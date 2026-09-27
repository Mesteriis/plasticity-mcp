import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeToolRouterAcceptanceArgs } from "./verify-native-tool-router-live.ts";

test("native tool-router acceptance defaults to inert help and requires live mutation guards", () => {
  assert.deepEqual(parseNativeToolRouterAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
  assert.deepEqual(parseNativeToolRouterAcceptanceArgs(["--help"]), { help: true, allowDisposableMutations: false });
  assert.throws(() => parseNativeToolRouterAcceptanceArgs(["--allow-disposable-mutations", "--output", "/tmp/out"]), /--target/);
  assert.throws(() => parseNativeToolRouterAcceptanceArgs(["--target", "window-1", "--output", "/tmp/out"]), /--allow-disposable-mutations/);
  assert.throws(() => parseNativeToolRouterAcceptanceArgs(["--target", "window-1", "--allow-disposable-mutations"]), /--output/);
  assert.deepEqual(parseNativeToolRouterAcceptanceArgs(["--target", "window-1", "--allow-disposable-mutations", "--output", "/tmp/out"]), {
    help: false, target: "window-1", allowDisposableMutations: true, output: "/tmp/out",
  });
  assert.throws(() => parseNativeToolRouterAcceptanceArgs(["--target", "window-1", "--allow-disposable-mutations", "--output", "/tmp/out", "--unknown"]), /Unknown argument/);
});
