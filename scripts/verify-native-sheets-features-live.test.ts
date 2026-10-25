import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeSheetsFeaturesAcceptanceArgs } from "./verify-native-sheets-features-live.ts";

test("native sheets-features acceptance is inert by default and with help", () => {
  assert.deepEqual(parseNativeSheetsFeaturesAcceptanceArgs([]), { help: true, allowDisposableMutations: false, case: "patch-region" });
  assert.equal(parseNativeSheetsFeaturesAcceptanceArgs(["--help"]).help, true);
});

test("native sheets-features acceptance requires an explicit disposable target, mutation guard, and output", () => {
  assert.throws(() => parseNativeSheetsFeaturesAcceptanceArgs(["--target", "window"]), /allow-disposable-mutations/u);
  assert.throws(() => parseNativeSheetsFeaturesAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/u);
  assert.deepEqual(parseNativeSheetsFeaturesAcceptanceArgs(["--target", "window", "--allow-disposable-mutations", "--output", "/tmp/evidence"]), {
    help: false, case: "patch-region", target: "window", allowDisposableMutations: true, output: "/tmp/evidence",
  });
});

test("native sheets-features acceptance rejects incomplete and unknown arguments", () => {
  assert.throws(() => parseNativeSheetsFeaturesAcceptanceArgs(["--unknown"]), /Unknown argument/u);
  assert.throws(() => parseNativeSheetsFeaturesAcceptanceArgs(["--target"]), /requires a value/u);
  assert.throws(() => parseNativeSheetsFeaturesAcceptanceArgs(["--output"]), /requires a value/u);
});

test("catalog acceptance selects only known cases", () => {
  assert.throws(() => parseNativeSheetsFeaturesAcceptanceArgs(["--help", "--case", "unknown"]), /Unknown catalog case/u);
  assert.throws(() => parseNativeSheetsFeaturesAcceptanceArgs(["--case"]), /requires a value/u);
  assert.equal(parseNativeSheetsFeaturesAcceptanceArgs(["--help", "--case", "rib"]).case, "rib");
});
