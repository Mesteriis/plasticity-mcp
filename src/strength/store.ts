import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";

import { CODEX_ERROR_CATEGORIES, type AnalysisFailureDiagnostics, type AnalysisResult, type Calculation, type StrengthInput } from "./contracts.ts";
import { hashStrengthInput } from "./calculate.ts";
import { analysisResultSchema, cadBindingSchema, strengthInputSchema } from "./schemas.ts";
import type { SectionCalculation, SectionScenarioInput } from "./section-contracts.ts";
import { hashSectionInput } from "./section-calculate.ts";
import { sectionScenarioInputSchema } from "./section-schemas.ts";
import type { FastenerCalculation, FastenerScenarioInput } from "./fastener-contracts.ts";
import { hashFastenerInput } from "./fastener-calculate.ts";
import { fastenerScenarioInputSchema } from "./fastener-schemas.ts";
import type { FastenerMemberCalculation, FastenerMemberInput } from "./fastener-member-contracts.ts";
import { hashFastenerMemberInput } from "./fastener-member-calculate.ts";
import { fastenerMemberInputSchema } from "./fastener-member-schemas.ts";
import type { ThreadedReceiverCalculation, ThreadedReceiverInput } from "./threaded-receiver-contracts.ts";
import { hashThreadedReceiverInput } from "./threaded-receiver-calculate.ts";
import { threadedReceiverInputSchema } from "./threaded-receiver-schemas.ts";
import type { InsertRetentionCalculation, InsertRetentionInput } from "./insert-retention-contracts.ts";
import { hashInsertRetentionInput } from "./insert-retention-calculate.ts";
import { insertRetentionInputSchema } from "./insert-retention-schemas.ts";
import type { FastenerGroupCalculation, FastenerGroupInput } from "./fastener-group-contracts.ts";
import { hashFastenerGroupInput } from "./fastener-group-calculate.ts";
import { fastenerGroupInputSchema } from "./fastener-group-schemas.ts";
import type { TongueRootCalculation, TongueRootInput } from "./tongue-root-contracts.ts";
import { hashTongueRootInput } from "./tongue-root-calculate.ts";
import { tongueRootInputSchema } from "./tongue-root-schemas.ts";
import type { SectionStrengthScanRecord, StoredSectionStrengthScan } from "./section-scan-contracts.ts";
import { sectionBindingSchema } from "./section-schemas.ts";
import { MaterialCouponQualificationStore } from "./material-qualification.ts";
import { FastenerGroupTestStore } from "./fastener-group-test.ts";
import { InterfaceTestStore } from "./interface-test.ts";
import { DcbModeIEnergyTestStore } from "./dcb-mode-i-energy-store.ts";
import { EnfModeIIEnergyTestStore } from "./enf-mode-ii-energy-store.ts";
import { MmbModeIEnergyTestStore } from "./mmb-mode-i-ii-energy-store.ts";
import type { FastenerGroupPlateBearingCalculation, FastenerGroupPlateBearingInput } from "./fastener-group-plate-calculate.ts";
import { hashFastenerGroupPlateBearingBinding } from "./fastener-group-plate-calculate.ts";
import { fastenerGroupPlateBearingInputSchema } from "./fastener-group-plate-schemas.ts";

export interface StoredRectangularReport {
  id: string;
  createdAt: string;
  input: StrengthInput;
  result: Calculation;
}

export interface StoredSectionReport {
  kind: "planar-section";
  id: string;
  createdAt: string;
  input: SectionScenarioInput;
  result: SectionCalculation;
}

export interface StoredFastenerReport {
  kind: "single-fastener-plate";
  id: string;
  createdAt: string;
  input: FastenerScenarioInput;
  result: FastenerCalculation;
}

export interface StoredFastenerMemberReport {
  kind: "fastener-member";
  id: string;
  createdAt: string;
  input: FastenerMemberInput;
  result: FastenerMemberCalculation;
}

export interface StoredInsertRetentionReport {
  kind: "heat-set-insert-retention";
  id: string;
  createdAt: string;
  input: InsertRetentionInput;
  result: InsertRetentionCalculation;
}

export interface StoredThreadedReceiverReport {
  kind: "threaded-receiver";
  id: string;
  createdAt: string;
  input: ThreadedReceiverInput;
  result: ThreadedReceiverCalculation;
}

export interface StoredFastenerGroupReport {
  kind: "fastener-group-load";
  id: string;
  createdAt: string;
  input: FastenerGroupInput;
  result: FastenerGroupCalculation;
}

export interface StoredFastenerGroupPlateBearingReport {
  kind: "fastener-group-plate-bearing";
  id: string;
  createdAt: string;
  input: FastenerGroupPlateBearingInput;
  result: FastenerGroupPlateBearingCalculation;
}

export interface StoredTongueRootReport {
  kind: "tongue-root";
  id: string;
  createdAt: string;
  input: TongueRootInput;
  result: TongueRootCalculation;
}

export type StoredReport = StoredRectangularReport | StoredSectionReport | StoredFastenerReport | StoredFastenerMemberReport | StoredThreadedReceiverReport | StoredInsertRetentionReport | StoredFastenerGroupReport | StoredFastenerGroupPlateBearingReport | StoredTongueRootReport;
export type ReportInput = StrengthInput | SectionScenarioInput | FastenerScenarioInput | FastenerMemberInput | ThreadedReceiverInput | InsertRetentionInput | FastenerGroupInput | TongueRootInput;

export interface ReportView {
  report: StoredReport;
  freshness: "current" | "stale" | "unverified";
  reasons: string[];
}

export interface RequestRecord {
  id: string;
  inputHash: string;
  state: "requested" | "completed" | "failed" | "interrupted";
  result?: AnalysisResult;
  errorCode?: string;
  failureDiagnostics?: AnalysisFailureDiagnostics;
}

interface InternalRequestRecord extends RequestRecord {
  owner?: { pid: number; nonce: string };
}

