import type { RuntimeState } from "./runtime.ts";
import {
  frameFromOriginNormalX,
  frameFromThreePoints,
  normalize,
  offsetFrame,
  rotateFrameAboutAxis,
  subtract,
  type AxisLine,
  type PlaneFrame,
  type Vector3,
} from "./construction.ts";
import type { AxisDefinition, DatumRegistry, PlaneDefinition, PointDefinition } from "./references.ts";

type Bounds = { min: Vector3; max: Vector3 };

export type Resolution<T> =
  | { status: "resolved"; value: T }
  | { status: "ambiguous"; matches: number }
  | { status: "unresolved"; reason: string };

export interface ScalarMatch {
  value: number;
  tolerance: number;
}

export interface PointMatch {
  pointMm: Vector3;
  toleranceMm: number;
}

export interface DirectionMatch {
  vector: Vector3;
  toleranceDeg: number;
  oriented?: boolean | undefined;
}

export interface FaceQuery {
  bodyIds?: number[] | undefined;
  surfaceTypes?: string[] | undefined;
  planar?: boolean | undefined;
  normal?: DirectionMatch | undefined;
  radiusMm?: ScalarMatch | undefined;
  blendRadiusMm?: ScalarMatch | undefined;
  center?: PointMatch | undefined;
  boundsMm?: Bounds | undefined;
  edgeCount?: number | undefined;
  adjacentEdgeIds?: string[] | undefined;
}

export interface EdgeQuery {
  bodyIds?: number[] | undefined;
  curveTypes?: string[] | undefined;
  line?: boolean | undefined;
  circle?: boolean | undefined;
  direction?: DirectionMatch | undefined;
  lengthMm?: ScalarMatch | undefined;
  center?: PointMatch | undefined;
  boundsMm?: Bounds | undefined;
  adjacentFaceIds?: string[] | undefined;
}

export type FaceMatch = RuntimeState["bodies"][number]["faces"][number] & { bodyId: number };
export type EdgeMatch = RuntimeState["bodies"][number]["edges"][number] & { bodyId: number };

export function findFaces(state: RuntimeState, query: FaceQuery): FaceMatch[] {
  return state.bodies
    .filter((body) => !query.bodyIds || query.bodyIds.includes(body.id))
    .flatMap((body) => body.faces.map((face) => ({ bodyId: body.id, ...face })))
    .filter((face) => {
      if (query.surfaceTypes && !query.surfaceTypes.some((type) => equalType(type, face.surfaceType))) return false;
      if (query.planar !== undefined && face.planar !== query.planar) return false;
      if (query.normal && !matchesDirection(face.normal, { ...query.normal, oriented: query.normal.oriented ?? true })) return false;
      if (query.radiusMm && !matchesNullableScalar(face.radiusMm, query.radiusMm)) return false;
      if (query.blendRadiusMm && !matchesNullableScalar(face.blendRadiusMm, query.blendRadiusMm)) return false;
      if (query.center && !matchesPoint(face.centerMm, query.center)) return false;
      if (query.boundsMm && !boundsOverlap(face.boundsMm, query.boundsMm)) return false;
      if (query.edgeCount !== undefined && face.edgeIds.length !== query.edgeCount) return false;
      if (query.adjacentEdgeIds && !query.adjacentEdgeIds.every((id) => face.edgeIds.includes(id))) return false;
      return true;
    });
}

export function findEdges(state: RuntimeState, query: EdgeQuery): EdgeMatch[] {
  return state.bodies
    .filter((body) => !query.bodyIds || query.bodyIds.includes(body.id))
    .flatMap((body) => body.edges.map((edge) => ({ bodyId: body.id, ...edge })))
    .filter((edge) => {
      if (query.curveTypes && !query.curveTypes.some((type) => equalType(type, edge.curveType))) return false;
      if (query.line !== undefined && edge.line !== query.line) return false;
      if (query.circle !== undefined && edge.circle !== query.circle) return false;
      if (query.direction && !matchesDirection(edge.tangent, query.direction)) return false;
      if (query.lengthMm && !matchesScalar(edge.lengthMm, query.lengthMm)) return false;
      if (query.center && !matchesPoint(edge.centerMm, query.center)) return false;
      if (query.boundsMm && !boundsOverlap(edge.boundsMm, query.boundsMm)) return false;
      if (query.adjacentFaceIds && !query.adjacentFaceIds.every((id) => edge.faceIds.includes(id))) return false;
      return true;
    });
}

