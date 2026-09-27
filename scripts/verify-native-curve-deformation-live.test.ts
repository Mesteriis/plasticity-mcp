import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeCurveDeformationAcceptanceArgs } from "./verify-native-curve-deformation-live.ts";

test("native-curve-deformation acceptance defaults to non-mutating help", () => {
  assert.deepEqual(parseNativeCurveDeformationAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
});

test("native-curve-deformation acceptance requires an explicit disposable target and output", () => {
  assert.throws(() => parseNativeCurveDeformationAcceptanceArgs(["--target", "window"]), /allow-disposable-mutations/u);
  assert.throws(() => parseNativeCurveDeformationAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/u);
  assert.deepEqual(parseNativeCurveDeformationAcceptanceArgs([
    "--target", "window", "--allow-disposable-mutations", "--output", "/tmp/evidence",
  ]), { help: false, target: "window", allowDisposableMutations: true, output: "/tmp/evidence" });
});

test("native-curve-deformation acceptance rejects unknown and incomplete arguments", () => {
  assert.throws(() => parseNativeCurveDeformationAcceptanceArgs(["--unknown"]), /Unknown argument/u);
  assert.throws(() => parseNativeCurveDeformationAcceptanceArgs(["--target"]), /requires/u);
  assert.throws(() => parseNativeCurveDeformationAcceptanceArgs(["--output"]), /requires/u);
});
