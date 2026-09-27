import assert from "node:assert/strict";
import test from "node:test";

import { evaluateSvgCubicBezier, fitSvgCubicBezier, isExactSvgCubicPolynomialDegree, svgCubicBezierBoundsPoints } from "./svg-cubic.ts";

test("recovers exact cubic Bezier handles from four equally spaced polynomial samples", () => {
  const expected: [[number, number], [number, number], [number, number], [number, number]] = [[0, 0], [0, 3], [3, 3], [3, 0]];
  const samples = [0, 1 / 3, 2 / 3, 1].map((parameter) => evaluateSvgCubicBezier(expected, parameter));
  const fitted = fitSvgCubicBezier(samples);
  fitted.forEach((point, index) => {
    assert.ok(Math.hypot(point[0] - expected[index]![0], point[1] - expected[index]![1]) < 1e-12);
  });
});

test("elevates quadratic and linear polynomial samples to exact cubic Beziers", () => {
  const evaluateQuadratic = (parameter: number): [number, number] => [10 * parameter, 8 * parameter * (1 - parameter)];
  const quadraticSamples = [0, 1 / 3, 2 / 3, 1].map(evaluateQuadratic);
  const quadratic = fitSvgCubicBezier(quadraticSamples);
  for (const parameter of [0, 0.07, 0.2, 0.5, 0.83, 1]) {
    const actual = evaluateSvgCubicBezier(quadratic, parameter);
    const expected = evaluateQuadratic(parameter);
    assert.ok(Math.hypot(actual[0] - expected[0], actual[1] - expected[1]) < 1e-12);
  }

  const evaluateLine = (parameter: number): [number, number] => [4 + 12 * parameter, -3 + 6 * parameter];
  const lineSamples = [0, 1 / 3, 2 / 3, 1].map(evaluateLine);
  const line = fitSvgCubicBezier(lineSamples);
  for (const parameter of [0, 0.13, 0.5, 0.91, 1]) {
    const actual = evaluateSvgCubicBezier(line, parameter);
    const expected = evaluateLine(parameter);
    assert.ok(Math.hypot(actual[0] - expected[0], actual[1] - expected[1]) < 1e-12);
  }
});

test("accepts only non-rational polynomial B-spline spans through cubic degree", () => {
  for (const degree of [1, 2, 3]) assert.equal(isExactSvgCubicPolynomialDegree(degree, false), true);
  for (const degree of [0, 4, -1, 1.5, Number.NaN]) assert.equal(isExactSvgCubicPolynomialDegree(degree, false), false);
  assert.equal(isExactSvgCubicPolynomialDegree(2, true), false);
});

test("returns exact cubic endpoints and interior extrema for SVG view bounds", () => {
  const controls: [[number, number], [number, number], [number, number], [number, number]] = [[0, 0], [0, 3], [3, 3], [3, 0]];
  const points = svgCubicBezierBoundsPoints(controls);
  const minX = Math.min(...points.map((point) => point[0]));
  const maxX = Math.max(...points.map((point) => point[0]));
  const minY = Math.min(...points.map((point) => point[1]));
  const maxY = Math.max(...points.map((point) => point[1]));
  assert.equal(minX, 0);
  assert.equal(maxX, 3);
  assert.equal(minY, 0);
  assert.ok(Math.abs(maxY - 2.25) < 1e-12);
});

test("rejects malformed cubic samples and evaluation parameters", () => {
  assert.throws(() => fitSvgCubicBezier([[0, 0], [1, 1], [2, 2]]), /four finite 2D samples/u);
  assert.throws(() => fitSvgCubicBezier([[0, 0], [1, 1], [2, Number.NaN], [3, 3]]), /four finite 2D samples/u);
  assert.throws(() => evaluateSvgCubicBezier([[0, 0], [1, 1], [2, 2], [3, 3]], 1.1), /parameter must be within/u);
});
