import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import type { PlasticityOperations } from "../../plasticity/operations.ts";
import type { CadBinding } from "../contracts.ts";
import { analyzeMaterialInterfaceTestCurve, interfaceTestRecordSchema, type InterfaceTestStore } from "../interface-test.ts";
import { exactMaterialCouponProcessSchema, MaterialCouponQualificationStore, sameMaterialCouponProcess, type MaterialCouponProcess, type MaterialCouponQualificationRecord } from "../material-qualification.ts";
import { assertCouponPoissonRatio } from "./material-binding.ts";
import { evidenceSchema } from "../schemas.ts";
import { runCodeAsterCohesiveCase, type RunCodeAsterCohesiveCaseResult } from "./code-aster-cohesive-runner.ts";
import { assertTuronDisplacementMatchesMeasuredShear, calibrateTuronCandidateFromInterfaceTests, type TuronPhysicalCalibrationResult } from "./code-aster-turon-physical-calibration.ts";
import { codeAsterTuronDeckInputFromCalibration } from "./code-aster-turon-deck.ts";
import { runCodeAsterTuronCase, type RunCodeAsterTuronCaseResult } from "./code-aster-turon-runner.ts";
import { buildCodeAsterCohesiveDeckFromTestRecord } from "./code-aster-cohesive-test.ts";
import { generateCohesiveMeshFromStep, type CohesiveStepMeshResult } from "./cohesive-step-mesh.ts";
import { orthotropicElasticConstantsError, type OrthotropicCaseMaterial } from "./orthotropic-material.ts";
import { MAX_LAYER_INTERFACE_PLANES, cohesiveLayerPlanePlanInputSchema, confirmedLayerOrthotropicFrames, createCohesiveLayerPlanePlan } from "./layer-plane-plan.ts";

