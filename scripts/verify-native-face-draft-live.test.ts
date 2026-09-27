import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeFaceDraftAcceptanceArgs } from "./verify-native-face-draft-live.ts";

test("face-draft acceptance defaults to help and requires explicit live guards", () => {
  assert.deepEqual(parseNativeFaceDraftAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
  assert.deepEqual(parseNativeFaceDraftAcceptanceArgs(["--help"]), { help: true, allowDisposableMutations: false });
  assert.throws(() => parseNativeFaceDraftAcceptanceArgs(["--allow-disposable-mutations", "--output", "/tmp/out"]), /--target/);
  assert.throws(() => parseNativeFaceDraftAcceptanceArgs(["--target", "window-1", "--output", "/tmp/out"]), /--allow-disposable-mutations/);
  assert.throws(() => parseNativeFaceDraftAcceptanceArgs(["--target", "window-1", "--allow-disposable-mutations"]), /--output/);
  assert.deepEqual(parseNativeFaceDraftAcceptanceArgs(["--target", "window-1", "--allow-disposable-mutations", "--output", "/tmp/out"]), { help: false, target: "window-1", allowDisposableMutations: true, output: "/tmp/out" });
});
