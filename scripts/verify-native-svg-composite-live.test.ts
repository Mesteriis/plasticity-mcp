import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs, pointPolylineDistanceMm, projectToSvg } from "./verify-native-svg-composite-live.ts";

test("composite SVG acceptance defaults to inert help", () => {
  assert.deepEqual(parseArgs([]), { help: true, allowLive: false });
});

test("composite SVG acceptance requires explicit target, live guard, and output directory", () => {
  assert.throws(() => parseArgs(["--target", "window"]), /--allow-live/u);
  assert.throws(() => parseArgs(["--allow-live", "--target", "window"]), /--output/u);
  assert.deepEqual(parseArgs(["--target", "window", "--allow-live", "--output", "/tmp/svg-composite"]), {
    help: false, target: "window", allowLive: true, output: "/tmp/svg-composite",
  });
});

test("composite SVG acceptance rejects unknown and incomplete arguments", () => {
  assert.throws(() => parseArgs(["--unknown"]), /Unknown argument/u);
  assert.throws(() => parseArgs(["--target"]), /requires a value/u);
});

test("composite SVG exact samples use the native plane projection and adaptive path distance", () => {
  const pointInSvg = projectToSvg([11, 18, 4], { originMm: [10, 20, 4], normal: [0, 0, 1] });
  assert.deepEqual(pointInSvg, [1, 2]);
  assert.equal(pointPolylineDistanceMm(pointInSvg, [[0, 0], [2, 0]]), 2);
  assert.throws(() => projectToSvg([0, 0, 1], { originMm: [0, 0, 0], normal: [0, 0, 1] }), /does not lie/u);
});