export function resolvePoint(state: RuntimeState, definition: PointDefinition): Resolution<Vector3> {
  if (definition.type === "coordinates") return resolveGeometry(() => normalizePoint(definition.pointMm));
  if (definition.type === "face-center") {
    const matches = topologyMatches(state, definition.bodyId, "faces", definition.faceId);
    if (matches.length !== 1) return matchFailure("face", matches.length);
    return { status: "resolved", value: [...matches[0]!.centerMm] };
  }
  const matches = topologyMatches(state, definition.bodyId, "edges", definition.edgeId);
  if (matches.length !== 1) return matchFailure("edge", matches.length);
  return { status: "resolved", value: [...matches[0]!.centerMm] };
}

export function resolveAxis(
  state: RuntimeState,
  definition: AxisDefinition,
  registry: DatumRegistry,
  refreshDependencies = false,
): Resolution<AxisLine> {
  if (definition.type === "origin-direction") {
    return resolveGeometry(() => ({ originMm: normalizePoint(definition.originMm), direction: normalize(definition.direction, "Axis direction") }));
  }
  if (definition.type === "two-points") {
    return resolveGeometry(() => {
      const first = refreshDependencies
        ? pointForDerivedAxis(registry, definition.firstId, state)
        : currentPoint(registry, definition.firstId, state);
      const second = refreshDependencies
        ? pointForDerivedAxis(registry, definition.secondId, state)
        : currentPoint(registry, definition.secondId, state);
      return { originMm: [...first.pointMm], direction: normalize(subtract(second.pointMm, first.pointMm), "Two-point axis direction") };
    });
  }
  if (definition.type === "linear-edge") {
    const matches = topologyMatches(state, definition.bodyId, "edges", definition.edgeId);
    if (matches.length !== 1) return matchFailure("edge", matches.length);
    const edge = matches[0]!;
    if (!edge.line) return { status: "unresolved", reason: `Edge ${definition.edgeId} is not linear` };
    return resolveGeometry(() => ({ originMm: [...edge.centerMm], direction: normalize(edge.tangent, "Linear edge direction") }));
  }
  const matches = topologyMatches(state, definition.bodyId, "faces", definition.faceId);
  if (matches.length !== 1) return matchFailure("face", matches.length);
  const face = matches[0]!;
  if (face.axisOriginMm === null || face.axisDirection === null || !/cylinder/i.test(face.surfaceType)) {
    return { status: "unresolved", reason: `Face ${definition.faceId} does not expose an exact cylindrical axis` };
  }
  return resolveGeometry(() => ({ originMm: [...face.axisOriginMm!], direction: normalize(face.axisDirection!, "Cylindrical face axis") }));
}

