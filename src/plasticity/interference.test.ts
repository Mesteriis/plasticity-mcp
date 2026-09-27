import assert from "node:assert/strict";
import test from "node:test";

import {
  checkBodyInterference,
  type NativeInterferencePairResult,
} from "./interference.ts";
import { PlasticityOperations } from "./operations.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";

const pairs = [{ firstBodyId: 7, secondBodyId: 8 }];

test("reports exact temporary native intersection evidence", async () => {
  const state = runtimeState();
  let source = "";
  let bindings: string[] = [];
  let arguments_: unknown;
  const runtime = {
    async getState() { return state; },
    async readNative(script: string, names: string[], values: unknown[]) {
      source = script;
      bindings = names;
      arguments_ = values[0];
      return [interferenceResult()];
    },
  } as unknown as PlasticityRuntime;

  const evidence = await checkBodyInterference(runtime, pairs, "r1", "session-1");

  assert.equal(evidence.sessionId, "session-1");
  assert.equal(evidence.documentToken, "doc-1");
  assert.equal(evidence.revision, "r1");
  assert.equal(evidence.source, "native-brep-temporary-intersection");
  assert.equal(evidence.pairs[0]?.status, "interfere");
  assert.deepEqual(evidence.pairs[0]?.intersectionBodies, [{
    type: "SolidBody",
    faceCount: 6,
    boundsMm: { min: [5, 0, 0], max: [10, 10, 10] },
    nativeCheckCodes: [],
  }]);
  assert.deepEqual(bindings, ["BooleanFactory", "kernel_Solid"]);
  assert.deepEqual(arguments_, { pairs, temporaryIds: [{ firstVersionId: 2_146_000_001, firstStableId: 2_146_000_000, secondVersionId: 2_145_999_999, secondStableId: 2_145_999_998 }] });
  assert.match(source, /makeTemporary/);
  assert.match(source, /findModel\(pair\.firstBodyId\)\.Clone\(\)/);
  assert.match(source, /operationType = 15901/);
  assert.match(source, /keepTools = false/);
  assert.match(source, /calculate\(factory\.partition\)/);
  assert.match(source, /FindBox/);
  assert.match(source, /await factory\.cancel/);
  assert.doesNotMatch(source, /this\.exec|commit\(/);
});

test("distinguishes absence of volume without claiming clearance or separation", async () => {
  const evidence = await inspect([{ firstBodyId: 7, secondBodyId: 8, outcome: "no-effect", error: "Operation has no effect" }]);

  assert.equal(evidence.pairs[0]?.status, "no-volumetric-interference");
  assert.deepEqual(evidence.pairs[0]?.reasons, ["native-intersection-has-no-volume"]);
  assert.equal(evidence.pairs[0]?.intersectionBodies, undefined);
  assert.equal("clearanceMm" in evidence.pairs[0]!, false);
});

test("returns bounded unsupported evidence for native failures and invalid intersection results", async () => {
  const nativeFailure = await inspect([{ firstBodyId: 7, secondBodyId: 8, outcome: "error", error: "kernel failure" }]);
  assert.equal(nativeFailure.pairs[0]?.status, "unsupported");
  assert.deepEqual(nativeFailure.pairs[0]?.reasons, ["native-intersection-failed"]);

  const invalid = interferenceResult();
  invalid.intersectionBodies![0]!.nativeCheckCodes = [17];
  const invalidEvidence = await inspect([invalid]);
  assert.equal(invalidEvidence.pairs[0]?.status, "unsupported");
  assert.deepEqual(invalidEvidence.pairs[0]?.reasons, ["native-check-failed"]);
});

test("rejects stale, duplicate, self, unknown and non-Solid pairs before native work", async () => {
  const candidates: Array<[typeof pairs, string, (state: RuntimeState) => void]> = [
    [pairs, "old", () => {}],
    [[...pairs, { firstBodyId: 8, secondBodyId: 7 }], "r1", () => {}],
    [[{ firstBodyId: 7, secondBodyId: 7 }], "r1", () => {}],
    [[{ firstBodyId: 7, secondBodyId: 99 }], "r1", () => {}],
    [pairs, "r1", (state) => { state.bodies[1]!.type = "Sheet"; }],
  ];
  for (const [candidatePairs, revision, mutateState] of candidates) {
    const state = runtimeState();
    mutateState(state);
    let reads = 0;
    const runtime = {
      async getState() { return state; },
      async readNative() { reads += 1; return []; },
    } as unknown as PlasticityRuntime;
    await assert.rejects(checkBodyInterference(runtime, candidatePairs, revision, "session-1"));
    assert.equal(reads, 0);
  }
});

test("discards all evidence when persistent document state changes during inspection", async () => {
  for (const changed of [
    { documentToken: "doc-2" },
    { revision: "r2" },
    { undoDepth: 3 },
    { redoDepth: 1 },
    { bodies: [{ ...runtimeState().bodies[0]!, versionId: 99 }, runtimeState().bodies[1]!] },
  ]) {
    let reads = 0;
    const runtime = {
      async getState() { reads += 1; return reads === 1 ? runtimeState() : { ...runtimeState(), ...changed }; },
      async readNative() { return [interferenceResult()]; },
    } as unknown as PlasticityRuntime;
    const evidence = await checkBodyInterference(runtime, pairs, "r1", "session-1");
    assert.equal(evidence.pairs[0]?.status, "unsupported");
    assert.deepEqual(evidence.pairs[0]?.reasons, ["document-changed-during-interference-check"]);
  }
});

test("ignores conservative floating bound drift when native identities and topology are unchanged", async () => {
  let reads = 0;
  const runtime = {
    async getState() {
      reads += 1;
      const state = runtimeState();
      if (reads === 2) {
        state.bodies[0]!.boundsMm!.max[0] += 1e-9;
      }
      return state;
    },
    async readNative() { return [interferenceResult()]; },
  } as unknown as PlasticityRuntime;

  const evidence = await checkBodyInterference(runtime, pairs, "r1", "session-1");
  assert.equal(evidence.pairs[0]?.status, "interfere");
});

test("requires a session and allocates fresh temporary identities", async () => {
  const state = runtimeState();
  const identities: unknown[] = [];
  const runtime = {
    async getState() { return state; },
    async readNative(_script: string, _names: string[], values: unknown[]) {
      identities.push((values[0] as { temporaryIds: unknown }).temporaryIds);
      return [interferenceResult()];
    },
  } as unknown as PlasticityRuntime;
  await assert.rejects(checkBodyInterference(runtime, pairs, "r1", ""), /session ID/i);
  await checkBodyInterference(runtime, pairs, "r1", "session-1");
  await checkBodyInterference(runtime, pairs, "r1", "session-1");
  assert.notDeepEqual(identities[0], identities[1]);
});

test("PlasticityOperations binds interference evidence to its owned session", async () => {
  const state = runtimeState();
  const runtime = {
    async getState() { return state; },
    async readNative() { return [interferenceResult()]; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime, "owned-session");

  const evidence = await operations.checkInterference(pairs, "r1");

  assert.equal(evidence.sessionId, "owned-session");
});

async function inspect(result: NativeInterferencePairResult[]) {
  const state = runtimeState();
  return await checkBodyInterference({
    async getState() { return state; },
    async readNative() { return structuredClone(result); },
  } as unknown as PlasticityRuntime, pairs, "r1", "session-1");
}

function interferenceResult(): NativeInterferencePairResult {
  return {
    firstBodyId: 7,
    secondBodyId: 8,
    outcome: "intersection",
    intersectionBodies: [{
      type: "SolidBody",
      faceCount: 6,
      boundsMm: { min: [5, 0, 0], max: [10, 10, 10] },
      nativeCheckCodes: [],
    }],
  };
}

function runtimeState(): RuntimeState {
  const body = (id: number, versionId: number, min: [number, number, number], max: [number, number, number]): RuntimeState["bodies"][number] => ({
    id, versionId, type: "Solid", name: `Body ${id}`, boundsMm: { min, max }, faceIds: [], edgeIds: [], faces: [], edges: [],
  });
  return {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision: "r1",
    dbVersion: 1, undoDepth: 2, redoDepth: 0, regions: [],
    construction: { planes: [], activePlaneId: null, planeStateToken: "p0", viewStateToken: "v0" },
    bodies: [body(7, 17, [0, 0, 0], [10, 10, 10]), body(8, 18, [5, 0, 0], [15, 10, 10])],
  };
}
