import type { RuntimeState } from "./runtime.ts";
import { measureNonparallelPolygonClearance } from "./polygon-clearance.ts";

export type Vector3 = [number, number, number];

export type MeasurementPointReference =
  | { type: "coordinates"; pointMm: Vector3 }
  | { type: "vertex"; bodyId: number; vertexId: number }
  | { type: "edge-midpoint"; bodyId: number; edgeId: string }
  | { type: "face-center"; bodyId: number; faceId: string };

export interface FaceReference {
  bodyId: number;
  faceId: string;
}

export interface EdgeReference {
  bodyId: number;
  edgeId: string;
}

export interface WireSegmentReference {
  bodyId: number;
  segmentEntityId: number;
}

export interface NativeSampledWireCurveSegment extends WireSegmentReference {
  curveType: string;
  lengthMm: number;
  linear: boolean;
  circular: boolean;
}

export interface NativeWireCircularSegment {
  segmentEntityId: number;
  lengthMm: number;
  circleGeometry: NonNullable<RuntimeState["bodies"][number]["edges"][number]["circleGeometry"]>;
}

export interface FastenerGripLayerReference {
  id: string;
  first: FaceReference;
  second: FaceReference;
}

type FaceBoundarySegment = {
  id: string;
  startVertexId: number;
  endVertexId: number;
  startPointMm: Vector3;
  endPointMm: Vector3;
  curve: { kind: "line" } | {
    kind: "arc";
    centerMm: Vector3;
    radiusMm: number;
    normal: Vector3;
    reference: Vector3;
    secondAxis: Vector3;
    startAngleRadians: number;
    sweepRadians: number;
  };
};

type FullCircleBoundary = {
  id: string;
  centerMm: Vector3;
  radiusMm: number;
};

type FullCircleBoundary2d = {
  id: string;
  center: [number, number];
  radiusMm: number;
};

export function measurePointDistance(
  state: RuntimeState,
  first: MeasurementPointReference,
  second: MeasurementPointReference,
  revision: string,
) {
  requireRevision(state, revision);
  const firstPoint = resolveMeasurementPoint(state, first);
  const secondPoint = resolveMeasurementPoint(state, second);
  const deltaMm = subtract(secondPoint, firstPoint);
  return {
    documentToken: state.documentToken,
    revision: state.revision,
    measurementSource: pointMeasurementSource(first, second),
    first: { reference: first, pointMm: firstPoint },
    second: { reference: second, pointMm: secondPoint },
    deltaMm,
    distanceMm: magnitude(deltaMm),
  };
}

export function measurePointToLinearEdge(
  state: RuntimeState,
  point: MeasurementPointReference,
  edgeReference: EdgeReference,
  revision: string,
) {
  requireRevision(state, revision);
  const pointMm = resolveMeasurementPoint(state, point);
  const edge = requireEdge(state, edgeReference);
  if (!edge.line) throw new Error("Measurement edge must be linear");
  if (!Number.isFinite(edge.lengthMm) || edge.lengthMm <= 0) throw new Error("Measurement edge length must be positive and finite");
  const direction = normalize(edge.tangent, "Measurement edge direction");
  const startMm = subtract(edge.centerMm, scale(direction, edge.lengthMm / 2));
  const projectedDistanceMm = dot(subtract(pointMm, startMm), direction);
  const unclampedEdgeParameter = projectedDistanceMm / edge.lengthMm;
  const infiniteLineProjectionMm = add(startMm, scale(direction, projectedDistanceMm));
  const clampedDistanceMm = clamp(projectedDistanceMm, 0, edge.lengthMm);
  const closestPointMm = add(startMm, scale(direction, clampedDistanceMm));
  const toInfiniteLine = subtract(pointMm, infiniteLineProjectionMm);
  const toFiniteSegment = subtract(pointMm, closestPointMm);
  return {
    documentToken: state.documentToken,
    revision: state.revision,
    measurementSource: point.type === "coordinates" ? "native-brep-and-explicit-coordinates" as const : "native-brep" as const,
    point: { reference: point, pointMm },
    edge: { ...edgeReference, pointMm: edge.centerMm, direction, lengthMm: edge.lengthMm },
    infiniteLineProjectionMm,
    closestPointMm,
    supportingLineDistanceMm: magnitude(toInfiniteLine),
    finiteSegmentDistanceMm: magnitude(toFiniteSegment),
    unclampedEdgeParameter,
    clampedToEndpoint: unclampedEdgeParameter < 0 || unclampedEdgeParameter > 1,
  };
}

export function measurePointToSampledCurveEdge(
  state: RuntimeState,
  point: MeasurementPointReference,
  edgeReference: EdgeReference | WireSegmentReference,
  revision: string,
  samples: Array<{ normalizedParameter: number; positionMm: Vector3 }>,
  approximation: { requestedToleranceMm: number; maxObservedChordDeviationMm: number },
  wireSegment?: NativeSampledWireCurveSegment,
) {
  requireRevision(state, revision);
  const pointMm = resolveMeasurementPoint(state, point);
  let curveType: string;
  let lengthMm: number;
  if ("edgeId" in edgeReference) {
    const edge = requireEdge(state, edgeReference);
    if (edge.line || edge.circle) throw new Error("Sampled curved-edge measurement requires a non-linear, non-circular B-Rep edge");
    curveType = edge.curveType;
    lengthMm = edge.lengthMm;
  } else {
    const body = state.bodies.find((candidate) => candidate.id === edgeReference.bodyId);
    if (body?.type !== "Wire" || !wireSegment || wireSegment.bodyId !== edgeReference.bodyId || wireSegment.segmentEntityId !== edgeReference.segmentEntityId) {
      throw new Error("Sampled curved-edge measurement requires current Wire segment geometry");
    }
    if (wireSegment.linear || wireSegment.circular) throw new Error("Sampled curved-edge measurement requires a non-linear, non-circular B-Rep edge");
    curveType = wireSegment.curveType;
    lengthMm = wireSegment.lengthMm;
  }
  requirePositiveFinite(lengthMm, "Measurement edge length");
  requirePositiveFinite(approximation.requestedToleranceMm, "Requested curve approximation tolerance");
  if (!Number.isFinite(approximation.maxObservedChordDeviationMm) || approximation.maxObservedChordDeviationMm < 0) {
    throw new Error("Observed curve chord deviation must be finite and nonnegative");
  }
  if (samples.length < 2) throw new Error("At least two native curve samples are required");
  let previousParameter = -1;
  for (const sample of samples) {
    if (!Number.isFinite(sample.normalizedParameter) || sample.normalizedParameter < 0 || sample.normalizedParameter > 1 || sample.normalizedParameter <= previousParameter) {
      throw new Error("Native curve sample parameters must be finite, strictly ascending, and within 0..1");
    }
    if (sample.positionMm.length !== 3 || sample.positionMm.some((value) => !Number.isFinite(value))) {
      throw new Error("Native curve sample positions must contain three finite coordinates");
    }
    previousParameter = sample.normalizedParameter;
  }
  if (samples[0]!.normalizedParameter !== 0 || samples.at(-1)!.normalizedParameter !== 1) {
    throw new Error("Native curve samples must include both trimmed-edge endpoints");
  }

  let closestPointEstimateMm: Vector3 | undefined;
  let closestParameterEstimate: number | undefined;
  let estimatedDistanceMm = Number.POSITIVE_INFINITY;
  for (let index = 0; index < samples.length - 1; index += 1) {
    const first = samples[index]!;
    const second = samples[index + 1]!;
    const segment = subtract(second.positionMm, first.positionMm);
    const segmentLengthSquared = dot(segment, segment);
    const fraction = segmentLengthSquared === 0
      ? 0
      : clamp(dot(subtract(pointMm, first.positionMm), segment) / segmentLengthSquared, 0, 1);
    const candidate = add(first.positionMm, scale(segment, fraction));
    const distanceMm = magnitude(subtract(pointMm, candidate));
    if (distanceMm < estimatedDistanceMm) {
      estimatedDistanceMm = distanceMm;
      closestPointEstimateMm = candidate;
      closestParameterEstimate = first.normalizedParameter + (second.normalizedParameter - first.normalizedParameter) * fraction;
    }
  }
  if (!closestPointEstimateMm || closestParameterEstimate === undefined || !Number.isFinite(estimatedDistanceMm)) {
    throw new Error("Could not find a finite sampled point-to-curve distance");
  }
  return {
    documentToken: state.documentToken,
    revision: state.revision,
    exact: false as const,
    measurementSource: "native-brep-sampled-polyline" as const,
    point: { reference: point, pointMm },
    edge: { ...edgeReference, curveType, lengthMm },
    closestPointEstimateMm,
    normalizedParameterEstimate: closestParameterEstimate,
    estimatedDistanceMm,
    approximationToleranceMm: approximation.requestedToleranceMm,
    maxObservedChordDeviationMm: approximation.maxObservedChordDeviationMm,
    toleranceObserved: approximation.maxObservedChordDeviationMm <= approximation.requestedToleranceMm,
    sampleCount: samples.length,
  };
}

