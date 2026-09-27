import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeBodyOutlinesAcceptanceArgs } from "./verify-native-body-outlines-live.ts";

test("native-body-outlines acceptance defaults to non-mutating help", () => {
  assert.deepEqual(parseNativeBodyOutlinesAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
});

test("native-body-outlines acceptance requires an explicit disposable target and output", () => {
  assert.throws(() => parseNativeBodyOutlinesAcceptanceArgs(["--target", "window"]), /allow-disposable-mutations/u);
  assert.throws(() => parseNativeBodyOutlinesAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/u);
  assert.deepEqual(parseNativeBodyOutlinesAcceptanceArgs([
    "--target", "window", "--allow-disposable-mutations", "--output", "/tmp/evidence",
  ]), { help: false, target: "window", allowDisposableMutations: true, output: "/tmp/evidence" });
});

test("native-body-outlines acceptance rejects unknown and incomplete arguments", () => {
  assert.throws(() => parseNativeBodyOutlinesAcceptanceArgs(["--unknown"]), /Unknown argument/u);
  assert.throws(() => parseNativeBodyOutlinesAcceptanceArgs(["--target"]), /requires/u);
  assert.throws(() => parseNativeBodyOutlinesAcceptanceArgs(["--output"]), /requires/u);
});
