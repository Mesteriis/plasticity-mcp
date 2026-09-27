import assert from "node:assert/strict";
import test from "node:test";

import {
  integrateNativeSectionBoundary,
  inspectPlanarSection,
  type NativeSectionEdge,
  type NativeSectionTopology,
} from "./section-geometry.ts";
import { PlasticityOperations } from "./operations.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";
import { strengthDependenciesForSession, type SessionLike } from "../server.ts";

const request = { bodyId: 7, faceId: "face-top", revision: "r1", xDirection: [1, 0, 0] as [number, number, number] };

test("integrates an exact native boundary from an explicit plane frame", () => {
  const edges = rectangleTopology().face!.edges;
  const integrated = integrateNativeSectionBoundary(edges, {
    originMm: [0, 0, 5],
    normal: [0, 0, 4],
    xDirection: [3, 0, 0],
  });

  assert.deepEqual(integrated.frame, {
    originMm: [0, 0, 5],
    normal: [0, 0, 1],
    xDirection: [1, 0, 0],
  });
  assert.equal(integrated.properties.areaMm2, 200);
  assert.deepEqual(integrated.properties.centroidMm, [10, 5, 5]);
  assert.equal(integrated.loops.length, 1);
});

test("reads one exact planar face and ignores all display bounds", async () => {
  const state = runtimeState("r1");
  let nativeSource = "";
  const runtime = {
    async getState() { return state; },
    async readNative(source: string) { nativeSource = source; return rectangleTopology(); },
  } as unknown as PlasticityRuntime;

  const evidence = await inspectPlanarSection(runtime, request, "session-1");

  assert.equal(evidence.status, "verified");
  assert.equal(evidence.properties?.areaMm2, 200);
  assert.deepEqual(evidence.properties?.centroidMm, [10, 5, 5]);
  assert.equal(evidence.properties?.source, "native-brep-boundary");
  assert.equal(evidence.binding.faceId, "face-top");
  assert.equal(evidence.binding.topologySignature, evidence.properties?.topologySignature);
  assert.deepEqual(evidence.frame, { originMm: [10, 5, 5], normal: [0, 0, 1], xDirection: [1, 0, 0] });
  assert.match(nativeSource, /GetPointAndTangent/);
  assert.match(nativeSource, /GetCurve\(\)/);
  assert.match(nativeSource, /\.Check\(\)/);
  assert.doesNotMatch(nativeSource, /boundsMm|FindBox|getBoundingBox/);
});

test("rejects stale revision before native collection", async () => {
  let nativeReads = 0;
  const runtime = {
    async getState() { return runtimeState("r2"); },
    async readNative() { nativeReads += 1; return rectangleTopology(); },
  } as unknown as PlasticityRuntime;
  const evidence = await inspectPlanarSection(runtime, request, "session-1");
  assert.equal(evidence.status, "unsupported");
  assert.deepEqual(evidence.reasons, ["stale-reference"]);
  assert.equal(nativeReads, 0);
});

test("rejects missing and duplicate selected face IDs", async () => {
  for (const count of [0, 2]) {
    const topology = { ...rectangleTopology(), faceMatchCount: count };
    const evidence = await inspect(topology);
    assert.equal(evidence.status, "unsupported");
    assert.ok(evidence.reasons.includes(count === 0 ? "missing-face" : "duplicate-face"));
  }
});

test("rejects a non-Solid, native Check failure and nonplanar face", async () => {
  const candidates: Array<[NativeSectionTopology, string]> = [
    [{ ...rectangleTopology(), solid: false }, "non-solid"],
    [{ ...rectangleTopology(), checkCodes: [42] }, "native-check-failed"],
    [{ ...rectangleTopology(), face: { ...rectangleTopology().face!, planar: false } }, "nonplanar-face"],
  ];
  for (const [topology, reason] of candidates) {
    const evidence = await inspect(topology);
    assert.equal(evidence.status, "unsupported");
    assert.ok(evidence.reasons.includes(reason));
  }
});

test("extracts a native full-circle hole and subtracts it", async () => {
  const topology = rectangleTopology();
  topology.face!.edges.push(circleEdge());
  const evidence = await inspect(topology);
  assert.equal(evidence.status, "verified");
  assert.ok(Math.abs(evidence.properties!.areaMm2 - (200 - 4 * Math.PI)) < 1e-10);
  assert.equal(evidence.properties!.innerLoopCount, 1);
  assert.deepEqual(evidence.properties!.boundaryKinds, ["line", "circle"]);
  assert.equal(evidence.loops!.length, 2);
});

test("rejects unsupported curves and open vertex incidence", async () => {
  const unsupported = rectangleTopology();
  unsupported.face!.edges[0] = { ...unsupported.face!.edges[0]!, isLine: false, isCircle: false };
  const unsupportedEvidence = await inspect(unsupported);
  assert.equal(unsupportedEvidence.status, "unsupported");
  assert.ok(unsupportedEvidence.reasons.includes("unsupported-curve:e1"));

  const open = rectangleTopology();
  open.face!.edges[3] = { ...open.face!.edges[3]!, vertexIds: [4, 5] };
  const openEvidence = await inspect(open);
  assert.equal(openEvidence.status, "unsupported");
  assert.ok(openEvidence.reasons.includes("open-boundary-incidence"));
});

