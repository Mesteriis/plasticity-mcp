import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { discoverPlasticityTargets, type PlasticityTarget } from "../src/cdp/discovery.ts";
import { ConstructionGeometry, frameFromOriginNormalX } from "../src/plasticity/construction.ts";
import { PlasticityRuntime } from "../src/plasticity/runtime.ts";

const REQUIRED_BINDINGS = [
  "SaveConstructionPlaneCommand",
  "RemovePlaneCommand",
  "ConstructionPlaneDatabase",
  "ConstructionPlaneSnap",
  "CreateViewspaceConstructionPlaneAtOrigin",
  "Plane",
  "Vector3",
] as const;

export interface ProbeArguments {
  endpoint: string;
  mutate: boolean;
  targetId: string | undefined;
}

interface PlaneSnapshot {
  counter: number;
  version: number;
  ids: Array<[string, number]>;
  planes: Array<{
    index: number;
    name: string;
    point: [number, number, number];
    normal: [number, number, number];
    xDirection: [number, number, number];
    yDirection: [number, number, number];
  }>;
  undoDepth: number;
  redoDepth: number;
}

export function parseProbeArguments(arguments_: readonly string[]): ProbeArguments {
  let endpoint = process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223";
  let mutate = false;
  let targetId: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--mutate") {
      mutate = true;
    } else if (argument === "--target") {
      targetId = requireArgumentValue(arguments_, ++index, "--target");
    } else if (argument === "--endpoint") {
      endpoint = requireArgumentValue(arguments_, ++index, "--endpoint");
    } else {
      throw new Error(`Unknown construction probe argument: ${argument}`);
    }
  }
  if (mutate && !targetId) throw new Error("Construction probe --mutate requires --target <id>");
  return { endpoint, mutate, targetId };
}

export async function runConstructionProbe(options: ProbeArguments): Promise<unknown> {
  const targets = await discoverPlasticityTargets(options.endpoint);
  const target = selectTarget(targets, options.targetId);
  const runtime = await PlasticityRuntime.connect(target);
  try {
    const capabilities = runtime.getCapabilities();
    const requiredBindings = Object.fromEntries(
      REQUIRED_BINDINGS.map((name) => [name, capabilities.includes(name)]),
    );
    const missing = REQUIRED_BINDINGS.filter((name) => !requiredBindings[name]);
    if (missing.length > 0) throw new Error(`Missing Plasticity construction bindings: ${missing.join(", ")}`);

    const inspection = await inspectNativeSurfaces(runtime);
    const report = {
      target: { id: target.id, title: target.title },
      availableTargets: targets.map(({ id, title }) => ({ id, title })),
      requiredBindings,
      ...inspection,
    };
    if (!options.mutate) return { mode: "read-only", status: "available", ...report };

    const mutationProof = await proveNativeMutation(runtime);
    return { mode: "mutation-proof", status: "passed", ...report, mutationProof };
  } finally {
    runtime.close();
  }
}

async function inspectNativeSurfaces(runtime: PlasticityRuntime): Promise<Record<string, unknown>> {
  return await runtime.mutate<Record<string, unknown>>(`function (Database) {
    const fields = value => Object.getOwnPropertyNames(value ?? {}).sort();
    const constructorName = value => value?.constructor?.name ?? null;
    const standardPlanes = ['Top', 'Bottom', 'Left', 'Right', 'Front', 'Back'].map(key => ({
      key,
      constructor: constructorName(Database[key]),
      fields: fields(Database[key]),
    }));
    const snapshot = this.planes.snapshot();
    const viewport = Array.from(this.viewports)[0];
    const descriptor = viewport
      ? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(viewport), 'constructionPlane')
      : undefined;
    return {
      standardPlanes,
      planeDatabase: {
        constructor: constructorName(this.planes),
        methods: Object.getOwnPropertyNames(Object.getPrototypeOf(this.planes)).sort(),
        savedCount: snapshot.planes?.length ?? 0,
      },
      activeCandidates: [
        { path: 'viewport.constructionPlane', constructor: constructorName(viewport?.constructionPlane), fields: fields(viewport?.constructionPlane) },
        { path: 'viewport._constructionPlane', constructor: constructorName(viewport?._constructionPlane), fields: fields(viewport?._constructionPlane) },
        { path: 'viewport.constructionPlane accessor', constructor: null, fields: [typeof descriptor?.get === 'function' ? 'get' : '', typeof descriptor?.set === 'function' ? 'set' : ''].filter(Boolean) },
      ],
    };
  }`, ["ConstructionPlaneDatabase"]);
}

