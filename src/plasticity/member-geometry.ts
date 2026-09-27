import type { CadBinding } from "../strength/contracts.ts";
import type { PlasticityRuntime } from "./runtime.ts";

type Vector3 = [number, number, number];

// Native topology coordinates should agree much more closely than the public
// 0.01 mm dimensional acceptance tolerance. This only absorbs floating-point
// projection noise; it must not turn a tapered body into a prism.
export const NATIVE_LINEAR_TOLERANCE_MM = 0.000_01;
const ANGULAR_TOLERANCE = 1e-8;

export interface MemberRequest {
  bodyId: number;
  revision: string;
  lengthAxis: Vector3;
  heightAxis: Vector3;
}

export interface MemberEvidence {
  binding: CadBinding;
  status: "verified" | "unsupported";
  dimensions?: { lengthMm: number; widthMm: number; heightMm: number };
  source: "native-brep";
  reasons: string[];
}

export interface RectangularTopology {
  solid: boolean;
  checkCodes: number[];
  vertices: { id: number; pointMm: Vector3 }[];
  edges: { id: string; linear: boolean; vertices: [number, number]; faceIds: string[] }[];
  faces: { id: string; planar: boolean; normal: Vector3; edgeIds: string[] }[];
}

export interface MemberFrame {
  lengthAxis: Vector3;
  heightAxis: Vector3;
}

export type TopologyVerification =
  | { status: "verified"; lengthMm: number; widthMm: number; heightMm: number }
  | { status: "unsupported"; reasons: string[] };

