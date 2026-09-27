import assert from "node:assert/strict";
import test from "node:test";

import type { StoredFemReport } from "./fem-report-store.ts";
import { buildOrthotropicMaximumStressScreen, buildStaticOrthotropicTsaiWuScreen, buildStaticStressAllowableScreen, buildStressAllowableScreen } from "./static-stress-screen.ts";

const evidence = {
  id: "allowable",
  label: "Factored von Mises design allowable",
  status: "sourced" as const,
  unit: "MPa" as const,
  value: 100,
  sourceUrl: "https://example.org/allowable",
  sourceHash: "a".repeat(64),
  sourceLocator: "Table 1, factored allowable",
  dependsOn: [],
};

function report(stresses: number[], withAllowable = true): StoredFemReport {
  const calculation = (maximumVonMisesMPa: number) => ({ maximumVonMisesMPa }) as StoredFemReport["calculation"];
  return {
    input: {
      factoredVonMisesAllowableMPa: withAllowable ? 100 : undefined,
      factoredVonMisesAllowableEvidence: withAllowable ? evidence : undefined,
      factoredVonMisesAllowableBasis: withAllowable ? "Safety factor already included in published design allowable." : undefined,
    },
    mesh: { meshSizeMm: 1, meshSha256: "b".repeat(64) },
    calculation: calculation(stresses[0] ?? 0),
    cases: [{
      name: "service",
      calculation: calculation(stresses[stresses.length - 1] ?? 0),
      meshSha256: "b".repeat(64),
      meshLevels: stresses.map((maximumVonMisesMPa, index) => ({
        meshSizeMm: 1 / 2 ** index,
        meshSha256: String(index + 1).repeat(64),
        calculation: calculation(maximumVonMisesMPa),
      })),
    }],
  } as unknown as StoredFemReport;
}

test("screens every named-case mesh level against the explicit factored allowable", () => {
  const screen = buildStaticFemScreen(report([50, 110]));
  assert.equal(screen?.overallStatus, "at-least-one-sampled-peak-above-allowable");
  assert.deepEqual(screen?.cases[0]?.samples.map((sample) => sample.utilization), [0.5, 1.1]);
  assert.deepEqual(screen?.cases[0]?.samples.map((sample) => sample.status), ["at-or-below-allowable", "above-allowable"]);
  assert.equal(screen?.interpretation, "diagnostic-only-no-strength-pass");
});

test("does not invent a strength screen when no design allowable was supplied", () => {
  assert.equal(buildStaticFemScreen(report([10], false)), null);
});

test("screens mesh levels merged from separate refinement reports", () => {
  const screen = buildStressAllowableScreen(80, { ...evidence, value: 80 }, "Already factored, process-specific design allowable.", [{
    name: "service",
    samples: [
      { meshSizeMm: 2, meshSha256: "a".repeat(64), maximumVonMisesMPa: 40 },
      { meshSizeMm: 1, meshSha256: "b".repeat(64), maximumVonMisesMPa: 88 },
    ],
  }]);
  assert.equal(screen?.overallStatus, "at-least-one-sampled-peak-above-allowable");
  assert.deepEqual(screen?.cases[0]?.samples.map((sample) => sample.utilization), [0.5, 1.1]);
});

test("refuses an overflowing stress-to-allowable ratio instead of returning invalid JSON", () => {
  assert.throws(() => buildStressAllowableScreen(Number.MIN_VALUE, { ...evidence, value: Number.MIN_VALUE }, "Explicit test basis.", [{
    name: "service",
    samples: [{ meshSizeMm: 1, meshSha256: "a".repeat(64), maximumVonMisesMPa: Number.MAX_VALUE }],
  }]), /finite numeric range/);
});

function buildStaticFemScreen(value: StoredFemReport) {
  return buildStaticStressAllowableScreen(value);
}

test("screens all orthotropic normal and shear extrema in the material frame", () => {
  const allowables = {
    xTensionMPa: 100, xCompressionMPa: 80,
    yTensionMPa: 60, yCompressionMPa: 50,
    zTensionMPa: 40, zCompressionMPa: 30,
    xyShearMPa: 25, xzShearMPa: 20, yzShearMPa: 15,
  };
  const evidenceByKey = Object.fromEntries(Object.keys(allowables).map((key) => [key, { ...evidence, id: key, label: key, value: allowables[key as keyof typeof allowables] }]));
  const result = buildOrthotropicMaximumStressScreen(allowables, evidenceByKey as never, "Already factored process-specific limits.", [{
    name: "service",
    samples: [{
      meshSizeMm: 1, meshSha256: "c".repeat(64),
      components: {
        sxx: { minimumMPa: -20, maximumMPa: 70 }, syy: { minimumMPa: -40, maximumMPa: 10 }, szz: { minimumMPa: -10, maximumMPa: 10 },
        sxy: { minimumMPa: -10, maximumMPa: 30 }, sxz: { minimumMPa: -5, maximumMPa: 5 }, syz: { minimumMPa: -3, maximumMPa: 3 },
      },
    }],
  }]);
  assert.equal(result?.overallStatus, "at-least-one-sampled-peak-above-allowable");
  assert.equal(result?.cases[0]?.samples[0]?.maximumUtilization, 1.2);
  assert.equal(result?.cases[0]?.samples[0]?.governingComponent, "Sxy shear");
  assert.equal(result?.cases[0]?.samples[0]?.governingStressMPa, 30);
  assert.equal(result?.cases[0]?.samples[0]?.governingAllowableMPa, 25);
  assert.equal(result?.interpretation, "diagnostic-only-no-strength-pass");
  assert.match(result?.limitations.join(" ") ?? "", /does not model individual layer interfaces, delamination or joints between different materials/);
});

