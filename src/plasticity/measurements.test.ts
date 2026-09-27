import assert from "node:assert/strict";
import { test } from "node:test";

import { measureFastenerGripStack, measureLinearEdges, measureNonparallelPlanarPolygonFaceClearance, measureParallelPlanarFaceClearance, measurePlanarFaces, measurePointDistance, measurePointToCircularEdge, measurePointToLinearEdge, measurePointToPlanarFace, measurePointToSampledCurveEdge } from "./measurements.ts";
import type { RuntimeState } from "./runtime.ts";

test("measures an exact distance between revision-bound B-Rep vertices", () => {
  const state = measurementState();

  const measured = measurePointDistance(
    state,
    { type: "vertex", bodyId: 7, vertexId: 101 },
    { type: "vertex", bodyId: 7, vertexId: 102 },
    state.revision,
  );

  assert.equal(measured.measurementSource, "native-brep");
  assert.deepEqual(measured.deltaMm, [3, 4, 12]);
  assert.equal(measured.distanceMm, 13);
});

test("resolves explicit coordinates, exact edge midpoints, and exact face points", () => {
  const state = measurementState();

  const measured = measurePointDistance(
    state,
    { type: "coordinates", pointMm: [1, 2, 3] },
    { type: "face-center", bodyId: 7, faceId: "top" },
    state.revision,
  );
  const edgeMeasured = measurePointDistance(
    state,
    { type: "edge-midpoint", bodyId: 7, edgeId: "x-edge" },
    { type: "coordinates", pointMm: [0, 0, 0] },
    state.revision,
  );

  assert.deepEqual(measured.deltaMm, [4, 3, 5]);
  assert.equal(measured.distanceMm, Math.sqrt(50));
  assert.equal(measured.measurementSource, "native-brep-and-explicit-coordinates");
  assert.equal(edgeMeasured.distanceMm, 5);
});

test("measures separation and orientation of exact planar faces", () => {
  const state = measurementState();

  const parallel = measurePlanarFaces(
    state,
    { bodyId: 7, faceId: "bottom" },
    { bodyId: 7, faceId: "top" },
    state.revision,
  );
  const perpendicular = measurePlanarFaces(
    state,
    { bodyId: 7, faceId: "top" },
    { bodyId: 7, faceId: "side" },
    state.revision,
  );

  assert.equal(parallel.parallel, true);
  assert.equal(parallel.normalAngleDeg, 180);
  assert.equal(parallel.planeAngleDeg, 0);
  assert.equal(parallel.separationKind, "supporting-planes");
  assert.equal(parallel.signedSeparationMm, 8);
  assert.equal(parallel.separationMm, 8);
  assert.equal(perpendicular.parallel, false);
  assert.equal(perpendicular.planeAngleDeg, 90);
  assert.equal(perpendicular.separationKind, null);
  assert.equal(perpendicular.separationMm, null);
});

test("measures exact clearance between parallel trimmed polygonal planar faces", () => {
  const state = measurementState();
  addRectangleFace(state, "clearance-first", 0, 0, 0, 10, 10);
  addRectangleFace(state, "clearance-overlap", 8, 2, 2, 8, 8);
  addRectangleFace(state, "clearance-offset", 4, 13, 0, 23, 10);

  const overlap = measureParallelPlanarFaceClearance(
    state,
    { bodyId: 7, faceId: "clearance-first" },
    { bodyId: 7, faceId: "clearance-overlap" },
    state.revision,
  );
  const separated = measureParallelPlanarFaceClearance(
    state,
    { bodyId: 7, faceId: "clearance-first" },
    { bodyId: 7, faceId: "clearance-offset" },
    state.revision,
  );

  assert.equal(overlap.status, "measured");
  assert.equal(overlap.inPlaneClearanceMm, 0);
  assert.equal(overlap.minimumDistanceMm, 8);
  assert.deepEqual(overlap.closestPointsMm, { first: [2, 2, 0], second: [2, 2, 8] });
  assert.equal(separated.inPlaneClearanceMm, 3);
  assert.equal(separated.parallelPlaneGapMm, 4);
  assert.equal(separated.minimumDistanceMm, 5);
  assert.deepEqual(separated.closestPointsMm, { first: [10, 0, 0], second: [13, 0, 4] });
});

test("measures exact clearance between nonparallel polygonal planar regions", () => {
  const state = measurementState();
  const horizontal = addPolygonFace(state, "oblique-clearance-horizontal", [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]]);
  const vertical = addPolygonFace(state, "oblique-clearance-vertical", [[3, 0, 0], [3, 2, 0], [3, 2, 2], [3, 0, 2]]);
  const crossed = addPolygonFace(state, "oblique-clearance-crossed", [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]]);
  const concave = addPolygonFace(state, "oblique-clearance-concave", [[0, 0, 0], [3, 0, 0], [3, 1, 0], [1, 1, 0], [1, 3, 0], [0, 3, 0]]);
  const notch = addPolygonFace(state, "oblique-clearance-notch", [[2, 1.5, -1], [2, 2.5, -1], [2, 2.5, 1], [2, 1.5, 1]]);

  const separated = measureNonparallelPlanarPolygonFaceClearance(state, { bodyId: 7, faceId: horizontal.id }, { bodyId: 7, faceId: vertical.id }, state.revision);
  const intersecting = measureNonparallelPlanarPolygonFaceClearance(state, { bodyId: 7, faceId: horizontal.id }, { bodyId: 7, faceId: crossed.id }, state.revision);
  const concaveClearance = measureNonparallelPlanarPolygonFaceClearance(state, { bodyId: 7, faceId: concave.id }, { bodyId: 7, faceId: notch.id }, state.revision);

  assert.equal(separated.exact, true);
  assert.equal(separated.minimumDistanceMm, 1);
  assert.deepEqual(separated.closestPointsMm, { first: [2, 0, 0], second: [3, 0, 0] });
  assert.equal(intersecting.minimumDistanceMm, 0);
  assert.deepEqual(intersecting.closestPointsMm.first, intersecting.closestPointsMm.second);
  assert.equal(concaveClearance.minimumDistanceMm, 0.5);
  assert.deepEqual(concaveClearance.closestPointsMm, { first: [2, 1, 0], second: [2, 1.5, 0] });
  assert.throws(() => measureNonparallelPlanarPolygonFaceClearance(state, { bodyId: 7, faceId: horizontal.id }, { bodyId: 7, faceId: "top" }, state.revision), /nonparallel/u);
  assert.throws(() => measureNonparallelPlanarPolygonFaceClearance(state, { bodyId: 7, faceId: horizontal.id }, { bodyId: 7, faceId: vertical.id }, "stale-revision"), /stale reference/iu);
});

test("keeps the hole empty when measuring a nonparallel planar face region", () => {
  const state = measurementState();
  addRectangleFace(state, "oblique-clearance-holed", 0, 0, 0, 10, 10);
  addRectangleLoop(state, "oblique-clearance-holed", 0, 4, 4, 6, 6);
  const vertical = addPolygonFace(state, "oblique-clearance-hole-probe", [[5, 4.5, -1], [5, 5.5, -1], [5, 5.5, 1], [5, 4.5, 1]]);

  const measured = measureNonparallelPlanarPolygonFaceClearance(
    state,
    { bodyId: 7, faceId: "oblique-clearance-holed" },
    { bodyId: 7, faceId: vertical.id },
    state.revision,
  );

  assert.equal(measured.minimumDistanceMm, 0.5);
  assert.ok([4, 6].some((boundaryY) => measured.closestPointsMm.first[1] === boundaryY
    && measured.closestPointsMm.second[1] === boundaryY + (boundaryY === 4 ? 0.5 : -0.5)));
});

