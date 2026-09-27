import assert from "node:assert/strict";
import test from "node:test";

import { parseNativeUiEditArgs } from "./verify-native-ui-edits-live.ts";

test("native UI edit acceptance defaults to inert help", () => {
  assert.deepEqual(parseNativeUiEditArgs([]), { help: true, allowDisposableMutations: false });
  assert.equal(parseNativeUiEditArgs(["--help"]).help, true);
});

test("live native UI edit acceptance requires an explicit target, disposable-mutation guard, and output", () => {
  assert.throws(() => parseNativeUiEditArgs(["--target", "window"]), /allow-disposable-mutations/);
  assert.throws(() => parseNativeUiEditArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/);
  assert.deepEqual(parseNativeUiEditArgs([
    "--target", "window", "--allow-disposable-mutations", "--output", "/tmp/evidence",
  ]), { help: false, target: "window", allowDisposableMutations: true, output: "/tmp/evidence" });
});

test("native UI edit acceptance rejects unknown and incomplete arguments", () => {
  assert.throws(() => parseNativeUiEditArgs(["--unexpected"]), /Unknown argument/);
  assert.throws(() => parseNativeUiEditArgs(["--target"]), /requires an explicit Plasticity/);
  assert.throws(() => parseNativeUiEditArgs(["--output"]), /requires a new directory/);
});
