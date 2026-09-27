import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeParasolidAcceptanceArgs } from "./verify-native-parasolid-live.ts";

test("native-parasolid acceptance defaults to non-mutating help", () => {
  assert.deepEqual(parseNativeParasolidAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
});

test("native-parasolid acceptance requires an explicit disposable target and new output directory", () => {
  assert.throws(() => parseNativeParasolidAcceptanceArgs(["--target", "window"]), /allow-disposable-mutations/u);
  assert.throws(() => parseNativeParasolidAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/u);
  assert.deepEqual(parseNativeParasolidAcceptanceArgs([
    "--target", "window", "--allow-disposable-mutations", "--output", "/tmp/evidence",
  ]), { help: false, target: "window", allowDisposableMutations: true, output: "/tmp/evidence" });
});

test("native-parasolid acceptance rejects unknown and incomplete arguments", () => {
  assert.throws(() => parseNativeParasolidAcceptanceArgs(["--unknown"]), /Unknown argument/u);
  assert.throws(() => parseNativeParasolidAcceptanceArgs(["--target"]), /requires/u);
  assert.throws(() => parseNativeParasolidAcceptanceArgs(["--output"]), /requires/u);
});
