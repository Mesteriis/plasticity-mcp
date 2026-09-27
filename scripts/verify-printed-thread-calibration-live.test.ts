import assert from "node:assert/strict";
import test from "node:test";

import { parsePrintedThreadCalibrationAcceptanceArgs } from "./verify-printed-thread-calibration-live.ts";

test("printed-thread calibration live acceptance is inert by default and explicitly guarded", () => {
  assert.deepEqual(parsePrintedThreadCalibrationAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
  assert.throws(() => parsePrintedThreadCalibrationAcceptanceArgs(["--target", "window"]), /allow-disposable-mutations/);
  assert.throws(() => parsePrintedThreadCalibrationAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /output/);
  assert.deepEqual(parsePrintedThreadCalibrationAcceptanceArgs([
    "--target", "window",
    "--allow-disposable-mutations",
    "--output", "/tmp/calibration-evidence",
  ]), {
    help: false,
    target: "window",
    allowDisposableMutations: true,
    output: "/tmp/calibration-evidence",
  });
});