test("does not create an orthotropic screen without all directional allowables", () => {
  assert.equal(buildOrthotropicMaximumStressScreen(undefined, undefined, undefined, []), null);
});

test("normal stress screen distinguishes tension, compression, and mixed signs on each axis", () => {
  const allowables = {
    xTensionMPa: 100, xCompressionMPa: 10,
    yTensionMPa: 100, yCompressionMPa: 10,
    zTensionMPa: 100, zCompressionMPa: 10,
    xyShearMPa: 100, xzShearMPa: 100, yzShearMPa: 100,
  };
  const evidenceByKey = Object.fromEntries(Object.keys(allowables).map((key) => [key, { ...evidence, id: key, label: key, value: allowables[key as keyof typeof allowables] }]));
  const zero = { minimumMPa: 0, maximumMPa: 0 };
  for (const axis of ["sxx", "syy", "szz"] as const) {
    for (const [minimumMPa, maximumMPa, expectedComponent, expectedStressMPa, expectedUtilization] of [
      [20, 25, `${axis[0]!.toUpperCase()}${axis.slice(1)} tension`, 25, 0.25],
      [-25, -20, `${axis[0]!.toUpperCase()}${axis.slice(1)} compression`, -25, 2.5],
      [-15, 25, `${axis[0]!.toUpperCase()}${axis.slice(1)} compression`, -15, 1.5],
    ] as const) {
      const result = buildOrthotropicMaximumStressScreen(allowables, evidenceByKey as never, "Factored limits.", [{
        name: "service",
        samples: [{ meshSizeMm: 1, meshSha256: "a".repeat(64), components: {
          sxx: zero, syy: zero, szz: zero, sxy: zero, sxz: zero, syz: zero,
          [axis]: { minimumMPa, maximumMPa },
        } }],
      }]);
      const sample = result?.cases[0]?.samples[0];
      assert.equal(sample?.governingComponent, expectedComponent);
      assert.equal(sample?.governingStressMPa, expectedStressMPa);
      assert.equal(sample?.maximumUtilization, expectedUtilization);
    }
  }
});

test("reports the sampled Tsai-Wu surface and proportional reserve factor with exact process binding", () => {
  const location = { elementId: 7, integrationPoint: 1, centroidMm: [1, 2, 3] as [number, number, number] };
  const sample = {
    maximumFailureIndex: 1.08,
    maximumFailureIndexLocation: location,
    minimumLoadFactorToIndexOne: 1 / Math.sqrt(1.08),
    minimumLoadFactorLocation: location,
  };
  const process = {
    printerId: "creality-k1c", materialId: "pla-test", profileHash: "c".repeat(64),
    orientationDeg: [0, 0, 0] as [number, number, number], infillPercent: 100, infillPattern: "grid", wallLoops: 2, topShellLayers: 5, bottomShellLayers: 3, nozzleTemperatureC: 210,
    layerHeightMm: 0.2,
  };
  const criterion = {
    strengths: { xTensionMPa: 100, xCompressionMPa: 100, yTensionMPa: 100, yCompressionMPa: 100, zTensionMPa: 100, zCompressionMPa: 100, xyShearMPa: 100, xzShearMPa: 100, yzShearMPa: 100 },
    interactions: { xy: 0.5, xz: 0, yz: 0 },
    strengthEvidence: {}, interactionEvidence: {}, basis: "Traceable exact-process strength and biaxial coupon test fit.",
  };
  const calculation = { orthotropicTsaiWu: sample } as StoredFemReport["calculation"];
  const report = {
    input: { orthotropicMaterial: { process, tsaiWuCriterion: criterion } },
    mesh: { meshSizeMm: 1, meshSha256: "b".repeat(64) },
    calculation,
    cases: [{ name: "combined", calculation, meshSha256: "b".repeat(64), meshLevels: [{ meshSizeMm: 1, meshSha256: "b".repeat(64), calculation }] }],
  } as unknown as StoredFemReport;

  const screen = buildStaticOrthotropicTsaiWuScreen(report);
  assert.equal(screen?.overallStatus, "at-least-one-sampled-index-at-or-above-one");
  assert.equal(screen?.cases[0]?.samples[0]?.maximumFailureIndex, 1.08);
  assert.equal(screen?.cases[0]?.samples[0]?.minimumLoadFactorToIndexOne, 1 / Math.sqrt(1.08));
  assert.deepEqual(screen?.process, process);
  assert.equal(screen?.interpretation, "diagnostic-only-no-strength-pass");
});
