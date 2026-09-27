import assert from "node:assert/strict";
import test from "node:test";

import { tessellateCurve, type CurveEvaluation } from "./svg-tessellation.ts";

function parabola(t: number): CurveEvaluation {
  return { point: [t * 10, 4 * t * (1 - t), 0], tangent: [10, 4 - 8 * t, 0] };
}

function pointToPolylineDistance(point: readonly number[], points: readonly (readonly number[])[]): number {
  let minimum = Infinity;
  for (let index = 0; index + 1 < points.length; index += 1) {
    const first = points[index]!;
    const second = points[index + 1]!;
    const direction = second.map((value, axis) => value - first[axis]!);
    const relative = point.map((value, axis) => value - first[axis]!);
    const lengthSquared = direction.reduce((sum, value) => sum + value * value, 0);
    const fraction = Math.max(0, Math.min(1, relative.reduce((sum, value, axis) => sum + value * direction[axis]!, 0) / lengthSquared));
    minimum = Math.min(minimum, Math.hypot(...relative.map((value, axis) => value - direction[axis]! * fraction)));
  }
  return minimum;
}

test("adaptive SVG tessellation stays within its requested chord tolerance on a curved B-Rep evaluator", () => {
  const result = tessellateCurve(parabola, 0.05, 5);
  assert.deepEqual(result.points[0], parabola(0).point);
  assert.deepEqual(result.points.at(-1), parabola(1).point);
  assert.ok(result.points.length > 2);
  assert.ok(result.maxChordDeviationMm <= 0.05);
  for (let sample = 0; sample <= 2000; sample += 1) {
    const t = sample / 2000;
    assert.ok(pointToPolylineDistance(parabola(t).point, result.points) <= 0.050001, `curve escaped tolerance at t=${t}`);
  }
});

test("adaptive SVG tessellation detects repeated curvature that aliases the interval endpoints and quarter probes", () => {
  const oscillating = (t: number): CurveEvaluation => ({
    point: [10 * t, Math.sin(8 * Math.PI * t), 0],
    tangent: [10, 8 * Math.PI * Math.cos(8 * Math.PI * t), 0],
  });
  const result = tessellateCurve(oscillating, 0.05, 5);

  assert.ok(result.points.length > 16, "the repeated curve should not collapse to one chord");
  assert.ok(result.maxChordDeviationMm <= 0.05);
  for (let sample = 0; sample <= 8000; sample += 1) {
    const t = sample / 8000;
    assert.ok(pointToPolylineDistance(oscillating(t).point, result.points) <= 0.050001, `curve escaped tolerance at t=${t}`);
  }
});

test("adaptive SVG tessellation enforces its point budget and validates evaluator results", () => {
  assert.throws(() => tessellateCurve(parabola, 0, 5), /positive finite/u);
  assert.throws(() => tessellateCurve(parabola, 0.05, 31), /within/u);
  assert.throws(() => tessellateCurve(() => ({ point: [NaN, 0, 0], tangent: [1, 0, 0] }), 0.05, 5), /non-finite/u);
  assert.throws(() => tessellateCurve(() => ({ point: [0, 0, 0], tangent: [0, 0, 0] }), 0.05, 5), /zero tangent/u);
});

test("adaptive SVG tessellation stops when a highly curved evaluator exceeds its bounded work budget", () => {
  let evaluations = 0;
  const circle = (t: number): CurveEvaluation => {
    evaluations += 1;
    const angle = 2 * Math.PI * t;
    return { point: [10 * Math.cos(angle), 10 * Math.sin(angle), 0], tangent: [-Math.sin(angle), Math.cos(angle), 0] };
  };

  assert.throws(() => tessellateCurve(circle, 0.05, 0.01), /tessellation exceeds the (point|evaluation) limit/u);
  assert.ok(evaluations < 50_000, `tessellation evaluated the curve ${evaluations} times`);
});
