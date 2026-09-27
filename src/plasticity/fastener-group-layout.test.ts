import assert from "node:assert/strict";
import test from "node:test";

import { inspectFastenerGroupLayout } from "./fastener-group-layout.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";
import type { NativeSectionEdge, NativeSectionTopology } from "./section-geometry.ts";

test("checks exact rectangular-plate edge, pitch, ligament and envelope clearances", async () => {
  const result = await inspectFastenerGroupLayout(runtime(), {
    bodyId: 7,
    boundaryFaceId: "top",
    cylindricalFaceIds: ["hole-a", "hole-b"],
    frame: { originMm: [0, 0, 8], normal: [0, 0, 1], xDirection: [1, 0, 0] },
    requirements: {
      basis: "User-approved M5 joint layout criteria",
      minimumCenterToEdgeMm: 9,
      minimumHoleEdgeClearanceMm: 6,
      minimumCenterSpacingMm: 40,
      minimumHoleLigamentMm: 10,
      envelopes: [{ id: "socket-head-and-tool", diameterMm: 12, minimumBoundaryClearanceMm: 3, minimumMutualClearanceMm: 2 }],
    },
    revision: "r1",
  }, "session-1");

  assert.equal(result.status, "verified");
  assert.equal(result.evaluation?.status, "pass");
  assert.equal(result.measurementSource, "native-brep-boundary-and-cylindrical-faces");
  assert.deepEqual(result.plate?.sizeMm, { x: 60, y: 40 });
  assert.equal(result.fasteners?.[0]?.minimumCenterToEdgeMm, 10);
  assert.equal(result.fasteners?.[0]?.minimumHoleEdgeClearanceMm, 7);
  assert.equal(result.fasteners?.[1]?.minimumCenterToEdgeMm, 10);
  assert.equal(result.fasteners?.[1]?.minimumHoleEdgeClearanceMm, 7);
  assert.ok(Math.abs(result.pairs![0]!.centerSpacingMm - Math.hypot(40, 20)) < 1e-10);
  assert.ok(Math.abs(result.pairs![0]!.holeLigamentMm - (Math.hypot(40, 20) - 6)) < 1e-10);
  assert.equal(result.envelopes?.[0]?.minimumBoundaryClearanceMm, 4);
  assert.ok(Math.abs(result.envelopes![0]!.minimumMutualClearanceMm - (Math.hypot(40, 20) - 12)) < 1e-10);
  assert.equal(result.binding.boundaryFaceId, "top");
  assert.match(result.binding.topologySignature, /^[a-f0-9]{64}$/u);
  assert.deepEqual(result.reasons, []);
});

test("fails an explicit mounting envelope criterion without calling geometry fit a strength check", async () => {
  const result = await inspectFastenerGroupLayout(runtime(), {
    bodyId: 7,
    boundaryFaceId: "top",
    cylindricalFaceIds: ["hole-a", "hole-b"],
    frame: { originMm: [0, 0, 8], normal: [0, 0, 1], xDirection: [1, 0, 0] },
    requirements: {
      basis: "Qualified driver access envelope",
      envelopes: [{ id: "driver", diameterMm: 20, minimumBoundaryClearanceMm: 1, minimumMutualClearanceMm: 0 }],
    },
    revision: "r1",
  }, "session-1");

  assert.equal(result.status, "verified");
  assert.equal(result.evaluation?.status, "fail");
  assert.deepEqual([...new Set(result.evaluation?.failures.map((failure) => failure.code))], ["ENVELOPE_BOUNDARY_CLEARANCE"]);
  assert.match(result.checkedScope!, /layout only/i);
});

test("returns measurements rather than pass when no requirements were supplied", async () => {
  const result = await inspectFastenerGroupLayout(runtime(), {
    bodyId: 7,
    boundaryFaceId: "top",
    cylindricalFaceIds: ["hole-a", "hole-b"],
    frame: { originMm: [0, 0, 8], normal: [0, 0, 1], xDirection: [1, 0, 0] },
    revision: "r1",
  }, "session-1");

  assert.equal(result.status, "verified");
  assert.equal(result.evaluation?.status, "measured");
  assert.deepEqual(result.evaluation?.failures, []);
});

test("measures exact multi-hole plate thickness only from a matching opposed B-rep face", async () => {
  const result = await inspectFastenerGroupLayout(runtime(), {
    bodyId: 7,
    boundaryFaceId: "top",
    opposedFaceId: "bottom",
    cylindricalFaceIds: ["hole-a", "hole-b"],
    frame: { originMm: [0, 0, 8], normal: [0, 0, 1], xDirection: [1, 0, 0] },
    revision: "r1",
  }, "session-1");

  assert.deepEqual(result.reasons, []);
  assert.equal(result.status, "verified");
  assert.equal(result.plate?.thicknessMm, 8);
  assert.equal(result.measurementSource, "native-brep-opposed-boundaries-and-cylindrical-faces");
  assert.equal(result.binding.opposedFaceId, "bottom");
  assert.match(result.binding.topologySignature, /^[a-f0-9]{64}$/u);
});

test("rejects mismatched perforated profiles on the opposed plate face", async () => {
  const candidate = runtime();
  const originalRead = candidate.readNative.bind(candidate);
  candidate.readNative = async (...args: Parameters<PlasticityRuntime["readNative"]>) => {
    const topology = await originalRead(...args) as NativeSectionTopology;
    if ((args[2] as Array<{ faceId?: string }> | undefined)?.[0]?.faceId === "bottom") topology.face!.edges.pop();
    return topology as never;
  };
  const result = await inspectFastenerGroupLayout(candidate, {
    bodyId: 7,
    boundaryFaceId: "top",
    opposedFaceId: "bottom",
    cylindricalFaceIds: ["hole-a", "hole-b"],
    frame: { originMm: [0, 0, 8], normal: [0, 0, 1], xDirection: [1, 0, 0] },
    revision: "r1",
  }, "session-1");

  assert.equal(result.status, "unsupported");
  assert.deepEqual(result.reasons, ["opposed-face-profiles-differ"]);
});

