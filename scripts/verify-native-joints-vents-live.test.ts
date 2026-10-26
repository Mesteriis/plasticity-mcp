import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeJointsVentsAcceptanceArgs } from "./verify-native-joints-vents-live.ts";

test("native joints-vents acceptance is inert by default and with help", () => {
  assert.deepEqual(parseNativeJointsVentsAcceptanceArgs([]), { help: true, allowDisposableMutations: false, case: "vent-array" });
  assert.equal(parseNativeJointsVentsAcceptanceArgs(["--help"]).help, true);
});

test("native joints-vents acceptance requires an explicit disposable target, mutation guard, and output", () => {
  assert.throws(() => parseNativeJointsVentsAcceptanceArgs(["--target", "window"]), /allow-disposable-mutations/u);
  assert.throws(() => parseNativeJointsVentsAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/u);
  assert.deepEqual(parseNativeJointsVentsAcceptanceArgs(["--target", "window", "--allow-disposable-mutations", "--output", "/tmp/evidence"]), {
    help: false, case: "vent-array", target: "window", allowDisposableMutations: true, output: "/tmp/evidence",
  });
});

test("native joints-vents acceptance rejects incomplete and unknown arguments", () => {
  assert.throws(() => parseNativeJointsVentsAcceptanceArgs(["--unknown"]), /Unknown argument/u);
  assert.throws(() => parseNativeJointsVentsAcceptanceArgs(["--target"]), /requires a value/u);
  assert.throws(() => parseNativeJointsVentsAcceptanceArgs(["--output"]), /requires a value/u);
});

test("catalog acceptance selects only known cases", () => {
  assert.throws(() => parseNativeJointsVentsAcceptanceArgs(["--help", "--case", "unknown"]), /Unknown catalog case/u);
  assert.throws(() => parseNativeJointsVentsAcceptanceArgs(["--case"]), /requires a value/u);
  assert.equal(parseNativeJointsVentsAcceptanceArgs(["--help", "--case", "enclosure"]).case, "enclosure");
  assert.equal(parseNativeJointsVentsAcceptanceArgs(["--help", "--case", "cable-channel-geometry"]).case, "cable-channel-geometry");
});