test("respects polygonal holes and rejects geometry outside the exact clearance method", () => {
  const state = measurementState();
  addRectangleFace(state, "clearance-with-hole", 0, 0, 0, 10, 10);
  addRectangleFace(state, "clearance-first", 0, 0, 0, 10, 10);
  addRectangleLoop(state, "clearance-with-hole", 0, 3, 3, 7, 7);
  addRectangleFace(state, "clearance-in-hole", 0, 4, 4, 6, 6);
  addRectangleFace(state, "clearance-angled", 1, 4, 4, 6, 6);
  state.bodies[0]!.faces.find((face) => face.id === "clearance-angled")!.normal = [0, Math.SQRT1_2, Math.SQRT1_2];
  const curvedEdgeFace = addRectangleFace(state, "clearance-curved-edge", 2, 4, 4, 6, 6);
  state.bodies[0]!.edges.find((edge) => edge.id === curvedEdgeFace.edgeIds[0])!.line = false;
  const nonfiniteFace = addRectangleFace(state, "clearance-nonfinite", 0, 20, 0, 22, 2);
  const nonfiniteEdge = state.bodies[0]!.edges.find((edge) => edge.id === nonfiniteFace.edgeIds[0])!;
  state.bodies[0]!.vertices!.find((vertex) => vertex.id === nonfiniteEdge.vertexIds[0])!.positionMm[0] = Number.NaN;

  const inHole = measureParallelPlanarFaceClearance(
    state,
    { bodyId: 7, faceId: "clearance-with-hole" },
    { bodyId: 7, faceId: "clearance-in-hole" },
    state.revision,
  );
  assert.equal(inHole.inPlaneClearanceMm, 1);
  assert.equal(inHole.minimumDistanceMm, 1);
  assert.throws(() => measureParallelPlanarFaceClearance(
    state,
    { bodyId: 7, faceId: "clearance-first" },
    { bodyId: 7, faceId: "clearance-angled" },
    state.revision,
  ), /requires parallel planar faces/i);
  assert.throws(() => measureParallelPlanarFaceClearance(
    state,
    { bodyId: 7, faceId: "clearance-first" },
    { bodyId: 7, faceId: "clearance-curved-edge" },
    state.revision,
  ), /supports straight edges and exact circular boundaries only/i);
  assert.throws(() => measureParallelPlanarFaceClearance(
    state,
    { bodyId: 7, faceId: "clearance-first" },
    { bodyId: 7, faceId: "clearance-nonfinite" },
    state.revision,
  ), /coordinates must be finite/i);
  assert.throws(() => measureParallelPlanarFaceClearance(
    state,
    { bodyId: 7, faceId: "clearance-first" },
    { bodyId: 7, faceId: "clearance-in-hole" },
    "stale-revision",
  ), /stale reference/i);
});

test("measures exact clearance to a complete circular hole in parallel planar faces", () => {
  const state = measurementState();
  addRectangleFace(state, "clearance-circular-hole", 0, 0, 0, 10, 10);
  addFullCircleBoundary(state, "clearance-circular-hole", 0, 5, 5, 4);
  addRectangleFace(state, "clearance-in-circular-hole", 0, 3, 3, 7, 7);

  const result = measureParallelPlanarFaceClearance(
    state,
    { bodyId: 7, faceId: "clearance-circular-hole" },
    { bodyId: 7, faceId: "clearance-in-circular-hole" },
    state.revision,
  );

  assert.equal(result.parallelPlaneGapMm, 0);
  assert.ok(Math.abs(result.inPlaneClearanceMm - (4 - Math.sqrt(8))) < 1e-10);
  assert.ok(Math.abs(result.minimumDistanceMm - (4 - Math.sqrt(8))) < 1e-10);
  assert.ok(Math.abs(Math.hypot(result.closestPointsMm.first[0] - 5, result.closestPointsMm.first[1] - 5) - 4) < 1e-10);
  assert.deepEqual(result.closestPointsMm.second, [3, 3, 0]);
});

test("measures exact clearance and tangency between circular planar faces", () => {
  const state = measurementState();
  addCircularFace(state, "clearance-circle-first", 0, 0, 0, 5);
  addCircularFace(state, "clearance-circle-separated", 3, 12, 0, 5);
  addCircularFace(state, "clearance-circle-tangent", 4, 10, 0, 5);

  const separated = measureParallelPlanarFaceClearance(
    state,
    { bodyId: 7, faceId: "clearance-circle-first" },
    { bodyId: 7, faceId: "clearance-circle-separated" },
    state.revision,
  );
  const tangent = measureParallelPlanarFaceClearance(
    state,
    { bodyId: 7, faceId: "clearance-circle-first" },
    { bodyId: 7, faceId: "clearance-circle-tangent" },
    state.revision,
  );

  assert.equal(separated.inPlaneClearanceMm, 2);
  assert.equal(separated.parallelPlaneGapMm, 3);
  assert.ok(Math.abs(separated.minimumDistanceMm - Math.sqrt(13)) < 1e-12);
  assert.deepEqual(separated.closestPointsMm, { first: [5, 0, 0], second: [7, 0, 3] });
  assert.equal(tangent.inPlaneClearanceMm, 0);
  assert.equal(tangent.minimumDistanceMm, 4);
});

test("measures exact clearance between parallel faces with native trimmed circular arcs", () => {
  const state = measurementState();
  addRoundedRectangleFace(state, "clearance-rounded-first", 0, 0, 0, 10, 10, 2);
  addRoundedRectangleFace(state, "clearance-rounded-second", 0, 12, 12, 10, 10, 2);
  addRoundedRectangleFace(state, "clearance-rounded-tangent", 0, 8 + 2 * Math.SQRT2 - 2, 8 + 2 * Math.SQRT2 - 2, 10, 10, 2);
  addRoundedRectangleFace(state, "clearance-rounded-contained", 0, 3, 3, 4, 4, 1);
  addRectangleFace(state, "clearance-rounded-line-near-arc", 0, 10.5, 9, 12.5, 11);

  const result = measureParallelPlanarFaceClearance(
    state,
    { bodyId: 7, faceId: "clearance-rounded-first" },
    { bodyId: 7, faceId: "clearance-rounded-second" },
    state.revision,
  );
  const diagonalGap = Math.sqrt(72) - 4;
  const radialOffset = 2 / Math.sqrt(2);
  const contained = measureParallelPlanarFaceClearance(
    state,
    { bodyId: 7, faceId: "clearance-rounded-first" },
    { bodyId: 7, faceId: "clearance-rounded-contained" },
    state.revision,
  );
  const lineToArc = measureParallelPlanarFaceClearance(
    state,
    { bodyId: 7, faceId: "clearance-rounded-first" },
    { bodyId: 7, faceId: "clearance-rounded-line-near-arc" },
    state.revision,
  );
  const tangent = measureParallelPlanarFaceClearance(
    state,
    { bodyId: 7, faceId: "clearance-rounded-first" },
    { bodyId: 7, faceId: "clearance-rounded-tangent" },
    state.revision,
  );

  assert.ok(Math.abs(result.inPlaneClearanceMm - diagonalGap) < 1e-10);
  assert.deepEqual(result.closestPointsMm.first, [8 + radialOffset, 8 + radialOffset, 0]);
  assert.deepEqual(result.closestPointsMm.second, [14 - radialOffset, 14 - radialOffset, 0]);
  assert.equal(contained.inPlaneClearanceMm, 0);
  assert.equal(lineToArc.closestPointsMm.second[0], 10.5);
  assert.ok(Math.abs(lineToArc.inPlaneClearanceMm - Math.hypot(10.5 - (8 + 5 / Math.sqrt(7.25)), 9 - (8 + 2 / Math.sqrt(7.25)))) < 1e-10);
  assert.equal(tangent.inPlaneClearanceMm, 0);
});

test("measures exact angles and supporting-line clearance between linear edges", () => {
  const state = measurementState();

  const parallel = measureLinearEdges(
    state,
    { bodyId: 7, edgeId: "x-edge" },
    { bodyId: 7, edgeId: "x-edge-offset" },
    state.revision,
  );
  const perpendicular = measureLinearEdges(
    state,
    { bodyId: 7, edgeId: "x-edge" },
    { bodyId: 7, edgeId: "y-edge" },
    state.revision,
  );

  assert.equal(parallel.parallel, true);
  assert.equal(parallel.lineAngleDeg, 0);
  assert.equal(parallel.supportingLineDistanceMm, 3);
  assert.equal(perpendicular.perpendicular, true);
  assert.equal(perpendicular.lineAngleDeg, 90);
  assert.equal(perpendicular.supportingLineDistanceMm, 2);
});

