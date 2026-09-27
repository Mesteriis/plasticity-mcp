import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { PlasticityOperations } from "../../plasticity/operations.ts";
import { InterfaceTestStore, type InterfaceTestInput } from "../interface-test.ts";
import { MaterialCouponQualificationStore, type MaterialCouponQualificationInput } from "../material-qualification.ts";
import { analyzeCohesiveInterface, cohesiveAnalysisInputSchema, cohesiveAnalysisRequestSchema, type CohesiveAnalysisDependencies, type CohesiveAnalysisRequest } from "./cohesive-analysis.ts";
import type { CohesiveStepMeshResult } from "./cohesive-step-mesh.ts";
import type { RunCodeAsterCohesiveCaseResult } from "./code-aster-cohesive-runner.ts";
import { CohesiveReportStore } from "./cohesive-report-store.ts";
import { verifyCohesiveReportEvidence } from "./cohesive-report-evidence.ts";
import { buildCodeAsterCohesiveDeck } from "./code-aster-cohesive-deck.ts";
import { createCohesiveLayerPlanePlan } from "./layer-plane-plan.ts";

const processA = { printerId: "creality-k1c", materialId: "pla-a", profileHash: "a".repeat(64), orientationDeg: [0, 0, 0] as [number, number, number], infillPercent: 100, infillPattern: "grid", wallLoops: 2, topShellLayers: 5, bottomShellLayers: 3, nozzleTemperatureC: 220, layerHeightMm: 0.2 };
const processB = { ...processA, materialId: "pla-b", profileHash: "b".repeat(64) };
const poissonEvidence = (id: string, value: number) => ({
  id, label: `Poisson ratio ${id}`, status: "measured" as const, value, unit: "ratio" as const,
  sourceUrl: "https://example.com/report.pdf", sourceHash: "c".repeat(64), sourceLocator: `report.pdf!${id}`, dependsOn: [],
});
const input: CohesiveAnalysisRequest = cohesiveAnalysisRequestSchema.parse({
  bodyId: 7, revision: "r1", interfaceTestRecordId: "d".repeat(64),
  layerPlanePlan: {
    processProfileHash: processA.profileHash,
    firstInterfacePointMm: [0, 0, 2],
    buildDirectionGlobal: [0, 0, 1],
    layerHeightMm: 0.2,
    totalLayerCount: 2,
    interfaceLayerIndices: [1],
  },
  splitPlanes: [{ pointMm: [0, 0, 2], normalGlobal: [0, 0, 1] }],
  supportFaceId: "bottom", loadedFaceId: "top", meshSizeMm: 1.5,
  poissonRatio: 0.3, poissonRatioEvidence: poissonEvidence("nu-single", 0.3),
  adherencePenalty: 0.00001, increments: 10,
});

test("cohesive analysis rejects direct force-area strengths before CAD export or meshing", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "cohesive-requires-traction-curve-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const interfaceTests = new InterfaceTestStore(join(root, "interface-tests"));
  const directStrength = interfaceInput("same-material-layer");
  delete directStrength.tractionSeparationCurve;
  delete directStrength.fractureMethod;
  directStrength.specimenResults = Array.from({ length: directStrength.specimenCount }, (_unused, index) => {
    const specimenId = `normal-${index + 1}`;
    return {
      specimenId,
      peakForceN: 24,
      netCrossSectionMm2: 10,
      nominalPeakStrengthMPa: 2.4,
      failureLocation: "interface" as const,
      sourceHash: `${index + 1}`.repeat(64),
      sourceLocator: `direct-test.csv!${specimenId}`,
    };
  });
  directStrength.representativeSpecimenId = "normal-1";
  directStrength.evidence[0]!.sourceHash = "1".repeat(64);
  directStrength.evidence[0]!.sourceLocator = "direct-test.csv!normal-1";
  const storedTest = await interfaceTests.record(directStrength);
  const workspace = join(root, "workspace");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(workspace);
  let meshCalled = false;
  let exportCalled = false;
  const cad = operations([state()]);
  cad.exportStep = async () => { exportCalled = true; throw new Error("must not export CAD"); };
  await assert.rejects(() => analyzeCohesiveInterface(cad, {
    ...input, interfaceTestRecordId: storedTest.record.id,
  }, workspace, {
    interfaceTests,
    coupons: new MaterialCouponQualificationStore(join(root, "coupons")),
    generateMesh: async () => { meshCalled = true; throw new Error("must not mesh"); },
  }), /requires a DCB Mode-I physical fracture-test record/i);
  assert.equal(exportCalled, false);
  assert.equal(meshCalled, false);
});

function couponInput(process: typeof processA, modulus: number, orthotropic?: ReturnType<typeof orthotropicInput>): MaterialCouponQualificationInput {
  const properties = { youngModulusMPa: modulus, shearModulusMPa: 800, tensileStrengthMPa: 30, shearStrengthMPa: 20 };
  const evidence = Object.entries(properties).map(([key, value], index) => ({
    id: `${process.materialId}-${index}`, label: key, status: "measured" as const, value, unit: "MPa" as const,
    sourceUrl: "https://example.com/coupon.pdf", sourceHash: `${index}`.repeat(64), sourceLocator: `coupon.pdf!${key}`, dependsOn: [],
  }));
  return {
    process, poissonRatio: 0.3, poissonRatioEvidence: ["nu-single"], properties,
    propertyEvidence: {
      youngModulusMPa: [evidence[0]!.id], shearModulusMPa: [evidence[1]!.id],
      tensileStrengthMPa: [evidence[2]!.id], shearStrengthMPa: [evidence[3]!.id],
    },
    ...(orthotropic ? { orthotropicMaterial: orthotropic.material } : {}),
    evidence: [...evidence, poissonEvidence("nu-single", 0.3), ...(orthotropic?.evidence ?? [])], testStandard: "ISO-527", specimenCount: 5, testedAt: "2026-09-24T10:00:00.000Z",
    source: "physical-coupon-test", callerConfirmsPhysicalTests: true,
  };
}

function orthotropicInput(id: string, youngsModulus2MPa: number, orientation = {
  axis1DirectionGlobal: [1, 0, 0] as [number, number, number],
  axis2ReferenceDirectionGlobal: [0, 1, 0] as [number, number, number],
  buildDirectionGlobal: [0, 0, 1] as [number, number, number],
}) {
  const properties = {
    youngsModulus2MPa, youngsModulus3MPa: 800, poissonRatio13: 0.2, poissonRatio23: 0.25,
    shearModulus12MPa: 600, shearModulus13MPa: 350, shearModulus23MPa: 300,
  };
  const evidence = (key: keyof typeof properties, index: number) => ({
    id: `${id}-${key}`, label: `${key} ${id}`, status: "measured" as const, value: properties[key],
    unit: key.startsWith("poisson") ? "ratio" as const : "MPa" as const,
    sourceUrl: "https://example.com/orthotropic-coupon.pdf", sourceHash: `${index + 2}`.repeat(64),
    sourceLocator: `orthotropic-coupon.pdf!${key}`, dependsOn: [],
  });
  return {
    material: {
      ...properties,
      propertyEvidence: {
        youngsModulus2MPa: [`${id}-youngsModulus2MPa`], youngsModulus3MPa: [`${id}-youngsModulus3MPa`],
        poissonRatio13: [`${id}-poissonRatio13`], poissonRatio23: [`${id}-poissonRatio23`],
        shearModulus12MPa: [`${id}-shearModulus12MPa`], shearModulus13MPa: [`${id}-shearModulus13MPa`], shearModulus23MPa: [`${id}-shearModulus23MPa`],
      },
      orientation: {
        ...orientation,
        evidence: { status: "user-confirmed" as const, description: "Axes confirmed by the user against the CAD global frame and print build direction." },
      },
    },
    evidence: [evidence("youngsModulus2MPa", 0), evidence("youngsModulus3MPa", 1), evidence("poissonRatio13", 2), evidence("poissonRatio23", 3), evidence("shearModulus12MPa", 4), evidence("shearModulus13MPa", 5), evidence("shearModulus23MPa", 6)],
  };
}

