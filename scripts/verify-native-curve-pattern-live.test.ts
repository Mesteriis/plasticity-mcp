import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeCurvePatternAcceptanceArgs } from "./verify-native-curve-pattern-live.ts";

test("native-curve-pattern acceptance defaults to non-mutating help", () => {
  assert.deepEqual(parseNativeCurvePatternAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
});

test("native-curve-pattern acceptance requires an explicit disposable target and output", () => {
  assert.throws(() => parseNativeCurvePatternAcceptanceArgs(["--target", "window"]), /allow-disposable-mutations/u);
  assert.throws(() => parseNativeCurvePatternAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/u);
  assert.deepEqual(parseNativeCurvePatternAcceptanceArgs([
    "--target", "window", "--allow-disposable-mutations", "--output", "/tmp/evidence",
  ]), { help: false, target: "window", allowDisposableMutations: true, output: "/tmp/evidence" });
});

test("native-curve-pattern acceptance rejects unknown and incomplete arguments", () => {
  assert.throws(() => parseNativeCurvePatternAcceptanceArgs(["--unknown"]), /Unknown argument/u);
  assert.throws(() => parseNativeCurvePatternAcceptanceArgs(["--target"]), /requires/u);
  assert.throws(() => parseNativeCurvePatternAcceptanceArgs(["--output"]), /requires/u);
});
