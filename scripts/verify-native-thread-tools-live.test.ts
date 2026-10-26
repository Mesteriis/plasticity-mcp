import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeThreadToolsAcceptanceArgs } from "./verify-native-thread-tools-live.ts";

test("native thread-tools acceptance is inert by default and with help", () => {
  assert.deepEqual(parseNativeThreadToolsAcceptanceArgs([]), { help: true, allowDisposableMutations: false, case: "external-right" });
  assert.equal(parseNativeThreadToolsAcceptanceArgs(["--help"]).help, true);
});

test("native thread-tools acceptance requires an explicit disposable target, mutation guard, and output", () => {
  assert.throws(() => parseNativeThreadToolsAcceptanceArgs(["--target", "window"]), /allow-disposable-mutations/u);
  assert.throws(() => parseNativeThreadToolsAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/u);
  assert.deepEqual(parseNativeThreadToolsAcceptanceArgs(["--target", "window", "--allow-disposable-mutations", "--output", "/tmp/evidence"]), {
    help: false, case: "external-right", target: "window", allowDisposableMutations: true, output: "/tmp/evidence",
  });
});

test("native thread-tools acceptance rejects incomplete and unknown arguments", () => {
  assert.throws(() => parseNativeThreadToolsAcceptanceArgs(["--unknown"]), /Unknown argument/u);
  assert.throws(() => parseNativeThreadToolsAcceptanceArgs(["--target"]), /requires a value/u);
  assert.throws(() => parseNativeThreadToolsAcceptanceArgs(["--output"]), /requires a value/u);
});

test("catalog acceptance selects only known cases", () => {
  assert.throws(() => parseNativeThreadToolsAcceptanceArgs(["--help", "--case", "unknown"]), /Unknown catalog case/u);
  assert.throws(() => parseNativeThreadToolsAcceptanceArgs(["--case"]), /requires a value/u);
  assert.equal(parseNativeThreadToolsAcceptanceArgs(["--help", "--case", "hex-screw"]).case, "hex-screw");
});