function interfaceInput(interfaceKind: InterfaceTestInput["interfaceKind"] = "same-material-layer"): InterfaceTestInput {
  const testedProcessB = interfaceKind === "same-material-layer" ? processA : processB;
  return {
    interfaceKind, materialAProcess: processA, materialBProcess: testedProcessB,
    testMode: "normal-tension", interfaceNormalGlobal: [0, 0, 1], loadDirectionGlobal: [0, 0, 1],
    fractureMethod: "dcb-mode-i",
    testMethod: "ASTM D5528 DCB", testProtocolHash: "e".repeat(64),
    specimenDescription: "Two printed tabs bonded across one planar material interface.",
    fixtureDescription: "Axial grips load both tabs along the marked normal direction.", measuredPeakStrengthMPa: 2.4,
    tractionSeparationCurve: {
      sourceHash: "f".repeat(64), sourceLocator: "curve.csv!A2:B5",
      points: [{ separationMm: 0, tractionMPa: 0 }, { separationMm: 0.01, tractionMPa: 2.4 }, { separationMm: 0.04, tractionMPa: 1.2 }, { separationMm: 0.08, tractionMPa: 0 }],
    },
    failureLocation: "interface",
    evidence: [{ id: "interface-peak", label: "Measured peak", status: "measured", value: 2.4, unit: "MPa", sourceHash: "1".repeat(64), sourceLocator: "test.pdf p.4", dependsOn: [] }],
    specimenCount: 5, testedAt: "2026-09-24T10:00:00.000Z", source: "physical-material-interface-test", callerConfirmsPhysicalTests: true,
  };
}

function scalarModeInput(mode: "normal-tension" | "interface-shear", testMethod: string, peak: number, endMm: number): InterfaceTestInput {
  const direction = mode === "normal-tension" ? [0, 0, 1] as [number, number, number] : [1, 0, 0] as [number, number, number];
  return {
    ...interfaceInput(), testMode: mode, interfaceNormalGlobal: [0, 0, 1], loadDirectionGlobal: direction,
    fractureMethod: mode === "normal-tension" ? "dcb-mode-i" : "enf-mode-ii",
    testMethod, testProtocolHash: peak.toString().replace(".", "a").padEnd(64, "d"), measuredPeakStrengthMPa: peak,
    tractionSeparationCurve: { sourceHash: `${peak}`.replace(".", "a").padEnd(64, "b"), sourceLocator: `${testMethod}.csv!A2:B4`, points: [
      { separationMm: 0, tractionMPa: 0 }, { separationMm: endMm / 2, tractionMPa: peak }, { separationMm: endMm, tractionMPa: 0 },
    ] },
    evidence: [{ id: `peak-${testMethod}`, label: "Measured peak", status: "measured", value: peak, unit: "MPa", sourceHash: "9".repeat(64), sourceLocator: `${testMethod}.pdf!peak`, dependsOn: [] }],
  };
}

function mixedModeInput(fraction: number, energy: number): InterfaceTestInput {
  const normalEnergy = energy * (1 - fraction);
  const shearEnergy = energy * fraction;
  const normalPeak = normalEnergy / 0.01;
  const shearPeak = shearEnergy / 0.01;
  const peak = Math.hypot(normalPeak, shearPeak);
  return {
    ...interfaceInput(), testMode: "mixed-mode", interfaceNormalGlobal: [0, 0, 1], loadDirectionGlobal: [Math.SQRT1_2, 0, Math.SQRT1_2],
    fractureMethod: "mmb-mixed-mode",
    testMethod: "ASTM-D6671 MMB", testProtocolHash: `${fraction}`.replace(".", "a").padEnd(64, "e"), measuredPeakStrengthMPa: peak, tractionSeparationCurve: undefined,
    mixedModeTractionSeparationCurve: { sourceHash: `${fraction}`.replace(".", "a").padEnd(64, "c"), sourceLocator: `MMB-${fraction}.csv!A2:D4`, points: [
      { normalSeparationMm: 0, tangentialSeparationMm: 0, normalTractionMPa: 0, tangentialTractionMPa: 0 },
      { normalSeparationMm: 0.01, tangentialSeparationMm: 0.01, normalTractionMPa: normalPeak, tangentialTractionMPa: shearPeak },
      { normalSeparationMm: 0.02, tangentialSeparationMm: 0.02, normalTractionMPa: 0, tangentialTractionMPa: 0 },
    ] },
    evidence: [{ id: `peak-mmb-${fraction}`, label: "Measured peak", status: "measured", value: peak, unit: "MPa", sourceHash: "8".repeat(64), sourceLocator: `MMB-${fraction}.pdf!peak`, dependsOn: [] }],
  };
}

const meshResult = (outputPath: string, splitPlanes: CohesiveStepMeshResult["splitPlanes"] = [
  { pointMm: [0, 0, 2], normalGlobal: [0, 0, 1] },
]): CohesiveStepMeshResult => ({
  gmshVersion: "4.15.2", layerwiseRegions: false, volumeCount: splitPlanes.length + 1, interfaceSurfaceCount: splitPlanes.length,
  splitPlanes,
  interfaceSurfaceGroups: splitPlanes.map((_plane, index) => ({ planeIndex: index, physicalTag: 3 + index, surfaceEntityTags: [10 + index], triangleCount: 20 })), meshSizeMm: 1.5,
  materialATetrahedronCount: 100, materialBTetrahedronCount: 100, cohesiveVolumeTag: 1003, interfaceTriangleCount: 20 * splitPlanes.length, duplicatedNodeCount: 15 * splitPlanes.length,
  cohesiveElementCount: 20 * splitPlanes.length, cohesiveElementIds: Array.from({ length: 20 * splitPlanes.length }, (_unused, index) => 200 + index),
  boundaryGroups: [
    { faceId: "bottom", physicalTag: 1001, name: "GM1001", surfaceEntityTag: 1 },
    { faceId: "top", physicalTag: 1002, name: "GM1002", surfaceEntityTag: 2 },
  ], outputPath,
});

function operations(states: unknown[]): PlasticityOperations {
  let index = 0;
  return {
    datumRegistry: { sessionId: "session-1" },
    state: async () => states[Math.min(index++, states.length - 1)],
    exportStep: async (_ids: number[], path: string) => { await writeFile(path, "ISO-10303-21;\nEND-ISO-10303-21;\n"); return { path, bytes: 40 }; },
  } as unknown as PlasticityOperations;
}

