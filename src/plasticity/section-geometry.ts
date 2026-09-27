import type { SectionBinding, SectionScenarioInput } from "../strength/section-contracts.ts";
import {
  integrateSection,
  type SectionLoop,
  type SectionProperties,
  type SectionSegment,
} from "../strength/section-geometry.ts";
import type { PlasticityRuntime } from "./runtime.ts";

type Vector3 = [number, number, number];

export interface SectionRequest {
  bodyId: number;
  faceId: string;
  revision: string;
  xDirection: Vector3;
}

export interface SectionEvidence {
  status: "verified" | "unsupported";
  binding: SectionBinding;
  frame?: SectionScenarioInput["frame"];
  properties?: SectionProperties;
  loops?: SectionLoop[];
  source: "native-brep-boundary";
  reasons: string[];
}

export interface NativeSectionEdge {
  id: string;
  nativeId: number;
  vertexIds: [number | null, number | null];
  isLine: boolean;
  isCircle: boolean;
  startMm: Vector3;
  endMm: Vector3;
  startTangent: Vector3;
  lengthMm: number;
  circle?: {
    centerMm: Vector3;
    axis: Vector3;
    reference: Vector3;
    radiusMm: number;
  };
}

export interface NativeSectionTopology {
  bodyMatchCount: number;
  solid: boolean;
  checkCodes: number[];
  faceMatchCount: number;
  face: null | {
    id: string;
    planar: boolean;
    midpointMm: Vector3;
    normal: Vector3;
    edges: NativeSectionEdge[];
  };
}

export interface NativeSectionFrameInput {
  originMm: Vector3;
  normal: Vector3;
  xDirection: Vector3;
}

interface SectionFrame extends NativeSectionFrameInput {
  originMm: Vector3;
  normal: Vector3;
  xDirection: Vector3;
  yDirection: Vector3;
}

export interface IntegratedNativeSection {
  frame: SectionScenarioInput["frame"];
  properties: SectionProperties;
  loops: SectionLoop[];
}

const COINCIDENCE_TOLERANCE_MM = 1e-5;
const ANGULAR_TOLERANCE = 1e-9;

export async function inspectPlanarSection(
  runtime: PlasticityRuntime,
  request: SectionRequest,
  sessionId: string,
): Promise<SectionEvidence> {
  if (!sessionId) throw new Error("MCP session ID is required");
  const before = await runtime.getState();
  const initialBinding = binding(sessionId, before.documentToken, request, "unavailable");
  if (before.revision !== request.revision) return unsupported(initialBinding, ["stale-reference"]);
  const stateBodyMatches = before.bodies.filter((body) => body.id === request.bodyId);
  if (stateBodyMatches.length === 0) return unsupported(initialBinding, ["unknown-body"]);
  if (stateBodyMatches.length > 1) return unsupported(initialBinding, ["duplicate-body"]);

  const topology = await collectNativeSection(runtime, request.bodyId, request.faceId);
  const reasons: string[] = [];
  if (topology.bodyMatchCount === 0) reasons.push("unknown-body");
  else if (topology.bodyMatchCount > 1) reasons.push("duplicate-body");
  if (!topology.solid) reasons.push("non-solid");
  if (topology.checkCodes.length > 0) reasons.push("native-check-failed");
  if (topology.faceMatchCount === 0 || topology.face === null) reasons.push("missing-face");
  else if (topology.faceMatchCount > 1) reasons.push("duplicate-face");
  if (topology.face && !topology.face.planar) reasons.push("nonplanar-face");
  if (reasons.length > 0 || !topology.face) return unsupported(initialBinding, reasons);

  let frame: SectionFrame;
  let loops: SectionLoop[];
  let localProperties: ReturnType<typeof integrateSection>;
  try {
    const integrated = integrateNativeSectionBoundary(topology.face.edges, {
      originMm: topology.face.midpointMm,
      normal: topology.face.normal,
      xDirection: request.xDirection,
    });
    frame = { ...integrated.frame, yDirection: normalize3(cross3(integrated.frame.normal, integrated.frame.xDirection))! };
    loops = integrated.loops;
    localProperties = integrated.properties;
  } catch (error) {
    const reason = error instanceof SectionTopologyError ? error.code : "invalid-section-boundary";
    return unsupported(initialBinding, [reason]);
  }

  const after = await runtime.getState();
  if (after.documentToken !== before.documentToken || after.revision !== before.revision) {
    return unsupported(initialBinding, ["stale-reference"]);
  }
  const centroidMm = add3(
    frame.originMm,
    add3(scale3(frame.xDirection, localProperties.centroidLocalMm[0]), scale3(frame.yDirection, localProperties.centroidLocalMm[1])),
  );
  const properties: SectionProperties = {
    ...localProperties,
    centroidMm,
    source: "native-brep-boundary",
  };
  const verifiedBinding = binding(sessionId, before.documentToken, request, properties.topologySignature);
  return {
    status: "verified",
    binding: verifiedBinding,
    frame: { originMm: frame.originMm, normal: frame.normal, xDirection: frame.xDirection },
    properties,
    loops,
    source: "native-brep-boundary",
    reasons: [],
  };
}

