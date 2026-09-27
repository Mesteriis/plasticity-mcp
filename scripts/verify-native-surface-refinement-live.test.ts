import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeSurfaceRefinementAcceptanceArgs } from "./verify-native-surface-refinement-live.ts";

test("native surface-refinement acceptance defaults to nonmutating help", () => {
  assert.deepEqual(parseNativeSurfaceRefinementAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
});

test("native surface-refinement acceptance requires an explicit target, mutation flag, and output", () => {
  assert.throws(() => parseNativeSurfaceRefinementAcceptanceArgs(["--allow-disposable-mutations", "--output", "/tmp/result"]), /--target/);
  assert.throws(() => parseNativeSurfaceRefinementAcceptanceArgs(["--target", "window-1", "--output", "/tmp/result"]), /--allow-disposable-mutations/);
  assert.throws(() => parseNativeSurfaceRefinementAcceptanceArgs(["--target", "window-1", "--allow-disposable-mutations"]), /--output/);
});

test("native surface-refinement acceptance parses guarded live arguments", () => {
  assert.deepEqual(parseNativeSurfaceRefinementAcceptanceArgs([
    "--target", "window-1",
    "--allow-disposable-mutations",
    "--output", "/tmp/result",
  ]), {
    help: false,
    target: "window-1",
    allowDisposableMutations: true,
    output: "/tmp/result",
  });
});
