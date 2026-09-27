import assert from "node:assert/strict";
import { test } from "node:test";
import { parseNonparallelClearanceArgs } from "./verify-nonparallel-planar-clearance-live.ts";

test("nonparallel-clearance acceptance is inert by default", () => {
  assert.deepEqual(parseNonparallelClearanceArgs([]), { help: true, allowDisposableMutations: false });
  assert.equal(parseNonparallelClearanceArgs(["--help"]).help, true);
});

test("nonparallel-clearance acceptance requires explicit target, mutations, and output", () => {
  assert.throws(() => parseNonparallelClearanceArgs(["--target", "window", "--output", "/tmp/run"]), /allow-disposable-mutations/u);
  assert.throws(() => parseNonparallelClearanceArgs(["--allow-disposable-mutations", "--output", "/tmp/run"]), /--target/u);
  assert.throws(() => parseNonparallelClearanceArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/u);
  assert.deepEqual(parseNonparallelClearanceArgs(["--target", "window", "--allow-disposable-mutations", "--output", "/tmp/run"]), {
    help: false, target: "window", allowDisposableMutations: true, output: "/tmp/run",
  });
  assert.throws(() => parseNonparallelClearanceArgs(["--target"]), /explicit Plasticity window ID/u);
  assert.throws(() => parseNonparallelClearanceArgs(["--unknown"]), /Unknown argument/u);
});
