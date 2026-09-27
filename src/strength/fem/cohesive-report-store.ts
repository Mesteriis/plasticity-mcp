import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { CadBinding } from "../contracts.ts";
import { exactMaterialCouponProcessSchema, materialCouponProcessSchema, orthotropicMaterialSchema } from "../material-qualification.ts";
import { evidenceSchema } from "../schemas.ts";
import { turonStoredPhysicalCalibrationResultSchema } from "./code-aster-turon-physical-calibration.ts";
import { MAX_LAYER_INTERFACE_PLANES, MAX_LAYERWISE_FEA_LAYERS, createCohesiveLayerPlanePlan } from "./layer-plane-plan.ts";
import { cohesiveStoredAnalysisInputSchema, type CohesiveAnalysisResult } from "./cohesive-analysis.ts";

const finite = z.number().finite();
const range = z.object({ min: finite, max: finite }).strict().refine(({ min, max }) => min <= max);
const bindingSchema = z.object({
  sessionId: z.string().min(1), documentToken: z.string().min(1), revision: z.string().min(1), bodyId: z.number().int().positive(),
}).strict();
const codeAsterResultsSchema = z.object({
  solverVersion: z.string().min(1),
  displacementHistory: z.array(z.object({ order: z.number().int().nonnegative(), time: finite, minMm: finite, maxMm: finite }).strict()).min(1).max(1001),
  reactionHistory: z.array(z.object({ order: z.number().int().nonnegative(), time: finite, xN: finite, yN: finite, zN: finite }).strict()).min(1).max(1001),
  interfaceStateHistory: z.array(z.object({
    order: z.number().int().nonnegative(), time: finite, elementCount: z.number().int().positive(),
    variables: z.object({ V3: range, V7: range, V8: range, V9: range }).strict(),
  }).strict()).min(1).max(1001),
  v3Interpretation: z.enum(["damage-variable-0-to-1", "state-variable-2-means-fully-broken"]).optional(),
  interpretation: z.literal("raw-cohesive-solver-response"),
}).strict();
const meshResolutionSchema = z.object({
  maximumCohesiveEdgeMm: finite.positive(), recommendedElementsAcrossZone: z.literal(5),
  materialEstimates: z.array(z.object({
    material: z.enum(["A", "B"]), indicativeProcessZoneLengthMm: finite.positive(), estimatedElementsAcrossZone: finite.positive(),
  }).strict()).length(2),
  status: z.enum(["meets-indicative-five-element-screen", "below-indicative-five-element-screen"]), interpretation: z.string().min(1),
}).strict();
const codeAsterSolverSchema = z.object({
  solver: z.enum(["Code_Aster 15.2.0", "Code_Aster 17.4.0"]), imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  result: codeAsterResultsSchema, meshResolution: meshResolutionSchema,
  limitations: z.array(z.string().min(1)).max(100), diagnostics: z.array(z.string().max(10_000)).max(20),
}).strict();
const turonSolverSchema = z.object({
  solver: z.literal("Code_Aster 17.4.0"), imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  finalTime: finite, maxDamageV3: finite.nonnegative(), maxStateV5: finite.nonnegative(),
  damageHistory: z.array(z.object({ order: z.number().int().nonnegative(), time: finite, maxDamageV3: finite.nonnegative(), maxStateV5: finite.nonnegative() }).strict()).min(2).max(1001),
  medSha256: z.string().regex(/^[a-f0-9]{64}$/), medBytes: z.number().int().positive(),
  interpretation: z.literal("raw-mixed-mode-cohesive-solver-response"),
  limitations: z.array(z.string().min(1)).max(100), diagnostics: z.array(z.string().max(10_000)).max(20),
}).strict();
const solverSchema = z.union([codeAsterSolverSchema, turonSolverSchema]);
const stiffnessEvidenceSchema = evidenceSchema.extend({ unit: z.literal("MPa/mm"), materialProcess: exactMaterialCouponProcessSchema.optional() }).superRefine((evidence, context) => {
  if ((evidence.status !== "measured" && evidence.status !== "sourced") || evidence.value === undefined
    || !evidence.sourceUrl || !evidence.sourceLocator || !evidence.sourceHash || !/^[a-f0-9]{64}$/.test(evidence.sourceHash)) {
    context.addIssue({ code: "custom", message: "Stored cohesive K evidence must be measured/sourced and traceable" });
  }
});
const processAssignmentSchema = z.object({
  testMaterial: z.enum(["A", "B"]), process: materialCouponProcessSchema,
  couponRecordId: z.string().regex(/^[a-f0-9]{64}$/), youngsModulusMPa: finite.positive(), poissonRatio: finite.gt(-1).lt(0.5),
  poissonRatioEvidence: evidenceSchema.extend({ unit: z.literal("ratio") }),
  orthotropicMaterial: orthotropicMaterialSchema.optional(),
}).strict();
const analysisResultSchema = z.object({
  binding: bindingSchema, bodyName: z.string().nullable(), input: cohesiveStoredAnalysisInputSchema,
  physicalTest: z.object({
    recordId: z.string().regex(/^[a-f0-9]{64}$/), interfaceKind: z.enum(["same-material-layer", "dissimilar-material-bond"]),
    materialAProcess: materialCouponProcessSchema, materialBProcess: materialCouponProcessSchema,
    curveSourceHash: z.string().regex(/^[a-f0-9]{64}$/), curveSourceLocator: z.string().min(1),
    measuredCurveSummary: z.object({
      mode: z.literal("normal-tension"), sourceHash: z.string().regex(/^[a-f0-9]{64}$/), sourceLocator: z.string().min(1),
      peakStrengthMPa: finite.positive(), peakSeparationMm: finite.nonnegative(), initialSegmentStiffnessMPaPerMm: finite.positive(),
      fractureEnergyNPerMm: finite.positive(), finalSeparationMm: finite.positive(),
      interpretation: z.literal("measured-curve-summary-only"), limitations: z.array(z.string().min(1)).max(100),
    }).strict(),
  }).strict(),
  couponRecordIds: z.object({ materialA: z.string().regex(/^[a-f0-9]{64}$/), materialB: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  materialAssignment: z.object({ negativeSide: processAssignmentSchema, positiveSide: processAssignmentSchema }).strict(),
  mesh: z.object({
    gmshVersion: z.string().min(1), volumeCount: z.number().int().min(2).max(MAX_LAYERWISE_FEA_LAYERS), interfaceSurfaceCount: z.number().int().positive(),
    splitPlanes: z.array(z.object({ pointMm: z.tuple([finite, finite, finite]), normalGlobal: z.tuple([finite, finite, finite]) }).strict()).min(1).max(MAX_LAYER_INTERFACE_PLANES),
    interfaceSurfaceGroups: z.array(z.object({
      planeIndex: z.number().int().nonnegative(), physicalTag: z.number().int().positive(),
      surfaceEntityTags: z.array(z.number().int().positive()).min(1), triangleCount: z.number().int().positive(),
    }).strict()).min(1).max(MAX_LAYER_INTERFACE_PLANES),
    meshSizeMm: finite.positive(), materialATetrahedronCount: z.number().int().positive().optional(), materialBTetrahedronCount: z.number().int().positive().optional(),
    cohesiveVolumeTag: z.number().int().positive().max(999999).optional(),
    layerwiseRegions: z.boolean().optional(),
    layerRegionGroups: z.array(z.object({
      layerIndex: z.number().int().positive(), physicalTag: z.number().int().positive(),
      name: z.string().min(1), tetrahedronCount: z.number().int().positive(),
    }).strict()).min(2).max(MAX_LAYERWISE_FEA_LAYERS).optional(),
    interfaceTriangleCount: z.number().int().positive(), duplicatedNodeCount: z.number().int().positive(), cohesiveElementCount: z.number().int().positive(),
    boundaryGroups: z.array(z.object({ faceId: z.string().min(1), physicalTag: z.number().int().positive(), name: z.string().min(1), surfaceEntityTag: z.number().int().positive() }).strict()).min(2).max(2),
    meshSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  solver: solverSchema,
  turonCalibration: z.object({
    calibration: turonStoredPhysicalCalibrationResultSchema,
    initialStiffnessMPaPerMm: finite.positive(), initialStiffnessEvidence: stiffnessEvidenceSchema,
  }).strict().optional(),
  layerInterfaceCoverage: z.enum(["all-layer-interfaces", "selected-interfaces-only"]).optional(),
  layerInterfaceLimitation: z.string().min(1).optional(),
  interpretation: z.literal("cohesive-solver-response-only"), strengthPass: z.literal(false), printApproved: z.literal(false),
}).strict().superRefine((report, context) => {
  if (report.input.layerPlanePlan) {
    const plan = createCohesiveLayerPlanePlan(report.input.layerPlanePlan);
    if (report.input.layerPlanePlan.processProfileHash !== report.physicalTest.materialAProcess.profileHash) {
      context.addIssue({ code: "custom", path: ["input", "layerPlanePlan", "processProfileHash"], message: "Layer-plane plan profile hash must match the measured interface process" });
    }
    const measuredLayerHeightMm = report.physicalTest.materialAProcess.layerHeightMm;
    if (measuredLayerHeightMm === undefined || Math.abs(report.input.layerPlanePlan.layerHeightMm - measuredLayerHeightMm) > 1e-6) {
      context.addIssue({ code: "custom", path: ["input", "layerPlanePlan", "layerHeightMm"], message: "Layer-plane plan layer height must match the exact process profile recorded with the measured interface test" });
    }
    if (report.layerInterfaceCoverage !== plan.coverage || report.layerInterfaceLimitation !== plan.limitation) {
      context.addIssue({ code: "custom", path: ["layerInterfaceCoverage"], message: "Layer-interface coverage summary must match the recorded layer-plane plan" });
    }
    if (plan.planes.length !== report.mesh.splitPlanes.length || plan.planes.some((planned, index) => {
      const meshed = report.mesh.splitPlanes[index];
      return !meshed || planned.pointMm.some((coordinate, axis) => Math.abs(coordinate - meshed.pointMm[axis]!) > 1e-9)
        || planned.normalGlobal.some((coordinate, axis) => Math.abs(coordinate - meshed.normalGlobal[axis]!) > 1e-9);
    })) {
      context.addIssue({ code: "custom", path: ["mesh", "splitPlanes"], message: "Recorded mesh planes must match the profile-bound layer-plane plan" });
    }
    if (report.input.useOrthotropicBulkProperties
      && report.materialAssignment.negativeSide.orthotropicMaterial
      && report.input.layerPlanePlan.buildDirectionGlobal.reduce((sum, value, axis) =>
        sum + value * report.materialAssignment.negativeSide.orthotropicMaterial!.orientation.buildDirectionGlobal[axis]!, 0) < Math.cos(Math.PI / 180)) {
      context.addIssue({ code: "custom", path: ["input", "layerPlanePlan", "buildDirectionGlobal"], message: "Layer-plane direction must match the exact-process coupon build direction" });
    }
  } else if (report.layerInterfaceCoverage !== undefined || report.layerInterfaceLimitation !== undefined) {
    context.addIssue({ code: "custom", path: ["layerInterfaceCoverage"], message: "Layer-interface coverage requires a stored layer-plane plan" });
  }
  const negativeSide = report.materialAssignment.negativeSide;
  const positiveSide = report.materialAssignment.positiveSide;
  if (report.physicalTest.interfaceKind !== "same-material-layer"
    || JSON.stringify(report.physicalTest.materialAProcess) !== JSON.stringify(report.physicalTest.materialBProcess)
    || report.couponRecordIds.materialA !== report.couponRecordIds.materialB
    || negativeSide.youngsModulusMPa !== positiveSide.youngsModulusMPa
    || negativeSide.poissonRatio !== positiveSide.poissonRatio
    || JSON.stringify(negativeSide.process) !== JSON.stringify(positiveSide.process)
    || negativeSide.couponRecordId !== positiveSide.couponRecordId
    || JSON.stringify(negativeSide.orthotropicMaterial ?? null) !== JSON.stringify(positiveSide.orthotropicMaterial ?? null)) {
    context.addIssue({ code: "custom", path: ["materialAssignment"], message: "Cohesive reports must represent one printed material with identical exact-process properties and print axes on both sides" });
  }
  if (report.mesh.volumeCount !== report.mesh.splitPlanes.length + 1
    || report.mesh.interfaceSurfaceGroups.length !== report.mesh.splitPlanes.length) {
    context.addIssue({ code: "custom", path: ["mesh"], message: "Cohesive mesh region and interface counts must match the ordered split planes" });
  }
  const interfaceTagBase = report.mesh.layerwiseRegions
    ? Math.max(3, report.mesh.splitPlanes.length + 2)
    : 3;
  const expectedInterfaceGroups = report.mesh.interfaceSurfaceGroups.every((group, index) =>
    group.planeIndex === index && group.physicalTag === interfaceTagBase + index);
  const interfaceSurfaceIds = report.mesh.interfaceSurfaceGroups.flatMap((group) => group.surfaceEntityTags);
  if (!expectedInterfaceGroups || new Set(interfaceSurfaceIds).size !== interfaceSurfaceIds.length
    || report.mesh.interfaceSurfaceGroups.reduce((sum, group) => sum + group.triangleCount, 0) !== report.mesh.interfaceTriangleCount
    || interfaceSurfaceIds.length !== report.mesh.interfaceSurfaceCount) {
    context.addIssue({ code: "custom", path: ["mesh", "interfaceSurfaceGroups"], message: "Cohesive interface groups must uniquely and completely describe the recorded mesh interfaces" });
  }
  if (report.mesh.layerwiseRegions === true
    && (report.mesh.layerRegionGroups?.length !== report.mesh.volumeCount
      || report.mesh.layerRegionGroups.some((group, index) => group.layerIndex !== index + 1 || group.physicalTag !== index + 1 || group.name !== `GM${index + 1}`))) {
    context.addIssue({ code: "custom", path: ["mesh", "layerRegionGroups"], message: "Layerwise mesh must report every ordered layer volume group exactly once" });
  }
  const isTuron = Boolean(report.turonCalibration);
  if ("result" in report.solver && report.solver.result.v3Interpretation !== undefined) {
    const expectedV3Interpretation = report.input.modeILaw === "CZM_LIN_REG"
      ? "state-variable-2-means-fully-broken"
      : "damage-variable-0-to-1";
    if (report.solver.result.v3Interpretation !== expectedV3Interpretation) {
      context.addIssue({ code: "custom", path: ["solver", "result", "v3Interpretation"], message: "Cohesive V3 interpretation must match the recorded Code_Aster Mode-I law" });
    }
  }
  const usesCodeAster17 = report.solver.solver === "Code_Aster 17.4.0";
  if (Boolean(report.input.modeIIRecordId) !== isTuron || Boolean(report.input.mixedModeRecordIds) !== isTuron) {
    context.addIssue({ code: "custom", path: ["input"], message: "Mixed-mode test references must match the selected solver route" });
  }
  if (usesCodeAster17 !== (isTuron || Boolean(report.input.useOrthotropicBulkProperties))) {
    context.addIssue({ code: "custom", path: ["solver"], message: "Code_Aster 17.4 is required for Turon or orthotropic cohesive analysis; isotropic Mode-I uses Code_Aster 15.2" });
  }
  const assignmentHasOrthotropy = Boolean(report.materialAssignment.negativeSide.orthotropicMaterial)
    && Boolean(report.materialAssignment.positiveSide.orthotropicMaterial);
  if (Boolean(report.input.useOrthotropicBulkProperties) !== assignmentHasOrthotropy) {
    context.addIssue({ code: "custom", path: ["materialAssignment"], message: "Orthotropic report inputs must match both persisted material-side records" });
  }
});

const storedReportSchema = analysisResultSchema.extend({
  id: z.string().uuid(), createdAt: z.iso.datetime(),
});

export type StoredCohesiveReport = z.infer<typeof storedReportSchema>;
export type CohesiveReportContent = CohesiveAnalysisResult;

export class CohesiveReportStore {
  private readonly root: string;

  constructor(root = join(process.cwd(), ".plasticity-mcp", "strength")) {
    this.root = join(root, "cohesive-reports");
  }

  async save(content: CohesiveReportContent): Promise<StoredCohesiveReport> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const report = storedReportSchema.parse({ ...content, id: randomUUID(), createdAt: new Date().toISOString() });
    const handle = await open(this.path(report.id), "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return structuredClone(report);
  }

  async read(reportId: string): Promise<StoredCohesiveReport> {
    if (!/^[0-9a-f-]{36}$/i.test(reportId)) throw new Error("Invalid cohesive report ID");
    const handle = await open(this.path(reportId), constants.O_RDONLY | constants.O_NOFOLLOW);
    let value: unknown;
    try {
      if ((await handle.stat()).size > 64 * 1024 * 1024) throw new Error("Stored cohesive report exceeds 64 MiB");
      value = JSON.parse(await handle.readFile("utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`Invalid stored cohesive report: ${reportId}`);
      throw error;
    } finally {
      await handle.close();
    }
    return structuredClone(storedReportSchema.parse(value));
  }

  private path(reportId: string): string {
    return join(this.root, `${reportId}.json`);
  }
}
