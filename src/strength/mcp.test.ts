import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AnalysisClient } from "../codex/analysis-client.ts";
import type { ArbitrarySectionEvidence } from "../plasticity/arbitrary-section.ts";
import type { FastenerPlateEvidence } from "../plasticity/fastener-geometry.ts";
import type { FastenerGroupGeometryEvidence } from "../plasticity/fastener-group-geometry.ts";
import type { FastenerGroupLayoutEvidence, FastenerGroupLayoutRequest } from "../plasticity/fastener-group-layout.ts";
import type { SectionEvidence } from "../plasticity/section-geometry.ts";
import type { AnalysisResult, CadBinding } from "./contracts.ts";
import { conditionalSyntheticInput, syntheticEulerColumnInput, syntheticInput, syntheticPlateInput } from "./fixtures.test.ts";
import { fastenerScenarioFixture } from "./fastener-fixtures.test.ts";
import { fastenerMemberFixture } from "./fastener-member-fixtures.test.ts";
import { insertRetentionFixture } from "./insert-retention-fixtures.test.ts";
import { fastenerGroupFixture } from "./fastener-group-fixtures.test.ts";
import { threadedReceiverFixture } from "./threaded-receiver-fixtures.test.ts";
import { tongueRootFixture } from "./tongue-root-fixtures.test.ts";
import { registerStrengthTools, type StrengthDependencies } from "./mcp.ts";
import { orthotropicTsaiWuInteractionTestAxis, orthotropicTsaiWuTestMetadata, type MaterialCouponQualificationInput } from "./material-qualification.ts";
import { rectangleLoop, sectionScenarioFixture } from "./section-fixtures.test.ts";
import { integrateSection } from "./section-geometry.ts";
import { StrengthStore } from "./store.ts";
import { FemReportStore, femStaticInputSchema, resolveFemSupportConditions, type FemReportContent, type FemStaticInput } from "./fem/fem-report-store.ts";
import { cohesiveAnalysisRequestSchema, type CohesiveAnalysisInput, type CohesiveAnalysisResult } from "./fem/cohesive-analysis.ts";
import { CohesiveReportStore } from "./fem/cohesive-report-store.ts";
import { createCohesiveLayerPlanePlan } from "./fem/layer-plane-plan.ts";
import { interfaceTestHash, type InterfaceTestMcpInput } from "./interface-test.ts";

