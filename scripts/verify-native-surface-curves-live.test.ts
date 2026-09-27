import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeSurfaceCurveAcceptanceArgs } from "./verify-native-surface-curves-live.ts";

test("native-surface-curve acceptance defaults to non-mutating help", () => {
  assert.deepEqual(parseNativeSurfaceCurveAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
});

test("native-surface-curve acceptance requires an explicit disposable target and output", () => {
  assert.throws(() => parseNativeSurfaceCurveAcceptanceArgs(["--target", "window"]), /allow-disposable-mutations/u);
  assert.throws(() => parseNativeSurfaceCurveAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/u);
  assert.deepEqual(parseNativeSurfaceCurveAcceptanceArgs([
    "--target", "window", "--allow-disposable-mutations", "--output", "/tmp/evidence",
  ]), { help: false, target: "window", allowDisposableMutations: true, output: "/tmp/evidence" });
});

test("native-surface-curve acceptance rejects unknown and incomplete arguments", () => {
  assert.throws(() => parseNativeSurfaceCurveAcceptanceArgs(["--unknown"]), /Unknown argument/u);
  assert.throws(() => parseNativeSurfaceCurveAcceptanceArgs(["--target"]), /requires/u);
  assert.throws(() => parseNativeSurfaceCurveAcceptanceArgs(["--output"]), /requires/u);
});
