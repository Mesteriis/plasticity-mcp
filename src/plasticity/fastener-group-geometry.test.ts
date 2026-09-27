import assert from "node:assert/strict";
import test from "node:test";

import { inspectFastenerGroupGeometry } from "./fastener-group-geometry.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";

test("reads exact fastener centers and diameters from selected cylindrical B-Rep faces", async () => {
  const state = groupState("r1");
  const runtime = { async getState() { return state; } } as unknown as PlasticityRuntime;
  const result = await inspectFastenerGroupGeometry(runtime, {
    bodyId: 7,
    cylindricalFaceIds: ["hole-a", "hole-b", "hole-c", "hole-d"],
    frame: { originMm: [20, 10, 8], normal: [0, 0, 2], xDirection: [3, 0, 0] },
    revision: "r1",
  }, "session-1");

  assert.equal(result.status, "verified");
  assert.deepEqual(result.frame, {
    originMm: [20, 10, 8],
    normal: [0, 0, 1],
    xDirection: [1, 0, 0],
    yDirection: [0, 1, 0],
  });
  assert.deepEqual(result.fasteners, [
    { id: "hole-a", faceId: "hole-a", centerMm: [0, 0, 8], xMm: -20, yMm: -10, diameterMm: 6, axisDirection: [0, 0, 1] },
    { id: "hole-b", faceId: "hole-b", centerMm: [40, 0, 8], xMm: 20, yMm: -10, diameterMm: 6, axisDirection: [0, 0, -1] },
    { id: "hole-c", faceId: "hole-c", centerMm: [0, 20, 8], xMm: -20, yMm: 10, diameterMm: 6, axisDirection: [0, 0, 1] },
    { id: "hole-d", faceId: "hole-d", centerMm: [40, 20, 8], xMm: 20, yMm: 10, diameterMm: 6, axisDirection: [0, 0, 1] },
  ]);
  assert.equal(result.binding.documentToken, "doc-1");
  assert.equal(result.binding.revision, "r1");
  assert.match(result.binding.topologySignature, /^[a-f0-9]{64}$/u);
  assert.equal(result.evidence?.length, 12);
  assert.deepEqual(result.assignments, {
    "fasteners.0.xMm": "fastener-hole-a-x",
    "fasteners.0.yMm": "fastener-hole-a-y",
    "fasteners.1.xMm": "fastener-hole-b-x",
    "fasteners.1.yMm": "fastener-hole-b-y",
    "fasteners.2.xMm": "fastener-hole-c-x",
    "fasteners.2.yMm": "fastener-hole-c-y",
    "fasteners.3.xMm": "fastener-hole-d-x",
    "fasteners.3.yMm": "fastener-hole-d-y",
  });
  assert.deepEqual(result.loadDistributionGeometry?.fasteners, [
    { id: "hole-a", xMm: -20, yMm: -10 },
    { id: "hole-b", xMm: 20, yMm: -10 },
    { id: "hole-c", xMm: -20, yMm: 10 },
    { id: "hole-d", xMm: 20, yMm: 10 },
  ]);
  assert.equal(result.loadDistributionGeometry?.binding.topologySignature, result.binding.topologySignature);
});

test("rejects stale references before using topology", async () => {
  let reads = 0;
  const runtime = { async getState() { reads += 1; return groupState("r2"); } } as unknown as PlasticityRuntime;
  const result = await inspectFastenerGroupGeometry(runtime, request(), "session-1");
  assert.equal(result.status, "unsupported");
  assert.deepEqual(result.reasons, ["stale-reference"]);
  assert.equal(reads, 1);
});

