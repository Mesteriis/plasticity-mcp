import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeTorusAcceptanceArgs } from "./verify-native-torus-live.ts";

test("native-torus acceptance defaults to non-mutating help", () => {
  assert.deepEqual(parseNativeTorusAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
});

test("native-torus acceptance requires an explicit disposable target and new output directory", () => {
  assert.throws(() => parseNativeTorusAcceptanceArgs(["--target", "window"]), /allow-disposable-mutations/u);
  assert.throws(() => parseNativeTorusAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/u);
  assert.deepEqual(parseNativeTorusAcceptanceArgs([
    "--target", "window", "--allow-disposable-mutations", "--output", "/tmp/evidence",
  ]), { help: false, target: "window", allowDisposableMutations: true, output: "/tmp/evidence" });
});

test("native-torus acceptance rejects unknown and incomplete arguments", () => {
  assert.throws(() => parseNativeTorusAcceptanceArgs(["--unknown"]), /Unknown argument/u);
  assert.throws(() => parseNativeTorusAcceptanceArgs(["--target"]), /requires/u);
  assert.throws(() => parseNativeTorusAcceptanceArgs(["--output"]), /requires/u);
});