export function measurePointToCircularEdge(
  state: RuntimeState,
  point: MeasurementPointReference,
  edgeReference: EdgeReference | WireSegmentReference,
  revision: string,
  wireSegment?: NativeWireCircularSegment,
) {
  requireRevision(state, revision);
  const pointMm = resolveMeasurementPoint(state, point);
  const edge = "edgeId" in edgeReference
    ? requireEdge(state, edgeReference)
    : resolveWireCircularSegment(state, edgeReference, wireSegment);
  const circle = edge.circleGeometry;
  if (!edge.circle || circle === undefined) throw new Error("Measurement edge requires exact circular B-Rep geometry");
  const circleCenterMm = circle.centerMm;
  requirePositiveFinite(circle.radiusMm, "Measurement circle radius");
  requirePositiveFinite(edge.lengthMm, "Measurement edge length");
  const normal = normalize(circle.normal, "Measurement circle normal");
  const reference = normalize(circle.reference, "Measurement circle reference");
  if (Math.abs(dot(normal, reference)) > 1e-6) throw new Error("Measurement circle reference must lie in its plane");
  const secondAxis = normalize(cross(normal, reference), "Measurement circle second axis");
  const radiusMm = circle.radiusMm;
  const circumferenceMm = 2 * Math.PI * radiusMm;
  const fullCircle = Math.abs(edge.lengthMm - circumferenceMm) <= Math.max(1e-6, circumferenceMm * 1e-9);
  if (edge.lengthMm > circumferenceMm + Math.max(1e-6, circumferenceMm * 1e-9)) {
    throw new Error("Measurement circular edge length exceeds one full circumference");
  }
  const startVector = validateCirclePoint(circle.startMm, circleCenterMm, normal, radiusMm, "start");
  const midpointVector = validateCirclePoint(circle.midpointMm, circleCenterMm, normal, radiusMm, "midpoint");
  const endVector = validateCirclePoint(circle.endMm, circleCenterMm, normal, radiusMm, "end");
  const startAngle = circleAngle(startVector, reference, secondAxis);
  const midpointAngle = circleAngle(midpointVector, reference, secondAxis);
  const endAngle = circleAngle(endVector, reference, secondAxis);
  let sweepRadians = 2 * Math.PI;
  if (!fullCircle) {
    const positiveSweep = positiveAngle(endAngle - startAngle);
    const midpointOnPositiveSweep = positiveAngle(midpointAngle - startAngle) <= positiveSweep + 1e-9;
    sweepRadians = midpointOnPositiveSweep ? positiveSweep : positiveSweep - 2 * Math.PI;
    if (Math.abs(sweepRadians) <= 1e-9 || Math.abs(Math.abs(sweepRadians) * radiusMm - edge.lengthMm) > Math.max(1e-5, edge.lengthMm * 1e-8)) {
      throw new Error("Measurement circular arc trim does not match its exact native length");
    }
  }

  const relativePoint = subtract(pointMm, circleCenterMm);
  const axialDistanceMm = dot(relativePoint, normal);
  const radialVector = subtract(relativePoint, scale(normal, axialDistanceMm));
  const radialLengthMm = magnitude(radialVector);
  const supportingCircleDistanceMm = Math.hypot(axialDistanceMm, radialLengthMm - radiusMm);
  let normalizedArcParameter: number | null = null;
  let closestPointMm: Vector3;
  let clampedToEndpoint = false;
  const angularTolerance = 1e-9;
  if (radialLengthMm <= 1e-12) {
    closestPointMm = [...circle.startMm];
  } else {
    const projectedAngle = circleAngle(radialVector, reference, secondAxis);
    const parameter = fullCircle
      ? positiveAngle(projectedAngle - startAngle) / (2 * Math.PI)
      : circularArcParameter(projectedAngle, startAngle, sweepRadians, angularTolerance);
    if (parameter !== null) {
      normalizedArcParameter = parameter;
      const closestAngle = startAngle + sweepRadians * parameter;
      const radialDirection = add(scale(reference, Math.cos(closestAngle)), scale(secondAxis, Math.sin(closestAngle)));
      closestPointMm = add(circleCenterMm, scale(radialDirection, radiusMm));
    } else {
      const startDistanceMm = magnitude(subtract(pointMm, circle.startMm));
      const endDistanceMm = magnitude(subtract(pointMm, circle.endMm));
      if (startDistanceMm <= endDistanceMm) {
        closestPointMm = [...circle.startMm];
        clampedToEndpoint = true;
      } else {
        closestPointMm = [...circle.endMm];
        clampedToEndpoint = true;
      }
    }
  }
  return {
    documentToken: state.documentToken,
    revision: state.revision,
    measurementSource: point.type === "coordinates" ? "native-brep-and-explicit-coordinates" as const : "native-brep" as const,
    method: "native-brep-circular-trim" as const,
    point: { reference: point, pointMm },
    edge: {
      ...edgeReference,
      centerMm: circleCenterMm,
      radiusMm,
      normal,
      reference,
      startAngleRadians: startAngle,
      sweepRadians,
      lengthMm: edge.lengthMm,
      fullCircle,
    },
    closestPointMm,
    supportingCircleDistanceMm,
    finiteArcDistanceMm: magnitude(subtract(pointMm, closestPointMm)),
    normalizedArcParameter,
    clampedToEndpoint,
  };
}

function resolveWireCircularSegment(
  state: RuntimeState,
  reference: WireSegmentReference,
  segment: NativeWireCircularSegment | undefined,
): Pick<RuntimeState["bodies"][number]["edges"][number], "circle" | "lengthMm" | "circleGeometry"> {
  const body = state.bodies.find((candidate) => candidate.id === reference.bodyId);
  if (!body || body.type !== "Wire") throw new Error("Circular segment reference must belong to a current Wire");
  if (!Number.isInteger(reference.segmentEntityId) || reference.segmentEntityId < 0) throw new Error("Circular Wire segment entity ID must be a nonnegative integer");
  if (!segment || segment.segmentEntityId !== reference.segmentEntityId) throw new Error("Circular Wire segment metadata is unavailable or stale");
  return {
    circle: true,
    lengthMm: segment.lengthMm,
    circleGeometry: segment.circleGeometry,
  };
}