const state = (revision = "r1") => ({
  documentToken: "doc-1", revision,
  bodies: [{ id: 7, versionId: 2, type: "Solid", name: "Coupon", boundsMm: { min: [0, 0, 0], max: [10, 5, 4] },
    faceIds: ["bottom", "top"], edgeIds: [], faces: [
      { id: "bottom", planar: true, surfaceType: "Plane", centerMm: [5, 2.5, 0], normal: [0, 0, -1], boundsMm: { min: [0, 0, 0], max: [10, 5, 0] }, edgeIds: [] },
      { id: "top", planar: true, surfaceType: "Plane", centerMm: [5, 2.5, 4], normal: [0, 0, 1], boundsMm: { min: [0, 0, 4], max: [10, 5, 4] }, edgeIds: [] },
    ], edges: [] }],
});

test("cohesive MCP analysis binds exact process coupons, physical curve, native faces, and a live CAD revision", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "cohesive-analysis-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const interfaceTests = new InterfaceTestStore(join(root, "interface-tests"));
  const coupons = new MaterialCouponQualificationStore(join(root, "coupons"));
  const storedTest = await interfaceTests.record(interfaceInput());
  const couponA = await coupons.record(couponInput(processA, 2000, orthotropicInput("iso-a", 1_500)));
  const workspace = join(root, "workspace");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(workspace);
  let solverCalled = false;
  let solverModeILaw: string | undefined;
  const solverResult = {
    solver: "Code_Aster 15.2.0", imageDigest: "sha256:fixture", result: { solverVersion: "15.02.00", displacementHistory: [], reactionHistory: [], interfaceStateHistory: [], v3Interpretation: "damage-variable-0-to-1", interpretation: "raw-cohesive-solver-response" },
    meshResolution: { maximumCohesiveEdgeMm: 0.5, recommendedElementsAcrossZone: 5, materialEstimates: [{ material: "A", indicativeProcessZoneLengthMm: 1, estimatedElementsAcrossZone: 5 }, { material: "B", indicativeProcessZoneLengthMm: 1, estimatedElementsAcrossZone: 5 }], status: "meets-indicative-five-element-screen", interpretation: "fixture" },
    limitations: [], diagnostics: [],
  } as unknown as RunCodeAsterCohesiveCaseResult;
  const result = await analyzeCohesiveInterface(operations([state()]), { ...input, interfaceTestRecordId: storedTest.record.id, modeILaw: "CZM_LIN_REG" }, workspace, {
    interfaceTests, coupons,
    generateMesh: async (request) => { await writeFile(request.outputPath, "$MeshFormat\n2.2 0 8\n$EndMeshFormat\n"); return meshResult(request.outputPath); },
    runSolver: async ({ deck }) => { solverCalled = true; solverModeILaw = deck.modeILaw; return solverResult; },
  });
  assert.equal(result.binding.revision, "r1");
  assert.equal(result.input.modeILaw, "CZM_LIN_REG");
  assert.equal(solverModeILaw, "CZM_LIN_REG");
  assert.equal(result.physicalTest.recordId, storedTest.record.id);
  assert.equal(result.couponRecordIds.materialA, couponA.record.id);
  assert.equal(result.couponRecordIds.materialB, couponA.record.id);
  assert.equal(result.materialAssignment.negativeSide.testMaterial, "A");
  assert.equal(result.materialAssignment.negativeSide.youngsModulusMPa, 2000);
  assert.equal(result.materialAssignment.positiveSide.testMaterial, "B");
  assert.equal(result.materialAssignment.positiveSide.youngsModulusMPa, 2000);
  assert.equal(result.materialAssignment.negativeSide.orthotropicMaterial, undefined, "a stored tensor is not silently enabled without the explicit Turon option");
  assert.equal(result.solver, solverResult);
  assert.equal(result.mesh.cohesiveElementCount, 20);
  assert.equal("cohesiveElementIds" in result.mesh, false);
  assert.equal("outputPath" in result.mesh, false);
  assert.equal(solverCalled, true);
});

test("cohesive analysis rejects nu12 that conflicts with the exact-process coupon before meshing", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "cohesive-nu12-binding-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const interfaceTests = new InterfaceTestStore(join(root, "interface-tests"));
  const coupons = new MaterialCouponQualificationStore(join(root, "coupons"));
  const storedTest = await interfaceTests.record(interfaceInput());
  await coupons.record(couponInput(processA, 2_000));
  const workspace = join(root, "workspace");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(workspace);
  let meshCalled = false;
  await assert.rejects(() => analyzeCohesiveInterface(
    operations([state()]),
    { ...input, interfaceTestRecordId: storedTest.record.id, poissonRatio: 0.28, poissonRatioEvidence: poissonEvidence("different-nu12", 0.28) },
    workspace,
    {
      interfaceTests, coupons,
      generateMesh: async () => { meshCalled = true; throw new Error("must not reach mesh"); },
      runSolver: async () => { throw new Error("must not start solver"); },
    },
  ), /Poisson ratio nu12 does not equal/i);
  assert.equal(meshCalled, false);
});

test("cohesive analysis supports one measured same-material layer interface", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "cohesive-layer-analysis-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const interfaceTests = new InterfaceTestStore(join(root, "interface-tests"));
  const coupons = new MaterialCouponQualificationStore(join(root, "coupons"));
  const storedTest = await interfaceTests.record(interfaceInput("same-material-layer"));
  const coupon = await coupons.record(couponInput(processA, 2000));
  const workspace = join(root, "workspace");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(workspace);
  const result = await analyzeCohesiveInterface(operations([state()]), { ...input, interfaceTestRecordId: storedTest.record.id }, workspace, {
    interfaceTests, coupons,
    generateMesh: async (request) => { await writeFile(request.outputPath, "$MeshFormat\n2.2 0 8\n$EndMeshFormat\n"); return meshResult(request.outputPath); },
    runSolver: async () => ({
      solver: "Code_Aster 15.2.0", imageDigest: `sha256:${"a".repeat(64)}`,
      result: {
        solverVersion: "15.02.00", v3Interpretation: "damage-variable-0-to-1", displacementHistory: [{ order: 0, time: 0, minMm: 0, maxMm: 0 }],
        reactionHistory: [{ order: 0, time: 0, xN: 0, yN: 0, zN: 0 }],
        interfaceStateHistory: [{ order: 0, time: 0, elementCount: 40, variables: { V3: { min: 0, max: 0 }, V7: { min: 0, max: 0 }, V8: { min: 0, max: 0 }, V9: { min: 0, max: 0 } } }],
        interpretation: "raw-cohesive-solver-response",
      },
      meshResolution: {
        maximumCohesiveEdgeMm: 0.5, recommendedElementsAcrossZone: 5,
        materialEstimates: [
          { material: "A", indicativeProcessZoneLengthMm: 2, estimatedElementsAcrossZone: 4 },
          { material: "B", indicativeProcessZoneLengthMm: 2, estimatedElementsAcrossZone: 4 },
        ], status: "meets-indicative-five-element-screen", interpretation: "fixture",
      },
      limitations: [], diagnostics: [],
    } as unknown as RunCodeAsterCohesiveCaseResult),
  });
  assert.equal(result.physicalTest.interfaceKind, "same-material-layer");
  assert.deepEqual(result.physicalTest.materialAProcess, result.physicalTest.materialBProcess);
  assert.equal(result.couponRecordIds.materialA, coupon.record.id);
  assert.equal(result.couponRecordIds.materialB, coupon.record.id);
});