test("measures closest points between bounded linear-edge centerlines", () => {
  const state = measurementState();
  state.bodies[0]!.edges.push(
    {
      ...state.bodies[0]!.edges[0]!,
      id: "x-edge-touching",
      centerMm: [15, 0, 0],
      tangent: [1, 0, 0],
    },
    {
      ...state.bodies[0]!.edges[0]!,
      id: "x-edge-disjoint",
      centerMm: [20, 0, 0],
      tangent: [1, 0, 0],
    },
    {
      ...state.bodies[0]!.edges[0]!,
      id: "y-edge-outside-crossing",
      centerMm: [15, 5, 0],
      tangent: [0, 1, 0],
    },
    {
      ...state.bodies[0]!.edges[0]!,
      id: "skew-edge",
      centerMm: [12, 2, 5],
      tangent: [0, 0, 1],
    },
    {
      ...state.bodies[0]!.edges[0]!,
      id: "y-edge-crossing-interior",
      centerMm: [5, 0, 0],
      tangent: [0, 1, 0],
    },
  );

  const parallel = measureLinearEdges(
    state,
    { bodyId: 7, edgeId: "x-edge" },
    { bodyId: 7, edgeId: "x-edge-offset" },
    state.revision,
  );
  assert.equal(parallel.finiteSegmentDistanceMm, 3);
  assert.deepEqual(parallel.closestPointsMm, { first: [0, 0, 0], second: [0, 3, 0] });

  const touching = measureLinearEdges(
    state,
    { bodyId: 7, edgeId: "x-edge" },
    { bodyId: 7, edgeId: "x-edge-touching" },
    state.revision,
  );
  assert.equal(touching.finiteSegmentDistanceMm, 0);
  assert.deepEqual(touching.closestPointsMm, { first: [10, 0, 0], second: [10, 0, 0] });

  const separated = measureLinearEdges(
    state,
    { bodyId: 7, edgeId: "x-edge" },
    { bodyId: 7, edgeId: "x-edge-disjoint" },
    state.revision,
  );
  assert.equal(separated.finiteSegmentDistanceMm, 5);
  assert.deepEqual(separated.closestPointsMm, { first: [10, 0, 0], second: [15, 0, 0] });

  const interiorCrossing = measureLinearEdges(
    state,
    { bodyId: 7, edgeId: "x-edge" },
    { bodyId: 7, edgeId: "y-edge-crossing-interior" },
    state.revision,
  );
  assert.equal(interiorCrossing.finiteSegmentDistanceMm, 0);
  assert.deepEqual(interiorCrossing.closestPointsMm, { first: [5, 0, 0], second: [5, 0, 0] });

  const outsideCrossing = measureLinearEdges(
    state,
    { bodyId: 7, edgeId: "x-edge" },
    { bodyId: 7, edgeId: "y-edge-outside-crossing" },
    state.revision,
  );
  assert.equal(outsideCrossing.supportingLineDistanceMm, 0);
  assert.equal(outsideCrossing.finiteSegmentDistanceMm, 5);
  assert.deepEqual(outsideCrossing.closestPointsMm, { first: [10, 0, 0], second: [15, 0, 0] });

  const skew = measureLinearEdges(
    state,
    { bodyId: 7, edgeId: "x-edge" },
    { bodyId: 7, edgeId: "skew-edge" },
    state.revision,
  );
  assert.equal(skew.supportingLineDistanceMm, 2);
  assert.equal(skew.finiteSegmentDistanceMm, Math.sqrt(8));
  assert.deepEqual(skew.closestPointsMm, { first: [10, 0, 0], second: [12, 2, 0] });
});

test("measures a point against the finite span of a linear B-Rep edge", () => {
  const state = measurementState();
  const edge = { bodyId: 7, edgeId: "x-edge" };
  const interior = measurePointToLinearEdge(
    state,
    { type: "coordinates", pointMm: [5, 3, 0] },
    edge,
    state.revision,
  );
  assert.equal(interior.measurementSource, "native-brep-and-explicit-coordinates");
  assert.equal(interior.supportingLineDistanceMm, 3);
  assert.equal(interior.finiteSegmentDistanceMm, 3);
  assert.equal(interior.unclampedEdgeParameter, 0.5);
  assert.equal(interior.clampedToEndpoint, false);
  assert.deepEqual(interior.closestPointMm, [5, 0, 0]);

  const beyondEnd = measurePointToLinearEdge(
    state,
    { type: "coordinates", pointMm: [15, 3, 0] },
    edge,
    state.revision,
  );
  assert.equal(beyondEnd.supportingLineDistanceMm, 3);
  assert.ok(Math.abs(beyondEnd.finiteSegmentDistanceMm - Math.sqrt(34)) < 1e-12);
  assert.equal(beyondEnd.unclampedEdgeParameter, 1.5);
  assert.equal(beyondEnd.clampedToEndpoint, true);
  assert.deepEqual(beyondEnd.closestPointMm, [10, 0, 0]);

  const vertex = measurePointToLinearEdge(
    state,
    { type: "vertex", bodyId: 7, vertexId: 102 },
    edge,
    state.revision,
  );
  assert.equal(vertex.measurementSource, "native-brep");
  assert.equal(vertex.finiteSegmentDistanceMm, Math.sqrt(160));
  assert.deepEqual(vertex.closestPointMm, [3, 0, 0]);
  assert.throws(() => measurePointToLinearEdge(state, { type: "coordinates", pointMm: [0, 0, 0] }, edge, "old-revision"), /stale reference/i);
  assert.throws(() => measurePointToLinearEdge(state, { type: "coordinates", pointMm: [0, 0, 0] }, { bodyId: 7, edgeId: "arc" }, state.revision), /must be linear/i);
});

test("estimates point distance to an arbitrary native curved edge without claiming an exact result", () => {
  const state = measurementState();
  state.bodies[0]!.edges.push({
    id: "spline", curveType: "BSpline", line: false, circle: false, lengthMm: 10,
    centerMm: [5, 1.8, 0], tangent: [1, 0, 0], boundsMm: { min: [0, 0, 0], max: [10, 3, 0] }, faceIds: [], vertexIds: [],
  });
  const samples = [
    { normalizedParameter: 0, positionMm: [0, 0, 0] as [number, number, number] },
    { normalizedParameter: 0.25, positionMm: [2.5, 2, 0] as [number, number, number] },
    { normalizedParameter: 0.5, positionMm: [5, 3, 0] as [number, number, number] },
    { normalizedParameter: 0.75, positionMm: [7.5, 2, 0] as [number, number, number] },
    { normalizedParameter: 1, positionMm: [10, 0, 0] as [number, number, number] },
  ];
  const result = measurePointToSampledCurveEdge(
    state,
    { type: "coordinates", pointMm: [5, 4, 0] },
    { bodyId: 7, edgeId: "spline" },
    state.revision,
    samples,
    { requestedToleranceMm: 0.01, maxObservedChordDeviationMm: 0.02 },
  );

  assert.equal(result.measurementSource, "native-brep-sampled-polyline");
  assert.equal(result.exact, false);
  assert.deepEqual(result.closestPointEstimateMm, [5, 3, 0]);
  assert.equal(result.estimatedDistanceMm, 1);
  assert.equal(result.approximationToleranceMm, 0.01);
  assert.equal(result.maxObservedChordDeviationMm, 0.02);
  assert.equal(result.toleranceObserved, false);
  assert.throws(() => measurePointToSampledCurveEdge(state, { type: "coordinates", pointMm: [0, 0, 0] }, { bodyId: 7, edgeId: "spline" }, "old-revision", samples, { requestedToleranceMm: 0.01, maxObservedChordDeviationMm: 0 }), /stale reference/i);
  assert.throws(() => measurePointToSampledCurveEdge(state, { type: "coordinates", pointMm: [0, 0, 0] }, { bodyId: 7, edgeId: "spline" }, state.revision, samples.slice(0, 1), { requestedToleranceMm: 0.01, maxObservedChordDeviationMm: 0 }), /at least two/i);
});