const vector = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const poissonEvidence = evidenceSchema.extend({ unit: z.literal("ratio") }).superRefine((evidence, context) => {
  if ((evidence.status !== "measured" && evidence.status !== "sourced") || evidence.value === undefined
    || !evidence.sourceUrl || !evidence.sourceLocator || !evidence.sourceHash || !/^[a-f0-9]{64}$/.test(evidence.sourceHash)) {
    context.addIssue({ code: "custom", message: "Poisson-ratio evidence must be measured or sourced with exact value, URL, SHA-256 and source locator" });
  }
});
const stiffnessEvidence = evidenceSchema.extend({ unit: z.literal("MPa/mm"), materialProcess: exactMaterialCouponProcessSchema.optional() }).superRefine((evidence, context) => {
  if ((evidence.status !== "measured" && evidence.status !== "sourced") || evidence.value === undefined
    || !evidence.sourceUrl || !evidence.sourceLocator || !evidence.sourceHash || !/^[a-f0-9]{64}$/.test(evidence.sourceHash)) {
    context.addIssue({ code: "custom", message: "Cohesive K evidence must be measured or sourced with exact value, URL, SHA-256 and source locator" });
  }
});
export const cohesiveAnalysisInputSchema = z.object({
  bodyId: z.number().int().positive(),
  revision: z.string().trim().min(1),
  interfaceTestRecordId: z.string().regex(/^[a-f0-9]{64}$/),
  splitPlanes: z.array(z.object({
    pointMm: vector,
    normalGlobal: vector.refine((normal) => Math.abs(Math.hypot(...normal) - 1) <= 1e-6, "Split-plane normal must be a unit vector"),
  }).strict()).min(1).max(MAX_LAYER_INTERFACE_PLANES).superRefine((planes, context) => {
    const normal = planes[0]?.normalGlobal;
    if (!normal) return;
    const offsets: number[] = [];
    for (const [index, plane] of planes.entries()) {
      const alignment = normal.reduce((sum, value, axis) => sum + value * plane.normalGlobal[axis]!, 0);
      if (alignment < 1 - 1e-9) context.addIssue({ code: "custom", path: [index, "normalGlobal"], message: "All split planes must have parallel normals pointing in the same direction" });
      offsets.push(plane.pointMm.reduce((sum, value, axis) => sum + value * normal[axis]!, 0));
    }
    if (offsets.some((offset, index) => index > 0 && offsets[index - 1]! >= offset - 1e-9)) {
      context.addIssue({ code: "custom", message: "Split planes must be ordered and separated along their shared normal" });
    }
  }),
  layerPlanePlan: cohesiveLayerPlanePlanInputSchema.optional(),
  supportFaceId: z.string().trim().min(1),
  loadedFaceId: z.string().trim().min(1),
  meshSizeMm: z.number().finite().positive().max(100),
  poissonRatio: z.number().finite().gt(-1).lt(0.5),
  poissonRatioEvidence: poissonEvidence,
  useOrthotropicBulkProperties: z.literal(true).optional(),
  modeILaw: z.enum(["CZM_EXP_REG", "CZM_LIN_REG"]).default("CZM_EXP_REG"),
  adherencePenalty: z.number().finite().gt(0).lt(1).default(0.00001),
  increments: z.number().int().min(2).max(1_000),
  modeIIRecordId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  mixedModeRecordIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(2).max(10).optional(),
  initialStiffnessMPaPerMm: z.number().finite().positive().optional(),
  initialStiffnessEvidence: stiffnessEvidence.optional(),
  prescribedDisplacementGlobalMm: vector.optional(),
  residualStiffnessRatio: z.number().finite().gt(0).max(0.1).default(0.001),
}).strict().superRefine((input, context) => {
  if (input.layerPlanePlan) {
    try {
      const plannedPlanes = createCohesiveLayerPlanePlan(input.layerPlanePlan).planes;
      if (plannedPlanes.length !== input.splitPlanes.length || plannedPlanes.some((planned, index) => {
        const supplied = input.splitPlanes[index];
        return !supplied || planned.pointMm.some((coordinate, axis) => Math.abs(coordinate - supplied.pointMm[axis]!) > 1e-9)
          || planned.normalGlobal.some((coordinate, axis) => Math.abs(coordinate - supplied.normalGlobal[axis]!) > 1e-9);
      })) {
        context.addIssue({ code: "custom", path: ["splitPlanes"], message: "Split planes must exactly match the supplied profile-bound layer-interface plan" });
      }
    } catch (error) {
      context.addIssue({ code: "custom", path: ["layerPlanePlan"], message: error instanceof Error ? error.message : "Invalid cohesive layer-plane plan" });
    }
  }
  if (input.supportFaceId === input.loadedFaceId) context.addIssue({ code: "custom", path: ["loadedFaceId"], message: "Support and loaded faces must be distinct" });
  if (input.poissonRatioEvidence.value !== input.poissonRatio) context.addIssue({ code: "custom", path: ["poissonRatioEvidence"], message: "Poisson-ratio evidence value must exactly match the supplied single-material ratio" });
  if (input.layerPlanePlan?.roadAxisMapping && !input.useOrthotropicBulkProperties) {
    context.addIssue({ code: "custom", path: ["useOrthotropicBulkProperties"], message: "Layerwise road directions require the measured exact-process orthotropic single-material tensor" });
  }
  const turonFields = [input.modeIIRecordId, input.mixedModeRecordIds, input.initialStiffnessMPaPerMm, input.initialStiffnessEvidence, input.prescribedDisplacementGlobalMm];
  if (input.modeILaw === "CZM_LIN_REG" && turonFields.some((value) => value !== undefined)) {
    context.addIssue({ code: "custom", path: ["modeILaw"], message: "modeILaw applies only to the Mode-I DCB route; mixed-mode requests use the calibrated Turon law" });
  }
  if (turonFields.every((value) => value === undefined) && input.increments > 250) {
    context.addIssue({ code: "custom", path: ["increments"], message: "Mode-I analysis allows at most 250 base increments because two recursive bisections keep the complete history within 1001 results" });
  }
  if (turonFields.some((value) => value !== undefined)) {
    if (!input.modeIIRecordId || !input.mixedModeRecordIds || input.initialStiffnessMPaPerMm === undefined
      || !input.initialStiffnessEvidence || !input.prescribedDisplacementGlobalMm) {
      context.addIssue({ code: "custom", message: "Mixed-mode Turon analysis requires ENF and MMB records, traceable K, and an explicit global displacement vector" });
    }
    if (input.modeIIRecordId === input.interfaceTestRecordId || input.mixedModeRecordIds?.includes(input.interfaceTestRecordId)
      || (input.modeIIRecordId && input.mixedModeRecordIds?.includes(input.modeIIRecordId))) {
      context.addIssue({ code: "custom", path: ["mixedModeRecordIds"], message: "DCB, ENF and MMB calibration records must be distinct" });
    }
    if (input.initialStiffnessEvidence?.value !== input.initialStiffnessMPaPerMm) {
      context.addIssue({ code: "custom", path: ["initialStiffnessEvidence"], message: "K evidence value must exactly match the supplied initial stiffness" });
    }
    if (input.increments < 100) context.addIssue({ code: "custom", path: ["increments"], message: "Mixed-mode Turon analysis requires at least 100 nonlinear increments" });
    if (input.prescribedDisplacementGlobalMm) {
      if (Math.hypot(...input.prescribedDisplacementGlobalMm) <= 0) {
        context.addIssue({ code: "custom", path: ["prescribedDisplacementGlobalMm"], message: "Mixed-mode displacement vector must be nonzero" });
      } else {
        const normalDisplacement = input.splitPlanes[0]!.normalGlobal.reduce((sum, value, axis) => sum + value * input.prescribedDisplacementGlobalMm![axis]!, 0);
        if (normalDisplacement < -1e-9) context.addIssue({ code: "custom", path: ["prescribedDisplacementGlobalMm"], message: "Mixed-mode displacement must not close the ordered interface" });
        const displacementMagnitude = Math.hypot(...input.prescribedDisplacementGlobalMm);
        const normalFraction = normalDisplacement / displacementMagnitude;
        const tangentFraction = Math.sqrt(Math.max(0, 1 - normalFraction * normalFraction));
        const minimumComponentFraction = Math.sin(Math.PI / 180);
        if (normalFraction <= minimumComponentFraction || tangentFraction <= minimumComponentFraction) {
          context.addIssue({ code: "custom", path: ["prescribedDisplacementGlobalMm"], message: "Mixed-mode Turon displacement must contain both opening-normal and in-plane tangential components greater than one degree" });
        }
      }
    }
  }
});

