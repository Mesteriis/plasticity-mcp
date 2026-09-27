import assert from "node:assert/strict";
import test from "node:test";

import { calculateMmbModeIEnergy, mmbModeIEnergyInputSchema } from "./mmb-mode-i-ii-energy.ts";

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
  testMethod: "MMB beam-theory initiation screen",
  testedAt: "2026-09-25T12:00:00Z",
  axesMappingConfirmed: "moduli-axis-1-matches-shear-axis-2-is-in-plane-transverse-3-is-interface-normal" as const,
  leverWeight: "measured-negligible-or-counterbalanced" as const,
  flexuralModulus: {
    valueMPa: 1800,
    sourceHash: "d".repeat(64),
    sourceLocator: "flexure.csv!records 20-40",
  },
  orthotropicModuli: {
    E11MPa: 2000,
    E22MPa: 1500,
    G13MPa: 500,
    sourceHash: "e".repeat(64),
    sourceLocator: "coupon-report.pdf!table 3",
  },
  specimens: [{
    specimenId: "MMB-1",
    widthMm: 25,
    totalLengthMm: 150,
    armThicknessMm: 2.5,
    halfSpanMm: 50,
    leverArmMm: 100,
    initialCrackLengthMm: 50,
    criticalForceN: 100,
    initiationCriterion: "visual-crack-initiation" as const,
    failureLocation: "interface" as const,
    sourceHash: "f".repeat(64),
    sourceLocator: "mmb-run.csv!record 80",
  }],
};

test("calculates MMB Mode-I and Mode-II initiation energy using measured axes and exact provenance", () => {
  const result = calculateMmbModeIEnergy(base);
  assert.equal(result.method, "reeder-crews-mmb-beam-theory");
  assert.equal(result.calculationVersion, 1);
  assert.equal(result.testProtocolHash, "c".repeat(64));
  assert.ok(result.specimens[0]!.modeIEnergyReleaseRateJPerM2 > 0);
  assert.ok(result.specimens[0]!.modeIIEnergyReleaseRateJPerM2 > 0);
  assert.ok(Math.abs(result.specimens[0]!.modeIIModeMixFraction - 0.205) < 0.005);
  assert.equal(result.specimens[0]!.totalEnergyReleaseRateJPerM2,
    result.specimens[0]!.modeIEnergyReleaseRateJPerM2 + result.specimens[0]!.modeIIEnergyReleaseRateJPerM2);
  assert.equal(result.specimens[0]!.eligibleForLayerInterfaceEvidence, true);
  assert.deepEqual(result.materialAxis1Global, [1, 0, 0]);
  assert.deepEqual(result.materialAxis3Global, [0, 0, 1]);
  assert.ok(result.limitations.some((limitation) => limitation.includes("not a determination of ASTM D6671 conformity")));
  assert.ok(result.limitations.some((limitation) => limitation.includes("not a traction-separation curve")));
});

test("rejects unsupported direction frames, mismatched axes, lever corrections and invalid MMB geometry", () => {
  assert.equal(mmbModeIEnergyInputSchema.safeParse({ ...base, interfaceShearDirectionGlobal: [0, 0, 1] }).success, false);
  assert.equal(mmbModeIEnergyInputSchema.safeParse({ ...base, axesMappingConfirmed: "unconfirmed" }).success, false);
  assert.equal(mmbModeIEnergyInputSchema.safeParse({ ...base, leverWeight: "unknown" }).success, false);
  assert.equal(mmbModeIEnergyInputSchema.safeParse({ ...base, flexuralModulus: { ...base.flexuralModulus, valueMPa: 0 } }).success, false);
  assert.throws(() => calculateMmbModeIEnergy({
    ...base,
    specimens: [{ ...base.specimens[0], leverArmMm: 10 }],
  }), /must exceed one-third of the MMB half span/i);
  assert.throws(() => calculateMmbModeIEnergy({
    ...base,
    specimens: [{ ...base.specimens[0], initialCrackLengthMm: 150 }],
  }), /inside the specimen/i);
  assert.throws(() => calculateMmbModeIEnergy({ ...base, flexuralModulus: { ...base.flexuralModulus, sourceHash: "bad" } }), /Invalid string/i);
});

test("reports non-interface MMB failures but keeps them out of same-material interface evidence", () => {
  const result = calculateMmbModeIEnergy({
    ...base,
    specimens: [{ ...base.specimens[0], failureLocation: "printed-material" }],
  });
  assert.equal(result.specimens[0]?.eligibleForLayerInterfaceEvidence, false);
});
