import assert from "node:assert/strict";
import { test } from "node:test";

import { bodyCount, parseCompactDiffAcceptanceArgs, requireCompactMutationState, requireSameDocumentIdentity, sceneMatchesBaseline } from "./verify-compact-diff-live.ts";

test("compact diff acceptance reads counts from mutation and observation response shapes", () => {
  assert.equal(bodyCount({ bodies: [{ id: 1 }, { id: 2 }] }), 2);
  assert.equal(bodyCount({ bodyPagination: { total: 21 } }), 21);
  assert.equal(bodyCount({ bodies: Array.from({ length: 20 }, (_, id) => ({ id })), bodyPagination: { total: 21 } }), 21,
    "the current page length must not be mistaken for the complete scene body count");
  assert.throws(() => bodyCount({}), /omitted its body count/);
});

test("live acceptance enforces compact mutation response pagination and one exact added-body summary", () => {
  const body = { id: 21, boundsMm: { min: [0, 0, 0], max: [1, 1, 1] }, faceCount: 6, edgeCount: 12, vertexCount: 8 };
  const state = {
    revision: "r2",
    bodyPagination: { offset: 0, limit: 20, total: 21, nextOffset: 20 },
    bodies: Array.from({ length: 20 }, (_, id) => ({ ...body, id })),
    change: { sceneChanged: true, revisionChanged: true, added: [body] },
  };
  assert.doesNotThrow(() => requireCompactMutationState(state, 21));
  assert.throws(() => requireCompactMutationState({ ...state, bodies: [...state.bodies, body] }, 21), /at most 20/);
  assert.throws(() => requireCompactMutationState({ ...state, change: { ...state.change, added: [{ ...body, faces: [] }] } }, 21), /full B-Rep topology/);
  assert.throws(() => requireCompactMutationState({ ...state, change: { ...state.change, added: [] } }, 21), /exactly one added-body summary/);
});

test("mutation revisions may advance while the selected document identity remains fixed", () => {
  assert.doesNotThrow(() => requireSameDocumentIdentity(
    { documentToken: "document-a", revision: "r1" },
    { documentToken: "document-a", revision: "r2" },
  ));
  assert.throws(() => requireSameDocumentIdentity(
    { documentToken: "document-a", revision: "r1" },
    { documentToken: "document-b", revision: "r2" },
  ), /document changed/);
});

test("baseline cleanup compares current scene count, not changed-body pagination count", () => {
  assert.equal(sceneMatchesBaseline({ diff: { sceneChanged: false }, current: { bodyCount: 4 }, bodyPagination: { total: 0 } }, 4), true);
  assert.equal(sceneMatchesBaseline({ diff: { sceneChanged: true }, current: { bodyCount: 4 } }, 4), false);
  assert.equal(sceneMatchesBaseline({ diff: { sceneChanged: false }, current: { bodyCount: 0 }, bodyPagination: { total: 0 } }, 4), false);
});

test("compact diff acceptance is inert by default and with help", () => {
  assert.deepEqual(parseCompactDiffAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
  assert.deepEqual(parseCompactDiffAcceptanceArgs(["--help"]), { help: true, allowDisposableMutations: false });
});

test("compact diff acceptance requires explicit window, mutation guard, and output", () => {
  assert.throws(() => parseCompactDiffAcceptanceArgs(["--target", "window-1", "--output", "/tmp/evidence"]), /requires --allow-disposable-mutations/);
  assert.throws(() => parseCompactDiffAcceptanceArgs(["--allow-disposable-mutations", "--output", "/tmp/evidence"]), /requires --target/);
  assert.throws(() => parseCompactDiffAcceptanceArgs(["--target", "window-1", "--allow-disposable-mutations"]), /requires --output/);
  assert.deepEqual(parseCompactDiffAcceptanceArgs(["--target", "window-1", "--allow-disposable-mutations", "--output", "/tmp/evidence"]), {
    help: false,
    target: "window-1",
    allowDisposableMutations: true,
    output: "/tmp/evidence",
  });
});

test("compact diff acceptance rejects unknown and incomplete arguments", () => {
  assert.throws(() => parseCompactDiffAcceptanceArgs(["--bogus"]), /Unknown argument/);
  assert.throws(() => parseCompactDiffAcceptanceArgs(["--target"]), /requires an explicit Plasticity window ID/);
  assert.throws(() => parseCompactDiffAcceptanceArgs(["--output"]), /requires a new directory path/);
});
