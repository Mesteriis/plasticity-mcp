import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeRectangleAcceptanceArgs } from "./verify-native-rectangle-live.ts";

test("native-rectangle acceptance defaults to non-mutating help", () => {
  assert.deepEqual(parseNativeRectangleAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
});

test("native-rectangle acceptance requires an explicit disposable target and new output directory", () => {
  assert.throws(() => parseNativeRectangleAcceptanceArgs(["--target", "window"]), /allow-disposable-mutations/u);
  assert.throws(() => parseNativeRectangleAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/u);
  assert.deepEqual(parseNativeRectangleAcceptanceArgs([
    "--target", "window", "--allow-disposable-mutations", "--output", "/tmp/evidence",
  ]), { help: false, target: "window", allowDisposableMutations: true, output: "/tmp/evidence" });
});

test("native-rectangle acceptance rejects unknown and incomplete arguments", () => {
  assert.throws(() => parseNativeRectangleAcceptanceArgs(["--unknown"]), /Unknown argument/u);
  assert.throws(() => parseNativeRectangleAcceptanceArgs(["--target"]), /requires/u);
  assert.throws(() => parseNativeRectangleAcceptanceArgs(["--output"]), /requires/u);
});
