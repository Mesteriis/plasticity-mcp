import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeCurveControlPointAcceptanceArgs } from "./verify-native-curve-control-points-live.ts";

test("native curve control-point acceptance is inert without explicit arguments", () => {
  assert.deepEqual(parseNativeCurveControlPointAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
  assert.deepEqual(parseNativeCurveControlPointAcceptanceArgs(["--help"]), { help: true, allowDisposableMutations: false });
});

test("native curve control-point acceptance requires an explicit target, mutation flag, and new output directory", () => {
  assert.throws(() => parseNativeCurveControlPointAcceptanceArgs(["--allow-disposable-mutations", "--output", "/tmp/evidence"]), /--target/);
  assert.throws(() => parseNativeCurveControlPointAcceptanceArgs(["--target", "window-1", "--output", "/tmp/evidence"]), /--allow-disposable-mutations/);
  assert.throws(() => parseNativeCurveControlPointAcceptanceArgs(["--target", "window-1", "--allow-disposable-mutations"]), /--output/);
});

test("native curve control-point acceptance parses its guarded live mode", () => {
  assert.deepEqual(parseNativeCurveControlPointAcceptanceArgs([
    "--target", "window-1",
    "--allow-disposable-mutations",
    "--output", "/tmp/evidence",
  ]), {
    help: false,
    target: "window-1",
    allowDisposableMutations: true,
    output: "/tmp/evidence",
  });
});
