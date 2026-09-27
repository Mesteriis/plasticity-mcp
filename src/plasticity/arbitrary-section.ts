import type { SectionBinding } from "../strength/section-contracts.ts";
import type { SectionLoop, SectionProperties } from "../strength/section-geometry.ts";
import {
  integrateNativeSectionBoundary,
  type NativeSectionEdge,
  type NativeSectionFrameInput,
} from "./section-geometry.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";

type Vector3 = [number, number, number];

export interface ArbitrarySectionRequest {
  bodyId: number;
  revision: string;
  plane: NativeSectionFrameInput;
}

export interface ArbitrarySectionBinding extends SectionBinding {
  plane: NativeSectionFrameInput;
}

export interface ArbitrarySectionEvidence {
  status: "verified" | "unsupported";
  binding: ArbitrarySectionBinding;
  frame?: NativeSectionFrameInput;
  properties?: SectionProperties;
  loops?: SectionLoop[];
  source: "native-brep-temporary-section";
  reasons: string[];
}

export interface NativeArbitrarySectionTopology {
  bodyMatchCount: number;
  solid: boolean;
  checkCodes: number[];
  cutBodyCount: number;
  cutFaceCount: number;
  edges: NativeSectionEdge[];
}

const VECTOR_TOLERANCE = 1e-9;
let nextTemporaryVersionId = 2_147_000_001;

export async function inspectArbitrarySection(
  runtime: PlasticityRuntime,
  request: ArbitrarySectionRequest,
  sessionId: string,
): Promise<ArbitrarySectionEvidence> {
  if (!sessionId) throw new Error("MCP session ID is required");
  const normalizedPlane = normalizeFrame(request.plane);
  const before = await runtime.getState();
  const initialBinding = binding(sessionId, before.documentToken, request, normalizedPlane ?? request.plane, "unavailable");
  if (before.revision !== request.revision) return unsupported({ ...initialBinding, revision: before.revision }, ["stale-reference"]);
  if (!normalizedPlane) return unsupported(initialBinding, ["invalid-frame"]);

  const matches = before.bodies.filter((body) => body.id === request.bodyId);
  if (matches.length === 0) return unsupported(initialBinding, ["unknown-body"]);
  if (matches.length > 1) return unsupported(initialBinding, ["duplicate-body"]);
  const body = matches[0]!;
  if (!body.boundsMm) return unsupported(initialBinding, ["body-bounds-unavailable"]);

  const sheet = sheetForBounds(body.boundsMm, normalizedPlane);
  const temporaryIds = allocateTemporaryIds();
  const topology = await collectNativeArbitrarySection(runtime, request.bodyId, normalizedPlane, sheet, temporaryIds);
  const after = await runtime.getState();
  if (!samePersistentState(before, after)) {
    return unsupported({ ...initialBinding, documentToken: after.documentToken, revision: after.revision }, ["document-changed-during-section"]);
  }

  const reasons: string[] = [];
  if (topology.bodyMatchCount === 0) reasons.push("unknown-body");
  else if (topology.bodyMatchCount > 1) reasons.push("duplicate-body");
  if (!topology.solid) reasons.push("non-solid");
  if (topology.checkCodes.length > 0) reasons.push("native-check-failed");
  if (topology.cutBodyCount === 0 || topology.cutFaceCount === 0 || topology.edges.length === 0) reasons.push("no-section");
  if (reasons.length > 0) return unsupported(initialBinding, reasons);

  try {
    const integrated = integrateNativeSectionBoundary(
      topology.edges,
      normalizedPlane,
      "native-brep-temporary-section",
    );
    return {
      status: "verified",
      binding: binding(
        sessionId,
        before.documentToken,
        request,
        integrated.frame,
        integrated.properties.topologySignature,
      ),
      frame: integrated.frame,
      properties: integrated.properties,
      loops: integrated.loops,
      source: "native-brep-temporary-section",
      reasons: [],
    };
  } catch {
    return unsupported(initialBinding, ["invalid-section-boundary"]);
  }
}

