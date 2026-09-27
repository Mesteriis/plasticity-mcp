import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectArbitrarySection,
  type ArbitrarySectionRequest,
  type NativeArbitrarySectionTopology,
} from "./arbitrary-section.ts";
import type { NativeSectionEdge } from "./section-geometry.ts";
import { PlasticityOperations } from "./operations.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";

const request: ArbitrarySectionRequest = {
  bodyId: 7,
  revision: "r1",
  plane: { originMm: [0, 0, 2.5], normal: [0, 0, 2], xDirection: [4, 0, 0] },
};

test("measures an exact temporary native section and preserves its plane binding", async () => {
  const state = runtimeState();
  let source = "";
  let bindings: string[] = [];
  let args: unknown;
  const runtime = {
    async getState() { return state; },
    async readNative(script: string, names: string[], values: unknown[]) {
      source = script;
      bindings = names;
      args = values[0];
      return rectangleTopology();
    },
  } as unknown as PlasticityRuntime;

  const evidence = await inspectArbitrarySection(runtime, request, "session-1");

  assert.equal(evidence.status, "verified");
  assert.equal(evidence.properties?.areaMm2, 200);
  assert.deepEqual(evidence.properties?.centroidMm, [10, 5, 2.5]);
  assert.equal(evidence.properties?.source, "native-brep-temporary-section");
  assert.deepEqual(evidence.binding.plane, {
    originMm: [0, 0, 2.5], normal: [0, 0, 1], xDirection: [1, 0, 0],
  });
  assert.equal(evidence.binding.topologySignature, evidence.properties?.topologySignature);
  assert.deepEqual(bindings, ["CutFactory", "kernel_Sheet", "kernel_Solid", "cplane2basis", "Vector3"]);
  assert.match(source, /makeTemporary/);
  assert.match(source, /CreateRectangle/);
  assert.match(source, /model\.Clone\(\)/);
  assert.match(source, /calculate\(factory\.partition\)/);
  assert.match(source, /await factory\.cancel/);
  assert.match(source, /await temporary\.removeItem/);
  assert.match(source, /kernel_Sheet\.Remove/);
  assert.doesNotMatch(source, /this\.exec|commit\(/);
  assert.deepEqual((args as { plane: unknown }).plane, evidence.binding.plane);
  const nativeSheet = (args as { sheet: { originMm: [number, number, number]; extentM: number } }).sheet;
  const expectedExtentMm = Math.hypot(20, 10, 5) * 4;
  assert.ok(Math.abs(nativeSheet.extentM * 1000 - expectedExtentMm) < 1e-10);
  assert.deepEqual(nativeSheet.originMm.map((value) => Number(value.toFixed(10))), [
    Number((10 - expectedExtentMm / 2).toFixed(10)),
    Number((5 - expectedExtentMm / 2).toFixed(10)),
    2.5,
  ]);
});

test("rejects stale revisions and invalid frames before native work", async () => {
  for (const candidate of [
    { ...request, revision: "old" },
    { ...request, plane: { ...request.plane, normal: [0, 0, 0] as [number, number, number] } },
    { ...request, plane: { ...request.plane, xDirection: [0, 0, 3] as [number, number, number] } },
  ]) {
    let reads = 0;
    const runtime = {
      async getState() { return runtimeState(); },
      async readNative() { reads += 1; return rectangleTopology(); },
    } as unknown as PlasticityRuntime;
    const evidence = await inspectArbitrarySection(runtime, candidate, "session-1");
    assert.equal(evidence.status, "unsupported");
    assert.equal(reads, 0);
    assert.ok(evidence.reasons.includes(candidate.revision === "old" ? "stale-reference" : "invalid-frame"));
    if (candidate.revision === "old") assert.equal(evidence.binding.revision, "r1");
  }
});

test("returns bounded unsupported reasons for invalid native topology", async () => {
  const candidates: Array<[NativeArbitrarySectionTopology, string]> = [
    [{ ...rectangleTopology(), bodyMatchCount: 0 }, "unknown-body"],
    [{ ...rectangleTopology(), bodyMatchCount: 2 }, "duplicate-body"],
    [{ ...rectangleTopology(), solid: false }, "non-solid"],
    [{ ...rectangleTopology(), checkCodes: [17] }, "native-check-failed"],
    [{ ...rectangleTopology(), cutBodyCount: 0, cutFaceCount: 0, edges: [] }, "no-section"],
  ];
  for (const [topology, reason] of candidates) {
    const evidence = await inspect(topology);
    assert.equal(evidence.status, "unsupported");
    assert.ok(evidence.reasons.includes(reason));
    assert.equal(evidence.properties, undefined);
  }
});

test("integrates multiple exact loops from a cut face", async () => {
  const topology = rectangleTopology();
  topology.edges.push(circleEdge());
  const evidence = await inspect(topology);
  assert.equal(evidence.status, "verified");
  assert.ok(Math.abs(evidence.properties!.areaMm2 - (200 - 4 * Math.PI)) < 1e-10);
  assert.equal(evidence.properties!.innerLoopCount, 1);
  assert.deepEqual(evidence.properties!.boundaryKinds, ["line", "circle"]);
});

test("discards section evidence if document, history or body identity changes", async () => {
  for (const changed of [
    { documentToken: "doc-2" },
    { revision: "r2" },
    { undoDepth: 4 },
    { redoDepth: 2 },
    { bodies: [{ ...runtimeState().bodies[0]!, versionId: 99 }] },
    { bodies: [{ ...runtimeState().bodies[0]!, boundsMm: { min: [0, 0, 0], max: [20, 10, 2.5] } }] },
  ]) {
    let stateReads = 0;
    const runtime = {
      async getState() {
        stateReads += 1;
        return stateReads === 1 ? runtimeState() : { ...runtimeState(), ...changed };
      },
      async readNative() { return rectangleTopology(); },
    } as unknown as PlasticityRuntime;
    const evidence = await inspectArbitrarySection(runtime, request, "session-1");
    assert.equal(evidence.status, "unsupported");
    assert.deepEqual(evidence.reasons, ["document-changed-during-section"]);
  }
});

test("requires a session ID and a usable body bound", async () => {
  const runtime = {
    async getState() { return runtimeState(); },
    async readNative() { return rectangleTopology(); },
  } as unknown as PlasticityRuntime;
  await assert.rejects(inspectArbitrarySection(runtime, request, ""), /session ID/i);

  const noBounds = runtimeState();
  noBounds.bodies[0]!.boundsMm = null;
  const unsupported = await inspectArbitrarySection({
    async getState() { return noBounds; },
  } as unknown as PlasticityRuntime, request, "session-1");
  assert.equal(unsupported.status, "unsupported");
  assert.deepEqual(unsupported.reasons, ["body-bounds-unavailable"]);
});

test("allocates fresh temporary view identities for sequential sections", async () => {
  const identities: Array<{ sheetVersionId: number; sheetStableId: number; targetVersionId: number; targetStableId: number }> = [];
  const state = runtimeState();
  const runtime = {
    async getState() { return state; },
    async readNative(_script: string, _names: string[], values: unknown[]) {
      identities.push((values[0] as { temporaryIds: typeof identities[number] }).temporaryIds);
      return rectangleTopology();
    },
  } as unknown as PlasticityRuntime;

  await inspectArbitrarySection(runtime, request, "session-1");
  await inspectArbitrarySection(runtime, request, "session-1");

  assert.equal(identities.length, 2);
  assert.notDeepEqual(identities[0], identities[1]);
  assert.ok(identities.every((identity) => new Set(Object.values(identity)).size === 4 && Object.values(identity).every((value) => value > 0)));
});

test("PlasticityOperations binds arbitrary-section evidence to its owned session", async () => {
  const state = runtimeState();
  const runtime = {
    async getState() { return state; },
    async readNative() { return rectangleTopology(); },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime, "owned-session");

  const evidence = await operations.inspectArbitrarySection(request);

  assert.equal(evidence.status, "verified");
  assert.equal(evidence.binding.sessionId, "owned-session");
});

async function inspect(topology: NativeArbitrarySectionTopology) {
  const state = runtimeState();
  const runtime = {
    async getState() { return state; },
    async readNative() { return structuredClone(topology); },
  } as unknown as PlasticityRuntime;
  return await inspectArbitrarySection(runtime, request, "session-1");
}

function rectangleTopology(): NativeArbitrarySectionTopology {
  return {
    bodyMatchCount: 1,
    solid: true,
    checkCodes: [],
    cutBodyCount: 2,
    cutFaceCount: 1,
    edges: [
      lineEdge("c1", 1, 2, [0, 0, 2.5], [20, 0, 2.5]),
      lineEdge("c2", 2, 3, [20, 0, 2.5], [20, 10, 2.5]),
      lineEdge("c3", 3, 4, [20, 10, 2.5], [0, 10, 2.5]),
      lineEdge("c4", 4, 1, [0, 10, 2.5], [0, 0, 2.5]),
    ],
  };
}

function lineEdge(
  id: string,
  first: number,
  second: number,
  startMm: [number, number, number],
  endMm: [number, number, number],
): NativeSectionEdge {
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

function circleEdge(): NativeSectionEdge {
  return {
    id: "hole",
    nativeId: 5,
    vertexIds: [null, null],
    isLine: false,
    isCircle: true,
    startMm: [12, 5, 2.5],
    endMm: [12, 5, 2.5],
    startTangent: [0, 1, 0],
    lengthMm: 4 * Math.PI,
    circle: { centerMm: [10, 5, 2.5], axis: [0, 0, 1], reference: [1, 0, 0], radiusMm: 2 },
  };
}

function runtimeState(): RuntimeState {
  return {
    targetId: "window-1",
    title: "Untitled - Plasticity",
    documentToken: "doc-1",
    revision: "r1",
    dbVersion: 4,
    undoDepth: 3,
    redoDepth: 1,
    construction: { planes: [], activePlaneId: null, planeStateToken: "p", viewStateToken: "v" },
    regions: [],
    bodies: [{
      id: 7,
      versionId: 11,
      type: "Solid",
      name: "Bracket",
      boundsMm: { min: [0, 0, 0], max: [20, 10, 5] },
      faceIds: [],
      edgeIds: [],
      faces: [],
      edges: [],
    }],
  };
}