export function integrateNativeSectionBoundary(
  edges: NativeSectionEdge[],
  frameInput: NativeSectionFrameInput,
  source: SectionProperties["source"] = "native-brep-boundary",
): IntegratedNativeSection {
  const frame = makeFrame(frameInput.originMm, frameInput.normal, frameInput.xDirection);
  const loops = reconstructLoops(edges, frame);
  const localProperties = integrateSection(loops);
  const centroidMm = add3(
    frame.originMm,
    add3(scale3(frame.xDirection, localProperties.centroidLocalMm[0]), scale3(frame.yDirection, localProperties.centroidLocalMm[1])),
  );
  return {
    frame: { originMm: frame.originMm, normal: frame.normal, xDirection: frame.xDirection },
    properties: { ...localProperties, centroidMm, source },
    loops,
  };
}

async function collectNativeSection(
  runtime: PlasticityRuntime,
  bodyId: number,
  faceId: string,
): Promise<NativeSectionTopology> {
  return await runtime.readNative<NativeSectionTopology>(`function (args) {
    const mm = value => value * 1000;
    const point = value => [mm(value.x), mm(value.y), mm(value.z)];
    const direction = value => [value.x, value.y, value.z];
    const matches = [];
    for (const [versionId, item] of this.geo.geometryModel) {
      if (this.db.lookupStableId(versionId) === args.bodyId) matches.push(item);
    }
    if (matches.length !== 1) {
      return { bodyMatchCount: matches.length, solid: false, checkCodes: [], faceMatchCount: 0, face: null };
    }
    const item = matches[0];
    const model = item.model;
    const faceViews = item.view?.high?.faces;
    const edgeViews = item.view?.high?.edges;
    const faceIndexes = [];
    for (let index = 0; index < (faceViews?.versionIds?.length ?? 0); index += 1) {
      if (String(faceViews.versionIds[index]) === args.faceId) faceIndexes.push(index);
    }
    const base = {
      bodyMatchCount: 1,
      solid: item.view?.constructor?.name === 'Solid',
      checkCodes: typeof model?.Check === 'function' ? Array.from(model.Check(), Number) : [-1],
      faceMatchCount: faceIndexes.length,
    };
    if (faceIndexes.length !== 1 || !model || !edgeViews) return { ...base, face: null };
    const faceView = faceViews.get(faceIndexes[0]);
    const modelFaces = model.GetFaces();
    const faceMatches = [];
    for (let index = 0; index < modelFaces.Size(); index += 1) {
      const candidate = modelFaces.Get(index);
      if (candidate.Id() === faceView.entityId) faceMatches.push(candidate);
    }
    if (faceMatches.length !== 1) return { ...base, faceMatchCount: faceMatches.length, face: null };
    const face = faceMatches[0];
    const edgeIdByEntity = new Map();
    for (let index = 0; index < edgeViews.versionIds.length; index += 1) {
      const view = edgeViews.get(index);
      if (view) edgeIdByEntity.set(view.entityId, String(edgeViews.versionIds[index]));
    }
    const edges = [];
    const nativeEdges = face.GetEdges();
    for (let index = 0; index < nativeEdges.Size(); index += 1) {
      const edge = nativeEdges.Get(index);
      const start = edge.GetPointAndTangent(0);
      const end = edge.GetPointAndTangent(1);
      const vertices = edge.GetVertices();
      const curve = edge.GetCurve();
      let circle;
      if (edge.IsCircle() && typeof curve?.curve?.GetInfo === 'function') {
        const info = curve.curve.GetInfo();
        const basis = info?.basis;
        if (basis?.Location && basis?.Axis && basis?.Ref && Number.isFinite(info?.radius)) {
          circle = {
            centerMm: point(basis.Location),
            axis: direction(basis.Axis),
            reference: direction(basis.Ref),
            radiusMm: mm(info.radius),
          };
        }
      }
      edges.push({
        id: edgeIdByEntity.get(edge.Id()) ?? 'unmapped-edge:' + edge.Id(),
        nativeId: Number(edge.Id()),
        vertexIds: [
          Number.isInteger(Number(vertices.left?.Id?.())) ? Number(vertices.left.Id()) : null,
          Number.isInteger(Number(vertices.right?.Id?.())) ? Number(vertices.right.Id()) : null,
        ],
        isLine: Boolean(edge.IsLine()),
        isCircle: Boolean(edge.IsCircle()),
        startMm: point(start.position),
        endMm: point(end.position),
        startTangent: direction(start.tangent),
        lengthMm: mm(edge.FindLength().length),
        ...(circle === undefined ? {} : { circle }),
      });
    }
    const midpoint = face.FindMidpoint();
    return {
      ...base,
      face: {
        id: args.faceId,
        planar: Boolean(face.IsPlanar()),
        midpointMm: point(midpoint.position),
        normal: direction(midpoint.normal),
        edges,
      },
    };
  }`, [], [{ bodyId, faceId }]);
}