export function measurePointToPlanarFace(
  state: RuntimeState,
  point: MeasurementPointReference,
  faceReference: FaceReference,
  revision: string,
) {
  requireRevision(state, revision);
  const pointMm = resolveMeasurementPoint(state, point);
  const face = requireFace(state, faceReference);
  if (!face.planar) throw new Error("Measurement face must be planar");
  if (face.edgeIds.length < 1 || face.edgeIds.length > 8192) {
    throw new Error("Measurement face must have between 1 and 8192 boundary edges");
  }
  const body = state.bodies.find((candidate) => candidate.id === faceReference.bodyId);
  if (!body?.vertices) throw new Error("Measurement face requires exact native B-Rep vertices");
  if (new Set(face.edgeIds).size !== face.edgeIds.length) throw new Error("Measurement face boundary contains duplicate edges");
  const vertexById = new Map(body.vertices.map((vertex) => [vertex.id, vertex]));
  const normal = normalize(face.normal, "Measurement face normal");
  const boundarySegments: FaceBoundarySegment[] = [];
  const fullCircleBoundaries: FullCircleBoundary[] = [];
  for (const edgeId of face.edgeIds) {
    const edge = requireEdge(state, { bodyId: faceReference.bodyId, edgeId });
    if (!edge.line) {
      if (!edge.circle || edge.circleGeometry === undefined) {
        throw new Error("Measurement face supports only linear edges and exact circular arcs");
      }
      const circle = edge.circleGeometry;
      requirePositiveFinite(circle.radiusMm, "Measurement circle radius");
      const circumferenceMm = 2 * Math.PI * circle.radiusMm;
      const circleCheck = measurePointToCircularEdge(state, point, { bodyId: faceReference.bodyId, edgeId }, revision);
      if (Math.abs(dot(circleCheck.edge.normal, normal)) < 1 - 1e-6) {
        throw new Error(`Measurement face circular boundary edge ${edgeId} must lie in the planar face`);
      }
      if (Math.abs(dot(subtract(circle.centerMm, face.centerMm), normal)) > 1e-6) {
        throw new Error(`Measurement face circular boundary edge ${edgeId} is not on the reported planar face`);
      }
      if (circleCheck.edge.fullCircle) {
        if (Math.abs(edge.lengthMm - circumferenceMm) > Math.max(1e-6, circumferenceMm * 1e-9)) {
          throw new Error(`Measurement face circular boundary edge ${edgeId} must be a complete circle`);
        }
        if (edge.vertexIds.length > 1) throw new Error(`Measurement face circular boundary edge ${edgeId} must be a full circle without distinct endpoints`);
        if (edge.vertexIds.length === 1) {
        const seamVertex = vertexById.get(edge.vertexIds[0]!);
        if (!seamVertex || magnitude(subtract(seamVertex.positionMm, circle.startMm)) > 1e-6) {
          throw new Error(`Measurement face circular boundary edge ${edgeId} has incomplete seam-vertex topology`);
        }
        }
        fullCircleBoundaries.push({ id: edgeId, centerMm: circle.centerMm, radiusMm: circle.radiusMm });
        continue;
      }
      if (edge.vertexIds.length !== 2 || edge.vertexIds[0] === edge.vertexIds[1]) {
        throw new Error(`Measurement face circular arc ${edgeId} must have two distinct endpoint vertices`);
      }
      const firstVertex = vertexById.get(edge.vertexIds[0]!);
      const secondVertex = vertexById.get(edge.vertexIds[1]!);
      if (!firstVertex || !secondVertex) throw new Error(`Measurement face circular arc ${edgeId} has unavailable endpoint vertices`);
      const endpointToleranceMm = 1e-6;
      const firstStart = magnitude(subtract(firstVertex.positionMm, circle.startMm)) <= endpointToleranceMm;
      const firstEnd = magnitude(subtract(firstVertex.positionMm, circle.endMm)) <= endpointToleranceMm;
      const secondStart = magnitude(subtract(secondVertex.positionMm, circle.startMm)) <= endpointToleranceMm;
      const secondEnd = magnitude(subtract(secondVertex.positionMm, circle.endMm)) <= endpointToleranceMm;
      let startVertex: typeof firstVertex;
      let endVertex: typeof secondVertex;
      if (firstStart && secondEnd) {
        startVertex = firstVertex;
        endVertex = secondVertex;
      } else if (secondStart && firstEnd) {
        startVertex = secondVertex;
        endVertex = firstVertex;
      } else {
        throw new Error(`Measurement face circular arc ${edgeId} endpoint vertices do not match native arc trim`);
      }
      for (const vertex of [startVertex, endVertex]) {
        const planeOffsetMm = dot(subtract(vertex.positionMm, face.centerMm), normal);
        if (Math.abs(planeOffsetMm) > 1e-6) throw new Error(`Measurement face circular arc ${edgeId} is not on the reported planar face`);
      }
      const circleReference = normalize(circle.reference, "Measurement circle reference");
      boundarySegments.push({
        id: edgeId,
        startVertexId: startVertex.id,
        endVertexId: endVertex.id,
        startPointMm: circle.startMm,
        endPointMm: circle.endMm,
        curve: {
          kind: "arc",
          centerMm: circle.centerMm,
          radiusMm: circle.radiusMm,
          normal: circleCheck.edge.normal,
          reference: circleReference,
          secondAxis: normalize(cross(circleCheck.edge.normal, circleReference), "Measurement circle second axis"),
          startAngleRadians: circleCheck.edge.startAngleRadians,
          sweepRadians: circleCheck.edge.sweepRadians,
        },
      });
      continue;
    }
    if (edge.vertexIds.length !== 2 || edge.vertexIds[0] === edge.vertexIds[1]) {
      throw new Error(`Measurement face boundary edge ${edgeId} must have two distinct endpoint vertices`);
    }
    const firstVertexId = edge.vertexIds[0]!;
    const secondVertexId = edge.vertexIds[1]!;
    const start = vertexById.get(firstVertexId);
    const end = vertexById.get(secondVertexId);
    if (!start || !end) throw new Error(`Measurement face boundary edge ${edgeId} has unavailable endpoint vertices`);
    for (const vertex of [start, end]) {
      const planeOffsetMm = dot(subtract(vertex.positionMm, face.centerMm), normal);
      if (Math.abs(planeOffsetMm) > 1e-6) throw new Error(`Measurement face boundary edge ${edgeId} is not on the reported planar face`);
    }
    boundarySegments.push({
      id: edgeId,
      startVertexId: start.id,
      endVertexId: end.id,
      startPointMm: start.positionMm,
      endPointMm: end.positionMm,
      curve: { kind: "line" },
    });
  }
  const loops = assembleFaceBoundaryLoops(boundarySegments);
  const referenceAxis: Vector3 = Math.abs(normal[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0];
  const xAxis = normalize(cross(referenceAxis, normal), "Measurement face projection axis");
  const yAxis = cross(normal, xAxis);
  const project = (positionMm: Vector3): [number, number] => {
    const relative = subtract(positionMm, face.centerMm);
    return [dot(relative, xAxis), dot(relative, yAxis)];
  };
  const signedPlaneDistanceMm = dot(subtract(pointMm, face.centerMm), normal);
  const projectedPointMm = subtract(pointMm, scale(normal, signedPlaneDistanceMm));
  const projectedPoint = project(projectedPointMm);
  const containingLoopCount = loops.filter((loop) => pointInsideFaceBoundaryLoop(projectedPoint, loop, project)).length
    + fullCircleBoundaries.filter((loop) => {
      const center = project(loop.centerMm);
      return Math.hypot(projectedPoint[0] - center[0], projectedPoint[1] - center[1]) <= loop.radiusMm + 1e-9;
    }).length;
  const isInsideTrimmedFace = containingLoopCount % 2 === 1;

  let closestPointMm: Vector3;
  let minimumDistanceMm: number;
  let closestFeature: { type: "face-interior"; faceId: string } | { type: "boundary-edge"; edgeId: string };
  if (isInsideTrimmedFace) {
    closestPointMm = projectedPointMm;
    minimumDistanceMm = Math.abs(signedPlaneDistanceMm);
    closestFeature = { type: "face-interior", faceId: faceReference.faceId };
  } else {
    const closestBoundary = face.edgeIds.reduce<{
      distanceMm: number;
      pointMm: Vector3;
      edgeId: string;
    } | null>((best, edgeId) => {
      const edge = requireEdge(state, { bodyId: faceReference.bodyId, edgeId });
      let distanceMm: number;
      let closestPointMm: Vector3;
      if (edge.line) {
        const result = measurePointToLinearEdge(state, point, { bodyId: faceReference.bodyId, edgeId }, revision);
        distanceMm = result.finiteSegmentDistanceMm;
        closestPointMm = result.closestPointMm;
      } else {
        const result = measurePointToCircularEdge(state, point, { bodyId: faceReference.bodyId, edgeId }, revision);
        distanceMm = result.finiteArcDistanceMm;
        closestPointMm = result.closestPointMm;
      }
      if (best && distanceMm >= best.distanceMm) return best;
      return { distanceMm, pointMm: closestPointMm, edgeId };
    }, null);
    if (!closestBoundary) throw new Error("Measurement face boundary has no measurable edges");
    closestPointMm = closestBoundary.pointMm;
    minimumDistanceMm = closestBoundary.distanceMm;
    closestFeature = { type: "boundary-edge", edgeId: closestBoundary.edgeId };
  }
  return {
    documentToken: state.documentToken,
    revision: state.revision,
    measurementSource: point.type === "coordinates" ? "native-brep-and-explicit-coordinates" as const : "native-brep" as const,
    method: "native-brep-planar-linear-and-circular-trim" as const,
    point: { reference: point, pointMm },
    face: faceReference,
    signedPlaneDistanceMm,
    supportingPlaneDistanceMm: Math.abs(signedPlaneDistanceMm),
    minimumDistanceMm,
    closestPointMm,
    closestFeature,
  };
}

function assembleFaceBoundaryLoops(edges: FaceBoundarySegment[]): FaceBoundarySegment[][] {
  const adjacency = new Map<number, string[]>();
  const edgeById = new Map(edges.map((edge) => [edge.id, edge]));
  for (const edge of edges) {
    adjacency.set(edge.startVertexId, [...(adjacency.get(edge.startVertexId) ?? []), edge.id]);
    adjacency.set(edge.endVertexId, [...(adjacency.get(edge.endVertexId) ?? []), edge.id]);
  }
  if ([...adjacency.values()].some((incidentEdges) => incidentEdges.length !== 2)) {
    throw new Error("Measurement face boundary must form closed linear loops with connected arc endpoints");
  }
  const visited = new Set<string>();
  const loops: FaceBoundarySegment[][] = [];
  for (const edge of edges) {
    if (visited.has(edge.id)) continue;
    const startVertexId = edge.startVertexId;
    let currentVertexId = startVertexId;
    let previousEdgeId: string | undefined;
    const loop: FaceBoundarySegment[] = [];
    for (let step = 0; ; step += 1) {
      if (step >= edges.length) throw new Error("Measurement face boundary loop did not close");
      const nextEdgeId = adjacency.get(currentVertexId)?.find((edgeId) => edgeId !== previousEdgeId);
      if (!nextEdgeId) throw new Error("Measurement face boundary contains an open loop");
      if (visited.has(nextEdgeId)) throw new Error("Measurement face boundary loops are not disjoint");
      visited.add(nextEdgeId);
      const nextEdge = orientFaceBoundarySegment(edgeById.get(nextEdgeId)!, currentVertexId);
      loop.push(nextEdge);
      previousEdgeId = nextEdgeId;
      currentVertexId = nextEdge.endVertexId;
      if (currentVertexId === startVertexId) break;
    }
    if (loop.length < 2) throw new Error("Measurement face boundary loop must contain at least 2 edges");
    loops.push(loop);
  }
  if (visited.size !== edges.length) throw new Error("Measurement face boundary contains unassigned edges");
  return loops;
}

function readPlanarFaceRegion(
  state: RuntimeState,
  reference: FaceReference,
  planeOriginMm: Vector3,
  planeNormal: Vector3,
  expectedOffsetMm = 0,
): { loops: FaceBoundarySegment[][]; circles: FullCircleBoundary[] } {
  const face = requireFace(state, reference);
  if (face.edgeIds.length < 1 || face.edgeIds.length > 512) {
    throw new Error("Exact parallel-face clearance requires 1 through 512 boundary edges per face");
  }
  if (new Set(face.edgeIds).size !== face.edgeIds.length) throw new Error("Clearance face boundary contains duplicate edges");
  const body = state.bodies.find((candidate) => candidate.id === reference.bodyId);
  if (!body?.vertices) throw new Error("Exact parallel-face clearance requires native B-Rep vertices");
  const vertexById = new Map(body.vertices.map((vertex) => [vertex.id, vertex]));
  const boundarySegments: FaceBoundarySegment[] = [];
  const circles: FullCircleBoundary[] = [];
  for (const edgeId of face.edgeIds) {
    const edge = requireEdge(state, { bodyId: reference.bodyId, edgeId });
    if (edge.circle) {
      const circle = edge.circleGeometry;
      if (!circle) throw new Error(`Clearance circular boundary edge ${edgeId} has no exact native circle data`);
      requirePositiveFinite(circle.radiusMm, "Clearance circle radius");
      const circumferenceMm = 2 * Math.PI * circle.radiusMm;
      const circleNormal = normalize(circle.normal, "Clearance circle normal");
      if (Math.abs(dot(circleNormal, planeNormal)) < 1 - 1e-6) throw new Error(`Clearance circle ${edgeId} must lie in the planar face`);
      if (![...circle.centerMm, ...circle.startMm, ...circle.midpointMm, ...circle.endMm].every(Number.isFinite)) throw new Error(`Clearance circle ${edgeId} must have finite native coordinates`);
      const circleOffset = dot(subtract(circle.centerMm, planeOriginMm), planeNormal);
      if (Math.abs(circleOffset - expectedOffsetMm) > 1e-6) throw new Error(`Clearance circle ${edgeId} is outside the parallel face plane`);
      if (!Number.isFinite(edge.lengthMm) || edge.lengthMm <= 0 || edge.lengthMm > circumferenceMm + Math.max(1e-6, circumferenceMm * 1e-9)) {
        throw new Error(`Clearance circular boundary edge ${edgeId} has an invalid native length`);
      }
      const isFullCircle = Math.abs(edge.lengthMm - circumferenceMm) <= Math.max(1e-6, circumferenceMm * 1e-9);
      if (isFullCircle) {
        if (edge.vertexIds.length > 1) throw new Error(`Clearance full circle ${edgeId} cannot have multiple distinct seam vertices`);
        if (edge.vertexIds.length === 1) {
          const seamVertex = vertexById.get(edge.vertexIds[0]!);
          if (!seamVertex || !seamVertex.positionMm.every(Number.isFinite) || magnitude(subtract(seamVertex.positionMm, circle.startMm)) > 1e-6) {
            throw new Error(`Clearance full circle ${edgeId} has incomplete seam-vertex topology`);
          }
        }
        circles.push({ id: edgeId, centerMm: circle.centerMm, radiusMm: circle.radiusMm });
        continue;
      }
      const edgeCheck = measurePointToCircularEdge(
        state,
        { type: "coordinates", pointMm: circle.midpointMm },
        { bodyId: reference.bodyId, edgeId },
        state.revision,
      );
      if (edge.vertexIds.length !== 2 || edge.vertexIds[0] === edge.vertexIds[1]) {
        throw new Error(`Clearance circular arc ${edgeId} must have two distinct endpoint vertices`);
      }
      const firstVertex = vertexById.get(edge.vertexIds[0]!);
      const secondVertex = vertexById.get(edge.vertexIds[1]!);
      if (!firstVertex || !secondVertex) throw new Error(`Clearance circular arc ${edgeId} has unavailable endpoint vertices`);
      if (![...firstVertex.positionMm, ...secondVertex.positionMm].every(Number.isFinite)) {
        throw new Error(`Clearance circular arc ${edgeId} endpoint coordinates must be finite`);
      }
      const firstIsStart = magnitude(subtract(firstVertex.positionMm, circle.startMm)) <= 1e-6;
      const firstIsEnd = magnitude(subtract(firstVertex.positionMm, circle.endMm)) <= 1e-6;
      const secondIsStart = magnitude(subtract(secondVertex.positionMm, circle.startMm)) <= 1e-6;
      const secondIsEnd = magnitude(subtract(secondVertex.positionMm, circle.endMm)) <= 1e-6;
      let startVertex: typeof firstVertex;
      let endVertex: typeof secondVertex;
      if (firstIsStart && secondIsEnd) [startVertex, endVertex] = [firstVertex, secondVertex];
      else if (secondIsStart && firstIsEnd) [startVertex, endVertex] = [secondVertex, firstVertex];
      else throw new Error(`Clearance circular arc ${edgeId} endpoint vertices do not match native arc trim`);
      for (const vertex of [startVertex, endVertex]) {
        const offset = dot(subtract(vertex.positionMm, planeOriginMm), planeNormal);
        if (Math.abs(offset - expectedOffsetMm) > 1e-6) throw new Error(`Clearance circular arc ${edgeId} is outside the parallel face plane`);
      }
      const referenceAxis = normalize(circle.reference, "Clearance circle reference");
      const secondAxis = normalize(cross(edgeCheck.edge.normal, referenceAxis), "Clearance circle second axis");
      boundarySegments.push({
        id: edgeId,
        startVertexId: startVertex.id,
        endVertexId: endVertex.id,
        startPointMm: circle.startMm,
        endPointMm: circle.endMm,
        curve: {
          kind: "arc",
          centerMm: circle.centerMm,
          radiusMm: circle.radiusMm,
          normal: edgeCheck.edge.normal,
          reference: referenceAxis,
          secondAxis,
          startAngleRadians: edgeCheck.edge.startAngleRadians,
          sweepRadians: edgeCheck.edge.sweepRadians,
        },
      });
      continue;
    }
    if (!edge.line) throw new Error("Exact parallel-face clearance supports straight edges and exact circular boundaries only");
    if (edge.vertexIds.length !== 2 || edge.vertexIds[0] === edge.vertexIds[1]) {
      throw new Error(`Clearance boundary edge ${edgeId} must have two distinct native endpoint vertices`);
    }
    const [start, end] = edge.vertexIds as [number, number];
    const startVertex = vertexById.get(start);
    const endVertex = vertexById.get(end);
    if (!startVertex || !endVertex) throw new Error(`Clearance boundary edge ${edgeId} has unavailable native endpoint vertices`);
    if (![...startVertex.positionMm, ...endVertex.positionMm].every(Number.isFinite)) {
      throw new Error(`Clearance boundary edge ${edgeId} endpoint coordinates must be finite`);
    }
    const actualLengthMm = magnitude(subtract(endVertex.positionMm, startVertex.positionMm));
    if (!Number.isFinite(edge.lengthMm) || edge.lengthMm <= 0 || Math.abs(actualLengthMm - edge.lengthMm) > Math.max(1e-6, edge.lengthMm * 1e-9)) {
      throw new Error(`Clearance boundary edge ${edgeId} endpoint distance does not match its native length`);
    }
    for (const vertex of [startVertex, endVertex]) {
      const offset = dot(subtract(vertex.positionMm, planeOriginMm), planeNormal);
      if (Math.abs(offset - expectedOffsetMm) > 1e-6) throw new Error(`Clearance boundary edge ${edgeId} is outside the parallel face plane`);
    }
    boundarySegments.push({
      id: edgeId,
      startVertexId: start,
      endVertexId: end,
      startPointMm: startVertex.positionMm,
      endPointMm: endVertex.positionMm,
      curve: { kind: "line" },
    });
  }
  if (boundarySegments.length === 0 && circles.length === 0) throw new Error("Clearance face has no supported exact boundary geometry");
  const loops = boundarySegments.length === 0 ? [] : assembleFaceBoundaryLoops(boundarySegments);
  for (const loop of loops) {
    if (loop.length < 2) throw new Error("Clearance face boundary loops require at least two segments");
    let twiceArea = 0;
    for (const segment of loop) {
      if (segment.curve.kind === "line") {
        twiceArea += dot(cross(segment.startPointMm, segment.endPointMm), planeNormal);
      } else {
        twiceArea += dot(
          add(
            cross(segment.curve.centerMm, subtract(segment.endPointMm, segment.startPointMm)),
            scale(cross(segment.curve.reference, segment.curve.secondAxis), segment.curve.radiusMm ** 2 * segment.curve.sweepRadians),
          ),
          planeNormal,
        );
      }
    }
    if (Math.abs(twiceArea) <= 2e-12) throw new Error("Clearance face boundary contains a zero-area loop");
  }
  return { loops, circles };
}

type PlanarClearancePrimitive =
  | { kind: "line"; start: [number, number]; end: [number, number] }
  | { kind: "circle"; id: string; center: [number, number]; radiusMm: number }
  | { kind: "arc"; id: string; center: [number, number]; radiusMm: number; axisU: [number, number]; axisV: [number, number]; startAngleRadians: number; sweepRadians: number };

type PlanarCirclePrimitive = Extract<PlanarClearancePrimitive, { kind: "circle" | "arc" }>;

function planarRegionsIntersection(
  firstLoops: PlanarClearancePrimitive[][],
  firstCircles: FullCircleBoundary2d[],
  secondLoops: PlanarClearancePrimitive[][],
  secondCircles: FullCircleBoundary2d[],
): [number, number] | null {
  const firstPrimitives = planarRegionPrimitives(firstLoops, firstCircles);
  const secondPrimitives = planarRegionPrimitives(secondLoops, secondCircles);
  for (const first of firstPrimitives) {
    for (const second of secondPrimitives) {
      const intersections = intersectPlanarPrimitives(first, second);
      if (intersections.length > 0) return intersections[0]!;
    }
  }
  const firstSamples = [...firstLoops.flatMap((loop) => loop.map(primitiveStartPoint)), ...firstCircles.map((circle) => [circle.center[0] + circle.radiusMm, circle.center[1]] as [number, number])];
  const secondSamples = [...secondLoops.flatMap((loop) => loop.map(primitiveStartPoint)), ...secondCircles.map((circle) => [circle.center[0] + circle.radiusMm, circle.center[1]] as [number, number])];
  for (const point of [...firstSamples, ...secondSamples]) {
    const firstContains = pointInsidePlanarRegion(point, firstLoops, firstCircles);
    const secondContains = pointInsidePlanarRegion(point, secondLoops, secondCircles);
    if (firstContains && secondContains) return point;
  }
  return null;
}

function pointInsidePlanarRegion(
  point: [number, number],
  loops: PlanarClearancePrimitive[][],
  circles: FullCircleBoundary2d[],
): boolean {
  let inside = loops.reduce((current, loop) => pointInsidePlanarLoop(point, loop) ? !current : current, false);
  for (const circle of circles) {
    if (Math.hypot(point[0] - circle.center[0], point[1] - circle.center[1]) <= circle.radiusMm + 1e-9) inside = !inside;
  }
  return inside;
}

function planarRegionPrimitives(
  loops: PlanarClearancePrimitive[][],
  circles: FullCircleBoundary2d[],
): PlanarClearancePrimitive[] {
  return [...loops.flat(), ...circles.map((circle) => ({ kind: "circle" as const, ...circle }))];
}

function projectPlanarBoundaryLoops(
  loops: FaceBoundarySegment[][],
  project: (point: Vector3) => [number, number],
): PlanarClearancePrimitive[][] {
  return loops.map((loop) => loop.map((segment): PlanarClearancePrimitive => {
    if (segment.curve.kind === "line") return { kind: "line", start: project(segment.startPointMm), end: project(segment.endPointMm) };
    const center = project(segment.curve.centerMm);
    const projectedU = project(add(segment.curve.centerMm, segment.curve.reference));
    const projectedV = project(add(segment.curve.centerMm, segment.curve.secondAxis));
    return {
      kind: "arc",
      id: segment.id,
      center,
      radiusMm: segment.curve.radiusMm,
      axisU: [projectedU[0] - center[0], projectedU[1] - center[1]],
      axisV: [projectedV[0] - center[0], projectedV[1] - center[1]],
      startAngleRadians: segment.curve.startAngleRadians,
      sweepRadians: segment.curve.sweepRadians,
    };
  }));
}

function primitiveStartPoint(primitive: PlanarClearancePrimitive): [number, number] {
  if (primitive.kind === "line") return primitive.start;
  return pointOnPlanarCircle(primitive, primitive.kind === "arc" ? primitive.startAngleRadians : 0);
}

function pointOnPlanarCircle(circle: PlanarCirclePrimitive, angle: number): [number, number] {
  const axisU: [number, number] = circle.kind === "arc" ? circle.axisU : [1, 0];
  const axisV: [number, number] = circle.kind === "arc" ? circle.axisV : [0, 1];
  return [
    circle.center[0] + circle.radiusMm * (axisU[0] * Math.cos(angle) + axisV[0] * Math.sin(angle)),
    circle.center[1] + circle.radiusMm * (axisU[1] * Math.cos(angle) + axisV[1] * Math.sin(angle)),
  ];
}

function angleForPlanarCirclePoint(point: [number, number], circle: Extract<PlanarClearancePrimitive, { kind: "arc" }>): number {
  const relative = [point[0] - circle.center[0], point[1] - circle.center[1]] as const;
  return Math.atan2(relative[0] * circle.axisV[0] + relative[1] * circle.axisV[1], relative[0] * circle.axisU[0] + relative[1] * circle.axisU[1]);
}

function arcParameterForPoint(point: [number, number], arc: Extract<PlanarClearancePrimitive, { kind: "arc" }>): number | null {
  const angle = angleForPlanarCirclePoint(point, arc);
  return circularArcParameter(angle, arc.startAngleRadians, arc.sweepRadians, 1e-9);
}

function pointOnPlanarPrimitive(point: [number, number], primitive: PlanarClearancePrimitive, toleranceMm = 1e-9): boolean {
  if (primitive.kind === "line") {
    const delta = [primitive.end[0] - primitive.start[0], primitive.end[1] - primitive.start[1]] as const;
    const lengthSquared = delta[0] ** 2 + delta[1] ** 2;
    const parameter = lengthSquared <= 1e-24 ? 0 : clamp(((point[0] - primitive.start[0]) * delta[0] + (point[1] - primitive.start[1]) * delta[1]) / lengthSquared, 0, 1);
    return Math.hypot(point[0] - primitive.start[0] - delta[0] * parameter, point[1] - primitive.start[1] - delta[1] * parameter) <= toleranceMm;
  }
  if (Math.abs(Math.hypot(point[0] - primitive.center[0], point[1] - primitive.center[1]) - primitive.radiusMm) > toleranceMm) return false;
  return primitive.kind === "circle" || arcParameterForPoint(point, primitive) !== null;
}

function pointInsidePlanarLoop(point: [number, number], loop: PlanarClearancePrimitive[]): boolean {
  if (loop.some((primitive) => pointOnPlanarPrimitive(point, primitive))) return true;
  let crossings = 0;
  for (const primitive of loop) {
    if (primitive.kind === "line") {
      const [first, second] = [primitive.start, primitive.end];
      if ((first[1] <= point[1] && point[1] < second[1]) || (second[1] <= point[1] && point[1] < first[1])) {
        const parameter = (point[1] - first[1]) / (second[1] - first[1]);
        if (first[0] + parameter * (second[0] - first[0]) > point[0]) crossings += 1;
      }
    } else if (primitive.kind === "arc") {
      crossings += planarArcRayCrossings(point, primitive);
    }
  }
  return crossings % 2 === 1;
}

function planarArcRayCrossings(point: [number, number], arc: Extract<PlanarClearancePrimitive, { kind: "arc" }>): number {
  const start = arc.startAngleRadians;
  const end = start + arc.sweepRadians;
  const lowerAngle = Math.min(start, end);
  const upperAngle = Math.max(start, end);
  const extremaBase = Math.atan2(arc.axisV[1], arc.axisU[1]);
  const breaks = [0, 1];
  for (let turn = -4; turn <= 4; turn += 1) {
    const extremum = extremaBase + turn * Math.PI;
    const parameter = (extremum - start) / arc.sweepRadians;
    if (extremum >= lowerAngle - 1e-12 && extremum <= upperAngle + 1e-12 && parameter > 1e-12 && parameter < 1 - 1e-12) breaks.push(parameter);
  }
  breaks.sort((first, second) => first - second);
  const pointAt = (parameter: number): [number, number] => pointOnPlanarCircle(arc, start + arc.sweepRadians * parameter);
  let crossings = 0;
  for (let index = 0; index < breaks.length - 1; index += 1) {
    let lower = breaks[index]!;
    let upper = breaks[index + 1]!;
    const first = pointAt(lower);
    const second = pointAt(upper);
    const ascending = first[1] < second[1];
    if (!(ascending ? first[1] <= point[1] && point[1] < second[1] : second[1] <= point[1] && point[1] < first[1])) continue;
    for (let iteration = 0; iteration < 64; iteration += 1) {
      const middle = (lower + upper) / 2;
      if ((pointAt(middle)[1] < point[1]) === ascending) lower = middle;
      else upper = middle;
    }
    if (pointAt((lower + upper) / 2)[0] > point[0]) crossings += 1;
  }
  return crossings;
}

function intersectPlanarPrimitives(
  first: PlanarClearancePrimitive,
  second: PlanarClearancePrimitive,
): Array<[number, number]> {
  if (first.kind === "line" && second.kind === "line") {
    const point = segmentIntersection2d(first.start, first.end, second.start, second.end);
    return point ? [point] : [];
  }
  if (first.kind === "line" && second.kind !== "line") {
    return lineCircleIntersections(first.start, first.end, second).filter((point) => pointOnPlanarPrimitive(point, second));
  }
  if (first.kind !== "line" && second.kind === "line") {
    return lineCircleIntersections(second.start, second.end, first).filter((point) => pointOnPlanarPrimitive(point, first));
  }
  return circleBoundaryIntersections(first as PlanarCirclePrimitive, second as PlanarCirclePrimitive);
}

function lineCircleIntersections(
  start: [number, number],
  end: [number, number],
  circle: PlanarCirclePrimitive,
): Array<[number, number]> {
  const direction = [end[0] - start[0], end[1] - start[1]] as const;
  const relative = [start[0] - circle.center[0], start[1] - circle.center[1]] as const;
  const a = direction[0] ** 2 + direction[1] ** 2;
  if (a <= 1e-24) return [];
  const b = 2 * (relative[0] * direction[0] + relative[1] * direction[1]);
  const c = relative[0] ** 2 + relative[1] ** 2 - circle.radiusMm ** 2;
  const discriminant = b * b - 4 * a * c;
  const tolerance = 1e-12 * Math.max(1, b * b, Math.abs(4 * a * c));
  if (discriminant < -tolerance) return [];
  const root = Math.sqrt(Math.max(0, discriminant));
  const parameters = root <= 1e-12 ? [-b / (2 * a)] : [(-b - root) / (2 * a), (-b + root) / (2 * a)];
  return parameters
    .filter((parameter) => parameter >= -1e-9 && parameter <= 1 + 1e-9)
    .map((parameter) => [start[0] + clamp(parameter, 0, 1) * direction[0], start[1] + clamp(parameter, 0, 1) * direction[1]]);
}

function circleCircleIntersections(first: PlanarCirclePrimitive, second: PlanarCirclePrimitive): Array<[number, number]> {
  const delta = [second.center[0] - first.center[0], second.center[1] - first.center[1]] as const;
  const distance = Math.hypot(...delta);
  if (distance <= 1e-12) {
    return Math.abs(first.radiusMm - second.radiusMm) <= 1e-9
      ? [[first.center[0] + first.radiusMm, first.center[1]]]
      : [];
  }
  if (distance > first.radiusMm + second.radiusMm + 1e-9 || distance < Math.abs(first.radiusMm - second.radiusMm) - 1e-9) return [];
  const along = (first.radiusMm ** 2 - second.radiusMm ** 2 + distance ** 2) / (2 * distance);
  const height = Math.sqrt(Math.max(0, first.radiusMm ** 2 - along ** 2));
  const axis = [delta[0] / distance, delta[1] / distance] as const;
  const base: [number, number] = [first.center[0] + axis[0] * along, first.center[1] + axis[1] * along];
  const perpendicular = [-axis[1], axis[0]] as const;
  const firstPoint: [number, number] = [base[0] + perpendicular[0] * height, base[1] + perpendicular[1] * height];
  if (height <= 1e-12) return [firstPoint];
  return [firstPoint, [base[0] - perpendicular[0] * height, base[1] - perpendicular[1] * height]];
}

function circleBoundaryIntersections(first: PlanarCirclePrimitive, second: PlanarCirclePrimitive): Array<[number, number]> {
  const points = circleCircleIntersections(first, second);
  if (Math.hypot(first.center[0] - second.center[0], first.center[1] - second.center[1]) <= 1e-12
    && Math.abs(first.radiusMm - second.radiusMm) <= 1e-9) {
    points.push(primitiveStartPoint(first), primitiveStartPoint(second));
  }
  return points.filter((point, index) => pointOnPlanarPrimitive(point, first)
    && pointOnPlanarPrimitive(point, second)
    && points.findIndex((candidate) => Math.hypot(candidate[0] - point[0], candidate[1] - point[1]) <= 1e-9) === index);
}

function segmentIntersection2d(
  firstStart: [number, number],
  firstEnd: [number, number],
  secondStart: [number, number],
  secondEnd: [number, number],
): [number, number] | null {
  const orientation = (a: [number, number], b: [number, number], c: [number, number]) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const onSegment = (point: [number, number], start: [number, number], end: [number, number]) =>
    point[0] >= Math.min(start[0], end[0]) - 1e-9
    && point[0] <= Math.max(start[0], end[0]) + 1e-9
    && point[1] >= Math.min(start[1], end[1]) - 1e-9
    && point[1] <= Math.max(start[1], end[1]) + 1e-9;
  const firstSecondStart = orientation(firstStart, firstEnd, secondStart);
  const firstSecondEnd = orientation(firstStart, firstEnd, secondEnd);
  const secondFirstStart = orientation(secondStart, secondEnd, firstStart);
  const secondFirstEnd = orientation(secondStart, secondEnd, firstEnd);
  if (firstSecondStart * firstSecondEnd > 1e-18 || secondFirstStart * secondFirstEnd > 1e-18) return null;
  for (const point of [firstStart, firstEnd, secondStart, secondEnd]) {
    if (Math.abs(orientation(firstStart, firstEnd, point)) <= 1e-9 && onSegment(point, firstStart, firstEnd)
      && Math.abs(orientation(secondStart, secondEnd, point)) <= 1e-9 && onSegment(point, secondStart, secondEnd)) return point;
  }
  const firstDirection = [firstEnd[0] - firstStart[0], firstEnd[1] - firstStart[1]] as const;
  const secondDirection = [secondEnd[0] - secondStart[0], secondEnd[1] - secondStart[1]] as const;
  const denominator = firstDirection[0] * secondDirection[1] - firstDirection[1] * secondDirection[0];
  if (Math.abs(denominator) <= 1e-18) return null;
  const offset = [secondStart[0] - firstStart[0], secondStart[1] - firstStart[1]] as const;
  const parameter = (offset[0] * secondDirection[1] - offset[1] * secondDirection[0]) / denominator;
  return [firstStart[0] + parameter * firstDirection[0], firstStart[1] + parameter * firstDirection[1]];
}

function closestPlanarRegionBoundaries(
  firstLoops: PlanarClearancePrimitive[][],
  firstCircles: FullCircleBoundary2d[],
  secondLoops: PlanarClearancePrimitive[][],
  secondCircles: FullCircleBoundary2d[],
): { distanceMm: number; first: [number, number]; second: [number, number] } {
  let closest: { distanceMm: number; first: [number, number]; second: [number, number] } | undefined;
  const firstPrimitives = planarRegionPrimitives(firstLoops, firstCircles);
  const secondPrimitives = planarRegionPrimitives(secondLoops, secondCircles);
  for (const first of firstPrimitives) {
    for (const second of secondPrimitives) {
      const candidate = closestPlanarPrimitives(first, second);
      if (!closest || candidate.distanceMm < closest.distanceMm) closest = candidate;
    }
  }
  if (!closest) throw new Error("Clearance face boundaries did not contain measurable geometry");
  return closest;
}

function closestPlanarPrimitives(
  first: PlanarClearancePrimitive,
  second: PlanarClearancePrimitive,
): { distanceMm: number; first: [number, number]; second: [number, number] } {
  if (first.kind === "line" && second.kind === "line") {
    const firstDelta = [first.end[0] - first.start[0], first.end[1] - first.start[1]] as const;
    const secondDelta = [second.end[0] - second.start[0], second.end[1] - second.start[1]] as const;
    const firstLengthMm = Math.hypot(...firstDelta);
    const secondLengthMm = Math.hypot(...secondDelta);
    const result = closestLinearSegments(
      [(first.start[0] + first.end[0]) / 2, (first.start[1] + first.end[1]) / 2, 0],
      [firstDelta[0] / firstLengthMm, firstDelta[1] / firstLengthMm, 0],
      firstLengthMm,
      [(second.start[0] + second.end[0]) / 2, (second.start[1] + second.end[1]) / 2, 0],
      [secondDelta[0] / secondLengthMm, secondDelta[1] / secondLengthMm, 0],
      secondLengthMm,
    );
    return { distanceMm: result.distanceMm, first: [result.firstPointMm[0], result.firstPointMm[1]], second: [result.secondPointMm[0], result.secondPointMm[1]] };
  }
  if (first.kind === "line" && second.kind !== "line") return closestLineToCircularBoundary(first, second);
  if (first.kind !== "line" && second.kind === "line") {
    const result = closestLineToCircularBoundary(second, first);
    return { distanceMm: result.distanceMm, first: result.second, second: result.first };
  }
  return closestCircularBoundaries(first as PlanarCirclePrimitive, second as PlanarCirclePrimitive);
}

function closestLineToCircularBoundary(
  line: Extract<PlanarClearancePrimitive, { kind: "line" }>,
  circle: PlanarCirclePrimitive,
): { distanceMm: number; first: [number, number]; second: [number, number] } {
  const delta = [line.end[0] - line.start[0], line.end[1] - line.start[1]] as const;
  const lengthSquared = delta[0] ** 2 + delta[1] ** 2;
  const projectToLine = (point: [number, number]): [number, number] => {
    const parameter = lengthSquared <= 1e-24 ? 0 : clamp(((point[0] - line.start[0]) * delta[0] + (point[1] - line.start[1]) * delta[1]) / lengthSquared, 0, 1);
    return [line.start[0] + delta[0] * parameter, line.start[1] + delta[1] * parameter];
  };
  const candidates: Array<{ distanceMm: number; first: [number, number]; second: [number, number] }> = [];
  const addCandidate = (linePoint: [number, number], circlePoint: [number, number]) => {
    candidates.push({ distanceMm: Math.hypot(linePoint[0] - circlePoint[0], linePoint[1] - circlePoint[1]), first: linePoint, second: circlePoint });
  };
  for (const linePoint of [line.start, line.end, projectToLine(circle.center)]) {
    addCandidate(linePoint, closestPointOnCircularBoundary(linePoint, circle));
  }
  for (const circlePoint of circularBoundaryEndpoints(circle)) addCandidate(projectToLine(circlePoint), circlePoint);
  return candidates.reduce((best, candidate) => candidate.distanceMm < best.distanceMm ? candidate : best);
}

function closestCircularBoundaries(
  first: PlanarCirclePrimitive,
  second: PlanarCirclePrimitive,
): { distanceMm: number; first: [number, number]; second: [number, number] } {
  const delta = [second.center[0] - first.center[0], second.center[1] - first.center[1]] as const;
  const centerDistance = Math.hypot(...delta);
  const axis = centerDistance <= 1e-12 ? [1, 0] as const : [delta[0] / centerDistance, delta[1] / centerDistance] as const;
  const candidates: Array<{ distanceMm: number; first: [number, number]; second: [number, number] }> = [];
  const addCandidate = (firstPoint: [number, number], secondPoint: [number, number]) => {
    candidates.push({ distanceMm: Math.hypot(firstPoint[0] - secondPoint[0], firstPoint[1] - secondPoint[1]), first: firstPoint, second: secondPoint });
  };
  for (const firstPoint of circularBoundaryEndpoints(first)) addCandidate(firstPoint, closestPointOnCircularBoundary(firstPoint, second));
  for (const secondPoint of circularBoundaryEndpoints(second)) addCandidate(closestPointOnCircularBoundary(secondPoint, first), secondPoint);
  const directions: ReadonlyArray<readonly [number, number]> = centerDistance <= 1e-12
    ? [[1, 0], [-1, 0], [0, 1], [0, -1]]
    : [axis, [-axis[0], -axis[1]]];
  for (const direction of directions) {
    const firstPoint = pointOnCircularBoundaryDirection(first, direction);
    if (firstPoint) addCandidate(firstPoint, closestPointOnCircularBoundary(firstPoint, second));
    const secondPoint = pointOnCircularBoundaryDirection(second, direction);
    if (secondPoint) addCandidate(closestPointOnCircularBoundary(secondPoint, first), secondPoint);
  }
  return candidates.reduce((best, candidate) => candidate.distanceMm < best.distanceMm ? candidate : best);
}

function circularBoundaryEndpoints(circle: PlanarCirclePrimitive): [number, number][] {
  if (circle.kind === "circle") return [];
  return [
    pointOnPlanarCircle(circle, circle.startAngleRadians),
    pointOnPlanarCircle(circle, circle.startAngleRadians + circle.sweepRadians),
  ];
}

function pointOnCircularBoundaryDirection(circle: PlanarCirclePrimitive, direction: readonly [number, number]): [number, number] | null {
  if (circle.kind === "circle") return [circle.center[0] + direction[0] * circle.radiusMm, circle.center[1] + direction[1] * circle.radiusMm];
  const angle = angleForPlanarCirclePoint([circle.center[0] + direction[0], circle.center[1] + direction[1]], circle);
  return circularArcParameter(angle, circle.startAngleRadians, circle.sweepRadians, 1e-9) === null ? null : pointOnPlanarCircle(circle, angle);
}

function closestPointOnCircularBoundary(point: [number, number], circle: PlanarCirclePrimitive): [number, number] {
  const delta = [point[0] - circle.center[0], point[1] - circle.center[1]] as const;
  const radialLength = Math.hypot(...delta);
  const direction = radialLength <= 1e-12 ? [1, 0] as [number, number] : [delta[0] / radialLength, delta[1] / radialLength] as [number, number];
  const radialPoint = pointOnCircularBoundaryDirection(circle, direction);
  if (radialPoint) return radialPoint;
  const endpoints = circularBoundaryEndpoints(circle);
  return endpoints.reduce((best, candidate) => Math.hypot(point[0] - candidate[0], point[1] - candidate[1]) < Math.hypot(point[0] - best[0], point[1] - best[1]) ? candidate : best);
}

function orientFaceBoundarySegment(segment: FaceBoundarySegment, startVertexId: number): FaceBoundarySegment {
  if (segment.startVertexId === startVertexId) return segment;
  if (segment.endVertexId !== startVertexId) throw new Error(`Measurement face boundary edge ${segment.id} is disconnected from its loop`);
  const curve = segment.curve.kind === "line"
    ? segment.curve
    : {
      ...segment.curve,
      startAngleRadians: segment.curve.startAngleRadians + segment.curve.sweepRadians,
      sweepRadians: -segment.curve.sweepRadians,
    };
  return {
    ...segment,
    startVertexId: segment.endVertexId,
    endVertexId: segment.startVertexId,
    startPointMm: segment.endPointMm,
    endPointMm: segment.startPointMm,
    curve,
  };
}

function pointInsideFaceBoundaryLoop(
  point: [number, number],
  loop: FaceBoundarySegment[],
  project: (pointMm: Vector3) => [number, number],
): boolean {
  if (loop.every((segment) => segment.curve.kind === "line")) {
    return pointInsidePolygon(point, loop.map((segment) => project(segment.startPointMm)));
  }
  let crossings = 0;
  for (const segment of loop) {
    if (segment.curve.kind === "line") {
      const first = project(segment.startPointMm);
      const second = project(segment.endPointMm);
      if ((first[1] <= point[1] && point[1] < second[1]) || (second[1] <= point[1] && point[1] < first[1])) {
        const parameter = (point[1] - first[1]) / (second[1] - first[1]);
        if (first[0] + parameter * (second[0] - first[0]) > point[0]) crossings += 1;
      }
      continue;
    }
    crossings += arcRayCrossings(point, segment, project);
  }
  return crossings % 2 === 1;
}

function arcRayCrossings(
  point: [number, number],
  segment: FaceBoundarySegment,
  project: (pointMm: Vector3) => [number, number],
): number {
  if (segment.curve.kind !== "arc") throw new Error("Expected an exact circular arc boundary segment");
  const curve = segment.curve;
  const start = curve.startAngleRadians;
  const end = start + curve.sweepRadians;
  const lowerAngle = Math.min(start, end);
  const upperAngle = Math.max(start, end);
  const breaks = [0, 1];
  const firstExtremumIndex = Math.ceil((lowerAngle - Math.PI / 2) / Math.PI);
  const lastExtremumIndex = Math.floor((upperAngle - Math.PI / 2) / Math.PI);
  for (let index = firstExtremumIndex; index <= lastExtremumIndex; index += 1) {
    const parameter = (Math.PI / 2 + index * Math.PI - start) / curve.sweepRadians;
    if (parameter > 1e-12 && parameter < 1 - 1e-12) breaks.push(parameter);
  }
  breaks.sort((first, second) => first - second);
  const pointAt = (parameter: number): [number, number] => {
    const angle = start + curve.sweepRadians * parameter;
    const radialDirection = add(scale(curve.reference, Math.cos(angle)), scale(curve.secondAxis, Math.sin(angle)));
    return project(add(curve.centerMm, scale(radialDirection, curve.radiusMm)));
  };
  let crossings = 0;
  for (let index = 0; index < breaks.length - 1; index += 1) {
    const firstParameter = breaks[index]!;
    const secondParameter = breaks[index + 1]!;
    const first = pointAt(firstParameter);
    const second = pointAt(secondParameter);
    const ascending = first[1] < second[1];
    const crossesRay = ascending
      ? first[1] <= point[1] && point[1] < second[1]
      : second[1] <= point[1] && point[1] < first[1];
    if (!crossesRay) continue;
    let lower = firstParameter;
    let upper = secondParameter;
    for (let iteration = 0; iteration < 64; iteration += 1) {
      const middle = (lower + upper) / 2;
      const middleY = pointAt(middle)[1];
      if ((middleY < point[1]) === ascending) lower = middle;
      else upper = middle;
    }
    if (pointAt((lower + upper) / 2)[0] > point[0]) crossings += 1;
  }
  return crossings;
}

function pointInsidePolygon(point: [number, number], polygon: Array<[number, number]>): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const [x, y] = point;
    const [x1, y1] = polygon[index]!;
    const [x2, y2] = polygon[previous]!;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSquared = dx * dx + dy * dy;
    const projection = lengthSquared === 0 ? 0 : clamp(((x - x1) * dx + (y - y1) * dy) / lengthSquared, 0, 1);
    if (Math.hypot(x - (x1 + projection * dx), y - (y1 + projection * dy)) <= 1e-9) return true;
    const crossesRay = (y1 > y) !== (y2 > y) && x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1;
    if (crossesRay) inside = !inside;
  }
  return inside;
}

