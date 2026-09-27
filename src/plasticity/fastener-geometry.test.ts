import assert from "node:assert/strict";
import test from "node:test";

import { describeFastenerFace, inspectSingleFastenerPlate } from "./fastener-geometry.ts";
import type { NativeSectionEdge, NativeSectionTopology, SectionEvidence } from "./section-geometry.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";

test("fastener face descriptor reads an axis-aligned rectangle and one circular hole", () => {
  const result = describeFastenerFace(section());
  assert.deepEqual(result, {
    minX: -20,
    maxX: 20,
    minY: -10,
    maxY: 10,
    holeCenter: [5, 0],
    holeRadiusMm: 3,
  });
});

test("fastener face descriptor rejects rotated or extra-hole topology", () => {
  const rotated = section();
  rotated.loops![0]!.segments[0] = { kind: "line", start: [-20, -10], end: [19, 10] };
  assert.throws(() => describeFastenerFace(rotated), /axis-aligned rectangle/i);

  const extra = section();
  extra.loops!.push({ segments: [{ kind: "arc", center: [-5, 0], radius: 2, startRadians: 0, sweepRadians: 2 * Math.PI }] });
  assert.throws(() => describeFastenerFace(extra), /one circular hole/i);
});

test("single-fastener inspector measures exact opposed native faces", async () => {
  const state = fastenerState("r1");
  const runtime = {
    async getState() { return state; },
    async readNative(_source: string, _names: string[], values: Array<{ faceId: string }>) {
      return nativeFace(values[0]!.faceId === "front" ? 2 : 0, values[0]!.faceId === "front" ? 1 : -1);
    },
  } as unknown as PlasticityRuntime;
  const evidence = await inspectSingleFastenerPlate(runtime, {
    bodyId: 7,
    frontFaceId: "front",
    backFaceId: "back",
    revision: "r1",
    loadDirection: [2, 0, 0],
  }, "session-1");
  assert.equal(evidence.status, "verified");
  assert.deepEqual(evidence.geometry, {
    thicknessMm: 2,
    holeDiameterMm: 6,
    loadedEdgeDistanceMm: 10,
    oppositeEdgeDistanceMm: 30,
    grossWidthMm: 20,
    sideClearancesMm: [7, 7],
  });
  assert.deepEqual(evidence.binding.loadDirection, [1, 0, 0]);
  assert.deepEqual(evidence.holeCenterMm, [30, 10, 1]);
});

test("single-fastener inspector rejects a non-planar load direction and stale revision", async () => {
  let nativeReads = 0;
  const state = fastenerState("r1");
  const runtime = {
    async getState() { return state; },
    async readNative(_source: string, _names: string[], values: Array<{ faceId: string }>) {
      nativeReads += 1;
      return nativeFace(values[0]!.faceId === "front" ? 2 : 0, values[0]!.faceId === "front" ? 1 : -1);
    },
  } as unknown as PlasticityRuntime;
  const offPlane = await inspectSingleFastenerPlate(runtime, {
    bodyId: 7, frontFaceId: "front", backFaceId: "back", revision: "r1", loadDirection: [1, 0, 1],
  }, "session-1");
  assert.equal(offPlane.status, "unsupported");
  assert.deepEqual(offPlane.reasons, ["load-direction-not-in-face-plane"]);

  const stale = await inspectSingleFastenerPlate(runtime, {
    bodyId: 7, frontFaceId: "front", backFaceId: "back", revision: "r0", loadDirection: [1, 0, 0],
  }, "session-1");
  assert.equal(stale.status, "unsupported");
  assert.deepEqual(stale.reasons, ["stale-reference"]);
  assert.equal(nativeReads, 2);
});

