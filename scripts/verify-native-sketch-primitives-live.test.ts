import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeSketchPrimitivesAcceptanceArgs } from "./verify-native-sketch-primitives-live.ts";

test("native sketch primitives acceptance is inert by default", () => {
  assert.deepEqual(parseNativeSketchPrimitivesAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
  assert.deepEqual(parseNativeSketchPrimitivesAcceptanceArgs(["--help"]), { help: true, allowDisposableMutations: false });
});

test("native sketch primitives acceptance requires an explicit target, mutation guard, and new output directory", () => {
  assert.throws(() => parseNativeSketchPrimitivesAcceptanceArgs(["--allow-disposable-mutations", "--output", "/tmp/out"]), /--target/);
  assert.throws(() => parseNativeSketchPrimitivesAcceptanceArgs(["--target", "window-1", "--output", "/tmp/out"]), /--allow-disposable-mutations/);
  assert.throws(() => parseNativeSketchPrimitivesAcceptanceArgs(["--target", "window-1", "--allow-disposable-mutations"]), /--output/);
  assert.deepEqual(parseNativeSketchPrimitivesAcceptanceArgs([
    "--target", "window-1", "--allow-disposable-mutations", "--output", "/tmp/out",
  ]), {
    help: false,
    target: "window-1",
    allowDisposableMutations: true,
    output: "/tmp/out",
  });
});