export function verifyRectangularTopology(
  topology: RectangularTopology,
  frame: MemberFrame,
): TopologyVerification {
  const reasons = new Set<string>();
  const axes = memberAxes(frame, reasons);

  if (!topology.solid) reasons.add("body-is-not-solid");
  if (topology.checkCodes.length > 0) reasons.add("native-check-failed");
  if (topology.vertices.length !== 8) reasons.add("expected-eight-vertices");
  if (topology.edges.length !== 12) reasons.add("expected-twelve-edges");
  if (topology.faces.length !== 6) reasons.add("expected-six-faces");
  if (!axes) return unsupported(reasons);

  const vertexById = uniqueMap(topology.vertices, (vertex) => vertex.id, "duplicate-vertex-id", reasons);
  const edgeById = uniqueMap(topology.edges, (edge) => edge.id, "duplicate-edge-id", reasons);
  const faceById = uniqueMap(topology.faces, (face) => face.id, "duplicate-face-id", reasons);

  for (const vertex of topology.vertices) {
    if (!Number.isInteger(vertex.id) || !finiteVector(vertex.pointMm)) reasons.add("invalid-vertex");
  }
  if (hasCoincidentVertices(topology.vertices)) reasons.add("coincident-vertices");

  const projected = new Map<number, Vector3>();
  for (const vertex of topology.vertices) {
    projected.set(vertex.id, axes.map((axis) => dot(vertex.pointMm, axis)) as Vector3);
  }
  const levels = [0, 1, 2].map((axisIndex) => clusterLevels(
    topology.vertices.map((vertex) => projected.get(vertex.id)![axisIndex]!),
  ));
  if (levels.some((axisLevels) => axisLevels.length !== 2)) reasons.add("vertices-do-not-form-cartesian-prism");

  const cornerByVertex = new Map<number, [number, number, number]>();
  if (levels.every((axisLevels) => axisLevels.length === 2)) {
    const seenCorners = new Set<string>();
    for (const vertex of topology.vertices) {
      const point = projected.get(vertex.id)!;
      const corner = point.map((coordinate, axisIndex) => nearestLevel(coordinate, levels[axisIndex]!)) as [number, number, number];
      if (corner.some((index) => index < 0)) {
        reasons.add("vertices-do-not-form-cartesian-prism");
        continue;
      }
      const key = corner.join(":");
      if (seenCorners.has(key)) reasons.add("duplicate-prism-corner");
      seenCorners.add(key);
      cornerByVertex.set(vertex.id, corner);
    }
    if (seenCorners.size !== 8) reasons.add("vertices-do-not-form-cartesian-prism");
  }

  const edgeFamilies: [number, number, number] = [0, 0, 0];
  const vertexDegree = new Map<number, number>();
  const vertexPairs = new Set<string>();
  for (const edge of topology.edges) {
    if (!edge.linear) reasons.add("nonlinear-edge");
    if (edge.vertices[0] === edge.vertices[1] || !vertexById.has(edge.vertices[0]) || !vertexById.has(edge.vertices[1])) {
      reasons.add("invalid-edge-vertices");
    } else {
      const pair = [...edge.vertices].sort((left, right) => left - right).join(":");
      if (vertexPairs.has(pair)) reasons.add("duplicate-edge-vertices");
      vertexPairs.add(pair);
      vertexDegree.set(edge.vertices[0], (vertexDegree.get(edge.vertices[0]) ?? 0) + 1);
      vertexDegree.set(edge.vertices[1], (vertexDegree.get(edge.vertices[1]) ?? 0) + 1);
      const first = cornerByVertex.get(edge.vertices[0]);
      const second = cornerByVertex.get(edge.vertices[1]);
      if (first && second) {
        const changed = first.flatMap((value, index) => value === second[index] ? [] : [index]);
        if (changed.length !== 1) reasons.add("edge-is-not-prism-side");
        else {
          const family = changed[0]!;
          edgeFamilies[family] = (edgeFamilies[family] ?? 0) + 1;
        }
      }
    }
    if (edge.faceIds.length !== 2 || new Set(edge.faceIds).size !== 2) reasons.add("edge-is-not-manifold");
    for (const faceId of edge.faceIds) {
      const face = faceById.get(faceId);
      if (!face || !face.edgeIds.includes(edge.id)) reasons.add("inconsistent-face-edge-incidence");
    }
  }
  if ([...vertexDegree.values()].some((degree) => degree !== 3) || vertexDegree.size !== 8) reasons.add("invalid-vertex-degree");
  if (edgeFamilies.some((count) => count !== 4)) reasons.add("invalid-edge-families");

  const faceFamilies: [number, number, number] = [0, 0, 0];
  for (const face of topology.faces) {
    if (!face.planar) reasons.add("nonplanar-face");
    if (face.edgeIds.length !== 4 || new Set(face.edgeIds).size !== 4) reasons.add("face-is-not-quadrilateral");
    const faceEdges = face.edgeIds.map((edgeId) => edgeById.get(edgeId));
    if (faceEdges.some((edge) => edge === undefined)) {
      reasons.add("unknown-face-edge");
      continue;
    }
    const faceVertexIds = new Set(faceEdges.flatMap((edge) => edge!.vertices));
    if (faceEdges.some((edge) => !edge!.faceIds.includes(face.id))) reasons.add("inconsistent-face-edge-incidence");
    if (faceVertexIds.size !== 4) reasons.add("face-is-not-rectangular-cycle");
    const faceDegrees = new Map<number, number>();
    for (const edge of faceEdges) {
      for (const vertexId of edge!.vertices) faceDegrees.set(vertexId, (faceDegrees.get(vertexId) ?? 0) + 1);
    }
    if ([...faceDegrees.values()].some((degree) => degree !== 2)) reasons.add("face-is-not-rectangular-cycle");

    const corners = [...faceVertexIds].map((id) => cornerByVertex.get(id)).filter((value): value is [number, number, number] => value !== undefined);
    if (corners.length !== 4) continue;
    const fixed = [0, 1, 2].filter((axisIndex) => corners.every((corner) => corner[axisIndex] === corners[0]![axisIndex]));
    if (fixed.length !== 1) {
      reasons.add("face-is-not-prism-plane");
      continue;
    }
    const family = fixed[0]!;
    faceFamilies[family] = (faceFamilies[family] ?? 0) + 1;
    const normal = normalize(face.normal);
    if (!normal) {
      reasons.add("invalid-face-normal");
      continue;
    }
    const side = corners[0]![family]!;
    const outward = side === 0 ? -1 : 1;
    if (dot(normal, axes[family]!) * outward < 1 - ANGULAR_TOLERANCE) reasons.add("face-normal-is-not-outward");
  }
  if (faceFamilies.some((count) => count !== 2)) reasons.add("invalid-face-families");

  if (reasons.size > 0) return unsupported(reasons);
  const dimensions = levels.map((axisLevels) => axisLevels[1]! - axisLevels[0]!);
  if (dimensions.some((dimension) => !Number.isFinite(dimension) || dimension <= NATIVE_LINEAR_TOLERANCE_MM)) {
    return { status: "unsupported", reasons: ["degenerate-dimensions"] };
  }
  return {
    status: "verified",
    lengthMm: stableMeasurement(dimensions[0]!),
    widthMm: stableMeasurement(dimensions[1]!),
    heightMm: stableMeasurement(dimensions[2]!),
  };
}