test("Mode-I MCP route binds one exact-process orthotropic coupon to both bulk regions", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "cohesive-mode-i-orthotropic-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const interfaceTests = new InterfaceTestStore(join(root, "interface-tests"));
  const coupons = new MaterialCouponQualificationStore(join(root, "coupons"));
  const storedTest = await interfaceTests.record(interfaceInput("same-material-layer"));
  const coupon = await coupons.record(couponInput(processA, 2_000, orthotropicInput("mode-i-orthotropic", 1_500)));
  const workspace = join(root, "workspace");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(workspace);
  const solverResult = {
    solver: "Code_Aster 17.4.0", imageDigest: `sha256:${"a".repeat(64)}`,
    result: { solverVersion: "17.04.00", displacementHistory: [{ order: 0, time: 0, minMm: 0, maxMm: 0 }], reactionHistory: [{ order: 0, time: 0, xN: 0, yN: 0, zN: 0 }], interfaceStateHistory: [{ order: 0, time: 0, elementCount: 20, variables: { V3: { min: 0, max: 0 }, V7: { min: 0, max: 0 }, V8: { min: 0, max: 0 }, V9: { min: 0, max: 0 } } }], interpretation: "raw-cohesive-solver-response" },
    meshResolution: { maximumCohesiveEdgeMm: 0.5, recommendedElementsAcrossZone: 5, materialEstimates: [{ material: "A", indicativeProcessZoneLengthMm: 1, estimatedElementsAcrossZone: 5 }, { material: "B", indicativeProcessZoneLengthMm: 1, estimatedElementsAcrossZone: 5 }], status: "meets-indicative-five-element-screen", interpretation: "fixture" },
    limitations: [], diagnostics: [],
  } as unknown as RunCodeAsterCohesiveCaseResult;
  let deckInput: unknown;
  const result = await analyzeCohesiveInterface(operations([state()]), {
    ...input, interfaceTestRecordId: storedTest.record.id, useOrthotropicBulkProperties: true,
  }, workspace, {
    interfaceTests, coupons,
    generateMesh: async (request) => { await writeFile(request.outputPath, "$MeshFormat\n2.2 0 8\n$EndMeshFormat\n"); return meshResult(request.outputPath); },
    runSolver: async ({ deck }) => { deckInput = deck; return solverResult; },
  });
  const deck = buildCodeAsterCohesiveDeck(deckInput as Parameters<typeof buildCodeAsterCohesiveDeck>[0]);
  assert.equal(result.solver.solver, "Code_Aster 17.4.0");
  assert.equal(result.couponRecordIds.materialA, coupon.record.id);
  assert.equal(result.couponRecordIds.materialB, coupon.record.id);
  assert.equal(result.materialAssignment.negativeSide.orthotropicMaterial?.youngsModulus2MPa, 1_500);
  assert.equal(result.materialAssignment.positiveSide.orthotropicMaterial?.youngsModulus2MPa, 1_500);
  assert.match(deck.commandFile, /RELATION='ELAS', GROUP_MA='GM1'/);
  assert.match(deck.commandFile, /CARA_ELEM=CARA/);
  const reports = new CohesiveReportStore(join(root, "reports"));
  const storedReport = await reports.save(result);
  assert.equal((await reports.read(storedReport.id)).solver.solver, "Code_Aster 17.4.0");
});

test("layerwise cohesive Mode-I uses one measured tensor with G-code-mapped axes for every layer", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "cohesive-layerwise-axes-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const interfaceTests = new InterfaceTestStore(join(root, "interface-tests"));
  const coupons = new MaterialCouponQualificationStore(join(root, "coupons"));
  const storedTest = await interfaceTests.record(interfaceInput("same-material-layer"));
  const coupon = await coupons.record(couponInput(processA, 2_000, orthotropicInput("layerwise-axes", 1_500)));
  const workspace = join(root, "workspace");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(workspace);
  const layerPlanePlan = {
    processProfileHash: processA.profileHash,
    firstInterfacePointMm: [0, 0, 2] as [number, number, number],
    buildDirectionGlobal: [0, 0, 1] as [number, number, number],
    layerHeightMm: 0.2,
    totalLayerCount: 3,
    interfaceLayerIndices: [1, 2],
    interfaceOffsetsMm: [0, 0.2],
    pathFrameMapping: {
      slicerXDirectionGlobal: [1, 0, 0] as [number, number, number],
      evidence: { status: "user-confirmed" as const, description: "Confirmed slicer X maps to the CAD global X axis." },
    },
    roadAxisMapping: {
      status: "user-confirmed" as const,
      couponAxis1Meaning: "dominant-deposition-road-direction" as const,
      evidence: { description: "Confirmed the exact-process coupon material axis 1 follows the dominant deposited-road direction." },
    },
    layerPathEvidence: {
      jobId: "layerwise-job", profileHash: processA.profileHash,
      sourceArtifactHash: "b".repeat(64), gcodeArtifactHash: "c".repeat(64),
      layerCount: 3, coordinateFrame: "slicer-build" as const,
      layers: [0, 90, 45].map((principalDirectionDeg, index) => ({
        layerIndex: index + 1, depositionLayerZMm: 0.2 * (index + 1),
        pathOrientation: {
          layerIndex: index + 1, planarPathLengthMm: 100, principalDirectionDeg,
          directionalConcentration: 0.9, curvedExtrusionMoves: 0, coverage: "complete-linear" as const,
        },
      })),
    },
  };
  let receivedDeck: unknown;
  const result = await analyzeCohesiveInterface(operations([state()]), {
    ...input,
    interfaceTestRecordId: storedTest.record.id,
    splitPlanes: createCohesiveLayerPlanePlan(layerPlanePlan).planes,
    layerPlanePlan,
    useOrthotropicBulkProperties: true,
  }, workspace, {
    interfaceTests, coupons,
    generateMesh: async (request) => {
      assert.equal(request.layerwiseRegions, true);
      await writeFile(request.outputPath, "$MeshFormat\n2.2 0 8\n$EndMeshFormat\n");
      const base = meshResult(request.outputPath, request.splitPlanes);
      const { materialATetrahedronCount: _a, materialBTetrahedronCount: _b, ...mesh } = base;
      return {
        ...mesh,
        layerwiseRegions: true,
        layerRegionGroups: [1, 2, 3].map((layerIndex) => ({ layerIndex, physicalTag: layerIndex, name: `GM${layerIndex}`, tetrahedronCount: 100 })),
        interfaceSurfaceGroups: request.splitPlanes.map((_plane, index) => ({ planeIndex: index, physicalTag: 4 + index, surfaceEntityTags: [10 + index], triangleCount: 20 })),
      };
    },
    runSolver: async ({ deck }) => { receivedDeck = deck; return {
      solver: "Code_Aster 17.4.0", imageDigest: `sha256:${"a".repeat(64)}`,
      result: { solverVersion: "17.04.00", displacementHistory: [{ order: 0, time: 0, minMm: 0, maxMm: 0 }], reactionHistory: [{ order: 0, time: 0, xN: 0, yN: 0, zN: 0 }], interfaceStateHistory: [{ order: 0, time: 0, elementCount: 40, variables: { V3: { min: 0, max: 0 }, V7: { min: 0, max: 0 }, V8: { min: 0, max: 0 }, V9: { min: 0, max: 0 } } }], interpretation: "raw-cohesive-solver-response" },
      meshResolution: { maximumCohesiveEdgeMm: 0.5, recommendedElementsAcrossZone: 5, materialEstimates: [{ material: "A", indicativeProcessZoneLengthMm: 1, estimatedElementsAcrossZone: 5 }, { material: "B", indicativeProcessZoneLengthMm: 1, estimatedElementsAcrossZone: 5 }], status: "meets-indicative-five-element-screen", interpretation: "fixture" }, limitations: [], diagnostics: [],
    } as unknown as RunCodeAsterCohesiveCaseResult; },
  });
  const deck = buildCodeAsterCohesiveDeck(receivedDeck as Parameters<typeof buildCodeAsterCohesiveDeck>[0]);
  assert.equal(result.mesh.layerwiseRegions, true);
  assert.deepEqual(result.mesh.layerRegionGroups?.map((group) => group.physicalTag), [1, 2, 3]);
  assert.match(deck.commandFile, /MAT_BULK = DEFI_MATERIAU/);
  assert.equal((deck.commandFile.match(/MAT_BULK = DEFI_MATERIAU/g) ?? []).length, 1);
  assert.match(deck.commandFile, /GROUP_MA='GM2', ANGL_EULER=\(90,0,0\)/);
  assert.match(deck.commandFile, /GROUP_MA='GM3', ANGL_EULER=\(45,0,0\)/);
  assert.equal(result.couponRecordIds.materialA, coupon.record.id);
  assert.equal(result.couponRecordIds.materialB, coupon.record.id);
  const reports = new CohesiveReportStore(join(root, "reports"));
  const storedReport = await reports.save(result);
  assert.equal((await reports.read(storedReport.id)).mesh.layerwiseRegions, true);
});