const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const vector3StoreSchema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const MAX_SECTION_SCAN_REPORT_BYTES = 16 * 1024 * 1024;
const issueSchema = z.object({ code: z.string().min(1), message: z.string().min(1), evidenceIds: z.array(z.string().min(1)) }).strict();
const calculationSchema = z.object({
  status: z.enum(["needs-input", "unsupported", "conditional", "pass", "fail"]),
  method: z.enum(["axial-rectangle-v1", "cantilever-tip-rectangle-v1", "simply-supported-plate-uniform-pressure-v1", "euler-column-buckling-v1"]),
  methodVersion: z.string().min(1),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  checkedScope: z.string().min(1),
  stressMPa: z.number().finite().optional(),
  displacementMm: z.number().finite().optional(),
  strengthUtilization: z.number().finite().optional(),
  displacementUtilization: z.number().finite().optional(),
  plate: z.object({
    flexuralRigidityNmm: z.number().finite().positive(),
    centerMomentsN: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
    centerSurfaceStressMPa: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
    seriesMaxOddIndex: z.number().int().positive(),
  }).strict().optional(),
  buckling: z.object({
    areaMm2: z.number().finite().positive(),
    secondMomentMm4: z.number().finite().positive(),
    radiusOfGyrationMm: z.number().finite().positive(),
    effectiveLengthMm: z.number().finite().positive(),
    slendernessRatio: z.number().finite().positive(),
    elasticTransitionSlenderness: z.number().finite().positive(),
    criticalLoadN: z.number().finite().positive(),
    criticalStressMPa: z.number().finite().positive(),
    appliedCompressiveStressMPa: z.number().finite().nonnegative(),
    bucklingUtilization: z.number().finite().nonnegative(),
    compressiveUtilization: z.number().finite().nonnegative(),
  }).strict().optional(),
  issues: z.array(issueSchema),
  unchecked: z.array(z.string().min(1)),
}).strict();
const rectangularStoredReportSchema = z.object({
  id: idSchema,
  createdAt: z.iso.datetime(),
  input: strengthInputSchema,
  result: calculationSchema,
}).strict();
const sectionCalculationSchema = z.object({
  kind: z.literal("planar-section"),
  status: z.enum(["needs-input", "unsupported", "conditional", "pass", "fail"]),
  method: z.literal("planar-section-resultants-v1"),
  methodVersion: z.enum(["1.0.0", "1.1.0", "1.2.0", "1.3.0"]),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  resultants: z.object({
    axialN: z.number().finite(),
    shearXN: z.number().finite(),
    shearYN: z.number().finite(),
    bendingXNmm: z.number().finite(),
    bendingYNmm: z.number().finite(),
    torsionNmm: z.number().finite(),
  }).strict(),
  normalStressMPa: z.object({ minimum: z.number().finite(), maximum: z.number().finite() }).strict().optional(),
  shearStressMPa: z.number().finite().optional(),
  shearModel: z.enum(["solid-rectangle", "solid-circle", "concentric-circular-annulus"]).optional(),
  torsionalShearStressMPa: z.number().finite().optional(),
  torsionModel: z.enum(["solid-circle", "concentric-circular-annulus", "thin-walled-rectangular-single-cell"]).optional(),
  torsionalShearFlowNPerMm: z.number().finite().nonnegative().optional(),
  torsionalMedianAreaMm2: z.number().finite().positive().optional(),
  torsionalWallThicknessMm: z.number().finite().positive().optional(),
  tensileUtilization: z.number().finite().optional(),
  compressiveUtilization: z.number().finite().optional(),
  shearUtilization: z.number().finite().optional(),
  torsionUtilization: z.number().finite().optional(),
  checkedScope: z.string().min(1),
  issues: z.array(issueSchema),
  unchecked: z.array(z.string().min(1)),
}).strict();
const sectionStoredReportSchema = z.object({
  kind: z.literal("planar-section"),
  id: idSchema,
  createdAt: z.iso.datetime(),
  input: sectionScenarioInputSchema,
  result: sectionCalculationSchema,
}).strict();
const sectionScanCandidateSchema = z.object({
  stationIndex: z.number().int().min(0),
  offsetMm: z.number().finite(),
  status: z.enum(["needs-input", "unsupported", "conditional", "pass", "fail"]),
  binding: sectionBindingSchema,
  reasons: z.array(z.string().min(1)),
  input: sectionScenarioInputSchema.optional(),
  calculation: sectionCalculationSchema.optional(),
  maximumSingleModeUtilization: z.number().finite().nonnegative().optional(),
  governingComponent: z.string().min(1).optional(),
}).strict().superRefine((candidate, context) => {
  if ((candidate.input === undefined) !== (candidate.calculation === undefined)) {
    context.addIssue({ code: "custom", message: "A section-scan candidate must store both input and calculation, or neither" });
  }
  if (candidate.input && candidate.calculation) {
    if (candidate.calculation.inputHash !== hashSectionInput(candidate.input as SectionScenarioInput)) {
      context.addIssue({ code: "custom", message: "Section-scan calculation input hash does not match its stored input" });
    }
    if (candidate.calculation.status !== candidate.status) {
      context.addIssue({ code: "custom", message: "Section-scan candidate status does not match its calculation" });
    }
    if (
      !candidate.binding.plane ||
      candidate.input.binding?.sessionId !== candidate.binding.sessionId ||
      candidate.input.binding.documentToken !== candidate.binding.documentToken ||
      candidate.input.binding.revision !== candidate.binding.revision ||
      candidate.input.binding.bodyId !== candidate.binding.bodyId ||
      candidate.input.binding.topologySignature !== candidate.binding.topologySignature ||
      JSON.stringify(candidate.input.binding.plane) !== JSON.stringify(candidate.binding.plane)
    ) {
      context.addIssue({ code: "custom", message: "Section-scan candidate input and binding disagree" });
    }
  } else if (candidate.status !== "unsupported" || candidate.reasons.length === 0) {
    context.addIssue({ code: "custom", message: "A geometry-only section-scan candidate must explain why it is unsupported" });
  }
});
const sectionStrengthScanRecordSchema = z.object({
  binding: cadBindingSchema,
  scan: z.object({
    startPlane: z.object({ originMm: vector3StoreSchema, normal: vector3StoreSchema, xDirection: vector3StoreSchema }).strict(),
    fromOffsetMm: z.number().finite(),
    toOffsetMm: z.number().finite(),
    spacingMm: z.number().finite().positive(),
    stationCount: z.number().int().min(2).max(32),
  }).strict(),
  ranking: z.object({
    status: z.enum(["complete", "incomplete"]),
    metric: z.literal("maximum-single-mode-utilization"),
    rankedStations: z.array(z.object({
      stationIndex: z.number().int().min(0),
      utilization: z.number().finite().nonnegative(),
      component: z.string().min(1),
    }).strict()).max(32),
    excludedStationIndices: z.array(z.number().int().min(0)).max(32),
    governingStationIndex: z.number().int().min(0).optional(),
  }).strict(),
  candidates: z.array(sectionScanCandidateSchema).min(2).max(32),
}).strict().superRefine((record, context) => {
  if (record.candidates.length !== record.scan.stationCount) {
    context.addIssue({ code: "custom", message: "Section-scan candidate count does not match station count" });
  }
  if (record.ranking.status === "complete" && record.ranking.excludedStationIndices.length !== 0) {
    context.addIssue({ code: "custom", message: "A complete section-scan ranking cannot exclude stations" });
  }
  if (record.ranking.status === "incomplete" && record.ranking.governingStationIndex !== undefined) {
    context.addIssue({ code: "custom", message: "An incomplete section-scan ranking cannot name a governing station" });
  }
  const normalized = record.scan.startPlane.normal;
  const magnitude = Math.hypot(...normalized);
  const spacing = (record.scan.toOffsetMm - record.scan.fromOffsetMm) / (record.scan.stationCount - 1);
  if (record.scan.fromOffsetMm >= record.scan.toOffsetMm || !Number.isFinite(spacing) || spacing <= 0 || Math.abs(spacing - record.scan.spacingMm) > 1e-9) {
    context.addIssue({ code: "custom", message: "Stored section-scan range and spacing are inconsistent" });
  }
  const expectedBinding = record.binding;
  const unitNormal = normalized.map((component) => component / magnitude);
  const expectedRanked: { stationIndex: number; utilization: number; component: string }[] = [];
  for (const [index, candidate] of record.candidates.entries()) {
    if (candidate.stationIndex !== index) context.addIssue({ code: "custom", message: "Stored section-scan candidates must be ordered by station index" });
    if (Math.abs(candidate.offsetMm - (record.scan.fromOffsetMm + spacing * index)) > 1e-8) {
      context.addIssue({ code: "custom", message: "Stored section-scan candidate offset is inconsistent" });
    }
    if (
      candidate.binding.sessionId !== expectedBinding.sessionId ||
      candidate.binding.documentToken !== expectedBinding.documentToken ||
      candidate.binding.revision !== expectedBinding.revision ||
      candidate.binding.bodyId !== expectedBinding.bodyId
    ) context.addIssue({ code: "custom", message: "Stored section-scan candidate mixes CAD identities" });
    const expectedOrigin = record.scan.startPlane.originMm.map((component, axis) =>
      component + unitNormal[axis]! * candidate.offsetMm,
    );
    if (candidate.binding.plane && expectedOrigin.some((component, axis) =>
      Math.abs(component - candidate.binding.plane!.originMm[axis]!) > 1e-8 ||
      Math.abs(unitNormal[axis]! - candidate.binding.plane!.normal[axis]!) > 1e-8,
    )) context.addIssue({ code: "custom", message: "Stored section-scan candidate plane does not match its scan station" });
    if (candidate.input && candidate.calculation) {
      const components = [
        ["tension", candidate.calculation.tensileUtilization],
        ["compression", candidate.calculation.compressiveUtilization],
        ["direct-shear", candidate.calculation.shearUtilization],
        ["torsion", candidate.calculation.torsionUtilization],
      ] as const;
      const maximum = components.flatMap(([component, value]) =>
        value !== undefined && Number.isFinite(value) && value >= 0 ? [{ component, value }] : [],
      ).sort((left, right) => right.value - left.value)[0];
      if (maximum) {
        if (candidate.maximumSingleModeUtilization !== maximum.value || candidate.governingComponent !== maximum.component) {
          context.addIssue({ code: "custom", message: "Stored section-scan utilization does not match its calculation" });
        }
        expectedRanked.push({ stationIndex: index, utilization: maximum.value, component: maximum.component });
      } else if (candidate.maximumSingleModeUtilization !== undefined || candidate.governingComponent !== undefined) {
        context.addIssue({ code: "custom", message: "Stored section-scan utilization has no corresponding calculated mode" });
      }
    }
  }
  if (!Number.isFinite(magnitude) || magnitude <= 1e-9) {
    context.addIssue({ code: "custom", message: "Stored section-scan normal is invalid" });
  }
  const rankedIndices = record.ranking.rankedStations.map((station) => station.stationIndex);
  if (new Set(rankedIndices).size !== rankedIndices.length || rankedIndices.some((index) => index >= record.scan.stationCount)) {
    context.addIssue({ code: "custom", message: "Stored section-scan ranking has duplicate or invalid station indices" });
  }
  if (record.ranking.status === "complete" && record.ranking.rankedStations.length !== record.scan.stationCount) {
    context.addIssue({ code: "custom", message: "A complete section-scan ranking must include every station" });
  }
  const expectedExcluded = record.candidates.map((candidate) => candidate.stationIndex)
    .filter((index) => !record.ranking.rankedStations.some((station) => station.stationIndex === index));
  if (JSON.stringify(record.ranking.excludedStationIndices) !== JSON.stringify(expectedExcluded)) {
    context.addIssue({ code: "custom", message: "Stored section-scan exclusions do not match its ranked stations" });
  }
  expectedRanked.sort((left, right) => right.utilization - left.utilization || left.stationIndex - right.stationIndex);
  if (JSON.stringify(record.ranking.rankedStations) !== JSON.stringify(expectedRanked)) {
    context.addIssue({ code: "custom", message: "Stored section-scan ranking does not match its candidate calculations" });
  }
  if (
    record.ranking.status === "complete" && record.ranking.rankedStations[0]?.stationIndex !== record.ranking.governingStationIndex
  ) context.addIssue({ code: "custom", message: "Stored governing station does not match the top-ranked station" });
});
const storedSectionStrengthScanSchema = sectionStrengthScanRecordSchema.extend({
  kind: z.literal("planar-section-strength-scan"),
  id: idSchema,
  createdAt: z.iso.datetime(),
}).strict();
const fastenerCalculationSchema = z.object({
  kind: z.literal("single-fastener-plate"),
  status: z.enum(["needs-input", "unsupported", "conditional", "pass", "fail"]),
  method: z.literal("single-fastener-plate-v1"),
  methodVersion: z.literal("1.0.0"),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  stressMPa: z.object({ bearing: z.number().finite(), shearOut: z.number().finite(), netTension: z.number().finite() }).strict().optional(),
  utilization: z.object({ bearing: z.number().finite(), shearOut: z.number().finite(), netTension: z.number().finite() }).strict().optional(),
  geometryRatios: z.object({ edgeDistanceToDiameter: z.number().finite(), widthToDiameter: z.number().finite() }).strict(),
  checkedScope: z.string().min(1),
  issues: z.array(issueSchema),
  unchecked: z.array(z.string().min(1)),
}).strict();
const fastenerStoredReportSchema = z.object({
  kind: z.literal("single-fastener-plate"),
  id: idSchema,
  createdAt: z.iso.datetime(),
  input: fastenerScenarioInputSchema,
  result: fastenerCalculationSchema,
}).strict();
const fastenerMemberCalculationSchema = z.object({
  kind: z.literal("fastener-member"),
  status: z.enum(["needs-input", "unsupported", "conditional", "pass", "fail"]),
  method: z.literal("fastener-member-v1"),
  methodVersion: z.literal("1.0.0"),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  stressMPa: z.object({ tension: z.number().finite(), shear: z.number().finite() }).strict().optional(),
  allowableLoadN: z.object({ tension: z.number().finite(), shear: z.number().finite() }).strict().optional(),
  loadRatio: z.object({ tension: z.number().finite(), shear: z.number().finite() }).strict().optional(),
  interactionValue: z.number().finite().optional(),
  checkedScope: z.string().min(1),
  issues: z.array(issueSchema),
  unchecked: z.array(z.string().min(1)),
}).strict();
const fastenerMemberStoredReportSchema = z.object({
  kind: z.literal("fastener-member"),
  id: idSchema,
  createdAt: z.iso.datetime(),
  input: fastenerMemberInputSchema,
  result: fastenerMemberCalculationSchema,
}).strict();
const threadedReceiverCalculationSchema = z.object({
  kind: z.literal("threaded-receiver"),
  status: z.enum(["needs-input", "unsupported", "conditional", "pass", "fail"]),
  method: z.literal("threaded-receiver-axial-v1"),
  methodVersion: z.literal("1.0.0"),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  factoredDemandN: z.number().finite().positive().optional(),
  utilization: z.object({
    internalThreadStrip: z.number().finite().nonnegative(),
    externalThreadStrip: z.number().finite().nonnegative(),
    fastenerTension: z.number().finite().nonnegative(),
  }).strict().optional(),
  governing: z.object({
    mode: z.enum(["internal-thread-strip", "external-thread-strip", "fastener-tension"]),
    allowableLoadN: z.number().finite().positive(),
    utilization: z.number().finite().nonnegative(),
  }).strict().optional(),
  failureHierarchy: z.object({
    status: z.enum(["fastener-tension-before-thread-stripping", "thread-stripping-before-fastener-tension"]),
    minimumThreadStripAllowableN: z.number().finite().positive(),
    fastenerTensileAllowableN: z.number().finite().positive(),
    marginN: z.number().finite(),
  }).strict().optional(),
  checkedScope: z.string().min(1),
  issues: z.array(issueSchema),
  unchecked: z.array(z.string().min(1)),
}).strict();
const threadedReceiverStoredReportSchema = z.object({
  kind: z.literal("threaded-receiver"),
  id: idSchema,
  createdAt: z.iso.datetime(),
  input: threadedReceiverInputSchema,
  result: threadedReceiverCalculationSchema,
}).strict();
const insertRetentionCalculationSchema = z.object({
  kind: z.literal("heat-set-insert-retention"),
  status: z.enum(["needs-input", "unsupported", "conditional", "pass", "fail"]),
  method: z.literal("heat-set-insert-retention-v1"),
  methodVersion: z.literal("1.0.0"),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  utilization: z.object({ pullout: z.number().finite(), torqueOut: z.number().finite() }).strict().optional(),
  factoredDemand: z.object({ pulloutN: z.number().finite(), torqueNmm: z.number().finite() }).strict().optional(),
  minimumHoleDepthGuidanceMm: z.number().finite().positive().optional(),
  checkedScope: z.string().min(1),
  issues: z.array(issueSchema),
  unchecked: z.array(z.string().min(1)),
}).strict();
const insertRetentionStoredReportSchema = z.object({
  kind: z.literal("heat-set-insert-retention"),
  id: idSchema,
  createdAt: z.iso.datetime(),
  input: insertRetentionInputSchema,
  result: insertRetentionCalculationSchema,
}).strict();
const fastenerGroupCalculationSchema = z.object({
  kind: z.literal("fastener-group-load"),
  status: z.enum(["needs-input", "unsupported", "conditional", "calculated"]),
  method: z.literal("fastener-group-elastic-in-plane-v1"),
  methodVersion: z.literal("1.0.0"),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  centroidMm: z.object({ x: z.number().finite(), y: z.number().finite() }).strict().optional(),
  totalMomentAboutCentroidNmm: z.number().finite().optional(),
  polarSumMm2: z.number().finite().positive().optional(),
  directPerFastenerN: z.object({ x: z.number().finite(), y: z.number().finite() }).strict().optional(),
  fasteners: z.array(z.object({
    id: z.string().min(1),
    positionMm: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
    offsetFromCentroidMm: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
    directN: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
    momentN: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
    resultantN: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
    magnitudeN: z.number().finite().nonnegative(),
  }).strict()).optional(),
  governing: z.object({ fastenerId: z.string().min(1), shearDemandN: z.number().finite().nonnegative() }).strict().optional(),
  equilibrium: z.object({ forceResidualN: z.number().finite().nonnegative(), momentResidualNmm: z.number().finite().nonnegative() }).strict().optional(),
  fastenerShearCheck: z.object({
    status: z.enum(["within-allowable", "exceeds-allowable", "conditional"]),
    fasteners: z.array(z.object({
      id: z.string().min(1),
      configuration: z.string().min(1).max(240),
      shearDemandN: z.number().finite().nonnegative(),
      allowableShearN: z.number().finite().positive(),
      utilization: z.number().finite().nonnegative(),
      evidenceId: z.string().min(1),
    }).strict()).min(2),
    governing: z.object({ fastenerId: z.string().min(1), utilization: z.number().finite().nonnegative() }).strict(),
    allowableBasis: z.literal("traceable-design-allowable-including-safety-factor"),
    checkedScope: z.string().min(1),
    unchecked: z.array(z.string().min(1)),
  }).strict().optional(),
  checkedScope: z.string().min(1),
  issues: z.array(issueSchema),
  unchecked: z.array(z.string().min(1)),
}).strict();
const fastenerGroupStoredReportSchema = z.object({
  kind: z.literal("fastener-group-load"),
  id: idSchema,
  createdAt: z.iso.datetime(),
  input: fastenerGroupInputSchema,
  result: fastenerGroupCalculationSchema,
}).strict().superRefine((report, context) => {
  const { input, result } = report;
  const capacities = input.shearCapacities;
  const check = result.fastenerShearCheck;
  if (!capacities || !result.fasteners || result.issues.some((issue) => issue.code === "SHEAR_UTILIZATION_OVERFLOW")) {
    if (check) context.addIssue({ code: "custom", message: "Fastener shear check is present without representable capacity inputs and demands" });
    return;
  }
  if (!check) {
    context.addIssue({ code: "custom", message: "Fastener shear capacity inputs require a corresponding calculated check" });
    return;
  }
  const expected = capacities.map((capacity, index) => ({
    capacity,
    demand: result.fasteners!.find((fastener) => fastener.id === capacity.fastenerId),
    evidenceId: input.assignments[`fastenerShearCapacities.${index}.allowableShearN`],
    checked: check.fasteners[index],
  }));
  const matches = expected.length === check.fasteners.length && expected.every(({ capacity, demand, evidenceId, checked }) => {
    const utilization = demand ? demand.magnitudeN / capacity.allowableShearN : Number.NaN;
    return !!demand && !!checked && checked.id === capacity.fastenerId
      && checked.configuration === capacity.configuration
      && checked.shearDemandN === demand.magnitudeN
      && checked.allowableShearN === capacity.allowableShearN
      && checked.evidenceId === evidenceId
      && Number.isFinite(utilization)
      && Math.abs(checked.utilization - utilization) <= Math.max(1e-12, Math.abs(utilization) * 1e-12);
  });
  const governing = check.fasteners.reduce((largest, candidate) => candidate.utilization > largest.utilization ? candidate : largest);
  const exceeds = check.fasteners.some((fastener) => fastener.utilization > 1);
  const expectedStatus = exceeds ? "exceeds-allowable" : result.status === "calculated" ? "within-allowable" : "conditional";
  if (!matches || check.governing.fastenerId !== governing.id
    || Math.abs(check.governing.utilization - governing.utilization) > Math.max(1e-12, Math.abs(governing.utilization) * 1e-12)
    || check.status !== expectedStatus
    || check.allowableBasis !== "traceable-design-allowable-including-safety-factor") {
    context.addIssue({ code: "custom", message: "Fastener shear check does not match its source demands, allowables, evidence, or result status" });
  }
});
const fastenerGroupPlateBearingCalculationSchema = z.object({
  kind: z.literal("fastener-group-plate-bearing"),
  status: z.enum(["needs-input", "unsupported", "conditional", "fail"]),
  method: z.literal("fastener-group-plate-bearing-v1"),
  methodVersion: z.literal("1.0.0"),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  geometryBinding: z.object({
    sessionId: z.string().min(1), documentToken: z.string().min(1), revision: z.string().min(1), bodyId: z.number().int().nonnegative(),
    boundaryFaceId: z.string().min(1), opposedFaceId: z.string().min(1), cylindricalFaceIds: z.array(z.string().min(1)).min(2),
    groupTopologySignature: z.string().min(1), topologySignature: z.string().min(1),
    frame: z.object({ originMm: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]), normal: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]), xDirection: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]), yDirection: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]) }).strict(),
  }).strict().optional(),
  plate: z.object({ thicknessMm: z.number().finite().positive(), bearingDesignAllowableMPa: z.number().finite().positive(), allowableEvidenceId: z.string().min(1), materialConfiguration: z.string().min(1) }).strict().optional(),
  fasteners: z.array(z.object({ id: z.string().min(1), holeDiameterMm: z.number().finite().positive(), bearingDemandN: z.number().finite().nonnegative(), nominalBearingStressMPa: z.number().finite().nonnegative(), utilization: z.number().finite().nonnegative() }).strict()).optional(),
  governing: z.object({ fastenerId: z.string().min(1), utilization: z.number().finite().nonnegative() }).strict().optional(),
  bearingCheckStatus: z.enum(["within-allowable", "exceeds-allowable", "conditional"]).optional(),
  netSection: z.object({
    method: z.literal("straight-transverse-cut-v1"), axis: z.enum(["x", "y"]),
    demandN: z.number().finite().positive(), grossWidthMm: z.number().finite().positive(),
    criticalOffsetMm: z.number().finite().nonnegative(), minimumNetWidthMm: z.number().finite().positive(),
    thicknessMm: z.number().finite().positive(), netAreaMm2: z.number().finite().positive(),
    tensileStressMPa: z.number().finite().nonnegative(), tensileDesignAllowableMPa: z.number().finite().positive(),
    allowableEvidenceId: z.string().min(1), utilization: z.number().finite().nonnegative(),
    intersectedHoles: z.array(z.object({ id: z.string().min(1), chordWidthMm: z.number().finite().positive() }).strict()).min(1),
    checkStatus: z.enum(["within-allowable", "exceeds-allowable", "conditional"]),
  }).strict().optional(),
  edgeShearOut: z.object({
    method: z.literal("two-plane-loaded-edge-v1"),
    status: z.enum(["within-allowable", "exceeds-allowable", "conditional", "unsupported"]),
    designAllowableMPa: z.number().finite().positive(),
    allowableEvidenceId: z.string().min(1),
    fasteners: z.array(z.object({
      id: z.string().min(1), demandN: z.number().finite().nonnegative(),
      axis: z.enum(["x", "y"]).optional(), loadedEdge: z.enum(["+X", "-X", "+Y", "-Y"]).optional(),
      centerToLoadedEdgeMm: z.number().finite().positive().optional(), holeDiameterMm: z.number().finite().positive(),
      edgeDistanceDiameterRatio: z.number().finite().positive().optional(), netLigamentMm: z.number().finite().positive().optional(),
      shearAreaMm2: z.number().finite().positive().optional(), nominalShearOutStressMPa: z.number().finite().nonnegative().optional(),
      designAllowableMPa: z.number().finite().positive(), utilization: z.number().finite().nonnegative().optional(),
      checkStatus: z.enum(["within-allowable", "exceeds-allowable", "conditional", "unsupported", "not-loaded"]),
      issue: z.string().min(1).optional(),
    }).strict()).min(1),
    governing: z.object({ fastenerId: z.string().min(1), utilization: z.number().finite().nonnegative() }).strict().optional(),
    issues: z.array(z.string().min(1)),
  }).strict().optional(),
  physicalTestComparison: z.object({
    recordId: z.string().regex(/^[a-f0-9]{64}$/), testedAt: z.iso.datetime(), loadAxis: z.enum(["x", "y"]),
    externalDemandN: z.number().finite().positive(), safetyFactor: z.number().finite().positive(),
    factoredDemandN: z.number().finite().positive(), specimenCount: z.number().int().positive(),
    minimumObservedPeakLoadN: z.number().finite().positive(), geometryToleranceMm: z.number().finite().positive(),
    geometryToleranceEvidenceId: z.string().min(1),
    geometryMatch: z.object({
      plateDeltaMm: z.object({ width: z.number().finite(), height: z.number().finite(), thickness: z.number().finite() }).strict(),
      maximumHoleCenterOffsetMm: z.number().finite().nonnegative(), maximumHoleDiameterDeltaMm: z.number().finite().nonnegative(),
      matchedHoleCount: z.number().int().positive(),
    }).strict(),
    observedLoadRatio: z.number().finite().positive(),
    outcome: z.enum(["below-minimum-observed-failure-load", "above-minimum-observed-failure-load"]),
    observedFailureModes: z.array(z.enum(["bearing", "net-tension", "shear-out", "cleavage", "shared-ligament", "mixed", "other"])).min(1),
    interpretation: z.string().min(1),
  }).strict().optional(),
  checkedScope: z.string().min(1), issues: z.array(issueSchema), unchecked: z.array(z.string().min(1)),
}).strict();
const fastenerGroupPlateBearingStoredReportSchema = z.object({
  kind: z.literal("fastener-group-plate-bearing"), id: idSchema, createdAt: z.iso.datetime(),
  input: fastenerGroupPlateBearingInputSchema, result: fastenerGroupPlateBearingCalculationSchema,
}).strict().superRefine((report, context) => {
  if (!report.result.geometryBinding) {
    context.addIssue({ code: "custom", message: "A stored fastener-group plate bearing report requires exact CAD geometry binding" });
    return;
  }
  if (report.result.inputHash !== hashFastenerGroupPlateBearingBinding(report.input as FastenerGroupPlateBearingInput, report.result.geometryBinding)) {
    context.addIssue({ code: "custom", message: "Fastener-group plate bearing input hash does not match its exact geometry binding" });
  }
  if (!report.input.group.binding || report.input.group.binding.topologySignature !== report.result.geometryBinding.groupTopologySignature) {
    context.addIssue({ code: "custom", message: "Fastener-group plate bearing report must preserve the measured group topology binding" });
  }
});
const tongueRootCalculationSchema = z.object({
  kind: z.literal("tongue-root"),
  status: z.enum(["needs-input", "unsupported", "conditional", "pass", "fail"]),
  method: z.literal("tongue-root-transverse-v1"),
  methodVersion: z.literal("1.0.0"),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  stressMPa: z.object({ rootBending: z.number().finite(), maximumTransverseShear: z.number().finite() }).strict().optional(),
  deflectionMm: z.object({ bending: z.number().finite(), shear: z.number().finite(), total: z.number().finite() }).strict().optional(),
  utilization: z.object({ bending: z.number().finite(), shear: z.number().finite(), deflection: z.number().finite(), governing: z.number().finite() }).strict().optional(),
  checkedScope: z.string().min(1),
  issues: z.array(issueSchema),
  unchecked: z.array(z.string().min(1)),
}).strict();
const tongueRootStoredReportSchema = z.object({
  kind: z.literal("tongue-root"),
  id: idSchema,
  createdAt: z.iso.datetime(),
  input: tongueRootInputSchema,
  result: tongueRootCalculationSchema,
}).strict();
const storedReportSchema = z.union([sectionStoredReportSchema, fastenerStoredReportSchema, fastenerMemberStoredReportSchema, threadedReceiverStoredReportSchema, insertRetentionStoredReportSchema, fastenerGroupPlateBearingStoredReportSchema, fastenerGroupStoredReportSchema, tongueRootStoredReportSchema, rectangularStoredReportSchema]);
const internalRequestSchema = z.object({
  id: idSchema,
  inputHash: z.string().min(1),
  state: z.enum(["requested", "completed", "failed", "interrupted"]),
  result: analysisResultSchema.optional(),
  errorCode: z.string().min(1).optional(),
  failureDiagnostics: z.object({
    category: z.enum(CODEX_ERROR_CATEGORIES).optional(),
    httpStatusCode: z.number().int().min(100).max(599).optional(),
    message: z.string().min(1).max(240).optional(),
  }).strict().refine((diagnostics) => Object.keys(diagnostics).length > 0, "failure diagnostics must contain at least one detail").optional(),
  owner: z.object({ pid: z.number().int().positive(), nonce: z.string().min(1) }).strict().optional(),
}).strict().superRefine((record, context) => {
  if (record.state === "requested" && record.owner === undefined) {
    context.addIssue({ code: "custom", message: "requested record requires owner" });
  }
  if (record.state === "completed" && record.result === undefined) {
    context.addIssue({ code: "custom", message: "completed record requires result" });
  }
});

