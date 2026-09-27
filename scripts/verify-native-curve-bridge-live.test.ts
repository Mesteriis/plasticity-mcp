import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeCurveBridgeAcceptanceArgs } from "./verify-native-curve-bridge-live.ts";

test("native Curve Bridge acceptance is inert by default", () => {
  assert.deepEqual(parseNativeCurveBridgeAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
  assert.deepEqual(parseNativeCurveBridgeAcceptanceArgs(["--help"]), { help: true, allowDisposableMutations: false });
});

test("native Curve Bridge acceptance requires target, mutation guard, and output", () => {
  assert.throws(() => parseNativeCurveBridgeAcceptanceArgs(["--allow-disposable-mutations", "--output", "/tmp/out"]), /--target/);
  assert.throws(() => parseNativeCurveBridgeAcceptanceArgs(["--target", "window-1", "--output", "/tmp/out"]), /--allow-disposable-mutations/);
  assert.throws(() => parseNativeCurveBridgeAcceptanceArgs(["--target", "window-1", "--allow-disposable-mutations"]), /--output/);
  assert.deepEqual(parseNativeCurveBridgeAcceptanceArgs(["--target", "window-1", "--allow-disposable-mutations", "--output", "/tmp/out"]), {
    help: false, target: "window-1", allowDisposableMutations: true, output: "/tmp/out",
  });
});
