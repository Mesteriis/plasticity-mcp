import assert from "node:assert/strict";
import test from "node:test";

import { analyzeSvgEllipseArc, fitSvgConicEllipse, fitSvgEllipse } from "./svg-ellipse.ts";

const carrier = (angle: number): [number, number] => {
  const rotation = -35 * Math.PI / 180;
  const x = 12 * Math.cos(angle);
  const y = 5 * Math.sin(angle);
  return [x * Math.cos(rotation) - y * Math.sin(rotation), x * Math.sin(rotation) + y * Math.cos(rotation)];
};
const fitted = fitSvgEllipse([0, Math.PI / 2, Math.PI, 3 * Math.PI / 2, 2 * Math.PI].map(carrier));

function arc(startRadians: number, endRadians: number, direction: 1 | -1) {
  const start = carrier(startRadians);
  const end = carrier(endRadians);
  const rotation = -35 * Math.PI / 180;
  const tangent = [
    -12 * Math.sin(startRadians) * Math.cos(rotation) - 5 * Math.cos(startRadians) * Math.sin(rotation),
    -12 * Math.sin(startRadians) * Math.sin(rotation) + 5 * Math.cos(startRadians) * Math.cos(rotation),
  ] as [number, number];
  return analyzeSvgEllipseArc(
    fitted, start, end, [tangent[0] * direction, tangent[1] * direction],
    startRadians, endRadians, 2 * Math.PI,
  );
}

test("classifies exact native Ellipse sweeps and direction for both SVG arc flags", () => {
  const longCounterclockwise = arc(30 * Math.PI / 180, 250 * Math.PI / 180, 1);
  assert.equal(longCounterclockwise.largeArcFlag, 1);
  assert.equal(longCounterclockwise.sweepFlag, 1);
  assert.ok(Math.abs(longCounterclockwise.sweepRadians - 220 * Math.PI / 180) < 1e-12);

  const shortClockwise = arc(250 * Math.PI / 180, 170 * Math.PI / 180, -1);
  assert.equal(shortClockwise.largeArcFlag, 0);
  assert.equal(shortClockwise.sweepFlag, 0);
  assert.ok(Math.abs(shortClockwise.sweepRadians - 80 * Math.PI / 180) < 1e-12);
});

test("rejects native Ellipse endpoints that do not match its carrier interval", () => {
  const start = carrier(0);
  const end = carrier(Math.PI / 2);
  const rotation = -35 * Math.PI / 180;
  const tangent: [number, number] = [-5 * Math.sin(rotation), 5 * Math.cos(rotation)];
  assert.throws(() => analyzeSvgEllipseArc(fitted, start, end, tangent, 0, Math.PI, 2 * Math.PI), /interval, endpoints, and tangent disagree/u);
});

test("fits an exact ellipse from non-uniform rational-conic samples", () => {
  const expectedCenter: [number, number] = [14, -9];
  const rotation = 27 * Math.PI / 180;
  const sampleAngles = [-155, -111, -58, 8, 74].map((angle) => angle * Math.PI / 180);
  const samples = sampleAngles.map((angle): [number, number] => {
    const x = 18 * Math.cos(angle);
    const y = 6 * Math.sin(angle);
    return [expectedCenter[0] + x * Math.cos(rotation) - y * Math.sin(rotation),
      expectedCenter[1] + x * Math.sin(rotation) + y * Math.cos(rotation)];
  });

  const ellipse = fitSvgConicEllipse(samples);
  assert.ok(Math.hypot(ellipse.center[0] - expectedCenter[0], ellipse.center[1] - expectedCenter[1]) < 1e-9);
  assert.ok(Math.abs(ellipse.majorRadius - 18) < 1e-9);
  assert.ok(Math.abs(ellipse.minorRadius - 6) < 1e-9);
  assert.ok(Math.abs(ellipse.rotationDegrees - 27) < 1e-9);
});

test("rejects degenerate conic samples", () => {
  assert.throws(() => fitSvgConicEllipse([[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]]), /do not define a stable ellipse/u);
});
