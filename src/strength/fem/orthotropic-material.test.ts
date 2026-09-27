import assert from "node:assert/strict";
import test from "node:test";

import { orthotropicElasticConstantsError, resolveOrthotropicOrientation } from "./orthotropic-material.ts";
import { femStaticInputSchema } from "./fem-report-store.ts";
import { orthotropicTsaiWuInteractionTestAxis, orthotropicTsaiWuTestMetadata } from "../material-qualification.ts";

const stableConstants = {
  youngsModulusMPa: 2_000,
  youngsModulus2MPa: 1_500,
  youngsModulus3MPa: 1_000,
  poissonRatio12: 0.3,
  poissonRatio13: 0.22,
  poissonRatio23: 0.27,
  shearModulus12MPa: 500,
  shearModulus13MPa: 400,
  shearModulus23MPa: 300,
};

test("accepts positive-definite orthotropic engineering constants", () => {
  assert.equal(orthotropicElasticConstantsError(stableConstants), undefined);
});

test("rejects non-positive moduli and unstable orthotropic compliance", () => {
  assert.match(orthotropicElasticConstantsError({ ...stableConstants, shearModulus12MPa: 0 })!, /must be positive/);
  assert.match(orthotropicElasticConstantsError({ ...stableConstants, poissonRatio12: 2 })!, /positive definite/);
  assert.match(orthotropicElasticConstantsError({
    ...stableConstants,
    poissonRatio12: 0.8,
    poissonRatio13: 0.8,
    poissonRatio23: -0.8,
  })!, /positive definite/);
  assert.match(orthotropicElasticConstantsError({ ...stableConstants, poissonRatio13: Number.NaN })!, /finite/);
});

test("normalizes an orthotropic print frame and removes the axis-2 projection", () => {
  const frame = resolveOrthotropicOrientation({
    axis1DirectionGlobal: [0, 3, 0],
    axis2ReferenceDirectionGlobal: [4, 5, 0],
    buildDirectionGlobal: [0, 0, 1],
  });
  assert.deepEqual(frame.axis1Global, [0, 1, 0]);
  assert.deepEqual(frame.axis2Global, [1, 0, 0]);
  assert.deepEqual(frame.axis3Global, [0, 0, -1]);
  assert.deepEqual(frame.calculixPointA, [0, 1, 0]);
  assert.deepEqual(frame.calculixPointB, [1, 1, 0]);
});

test("requires exact traceable directional allowables before enabling orthotropic stress screening", () => {
  const makeEvidence = (id: string, value: number, status: "sourced" | "assumed" = "sourced") => ({
    id, label: id, status, unit: "MPa", value, sourceUrl: "https://example.org/material", sourceHash: "a".repeat(64), sourceLocator: "Table 1, values", dependsOn: [],
    ...(status === "assumed" ? { derivation: "Assumption for test only" } : {}),
  });
  const propertyKeys = ["youngsModulus2MPa", "youngsModulus3MPa", "poissonRatio13", "poissonRatio23", "shearModulus12MPa", "shearModulus13MPa", "shearModulus23MPa"] as const;
  const constants = { youngsModulus2MPa: 1500, youngsModulus3MPa: 1000, poissonRatio13: 0.22, poissonRatio23: 0.27, shearModulus12MPa: 500, shearModulus13MPa: 400, shearModulus23MPa: 300 };
  const strengthKeys = ["xTensionMPa", "xCompressionMPa", "yTensionMPa", "yCompressionMPa", "zTensionMPa", "zCompressionMPa", "xyShearMPa", "xzShearMPa", "yzShearMPa"] as const;
  const directional = Object.fromEntries(strengthKeys.map((key) => [key, 25]));
  const base = {
    bodyId: 1, revision: "rev-1", supportFaceIds: ["support"], faceLoads: [{ faceId: "load", tractionNPerMm2: [1, 0, 0] }], resultantLoads: [], loadCases: [],
    meshSizeMm: 1, meshRefinementSteps: 0, youngsModulusMPa: 2000, youngsModulusEvidence: makeEvidence("e1", 2000), poissonRatio: 0.3,
    poissonRatioEvidence: { ...makeEvidence("e2", 0.3), unit: "ratio" },
    orthotropicMaterial: {
      ...constants,
      evidence: Object.fromEntries(propertyKeys.map((key, index) => [key, { ...makeEvidence(`e${index + 3}`, constants[key]), unit: key.startsWith("poisson") ? "ratio" : "MPa" }])),
      orientation: { axis1DirectionGlobal: [1, 0, 0], axis2ReferenceDirectionGlobal: [0, 1, 0], buildDirectionGlobal: [0, 0, 1], evidence: { status: "user-confirmed", description: "User confirmed print-axis directions and build axis" } },
      factoredAllowables: {
        ...directional,
        evidence: Object.fromEntries(strengthKeys.map((key, index) => [key, makeEvidence(`a${index}`, 25)])),
        basis: "All nine values include the stated design factors and match this material process.",
      },
    },
  };
  assert.equal(femStaticInputSchema.safeParse(base).success, true);
  const mismatched = structuredClone(base);
  mismatched.orthotropicMaterial.factoredAllowables.evidence.xTensionMPa!.value = 24;
  assert.equal(femStaticInputSchema.safeParse(mismatched).success, false);
  const assumed = structuredClone(base);
  assumed.orthotropicMaterial.factoredAllowables.evidence.xTensionMPa!.status = "assumed";
  assert.equal(femStaticInputSchema.safeParse(assumed).success, false);
});

