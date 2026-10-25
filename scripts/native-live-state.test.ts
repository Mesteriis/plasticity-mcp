import assert from "node:assert/strict";
import { test } from "node:test";
import { hydrateNativeState } from "./native-live-state.ts";

test("acceptance reads topology explicitly without changing compact MCP responses", async () => {
  const state = { documentToken: "doc", revision: "r1", undoDepth: 0, bodies: [{ id: 7 }] };
  const body = { id: 7, faces: [{ id: "f1" }] };
  const result = await hydrateNativeState(state, async (id) => {
    assert.equal(id, 7); return { documentToken: "doc", revision: "r1", body };
  });
  assert.equal(result.bodies[0], body);
  assert.deepEqual(state.bodies, [{ id: 7 }]);
  for (const response of [{ revision: "r2", body }, { documentToken: "other", body }, { body: { id: 9 } }]) {
    await assert.rejects(hydrateNativeState(state, async () => (Object.assign({ documentToken: "doc", revision: "r1", body }, response))), /Document changed/);
  }
});

test("acceptance leaves non-state responses and existing detailed bodies alone", async () => {
  const read = async () => { throw new Error("unexpected topology read"); };
  for (const result of [{ documentToken: "doc", revision: "r1", bodies: [{ id: 7, nativeValid: true }] }, [], { body: { id: 7 } }, { documentToken: "doc", revision: "r1", undoDepth: 0, bodies: [{ id: 7, faces: [] }] }]) {
    assert.deepEqual(await hydrateNativeState(result, read), result);
  }
});