export type CohesiveAnalysisInput = z.infer<typeof cohesiveAnalysisInputSchema>;
export const cohesiveAnalysisRequestSchema = cohesiveAnalysisInputSchema.safeExtend({
  layerPlanePlan: cohesiveLayerPlanePlanInputSchema,
}).superRefine((input, context) => {
  const usesTuron = [input.modeIIRecordId, input.mixedModeRecordIds, input.initialStiffnessMPaPerMm,
    input.initialStiffnessEvidence, input.prescribedDisplacementGlobalMm].some((value) => value !== undefined);
  if (usesTuron && !input.initialStiffnessEvidence?.materialProcess) {
    context.addIssue({ code: "custom", path: ["initialStiffnessEvidence", "materialProcess"], message: "Cohesive K evidence must identify its exact printer, material and print process" });
  }
});
export type CohesiveAnalysisRequest = z.infer<typeof cohesiveAnalysisRequestSchema>;

export const cohesiveStoredAnalysisInputSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const legacy = value as Record<string, unknown>;
  if ("poissonRatio" in legacy || !("poissonRatioA" in legacy) || !("poissonRatioB" in legacy)) return value;
  const evidenceA = legacy.poissonRatioEvidenceA;
  const evidenceB = legacy.poissonRatioEvidenceB;
  const ratioA = legacy.poissonRatioA;
  const ratioB = legacy.poissonRatioB;
  const evidenceValue = (evidence: unknown): unknown =>
    evidence && typeof evidence === "object" && !Array.isArray(evidence) ? (evidence as Record<string, unknown>).value : undefined;
  if (legacy.negativeSideMaterial !== "A" && legacy.negativeSideMaterial !== "B") return value;
  if (typeof ratioA !== "number" || ratioA !== ratioB || evidenceValue(evidenceA) !== ratioA || evidenceValue(evidenceB) !== ratioB
    || !poissonEvidence.safeParse(evidenceB).success) return value;
  const {
    negativeSideMaterial: _negativeSideMaterial,
    poissonRatioA: _poissonRatioA,
    poissonRatioEvidenceA: _poissonRatioEvidenceA,
    poissonRatioB: _poissonRatioB,
    poissonRatioEvidenceB: _poissonRatioEvidenceB,
    ...rest
  } = legacy;
  return { ...rest, poissonRatio: ratioA, poissonRatioEvidence: evidenceA };
}, cohesiveAnalysisInputSchema);

