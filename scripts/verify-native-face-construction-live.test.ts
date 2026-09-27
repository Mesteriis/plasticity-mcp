import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeFaceConstructionAcceptanceArgs } from "./verify-native-face-construction-live.ts";

test("native-face-construction acceptance defaults to non-mutating help", () => {
  assert.deepEqual(parseNativeFaceConstructionAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
});

test("native-face-construction acceptance requires an explicit disposable target and output", () => {
  assert.throws(() => parseNativeFaceConstructionAcceptanceArgs(["--target", "window"]), /allow-disposable-mutations/u);
  assert.throws(() => parseNativeFaceConstructionAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/u);
  assert.deepEqual(parseNativeFaceConstructionAcceptanceArgs([
    "--target", "window", "--allow-disposable-mutations", "--output", "/tmp/evidence",
  ]), { help: false, target: "window", allowDisposableMutations: true, output: "/tmp/evidence" });
});

test("native-face-construction acceptance rejects unknown and incomplete arguments", () => {
  assert.throws(() => parseNativeFaceConstructionAcceptanceArgs(["--unknown"]), /Unknown argument/u);
  assert.throws(() => parseNativeFaceConstructionAcceptanceArgs(["--target"]), /requires/u);
  assert.throws(() => parseNativeFaceConstructionAcceptanceArgs(["--output"]), /requires/u);
});
