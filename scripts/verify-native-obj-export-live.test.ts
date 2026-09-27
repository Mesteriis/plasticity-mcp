import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeObjExportAcceptanceArgs } from "./verify-native-obj-export-live.ts";

test("native-obj-export acceptance defaults to non-mutating help", () => {
  assert.deepEqual(parseNativeObjExportAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
});

test("native-obj-export acceptance requires an explicit disposable target and new output directory", () => {
  assert.throws(() => parseNativeObjExportAcceptanceArgs(["--target", "window"]), /allow-disposable-mutations/u);
  assert.throws(() => parseNativeObjExportAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/u);
  assert.deepEqual(parseNativeObjExportAcceptanceArgs([
    "--target", "window", "--allow-disposable-mutations", "--output", "/tmp/evidence",
  ]), { help: false, target: "window", allowDisposableMutations: true, output: "/tmp/evidence" });
});

test("native-obj-export acceptance rejects unknown and incomplete arguments", () => {
  assert.throws(() => parseNativeObjExportAcceptanceArgs(["--unknown"]), /Unknown argument/u);
  assert.throws(() => parseNativeObjExportAcceptanceArgs(["--target"]), /requires/u);
  assert.throws(() => parseNativeObjExportAcceptanceArgs(["--output"]), /requires/u);
});