test("rejects non-cylindrical, skew and duplicate-axis face selections", async () => {
  const nonCylinder = groupState("r1");
  nonCylinder.bodies[0]!.faces[0]!.surfaceType = "Plane";
  nonCylinder.bodies[0]!.faces[0]!.planar = true;
  let result = await inspect(nonCylinder);
  assert.deepEqual(result.reasons, ["face-hole-a-not-cylindrical"]);

  const skew = groupState("r1");
  skew.bodies[0]!.faces[0]!.axisDirection = [1, 0, 1];
  result = await inspect(skew);
  assert.deepEqual(result.reasons, ["face-hole-a-axis-not-normal-to-frame"]);

  const duplicate = groupState("r1");
  duplicate.bodies[0]!.faces[1]!.axisOriginMm = [0, 0, 0];
  result = await inspect(duplicate);
  assert.deepEqual(result.reasons, ["duplicate-projected-center:hole-a:hole-b"]);
});

test("detects a document change during inspection", async () => {
  let reads = 0;
  const runtime = {
    async getState() {
      reads += 1;
      return groupState(reads === 1 ? "r1" : "r2");
    },
  } as unknown as PlasticityRuntime;
  const result = await inspectFastenerGroupGeometry(runtime, request(), "session-1");
  assert.equal(result.status, "unsupported");
  assert.deepEqual(result.reasons, ["stale-reference"]);
});

test("requires a session and a valid in-plane frame", async () => {
  const runtime = { async getState() { return groupState("r1"); } } as unknown as PlasticityRuntime;
  await assert.rejects(inspectFastenerGroupGeometry(runtime, request(), ""), /session ID/i);
  await assert.rejects(inspectFastenerGroupGeometry(runtime, {
    ...request(),
    frame: { originMm: [0, 0, 0], normal: [0, 0, 1], xDirection: [0, 0, 2] },
  }, "session-1"), /parallel/i);
});

function request() {
  return {
    bodyId: 7,
    cylindricalFaceIds: ["hole-a", "hole-b"],
    frame: { originMm: [20, 10, 8] as [number, number, number], normal: [0, 0, 1] as [number, number, number], xDirection: [1, 0, 0] as [number, number, number] },
    revision: "r1",
  };
}

async function inspect(state: RuntimeState) {
  const runtime = { async getState() { return state; } } as unknown as PlasticityRuntime;
  return await inspectFastenerGroupGeometry(runtime, request(), "session-1");
}

function groupState(revision: string): RuntimeState {
  const locations: Array<[string, [number, number, number], [number, number, number]]> = [
    ["hole-a", [0, 0, 0], [0, 0, 1]],
    ["hole-b", [40, 0, 3], [0, 0, -1]],
    ["hole-c", [0, 20, 0], [0, 0, 1]],
    ["hole-d", [40, 20, 0], [0, 0, 1]],
  ];
  const faces = locations.map(([id, axisOriginMm, axisDirection]) => ({
    id,
    surfaceType: "Cylinder",
    planar: false,
    centerMm: axisOriginMm,
    normal: [1, 0, 0] as [number, number, number],
    radiusMm: 3,
    blendRadiusMm: null,
    axisOriginMm,
    axisDirection,
    boundsMm: { min: [axisOriginMm[0] - 3, axisOriginMm[1] - 3, 0] as [number, number, number], max: [axisOriginMm[0] + 3, axisOriginMm[1] + 3, 8] as [number, number, number] },
    edgeIds: [`${id}-top`, `${id}-bottom`],
  }));
  return {
    targetId: "window-1",
    title: "Untitled - Plasticity",
    documentToken: "doc-1",
    revision,
    dbVersion: 1,
    undoDepth: 0,
    redoDepth: 0,
    construction: { planes: [], activePlaneId: null, planeStateToken: "p", viewStateToken: "v" },
    regions: [],
    bodies: [{
      id: 7,
      versionId: 17,
      type: "Solid",
      name: "Four-hole plate",
      boundsMm: { min: [0, 0, 0], max: [40, 20, 8] },
      faceIds: faces.map((face) => face.id),
      edgeIds: faces.flatMap((face) => face.edgeIds),
      faces,
      edges: [],
    }],
  };
}
