import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeInstanceAcceptanceArgs } from "./verify-native-instances-live.ts";

test("native-instance acceptance requires an explicit disposable target and new output directory", () => {
  assert.deepEqual(parseNativeInstanceAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
  assert.throws(() => parseNativeInstanceAcceptanceArgs(["--target", "window"]), /allow-disposable-mutations/u);
  assert.throws(() => parseNativeInstanceAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/u);
  assert.deepEqual(parseNativeInstanceAcceptanceArgs([
    "--target", "window", "--allow-disposable-mutations", "--output", "/tmp/evidence",
  ]), { help: false, target: "window", allowDisposableMutations: true, output: "/tmp/evidence" });
});
