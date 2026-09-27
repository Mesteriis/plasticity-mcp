import assert from "node:assert/strict";
import test from "node:test";

import { parseProbeArgs } from "./probe-codex-analysis.ts";

test("probe is read-only and unpaid unless live is explicit", () => {
  assert.deepEqual(parseProbeArgs([]), {
    help: false,
    live: false,
    timeoutMs: 60_000,
  });
});

test("probe accepts one absolute image and a bounded timeout", () => {
  assert.deepEqual(parseProbeArgs(["--live", "--image", "/tmp/sketch.png", "--timeout-ms", "15000"]), {
    help: false,
    live: true,
    imagePath: "/tmp/sketch.png",
    timeoutMs: 15_000,
  });
});

test("probe rejects relative images and unknown flags", () => {
  assert.throws(() => parseProbeArgs(["--image", "sketch.png"]), /absolute/);
  assert.throws(() => parseProbeArgs(["--surprise"]), /Unknown/);
});
