import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeSphereAcceptanceArgs } from "./verify-native-sphere-live.ts";

test("native sphere acceptance is inert by default and with help", () => {
  assert.deepEqual(parseNativeSphereAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
  assert.equal(parseNativeSphereAcceptanceArgs(["--help"]).help, true);
});

test("native sphere acceptance requires an explicit disposable target, mutation guard, and output", () => {
  assert.throws(() => parseNativeSphereAcceptanceArgs(["--target", "window"]), /allow-disposable-mutations/u);
  assert.throws(() => parseNativeSphereAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/u);
  assert.deepEqual(parseNativeSphereAcceptanceArgs(["--target", "window", "--allow-disposable-mutations", "--output", "/tmp/evidence"]), {
    help: false, target: "window", allowDisposableMutations: true, output: "/tmp/evidence",
  });
});

test("native sphere acceptance rejects incomplete and unknown arguments", () => {
  assert.throws(() => parseNativeSphereAcceptanceArgs(["--unknown"]), /Unknown argument/u);
  assert.throws(() => parseNativeSphereAcceptanceArgs(["--target"]), /requires a value/u);
  assert.throws(() => parseNativeSphereAcceptanceArgs(["--output"]), /requires a value/u);
});
