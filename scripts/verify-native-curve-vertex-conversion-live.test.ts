import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeCurveVertexConversionAcceptanceArgs } from "./verify-native-curve-vertex-conversion-live.ts";

test("native curve-vertex-conversion acceptance defaults to non-mutating help", () => {
  assert.deepEqual(parseNativeCurveVertexConversionAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
});

test("native curve-vertex-conversion acceptance requires an explicit target, disposable mutations and output", () => {
  assert.throws(() => parseNativeCurveVertexConversionAcceptanceArgs(["--target", "window"]), /allow-disposable-mutations/u);
  assert.throws(() => parseNativeCurveVertexConversionAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/u);
  assert.deepEqual(parseNativeCurveVertexConversionAcceptanceArgs([
    "--target", "window", "--allow-disposable-mutations", "--output", "/tmp/evidence",
  ]), { help: false, target: "window", allowDisposableMutations: true, output: "/tmp/evidence" });
});

test("native curve-vertex-conversion acceptance rejects unknown and incomplete arguments", () => {
  assert.throws(() => parseNativeCurveVertexConversionAcceptanceArgs(["--unknown"]), /Unknown argument/u);
  assert.throws(() => parseNativeCurveVertexConversionAcceptanceArgs(["--target"]), /requires/u);
  assert.throws(() => parseNativeCurveVertexConversionAcceptanceArgs(["--output"]), /requires/u);
});
