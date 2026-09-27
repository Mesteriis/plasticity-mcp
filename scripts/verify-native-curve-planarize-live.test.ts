import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeCurvePlanarizeAcceptanceArgs } from "./verify-native-curve-planarize-live.ts";

test("native curve planarization acceptance is inert by default", () => {
  assert.deepEqual(parseNativeCurvePlanarizeAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
  assert.deepEqual(parseNativeCurvePlanarizeAcceptanceArgs(["--help"]), { help: true, allowDisposableMutations: false });
});

test("native curve planarization acceptance requires target, mutation guard, and output", () => {
  assert.throws(() => parseNativeCurvePlanarizeAcceptanceArgs(["--allow-disposable-mutations", "--output", "/tmp/out"]), /--target/);
  assert.throws(() => parseNativeCurvePlanarizeAcceptanceArgs(["--target", "window-1", "--output", "/tmp/out"]), /--allow-disposable-mutations/);
  assert.throws(() => parseNativeCurvePlanarizeAcceptanceArgs(["--target", "window-1", "--allow-disposable-mutations"]), /--output/);
  assert.deepEqual(parseNativeCurvePlanarizeAcceptanceArgs(["--target", "window-1", "--allow-disposable-mutations", "--output", "/tmp/out"]), {
    help: false, target: "window-1", allowDisposableMutations: true, output: "/tmp/out",
  });
});
