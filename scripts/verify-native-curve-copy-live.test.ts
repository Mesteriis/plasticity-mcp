import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeCurveCopyAcceptanceArgs } from "./verify-native-curve-copy-live.ts";

test("native curve-copy acceptance defaults to nonmutating help", () => {
  assert.deepEqual(parseNativeCurveCopyAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
});

test("native curve-copy acceptance requires an explicit target, mutation flag, and output", () => {
  assert.throws(() => parseNativeCurveCopyAcceptanceArgs(["--allow-disposable-mutations", "--output", "/tmp/result"]), /--target/);
  assert.throws(() => parseNativeCurveCopyAcceptanceArgs(["--target", "window-1", "--output", "/tmp/result"]), /--allow-disposable-mutations/);
  assert.throws(() => parseNativeCurveCopyAcceptanceArgs(["--target", "window-1", "--allow-disposable-mutations"]), /--output/);
});

test("native curve-copy acceptance parses guarded live arguments", () => {
  assert.deepEqual(parseNativeCurveCopyAcceptanceArgs([
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
