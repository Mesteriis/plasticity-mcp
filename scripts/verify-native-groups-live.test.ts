import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeGroupAcceptanceArgs } from "./verify-native-groups-live.ts";

test("native-group acceptance requires an explicit disposable target and new output directory", () => {
  assert.deepEqual(parseNativeGroupAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
  assert.throws(() => parseNativeGroupAcceptanceArgs(["--target", "window"]), /allow-disposable-mutations/u);
  assert.throws(() => parseNativeGroupAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/u);
  assert.deepEqual(parseNativeGroupAcceptanceArgs([
    "--target", "window", "--allow-disposable-mutations", "--output", "/tmp/evidence",
  ]), { help: false, target: "window", allowDisposableMutations: true, output: "/tmp/evidence" });
});
