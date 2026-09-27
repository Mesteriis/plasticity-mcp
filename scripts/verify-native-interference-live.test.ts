import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeInterferenceAcceptanceArgs } from "./verify-native-interference-live.ts";

test("native-interference acceptance defaults to non-mutating help", () => {
  assert.deepEqual(parseNativeInterferenceAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
});

test("native-interference acceptance requires an explicit disposable target and new output directory", () => {
  assert.throws(() => parseNativeInterferenceAcceptanceArgs(["--target", "window"]), /allow-disposable-mutations/u);
  assert.throws(() => parseNativeInterferenceAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/u);
  assert.deepEqual(parseNativeInterferenceAcceptanceArgs([
    "--target", "window", "--allow-disposable-mutations", "--output", "/tmp/evidence",
  ]), { help: false, target: "window", allowDisposableMutations: true, output: "/tmp/evidence" });
});

test("native-interference acceptance rejects unknown and incomplete arguments", () => {
  assert.throws(() => parseNativeInterferenceAcceptanceArgs(["--unknown"]), /Unknown argument/u);
  assert.throws(() => parseNativeInterferenceAcceptanceArgs(["--target"]), /requires/u);
  assert.throws(() => parseNativeInterferenceAcceptanceArgs(["--output"]), /requires/u);
});