async function collectNativeArbitrarySection(
  runtime: PlasticityRuntime,
  bodyId: number,
  plane: NativeSectionFrameInput,
  sheet: { originMm: Vector3; extentM: number },
  temporaryIds: TemporaryIds,
): Promise<NativeArbitrarySectionTopology> {
  return await runtime.readNative<NativeArbitrarySectionTopology>(`async function (CutFactory, kernel_Sheet, kernel_Solid, cplane2basis, Vector3, args) {
    const mm = value => value * 1000;
    const point = value => [mm(value.x), mm(value.y), mm(value.z)];
    const direction = value => [value.x, value.y, value.z];
    const dot = (left, right) => left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
    const matches = [];
    for (const [versionId, item] of this.geo.geometryModel) {
      if (this.db.lookupStableId(versionId) === args.bodyId) matches.push(item);
    }
    if (matches.length !== 1) {
      return { bodyMatchCount: matches.length, solid: false, checkCodes: [], cutBodyCount: 0, cutFaceCount: 0, edges: [] };
    }
    const item = matches[0];
    const model = item.model;
    const solid = item.view?.constructor?.name === 'Solid';
    const checkCodes = typeof model?.Check === 'function' ? Array.from(model.Check(), Number) : [-1];
    if (!solid || checkCodes.length > 0) {
      return { bodyMatchCount: 1, solid, checkCodes, cutBodyCount: 0, cutFaceCount: 0, edges: [] };
    }

    const normal = args.plane.normal;
    const x = args.plane.xDirection;
    const y = [
      normal[1] * x[2] - normal[2] * x[1],
      normal[2] * x[0] - normal[0] * x[2],
      normal[0] * x[1] - normal[1] * x[0],
    ];
    const p = args.sheet.originMm.map(value => value / 1000);
    const basis = cplane2basis({
      p: new Vector3(...p),
      n: new Vector3(...normal),
      x: new Vector3(...x),
      y: new Vector3(...y),
    });
    const temporary = this.geo.makeTemporary();
    Object.defineProperty(temporary, 'primaryPartition', { value: this.geo.primaryPartition });
    const temporaryDatabase = Object.create(this.db);
    Object.defineProperty(temporaryDatabase, 'geo', { value: temporary });
    const temporaryEditor = Object.create(this);
    Object.defineProperties(temporaryEditor, {
      geo: { value: temporary },
      db: { value: temporaryDatabase },
    });
    let targetCopy;
    let sheetBody;
    let factory;
    let targetView;
    let sheetView;
    let primaryFailure;
    try {
      targetCopy = model.Clone();
      sheetBody = kernel_Sheet.CreateRectangle(args.sheet.extentM, args.sheet.extentM, basis);
      const usedVersions = new Set(temporary.geometryModel.keys());
      let targetVersionId = args.temporaryIds.targetVersionId;
      let targetStableId = args.temporaryIds.targetStableId;
      let sheetVersionId = args.temporaryIds.sheetVersionId;
      let sheetStableId = args.temporaryIds.sheetStableId;
      while (usedVersions.has(targetVersionId) || temporary.hasStableId(targetStableId) ||
        usedVersions.has(sheetVersionId) || temporary.hasStableId(sheetStableId)) {
        targetVersionId -= 4;
        targetStableId -= 4;
        sheetVersionId -= 4;
        sheetStableId -= 4;
      }
      const targetCvs = targetCopy.GetCVs();
      const sheetCvs = sheetBody.GetCVs();
      const views = await this.views.build([
        { model: targetCopy, cvs: targetCvs, versionId: targetVersionId, stableId: targetStableId },
        { model: sheetBody, cvs: sheetCvs, versionId: sheetVersionId, stableId: sheetStableId },
      ], 'real');
      targetView = views[0];
      sheetView = views[1];
      await temporary.addItem(targetCopy, targetCvs, targetView, targetStableId, 'user');
      await temporary.addItem(sheetBody, sheetCvs, sheetView, sheetStableId, 'user');
      const cutterFace = sheetView?.high?.faces?.get(0);
      if (!cutterFace) throw new Error('Temporary Sheet face was not built');
      factory = new CutFactory(temporaryEditor);
      factory.target = targetView;
      factory.face = cutterFace;
      const calculated = await factory.calculate(factory.partition);
      const results = Array.isArray(calculated) ? calculated : [calculated].filter(Boolean);
      const positiveFaces = [];
      const negativeFaces = [];
      const planeOriginM = args.plane.originMm.map(value => value / 1000);
      for (const result of results) {
        const faces = result?.GetFaces?.();
        if (!faces) continue;
        for (let faceIndex = 0; faceIndex < faces.Size(); faceIndex += 1) {
          const face = faces.Get(faceIndex);
          if (!face.IsPlanar()) continue;
          const midpoint = face.FindMidpoint();
          const position = [midpoint.position.x, midpoint.position.y, midpoint.position.z];
          const faceNormal = [midpoint.normal.x, midpoint.normal.y, midpoint.normal.z];
          const offset = [position[0] - planeOriginM[0], position[1] - planeOriginM[1], position[2] - planeOriginM[2]];
          const alignment = dot(faceNormal, normal);
          if (Math.abs(dot(offset, normal)) > 1e-8 || Math.abs(Math.abs(alignment) - 1) > 1e-7) continue;
          (alignment >= 0 ? positiveFaces : negativeFaces).push(face);
        }
      }
      const sectionFaces = positiveFaces.length > 0 ? positiveFaces : negativeFaces;
      const edges = [];
      for (const face of sectionFaces) {
        const nativeEdges = face.GetEdges();
        for (let edgeIndex = 0; edgeIndex < nativeEdges.Size(); edgeIndex += 1) {
          const edge = nativeEdges.Get(edgeIndex);
          const start = edge.GetPointAndTangent(0);
          const end = edge.GetPointAndTangent(1);
          const vertices = edge.GetVertices();
          const curve = edge.GetCurve();
          let circle;
          if (edge.IsCircle() && typeof curve?.curve?.GetInfo === 'function') {
            const info = curve.curve.GetInfo();
            const circleBasis = info?.basis;
            if (circleBasis?.Location && circleBasis?.Axis && circleBasis?.Ref && Number.isFinite(info?.radius)) {
              circle = {
                centerMm: point(circleBasis.Location),
                axis: direction(circleBasis.Axis),
                reference: direction(circleBasis.Ref),
                radiusMm: mm(info.radius),
              };
            }
          }
          const left = Number(vertices.left?.Id?.());
          const right = Number(vertices.right?.Id?.());
          edges.push({
            id: 'cut:' + face.Id() + ':' + edge.Id(),
            nativeId: Number(edge.Id()),
            vertexIds: [Number.isInteger(left) ? left : null, Number.isInteger(right) ? right : null],
            isLine: Boolean(edge.IsLine()),
            isCircle: Boolean(edge.IsCircle()),
            startMm: point(start.position),
            endMm: point(end.position),
            startTangent: direction(start.tangent),
            lengthMm: mm(edge.FindLength().length),
            ...(circle === undefined ? {} : { circle }),
          });
        }
      }
      return {
        bodyMatchCount: 1,
        solid: true,
        checkCodes,
        cutBodyCount: results.length,
        cutFaceCount: sectionFaces.length,
        edges,
      };
    } catch (error) {
      primaryFailure = error;
      throw error;
    } finally {
      let cleanupFailure;
      try { if (factory) await factory.cancel(); } catch (error) { cleanupFailure = error; }
      try { if (sheetView) await temporary.removeItem(sheetView, 'user'); } catch (error) { cleanupFailure ??= error; }
      try { if (targetView) await temporary.removeItem(targetView, 'user'); } catch (error) { cleanupFailure ??= error; }
      try { if (sheetBody) kernel_Sheet.Remove([sheetBody.Id()]); } catch (error) { cleanupFailure ??= error; }
      try { if (targetCopy) kernel_Solid.Remove([targetCopy.Id()]); } catch (error) { cleanupFailure ??= error; }
      if (!primaryFailure && cleanupFailure) throw cleanupFailure;
    }
  }`, ["CutFactory", "kernel_Sheet", "kernel_Solid", "cplane2basis", "Vector3"], [{ bodyId, plane, sheet, temporaryIds }]);
}

