import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeLifecycleAcceptanceArgs } from "./verify-native-lifecycle-live.ts";

test("native lifecycle acceptance is inert by default and with help", () => {
  assert.deepEqual(parseNativeLifecycleAcceptanceArgs([]), { help: true, allowDisposableMutations: false, case: "appearance" });
  assert.equal(parseNativeLifecycleAcceptanceArgs(["--help"]).help, true);
});

test("native lifecycle acceptance requires an explicit disposable target, mutation guard, and output", () => {
  assert.throws(() => parseNativeLifecycleAcceptanceArgs(["--target", "window"]), /allow-disposable-mutations/u);
  assert.throws(() => parseNativeLifecycleAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/u);
  assert.deepEqual(parseNativeLifecycleAcceptanceArgs(["--target", "window", "--allow-disposable-mutations", "--output", "/tmp/evidence"]), {
    help: false, case: "appearance", target: "window", allowDisposableMutations: true, output: "/tmp/evidence",
  });
});

test("native lifecycle acceptance rejects incomplete and unknown arguments", () => {
  assert.throws(() => parseNativeLifecycleAcceptanceArgs(["--unknown"]), /Unknown argument/u);
  assert.throws(() => parseNativeLifecycleAcceptanceArgs(["--target"]), /requires a value/u);
  assert.throws(() => parseNativeLifecycleAcceptanceArgs(["--output"]), /requires a value/u);
});

test("catalog acceptance selects only known cases", () => {
  assert.throws(() => parseNativeLifecycleAcceptanceArgs(["--help", "--case", "unknown"]), /Unknown catalog case/u);
  assert.throws(() => parseNativeLifecycleAcceptanceArgs(["--case"]), /requires a value/u);
  assert.equal(parseNativeLifecycleAcceptanceArgs(["--help", "--case", "surface-bridge"]).case, "surface-bridge");
});