test("estimates a native Wire spline segment with the same explicit approximate semantics", () => {
  const state = measurementState();
  state.bodies.push({
    id: 9, versionId: 19, type: "Wire", name: "Spline guide", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [],
  });
  const samples = [
    { normalizedParameter: 0, positionMm: [0, 0, 0] as [number, number, number] },
    { normalizedParameter: 0.5, positionMm: [5, 3, 0] as [number, number, number] },
    { normalizedParameter: 1, positionMm: [10, 0, 0] as [number, number, number] },
  ];
  const wireSegment = { bodyId: 9, segmentEntityId: 501 };
  const result = measurePointToSampledCurveEdge(
    state,
    { type: "coordinates", pointMm: [5, 4, 0] },
    wireSegment,
    state.revision,
    samples,
    { requestedToleranceMm: 0.01, maxObservedChordDeviationMm: 0.005 },
    { bodyId: 9, segmentEntityId: 501, curveType: "BCurve", lengthMm: 11.2, linear: false, circular: false },
  );

  assert.equal(result.measurementSource, "native-brep-sampled-polyline");
  assert.equal(result.exact, false);
  assert.deepEqual(result.edge, { ...wireSegment, curveType: "BCurve", lengthMm: 11.2 });
  assert.equal(result.estimatedDistanceMm, 1);
  assert.equal(result.toleranceObserved, true);
  assert.throws(() => measurePointToSampledCurveEdge(
    state, { type: "coordinates", pointMm: [0, 0, 0] }, wireSegment, state.revision, samples,
    { requestedToleranceMm: 0.01, maxObservedChordDeviationMm: 0.005 },
  ), /current Wire segment geometry/i);
  assert.throws(() => measurePointToSampledCurveEdge(
    state, { type: "coordinates", pointMm: [0, 0, 0] }, wireSegment, state.revision, samples,
    { requestedToleranceMm: 0.01, maxObservedChordDeviationMm: 0.005 },
    { bodyId: 9, segmentEntityId: 501, curveType: "Line", lengthMm: 10, linear: true, circular: false },
  ), /non-linear, non-circular/i);
});

test("measures exact distance to a finite circular B-Rep arc and rejects unsupported metadata", () => {
  const state = measurementState();
  const arc = state.bodies[0]!.edges.find((candidate) => candidate.id === "arc")!;
  arc.lengthMm = 5 * Math.PI;
  arc.circleGeometry = {
    centerMm: [0, 0, 0], radiusMm: 5, normal: [0, 0, 1], reference: [1, 0, 0],
    startMm: [5, 0, 0], midpointMm: [0, 5, 0], endMm: [-5, 0, 0],
  };
  const aboveMidpoint = measurePointToCircularEdge(state, { type: "coordinates", pointMm: [0, 10, 3] }, { bodyId: 7, edgeId: "arc" }, state.revision);
  assert.ok(Math.abs(aboveMidpoint.supportingCircleDistanceMm - Math.sqrt(34)) < 1e-12);
  assert.ok(Math.abs(aboveMidpoint.finiteArcDistanceMm - Math.sqrt(34)) < 1e-12);
  aboveMidpoint.closestPointMm.forEach((value, axis) => assert.ok(Math.abs(value - [0, 5, 0][axis]!) < 1e-12));
  assert.equal(aboveMidpoint.normalizedArcParameter, 0.5);
  assert.equal(aboveMidpoint.clampedToEndpoint, false);

  const belowArc = measurePointToCircularEdge(state, { type: "coordinates", pointMm: [6, -1, 0] }, { bodyId: 7, edgeId: "arc" }, state.revision);
  assert.equal(belowArc.clampedToEndpoint, true);
  assert.equal(belowArc.normalizedArcParameter, null);
  assert.ok(Math.abs(belowArc.finiteArcDistanceMm - Math.sqrt(2)) < 1e-12);
  assert.deepEqual(belowArc.closestPointMm, [5, 0, 0]);

  const majorClockwiseArc = state.bodies[0]!.edges.find((candidate) => candidate.id === "y-edge")!;
  const diagonal = Math.sqrt(12.5);
  majorClockwiseArc.circle = true;
  majorClockwiseArc.line = false;
  majorClockwiseArc.lengthMm = 7.5 * Math.PI;
  majorClockwiseArc.circleGeometry = {
    centerMm: [0, 0, 0], radiusMm: 5, normal: [0, 0, 1], reference: [1, 0, 0],
    startMm: [5, 0, 0], midpointMm: [-diagonal, -diagonal, 0], endMm: [0, 5, 0],
  };
  const majorMidpoint = measurePointToCircularEdge(state, { type: "coordinates", pointMm: [-diagonal, -diagonal, 1] }, { bodyId: 7, edgeId: "y-edge" }, state.revision);
  assert.ok(Math.abs(majorMidpoint.finiteArcDistanceMm - 1) < 1e-12);
  assert.ok(Math.abs(majorMidpoint.normalizedArcParameter! - 0.5) < 1e-12);

  const fullCircle = state.bodies[0]!.edges.find((candidate) => candidate.id === "x-edge")!;
  fullCircle.circle = true;
  fullCircle.line = false;
  fullCircle.lengthMm = 4 * Math.PI;
  fullCircle.circleGeometry = {
    centerMm: [20, 0, 0], radiusMm: 2, normal: [0, 0, 1], reference: [1, 0, 0],
    startMm: [22, 0, 0], midpointMm: [18, 0, 0], endMm: [22, 0, 0],
  };
  const onAxis = measurePointToCircularEdge(state, { type: "coordinates", pointMm: [20, 0, 4] }, { bodyId: 7, edgeId: "x-edge" }, state.revision);
  assert.ok(Math.abs(onAxis.finiteArcDistanceMm - Math.sqrt(20)) < 1e-12);
  assert.equal(onAxis.normalizedArcParameter, null);

  const noCircleData = structuredClone(state);
  delete noCircleData.bodies[0]!.edges.find((candidate) => candidate.id === "arc")!.circleGeometry;
  assert.throws(() => measurePointToCircularEdge(noCircleData, { type: "coordinates", pointMm: [0, 0, 0] }, { bodyId: 7, edgeId: "arc" }, state.revision), /exact circular B-Rep geometry/i);
  assert.throws(() => measurePointToCircularEdge(state, { type: "coordinates", pointMm: [0, 0, 0] }, { bodyId: 7, edgeId: "arc" }, "old-revision"), /stale reference/i);
});

test("measures a native circular Wire segment through its revision-bound segment ID", () => {
  const state = measurementState();
  const body = state.bodies[0]!;
  body.type = "Wire";
  body.edges = [];
  const segment = {
    segmentEntityId: 701,
    lengthMm: 4 * Math.PI,
    circleGeometry: {
      centerMm: [0, 0, 0] as [number, number, number],
      radiusMm: 2,
      normal: [0, 0, 1] as [number, number, number],
      reference: [1, 0, 0] as [number, number, number],
      startMm: [2, 0, 0] as [number, number, number],
      midpointMm: [-2, 0, 0] as [number, number, number],
      endMm: [2, 0, 0] as [number, number, number],
    },
  };
  const result = measurePointToCircularEdge(
    state,
    { type: "coordinates", pointMm: [4, 0, 3] },
    { bodyId: 7, segmentEntityId: segment.segmentEntityId },
    state.revision,
    segment,
  );
  assert.deepEqual(result.edge, {
    bodyId: 7,
    segmentEntityId: 701,
    centerMm: [0, 0, 0],
    radiusMm: 2,
    normal: [0, 0, 1],
    reference: [1, 0, 0],
    startAngleRadians: 0,
    sweepRadians: 2 * Math.PI,
    lengthMm: 4 * Math.PI,
    fullCircle: true,
  });
  assert.ok(Math.abs(result.supportingCircleDistanceMm - Math.sqrt(13)) < 1e-12);
  assert.ok(Math.abs(result.finiteArcDistanceMm - Math.sqrt(13)) < 1e-12);
  assert.deepEqual(result.closestPointMm, [2, 0, 0]);
  assert.throws(() => measurePointToCircularEdge(state, { type: "coordinates", pointMm: [4, 0, 3] }, { bodyId: 7, segmentEntityId: 702 }, state.revision, segment), /metadata is unavailable or stale/i);
  assert.throws(() => measurePointToCircularEdge(state, { type: "coordinates", pointMm: [4, 0, 3] }, { bodyId: 8, segmentEntityId: 701 }, state.revision, segment), /current Wire/i);
});

