import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeCurveSegmentSplitAcceptanceArgs } from "./verify-native-curve-segment-split-live.ts";

test("native curve-segment split acceptance is inert by default", () => {
  assert.deepEqual(parseNativeCurveSegmentSplitAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
  assert.deepEqual(parseNativeCurveSegmentSplitAcceptanceArgs(["--help"]), { help: true, allowDisposableMutations: false });
});

test("native curve-segment split acceptance requires target, mutation guard, and output", () => {
  assert.throws(() => parseNativeCurveSegmentSplitAcceptanceArgs(["--allow-disposable-mutations", "--output", "/tmp/out"]), /--target/);
  assert.throws(() => parseNativeCurveSegmentSplitAcceptanceArgs(["--target", "window-1", "--output", "/tmp/out"]), /--allow-disposable-mutations/);
  assert.throws(() => parseNativeCurveSegmentSplitAcceptanceArgs(["--target", "window-1", "--allow-disposable-mutations"]), /--output/);
  assert.deepEqual(parseNativeCurveSegmentSplitAcceptanceArgs(["--target", "window-1", "--allow-disposable-mutations", "--output", "/tmp/out"]), {
    help: false, target: "window-1", allowDisposableMutations: true, output: "/tmp/out",
  });
});
