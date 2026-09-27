import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeFaceTransformAcceptanceArgs } from "./verify-native-face-transforms-live.ts";

test("native-face-transform acceptance defaults to non-mutating help", () => {
  assert.deepEqual(parseNativeFaceTransformAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
});

test("native-face-transform acceptance requires an explicit disposable target and output", () => {
  assert.throws(() => parseNativeFaceTransformAcceptanceArgs(["--target", "window"]), /allow-disposable-mutations/u);
  assert.throws(() => parseNativeFaceTransformAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/u);
  assert.deepEqual(parseNativeFaceTransformAcceptanceArgs([
    "--target", "window", "--allow-disposable-mutations", "--output", "/tmp/evidence",
  ]), { help: false, target: "window", allowDisposableMutations: true, output: "/tmp/evidence" });
});

test("native-face-transform acceptance rejects unknown and incomplete arguments", () => {
  assert.throws(() => parseNativeFaceTransformAcceptanceArgs(["--unknown"]), /Unknown argument/u);
  assert.throws(() => parseNativeFaceTransformAcceptanceArgs(["--target"]), /requires/u);
  assert.throws(() => parseNativeFaceTransformAcceptanceArgs(["--output"]), /requires/u);
});