async function proveNativeMutation(runtime: PlasticityRuntime): Promise<unknown> {
  const state = await runtime.getState();
  if (state.bodies.length !== 0) {
    throw new Error(`Construction mutation proof requires an empty document; found ${state.bodies.length} bodies`);
  }
  const before = await readPlaneSnapshot(runtime);
  const adapter = new ConstructionGeometry(runtime);
  const creation = await adapter.createPlane(
    frameFromOriginNormalX([0, 0, 12.5], [0, 0, 1], [1, 0, 0]),
    "MCP Construction Probe",
    state.revision,
  );

  const afterCreate = await readPlaneSnapshot(runtime);
  const beforeIds = new Set(before.ids.map(([id]) => id));
  const addedIds = afterCreate.ids.map(([id]) => id).filter((id) => !beforeIds.has(id));
  if (
    afterCreate.planes.length !== before.planes.length + 1 ||
    addedIds.length !== 1 ||
    addedIds[0] !== creation.plane.nativeId
  ) {
    throw new Error(`Native plane read-back was not unique: before=${JSON.stringify(before.ids)}, after=${JSON.stringify(afterCreate.ids)}`);
  }
  const created = planeForId(afterCreate, addedIds[0] as string);
  assertVectorClose(created.point, [0, 0, 0.0125], 1e-12, "created plane origin");
  assertVectorClose(created.normal, [0, 0, 1], 1e-12, "created plane normal");
  assertVectorClose(created.xDirection, [1, 0, 0], 1e-12, "created plane x direction");

  await runtime.mutate(`async function () { await this.undo(); }`, []);
  const afterUndo = await readPlaneSnapshot(runtime);
  if (afterUndo.planes.length !== before.planes.length) throw new Error("Undo did not remove the probe construction plane");

  await runtime.mutate(`async function () { await this.redo(); }`, []);
  const afterRedo = await readPlaneSnapshot(runtime);
  if (afterRedo.planes.length !== afterCreate.planes.length) throw new Error("Redo did not restore the probe construction plane");

  const redoneState = await runtime.getState();
  const redonePlane = redoneState.construction.planes.find(
    (plane) => plane.source === "saved" && plane.nativeId === addedIds[0],
  );
  if (!redonePlane) throw new Error("Redone probe plane is missing from runtime state");
  const activatedState = await adapter.setWorkplane(redonePlane);
  const activation = {
    activePlaneId: activatedState.construction.activePlaneId,
    viewStateToken: activatedState.construction.viewStateToken,
  };
  const top = activatedState.construction.planes.find((plane) => plane.id === "standard:top");
  if (!top) throw new Error("Standard Top plane is unavailable for probe restoration");
  await adapter.setWorkplane(top);

  await runtime.mutate(`async function () { await this.undo(); }`, []);
  const afterCleanup = await readPlaneSnapshot(runtime);
  if (afterCleanup.planes.length !== before.planes.length) throw new Error("Probe cleanup did not restore the initial plane count");

  return {
    nativeId: addedIds[0],
    internalOffset: created.point[2],
    publicOffsetMm: created.point[2] * 1000,
    created,
    activation,
    history: {
      before: history(before),
      afterCreate: history(afterCreate),
      afterUndo: history(afterUndo),
      afterRedo: history(afterRedo),
      afterCleanup: history(afterCleanup),
    },
  };
}

async function readPlaneSnapshot(runtime: PlasticityRuntime): Promise<PlaneSnapshot> {
  return await runtime.read<PlaneSnapshot>(`function () {
    const snapshot = this.planes.snapshot();
    const rawIds = snapshot.ids instanceof Map ? Array.from(snapshot.ids) : Object.entries(snapshot.ids ?? {});
    const ids = rawIds.map(([index, nativeId]) => [String(nativeId), Number(index)]);
    return {
      counter: snapshot.counter ?? 0,
      version: snapshot.version ?? 0,
      ids,
      planes: (snapshot.planes ?? []).map((plane, index) => ({
        index,
        name: String(plane.name ?? ''),
        point: plane.p.toArray(),
        normal: plane.n.toArray(),
        xDirection: plane.x.toArray(),
        yDirection: plane.y.toArray(),
      })),
      undoDepth: this.history?.undoStack?.length ?? 0,
      redoDepth: this.history?.redoStack?.length ?? 0,
    };
  }`);
}

function planeForId(snapshot: PlaneSnapshot, nativeId: string): PlaneSnapshot["planes"][number] {
  const index = snapshot.ids.find(([id]) => id === nativeId)?.[1];
  const plane = index === undefined ? undefined : snapshot.planes[index];
  if (!plane) throw new Error(`Native plane ID did not resolve after creation: ${nativeId}`);
  return plane;
}

function history(snapshot: PlaneSnapshot): { undoDepth: number; redoDepth: number; planeVersion: number } {
  return { undoDepth: snapshot.undoDepth, redoDepth: snapshot.redoDepth, planeVersion: snapshot.version };
}

function assertVectorClose(
  actual: [number, number, number],
  expected: [number, number, number],
  tolerance: number,
  label: string,
): void {
  if (actual.some((value, index) => Math.abs(value - expected[index]!) > tolerance)) {
    throw new Error(`${label} mismatch: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}`);
  }
}

function selectTarget(targets: PlasticityTarget[], targetId: string | undefined): PlasticityTarget {
  if (targets.length === 0) throw new Error("No Plasticity document windows are exposed on the CDP endpoint");
  if (targetId) {
    const selected = targets.find((target) => target.id === targetId);
    if (!selected) throw new Error(`Plasticity target not found: ${targetId}`);
    return selected;
  }
  return [...targets].sort((left, right) => left.id.localeCompare(right.id))[0] as PlasticityTarget;
}

function requireArgumentValue(arguments_: readonly string[], index: number, option: string): string {
  const value = arguments_[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

async function main(): Promise<void> {
  try {
    const report = await runConstructionProbe(parseProbeArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ status: "failed", error: message }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
