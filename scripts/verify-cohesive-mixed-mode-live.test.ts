import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "./verify-cohesive-mixed-mode-live.ts";

test("mixed-mode live acceptance is inert without explicit arguments", () => {
  assert.deepEqual(parseArgs([]), { help: true, allowMutations: false });
});

test("mixed-mode live acceptance requires an explicit target, mutation guard, and output path", () => {
  assert.throws(() => parseArgs(["--target", "window"]), /allow-disposable-mutations/);
  assert.throws(() => parseArgs(["--allow-disposable-mutations", "--output", "/tmp/run"]), /explicit Plasticity window/);
  assert.throws(() => parseArgs(["--target", "window", "--allow-disposable-mutations"]), /new evidence directory/);
});

test("mixed-mode live acceptance rejects unknown arguments and accepts a complete guarded invocation", () => {
  assert.throws(() => parseArgs(["--target", "window", "--allow-disposable-mutations", "--output", "/tmp/run", "--unsafe"]), /Unknown argument/);
  assert.deepEqual(parseArgs(["--target", "window", "--allow-disposable-mutations", "--output", "/tmp/run"]), {
    help: false, target: "window", allowMutations: true, output: "/tmp/run",
  });
});
