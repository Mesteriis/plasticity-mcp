import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeFacePropertiesAcceptanceArgs } from "./verify-native-face-properties-live.ts";

test("face-properties acceptance defaults to help and requires explicit live guards", () => {
  assert.deepEqual(parseNativeFacePropertiesAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
  assert.deepEqual(parseNativeFacePropertiesAcceptanceArgs(["--help"]), { help: true, allowDisposableMutations: false });
  assert.throws(() => parseNativeFacePropertiesAcceptanceArgs(["--allow-disposable-mutations", "--output", "/tmp/out"]), /--target/);
  assert.throws(() => parseNativeFacePropertiesAcceptanceArgs(["--target", "window-1", "--output", "/tmp/out"]), /--allow-disposable-mutations/);
  assert.throws(() => parseNativeFacePropertiesAcceptanceArgs(["--target", "window-1", "--allow-disposable-mutations"]), /--output/);
  assert.deepEqual(parseNativeFacePropertiesAcceptanceArgs(["--target", "window-1", "--allow-disposable-mutations", "--output", "/tmp/out"]), { help: false, target: "window-1", allowDisposableMutations: true, output: "/tmp/out" });
});
