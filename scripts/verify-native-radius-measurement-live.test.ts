import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeRadiusMeasurementAcceptanceArgs } from "./verify-native-radius-measurement-live.ts";

test("radius-measurement acceptance defaults to help and requires explicit live guards", () => {
  assert.deepEqual(parseNativeRadiusMeasurementAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
  assert.deepEqual(parseNativeRadiusMeasurementAcceptanceArgs(["--help"]), { help: true, allowDisposableMutations: false });
  assert.throws(() => parseNativeRadiusMeasurementAcceptanceArgs(["--allow-disposable-mutations", "--output", "/tmp/out"]), /--target/);
  assert.throws(() => parseNativeRadiusMeasurementAcceptanceArgs(["--target", "window-1", "--output", "/tmp/out"]), /--allow-disposable-mutations/);
  assert.throws(() => parseNativeRadiusMeasurementAcceptanceArgs(["--target", "window-1", "--allow-disposable-mutations"]), /--output/);
  assert.deepEqual(parseNativeRadiusMeasurementAcceptanceArgs(["--target", "window-1", "--allow-disposable-mutations", "--output", "/tmp/out"]), {
    help: false, target: "window-1", allowDisposableMutations: true, output: "/tmp/out",
  });
});
