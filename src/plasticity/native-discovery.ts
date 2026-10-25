import { randomUUID } from "node:crypto";

import type { CdpClient } from "../cdp/client.ts";
import { NATIVE_ENUM_CONTRACTS } from "./native-enums.ts";

// Renderer functions: no host imports or globals are installed in the app.
export const SELECT_EDITOR_PROTOTYPE = `function () {
  const matches = this.filter(fn => fn.name === 'Editor' && fn.prototype &&
    ['open', 'save', 'exec'].every(key => typeof fn.prototype[key] === 'function'));
  if (matches.length !== 1) throw new Error('Native Editor constructor is missing or ambiguous');
  return matches[0].prototype;
}`;

export const SELECT_STORE_EDITOR = `function () {
  const matches = this.filter(editor => editor.geo?.read?.geometryModel &&
    !editor.geo.geometryModel && editor.nodes && editor.groups && editor.empties &&
    typeof editor.geo.lookupStableId === 'function');
  if (matches.length !== 1) throw new Error('Native store editor is missing or ambiguous');
  return matches[0];
}`;

export const SELECT_NATIVE_ROOTS = `function (contracts) {
  const kernels = [], enums = {};
  const entries = Object.entries(contracts);
  for (const object of this) {
    const context = Object.getOwnPropertyDescriptor(object, 'Context')?.value;
    const evaluate = Object.getOwnPropertyDescriptor(object, 'Eval')?.value;
    if (typeof context?.Get === 'function' && typeof evaluate === 'function') kernels.push(object);
    for (const [name, contract] of entries) {
      if (enums[name]) continue;
      const expected = Object.entries(contract);
      if (!expected.every(([key, value]) => Object.getOwnPropertyDescriptor(object, key)?.value === value)) continue;
      if (Object.keys(object).length === expected.length) enums[name] = object;
    }
  }
  if (kernels.length !== 1) throw new Error('Native kernel namespace is missing or ambiguous (' + kernels.length + ' candidates)');
  return { kernel: kernels[0], enums };
}`;

export const SELECT_STORE_BINDINGS = `function (editor, roots) {
  const bindings = {};
  const byName = new Map();
  const extras = new Set(['ConstructionPlaneDatabase', 'ConstructionPlaneSnap', 'ImporterExporter',
    'LineSegmentHelper', 'CurvatureMeasurement', 'Target', 'makeAxisAlignedMeasurementPath', 'cplane2basis', 'evalCurvatureMeasurements', 'evalSurfaceContinuityMeasurements']);
  for (const fn of this) {
    if (!fn.name || (!extras.has(fn.name) && !/(?:Factory|Command)$/.test(fn.name))) continue;
    if (/^[A-Z]/.test(fn.name) && !fn.prototype) continue;
    const matches = byName.get(fn.name) ?? [];
    matches.push(fn); byName.set(fn.name, matches);
  }
  for (const [name, matches] of byName) if (matches.length === 1) bindings[name] = matches[0];
  for (const [name, value] of Object.entries(roots.kernel)) {
    if (value && (typeof value === 'object' || typeof value === 'function')) bindings[name] = value;
  }
  for (const [name, value] of Object.entries(editor.commands)) if (typeof value === 'function') bindings[name] = value;
  // 26.2 unified or renamed these factories. Call-local API adapters normalize
  // the changed control-point and bridge contracts; commands keep the real editor.
  for (const [legacy, current] of Object.entries({
    PossiblyBooleanSphereFactory: 'SphereFactory',
    PossiblyBooleanCylinderFactory: 'CylinderFactory',
    MultiCutFactory: 'CutFactory',
    RealizeInstanceFactory: 'RealizeFactory',
    MultiMoveControlPointFactory: 'MoveControlPointFactory',
    MultiRotateControlPointFactory: 'RotateControlPointFactory',
    MultiScaleControlPointFactory: 'ScaleControlPointFactory',
    MultiSlideControlPointFactory: 'SlideControlPointFactory',
    BridgeEdgeFactory: 'BridgeCurveFactory',
    BridgeVertexFactory: 'BridgeCurveFactory',
    BridgeSurfaceWithPreviewFactory: 'BridgeSurfaceFactory',
    DeleteEdgeFactory: 'DissolveEdgeFactory',
    DeleteEdgeCommand: 'DeleteRedundantTopologyCommand',
  })) if (!bindings[legacy] && bindings[current]) bindings[legacy] = bindings[current];
  // ConvertCommand became selection-only in 26.2. Geometry conversion must use
  // a native geometry command so committing its factory records Undo history.
  if (bindings.ConvertControlPointCommand) bindings.ConvertCommand = bindings.ConvertControlPointCommand;
  // These aliases were checked against the legacy module and live native models.
  bindings.kernel_Solid = roots.kernel.SolidBody;
  bindings.kernel_Sheet = roots.kernel.SheetBody;
  bindings.pk_default = { a: roots.kernel };
  Object.assign(bindings, roots.enums);
  const camera = Array.from(editor.viewports)[0]?.camera;
  if (!camera) throw new Error('Native viewport camera is unavailable');
  bindings.Vector3 = camera.position.constructor;
  bindings.Quaternion = camera.quaternion.constructor;
  bindings.Matrix4 = camera.matrixWorld.constructor;
  const vectors = this.filter(fn => fn.name === 'Vector2' && fn.prototype?.isVector2 === true);
  if (vectors.length === 1) bindings.Vector2 = vectors[0];
  for (const name of ['ConstructionPlaneDatabase', 'Vector3', 'Quaternion', 'Matrix4']) {
    if (typeof bindings[name] !== 'function') throw new Error('Native core binding is unavailable: ' + name);
  }
  return bindings;
}`;