test("cohesive layer planes must align with the exact-process orthotropic coupon build direction", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "cohesive-layer-frame-binding-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const interfaceTests = new InterfaceTestStore(join(root, "interface-tests"));
  const coupons = new MaterialCouponQualificationStore(join(root, "coupons"));
  const storedTest = await interfaceTests.record(interfaceInput("same-material-layer"));
  const couponAxes = {
    axis1DirectionGlobal: [0, 1, 0] as [number, number, number],
    axis2ReferenceDirectionGlobal: [0, 0, 1] as [number, number, number],
    buildDirectionGlobal: [1, 0, 0] as [number, number, number],
  };
  await coupons.record(couponInput(processA, 2_000, orthotropicInput("frame-mismatch", 1_500, couponAxes)));
  const workspace = join(root, "workspace");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(workspace);
  const layerPlanePlan = {
    processProfileHash: processA.profileHash,
    firstInterfacePointMm: [0, 0, 2] as [number, number, number],
    buildDirectionGlobal: [0, 0, 1] as [number, number, number],
    layerHeightMm: 0.2,
    totalLayerCount: 2,
    interfaceLayerIndices: [1],
  };
  await assert.rejects(() => analyzeCohesiveInterface(operations([state()]), {
    ...input,
    interfaceTestRecordId: storedTest.record.id,
    splitPlanes: createCohesiveLayerPlanePlan(layerPlanePlan).planes,
    layerPlanePlan,
    useOrthotropicBulkProperties: true,
  }, workspace, {
    interfaceTests, coupons,
    generateMesh: async () => { throw new Error("mesh must not start"); },
  }), /align with the exact-process coupon's confirmed print build direction/i);
});

test("cohesive analysis repeats a measured same-material law over ordered parallel layer planes", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "cohesive-layer-stack-analysis-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const interfaceTests = new InterfaceTestStore(join(root, "interface-tests"));
  const coupons = new MaterialCouponQualificationStore(join(root, "coupons"));
  const storedTest = await interfaceTests.record(interfaceInput("same-material-layer"));
  const coupon = await coupons.record(couponInput(processA, 2000));
  const workspace = join(root, "workspace");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(workspace);
  const layerPlanePlan = {
    processProfileHash: processA.profileHash,
    firstInterfacePointMm: [0, 0, 1] as [number, number, number],
    buildDirectionGlobal: [0, 0, 1] as [number, number, number],
    layerHeightMm: 0.2,
    totalLayerCount: 3,
    interfaceLayerIndices: [1, 2],
    interfaceOffsetsMm: [0, 0.24],
    depositionPathEvidence: {
      jobId: "slice-job-17", profileHash: processA.profileHash,
      sourceArtifactHash: "b".repeat(64), gcodeArtifactHash: "c".repeat(64),
      layerCount: 3, coordinateFrame: "slicer-build" as const, firstDepositionLayerZMm: 0.2,
      interfaces: [1, 2].map((interfaceLayerIndex) => ({
        interfaceLayerIndex,
        depositionLayerZMm: interfaceLayerIndex === 1 ? 0.2 : 0.44,
        relativeOffsetMm: interfaceLayerIndex === 1 ? 0 : 0.24,
        depositionPathOrientation: {
          layerIndex: interfaceLayerIndex, planarPathLengthMm: 40,
          principalDirectionDeg: interfaceLayerIndex === 1 ? 0 : 90,
          directionalConcentration: 0.9, curvedExtrusionMoves: 0, coverage: "complete-linear" as const,
        },
      })),
    },
  };
  const splitPlanes = createCohesiveLayerPlanePlan(layerPlanePlan).planes;
  await assert.rejects(() => analyzeCohesiveInterface(operations([state()]), {
    ...input,
    splitPlanes,
    layerPlanePlan: { ...layerPlanePlan, processProfileHash: "b".repeat(64) },
    interfaceTestRecordId: storedTest.record.id,
  }, workspace, { interfaceTests, coupons, generateMesh: async () => { throw new Error("mesh must not start"); } }), /profile hash must match/i);
  const mismatchedLayerPlan = { ...layerPlanePlan, layerHeightMm: 0.16 };
  await assert.rejects(() => analyzeCohesiveInterface(operations([state()]), {
    ...input, splitPlanes: createCohesiveLayerPlanePlan(mismatchedLayerPlan).planes,
    layerPlanePlan: mismatchedLayerPlan,
    interfaceTestRecordId: storedTest.record.id,
  }, workspace, { interfaceTests, coupons, generateMesh: async () => { throw new Error("mesh must not start"); } }), /layer height must match the exact process profile/i);
  const result = await analyzeCohesiveInterface(operations([state()]), {
    ...input, splitPlanes, layerPlanePlan, interfaceTestRecordId: storedTest.record.id,
  }, workspace, {
    interfaceTests, coupons,
    generateMesh: async (request) => { await writeFile(request.outputPath, "$MeshFormat\n2.2 0 8\n$EndMeshFormat\n"); return meshResult(request.outputPath, request.splitPlanes); },
    runSolver: async () => ({
      solver: "Code_Aster 15.2.0", imageDigest: `sha256:${"a".repeat(64)}`,
      result: {
        solverVersion: "15.02.00", v3Interpretation: "damage-variable-0-to-1", displacementHistory: [{ order: 0, time: 0, minMm: 0, maxMm: 0 }],
        reactionHistory: [{ order: 0, time: 0, xN: 0, yN: 0, zN: 0 }],
        interfaceStateHistory: [{ order: 0, time: 0, elementCount: 40, variables: { V3: { min: 0, max: 0 }, V7: { min: 0, max: 0 }, V8: { min: 0, max: 0 }, V9: { min: 0, max: 0 } } }],
        interpretation: "raw-cohesive-solver-response",
      },
      meshResolution: {
        maximumCohesiveEdgeMm: 0.5, recommendedElementsAcrossZone: 5,
        materialEstimates: [
          { material: "A", indicativeProcessZoneLengthMm: 2, estimatedElementsAcrossZone: 4 },
          { material: "B", indicativeProcessZoneLengthMm: 2, estimatedElementsAcrossZone: 4 },
        ], status: "meets-indicative-five-element-screen", interpretation: "fixture",
      },
      limitations: [], diagnostics: [],
    } as unknown as RunCodeAsterCohesiveCaseResult),
  });
  assert.equal(result.mesh.volumeCount, 3);
  assert.equal(result.mesh.interfaceSurfaceGroups.length, 2);
  assert.equal(result.layerInterfaceCoverage, "all-layer-interfaces");
  assert.deepEqual(result.input.layerPlanePlan, layerPlanePlan);
  assert.equal(result.materialAssignment.positiveSide.testMaterial, "B", "material labels identify solver regions; the same coupon supplies both");
  assert.equal(result.materialAssignment.positiveSide.couponRecordId, coupon.record.id);
  const reports = new CohesiveReportStore(join(root, "reports"));
  const stored = await reports.save(result);
  const reread = await reports.read(stored.id);
  assert.equal("result" in reread.solver ? reread.solver.result.v3Interpretation : undefined, "damage-variable-0-to-1");
  assert.equal(reread.mesh.interfaceSurfaceGroups.length, 2);
  assert.deepEqual(reread.input.layerPlanePlan, layerPlanePlan);
  assert.equal(reread.layerInterfaceCoverage, "all-layer-interfaces");
  const mismatchedInterpretation = structuredClone(result);
  if (!("result" in mismatchedInterpretation.solver)) throw new Error("Expected a Mode-I Code_Aster result");
  mismatchedInterpretation.solver.result.v3Interpretation = "state-variable-2-means-fully-broken";
  await assert.rejects(() => reports.save(mismatchedInterpretation), /V3 interpretation must match/);
});