export interface CohesiveAnalysisDependencies {
  interfaceTests: InterfaceTestStore;
  coupons: MaterialCouponQualificationStore;
  generateMesh?: typeof generateCohesiveMeshFromStep;
  runSolver?: typeof runCodeAsterCohesiveCase;
  runTuronSolver?: typeof runCodeAsterTuronCase;
}

export interface CohesiveAnalysisResult {
  binding: CadBinding;
  bodyName: string | null;
  input: CohesiveAnalysisInput;
  physicalTest: {
    recordId: string;
    interfaceKind: "same-material-layer";
    materialAProcess: MaterialCouponProcess;
    materialBProcess: MaterialCouponProcess;
    curveSourceHash: string;
    curveSourceLocator: string;
    measuredCurveSummary: ReturnType<typeof buildCodeAsterCohesiveDeckFromTestRecord>["curveSummary"];
  };
  couponRecordIds: { materialA: string; materialB: string };
  materialAssignment: {
    negativeSide: { testMaterial: "A" | "B"; process: MaterialCouponProcess; couponRecordId: string; youngsModulusMPa: number; poissonRatio: number; poissonRatioEvidence: z.output<typeof poissonEvidence>; orthotropicMaterial?: NonNullable<MaterialCouponQualificationRecord["orthotropicMaterial"]> };
    positiveSide: { testMaterial: "A" | "B"; process: MaterialCouponProcess; couponRecordId: string; youngsModulusMPa: number; poissonRatio: number; poissonRatioEvidence: z.output<typeof poissonEvidence>; orthotropicMaterial?: NonNullable<MaterialCouponQualificationRecord["orthotropicMaterial"]> };
  };
  mesh: Omit<CohesiveStepMeshResult, "cohesiveElementIds" | "outputPath"> & { meshSha256: string };
  solver: RunCodeAsterCohesiveCaseResult | RunCodeAsterTuronCaseResult;
  turonCalibration?: {
    calibration: TuronPhysicalCalibrationResult;
    initialStiffnessMPaPerMm: number;
    initialStiffnessEvidence: z.output<typeof stiffnessEvidence>;
  };
  layerInterfaceCoverage?: "all-layer-interfaces" | "selected-interfaces-only";
  layerInterfaceLimitation?: string;
  interpretation: "cohesive-solver-response-only";
  strengthPass: false;
  printApproved: false;
}

