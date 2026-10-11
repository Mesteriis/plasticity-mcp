import assert from "node:assert/strict";
import { test } from "node:test";

import type { PlasticityRuntime, RuntimeState } from "../src/plasticity/runtime.ts";
import { verifyCachedTopology } from "./verify-native-topology-cache-live.ts";

test("topology acceptance compares a cached snapshot to a fresh native walk and restores the cache", async () => {
  const state = { bodies: [{ id: 1, boundsMm: { min: [0, 0, 0], max: [20, 10, 5] } }] } as RuntimeState;
  for (const diverges of [false, true]) {
    let reads = 0;
    const sources: string[] = [];
    const runtime = {
      async getState() {
        reads += 1;
        return reads === 3 && diverges ? { ...state, bodies: [] } : state;
      },
      async read(source: string) { sources.push(source); return true; },
    } as unknown as PlasticityRuntime;
    if (diverges) await assert.rejects(verifyCachedTopology(runtime), /fresh native walk/);
    else assert.equal(await verifyCachedTopology(runtime), state);
    assert.equal(reads, 3);
    assert.equal(sources.length, 3);
    assert.match(sources[1]!, /new WeakMap/);
    assert.match(sources[2]!, /delete globalThis\[saved\]/);
  }
});

test("topology acceptance rejects an absent cache before replacing it", async () => {
  let reads = 0;
  const runtime = {
    async getState() { return { bodies: [] }; },
    async read() { reads += 1; return false; },
  } as unknown as PlasticityRuntime;
  await assert.rejects(verifyCachedTopology(runtime), /topology cache entry/);
  assert.equal(reads, 1);
});
