import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeThreeMfExportAcceptanceArgs } from "./verify-native-3mf-export-live.ts";

test("native-3mf-export acceptance defaults to non-mutating help", () => {
  assert.deepEqual(parseNativeThreeMfExportAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
});

test("native-3mf-export acceptance requires an explicit disposable target and new output directory", () => {
  assert.throws(() => parseNativeThreeMfExportAcceptanceArgs(["--target", "window"]), /allow-disposable-mutations/u);
  assert.throws(() => parseNativeThreeMfExportAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/u);
  assert.deepEqual(parseNativeThreeMfExportAcceptanceArgs([
    "--target", "window", "--allow-disposable-mutations", "--output", "/tmp/evidence",
  ]), { help: false, target: "window", allowDisposableMutations: true, output: "/tmp/evidence" });
});

test("native-3mf-export acceptance rejects unknown and incomplete arguments", () => {
  assert.throws(() => parseNativeThreeMfExportAcceptanceArgs(["--unknown"]), /Unknown argument/u);
  assert.throws(() => parseNativeThreeMfExportAcceptanceArgs(["--target"]), /requires/u);
  assert.throws(() => parseNativeThreeMfExportAcceptanceArgs(["--output"]), /requires/u);
});
