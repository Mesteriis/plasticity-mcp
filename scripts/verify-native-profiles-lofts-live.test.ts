import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeProfilesLoftsAcceptanceArgs } from "./verify-native-profiles-lofts-live.ts";

test("native profiles-lofts acceptance is inert by default and with help", () => {
  assert.deepEqual(parseNativeProfilesLoftsAcceptanceArgs([]), { help: true, allowDisposableMutations: false, case: "offset-outward" });
  assert.equal(parseNativeProfilesLoftsAcceptanceArgs(["--help"]).help, true);
});

test("native profiles-lofts acceptance requires an explicit disposable target, mutation guard, and output", () => {
  assert.throws(() => parseNativeProfilesLoftsAcceptanceArgs(["--target", "window"]), /allow-disposable-mutations/u);
  assert.throws(() => parseNativeProfilesLoftsAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/u);
  assert.deepEqual(parseNativeProfilesLoftsAcceptanceArgs(["--target", "window", "--allow-disposable-mutations", "--output", "/tmp/evidence"]), {
    help: false, case: "offset-outward", target: "window", allowDisposableMutations: true, output: "/tmp/evidence",
  });
});

test("native profiles-lofts acceptance rejects incomplete and unknown arguments", () => {
  assert.throws(() => parseNativeProfilesLoftsAcceptanceArgs(["--unknown"]), /Unknown argument/u);
  assert.throws(() => parseNativeProfilesLoftsAcceptanceArgs(["--target"]), /requires a value/u);
  assert.throws(() => parseNativeProfilesLoftsAcceptanceArgs(["--output"]), /requires a value/u);
});

test("catalog acceptance selects only known cases", () => {
  assert.throws(() => parseNativeProfilesLoftsAcceptanceArgs(["--help", "--case", "unknown"]), /Unknown catalog case/u);
  assert.throws(() => parseNativeProfilesLoftsAcceptanceArgs(["--case"]), /requires a value/u);
  assert.equal(parseNativeProfilesLoftsAcceptanceArgs(["--help", "--case", "cap-sheet"]).case, "cap-sheet");
});
