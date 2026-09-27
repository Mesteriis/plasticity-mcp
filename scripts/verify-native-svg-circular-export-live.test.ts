import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeSvgCircularAcceptanceArgs } from "./verify-native-svg-circular-export-live.ts";

test("circular SVG acceptance defaults to inert help", () => {
  assert.deepEqual(parseNativeSvgCircularAcceptanceArgs([]), { help: true, allowLive: false });
});

test("circular SVG acceptance requires explicit target, output, and live guard", () => {
  assert.throws(() => parseNativeSvgCircularAcceptanceArgs(["--target", "window"]), /--allow-live/u);
  assert.throws(() => parseNativeSvgCircularAcceptanceArgs(["--target", "window", "--allow-live"]), /--output/u);
  assert.deepEqual(parseNativeSvgCircularAcceptanceArgs(["--target", "window", "--allow-live", "--output", "/tmp/circle-export"]), {
    help: false, target: "window", allowLive: true, output: "/tmp/circle-export",
  });
});

test("circular SVG acceptance rejects malformed arguments", () => {
  assert.throws(() => parseNativeSvgCircularAcceptanceArgs(["--unexpected"]), /Unknown argument/u);
  assert.throws(() => parseNativeSvgCircularAcceptanceArgs(["--output"]), /requires a value/u);
});