test("cohesive layer-plane analysis rejects legacy physical tests without a recorded layer height", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "cohesive-layer-height-required-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const processWithoutLayerHeight = { ...processA };
  delete (processWithoutLayerHeight as Partial<typeof processA>).layerHeightMm;
  const physicalTest = interfaceInput("same-material-layer");
  physicalTest.materialAProcess = processWithoutLayerHeight;
  physicalTest.materialBProcess = processWithoutLayerHeight;
  const interfaceTests = new InterfaceTestStore(join(root, "interface-tests"));
  const coupons = new MaterialCouponQualificationStore(join(root, "coupons"));
  await assert.rejects(() => interfaceTests.record(physicalTest), /measured slicer layer height/);
  await assert.rejects(() => coupons.record(couponInput(processWithoutLayerHeight, 2_000)), /measured slicer layer height/);
});

test("cohesive analysis binds cut orientation and rejects dissimilar-material printed bonds", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "cohesive-interface-orientation-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const interfaceTests = new InterfaceTestStore(join(root, "interface-tests"));
  const coupons = new MaterialCouponQualificationStore(join(root, "coupons"));
  const dissimilar = await interfaceTests.record(interfaceInput("dissimilar-material-bond"));
  await coupons.record(couponInput(processA, 2000));
  await coupons.record(couponInput(processB, 1000));
  const workspace = join(root, "workspace");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(workspace);
  const deps = { interfaceTests, coupons, generateMesh: async () => { throw new Error("mesh must not start"); } };
  await assert.rejects(analyzeCohesiveInterface(operations([state()]), {
    ...input, interfaceTestRecordId: dissimilar.record.id,
  }, workspace, deps), /only same-material printed-layer interfaces/);
  await assert.rejects(analyzeCohesiveInterface(operations([state()]), {
    ...input, interfaceTestRecordId: dissimilar.record.id,
    layerPlanePlan: {
      processProfileHash: processA.profileHash, firstInterfacePointMm: [0, 0, 1], buildDirectionGlobal: [0, 0, 1],
      layerHeightMm: 0.2, totalLayerCount: 3, interfaceLayerIndices: [1, 2], interfaceOffsetsMm: [0, 1],
    },
    splitPlanes: [
      { pointMm: [0, 0, 1], normalGlobal: [0, 0, 1] },
      { pointMm: [0, 0, 2], normalGlobal: [0, 0, 1] },
    ],
  }, workspace, deps), /only same-material printed-layer interfaces/);
});

