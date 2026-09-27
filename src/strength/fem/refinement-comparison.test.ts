import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { StoredFemReport } from "./fem-report-store.ts";
import { compareFemRefinementReports } from "./refinement-comparison.ts";

test("merges overlapping reports only when repeated meshes reproduce the solver result", () => {
  const coarse = report("report-coarse-000000000000000000000000", [6, 3, 1.5]);
  const fine = report("report-fine-0000000000000000000000000", [3, 1.5, 0.75]);
  const comparison = compareFemRefinementReports([coarse, fine]);
  assert.equal(comparison.cases[0]!.meshLevels.length, 4);
  assert.deepEqual(comparison.cases[0]!.meshLevels.map((level) => level.meshSizeMm), [6, 3, 1.5, 0.75]);
  assert.deepEqual(comparison.cases[0]!.meshLevels.map((level) => level.fifthPercentileSampledSICN), [0.7, 0.7, 0.7, 0.7]);
  assert.deepEqual(comparison.cases[0]!.meshLevels.map((level) => level.medianSampledSICN), [0.8, 0.8, 0.8, 0.8]);
  assert.deepEqual(comparison.cases[0]!.meshLevels.map((level) => level.minimumSICNElementId), [11, 21, 41, 81]);
  assert.deepEqual(comparison.cases[0]!.meshLevels.map((level) => level.maximumPrincipalStressMPa), [0.75, 1.5, 2.25, 3]);
  assert.equal(comparison.cases[0]!.refinementDiagnostics.maximumVonMisesMPa, "increasing");
  assert.equal(comparison.cases[0]!.refinementDiagnostics.maximumDisplacementOnSetMm, "increasing");
  assert.equal(comparison.cases[0]!.refinementDiagnostics.maximumPrincipalStressMPa, "increasing");
  assert.equal(comparison.cases[0]!.refinementDiagnostics.minimumPrincipalStressMPa, "decreasing");
  assert.equal(comparison.cases[0]!.meshLevels[1]!.relativeChangeFromPreviousPercent?.maximumPrincipalStressMPa, 100);
  assert.equal(comparison.cases[0]!.meshLevels[1]!.relativeChangeFromPreviousPercent?.minimumPrincipalStressMPa, -100);
  assert.equal(comparison.cases[0]!.refinementDiagnostics.interpretation, "sampled-trend-only");
});

test("rejects comparisons across CAD revisions and non-reproducible repeated meshes", () => {
  const coarse = report("report-coarse-000000000000000000000000", [6, 3, 1.5]);
  const fine = report("report-fine-0000000000000000000000000", [3, 1.5, 0.75]);
  const stale = structuredClone(fine);
  stale.binding.revision = "another-revision";
  assert.throws(() => compareFemRefinementReports([coarse, stale]), /same CAD session, document, revision and body/);

  const inconsistent = structuredClone(fine);
  inconsistent.cases![0]!.meshLevels![0]!.calculation.maximumVonMisesMPa += 1;
  assert.throws(() => compareFemRefinementReports([coarse, inconsistent]), /did not reproduce identical solver evidence/);

  const inconsistentQuality = structuredClone(fine);
  inconsistentQuality.cases![0]!.meshLevels![0]!.fifthPercentileSampledSICN = 0.75;
  assert.throws(() => compareFemRefinementReports([coarse, inconsistentQuality]), /did not reproduce identical solver evidence/);

  const inconsistentPeakQuality = structuredClone(fine);
  inconsistentPeakQuality.cases![0]!.meshLevels![0]!.calculation.maximumVonMisesElementSICN = 0.9;
  assert.throws(() => compareFemRefinementReports([coarse, inconsistentPeakQuality]), /did not reproduce identical solver evidence/);

  const inconsistentPrincipal = structuredClone(fine);
  inconsistentPrincipal.cases![0]!.meshLevels![0]!.calculation.maximumPrincipalStressMPa = 999;
  assert.throws(() => compareFemRefinementReports([coarse, inconsistentPrincipal]), /did not reproduce identical solver evidence/);
});

test("rejects reports that contain no additional distinct mesh level", () => {
  assert.throws(() => compareFemRefinementReports([
    report("report-one-000000000000000000000000000", [3]),
    report("report-two-000000000000000000000000000", [3]),
  ]), /at least two distinct mesh levels/);
});

