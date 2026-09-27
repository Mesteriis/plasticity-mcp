import assert from "node:assert/strict";
import { test } from "node:test";

import { calculateConeDevelopment, planConeDevelopmentCurves } from "./cone-development.ts";

const axisOriginMm: [number, number, number] = [40, 0, 0];
const axisDirection: [number, number, number] = [0, 0, -1];
const semiAngleRad = Math.atan(1 / 3);

test("calculates an area-preserving sector for a complete R12/R6 × 18 mm frustum", () => {
  const result = calculateConeDevelopment({
    basisRadiusMm: 12,
    semiAngleRad,
    axisOriginMm,
    axisDirection,
    circularBoundaries: [
      { pointOnCircleMm: [52, 0, 0], circumferenceMm: 75.39822368615503 },
      { pointOnCircleMm: [46, 0, 18], circumferenceMm: 37.69911184307752 },
    ],
  });

  assert.equal(result.axialHeightMm, 18);
  assert.ok(Math.abs(result.innerRadiusMm - 18.973665961010276) < 1e-9);
  assert.ok(Math.abs(result.outerRadiusMm - 37.94733192202055) < 1e-9);
  assert.ok(Math.abs(result.includedAngleRad - 1.98691765315922) < 1e-9);
  assert.ok(Math.abs(result.innerRadiusMm * result.includedAngleRad - 37.69911184307752) < 1e-9);
  assert.ok(Math.abs(result.outerRadiusMm * result.includedAngleRad - 75.39822368615503) < 1e-9);
});

test("rejects incomplete or mismatched conical boundaries instead of inventing a flat pattern", () => {
  const base = {
    basisRadiusMm: 12,
    semiAngleRad,
    axisOriginMm,
    axisDirection,
    circularBoundaries: [
      { pointOnCircleMm: [52, 0, 0] as [number, number, number], circumferenceMm: 75.39822368615503 },
      { pointOnCircleMm: [46, 0, 18] as [number, number, number], circumferenceMm: 37.69911184307752 },
    ],
  };

  assert.throws(() => calculateConeDevelopment({ ...base, circularBoundaries: [base.circularBoundaries[0]!] }), /exactly two full circular boundaries/i);
  assert.throws(() => calculateConeDevelopment({ ...base, circularBoundaries: [base.circularBoundaries[0]!, { ...base.circularBoundaries[1]!, circumferenceMm: 12 }] }), /does not match the native cone/i);
  assert.throws(() => calculateConeDevelopment({ ...base, basisRadiusMm: Number.NaN }), /finite positive native cone radius/i);
});

test("plans four exactly connected native curves for the annular sector", () => {
  const development = {
    axialHeightMm: 18,
    innerRadiusMm: 18.973665961010276,
    outerRadiusMm: 37.94733192202055,
    includedAngleRad: 1.98691765315922,
    slantLengthMm: 18.973665961010276,
  };

  const plan = planConeDevelopmentCurves([100, 200, 30], development);

  assert.deepEqual(plan.arcs.map((arc) => [arc.radiusMm, arc.startAngleDegrees, arc.sweepAngleDegrees]), [
    [37.94733192202055, 0, 113.84199576606166],
    [18.973665961010276, 113.84199576606166, -113.84199576606166],
  ]);
  assert.deepEqual(plan.radialSegments, [
    [[84.66108808197492, 234.70904465944096, 30], [92.33054404098746, 217.35452232972048, 30]],
    [[118.97366596101028, 200, 30], [137.94733192202057, 200, 30]],
  ]);
});