test("discards exact topology when document or revision changes after collection", async () => {
  for (const changed of [
    { documentToken: "doc-2", revision: "r1" },
    { documentToken: "doc-1", revision: "r2" },
  ]) {
    let reads = 0;
    const runtime = {
      async getState() {
        reads += 1;
        return reads === 1 ? runtimeState("r1") : { ...runtimeState(changed.revision), documentToken: changed.documentToken };
      },
      async readNative() { return rectangleTopology(); },
    } as unknown as PlasticityRuntime;
    const evidence = await inspectPlanarSection(runtime, request, "session-1");
    assert.equal(evidence.status, "unsupported");
    assert.deepEqual(evidence.reasons, ["stale-reference"]);
    assert.equal(evidence.properties, undefined);
  }
});

test("PlasticityOperations delegates with the owned session ID", async () => {
  const state = runtimeState("r1");
  const runtime = {
    getCapabilities() { return []; },
    async getState() { return state; },
    async readNative() { return rectangleTopology(); },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime, "session-owned");
  const evidence = await operations.inspectPlanarSection(request);
  assert.equal(evidence.status, "verified");
  assert.equal(evidence.binding.sessionId, "session-owned");
});

test("session strength dependencies re-resolve the current face signature", async () => {
  const calls: typeof request[] = [];
  let available = true;
  const operations = {
    datumRegistry: { sessionId: "session-owned" },
    async state() { return runtimeState("r-current"); },
    async inspectPlanarSection(candidate: typeof request) {
      calls.push(candidate);
      return {
        status: available ? "verified" as const : "unsupported" as const,
        binding: {
          sessionId: "session-owned",
          documentToken: "doc-1",
          revision: candidate.revision,
          bodyId: candidate.bodyId,
          faceId: candidate.faceId,
          topologySignature: available ? "exact-signature" : "unavailable",
        },
        source: "native-brep-boundary" as const,
        reasons: available ? [] : ["missing-face"],
      };
    },
  };
  const session = { get: () => operations } as unknown as SessionLike;
  const deps = strengthDependenciesForSession(session);
  const inspected = await deps.inspectSection(request);
  assert.equal(inspected.binding.topologySignature, "exact-signature");
  const current = await deps.readSectionBinding({ bodyId: 7, faceId: "face-top", xDirection: [1, 0, 0] });
  assert.equal(current.topologySignature, "exact-signature");
  assert.equal(calls.at(-1)?.revision, "r-current");
  available = false;
  const missing = await deps.readSectionBinding({ bodyId: 7, faceId: "face-top", xDirection: [1, 0, 0] });
  assert.equal(missing.topologySignature, "unavailable");
  assert.equal(missing.revision, "r-current");
});

async function inspect(topology: NativeSectionTopology) {
  const state = runtimeState("r1");
  const runtime = {
    async getState() { return state; },
    async readNative() { return structuredClone(topology); },
  } as unknown as PlasticityRuntime;
  return await inspectPlanarSection(runtime, request, "session-1");
}

function rectangleTopology(): NativeSectionTopology {
  return {
    bodyMatchCount: 1,
    solid: true,
    checkCodes: [],
    faceMatchCount: 1,
    face: {
      id: "face-top",
      planar: true,
      midpointMm: [10, 5, 5],
      normal: [0, 0, 1],
      edges: [
        lineEdge("e1", 1, 2, [0, 0, 5], [20, 0, 5]),
        lineEdge("e2", 2, 3, [20, 0, 5], [20, 10, 5]),
        lineEdge("e3", 3, 4, [20, 10, 5], [0, 10, 5]),
        lineEdge("e4", 4, 1, [0, 10, 5], [0, 0, 5]),
      ],
    },
  };
}

function lineEdge(
  id: string,
  first: number,
  second: number,
  startMm: [number, number, number],
  endMm: [number, number, number],
): NativeSectionEdge {
  const length = Math.hypot(...startMm.map((value, index) => value - endMm[index]!));
  return {
    id,
    nativeId: Number(id.slice(1)),
    vertexIds: [first, second],
    isLine: true,
    isCircle: false,
    startMm,
    endMm,
    startTangent: startMm.map((value, index) => (endMm[index]! - value) / length) as [number, number, number],
    lengthMm: length,
  };
}

function circleEdge(): NativeSectionEdge {
  return {
    id: "hole",
    nativeId: 5,
    vertexIds: [null, null],
    isLine: false,
    isCircle: true,
    startMm: [12, 5, 5],
    endMm: [12, 5, 5],
    startTangent: [0, 1, 0],
    lengthMm: 4 * Math.PI,
    circle: {
      centerMm: [10, 5, 5],
      axis: [0, 0, 1],
      reference: [1, 0, 0],
      radiusMm: 2,
    },
  };
}

function runtimeState(revision: string): RuntimeState {
  return {
    targetId: "window-1",
    title: "Untitled - Plasticity",
    documentToken: "doc-1",
    revision,
    dbVersion: revision === "r1" ? 1 : 2,
    undoDepth: 0,
    redoDepth: 0,
    regions: [],
    construction: { planes: [], activePlaneId: null, planeStateToken: "p1", viewStateToken: "v1" },
    bodies: [{
      id: 7,
      versionId: 17,
      type: "Solid",
      name: "Section body",
      boundsMm: { min: [-999, -999, -999], max: [999, 999, 999] },
      faceIds: ["face-top"],
      edgeIds: ["e1", "e2", "e3", "e4"],
      faces: [],
      edges: [],
    }],
  };
}