function report(id: string, meshSizes: number[]): StoredFemReport {
  const results = new Map([
    [6, { stress: 1, displacement: 0.1, count: 10 }],
    [3, { stress: 2, displacement: 0.2, count: 20 }],
    [1.5, { stress: 3, displacement: 0.3, count: 40 }],
    [0.75, { stress: 4, displacement: 0.4, count: 80 }],
  ]);
  const calculations = meshSizes.map((meshSizeMm, index) => {
    const measured = results.get(meshSizeMm)!;
    return {
      solver: "CalculiX 2.20" as const,
      elementFamily: "C3D4" as const,
      stressIntegrationPointCount: 1,
      minimumSxxMPa: -measured.stress,
      maximumSxxMPa: measured.stress,
      maximumVonMisesMPa: measured.stress,
      maximumVonMisesLocation: { elementId: measured.count, integrationPoint: 1, centroidMm: [0, 0, 0] as [number, number, number] },
      maximumPrincipalStressMPa: measured.stress * 0.75,
      maximumPrincipalStressLocation: { elementId: measured.count, integrationPoint: 1, centroidMm: [0, 0, 0] as [number, number, number] },
      minimumPrincipalStressMPa: -measured.stress * 0.4,
      minimumPrincipalStressLocation: { elementId: measured.count, integrationPoint: 1, centroidMm: [0, 0, 0] as [number, number, number] },
      maximumVonMisesElementSICN: 0.8,
      maximumVonMisesOnMinimumSICNElement: false,
      prescribedDisplacementMm: null,
      displacementObservationNodeSetName: "LOAD_FACE",
      displacementObservationAxis: 2 as const,
      maximumDisplacementOnSetMm: measured.displacement,
      supportReactionN: [0, -1, 0] as [number, number, number],
      supportReactionMomentNmm: [0, 0, 0] as [number, number, number],
      forceEquilibriumResidualN: [0, 0, 0] as [number, number, number],
      momentEquilibriumResidualNmm: [0, 0, 0] as [number, number, number],
      jobName: `${id}-level-${index}`,
      inputPath: `/tmp/${id}-${index}.inp`,
      reportPath: `/tmp/${id}-${index}.dat`,
    };
  });
  const input = {
    bodyId: 1,
    revision: "same-revision",
    supportFaceIds: ["support-face"],
    supportConditions: undefined,
    faceLoads: [],
    resultantLoads: [],
    loadCases: [{ name: "vertical-load", faceLoads: [{ faceId: "load-face", tractionNPerMm2: [0, 1, 0] }], resultantLoads: [] }],
    meshSizeMm: meshSizes[0]!,
    meshRefinementSteps: meshSizes.length - 1,
    youngsModulusMPa: 1_000,
    poissonRatio: 0.3,
    youngsModulusEvidence: { id: "e-modulus", label: "fixture", status: "assumed", unit: "MPa", value: 1_000, derivation: "test-only", dependsOn: [] },
    poissonRatioEvidence: { id: "poisson", label: "fixture", status: "assumed", unit: "ratio", value: 0.3, derivation: "test-only", dependsOn: [] },
  } as unknown as StoredFemReport["input"];
  const caseMeshLevels = meshSizes.map((meshSizeMm, index) => {
    const measured = results.get(meshSizeMm)!;
    return {
      meshSizeMm,
      meshSha256: createHash("sha256").update(`mesh-${meshSizeMm}`).digest("hex"),
      nodeCount: measured.count + 4,
      tetrahedronCount: measured.count,
      minimumScaledInverseConditionNumber: 0.5,
      fifthPercentileSampledSICN: 0.7,
      medianSampledSICN: 0.8,
      minimumSICNElementId: measured.count + 1,
      minimumSICNElementCentroidMm: [0.5, 0.5, 0.5] as [number, number, number],
      totalResultantN: [0, 1, 0] as [number, number, number],
      totalResultantMomentNmm: [0, 0, 0] as [number, number, number],
      calculation: calculations[index]!,
      relativeChangeFromPreviousPercent: index === 0 ? null : {
        maximumVonMisesMPa: 100,
        maximumDisplacementOnSetMm: 100,
        maximumVonMisesLocationShiftMm: 0,
      },
    };
  });
  const sharedMeshSha256 = caseMeshLevels[0]!.meshSha256;
  return {
    id,
    createdAt: "2026-09-24T00:00:00.000Z",
    binding: { sessionId: "session", documentToken: "document", revision: "same-revision", bodyId: 1 },
    input,
    bodyName: "Fixture",
    boundsMm: { min: [0, 0, 0], max: [1, 1, 1] },
    gmshVersion: "4.15.2",
    faceMappings: [],
    supportFaceAreasMm2: [],
    mesh: { meshFile: "/tmp/mesh.inp", meshSha256: sharedMeshSha256, meshSizeMm: meshSizes[0]!, elementFamily: "C3D4", nodeCount: 14, tetrahedronCount: 10, minimumScaledInverseConditionNumber: 0.5, fifthPercentileSampledSICN: 0.7, medianSampledSICN: 0.8, minimumSICNElementId: results.get(meshSizes[0]!)!.count + 1, minimumSICNElementCentroidMm: [0.5, 0.5, 0.5], boundsMm: { min: [0, 0, 0], max: [1, 1, 1] }, nodeSets: [], sharedSurfaceNodeCount: 0, loadFile: "/tmp/loads.inp", surfaceLoads: [], resultantLoads: [], totalResultantN: [0, 1, 0], totalResultantMomentNmm: [0, 0, 0] },
    calculation: calculations[0]!,
    cases: [{ name: "vertical-load", meshSha256: sharedMeshSha256, loadFile: "/tmp/loads.inp", surfaceLoads: [], resultantLoads: [], totalResultantN: [0, 1, 0], totalResultantMomentNmm: [0, 0, 0], calculation: calculations[0]!, meshLevels: caseMeshLevels }],
  } as unknown as StoredFemReport;
}