test("mixed-mode MCP route fits immutable DCB/ENF/MMB evidence and runs the Turon solver", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "cohesive-turon-analysis-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const interfaceTests = new InterfaceTestStore(join(root, "interface-tests"));
  const coupons = new MaterialCouponQualificationStore(join(root, "coupons"));
  const dcb = await interfaceTests.record({ ...interfaceInput(), testMethod: "ASTM-D5528 DCB" });
  const enf = await interfaceTests.record(scalarModeInput("interface-shear", "ASTM-D7905 ENF", 2, 0.05));
  const modeMixA = await interfaceTests.record(mixedModeInput(0.25, 0.055));
  const modeMixB = await interfaceTests.record(mixedModeInput(0.64, 0.070));
  const orthotropicA = orthotropicInput("a", 1_500);
  const coupon = await coupons.record(couponInput(processA, 2000, orthotropicA));
  const workspace = join(root, "workspace");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(workspace);
  const stiffnessEvidence = { ...poissonEvidence("cohesive-k", 100_000), unit: "MPa/mm" as const, materialProcess: processA };
  const layerPlanInput = {
    processProfileHash: processA.profileHash,
    firstInterfacePointMm: [0, 0, 2] as [number, number, number],
    buildDirectionGlobal: [0, 0, 1] as [number, number, number],
    layerHeightMm: 0.2,
    totalLayerCount: 3,
    interfaceLayerIndices: [1, 2],
    interfaceOffsetsMm: [0, 0.2],
    pathFrameMapping: { slicerXDirectionGlobal: [1, 0, 0] as [number, number, number], evidence: { status: "user-confirmed" as const, description: "Slicer build X was confirmed against the Plasticity global X axis." } },
    roadAxisMapping: { status: "user-confirmed" as const, couponAxis1Meaning: "dominant-deposition-road-direction" as const, evidence: { description: "The exact-process coupon axis 1 follows the dominant deposited road direction." } },
    layerPathEvidence: {
      jobId: "turon-layerwise-job", profileHash: processA.profileHash,
      sourceArtifactHash: "1".repeat(64), gcodeArtifactHash: "2".repeat(64), layerCount: 3, coordinateFrame: "slicer-build" as const,
      layers: [0, 90, 45].map((degrees, index) => ({
        layerIndex: index + 1, depositionLayerZMm: 0.2 * index,
        pathOrientation: { layerIndex: index + 1, planarPathLengthMm: 100, principalDirectionDeg: degrees, directionalConcentration: 0.9, curvedExtrusionMoves: 0, coverage: "complete-linear" as const },
      })),
    },
  };
  const layerPlan = createCohesiveLayerPlanePlan(layerPlanInput);
  let receivedDeck: unknown;
  let meshCalls = 0;
  const analysisInput: CohesiveAnalysisRequest = {
    ...input, layerPlanePlan: layerPlanInput, splitPlanes: layerPlan.planes, interfaceTestRecordId: dcb.record.id, modeIIRecordId: enf.record.id,
    mixedModeRecordIds: [modeMixA.record.id, modeMixB.record.id], initialStiffnessMPaPerMm: 100_000,
    initialStiffnessEvidence: stiffnessEvidence, prescribedDisplacementGlobalMm: [0.1, 0, 0.1], increments: 100,
    useOrthotropicBulkProperties: true,
  };
  const deps: CohesiveAnalysisDependencies = {
    interfaceTests, coupons,
    generateMesh: async (request: Parameters<NonNullable<CohesiveAnalysisDependencies["generateMesh"]>>[0]) => {
      meshCalls += 1;
      await writeFile(request.outputPath, "$MeshFormat\n2.2 0 8\n$EndMeshFormat\n");
      const generated = meshResult(request.outputPath, request.splitPlanes);
      return {
        ...generated, layerwiseRegions: true,
        interfaceSurfaceGroups: generated.interfaceSurfaceGroups.map((group, index) => ({ ...group, physicalTag: 4 + index })),
        layerRegionGroups: [1, 2, 3].map((layerIndex) => ({ layerIndex, physicalTag: layerIndex, name: `GM${layerIndex}`, tetrahedronCount: 100 })),
      };
    },
    runTuronSolver: async (request: Parameters<NonNullable<CohesiveAnalysisDependencies["runTuronSolver"]>>[0]) => {
      receivedDeck = request.deck;
      return {
        solver: "Code_Aster 17.4.0", imageDigest: `sha256:${"a".repeat(64)}`, finalTime: 1,
        maxDamageV3: 0.9, maxStateV5: 1, damageHistory: [
          { order: 0, time: 0, maxDamageV3: 0, maxStateV5: 0 }, { order: 100, time: 1, maxDamageV3: 0.9, maxStateV5: 1 },
        ], medSha256: "b".repeat(64), medBytes: 1000, interpretation: "raw-mixed-mode-cohesive-solver-response",
        limitations: [], diagnostics: [],
      };
    },
  };
  await assert.rejects(analyzeCohesiveInterface(operations([state()]), {
    ...analysisInput, prescribedDisplacementGlobalMm: [0, 0.1, 0.1],
  }, workspace, deps), /align with the measured ENF\/MMB shear direction/i);
  assert.equal(meshCalls, 0, "an unsupported interface shear direction must stop before meshing or solver work");
  await assert.rejects(analyzeCohesiveInterface(operations([state()]), {
    ...analysisInput,
    initialStiffnessEvidence: { ...stiffnessEvidence, materialProcess: processB },
  }, workspace, deps), /K evidence must match the exact same-material process/i);
  assert.equal(meshCalls, 0, "K evidence from another material process must stop before meshing or solver work");
  const result = await analyzeCohesiveInterface(operations([state()]), analysisInput, workspace, deps);
  assert.equal(meshCalls, 1);
  assert.equal(result.turonCalibration?.calibration.samples.length, 2);
  assert.deepEqual(result.turonCalibration?.calibration.materialProcess, processA);
  assert.equal("materialPair" in (result.turonCalibration?.calibration ?? {}), false);
  assert.equal(result.solver.solver, "Code_Aster 17.4.0");
  const deck = receivedDeck as { stiffnessMPaPerMm: number; orthotropicMaterialA: { youngsModulus2MPa: number }; orthotropicMaterialB: { youngsModulus2MPa: number; orientation: { axis1DirectionGlobal: number[] } }; layerwiseOrthotropicRegions: Array<{ layerIndex: number; grid: string; orientation: { axis1DirectionGlobal: number[] } }> };
  assert.equal(deck.stiffnessMPaPerMm, 100_000);
  assert.equal(deck.orthotropicMaterialA.youngsModulus2MPa, 1_500);
  assert.equal(deck.orthotropicMaterialB.youngsModulus2MPa, 1_500);
  assert.deepEqual(deck.orthotropicMaterialB.orientation.axis1DirectionGlobal, [1, 0, 0]);
  assert.deepEqual(deck.layerwiseOrthotropicRegions.map((region) => region.grid), ["GM1", "GM2", "GM3"]);
  assert.ok(Math.abs(deck.layerwiseOrthotropicRegions[1]!.orientation.axis1DirectionGlobal[0]!) < 1e-8);
  assert.ok(Math.abs(deck.layerwiseOrthotropicRegions[1]!.orientation.axis1DirectionGlobal[1]! - 1) < 1e-8);
  assert.equal(result.mesh.layerwiseRegions, true);
  const reports = new CohesiveReportStore(join(root, "reports"));
  const stored = await reports.save(result);
  const reread = await reports.read(stored.id);
  assert.equal(reread.solver.solver, "Code_Aster 17.4.0");
  assert.equal(reread.materialAssignment.positiveSide.couponRecordId, coupon.record.id);
  assert.equal(reread.materialAssignment.positiveSide.orthotropicMaterial?.youngsModulus2MPa, 1_500);
  assert.deepEqual(reread.turonCalibration?.initialStiffnessEvidence.materialProcess, processA);
  await verifyCohesiveReportEvidence(reread, interfaceTests, coupons);
  const reportPath = join(root, "reports", "cohesive-reports", `${stored.id}.json`);
  const storedValue = JSON.parse(await readFile(reportPath, "utf8")) as { input: Record<string, unknown>; [key: string]: unknown };
  const legacyInput: Record<string, unknown> = { ...storedValue.input, negativeSideMaterial: "B", poissonRatioA: storedValue.input.poissonRatio,
    poissonRatioEvidenceA: storedValue.input.poissonRatioEvidence, poissonRatioB: storedValue.input.poissonRatio,
    poissonRatioEvidenceB: storedValue.input.poissonRatioEvidence };
  delete legacyInput.poissonRatio;
  delete legacyInput.poissonRatioEvidence;
  delete (legacyInput.initialStiffnessEvidence as Record<string, unknown>).materialProcess;
  storedValue.input = legacyInput;
  const turonCalibration = storedValue.turonCalibration as { calibration: Record<string, unknown>; initialStiffnessEvidence: Record<string, unknown> };
  delete turonCalibration.initialStiffnessEvidence.materialProcess;
  const calibration = turonCalibration.calibration;
  const { materialProcess, interfaceNormalGlobal, ...legacyCalibrationFields } = calibration;
  turonCalibration.calibration = {
    ...legacyCalibrationFields,
    materialPair: {
      interfaceKind: "same-material-layer", materialAProcess: materialProcess, materialBProcess: materialProcess,
      interfaceNormalGlobal,
    },
  };
  await writeFile(reportPath, `${JSON.stringify(storedValue)}\n`);
  const migrated = await reports.read(stored.id);
  assert.equal(migrated.input.poissonRatio, 0.3);
  assert.equal("negativeSideMaterial" in migrated.input, false);
  assert.deepEqual(migrated.turonCalibration?.calibration.materialProcess, processA);
  assert.equal("materialPair" in (migrated.turonCalibration?.calibration ?? {}), false);
  await assert.rejects(
    () => verifyCohesiveReportEvidence(migrated, interfaceTests, coupons),
    /K\/process evidence or calibration references do not match/i,
    "legacy Turon reports remain readable but become stale when their K cannot be tied to the exact process",
  );
  await coupons.record(couponInput(processA, 2000, orthotropicInput("a-conflict", 1_600)));
  await assert.rejects(() => verifyCohesiveReportEvidence(reread, interfaceTests, coupons), /exact-process coupon data are missing, conflicting/i);
});

