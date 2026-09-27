import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeClosedWirePatchAcceptanceArgs } from "./verify-native-closed-wire-patch-live.ts";

test("native-closed-Wire-patch acceptance defaults to non-mutating help", () => {
  assert.deepEqual(parseNativeClosedWirePatchAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
});

test("native-closed-Wire-patch acceptance requires an explicit disposable target and output", () => {
  assert.throws(() => parseNativeClosedWirePatchAcceptanceArgs(["--target", "window"]), /allow-disposable-mutations/u);
  assert.throws(() => parseNativeClosedWirePatchAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/u);
  assert.deepEqual(parseNativeClosedWirePatchAcceptanceArgs([
    "--target", "window", "--allow-disposable-mutations", "--output", "/tmp/evidence",
  ]), { help: false, target: "window", allowDisposableMutations: true, output: "/tmp/evidence" });
});

test("native-closed-Wire-patch acceptance rejects unknown and incomplete arguments", () => {
  assert.throws(() => parseNativeClosedWirePatchAcceptanceArgs(["--unknown"]), /Unknown argument/u);
  assert.throws(() => parseNativeClosedWirePatchAcceptanceArgs(["--target"]), /requires/u);
  assert.throws(() => parseNativeClosedWirePatchAcceptanceArgs(["--output"]), /requires/u);
});