interface TemporaryIds {
  targetVersionId: number;
  targetStableId: number;
  sheetVersionId: number;
  sheetStableId: number;
}

function allocateTemporaryIds(): TemporaryIds {
  if (nextTemporaryVersionId < 1_500_000_001) nextTemporaryVersionId = 2_147_000_001;
  const targetVersionId = nextTemporaryVersionId;
  nextTemporaryVersionId -= 4;
  return {
    targetVersionId,
    targetStableId: targetVersionId - 1,
    sheetVersionId: targetVersionId - 2,
    sheetStableId: targetVersionId - 3,
  };
}

function normalizeFrame(frame: NativeSectionFrameInput): NativeSectionFrameInput | null {
  if (![...frame.originMm, ...frame.normal, ...frame.xDirection].every(Number.isFinite)) return null;
  const normal = normalize(frame.normal);
  if (!normal) return null;
  const projected = subtract(frame.xDirection, scale(normal, dot(frame.xDirection, normal)));
  const xDirection = normalize(projected);
  if (!xDirection) return null;
  return { originMm: [...frame.originMm], normal, xDirection };
}

function sheetForBounds(
  bounds: { min: Vector3; max: Vector3 },
  plane: NativeSectionFrameInput,
): { originMm: Vector3; extentM: number } {
  const center = bounds.min.map((value, index) => (value + bounds.max[index]!) / 2) as Vector3;
  const projectedCenter = subtract(center, scale(plane.normal, dot(subtract(center, plane.originMm), plane.normal)));
  const diagonalMm = Math.hypot(...bounds.min.map((value, index) => bounds.max[index]! - value));
  const extentMm = Math.max(1, diagonalMm * 4);
  const yDirection = cross(plane.normal, plane.xDirection);
  const originMm = subtract(
    subtract(projectedCenter, scale(plane.xDirection, extentMm / 2)),
    scale(yDirection, extentMm / 2),
  );
  return { originMm, extentM: extentMm / 1000 };
}

