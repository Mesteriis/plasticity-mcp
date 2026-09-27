import assert from "node:assert/strict";
import { test } from "node:test";

import type { RuntimeState } from "./runtime.ts";
import { DatumRegistry } from "./references.ts";
import { findEdges, findFaces, resolveAxis, resolvePlaneFrame, resolvePoint } from "./semantic.ts";

const state: RuntimeState = {
  targetId: "window-1",
  title: "Part - Plasticity",
  documentToken: "doc-1",
  revision: "r1",
  dbVersion: 1,
  undoDepth: 0,
  redoDepth: 0,
  regions: [],
  construction: {
    planes: [],
    activePlaneId: "standard:top",
    planeStateToken: "planes:empty",
    viewStateToken: "workplane:standard:top",
  },
  bodies: [{
    id: 7,
    versionId: 9,
    type: "Solid",
    name: "Bracket",
    boundsMm: { min: [0, 0, 0], max: [80, 40, 8] },
    faceIds: ["top", "hole"],
    edgeIds: ["vertical", "rim"],
    faces: [
      { id: "top", surfaceType: "Plane", planar: true, centerMm: [40, 20, 8], normal: [0, 0, 1], radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: [0, 0, 8], max: [80, 40, 8] }, edgeIds: ["rim"] },
      { id: "hole", surfaceType: "Cylinder", planar: false, centerMm: [10, 20, 4], normal: [1, 0, 0], radiusMm: 3, blendRadiusMm: null, axisOriginMm: [10, 20, 0], axisDirection: [0, 0, 4], boundsMm: { min: [7, 17, 0], max: [13, 23, 8] }, edgeIds: ["rim"] },
    ],
    edges: [
      { id: "vertical", curveType: "Line", line: true, circle: false, lengthMm: 8, centerMm: [0, 0, 4], tangent: [0, 0, -1], boundsMm: { min: [0, 0, 0], max: [0, 0, 8] }, faceIds: ["top"], vertexIds: [1, 2] },
      { id: "rim", curveType: "Circle", line: false, circle: true, lengthMm: 18.8496, centerMm: [10, 20, 8], tangent: [0, 1, 0], boundsMm: { min: [7, 17, 8], max: [13, 23, 8] }, faceIds: ["top", "hole"], vertexIds: [] },
    ],
  }],
};

test("finds a cylindrical face by native radius and approximate center", () => {
  const matches = findFaces(state, {
    surfaceTypes: ["cylinder"],
    radiusMm: { value: 3.005, tolerance: 0.01 },
    center: { pointMm: [10, 20, 4.02], toleranceMm: 0.05 },
  });

  assert.deepEqual(matches.map((match) => match.id), ["hole"]);
});

test("finds unoriented vertical edges despite opposite tangent direction", () => {
  const matches = findEdges(state, {
    line: true,
    direction: { vector: [0, 0, 1], toleranceDeg: 0.1 },
    lengthMm: { value: 8, tolerance: 0.01 },
  });

  assert.deepEqual(matches.map((match) => match.id), ["vertical"]);
});

test("treats face normals as oriented by default", () => {
  const matches = findFaces(state, {
    planar: true,
    normal: { vector: [0, 0, -1], toleranceDeg: 0.1 },
  });

  assert.deepEqual(matches, []);
});

test("resolves exact face centers and edge midpoints within the selected body", () => {
  assert.deepEqual(resolvePoint(state, { type: "face-center", bodyId: 7, faceId: "top" }), {
    status: "resolved",
    value: [40, 20, 8],
  });
  assert.deepEqual(resolvePoint(state, { type: "edge-midpoint", bodyId: 7, edgeId: "vertical" }), {
    status: "resolved",
    value: [0, 0, 4],
  });
  assert.equal(resolvePoint(state, { type: "face-center", bodyId: 8, faceId: "top" }).status, "unresolved");
  assert.equal(resolvePoint(state, { type: "edge-midpoint", bodyId: 7, edgeId: "missing" }).status, "unresolved");
});

test("normalizes linear-edge axes and reads cylindrical axes from exact surface data", () => {
  const registry = syncedRegistry();
  assert.deepEqual(resolveAxis(state, { type: "linear-edge", bodyId: 7, edgeId: "vertical" }, registry), {
    status: "resolved",
    value: { originMm: [0, 0, 4], direction: [0, 0, -1] },
  });
  assert.deepEqual(resolveAxis(state, { type: "cylindrical-face", bodyId: 7, faceId: "hole" }, registry), {
    status: "resolved",
    value: { originMm: [10, 20, 0], direction: [0, 0, 1] },
  });
  assert.equal(resolveAxis(state, { type: "linear-edge", bodyId: 7, edgeId: "rim" }, registry).status, "unresolved");
  assert.equal(resolveAxis(state, { type: "cylindrical-face", bodyId: 7, faceId: "top" }, registry).status, "unresolved");
});

test("resolves planar-face planes and rejects non-planar faces", () => {
  const registry = syncedRegistry();
  assert.deepEqual(resolvePlaneFrame(state, { type: "planar-face", bodyId: 7, faceId: "top", offsetMm: 2 }, registry), {
    status: "resolved",
    value: { originMm: [40, 20, 10], normal: [0, 0, 1], xDirection: [1, 0, 0], yDirection: [0, 1, 0] },
  });
  assert.equal(resolvePlaneFrame(state, { type: "planar-face", bodyId: 7, faceId: "hole", offsetMm: 0 }, registry).status, "unresolved");
});

test("returns ambiguous when a topology ID appears more than once in the selected body", () => {
  const duplicate: RuntimeState = structuredClone(state);
  duplicate.bodies[0]!.faces.push(structuredClone(duplicate.bodies[0]!.faces[0]!));
  duplicate.bodies[0]!.edges.push(structuredClone(duplicate.bodies[0]!.edges[0]!));
  assert.deepEqual(resolvePoint(duplicate, { type: "face-center", bodyId: 7, faceId: "top" }), { status: "ambiguous", matches: 2 });
  assert.deepEqual(resolveAxis(duplicate, { type: "linear-edge", bodyId: 7, edgeId: "vertical" }, syncedRegistry()), { status: "ambiguous", matches: 2 });
});

test("builds two-point axes and three-point planes from current datum identities", () => {
  const registry = syncedRegistry();
  const first = registry.addPoint({ type: "coordinates", pointMm: [0, 0, 0] }, [0, 0, 0]);
  const second = registry.addPoint({ type: "coordinates", pointMm: [0, 0, 5] }, [0, 0, 5]);
  const third = registry.addPoint({ type: "coordinates", pointMm: [5, 0, 0] }, [5, 0, 0]);
  assert.deepEqual(resolveAxis(state, { type: "two-points", firstId: first.id, secondId: second.id }, registry), {
    status: "resolved",
    value: { originMm: [0, 0, 0], direction: [0, 0, 1] },
  });
  assert.equal(resolvePlaneFrame(state, { type: "three-points", firstId: first.id, secondId: third.id, thirdId: second.id }, registry).status, "resolved");
});

function syncedRegistry(): DatumRegistry {
  const registry = new DatumRegistry("session-1");
  registry.sync(state);
  return registry;
}
