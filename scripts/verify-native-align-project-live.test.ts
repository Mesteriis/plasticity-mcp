import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeAlignProjectAcceptanceArgs } from "./verify-native-align-project-live.ts";

test("native align-project acceptance is inert by default and with help", () => {
  assert.deepEqual(parseNativeAlignProjectAcceptanceArgs([]), { help: true, allowDisposableMutations: false, case: "align-vertices" });
  assert.equal(parseNativeAlignProjectAcceptanceArgs(["--help"]).help, true);
});

test("native align-project acceptance requires an explicit disposable target, mutation guard, and output", () => {
  assert.throws(() => parseNativeAlignProjectAcceptanceArgs(["--target", "window"]), /allow-disposable-mutations/u);
  assert.throws(() => parseNativeAlignProjectAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/u);
  assert.deepEqual(parseNativeAlignProjectAcceptanceArgs(["--target", "window", "--allow-disposable-mutations", "--output", "/tmp/evidence"]), {
    help: false, case: "align-vertices", target: "window", allowDisposableMutations: true, output: "/tmp/evidence",
  });
});

test("native align-project acceptance rejects incomplete and unknown arguments", () => {
  assert.throws(() => parseNativeAlignProjectAcceptanceArgs(["--unknown"]), /Unknown argument/u);
  assert.throws(() => parseNativeAlignProjectAcceptanceArgs(["--target"]), /requires a value/u);
  assert.throws(() => parseNativeAlignProjectAcceptanceArgs(["--output"]), /requires a value/u);
});

test("catalog acceptance selects only known cases", () => {
  assert.throws(() => parseNativeAlignProjectAcceptanceArgs(["--help", "--case", "unknown"]), /Unknown catalog case/u);
  assert.throws(() => parseNativeAlignProjectAcceptanceArgs(["--case"]), /requires a value/u);
  assert.equal(parseNativeAlignProjectAcceptanceArgs(["--help", "--case", "named-selection"]).case, "named-selection");
});
