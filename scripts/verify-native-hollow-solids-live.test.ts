import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeHollowSolidsAcceptanceArgs } from "./verify-native-hollow-solids-live.ts";

test("native-hollow-solids acceptance defaults to non-mutating help", () => {
  assert.deepEqual(parseNativeHollowSolidsAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
});

test("native-hollow-solids acceptance requires an explicit disposable target and output", () => {
  assert.throws(() => parseNativeHollowSolidsAcceptanceArgs(["--target", "window"]), /allow-disposable-mutations/u);
  assert.throws(() => parseNativeHollowSolidsAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/u);
  assert.deepEqual(parseNativeHollowSolidsAcceptanceArgs([
    "--target", "window", "--allow-disposable-mutations", "--output", "/tmp/evidence",
  ]), { help: false, target: "window", allowDisposableMutations: true, output: "/tmp/evidence" });
});

test("native-hollow-solids acceptance rejects unknown and incomplete arguments", () => {
  assert.throws(() => parseNativeHollowSolidsAcceptanceArgs(["--unknown"]), /Unknown argument/u);
  assert.throws(() => parseNativeHollowSolidsAcceptanceArgs(["--target"]), /requires/u);
  assert.throws(() => parseNativeHollowSolidsAcceptanceArgs(["--output"]), /requires/u);
});
