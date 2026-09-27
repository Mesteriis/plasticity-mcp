import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeCurveLoftAcceptanceArgs } from "./verify-native-curve-loft-live.ts";

test("native curve loft acceptance is inert by default", () => {
  assert.deepEqual(parseNativeCurveLoftAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
  assert.deepEqual(parseNativeCurveLoftAcceptanceArgs(["--help"]), { help: true, allowDisposableMutations: false });
});

test("native curve loft acceptance requires target, mutation guard, and output", () => {
  assert.throws(() => parseNativeCurveLoftAcceptanceArgs(["--allow-disposable-mutations", "--output", "/tmp/out"]), /--target/);
  assert.throws(() => parseNativeCurveLoftAcceptanceArgs(["--target", "window-1", "--output", "/tmp/out"]), /--allow-disposable-mutations/);
  assert.throws(() => parseNativeCurveLoftAcceptanceArgs(["--target", "window-1", "--allow-disposable-mutations"]), /--output/);
  assert.deepEqual(parseNativeCurveLoftAcceptanceArgs(["--target", "window-1", "--allow-disposable-mutations", "--output", "/tmp/out"]), {
    help: false, target: "window-1", allowDisposableMutations: true, output: "/tmp/out",
  });
});
