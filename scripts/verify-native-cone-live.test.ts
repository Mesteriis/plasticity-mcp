import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeConeAcceptanceArgs } from "./verify-native-cone-live.ts";

test("native-cone acceptance defaults to non-mutating help", () => {
  assert.deepEqual(parseNativeConeAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
});

test("native-cone acceptance requires an explicit disposable target and new output directory", () => {
  assert.throws(() => parseNativeConeAcceptanceArgs(["--target", "window"]), /allow-disposable-mutations/u);
  assert.throws(() => parseNativeConeAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/u);
  assert.deepEqual(parseNativeConeAcceptanceArgs([
    "--target", "window", "--allow-disposable-mutations", "--output", "/tmp/evidence",
  ]), { help: false, target: "window", allowDisposableMutations: true, output: "/tmp/evidence" });
});

test("native-cone acceptance rejects unknown and incomplete arguments", () => {
  assert.throws(() => parseNativeConeAcceptanceArgs(["--unknown"]), /Unknown argument/u);
  assert.throws(() => parseNativeConeAcceptanceArgs(["--target"]), /requires/u);
  assert.throws(() => parseNativeConeAcceptanceArgs(["--output"]), /requires/u);
});