test("cohesive layer-plane planner is exposed through MCP and returns analysis-ready planes", async (context) => {
  const harness = await createHarness(context, {});
  const response = await harness.client.callTool({
    name: "plasticity_plan_cohesive_layer_planes",
    arguments: {
      processProfileHash: "a".repeat(64),
      firstInterfacePointMm: [10, 20, 1],
      buildDirectionGlobal: [0, 0, 1],
      layerHeightMm: 0.2,
      totalLayerCount: 4,
      interfaceLayerIndices: [1, 2, 3],
      interfaceOffsetsMm: [0, 0.2, 0.4],
      pathFrameMapping: {
        slicerXDirectionGlobal: [1, 0, 0],
        evidence: { status: "user-confirmed", description: "Confirmed slicer X maps to the CAD global X axis." },
      },
      depositionPathEvidence: {
        jobId: "slice-1", profileHash: "a".repeat(64), sourceArtifactHash: "b".repeat(64),
        gcodeArtifactHash: "c".repeat(64), layerCount: 4, coordinateFrame: "slicer-build",
        firstDepositionLayerZMm: 0.2,
        interfaces: [1, 2, 3].map((interfaceLayerIndex) => ({
          interfaceLayerIndex, depositionLayerZMm: 0.2 * interfaceLayerIndex,
          relativeOffsetMm: 0.2 * (interfaceLayerIndex - 1),
          depositionPathOrientation: {
            layerIndex: interfaceLayerIndex, planarPathLengthMm: 100,
            principalDirectionDeg: 45, directionalConcentration: 0.9,
            curvedExtrusionMoves: 0, coverage: "complete-linear",
          },
        })),
      },
    },
  });
  assert.equal(response.isError, undefined);
  const result = JSON.parse((response.content as Array<{ text: string }>)[0]!.text) as {
    coverage: string;
    plan: { processProfileHash: string };
    planes: Array<{ pointMm: number[]; normalGlobal: number[] }>;
    layerMaterialFrames: Array<{ axis1DirectionGlobal: number[]; applicability: string } | null>;
  };
  assert.equal(result.coverage, "all-layer-interfaces");
  assert.equal(result.plan.processProfileHash, "a".repeat(64));
  assert.deepEqual(result.planes.map((plane) => plane.pointMm), [[10, 20, 1], [10, 20, 1.2], [10, 20, 1.4]]);
  assert.deepEqual(result.planes[0]?.normalGlobal, [0, 0, 1]);
  assert.ok(Math.abs(result.layerMaterialFrames[0]!.axis1DirectionGlobal[0]! - Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(result.layerMaterialFrames[0]!.axis1DirectionGlobal[1]! - Math.SQRT1_2) < 1e-12);
  assert.equal(result.layerMaterialFrames[0]?.applicability, "candidate-material-axes-only");
});

test("cohesive FEA MCP validates the request and returns only a revision-bound solver response", async (context) => {
  const input = cohesiveAnalysisRequestSchema.parse({
    bodyId: 7, revision: "r1", interfaceTestRecordId: "a".repeat(64),
    layerPlanePlan: {
      processProfileHash: "a".repeat(64), firstInterfacePointMm: [0, 0, 2], buildDirectionGlobal: [0, 0, 1],
      layerHeightMm: 0.2, totalLayerCount: 2, interfaceLayerIndices: [1],
    },
    splitPlanes: [{ pointMm: [0, 0, 2], normalGlobal: [0, 0, 1] }],
    supportFaceId: "bottom", loadedFaceId: "top", meshSizeMm: 1,
    poissonRatio: 0.3,
    poissonRatioEvidence: { id: "nu-single", label: "Single-material Poisson ratio", status: "measured", value: 0.3, unit: "ratio", sourceUrl: "https://example.test/a", sourceHash: "b".repeat(64), sourceLocator: "p.2", dependsOn: [] },
    adherencePenalty: 0.00001, increments: 10,
  });
  const expected = cohesiveResult(input, binding("r1"));
  let calls = 0;
  let currentRevision = "r1";
  const harness = await createHarness(context, {
    readCadBinding: async () => binding(currentRevision),
    analyzeCohesive: async (actual) => { calls += 1; assert.deepEqual(actual, input); return expected; },
  });
  const invalid = await harness.client.callTool({ name: "plasticity_analyze_cohesive_interface", arguments: {} });
  assert.equal(invalid.isError, true);
  assert.equal(calls, 0);
  const { layerPlanePlan: _layerPlanePlan, ...unboundInput } = input;
  const unbound = await harness.client.callTool({ name: "plasticity_analyze_cohesive_interface", arguments: unboundInput });
  assert.equal(unbound.isError, true, JSON.stringify(unbound.content));
  assert.equal(calls, 0, "MCP must reject an unbound cohesive plane before calling the solver");
  const response = await harness.client.callTool({ name: "plasticity_analyze_cohesive_interface", arguments: input });
  assert.equal(response.isError, undefined, JSON.stringify(response.content));
  assert.equal(calls, 1);
  assert.match(JSON.stringify(response.content), /cohesive-solver-response-only/);
  assert.match(JSON.stringify(response.content), /strengthPass/);
  const text = ((response.content as Array<{ text?: string }>)[0]?.text ?? "");
  const saved = JSON.parse(text) as { id: string };
  assert.match(saved.id, /^[0-9a-f-]{36}$/i);
  const restored = await harness.client.callTool({ name: "plasticity_cohesive_fem_report", arguments: { reportId: saved.id } });
  assert.equal(restored.isError, undefined);
  const restoredText = (restored.content as Array<{ text?: string }>)[0]?.text ?? "{}";
  const restoredReport = JSON.parse(restoredText) as { freshness: { status: string; reason: string } };
  assert.equal(restoredReport.freshness.status, "stale");
  assert.match(restoredReport.freshness.reason, /Physical interface\/coupon evidence/);
  currentRevision = "r2";
  const stale = await harness.client.callTool({ name: "plasticity_cohesive_fem_report", arguments: { reportId: saved.id } });
  const staleText = (stale.content as Array<{ text?: string }>)[0]?.text ?? "{}";
  assert.equal((JSON.parse(staleText) as { freshness: { status: string } }).freshness.status, "stale");
  assert.equal(currentRevision, "r2");
});

test("cohesive FEA MCP rejects a solver response if the CAD revision changed before return", async (context) => {
  const input = cohesiveAnalysisRequestSchema.parse({
    bodyId: 7, revision: "r1", interfaceTestRecordId: "a".repeat(64),
    layerPlanePlan: {
      processProfileHash: "a".repeat(64), firstInterfacePointMm: [0, 0, 2], buildDirectionGlobal: [0, 0, 1],
      layerHeightMm: 0.2, totalLayerCount: 2, interfaceLayerIndices: [1],
    },
    splitPlanes: [{ pointMm: [0, 0, 2], normalGlobal: [0, 0, 1] }],
    supportFaceId: "bottom", loadedFaceId: "top", meshSizeMm: 1,
    poissonRatio: 0.3,
    poissonRatioEvidence: { id: "nu-single", label: "Single-material Poisson ratio", status: "measured", value: 0.3, unit: "ratio", sourceUrl: "https://example.test/a", sourceHash: "b".repeat(64), sourceLocator: "p.2", dependsOn: [] },
    adherencePenalty: 0.00001, increments: 10,
  });
  const expected = cohesiveResult(input, binding("r1"));
  const harness = await createHarness(context, { readCadBinding: async () => binding("r2"), analyzeCohesive: async () => expected });
  const response = await harness.client.callTool({ name: "plasticity_analyze_cohesive_interface", arguments: input });
  assert.equal(response.isError, true);
  assert.match(JSON.stringify(response.content), /CAD changed before the cohesive solver response could be returned/);
});

function cohesiveResult(input: CohesiveAnalysisInput, cadBinding: CadBinding): CohesiveAnalysisResult {
  const processA = { printerId: "creality-k1c", materialId: "pla-a", profileHash: "a".repeat(64), orientationDeg: [0, 0, 0] as [number, number, number], infillPercent: 100, infillPattern: "grid", wallLoops: 2, topShellLayers: 5, bottomShellLayers: 3, nozzleTemperatureC: 220, layerHeightMm: 0.2 };
  const layerPlan = input.layerPlanePlan ? createCohesiveLayerPlanePlan(input.layerPlanePlan) : undefined;
  const couponA = "1".repeat(64);
  const evidence = (id: string, value: number) => ({ id, label: id, status: "measured" as const, unit: "ratio" as const, value, sourceUrl: "https://example.test/report.pdf", sourceHash: "c".repeat(64), sourceLocator: id, dependsOn: [] });
  const assignment = (testMaterial: "A" | "B", process: typeof processA, couponRecordId: string, youngsModulusMPa: number, poissonRatio: number) => ({
    testMaterial, process, couponRecordId, youngsModulusMPa, poissonRatio, poissonRatioEvidence: evidence(`nu-${testMaterial}`, poissonRatio),
  });
  return {
    binding: cadBinding, bodyName: "Test solid", input,
    physicalTest: {
      recordId: "d".repeat(64), interfaceKind: "same-material-layer", materialAProcess: processA, materialBProcess: processA,
      curveSourceHash: "e".repeat(64), curveSourceLocator: "curve.csv!A2:B5",
      measuredCurveSummary: {
        mode: "normal-tension", sourceHash: "e".repeat(64), sourceLocator: "curve.csv!A2:B5", peakStrengthMPa: 2.4,
        peakSeparationMm: 0.01, initialSegmentStiffnessMPaPerMm: 240, fractureEnergyNPerMm: 0.12, finalSeparationMm: 0.08,
        interpretation: "measured-curve-summary-only", limitations: ["Measured curve summary only"],
      },
    },
    couponRecordIds: { materialA: couponA, materialB: couponA },
    materialAssignment: { negativeSide: assignment("A", processA, couponA, 2000, 0.3), positiveSide: assignment("B", processA, couponA, 2000, 0.3) },
    mesh: {
      gmshVersion: "4.15.2", layerwiseRegions: false, volumeCount: input.splitPlanes.length + 1, interfaceSurfaceCount: input.splitPlanes.length,
      splitPlanes: input.splitPlanes,
      interfaceSurfaceGroups: input.splitPlanes.map((_plane, index) => ({ planeIndex: index, physicalTag: 3 + index, surfaceEntityTags: [index + 10], triangleCount: 20 })), meshSizeMm: input.meshSizeMm,
      materialATetrahedronCount: 100, materialBTetrahedronCount: 100, cohesiveVolumeTag: 1003, interfaceTriangleCount: 20, duplicatedNodeCount: 15,
      cohesiveElementCount: 20, boundaryGroups: [
        { faceId: input.supportFaceId, physicalTag: 1001, name: "GM1001", surfaceEntityTag: 1 },
        { faceId: input.loadedFaceId, physicalTag: 1002, name: "GM1002", surfaceEntityTag: 2 },
      ], meshSha256: "f".repeat(64),
    },
    solver: {
      solver: "Code_Aster 15.2.0", imageDigest: `sha256:${"a".repeat(64)}`,
      result: {
        solverVersion: "15.02.00", displacementHistory: [{ order: 0, time: 0, minMm: 0, maxMm: 0 }],
        reactionHistory: [{ order: 0, time: 0, xN: 0, yN: 0, zN: 0 }],
        interfaceStateHistory: [{ order: 0, time: 0, elementCount: 20, variables: { V3: { min: 0, max: 0 }, V7: { min: 0, max: 0 }, V8: { min: 0, max: 0 }, V9: { min: 0, max: 0 } } }],
        v3Interpretation: "damage-variable-0-to-1",
        interpretation: "raw-cohesive-solver-response",
      },
      meshResolution: {
        maximumCohesiveEdgeMm: 0.5, recommendedElementsAcrossZone: 5,
        materialEstimates: [
          { material: "A", indicativeProcessZoneLengthMm: 2, estimatedElementsAcrossZone: 4 },
          { material: "B", indicativeProcessZoneLengthMm: 1, estimatedElementsAcrossZone: 2 },
        ], status: "below-indicative-five-element-screen", interpretation: "Test only",
      },
      limitations: ["Test limitation"], diagnostics: [],
    },
    ...(layerPlan ? { layerInterfaceCoverage: layerPlan.coverage, layerInterfaceLimitation: layerPlan.limitation } : {}),
    interpretation: "cohesive-solver-response-only", strengthPass: false, printApproved: false,
  };
}

test("static FEA named load cases are bounded, distinct, and cannot mix with legacy loads", () => {
  const base = {
    bodyId: 7,
    revision: "r1",
    supportFaceIds: ["support"],
    faceLoads: [],
    resultantLoads: [],
    meshSizeMm: 1,
    youngsModulusMPa: 2000,
    youngsModulusEvidence: testYoungsModulusEvidence(),
    poissonRatio: 0.3,
    poissonRatioEvidence: testPoissonRatioEvidence(),
  };
  const valid = femStaticInputSchema.parse({
    ...base,
    loadCases: [
      { name: "device weight", faceLoads: [{ faceId: "base", tractionNPerMm2: [0, 0, -1] }], resultantLoads: [] },
      { name: "screen press", faceLoads: [], resultantLoads: [{ faceId: "button", forceN: [0, -20, 0], applicationPointMm: [5, 3, 8], momentNmm: [0, 0, 0] }] },
    ],
  });
  assert.equal(valid.loadCases.length, 2);
  assert.equal(femStaticInputSchema.safeParse({ ...base, loadCases: [
    { name: "same", faceLoads: [{ faceId: "base", tractionNPerMm2: [1, 0, 0] }], resultantLoads: [] },
    { name: "SAME", faceLoads: [{ faceId: "base", tractionNPerMm2: [0, 1, 0] }], resultantLoads: [] },
  ] }).success, false);
  assert.equal(femStaticInputSchema.safeParse({
    ...base,
    faceLoads: [{ faceId: "base", tractionNPerMm2: [1, 0, 0] }],
    loadCases: [{ name: "extra", faceLoads: [{ faceId: "top", tractionNPerMm2: [0, 1, 0] }], resultantLoads: [] }],
  }).success, false);
  assert.equal(femStaticInputSchema.safeParse({
    ...base,
    loadCases: [{ name: "support collision", faceLoads: [{ faceId: "support", tractionNPerMm2: [1, 0, 0] }], resultantLoads: [] }],
  }).success, false);
  assert.equal(femStaticInputSchema.parse({
    ...base,
    faceLoads: [{ faceId: "loaded", tractionNPerMm2: [1, 0, 0] }],
    meshRefinementSteps: 3,
  }).meshRefinementSteps, 3);
  assert.equal(femStaticInputSchema.safeParse({
    ...base,
    faceLoads: [{ faceId: "loaded", tractionNPerMm2: [1, 0, 0] }],
    meshRefinementSteps: 4,
  }).success, false);
  const twelveJobs = femStaticInputSchema.safeParse({
    ...base,
    loadCases: Array.from({ length: 4 }, (_, index) => ({
      name: `case-${index + 1}`,
      faceLoads: [{ faceId: `face-${index + 1}`, tractionNPerMm2: [1, 0, 0] }],
      resultantLoads: [],
    })),
    meshRefinementSteps: 2,
  });
  assert.equal(twelveJobs.success, true);
  assert.equal(femStaticInputSchema.safeParse({
    ...base,
    loadCases: Array.from({ length: 5 }, (_, index) => ({
      name: `case-${index + 1}`,
      faceLoads: [{ faceId: `face-${index + 1}`, tractionNPerMm2: [1, 0, 0] }],
      resultantLoads: [],
    })),
    meshRefinementSteps: 2,
  }).success, false);
  assert.equal(femStaticInputSchema.safeParse({
    ...base,
    loadCases: Array.from({ length: 3 }, (_, index) => ({
      name: `refined-case-${index + 1}`,
      faceLoads: [{ faceId: `refined-face-${index + 1}`, tractionNPerMm2: [1, 0, 0] }],
      resultantLoads: [],
    })),
    meshRefinementSteps: 3,
  }).success, true);
  assert.equal(femStaticInputSchema.safeParse({
    ...base,
    loadCases: Array.from({ length: 4 }, (_, index) => ({
      name: `over-budget-case-${index + 1}`,
      faceLoads: [{ faceId: `over-budget-face-${index + 1}`, tractionNPerMm2: [1, 0, 0] }],
      resultantLoads: [],
    })),
    meshRefinementSteps: 3,
  }).success, false);
  assert.equal(femStaticInputSchema.safeParse({ ...base, poissonRatioEvidence: undefined }).success, false);
  assert.equal(femStaticInputSchema.safeParse({
    ...base,
    poissonRatioEvidence: { ...testPoissonRatioEvidence(), value: 0.25 },
  }).success, false);
  assert.equal(femStaticInputSchema.safeParse({
    ...base,
    youngsModulusEvidence: { id: "source-e", label: "Young's modulus", status: "sourced", unit: "MPa", value: 2000, sourceUrl: "https://example.org/material", sourceLocator: "table 1", dependsOn: [] },
  }).success, false);
  const sourcedProperties = femStaticInputSchema.parse({
    ...base,
    faceLoads: [{ faceId: "loaded", tractionNPerMm2: [1, 0, 0] }],
    youngsModulusEvidence: {
      id: "source-young-e", label: "Young's modulus", status: "sourced", unit: "MPa", value: 2000,
      sourceUrl: "https://example.org/material", sourceHash: "a".repeat(64), sourceLocator: "table 1", dependsOn: [],
    },
    poissonRatioEvidence: {
      id: "source-poisson", label: "Poisson ratio", status: "sourced", unit: "ratio", value: 0.3,
      sourceUrl: "https://example.org/material", sourceHash: "b".repeat(64), sourceLocator: "table 2", dependsOn: [],
    },
  });
  assert.equal(sourcedProperties.youngsModulusEvidence?.status, "sourced");
  const factoredAllowable = {
    id: "sourced-factored-von-mises-allowable",
    label: "Factored von Mises design allowable",
    status: "sourced" as const,
    unit: "MPa" as const,
    value: 30,
    sourceUrl: "https://example.org/design-allowable",
    sourceHash: "c".repeat(64),
    sourceLocator: "Design table 4, material and build orientation column",
    dependsOn: [],
  };
  const allowableBase = {
    ...base,
    faceLoads: [{ faceId: "loaded", tractionNPerMm2: [1, 0, 0] as [number, number, number] }],
    factoredVonMisesAllowableMPa: 30,
    factoredVonMisesAllowableEvidence: factoredAllowable,
    factoredVonMisesAllowableBasis: "Published design allowable for the specified printed material and build direction; safety factor already included.",
  };
  assert.equal(femStaticInputSchema.safeParse(allowableBase).success, true);
  assert.equal(femStaticInputSchema.safeParse({ ...allowableBase, factoredVonMisesAllowableEvidence: { ...factoredAllowable, value: 25 } }).success, false);
  assert.equal(femStaticInputSchema.safeParse({ ...allowableBase, factoredVonMisesAllowableEvidence: { ...factoredAllowable, status: "assumed" } }).success, false);
  assert.equal(femStaticInputSchema.safeParse({ ...allowableBase, factoredVonMisesAllowableEvidence: undefined }).success, false);
  assert.equal(femStaticInputSchema.safeParse({ ...allowableBase, factoredVonMisesAllowableBasis: undefined }).success, false);
});

test("static FEA accepts explicit per-face translation constraints and resolves legacy supports as fixed", () => {
  const base = {
    bodyId: 7,
    revision: "r1",
    faceLoads: [{ faceId: "load", tractionNPerMm2: [0, 0, -1] as [number, number, number] }],
    resultantLoads: [],
    meshSizeMm: 1,
    youngsModulusMPa: 2000,
    youngsModulusEvidence: testYoungsModulusEvidence(),
    poissonRatio: 0.3,
    poissonRatioEvidence: testPoissonRatioEvidence(),
  };
  const legacy = femStaticInputSchema.parse({ ...base, supportFaceIds: ["support"] });
  assert.deepEqual(resolveFemSupportConditions(legacy), [{ faceId: "support", fixedTranslationAxes: [1, 2, 3] }]);

  const explicit = femStaticInputSchema.parse({
    ...base,
    supportConditions: [
      { faceId: "base", fixedTranslationAxes: ["x", "y", "z"] },
      { faceId: "roller", fixedTranslationAxes: ["z"] },
    ],
  });
  assert.deepEqual(resolveFemSupportConditions(explicit), [
    { faceId: "base", fixedTranslationAxes: [1, 2, 3] },
    { faceId: "roller", fixedTranslationAxes: [3] },
  ]);
  assert.equal(femStaticInputSchema.safeParse({ ...base, supportConditions: [{ faceId: "support", fixedTranslationAxes: [] }] }).success, false);
  assert.equal(femStaticInputSchema.safeParse({ ...base, supportConditions: [{ faceId: "support", fixedTranslationAxes: ["x", "x"] }] }).success, false);
  assert.equal(femStaticInputSchema.safeParse({ ...base, supportFaceIds: ["legacy"], supportConditions: [{ faceId: "support", fixedTranslationAxes: ["x"] }] }).success, false);
  assert.equal(femStaticInputSchema.safeParse({ ...base, supportFaceIds: ["support"], supportConditions: [{ faceId: "other", fixedTranslationAxes: ["x"] }] }).success, false);
  assert.equal(femStaticInputSchema.safeParse({ ...base, supportConditions: [{ faceId: "load", fixedTranslationAxes: ["x"] }] }).success, false);
});

test("static FEA validates orthotropic properties, evidence, axes and persisted stress basis", async (context) => {
  const propertyEvidence = (id: string, label: string, value: number, unit: "MPa" | "ratio") => ({
    id,
    label,
    status: "assumed" as const,
    unit,
    value,
    derivation: "Synthetic orthotropic acceptance fixture; not a physical material qualification.",
    dependsOn: [],
  });
  const base = {
    bodyId: 7,
    revision: "r1",
    supportFaceIds: ["support"],
    faceLoads: [{ faceId: "loaded", tractionNPerMm2: [1, 0, 0] }],
    resultantLoads: [],
    meshSizeMm: 1,
    youngsModulusMPa: 2000,
    youngsModulusEvidence: testYoungsModulusEvidence(),
    poissonRatio: 0.3,
    poissonRatioEvidence: testPoissonRatioEvidence(),
    orthotropicMaterial: {
      youngsModulus2MPa: 1500,
      youngsModulus3MPa: 1000,
      poissonRatio13: 0.22,
      poissonRatio23: 0.27,
      shearModulus12MPa: 500,
      shearModulus13MPa: 400,
      shearModulus23MPa: 300,
      evidence: {
        youngsModulus2MPa: propertyEvidence("e2", "E2", 1500, "MPa"),
        youngsModulus3MPa: propertyEvidence("e3", "E3", 1000, "MPa"),
        poissonRatio13: propertyEvidence("nu13", "nu13", 0.22, "ratio"),
        poissonRatio23: propertyEvidence("nu23", "nu23", 0.27, "ratio"),
        shearModulus12MPa: propertyEvidence("g12", "G12", 500, "MPa"),
        shearModulus13MPa: propertyEvidence("g13", "G13", 400, "MPa"),
        shearModulus23MPa: propertyEvidence("g23", "G23", 300, "MPa"),
      },
      orientation: {
        axis1DirectionGlobal: [0, 1, 0],
        axis2ReferenceDirectionGlobal: [1, 0, 0],
        buildDirectionGlobal: [0, 0, 1],
        evidence: { status: "user-confirmed", description: "User confirmed the first print axis along global Y and second axis along global X." },
      },
    },
  };
  const parsed = femStaticInputSchema.parse(base);
  assert.equal(parsed.orthotropicMaterial?.youngsModulus2MPa, 1500);
  const reportRoot = await mkdtemp(join(tmpdir(), "plasticity-orthotropic-report-"));
  context.after(() => rm(reportRoot, { recursive: true, force: true }));
  const reportStore = new FemReportStore(reportRoot);
  const validReport = femReportContent(parsed, reportRoot);
  validReport.calculation.stressCoordinateBasis = "material-local";
  await reportStore.save(validReport);
  await assert.rejects(() => reportStore.save({
    ...validReport,
    calculation: { ...validReport.calculation, stressCoordinateBasis: "global" },
  }), /stress-coordinate basis does not match its material model/);
  assert.equal(femStaticInputSchema.safeParse({
    ...base,
    orthotropicMaterial: { ...base.orthotropicMaterial, evidence: { ...base.orthotropicMaterial.evidence, youngsModulus2MPa: { ...base.orthotropicMaterial.evidence.youngsModulus2MPa, value: 1400 } } },
  }).success, false);
  assert.equal(femStaticInputSchema.safeParse({
    ...base,
    orthotropicMaterial: { ...base.orthotropicMaterial, poissonRatio13: 0.8, poissonRatio23: -0.8 },
  }).success, false);
  assert.equal(femStaticInputSchema.safeParse({
    ...base,
    orthotropicMaterial: { ...base.orthotropicMaterial, orientation: { ...base.orthotropicMaterial.orientation, axis2ReferenceDirectionGlobal: [0, 3, 0] } },
  }).success, false);
  assert.equal(femStaticInputSchema.safeParse({
    ...base,
    orthotropicMaterial: { ...base.orthotropicMaterial, orientation: { ...base.orthotropicMaterial.orientation, buildDirectionGlobal: [0, 1, 0] } },
  }).success, false);
  assert.equal(femStaticInputSchema.safeParse({
    ...base,
    materialCoupon: { recordId: "a".repeat(64), process: materialCouponQualificationInput().process },
  }).success, false);
  assert.equal(femStaticInputSchema.safeParse({
    ...base,
    factoredVonMisesAllowableMPa: 20,
    factoredVonMisesAllowableEvidence: { id: "allow", label: "allow", status: "sourced", unit: "MPa", value: 20, sourceUrl: "https://example.test/allow", sourceHash: "a".repeat(64), sourceLocator: "table 1", dependsOn: [] },
    factoredVonMisesAllowableBasis: "Direct design allowable for this synthetic fixture.",
  }).success, false);
});

test("static FEA exposes and persists an exact-process orthotropic Tsai-Wu screen", async (context) => {
  let analyzedInput: FemStaticInput | undefined;
  let analysisCalls = 0;
  const harness = await createHarness(context, {
    analyzeStaticFem: async (input, workspace) => { analysisCalls += 1; analyzedInput = input; return femReportContent(input, workspace); },
  });
  const process = {
    printerId: "creality-k1c", materialId: "pla-test", profileHash: "c".repeat(64),
    orientationDeg: [0, 0, 0] as [number, number, number], infillPercent: 100, infillPattern: "grid", wallLoops: 2, topShellLayers: 5, bottomShellLayers: 3, nozzleTemperatureC: 210,
    layerHeightMm: 0.2,
  };
  const strengths = {
    xTensionMPa: 100, xCompressionMPa: 100, yTensionMPa: 100, yCompressionMPa: 100,
    zTensionMPa: 100, zCompressionMPa: 100, xyShearMPa: 100, xzShearMPa: 100, yzShearMPa: 100,
  };
  const strengthEvidence = Object.fromEntries(Object.entries(strengths).map(([key, value], index) => [key, {
    id: `tsai-wu-strength-${key}`, label: `Synthetic test-only ${key}`, status: "measured" as const, unit: "MPa" as const,
    ...orthotropicTsaiWuTestMetadata[key as keyof typeof orthotropicTsaiWuTestMetadata],
    value, sourceUrl: "https://example.org/synthetic-test-fixture", sourceHash: `${index + 1}`.repeat(64),
    sourceLocator: `synthetic test fixture ${key}`, dependsOn: [], process,
  }]));
  const interactions = { xy: 0.5, xz: 0, yz: 0 };
  const interactionEvidence = Object.fromEntries(Object.entries(interactions).map(([key, value], index) => [key, {
    id: `tsai-wu-interaction-${key}`, label: `Synthetic test-only ${key} biaxial fit`, status: "derived" as const,
    testAxis: orthotropicTsaiWuInteractionTestAxis[key as keyof typeof orthotropicTsaiWuInteractionTestAxis], testMode: "biaxial" as const,
    unit: "ratio" as const, value, sourceUrl: "https://example.org/synthetic-test-fixture",
    sourceHash: `${index + 7}`.repeat(64), sourceLocator: `synthetic biaxial fixture ${key}`,
    derivation: "Synthetic test-only normalized fit to one biaxial specimen.", dependsOn: [`synthetic-biaxial-${key}`], process,
  }]));
  const candidate = {
    bodyId: 7, revision: "r1", supportFaceIds: ["support-face"],
    faceLoads: [{ faceId: "load-face", tractionNPerMm2: [1, 0, 0] }], resultantLoads: [],
    meshSizeMm: 1, youngsModulusMPa: 2000, youngsModulusEvidence: testYoungsModulusEvidence(),
    poissonRatio: 0.3, poissonRatioEvidence: {
      id: "coupon-nu12", label: "Synthetic measured test-only nu12", status: "measured", unit: "ratio", value: 0.3,
      sourceUrl: "https://example.org/synthetic-test-fixture", sourceHash: "a".repeat(64), sourceLocator: "synthetic nu12 report p.1", dependsOn: [],
    },
    orthotropicMaterial: {
      youngsModulus2MPa: 1500, youngsModulus3MPa: 1000, poissonRatio13: 0.22, poissonRatio23: 0.27,
      shearModulus12MPa: 500, shearModulus13MPa: 400, shearModulus23MPa: 300,
      evidence: {
        youngsModulus2MPa: testPropertyEvidence("ortho-e2", 1500), youngsModulus3MPa: testPropertyEvidence("ortho-e3", 1000),
        poissonRatio13: testPropertyEvidence("ortho-nu13", 0.22, "ratio"), poissonRatio23: testPropertyEvidence("ortho-nu23", 0.27, "ratio"),
        shearModulus12MPa: testPropertyEvidence("ortho-g12", 500), shearModulus13MPa: testPropertyEvidence("ortho-g13", 400), shearModulus23MPa: testPropertyEvidence("ortho-g23", 300),
      },
      orientation: {
        axis1DirectionGlobal: [1, 0, 0], axis2ReferenceDirectionGlobal: [0, 1, 0], buildDirectionGlobal: [0, 0, 1],
        evidence: { status: "user-confirmed" as const, description: "User confirmed the homogeneous test axes and build direction." },
      },
      process,
      tsaiWuCriterion: {
        strengths, interactions, strengthEvidence, interactionEvidence,
        basis: "Synthetic test-only single-profile strengths and biaxial interaction fit.",
      },
    },
  };
  const response = await harness.client.callTool({ name: "plasticity_analyze_static_fem", arguments: candidate });
  assert.notEqual(response.isError, true, JSON.stringify(response.content));
  const report = output(response);
  assert.equal(report.orthotropicTsaiWuScreen.kind, "orthotropic-tsai-wu-3d-proportional-load-factor-screen");
  assert.equal(report.orthotropicTsaiWuScreen.cases[0].samples[0].maximumFailureIndex, 1.08);
  assert.equal(report.orthotropicTsaiWuScreen.overallStatus, "at-least-one-sampled-index-at-or-above-one");
  assert.equal(report.strengthPass, false);

  const reread = output(await harness.client.callTool({ name: "plasticity_static_fem_report", arguments: { reportId: report.id } }));
  assert.equal(reread.orthotropicTsaiWuScreen.cases[0].samples[0].minimumLoadFactorToIndexOne, 1 / Math.sqrt(1.08));

  const qualification = materialCouponQualificationInput();
  qualification.process = process;
  qualification.properties.youngModulusMPa = candidate.youngsModulusMPa;
  qualification.evidence.find((item) => item.id === qualification.propertyEvidence.youngModulusMPa[0])!.value = candidate.youngsModulusMPa;
  qualification.poissonRatio = 0.3;
  qualification.poissonRatioEvidence = ["coupon-nu12"];
  qualification.evidence.push({
    id: "coupon-nu12", label: "Synthetic measured test-only nu12", status: "measured", unit: "ratio", value: 0.3,
    sourceUrl: "https://example.org/synthetic-test-fixture", sourceHash: "a".repeat(64), sourceLocator: "synthetic nu12 report p.1", dependsOn: [],
  });
  const orthotropicConstants = {
    youngsModulus2MPa: 1500, youngsModulus3MPa: 1000, poissonRatio13: 0.22, poissonRatio23: 0.27,
    shearModulus12MPa: 500, shearModulus13MPa: 400, shearModulus23MPa: 300,
  };
  const propertyEvidence = Object.entries(orthotropicConstants).map(([key, value], index) => ({
    id: `coupon-${key}`, label: `Synthetic test-only ${key}`, status: "measured" as const,
    unit: key.startsWith("poisson") ? "ratio" as const : "MPa" as const, value,
    sourceUrl: "https://example.org/synthetic-test-fixture", sourceHash: (index + 1).toString(16).padStart(64, "0"),
    sourceLocator: `synthetic fixture ${key}`, dependsOn: [],
  }));
  const couponStrengthEvidence = Object.entries(strengths).map(([key, value], index) => ({
    id: `coupon-strength-${key}`, label: `Synthetic test-only ${key}`, status: "measured" as const, unit: "MPa" as const,
    ...orthotropicTsaiWuTestMetadata[key as keyof typeof orthotropicTsaiWuTestMetadata],
    value, sourceUrl: "https://example.org/synthetic-test-fixture", sourceHash: (index + 11).toString(16).padStart(64, "0"),
    sourceLocator: `synthetic fixture ${key}`, dependsOn: [],
  }));
  const couponBiaxialEvidence = Object.keys(interactions).map((key, index) => ({
    id: `coupon-biaxial-${key}`, label: `Synthetic test-only biaxial ${key}`, status: "measured" as const,
    testAxis: orthotropicTsaiWuInteractionTestAxis[key as keyof typeof orthotropicTsaiWuInteractionTestAxis], testMode: "biaxial" as const,
    sourceUrl: "https://example.org/synthetic-test-fixture", sourceHash: (index + 21).toString(16).padStart(64, "0"),
    sourceLocator: `synthetic fixture biaxial ${key}`, dependsOn: [],
  }));
  const couponInteractionEvidence = Object.entries(interactions).map(([key, value], index) => ({
    id: `coupon-interaction-${key}`, label: `Synthetic test-only ${key} interaction`, status: "derived" as const, unit: "ratio" as const,
    testAxis: orthotropicTsaiWuInteractionTestAxis[key as keyof typeof orthotropicTsaiWuInteractionTestAxis], testMode: "biaxial" as const,
    value, sourceUrl: "https://example.org/synthetic-test-fixture", sourceHash: (index + 31).toString(16).padStart(64, "0"),
    sourceLocator: `synthetic fixture ${key} fit`, derivation: "Synthetic registry binding fixture.", dependsOn: [`coupon-biaxial-${key}`],
  }));
  qualification.orthotropicMaterial = {
    ...orthotropicConstants,
    propertyEvidence: Object.fromEntries(Object.keys(orthotropicConstants).map((key) => [key, [`coupon-${key}`]])) as NonNullable<MaterialCouponQualificationInput["orthotropicMaterial"]>["propertyEvidence"],
    orientation: {
      axis1DirectionGlobal: [1, 0, 0], axis2ReferenceDirectionGlobal: [0, 1, 0], buildDirectionGlobal: [0, 0, 1],
      evidence: { status: "user-confirmed", description: "Synthetic test-only coupon axes." },
    },
    tsaiWuCriterion: {
      strengths, interactions,
      strengthEvidence: Object.fromEntries(Object.keys(strengths).map((key) => [key, [`coupon-strength-${key}`]])) as NonNullable<NonNullable<MaterialCouponQualificationInput["orthotropicMaterial"]>["tsaiWuCriterion"]>["strengthEvidence"],
      interactionEvidence: { xy: "coupon-interaction-xy", xz: "coupon-interaction-xz", yz: "coupon-interaction-yz" },
    },
  };
  qualification.evidence.push(...propertyEvidence, ...couponStrengthEvidence, ...couponBiaxialEvidence, ...couponInteractionEvidence);
  const qualificationResponse = await harness.client.callTool({ name: "plasticity_record_material_coupon_data", arguments: qualification });
  assert.notEqual(qualificationResponse.isError, true, JSON.stringify(qualificationResponse.content));
  const savedQualification = output(qualificationResponse);
  const couponEvidenceById = new Map<string, any>(savedQualification.record.evidence.map((item: any) => [item.id, item]));
  const couponOrthotropic = savedQualification.record.orthotropicMaterial;
  const orthotropicPropertyKeys = Object.keys(orthotropicConstants) as Array<keyof typeof orthotropicConstants>;
  const referencedInput = {
    ...candidate,
    youngsModulusEvidence: undefined,
    poissonRatioEvidence: couponEvidenceById.get(savedQualification.record.poissonRatioEvidence[0])!,
    materialCoupon: { recordId: savedQualification.record.id, process },
    orthotropicMaterial: {
      ...candidate.orthotropicMaterial,
      evidence: Object.fromEntries(orthotropicPropertyKeys.map((key) => [key, couponEvidenceById.get(couponOrthotropic.propertyEvidence[key][0])!])),
      orientation: couponOrthotropic.orientation,
      process,
      couponRecordId: savedQualification.record.id,
      tsaiWuCriterion: undefined,
      tsaiWuQualificationRecordId: savedQualification.record.id,
    },
  };
  const boundResponse = await harness.client.callTool({ name: "plasticity_analyze_static_fem", arguments: referencedInput });
  assert.notEqual(boundResponse.isError, true, JSON.stringify(boundResponse.content));
  const boundReport = output(boundResponse);
  assert.equal(analyzedInput?.orthotropicMaterial?.tsaiWuCriterion?.qualificationRecordId, savedQualification.record.id);
  assert.deepEqual(analyzedInput?.orthotropicMaterial?.tsaiWuCriterion?.strengths, strengths);
  assert.equal(analyzedInput?.orthotropicMaterial?.tsaiWuCriterion?.strengthEvidence.xTensionMPa.id, "coupon-strength-xTensionMPa");

  const mismatchedOrthotropicTensor = await harness.client.callTool({
    name: "plasticity_analyze_static_fem",
    arguments: {
      ...referencedInput,
      orthotropicMaterial: {
        ...referencedInput.orthotropicMaterial,
        youngsModulus2MPa: referencedInput.orthotropicMaterial.youngsModulus2MPa + 1,
        evidence: {
          ...referencedInput.orthotropicMaterial.evidence,
          youngsModulus2MPa: {
            ...referencedInput.orthotropicMaterial.evidence.youngsModulus2MPa,
            id: "unrecorded-e2",
            value: referencedInput.orthotropicMaterial.youngsModulus2MPa + 1,
          },
        },
      },
    },
  });
  assert.equal(mismatchedOrthotropicTensor.isError, true);
  assert.match(JSON.stringify(mismatchedOrthotropicTensor.content), /youngsModulus2MPa does not equal the selected exact-process orthotropic coupon record/i);
  assert.equal(analysisCalls, 2, "an unrecorded orthotropic tensor value must be rejected before launching the solver");

  const mismatchedOrthotropicProvenance = await harness.client.callTool({
    name: "plasticity_analyze_static_fem",
    arguments: {
      ...referencedInput,
      orthotropicMaterial: {
        ...referencedInput.orthotropicMaterial,
        evidence: { ...referencedInput.orthotropicMaterial.evidence, shearModulus23MPa: { ...referencedInput.orthotropicMaterial.evidence.shearModulus23MPa, sourceHash: "e".repeat(64) } },
      },
    },
  });
  assert.equal(mismatchedOrthotropicProvenance.isError, true);
  assert.match(JSON.stringify(mismatchedOrthotropicProvenance.content), /shearModulus23MPa evidence does not match the selected exact-process orthotropic coupon record/i);
  assert.equal(analysisCalls, 2, "changed orthotropic provenance must be rejected before launching the solver");

  const mismatchedNu12 = await harness.client.callTool({
    name: "plasticity_analyze_static_fem",
    arguments: {
      ...referencedInput,
      poissonRatio: 0.29,
      poissonRatioEvidence: {
        ...referencedInput.poissonRatioEvidence,
        id: "other-nu12", value: 0.29, sourceHash: "d".repeat(64), sourceLocator: "synthetic other nu12 report p.1",
      },
    },
  });
  assert.equal(mismatchedNu12.isError, true);
  assert.match(JSON.stringify(mismatchedNu12.content), /Poisson ratio nu12 does not equal/i);
  assert.equal(analysisCalls, 2, "a nu12 mismatch must be rejected before launching the solver");

  const mismatchedNu12Evidence = await harness.client.callTool({
    name: "plasticity_analyze_static_fem",
    arguments: {
      ...referencedInput,
      poissonRatioEvidence: { ...referencedInput.poissonRatioEvidence, sourceHash: "e".repeat(64) },
    },
  });
  assert.equal(mismatchedNu12Evidence.isError, true);
  assert.match(JSON.stringify(mismatchedNu12Evidence.content), /evidence does not match the selected exact-process physical coupon record/i);
  assert.equal(analysisCalls, 2, "changed nu12 provenance must be rejected before launching the solver");

  const mismatchedAxes = await harness.client.callTool({
    name: "plasticity_analyze_static_fem",
    arguments: {
      ...referencedInput,
      orthotropicMaterial: {
        ...referencedInput.orthotropicMaterial,
        orientation: {
          ...referencedInput.orthotropicMaterial.orientation,
          axis1DirectionGlobal: [0, 1, 0], axis2ReferenceDirectionGlobal: [1, 0, 0],
        },
      },
    },
  });
  assert.equal(mismatchedAxes.isError, true);
  assert.match(JSON.stringify(mismatchedAxes.content), /axes do not match the FEA material coordinate frame/i);
  assert.equal(analysisCalls, 2);

  await unlink(join(harness.root, "material-qualifications", `${savedQualification.record.id}.json`));
  const staleReport = output(await harness.client.callTool({ name: "plasticity_static_fem_report", arguments: { reportId: boundReport.id } }));
  assert.equal(staleReport.freshness.status, "stale");
  assert.match(staleReport.freshness.reason, /Orthotropic Tsai-Wu qualification record could not be verified/i);
});

test("lists all strength tools, prompt and versioned resources", async (context) => {
  const harness = await createHarness(context, { analysis: null, unavailableReason: "Codex profile is unavailable" });
  const tools = await harness.client.listTools();
  const staticFemTool = tools.tools.find((tool) => tool.name === "plasticity_analyze_static_fem");
  assert.match(staticFemTool?.description ?? "", /supportConditions/);
  assert.match(staticFemTool?.description ?? "", /do not infer them from a photo or face orientation/);
  assert.match(staticFemTool?.description ?? "", /factoredVonMisesAllowableMPa/);
  assert.match(staticFemTool?.description ?? "", /tsaiWuQualificationRecordId/);
  assert.match(staticFemTool?.description ?? "", /never combine material datasets/);
  assert.match(staticFemTool?.description ?? "", /never establishes strength/);
  assert.match(staticFemTool?.description ?? "", /up to 256/);
  const compareFemTool = tools.tools.find((tool) => tool.name === "plasticity_compare_static_fem_refinement_reports");
  assert.match(compareFemTool?.description ?? "", /byte-identical repeated mesh hashes/);
  const cohesiveTool = tools.tools.find((tool) => tool.name === "plasticity_analyze_cohesive_interface");
  assert.match(cohesiveTool?.description ?? "", /does not establish strength/);
  assert.match(cohesiveTool?.description ?? "", /1\.\.255 ordered parallel planes/);
  assert.equal(cohesiveTool?.annotations?.readOnlyHint, false);
  const layerPlanTool = tools.tools.find((tool) => tool.name === "plasticity_plan_cohesive_layer_planes");
  assert.match(layerPlanTool?.description ?? "", /up to 256 layers/);
  const duplicateReports = await harness.client.callTool({
    name: "plasticity_compare_static_fem_refinement_reports",
    arguments: { reportIds: ["00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000001"] },
  });
  assert.equal(duplicateReports.isError, true);
  assert.match(JSON.stringify(duplicateReports.content), /must be unique/i);
  for (const name of [
    "plasticity_strength_methods",
    "plasticity_plan_single_material_strength_tests",
    "plasticity_record_material_coupon_data",
    "plasticity_combine_material_coupon_data",
    "plasticity_match_material_coupon_data",
    "plasticity_list_material_coupon_data",
    "plasticity_record_material_interface_test",
    "plasticity_calculate_dcb_mode_i_energy",
    "plasticity_import_dcb_mode_i_energy_csv",
    "plasticity_calculate_enf_mode_ii_energy",
    "plasticity_import_enf_mode_ii_energy_csv",
    "plasticity_record_enf_mode_ii_energy_test",
    "plasticity_match_enf_mode_ii_energy_test",
    "plasticity_list_enf_mode_ii_energy_tests",
    "plasticity_read_enf_mode_ii_energy_test",
    "plasticity_record_dcb_mode_i_energy_test",
    "plasticity_match_dcb_mode_i_energy_test",
    "plasticity_list_dcb_mode_i_energy_tests",
    "plasticity_read_dcb_mode_i_energy_test",
    "plasticity_import_interface_tensile_csv",
    "plasticity_import_interface_fracture_csv",
    "plasticity_match_material_interface_test",
    "plasticity_list_material_interface_tests",
    "plasticity_analyze_material_interface_test_curve",
    "plasticity_record_fastener_group_test",
    "plasticity_match_fastener_group_test",
    "plasticity_list_fastener_group_tests",
    "plasticity_analyze_static_fem",
    "plasticity_analyze_cohesive_interface",
    "plasticity_static_fem_report",
    "plasticity_compare_static_fem_refinement_reports",
    "plasticity_analyze_strength_task",
    "plasticity_strength_request",
    "plasticity_analyze_design_reference",
    "plasticity_design_reference_request",
    "plasticity_reference_search_status",
    "plasticity_search_product_references",
    "plasticity_calculate_strength",
    "plasticity_size_member",
    "plasticity_inspect_rectangular_member",
    "plasticity_inspect_integral_rectangular_plate",
    "plasticity_verify_member_strength",
    "plasticity_verify_integral_plate_strength",
    "plasticity_inspect_planar_section",
    "plasticity_inspect_arbitrary_section",
    "plasticity_inspect_arbitrary_sections",
    "plasticity_scan_arbitrary_sections",
    "plasticity_scan_section_strength",
    "plasticity_section_strength_scan_report",
    "plasticity_inspect_single_fastener_plate",
    "plasticity_calculate_section_strength",
    "plasticity_verify_section_strength",
    "plasticity_calculate_single_fastener_strength",
    "plasticity_verify_single_fastener_strength",
    "plasticity_calculate_fastener_member_strength",
    "plasticity_calculate_threaded_receiver_strength",
    "plasticity_calculate_tongue_root_strength_from_coupon_data",
    "plasticity_verify_tongue_root_strength_from_coupon_data",
    "plasticity_calculate_rectangular_strength_from_coupon_data",
    "plasticity_calculate_heat_set_insert_retention",
    "plasticity_distribute_fastener_group_load",
    "plasticity_verify_fastener_group_load",
    "plasticity_strength_report",
  ]) assert.ok(tools.tools.some((tool) => tool.name === name), `missing ${name}`);
  const dcbEnergyTool = tools.tools.find((tool) => tool.name === "plasticity_calculate_dcb_mode_i_energy")!;
  assert.equal(dcbEnergyTool.annotations?.readOnlyHint, true);
  assert.match(dcbEnergyTool.description ?? "", /not a standards-conformance determination/i);
  const dcbEnergyArguments = {
    materialProcess: {
      printerId: "creality-k1c-0.4", materialId: "creality-cr-pla", profileHash: "b".repeat(64),
      orientationDeg: [0, 0, 0], infillPercent: 100, infillPattern: "grid", wallLoops: 2,
      topShellLayers: 5, bottomShellLayers: 3, nozzleTemperatureC: 220, layerHeightMm: 0.2,
    },
    testProtocolHash: "c".repeat(64), testedAt: "2026-09-25T12:00:00Z",
    interfaceNormalGlobal: [0, 0, 1], testMethod: "DCB Mode-I MBT study",
    displacementEvidence: "machine-compliance-corrected-load-point-displacement",
    linearElasticQuasiStaticEvidence: "confirmed-linear-elastic-quasi-static-test",
    specimens: [{
      specimenId: "DCB-1", widthMm: 25, totalLengthMm: 125, armThicknessMm: 2.5,
      failureLocation: "interface", sourceHash: "a".repeat(64),
      points: [
        { crackLengthMm: 40, forceN: 10, loadPointDisplacementMm: 4, sourceLocator: "run.csv!row 2" },
        { crackLengthMm: 50, forceN: 8, loadPointDisplacementMm: 5, sourceLocator: "run.csv!row 3" },
        { crackLengthMm: 60, forceN: 6, loadPointDisplacementMm: 6, sourceLocator: "run.csv!row 4" },
      ],
    }],
  };
  const dcbEnergyCsvPath = join(harness.root, "dcb-energy.csv");
  await writeFile(dcbEnergyCsvPath, "specimen,load_kN,opening_um,note\nDCB-1,-0.01,2160,observed-a\nDCB-1,-0.008,2744,observed-b\nDCB-1,-0.006,3072,observed-c\nDCB-1,-0.005,3200,unselected\n");
  const dcbEnergyCsvTool = tools.tools.find((tool) => tool.name === "plasticity_import_dcb_mode_i_energy_csv")!;
  assert.equal(dcbEnergyCsvTool.annotations?.readOnlyHint, true);
  assert.match(dcbEnergyCsvTool.description ?? "", /correct machine compliance/i);
  const dcbEnergyCsvPreview = output(await harness.client.callTool({
    name: "plasticity_import_dcb_mode_i_energy_csv",
    arguments: {
      path: dcbEnergyCsvPath,
      specimenIdColumn: "specimen", forceColumn: "load_kN", forceUnit: "kN", forceSign: "negative",
      displacementColumn: "opening_um", displacementUnit: "um", displacementSign: "positive",
      delimiter: "comma", decimalSeparator: "period",
      materialProcess: dcbEnergyArguments.materialProcess,
      interfaceNormalGlobal: dcbEnergyArguments.interfaceNormalGlobal,
      testProtocolHash: dcbEnergyArguments.testProtocolHash,
      testMethod: dcbEnergyArguments.testMethod,
      testedAt: dcbEnergyArguments.testedAt,
      displacementEvidence: dcbEnergyArguments.displacementEvidence,
      linearElasticQuasiStaticEvidence: dcbEnergyArguments.linearElasticQuasiStaticEvidence,
      specimens: [{
        specimenId: "DCB-1", widthMm: 25, totalLengthMm: 125, armThicknessMm: 2.5,
        failureLocation: "interface",
        crackObservations: [
          { csvRecordNumber: 2, crackLengthMm: 40 },
          { csvRecordNumber: 3, crackLengthMm: 50 },
          { csvRecordNumber: 4, crackLengthMm: 60 },
        ],
      }],
    },
  }));
  assert.equal(dcbEnergyCsvPreview.sourceName, "dcb-energy.csv");
  assert.equal(dcbEnergyCsvPreview.recordInput.specimens[0].points[0].forceN, 10);
  assert.equal(dcbEnergyCsvPreview.recordInput.specimens[0].points[0].loadPointDisplacementMm, 2.16);
  assert.equal(dcbEnergyCsvPreview.recordInput.specimens[0].points[0].sourceLocator, "dcb-energy.csv!record 2");
  const dcbEnergyCsvInvalid = await harness.client.callTool({
    name: "plasticity_import_dcb_mode_i_energy_csv",
    arguments: { path: dcbEnergyCsvPath, specimenIdColumn: "specimen", forceColumn: "load_kN", forceUnit: "kN" },
  });
  assert.equal(dcbEnergyCsvInvalid.isError, true);
  const enfEnergyTool = tools.tools.find((tool) => tool.name === "plasticity_calculate_enf_mode_ii_energy")!;
  assert.equal(enfEnergyTool.annotations?.readOnlyHint, true);
  assert.match(enfEnergyTool.description ?? "", /printed PLA is outside the validated scope/i);
  const enfEnergyArguments = {
    materialProcess: dcbEnergyArguments.materialProcess,
    interfaceNormalGlobal: dcbEnergyArguments.interfaceNormalGlobal,
    interfaceShearDirectionGlobal: [1, 0, 0],
    testProtocolHash: dcbEnergyArguments.testProtocolHash,
    testMethod: "ENF Mode-II compliance calibration",
    testedAt: dcbEnergyArguments.testedAt,
    complianceEvidence: "inverse-initial-linear-force-displacement-slope-same-fixture",
    linearElasticQuasiStaticEvidence: "confirmed-linear-elastic-quasi-static-test",
    specimens: [{
      specimenId: "ENF-1", widthMm: 20, totalLengthMm: 160, armThicknessMm: 2,
      failureLocation: "interface",
      calibration: [
        { crackLengthMm: 20, complianceMmPerN: 0.009, sourceHash: "d".repeat(64), sourceLocator: "cal.csv!rows 2-12" },
        { crackLengthMm: 30, complianceMmPerN: 0.028, sourceHash: "d".repeat(64), sourceLocator: "cal.csv!rows 13-23" },
        { crackLengthMm: 40, complianceMmPerN: 0.065, sourceHash: "d".repeat(64), sourceLocator: "cal.csv!rows 24-34" },
      ],
      fracture: { initialCrackLengthMm: 30, peakForceN: 100, sourceHash: "e".repeat(64), sourceLocator: "fracture.csv!record 88" },
    }],
  };
  const enfEnergyPreview = output(await harness.client.callTool({
    name: "plasticity_calculate_enf_mode_ii_energy",
    arguments: enfEnergyArguments,
  }));
  assert.equal(enfEnergyPreview.method, "end-notched-flexure-compliance-calibration");
  assert.equal(enfEnergyPreview.specimens[0].energyReleaseRateJPerM2, 675);
  assert.equal(enfEnergyPreview.specimens[0].eligibleForLayerInterfaceEvidence, true);
  const mmbEnergyTool = tools.tools.find((tool) => tool.name === "plasticity_calculate_mmb_mode_i_ii_energy")!;
  assert.equal(mmbEnergyTool.annotations?.readOnlyHint, true);
  assert.match(mmbEnergyTool.description ?? "", /axis 1 = shear/i);
  assert.match(mmbEnergyTool.description ?? "", /not .*cohesive FEA/i);
  const mmbEnergyPreview = output(await harness.client.callTool({
    name: "plasticity_calculate_mmb_mode_i_ii_energy",
    arguments: {
      materialProcess: dcbEnergyArguments.materialProcess,
      interfaceNormalGlobal: [0, 0, 1],
      interfaceShearDirectionGlobal: [1, 0, 0],
      testProtocolHash: "c".repeat(64),
      testMethod: "MMB beam-theory initiation screen",
      testedAt: dcbEnergyArguments.testedAt,
      axesMappingConfirmed: "moduli-axis-1-matches-shear-axis-2-is-in-plane-transverse-3-is-interface-normal",
      leverWeight: "measured-negligible-or-counterbalanced",
      flexuralModulus: { valueMPa: 1800, sourceHash: "d".repeat(64), sourceLocator: "flexure.csv!records 20-40" },
      orthotropicModuli: { E11MPa: 2000, E22MPa: 1500, G13MPa: 500, sourceHash: "e".repeat(64), sourceLocator: "coupon.pdf!table 3" },
      specimens: [{
        specimenId: "MMB-1", widthMm: 25, totalLengthMm: 150, armThicknessMm: 2.5,
        halfSpanMm: 50, leverArmMm: 100, initialCrackLengthMm: 50, criticalForceN: 100,
        initiationCriterion: "visual-crack-initiation",
        failureLocation: "interface", sourceHash: "f".repeat(64), sourceLocator: "mmb.csv!record 80",
      }],
    },
  }));
  assert.equal(mmbEnergyPreview.method, "reeder-crews-mmb-beam-theory");
  assert.ok(mmbEnergyPreview.specimens[0].modeIEnergyReleaseRateJPerM2 > 0);
  assert.ok(mmbEnergyPreview.specimens[0].modeIIEnergyReleaseRateJPerM2 > 0);
  assert.ok(Math.abs(mmbEnergyPreview.specimens[0].modeIIModeMixFraction - 0.205) < 0.005);
  assert.equal(mmbEnergyPreview.specimens[0].eligibleForLayerInterfaceEvidence, true);
  const mmbCsvTool = tools.tools.find((tool) => tool.name === "plasticity_import_mmb_mode_i_ii_energy_csv")!;
  assert.equal(mmbCsvTool.annotations?.readOnlyHint, true);
  assert.match(mmbCsvTool.description ?? "", /never selects a peak/i);
  const mmbCsvPath = join(harness.root, "mmb-energy.csv");
  await writeFile(mmbCsvPath, "specimen,force_kN,note\nMMB-1,0.1,pre-initiation\nMMB-1,0.12,selected initiation\nMMB-1,0.15,later maximum\n");
  const mmbCsvPreview = output(await harness.client.callTool({
    name: "plasticity_import_mmb_mode_i_ii_energy_csv",
    arguments: {
      path: mmbCsvPath, specimenIdColumn: "specimen", forceColumn: "force_kN", forceUnit: "kN",
      forceSign: "positive", delimiter: "comma", decimalSeparator: "period",
      materialProcess: dcbEnergyArguments.materialProcess,
      interfaceNormalGlobal: [0, 0, 1], interfaceShearDirectionGlobal: [1, 0, 0],
      testProtocolHash: "c".repeat(64), testMethod: "MMB beam-theory initiation screen", testedAt: dcbEnergyArguments.testedAt,
      axesMappingConfirmed: "moduli-axis-1-matches-shear-axis-2-is-in-plane-transverse-3-is-interface-normal",
      leverWeight: "measured-negligible-or-counterbalanced",
      flexuralModulus: { valueMPa: 1800, sourceHash: "d".repeat(64), sourceLocator: "flexure.csv!records 20-40" },
      orthotropicModuli: { E11MPa: 2000, E22MPa: 1500, G13MPa: 500, sourceHash: "e".repeat(64), sourceLocator: "coupon.pdf!table 3" },
      specimens: [{
        specimenId: "MMB-1", selectedRecordNumber: 3, initiationCriterion: "visual-crack-initiation",
        widthMm: 25, totalLengthMm: 150, armThicknessMm: 2.5, halfSpanMm: 50, leverArmMm: 100,
        initialCrackLengthMm: 50, failureLocation: "interface",
      }],
    },
  }));
  assert.equal(mmbCsvPreview.sourceName, "mmb-energy.csv");
  assert.equal(mmbCsvPreview.recordInput.specimens[0].criticalForceN, 120);
  assert.equal(mmbCsvPreview.recordInput.specimens[0].sourceLocator, "mmb-energy.csv!record 3");
  assert.equal(mmbCsvPreview.calculation.specimens[0].criticalForceN, 120);
  const mmbRecordTool = tools.tools.find((tool) => tool.name === "plasticity_record_mmb_mode_i_ii_energy_test")!;
  assert.equal(mmbRecordTool.annotations?.readOnlyHint, false);
  const mmbBeforeRecord = output(await harness.client.callTool({ name: "plasticity_list_mmb_mode_i_ii_energy_tests", arguments: {} }));
  assert.equal(mmbBeforeRecord.records.length, 0);
  const savedMmb = output(await harness.client.callTool({
    name: "plasticity_record_mmb_mode_i_ii_energy_test",
    arguments: { ...mmbCsvPreview.recordInput, callerConfirmsPhysicalTests: true },
  }));
  assert.equal(savedMmb.record.calculation.specimens[0].criticalForceN, 120);
  assert.equal(savedMmb.record.input.callerConfirmsPhysicalTests, true);
  const mmbMatch = output(await harness.client.callTool({
    name: "plasticity_match_mmb_mode_i_ii_energy_test",
    arguments: {
      materialProcess: dcbEnergyArguments.materialProcess,
      interfaceNormalGlobal: [0, 0, 1], interfaceShearDirectionGlobal: [1, 0, 0], testProtocolHash: "c".repeat(64),
    },
  }));
  assert.equal(mmbMatch.status, "matched");
  assert.equal(mmbMatch.selectedRecordId, savedMmb.record.id);
  const mmbMismatch = output(await harness.client.callTool({
    name: "plasticity_match_mmb_mode_i_ii_energy_test",
    arguments: {
      materialProcess: dcbEnergyArguments.materialProcess,
      interfaceNormalGlobal: [0, 0, 1], interfaceShearDirectionGlobal: [0, 1, 0], testProtocolHash: "c".repeat(64),
    },
  }));
  assert.equal(mmbMismatch.status, "no-match");
  const mmbListed = output(await harness.client.callTool({ name: "plasticity_list_mmb_mode_i_ii_energy_tests", arguments: {} }));
  assert.equal(mmbListed.records.length, 1);
  const mmbRead = output(await harness.client.callTool({
    name: "plasticity_read_mmb_mode_i_ii_energy_test", arguments: { recordId: savedMmb.record.id },
  }));
  assert.equal(mmbRead.id, savedMmb.record.id);
  const unconfirmedMmb = await harness.client.callTool({
    name: "plasticity_record_mmb_mode_i_ii_energy_test",
    arguments: { ...mmbCsvPreview.recordInput, callerConfirmsPhysicalTests: false },
  });
  assert.equal(unconfirmedMmb.isError, true);
  const enfCsvPath = join(harness.root, "enf-energy.csv");
  await writeFile(enfCsvPath, [
    "specimen,run,force_kN,opening_um",
    "ENF-1,c20,-0.01,90", "ENF-1,c20,-0.02,180", "ENF-1,c20,-0.03,270",
    "ENF-1,c30,-0.01,280", "ENF-1,c30,-0.02,560", "ENF-1,c30,-0.03,840",
    "ENF-1,c40,-0.01,650", "ENF-1,c40,-0.02,1300", "ENF-1,c40,-0.03,1950",
    "ENF-1,fracture,-0.1,600", "ENF-1,fracture,-0.2,1200", "",
  ].join("\n"));
  const enfCsvTool = tools.tools.find((tool) => tool.name === "plasticity_import_enf_mode_ii_energy_csv")!;
  assert.equal(enfCsvTool.annotations?.readOnlyHint, true);
  assert.match(enfCsvTool.description ?? "", /never chooses a peak/i);
  const enfCsvPreview = output(await harness.client.callTool({
    name: "plasticity_import_enf_mode_ii_energy_csv",
    arguments: {
      path: enfCsvPath,
      specimenIdColumn: "specimen", runIdColumn: "run",
      forceColumn: "force_kN", forceUnit: "kN", forceSign: "negative",
      displacementColumn: "opening_um", displacementUnit: "um", displacementSign: "positive",
      delimiter: "comma", decimalSeparator: "period",
      ...enfEnergyArguments,
      specimens: [{
        specimenId: "ENF-1", widthMm: 20, totalLengthMm: 160, armThicknessMm: 2,
        failureLocation: "interface",
        calibrationRuns: [
          { runId: "c20", crackLengthMm: 20, csvRecordNumbers: [2, 3, 4] },
          { runId: "c30", crackLengthMm: 30, csvRecordNumbers: [5, 6, 7] },
          { runId: "c40", crackLengthMm: 40, csvRecordNumbers: [8, 9, 10] },
        ],
        fractureRunId: "fracture", fracturePeakRecordNumber: 11, initialCrackLengthMm: 30,
      }],
    },
  }));
  assert.equal(enfCsvPreview.sourceName, "enf-energy.csv");
  assert.ok(Math.abs(enfCsvPreview.recordInput.specimens[0].calibration[0].complianceMmPerN - 0.009) < 1e-12);
  assert.equal(enfCsvPreview.recordInput.specimens[0].fracture.peakForceN, 100);
  assert.equal(enfCsvPreview.calculation.specimens[0].energyReleaseRateJPerM2, 675);
  const enfRecordTool = tools.tools.find((tool) => tool.name === "plasticity_record_enf_mode_ii_energy_test")!;
  assert.equal(enfRecordTool.annotations?.readOnlyHint, false);
  const enfBeforeRecord = output(await harness.client.callTool({ name: "plasticity_list_enf_mode_ii_energy_tests", arguments: {} }));
  assert.equal(enfBeforeRecord.records.length, 0);
  const savedEnf = output(await harness.client.callTool({
    name: "plasticity_record_enf_mode_ii_energy_test",
    arguments: { ...enfCsvPreview.recordInput, callerConfirmsPhysicalTests: true },
  }));
  assert.equal(savedEnf.record.calculation.specimens[0].energyReleaseRateJPerM2, 675);
  assert.equal(savedEnf.record.input.callerConfirmsPhysicalTests, true);
  const enfMatch = output(await harness.client.callTool({
    name: "plasticity_match_enf_mode_ii_energy_test",
    arguments: {
      materialProcess: enfEnergyArguments.materialProcess,
      interfaceNormalGlobal: enfEnergyArguments.interfaceNormalGlobal,
      interfaceShearDirectionGlobal: enfEnergyArguments.interfaceShearDirectionGlobal,
      testProtocolHash: enfEnergyArguments.testProtocolHash,
    },
  }));
  assert.equal(enfMatch.status, "matched");
  assert.equal(enfMatch.selectedRecordId, savedEnf.record.id);
  const enfMismatch = output(await harness.client.callTool({
    name: "plasticity_match_enf_mode_ii_energy_test",
    arguments: {
      materialProcess: enfEnergyArguments.materialProcess,
      interfaceNormalGlobal: enfEnergyArguments.interfaceNormalGlobal,
      interfaceShearDirectionGlobal: [0, 1, 0],
      testProtocolHash: enfEnergyArguments.testProtocolHash,
    },
  }));
  assert.equal(enfMismatch.status, "no-match");
  const enfListed = output(await harness.client.callTool({ name: "plasticity_list_enf_mode_ii_energy_tests", arguments: {} }));
  assert.equal(enfListed.records.length, 1);
  const enfRead = output(await harness.client.callTool({
    name: "plasticity_read_enf_mode_ii_energy_test", arguments: { recordId: savedEnf.record.id },
  }));
  assert.equal(enfRead.id, savedEnf.record.id);
  const unconfirmedEnf = await harness.client.callTool({
    name: "plasticity_record_enf_mode_ii_energy_test",
    arguments: { ...enfCsvPreview.recordInput, callerConfirmsPhysicalTests: false },
  });
  assert.equal(unconfirmedEnf.isError, true);
  const enfPlan = output(await harness.client.callTool({
    name: "plasticity_plan_single_material_strength_tests",
    arguments: {
      process: dcbEnergyArguments.materialProcess,
      scopes: ["layer-interface-mode-ii"],
      interfaceNormalGlobal: [0, 0, 1],
      interfaceShearDirectionGlobal: [1, 0, 0],
    },
  }));
  assert.equal(enfPlan.tasks[0].id, "ENF-mode-II-energy");
  assert.match(enfPlan.tasks[0].measurement, /plasticity_calculate_enf_mode_ii_energy/i);
  const dcbEnergy = output(await harness.client.callTool({
    name: "plasticity_calculate_dcb_mode_i_energy",
    arguments: dcbEnergyArguments,
  }));
  assert.equal(dcbEnergy.method, "modified-beam-theory");
  assert.equal(dcbEnergy.calculationVersion, 1);
  assert.equal(dcbEnergy.materialProcess.materialId, "creality-cr-pla");
  assert.match(dcbEnergy.methodReference, /10\.1007\/s00170-023-12223-1/);
  assert.equal(dcbEnergy.specimens[0].eligibleForLayerInterfaceEvidence, true);
  assert.ok(dcbEnergy.specimens[0].points.every((point: { energyReleaseRateJPerM2: number }) => point.energyReleaseRateJPerM2 > 0));
  const dcbEnergyRecordInput = { ...dcbEnergyArguments, callerConfirmsPhysicalTests: true };
  const savedDcbEnergy = output(await harness.client.callTool({
    name: "plasticity_record_dcb_mode_i_energy_test",
    arguments: dcbEnergyRecordInput,
  }));
  assert.equal(savedDcbEnergy.record.calculation.method, "modified-beam-theory");
  assert.equal(savedDcbEnergy.record.input.callerConfirmsPhysicalTests, true);
  const dcbEnergyMatch = output(await harness.client.callTool({
    name: "plasticity_match_dcb_mode_i_energy_test",
    arguments: {
      materialProcess: dcbEnergyArguments.materialProcess,
      interfaceNormalGlobal: dcbEnergyArguments.interfaceNormalGlobal,
      testProtocolHash: dcbEnergyArguments.testProtocolHash,
    },
  }));
  assert.equal(dcbEnergyMatch.status, "matched");
  assert.equal(dcbEnergyMatch.selectedRecordId, savedDcbEnergy.record.id);
  const dcbEnergyList = output(await harness.client.callTool({
    name: "plasticity_list_dcb_mode_i_energy_tests",
    arguments: {},
  }));
  assert.equal(dcbEnergyList.records.length, 1);
  const dcbEnergyRead = output(await harness.client.callTool({
    name: "plasticity_read_dcb_mode_i_energy_test",
    arguments: { recordId: savedDcbEnergy.record.id },
  }));
  assert.equal(dcbEnergyRead.id, savedDcbEnergy.record.id);
  const unconfirmedDcbEnergy = await harness.client.callTool({
    name: "plasticity_record_dcb_mode_i_energy_test",
    arguments: { ...dcbEnergyArguments, callerConfirmsPhysicalTests: false },
  });
  assert.equal(unconfirmedDcbEnergy.isError, true);
  const dcbEnergyInvalid = await harness.client.callTool({
    name: "plasticity_calculate_dcb_mode_i_energy",
    arguments: {
      materialProcess: {
        printerId: "creality-k1c-0.4", materialId: "creality-cr-pla", profileHash: "b".repeat(64),
        orientationDeg: [0, 0, 0], infillPercent: 100, infillPattern: "grid", wallLoops: 2,
        topShellLayers: 5, bottomShellLayers: 3, nozzleTemperatureC: 220, layerHeightMm: 0.2,
      },
      testProtocolHash: "c".repeat(64), testedAt: "2026-09-25T12:00:00Z",
      interfaceNormalGlobal: [0, 0, 1], testMethod: "DCB Mode-I MBT study",
      displacementEvidence: "raw-crosshead-displacement",
      linearElasticQuasiStaticEvidence: "confirmed-linear-elastic-quasi-static-test",
      specimens: [],
    },
  });
  assert.equal(dcbEnergyInvalid.isError, true);
  const interfaceCsvTool = tools.tools.find((tool) => tool.name === "plasticity_import_interface_tensile_csv")!;
  assert.equal(interfaceCsvTool.annotations?.readOnlyHint, true);
  assert.match(interfaceCsvTool.description ?? "", /does not register a physical test/i);
  const interfaceCsvPath = join(harness.root, "measured-interface-coupons.csv");
  await writeFile(interfaceCsvPath, "specimen,force_N\nA,10\nA,30\nB,20\nB,60\n");
  const interfaceCsvPreview = output(await harness.client.callTool({
    name: "plasticity_import_interface_tensile_csv",
    arguments: {
      path: interfaceCsvPath,
      specimenIdColumn: "specimen",
      forceColumn: "force_N",
      forceUnit: "N",
      forceSign: "positive",
      delimiter: "comma",
      decimalSeparator: "period",
      specimens: [
        { specimenId: "A", netCrossSectionMm2: 15, failureLocation: "interface" },
        { specimenId: "B", netCrossSectionMm2: 15, failureLocation: "fixture" },
      ],
    },
  }));
  assert.equal(interfaceCsvPreview.specimens[0].peakForceN, 30);
  assert.equal(interfaceCsvPreview.specimens[0].nominalPeakStrengthMPa, 2);
  assert.equal(interfaceCsvPreview.summary.interfaceFailureCount, 1);
  assert.equal(interfaceCsvPreview.interpretation, "nominal-interface-coupon-strength-screen-only");
  const fractureCsvTool = tools.tools.find((tool) => tool.name === "plasticity_import_interface_fracture_csv")!;
  assert.equal(fractureCsvTool.annotations?.readOnlyHint, true);
  assert.match(fractureCsvTool.description ?? "", /raw force-displacement data are rejected/i);
  const fractureCsvPath = join(harness.root, "measured-interface-dcb.csv");
  await writeFile(fractureCsvPath, "specimen,opening_um,traction_kPa\nA,0,0\nA,10,1000\nA,20,500\nA,30,0\n");
  const fractureCsvPreview = output(await harness.client.callTool({
    name: "plasticity_import_interface_fracture_csv",
    arguments: {
      path: fractureCsvPath,
      fractureMethod: "dcb-mode-i",
      processingAttestation: "already-compliance-corrected-traction-separation",
      specimenIdColumn: "specimen",
      separationColumn: "opening_um",
      tractionColumn: "traction_kPa",
      separationUnit: "um",
      tractionUnit: "kPa",
      delimiter: "comma",
      decimalSeparator: "period",
    },
  }));
  assert.equal(fractureCsvPreview.specimens[0].measuredPeakStrengthMPa, 1);
  assert.equal(fractureCsvPreview.specimens[0].analysis.fractureEnergyNPerMm, 0.015);
  assert.equal(fractureCsvPreview.interpretation, "processed-physical-fracture-curve-preview-only");
  const interfaceTestRegistry = output(await harness.client.callTool({ name: "plasticity_list_material_interface_tests", arguments: {} }));
  assert.equal(interfaceTestRegistry.records.length, 0, "CSV previews must not persist an attested physical test");
  const analyzeTool = tools.tools.find((tool) => tool.name === "plasticity_analyze_strength_task")!;
  assert.equal(analyzeTool.annotations?.readOnlyHint, false);
  assert.equal(analyzeTool.annotations?.destructiveHint, false);
  assert.equal(analyzeTool.annotations?.openWorldHint, true);
  assert.match(analyzeTool.description ?? "", /Delegation ends when the task ends/i);
  const inspectTool = tools.tools.find((tool) => tool.name === "plasticity_inspect_rectangular_member")!;
  assert.equal(inspectTool.annotations?.readOnlyHint, true);
  const sectionInspect = tools.tools.find((tool) => tool.name === "plasticity_inspect_planar_section")!;
  assert.equal(sectionInspect.annotations?.readOnlyHint, true);
  assert.equal(sectionInspect.annotations?.destructiveHint, false);
  const arbitraryInspect = tools.tools.find((tool) => tool.name === "plasticity_inspect_arbitrary_section")!;
  assert.equal(arbitraryInspect.annotations?.readOnlyHint, true);
  assert.equal(arbitraryInspect.annotations?.destructiveHint, false);
  const sectionCalculate = tools.tools.find((tool) => tool.name === "plasticity_calculate_section_strength")!;
  assert.equal(sectionCalculate.annotations?.readOnlyHint, false);
  assert.equal(sectionCalculate.annotations?.destructiveHint, false);
  assert.equal(sectionCalculate.annotations?.openWorldHint, false);
  const sectionVerify = tools.tools.find((tool) => tool.name === "plasticity_verify_section_strength")!;
  assert.equal(sectionVerify.annotations?.readOnlyHint, false);
  assert.equal(sectionVerify.annotations?.destructiveHint, false);
  assert.equal(sectionVerify.annotations?.openWorldHint, false);

  const methods = output(await harness.client.callTool({ name: "plasticity_strength_methods", arguments: {} }));
  assert.equal(methods.analysis.available, false);
  assert.match(methods.analysis.reason, /unavailable/i);
  assert.equal(methods.methods.length, 11);
  assert.ok(methods.methods.some((method: { id: string }) => method.id === "planar-section-resultants-v1"));
  assert.ok(methods.methods.some((method: { id: string }) => method.id === "simply-supported-plate-uniform-pressure-v1"));
  assert.ok(methods.methods.some((method: { id: string }) => method.id === "euler-column-buckling-v1"));
  assert.ok(methods.methods.some((method: { id: string }) => method.id === "single-fastener-plate-v1"));
  assert.ok(methods.methods.some((method: { id: string }) => method.id === "fastener-member-v1"));
  assert.ok(methods.methods.some((method: { id: string }) => method.id === "tongue-root-transverse-v1"));
  assert.ok(methods.methods.some((method: { id: string }) => method.id === "heat-set-insert-retention-v1"));
  assert.ok(methods.methods.some((method: { id: string }) => method.id === "fastener-group-elastic-in-plane-v1"));
  assert.ok(methods.methods.some((method: { id: string }) => method.id === "threaded-receiver-axial-v1"));
  const materialMatch = output(await harness.client.callTool({
    name: "plasticity_match_material_coupon_data",
    arguments: {
      process: {
        printerId: "creality-k1c-0.4",
        materialId: "generic-pla-k1c-0.4",
        profileHash: "b".repeat(64),
        orientationDeg: [0, 0, 0],
        infillPercent: 100,
        infillPattern: "grid",
        wallLoops: 2,
        topShellLayers: 5,
        bottomShellLayers: 3,
        nozzleTemperatureC: 220,
        layerHeightMm: 0.2,
      },
    },
  }));
  assert.equal(materialMatch.status, "no-match");
  assert.equal(materialMatch.source, "immutable-local-physical-coupon-registry");
  const testPlanTool = tools.tools.find((tool) => tool.name === "plasticity_plan_single_material_strength_tests")!;
  assert.equal(testPlanTool.annotations?.readOnlyHint, true);
  assert.match(testPlanTool.description ?? "", /without inventing property values/i);
  assert.match(testPlanTool.description ?? "", /focused layer-interface-normal-tension scope/i);
  const testPlan = output(await harness.client.callTool({
    name: "plasticity_plan_single_material_strength_tests",
    arguments: {
      process: {
        printerId: "creality-k1c-0.4",
        materialId: "generic-pla-k1c-0.4",
        profileHash: "b".repeat(64),
        orientationDeg: [0, 0, 0],
        infillPercent: 100,
        infillPattern: "grid",
        wallLoops: 2,
        topShellLayers: 5,
        bottomShellLayers: 3,
        nozzleTemperatureC: 220,
        layerHeightMm: 0.2,
      },
      scopes: ["layerwise-elastic-response", "layer-interface-mixed-mode"],
      interfaceNormalGlobal: [0, 0, 1],
      interfaceShearDirectionGlobal: [1, 0, 0],
    },
  }));
  assert.equal(testPlan.materialModel, "one-material-orthotropic-bulk-and-same-material-interfaces");
  assert.ok(testPlan.tasks.some((task: { id: string }) => task.id === "E3"));
  assert.ok(testPlan.tasks.some((task: { id: string }) => task.id === "MMB-2"));
  assert.equal(testPlan.tasks.find((task: { id: string }) => task.id === "cohesive-K")?.provideTo, "plasticity_analyze_cohesive_interface");
  assert.ok(testPlan.tasks.every((task: { value?: unknown }) => !("value" in task)));
  const normalLayerPlan = output(await harness.client.callTool({
    name: "plasticity_plan_single_material_strength_tests",
    arguments: {
      process: {
        printerId: "creality-k1c-0.4",
        materialId: "generic-pla-k1c-0.4",
        profileHash: "b".repeat(64),
        orientationDeg: [0, 0, 0],
        infillPercent: 100,
        infillPattern: "grid",
        wallLoops: 2,
        topShellLayers: 5,
        bottomShellLayers: 3,
        nozzleTemperatureC: 220,
        layerHeightMm: 0.2,
      },
      scopes: ["layer-interface-normal-tension"],
      interfaceNormalGlobal: [0, 0, 1],
    },
  }));
  assert.deepEqual(normalLayerPlan.tasks.map((task: { id: string }) => task.id), ["layer-normal-tension"]);
  assert.equal(normalLayerPlan.tasks[0].kind, "interface-strength");
  assert.equal(normalLayerPlan.tasks[0].recordWith, "plasticity_record_material_interface_test");
  assert.ok(normalLayerPlan.solverLimits.some((limit: string) => /peak-strength screen only/i.test(limit)));
  assert.ok(normalLayerPlan.tasks.every((task: { value?: unknown }) => !("value" in task)));
  const invalidTestPlan = await harness.client.callTool({
    name: "plasticity_plan_single_material_strength_tests",
    arguments: {
      process: {
        printerId: "creality-k1c-0.4",
        materialId: "generic-pla-k1c-0.4",
        profileHash: "b".repeat(64),
        orientationDeg: [0, 0, 0],
        infillPercent: 100,
        infillPattern: "grid",
        wallLoops: 2,
        topShellLayers: 5,
        bottomShellLayers: 3,
        nozzleTemperatureC: 220,
      },
      scopes: ["layerwise-elastic-response"],
    },
  });
  assert.equal(invalidTestPlan.isError, true);
  assert.match(JSON.stringify(invalidTestPlan.content), /measured slicer layer height/i);
  const strict = await harness.client.callTool({ name: "plasticity_strength_methods", arguments: { extra: true } });
  assert.equal(strict.isError, true);

  const prompts = await harness.client.listPrompts();
  assert.ok(prompts.prompts.some((prompt) => prompt.name === "plasticity_strength_first"));
  assert.ok(prompts.prompts.some((prompt) => prompt.name === "plasticity_design_from_reference"));
  const resources = await harness.client.listResources();
  const uris = resources.resources.map((resource) => resource.uri);
  assert.ok(uris.includes("plasticity://design/reference-workflow"));
  assert.ok(uris.includes("plasticity://strength/workflow"));
  assert.ok(uris.includes("plasticity://strength/interlayer-literature-baseline"));
  assert.ok(uris.includes("plasticity://strength/methods"));
  assert.ok(uris.includes("plasticity://strength/recovery"));
  const workflow = await harness.client.readResource({ uri: "plasticity://strength/workflow" });
  assert.match(JSON.stringify(workflow.contents), /photo without scale/i);
  assert.match(JSON.stringify(workflow.contents), /unsupported ribbed part/i);
  assert.match(JSON.stringify(workflow.contents), /plasticity_analyze_cohesive_interface/);
  assert.match(JSON.stringify(workflow.contents), /plasticity_plan_single_material_strength_tests/);
  assert.match(JSON.stringify(workflow.contents), /plasticity_import_interface_tensile_csv/);
  assert.match(JSON.stringify(workflow.contents), /focused.*layer-interface-normal-tension.*scope/i);
  assert.match(JSON.stringify(workflow.contents), /never report it as a part-strength verdict/);
  assert.match(JSON.stringify(workflow.contents), /distinguish CR-PLA's physical tensile\/infill study and the two-sample CR-PLA-associated vertical layer-adhesion screen from the Hyper PLA flat tensile\/flexural study/i);
  assert.match(JSON.stringify(workflow.contents), /Layerwise static FEA assumes perfectly bonded interfaces/i);
  const interlayerBaseline = await harness.client.readResource({ uri: "plasticity://strength/interlayer-literature-baseline" });
  assert.match(JSON.stringify(interlayerBaseline.contents), /Z-direction tensile strength of 6\.63 MPa/i);
  assert.match(JSON.stringify(interlayerBaseline.contents), /another same-named TDS copy reports 8\.63 MPa/i);
  assert.match(JSON.stringify(interlayerBaseline.contents), /do not treat 6\.63 MPa as a guaranteed lower bound/i);
  assert.match(JSON.stringify(interlayerBaseline.contents), /0\.74 kJ\/m²/);
  assert.match(JSON.stringify(interlayerBaseline.contents), /abstract reports 0\.75 kJ\/m².*2\.4 kJ\/m²/i);
  assert.match(JSON.stringify(interlayerBaseline.contents), /Preserve this internal summary discrepancy/i);
  assert.match(JSON.stringify(interlayerBaseline.contents), /Ender 3 Pro/);
  assert.match(JSON.stringify(interlayerBaseline.contents), /32\.6 MPa/);
  assert.match(JSON.stringify(interlayerBaseline.contents), /two PLA layer-adhesion break loads, 36\.20 and 35\.95 kg/i);
  assert.match(JSON.stringify(interlayerBaseline.contents), /22\.19 and 22\.03 MPa \(mean 22\.11 MPa\)/i);
  assert.match(JSON.stringify(interlayerBaseline.contents), /https:\/\/www\.mytechfun\.com\/video\/123/);
  assert.match(JSON.stringify(interlayerBaseline.contents), /only two specimens/i);
  assert.match(JSON.stringify(interlayerBaseline.contents), /do not pass it into the solver/i);
  assert.match(JSON.stringify(interlayerBaseline.contents), /Creality Hyper PLA physical flexural delamination evidence/i);
  assert.match(JSON.stringify(interlayerBaseline.contents), /42\.13/);
  assert.match(JSON.stringify(interlayerBaseline.contents), /not interface traction or fracture-energy values/i);
  assert.match(JSON.stringify(interlayerBaseline.contents), /different Creality SKU/i);
  assert.match(JSON.stringify(interlayerBaseline.contents), /does not establish Z-build orientation/i);
  assert.match(JSON.stringify(interlayerBaseline.contents), /2026 physical study also identifies Creality CR-PLA/i);
  assert.match(JSON.stringify(interlayerBaseline.contents), /qualitative porosity\/interlayer erosion after thermal cycling/i);
  assert.match(JSON.stringify(interlayerBaseline.contents), /not a guaranteed lower bound/);
  assert.match(JSON.stringify(interlayerBaseline.contents), /nominal coupon tensile strength of 35\.52 MPa/i);
  assert.match(JSON.stringify(interlayerBaseline.contents), /filament brand is unspecified/i);
  assert.match(JSON.stringify(interlayerBaseline.contents), /22\.8 MPa average tensile strength/i);
  assert.match(JSON.stringify(interlayerBaseline.contents), /33\.75 MPa average interface strength was inferred/i);
  assert.match(JSON.stringify(interlayerBaseline.contents), /Keep this literature record separate from/);
  const designWorkflow = await harness.client.readResource({ uri: "plasticity://design/reference-workflow" });
  assert.match(JSON.stringify(designWorkflow.contents), /cannot establish exact millimetre dimensions/i);
  assert.match(JSON.stringify(designWorkflow.contents), /one next decision package/i);
});

test("product reference search is isolated and reports unavailable capability without fallback", async (context) => {
  let calls = 0;
  const timeouts: number[] = [];
  const harness = await createHarness(context, {
    referenceSearch: {
      async search(input, options) {
        calls += 1;
        timeouts.push(options.timeoutMs);
        return {
          query: input.query,
          candidates: [{
            title: "Manufacturer CAD",
            url: "https://vendor.example/cad",
            sourceKind: "manufacturer",
            summary: "A STEP candidate is listed.",
            licenseStatus: "requires-review",
            accessStatus: "account-required",
            dimensionEvidence: [],
            assets: [{
              url: "https://vendor.example/model.step",
              format: "step",
              kind: "editable-cad",
              evidence: "Download link is explicitly marked STEP.",
            }],
          }],
          limitations: [],
        };
      },
      async close() {},
    },
  });
  const result = output(await harness.client.callTool({
    name: "plasticity_search_product_references",
    arguments: { query: "Example enclosure", limit: 3, allowedDomains: ["vendor.example"], searchTimeoutMs: 150_000 },
  }));
  assert.equal(calls, 1);
  assert.deepEqual(timeouts, [150_000]);
  assert.equal(result.candidates[0].url, "https://vendor.example/cad");
  assert.equal(result.candidates[0].accessStatus, "account-required");
  await harness.client.callTool({ name: "plasticity_search_product_references", arguments: { query: "Second enclosure search" } });
  assert.deepEqual(timeouts, [150_000, 180_000]);
  const searchDescription = (await harness.client.listTools()).tools.find((tool) => tool.name === "plasticity_search_product_references")?.description ?? "";
  assert.match(searchDescription, /accessStatus separately from licenseStatus/i);
  assert.match(searchDescription, /paid product page is not a direct asset URL/i);
  assert.match(searchDescription, /never downloads\/imports files or mutates CAD/i);
  const status = output(await harness.client.callTool({ name: "plasticity_reference_search_status", arguments: {} }));
  assert.deepEqual(status, { available: true, transport: "Codex app-server web_search live", autoImport: false });

  const unavailable = await createHarness(context, {
    referenceSearch: null,
    referenceSearchUnavailableReason: "Unsupported Codex protocol",
  });
  const unavailableStatus = output(await unavailable.client.callTool({ name: "plasticity_reference_search_status", arguments: {} }));
  assert.deepEqual(unavailableStatus, { available: false, reason: "Unsupported Codex protocol", autoImport: false });
  const refused = await unavailable.client.callTool({
    name: "plasticity_search_product_references",
    arguments: { query: "Example enclosure" },
  });
  assert.equal(refused.isError, true);
  assert.match(JSON.stringify(refused.content), /Unsupported Codex protocol/);
});

test("design-reference MCP calls isolated Codex, persists structured uncertainty, and never touches CAD", async (context) => {
  let calls = 0;
  const result = {
    observations: [{ id: "scale", label: "No known scale marker in the image", status: "unknown", dependsOn: [] }],
    proposedMethod: null,
    questions: [{ id: "q-function", question: "What will this bracket support, and how is it mounted?", resolves: ["functionalIntent", "mounting"], reason: "The load path determines the section and the next dimensions needed." }],
    unsupportedConditions: [],
    designInterpretation: {
      articleType: "bracket", functionalIntent: "Supports an unknown object from a vertical panel", scaleStatus: "unscaled",
      interfaces: [{ id: "mount", kind: "mounting", description: "Two visible fastener points", confidence: "probable", evidenceIds: ["scale"] }],
      featureCandidates: [{ id: "holes", type: "hole", description: "Two mounting holes", confidence: "probable", evidenceIds: ["scale"] }],
    },
  } as AnalysisResult;
  const followupResult: AnalysisResult = {
    ...result,
    questions: [{ id: "q-object", question: "Can you share the object or a photo of it?", resolves: ["supportedObject"], reason: "The supported object's interface narrows the fit questions." }],
  };
  const harness = await createHarness(context, {
    analysis: {
      async fingerprintImages() { return []; },
      async run(input) {
        calls += 1;
        assert.equal(input.analysisMode, "design-reference");
        assert.equal(input.prompt, "Build this bracket from the unscaled sketch");
        if (calls === 1) {
          assert.equal(input.answers.length, 0);
          return result;
        }
        assert.deepEqual(input.answers, [{ questionId: "q-function", question: result.questions[0]!.question, answer: "I don't know the supported object's details yet." }]);
        return followupResult;
      },
      async close() {},
    },
  });
  const listed = await harness.client.listTools();
  const designTool = listed.tools.find((item) => item.name === "plasticity_analyze_design_reference");
  assert.ok(designTool);
  assert.equal((designTool.inputSchema.properties as Record<string, { maxItems?: number }>).imagePaths?.maxItems, 4);
  assert.match(designTool.description ?? "", /PNG\/JPEG\/HEIC\/HEIF/);
  assert.match(designTool.description ?? "", /converts HEIC\/HEIF locally/);
  const args = { requestId: "bracket-sketch", prompt: "Build this bracket from the unscaled sketch", imagePaths: [], evidence: [], answers: [] };
  const excessViews = await harness.client.callTool({ name: "plasticity_analyze_design_reference", arguments: {
    ...args,
    requestId: "bracket-sketch-too-many-views",
    imagePaths: ["front.png", "side.png", "back.png", "detail.png", "extra.png"],
  } });
  assert.equal(excessViews.isError, true);
  assert.equal(calls, 0, "invalid image count must be rejected before invoking Codex");
  const response = await harness.client.callTool({ name: "plasticity_analyze_design_reference", arguments: args });
  assert.equal(response.isError, undefined);
  const record = output(response);
  assert.equal(record.state, "completed");
  assert.equal(record.result.designInterpretation.scaleStatus, "unscaled");
  assert.equal(record.result.questions.length, 1);
  assert.equal(calls, 1);
  const followup = output(await harness.client.callTool({ name: "plasticity_analyze_design_reference", arguments: {
    ...args,
    requestId: "bracket-sketch-follow-up",
    answers: [{ questionId: "q-function", question: record.result.questions[0].question, answer: "I don't know the supported object's details yet." }],
  } }));
  assert.equal(followup.state, "completed");
  assert.equal(followup.result.questions[0].id, "q-object");
  assert.notEqual(followup.result.questions[0].id, record.result.questions[0].id);
  assert.equal(calls, 2);
  const replay = output(await harness.client.callTool({ name: "plasticity_analyze_design_reference", arguments: args }));
  assert.deepEqual(replay, record);
  assert.equal(calls, 2);
  const persisted = output(await harness.client.callTool({ name: "plasticity_design_reference_request", arguments: { requestId: "bracket-sketch" } }));
  assert.deepEqual(persisted, record);
  const missingModeData = await harness.client.callTool({
    name: "plasticity_analyze_design_reference",
    arguments: { requestId: "bad-sketch", prompt: "inspect", imagePaths: [], evidence: [], answers: [], analysisMode: "strength" },
  });
  assert.equal(missingModeData.isError, true);
});

test("formula tools remain available without Codex and calculations are labelled scenarios", async (context) => {
  const harness = await createHarness(context, { analysis: null });
  const input = {
    ...syntheticInput("axial-rectangle-v1"),
    binding: binding("r1"),
  };
  const response = await harness.client.callTool({ name: "plasticity_calculate_strength", arguments: input });
  assert.equal(response.isError, undefined);
  const report = output(response);
  assert.equal(report.input.binding, undefined);
  assert.match(report.result.checkedScope, /scenario/i);
  assert.equal(report.result.status, "conditional");

  const unavailable = await harness.client.callTool({
    name: "plasticity_analyze_strength_task",
    arguments: { requestId: "no-codex", prompt: "analyze", imagePaths: [], evidence: [], answers: [] },
  });
  assert.equal(unavailable.isError, true);
});

test("MCP records coupon data and matches it only to the exact print process", async (context) => {
  const harness = await createHarness(context, {});
  const qualification = materialCouponQualificationInput();
  const forgedComposition = await harness.client.callTool({
    name: "plasticity_record_material_coupon_data",
    arguments: { ...qualification, composedFromRecordIds: ["a".repeat(64), "b".repeat(64)] },
  });
  assert.equal(forgedComposition.isError, true);
  const saveResponse = await harness.client.callTool({ name: "plasticity_record_material_coupon_data", arguments: qualification });
  assert.notEqual(saveResponse.isError, true, JSON.stringify(saveResponse.content));
  const saved = output(saveResponse);
  assert.equal(saved.alreadyExisted, false);
  assert.equal(saved.record.recordStatus, "caller-attested-physical-coupon-record");
  const matched = output(await harness.client.callTool({
    name: "plasticity_match_material_coupon_data",
    arguments: { process: qualification.process },
  }));
  assert.equal(matched.status, "matched");
  assert.equal(matched.selected.id, saved.record.id);
  const differentOrientation = output(await harness.client.callTool({
    name: "plasticity_match_material_coupon_data",
    arguments: { process: { ...qualification.process, orientationDeg: [0, 90, 0] } },
  }));
  assert.equal(differentOrientation.status, "no-match");
});

test("MCP explicitly combines compatible partial physical coupon records for one process", async (context) => {
  const harness = await createHarness(context, {});
  const shear = materialCouponQualificationInput();
  const tension = materialCouponQualificationInput();
  for (const property of ["tensileStrengthMPa", "shearStrengthMPa"] as const) {
    Reflect.deleteProperty(shear.properties, property);
    Reflect.deleteProperty(shear.propertyEvidence, property);
  }
  shear.evidence = shear.evidence.filter((item) => item.id === "young-modulus" || item.id === "shear-modulus");
  Reflect.deleteProperty(tension.properties, "shearModulusMPa");
  Reflect.deleteProperty(tension.properties, "shearStrengthMPa");
  Reflect.deleteProperty(tension.propertyEvidence, "shearModulusMPa");
  Reflect.deleteProperty(tension.propertyEvidence, "shearStrengthMPa");
  tension.evidence = tension.evidence.filter((item) => item.id === "young-modulus" || item.id === "tensile-strength");
  const shearRecord = output(await harness.client.callTool({ name: "plasticity_record_material_coupon_data", arguments: shear })).record;
  const tensionRecord = output(await harness.client.callTool({ name: "plasticity_record_material_coupon_data", arguments: tension })).record;
  assert.equal(output(await harness.client.callTool({
    name: "plasticity_match_material_coupon_data", arguments: { process: shear.process },
  })).status, "ambiguous");

  const combined = output(await harness.client.callTool({
    name: "plasticity_combine_material_coupon_data",
    arguments: { recordIds: [shearRecord.id, tensionRecord.id], specimenCount: 8 },
  }));
  assert.equal(combined.record.composedFromRecordIds.length, 2);
  assert.equal(combined.record.specimenCount, 8);
  const match = output(await harness.client.callTool({
    name: "plasticity_match_material_coupon_data", arguments: { process: shear.process },
  }));
  assert.equal(match.status, "matched");
  assert.equal(match.selected.id, combined.record.id);
  assert.equal(match.selected.properties.shearModulusMPa, shear.properties.shearModulusMPa);
  assert.equal(match.selected.properties.tensileStrengthMPa, tension.properties.tensileStrengthMPa);
});

test("MCP records and retrieves one-process orthotropic failure-test data", async (context) => {
  const harness = await createHarness(context, {});
  const qualification = materialCouponQualificationInput();
  const prefix = "synthetic-tsai-wu";
  const strengths = {
    xTensionMPa: 35, xCompressionMPa: 42, yTensionMPa: 28, yCompressionMPa: 31,
    zTensionMPa: 12, zCompressionMPa: 22, xyShearMPa: 18, xzShearMPa: 11, yzShearMPa: 10,
  };
  const interactions = { xy: 0.2, xz: -0.1, yz: 0.15 };
  const strengthEvidence = {
    xTensionMPa: [`${prefix}-strength-xTensionMPa`], xCompressionMPa: [`${prefix}-strength-xCompressionMPa`],
    yTensionMPa: [`${prefix}-strength-yTensionMPa`], yCompressionMPa: [`${prefix}-strength-yCompressionMPa`],
    zTensionMPa: [`${prefix}-strength-zTensionMPa`], zCompressionMPa: [`${prefix}-strength-zCompressionMPa`],
    xyShearMPa: [`${prefix}-strength-xyShearMPa`], xzShearMPa: [`${prefix}-strength-xzShearMPa`], yzShearMPa: [`${prefix}-strength-yzShearMPa`],
  };
  const interactionEvidence = {
    xy: `${prefix}-interaction-xy`, xz: `${prefix}-interaction-xz`, yz: `${prefix}-interaction-yz`,
  };
  const testEvidence = Object.entries(strengths).map(([key, value], index) => ({
    id: `${prefix}-strength-${key}`, label: `Synthetic test-only ${key}`, status: "measured" as const, unit: "MPa" as const,
    ...orthotropicTsaiWuTestMetadata[key as keyof typeof orthotropicTsaiWuTestMetadata],
    value, sourceUrl: "https://example.org/synthetic-test-fixture", sourceHash: `${index + 1}`.repeat(64),
    sourceLocator: `synthetic fixture ${key}`, dependsOn: [],
  }));
  const biaxialEvidence = Object.keys(interactions).map((key, index) => ({
    id: `${prefix}-biaxial-${key}`, label: `Synthetic test-only biaxial ${key}`, status: "measured" as const,
    testAxis: orthotropicTsaiWuInteractionTestAxis[key as keyof typeof orthotropicTsaiWuInteractionTestAxis], testMode: "biaxial" as const,
    sourceUrl: "https://example.org/synthetic-test-fixture", sourceHash: `${index + 1}`.repeat(64),
    sourceLocator: `synthetic fixture biaxial ${key}`, dependsOn: [],
  }));
  const interactionResults = Object.entries(interactions).map(([key, value], index) => ({
    id: `${prefix}-interaction-${key}`, label: `Synthetic test-only fit ${key}`, status: "derived" as const, unit: "ratio" as const,
    testAxis: orthotropicTsaiWuInteractionTestAxis[key as keyof typeof orthotropicTsaiWuInteractionTestAxis], testMode: "biaxial" as const,
    value, sourceUrl: "https://example.org/synthetic-test-fixture", sourceHash: `${index + 4}`.repeat(64),
    sourceLocator: `synthetic fixture fit ${key}`, derivation: "Synthetic registry plumbing fixture.", dependsOn: [`${prefix}-biaxial-${key}`],
  }));
  const orthotropicConstants = {
    youngsModulus2MPa: 1500, youngsModulus3MPa: 1000, poissonRatio13: 0.22, poissonRatio23: 0.27,
    shearModulus12MPa: 500, shearModulus13MPa: 400, shearModulus23MPa: 300,
  };
  const orthotropicPropertyEvidence = Object.entries(orthotropicConstants).map(([key, value], index) => ({
    id: `orthotropic-${key}`, label: `Synthetic test-only ${key}`, status: "measured" as const,
    unit: key.startsWith("poisson") ? "ratio" as const : "MPa" as const, value,
    sourceUrl: "https://example.org/synthetic-test-fixture", sourceHash: `${index + 1}`.repeat(64),
    sourceLocator: `synthetic fixture ${key}`, dependsOn: [],
  }));
  qualification.orthotropicMaterial = {
    ...orthotropicConstants,
    propertyEvidence: {
      youngsModulus2MPa: ["orthotropic-youngsModulus2MPa"], youngsModulus3MPa: ["orthotropic-youngsModulus3MPa"],
      poissonRatio13: ["orthotropic-poissonRatio13"], poissonRatio23: ["orthotropic-poissonRatio23"],
      shearModulus12MPa: ["orthotropic-shearModulus12MPa"], shearModulus13MPa: ["orthotropic-shearModulus13MPa"], shearModulus23MPa: ["orthotropic-shearModulus23MPa"],
    },
    orientation: {
      axis1DirectionGlobal: [1, 0, 0], axis2ReferenceDirectionGlobal: [0, 1, 0], buildDirectionGlobal: [0, 0, 1],
      evidence: { status: "user-confirmed", description: "Synthetic acceptance fixture axes only." },
    },
    tsaiWuCriterion: { strengths, interactions, strengthEvidence, interactionEvidence },
  };
  qualification.evidence.push(...orthotropicPropertyEvidence, ...testEvidence, ...biaxialEvidence, ...interactionResults);
  const saveResponse = await harness.client.callTool({ name: "plasticity_record_material_coupon_data", arguments: qualification });
  assert.notEqual(saveResponse.isError, true, JSON.stringify(saveResponse.content));
  const saved = output(saveResponse);
  assert.equal(saved.record.orthotropicMaterial.tsaiWuCriterion.strengths.zTensionMPa, 12);
  const matched = output(await harness.client.callTool({ name: "plasticity_match_material_coupon_data", arguments: { process: qualification.process } }));
  assert.equal(matched.status, "matched");
  assert.deepEqual(matched.selected.orthotropicMaterial.tsaiWuCriterion.interactions, interactions);
  assert.equal(matched.selected.orthotropicMaterial.tsaiWuCriterion.strengthEvidence.xTensionMPa[0], `${prefix}-strength-xTensionMPa`);
});

test("MCP preserves single-material interface-test evidence without promoting it to a design allowable", async (context) => {
  const harness = await createHarness(context, {});
  const process = (materialId: string) => ({
    printerId: "creality-k1c-0.4", materialId, profileHash: "b".repeat(64),
    orientationDeg: [0, 0, 0] as [number, number, number], infillPercent: 100, infillPattern: "grid", wallLoops: 2, topShellLayers: 5, bottomShellLayers: 3, nozzleTemperatureC: 220,
    layerHeightMm: 0.2,
  });
  const physicalTest: InterfaceTestMcpInput = {
    materialProcess: process("pla-brand-a"),
    testMode: "normal-tension", interfaceNormalGlobal: [0, 0, 1], loadDirectionGlobal: [0, 0, 1],
    fractureMethod: "dcb-mode-i",
    testMethod: "ASTM D5528 DCB", testProtocolHash: "c".repeat(64),
    specimenDescription: "One printed PLA specimen with a measured interlayer interface.",
    fixtureDescription: "A calibrated fixture loads the printed layer interface in the normal direction.",
    measuredPeakStrengthMPa: 18, failureLocation: "interface",
    specimenResults: Array.from({ length: 5 }, (_, index) => {
      const specimenId = `series-a-${index + 1}`;
      const strength = [18, 17, 16, 20, 21][index]!;
      return {
        specimenId,
        peakForceN: strength * 10,
        netCrossSectionMm2: 10,
        nominalPeakStrengthMPa: strength,
        failureLocation: index === 2 ? "printed-material" as const : "interface" as const,
        sourceHash: `${index + 1}`.repeat(64),
        sourceLocator: `test report, specimen ${specimenId}`,
      };
    }),
    tractionSeparationCurve: {
      sourceHash: "e".repeat(64), sourceLocator: "raw.csv, specimens 1-5, corrected traction-separation data",
      points: [
        { separationMm: 0, tractionMPa: 0 }, { separationMm: 0.01, tractionMPa: 10 },
        { separationMm: 0.02, tractionMPa: 18 }, { separationMm: 0.04, tractionMPa: 12 },
        { separationMm: 0.06, tractionMPa: 0 },
      ],
    },
    evidence: [{ id: "interface-strength", label: "Measured nominal interface peak", status: "measured", unit: "MPa", value: 18, sourceHash: "1".repeat(64), sourceLocator: "test report, specimen series-a-1", dependsOn: [] }],
    specimenCount: 5, testedAt: "2026-09-24T10:00:00.000Z", source: "physical-material-interface-test", callerConfirmsPhysicalTests: true,
  };
  const saved = output(await harness.client.callTool({ name: "plasticity_record_material_interface_test", arguments: physicalTest }));
  assert.equal(saved.alreadyExisted, false);
  assert.equal(saved.record.recordStatus, "caller-attested-physical-material-interface-test");
  assert.deepEqual(saved.record.materialProcess, physicalTest.materialProcess);
  assert.equal("materialAProcess" in saved.record, false);
  assert.equal("materialBProcess" in saved.record, false);
  assert.equal("designAllowableMPa" in saved.record, false);
  const { materialProcess, tractionSeparationCurve: legacyCurve, ...physicalTestInternal } = physicalTest;
  const legacyDissimilar = await harness.store.materialInterfaceTests.record({
    ...physicalTestInternal,
    interfaceKind: "dissimilar-material-bond",
    materialAProcess: materialProcess,
    materialBProcess: process("tpu-brand-b"),
    failureLocation: "interface",
    tractionSeparationCurve: legacyCurve,
    specimenResults: physicalTest.specimenResults!.map((specimen) => ({
      ...specimen,
      failureLocation: specimen.failureLocation === "printed-material" ? "material-a" : specimen.failureLocation,
    })),
  });
  const listed = output(await harness.client.callTool({ name: "plasticity_list_material_interface_tests", arguments: {} }));
  assert.equal(listed.records.length, 1);
  assert.deepEqual(listed.records[0].materialProcess, physicalTest.materialProcess);
  assert.equal("materialAProcess" in listed.records[0], false);
  assert.equal("materialBProcess" in listed.records[0], false);
  const hiddenLegacyCurve = await harness.client.callTool({
    name: "plasticity_analyze_material_interface_test_curve",
    arguments: { recordId: legacyDissimilar.record.id },
  });
  assert.equal(hiddenLegacyCurve.isError, true);
  const matched = output(await harness.client.callTool({
    name: "plasticity_match_material_interface_test",
    arguments: {
      materialProcess: physicalTest.materialProcess,
      testMode: physicalTest.testMode,
      interfaceNormalGlobal: physicalTest.interfaceNormalGlobal,
      loadDirectionGlobal: physicalTest.loadDirectionGlobal,
      testProtocolHash: physicalTest.testProtocolHash,
    },
  }));
  assert.equal(matched.status, "matched");
  assert.equal(matched.records.length, 1);
  assert.equal(matched.records[0].id, saved.record.id);
  assert.equal(matched.selected.id, saved.record.id);
  assert.deepEqual(matched.selected.materialProcess, physicalTest.materialProcess);
  assert.equal("materialAProcess" in matched.selected, false);
  assert.equal("materialBProcess" in matched.selected, false);
  assert.equal(matched.selected.measuredPeakStrengthMPa, 18);
  const curve = output(await harness.client.callTool({
    name: "plasticity_analyze_material_interface_test_curve",
    arguments: { recordId: saved.record.id },
  }));
  assert.equal(curve.recordId, saved.record.id);
  assert.equal(curve.analysis.fractureEnergyNPerMm, 0.61);
  assert.equal(curve.analysis.interpretation, "measured-curve-summary-only");
  assert.deepEqual(curve.materialProcess, physicalTest.materialProcess);
  assert.equal("materialAProcess" in curve, false);
  assert.equal("materialBProcess" in curve, false);

  const { id: _storedId, createdAt, recordStatus, materialProcess: storedMaterialProcess, ...storedInput } = saved.record;
  const { fractureMethod: _legacyFractureMethod, ...legacyInput } = storedInput;
  const internalLegacyInput = {
    ...legacyInput,
    interfaceKind: "same-material-layer",
    testProtocolHash: "9".repeat(64),
    materialAProcess: storedMaterialProcess,
    materialBProcess: storedMaterialProcess,
    failureLocation: legacyInput.failureLocation === "printed-material" ? "material-a" : legacyInput.failureLocation,
    specimenResults: legacyInput.specimenResults?.map((specimen: { failureLocation: string }) => ({
      ...specimen,
      failureLocation: specimen.failureLocation === "printed-material" ? "material-a" : specimen.failureLocation,
    })),
  };
  const legacyId = interfaceTestHash(internalLegacyInput);
  await writeFile(join(harness.root, "material-interface-tests", `${legacyId}.json`), `${JSON.stringify({
    ...internalLegacyInput, id: legacyId, createdAt, recordStatus,
  })}\n`, { mode: 0o600 });
  const unclassifiedLegacyCurve = await harness.client.callTool({
    name: "plasticity_analyze_material_interface_test_curve",
    arguments: { recordId: legacyId },
  });
  assert.equal(unclassifiedLegacyCurve.isError, true);
  assert.match(JSON.stringify(unclassifiedLegacyCurve.content), /without explicit dcb-mode-i physical-test classification/i);

  const calculatedSpecimens = output(await harness.client.callTool({
    name: "plasticity_calculate_interface_specimen_strengths",
    arguments: {
      specimens: physicalTest.specimenResults!.map(({ specimenId, peakForceN, netCrossSectionMm2, failureLocation, sourceHash, sourceLocator }) => ({
        specimenId, peakForceN, netCrossSectionMm2,
        failureLocation,
        sourceHash, sourceLocator,
      })),
    },
  }));
  assert.deepEqual(calculatedSpecimens.specimens.map((specimen: { nominalPeakStrengthMPa: number }) => specimen.nominalPeakStrengthMPa), [18, 17, 16, 20, 21]);
  assert.equal(calculatedSpecimens.summary.interfaceFailureCount, 4);
  assert.equal(calculatedSpecimens.summary.interpretation, "descriptive-interface-failure-specimen-statistics-only");
  assert.equal(calculatedSpecimens.summary.specimenCount, 5);
  assert.equal(calculatedSpecimens.summary.interfaceFailureCount, 4);
  assert.equal(calculatedSpecimens.summary.minimumPeakStrengthMPa, 17);
  assert.equal(calculatedSpecimens.summary.maximumPeakStrengthMPa, 21);
  assert.equal(calculatedSpecimens.summary.meanPeakStrengthMPa, 19);
  assert.ok(Math.abs(calculatedSpecimens.summary.sampleStandardDeviationMPa - Math.sqrt(10 / 3)) < 1e-12);
  assert.equal("designAllowableMPa" in calculatedSpecimens, false);

  const { tractionSeparationCurve: _tractionSeparationCurve, fractureMethod: _fractureMethod, ...bulkFailureBase } = physicalTest;
  const bulkFailure = output(await harness.client.callTool({
    name: "plasticity_record_material_interface_test",
    arguments: {
      ...bulkFailureBase,
      failureLocation: "printed-material",
      representativeSpecimenId: "series-a-1",
      specimenResults: physicalTest.specimenResults!.map((specimen, index) => index === 0 ? { ...specimen, failureLocation: "printed-material" as const } : specimen),
      testMethod: "Instrumented layer-interface tension with bulk failure",
      testProtocolHash: "f".repeat(64),
    },
  }));
  assert.equal(bulkFailure.record.failureLocation, "printed-material");

  const mmbTest = {
    ...physicalTest,
    testMode: "mixed-mode",
    fractureMethod: "mmb-mixed-mode",
    loadDirectionGlobal: [Math.SQRT1_2, 0, Math.SQRT1_2],
    testMethod: "ASTM D6671 MMB",
    measuredPeakStrengthMPa: 30,
    evidence: [{ ...physicalTest.evidence[0], value: 30 }],
    specimenResults: physicalTest.specimenResults!.map((specimen) => specimen.specimenId === "series-a-1"
      ? { ...specimen, peakForceN: 300, nominalPeakStrengthMPa: 30 }
      : specimen),
    mixedModeTractionSeparationCurve: {
      sourceHash: "f".repeat(64), sourceLocator: "MMB.csv, compliance-corrected vector response",
      points: [
        { normalSeparationMm: 0, tangentialSeparationMm: 0, normalTractionMPa: 0, tangentialTractionMPa: 0 },
        { normalSeparationMm: 0.01, tangentialSeparationMm: 0.01, normalTractionMPa: 10, tangentialTractionMPa: 10 },
        { normalSeparationMm: 0.02, tangentialSeparationMm: 0.03, normalTractionMPa: 18, tangentialTractionMPa: 24 },
        { normalSeparationMm: 0.04, tangentialSeparationMm: 0.05, normalTractionMPa: 12, tangentialTractionMPa: 8 },
        { normalSeparationMm: 0.06, tangentialSeparationMm: 0.08, normalTractionMPa: 0, tangentialTractionMPa: 0 },
      ],
    },
  };
  delete (mmbTest as { tractionSeparationCurve?: unknown }).tractionSeparationCurve;
  const savedMmb = output(await harness.client.callTool({ name: "plasticity_record_material_interface_test", arguments: mmbTest }));
  const analyzedMmb = output(await harness.client.callTool({
    name: "plasticity_analyze_material_interface_test_curve", arguments: { recordId: savedMmb.record.id },
  }));
  assert.equal(analyzedMmb.analysis.mode, "mixed-mode");
  assert.equal(analyzedMmb.analysis.totalFractureEnergyNPerMm, 1.44);
  assert.equal(analyzedMmb.analysis.tangentialEnergyFraction, 0.83 / 1.44);

  const enfTest = {
    ...physicalTest,
    testMode: "interface-shear",
    fractureMethod: "enf-mode-ii",
    loadDirectionGlobal: [1, 0, 0],
    testMethod: "Documented ENF three-point bend coupon",
    testProtocolHash: "7".repeat(64),
    measuredPeakStrengthMPa: 20,
    evidence: [{ ...physicalTest.evidence[0], value: 20 }],
    specimenResults: physicalTest.specimenResults!.map((specimen) => specimen.specimenId === "series-a-1"
      ? { ...specimen, peakForceN: 200, nominalPeakStrengthMPa: 20 }
      : specimen),
    tractionSeparationCurve: {
      sourceHash: "8".repeat(64), sourceLocator: "ENF.csv, compliance-corrected vector response",
      points: [
        { separationMm: 0, tractionMPa: 0 }, { separationMm: 0.2, tractionMPa: 20 },
        { separationMm: 0.4, tractionMPa: 0 },
      ],
    },
  };
  const savedEnf = output(await harness.client.callTool({ name: "plasticity_record_material_interface_test", arguments: enfTest }));
  const mmb75 = {
    ...mmbTest,
    loadDirectionGlobal: [Math.sin(Math.PI / 3), 0, Math.cos(Math.PI / 3)],
    testMethod: "Documented MMB mixed-mode bending at second mode ratio",
    testProtocolHash: "6".repeat(64),
    measuredPeakStrengthMPa: Math.sqrt(200),
    evidence: [{ ...mmbTest.evidence[0], value: Math.sqrt(200) }],
    specimenResults: mmbTest.specimenResults!.map((specimen) => specimen.specimenId === "series-a-1"
      ? { ...specimen, peakForceN: Math.sqrt(200) * specimen.netCrossSectionMm2, nominalPeakStrengthMPa: Math.sqrt(200) }
      : specimen),
    mixedModeTractionSeparationCurve: {
      sourceHash: "5".repeat(64), sourceLocator: "MMB-75.csv, compliance-corrected vector response",
      points: [
        { normalSeparationMm: 0, tangentialSeparationMm: 0, normalTractionMPa: 0, tangentialTractionMPa: 0 },
        { normalSeparationMm: 0.0671875, tangentialSeparationMm: 0.2015625, normalTractionMPa: 10, tangentialTractionMPa: 10 },
        { normalSeparationMm: 0.134375, tangentialSeparationMm: 0.403125, normalTractionMPa: 0, tangentialTractionMPa: 0 },
      ],
    },
  };
  const savedMmb75 = output(await harness.client.callTool({ name: "plasticity_record_material_interface_test", arguments: mmb75 }));
  const calibration = output(await harness.client.callTool({
    name: "plasticity_calibrate_turon_mixed_mode_law",
    arguments: {
      modeIRecordId: saved.record.id,
      modeIIRecordId: savedEnf.record.id,
      mixedModeRecordIds: [savedMmb.record.id, savedMmb75.record.id],
    },
  }));
  assert.equal(calibration.interpretation, "candidate-calibration-requires-engineering-review");
  assert.equal(calibration.samples.length, 2);
  assert.ok(calibration.etaBk > 0);
  assert.ok(calibration.limitations.some((limitation: string) => limitation.includes("does not identify the initial cohesive stiffness K")));
  const legacyDissimilarCalibration = await harness.client.callTool({
    name: "plasticity_calibrate_turon_mixed_mode_law",
    arguments: {
      modeIRecordId: legacyDissimilar.record.id,
      modeIIRecordId: savedEnf.record.id,
      mixedModeRecordIds: [savedMmb.record.id, savedMmb75.record.id],
    },
  });
  assert.equal(legacyDissimilarCalibration.isError, true);
  assert.match(JSON.stringify(legacyDissimilarCalibration.content), /same.material|same material/i);

  const dissimilarDcb = {
    ...physicalTest,
    materialBProcess: process("tpu-brand-b"),
    testProtocolHash: "9".repeat(64),
    tractionSeparationCurve: {
      ...physicalTest.tractionSeparationCurve,
      sourceHash: "a".repeat(64),
      sourceLocator: "dissimilar-bond.csv, compliance-corrected traction-separation data",
    },
    evidence: [{ ...physicalTest.evidence[0], id: "dissimilar-bond-strength", sourceHash: "8".repeat(64) }],
  };
  const dissimilarRecord = await harness.client.callTool({
    name: "plasticity_record_material_interface_test", arguments: dissimilarDcb,
  });
  assert.equal(dissimilarRecord.isError, true);
  assert.match(JSON.stringify(dissimilarRecord.content), /Unrecognized key|materialProcess/i);
});

test("MCP records and matches exact multi-hole physical test evidence without deriving a capacity", async (context) => {
  const harness = await createHarness(context, {});
  const physicalTest = fastenerGroupTestInput();
  const saved = output(await harness.client.callTool({ name: "plasticity_record_fastener_group_test", arguments: physicalTest }));
  assert.equal(saved.alreadyExisted, false);
  assert.equal(saved.record.recordStatus, "caller-attested-physical-multi-hole-joint-test");
  const matched = output(await harness.client.callTool({
    name: "plasticity_match_fastener_group_test",
    arguments: {
      process: physicalTest.process,
      geometry: { ...physicalTest.geometry, holes: [...physicalTest.geometry.holes].reverse() },
      fixture: physicalTest.fixture,
    },
  }));
  assert.equal(matched.status, "matched");
  assert.equal(matched.selected.id, saved.record.id);
  assert.equal("designAllowableMPa" in matched.selected, false);
  const differentThickness = output(await harness.client.callTool({
    name: "plasticity_match_fastener_group_test",
    arguments: {
      process: physicalTest.process,
      geometry: { ...physicalTest.geometry, thicknessMm: physicalTest.geometry.thicknessMm + 0.01 },
      fixture: physicalTest.fixture,
    },
  }));
  assert.equal(differentThickness.status, "no-match");
});

test("plate scenario and native verification use the existing exact prism binding", async (context) => {
  const harness = await createHarness(context, {});
  const scenario = output(await harness.client.callTool({
    name: "plasticity_calculate_strength",
    arguments: { ...syntheticPlateInput() },
  }));
  assert.equal(scenario.result.method, "simply-supported-plate-uniform-pressure-v1");
  assert.equal(scenario.result.plate.seriesMaxOddIndex, 401);

  const verified = output(await harness.client.callTool({
    name: "plasticity_verify_member_strength",
    arguments: {
      input: { ...syntheticPlateInput(), binding: binding("r1") },
      lengthAxis: [1, 0, 0],
      heightAxis: [0, 0, 1],
    },
  }));
  assert.deepEqual(
    [verified.input.lengthMm, verified.input.widthMm, verified.input.heightMm],
    [80, 20, 10],
  );
  assert.equal(verified.result.status, "unsupported");
  assert.ok(verified.result.issues.some((issue: { code: string }) => issue.code === "THICKNESS_OUTSIDE_THIN_PLATE_LIMIT"));
});

test("integral enclosure-wall verification replaces dimensions from exact opposed faces", async (context) => {
  let inspectedRequest: unknown;
  const harness = await createHarness(context, {
    inspectIntegralPlate: async (request) => {
      inspectedRequest = request;
      return {
        status: "verified",
        binding: binding(request.revision),
        faces: { frontFaceId: request.frontFaceId, backFaceId: request.backFaceId },
        geometry: { lengthMm: 80, widthMm: 20, thicknessMm: 2 },
        source: "native-brep-opposed-rectangular-faces",
        reasons: [],
      };
    },
  });
  const response = await harness.client.callTool({
    name: "plasticity_verify_integral_plate_strength",
    arguments: {
      input: { ...syntheticPlateInput(), binding: binding("r1") },
      frontFaceId: "outer-face",
      backFaceId: "inner-face",
      xDirection: [1, 0, 0],
    },
  });
  assert.notEqual(response.isError, true, JSON.stringify(response.content));
  const report = output(response);
  assert.deepEqual([report.input.lengthMm, report.input.widthMm, report.input.heightMm], [80, 20, 2]);
  assert.equal(report.input.binding.revision, "r1");
  assert.deepEqual(inspectedRequest, {
    bodyId: 7,
    frontFaceId: "outer-face",
    backFaceId: "inner-face",
    revision: "r1",
    xDirection: [1, 0, 0],
  });
  assert.ok(report.input.evidence.some((item: { label: string; status: string }) => item.label.includes("heightMm") && item.status === "measured"));
});

test("integral enclosure-wall verification refuses to save after a concurrent CAD change", async (context) => {
  let reads = 0;
  const harness = await createHarness(context, {
    inspectIntegralPlate: async (request) => ({
      status: "verified",
      binding: binding(request.revision),
      faces: { frontFaceId: request.frontFaceId, backFaceId: request.backFaceId },
      geometry: { lengthMm: 80, widthMm: 20, thicknessMm: 2 },
      source: "native-brep-opposed-rectangular-faces",
      reasons: [],
    }),
    readCadBinding: async (_bodyId) => binding(++reads === 1 ? "r1" : "r2"),
  });
  const response = await harness.client.callTool({
    name: "plasticity_verify_integral_plate_strength",
    arguments: {
      input: { ...syntheticPlateInput(), binding: binding("r1") },
      frontFaceId: "outer-face",
      backFaceId: "inner-face",
      xDirection: [1, 0, 0],
    },
  });
  assert.equal(response.isError, true);
  assert.match(JSON.stringify(response.content), /document changed during integral plate verification/);
  assert.equal(reads, 2);
});

test("analysis cancellation is persisted as interrupted and never authorizes CAD", async (context) => {
  let inspectCalls = 0;
  let sawAbort = false;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const analysis: AnalysisClient = {
    async fingerprintImages() { return []; },
    run(_input, options) {
      return new Promise((_resolve, reject) => {
        markStarted();
        if (options.signal?.aborted) {
          sawAbort = true;
          reject(Object.assign(new Error("cancelled"), { code: "ANALYSIS_CANCELLED" }));
          return;
        }
        options.signal?.addEventListener("abort", () => {
          sawAbort = true;
          reject(Object.assign(new Error("cancelled"), { code: "ANALYSIS_CANCELLED" }));
        }, { once: true });
      });
    },
    async close() {},
  };
  const harness = await createHarness(context, {
    analysis,
    inspectMember: async () => { inspectCalls += 1; throw new Error("must not inspect"); },
  });
  const controller = new AbortController();
  const running = harness.client.callTool({
    name: "plasticity_analyze_strength_task",
    arguments: { requestId: "cancel-me", prompt: "analyze", imagePaths: [], evidence: [], answers: [] },
  }, undefined, { signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(running, /abort/i);
  await waitForTerminal(harness.store, "cancel-me");
  assert.equal(sawAbort, true);
  assert.equal(inspectCalls, 0);

  const replay = output(await harness.client.callTool({ name: "plasticity_strength_request", arguments: { requestId: "cancel-me" } }));
  assert.equal(replay.state, "interrupted");
});

test("verification preserves physical uncertainty and appends native measured evidence", async (context) => {
  const harness = await createHarness(context, {});
  const input = { ...conditionalSyntheticInput("axial-rectangle-v1"), binding: binding("r1") };
  const report = output(await harness.client.callTool({
    name: "plasticity_verify_member_strength",
    arguments: { input, lengthAxis: [1, 0, 0], heightAxis: [0, 0, 1] },
  }));

  assert.equal(report.input.lengthMm, 80);
  assert.equal(report.input.widthMm, 20);
  assert.equal(report.input.heightMm, 10);
  assert.equal(report.input.binding.revision, "r1");
  assert.equal(report.result.status, "conditional");
  assert.ok(report.input.evidence.some((item: { id: string; status: string }) => item.id === "length" && item.status === "measured"));
  assert.notEqual(report.input.assignments.lengthMm, "length");
  assert.equal(report.input.evidence.find((item: { id: string }) => item.id === report.input.assignments.lengthMm).status, "measured");
});

test("member verification binds an Euler column calculation to measured native dimensions", async (context) => {
  const harness = await createHarness(context, {
    inspectMember: async (request) => ({
      binding: binding(request.revision),
      status: "verified",
      dimensions: { lengthMm: 200, widthMm: 20, heightMm: 10 },
      source: "native-brep",
      reasons: [],
    }),
  });
  const input = { ...syntheticEulerColumnInput(), binding: binding("r1") };
  const report = output(await harness.client.callTool({
    name: "plasticity_verify_member_strength",
    arguments: { input, lengthAxis: [1, 0, 0], heightAxis: [0, 0, 1] },
  }));

  assert.equal(report.input.method, "euler-column-buckling-v1");
  assert.equal(report.result.method, "euler-column-buckling-v1");
  assert.equal(report.result.status, "conditional");
  assert.ok(report.result.issues.some((issue: { code: string }) => issue.code === "MATERIAL_MATCH_UNVERIFIED"));
  assert.equal(report.result.buckling.secondMomentMm4, 1_666.6666666666667);
  assert.equal(report.input.evidence.find((item: { id: string }) => item.id === report.input.assignments.lengthMm).status, "measured");
});

test("manual CAD change during verification prevents a current stored conclusion", async (context) => {
  let reads = 0;
  const harness = await createHarness(context, {
    readCadBinding: async () => binding(++reads < 2 ? "r1" : "r2"),
  });
  const input = { ...syntheticInput("axial-rectangle-v1"), binding: binding("r1") };
  const response = await harness.client.callTool({
    name: "plasticity_verify_member_strength",
    arguments: { input, lengthAxis: [1, 0, 0], heightAxis: [0, 0, 1] },
  });
  assert.equal(response.isError, true);
  assert.match(JSON.stringify(response.content), /changed|stale/i);
});

test("report freshness checks manufacturing changes and live bound CAD identity", async (context) => {
  let live = binding("r1");
  const harness = await createHarness(context, { readCadBinding: async () => live });
  const input = { ...syntheticInput("axial-rectangle-v1"), binding: binding("r1") };
  const report = output(await harness.client.callTool({
    name: "plasticity_verify_member_strength",
    arguments: { input, lengthAxis: [1, 0, 0], heightAxis: [0, 0, 1] },
  }));
  const currentView = output(await harness.client.callTool({
    name: "plasticity_strength_report",
    arguments: { reportId: report.id, current: report.input },
  }));
  assert.equal(currentView.freshness, "current");
  const changedProfile = {
    ...report.input,
    material: {
      ...report.input.material,
      manufacturing: { ...report.input.material.manufacturing, orientationDeg: [0, 90, 0] },
    },
  };
  const profileView = output(await harness.client.callTool({
    name: "plasticity_strength_report",
    arguments: { reportId: report.id, current: changedProfile },
  }));
  assert.equal(profileView.freshness, "stale");
  assert.ok(profileView.reasons.includes("TASK_OR_MATERIAL_CHANGED"));

  live = binding("r2");
  const cadView = output(await harness.client.callTool({
    name: "plasticity_strength_report",
    arguments: { reportId: report.id, current: report.input },
  }));
  assert.equal(cadView.freshness, "stale");
  assert.ok(cadView.reasons.includes("CAD_REVISION_CHANGED"));
});

test("native verification fails clearly when no CAD session is connected", async (context) => {
  const harness = await createHarness(context, {
    readCadBinding: async () => { throw new Error("Connect to an explicit Plasticity window first"); },
  });
  const response = await harness.client.callTool({
    name: "plasticity_verify_member_strength",
    arguments: {
      input: { ...syntheticInput("axial-rectangle-v1"), binding: binding("r1") },
      lengthAxis: [1, 0, 0],
      heightAxis: [0, 0, 1],
    },
  });
  assert.equal(response.isError, true);
  assert.match(JSON.stringify(response.content), /connect.*Plasticity window/i);
});

test("single-fastener tools inspect, replace caller geometry and track live topology", async (context) => {
  let live = fastenerBinding("r1");
  const measured = verifiedFastenerEvidence("r1", { loadedEdgeDistanceMm: 12 });
  const harness = await createHarness(context, {
    inspectFastenerPlate: async () => measured,
    readFastenerBinding: async () => live,
  });
  const inspected = output(await harness.client.callTool({
    name: "plasticity_inspect_single_fastener_plate",
    arguments: { bodyId: 7, frontFaceId: "front", backFaceId: "back", revision: "r1", loadDirection: [1, 0, 0] },
  }));
  assert.deepEqual(inspected, measured);

  const scenarioInput = { ...fastenerScenarioFixture(), binding: fastenerBinding("r1") };
  const scenario = output(await harness.client.callTool({
    name: "plasticity_calculate_single_fastener_strength",
    arguments: scenarioInput,
  }));
  assert.equal(scenario.input.binding, undefined);
  assert.equal(scenario.result.kind, "single-fastener-plate");
  assert.match(scenario.result.checkedScope, /scenario/i);

  const verified = output(await harness.client.callTool({
    name: "plasticity_verify_single_fastener_strength",
    arguments: scenarioInput,
  }));
  assert.equal(verified.input.geometry.loadedEdgeDistanceMm, 12);
  assert.deepEqual(verified.input.binding, measured.binding);
  assert.equal(verified.input.evidence.find((item: { id: string }) => item.id === verified.input.assignments["geometry.loadedEdgeDistanceMm"]).status, "measured");
  const current = output(await harness.client.callTool({
    name: "plasticity_strength_report",
    arguments: { reportId: verified.id, current: verified.input },
  }));
  assert.equal(current.freshness, "current");

  live = { ...live, topologySignature: "changed-fastener" };
  const stale = output(await harness.client.callTool({
    name: "plasticity_strength_report",
    arguments: { reportId: verified.id, current: verified.input },
  }));
  assert.equal(stale.freshness, "stale");
  assert.ok(stale.reasons.includes("CAD_TOPOLOGY_CHANGED"));
});

test("single-fastener verification rejects unsupported geometry and a stale-before-store race", async (context) => {
  const input = { ...fastenerScenarioFixture(), binding: fastenerBinding("r1") };
  const unsupportedHarness = await createHarness(context, {
    inspectFastenerPlate: async (request) => ({
      status: "unsupported",
      binding: { ...fastenerBinding(request.revision), bodyId: request.bodyId },
      source: "native-brep-opposed-faces",
      reasons: ["unsupported-body-topology"],
    }),
  });
  const unsupported = await unsupportedHarness.client.callTool({
    name: "plasticity_verify_single_fastener_strength",
    arguments: input,
  });
  assert.equal(unsupported.isError, true);
  assert.match(JSON.stringify(unsupported.content), /unsupported-body-topology/);
  assert.deepEqual(await reportFiles(unsupportedHarness.root), []);

  const staleHarness = await createHarness(context, {
    inspectFastenerPlate: async () => verifiedFastenerEvidence("r1"),
    readFastenerBinding: async () => fastenerBinding("r2"),
  });
  const stale = await staleHarness.client.callTool({
    name: "plasticity_verify_single_fastener_strength",
    arguments: input,
  });
  assert.equal(stale.isError, true);
  assert.match(JSON.stringify(stale.content), /changed|stale/i);
  assert.deepEqual(await reportFiles(staleHarness.root), []);
});

test("fastener-member calculation persists a labelled scenario and tracks engineering changes", async (context) => {
  const harness = await createHarness(context, {});
  const input = fastenerMemberFixture();
  const response = await harness.client.callTool({
    name: "plasticity_calculate_fastener_member_strength",
    arguments: input as unknown as Record<string, unknown>,
  });
  assert.equal(response.isError, undefined);
  const report = output(response);
  assert.equal(report.kind, "fastener-member");
  assert.equal(report.result.method, "fastener-member-v1");
  assert.equal(report.result.status, "pass");
  assert.match(report.result.checkedScope, /scenario/i);

  const current = output(await harness.client.callTool({
    name: "plasticity_strength_report",
    arguments: { reportId: report.id, current: report.input },
  }));
  assert.equal(current.freshness, "current");

  const changed = structuredClone(report.input);
  changed.loads.transverseShearN = 750;
  changed.evidence.find((item: { id: string }) => item.id === "loads.transverseShearN").value = 750;
  const stale = output(await harness.client.callTool({
    name: "plasticity_strength_report",
    arguments: { reportId: report.id, current: changed },
  }));
  assert.equal(stale.freshness, "stale");
  assert.deepEqual(stale.reasons, ["TASK_OR_MATERIAL_CHANGED"]);

  const strict = await harness.client.callTool({
    name: "plasticity_calculate_fastener_member_strength",
    arguments: { ...input, extra: true } as unknown as Record<string, unknown>,
  });
  assert.equal(strict.isError, true);
});

test("tongue-root calculation is exposed through MCP and explicitly remains conditional", async (context) => {
  const harness = await createHarness(context, {});
  const response = await harness.client.callTool({
    name: "plasticity_calculate_tongue_root_strength",
    arguments: tongueRootFixture() as unknown as Record<string, unknown>,
  });
  assert.equal(response.isError, undefined);
  const report = output(response);
  assert.equal(report.kind, "tongue-root");
  assert.equal(report.result.method, "tongue-root-transverse-v1");
  assert.equal(report.result.status, "conditional");
  assert.match(report.result.checkedScope, /Calculation scenario/);
  assert.match(report.result.checkedScope, /never a pass/);
});

test("tongue-root coupon calculation copies exact-match moduli and keeps allowables independent", async (context) => {
  const harness = await createHarness(context, {});
  const qualification = materialCouponQualificationInput();
  await harness.client.callTool({ name: "plasticity_record_material_coupon_data", arguments: qualification });
  const fixture = tongueRootFixture();
  const { material, ...scenario } = fixture;
  const assignments = { ...scenario.assignments };
  delete assignments["material.youngModulusMPa"];
  delete assignments["material.shearModulusMPa"];
  const evidence = scenario.evidence.filter((item) => item.id !== "material.youngModulusMPa" && item.id !== "material.shearModulusMPa");
  const args = {
    process: qualification.process,
    scenario: { ...scenario, assignments, evidence },
    allowables: { tensileMPa: material.tensileAllowableMPa, shearMPa: material.shearAllowableMPa },
    allowablesBasis: "Separately sourced design allowable for this exact material/process; independent of measured ultimate coupon strength.",
    effectiveSection: "validated-effective",
  };
  const response = await harness.client.callTool({
    name: "plasticity_calculate_tongue_root_strength_from_coupon_data",
    arguments: args,
  });
  assert.equal(response.isError, undefined, JSON.stringify(response));
  const report = output(response);
  assert.equal(report.status, "calculated-conditional");
  assert.equal(report.couponRecordId.length, 64);
  assert.equal(report.report.input.material.youngModulusMPa, qualification.properties.youngModulusMPa);
  assert.equal(report.report.input.material.shearModulusMPa, qualification.properties.shearModulusMPa);
  assert.equal(report.report.input.material.tensileAllowableMPa, material.tensileAllowableMPa);
  assert.equal(report.report.input.material.suitability, "unconfirmed");
  assert.equal(report.report.input.material.couponRecordId, report.couponRecordId);
  assert.equal(report.report.input.material.allowablesBasis, args.allowablesBasis);
  assert.ok(report.report.input.evidence.some((item: { id: string }) => item.id === "young-modulus"));
  assert.ok(report.report.result.issues.some((issue: { code: string }) => issue.code === "MATERIAL_UNCONFIRMED"));

  const noMatch = output(await harness.client.callTool({
    name: "plasticity_calculate_tongue_root_strength_from_coupon_data",
    arguments: { ...args, process: { ...qualification.process, orientationDeg: [0, 90, 0] } },
  }));
  assert.equal(noMatch.status, "no-match");
  assert.equal("report" in noMatch, false);
});

test("tongue-root refuses a coupon without its required measured shear modulus", async (context) => {
  const harness = await createHarness(context, {});
  const qualification = materialCouponQualificationInput();
  for (const property of ["shearModulusMPa", "tensileStrengthMPa", "shearStrengthMPa"] as const) {
    Reflect.deleteProperty(qualification.properties, property);
    Reflect.deleteProperty(qualification.propertyEvidence, property);
  }
  qualification.evidence = qualification.evidence.filter((item) => item.id === "young-modulus");
  await harness.client.callTool({ name: "plasticity_record_material_coupon_data", arguments: qualification });
  const fixture = tongueRootFixture();
  const { material, ...scenario } = fixture;
  const assignments = { ...scenario.assignments };
  delete assignments["material.youngModulusMPa"];
  delete assignments["material.shearModulusMPa"];
  const evidence = scenario.evidence.filter((item) => item.id !== "material.youngModulusMPa" && item.id !== "material.shearModulusMPa");
  const response = await harness.client.callTool({
    name: "plasticity_calculate_tongue_root_strength_from_coupon_data",
    arguments: {
      process: qualification.process,
      scenario: { ...scenario, assignments, evidence },
      allowables: { tensileMPa: material.tensileAllowableMPa, shearMPa: material.shearAllowableMPa },
      allowablesBasis: "Separately sourced design allowables for this exact material/process.",
      effectiveSection: "validated-effective",
    },
  });
  assert.equal(response.isError, true);
  const errorText = (response as { content: { type: string; text: string }[] }).content[0]?.text ?? "";
  assert.match(errorText, /needs measured coupon shear modulus and evidence/i);
});

test("rectangular coupon calculation copies only exact-match Young's modulus and preserves independent allowables", async (context) => {
  const harness = await createHarness(context, {});
  const qualification = materialCouponQualificationInput();
  await harness.client.callTool({ name: "plasticity_record_material_coupon_data", arguments: qualification });
  const fixture = syntheticInput("cantilever-tip-rectangle-v1");
  const { material, ...scenario } = fixture;
  const assignments = { ...scenario.assignments };
  delete assignments["material.youngMPa"];
  const evidence = scenario.evidence.filter((item) => item.id !== "young");
  const couponYoungEvidenceId = qualification.propertyEvidence.youngModulusMPa[0]!;
  const assumptions = scenario.assumptions.map((assumption) => ({
    ...assumption,
    evidenceIds: assumption.evidenceIds.map((id) => id === "young" ? couponYoungEvidenceId : id),
  }));
  const args = {
    process: qualification.process,
    scenario: { ...scenario, assignments, evidence, assumptions },
    allowables: { tensileMPa: material.tensileLimitMPa, compressiveMPa: material.compressiveLimitMPa },
    allowablesBasis: "Separately sourced tensile and compressive design allowables; independent of raw coupon strengths.",
    effectiveSection: "validated-effective",
  };
  const response = await harness.client.callTool({
    name: "plasticity_calculate_rectangular_strength_from_coupon_data",
    arguments: args,
  });
  assert.equal(response.isError, undefined, JSON.stringify(response));
  const result = output(response);
  const report = result.report;
  assert.equal(result.status, "calculated-conditional");
  assert.equal(report.input.material.youngMPa, qualification.properties.youngModulusMPa);
  assert.equal(report.input.material.tensileLimitMPa, material.tensileLimitMPa);
  assert.equal(report.input.material.compressiveLimitMPa, material.compressiveLimitMPa);
  assert.notEqual(report.input.material.tensileLimitMPa, qualification.properties.tensileStrengthMPa);
  assert.equal(report.input.material.suitability, "unconfirmed");
  assert.equal(report.input.material.couponRecordId, result.couponRecordId);
  assert.equal(report.input.material.allowablesBasis, args.allowablesBasis);
  assert.equal(report.input.assignments["material.youngMPa"], qualification.propertyEvidence.youngModulusMPa[0]);
  assert.ok(report.input.evidence.some((item: { id: string }) => item.id === qualification.propertyEvidence.youngModulusMPa[0]));
  assert.ok(report.result.issues.some((issue: { code: string }) => issue.code === "MATERIAL_UNCONFIRMED"));

  const missingCompression = await harness.client.callTool({
    name: "plasticity_calculate_rectangular_strength_from_coupon_data",
    arguments: { ...args, allowables: { tensileMPa: material.tensileLimitMPa } },
  });
  assert.equal(missingCompression.isError, true);
  assert.match(JSON.stringify(missingCompression.content), /compressive allowable/i);

  const noMatch = output(await harness.client.callTool({
    name: "plasticity_calculate_rectangular_strength_from_coupon_data",
    arguments: { ...args, process: { ...qualification.process, orientationDeg: [0, 90, 0] } },
  }));
  assert.equal(noMatch.status, "no-match");
  assert.equal("report" in noMatch, false);
});

test("tongue-root coupon verification binds exact native dimensions after resolving material data", async (context) => {
  const plane = { originMm: [0, 0, 0] as [number, number, number], normal: [1, 0, 0] as [number, number, number], xDirection: [0, 1, 0] as [number, number, number] };
  let reads = 0;
  const harness = await createHarness(context, {
    inspectArbitrarySection: async (request) => {
      reads += 1;
      return rectangularSectionEvidence(request.bodyId, request.revision, request.plane, 10, 5);
    },
  });
  const qualification = materialCouponQualificationInput();
  await harness.client.callTool({ name: "plasticity_record_material_coupon_data", arguments: qualification });
  const fixture = tongueRootFixture();
  const { material, ...scenario } = fixture;
  const assignments = { ...scenario.assignments };
  delete assignments["material.youngModulusMPa"];
  delete assignments["material.shearModulusMPa"];
  const evidence = scenario.evidence.filter((item) => item.id !== "material.youngModulusMPa" && item.id !== "material.shearModulusMPa");
  const initialSection = rectangularSectionEvidence(7, "r1", plane, 10, 5);
  const response = await harness.client.callTool({
    name: "plasticity_verify_tongue_root_strength_from_coupon_data",
    arguments: {
      process: qualification.process,
      scenario: { ...scenario, assignments, evidence, binding: initialSection.binding },
      allowables: { tensileMPa: material.tensileAllowableMPa, shearMPa: material.shearAllowableMPa },
      allowablesBasis: "Separately sourced design allowable; not taken from raw coupon strength.",
      effectiveSection: "unknown",
    },
  });
  assert.equal(response.isError, undefined, JSON.stringify(response));
  const result = output(response);
  assert.equal(reads, 2);
  assert.deepEqual([result.report.input.geometry.rootWidthMm, result.report.input.geometry.rootThicknessMm], [10, 5]);
  assert.equal(result.report.input.material.youngModulusMPa, qualification.properties.youngModulusMPa);
  assert.equal(result.report.input.material.couponRecordId, result.couponRecordId);
  assert.ok(result.report.result.issues.some((issue: { code: string }) => issue.code === "EFFECTIVE_SECTION_UNCONFIRMED"));
});

test("tongue-root verification replaces dimensions with an exact section and rechecks its CAD binding", async (context) => {
  const plane = { originMm: [0, 0, 0] as [number, number, number], normal: [1, 0, 0] as [number, number, number], xDirection: [0, 1, 0] as [number, number, number] };
  let nativeTopologyChanged = false;
  const harness = await createHarness(context, {
    inspectArbitrarySection: async (request) => {
      const evidence = rectangularSectionEvidence(request.bodyId, request.revision, request.plane, 12, 4);
      return nativeTopologyChanged ? { ...evidence, binding: { ...evidence.binding, topologySignature: "edited-native-topology" } } : evidence;
    },
  });
  const input = tongueRootFixture();
  input.binding = {
    sessionId: "session-1",
    documentToken: "doc-1",
    revision: "r1",
    bodyId: 7,
    plane,
    topologySignature: "pending-inspection",
  };
  const inspected = output(await harness.client.callTool({
    name: "plasticity_inspect_tongue_root_section",
    arguments: { bodyId: 7, revision: "r1", plane },
  }));
  assert.equal(inspected.status, "verified");
  assert.deepEqual(inspected.dimensions, { rootWidthMm: 12, rootThicknessMm: 4 });
  input.binding = inspected.binding;

  const response = await harness.client.callTool({
    name: "plasticity_verify_tongue_root_strength",
    arguments: { input },
  });
  assert.equal(response.isError, undefined, JSON.stringify(response));
  const report = output(response);
  assert.equal(report.input.geometry.rootWidthMm, 12);
  assert.equal(report.input.geometry.rootThicknessMm, 4);
  assert.equal(report.input.evidence.find((item: { id: string }) => item.id === report.input.assignments["geometry.rootWidthMm"]).status, "measured");
  assert.equal(report.result.status, "conditional");
  assert.match(report.result.checkedScope, /Verified current native B-rep/);

  const current = output(await harness.client.callTool({
    name: "plasticity_strength_report",
    arguments: { reportId: report.id, current: report.input },
  }));
  assert.equal(current.freshness, "current");

  nativeTopologyChanged = true;
  const stale = output(await harness.client.callTool({
    name: "plasticity_strength_report",
    arguments: { reportId: report.id, current: report.input },
  }));
  assert.equal(stale.freshness, "stale");
  assert.ok(stale.reasons.includes("CAD_TOPOLOGY_CHANGED"));
});

test("tongue-root verification does not save when the section changes before persistence", async (context) => {
  const plane = { originMm: [0, 0, 0] as [number, number, number], normal: [1, 0, 0] as [number, number, number], xDirection: [0, 1, 0] as [number, number, number] };
  let reads = 0;
  const harness = await createHarness(context, {
    inspectArbitrarySection: async (request) => {
      reads += 1;
      const evidence = rectangularSectionEvidence(request.bodyId, request.revision, request.plane, 10, 5);
      return reads === 1 ? evidence : { ...evidence, binding: { ...evidence.binding, revision: "r2" } };
    },
  });
  const input = tongueRootFixture();
  input.binding = rectangularSectionEvidence(7, "r1", plane, 10, 5).binding;
  const response = await harness.client.callTool({
    name: "plasticity_verify_tongue_root_strength",
    arguments: { input },
  });
  assert.equal(response.isError, true);
  assert.match(JSON.stringify(response.content), /changed during tongue-root verification/i);
  assert.deepEqual(await reportFiles(harness.root), []);
});

test("threaded-receiver calculation persists a strict scenario and tracks engagement changes", async (context) => {
  const harness = await createHarness(context, {});
  const input = threadedReceiverFixture();
  const response = await harness.client.callTool({
    name: "plasticity_calculate_threaded_receiver_strength",
    arguments: input as unknown as Record<string, unknown>,
  });
  assert.equal(response.isError, undefined);
  const report = output(response);
  assert.equal(report.kind, "threaded-receiver");
  assert.equal(report.result.method, "threaded-receiver-axial-v1");
  assert.equal(report.result.status, "pass");
  assert.match(report.result.checkedScope, /scenario/i);

  const current = output(await harness.client.callTool({
    name: "plasticity_strength_report",
    arguments: { reportId: report.id, current: report.input },
  }));
  assert.equal(current.freshness, "current");

  const changed = structuredClone(report.input);
  changed.configuration.engagementMm = 8.8;
  changed.configuration.completeThreadCount = 11;
  changed.evidence.find((item: { id: string }) => item.id === "configuration.engagementMm").value = 8.8;
  changed.evidence.find((item: { id: string }) => item.id === "configuration.completeThreadCount").value = 11;
  const stale = output(await harness.client.callTool({
    name: "plasticity_strength_report",
    arguments: { reportId: report.id, current: changed },
  }));
  assert.deepEqual(stale.reasons, ["TASK_OR_MATERIAL_CHANGED"]);

  const strict = await harness.client.callTool({
    name: "plasticity_calculate_threaded_receiver_strength",
    arguments: { ...input, extra: true } as unknown as Record<string, unknown>,
  });
  assert.equal(strict.isError, true);
});

test("heat-set insert retention persists a strict scenario and tracks qualification changes", async (context) => {
  const harness = await createHarness(context, {});
  const input = insertRetentionFixture();
  const response = await harness.client.callTool({
    name: "plasticity_calculate_heat_set_insert_retention",
    arguments: input as unknown as Record<string, unknown>,
  });
  assert.equal(response.isError, undefined);
  const report = output(response);
  assert.equal(report.kind, "heat-set-insert-retention");
  assert.equal(report.result.status, "pass");
  assert.deepEqual(report.result.utilization, { pullout: 0.5, torqueOut: 0 });
  assert.match(report.result.checkedScope, /scenario/i);

  const current = output(await harness.client.callTool({
    name: "plasticity_strength_report",
    arguments: { reportId: report.id, current: report.input },
  }));
  assert.equal(current.freshness, "current");

  const changed = structuredClone(report.input);
  changed.configuration.profileHash = "other-profile";
  const stale = output(await harness.client.callTool({
    name: "plasticity_strength_report",
    arguments: { reportId: report.id, current: changed },
  }));
  assert.deepEqual(stale.reasons, ["TASK_OR_MATERIAL_CHANGED"]);

  const strict = await harness.client.callTool({
    name: "plasticity_calculate_heat_set_insert_retention",
    arguments: { ...input, extra: true } as unknown as Record<string, unknown>,
  });
  assert.equal(strict.isError, true);
});

test("fastener-group load distribution persists a strict scenario and tracks load-path changes", async (context) => {
  const harness = await createHarness(context, {});
  const input = fastenerGroupFixture();
  input.binding = fastenerGroupBinding("r1");
  input.shearCapacities = input.fasteners.map((fastener) => ({
    fastenerId: fastener.id,
    configuration: "M5 class 8.8, unthreaded shank in single shear",
    allowableShearN: 40,
  }));
  for (const [index, capacity] of input.shearCapacities.entries()) {
    const evidenceId = `shear-allowable-${capacity.fastenerId}`;
    input.evidence.push({
      id: evidenceId,
      label: `Qualified design allowable for ${capacity.configuration}`,
      status: "sourced",
      unit: "N",
      value: 40,
      sourceUrl: "https://example.test/fastener-allowable",
      sourceHash: "c".repeat(64),
      sourceLocator: `design-data:${capacity.fastenerId}`,
      dependsOn: [],
    });
    input.assignments[`fastenerShearCapacities.${index}.allowableShearN`] = evidenceId;
  }
  const response = await harness.client.callTool({
    name: "plasticity_distribute_fastener_group_load",
    arguments: input as unknown as Record<string, unknown>,
  });
  assert.equal(response.isError, undefined);
  const report = output(response);
  assert.equal(report.kind, "fastener-group-load");
  assert.equal(report.input.binding, undefined);
  assert.equal(report.result.status, "calculated");
  assert.equal(report.result.fastenerShearCheck.status, "exceeds-allowable");
  assert.deepEqual(report.result.governing, { fastenerId: "C", shearDemandN: 50 });
  assert.deepEqual(report.result.fastenerShearCheck.governing, { fastenerId: "C", utilization: 1.25 });
  assert.match(report.result.checkedScope, /scenario/i);

  const current = output(await harness.client.callTool({
    name: "plasticity_strength_report",
    arguments: { reportId: report.id, current: report.input },
  }));
  assert.equal(current.freshness, "current");

  const changed = structuredClone(report.input);
  changed.load.applicationPointYmm = 35;
  changed.evidence.find((item: { id: string }) => item.id === "load.applicationPointYmm").value = 35;
  const stale = output(await harness.client.callTool({
    name: "plasticity_strength_report",
    arguments: { reportId: report.id, current: changed },
  }));
  assert.deepEqual(stale.reasons, ["TASK_OR_MATERIAL_CHANGED"]);

  const strict = await harness.client.callTool({
    name: "plasticity_distribute_fastener_group_load",
    arguments: { ...input, extra: true } as unknown as Record<string, unknown>,
  });
  assert.equal(strict.isError, true);
});

test("fastener-group verification replaces positions with native evidence and tracks live topology", async (context) => {
  let live = fastenerGroupBinding("r1");
  const harness = await createHarness(context, {
    inspectFastenerGroup: async () => verifiedFastenerGroupEvidence("r1"),
    readFastenerGroupBinding: async () => live,
  });
  const input = fastenerGroupFixture();
  input.binding = fastenerGroupBinding("r1");
  const response = await harness.client.callTool({
    name: "plasticity_verify_fastener_group_load",
    arguments: input as unknown as Record<string, unknown>,
  });
  assert.equal(response.isError, undefined);
  const report = output(response);
  assert.equal(report.result.status, "calculated");
  assert.equal(report.input.binding.topologySignature, "fastener-group-signature");
  assert.deepEqual(report.input.fasteners, input.fasteners);
  for (const [index] of input.fasteners.entries()) {
    const evidence = report.input.evidence.find((item: { id: string }) => item.id === report.input.assignments[`fasteners.${index}.xMm`]);
    assert.equal(evidence.status, "measured");
    assert.match(evidence.sourceLocator, /body=7&face=/u);
  }

  const current = output(await harness.client.callTool({
    name: "plasticity_strength_report",
    arguments: { reportId: report.id, current: report.input },
  }));
  assert.equal(current.freshness, "current");

  live = { ...live, topologySignature: "changed-signature" };
  const stale = output(await harness.client.callTool({
    name: "plasticity_strength_report",
    arguments: { reportId: report.id, current: report.input },
  }));
  assert.equal(stale.freshness, "stale");
  assert.ok(stale.reasons.includes("CAD_TOPOLOGY_CHANGED"));
});

test("multi-hole bearing tool measures current thickness and never returns an overall pass", async (context) => {
  let live = fastenerGroupBinding("r1");
  const harness = await createHarness(context, {
    inspectFastenerGroup: async () => verifiedFastenerGroupEvidence("r1"),
    inspectFastenerGroupLayout: async (request) => verifiedFastenerGroupLayoutEvidence(request),
    readFastenerGroupBinding: async () => live,
  });
  const group = fastenerGroupFixture();
  group.binding = fastenerGroupBinding("r1");
  const response = await harness.client.callTool({
    name: "plasticity_verify_fastener_group_plate_bearing",
    arguments: {
      group,
      netTension: {
        axis: "x",
        demandN: 100,
        tensileDesignAllowableMPa: 10,
        allowableEvidence: {
          id: "tensile-net-allowable",
          label: "Configuration-matched net-tension design allowable",
          status: "sourced",
          unit: "MPa",
          value: 10,
          sourceUrl: "https://example.test/tensile-allowable",
          sourceHash: "sha256:tensile-allowable",
          dependsOn: [],
        },
        assumptions: {
          uniformMembraneTension: true,
          loadCenteredThroughThickness: true,
          straightCutFailurePath: true,
        },
      },
      edgeShearOut: {
        shearDesignAllowableMPa: 5,
        allowableEvidence: {
          id: "shear-out-allowable",
          label: "Configuration-matched shear-out design allowable",
          status: "sourced",
          unit: "MPa",
          value: 5,
          sourceUrl: "https://example.test/shear-out-allowable",
          sourceHash: "sha256:shear-out-allowable",
          dependsOn: [],
        },
        assumptions: {
          homogeneousEquivalentPlate: true,
          loadCenteredThroughThickness: true,
          twoPlaneShearOut: true,
        },
      },
      plate: {
        boundaryFaceId: "front",
        opposedFaceId: "back",
        bearingDesignAllowableMPa: 20,
        allowableEvidence: {
          id: "bearing-allowable",
          label: "Configuration-matched bearing design allowable",
          status: "sourced",
          unit: "MPa",
          value: 20,
          sourceUrl: "https://example.test/bearing-allowable",
          sourceHash: "sha256:allowable",
          dependsOn: [],
        },
        materialConfiguration: "K1C/PLA/profile-hash/orientation coupon set",
        materialSuitability: "matched",
        assumptions: {
          homogeneousEquivalentPlate: true,
          nominalBearingContact: true,
          loadCenteredThroughThickness: true,
        },
      },
    },
  });
  assert.equal(response.isError, undefined);
  const stored = output(response);
  assert.equal(stored.kind, "fastener-group-plate-bearing");
  assert.ok(stored.id);
  const result = stored.result;
  assert.equal(result.status, "conditional");
  assert.equal(result.bearingCheckStatus, "within-allowable");
  assert.equal(result.plate.thicknessMm, 8);
  assert.equal(result.fasteners.length, 4);
  assert.equal(result.netSection.minimumNetWidthMm, 28);
  assert.equal(result.netSection.netAreaMm2, 224);
  assert.equal(result.netSection.tensileStressMPa, 100 / 224);
  assert.equal(result.netSection.checkStatus, "within-allowable");
  assert.equal(result.netSection.intersectedHoles.length, 2);
  assert.equal(result.edgeShearOut.status, "unsupported");
  assert.ok(result.edgeShearOut.fasteners.some((fastener: { checkStatus: string }) => fastener.checkStatus === "unsupported"));
  assert.ok(result.unchecked.some((item: string) => /angled\/staggered net-section paths/i.test(item)));
  assert.match(result.checkedScope, /complete joint remain unchecked/i);

  const alignedInput = structuredClone(stored.input);
  alignedInput.group.load.applicationPointYmm = 0;
  const applicationPointEvidenceId = alignedInput.group.assignments["load.applicationPointYmm"];
  alignedInput.group.evidence.find((item: { id: string }) => item.id === applicationPointEvidenceId)!.value = 0;
  const alignedResult = output(await harness.client.callTool({
    name: "plasticity_verify_fastener_group_plate_bearing",
    arguments: alignedInput,
  })).result;
  assert.equal(alignedResult.edgeShearOut.status, "conditional");
  assert.equal(alignedResult.edgeShearOut.fasteners.filter((fastener: { checkStatus: string }) => fastener.checkStatus === "conditional").length, 2);
  assert.equal(alignedResult.edgeShearOut.fasteners.filter((fastener: { checkStatus: string }) => fastener.checkStatus === "within-allowable").length, 2);
  assert.equal(Math.max(...alignedResult.edgeShearOut.fasteners.map((fastener: { nominalShearOutStressMPa: number }) => fastener.nominalShearOutStressMPa)), 25 / 112);

  const overloadedInput = structuredClone(stored.input);
  overloadedInput.netTension.demandN = 100_000;
  const overloaded = output(await harness.client.callTool({
    name: "plasticity_verify_fastener_group_plate_bearing",
    arguments: overloadedInput,
  }));
  assert.equal(overloaded.result.netSection.checkStatus, "exceeds-allowable");
  assert.equal(overloaded.result.status, "fail");
  assert.ok(overloaded.result.issues.some((issue: { code: string }) => issue.code === "NET_SECTION_ALLOWABLE_EXCEEDED"));

  const unconfirmedPathInput = structuredClone(stored.input);
  unconfirmedPathInput.netTension.assumptions.straightCutFailurePath = false;
  const unconfirmedPath = output(await harness.client.callTool({
    name: "plasticity_verify_fastener_group_plate_bearing",
    arguments: unconfirmedPathInput,
  }));
  assert.equal(unconfirmedPath.result.netSection.checkStatus, "conditional");
  assert.equal(unconfirmedPath.result.status, "conditional");
  assert.ok(unconfirmedPath.result.issues.some((issue: { code: string }) => issue.code === "NET_SECTION_ASSUMPTIONS_UNCONFIRMED"));

  const current = output(await harness.client.callTool({
    name: "plasticity_fastener_group_plate_bearing_report",
    arguments: { reportId: stored.id, current: stored.input },
  }));
  assert.equal(current.freshness, "current");
  const changedConfiguration = structuredClone(stored.input);
  changedConfiguration.plate.materialConfiguration = "different print configuration";
  const changed = output(await harness.client.callTool({
    name: "plasticity_fastener_group_plate_bearing_report",
    arguments: { reportId: stored.id, current: changedConfiguration },
  }));
  assert.equal(changed.freshness, "stale");
  assert.ok(changed.reasons.includes("TASK_OR_MATERIAL_CHANGED"));
  const changedNetDemand = structuredClone(stored.input);
  changedNetDemand.netTension.demandN += 1;
  const changedNetReport = output(await harness.client.callTool({
    name: "plasticity_fastener_group_plate_bearing_report",
    arguments: { reportId: stored.id, current: changedNetDemand },
  }));
  assert.equal(changedNetReport.freshness, "stale");
  assert.ok(changedNetReport.reasons.includes("TASK_OR_MATERIAL_CHANGED"));
  live = fastenerGroupBinding("r2");
  const stale = output(await harness.client.callTool({
    name: "plasticity_fastener_group_plate_bearing_report",
    arguments: { reportId: stored.id, current: stored.input },
  }));
  assert.equal(stale.freshness, "stale");
  assert.ok(stale.reasons.includes("CAD_REVISION_CHANGED"));
});

test("multi-hole bearing report compares only an exact-process physical test within evidence-backed geometry tolerance", async (context) => {
  let liveHeightMm = 40;
  const harness = await createHarness(context, {
    inspectFastenerGroup: async () => verifiedFastenerGroupEvidence("r1"),
    inspectFastenerGroupLayout: async (request) => {
      const geometry = verifiedFastenerGroupLayoutEvidence(request);
      geometry.plate!.sizeMm.y = liveHeightMm;
      if (liveHeightMm === 40) {
        geometry.plate!.sizeMm.x = 60.005;
        geometry.plate!.boundsMm.maxX = 30.005;
        geometry.plate!.sizeMm.y = 39.998;
        geometry.plate!.boundsMm.maxY = 19.998;
        geometry.plate!.thicknessMm = 8.003;
        geometry.fasteners![0]!.localCenterMm.x += 0.004;
      }
      return geometry;
    },
  });
  const testInput = fastenerGroupTestInput();
  testInput.geometry = {
    widthMm: 60, heightMm: 40, thicknessMm: 8,
    holes: [
      { xMm: 10, yMm: 10, diameterMm: 6 }, { xMm: 50, yMm: 10, diameterMm: 6 },
      { xMm: 10, yMm: 30, diameterMm: 6 }, { xMm: 50, yMm: 30, diameterMm: 6 },
    ],
  };
  testInput.outcomes = [{ peakLoadN: 400, failureMode: "shared-ligament", evidenceIds: ["peak"] }];
  testInput.evidence.find((item) => item.id === "peak")!.value = 400;
  const { record } = await harness.store.fastenerGroupTests.record(testInput);
  const input = {
    group: { ...fastenerGroupFixture(), binding: fastenerGroupBinding("r1") },
    netTension: {
      axis: "x" as const, demandN: 100, tensileDesignAllowableMPa: 10,
      allowableEvidence: {
        id: "net-allowable", label: "Traceable net-section allowable", status: "sourced" as const,
        unit: "MPa" as const, value: 10, sourceUrl: "https://example.test/net-allowable",
        sourceHash: "sha256:net-allowable", dependsOn: [],
      },
      assumptions: { uniformMembraneTension: true, loadCenteredThroughThickness: true, straightCutFailurePath: true },
    },
    physicalTest: {
      recordId: record.id, process: record.process, safetyFactor: 2,
      geometryToleranceMm: 0.01,
      geometryToleranceEvidence: {
        id: "geometry-tolerance", label: "Documented specimen metrology tolerance", status: "measured" as const,
        unit: "mm" as const, value: 0.01, sourceHash: "e".repeat(64), sourceLocator: "metrology:calibration-report",
        dependsOn: [],
      },
      processMatchesPartConfirmed: true as const,
      fixtureAndLoadPathMatchConfirmed: true as const,
    },
    plate: {
      boundaryFaceId: "front", opposedFaceId: "back", bearingDesignAllowableMPa: 20,
      allowableEvidence: {
        id: "bearing-allowable", label: "Traceable bearing allowable", status: "sourced" as const,
        unit: "MPa" as const, value: 20, sourceUrl: "https://example.test/bearing-allowable",
        sourceHash: "sha256:bearing-allowable", dependsOn: [],
      },
      materialConfiguration: "same recorded printer, material, profile, orientation and infill",
      materialSuitability: "matched" as const,
      assumptions: { homogeneousEquivalentPlate: true, nominalBearingContact: true, loadCenteredThroughThickness: true },
    },
  };
  const report = output(await harness.client.callTool({ name: "plasticity_verify_fastener_group_plate_bearing", arguments: input }));
  assert.equal(report.result.physicalTestComparison.specimenCount, 1);
  assert.equal(report.result.physicalTestComparison.factoredDemandN, 200);
  assert.equal(report.result.physicalTestComparison.geometryToleranceEvidenceId, "geometry-tolerance");
  assert.equal(report.result.physicalTestComparison.geometryMatch.matchedHoleCount, 4);
  assert.ok(Math.abs(report.result.physicalTestComparison.geometryMatch.plateDeltaMm.width + 0.005) < 1e-9);
  assert.ok(Math.abs(report.result.physicalTestComparison.geometryMatch.plateDeltaMm.height - 0.002) < 1e-9);
  assert.ok(Math.abs(report.result.physicalTestComparison.geometryMatch.plateDeltaMm.thickness + 0.003) < 1e-9);
  assert.ok(Math.abs(report.result.physicalTestComparison.geometryMatch.maximumHoleCenterOffsetMm - 0.004) < 1e-9);
  assert.equal(report.result.physicalTestComparison.outcome, "below-minimum-observed-failure-load");
  assert.match(report.result.physicalTestComparison.interpretation, /not a statistically reduced design allowable/i);
  assert.ok(["conditional", "fail"].includes(report.result.status));
  assert.notEqual(report.result.status, "pass");

  const current = output(await harness.client.callTool({ name: "plasticity_fastener_group_plate_bearing_report", arguments: { reportId: report.id, current: report.input } }));
  assert.equal(current.freshness, "current");
  liveHeightMm = 40.02;
  const mismatch = await harness.client.callTool({ name: "plasticity_verify_fastener_group_plate_bearing", arguments: input });
  assert.equal(mismatch.isError, true);
  liveHeightMm = 40;

  const processMismatchInput = structuredClone(input);
  processMismatchInput.physicalTest.process.materialId = "different-material-process";
  const processMismatch = await harness.client.callTool({ name: "plasticity_verify_fastener_group_plate_bearing", arguments: processMismatchInput });
  assert.equal(processMismatch.isError, true);

  const overloadedBenchmarkInput = structuredClone(input);
  overloadedBenchmarkInput.physicalTest.safetyFactor = 5;
  const overloadedBenchmark = output(await harness.client.callTool({ name: "plasticity_verify_fastener_group_plate_bearing", arguments: overloadedBenchmarkInput }));
  assert.equal(overloadedBenchmark.result.physicalTestComparison.outcome, "above-minimum-observed-failure-load");
  assert.ok(overloadedBenchmark.result.issues.some((issue: { code: string }) => issue.code === "PHYSICAL_GROUP_TEST_LOAD_EXCEEDED"));
  assert.notEqual(overloadedBenchmark.result.status, "pass");

  const conflictingRecordInput = structuredClone(testInput);
  conflictingRecordInput.outcomes[0]!.peakLoadN = 350;
  conflictingRecordInput.evidence.find((item) => item.id === "peak")!.value = 350;
  await harness.store.fastenerGroupTests.record(conflictingRecordInput);
  const ambiguous = await harness.client.callTool({ name: "plasticity_verify_fastener_group_plate_bearing", arguments: input });
  assert.equal(ambiguous.isError, true);
});

test("section scenario calculation strips a caller binding and stores a labelled report", async (context) => {
  const harness = await createHarness(context, {});
  const scenario = { ...sectionScenarioFixture(), binding: sectionBinding("r1") };
  const response = await harness.client.callTool({
    name: "plasticity_calculate_section_strength",
    arguments: scenario,
  });
  assert.equal(response.isError, undefined);
  const report = output(response);
  assert.equal(report.kind, "planar-section");
  assert.equal(report.input.binding, undefined);
  assert.equal(report.result.kind, "planar-section");
  assert.match(report.result.checkedScope, /scenario/i);

  const strict = await harness.client.callTool({
    name: "plasticity_calculate_section_strength",
    arguments: { ...scenario, extra: true },
  });
  assert.equal(strict.isError, true);
});

test("section inspection returns exact native evidence through the public tool", async (context) => {
  const expected = verifiedSectionEvidence("r1");
  const harness = await createHarness(context, {
    inspectSection: async () => expected,
  });
  const response = await harness.client.callTool({
    name: "plasticity_inspect_planar_section",
    arguments: { bodyId: 7, faceId: "face-1", revision: "r1", xDirection: [1, 0, 0] },
  });
  assert.equal(response.isError, undefined);
  assert.deepEqual(output(response), expected);

  const strict = await harness.client.callTool({
    name: "plasticity_inspect_planar_section",
    arguments: { bodyId: 7, faceId: "face-1", revision: "r1", xDirection: [1, 0, 0], script: "forbidden" },
  });
  assert.equal(strict.isError, true);
});

test("arbitrary-plane inspection returns exact native evidence through a strict public tool", async (context) => {
  const expected = verifiedArbitrarySectionEvidence("r1");
  const harness = await createHarness(context, {
    inspectArbitrarySection: async () => expected,
  });
  const input = {
    bodyId: 7,
    revision: "r1",
    plane: { originMm: [0, 0, 2.5], normal: [0, 0, 1], xDirection: [1, 0, 0] },
  };
  const response = await harness.client.callTool({ name: "plasticity_inspect_arbitrary_section", arguments: input });
  assert.equal(response.isError, undefined);
  assert.deepEqual(output(response), expected);

  const strict = await harness.client.callTool({
    name: "plasticity_inspect_arbitrary_section",
    arguments: { ...input, script: "forbidden" },
  });
  assert.equal(strict.isError, true);
});

test("batch arbitrary-plane inspection preserves candidate order and one live CAD revision", async (context) => {
  const planes = [
    { originMm: [0, 0, 2.5], normal: [0, 0, 1], xDirection: [1, 0, 0] },
    { originMm: [10, 0, 0], normal: [1, 0, 0], xDirection: [0, 1, 0] },
  ] as const;
  const inspected: unknown[] = [];
  const evidence = verifiedArbitrarySectionEvidence("r1");
  const harness = await createHarness(context, {
    inspectArbitrarySection: async (request) => {
      inspected.push(request.plane);
      return { ...evidence, binding: { ...evidence.binding, plane: request.plane } };
    },
  });
  const response = await harness.client.callTool({
    name: "plasticity_inspect_arbitrary_sections",
    arguments: { bodyId: 7, revision: "r1", planes },
  });
  assert.equal(response.isError, undefined);
  const result = output(response);
  assert.equal(result.status, "complete");
  assert.deepEqual(inspected, planes);
  assert.deepEqual(result.sections.map((section: any) => section.binding.plane), planes);
  assert.deepEqual(result.sections.map((section: any) => section.status), ["verified", "verified"]);

  const invalid = await harness.client.callTool({
    name: "plasticity_inspect_arbitrary_sections",
    arguments: { bodyId: 7, revision: "r1", planes: Array(33).fill(planes[0]) },
  });
  assert.equal(invalid.isError, true);
});

test("batch arbitrary-plane inspection rejects a revision change during candidate sampling", async (context) => {
  let stateReads = 0;
  const evidence = verifiedArbitrarySectionEvidence("r1");
  const harness = await createHarness(context, {
    readCadBinding: async () => {
      stateReads += 1;
      return binding(stateReads < 2 ? "r1" : "r2");
    },
    inspectArbitrarySection: async (request) => ({
      ...evidence,
      binding: { ...evidence.binding, revision: request.revision, plane: request.plane },
    }),
  });
  const response = await harness.client.callTool({
    name: "plasticity_inspect_arbitrary_sections",
    arguments: {
      bodyId: 7,
      revision: "r1",
      planes: [
        { originMm: [0, 0, 2.5], normal: [0, 0, 1], xDirection: [1, 0, 0] },
        { originMm: [10, 0, 0], normal: [1, 0, 0], xDirection: [0, 1, 0] },
      ],
    },
  });
  assert.equal(response.isError, true);
  assert.match(JSON.stringify(response.content), /revision|changed|stale/i);
});

test("arbitrary-section scan evenly spaces exact stations along the normalized section normal", async (context) => {
  const origins: number[][] = [];
  const evidence = verifiedArbitrarySectionEvidence("r1");
  const harness = await createHarness(context, {
    inspectArbitrarySection: async (request) => {
      origins.push(request.plane.originMm);
      return {
        ...evidence,
        binding: { ...evidence.binding, plane: request.plane },
      };
    },
  });
  const input = {
    bodyId: 7,
    revision: "r1",
    startPlane: { originMm: [2, 3, 4], normal: [0, 0, 2], xDirection: [1, 0, 0] },
    fromOffsetMm: -4,
    toOffsetMm: 8,
    stationCount: 4,
  };
  const response = await harness.client.callTool({ name: "plasticity_scan_arbitrary_sections", arguments: input });
  assert.equal(response.isError, undefined);
  const result = output(response);
  assert.deepEqual(origins, [[2, 3, 0], [2, 3, 4], [2, 3, 8], [2, 3, 12]]);
  assert.equal(result.scan.spacingMm, 4);
  assert.equal(result.scan.stationCount, 4);
  assert.equal(result.sections.length, 4);

  const invalid = await harness.client.callTool({
    name: "plasticity_scan_arbitrary_sections",
    arguments: { ...input, toOffsetMm: -4 },
  });
  assert.equal(invalid.isError, true);
  const overflow = await harness.client.callTool({
    name: "plasticity_scan_arbitrary_sections",
    arguments: { ...input, fromOffsetMm: -Number.MAX_VALUE, toOffsetMm: Number.MAX_VALUE },
  });
  assert.equal(overflow.isError, true);
});

test("section-strength station scan ranks measured utilization only when every section is supported", async (context) => {
  const scenario = sectionScenarioFixture();
  const { kind: _kind, frame: _frame, loops: _loops, properties: _properties, binding: _binding, ...parameters } = scenario;
  let inspected = 0;
  let currentRevision = "r1";
  const verified = verifiedArbitrarySectionEvidence("r1");
  const harness = await createHarness(context, {
    readCadBinding: async () => binding(currentRevision),
    inspectArbitrarySection: async (request) => {
      inspected += 1;
      if (inspected === 2) {
        return {
          status: "unsupported",
          binding: { ...verified.binding, plane: request.plane },
          source: "native-brep-temporary-section",
          reasons: ["no-section"],
        };
      }
      return { ...verified, binding: { ...verified.binding, plane: request.plane } };
    },
  });
  const response = await harness.client.callTool({
    name: "plasticity_scan_section_strength",
    arguments: {
      bodyId: 7,
      revision: "r1",
      startPlane: { originMm: [0, 0, 0], normal: [0, 0, 1], xDirection: [1, 0, 0] },
      fromOffsetMm: 1,
      toOffsetMm: 3,
      stationCount: 2,
      scenario: parameters,
    },
  });
  assert.equal(response.isError, undefined);
  const result = output(response);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0].calculation.status, "pass");
  assert.equal(result.candidates[1].calculation, undefined);
  assert.equal(result.ranking.status, "incomplete");
  assert.equal(result.ranking.governingStationIndex, undefined);
  assert.deepEqual(result.ranking.excludedStationIndices, [1]);
  assert.ok(result.scanReportId);
  const current = output(await harness.client.callTool({
    name: "plasticity_section_strength_scan_report",
    arguments: { scanReportId: result.scanReportId },
  }));
  assert.equal(current.freshness, "current");
  assert.equal(current.report.candidates.length, 2);
  assert.ok(current.report.candidates[0].input);
  assert.ok(current.report.candidates[0].calculation);
  assert.deepEqual(current.report.candidates[1].reasons, ["no-section"]);
  currentRevision = "r2";
  const stale = output(await harness.client.callTool({
    name: "plasticity_section_strength_scan_report",
    arguments: { scanReportId: result.scanReportId },
  }));
  assert.equal(stale.freshness, "stale");
  assert.ok(stale.reasons.includes("CAD_REVISION_CHANGED"));
});

test("section-strength station scan reports the highest supported nominal utilization", async (context) => {
  const scenario = sectionScenarioFixture();
  const { kind: _kind, frame: _frame, loops: _loops, properties: _properties, binding: _binding, ...parameters } = scenario;
  const harness = await createHarness(context, {
    inspectArbitrarySection: async (request) => {
      const widthMm = request.plane.originMm[2] === 1 ? 10 : 20;
      const frame = structuredClone(request.plane);
      const loops = [rectangleLoop(-widthMm / 2, -2, widthMm, 4)];
      const properties = {
        ...integrateSection(loops),
        centroidMm: frame.originMm,
        source: "native-brep-temporary-section" as const,
      };
      const base = verifiedArbitrarySectionEvidence(request.revision);
      return {
        ...base,
        binding: { ...base.binding, plane: request.plane, topologySignature: properties.topologySignature },
        frame,
        loops,
        properties,
      };
    },
  });
  const response = await harness.client.callTool({
    name: "plasticity_scan_section_strength",
    arguments: {
      bodyId: 7,
      revision: "r1",
      startPlane: { originMm: [0, 0, 0], normal: [0, 0, 1], xDirection: [1, 0, 0] },
      fromOffsetMm: 1,
      toOffsetMm: 3,
      stationCount: 2,
      scenario: parameters,
    },
  });
  assert.equal(response.isError, undefined);
  const result = output(response);
  assert.equal(result.ranking.status, "complete");
  assert.equal(result.ranking.governingStationIndex, 0);
  assert.equal(result.candidates[0].governingComponent, "tension");
  assert.ok(result.candidates[0].maximumSingleModeUtilization > result.candidates[1].maximumSingleModeUtilization);
});

test("section verification replaces caller geometry with measured evidence and stores a bound report", async (context) => {
  const measured = verifiedSectionEvidence("r1");
  const harness = await createHarness(context, { inspectSection: async () => measured });
  const caller = sectionScenarioFixture();
  caller.properties = { ...caller.properties, areaMm2: caller.properties.areaMm2 + 1 };
  const callerAreaEvidence = caller.evidence.find((item) => item.id === caller.assignments["properties.areaMm2"]);
  assert.ok(callerAreaEvidence);
  callerAreaEvidence.value = caller.properties.areaMm2;
  caller.frame = { originMm: [99, 99, 99], normal: [0, 1, 0], xDirection: [1, 0, 0] };
  caller.binding = sectionBinding("r1");

  const response = await harness.client.callTool({
    name: "plasticity_verify_section_strength",
    arguments: { ...caller },
  });
  assert.equal(response.isError, undefined);
  const report = output(response);
  assert.equal(report.input.properties.areaMm2, measured.properties!.areaMm2);
  assert.deepEqual(report.input.frame, measured.frame);
  assert.deepEqual(report.input.loops, measured.loops);
  assert.deepEqual(report.input.binding, measured.binding);
  for (const path of [
    "properties.areaMm2",
    "properties.centroidLocalMm.x",
    "properties.centroidLocalMm.y",
    "properties.ixxMm4",
    "properties.iyyMm4",
    "properties.ixyMm4",
  ]) {
    const evidenceId = report.input.assignments[path];
    const evidence = report.input.evidence.find((item: { id: string }) => item.id === evidenceId);
    assert.equal(evidence.status, "measured");
    assert.match(evidence.sourceLocator, /face=face-1/);
  }
});

test("section verification accepts an exact arbitrary-plane binding and refreshes it for report reads", async (context) => {
  const measured = verifiedArbitrarySectionEvidence("r1");
  let live = structuredClone(measured);
  const harness = await createHarness(context, { inspectArbitrarySection: async () => live });
  const input = { ...sectionScenarioFixture(), binding: structuredClone(measured.binding) };
  const report = output(await harness.client.callTool({
    name: "plasticity_verify_section_strength",
    arguments: input,
  }));
  assert.deepEqual(report.input.binding, measured.binding);
  assert.deepEqual(report.input.frame, measured.frame);
  assert.deepEqual(report.input.loops, measured.loops);
  const evidenceId = report.input.assignments["properties.areaMm2"];
  const evidence = report.input.evidence.find((item: { id: string }) => item.id === evidenceId);
  assert.equal(evidence.status, "measured");
  assert.match(evidence.sourceLocator, new RegExp(`section=${measured.binding.topologySignature}`));

  const current = output(await harness.client.callTool({
    name: "plasticity_strength_report",
    arguments: { reportId: report.id, current: report.input },
  }));
  assert.equal(current.freshness, "current");

  live = { ...live, binding: { ...live.binding, topologySignature: "changed-section" } };
  const stale = output(await harness.client.callTool({
    name: "plasticity_strength_report",
    arguments: { reportId: report.id, current: report.input },
  }));
  assert.equal(stale.freshness, "stale");
  assert.ok(stale.reasons.includes("CAD_TOPOLOGY_CHANGED"));
});

test("arbitrary-plane section verification rejects malformed bindings and detects a pre-store edit", async (context) => {
  const measured = verifiedArbitrarySectionEvidence("r1");
  const invalidHarness = await createHarness(context, { inspectArbitrarySection: async () => measured });
  const input = { ...sectionScenarioFixture(), binding: structuredClone(measured.binding) };
  const { plane: _plane, ...withoutPlane } = input.binding;
  const missing = await invalidHarness.client.callTool({
    name: "plasticity_verify_section_strength",
    arguments: { ...input, binding: withoutPlane },
  });
  assert.equal(missing.isError, true);
  const ambiguous = await invalidHarness.client.callTool({
    name: "plasticity_verify_section_strength",
    arguments: { ...input, binding: { ...input.binding, faceId: "face-1" } },
  });
  assert.equal(ambiguous.isError, true);
  assert.deepEqual(await reportFiles(invalidHarness.root), []);

  let reads = 0;
  const staleHarness = await createHarness(context, {
    inspectArbitrarySection: async () => {
      reads += 1;
      return reads === 1 ? measured : { ...measured, binding: { ...measured.binding, topologySignature: "changed-before-save" } };
    },
  });
  const stale = await staleHarness.client.callTool({
    name: "plasticity_verify_section_strength",
    arguments: input,
  });
  assert.equal(stale.isError, true);
  assert.match(JSON.stringify(stale.content), /changed|stale/i);
  assert.deepEqual(await reportFiles(staleHarness.root), []);
});

test("section verification rejects unsupported topology and a stale-before-store race", async (context) => {
  const unsupportedHarness = await createHarness(context, {
    inspectSection: async (request) => ({
      status: "unsupported",
      binding: { ...sectionBinding(request.revision), bodyId: request.bodyId, faceId: request.faceId },
      source: "native-brep-boundary",
      reasons: ["unsupported-curve:spline"],
    }),
  });
  const input = { ...sectionScenarioFixture(), binding: sectionBinding("r1") };
  const unsupported = await unsupportedHarness.client.callTool({
    name: "plasticity_verify_section_strength",
    arguments: input,
  });
  assert.equal(unsupported.isError, true);
  assert.match(JSON.stringify(unsupported.content), /unsupported-curve:spline/);
  assert.deepEqual(await reportFiles(unsupportedHarness.root), []);

  const staleHarness = await createHarness(context, {
    inspectSection: async () => verifiedSectionEvidence("r1"),
    readSectionBinding: async () => sectionBinding("r2"),
  });
  const stale = await staleHarness.client.callTool({
    name: "plasticity_verify_section_strength",
    arguments: input,
  });
  assert.equal(stale.isError, true);
  assert.match(JSON.stringify(stale.content), /changed|stale/i);
  assert.deepEqual(await reportFiles(staleHarness.root), []);
});

test("section report freshness re-reads the face topology signature", async (context) => {
  let live = sectionBinding("r1");
  const harness = await createHarness(context, {
    inspectSection: async () => verifiedSectionEvidence("r1"),
    readSectionBinding: async () => live,
  });
  const input = { ...sectionScenarioFixture(), binding: sectionBinding("r1") };
  const report = output(await harness.client.callTool({
    name: "plasticity_verify_section_strength",
    arguments: input,
  }));
  const current = output(await harness.client.callTool({
    name: "plasticity_strength_report",
    arguments: { reportId: report.id, current: report.input },
  }));
  assert.equal(current.freshness, "current");

  live = { ...live, topologySignature: "changed-signature" };
  const stale = output(await harness.client.callTool({
    name: "plasticity_strength_report",
    arguments: { reportId: report.id, current: report.input },
  }));
  assert.equal(stale.freshness, "stale");
  assert.ok(stale.reasons.includes("CAD_TOPOLOGY_CHANGED"));
});

test("section tools fail clearly when no CAD session is connected", async (context) => {
  const harness = await createHarness(context, {
    inspectSection: async () => { throw new Error("Connect to an explicit Plasticity window first"); },
  });
  const response = await harness.client.callTool({
    name: "plasticity_inspect_planar_section",
    arguments: { bodyId: 7, faceId: "face-1", revision: "r1", xDirection: [1, 0, 0] },
  });
  assert.equal(response.isError, true);
  assert.match(JSON.stringify(response.content), /connect.*Plasticity window/i);
});

test("section tool responses are bounded", async (context) => {
  const harness = await createHarness(context, {
    inspectSection: async (request) => ({
      status: "unsupported",
      binding: { ...sectionBinding(request.revision), bodyId: request.bodyId, faceId: request.faceId },
      source: "native-brep-boundary",
      reasons: ["x".repeat(1024 * 1024)],
    }),
  });
  const response = await harness.client.callTool({
    name: "plasticity_inspect_planar_section",
    arguments: { bodyId: 7, faceId: "face-1", revision: "r1", xDirection: [1, 0, 0] },
  });
  assert.equal(response.isError, true);
  assert.match(JSON.stringify(response.content), /exceeds 1 MiB/i);
});

test("static FEA is an explicit solver result, persists it, and marks CAD edits stale", async (context) => {
  let live = binding("r1");
  let analysisCalls = 0;
  const harness = await createHarness(context, {
    readCadBinding: async () => live,
    analyzeStaticFem: async (input, workspace) => {
      analysisCalls += 1;
      return femReportContent(input, workspace);
    },
  });
  const couponInput = materialCouponQualificationInput();
  const couponResponse = output(await harness.client.callTool({
    name: "plasticity_record_material_coupon_data",
    arguments: couponInput,
  }));
  const coupon = couponResponse.record;
  const baseArguments = {
    bodyId: 7,
    revision: "r1",
    supportFaceIds: ["support-face", "support-face-2"],
    faceLoads: [
      { faceId: "load-face", tractionNPerMm2: [100, 0, 0] },
      { faceId: "load-face-2", tractionNPerMm2: [0, 50, 0] },
    ],
    resultantLoads: [{ faceId: "load-face", forceN: [0, 100, 0], applicationPointMm: [10, 2.5, 2], momentNmm: [0, 0, 50] }],
    meshSizeMm: 1,
    poissonRatio: 0.3,
    poissonRatioEvidence: testPoissonRatioEvidence(),
    materialCoupon: { recordId: coupon.id, process: couponInput.process },
    factoredVonMisesAllowableMPa: 80,
    factoredVonMisesAllowableEvidence: {
      id: "factored-allowable-fixture",
      label: "Factored von Mises design allowable",
      status: "sourced" as const,
      unit: "MPa" as const,
      value: 80,
      sourceUrl: "https://example.org/factored-allowable",
      sourceHash: "d".repeat(64),
      sourceLocator: "Table 1, process-specific factored von Mises allowable",
      dependsOn: [],
    },
    factoredVonMisesAllowableBasis: "Published factored design allowable for this exact process; the selected safety factors are already included.",
  };
  const mismatchedModulus = await harness.client.callTool({
    name: "plasticity_analyze_static_fem",
    arguments: { ...baseArguments, youngsModulusMPa: 2000 },
  });
  assert.equal(mismatchedModulus.isError, true);
  assert.match(JSON.stringify(mismatchedModulus.content), /does not equal the selected physical coupon record/i);
  assert.equal(analysisCalls, 0);
  const mismatchedProcess = await harness.client.callTool({
    name: "plasticity_analyze_static_fem",
    arguments: {
      ...baseArguments,
      youngsModulusMPa: coupon.properties.youngModulusMPa,
      materialCoupon: { ...baseArguments.materialCoupon, process: { ...couponInput.process, orientationDeg: [90, 0, 0] } },
    },
  });
  assert.equal(mismatchedProcess.isError, true);
  assert.match(JSON.stringify(mismatchedProcess.content), /unique exact-process match/i);
  assert.equal(analysisCalls, 0);

  const rawReport = await harness.client.callTool({
    name: "plasticity_analyze_static_fem",
    arguments: { ...baseArguments, youngsModulusMPa: coupon.properties.youngModulusMPa },
  });
  assert.notEqual(rawReport.isError, true, JSON.stringify(rawReport.content));
  const report = output(rawReport);
  assert.equal(report.kind, "static-fem-linear-elastic");
  assert.equal(report.mesh.surfaceLoads.length, 2);
  assert.deepEqual(report.mesh.totalResultantN, [2000, 1100, 0]);
  assert.deepEqual(report.mesh.totalResultantMomentNmm, [-2200, 4000, 7050]);
  assert.equal(report.calculation.maximumVonMisesMPa, 100);
  assert.deepEqual(report.calculation.maximumVonMisesLocation, { elementId: 1, integrationPoint: 1, centroidMm: [5, 2.5, 2] });
  assert.deepEqual(report.input.materialCoupon, baseArguments.materialCoupon);
  assert.equal(report.input.youngsModulusMPa, coupon.properties.youngModulusMPa);
  assert.equal(report.interpretation, "linear-static-solver-result-only");
  assert.equal(report.strengthPass, false);
  assert.equal(report.printApproved, false);
  assert.equal(report.stressAllowableScreen.overallStatus, "at-least-one-sampled-peak-above-allowable");
  assert.equal(report.stressAllowableScreen.cases[0].samples[0].utilization, 1.25);
  assert.equal(report.stressAllowableScreen.interpretation, "diagnostic-only-no-strength-pass");

  const persistedPath = join(harness.root, "fem-reports", `${report.id}.json`);
  const persisted = JSON.parse(await readFile(persistedPath, "utf8")) as { input: Record<string, unknown> };
  delete persisted.input.youngsModulusEvidence;
  delete persisted.input.poissonRatioEvidence;
  await writeFile(persistedPath, JSON.stringify(persisted));

  const current = output(await harness.client.callTool({
    name: "plasticity_static_fem_report",
    arguments: { reportId: report.id },
  }));
  assert.equal(current.freshness.status, "current");
  assert.equal(current.input.poissonRatioEvidence, undefined, "legacy report without material evidence should remain readable");
  assert.equal(current.stressAllowableScreen.cases[0].samples[0].status, "above-allowable", "persisted reports should reproduce the exact-allowable screen");

  const conflictingCoupon = materialCouponQualificationInput();
  conflictingCoupon.properties.tensileStrengthMPa = conflictingCoupon.properties.tensileStrengthMPa! + 1;
  conflictingCoupon.evidence.find((item) => item.id === "tensile-strength")!.value = conflictingCoupon.properties.tensileStrengthMPa;
  conflictingCoupon.testedAt = "2026-09-24T10:00:00.000Z";
  await harness.store.materialQualifications.record(conflictingCoupon);
  const staleCoupon = output(await harness.client.callTool({
    name: "plasticity_static_fem_report",
    arguments: { reportId: report.id },
  }));
  assert.equal(staleCoupon.freshness.status, "stale");
  assert.match(staleCoupon.freshness.reason, /coupon.*ambiguous|ambiguous.*coupon/i);

  live = { ...live, revision: "r2" };
  const stale = output(await harness.client.callTool({
    name: "plasticity_static_fem_report",
    arguments: { reportId: report.id },
  }));
  assert.equal(stale.freshness.status, "stale");
  assert.match(stale.freshness.reason, /CAD.*changed/i);
  assert.match(stale.freshness.reason, /coupon.*ambiguous|ambiguous.*coupon/i);
});

test("static FEA refuses a physical coupon when exact-process records conflict", async (context) => {
  let analysisCalls = 0;
  const harness = await createHarness(context, {
    analyzeStaticFem: async (input, workspace) => {
      analysisCalls += 1;
      return femReportContent(input, workspace);
    },
  });
  const firstInput = materialCouponQualificationInput();
  const first = output(await harness.client.callTool({ name: "plasticity_record_material_coupon_data", arguments: firstInput })).record;
  const secondInput = materialCouponQualificationInput();
  secondInput.properties.tensileStrengthMPa = secondInput.properties.tensileStrengthMPa! + 1;
  secondInput.evidence.find((item) => item.id === "tensile-strength")!.value = secondInput.properties.tensileStrengthMPa;
  secondInput.testedAt = "2026-09-24T10:00:00.000Z";
  await harness.client.callTool({ name: "plasticity_record_material_coupon_data", arguments: secondInput });

  const response = await harness.client.callTool({
    name: "plasticity_analyze_static_fem",
    arguments: {
      bodyId: 7,
      revision: "r1",
      supportFaceIds: ["support-face"],
      faceLoads: [{ faceId: "load-face", tractionNPerMm2: [100, 0, 0] }],
      resultantLoads: [],
      meshSizeMm: 1,
      youngsModulusMPa: first.properties.youngModulusMPa,
      poissonRatio: 0.3,
      poissonRatioEvidence: testPoissonRatioEvidence(),
      materialCoupon: { recordId: first.id, process: firstInput.process },
    },
  });
  assert.equal(response.isError, true);
  assert.match(JSON.stringify(response.content), /unique exact-process match/i);
  assert.equal(analysisCalls, 0);
});

test("static FEA refuses to persist a solver result after a concurrent CAD revision change", async (context) => {
  let live = binding("r1");
  const harness = await createHarness(context, {
    readCadBinding: async () => live,
    analyzeStaticFem: async (input, workspace) => {
      const content = femReportContent(input, workspace);
      live = { ...live, revision: "r2" };
      return content;
    },
  });
  const response = await harness.client.callTool({
    name: "plasticity_analyze_static_fem",
    arguments: {
      bodyId: 7,
      revision: "r1",
      supportFaceIds: ["support-face", "support-face-2"],
      faceLoads: [{ faceId: "load-face", tractionNPerMm2: [100, 0, 0] }],
      resultantLoads: [],
      meshSizeMm: 1,
      youngsModulusMPa: 2000,
      youngsModulusEvidence: testYoungsModulusEvidence(),
      poissonRatio: 0.3,
      poissonRatioEvidence: testPoissonRatioEvidence(),
    },
  });
  assert.equal((response as { isError?: boolean }).isError, true);
  assert.match(JSON.stringify(response), /CAD changed before the FEA report could be saved/);
  assert.deepEqual(await readdir(join(harness.root, "fem-reports")), ["jobs"]);
});

test("static FEA rejects duplicate support faces before starting an analysis", async (context) => {
  let analysisStarted = false;
  const harness = await createHarness(context, {
    analyzeStaticFem: async (input, workspace) => {
      analysisStarted = true;
      return femReportContent(input, workspace);
    },
  });
  const response = await harness.client.callTool({
    name: "plasticity_analyze_static_fem",
    arguments: {
      bodyId: 7,
      revision: "r1",
      supportFaceIds: ["support-face", "support-face"],
      faceLoads: [{ faceId: "load-face", tractionNPerMm2: [100, 0, 0] }],
      resultantLoads: [],
      meshSizeMm: 1,
      youngsModulusMPa: 2000,
      youngsModulusEvidence: testYoungsModulusEvidence(),
      poissonRatio: 0.3,
      poissonRatioEvidence: testPoissonRatioEvidence(),
    },
  });
  assert.equal(response.isError, true);
  assert.equal(analysisStarted, false);
  assert.match(JSON.stringify(response.content), /unique/i);
});

test("strength MCP is bounded and has no Workbench or HTTP service dependency", async () => {
  const source = await readFile(new URL("./mcp.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from\s+["'][^"']*workbench|\bexpress\b|node:http|https?:\/\//i);
  assert.ok(source.length < 80_000);
});

async function createHarness(
  context: test.TestContext,
  overrides: Partial<StrengthDependencies> & { unavailableReason?: string },
): Promise<{ client: Client; store: StrengthStore; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "plasticity-strength-mcp-"));
  const store = new StrengthStore(root);
  const femReports = new FemReportStore(root);
  const cohesiveReports = new CohesiveReportStore(root);
  const server = new McpServer({ name: "strength-test", version: "1" });
  const deps: StrengthDependencies = {
    store,
    femReports,
    cohesiveReports,
    analysis: overrides.analysis ?? null,
    ...(overrides.unavailableReason === undefined ? {} : { analysisUnavailableReason: overrides.unavailableReason }),
    referenceSearch: overrides.referenceSearch ?? null,
    ...(overrides.referenceSearchUnavailableReason === undefined ? {} : { referenceSearchUnavailableReason: overrides.referenceSearchUnavailableReason }),
    async inspectMember(request) {
      if (overrides.inspectMember) return await overrides.inspectMember(request);
      return {
        binding: binding(request.revision),
        status: "verified",
        dimensions: { lengthMm: 80, widthMm: 20, heightMm: 10 },
        source: "native-brep",
        reasons: [],
      };
    },
    async inspectIntegralPlate(request) {
      if (overrides.inspectIntegralPlate) return await overrides.inspectIntegralPlate(request);
      return {
        status: "unsupported",
        binding: binding(request.revision),
        faces: { frontFaceId: request.frontFaceId, backFaceId: request.backFaceId },
        source: "native-brep-opposed-rectangular-faces",
        reasons: ["test-integral-plate-unavailable"],
      };
    },
    async readCadBinding(bodyId) {
      if (overrides.readCadBinding) return await overrides.readCadBinding(bodyId);
      return binding("r1");
    },
    async inspectSection(request) {
      if (overrides.inspectSection) return await overrides.inspectSection(request);
      return {
        status: "unsupported",
        binding: sectionBinding(request.revision),
        source: "native-brep-boundary",
        reasons: ["test-section-unavailable"],
      };
    },
    async inspectArbitrarySection(request) {
      if (overrides.inspectArbitrarySection) return await overrides.inspectArbitrarySection(request);
      return {
        status: "unsupported",
        binding: {
          sessionId: "session-1",
          documentToken: "doc-1",
          revision: request.revision,
          bodyId: request.bodyId,
          plane: request.plane,
          topologySignature: "unavailable",
        },
        source: "native-brep-temporary-section",
        reasons: ["test-section-unavailable"],
      };
    },
    async inspectFastenerPlate(request) {
      if (overrides.inspectFastenerPlate) return await overrides.inspectFastenerPlate(request);
      return {
        status: "unsupported",
        binding: {
          sessionId: "session-1",
          documentToken: "doc-1",
          revision: request.revision,
          bodyId: request.bodyId,
          frontFaceId: request.frontFaceId,
          backFaceId: request.backFaceId,
          loadDirection: request.loadDirection,
          topologySignature: "unavailable",
        },
        source: "native-brep-opposed-faces",
        reasons: ["test-fastener-unavailable"],
      };
    },
    async readSectionBinding(request) {
      if (overrides.readSectionBinding) return await overrides.readSectionBinding(request);
      return { ...sectionBinding("r1"), bodyId: request.bodyId, faceId: request.faceId };
    },
    async readFastenerBinding(request) {
      if (overrides.readFastenerBinding) return await overrides.readFastenerBinding(request);
      return {
        sessionId: "session-1",
        documentToken: "doc-1",
        revision: "r1",
        bodyId: request.bodyId,
        frontFaceId: request.frontFaceId,
        backFaceId: request.backFaceId,
        loadDirection: request.loadDirection,
        topologySignature: "fastener-signature",
      };
    },
    async inspectFastenerGroup(request) {
      if (overrides.inspectFastenerGroup) return await overrides.inspectFastenerGroup(request);
      return {
        status: "unsupported",
        binding: { ...fastenerGroupBinding(request.revision), bodyId: request.bodyId, cylindricalFaceIds: request.cylindricalFaceIds },
        source: "native-brep-cylindrical-faces",
        reasons: ["test-fastener-group-unavailable"],
      };
    },
    async inspectFastenerGroupLayout(request) {
      if (overrides.inspectFastenerGroupLayout) return await overrides.inspectFastenerGroupLayout(request);
      return {
        status: "unsupported",
        binding: {
          ...fastenerGroupBinding(request.revision),
          bodyId: request.bodyId,
          boundaryFaceId: request.boundaryFaceId,
          ...(request.opposedFaceId === undefined ? {} : { opposedFaceId: request.opposedFaceId }),
          groupTopologySignature: "test-group-topology-signature",
        },
        measurementSource: "native-brep-boundary-and-cylindrical-faces",
        reasons: ["test-fastener-group-layout-unavailable"],
      };
    },
    async readFastenerGroupBinding(request) {
      if (overrides.readFastenerGroupBinding) return await overrides.readFastenerGroupBinding(request);
      return { ...fastenerGroupBinding("r1"), bodyId: request.bodyId, cylindricalFaceIds: request.cylindricalFaceIds };
    },
    async analyzeStaticFem(input, workspace, signal) {
      if (overrides.analyzeStaticFem) return await overrides.analyzeStaticFem(input, workspace, signal);
      throw new Error("FEA test adapter is not configured");
    },
    async analyzeCohesive(input, workspace, signal) {
      if (overrides.analyzeCohesive) return await overrides.analyzeCohesive(input, workspace, signal);
      throw new Error("Cohesive FEA test adapter is not configured");
    },
  };
  registerStrengthTools(server, deps);
  const client = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  return { client, store, root };
}

function binding(revision: string): CadBinding {
  return { sessionId: "session-1", documentToken: "doc-1", revision, bodyId: 7 };
}

function rectangularSectionEvidence(
  bodyId: number,
  revision: string,
  plane: { originMm: [number, number, number]; normal: [number, number, number]; xDirection: [number, number, number] },
  widthMm: number,
  thicknessMm: number,
): ArbitrarySectionEvidence {
  const loops = [{ segments: [
    { kind: "line" as const, start: [0, 0] as [number, number], end: [widthMm, 0] as [number, number] },
    { kind: "line" as const, start: [widthMm, 0] as [number, number], end: [widthMm, thicknessMm] as [number, number] },
    { kind: "line" as const, start: [widthMm, thicknessMm] as [number, number], end: [0, thicknessMm] as [number, number] },
    { kind: "line" as const, start: [0, thicknessMm] as [number, number], end: [0, 0] as [number, number] },
  ] }];
  const local = integrateSection(loops);
  return {
    status: "verified",
    binding: { ...binding(revision), bodyId, plane, topologySignature: local.topologySignature },
    frame: plane,
    properties: {
      ...local,
      centroidMm: [local.centroidLocalMm[0], local.centroidLocalMm[1], 0],
      source: "native-brep-temporary-section",
    },
    loops,
    source: "native-brep-temporary-section",
    reasons: [],
  };
}

function femReportContent(input: FemStaticInput, workspace: string): FemReportContent {
  const loadedFaceIds = [...new Set([...input.faceLoads.map((load) => load.faceId), ...input.resultantLoads.map((load) => load.faceId)])];
  const surfaceLoads = input.faceLoads.map((load, index) => {
    const resultantN = load.tractionNPerMm2.map((component) => component * 20) as [number, number, number];
    const center: [number, number, number] = [10 + index, 2.5, 2];
    return {
      faceId: load.faceId,
      surfaceAreaMm2: 20,
      tractionNPerMm2: load.tractionNPerMm2,
      resultantN,
      resultantMomentNmm: [center[1] * resultantN[2] - center[2] * resultantN[1], center[2] * resultantN[0] - center[0] * resultantN[2], center[0] * resultantN[1] - center[1] * resultantN[0]] as [number, number, number],
      loadedNodeCount: 8,
    };
  });
  const resultantLoads = input.resultantLoads.map((load) => ({
    ...load,
    appliedMomentAtOriginNmm: [
      load.applicationPointMm[1] * load.forceN[2] - load.applicationPointMm[2] * load.forceN[1] + load.momentNmm[0],
      load.applicationPointMm[2] * load.forceN[0] - load.applicationPointMm[0] * load.forceN[2] + load.momentNmm[1],
      load.applicationPointMm[0] * load.forceN[1] - load.applicationPointMm[1] * load.forceN[0] + load.momentNmm[2],
    ] as [number, number, number],
  }));
  const totalResultantN = [0, 1, 2].map((axis) => surfaceLoads.reduce((sum, load) => sum + load.resultantN[axis]!, resultantLoads.reduce((total, load) => total + load.forceN[axis]!, 0))) as [number, number, number];
  const totalResultantMomentNmm = [0, 1, 2].map((axis) => surfaceLoads.reduce((sum, load) => sum + load.resultantMomentNmm[axis]!, resultantLoads.reduce((total, load) => total + load.appliedMomentAtOriginNmm[axis]!, 0))) as [number, number, number];
  const firstLoadDirection = input.faceLoads[0]?.tractionNPerMm2
    ?? (input.resultantLoads[0]?.forceN.some((component) => component !== 0) ? input.resultantLoads[0].forceN : input.resultantLoads[0]?.momentNmm);
  const displacementObservationAxis = firstLoadDirection
    ? ([0, 1, 2] as const).reduce((bestAxis, axis) => Math.abs(firstLoadDirection[axis]!) > Math.abs(firstLoadDirection[bestAxis]!) ? axis : bestAxis, 0) + 1 as 1 | 2 | 3
    : 1;
  return {
    kind: "static-fem-linear-elastic",
    binding: binding(input.revision),
    input,
    bodyName: "Test solid",
    boundsMm: { min: [0, 0, 0], max: [10, 5, 4] },
    gmshVersion: "4.15.2",
    faceMappings: [
      ...input.supportFaceIds.map((faceId, index) => ({ faceId, surfaceEntityTag: index + 1, surfaceType: "Plane" as const, centerMm: [0, 2.5, 2] as [number, number, number], normal: [-1, 0, 0] as [number, number, number], boundsMm: { min: [0, 0, 0] as [number, number, number], max: [0, 5, 4] as [number, number, number] }, areaMm2: 20, maxSignatureErrorMm: 0, normalDot: 1 })),
      ...loadedFaceIds.map((faceId, index) => ({ faceId, surfaceEntityTag: input.supportFaceIds.length + index + 1, surfaceType: "Plane" as const, centerMm: [10 + index, 2.5, 2] as [number, number, number], normal: [1, 0, 0] as [number, number, number], boundsMm: { min: [10 + index, 0, 0] as [number, number, number], max: [10 + index, 5, 4] as [number, number, number] }, areaMm2: 20, maxSignatureErrorMm: 0, normalDot: 1 })),
    ],
    supportFaceAreasMm2: input.supportFaceIds.map((faceId) => ({ faceId, areaMm2: 20 })),
    mesh: {
      meshFile: join(workspace, "mesh.inp"),
      meshSizeMm: input.meshSizeMm,
      elementFamily: "C3D4",
      nodeCount: 20,
      tetrahedronCount: 12,
      minimumScaledInverseConditionNumber: 0.3,
      boundsMm: { min: [0, 0, 0], max: [10, 5, 4] },
      nodeSets: [
        ...input.supportFaceIds.map((faceId, index) => ({ faceId, setName: `FACE_${index + 1}`, nodeCount: 8 })),
        ...loadedFaceIds.map((faceId, index) => ({ faceId, setName: `FACE_${input.supportFaceIds.length + index + 1}`, nodeCount: 8 })),
      ],
      sharedSurfaceNodeCount: 0,
      loadFile: join(workspace, "loads.inp"),
      surfaceLoads,
      resultantLoads,
      totalResultantN,
      totalResultantMomentNmm,
    },
    calculation: {
      solver: "CalculiX 2.20",
      elementFamily: "C3D4",
      stressCoordinateBasis: "orthotropicMaterial" in input && input.orthotropicMaterial ? "material-local" : "global",
      stressIntegrationPointCount: 12,
      ...(input.orthotropicMaterial?.tsaiWuCriterion ? {
        orthotropicTsaiWu: {
          maximumFailureIndex: 1.08,
          maximumFailureIndexLocation: { elementId: 1, integrationPoint: 1, centroidMm: [5, 2.5, 2] as [number, number, number] },
          minimumLoadFactorToIndexOne: 1 / Math.sqrt(1.08),
          minimumLoadFactorLocation: { elementId: 1, integrationPoint: 1, centroidMm: [5, 2.5, 2] as [number, number, number] },
        },
      } : {}),
      minimumSxxMPa: 100,
      maximumSxxMPa: 100,
      maximumVonMisesMPa: 100,
      maximumVonMisesLocation: { elementId: 1, integrationPoint: 1, centroidMm: [5, 2.5, 2] },
      prescribedDisplacementMm: null,
      displacementObservationNodeSetName: `FACE_${input.supportFaceIds.length + 1}`,
      displacementObservationAxis,
      maximumDisplacementOnSetMm: 0.5,
      supportReactionN: totalResultantN.map((component) => -component) as [number, number, number],
      supportReactionMomentNmm: totalResultantMomentNmm.map((component) => -component) as [number, number, number],
      forceEquilibriumResidualN: [0, 0, 0],
      momentEquilibriumResidualNmm: [0, 0, 0],
      jobName: "test-job",
      inputPath: join(workspace, "job.inp"),
      reportPath: join(workspace, "job.dat"),
    },
  };
}

function sectionBinding(revision: string) {
  return { ...binding(revision), faceId: "face-1", topologySignature: "section-signature" };
}

function fastenerBinding(revision: string) {
  return {
    ...binding(revision),
    frontFaceId: "front",
    backFaceId: "back",
    loadDirection: [1, 0, 0] as [number, number, number],
    topologySignature: "fastener-signature",
  };
}

function fastenerGroupBinding(revision: string) {
  return {
    ...binding(revision),
    cylindricalFaceIds: ["A", "B", "C", "D"],
    frame: {
      originMm: [0, 0, 0] as [number, number, number],
      normal: [0, 0, 1] as [number, number, number],
      xDirection: [1, 0, 0] as [number, number, number],
      yDirection: [0, 1, 0] as [number, number, number],
    },
    topologySignature: "fastener-group-signature",
  };
}

function verifiedFastenerGroupEvidence(revision: string): FastenerGroupGeometryEvidence {
  const fixture = fastenerGroupFixture();
  const binding = fastenerGroupBinding(revision);
  return {
    status: "verified",
    binding,
    frame: binding.frame,
    fasteners: fixture.fasteners.map((fastener) => ({
      ...fastener,
      faceId: fastener.id,
      centerMm: [fastener.xMm, fastener.yMm, 0],
      diameterMm: 6,
      axisDirection: [0, 0, 1],
    })),
    source: "native-brep-cylindrical-faces",
    reasons: [],
  };
}

function verifiedFastenerGroupLayoutEvidence(request: FastenerGroupLayoutRequest): FastenerGroupLayoutEvidence {
  const group = verifiedFastenerGroupEvidence(request.revision);
  const binding = group.binding;
  return {
    status: "verified",
    binding: {
      ...binding,
      boundaryFaceId: request.boundaryFaceId,
      ...(request.opposedFaceId === undefined ? {} : { opposedFaceId: request.opposedFaceId }),
      groupTopologySignature: binding.topologySignature,
      topologySignature: "layout-topology-signature",
    },
    measurementSource: request.opposedFaceId === undefined
      ? "native-brep-boundary-and-cylindrical-faces"
      : "native-brep-opposed-boundaries-and-cylindrical-faces",
    plate: {
      boundaryFaceId: request.boundaryFaceId,
      ...(request.opposedFaceId === undefined ? {} : { opposedFaceId: request.opposedFaceId }),
      frame: { ...request.frame, yDirection: [0, 1, 0] },
      boundsMm: { minX: -30, maxX: 30, minY: -20, maxY: 20 },
      sizeMm: { x: 60, y: 40 },
      ...(request.opposedFaceId === undefined ? {} : { thicknessMm: 8 }),
    },
    fasteners: group.fasteners!.map((fastener) => {
      const centerToEdgesMm = {
        minX: fastener.xMm + 30,
        maxX: 30 - fastener.xMm,
        minY: fastener.yMm + 20,
        maxY: 20 - fastener.yMm,
      };
      const holeEdgeClearancesMm = {
        minX: centerToEdgesMm.minX - fastener.diameterMm / 2,
        maxX: centerToEdgesMm.maxX - fastener.diameterMm / 2,
        minY: centerToEdgesMm.minY - fastener.diameterMm / 2,
        maxY: centerToEdgesMm.maxY - fastener.diameterMm / 2,
      };
      return {
        id: fastener.id,
        faceId: fastener.faceId,
        centerMm: fastener.centerMm,
        localCenterMm: { x: fastener.xMm, y: fastener.yMm },
        holeDiameterMm: fastener.diameterMm,
        centerToEdgesMm,
        holeEdgeClearancesMm,
        minimumCenterToEdgeMm: Math.min(...Object.values(centerToEdgesMm)),
        minimumHoleEdgeClearanceMm: Math.min(...Object.values(holeEdgeClearancesMm)),
      };
    }),
    pairs: [],
    envelopes: [],
    evaluation: { status: "measured", failures: [] },
    checkedScope: "Exact rectangular-face fastener layout only.",
    reasons: [],
  };
}

function verifiedFastenerEvidence(
  revision: string,
  geometry: Partial<ReturnType<typeof fastenerScenarioFixture>["geometry"]> = {},
): FastenerPlateEvidence {
  const fixture = fastenerScenarioFixture(geometry);
  return {
    status: "verified",
    binding: fastenerBinding(revision),
    geometry: fixture.geometry,
    loadDirection: [1, 0, 0],
    holeCenterMm: [10, 10, 1],
    source: "native-brep-opposed-faces",
    reasons: [],
  };
}

function verifiedSectionEvidence(revision: string): SectionEvidence {
  const scenario = sectionScenarioFixture();
  return {
    status: "verified",
    binding: sectionBinding(revision),
    frame: structuredClone(scenario.frame),
    properties: {
      ...structuredClone(scenario.properties),
      centroidMm: [0, 0, 0],
      source: "native-brep-boundary",
    },
    loops: structuredClone(scenario.loops),
    source: "native-brep-boundary",
    reasons: [],
  };
}

function verifiedArbitrarySectionEvidence(revision: string): ArbitrarySectionEvidence {
  const scenario = sectionScenarioFixture();
  const plane = structuredClone(scenario.frame);
  const topologySignature = scenario.properties.topologySignature;
  return {
    status: "verified",
    binding: {
      sessionId: "session-1",
      documentToken: "doc-1",
      revision,
      bodyId: 7,
      plane,
      topologySignature,
    },
    frame: plane,
    properties: {
      ...structuredClone(scenario.properties),
      centroidMm: [0, 0, 0],
      source: "native-brep-temporary-section",
      topologySignature,
    },
    loops: structuredClone(scenario.loops),
    source: "native-brep-temporary-section",
    reasons: [],
  };
}

function output(response: unknown): any {
  if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) {
    throw new Error("Expected MCP tool content");
  }
  const item = response.content[0] as { type?: string; text?: string } | undefined;
  assert.equal(item?.type, "text");
  assert.ok(item.text);
  return JSON.parse(item.text);
}