function pointMeasurementSource(first: MeasurementPointReference, second: MeasurementPointReference) {
  if (first.type === "coordinates" && second.type === "coordinates") return "explicit-coordinates" as const;
  if (first.type === "coordinates" || second.type === "coordinates") return "native-brep-and-explicit-coordinates" as const;
  return "native-brep" as const;
}

export function measurePlanarFaces(
  state: RuntimeState,
  first: FaceReference,
  second: FaceReference,
  revision: string,
  angularToleranceDeg = 0.01,
) {
  requireRevision(state, revision);
  requirePositiveFinite(angularToleranceDeg, "angularToleranceDeg");
  const firstFace = requireFace(state, first);
  const secondFace = requireFace(state, second);
  if (!firstFace.planar || !secondFace.planar) throw new Error("Both measurement faces must be planar");
  const firstNormal = normalize(firstFace.normal, "First face normal");
  const secondNormal = normalize(secondFace.normal, "Second face normal");
  const normalAngleDeg = radiansToDegrees(Math.acos(clamp(dot(firstNormal, secondNormal), -1, 1)));
  const planeAngleDeg = Math.min(normalAngleDeg, 180 - normalAngleDeg);
  const parallel = planeAngleDeg <= angularToleranceDeg;
  const signedSeparationMm = parallel
    ? dot(subtract(secondFace.centerMm, firstFace.centerMm), firstNormal)
    : null;
  return {
    documentToken: state.documentToken,
    revision: state.revision,
    measurementSource: "native-brep" as const,
    first: { ...first, pointMm: firstFace.centerMm, normal: firstNormal },
    second: { ...second, pointMm: secondFace.centerMm, normal: secondNormal },
    normalAngleDeg,
    planeAngleDeg,
    parallel,
    separationKind: parallel ? "supporting-planes" as const : null,
    signedSeparationMm,
    separationMm: signedSeparationMm === null ? null : Math.abs(signedSeparationMm),
  };
}

