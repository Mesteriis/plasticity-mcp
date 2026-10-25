import assert from "node:assert/strict";
import { test } from "node:test";

import { assertPointSetNear, parseNativePatternsRecipesAcceptanceArgs } from "./verify-native-patterns-recipes-live.ts";

test("native patterns-recipes acceptance is inert by default and with help", () => {
  assert.deepEqual(parseNativePatternsRecipesAcceptanceArgs([]), { help: true, allowDisposableMutations: false, case: "mirror-copy" });
  assert.equal(parseNativePatternsRecipesAcceptanceArgs(["--help"]).help, true);
});

test("native patterns-recipes acceptance requires an explicit disposable target, mutation guard, and output", () => {
  assert.throws(() => parseNativePatternsRecipesAcceptanceArgs(["--target", "window"]), /allow-disposable-mutations/u);
  assert.throws(() => parseNativePatternsRecipesAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/u);
  assert.deepEqual(parseNativePatternsRecipesAcceptanceArgs(["--target", "window", "--allow-disposable-mutations", "--output", "/tmp/evidence"]), {
    help: false, case: "mirror-copy", target: "window", allowDisposableMutations: true, output: "/tmp/evidence",
  });
});

test("native patterns-recipes acceptance rejects incomplete and unknown arguments", () => {
  assert.throws(() => parseNativePatternsRecipesAcceptanceArgs(["--unknown"]), /Unknown argument/u);
  assert.throws(() => parseNativePatternsRecipesAcceptanceArgs(["--target"]), /requires a value/u);
  assert.throws(() => parseNativePatternsRecipesAcceptanceArgs(["--output"]), /requires a value/u);
});

test("catalog acceptance selects only known cases", () => {
  assert.throws(() => parseNativePatternsRecipesAcceptanceArgs(["--help", "--case", "unknown"]), /Unknown catalog case/u);
  assert.throws(() => parseNativePatternsRecipesAcceptanceArgs(["--case"]), /requires a value/u);
  assert.equal(parseNativePatternsRecipesAcceptanceArgs(["--help", "--case", "reverse-curves"]).case, "reverse-curves");
});


test("point-set acceptance ignores ordering but consumes each actual point once", () => {
  assert.doesNotThrow(() => assertPointSetNear([[2, 3, 4], [0, 0, 0]], [[0, 0, 0], [2, 3, 4.000001]], 0.00001, "centers"));
  assert.throws(() => assertPointSetNear([[0, 0, 0], [0, 0, 0]], [[0, 0, 0], [1, 0, 0]], 0.001, "centers"), /missing expected point/u);
  assert.throws(() => assertPointSetNear([[0, 0, 0]], [], 0.001, "centers"), /point count mismatch/u);
});

test("point-set acceptance rejects invalid coordinates and tolerances", () => {
  assert.throws(() => assertPointSetNear([[NaN, 0, 0]], [[0, 0, 0]], 1, "centers"), /missing expected point/u);
  assert.throws(() => assertPointSetNear([[0, 0, 0]], [[Infinity, 0, 0]], 1, "centers"), /missing expected point/u);
  assert.throws(() => assertPointSetNear([[0, 0]], [[0, 0, 0]], 1, "centers"), /missing expected point/u);
  assert.throws(() => assertPointSetNear([], [], -1, "centers"), /finite and nonnegative/u);
});