test("orthotropic cohesive inputs are allowed on Mode-I and calibrated mixed-mode routes", () => {
  assert.equal(cohesiveAnalysisInputSchema.safeParse({ ...input, useOrthotropicBulkProperties: true }).success, true);
  const mixed = {
    ...input, modeIIRecordId: "e".repeat(64), mixedModeRecordIds: ["a".repeat(64), "b".repeat(64)],
    initialStiffnessMPaPerMm: 100_000, initialStiffnessEvidence: { ...poissonEvidence("schema-k", 100_000), unit: "MPa/mm" as const },
    prescribedDisplacementGlobalMm: [0.01, 0, 0.1] as [number, number, number], increments: 100,
    useOrthotropicBulkProperties: true,
  };
  assert.equal(cohesiveAnalysisInputSchema.safeParse(mixed).success, true);
  const plannedMixed = { ...mixed, layerPlanePlan: input.layerPlanePlan };
  assert.equal(cohesiveAnalysisRequestSchema.safeParse(plannedMixed).success, false, "Turon K evidence must be process-bound before a request can run");
  assert.equal(cohesiveAnalysisRequestSchema.safeParse({
    ...plannedMixed,
    initialStiffnessEvidence: { ...mixed.initialStiffnessEvidence, materialProcess: processA },
  }).success, true);
  assert.equal(cohesiveAnalysisRequestSchema.safeParse({
    ...plannedMixed,
    initialStiffnessEvidence: { ...mixed.initialStiffnessEvidence, materialProcess: processB },
  }).success, true, "an exact but wrong process can only be rejected after matching the referenced interface-test record");
  assert.equal(cohesiveAnalysisInputSchema.safeParse({ ...mixed, prescribedDisplacementGlobalMm: [0, 0, 0.1] }).success, false);
  assert.equal(cohesiveAnalysisInputSchema.safeParse({ ...mixed, prescribedDisplacementGlobalMm: [0.1, 0, 0] }).success, false);
  assert.equal(cohesiveAnalysisInputSchema.safeParse({ ...mixed, modeILaw: "CZM_LIN_REG" }).success, false);
});

test("cohesive analysis accepts only split planes generated by its profile-bound layer plan", () => {
  const layerPlanePlan = {
    processProfileHash: processA.profileHash,
    firstInterfacePointMm: [0, 0, 2] as [number, number, number],
    buildDirectionGlobal: [0, 0, 1] as [number, number, number],
    layerHeightMm: 0.2,
    totalLayerCount: 5,
    interfaceLayerIndices: [1, 2, 3, 4],
  };
  const planned = createCohesiveLayerPlanePlan(layerPlanePlan);
  assert.equal(cohesiveAnalysisInputSchema.safeParse({ ...input, splitPlanes: planned.planes, layerPlanePlan }).success, true);
  assert.equal(cohesiveAnalysisInputSchema.safeParse({
    ...input,
    splitPlanes: [{ ...planned.planes[0]!, pointMm: [0, 0, 2.01] }],
    layerPlanePlan,
  }).success, false);
});

test("new cohesive solver requests require a profile-bound layer-plane plan", () => {
  assert.equal(cohesiveAnalysisRequestSchema.safeParse(input).success, true);
  assert.equal(cohesiveAnalysisRequestSchema.safeParse({ ...input, layerPlanePlan: undefined }).success, false);
});

test("does not start the solver when the Plasticity revision changes during analysis", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "cohesive-stale-analysis-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const interfaceTests = new InterfaceTestStore(join(root, "interface-tests"));
  const coupons = new MaterialCouponQualificationStore(join(root, "coupons"));
  const storedTest = await interfaceTests.record(interfaceInput());
  await coupons.record(couponInput(processA, 2000));
  const workspace = join(root, "workspace");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(workspace);
  let solverCalled = false;
  await assert.rejects(analyzeCohesiveInterface(operations([state("old"), state("new")]), { ...input, revision: "old", interfaceTestRecordId: storedTest.record.id }, workspace, {
    interfaceTests, coupons,
    generateMesh: async (request) => { await writeFile(request.outputPath, "$MeshFormat\n2.2 0 8\n$EndMeshFormat\n"); return meshResult(request.outputPath); },
    runSolver: async () => { solverCalled = true; throw new Error("must not run"); },
  }), /changed during cohesive meshing/);
  assert.equal(solverCalled, false);
});

test("schema requires exact evidence values and distinct support/load faces", () => {
  assert.equal(cohesiveAnalysisInputSchema.safeParse(input).success, true);
  assert.equal(cohesiveAnalysisInputSchema.parse(input).modeILaw, "CZM_EXP_REG");
  assert.equal(cohesiveAnalysisInputSchema.parse({ ...input, modeILaw: "CZM_LIN_REG" }).modeILaw, "CZM_LIN_REG");
  assert.equal(cohesiveAnalysisInputSchema.safeParse({ ...input, modeILaw: "CZM_TURON" }).success, false);
  assert.equal(cohesiveAnalysisInputSchema.safeParse({
    ...input, negativeSideMaterial: "A", poissonRatioA: 0.3, poissonRatioEvidenceA: input.poissonRatioEvidence,
    poissonRatioB: 0.3, poissonRatioEvidenceB: input.poissonRatioEvidence,
  }).success, false);
  assert.equal(cohesiveAnalysisInputSchema.safeParse({ ...input, supportFaceId: "top" }).success, false);
  assert.equal(cohesiveAnalysisInputSchema.safeParse({ ...input, poissonRatioEvidence: poissonEvidence("wrong", 0.31) }).success, false);
  assert.equal(cohesiveAnalysisInputSchema.safeParse({ ...input, poissonRatio: 0.28 }).success, false);
  assert.equal(cohesiveAnalysisInputSchema.safeParse({ ...input, increments: 251 }).success, false);
  assert.equal(cohesiveAnalysisInputSchema.safeParse({ ...input, splitPlanes: [input.splitPlanes[0]!, input.splitPlanes[0]!] }).success, false);
  assert.equal(cohesiveAnalysisInputSchema.safeParse({ ...input, splitPlanes: [input.splitPlanes[0]!, { pointMm: [0, 0, 3], normalGlobal: [0, 1, 0] }] }).success, false);
});
