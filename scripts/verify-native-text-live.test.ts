import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeTextAcceptanceArgs } from "./verify-native-text-live.ts";

test("native-text acceptance defaults to non-mutating help", () => {
  assert.deepEqual(parseNativeTextAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
});

test("native-text acceptance requires an explicit disposable target and new output directory", () => {
  assert.throws(() => parseNativeTextAcceptanceArgs(["--target", "window"]), /allow-disposable-mutations/u);
  assert.throws(() => parseNativeTextAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/u);
  assert.deepEqual(parseNativeTextAcceptanceArgs([
    "--target", "window", "--allow-disposable-mutations", "--output", "/tmp/evidence",
  ]), { help: false, target: "window", allowDisposableMutations: true, output: "/tmp/evidence" });
});

test("native-text acceptance rejects unknown and incomplete arguments", () => {
  assert.throws(() => parseNativeTextAcceptanceArgs(["--unknown"]), /Unknown argument/u);
  assert.throws(() => parseNativeTextAcceptanceArgs(["--target"]), /requires/u);
  assert.throws(() => parseNativeTextAcceptanceArgs(["--output"]), /requires/u);
});