function fastenerGroupTestInput() {
  const sourceHash = "d".repeat(64);
  return {
    process: materialCouponQualificationInput().process,
    geometry: {
      widthMm: 50,
      heightMm: 30,
      thicknessMm: 4,
      holes: [{ xMm: 15, yMm: 15, diameterMm: 5 }, { xMm: 35, yMm: 15, diameterMm: 5 }],
    },
    fixture: {
      testMethod: "documented two-hole pin-joint test",
      loadAxis: "x" as const,
      jointConfiguration: "double-lap" as const,
      fastenerDiameterMm: 5,
      radialClearanceMm: 0.2,
      clampCondition: "no preload",
    },
    outcomes: [{ peakLoadN: 400, failureMode: "shared-ligament" as const, evidenceIds: ["peak"] }],
    evidence: [
      { id: "geometry", label: "Measured specimen geometry", status: "measured" as const, sourceHash, sourceLocator: "test:geometry", dependsOn: [] },
      { id: "fixture", label: "Physical test report", status: "measured" as const, sourceHash, sourceLocator: "test:fixture", dependsOn: [] },
      { id: "peak", label: "Specimen peak load", status: "measured" as const, unit: "N" as const, value: 400, sourceHash, sourceLocator: "test:peak", dependsOn: [] },
    ],
    specimenMeasurementEvidenceId: "geometry",
    testReportEvidenceId: "fixture",
    testedAt: "2026-09-23T10:00:00.000Z",
    source: "physical-multi-hole-joint-test" as const,
    callerConfirmsPhysicalTests: true as const,
  };
}