function section(): SectionEvidence {
  return {
    status: "verified",
    binding: {
      sessionId: "session",
      documentToken: "doc",
      revision: "r1",
      bodyId: 7,
      faceId: "front",
      topologySignature: "sig",
    },
    frame: { originMm: [20, 10, 2], normal: [0, 0, 1], xDirection: [1, 0, 0] },
    properties: {
      areaMm2: 800 - 9 * Math.PI,
      centroidLocalMm: [0, 0],
      centroidMm: [20, 10, 2],
      ixxMm4: 1,
      iyyMm4: 1,
      ixyMm4: 0,
      principal: { majorMm4: 1, minorMm4: 1, angleDegrees: 0 },
      innerLoopCount: 1,
      boundaryKinds: ["line", "circle"],
      rectangular: false,
      topologySignature: "sig",
      source: "native-brep-boundary",
    },
    loops: [
      { segments: [
        { kind: "line", start: [-20, -10], end: [20, -10] },
        { kind: "line", start: [20, -10], end: [20, 10] },
        { kind: "line", start: [20, 10], end: [-20, 10] },
        { kind: "line", start: [-20, 10], end: [-20, -10] },
      ] },
      { segments: [{ kind: "arc", center: [5, 0], radius: 3, startRadians: 0, sweepRadians: -2 * Math.PI }] },
    ],
    source: "native-brep-boundary",
    reasons: [],
  };
}

function fastenerState(revision: string): RuntimeState {
  const faces = [
    { id: "front", planar: true, normal: [0, 0, 1] as [number, number, number], radiusMm: null },
    { id: "back", planar: true, normal: [0, 0, -1] as [number, number, number], radiusMm: null },
    ...["left", "right", "near", "far"].map((id) => ({ id, planar: true, normal: [1, 0, 0] as [number, number, number], radiusMm: null })),
    { id: "hole", planar: false, normal: [1, 0, 0] as [number, number, number], radiusMm: 3 },
  ].map((face) => ({
    ...face,
    surfaceType: face.planar ? "Plane" : "Cylinder",
    centerMm: [0, 0, 0] as [number, number, number],
    blendRadiusMm: null,
    axisOriginMm: null,
    axisDirection: null,
    boundsMm: { min: [0, 0, 0] as [number, number, number], max: [0, 0, 0] as [number, number, number] },
    edgeIds: [],
  }));
  return {
    targetId: "window",
    title: "Untitled - Plasticity",
    documentToken: "doc",
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
      name: "Fastener plate",
      boundsMm: null,
      faceIds: faces.map((face) => face.id),
      edgeIds: Array.from({ length: 14 }, (_, index) => `edge-${index}`),
      faces,
      edges: [],
    }],
  };
}

function nativeFace(z: number, normalZ: number): NativeSectionTopology {
  return {
    bodyMatchCount: 1,
    solid: true,
    checkCodes: [],
    faceMatchCount: 1,
    face: {
      id: z === 2 ? "front" : "back",
      planar: true,
      midpointMm: [20, 10, z],
      normal: [0, 0, normalZ],
      edges: [
        line("e1", 1, 2, [0, 0, z], [40, 0, z]),
        line("e2", 2, 3, [40, 0, z], [40, 20, z]),
        line("e3", 3, 4, [40, 20, z], [0, 20, z]),
        line("e4", 4, 1, [0, 20, z], [0, 0, z]),
        circle(z),
      ],
    },
  };
}

function line(id: string, first: number, second: number, startMm: [number, number, number], endMm: [number, number, number]): NativeSectionEdge {
  const lengthMm = Math.hypot(...startMm.map((value, index) => value - endMm[index]!));
  return {
    id,
    nativeId: Number(id.slice(1)),
    vertexIds: [first, second],
    isLine: true,
    isCircle: false,
    startMm,
    endMm,
    startTangent: startMm.map((value, index) => (endMm[index]! - value) / lengthMm) as [number, number, number],
    lengthMm,
  };
}

function circle(z: number): NativeSectionEdge {
  return {
    id: "circle",
    nativeId: 5,
    vertexIds: [null, null],
    isLine: false,
    isCircle: true,
    startMm: [33, 10, z],
    endMm: [33, 10, z],
    startTangent: [0, 1, 0],
    lengthMm: 6 * Math.PI,
    circle: { centerMm: [30, 10, z], axis: [0, 0, 1], reference: [1, 0, 0], radiusMm: 3 },
  };
}
