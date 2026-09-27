import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeCurveRebuildAcceptanceArgs } from "./verify-native-curve-rebuild-live.ts";

test("native curve rebuild acceptance is inert by default", () => {
  assert.deepEqual(parseNativeCurveRebuildAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
  assert.deepEqual(parseNativeCurveRebuildAcceptanceArgs(["--help"]), { help: true, allowDisposableMutations: false });
});

test("native curve rebuild acceptance requires target, mutation guard, and output", () => {
  assert.throws(() => parseNativeCurveRebuildAcceptanceArgs(["--allow-disposable-mutations", "--output", "/tmp/out"]), /--target/);
  assert.throws(() => parseNativeCurveRebuildAcceptanceArgs(["--target", "window-1", "--output", "/tmp/out"]), /--allow-disposable-mutations/);
  assert.throws(() => parseNativeCurveRebuildAcceptanceArgs(["--target", "window-1", "--allow-disposable-mutations"]), /--output/);
  assert.deepEqual(parseNativeCurveRebuildAcceptanceArgs(["--target", "window-1", "--allow-disposable-mutations", "--output", "/tmp/out"]), {
    help: false, target: "window-1", allowDisposableMutations: true, output: "/tmp/out",
  });
});

