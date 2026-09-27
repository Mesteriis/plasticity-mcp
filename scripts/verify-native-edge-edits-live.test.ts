import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeEdgeEditAcceptanceArgs } from "./verify-native-edge-edits-live.ts";

test("native-edge-edit acceptance defaults to non-mutating help", () => {
  assert.deepEqual(parseNativeEdgeEditAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
});

test("native-edge-edit acceptance requires an explicit disposable target and output", () => {
  assert.throws(() => parseNativeEdgeEditAcceptanceArgs(["--target", "window"]), /allow-disposable-mutations/u);
  assert.throws(() => parseNativeEdgeEditAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/u);
  assert.deepEqual(parseNativeEdgeEditAcceptanceArgs([
    "--target", "window", "--allow-disposable-mutations", "--output", "/tmp/evidence",
  ]), { help: false, target: "window", allowDisposableMutations: true, output: "/tmp/evidence" });
});

test("native-edge-edit acceptance rejects unknown and incomplete arguments", () => {
  assert.throws(() => parseNativeEdgeEditAcceptanceArgs(["--unknown"]), /Unknown argument/u);
  assert.throws(() => parseNativeEdgeEditAcceptanceArgs(["--target"]), /requires/u);
  assert.throws(() => parseNativeEdgeEditAcceptanceArgs(["--output"]), /requires/u);
});
