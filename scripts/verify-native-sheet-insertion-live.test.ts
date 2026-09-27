import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeSheetInsertionAcceptanceArgs } from "./verify-native-sheet-insertion-live.ts";

test("native-sheet-insertion acceptance defaults to non-mutating help", () => {
  assert.deepEqual(parseNativeSheetInsertionAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
});

test("native-sheet-insertion acceptance requires an explicit disposable target and output", () => {
  assert.throws(() => parseNativeSheetInsertionAcceptanceArgs(["--target", "window"]), /allow-disposable-mutations/u);
  assert.throws(() => parseNativeSheetInsertionAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/u);
  assert.deepEqual(parseNativeSheetInsertionAcceptanceArgs([
    "--target", "window", "--allow-disposable-mutations", "--output", "/tmp/evidence",
  ]), { help: false, target: "window", allowDisposableMutations: true, output: "/tmp/evidence" });
});

test("native-sheet-insertion acceptance rejects unknown and incomplete arguments", () => {
  assert.throws(() => parseNativeSheetInsertionAcceptanceArgs(["--unknown"]), /Unknown argument/u);
  assert.throws(() => parseNativeSheetInsertionAcceptanceArgs(["--target"]), /requires/u);
  assert.throws(() => parseNativeSheetInsertionAcceptanceArgs(["--output"]), /requires/u);
});