function reconstructLoops(edges: NativeSectionEdge[], frame: SectionFrame): SectionLoop[] {
  if (edges.length === 0) throw new SectionTopologyError("open-boundary-incidence");
  const prepared = edges.map((edge) => prepareSegment(edge, frame));
  const used = new Set<number>();
  const loops: SectionLoop[] = [];
  const incidence = new Map<number, number[]>();
  for (const [index, edge] of edges.entries()) {
    const [left, right] = edge.vertexIds;
    if (left === null || right === null) {
      if (left !== null || right !== null || !edge.isCircle || distance3(edge.startMm, edge.endMm) > COINCIDENCE_TOLERANCE_MM) {
        throw new SectionTopologyError("open-boundary-incidence");
      }
      loops.push({ segments: [prepared[index]!] });
      used.add(index);
      continue;
    }
    incidence.set(left, [...(incidence.get(left) ?? []), index]);
    incidence.set(right, [...(incidence.get(right) ?? []), index]);
  }
  if ([...incidence.values()].some((indexes) => indexes.length !== 2)) {
    throw new SectionTopologyError("open-boundary-incidence");
  }

  for (let seed = 0; seed < edges.length; seed += 1) {
    if (used.has(seed)) continue;
    const seedVertices = edges[seed]!.vertexIds;
    if (seedVertices[0] === null || seedVertices[1] === null) continue;
    const startVertex = seedVertices[0];
    let currentVertex = seedVertices[1];
    let currentEdge = seed;
    const segments: SectionSegment[] = [prepared[seed]!];
    used.add(seed);
    while (currentVertex !== startVertex) {
      const candidates = (incidence.get(currentVertex) ?? []).filter((index) => index !== currentEdge);
      if (candidates.length !== 1) throw new SectionTopologyError("open-boundary-incidence");
      const nextIndex = candidates[0]!;
      if (used.has(nextIndex)) throw new SectionTopologyError("open-boundary-incidence");
      const nextEdge = edges[nextIndex]!;
      const forward = nextEdge.vertexIds[0] === currentVertex;
      if (!forward && nextEdge.vertexIds[1] !== currentVertex) throw new SectionTopologyError("open-boundary-incidence");
      segments.push(forward ? prepared[nextIndex]! : reverseSegment(prepared[nextIndex]!));
      used.add(nextIndex);
      currentEdge = nextIndex;
      currentVertex = forward ? nextEdge.vertexIds[1]! : nextEdge.vertexIds[0]!;
    }
    loops.push({ segments });
  }
  if (used.size !== edges.length) throw new SectionTopologyError("open-boundary-incidence");
  return loops;
}

