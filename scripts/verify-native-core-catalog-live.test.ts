import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeCoreCatalogAcceptanceArgs } from "./verify-native-core-catalog-live.ts";

test("native core-catalog acceptance is inert by default and with help", () => {
  assert.deepEqual(parseNativeCoreCatalogAcceptanceArgs([]), { help: true, allowDisposableMutations: false, case: "offset-face" });
  assert.equal(parseNativeCoreCatalogAcceptanceArgs(["--help"]).help, true);
});

test("native core-catalog acceptance requires an explicit disposable target, mutation guard, and output", () => {
  assert.throws(() => parseNativeCoreCatalogAcceptanceArgs(["--target", "window"]), /allow-disposable-mutations/u);
  assert.throws(() => parseNativeCoreCatalogAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/u);
  assert.deepEqual(parseNativeCoreCatalogAcceptanceArgs(["--target", "window", "--allow-disposable-mutations", "--output", "/tmp/evidence"]), {
    help: false, case: "offset-face", target: "window", allowDisposableMutations: true, output: "/tmp/evidence",
  });
});

test("native core-catalog acceptance rejects incomplete and unknown arguments", () => {
  assert.throws(() => parseNativeCoreCatalogAcceptanceArgs(["--unknown"]), /Unknown argument/u);
  assert.throws(() => parseNativeCoreCatalogAcceptanceArgs(["--target"]), /requires a value/u);
  assert.throws(() => parseNativeCoreCatalogAcceptanceArgs(["--output"]), /requires a value/u);
});

test("catalog acceptance selects only known cases", () => {
  assert.throws(() => parseNativeCoreCatalogAcceptanceArgs(["--help", "--case", "unknown"]), /Unknown catalog case/u);
  assert.throws(() => parseNativeCoreCatalogAcceptanceArgs(["--case"]), /requires a value/u);
  assert.equal(parseNativeCoreCatalogAcceptanceArgs(["--help", "--case", "pipe"]).case, "pipe");
});