function materialCouponQualificationInput(): MaterialCouponQualificationInput {
  const properties = { youngModulusMPa: 2100, shearModulusMPa: 740, tensileStrengthMPa: 31, shearStrengthMPa: 17 };
  const ids = ["young-modulus", "shear-modulus", "tensile-strength", "shear-strength"];
  const values = Object.values(properties);
  const paths = Object.keys(properties);
  return {
    process: {
      printerId: "creality-k1c-0.4",
      materialId: "generic-pla-k1c-0.4",
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
    properties,
    propertyEvidence: {
      youngModulusMPa: [ids[0]!],
      shearModulusMPa: [ids[1]!],
      tensileStrengthMPa: [ids[2]!],
      shearStrengthMPa: [ids[3]!],
    },
    evidence: ids.map((id, index) => ({
      id,
      label: paths[index]!,
      status: "measured" as const,
      unit: "MPa" as const,
      value: values[index]!,
      sourceUrl: "https://example.com/coupon-report.pdf",
      sourceHash: `${index + 1}`.repeat(64),
      sourceLocator: `coupon-report:${id}`,
      dependsOn: [],
    })),
    testStandard: "documented tensile and shear coupon procedures",
    specimenCount: 5,
    testedAt: "2026-09-23T10:00:00.000Z",
    source: "physical-coupon-test",
    callerConfirmsPhysicalTests: true,
  };
}

function testPropertyEvidence(id: string, value: number, unit: "MPa" | "ratio" = "MPa") {
  return {
    id,
    label: `Synthetic FEA test ${id}`,
    status: "assumed" as const,
    unit,
    value,
    derivation: "Synthetic acceptance fixture only; this is not a physical material property.",
    dependsOn: [],
  };
}

function testYoungsModulusEvidence() {
  return {
    id: "test-youngs-modulus",
    label: "Synthetic FEA test Young's modulus",
    status: "assumed" as const,
    unit: "MPa" as const,
    value: 2000,
    derivation: "Synthetic acceptance fixture only; this is not a physical material property.",
    dependsOn: [],
  };
}

function testPoissonRatioEvidence() {
  return {
    id: "test-poisson-ratio",
    label: "Synthetic FEA test Poisson ratio",
    status: "assumed" as const,
    unit: "ratio" as const,
    value: 0.3,
    derivation: "Synthetic acceptance fixture only; this is not a physical material property.",
    dependsOn: [],
  };
}

async function waitForTerminal(store: StrengthStore, id: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      if ((await store.readRequest(id)).state !== "requested") return;
    } catch {
      // The request file may not have been created when cancellation arrived.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Request did not become terminal: ${id}`);
}

async function reportFiles(root: string): Promise<string[]> {
  try {
    return await readdir(join(root, "reports"));
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}