export function resolvePlaneFrame(
  state: RuntimeState,
  definition: PlaneDefinition,
  registry: DatumRegistry,
): Resolution<PlaneFrame> {
  return resolveGeometry(() => {
    if (definition.type === "explicit") {
      return frameFromOriginNormalX(definition.originMm, definition.normal, definition.xDirection);
    }
    if (definition.type === "three-points") {
      return frameFromThreePoints(
        currentPoint(registry, definition.firstId, state).pointMm,
        currentPoint(registry, definition.secondId, state).pointMm,
        currentPoint(registry, definition.thirdId, state).pointMm,
      );
    }
    if (definition.type === "planar-face") {
      const matches = topologyMatches(state, definition.bodyId, "faces", definition.faceId);
      if (matches.length > 1) throw new AmbiguousResolution(matches.length);
      const face = matches[0];
      if (!face) throw new Error(`Face ${definition.faceId} was not found on body ${definition.bodyId}`);
      if (!face.planar) throw new Error(`Face ${definition.faceId} is not planar`);
      const reference: Vector3 = Math.abs(face.normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      return offsetFrame(frameFromOriginNormalX(face.centerMm, face.normal, reference), definition.offsetMm);
    }
    if (definition.type === "offset") {
      return offsetFrame(currentPlane(registry, definition.planeId, state), definition.offsetMm);
    }
    return rotateFrameAboutAxis(
      currentPlane(registry, definition.planeId, state),
      currentAxis(registry, definition.axisId, state),
      definition.angleDegrees,
    );
  });
}

function topologyMatches<K extends "faces" | "edges">(
  state: RuntimeState,
  bodyId: number,
  kind: K,
  topologyId: string,
): RuntimeState["bodies"][number][K] {
  return state.bodies.filter((body) => body.id === bodyId).flatMap((body) => body[kind].filter((item) => item.id === topologyId)) as RuntimeState["bodies"][number][K];
}

function matchFailure(kind: string, matches: number): Resolution<never> {
  return matches > 1
    ? { status: "ambiguous", matches }
    : { status: "unresolved", reason: `The requested ${kind} was not found` };
}

class AmbiguousResolution extends Error {
  readonly matches: number;

  constructor(matches: number) {
    super(`Geometry reference matched ${matches} topology items`);
    this.matches = matches;
  }
}

function resolveGeometry<T>(operation: () => T): Resolution<T> {
  try {
    return { status: "resolved", value: operation() };
  } catch (error) {
    if (error instanceof AmbiguousResolution) return { status: "ambiguous", matches: error.matches };
    return { status: "unresolved", reason: error instanceof Error ? error.message : String(error) };
  }
}

function normalizePoint(point: Vector3): Vector3 {
  if (point.length !== 3 || point.some((value) => !Number.isFinite(value))) throw new Error("Point coordinates must be finite numbers");
  return [...point];
}

function currentPoint(registry: DatumRegistry, id: string, state: RuntimeState) {
  const record = registry.get(id);
  if (record.kind !== "datum-point") throw new Error(`Datum reference is not a point: ${id}`);
  return registry.requireCurrentPoint(record.identity, state.documentToken, state.revision);
}

function pointForDerivedAxis(registry: DatumRegistry, id: string, state: RuntimeState): { pointMm: Vector3 } {
  const record = registry.get(id);
  if (record.kind !== "datum-point") throw new Error(`Datum reference is not a point: ${id}`);
  if (record.documentToken !== state.documentToken) throw new Error(`Datum point belongs to another Plasticity document: ${id}`);
  if (record.revision === state.revision) return record;
  const resolved = resolvePoint(state, record.definition);
  if (resolved.status === "ambiguous") throw new AmbiguousResolution(resolved.matches);
  if (resolved.status === "unresolved") throw new Error(resolved.reason);
  return { pointMm: resolved.value };
}

function currentAxis(registry: DatumRegistry, id: string, state: RuntimeState) {
  const record = registry.get(id);
  if (record.kind !== "datum-axis") throw new Error(`Datum reference is not an axis: ${id}`);
  return registry.requireCurrentAxis(record.identity, state.documentToken, state.revision);
}

function currentPlane(registry: DatumRegistry, id: string, state: RuntimeState): PlaneFrame {
  const record = registry.get(id);
  if (record.kind !== "construction-plane") throw new Error(`Datum reference is not a plane: ${id}`);
  return registry.requireCurrentPlane(record.identity, state.documentToken, state.revision);
}

function equalType(expected: string, actual: string): boolean {
  return expected.localeCompare(actual, undefined, { sensitivity: "accent" }) === 0;
}

function matchesNullableScalar(actual: number | null, expected: ScalarMatch): boolean {
  return actual !== null && matchesScalar(actual, expected);
}

function matchesScalar(actual: number, expected: ScalarMatch): boolean {
  return Math.abs(actual - expected.value) <= expected.tolerance;
}

function matchesPoint(actual: Vector3, expected: PointMatch): boolean {
  return distance(actual, expected.pointMm) <= expected.toleranceMm;
}

function matchesDirection(actual: Vector3, expected: DirectionMatch): boolean {
  const actualLength = magnitude(actual);
  const expectedLength = magnitude(expected.vector);
  if (actualLength === 0 || expectedLength === 0) return false;
  let cosine = dot(actual, expected.vector) / (actualLength * expectedLength);
  if (!expected.oriented) cosine = Math.abs(cosine);
  cosine = Math.max(-1, Math.min(1, cosine));
  return Math.acos(cosine) * 180 / Math.PI <= expected.toleranceDeg;
}

function boundsOverlap(left: Bounds, right: Bounds): boolean {
  return left.min.every((value, axis) => value <= right.max[axis]!) &&
    right.min.every((value, axis) => value <= left.max[axis]!);
}

function magnitude(value: Vector3): number {
  return Math.sqrt(dot(value, value));
}

function dot(left: Vector3, right: Vector3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function distance(left: Vector3, right: Vector3): number {
  return Math.sqrt(
    (left[0] - right[0]) ** 2 +
    (left[1] - right[1]) ** 2 +
    (left[2] - right[2]) ** 2,
  );
}