export function measureParallelPlanarFaceClearance(
  state: RuntimeState,
  first: FaceReference,
  second: FaceReference,
  revision: string,
): {
  documentToken: string;
  revision: string;
  measurementSource: "native-brep";
  method: "parallel-planar-exact-trimmed-regions";
  exact: true;
  status: "measured";
  first: FaceReference;
  second: FaceReference;
  normalAngleDeg: number;
  parallelPlaneGapMm: number;
  inPlaneClearanceMm: number;
  minimumDistanceMm: number;
  closestPointsMm: { first: Vector3; second: Vector3 };
} {
  requireRevision(state, revision);
  const firstFace = requireFace(state, first);
  const secondFace = requireFace(state, second);
  if (!firstFace.planar || !secondFace.planar) throw new Error("Both clearance faces must be planar");
  if (![...firstFace.centerMm, ...secondFace.centerMm].every(Number.isFinite)) throw new Error("Clearance face centers must contain finite coordinates");
  const firstNormal = normalize(firstFace.normal, "First clearance face normal");
  const secondNormal = normalize(secondFace.normal, "Second clearance face normal");
  const normalAngleDeg = radiansToDegrees(Math.acos(clamp(dot(firstNormal, secondNormal), -1, 1)));
  const planeAngleDeg = Math.min(normalAngleDeg, 180 - normalAngleDeg);
  if (planeAngleDeg > 1e-7) throw new Error("Exact trimmed-face clearance currently requires parallel planar faces");

  const firstRegion = readPlanarFaceRegion(state, first, firstFace.centerMm, firstNormal);
  const signedPlaneGapMm = dot(subtract(secondFace.centerMm, firstFace.centerMm), firstNormal);
  const secondRegion = readPlanarFaceRegion(state, second, firstFace.centerMm, firstNormal, signedPlaneGapMm);
  const xReference: Vector3 = Math.abs(firstNormal[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0];
  const xAxis = normalize(cross(xReference, firstNormal), "Clearance projection X axis");
  const yAxis = cross(firstNormal, xAxis);
  const project = (pointMm: Vector3): [number, number] => {
    const relative = subtract(pointMm, firstFace.centerMm);
    return [dot(relative, xAxis), dot(relative, yAxis)];
  };
  const firstLoops = projectPlanarBoundaryLoops(firstRegion.loops, project);
  const secondLoops = projectPlanarBoundaryLoops(secondRegion.loops, project);
  const firstCircles = firstRegion.circles.map((circle) => ({ id: circle.id, center: project(circle.centerMm), radiusMm: circle.radiusMm }));
  const secondCircles = secondRegion.circles.map((circle) => ({ id: circle.id, center: project(circle.centerMm), radiusMm: circle.radiusMm }));
  const intersection = planarRegionsIntersection(firstLoops, firstCircles, secondLoops, secondCircles);
  let inPlaneClearanceMm: number;
  let firstPlanePoint: [number, number];
  let secondPlanePoint: [number, number];
  if (intersection) {
    inPlaneClearanceMm = 0;
    firstPlanePoint = intersection;
    secondPlanePoint = intersection;
  } else {
    const closest = closestPlanarRegionBoundaries(firstLoops, firstCircles, secondLoops, secondCircles);
    inPlaneClearanceMm = closest.distanceMm;
    firstPlanePoint = closest.first;
    secondPlanePoint = closest.second;
  }
  const toWorld = (point: [number, number], offsetMm: number): Vector3 => add(
    add(firstFace.centerMm, add(scale(xAxis, point[0]), scale(yAxis, point[1]))),
    scale(firstNormal, offsetMm),
  );
  const parallelPlaneGapMm = Math.abs(signedPlaneGapMm);
  return {
    documentToken: state.documentToken,
    revision: state.revision,
    measurementSource: "native-brep",
    method: "parallel-planar-exact-trimmed-regions",
    exact: true,
    status: "measured",
    first,
    second,
    normalAngleDeg,
    parallelPlaneGapMm,
    inPlaneClearanceMm,
    minimumDistanceMm: Math.hypot(parallelPlaneGapMm, inPlaneClearanceMm),
    closestPointsMm: {
      first: toWorld(firstPlanePoint, 0),
      second: toWorld(secondPlanePoint, signedPlaneGapMm),
    },
  };
}

export function measureNonparallelPlanarPolygonFaceClearance(
  state: RuntimeState,
  first: FaceReference,
  second: FaceReference,
  revision: string,
) {
  requireRevision(state, revision);
  const firstFace = requireFace(state, first);
  const secondFace = requireFace(state, second);
  if (!firstFace.planar || !secondFace.planar) throw new Error("Both clearance faces must be planar");
  const firstNormal = normalize(firstFace.normal, "First clearance face normal");
  const secondNormal = normalize(secondFace.normal, "Second clearance face normal");
  const normalAngleDeg = radiansToDegrees(Math.acos(clamp(dot(firstNormal, secondNormal), -1, 1)));
  const planeAngleDeg = Math.min(normalAngleDeg, 180 - normalAngleDeg);
  if (planeAngleDeg <= 1e-7) throw new Error("Nonparallel polygon clearance requires nonparallel planar faces");
  const firstRegion = readPlanarFaceRegion(state, first, firstFace.centerMm, firstNormal);
  const secondRegion = readPlanarFaceRegion(state, second, secondFace.centerMm, secondNormal);
  if (firstRegion.circles.length > 0 || secondRegion.circles.length > 0
    || firstRegion.loops.length === 0 || secondRegion.loops.length === 0
    || [...firstRegion.loops, ...secondRegion.loops].some((loops) => loops.some((segment) => segment.curve.kind !== "line"))) {
    throw new Error("Nonparallel polygon clearance supports straight-edged planar face regions; circular boundaries are unsupported");
  }
  const measured = measureNonparallelPolygonClearance(
    firstRegion.loops.map((loop) => loop.map((segment) => segment.startPointMm)),
    secondRegion.loops.map((loop) => loop.map((segment) => segment.startPointMm)),
  );
  return {
    documentToken: state.documentToken,
    revision: state.revision,
    measurementSource: "native-brep" as const,
    method: "nonparallel-planar-polygon-regions" as const,
    exact: true as const,
    status: "measured" as const,
    first,
    second,
    normalAngleDeg,
    minimumDistanceMm: measured.distanceMm,
    closestPointsMm: { first: measured.first, second: measured.second },
  };
}

export function measureLinearEdges(
  state: RuntimeState,
  first: EdgeReference,
  second: EdgeReference,
  revision: string,
  angularToleranceDeg = 0.01,
) {
  requireRevision(state, revision);
  requirePositiveFinite(angularToleranceDeg, "angularToleranceDeg");
  const firstEdge = requireEdge(state, first);
  const secondEdge = requireEdge(state, second);
  if (!firstEdge.line || !secondEdge.line) throw new Error("Both measurement edges must be linear");
  const firstDirection = normalize(firstEdge.tangent, "First edge direction");
  const secondDirection = normalize(secondEdge.tangent, "Second edge direction");
  const directionAngleDeg = radiansToDegrees(Math.acos(clamp(dot(firstDirection, secondDirection), -1, 1)));
  const lineAngleDeg = Math.min(directionAngleDeg, 180 - directionAngleDeg);
  const parallel = lineAngleDeg <= angularToleranceDeg;
  const betweenCenters = subtract(secondEdge.centerMm, firstEdge.centerMm);
  const crossDirection = cross(firstDirection, secondDirection);
  const crossMagnitude = magnitude(crossDirection);
  const supportingLineDistanceMm = parallel
    ? magnitude(cross(betweenCenters, firstDirection))
    : Math.abs(dot(betweenCenters, crossDirection)) / crossMagnitude;
  const finiteSegment = closestLinearSegments(firstEdge.centerMm, firstDirection, firstEdge.lengthMm, secondEdge.centerMm, secondDirection, secondEdge.lengthMm);
  return {
    documentToken: state.documentToken,
    revision: state.revision,
    measurementSource: "native-brep" as const,
    first: { ...first, pointMm: firstEdge.centerMm, direction: firstDirection, lengthMm: firstEdge.lengthMm },
    second: { ...second, pointMm: secondEdge.centerMm, direction: secondDirection, lengthMm: secondEdge.lengthMm },
    directionAngleDeg,
    lineAngleDeg,
    parallel,
    perpendicular: Math.abs(lineAngleDeg - 90) <= angularToleranceDeg,
    supportingLineDistanceMm,
    finiteSegmentDistanceMm: finiteSegment.distanceMm,
    closestPointsMm: { first: finiteSegment.firstPointMm, second: finiteSegment.secondPointMm },
  };
}

function closestLinearSegments(
  firstCenter: Vector3,
  firstDirection: Vector3,
  firstLengthMm: number,
  secondCenter: Vector3,
  secondDirection: Vector3,
  secondLengthMm: number,
): { distanceMm: number; firstPointMm: Vector3; secondPointMm: Vector3 } {
  if (!Number.isFinite(firstLengthMm) || firstLengthMm <= 0 || !Number.isFinite(secondLengthMm) || secondLengthMm <= 0) {
    throw new Error("Linear edge lengths must be positive and finite");
  }
  const firstVector = scale(firstDirection, firstLengthMm);
  const secondVector = scale(secondDirection, secondLengthMm);
  const firstStart = subtract(firstCenter, scale(firstVector, 0.5));
  const secondStart = subtract(secondCenter, scale(secondVector, 0.5));
  const offset = subtract(firstStart, secondStart);
  const a = dot(firstVector, firstVector);
  const b = dot(firstVector, secondVector);
  const c = dot(secondVector, secondVector);
  const d = dot(firstVector, offset);
  const e = dot(secondVector, offset);
  const candidates: Array<{ s: number; t: number; distanceSquared: number }> = [];
  const addCandidate = (s: number, t: number) => {
    const firstPoint = add(firstStart, scale(firstVector, s));
    const secondPoint = add(secondStart, scale(secondVector, t));
    const delta = subtract(firstPoint, secondPoint);
    candidates.push({ s, t, distanceSquared: dot(delta, delta) });
  };

  // The four clamped boundary minima cover parallel segments and all cases
  // where the unconstrained closest points lie beyond either finite endpoint.
  addCandidate(0, clamp(e / c, 0, 1));
  addCandidate(1, clamp((e + b) / c, 0, 1));
  addCandidate(clamp(-d / a, 0, 1), 0);
  addCandidate(clamp((b - d) / a, 0, 1), 1);

  const determinant = a * c - b * b;
  if (determinant > Number.EPSILON * a * c * 16) {
    const s = (b * e - c * d) / determinant;
    const t = (a * e - b * d) / determinant;
    if (s >= 0 && s <= 1 && t >= 0 && t <= 1) addCandidate(s, t);
  }

  let closest = candidates[0]!;
  for (const candidate of candidates.slice(1)) {
    if (candidate.distanceSquared < closest.distanceSquared) closest = candidate;
  }
  return {
    distanceMm: Math.sqrt(closest.distanceSquared),
    firstPointMm: add(firstStart, scale(firstVector, closest.s)),
    secondPointMm: add(secondStart, scale(secondVector, closest.t)),
  };
}

export function measureFastenerGripStack(
  state: RuntimeState,
  layers: FastenerGripLayerReference[],
  axis: Vector3,
  revision: string,
  angularToleranceDeg = 0.01,
) {
  requireRevision(state, revision);
  requirePositiveFinite(angularToleranceDeg, "angularToleranceDeg");
  if (layers.length < 1 || layers.length > 64) throw new Error("Fastener grip stack requires between 1 and 64 layers");
  if (new Set(layers.map((layer) => layer.id)).size !== layers.length) throw new Error("Fastener grip layer IDs must be unique");
  const facePairKeys = layers.map((layer) => `${layer.first.bodyId}:${[layer.first.faceId, layer.second.faceId].sort().join(":")}`);
  if (new Set(facePairKeys).size !== facePairKeys.length) throw new Error("Fastener grip face pairs must be unique");
  const normalizedAxis = normalize(axis, "Fastener axis");
  const measuredLayers = layers.map((layer) => {
    if (!layer.id.trim()) throw new Error("Fastener grip layer ID must not be empty");
    if (layer.first.bodyId !== layer.second.bodyId) throw new Error(`Fastener grip layer ${layer.id} faces must belong to the same body`);
    if (layer.first.faceId === layer.second.faceId) throw new Error(`Fastener grip layer ${layer.id} requires two different faces`);
    const body = state.bodies.find((candidate) => candidate.id === layer.first.bodyId);
    if (!body) throw new Error(`Unknown current body ID: ${layer.first.bodyId}`);
    if (body.type !== "Solid") throw new Error(`Fastener grip layer ${layer.id} body must be a Solid`);
    const measurement = measurePlanarFaces(state, layer.first, layer.second, revision, angularToleranceDeg);
    if (!measurement.parallel || measurement.separationMm === null) throw new Error(`Fastener grip layer ${layer.id} faces must be parallel`);
    for (const [position, face] of [["first", measurement.first], ["second", measurement.second]] as const) {
      const alignment = Math.abs(dot(face.normal, normalizedAxis));
      const angleDeg = radiansToDegrees(Math.acos(clamp(alignment, -1, 1)));
      if (angleDeg > angularToleranceDeg) throw new Error(`Fastener grip layer ${layer.id} ${position} face normal must align with the fastener axis`);
    }
    if (measurement.separationMm <= 1e-9) throw new Error(`Fastener grip layer ${layer.id} thickness must be positive`);
    return {
      id: layer.id,
      bodyId: body.id,
      bodyVersionId: body.versionId,
      first: measurement.first,
      second: measurement.second,
      thicknessMm: measurement.separationMm,
    };
  });
  const gripItems = measuredLayers.map(({ id, thicknessMm }) => ({ id, thicknessMm }));
  return {
    documentToken: state.documentToken,
    revision: state.revision,
    measurementSource: "native-brep-planar-faces" as const,
    axis: normalizedAxis,
    layers: measuredLayers,
    gripItems,
    totalGripMm: gripItems.reduce((total, item) => total + item.thicknessMm, 0),
  };
}

function resolveMeasurementPoint(state: RuntimeState, reference: MeasurementPointReference): Vector3 {
  if (reference.type === "coordinates") {
    if (!reference.pointMm.every(Number.isFinite)) throw new Error("Measurement coordinates must be finite");
    return [...reference.pointMm];
  }
  const body = state.bodies.find((candidate) => candidate.id === reference.bodyId);
  if (!body) throw new Error(`Unknown current body ID: ${reference.bodyId}`);
  if (reference.type === "vertex") {
    const vertex = body.vertices?.find((candidate) => candidate.id === reference.vertexId);
    if (!vertex) throw new Error(`Unknown current vertex ID ${reference.vertexId} on body ${reference.bodyId}`);
    return [...vertex.positionMm];
  }
  if (reference.type === "edge-midpoint") {
    const edge = body.edges.find((candidate) => candidate.id === reference.edgeId);
    if (!edge) throw new Error(`Unknown current edge ID ${reference.edgeId} on body ${reference.bodyId}`);
    return [...edge.centerMm];
  }
  const face = body.faces.find((candidate) => candidate.id === reference.faceId);
  if (!face) throw new Error(`Unknown current face ID ${reference.faceId} on body ${reference.bodyId}`);
  return [...face.centerMm];
}

function requireFace(state: RuntimeState, reference: FaceReference) {
  const face = state.bodies.find((body) => body.id === reference.bodyId)?.faces
    .find((candidate) => candidate.id === reference.faceId);
  if (!face) throw new Error(`Unknown current face ID ${reference.faceId} on body ${reference.bodyId}`);
  return face;
}

function requireEdge(state: RuntimeState, reference: EdgeReference) {
  const edge = state.bodies.find((body) => body.id === reference.bodyId)?.edges
    .find((candidate) => candidate.id === reference.edgeId);
  if (!edge) throw new Error(`Unknown current edge ID ${reference.edgeId} on body ${reference.bodyId}`);
  return edge;
}

function requireRevision(state: RuntimeState, revision: string): void {
  if (state.revision !== revision) {
    throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
  }
}

function requirePositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number`);
}

function subtract(left: readonly number[], right: readonly number[]): Vector3 {
  return [left[0]! - right[0]!, left[1]! - right[1]!, left[2]! - right[2]!];
}

function add(left: readonly number[], right: readonly number[]): Vector3 {
  return [left[0]! + right[0]!, left[1]! + right[1]!, left[2]! + right[2]!];
}

function scale(vector: readonly number[], factor: number): Vector3 {
  return [vector[0]! * factor, vector[1]! * factor, vector[2]! * factor];
}

function dot(left: readonly number[], right: readonly number[]): number {
  return left[0]! * right[0]! + left[1]! * right[1]! + left[2]! * right[2]!;
}

function cross(left: readonly number[], right: readonly number[]): Vector3 {
  return [
    left[1]! * right[2]! - left[2]! * right[1]!,
    left[2]! * right[0]! - left[0]! * right[2]!,
    left[0]! * right[1]! - left[1]! * right[0]!,
  ];
}

function magnitude(vector: readonly number[]): number {
  return Math.hypot(vector[0]!, vector[1]!, vector[2]!);
}

function normalize(vector: readonly number[], description: string): Vector3 {
  const length = magnitude(vector);
  if (!Number.isFinite(length) || length <= 1e-12) throw new Error(`${description} is unavailable`);
  return [vector[0]! / length, vector[1]! / length, vector[2]! / length];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function positiveAngle(angle: number): number {
  const turn = 2 * Math.PI;
  return ((angle % turn) + turn) % turn;
}

function circularArcParameter(angle: number, startAngle: number, sweepRadians: number, tolerance: number): number | null {
  const distanceAlongSweep = sweepRadians > 0
    ? positiveAngle(angle - startAngle)
    : positiveAngle(startAngle - angle);
  const sweepMagnitude = Math.abs(sweepRadians);
  if (distanceAlongSweep > sweepMagnitude + tolerance) return null;
  return clamp(distanceAlongSweep / sweepMagnitude, 0, 1);
}

function validateCirclePoint(positionMm: Vector3, centerMm: Vector3, normal: Vector3, radiusMm: number, label: string): Vector3 {
  const relative = subtract(positionMm, centerMm);
  const axial = dot(relative, normal);
  const inPlane = subtract(relative, scale(normal, axial));
  if (Math.abs(axial) > 1e-6 || Math.abs(magnitude(inPlane) - radiusMm) > 1e-6) {
    throw new Error(`Measurement circle ${label} does not lie on its reported exact circle`);
  }
  return inPlane;
}

function circleAngle(radial: Vector3, reference: Vector3, secondAxis: Vector3): number {
  return Math.atan2(dot(radial, secondAxis), dot(radial, reference));
}

function radiansToDegrees(value: number): number {
  return value * 180 / Math.PI;
}