export class StrengthStore {
  private readonly ownerNonce = randomUUID();
  private readonly reportsRoot: string;
  private readonly sectionScansRoot: string;
  private readonly requestsRoot: string;
  readonly materialQualifications: MaterialCouponQualificationStore;
  readonly fastenerGroupTests: FastenerGroupTestStore;
  readonly materialInterfaceTests: InterfaceTestStore;
  readonly dcbModeIEnergyTests: DcbModeIEnergyTestStore;
  readonly enfModeIIEnergyTests: EnfModeIIEnergyTestStore;
  readonly mmbModeIEnergyTests: MmbModeIEnergyTestStore;

  constructor(root = join(process.cwd(), ".plasticity-mcp", "strength")) {
    this.reportsRoot = join(root, "reports");
    this.sectionScansRoot = join(root, "section-scans");
    this.requestsRoot = join(root, "requests");
    this.materialQualifications = new MaterialCouponQualificationStore(join(root, "material-qualifications"));
    this.fastenerGroupTests = new FastenerGroupTestStore(join(root, "fastener-group-tests"));
    this.materialInterfaceTests = new InterfaceTestStore(join(root, "material-interface-tests"));
    this.dcbModeIEnergyTests = new DcbModeIEnergyTestStore(join(root, "dcb-mode-i-energy-tests"));
    this.enfModeIIEnergyTests = new EnfModeIIEnergyTestStore(join(root, "enf-mode-ii-energy-tests"));
    this.mmbModeIEnergyTests = new MmbModeIEnergyTestStore(join(root, "mmb-mode-i-ii-energy-tests"));
  }