test("accepts static per-layer material frames only with complete confirmed exact-process G-code evidence", () => {
  const process = {
    printerId: "creality-k1c", materialId: "pla-test", profileHash: "f".repeat(64),
    orientationDeg: [0, 0, 0] as [number, number, number], infillPercent: 100, infillPattern: "grid", wallLoops: 2, topShellLayers: 5, bottomShellLayers: 3, nozzleTemperatureC: 210, layerHeightMm: 0.2,
  };
  const makeEvidence = (id: string, value: number, unit: "MPa" | "ratio") => ({
    id, label: id, status: "sourced" as const, unit, value,
    sourceUrl: "https://example.org/material", sourceHash: "a".repeat(64), sourceLocator: "Table 1", dependsOn: [],
  });
  const propertyValues = {
    youngsModulus2MPa: 1500, youngsModulus3MPa: 1000, poissonRatio13: 0.22, poissonRatio23: 0.27,
    shearModulus12MPa: 500, shearModulus13MPa: 400, shearModulus23MPa: 300,
  };
  const propertyKeys = Object.keys(propertyValues) as Array<keyof typeof propertyValues>;
  const base = {
    bodyId: 1, revision: "rev-1", supportFaceIds: ["support"], faceLoads: [{ faceId: "load", tractionNPerMm2: [1, 0, 0] as [number, number, number] }],
    resultantLoads: [], loadCases: [], meshSizeMm: 1, meshRefinementSteps: 0,
    youngsModulusMPa: 2000, youngsModulusEvidence: makeEvidence("e1", 2000, "MPa"), poissonRatio: 0.3,
    poissonRatioEvidence: { ...makeEvidence("e2", 0.3, "ratio"), unit: "ratio" as const },
    orthotropicMaterial: {
      ...propertyValues,
      evidence: Object.fromEntries(propertyKeys.map((key, index) => [key, makeEvidence(`e${index + 3}`, propertyValues[key], key.startsWith("poisson") ? "ratio" : "MPa")])),
      orientation: {
        axis1DirectionGlobal: [1, 0, 0], axis2ReferenceDirectionGlobal: [0, 1, 0], buildDirectionGlobal: [0, 0, 1],
        evidence: { status: "user-confirmed" as const, description: "Coupon axes and print build direction confirmed by user." },
      },
      process,
    },
  };
  const plan = {
    processProfileHash: process.profileHash,
    firstInterfacePointMm: [0, 0, 0.2],
    buildDirectionGlobal: [0, 0, 1],
    layerHeightMm: 0.2,
    totalLayerCount: 2,
    interfaceLayerIndices: [1],
    pathFrameMapping: {
      slicerXDirectionGlobal: [1, 0, 0],
      evidence: { status: "user-confirmed" as const, description: "Slicer X axis confirmed as CAD global X." },
    },
    roadAxisMapping: {
      status: "user-confirmed" as const,
      couponAxis1Meaning: "dominant-deposition-road-direction" as const,
      evidence: { description: "Coupon axis 1 confirmed as the dominant deposited-road direction." },
    },
    layerPathEvidence: {
      jobId: "slice-job-static", profileHash: process.profileHash,
      sourceArtifactHash: "b".repeat(64), gcodeArtifactHash: "c".repeat(64),
      layerCount: 2, coordinateFrame: "slicer-build" as const,
      layers: [0, 90].map((principalDirectionDeg, index) => ({
        layerIndex: index + 1,
        depositionLayerZMm: 0.2 * (index + 1),
        pathOrientation: {
          layerIndex: index + 1, planarPathLengthMm: 100, principalDirectionDeg,
          directionalConcentration: 0.9, curvedExtrusionMoves: 0, coverage: "complete-linear" as const,
        },
      })),
    },
  };
  const candidate = { ...base, layerPlanePlan: plan };
  const accepted = femStaticInputSchema.safeParse(candidate);
  assert.equal(accepted.success, true, accepted.success ? undefined : accepted.error.message);
  if (accepted.success) assert.equal(accepted.data.layerPlanePlan?.totalLayerCount, 2);

  assert.equal(femStaticInputSchema.safeParse({ ...candidate, layerPlanePlan: { ...plan, processProfileHash: "d".repeat(64) } }).success, false);
  assert.equal(femStaticInputSchema.safeParse({ ...candidate, orthotropicMaterial: { ...base.orthotropicMaterial, process: { ...process, layerHeightMm: 0.16 } } }).success, false);
  assert.equal(femStaticInputSchema.safeParse({ ...candidate, orthotropicMaterial: { ...base.orthotropicMaterial, process: undefined } }).success, false);
  assert.equal(femStaticInputSchema.safeParse({ ...candidate, orthotropicMaterial: { ...base.orthotropicMaterial, factoredAllowables: {
    ...Object.fromEntries(["xTensionMPa", "xCompressionMPa", "yTensionMPa", "yCompressionMPa", "zTensionMPa", "zCompressionMPa", "xyShearMPa", "xzShearMPa", "yzShearMPa"].map((key) => [key, 25])),
    evidence: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`e${index}`, { ...makeEvidence(`a${index}`, 25, "MPa"), status: "sourced", unit: "MPa" }])),
    basis: "Factored directional allowables for a fixed material frame.",
  } } }).success, false);
});

