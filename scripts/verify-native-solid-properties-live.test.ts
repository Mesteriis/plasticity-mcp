import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeSolidPropertiesAcceptanceArgs } from "./verify-native-solid-properties-live.ts";

test("native-solid-properties acceptance defaults to non-mutating help", () => {
  assert.deepEqual(parseNativeSolidPropertiesAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
});

test("native-solid-properties acceptance requires an explicit disposable target and new output directory", () => {
  assert.throws(() => parseNativeSolidPropertiesAcceptanceArgs(["--target", "window"]), /allow-disposable-mutations/u);
  assert.throws(() => parseNativeSolidPropertiesAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/u);
  assert.deepEqual(parseNativeSolidPropertiesAcceptanceArgs([
    "--target", "window", "--allow-disposable-mutations", "--output", "/tmp/evidence",
  ]), { help: false, target: "window", allowDisposableMutations: true, output: "/tmp/evidence" });
});

test("native-solid-properties acceptance rejects unknown and incomplete arguments", () => {
  assert.throws(() => parseNativeSolidPropertiesAcceptanceArgs(["--unknown"]), /Unknown argument/u);
  assert.throws(() => parseNativeSolidPropertiesAcceptanceArgs(["--target"]), /requires/u);
  assert.throws(() => parseNativeSolidPropertiesAcceptanceArgs(["--output"]), /requires/u);
});