test("measures exact distance to a trimmed planar polygon face with a hole", () => {
  const state = measurementState();
  const body = state.bodies[0]!;
  const face = body.faces.find((candidate) => candidate.id === "top")!;
  face.centerMm = [5, 5, 0];
  face.normal = [0, 0, 1];
  face.edgeIds = [];
  const loops = [
    { points: [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]] as [number, number, number][], vertexStart: 201, edgePrefix: "outer" },
    { points: [[3, 3, 0], [7, 3, 0], [7, 7, 0], [3, 7, 0]] as [number, number, number][], vertexStart: 301, edgePrefix: "hole" },
  ];
  for (const loop of loops) {
    const vertices = loop.points.map((positionMm, index) => ({
      id: loop.vertexStart + index,
      positionMm,
      edgeIds: [] as string[],
      faceIds: ["top"],
    }));
    body.vertices!.push(...vertices);
    loop.points.forEach((centerPoint, index) => {
      const nextIndex = (index + 1) % loop.points.length;
      const nextPoint = loop.points[nextIndex]!;
      const delta = nextPoint.map((value, axis) => value - centerPoint[axis]!) as [number, number, number];
      const lengthMm = Math.hypot(...delta);
      const edgeId = `${loop.edgePrefix}-${index}`;
      const vertexIds = [vertices[index]!.id, vertices[nextIndex]!.id];
      body.edges.push({
        id: edgeId,
        curveType: "Line",
        line: true,
        circle: false,
        lengthMm,
        centerMm: centerPoint.map((value, axis) => value + delta[axis]! / 2) as [number, number, number],
        tangent: delta.map((value) => value / lengthMm) as [number, number, number],
        boundsMm: { min: centerPoint, max: nextPoint },
        faceIds: ["top"],
        vertexIds,
      });
      face.edgeIds.push(edgeId);
      vertices[index]!.edgeIds.push(edgeId);
      vertices[nextIndex]!.edgeIds.push(edgeId);
    });
  }
  const circularHoleEdgeId = "circle-hole";
  body.vertices!.push({ id: 401, positionMm: [9, 8, 0], edgeIds: [circularHoleEdgeId], faceIds: ["top"] });
  body.edges.push({
    id: circularHoleEdgeId,
    curveType: "Circle",
    line: false,
    circle: true,
    lengthMm: 2 * Math.PI,
    centerMm: [8, 8, 0],
    tangent: [0, 1, 0],
    boundsMm: { min: [7, 7, 0], max: [9, 9, 0] },
    faceIds: ["top"],
    vertexIds: [401],
    circleGeometry: {
      centerMm: [8, 8, 0], radiusMm: 1, normal: [0, 0, 1], reference: [1, 0, 0],
      startMm: [9, 8, 0], midpointMm: [7, 8, 0], endMm: [9, 8, 0],
    },
  });
  face.edgeIds.push(circularHoleEdgeId);

  const interior = measurePointToPlanarFace(state, { type: "coordinates", pointMm: [1, 1, 3] }, { bodyId: 7, faceId: "top" }, state.revision);
  assert.equal(interior.minimumDistanceMm, 3);
  assert.equal(interior.signedPlaneDistanceMm, 3);
  assert.deepEqual(interior.closestPointMm, [1, 1, 0]);
  assert.deepEqual(interior.closestFeature, { type: "face-interior", faceId: "top" });

  const outside = measurePointToPlanarFace(state, { type: "coordinates", pointMm: [15, 5, 0] }, { bodyId: 7, faceId: "top" }, state.revision);
  assert.equal(outside.minimumDistanceMm, 5);
  assert.deepEqual(outside.closestPointMm, [10, 5, 0]);
  assert.deepEqual(outside.closestFeature, { type: "boundary-edge", edgeId: "outer-1" });

  const inHole = measurePointToPlanarFace(state, { type: "coordinates", pointMm: [5, 5, 2] }, { bodyId: 7, faceId: "top" }, state.revision);
  assert.equal(inHole.minimumDistanceMm, Math.sqrt(8));
  assert.deepEqual(inHole.closestPointMm, [5, 3, 0]);
  assert.deepEqual(inHole.closestFeature, { type: "boundary-edge", edgeId: "hole-0" });

  const inCircularHole = measurePointToPlanarFace(state, { type: "coordinates", pointMm: [8, 8, 2] }, { bodyId: 7, faceId: "top" }, state.revision);
  assert.ok(Math.abs(inCircularHole.minimumDistanceMm - Math.sqrt(5)) < 1e-12);
  assert.deepEqual(inCircularHole.closestPointMm, [9, 8, 0]);
  assert.deepEqual(inCircularHole.closestFeature, { type: "boundary-edge", edgeId: circularHoleEdgeId });

  const circularFaceState = structuredClone(state);
  circularFaceState.bodies[0]!.faces.find((candidate) => candidate.id === "top")!.edgeIds = [circularHoleEdgeId];
  circularFaceState.bodies[0]!.faces.find((candidate) => candidate.id === "top")!.centerMm = [8, 8, 0];
  circularFaceState.bodies[0]!.vertices = [];
  circularFaceState.bodies[0]!.edges.find((edge) => edge.id === circularHoleEdgeId)!.vertexIds = [];
  const outsideCircularFace = measurePointToPlanarFace(circularFaceState, { type: "coordinates", pointMm: [11, 8, 2] }, { bodyId: 7, faceId: "top" }, state.revision);
  assert.ok(Math.abs(outsideCircularFace.minimumDistanceMm - Math.sqrt(8)) < 1e-12);
  assert.deepEqual(outsideCircularFace.closestPointMm, [9, 8, 0]);
  assert.deepEqual(outsideCircularFace.closestFeature, { type: "boundary-edge", edgeId: circularHoleEdgeId });

  assert.throws(() => measurePointToPlanarFace(state, { type: "coordinates", pointMm: [0, 0, 0] }, { bodyId: 7, faceId: "cylinder" }, state.revision), /must be planar/i);
  assert.throws(() => measurePointToPlanarFace(state, { type: "coordinates", pointMm: [0, 0, 0] }, { bodyId: 7, faceId: "top" }, "old-revision"), /stale reference/i);
  const curvedBoundaryState = structuredClone(state);
  curvedBoundaryState.bodies[0]!.edges.find((edge) => edge.id === "outer-0")!.line = false;
  assert.throws(() => measurePointToPlanarFace(curvedBoundaryState, { type: "coordinates", pointMm: [1, 1, 3] }, { bodyId: 7, faceId: "top" }, state.revision), /linear edges and exact circular arcs/i);
  const openBoundaryState = structuredClone(state);
  openBoundaryState.bodies[0]!.faces.find((candidate) => candidate.id === "top")!.edgeIds.splice(0, 1);
  assert.throws(() => measurePointToPlanarFace(openBoundaryState, { type: "coordinates", pointMm: [1, 1, 3] }, { bodyId: 7, faceId: "top" }, state.revision), /closed linear loops/i);
  const partialCircularBoundaryState = structuredClone(state);
  partialCircularBoundaryState.bodies[0]!.edges.find((edge) => edge.id === circularHoleEdgeId)!.lengthMm = Math.PI;
  assert.throws(() => measurePointToPlanarFace(partialCircularBoundaryState, { type: "coordinates", pointMm: [8, 8, 2] }, { bodyId: 7, faceId: "top" }, state.revision), /circular arc trim does not match/i);
});