test("requires measured Tsai-Wu strengths and biaxial interactions tied to one explicit print process", () => {
  const process = {
    printerId: "creality-k1c", materialId: "pla-test", profileHash: "c".repeat(64),
    orientationDeg: [0, 0, 0] as [number, number, number], infillPercent: 100, infillPattern: "grid", wallLoops: 2, topShellLayers: 5, bottomShellLayers: 3, nozzleTemperatureC: 210, layerHeightMm: 0.2,
  };
  const makeEvidence = (id: string, value: number, unit: "MPa" | "ratio") => ({
    id, label: id, status: "measured" as const, unit, value,
    sourceUrl: "https://example.org/test-report", sourceHash: "d".repeat(64), sourceLocator: `Test result ${id}`, dependsOn: [],
    process,
  });
  const criterion = {
    strengths: {
      xTensionMPa: 30, xCompressionMPa: 30, yTensionMPa: 20, yCompressionMPa: 20,
      zTensionMPa: 10, zCompressionMPa: 10, xyShearMPa: 12, xzShearMPa: 8, yzShearMPa: 7,
    },
    interactions: { xy: 0.2, xz: -0.1, yz: 0.15 },
    strengthEvidence: {} as Record<string, unknown>,
    interactionEvidence: {} as Record<string, unknown>,
    basis: "Single-profile physical strength tests and biaxial interaction tests in the declared local print axes.",
  };
  for (const [key, value] of Object.entries(criterion.strengths)) {
    criterion.strengthEvidence[key] = {
      ...makeEvidence(`strength-${key}`, value, "MPa"),
      ...orthotropicTsaiWuTestMetadata[key as keyof typeof orthotropicTsaiWuTestMetadata],
    };
  }
  for (const [key, value] of Object.entries(criterion.interactions)) {
    criterion.interactionEvidence[key] = {
      ...makeEvidence(`interaction-${key}`, value, "ratio"),
      testAxis: orthotropicTsaiWuInteractionTestAxis[key as keyof typeof orthotropicTsaiWuInteractionTestAxis], testMode: "biaxial",
      status: "derived",
      derivation: "Normalized interaction fit to biaxial test results.",
      dependsOn: [`biaxial-test-${key}`],
    };
  }
  const candidate: any = structuredClone(baseInputForTsaiWu());
  candidate.orthotropicMaterial.tsaiWuCriterion = criterion;
  assert.equal(femStaticInputSchema.safeParse(candidate).success, false);

  candidate.orthotropicMaterial.process = process;
  const parsed = femStaticInputSchema.safeParse(candidate);
  assert.equal(parsed.success, true, parsed.success ? undefined : parsed.error.message);
  const wrongAxis = structuredClone(candidate);
  wrongAxis.orthotropicMaterial.tsaiWuCriterion.strengthEvidence.xTensionMPa.testAxis = "material-2";
  assert.equal(femStaticInputSchema.safeParse(wrongAxis).success, false);
  const mismatch = structuredClone(candidate);
  mismatch.orthotropicMaterial.tsaiWuCriterion.strengthEvidence.xTensionMPa.value = 29;
  assert.equal(femStaticInputSchema.safeParse(mismatch).success, false);

  const differentFilament = structuredClone(candidate);
  differentFilament.orthotropicMaterial.tsaiWuCriterion.strengthEvidence.xTensionMPa.process = { ...process, materialId: "petg-test" };
  assert.equal(femStaticInputSchema.safeParse(differentFilament).success, false);

  const differentProfile = structuredClone(candidate);
  differentProfile.orthotropicMaterial.tsaiWuCriterion.interactionEvidence.xy.process = { ...process, profileHash: "e".repeat(64) };
  assert.equal(femStaticInputSchema.safeParse(differentProfile).success, false);

  const differentLayerHeight = structuredClone(candidate);
  differentLayerHeight.orthotropicMaterial.tsaiWuCriterion.strengthEvidence.xTensionMPa.process = { ...process, layerHeightMm: 0.16 };
  assert.equal(femStaticInputSchema.safeParse(differentLayerHeight).success, false);

  const missingLayerHeight = structuredClone(candidate);
  Reflect.deleteProperty(missingLayerHeight.orthotropicMaterial.process, "layerHeightMm");
  for (const evidence of [
    ...Object.values(missingLayerHeight.orthotropicMaterial.tsaiWuCriterion.strengthEvidence),
    ...Object.values(missingLayerHeight.orthotropicMaterial.tsaiWuCriterion.interactionEvidence),
  ]) Reflect.deleteProperty((evidence as { process: object }).process, "layerHeightMm");
  assert.equal(femStaticInputSchema.safeParse(missingLayerHeight).success, false);
});

