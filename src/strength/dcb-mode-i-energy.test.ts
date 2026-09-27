import assert from "node:assert/strict";
import test from "node:test";

import { calculateDcbModeIEnergy, dcbModeIEnergyInputSchema } from "./dcb-mode-i-energy.ts";

const specimen = {
  specimenId: "A-1",
  widthMm: 25,
  totalLengthMm: 125,
  armThicknessMm: 2.5,
  failureLocation: "interface" as const,
  sourceHash: "a".repeat(64),
  points: [
    { crackLengthMm: 40, forceN: 10, loadPointDisplacementMm: 2.16, sourceLocator: "run.csv!row 2" },
    { crackLengthMm: 50, forceN: 8, loadPointDisplacementMm: 2.744, sourceLocator: "run.csv!row 3" },
    { crackLengthMm: 60, forceN: 6, loadPointDisplacementMm: 3.072, sourceLocator: "run.csv!row 4" },
  ],
};

const testContext = {
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
  testProtocolHash: "c".repeat(64),
  interfaceNormalGlobal: [0, 0, 1] as [number, number, number],
  testMethod: "DCB Mode-I MBT study",
  testedAt: "2026-09-25T12:00:00Z",
};

test("calculates a corrected MBT R-curve per DCB specimen and preserves provenance", () => {
  const result = calculateDcbModeIEnergy({
    ...testContext,
    displacementEvidence: "machine-compliance-corrected-load-point-displacement",
    linearElasticQuasiStaticEvidence: "confirmed-linear-elastic-quasi-static-test",
    specimens: [specimen],
  });
  assert.equal(result.method, "modified-beam-theory");
  assert.equal(result.calculationVersion, 1);
  assert.equal(result.materialProcess.materialId, "creality-cr-pla");
  assert.equal(result.testProtocolHash, "c".repeat(64));
  assert.equal(result.testedAt, "2026-09-25T12:00:00Z");
  assert.equal(result.specimens[0]?.failureLocation, "interface");
  assert.equal(result.specimens[0]?.sourceHash, "a".repeat(64));
  assert.equal(result.specimens[0]?.points.length, 3);
  assert.ok(Math.abs((result.specimens[0]?.crackLengthCorrectionMm ?? 0) - 20) < 1e-9);
  assert.ok(Math.abs((result.specimens[0]?.points[0]?.energyReleaseRateJPerM2 ?? 0) - 21.6) < 1e-9);
  assert.equal(result.specimens[0]?.points[0]?.sourceLocator, "run.csv!row 2");
  assert.ok(result.limitations.some((limitation) => limitation.includes("not a traction-separation curve")));
});

test("reports apparent energy but marks non-interface failures ineligible for layer fracture", () => {
  const result = calculateDcbModeIEnergy({
    ...testContext,
    displacementEvidence: "machine-compliance-corrected-load-point-displacement",
    linearElasticQuasiStaticEvidence: "confirmed-linear-elastic-quasi-static-test",
    specimens: [{ ...specimen, failureLocation: "printed-material" }],
  });
  assert.equal(result.specimens[0]?.eligibleForLayerInterfaceEvidence, false);
  assert.ok(result.specimens[0]?.points.every((point) => point.energyReleaseRateJPerM2 !== null));
});

test("rejects invalid DCB geometry, repeated crack readings, poor specimen count, and large-displacement rows", () => {
  const base = {
    ...testContext,
    displacementEvidence: "machine-compliance-corrected-load-point-displacement",
    linearElasticQuasiStaticEvidence: "confirmed-linear-elastic-quasi-static-test",
    specimens: [specimen],
  } as const;
  assert.equal(dcbModeIEnergyInputSchema.safeParse({ ...base, specimens: [{ ...specimen, widthMm: 0 }] }).success, false);
  assert.equal(dcbModeIEnergyInputSchema.safeParse({ ...base, specimens: [{ ...specimen, points: specimen.points.slice(0, 2) }] }).success, false);
  assert.equal(dcbModeIEnergyInputSchema.safeParse({ ...base, specimens: [{ ...specimen, points: [specimen.points[0], specimen.points[0], specimen.points[2]] }] }).success, false);
  assert.throws(() => calculateDcbModeIEnergy({
    ...base,
    specimens: [{ ...specimen, points: specimen.points.map((point) => ({ ...point, loadPointDisplacementMm: point.crackLengthMm })) }],
  }), /requires a large-displacement correction/i);
  assert.throws(() => calculateDcbModeIEnergy({
    ...base,
    specimens: [{ ...specimen, points: specimen.points.map((point) => ({ ...point, forceN: Number.MIN_VALUE })) }],
  }), /compliance is outside the supported numeric range/i);
  assert.throws(() => calculateDcbModeIEnergy({ ...base, displacementEvidence: "raw-crosshead-displacement" }), /Invalid input/i);
});