test("measures exact distance to a planar face bounded by lines and circular arcs", () => {
  const state = measurementState();
  const body = state.bodies[0]!;
  const face = body.faces.find((candidate) => candidate.id === "top")!;
  face.centerMm = [5, 5, 0];
  face.normal = [0, 0, 1];
  face.edgeIds = [];

  const vertices = [
    [2, 0, 0], [8, 0, 0], [10, 2, 0], [10, 8, 0],
    [8, 10, 0], [2, 10, 0], [0, 8, 0], [0, 2, 0],
  ] as [number, number, number][];
  const vertexRecords = vertices.map((positionMm, index) => ({ id: 501 + index, positionMm, edgeIds: [] as string[], faceIds: ["top"] }));
  body.vertices!.push(...vertexRecords);
  const addLinear = (edgeIndex: number, first: number, second: number) => {
    const start = vertices[first]!;
    const end = vertices[second]!;
    const delta = end.map((value, axis) => value - start[axis]!) as [number, number, number];
    const lengthMm = Math.hypot(...delta);
    const edgeId = `rounded-line-${edgeIndex}`;
    body.edges.push({
      id: edgeId, curveType: "Line", line: true, circle: false, lengthMm,
      centerMm: start.map((value, axis) => (value + end[axis]!) / 2) as [number, number, number],
      tangent: delta.map((value) => value / lengthMm) as [number, number, number],
      boundsMm: { min: start, max: end }, faceIds: ["top"], vertexIds: [vertexRecords[first]!.id, vertexRecords[second]!.id],
    });
    face.edgeIds.push(edgeId);
    vertexRecords[first]!.edgeIds.push(edgeId);
    vertexRecords[second]!.edgeIds.push(edgeId);
  };
  const addArc = (edgeIndex: number, first: number, second: number, center: [number, number, number], startAngle: number, sweep: number) => {
    const edgeId = `rounded-arc-${edgeIndex}`;
    const pointAt = (angle: number): [number, number, number] => [center[0] + 2 * Math.cos(angle), center[1] + 2 * Math.sin(angle), 0];
    const startMm = pointAt(startAngle);
    const midpointMm = pointAt(startAngle + sweep / 2);
    const endMm = pointAt(startAngle + sweep);
    const tangentAngle = startAngle + sweep / 2 + Math.PI / 2;
    const startVertex = vertexRecords[first]!;
    const endVertex = vertexRecords[second]!;
    assert.ok(Math.hypot(...startMm.map((value, axis) => value - startVertex.positionMm[axis]!)) < 1e-12);
    assert.ok(Math.hypot(...endMm.map((value, axis) => value - endVertex.positionMm[axis]!)) < 1e-12);
    body.edges.push({
      id: edgeId, curveType: "Circle", line: false, circle: true, lengthMm: 2 * sweep,
      centerMm: midpointMm, tangent: [Math.cos(tangentAngle), Math.sin(tangentAngle), 0],
      boundsMm: { min: [center[0] - 2, center[1] - 2, 0], max: [center[0] + 2, center[1] + 2, 0] },
      faceIds: ["top"], vertexIds: [startVertex.id, endVertex.id],
      circleGeometry: { centerMm: center, radiusMm: 2, normal: [0, 0, 1], reference: [1, 0, 0], startMm, midpointMm, endMm },
    });
    face.edgeIds.push(edgeId);
    startVertex.edgeIds.push(edgeId);
    endVertex.edgeIds.push(edgeId);
  };

  addLinear(0, 0, 1);
  addArc(0, 1, 2, [8, 2, 0], -Math.PI / 2, Math.PI / 2);
  addLinear(1, 2, 3);
  addArc(1, 3, 4, [8, 8, 0], 0, Math.PI / 2);
  addLinear(2, 4, 5);
  addArc(2, 5, 6, [2, 8, 0], Math.PI / 2, Math.PI / 2);
  addLinear(3, 6, 7);
  addArc(3, 7, 0, [2, 2, 0], Math.PI, Math.PI / 2);

  const interior = measurePointToPlanarFace(state, { type: "coordinates", pointMm: [5, 5, 3] }, { bodyId: 7, faceId: "top" }, state.revision);
  assert.equal(interior.minimumDistanceMm, 3);
  assert.deepEqual(interior.closestFeature, { type: "face-interior", faceId: "top" });

  const roundedCorner = measurePointToPlanarFace(state, { type: "coordinates", pointMm: [0, 0, 0] }, { bodyId: 7, faceId: "top" }, state.revision);
  assert.ok(Math.abs(roundedCorner.minimumDistanceMm - (Math.sqrt(8) - 2)) < 1e-9);
  assert.ok(Math.abs(roundedCorner.closestPointMm[0] - (2 - Math.sqrt(2))) < 1e-9);
  assert.ok(Math.abs(roundedCorner.closestPointMm[1] - (2 - Math.sqrt(2))) < 1e-9);
  assert.deepEqual(roundedCorner.closestFeature, { type: "boundary-edge", edgeId: "rounded-arc-3" });

  const reversedEndpointState = structuredClone(state);
  reversedEndpointState.bodies[0]!.edges.find((edge) => edge.id === "rounded-arc-0")!.vertexIds.reverse();
  const reversedEndpoint = measurePointToPlanarFace(reversedEndpointState, { type: "coordinates", pointMm: [0, 0, 0] }, { bodyId: 7, faceId: "top" }, state.revision);
  assert.ok(Math.abs(reversedEndpoint.minimumDistanceMm - roundedCorner.minimumDistanceMm) < 1e-9);
  assert.deepEqual(reversedEndpoint.closestPointMm, roundedCorner.closestPointMm);
  assert.deepEqual(reversedEndpoint.closestFeature, roundedCorner.closestFeature);

  assert.throws(() => measurePointToPlanarFace(state, { type: "coordinates", pointMm: [1, 1, 3] }, { bodyId: 7, faceId: "top" }, "stale-revision"), /stale reference/i);

  const invalidArcState = structuredClone(state);
  invalidArcState.bodies[0]!.edges.find((edge) => edge.id === "rounded-arc-0")!.vertexIds[0] = 501;
  assert.throws(() => measurePointToPlanarFace(invalidArcState, { type: "coordinates", pointMm: [5, 5, 3] }, { bodyId: 7, faceId: "top" }, state.revision), /endpoint vertices do not match native arc trim/i);
});

test("measures a multi-body fastener grip stack from exact planar face pairs", () => {
  const state = measurementState();
  const source = state.bodies[0]!;
  state.bodies.push({
    ...source,
    id: 8,
    versionId: 18,
    name: "Washer",
    boundsMm: { min: [0, 0, 8], max: [10, 10, 9] },
    faceIds: ["washer-bottom", "washer-top"],
    edgeIds: [],
    faces: [
      { ...source.faces[0]!, id: "washer-bottom", centerMm: [5, 5, 8] },
      { ...source.faces[1]!, id: "washer-top", centerMm: [5, 5, 9] },
    ],
    edges: [],
    vertices: [],
  });

  const measured = measureFastenerGripStack(state, [
    { id: "plate", first: { bodyId: 7, faceId: "bottom" }, second: { bodyId: 7, faceId: "top" } },
    { id: "washer", first: { bodyId: 8, faceId: "washer-bottom" }, second: { bodyId: 8, faceId: "washer-top" } },
  ], [0, 0, 1], state.revision);

  assert.equal(measured.measurementSource, "native-brep-planar-faces");
  assert.deepEqual(measured.gripItems, [{ id: "plate", thicknessMm: 8 }, { id: "washer", thicknessMm: 1 }]);
  assert.equal(measured.totalGripMm, 9);
  assert.deepEqual(measured.axis, [0, 0, 1]);
  assert.equal(measured.layers[0]?.bodyVersionId, 17);
  assert.equal(measured.layers[1]?.bodyVersionId, 18);
});

test("rejects invalid fastener grip face pairs before reporting a stack", () => {
  const state = measurementState();
  assert.throws(() => measureFastenerGripStack(state, [
    { id: "plate", first: { bodyId: 7, faceId: "bottom" }, second: { bodyId: 7, faceId: "top" } },
  ], [1, 0, 0], state.revision), /normal must align with the fastener axis/i);
  assert.throws(() => measureFastenerGripStack(state, [
    { id: "plate", first: { bodyId: 7, faceId: "bottom" }, second: { bodyId: 8, faceId: "top" } },
  ], [0, 0, 1], state.revision), /same body/i);
  assert.throws(() => measureFastenerGripStack(state, [
    { id: "plate", first: { bodyId: 7, faceId: "bottom" }, second: { bodyId: 7, faceId: "top" } },
    { id: "plate-again", first: { bodyId: 7, faceId: "top" }, second: { bodyId: 7, faceId: "bottom" } },
  ], [0, 0, 1], state.revision), /face pairs must be unique/i);
  assert.throws(() => measureFastenerGripStack(state, [
    { id: "plate", first: { bodyId: 7, faceId: "bottom" }, second: { bodyId: 7, faceId: "top" } },
  ], [0, 0, 1], "old-revision"), /stale reference/i);
});