test("rejects a rectangular face whose circular boundaries do not match the selected cylindrical faces", async () => {
  const candidate = runtime();
  const originalRead = candidate.readNative.bind(candidate);
  candidate.readNative = async (...args: Parameters<PlasticityRuntime["readNative"]>) => {
    const topology = await originalRead(...args) as NativeSectionTopology;
    topology.face!.edges.push(circle("extra", [30, 10, 8], 2));
    return topology as never;
  };
  const result = await inspectFastenerGroupLayout(candidate, {
    bodyId: 7,
    boundaryFaceId: "top",
    cylindricalFaceIds: ["hole-a", "hole-b"],
    frame: { originMm: [0, 0, 8], normal: [0, 0, 1], xDirection: [1, 0, 0] },
    revision: "r1",
  }, "session-1");

  assert.equal(result.status, "unsupported");
  assert.deepEqual(result.reasons, ["boundary-hole-count-does-not-match-selected-fasteners"]);
});

function runtime(): PlasticityRuntime {
  const state = groupState();
  return {
    async getState() { return structuredClone(state); },
    async readNative(_script: string, _bindings: string[], values: unknown[] = []) { return (values[0] as { faceId?: string } | undefined)?.faceId === "bottom" ? sectionTopology("bottom") : sectionTopology("top"); },
  } as unknown as PlasticityRuntime;
}

function groupState(): RuntimeState {
  const cylinders = [
    cylinder("hole-a", [10, 10, 0]),
    cylinder("hole-b", [50, 30, 0]),
  ];
  return {
    targetId: "window-1",
    title: "Untitled - Plasticity",
    documentToken: "doc-1",
    revision: "r1",
    dbVersion: 1,
    undoDepth: 0,
    redoDepth: 0,
    construction: { planes: [], activePlaneId: null, planeStateToken: "p", viewStateToken: "v" },
    regions: [],
    bodies: [{
      id: 7,
      versionId: 17,
      type: "Solid",
      name: "Two-hole plate",
      boundsMm: { min: [0, 0, 0], max: [60, 40, 8] },
      faceIds: ["top", "bottom", ...cylinders.map((face) => face.id)],
      edgeIds: [],
      faces: [{
        id: "top", surfaceType: "Plane", planar: true, centerMm: [30, 20, 8], normal: [0, 0, 1],
        radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null,
        boundsMm: { min: [0, 0, 8], max: [60, 40, 8] }, edgeIds: [],
      }, {
        id: "bottom", surfaceType: "Plane", planar: true, centerMm: [30, 20, 0], normal: [0, 0, -1],
        radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null,
        boundsMm: { min: [0, 0, 0], max: [60, 40, 0] }, edgeIds: [],
      }, ...cylinders],
      edges: [],
    }],
  };
}

function cylinder(id: string, axisOriginMm: [number, number, number]): RuntimeState["bodies"][number]["faces"][number] {
  return {
    id,
    surfaceType: "Cylinder",
    planar: false,
    centerMm: axisOriginMm,
    normal: [1, 0, 0],
    radiusMm: 3,
    blendRadiusMm: null,
    axisOriginMm,
    axisDirection: [0, 0, 1],
    boundsMm: { min: [axisOriginMm[0] - 3, axisOriginMm[1] - 3, 0], max: [axisOriginMm[0] + 3, axisOriginMm[1] + 3, 8] },
    edgeIds: [],
  };
}

function sectionTopology(faceId = "top"): NativeSectionTopology {
  const z = faceId === "bottom" ? 0 : 8;
  const normal: [number, number, number] = faceId === "bottom" ? [0, 0, -1] : [0, 0, 1];
  return {
    bodyMatchCount: 1,
    solid: true,
    checkCodes: [],
    faceMatchCount: 1,
    face: {
      id: faceId,
      planar: true,
      midpointMm: [30, 20, z],
      normal,
      edges: [
        line("e1", 1, 2, [0, 0, z], [60, 0, z]),
        line("e2", 2, 3, [60, 0, z], [60, 40, z]),
        line("e3", 3, 4, [60, 40, z], [0, 40, z]),
        line("e4", 4, 1, [0, 40, z], [0, 0, z]),
        circle("hole-a-loop", [10, 10, z], 3),
        circle("hole-b-loop", [50, 30, z], 3),
      ],
    },
  };
}

function line(id: string, first: number, second: number, startMm: [number, number, number], endMm: [number, number, number]): NativeSectionEdge {
  const lengthMm = Math.hypot(...startMm.map((value, index) => value - endMm[index]!));
  return { id, nativeId: Number(id.slice(1)), vertexIds: [first, second], isLine: true, isCircle: false, startMm, endMm, startTangent: startMm.map((value, index) => (endMm[index]! - value) / lengthMm) as [number, number, number], lengthMm };
}

function circle(id: string, centerMm: [number, number, number], radiusMm: number): NativeSectionEdge {
  return {
    id,
    nativeId: id.length,
    vertexIds: [null, null],
    isLine: false,
    isCircle: true,
    startMm: [centerMm[0] + radiusMm, centerMm[1], centerMm[2]],
    endMm: [centerMm[0] + radiusMm, centerMm[1], centerMm[2]],
    startTangent: [0, 1, 0],
    lengthMm: 2 * Math.PI * radiusMm,
    circle: { centerMm, axis: [0, 0, 1], reference: [1, 0, 0], radiusMm },
  };
}
