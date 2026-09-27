import assert from "node:assert/strict";
import test from "node:test";

import {
  hasSceneContentChanges,
  parseSectionAcceptanceArgs,
  sanitizeEvidence,
} from "./verify-section-strength-live.ts";

test("help and default modes cannot enable live section work", () => {
  assert.deepEqual(parseSectionAcceptanceArgs([]), {
    help: true,
    allowDisposableMutations: false,
  });
  assert.equal(parseSectionAcceptanceArgs(["--help"]).help, true);
});

test("live section acceptance requires target, mutation acknowledgement and new output", () => {
  assert.throws(
    () => parseSectionAcceptanceArgs(["--target", "window", "--output", "/tmp/new"]),
    /allow-disposable-mutations/i,
  );
  assert.throws(
    () => parseSectionAcceptanceArgs(["--allow-disposable-mutations", "--output", "/tmp/new"]),
    /target/i,
  );
  assert.throws(
    () => parseSectionAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]),
    /output/i,
  );
  assert.deepEqual(
    parseSectionAcceptanceArgs([
      "--target", "window-1",
      "--allow-disposable-mutations",
      "--output", "/tmp/new-output",
    ]),
    {
      help: false,
      target: "window-1",
      allowDisposableMutations: true,
      output: "/tmp/new-output",
    },
  );
});

test("unknown and incomplete section arguments are rejected", () => {
  assert.throws(() => parseSectionAcceptanceArgs(["--target"]), /requires/i);
  assert.throws(() => parseSectionAcceptanceArgs(["--unknown"]), /unknown/i);
});

test("sanitized evidence rejects secrets, native dumps and full prompts", () => {
  assert.deepEqual(sanitizeEvidence({
    targetId: "window-1",
    password: "secret",
    prompt: "full prompt",
    nativeDump: { private: true },
    measured: { areaMm2: 200 },
  }), {
    targetId: "window-1",
    measured: { areaMm2: 200 },
  });
});

test("cleanup distinguishes history-only changes from remaining scene content", () => {
  const empty = {
    documentChanged: false,
    added: [],
    removed: [],
    modified: [],
    constructionPlanesAdded: [],
    constructionPlanesRemoved: [],
    constructionPlanesModified: [],
    activeWorkplaneChanged: null,
  };
  assert.equal(hasSceneContentChanges(empty), false);
  assert.equal(hasSceneContentChanges({ ...empty, modified: [{ id: 1 }] }), true);
  assert.equal(hasSceneContentChanges({ ...empty, documentChanged: true }), true);
  assert.equal(hasSceneContentChanges({ ...empty, groupsChanged: true }), true);
});
