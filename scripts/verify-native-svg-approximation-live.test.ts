import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "./verify-native-svg-approximation-live.ts";

test("native SVG approximation acceptance is inert without explicit live arguments", () => {
  assert.deepEqual(parseArgs([]), { help: true, allowLive: false });
  assert.equal(parseArgs(["--help"]).help, true);
});

test("native SVG approximation acceptance requires an explicit target, live guard, and output", () => {
  assert.throws(() => parseArgs(["--allow-live", "--output", "/tmp/out"]), /--target/u);
  assert.throws(() => parseArgs(["--target", "window", "--output", "/tmp/out"]), /--allow-live/u);
  assert.throws(() => parseArgs(["--target", "window", "--allow-live"]), /--output/u);
  assert.deepEqual(parseArgs(["--target", "window", "--allow-live", "--output", "/tmp/out"]), {
    help: false, target: "window", allowLive: true, output: "/tmp/out",
  });
});

test("native SVG approximation acceptance rejects incomplete and unknown arguments", () => {
  assert.throws(() => parseArgs(["--target"]), /requires a value/u);
  assert.throws(() => parseArgs(["--unexpected"]), /Unknown argument/u);
});