export async function inspectRectangularMember(
  runtime: PlasticityRuntime,
  request: MemberRequest,
  sessionId: string,
): Promise<MemberEvidence> {
  if (!sessionId) throw new Error("MCP session ID is required");
  const before = await runtime.getState();
  const binding: CadBinding = {
    sessionId,
    documentToken: before.documentToken,
    revision: request.revision,
    bodyId: request.bodyId,
  };
  if (before.revision !== request.revision) return unsupportedEvidence(binding, ["stale-reference"]);
  if (!before.bodies.some((body) => body.id === request.bodyId)) return unsupportedEvidence(binding, ["unknown-body"]);

  const topology = await runtime.readNative<RectangularTopology | null>(`function (args) {
    const mm = value => value * 1000;
    const point = value => [mm(value.x), mm(value.y), mm(value.z)];
    const direction = value => [value.x, value.y, value.z];
    for (const [versionId, item] of this.geo.geometryModel) {
      const bodyId = this.db.lookupStableId(versionId);
      if (bodyId !== args.bodyId) continue;
      const model = item.model;
      if (!model || typeof model.Check !== 'function') return null;
      const faceViews = item.view?.high?.faces;
      const edgeViews = item.view?.high?.edges;
      const faceIdByEntity = new Map();
      const edgeIdByEntity = new Map();
      for (let index = 0; index < (faceViews?.versionIds?.length ?? 0); index += 1) {
        const view = faceViews.get(index);
        if (view) faceIdByEntity.set(view.entityId, String(faceViews.versionIds[index]));
      }
      for (let index = 0; index < (edgeViews?.versionIds?.length ?? 0); index += 1) {
        const view = edgeViews.get(index);
        if (view) edgeIdByEntity.set(view.entityId, String(edgeViews.versionIds[index]));
      }
      const vertexById = new Map();
      const vertexConflicts = [];
      const putVertex = (vertex, nativePoint) => {
        const id = Number(vertex?.Id?.());
        if (!Number.isInteger(id)) return;
        const pointMm = point(nativePoint);
        const prior = vertexById.get(id);
        if (prior && prior.pointMm.some((value, index) => Math.abs(value - pointMm[index]) > ${NATIVE_LINEAR_TOLERANCE_MM})) {
          vertexConflicts.push({ id, pointMm });
        } else if (!prior) vertexById.set(id, { id, pointMm });
      };
      const modelEdges = model.GetEdges();
      const edges = [];
      for (let index = 0; index < modelEdges.Size(); index += 1) {
        const edge = modelEdges.Get(index);
        const id = edgeIdByEntity.get(edge.Id());
        const vertices = edge.GetVertices();
        const start = edge.GetPointAndTangent(0).position;
        const end = edge.GetPointAndTangent(1).position;
        putVertex(vertices.left, typeof vertices.left?.GetPoint === 'function' ? vertices.left.GetPoint() : start);
        putVertex(vertices.right, typeof vertices.right?.GetPoint === 'function' ? vertices.right.GetPoint() : end);
        const adjacentFaces = edge.GetFaces();
        const faceIds = [];
        for (let faceIndex = 0; faceIndex < adjacentFaces.Size(); faceIndex += 1) {
          const faceId = faceIdByEntity.get(adjacentFaces.Get(faceIndex).Id());
          if (faceId) faceIds.push(faceId);
        }
        edges.push({
          id: id ?? 'unmapped-edge:' + edge.Id(),
          linear: edge.IsLine(),
          vertices: [Number(vertices.left?.Id?.()), Number(vertices.right?.Id?.())],
          faceIds,
        });
      }
      const modelFaces = model.GetFaces();
      const faces = [];
      for (let index = 0; index < modelFaces.Size(); index += 1) {
        const face = modelFaces.Get(index);
        const id = faceIdByEntity.get(face.Id());
        const faceEdges = face.GetEdges();
        const edgeIds = [];
        for (let edgeIndex = 0; edgeIndex < faceEdges.Size(); edgeIndex += 1) {
          const edgeId = edgeIdByEntity.get(faceEdges.Get(edgeIndex).Id());
          if (edgeId) edgeIds.push(edgeId);
        }
        faces.push({
          id: id ?? 'unmapped-face:' + face.Id(),
          planar: face.IsPlanar(),
          normal: direction(face.FindMidpoint().normal),
          edgeIds,
        });
      }
      return {
        solid: item.view?.constructor?.name === 'Solid',
        checkCodes: Array.from(model.Check(), Number),
        vertices: [...vertexById.values(), ...vertexConflicts],
        edges,
        faces,
      };
    }
    return null;
  }`, [], [{ bodyId: request.bodyId }]);

  const after = await runtime.getState();
  if (after.documentToken !== before.documentToken || after.revision !== before.revision) {
    return unsupportedEvidence(binding, ["stale-reference"]);
  }
  if (!topology) return unsupportedEvidence(binding, ["native-topology-unavailable"]);

  const verification = verifyRectangularTopology(topology, request);
  if (verification.status === "unsupported") return unsupportedEvidence(binding, verification.reasons);
  return {
    binding,
    status: "verified",
    dimensions: {
      lengthMm: verification.lengthMm,
      widthMm: verification.widthMm,
      heightMm: verification.heightMm,
    },
    source: "native-brep",
    reasons: [],
  };
}