test("rejects stale, missing, and incompatible measurement references", () => {
  const state = measurementState();

  assert.throws(() => measurePointDistance(
    state,
    { type: "vertex", bodyId: 7, vertexId: 999 },
    { type: "coordinates", pointMm: [0, 0, 0] },
    state.revision,
  ), /unknown current vertex/i);
  assert.throws(() => measurePointDistance(
    state,
    { type: "coordinates", pointMm: [0, 0, 0] },
    { type: "coordinates", pointMm: [0, 0, 0] },
    "old-revision",
  ), /stale reference/i);
  assert.throws(() => measurePlanarFaces(
    state,
    { bodyId: 7, faceId: "top" },
    { bodyId: 7, faceId: "cylinder" },
    state.revision,
  ), /must be planar/i);
  assert.throws(() => measureLinearEdges(
    state,
    { bodyId: 7, edgeId: "x-edge" },
    { bodyId: 7, edgeId: "arc" },
    state.revision,
  ), /must be linear/i);
});

function measurementState(): RuntimeState {
  const face = (
    id: string,
    centerMm: [number, number, number],
    normal: [number, number, number],
    planar = true,
  ): RuntimeState["bodies"][number]["faces"][number] => ({
    id,
    surfaceType: planar ? "Plane" : "Cylinder",
    planar,
    centerMm,
    normal,
    radiusMm: planar ? null : 3,
    blendRadiusMm: null,
    axisOriginMm: planar ? null : [0, 0, 0],
    axisDirection: planar ? null : [0, 0, 1],
    boundsMm: { min: [0, 0, 0], max: [10, 10, 10] },
    edgeIds: [],
  });
  const edge = (
    id: string,
    centerMm: [number, number, number],
    tangent: [number, number, number],
    line = true,
  ): RuntimeState["bodies"][number]["edges"][number] => ({
    id,
    curveType: line ? "Line" : "Circle",
    line,
    circle: !line,
    lengthMm: 10,
    centerMm,
    tangent,
    boundsMm: { min: [0, 0, 0], max: [10, 10, 10] },
    faceIds: [],
    vertexIds: [],
  });
  return {
    targetId: "window-1",
    title: "Untitled - Plasticity",
    documentToken: "document-1",
    revision: "revision-1",
    dbVersion: 1,
    undoDepth: 0,
    redoDepth: 0,
    construction: { planes: [], activePlaneId: null, planeStateToken: "p", viewStateToken: "v" },
    regions: [],
    bodies: [{
      id: 7,
      versionId: 17,
      type: "Solid",
      name: "Measured part",
      boundsMm: { min: [0, 0, 0], max: [10, 10, 8] },
      faceIds: ["bottom", "top", "side", "cylinder"],
      edgeIds: ["x-edge", "x-edge-offset", "y-edge", "arc"],
      faces: [
        face("bottom", [5, 5, 0], [0, 0, 1]),
        face("top", [5, 5, 8], [0, 0, -1]),
        face("side", [0, 5, 4], [1, 0, 0]),
        face("cylinder", [5, 5, 4], [1, 0, 0], false),
      ],
      edges: [
        edge("x-edge", [5, 0, 0], [1, 0, 0]),
        edge("x-edge-offset", [5, 3, 0], [-1, 0, 0]),
        edge("y-edge", [0, 0, 2], [0, 1, 0]),
        edge("arc", [5, 5, 8], [0, 1, 0], false),
      ],
      vertices: [
        { id: 101, positionMm: [0, 0, 0], edgeIds: ["x-edge"], faceIds: ["bottom"] },
        { id: 102, positionMm: [3, 4, 12], edgeIds: [], faceIds: [] },
      ],
    }],
  };
}

function addRectangleFace(state: RuntimeState, faceId: string, z: number, minX: number, minY: number, maxX: number, maxY: number): RuntimeState["bodies"][number]["faces"][number] {
  const body = state.bodies[0]!;
  const points: Array<[number, number, number]> = [
    [minX, minY, z], [maxX, minY, z], [maxX, maxY, z], [minX, maxY, z],
  ];
  const edgeIds = points.map((_, index) => `${faceId}-edge-${index}`);
  const firstVertexId = Math.max(100, ...body.vertices!.map((vertex) => vertex.id)) + 1;
  const vertexIds = points.map((_, index) => firstVertexId + index);
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index]!;
    const end = points[(index + 1) % points.length]!;
    const delta = end.map((value, axis) => value - start[axis]!) as [number, number, number];
    const lengthMm = Math.hypot(...delta);
    const id = edgeIds[index]!;
    body.edges.push({
      id,
      curveType: "Line",
      line: true,
      circle: false,
      lengthMm,
      centerMm: start.map((value, axis) => (value + end[axis]!) / 2) as [number, number, number],
      tangent: delta.map((value) => value / lengthMm) as [number, number, number],
      boundsMm: {
        min: start.map((value, axis) => Math.min(value, end[axis]!)) as [number, number, number],
        max: start.map((value, axis) => Math.max(value, end[axis]!)) as [number, number, number],
      },
      faceIds: [faceId],
      vertexIds: [vertexIds[index]!, vertexIds[(index + 1) % points.length]!],
    });
    body.vertices!.push({
      id: vertexIds[index]!,
      positionMm: start,
      edgeIds: [id, edgeIds[(index + points.length - 1) % points.length]!],
      faceIds: [faceId],
    });
  }
  body.edgeIds.push(...edgeIds);
  body.faces.push({
    id: faceId,
    surfaceType: "Plane",
    planar: true,
    centerMm: [(minX + maxX) / 2, (minY + maxY) / 2, z],
    normal: [0, 0, 1],
    radiusMm: null,
    blendRadiusMm: null,
    axisOriginMm: null,
    axisDirection: null,
    boundsMm: { min: [minX, minY, z], max: [maxX, maxY, z] },
    edgeIds,
  });
  body.faceIds.push(faceId);
  return body.faces.at(-1)!;
}

function addPolygonFace(state: RuntimeState, faceId: string, points: Array<[number, number, number]>): RuntimeState["bodies"][number]["faces"][number] {
  const body = state.bodies[0]!;
  const firstVertexId = Math.max(100, ...body.vertices!.map((vertex) => vertex.id)) + 1;
  const vertexIds = points.map((_, index) => firstVertexId + index);
  const edgeIds = points.map((_, index) => `${faceId}-edge-${index}`);
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index]!;
    const end = points[(index + 1) % points.length]!;
    const delta = end.map((value, axis) => value - start[axis]!) as [number, number, number];
    const lengthMm = Math.hypot(...delta);
    const id = edgeIds[index]!;
    body.edges.push({
      id, curveType: "Line", line: true, circle: false, lengthMm,
      centerMm: start.map((value, axis) => (value + end[axis]!) / 2) as [number, number, number],
      tangent: delta.map((value) => value / lengthMm) as [number, number, number],
      boundsMm: { min: start.map((value, axis) => Math.min(value, end[axis]!)) as [number, number, number], max: start.map((value, axis) => Math.max(value, end[axis]!)) as [number, number, number] },
      faceIds: [faceId], vertexIds: [vertexIds[index]!, vertexIds[(index + 1) % points.length]!],
    });
    body.vertices!.push({ id: vertexIds[index]!, positionMm: start, edgeIds: [id, edgeIds[(index + points.length - 1) % points.length]!], faceIds: [faceId] });
  }
  const centerMm = points.reduce((center, point) => center.map((value, axis) => value + point[axis]! / points.length) as [number, number, number], [0, 0, 0] as [number, number, number]);
  const first = points[1]!.map((value, axis) => value - points[0]![axis]!) as [number, number, number];
  const second = points[2]!.map((value, axis) => value - points[0]![axis]!) as [number, number, number];
  const normal = [first[1] * second[2] - first[2] * second[1], first[2] * second[0] - first[0] * second[2], first[0] * second[1] - first[1] * second[0]] as [number, number, number];
  const normalLength = Math.hypot(...normal);
  const normalizedNormal = normal.map((value) => value / normalLength) as [number, number, number];
  const face = {
    id: faceId, surfaceType: "Plane", planar: true, centerMm, normal: normalizedNormal,
    radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null,
    boundsMm: { min: [0, 0, 0] as [number, number, number], max: [0, 0, 0] as [number, number, number] }, edgeIds,
  } as RuntimeState["bodies"][number]["faces"][number];
  body.faces.push(face);
  body.faceIds.push(faceId);
  body.edgeIds.push(...edgeIds);
  return face;
}