  async saveReport(input: StrengthInput, result: Calculation): Promise<StoredRectangularReport> {
    const parsedInput = strengthInputSchema.parse(input) as StrengthInput;
    const parsedResult = calculationSchema.parse(result) as Calculation;
    if (parsedResult.inputHash !== hashStrengthInput(parsedInput)) {
      throw new Error("Calculation input hash does not match the stored input");
    }
    await this.prepare();
    for (;;) {
      const report: StoredRectangularReport = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        input: structuredClone(parsedInput),
        result: structuredClone(parsedResult),
      };
      try {
        await writeExclusive(this.reportPath(report.id), report);
        return structuredClone(report);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    }
  }

  async saveSectionReport(input: SectionScenarioInput, result: SectionCalculation): Promise<StoredSectionReport> {
    const parsedInput = sectionScenarioInputSchema.parse(input) as SectionScenarioInput;
    const parsedResult = sectionCalculationSchema.parse(result) as SectionCalculation;
    if (parsedResult.inputHash !== hashSectionInput(parsedInput)) {
      throw new Error("Section calculation input hash does not match the stored input");
    }
    await this.prepare();
    for (;;) {
      const report: StoredSectionReport = {
        kind: "planar-section",
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        input: structuredClone(parsedInput),
        result: structuredClone(parsedResult),
      };
      try {
        await writeExclusive(this.reportPath(report.id), report);
        return structuredClone(report);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    }
  }

  async saveSectionStrengthScan(record: SectionStrengthScanRecord): Promise<StoredSectionStrengthScan> {
    const parsedRecord = sectionStrengthScanRecordSchema.parse(record) as SectionStrengthScanRecord;
    await this.prepare();
    for (;;) {
      const report = storedSectionStrengthScanSchema.parse({
        ...structuredClone(parsedRecord),
        kind: "planar-section-strength-scan",
        id: randomUUID(),
        createdAt: new Date().toISOString(),
      }) as StoredSectionStrengthScan;
      const serialized = `${JSON.stringify(report)}\n`;
      if (Buffer.byteLength(serialized, "utf8") > MAX_SECTION_SCAN_REPORT_BYTES) {
        throw new Error("Section-strength scan report exceeds the 16 MiB storage limit");
      }
      try {
        await writeExclusive(this.sectionScanPath(report.id), report);
        return structuredClone(report);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    }
  }

  async readSectionStrengthScan(id: string): Promise<StoredSectionStrengthScan> {
    validateId(id);
    const value = await readNoFollow(this.sectionScanPath(id), MAX_SECTION_SCAN_REPORT_BYTES);
    const parsed = storedSectionStrengthScanSchema.safeParse(value);
    if (!parsed.success) throw new Error(`Invalid stored section-strength scan ${id}: ${parsed.error.issues[0]?.message ?? "schema error"}`);
    return structuredClone(parsed.data) as StoredSectionStrengthScan;
  }

  async saveFastenerReport(input: FastenerScenarioInput, result: FastenerCalculation): Promise<StoredFastenerReport> {
    const parsedInput = fastenerScenarioInputSchema.parse(input) as FastenerScenarioInput;
    const parsedResult = fastenerCalculationSchema.parse(result) as FastenerCalculation;
    if (parsedResult.inputHash !== hashFastenerInput(parsedInput)) {
      throw new Error("Fastener calculation input hash does not match the stored input");
    }
    await this.prepare();
    for (;;) {
      const report: StoredFastenerReport = {
        kind: "single-fastener-plate",
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        input: structuredClone(parsedInput),
        result: structuredClone(parsedResult),
      };
      try {
        await writeExclusive(this.reportPath(report.id), report);
        return structuredClone(report);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    }
  }

  async saveFastenerMemberReport(input: FastenerMemberInput, result: FastenerMemberCalculation): Promise<StoredFastenerMemberReport> {
    const parsedInput = fastenerMemberInputSchema.parse(input) as FastenerMemberInput;
    const parsedResult = fastenerMemberCalculationSchema.parse(result) as FastenerMemberCalculation;
    if (parsedResult.inputHash !== hashFastenerMemberInput(parsedInput)) {
      throw new Error("Fastener member calculation input hash does not match the stored input");
    }
    await this.prepare();
    for (;;) {
      const report: StoredFastenerMemberReport = {
        kind: "fastener-member",
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        input: structuredClone(parsedInput),
        result: structuredClone(parsedResult),
      };
      try {
        await writeExclusive(this.reportPath(report.id), report);
        return structuredClone(report);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    }
  }

  async saveThreadedReceiverReport(input: ThreadedReceiverInput, result: ThreadedReceiverCalculation): Promise<StoredThreadedReceiverReport> {
    const parsedInput = threadedReceiverInputSchema.parse(input) as ThreadedReceiverInput;
    const parsedResult = threadedReceiverCalculationSchema.parse(result) as ThreadedReceiverCalculation;
    if (parsedResult.inputHash !== hashThreadedReceiverInput(parsedInput)) {
      throw new Error("Threaded-receiver calculation input hash does not match the stored input");
    }
    await this.prepare();
    for (;;) {
      const report: StoredThreadedReceiverReport = {
        kind: "threaded-receiver",
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        input: structuredClone(parsedInput),
        result: structuredClone(parsedResult),
      };
      try {
        await writeExclusive(this.reportPath(report.id), report);
        return structuredClone(report);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    }
  }

  async saveInsertRetentionReport(input: InsertRetentionInput, result: InsertRetentionCalculation): Promise<StoredInsertRetentionReport> {
    const parsedInput = insertRetentionInputSchema.parse(input) as InsertRetentionInput;
    const parsedResult = insertRetentionCalculationSchema.parse(result) as InsertRetentionCalculation;
    if (parsedResult.inputHash !== hashInsertRetentionInput(parsedInput)) {
      throw new Error("Insert retention calculation input hash does not match the stored input");
    }
    await this.prepare();
    for (;;) {
      const report: StoredInsertRetentionReport = {
        kind: "heat-set-insert-retention",
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        input: structuredClone(parsedInput),
        result: structuredClone(parsedResult),
      };
      try {
        await writeExclusive(this.reportPath(report.id), report);
        return structuredClone(report);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    }
  }

  async saveFastenerGroupReport(input: FastenerGroupInput, result: FastenerGroupCalculation): Promise<StoredFastenerGroupReport> {
    const parsedInput = fastenerGroupInputSchema.parse(input) as FastenerGroupInput;
    const parsedResult = fastenerGroupCalculationSchema.parse(result) as FastenerGroupCalculation;
    if (parsedResult.inputHash !== hashFastenerGroupInput(parsedInput)) {
      throw new Error("Fastener-group calculation input hash does not match the stored input");
    }
    await this.prepare();
    for (;;) {
      const report: StoredFastenerGroupReport = {
        kind: "fastener-group-load",
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        input: structuredClone(parsedInput),
        result: structuredClone(parsedResult),
      };
      try {
        await writeExclusive(this.reportPath(report.id), report);
        return structuredClone(report);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    }
  }

  async saveFastenerGroupPlateBearingReport(input: FastenerGroupPlateBearingInput, result: FastenerGroupPlateBearingCalculation): Promise<StoredFastenerGroupPlateBearingReport> {
    const parsedInput = fastenerGroupPlateBearingInputSchema.parse(input) as FastenerGroupPlateBearingInput;
    const parsedResult = fastenerGroupPlateBearingCalculationSchema.parse(result) as FastenerGroupPlateBearingCalculation;
    if (!parsedResult.geometryBinding) throw new Error("Fastener-group plate report requires exact native geometry binding");
    if (parsedResult.inputHash !== hashFastenerGroupPlateBearingBinding(parsedInput, parsedResult.geometryBinding)) {
      throw new Error("Fastener-group plate bearing input hash does not match the stored input and geometry binding");
    }
    await this.prepare();
    for (;;) {
      const report: StoredFastenerGroupPlateBearingReport = {
        kind: "fastener-group-plate-bearing",
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        input: structuredClone(parsedInput),
        result: structuredClone(parsedResult),
      };
      try {
        await writeExclusive(this.reportPath(report.id), report);
        return structuredClone(report);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    }
  }

  async saveTongueRootReport(input: TongueRootInput, result: TongueRootCalculation): Promise<StoredTongueRootReport> {
    const parsedInput = tongueRootInputSchema.parse(input) as TongueRootInput;
    const parsedResult = tongueRootCalculationSchema.parse(result) as TongueRootCalculation;
    if (parsedResult.inputHash !== hashTongueRootInput(parsedInput)) throw new Error("Tongue-root calculation input hash does not match the stored input");
    await this.prepare();
    for (;;) {
      const report: StoredTongueRootReport = {
        kind: "tongue-root",
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        input: structuredClone(parsedInput),
        result: structuredClone(parsedResult),
      };
      try {
        await writeExclusive(this.reportPath(report.id), report);
        return structuredClone(report);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    }
  }

  async readReport(id: string): Promise<StoredReport> {
    validateId(id);
    const value = await readNoFollow(this.reportPath(id));
    const parsed = storedReportSchema.safeParse(value);
    if (!parsed.success) throw new Error(`Invalid stored report ${id}: ${parsed.error.issues[0]?.message ?? "schema error"}`);
    return structuredClone(parsed.data) as StoredReport;
  }

  async beginRequest(id: string, requestInputHash: string): Promise<boolean> {
    validateId(id);
    if (!requestInputHash) throw new Error("Request input hash is required");
    await this.prepare();
    const initial: InternalRequestRecord = {
      id,
      inputHash: requestInputHash,
      state: "requested",
      owner: { pid: process.pid, nonce: this.ownerNonce },
    };
    try {
      await writeExclusive(this.requestPath(id), initial);
      return true;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    const existing = await this.readInternalRequest(id);
    if (existing.inputHash !== requestInputHash) throw new Error(`Request ID conflict: ${id}`);
    if (existing.state === "requested" && existing.owner && !processIsAlive(existing.owner.pid)) {
      await this.replaceRequest({
        id: existing.id,
        inputHash: existing.inputHash,
        state: "interrupted",
        errorCode: "OWNER_STOPPED",
      });
    }
    return false;
  }

  async readRequest(id: string): Promise<RequestRecord> {
    const internal = await this.readInternalRequest(id);
    return publicRequest(internal);
  }

  async finishRequest(record: RequestRecord): Promise<void> {
    validateId(record.id);
    const next = internalRequestSchema.parse(record) as InternalRequestRecord;
    if (next.state === "requested") throw new Error("finishRequest requires a terminal state");
    const current = await this.readInternalRequest(record.id);
    if (current.inputHash !== next.inputHash) throw new Error(`Request ID conflict: ${record.id}`);
    if (current.state !== "requested") throw new Error(`Request is already terminal: ${record.id}`);
    if (!current.owner || current.owner.nonce !== this.ownerNonce || current.owner.pid !== process.pid) {
      throw new Error(`Request is owned by another process: ${record.id}`);
    }
    await this.replaceRequest(next);
  }

  private async prepare(): Promise<void> {
    await mkdir(this.reportsRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.sectionScansRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.requestsRoot, { recursive: true, mode: 0o700 });
  }

  private reportPath(id: string): string {
    validateId(id);
    return join(this.reportsRoot, `${id}.json`);
  }

  private requestPath(id: string): string {
    validateId(id);
    return join(this.requestsRoot, `${id}.json`);
  }

  private sectionScanPath(id: string): string {
    validateId(id);
    return join(this.sectionScansRoot, `${id}.json`);
  }

  private async readInternalRequest(id: string): Promise<InternalRequestRecord> {
    validateId(id);
    const value = await readNoFollow(this.requestPath(id));
    const parsed = internalRequestSchema.safeParse(value);
    if (!parsed.success) throw new Error(`Invalid stored request ${id}: ${parsed.error.issues[0]?.message ?? "schema error"}`);
    return structuredClone(parsed.data) as InternalRequestRecord;
  }

  private async replaceRequest(record: InternalRequestRecord): Promise<void> {
    const parsed = internalRequestSchema.parse(record);
    await this.prepare();
    const temporary = join(this.requestsRoot, `.${record.id}.${randomUUID()}.tmp`);
    try {
      await writeExclusive(temporary, parsed);
      await rename(temporary, this.requestPath(record.id));
    } catch (error) {
      try {
        await unlink(temporary);
      } catch {
        // The temporary file may already have been renamed or never created.
      }
      throw error;
    }
  }
}

export function inputHash(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalJson(input))).digest("hex");
}

export function reportView(report: StoredReport, current?: ReportInput): ReportView {
  if ("kind" in report && report.kind === "fastener-group-plate-bearing") {
    return { report: structuredClone(report), freshness: "unverified", reasons: ["USE_FASTENER_GROUP_PLATE_BEARING_REPORT_TOOL"] };
  }
  if (current === undefined) return { report: structuredClone(report), freshness: "unverified", reasons: ["NO_CURRENT_INPUT"] };
  const reasons: string[] = [];
  const reportKind = inputKind(report.input);
  const currentKind = inputKind(current);
  if (reportKind !== currentKind) {
    reasons.push("TASK_OR_MATERIAL_CHANGED");
  } else if (report.input.binding) {
    if (!current.binding) reasons.push("CAD_BINDING_MISSING");
    else {
      const currentBinding = current.binding;
      if (report.input.binding.sessionId !== currentBinding.sessionId) reasons.push("CAD_SESSION_CHANGED");
      if (report.input.binding.documentToken !== currentBinding.documentToken) reasons.push("CAD_DOCUMENT_CHANGED");
      if (report.input.binding.revision !== currentBinding.revision) reasons.push("CAD_REVISION_CHANGED");
      if (report.input.binding.bodyId !== currentBinding.bodyId) reasons.push("CAD_BODY_CHANGED");
      if (isSectionInput(report.input) && isSectionInput(current)) {
        const currentSectionBinding = current.binding!;
        if (report.input.binding.faceId !== currentSectionBinding.faceId) reasons.push("CAD_FACE_CHANGED");
        if ((report.input.binding.plane === undefined) !== (currentSectionBinding.plane === undefined)) reasons.push("CAD_SECTION_SOURCE_CHANGED");
        if (report.input.binding.plane && currentSectionBinding.plane) {
          for (const key of ["originMm", "normal", "xDirection"] as const) {
            if (report.input.binding.plane[key].some((value, index) => value !== currentSectionBinding.plane![key][index])) reasons.push("CAD_PLANE_CHANGED");
          }
        }
        if (report.input.binding.topologySignature !== currentSectionBinding.topologySignature) reasons.push("CAD_TOPOLOGY_CHANGED");
      } else if (isFastenerInput(report.input) && isFastenerInput(current)) {
        const currentFastenerBinding = current.binding!;
        if (report.input.binding.frontFaceId !== currentFastenerBinding.frontFaceId) reasons.push("CAD_FACE_CHANGED");
        if (report.input.binding.backFaceId !== currentFastenerBinding.backFaceId) reasons.push("CAD_FACE_CHANGED");
        if (report.input.binding.topologySignature !== currentFastenerBinding.topologySignature) reasons.push("CAD_TOPOLOGY_CHANGED");
        if (report.input.binding.loadDirection.some((value, index) => value !== currentFastenerBinding.loadDirection[index])) reasons.push("CAD_LOAD_DIRECTION_CHANGED");
      } else if (isFastenerGroupInput(report.input) && isFastenerGroupInput(current)) {
        const currentGroupBinding = current.binding!;
        if (report.input.binding.cylindricalFaceIds.length !== currentGroupBinding.cylindricalFaceIds.length ||
            report.input.binding.cylindricalFaceIds.some((value, index) => value !== currentGroupBinding.cylindricalFaceIds[index])) {
          reasons.push("CAD_FACE_CHANGED");
        }
        if (report.input.binding.topologySignature !== currentGroupBinding.topologySignature) reasons.push("CAD_TOPOLOGY_CHANGED");
        for (const key of ["originMm", "normal", "xDirection", "yDirection"] as const) {
          if (report.input.binding.frame[key].some((value, index) => value !== currentGroupBinding.frame[key][index])) reasons.push("CAD_FRAME_CHANGED");
        }
      } else if (isTongueRootInput(report.input) && isTongueRootInput(current)) {
        const currentRootBinding = current.binding!;
        if (report.input.binding.topologySignature !== currentRootBinding.topologySignature) reasons.push("CAD_TOPOLOGY_CHANGED");
        for (const key of ["originMm", "normal", "xDirection"] as const) {
          if (report.input.binding.plane[key].some((value, index) => value !== currentRootBinding.plane[key][index])) reasons.push("CAD_SECTION_PLANE_CHANGED");
        }
      }
    }
  }
  if (reportKind === currentKind && inputHash(withoutBinding(report.input)) !== inputHash(withoutBinding(current))) {
    reasons.push("TASK_OR_MATERIAL_CHANGED");
  }
  return {
    report: structuredClone(report),
    freshness: reasons.length === 0 ? "current" : "stale",
    reasons,
  };
}

function withoutBinding(input: ReportInput): Omit<ReportInput, "binding"> {
  const { binding: _binding, ...rest } = input;
  return rest;
}

function isSectionInput(input: ReportInput): input is SectionScenarioInput {
  return "kind" in input && input.kind === "planar-section";
}

function isFastenerInput(input: ReportInput): input is FastenerScenarioInput {
  return "kind" in input && input.kind === "single-fastener-plate";
}

function isFastenerMemberInput(input: ReportInput): input is FastenerMemberInput {
  return "kind" in input && input.kind === "fastener-member";
}

function isThreadedReceiverInput(input: ReportInput): input is ThreadedReceiverInput {
  return "kind" in input && input.kind === "threaded-receiver";
}

function isInsertRetentionInput(input: ReportInput): input is InsertRetentionInput {
  return "kind" in input && input.kind === "heat-set-insert-retention";
}

function isFastenerGroupInput(input: ReportInput): input is FastenerGroupInput {
  return "kind" in input && input.kind === "fastener-group-load";
}

function isTongueRootInput(input: ReportInput): input is TongueRootInput {
  return "kind" in input && input.kind === "tongue-root";
}

function inputKind(input: ReportInput): "rectangular" | "planar-section" | "single-fastener-plate" | "fastener-member" | "threaded-receiver" | "heat-set-insert-retention" | "fastener-group-load" | "tongue-root" {
  return isSectionInput(input)
    ? "planar-section"
    : isFastenerInput(input)
      ? "single-fastener-plate"
      : isFastenerMemberInput(input)
        ? "fastener-member"
        : isThreadedReceiverInput(input)
          ? "threaded-receiver"
          : isInsertRetentionInput(input)
            ? "heat-set-insert-retention"
            : isFastenerGroupInput(input)
              ? "fastener-group-load"
              : isTongueRootInput(input)
                ? "tongue-root"
              : "rectangular";
}

async function writeExclusive(path: string, value: unknown): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readNoFollow(path: string, maximumBytes?: number): Promise<unknown> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (errorCode(error) === "ELOOP") throw new Error(`Refusing symbolic link: ${path}`);
    throw error;
  }
  try {
    if (maximumBytes !== undefined && (await handle.stat()).size > maximumBytes) {
      throw new Error(`Stored file exceeds the ${maximumBytes} byte read limit`);
    }
    return JSON.parse(await handle.readFile("utf8")) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in store: ${path}`);
    throw error;
  } finally {
    await handle.close();
  }
}

function validateId(id: string): void {
  if (!idSchema.safeParse(id).success) throw new Error(`Invalid store ID: ${id}`);
}

function publicRequest(record: InternalRequestRecord): RequestRecord {
  return {
    id: record.id,
    inputHash: record.inputHash,
    state: record.state,
    ...(record.result === undefined ? {} : { result: structuredClone(record.result) }),
    ...(record.errorCode === undefined ? {} : { errorCode: record.errorCode }),
    ...(record.failureDiagnostics === undefined ? {} : { failureDiagnostics: structuredClone(record.failureDiagnostics) }),
  };
}

function canonicalJson(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Hash input numbers must be finite");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalJson(entry));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalJson(entry)]));
  }
  throw new TypeError(`Hash input is not JSON-compatible: ${typeof value}`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}