function memberAxes(frame: MemberFrame, reasons: Set<string>): [Vector3, Vector3, Vector3] | null {
  const length = normalize(frame.lengthAxis);
  const height = normalize(frame.heightAxis);
  if (!length || !height) {
    reasons.add("invalid-member-axes");
    return null;
  }
  if (Math.abs(dot(length, height)) > ANGULAR_TOLERANCE) {
    reasons.add("member-axes-are-not-perpendicular");
    return null;
  }
  const width = normalize(cross(height, length));
  if (!width) {
    reasons.add("invalid-member-axes");
    return null;
  }
  return [length, width, height];
}

function unsupported(reasons: Set<string>): TopologyVerification {
  return { status: "unsupported", reasons: [...reasons].sort() };
}

function unsupportedEvidence(binding: CadBinding, reasons: string[]): MemberEvidence {
  return { binding, status: "unsupported", source: "native-brep", reasons: [...new Set(reasons)].sort() };
}

function uniqueMap<T, K>(items: T[], key: (item: T) => K, reason: string, reasons: Set<string>): Map<K, T> {
  const result = new Map<K, T>();
  for (const item of items) {
    const value = key(item);
    if (result.has(value)) reasons.add(reason);
    result.set(value, item);
  }
  return result;
}

function hasCoincidentVertices(vertices: RectangularTopology["vertices"]): boolean {
  return vertices.some((left, index) => vertices.slice(index + 1).some((right) =>
    Math.hypot(...left.pointMm.map((value, axis) => value - right.pointMm[axis]!)) <= NATIVE_LINEAR_TOLERANCE_MM
  ));
}

function clusterLevels(values: number[]): number[] {
  if (values.some((value) => !Number.isFinite(value))) return [];
  const sorted = [...values].sort((left, right) => left - right);
  const levels: number[] = [];
  for (const value of sorted) {
    const prior = levels.at(-1);
    if (prior === undefined || Math.abs(value - prior) > NATIVE_LINEAR_TOLERANCE_MM) levels.push(value);
  }
  return levels;
}

function nearestLevel(value: number, levels: number[]): number {
  const index = levels.findIndex((level) => Math.abs(value - level) <= NATIVE_LINEAR_TOLERANCE_MM);
  return index;
}

function normalize(vector: Vector3): Vector3 | null {
  if (!finiteVector(vector)) return null;
  const length = Math.hypot(...vector);
  if (length <= Number.EPSILON) return null;
  return vector.map((value) => value / length) as Vector3;
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

function finiteVector(vector: Vector3): boolean {
  return vector.length === 3 && vector.every(Number.isFinite);
}

function stableMeasurement(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}
