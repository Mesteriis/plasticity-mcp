import assert from "node:assert/strict";
import test from "node:test";

import type { NativeSectionTopology } from "./section-geometry.ts";
import { inspectIntegralRectangularPlate, type IntegralPlateRequest } from "./integral-plate-geometry.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";

const request: IntegralPlateRequest = {
  bodyId: 7,
  frontFaceId: "outer-panel",
  backFaceId: "inner-panel",
  revision: "r1",
  xDirection: [1, 0, 0],
};

test("measures exact dimensions and thickness from opposed native rectangular faces", async () => {
  const evidence = await inspectIntegralRectangularPlate(runtime(), request, "session-1");
  assert.equal(evidence.status, "verified", JSON.stringify(evidence.reasons));
  assert.deepEqual(evidence.geometry, { lengthMm: 20, widthMm: 10, thicknessMm: 2 });
  assert.deepEqual(evidence.faces, { frontFaceId: "outer-panel", backFaceId: "inner-panel" });
  assert.equal(evidence.binding.revision, "r1");
});

test("recovers the panel mid-surface dimensions when enclosure walls inset the inner face by one wall thickness", async () => {
  const evidence = await inspectIntegralRectangularPlate(runtime({ backWidth: 16, backHeight: 6 }), request, "session-1");
  assert.equal(evidence.status, "verified", JSON.stringify(evidence.reasons));
  assert.deepEqual(evidence.geometry, { lengthMm: 18, widthMm: 8, thicknessMm: 2 });
});

test("rejects same-facing planes, mismatched outlines and stale revisions", async () => {
  const sameFacing = await inspectIntegralRectangularPlate(runtime({ backNormal: [0, 0, 1] }), request, "session-1");
  assert.equal(sameFacing.status, "unsupported");
  assert.ok(sameFacing.reasons.includes("faces-are-not-opposed"));

  const mismatched = await inspectIntegralRectangularPlate(runtime({ backWidth: 8 }), request, "session-1");
  assert.equal(mismatched.status, "unsupported");
  assert.ok(mismatched.reasons.includes("opposed-face-outlines-do-not-match-or-thickness-inset"));

  const stale = await inspectIntegralRectangularPlate(runtime({ beforeRevision: "r2" }), request, "session-1");
  assert.equal(stale.status, "unsupported");
  assert.deepEqual(stale.reasons, ["stale-reference"]);
});

test("rejects nonrectangular selected panel faces", async () => {
  const evidence = await inspectIntegralRectangularPlate(runtime({ curved: true }), request, "session-1");
  assert.equal(evidence.status, "unsupported");
  assert.ok(evidence.reasons.some((reason) => reason.startsWith("front:")));
});

function runtime(options: {
  beforeRevision?: string;
  backNormal?: [number, number, number];
  backWidth?: number;
  backHeight?: number;
  curved?: boolean;
} = {}): PlasticityRuntime {
  const state = stateFor(options.beforeRevision ?? "r1");
  return {
    async getState() { return state; },
    async readNative(_source: string, _bindings: string[], values: unknown[]) {
      return topologyFor(String((values[0] as { faceId: string }).faceId), options);
    },
  } as unknown as PlasticityRuntime;
}

function topologyFor(faceId: string, options: { backNormal?: [number, number, number]; backWidth?: number; backHeight?: number; curved?: boolean }): NativeSectionTopology {
  const back = faceId === "inner-panel";
  const z = back ? 3 : 5;
  const width = back ? options.backWidth ?? 20 : 20;
  const height = back ? options.backHeight ?? 10 : 10;
  const half = width / 2;
  const halfHeight = height / 2;
  const edges = [
    line("e1", 1, 2, [-half, -halfHeight, z], [half, -halfHeight, z]),
    line("e2", 2, 3, [half, -halfHeight, z], [half, halfHeight, z]),
    line("e3", 3, 4, [half, halfHeight, z], [-half, halfHeight, z]),
    line("e4", 4, 1, [-half, halfHeight, z], [-half, -halfHeight, z]),
  ];
  if (options.curved) edges[0] = { ...edges[0]!, isLine: false };
  return {
    bodyMatchCount: 1,
    solid: true,
    checkCodes: [],
    faceMatchCount: 1,
    face: {
      id: faceId,
      planar: true,
      midpointMm: [0, 0, z],
      normal: back ? options.backNormal ?? [0, 0, -1] : [0, 0, 1],
      edges,
    },
  };
}

function line(id: string, first: number, second: number, startMm: [number, number, number], endMm: [number, number, number]) {
  const length = Math.hypot(...startMm.map((value, index) => value - endMm[index]!));
  return {
    id,
    nativeId: Number(id.slice(1)),
    vertexIds: [first, second] as [number, number],
    isLine: true,
    isCircle: false,
    startMm,
    endMm,
    startTangent: startMm.map((value, index) => (endMm[index]! - value) / length) as [number, number, number],
    lengthMm: length,
  };
}

function stateFor(revision: string): RuntimeState {
  return {
    targetId: "window-1",
    title: "Untitled - Plasticity",
    documentToken: "doc-1",
    revision,
    dbVersion: 1,
    undoDepth: 0,
    redoDepth: 0,
    regions: [],
    construction: { planes: [], activePlaneId: null, planeStateToken: "p1", viewStateToken: "v1" },
    bodies: [{
      id: 7,
      versionId: 17,
      type: "Solid",
      name: "Enclosure",
      boundsMm: null,
      faceIds: ["outer-panel", "inner-panel"],
      edgeIds: [],
      faces: [],
      edges: [],
    }],
  };
}
