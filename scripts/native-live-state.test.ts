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

test("acceptance follows revision-bound body pages and rejects duplicate or cycling pages", async () => {
  const first = { documentToken: "doc", revision: "r1", undoDepth: 0, bodies: [{ id: 1, faces: [] }], bodyPagination: { nextOffset: 1 } };
  const second = { documentToken: "doc", revision: "r1", bodies: [{ id: 2, faces: [] }], bodyPagination: { nextOffset: null } };
  const unused = async () => { throw new Error("Unexpected body read"); };
  const result = await hydrateNativeState(first, unused, async (offset, revision) => {
    assert.equal(offset, 1); assert.equal(revision, "r1"); return second;
  });
  assert.deepEqual(result.bodies.map((body: any) => body.id), [1, 2]);
  await assert.rejects(hydrateNativeState(first, unused), /requires all body pages/);
  await assert.rejects(hydrateNativeState(first, unused, async () => ({ ...second, bodies: [{ id: 1, faces: [] }] })), /duplicate identities/);
  await assert.rejects(hydrateNativeState(first, unused, async () => ({ ...second, bodyPagination: { nextOffset: 1 } })), /did not advance/);
  await assert.rejects(hydrateNativeState(first, unused, async () => ({ ...second, revision: "r2" })), /Document changed/);
});
