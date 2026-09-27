import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeCurveFilletAcceptanceArgs } from "./verify-native-curve-fillet-live.ts";

test("native-curve-fillet acceptance defaults to non-mutating help", () => {
  assert.deepEqual(parseNativeCurveFilletAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
});

test("native-curve-fillet acceptance requires an explicit disposable target and output", () => {
  assert.throws(() => parseNativeCurveFilletAcceptanceArgs(["--target", "window"]), /allow-disposable-mutations/u);
  assert.throws(() => parseNativeCurveFilletAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/u);
  assert.deepEqual(parseNativeCurveFilletAcceptanceArgs([
    "--target", "window", "--allow-disposable-mutations", "--output", "/tmp/evidence",
  ]), { help: false, target: "window", allowDisposableMutations: true, output: "/tmp/evidence" });
});

test("native-curve-fillet acceptance rejects unknown and incomplete arguments", () => {
  assert.throws(() => parseNativeCurveFilletAcceptanceArgs(["--unknown"]), /Unknown argument/u);
  assert.throws(() => parseNativeCurveFilletAcceptanceArgs(["--target"]), /requires/u);
  assert.throws(() => parseNativeCurveFilletAcceptanceArgs(["--output"]), /requires/u);
});