export async function analyzeCohesiveInterface(
  operations: PlasticityOperations,
  rawInput: CohesiveAnalysisRequest,
  workspace: string,
  deps: CohesiveAnalysisDependencies,
  signal?: AbortSignal,
): Promise<CohesiveAnalysisResult> {
  const parsedInput = cohesiveAnalysisRequestSchema.parse(rawInput);
  const layerPlan = createCohesiveLayerPlanePlan(parsedInput.layerPlanePlan);
  const input = { ...parsedInput, layerPlanePlan: layerPlan.plan, splitPlanes: layerPlan.planes };
  throwIfAborted(signal);
  const initial = await operations.state();
  if (initial.revision !== input.revision) throw new Error("Cohesive FEA input revision is stale");
  const body = initial.bodies.find((candidate) => candidate.id === input.bodyId);
  if (!body || body.type !== "Solid" || !body.boundsMm) throw new Error("Cohesive FEA requires one current bounded native Solid");
  const supportFace = body.faces.find((face) => face.id === input.supportFaceId);
  const loadedFace = body.faces.find((face) => face.id === input.loadedFaceId);
  if (!supportFace?.planar || supportFace.surfaceType !== "Plane" || !loadedFace?.planar || loadedFace.surfaceType !== "Plane") {
    throw new Error("Cohesive support and loaded face IDs must identify current native planar faces on the selected Solid");
  }
  if (supportFace.id === loadedFace.id) throw new Error("Cohesive support and loaded faces must be distinct");

  const record = await deps.interfaceTests.read(input.interfaceTestRecordId);
  const testRecord = interfaceTestRecordSchema.parse(record);
  if (testRecord.interfaceKind !== "same-material-layer" && testRecord.interfaceKind !== "dissimilar-material-bond") {
    throw new Error("Unsupported material interface test kind");
  }
  if (testRecord.interfaceKind !== "same-material-layer") {
    throw new Error("Cohesive strength analysis currently supports only same-material printed-layer interfaces");
  }
  if (input.initialStiffnessEvidence?.materialProcess
    && !sameMaterialCouponProcess(input.initialStiffnessEvidence.materialProcess, testRecord.materialAProcess)) {
    throw new Error("Cohesive K evidence must match the exact same-material process recorded by the DCB/ENF/MMB interface tests");
  }
  if (testRecord.materialAProcess.layerHeightMm === undefined || testRecord.materialBProcess.layerHeightMm === undefined) {
    throw new Error("Cohesive analysis requires the measured slicer layer height on both sides of the same-material test");
  }
  const exactCouponProcess = testRecord.materialAProcess as MaterialCouponProcess & { layerHeightMm: number };
  if (input.layerPlanePlan && input.layerPlanePlan.processProfileHash !== testRecord.materialAProcess.profileHash) {
    throw new Error("Layer-plane plan profile hash must match the exact process profile of the measured interface test");
  }
  if (input.layerPlanePlan) {
    const measuredLayerHeightMm = testRecord.materialAProcess.layerHeightMm;
    if (measuredLayerHeightMm === undefined) {
      throw new Error("Layer-plane analysis requires the exact slicer layer height to be recorded with the measured interface-test process");
    }
    if (Math.abs(input.layerPlanePlan.layerHeightMm - measuredLayerHeightMm) > 1e-6) {
      throw new Error("Layer-plane plan layer height must match the exact process profile recorded with the measured interface test");
    }
  }
  if (angleBetweenNormals(testRecord.interfaceNormalGlobal, input.splitPlanes[0]!.normalGlobal) > Math.PI / 180) {
    throw new Error("Split-plane normal must align with the measured physical interface normal within one degree");
  }
  if (testRecord.fractureMethod !== "dcb-mode-i") {
    throw new Error("Mode-I cohesive analysis requires a DCB Mode-I physical fracture-test record; direct normal-tension strength is insufficient");
  }
  // Direct force-over-area records provide a nominal specimen strength only.
  // Fail before STEP export or meshing unless an analysis-ready DCB traction curve exists.
  analyzeMaterialInterfaceTestCurve(testRecord);
  let measuredTuronCalibration: TuronPhysicalCalibrationResult | undefined;
  if (input.modeIIRecordId && input.mixedModeRecordIds && input.initialStiffnessMPaPerMm !== undefined
    && input.initialStiffnessEvidence && input.prescribedDisplacementGlobalMm) {
    measuredTuronCalibration = await calibrateTuronCandidateFromInterfaceTests(deps.interfaceTests, {
      modeIRecordId: input.interfaceTestRecordId,
      modeIIRecordId: input.modeIIRecordId,
      mixedModeRecordIds: input.mixedModeRecordIds,
    });
    const modeIIRecord = await deps.interfaceTests.read(input.modeIIRecordId);
    assertTuronDisplacementMatchesMeasuredShear(
      input.prescribedDisplacementGlobalMm,
      measuredTuronCalibration.interfaceNormalGlobal,
      modeIIRecord.loadDirectionGlobal,
    );
    if (angleBetweenNormals(measuredTuronCalibration.interfaceNormalGlobal, input.splitPlanes[0]!.normalGlobal) > Math.PI / 180) {
      throw new Error("Split-plane normal must align with the measured DCB/ENF/MMB interface normal within one degree");
    }
  }
  const couponMatch = await deps.coupons.match({ process: exactCouponProcess });
  if (couponMatch.status !== "matched" || !couponMatch.selected) throw new Error(`No unambiguous exact-process single-material coupon is available: ${couponMatch.reasons.join("; ")}`);
  const coupon = couponMatch.selected;
  assertCouponPoissonRatio(coupon, input.poissonRatio, input.poissonRatioEvidence);
  if (input.useOrthotropicBulkProperties) {
    const material = coupon.orthotropicMaterial;
    if (!material) throw new Error("Orthotropic cohesive analysis requires orthotropic properties in the exact-process single-material coupon record");
    if (input.layerPlanePlan && angleBetweenNormals(input.layerPlanePlan.buildDirectionGlobal, material.orientation.buildDirectionGlobal) > Math.PI / 180) {
      throw new Error("Layer-plane direction must align with the exact-process coupon's confirmed print build direction within one degree");
    }
    const invalid = orthotropicElasticConstantsError({
      youngsModulusMPa: coupon.properties.youngModulusMPa, youngsModulus2MPa: material.youngsModulus2MPa, youngsModulus3MPa: material.youngsModulus3MPa,
      poissonRatio12: input.poissonRatio, poissonRatio13: material.poissonRatio13, poissonRatio23: material.poissonRatio23,
      shearModulus12MPa: material.shearModulus12MPa, shearModulus13MPa: material.shearModulus13MPa, shearModulus23MPa: material.shearModulus23MPa,
    });
    if (invalid) throw new Error(`Single-material orthotropic tensor is invalid: ${invalid}`);
  }

  if (input.splitPlanes.length > 1 && testRecord.interfaceKind !== "same-material-layer") {
    throw new Error("Multiple cohesive split planes are currently supported only for one measured same-material layer process");
  }
  const normal = input.splitPlanes[0]!.normalGlobal;
  const firstPlane = input.splitPlanes[0]!;
  const lastPlane = input.splitPlanes[input.splitPlanes.length - 1]!;
  const supportOffset = dot(subtract(supportFace.centerMm, firstPlane.pointMm), normal);
  const loadedOffset = dot(subtract(loadedFace.centerMm, lastPlane.pointMm), normal);
  if (supportOffset >= -1e-6 || loadedOffset <= 1e-6) {
    throw new Error("Cohesive support must lie below the first split plane and the loaded face above the last plane along their shared normal");
  }
  throwIfAborted(signal);
  const stepPath = join(workspace, "native-solid.step");
  await operations.exportStep([body.id], stepPath, input.revision);
  const faceReference = (face: typeof supportFace) => ({
    faceId: face.id,
    surfaceType: face.surfaceType,
    centerMm: face.centerMm,
    normal: face.normal,
    boundsMm: face.boundsMm,
  });
  const meshResult = await (deps.generateMesh ?? generateCohesiveMeshFromStep)({
    stepPath,
    outputPath: join(workspace, "cohesive.msh"),
    splitPlanes: input.splitPlanes,
    meshSizeMm: input.meshSizeMm,
    boundaryFaces: [faceReference(supportFace), faceReference(loadedFace)],
    ...(input.layerPlanePlan.roadAxisMapping ? { layerwiseRegions: true } : {}),
  }, signal);
  const preSolverState = await operations.state();
  if (preSolverState.documentToken !== initial.documentToken || preSolverState.revision !== initial.revision
    || !preSolverState.bodies.some((candidate) => candidate.id === body.id)) {
    throw new Error("Plasticity document changed during cohesive meshing; Code_Aster was not started");
  }
  const supportGroup = meshResult.boundaryGroups.find((group) => group.faceId === input.supportFaceId);
  const loadGroup = meshResult.boundaryGroups.find((group) => group.faceId === input.loadedFaceId);
  if (!supportGroup || !loadGroup) throw new Error("Cohesive mesh is missing a requested native support or load face mapping");
  const layerwiseOrthotropicRegions = input.layerPlanePlan.roadAxisMapping
    ? (() => {
      const frames = confirmedLayerOrthotropicFrames(input.layerPlanePlan!);
      const groups = meshResult.layerRegionGroups;
      if (!frames || !groups || frames.length !== groups.length || groups.length !== input.layerPlanePlan.totalLayerCount) {
        throw new Error("Layerwise cohesive mesh groups do not match the complete confirmed deposition-layer direction schedule");
      }
      return groups.map((group, index) => {
        const frame = frames[index];
        if (!frame || frame.layerIndex !== group.layerIndex || group.layerIndex !== index + 1) {
          throw new Error(`No mapped G-code road direction is available for printed layer ${index + 1}`);
        }
        return {
          layerIndex: group.layerIndex,
          grid: group.name,
          orientation: frame.orientation,
        };
      });
    })()
    : undefined;

  const negativeCoupon = coupon;
  const positiveCoupon = coupon;
  const modeIDeck = buildCodeAsterCohesiveDeckFromTestRecord({
    record: testRecord,
    materialAGrid: "GM1",
    materialBGrid: "GM2",
    supportFaceGroup: supportGroup.name,
    loadedFaceGroup: loadGroup.name,
    cohesiveElementGroup: `GM${meshResult.cohesiveVolumeTag}`,
    materialA: { youngsModulusMPa: coupon.properties.youngModulusMPa, poissonRatio: input.poissonRatio },
    materialB: { youngsModulusMPa: coupon.properties.youngModulusMPa, poissonRatio: input.poissonRatio },
    ...(input.useOrthotropicBulkProperties && coupon.orthotropicMaterial ? {
      orthotropicMaterialA: orthotropicDeckMaterial(coupon.orthotropicMaterial),
      orthotropicMaterialB: orthotropicDeckMaterial(coupon.orthotropicMaterial),
    } : {}),
    ...(layerwiseOrthotropicRegions ? { layerwiseOrthotropicRegions } : {}),
    modeILaw: input.modeILaw,
    interfaceNormalGlobal: normal,
    displacementDirectionGlobal: normal,
    increments: input.increments,
    adherencePenalty: input.adherencePenalty,
  });
  throwIfAborted(signal);
  let solver: RunCodeAsterCohesiveCaseResult | RunCodeAsterTuronCaseResult;
  let turonCalibration: CohesiveAnalysisResult["turonCalibration"];
  if (measuredTuronCalibration && input.initialStiffnessMPaPerMm !== undefined
    && input.initialStiffnessEvidence && input.prescribedDisplacementGlobalMm) {
    const turonDeck = codeAsterTuronDeckInputFromCalibration(measuredTuronCalibration, {
      materialAGrid: "GM1",
      materialBGrid: "GM2",
      supportFaceGroup: supportGroup.name,
      loadedFaceGroup: loadGroup.name,
      cohesiveElementGroup: `GM${meshResult.cohesiveVolumeTag}`,
      materialA: { youngsModulusMPa: coupon.properties.youngModulusMPa, poissonRatio: input.poissonRatio },
      materialB: { youngsModulusMPa: coupon.properties.youngModulusMPa, poissonRatio: input.poissonRatio },
      ...(input.useOrthotropicBulkProperties && coupon.orthotropicMaterial ? {
        orthotropicMaterialA: orthotropicDeckMaterial(coupon.orthotropicMaterial),
        orthotropicMaterialB: orthotropicDeckMaterial(coupon.orthotropicMaterial),
      } : {}),
      ...(layerwiseOrthotropicRegions ? { layerwiseOrthotropicRegions } : {}),
      stiffnessMPaPerMm: input.initialStiffnessMPaPerMm,
      residualStiffnessRatio: input.residualStiffnessRatio,
      interfaceNormalGlobal: normal,
      prescribedDisplacementGlobalMm: input.prescribedDisplacementGlobalMm,
      increments: input.increments,
    });
    solver = await (deps.runTuronSolver ?? runCodeAsterTuronCase)({ workspacePath: workspace, deck: turonDeck, ...(signal ? { signal } : {}) });
    turonCalibration = {
      calibration: measuredTuronCalibration,
      initialStiffnessMPaPerMm: input.initialStiffnessMPaPerMm,
      initialStiffnessEvidence: input.initialStiffnessEvidence,
    };
  } else {
    solver = await (deps.runSolver ?? runCodeAsterCohesiveCase)({ workspacePath: workspace, deck: modeIDeck.deckInput, ...(signal ? { signal } : {}) });
  }
  const finalState = await operations.state();
  const binding: CadBinding = {
    sessionId: operations.datumRegistry.sessionId,
    documentToken: initial.documentToken,
    revision: initial.revision,
    bodyId: body.id,
  };
  if (finalState.documentToken !== binding.documentToken || finalState.revision !== binding.revision
    || !finalState.bodies.some((candidate) => candidate.id === binding.bodyId)) {
    throw new Error("Plasticity document changed during cohesive FEA; the solver response was not bound to the current model");
  }
  const meshSha256 = createHash("sha256").update(await readFile(meshResult.outputPath)).digest("hex");
  const { cohesiveElementIds: _cohesiveElementIds, outputPath: _outputPath, ...meshSummary } = meshResult;
  return {
    binding,
    bodyName: body.name,
    input,
    physicalTest: {
      recordId: modeIDeck.recordId,
      interfaceKind: testRecord.interfaceKind,
      materialAProcess: testRecord.materialAProcess,
      materialBProcess: testRecord.materialBProcess,
      curveSourceHash: modeIDeck.sourceHash,
      curveSourceLocator: modeIDeck.sourceLocator,
      measuredCurveSummary: modeIDeck.curveSummary,
    },
    couponRecordIds: { materialA: coupon.id, materialB: coupon.id },
    materialAssignment: {
      negativeSide: {
        testMaterial: "A",
        process: negativeCoupon.process,
        couponRecordId: negativeCoupon.id,
        youngsModulusMPa: negativeCoupon.properties.youngModulusMPa,
        poissonRatio: input.poissonRatio,
        poissonRatioEvidence: input.poissonRatioEvidence,
        ...(input.useOrthotropicBulkProperties && negativeCoupon.orthotropicMaterial ? { orthotropicMaterial: negativeCoupon.orthotropicMaterial } : {}),
      },
      positiveSide: {
        testMaterial: "B",
        process: positiveCoupon.process,
        couponRecordId: positiveCoupon.id,
        youngsModulusMPa: positiveCoupon.properties.youngModulusMPa,
        poissonRatio: input.poissonRatio,
        poissonRatioEvidence: input.poissonRatioEvidence,
        ...(input.useOrthotropicBulkProperties && positiveCoupon.orthotropicMaterial ? { orthotropicMaterial: positiveCoupon.orthotropicMaterial } : {}),
      },
    },
    mesh: {
      ...meshSummary,
      meshSha256,
    },
    solver,
    ...(turonCalibration ? { turonCalibration } : {}),
    ...(layerPlan ? {
      layerInterfaceCoverage: layerPlan.coverage,
      layerInterfaceLimitation: layerPlan.limitation,
    } : {}),
    interpretation: "cohesive-solver-response-only",
    strengthPass: false,
    printApproved: false,
  };
}

function orthotropicDeckMaterial(material: NonNullable<MaterialCouponQualificationRecord["orthotropicMaterial"]>): OrthotropicCaseMaterial {
  return {
    youngsModulus2MPa: material.youngsModulus2MPa, youngsModulus3MPa: material.youngsModulus3MPa,
    poissonRatio13: material.poissonRatio13, poissonRatio23: material.poissonRatio23,
    shearModulus12MPa: material.shearModulus12MPa, shearModulus13MPa: material.shearModulus13MPa,
    shearModulus23MPa: material.shearModulus23MPa,
    orientation: {
      axis1DirectionGlobal: material.orientation.axis1DirectionGlobal,
      axis2ReferenceDirectionGlobal: material.orientation.axis2ReferenceDirectionGlobal,
      buildDirectionGlobal: material.orientation.buildDirectionGlobal,
    },
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Cohesive FEA analysis was cancelled");
}

function dot(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function angleBetweenNormals(a: [number, number, number], b: [number, number, number]): number {
  return Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
}

function subtract(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