interface RemoteResult {
  result?: { objectId?: string };
  objects?: { objectId?: string };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

function objectId(result: RemoteResult): string {
  if (result.exceptionDetails) {
    throw new Error(`Plasticity native discovery failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
  }
  const id = result.result?.objectId ?? result.objects?.objectId;
  if (!id) throw new Error("Plasticity native discovery returned no object");
  return id;
}

export async function discoverStoreBindings(client: CdpClient): Promise<{ editorId: string; bindings: Map<string, string> }> {
  const temporary = `plasticity-discovery-${randomUUID()}`;
  const retained = `plasticity-bindings-${randomUUID()}`;
  let complete = false;
  const send = async (method: string, params: Record<string, unknown>) => objectId(await client.send(method, params) as RemoteResult);
  try {
    const functionPrototype = await send("Runtime.evaluate", { expression: "Function.prototype", objectGroup: temporary });
    const functions = await send("Runtime.queryObjects", { prototypeObjectId: functionPrototype, objectGroup: temporary });
    const editorPrototype = await send("Runtime.callFunctionOn", { objectId: functions, functionDeclaration: SELECT_EDITOR_PROTOTYPE, objectGroup: temporary });
    const editors = await send("Runtime.queryObjects", { prototypeObjectId: editorPrototype, objectGroup: temporary });
    const editorId = await send("Runtime.callFunctionOn", { objectId: editors, functionDeclaration: SELECT_STORE_EDITOR, objectGroup: retained });
    const plainPrototype = await send("Runtime.evaluate", { expression: "Object.prototype", objectGroup: temporary });
    const objects = await send("Runtime.queryObjects", { prototypeObjectId: plainPrototype, objectGroup: temporary });
    const roots = await send("Runtime.callFunctionOn", {
      objectId: objects, functionDeclaration: SELECT_NATIVE_ROOTS, arguments: [{ value: NATIVE_ENUM_CONTRACTS }], objectGroup: temporary,
    });
    const catalog = await send("Runtime.callFunctionOn", {
      objectId: functions, functionDeclaration: SELECT_STORE_BINDINGS,
      arguments: [{ objectId: editorId }, { objectId: roots }], objectGroup: retained,
    });
    const properties = await client.send("Runtime.getProperties", { objectId: catalog, ownProperties: true, accessorPropertiesOnly: false }) as {
      result: Array<{ name: string; value?: { objectId?: string } }>;
    };
    const bindings = new Map<string, string>();
    for (const property of properties.result) if (property.value?.objectId) bindings.set(property.name, property.value.objectId);
    await client.send("Runtime.releaseObject", { objectId: catalog });
    complete = true;
    return { editorId, bindings };
  } finally {
    await client.send("Runtime.releaseObjectGroup", { objectGroup: temporary }).catch(() => undefined);
    if (!complete) await client.send("Runtime.releaseObjectGroup", { objectGroup: retained }).catch(() => undefined);
  }
}
