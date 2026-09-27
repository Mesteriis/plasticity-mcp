import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeVertexOffsetAcceptanceArgs } from "./verify-native-vertex-offset-live.ts";

test("native-vertex-offset acceptance defaults to non-mutating help", () => {
  assert.deepEqual(parseNativeVertexOffsetAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
});

test("native-vertex-offset acceptance requires an explicit disposable target and output", () => {
  assert.throws(() => parseNativeVertexOffsetAcceptanceArgs(["--target", "window"]), /allow-disposable-mutations/u);
  assert.throws(() => parseNativeVertexOffsetAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/u);
  assert.deepEqual(parseNativeVertexOffsetAcceptanceArgs([
    "--target", "window", "--allow-disposable-mutations", "--output", "/tmp/evidence",
  ]), { help: false, target: "window", allowDisposableMutations: true, output: "/tmp/evidence" });
});

test("native-vertex-offset acceptance rejects unknown and incomplete arguments", () => {
  assert.throws(() => parseNativeVertexOffsetAcceptanceArgs(["--unknown"]), /Unknown argument/u);
  assert.throws(() => parseNativeVertexOffsetAcceptanceArgs(["--target"]), /requires/u);
  assert.throws(() => parseNativeVertexOffsetAcceptanceArgs(["--output"]), /requires/u);
});
