import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeSvgExportAcceptanceArgs } from "./verify-native-svg-export-live.ts";

test("native SVG export acceptance defaults to non-connecting help", () => {
  assert.deepEqual(parseNativeSvgExportAcceptanceArgs([]), { help: true, allowLive: false });
});

test("native SVG export acceptance requires an explicit target, Wire ID, output, and live guard", () => {
  assert.throws(() => parseNativeSvgExportAcceptanceArgs(["--target", "window"]), /--wire-id/u);
  assert.throws(() => parseNativeSvgExportAcceptanceArgs(["--target", "window", "--wire-id", "3"]), /--allow-live/u);
  assert.throws(() => parseNativeSvgExportAcceptanceArgs(["--target", "window", "--wire-id", "3", "--allow-live"]), /--output/u);
  assert.deepEqual(parseNativeSvgExportAcceptanceArgs([
    "--target", "window", "--wire-id", "3", "--allow-live", "--output", "/tmp/svg-export",
  ]), { help: false, target: "window", wireId: 3, allowLive: true, output: "/tmp/svg-export" });
});

test("native SVG export acceptance rejects malformed arguments and Wire IDs", () => {
  assert.throws(() => parseNativeSvgExportAcceptanceArgs(["--unknown"]), /Unknown argument/u);
  assert.throws(() => parseNativeSvgExportAcceptanceArgs(["--target"]), /requires a value/u);
  assert.throws(() => parseNativeSvgExportAcceptanceArgs(["--wire-id", "0"]), /positive integer/u);
});
