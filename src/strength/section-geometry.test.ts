import assert from "node:assert/strict";
import test from "node:test";

import {
  integrateSection,
  linearStressExtrema,
  type SectionLoop,
  type SectionSegment,
} from "./section-geometry.ts";

const TAU = 2 * Math.PI;

test("integrates a 20 by 10 rectangle from literal analytical references", () => {
  const result = integrateSection([rectangle(0, 0, 20, 10)]);

  near(result.areaMm2, 200);
  near(result.centroidLocalMm[0], 10);
  near(result.centroidLocalMm[1], 5);
  near(result.ixxMm4, 1666.6666666667, 1e-9);
  near(result.iyyMm4, 6666.6666666667, 1e-9);
  near(result.ixyMm4, 0, 1e-9);
  assert.equal(result.rectangular, true);
  assert.equal(result.innerLoopCount, 0);
  assert.deepEqual(result.boundaryKinds, ["line"]);
});

test("classifies a same-orientation centred circle as a hole", () => {
  const result = integrateSection([
    rectangle(0, 0, 20, 10),
    { segments: [{ kind: "arc", center: [10, 5], radius: 2, startRadians: 0, sweepRadians: TAU }] },
  ]);

  near(result.areaMm2, 200 - 4 * Math.PI, 1e-10);
  near(result.centroidLocalMm[0], 10, 1e-10);
  near(result.centroidLocalMm[1], 5, 1e-10);
  near(result.ixxMm4, 1666.6666666667 - 4 * Math.PI, 1e-9);
  near(result.iyyMm4, 6666.6666666667 - 4 * Math.PI, 1e-9);
  near(result.ixyMm4, 0, 1e-9);
  assert.equal(result.innerLoopCount, 1);
  assert.equal(result.rectangular, false);
  assert.deepEqual(result.boundaryKinds, ["line", "circle"]);
});

test("integrates concentric full circles with opposite native orientations", () => {
  const result = integrateSection([
    { segments: [{ kind: "arc", center: [0, 0], radius: 3, startRadians: 0, sweepRadians: 2 * Math.PI }] },
    { segments: [{ kind: "arc", center: [0, 0], radius: 5, startRadians: 0, sweepRadians: -2 * Math.PI }] },
  ]);

  near(result.areaMm2, 16 * Math.PI);
  near(result.ixxMm4, 136 * Math.PI);
  near(result.iyyMm4, 136 * Math.PI);
  assert.equal(result.innerLoopCount, 1);
});

test("integrates a radius-3 upper semicircle", () => {
  const radius = 3;
  const loop: SectionLoop = {
    segments: [
      { kind: "line", start: [-radius, 0], end: [radius, 0] },
      { kind: "arc", center: [0, 0], radius, startRadians: 0, sweepRadians: Math.PI },
    ],
  };
  const result = integrateSection([loop]);

  near(result.areaMm2, Math.PI * radius ** 2 / 2, 1e-11);
  near(result.centroidLocalMm[0], 0, 1e-11);
  near(result.centroidLocalMm[1], 4 * radius / (3 * Math.PI), 1e-11);
  near(result.ixxMm4, radius ** 4 * (Math.PI / 8 - 8 / (9 * Math.PI)), 1e-10);
  near(result.iyyMm4, Math.PI * radius ** 4 / 8, 1e-10);
  near(result.ixyMm4, 0, 1e-10);
});

test("integrates a rounded rectangle and does not label it rectangular", () => {
  const radius = 2;
  const result = integrateSection([roundedRectangle(20, 10, radius)]);

  near(result.areaMm2, 200 - (4 - Math.PI) * radius ** 2, 1e-10);
  near(result.centroidLocalMm[0], 10, 1e-10);
  near(result.centroidLocalMm[1], 5, 1e-10);
  near(result.ixyMm4, 0, 1e-9);
  assert.ok(result.ixxMm4 > 0);
  assert.ok(result.iyyMm4 > result.ixxMm4);
  assert.equal(result.rectangular, false);
  assert.deepEqual(result.boundaryKinds, ["line", "circle"]);
});

test("normalizes reversed loop orientation and canonical topology", () => {
  const forward = integrateSection([rectangle(0, 0, 20, 10)]);
  const reversed = integrateSection([reverseLoop(rectangle(0, 0, 20, 10))]);

  near(reversed.areaMm2, forward.areaMm2);
  near(reversed.ixxMm4, forward.ixxMm4);
  near(reversed.iyyMm4, forward.iyyMm4);
  assert.equal(reversed.topologySignature, forward.topologySignature);
});

