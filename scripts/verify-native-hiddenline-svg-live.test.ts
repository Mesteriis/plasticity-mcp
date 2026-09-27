import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "./verify-native-hiddenline-svg-live.ts";

test("hidden-line SVG live acceptance is inert by default", () => {
  assert.deepEqual(parseArgs([]), { help: true, allowLive: false });
  assert.equal(parseArgs(["--help"]).help, true);
});

test("hidden-line SVG live acceptance requires a target, Solid ID, live guard, and output", () => {
  assert.throws(() => parseArgs(["--solid-id", "8", "--allow-live", "--output", "/tmp/out"]), /--target/u);
  assert.throws(() => parseArgs(["--target", "window", "--allow-live", "--output", "/tmp/out"]), /--solid-id/u);
  assert.throws(() => parseArgs(["--target", "window", "--solid-id", "8", "--output", "/tmp/out"]), /--allow-live/u);
  assert.throws(() => parseArgs(["--target", "window", "--solid-id", "8", "--allow-live"]), /--output/u);
});

test("hidden-line SVG live acceptance rejects invalid Solid IDs and unknown options", () => {
  assert.throws(() => parseArgs(["--target", "window", "--solid-id", "0", "--allow-live", "--output", "/tmp/out"]), /positive integer/u);
  assert.throws(() => parseArgs(["--unknown"]), /Unknown argument/u);
  assert.deepEqual(parseArgs(["--target", "window", "--solid-id", "8", "--allow-live", "--output", "/tmp/out"]), {
    help: false, target: "window", solidId: 8, allowLive: true, output: "/tmp/out",
  });
});
