import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "./verify-native-svg-polynomial-degrees-live.ts";

test("polynomial SVG acceptance is inert by default", () => {
  assert.deepEqual(parseArgs([]), { help: true, allowDisposableMutations: false });
  assert.equal(parseArgs(["--help"]).help, true);
});

test("polynomial SVG acceptance requires explicit target, mutation guard, and output", () => {
  assert.throws(() => parseArgs(["--allow-disposable-mutations", "--output", "/tmp/out"]), /--target/u);
  assert.throws(() => parseArgs(["--target", "window", "--output", "/tmp/out"]), /--allow-disposable-mutations/u);
  assert.throws(() => parseArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/u);
  assert.deepEqual(parseArgs(["--target", "window", "--allow-disposable-mutations", "--output", "/tmp/out"]), {
    help: false, target: "window", allowDisposableMutations: true, output: "/tmp/out",
  });
});

test("polynomial SVG acceptance rejects missing values and unknown flags", () => {
  assert.throws(() => parseArgs(["--target"]), /requires a value/u);
  assert.throws(() => parseArgs(["--output"]), /requires a value/u);
  assert.throws(() => parseArgs(["--unknown"]), /Unknown argument/u);
});