function baseInputForTsaiWu() {
  const evidence = (id: string, value: number, unit: "MPa" | "ratio") => ({
    id, label: id, status: "sourced" as const, unit, value,
    sourceUrl: "https://example.org/material", sourceHash: "a".repeat(64), sourceLocator: "Table 1", dependsOn: [],
  });
  const orthotropicEvidenceKeys = ["youngsModulus2MPa", "youngsModulus3MPa", "poissonRatio13", "poissonRatio23", "shearModulus12MPa", "shearModulus13MPa", "shearModulus23MPa"] as const;
  const values = { youngsModulus2MPa: 1500, youngsModulus3MPa: 1000, poissonRatio13: 0.22, poissonRatio23: 0.27, shearModulus12MPa: 500, shearModulus13MPa: 400, shearModulus23MPa: 300 };
  return {
    bodyId: 1, revision: "rev-1", supportFaceIds: ["support"], faceLoads: [{ faceId: "load", tractionNPerMm2: [1, 0, 0] }], resultantLoads: [], loadCases: [],
    meshSizeMm: 1, meshRefinementSteps: 0, youngsModulusMPa: 2000, youngsModulusEvidence: evidence("youngs", 2000, "MPa"), poissonRatio: 0.3,
    poissonRatioEvidence: evidence("poisson", 0.3, "ratio"),
    orthotropicMaterial: {
      ...values,
      evidence: Object.fromEntries(orthotropicEvidenceKeys.map((key) => [key, evidence(key, values[key], key.startsWith("poisson") ? "ratio" : "MPa")])),
      orientation: { axis1DirectionGlobal: [1, 0, 0], axis2ReferenceDirectionGlobal: [0, 1, 0], buildDirectionGlobal: [0, 0, 1], evidence: { status: "user-confirmed" as const, description: "User confirmed print-axis directions and build axis" } },
    },
  };
}

test("rejects a zero axis and parallel material axes", () => {
  assert.throws(() => resolveOrthotropicOrientation({
    axis1DirectionGlobal: [0, 0, 0],
    axis2ReferenceDirectionGlobal: [0, 1, 0],
    buildDirectionGlobal: [0, 0, 1],
  }), /axis 1.*nonzero/);
  assert.throws(() => resolveOrthotropicOrientation({
    axis1DirectionGlobal: [1, 0, 0],
    axis2ReferenceDirectionGlobal: [3, 0, 0],
    buildDirectionGlobal: [0, 0, 1],
  }), /must not be parallel/);
  assert.throws(() => resolveOrthotropicOrientation({
    axis1DirectionGlobal: [1, 0, 0],
    axis2ReferenceDirectionGlobal: [0, 1, 0],
    buildDirectionGlobal: [0, 1, 0],
  }), /axis 3 must align/);
});