function prepareSegment(edge: NativeSectionEdge, frame: SectionFrame): SectionSegment {
  if (edge.isLine === edge.isCircle) throw new SectionTopologyError(`unsupported-curve:${edge.id}`);
  if (!edge.lengthMm || !Number.isFinite(edge.lengthMm)) throw new SectionTopologyError(`invalid-edge:${edge.id}`);
  if (edge.isLine) {
    return { kind: "line", start: project(edge.startMm, frame), end: project(edge.endMm, frame) };
  }
  const circle = edge.circle;
  if (!circle || !(circle.radiusMm > 0) || ![...circle.centerMm, ...circle.axis, ...circle.reference, circle.radiusMm].every(Number.isFinite)) {
    throw new SectionTopologyError(`invalid-circle:${edge.id}`);
  }
  const axis = normalize3(circle.axis);
  const tangent = normalize3(edge.startTangent);
  const radial = normalize3(subtract3(edge.startMm, circle.centerMm));
  if (!axis || !tangent || !radial || Math.abs(Math.abs(dot3(axis, frame.normal)) - 1) > ANGULAR_TOLERANCE) {
    throw new SectionTopologyError(`invalid-circle:${edge.id}`);
  }
  const magnitude = edge.lengthMm / circle.radiusMm;
  if (!Number.isFinite(magnitude) || magnitude > 2 * Math.PI + ANGULAR_TOLERANCE) {
    throw new SectionTopologyError(`invalid-circle-sweep:${edge.id}`);
  }
  const startLocal = project(edge.startMm, frame);
  const centerLocal = project(circle.centerMm, frame);
  const startRadians = Math.atan2(startLocal[1] - centerLocal[1], startLocal[0] - centerLocal[0]);
  const positiveTangent = cross3(frame.normal, radial);
  const sign = dot3(tangent, positiveTangent) >= 0 ? 1 : -1;
  const sweepRadians = sign * (Math.abs(magnitude - 2 * Math.PI) <= ANGULAR_TOLERANCE ? 2 * Math.PI : magnitude);
  return { kind: "arc", center: centerLocal, radius: circle.radiusMm, startRadians, sweepRadians };
}

function reverseSegment(segment: SectionSegment): SectionSegment {
  if (segment.kind === "line") return { kind: "line", start: segment.end, end: segment.start };
  return {
    kind: "arc",
    center: segment.center,
    radius: segment.radius,
    startRadians: segment.startRadians + segment.sweepRadians,
    sweepRadians: -segment.sweepRadians,
  };
}

function makeFrame(originMm: Vector3, normal: Vector3, xDirection: Vector3): SectionFrame {
  if (![...originMm, ...normal, ...xDirection].every(Number.isFinite)) throw new SectionTopologyError("invalid-frame");
  const n = normalize3(normal);
  if (!n) throw new SectionTopologyError("invalid-frame");
  const x = normalize3(subtract3(xDirection, scale3(n, dot3(xDirection, n))));
  if (!x) throw new SectionTopologyError("invalid-frame");
  const y = normalize3(cross3(n, x));
  if (!y) throw new SectionTopologyError("invalid-frame");
  return { originMm: [...originMm], normal: n, xDirection: x, yDirection: y };
}

function project(point: Vector3, frame: SectionFrame): [number, number] {
  const relative = subtract3(point, frame.originMm);
  const offPlane = dot3(relative, frame.normal);
  if (Math.abs(offPlane) > COINCIDENCE_TOLERANCE_MM) throw new SectionTopologyError("nonplanar-boundary");
  return [dot3(relative, frame.xDirection), dot3(relative, frame.yDirection)];
}

function binding(
  sessionId: string,
  documentToken: string,
  request: SectionRequest,
  topologySignature: string,
): SectionBinding {
  return {
    sessionId,
    documentToken,
    revision: request.revision,
    bodyId: request.bodyId,
    faceId: request.faceId,
    topologySignature,
  };
}

function unsupported(bindingValue: SectionBinding, reasons: string[]): SectionEvidence {
  return {
    status: "unsupported",
    binding: bindingValue,
    source: "native-brep-boundary",
    reasons: [...new Set(reasons)],
  };
}

class SectionTopologyError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

function normalize3(value: Vector3): Vector3 | null {
  const length = Math.hypot(...value);
  return Number.isFinite(length) && length > ANGULAR_TOLERANCE ? scale3(value, 1 / length) : null;
}

function add3(left: Vector3, right: Vector3): Vector3 {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}

function subtract3(left: Vector3, right: Vector3): Vector3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function scale3(value: Vector3, factor: number): Vector3 {
  return [value[0] * factor, value[1] * factor, value[2] * factor];
}

function dot3(left: Vector3, right: Vector3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function cross3(left: Vector3, right: Vector3): Vector3 {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function distance3(left: Vector3, right: Vector3): number {
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}
