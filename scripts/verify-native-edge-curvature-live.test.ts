import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeEdgeCurvatureAcceptanceArgs } from "./verify-native-edge-curvature-live.ts";

test("edge-curvature acceptance defaults to help and requires explicit live guards", () => {
  assert.deepEqual(parseNativeEdgeCurvatureAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
  assert.deepEqual(parseNativeEdgeCurvatureAcceptanceArgs(["--help"]), { help: true, allowDisposableMutations: false });
  assert.throws(() => parseNativeEdgeCurvatureAcceptanceArgs(["--allow-disposable-mutations", "--output", "/tmp/out"]), /--target/);
  assert.throws(() => parseNativeEdgeCurvatureAcceptanceArgs(["--target", "window-1", "--output", "/tmp/out"]), /--allow-disposable-mutations/);
  assert.throws(() => parseNativeEdgeCurvatureAcceptanceArgs(["--target", "window-1", "--allow-disposable-mutations"]), /--output/);
  assert.deepEqual(parseNativeEdgeCurvatureAcceptanceArgs(["--target", "window-1", "--allow-disposable-mutations", "--output", "/tmp/out"]), {
    help: false, target: "window-1", allowDisposableMutations: true, output: "/tmp/out",
  });
});