function addRectangleLoop(state: RuntimeState, faceId: string, z: number, minX: number, minY: number, maxX: number, maxY: number): void {
  const body = state.bodies[0]!;
  const face = body.faces.find((candidate) => candidate.id === faceId)!;
  const points: Array<[number, number, number]> = [[minX, minY, z], [maxX, minY, z], [maxX, maxY, z], [minX, maxY, z]];
  const edgeIds = points.map((_, index) => `${faceId}-hole-edge-${index}`);
  const firstVertexId = Math.max(100, ...body.vertices!.map((vertex) => vertex.id)) + 1;
  const vertexIds = points.map((_, index) => firstVertexId + index);
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index]!;
    const end = points[(index + 1) % points.length]!;
    const delta = end.map((value, axis) => value - start[axis]!) as [number, number, number];
    const lengthMm = Math.hypot(...delta);
    const id = edgeIds[index]!;
    body.edges.push({
      id, curveType: "Line", line: true, circle: false, lengthMm,
      centerMm: start.map((value, axis) => (value + end[axis]!) / 2) as [number, number, number],
      tangent: delta.map((value) => value / lengthMm) as [number, number, number],
      boundsMm: { min: start.map((value, axis) => Math.min(value, end[axis]!)) as [number, number, number], max: start.map((value, axis) => Math.max(value, end[axis]!)) as [number, number, number] },
      faceIds: [faceId], vertexIds: [vertexIds[index]!, vertexIds[(index + 1) % points.length]!],
    });
    body.vertices!.push({ id: vertexIds[index]!, positionMm: start, edgeIds: [id, edgeIds[(index + points.length - 1) % points.length]!], faceIds: [faceId] });
  }
  face.edgeIds.push(...edgeIds);
  body.edgeIds.push(...edgeIds);
}

function addFullCircleBoundary(state: RuntimeState, faceId: string, z: number, centerX: number, centerY: number, radiusMm: number): void {
  const body = state.bodies[0]!;
  const face = body.faces.find((candidate) => candidate.id === faceId)!;
  const id = `${faceId}-circle`;
  const centerMm: [number, number, number] = [centerX, centerY, z];
  const startMm: [number, number, number] = [centerX + radiusMm, centerY, z];
  const midpointMm: [number, number, number] = [centerX, centerY + radiusMm, z];
  body.edges.push({
    id,
    curveType: "Circle",
    line: false,
    circle: true,
    lengthMm: 2 * Math.PI * radiusMm,
    centerMm,
    tangent: [0, 1, 0],
    boundsMm: { min: [centerX - radiusMm, centerY - radiusMm, z], max: [centerX + radiusMm, centerY + radiusMm, z] },
    faceIds: [faceId],
    vertexIds: [],
    circleGeometry: { centerMm, radiusMm, normal: [0, 0, 1], reference: [1, 0, 0], startMm, midpointMm, endMm: startMm },
  });
  body.edgeIds.push(id);
  face.edgeIds.push(id);
}

function addCircularFace(state: RuntimeState, faceId: string, z: number, centerX: number, centerY: number, radiusMm: number): void {
  const face = addRectangleFace(state, faceId, z, centerX - radiusMm, centerY - radiusMm, centerX + radiusMm, centerY + radiusMm);
  face.edgeIds = [];
  face.centerMm = [centerX, centerY, z];
  face.boundsMm = { min: [centerX - radiusMm, centerY - radiusMm, z], max: [centerX + radiusMm, centerY + radiusMm, z] };
  addFullCircleBoundary(state, faceId, z, centerX, centerY, radiusMm);
}

function addRoundedRectangleFace(
  state: RuntimeState,
  faceId: string,
  z: number,
  minX: number,
  minY: number,
  width: number,
  height: number,
  radius: number,
): void {
  const body = state.bodies[0]!;
  const firstVertexId = Math.max(100, ...body.vertices!.map((vertex) => vertex.id)) + 1;
  const quarter = Math.PI / 2;
  const segments: Array<{ start: [number, number]; end: [number, number]; center?: [number, number]; startAngle?: number }> = [
    { start: [minX + radius, minY], end: [minX + width - radius, minY] },
    { start: [minX + width - radius, minY], end: [minX + width, minY + radius], center: [minX + width - radius, minY + radius], startAngle: -quarter },
    { start: [minX + width, minY + radius], end: [minX + width, minY + height - radius] },
    { start: [minX + width, minY + height - radius], end: [minX + width - radius, minY + height], center: [minX + width - radius, minY + height - radius], startAngle: 0 },
    { start: [minX + width - radius, minY + height], end: [minX + radius, minY + height] },
    { start: [minX + radius, minY + height], end: [minX, minY + height - radius], center: [minX + radius, minY + height - radius], startAngle: quarter },
    { start: [minX, minY + height - radius], end: [minX, minY + radius] },
    { start: [minX, minY + radius], end: [minX + radius, minY], center: [minX + radius, minY + radius], startAngle: Math.PI },
  ];
  const vertexIds = segments.map((_, index) => firstVertexId + index);
  const edgeIds: string[] = [];
  const positions = (point: [number, number]): [number, number, number] => [point[0], point[1], z];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const id = `${faceId}-edge-${index}`;
    const startMm = positions(segment.start);
    const endMm = positions(segment.end);
    const centerMm = segment.center ? positions(segment.center) : undefined;
    const midpointAngle = segment.startAngle === undefined ? 0 : segment.startAngle + quarter / 2;
    const midpointMm = centerMm && segment.startAngle !== undefined
      ? [centerMm[0] + radius * Math.cos(midpointAngle), centerMm[1] + radius * Math.sin(midpointAngle), z] as [number, number, number]
      : undefined;
    const delta = [endMm[0] - startMm[0], endMm[1] - startMm[1], endMm[2] - startMm[2]] as [number, number, number];
    const lengthMm = segment.center ? radius * quarter : Math.hypot(...delta);
    const bounds = [startMm, endMm, ...(midpointMm ? [midpointMm] : [])];
    body.edges.push({
      id,
      curveType: segment.center ? "Circle" : "Line",
      line: !segment.center,
      circle: Boolean(segment.center),
      lengthMm,
      centerMm: segment.center && midpointMm ? midpointMm : [(startMm[0] + endMm[0]) / 2, (startMm[1] + endMm[1]) / 2, z],
      tangent: segment.center && midpointMm
        ? [-Math.sin(midpointAngle), Math.cos(midpointAngle), 0]
        : delta.map((value) => value / lengthMm) as [number, number, number],
      boundsMm: {
        min: [Math.min(...bounds.map((point) => point[0])), Math.min(...bounds.map((point) => point[1])), z],
        max: [Math.max(...bounds.map((point) => point[0])), Math.max(...bounds.map((point) => point[1])), z],
      },
      faceIds: [faceId],
      vertexIds: [vertexIds[index]!, vertexIds[(index + 1) % segments.length]!],
      ...(centerMm && segment.center && segment.startAngle !== undefined ? {
        circleGeometry: {
          centerMm,
          radiusMm: radius,
          normal: [0, 0, 1] as [number, number, number],
          reference: [1, 0, 0] as [number, number, number],
          startMm,
          midpointMm: midpointMm!,
          endMm,
        },
      } : {}),
    });
    body.vertices!.push({
      id: vertexIds[index]!,
      positionMm: startMm,
      edgeIds: [id, `${faceId}-edge-${(index + segments.length - 1) % segments.length}`],
      faceIds: [faceId],
    });
    edgeIds.push(id);
  }
  body.edgeIds.push(...edgeIds);
  body.faces.push({
    id: faceId,
    surfaceType: "Plane",
    planar: true,
    centerMm: [minX + width / 2, minY + height / 2, z],
    normal: [0, 0, 1],
    radiusMm: null,
    blendRadiusMm: null,
    axisOriginMm: null,
    axisDirection: null,
    boundsMm: { min: [minX, minY, z], max: [minX + width, minY + height, z] },
    edgeIds,
  });
  body.faceIds.push(faceId);
}
