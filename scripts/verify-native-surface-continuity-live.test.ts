import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeSurfaceContinuityAcceptanceArgs } from "./verify-native-surface-continuity-live.ts";

test("surface-continuity acceptance defaults to help and requires explicit live guards", () => {
  assert.deepEqual(parseNativeSurfaceContinuityAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
  assert.deepEqual(parseNativeSurfaceContinuityAcceptanceArgs(["--help"]), { help: true, allowDisposableMutations: false });
  assert.throws(() => parseNativeSurfaceContinuityAcceptanceArgs(["--allow-disposable-mutations", "--output", "/tmp/out"]), /--target/);
  assert.throws(() => parseNativeSurfaceContinuityAcceptanceArgs(["--target", "window-1", "--output", "/tmp/out"]), /--allow-disposable-mutations/);
  assert.throws(() => parseNativeSurfaceContinuityAcceptanceArgs(["--target", "window-1", "--allow-disposable-mutations"]), /--output/);
  assert.deepEqual(parseNativeSurfaceContinuityAcceptanceArgs(["--target", "window-1", "--allow-disposable-mutations", "--output", "/tmp/out"]), {
    help: false, target: "window-1", allowDisposableMutations: true, output: "/tmp/out",
  });
});