function samePersistentState(before: RuntimeState, after: RuntimeState): boolean {
  return before.documentToken === after.documentToken &&
    before.revision === after.revision &&
    before.undoDepth === after.undoDepth &&
    before.redoDepth === after.redoDepth &&
    bodyIdentity(before) === bodyIdentity(after);
}

function bodyIdentity(state: RuntimeState): string {
  return JSON.stringify([...state.bodies].sort((left, right) => left.id - right.id));
}

function binding(
  sessionId: string,
  documentToken: string,
  request: ArbitrarySectionRequest,
  plane: NativeSectionFrameInput,
  topologySignature: string,
): ArbitrarySectionBinding {
  return {
    sessionId,
    documentToken,
    revision: request.revision,
    bodyId: request.bodyId,
    plane,
    topologySignature,
  };
}

function unsupported(bindingValue: ArbitrarySectionBinding, reasons: string[]): ArbitrarySectionEvidence {
  return {
    status: "unsupported",
    binding: bindingValue,
    source: "native-brep-temporary-section",
    reasons: [...new Set(reasons)],
  };
}

function normalize(value: Vector3): Vector3 | null {
  const length = Math.hypot(...value);
  return Number.isFinite(length) && length > VECTOR_TOLERANCE ? scale(value, 1 / length) : null;
}

function subtract(left: Vector3, right: Vector3): Vector3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function scale(value: Vector3, factor: number): Vector3 {
  return [value[0] * factor, value[1] * factor, value[2] * factor];
}

function dot(left: Vector3, right: Vector3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function cross(left: Vector3, right: Vector3): Vector3 {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}
