import assert from "node:assert/strict";
import test from "node:test";

import { solveSimplySupportedUniformPlate } from "./plate-theory.ts";

const near = (actual: number, expected: number, tolerance = 1e-9): void => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
};

test("Navier series reproduces the published simply-supported square-plate coefficients", () => {
  const sideMm = 40;
  const thicknessMm = 2;
  const pressureMPa = 0.001;
  const youngMPa = 2_000;
  const poissonRatio = 0.3;
  const result = solveSimplySupportedUniformPlate({
    lengthMm: sideMm,
    widthMm: sideMm,
    thicknessMm,
    pressureMPa,
    youngMPa,
    poissonRatio,
  });

  const deflectionCoefficient = result.centerDeflectionMm * result.flexuralRigidityNmm /
    (pressureMPa * sideMm ** 4);
  const stressCoefficient = result.maximumCenterSurfaceStressMPa * thicknessMm ** 2 /
    (pressureMPa * sideMm ** 2);
  near(deflectionCoefficient, 0.00406235266, 2e-10);
  near(stressCoefficient, 0.28731828, 2e-8);
  near(result.centerMomentXN, result.centerMomentYN, 1e-12);
  assert.equal(result.seriesMaxOddIndex, 401);
});

test("plate solution is symmetric under span exchange and obeys pressure and thickness scaling", () => {
  const input = {
    lengthMm: 80,
    widthMm: 40,
    thicknessMm: 2,
    pressureMPa: 0.001,
    youngMPa: 2_000,
    poissonRatio: 0.35,
  };
  const nominal = solveSimplySupportedUniformPlate(input);
  const swapped = solveSimplySupportedUniformPlate({ ...input, lengthMm: 40, widthMm: 80 });
  const doubledPressure = solveSimplySupportedUniformPlate({ ...input, pressureMPa: 0.002 });
  const doubledThickness = solveSimplySupportedUniformPlate({ ...input, thicknessMm: 4 });

  near(nominal.centerDeflectionMm, 0.0170647715154, 2e-12);
  near(nominal.centerSurfaceStressMPa.x, 0.122815842402, 2e-12);
  near(nominal.centerSurfaceStressMPa.y, 0.246128909778, 2e-12);
  near(swapped.centerDeflectionMm, nominal.centerDeflectionMm, 1e-12);
  near(swapped.centerMomentXN, nominal.centerMomentYN, 1e-12);
  near(swapped.centerMomentYN, nominal.centerMomentXN, 1e-12);
  near(doubledPressure.centerDeflectionMm, 2 * nominal.centerDeflectionMm, 1e-12);
  near(doubledPressure.maximumCenterSurfaceStressMPa, 2 * nominal.maximumCenterSurfaceStressMPa, 1e-12);
  near(doubledThickness.centerDeflectionMm, nominal.centerDeflectionMm / 8, 1e-12);
  near(doubledThickness.maximumCenterSurfaceStressMPa, nominal.maximumCenterSurfaceStressMPa / 4, 1e-12);
});

test("plate solver rejects nonphysical inputs and keeps zero pressure finite", () => {
  const input = {
    lengthMm: 40,
    widthMm: 40,
    thicknessMm: 2,
    pressureMPa: 0,
    youngMPa: 2_000,
    poissonRatio: 0.3,
  };
  const unloaded = solveSimplySupportedUniformPlate(input);
  assert.equal(unloaded.centerDeflectionMm, 0);
  assert.equal(unloaded.maximumCenterSurfaceStressMPa, 0);
  assert.throws(() => solveSimplySupportedUniformPlate({ ...input, thicknessMm: 0 }), /thickness/i);
  assert.throws(() => solveSimplySupportedUniformPlate({ ...input, pressureMPa: -1 }), /pressure/i);
  assert.throws(() => solveSimplySupportedUniformPlate({ ...input, poissonRatio: 0.5 }), /Poisson/i);
});
