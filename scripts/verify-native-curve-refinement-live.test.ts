import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeCurveRefinementAcceptanceArgs } from "./verify-native-curve-refinement-live.ts";

test("native curve refinement acceptance is inert by default", () => {
  assert.deepEqual(parseNativeCurveRefinementAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
  assert.deepEqual(parseNativeCurveRefinementAcceptanceArgs(["--help"]), { help: true, allowDisposableMutations: false });
});

test("native curve refinement acceptance requires target, mutation guard, and output", () => {
  assert.throws(() => parseNativeCurveRefinementAcceptanceArgs(["--allow-disposable-mutations", "--output", "/tmp/out"]), /--target/);
  assert.throws(() => parseNativeCurveRefinementAcceptanceArgs(["--target", "window-1", "--output", "/tmp/out"]), /--allow-disposable-mutations/);
  assert.throws(() => parseNativeCurveRefinementAcceptanceArgs(["--target", "window-1", "--allow-disposable-mutations"]), /--output/);
  assert.deepEqual(parseNativeCurveRefinementAcceptanceArgs(["--target", "window-1", "--allow-disposable-mutations", "--output", "/tmp/out"]), {
    help: false, target: "window-1", allowDisposableMutations: true, output: "/tmp/out",
  });
});