test("accepts a circle split into two adjacent semicircular arcs", () => {
  const result = integrateSection([{ segments: [
    { kind: "arc", center: [4, 3], radius: 2, startRadians: 0, sweepRadians: Math.PI },
    { kind: "arc", center: [4, 3], radius: 2, startRadians: Math.PI, sweepRadians: Math.PI },
  ] }]);

  near(result.areaMm2, 4 * Math.PI, 1e-11);
  near(result.centroidLocalMm[0], 4, 1e-11);
  near(result.centroidLocalMm[1], 3, 1e-11);
  near(result.ixxMm4, 4 * Math.PI, 1e-10);
  near(result.iyyMm4, 4 * Math.PI, 1e-10);
});

test("rejects open, self-intersecting, disconnected and overflowing boundaries", () => {
  assert.throws(() => integrateSection([{ segments: [
    { kind: "line", start: [0, 0], end: [10, 0] },
    { kind: "line", start: [10, 0], end: [10, 10] },
  ] }]), /open/i);

  assert.throws(() => integrateSection([{ segments: [
    { kind: "line", start: [0, 0], end: [10, 10] },
    { kind: "line", start: [10, 10], end: [0, 10] },
    { kind: "line", start: [0, 10], end: [10, 0] },
    { kind: "line", start: [10, 0], end: [0, 0] },
  ] }]), /self-intersection/i);

  assert.throws(() => integrateSection([
    rectangle(0, 0, 10, 10),
    rectangle(20, 0, 10, 10),
  ]), /outer island/i);

  assert.throws(() => integrateSection([{ segments: [
    { kind: "arc", center: [0, 0], radius: Number.MAX_VALUE, startRadians: 0, sweepRadians: TAU },
  ] }]), /finite|overflow/i);
  assert.throws(() => integrateSection([{ segments: [
    { kind: "arc", center: [0, 0], radius: 2, startRadians: 0, sweepRadians: 4 * Math.PI },
  ] }]), /sweep/i);
});

test("finds exact linear-field extrema on lines and arcs", () => {
  const rectangleResult = linearStressExtrema(
    [rectangle(0, 0, 20, 10)],
    { constant: 3, x: 2, y: -4 },
  );
  assert.deepEqual(rectangleResult.maximumAt, [20, 0]);
  assert.deepEqual(rectangleResult.minimumAt, [0, 10]);
  near(rectangleResult.maximum, 43);
  near(rectangleResult.minimum, -37);

  const semicircle: SectionLoop = { segments: [
    { kind: "line", start: [-3, 0], end: [3, 0] },
    { kind: "arc", center: [0, 0], radius: 3, startRadians: 0, sweepRadians: Math.PI },
  ] };
  const arcResult = linearStressExtrema([semicircle], { constant: 0, x: 0, y: 1 });
  near(arcResult.maximum, 3, 1e-12);
  near(arcResult.maximumAt[0], 0, 1e-12);
  near(arcResult.maximumAt[1], 3, 1e-12);
  near(arcResult.minimum, 0, 1e-12);
});

function rectangle(x: number, y: number, width: number, height: number): SectionLoop {
  return { segments: [
    { kind: "line", start: [x, y], end: [x + width, y] },
    { kind: "line", start: [x + width, y], end: [x + width, y + height] },
    { kind: "line", start: [x + width, y + height], end: [x, y + height] },
    { kind: "line", start: [x, y + height], end: [x, y] },
  ] };
}

function roundedRectangle(width: number, height: number, radius: number): SectionLoop {
  return { segments: [
    { kind: "line", start: [radius, 0], end: [width - radius, 0] },
    { kind: "arc", center: [width - radius, radius], radius, startRadians: -Math.PI / 2, sweepRadians: Math.PI / 2 },
    { kind: "line", start: [width, radius], end: [width, height - radius] },
    { kind: "arc", center: [width - radius, height - radius], radius, startRadians: 0, sweepRadians: Math.PI / 2 },
    { kind: "line", start: [width - radius, height], end: [radius, height] },
    { kind: "arc", center: [radius, height - radius], radius, startRadians: Math.PI / 2, sweepRadians: Math.PI / 2 },
    { kind: "line", start: [0, height - radius], end: [0, radius] },
    { kind: "arc", center: [radius, radius], radius, startRadians: Math.PI, sweepRadians: Math.PI / 2 },
  ] };
}

function reverseLoop(loop: SectionLoop): SectionLoop {
  return { segments: [...loop.segments].reverse().map(reverseSegment) };
}

function reverseSegment(segment: SectionSegment): SectionSegment {
  if (segment.kind === "line") return { kind: "line", start: segment.end, end: segment.start };
  return {
    ...segment,
    startRadians: segment.startRadians + segment.sweepRadians,
    sweepRadians: -segment.sweepRadians,
  };
}

function near(actual: number, expected: number, tolerance = 1e-12): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected} within ${tolerance}`);
}
