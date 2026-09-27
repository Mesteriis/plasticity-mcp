import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeFacePatternAcceptanceArgs } from "./verify-native-face-patterns-live.ts";

test("native-face-pattern acceptance defaults to non-mutating help", () => {
  assert.deepEqual(parseNativeFacePatternAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
});

test("native-face-pattern acceptance requires an explicit disposable target and output", () => {
  assert.throws(() => parseNativeFacePatternAcceptanceArgs(["--target", "window"]), /allow-disposable-mutations/u);
  assert.throws(() => parseNativeFacePatternAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/u);
  assert.deepEqual(parseNativeFacePatternAcceptanceArgs([
    "--target", "window", "--allow-disposable-mutations", "--output", "/tmp/evidence",
  ]), { help: false, target: "window", allowDisposableMutations: true, output: "/tmp/evidence" });
});

test("native-face-pattern acceptance rejects unknown and incomplete arguments", () => {
  assert.throws(() => parseNativeFacePatternAcceptanceArgs(["--unknown"]), /Unknown argument/u);
  assert.throws(() => parseNativeFacePatternAcceptanceArgs(["--target"]), /requires/u);
  assert.throws(() => parseNativeFacePatternAcceptanceArgs(["--output"]), /requires/u);
});
