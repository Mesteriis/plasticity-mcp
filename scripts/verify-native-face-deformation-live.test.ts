import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeFaceDeformationAcceptanceArgs } from "./verify-native-face-deformation-live.ts";

test("native-face-deformation acceptance defaults to non-mutating help", () => {
  assert.deepEqual(parseNativeFaceDeformationAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
});

test("native-face-deformation acceptance requires an explicit disposable target and output", () => {
  assert.throws(() => parseNativeFaceDeformationAcceptanceArgs(["--target", "window"]), /allow-disposable-mutations/u);
  assert.throws(() => parseNativeFaceDeformationAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/u);
  assert.deepEqual(parseNativeFaceDeformationAcceptanceArgs([
    "--target", "window", "--allow-disposable-mutations", "--output", "/tmp/evidence",
  ]), { help: false, target: "window", allowDisposableMutations: true, output: "/tmp/evidence" });
});

test("native-face-deformation acceptance rejects unknown and incomplete arguments", () => {
  assert.throws(() => parseNativeFaceDeformationAcceptanceArgs(["--unknown"]), /Unknown argument/u);
  assert.throws(() => parseNativeFaceDeformationAcceptanceArgs(["--target"]), /requires/u);
  assert.throws(() => parseNativeFaceDeformationAcceptanceArgs(["--output"]), /requires/u);
});
