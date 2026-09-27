import assert from "node:assert/strict";
import test from "node:test";

import { calculateEnfModeIIEnergy, enfModeIIEnergyInputSchema } from "./enf-mode-ii-energy.ts";

const specimen = {
  specimenId: "ENF-1",
  widthMm: 20,
  totalLengthMm: 160,
  armThicknessMm: 2,
  failureLocation: "interface" as const,
  calibration: [
    { crackLengthMm: 20, complianceMmPerN: 0.009, sourceHash: "e".repeat(64), sourceLocator: "calibration.csv!rows 2-12" },
    { crackLengthMm: 30, complianceMmPerN: 0.028, sourceHash: "e".repeat(64), sourceLocator: "calibration.csv!rows 13-23" },
    { crackLengthMm: 40, complianceMmPerN: 0.065, sourceHash: "e".repeat(64), sourceLocator: "calibration.csv!rows 24-34" },
  ],
  fracture: {
    initialCrackLengthMm: 30,
    peakForceN: 100,
    sourceHash: "f".repeat(64),
    sourceLocator: "fracture.csv!record 88",
  },
};

const base = {
  materialProcess: {
    printerId: "creality-k1c",
    materialId: "creality-cr-pla",
    profileHash: "b".repeat(64),
    orientationDeg: [0, 0, 0] as [number, number, number],
    infillPercent: 100,
    infillPattern: "grid",
    wallLoops: 2,
    topShellLayers: 5,
    bottomShellLayers: 3,
    nozzleTemperatureC: 220,
    layerHeightMm: 0.2,
  },
  interfaceNormalGlobal: [0, 0, 1] as [number, number, number],
  interfaceShearDirectionGlobal: [1, 0, 0] as [number, number, number],
  testProtocolHash: "c".repeat(64),
  testMethod: "ENF Mode-II compliance calibration",
  testedAt: "2026-09-25T12:00:00Z",
  complianceEvidence: "inverse-initial-linear-force-displacement-slope-same-fixture" as const,
  linearElasticQuasiStaticEvidence: "confirmed-linear-elastic-quasi-static-test" as const,
  specimens: [specimen],
};

test("calculates ENF Mode-II initiation energy from compliance calibration and preserves evidence", () => {
  const result = calculateEnfModeIIEnergy(base);
  assert.equal(result.method, "end-notched-flexure-compliance-calibration");
  assert.equal(result.calculationVersion, 1);
  assert.equal(result.materialProcess.materialId, "creality-cr-pla");
  assert.equal(result.testProtocolHash, "c".repeat(64));
  assert.deepEqual(result.interfaceShearDirectionGlobal, [1, 0, 0]);
  assert.equal(result.specimens[0]?.failureLocation, "interface");
  assert.equal(result.specimens[0]?.eligibleForLayerInterfaceEvidence, true);
  assert.ok(Math.abs((result.specimens[0]?.complianceFitSlopeMmPerNPerMm3 ?? 0) - 1e-6) < 1e-15);
  assert.ok(Math.abs((result.specimens[0]?.complianceFitRSquared ?? 0) - 1) < 1e-12);
  assert.equal(result.specimens[0]?.energyReleaseRateJPerM2, 675);
  assert.equal(result.specimens[0]?.calibration[0]?.sourceLocator, "calibration.csv!rows 2-12");
  assert.equal(result.specimens[0]?.calibration[0]?.sourceHash, "e".repeat(64));
  assert.equal(result.specimens[0]?.fractureSourceHash, "f".repeat(64));
  assert.equal(result.specimens[0]?.fractureSourceLocator, "fracture.csv!record 88");
  assert.ok(result.limitations.some((limitation) => limitation.includes("not a determination of compliance with ASTM D7905")));
});

test("keeps non-interface ENF failures ineligible for same-material layer fracture evidence", () => {
  const result = calculateEnfModeIIEnergy({
    ...base,
    specimens: [{ ...specimen, failureLocation: "printed-material" }],
  });
  assert.equal(result.specimens[0]?.eligibleForLayerInterfaceEvidence, false);
});

test("rejects invalid compliance calibration, extrapolation, source evidence and DCB method substitutions", () => {
  assert.equal(enfModeIIEnergyInputSchema.safeParse({ ...base, specimens: [{ ...specimen, widthMm: 0 }] }).success, false);
  assert.equal(enfModeIIEnergyInputSchema.safeParse({ ...base, specimens: [{ ...specimen, calibration: specimen.calibration.slice(0, 2) }] }).success, false);
  assert.equal(enfModeIIEnergyInputSchema.safeParse({ ...base, complianceEvidence: "unverified" }).success, false);
  assert.equal(enfModeIIEnergyInputSchema.safeParse({ ...base, interfaceShearDirectionGlobal: [0, 0, 1] }).success, false);
  assert.throws(() => calculateEnfModeIIEnergy({
    ...base,
    specimens: [{ ...specimen, calibration: specimen.calibration.map((point) => ({ ...point, complianceMmPerN: 0.01 })) }],
  }), /compliance must vary and increase with the cube of crack length/i);
  assert.throws(() => calculateEnfModeIIEnergy({
    ...base,
    specimens: [{ ...specimen, fracture: { ...specimen.fracture, initialCrackLengthMm: 45 } }],
  }), /inside the calibrated crack-length interval/i);
  assert.throws(() => calculateEnfModeIIEnergy({ ...base, linearElasticQuasiStaticEvidence: "not-confirmed" }), /Invalid input/i);
});
