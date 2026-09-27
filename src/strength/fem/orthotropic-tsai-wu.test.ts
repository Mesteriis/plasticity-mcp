import assert from "node:assert/strict";
import test from "node:test";

import * as failure from "./orthotropic-tsai-wu.ts";

const calculate = failure.calculateOrthotropicTsaiWu as (input: unknown) => unknown;

const strengths = {
  xTensionMPa: 100, xCompressionMPa: 100,
  yTensionMPa: 100, yCompressionMPa: 100,
  zTensionMPa: 100, zCompressionMPa: 100,
  xyShearMPa: 100, xzShearMPa: 100, yzShearMPa: 100,
};

test("computes 3D Tsai-Wu interaction and proportional reserve factor for one local stress tensor", () => {
  const result = calculate({
    strengths,
    interactions: { xy: 0.5, xz: 0, yz: 0 },
    stressTensorMPa: [60, 60, 0, 0, 0, 0],
    location: { elementId: 7, integrationPoint: 2, centroidMm: [1, 2, 3] },
  }) as { failureIndex: number; loadFactorToIndexOne: number; location: { elementId: number; integrationPoint: number } } | undefined;

  assert.ok(Math.abs((result?.failureIndex ?? Number.NaN) - 1.08) < 1e-12);
  assert.ok(Math.abs((result?.loadFactorToIndexOne ?? Number.NaN) - 1 / Math.sqrt(1.08)) < 1e-12);
  assert.deepEqual(result?.location, { elementId: 7, integrationPoint: 2, centroidMm: [1, 2, 3] });
});

test("reports a zero stress tensor without manufacturing an infinite reserve factor", () => {
  const result = calculate({
    strengths,
    interactions: { xy: 0, xz: 0, yz: 0 },
    stressTensorMPa: [0, 0, 0, 0, 0, 0],
    location: { elementId: 1, integrationPoint: 1, centroidMm: [0, 0, 0] },
  }) as { failureIndex: number; loadFactorToIndexOne: number | null } | undefined;

  assert.equal(result?.failureIndex, 0);
  assert.equal(result?.loadFactorToIndexOne, null);
});

test("rejects normalized Tsai-Wu interactions that make the quadratic surface non-convex", () => {
  assert.throws(() => calculate({
    strengths,
    interactions: { xy: 0.9, xz: 0.9, yz: -0.9 },
    stressTensorMPa: [10, 10, 10, 0, 0, 0],
    location: { elementId: 1, integrationPoint: 1, centroidMm: [0, 0, 0] },
  }), /positive definite/);
});
