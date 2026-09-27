import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCompactObservationAcceptanceArgs } from "./verify-compact-observation-live.ts";

test("compact observation acceptance is inert by default and when help is requested", () => {
  assert.deepEqual(parseCompactObservationAcceptanceArgs([]), { help: true });
  assert.deepEqual(parseCompactObservationAcceptanceArgs(["--help"]), { help: true });
});

test("compact observation acceptance requires an explicit window and new output path", () => {
  assert.throws(() => parseCompactObservationAcceptanceArgs(["--target", "window-1"]), /requires --output/);
  assert.throws(() => parseCompactObservationAcceptanceArgs(["--output", "/tmp/evidence"]), /requires --target/);
  assert.deepEqual(parseCompactObservationAcceptanceArgs(["--target", "window-1", "--output", "/tmp/evidence"]), {
    help: false, target: "window-1", output: "/tmp/evidence",
  });
});

test("compact observation acceptance rejects unknown and incomplete arguments", () => {
  assert.throws(() => parseCompactObservationAcceptanceArgs(["--bogus"]), /Unknown argument/);
  assert.throws(() => parseCompactObservationAcceptanceArgs(["--target"]), /requires an explicit Plasticity window ID/);
  assert.throws(() => parseCompactObservationAcceptanceArgs(["--output"]), /requires a new directory path/);
});
