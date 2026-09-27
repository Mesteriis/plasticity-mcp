import { constants } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";

import {
  exactMaterialCouponProcessSchema,
  materialCouponProcessSchema,
  orthotropicTsaiWuInteractionTestAxis,
  orthotropicTsaiWuTestMetadata,
  sameMaterialCouponProcess,
} from "../material-qualification.ts";
import { evidenceSchema } from "../schemas.ts";
import { classifyRefinementTrend } from "./refinement-diagnostics.ts";
import { orthotropicElasticConstantsError, resolveOrthotropicOrientation } from "./orthotropic-material.ts";
import { MAX_LAYERWISE_FEA_LAYERS, cohesiveLayerPlanePlanInputSchema, createCohesiveLayerPlanePlan } from "./layer-plane-plan.ts";

const vector = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const faceLoadSchema = z.object({
  faceId: z.string().min(1),
  tractionNPerMm2: vector.refine((value) => value.some((component) => component !== 0), "Traction must be nonzero"),
}).strict();
const resultantLoadSchema = z.object({
  faceId: z.string().min(1),
  forceN: vector,
  applicationPointMm: vector,
  momentNmm: vector,
}).strict();
const loadCaseSchema = z.object({
  name: z.string().trim().min(1).max(48).regex(/^[A-Za-z0-9][A-Za-z0-9 _-]*$/),
  faceLoads: z.array(faceLoadSchema).max(8).refine((loads) => new Set(loads.map((load) => load.faceId)).size === loads.length, "Loaded face IDs must be unique within a case"),
  resultantLoads: z.array(resultantLoadSchema).max(8).refine((loads) => new Set(loads.map((load) => load.faceId)).size === loads.length, "Resultant-load face IDs must be unique within a case"),
}).strict().refine((loadCase) => loadCase.faceLoads.length + loadCase.resultantLoads.length > 0, "Each load case requires at least one explicit load");
const supportConditionSchema = z.object({
  faceId: z.string().min(1),
  fixedTranslationAxes: z.array(z.enum(["x", "y", "z"])).min(1).max(3)
    .refine((axes) => new Set(axes).size === axes.length, "Fixed translation axes must be unique"),
}).strict();
type SupportConditionInput = z.infer<typeof supportConditionSchema>;

const materialPropertyEvidenceSchema = evidenceSchema.extend({ unit: z.enum(["MPa", "ratio"]) });
function validateMaterialPropertyEvidence(evidence: z.infer<typeof materialPropertyEvidenceSchema>, context: z.RefinementCtx): void {
  if (!(evidence.status === "measured" || evidence.status === "sourced" || evidence.status === "assumed")) {
    context.addIssue({ code: "custom", path: ["status"], message: "Material property evidence must be measured, sourced or explicitly assumed" });
  }
  if (evidence.status === "assumed") {
    if (!evidence.derivation) context.addIssue({ code: "custom", path: ["derivation"], message: "An assumed material property needs an explicit assumption reason" });
    return;
  }
  if (evidence.value === undefined || !evidence.sourceUrl || !evidence.sourceLocator || !evidence.sourceHash || !/^[a-f0-9]{64}$/.test(evidence.sourceHash)) {
    context.addIssue({ code: "custom", message: "Measured or sourced material properties require a value, URL, SHA-256 source hash and source locator" });
  }
}

const youngsModulusEvidenceSchema = materialPropertyEvidenceSchema.extend({ unit: z.literal("MPa") }).superRefine(validateMaterialPropertyEvidence);
const poissonRatioEvidenceSchema = materialPropertyEvidenceSchema.extend({ unit: z.literal("ratio") }).superRefine(validateMaterialPropertyEvidence);
const orthotropicOrientationEvidenceSchema = z.object({
  status: z.enum(["user-confirmed", "measured", "sourced"]),
  description: z.string().trim().min(12).max(1000),
  sourceUrl: z.url().optional(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  sourceLocator: z.string().trim().min(1).optional(),
}).strict().superRefine((evidence, context) => {
  if (evidence.status !== "user-confirmed"
    && (!evidence.sourceUrl || !evidence.sourceHash || !evidence.sourceLocator)) {
    context.addIssue({ code: "custom", message: "Measured or sourced print-axis orientation requires a URL, SHA-256 and locator" });
  }
});
const orthotropicFactoredAllowableKeys = ["xTensionMPa", "xCompressionMPa", "yTensionMPa", "yCompressionMPa", "zTensionMPa", "zCompressionMPa", "xyShearMPa", "xzShearMPa", "yzShearMPa"] as const;
const factoredOrthotropicAllowableEvidenceSchema = evidenceSchema.extend({ unit: z.literal("MPa") }).superRefine((evidence, context) => {
  if (evidence.status !== "measured" && evidence.status !== "sourced") {
    context.addIssue({ code: "custom", path: ["status"], message: "A factored orthotropic allowable must be directly measured or sourced, not assumed" });
  }
  if (evidence.value === undefined || !evidence.sourceUrl || !evidence.sourceLocator
    || !evidence.sourceHash || !/^[a-f0-9]{64}$/.test(evidence.sourceHash)) {
    context.addIssue({ code: "custom", message: "A factored orthotropic allowable requires exact value, URL, SHA-256 and source locator" });
  }
});
const orthotropicFactoredAllowablesSchema = z.object({
  xTensionMPa: z.number().finite().positive(), xCompressionMPa: z.number().finite().positive(),
  yTensionMPa: z.number().finite().positive(), yCompressionMPa: z.number().finite().positive(),
  zTensionMPa: z.number().finite().positive(), zCompressionMPa: z.number().finite().positive(),
  xyShearMPa: z.number().finite().positive(), xzShearMPa: z.number().finite().positive(), yzShearMPa: z.number().finite().positive(),
  evidence: z.object({
    xTensionMPa: factoredOrthotropicAllowableEvidenceSchema, xCompressionMPa: factoredOrthotropicAllowableEvidenceSchema,
    yTensionMPa: factoredOrthotropicAllowableEvidenceSchema, yCompressionMPa: factoredOrthotropicAllowableEvidenceSchema,
    zTensionMPa: factoredOrthotropicAllowableEvidenceSchema, zCompressionMPa: factoredOrthotropicAllowableEvidenceSchema,
    xyShearMPa: factoredOrthotropicAllowableEvidenceSchema, xzShearMPa: factoredOrthotropicAllowableEvidenceSchema, yzShearMPa: factoredOrthotropicAllowableEvidenceSchema,
  }).strict(),
  basis: z.string().trim().min(12).max(1000),
}).strict();
export type OrthotropicFactoredAllowables = z.infer<typeof orthotropicFactoredAllowablesSchema>;
const orthotropicTsaiWuStrengthKeys = ["xTensionMPa", "xCompressionMPa", "yTensionMPa", "yCompressionMPa", "zTensionMPa", "zCompressionMPa", "xyShearMPa", "xzShearMPa", "yzShearMPa"] as const;
const orthotropicTsaiWuStrengthEvidenceSchema = evidenceSchema.extend({
  unit: z.literal("MPa"), process: materialCouponProcessSchema,
  testAxis: z.enum(["material-1", "material-2", "material-3", "material-1-2", "material-1-3", "material-2-3"]),
  testMode: z.enum(["tension", "compression", "shear", "biaxial"]),
}).superRefine((evidence, context) => {
  if (evidence.status !== "measured" || evidence.value === undefined || !evidence.sourceUrl
    || !evidence.sourceLocator || !evidence.sourceHash || !/^[a-f0-9]{64}$/.test(evidence.sourceHash)) {
    context.addIssue({ code: "custom", message: "Tsai-Wu strength inputs require exact, traceable physical-test evidence" });
  }
});
const orthotropicTsaiWuInteractionEvidenceSchema = evidenceSchema.extend({
  unit: z.literal("ratio"), process: materialCouponProcessSchema,
  testAxis: z.enum(["material-1", "material-2", "material-3", "material-1-2", "material-1-3", "material-2-3"]),
  testMode: z.enum(["tension", "compression", "shear", "biaxial"]),
}).superRefine((evidence, context) => {
  if (evidence.status !== "derived" || evidence.value === undefined || !evidence.sourceUrl
    || !evidence.sourceLocator || !evidence.sourceHash || !/^[a-f0-9]{64}$/.test(evidence.sourceHash)
    || !evidence.derivation || evidence.dependsOn.length === 0) {
    context.addIssue({ code: "custom", message: "Tsai-Wu interaction inputs must be derived from traceable biaxial-test evidence" });
  }
});
const orthotropicTsaiWuCriterionSchema = z.object({
  qualificationRecordId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  strengths: z.object({
    xTensionMPa: z.number().finite().positive(), xCompressionMPa: z.number().finite().positive(),
    yTensionMPa: z.number().finite().positive(), yCompressionMPa: z.number().finite().positive(),
    zTensionMPa: z.number().finite().positive(), zCompressionMPa: z.number().finite().positive(),
    xyShearMPa: z.number().finite().positive(), xzShearMPa: z.number().finite().positive(), yzShearMPa: z.number().finite().positive(),
  }).strict(),
  interactions: z.object({ xy: z.number().finite(), xz: z.number().finite(), yz: z.number().finite() }).strict()
    .superRefine((value, context) => {
      const { xy, xz, yz } = value;
      const determinant = 1 + 2 * xy * xz * yz - xy * xy - xz * xz - yz * yz;
      if ([xy, xz, yz].some((coefficient) => Math.abs(coefficient) >= 1)
        || 1 - xy * xy <= 0 || !Number.isFinite(determinant) || determinant <= 1e-12) {
        context.addIssue({ code: "custom", message: "Normalized Tsai-Wu interaction matrix must be positive definite" });
      }
    }),
  strengthEvidence: z.object(Object.fromEntries(orthotropicTsaiWuStrengthKeys.map((key) => [key, orthotropicTsaiWuStrengthEvidenceSchema])) as Record<typeof orthotropicTsaiWuStrengthKeys[number], typeof orthotropicTsaiWuStrengthEvidenceSchema>).strict(),
  interactionEvidence: z.object({
    xy: orthotropicTsaiWuInteractionEvidenceSchema, xz: orthotropicTsaiWuInteractionEvidenceSchema, yz: orthotropicTsaiWuInteractionEvidenceSchema,
  }).strict(),
  basis: z.string().trim().min(24).max(2000),
}).strict().superRefine((value, context) => {
  for (const key of orthotropicTsaiWuStrengthKeys) {
    if (value.strengthEvidence[key].value !== value.strengths[key]) {
      context.addIssue({ code: "custom", path: ["strengthEvidence", key, "value"], message: `Evidence value must exactly match ${key}` });
    }
    const expected = orthotropicTsaiWuTestMetadata[key];
    if (value.strengthEvidence[key].testAxis !== expected.testAxis || value.strengthEvidence[key].testMode !== expected.testMode) {
      context.addIssue({ code: "custom", path: ["strengthEvidence", key], message: `Evidence must identify a ${expected.testMode} test along ${expected.testAxis} in the confirmed material frame` });
    }
  }
  for (const key of ["xy", "xz", "yz"] as const) {
    if (value.interactionEvidence[key].value !== value.interactions[key]) {
      context.addIssue({ code: "custom", path: ["interactionEvidence", key, "value"], message: `Biaxial evidence value must exactly match interaction ${key}` });
    }
    if (value.interactionEvidence[key].testAxis !== orthotropicTsaiWuInteractionTestAxis[key]
      || value.interactionEvidence[key].testMode !== "biaxial") {
      context.addIssue({ code: "custom", path: ["interactionEvidence", key], message: `Interaction evidence must identify a biaxial test along ${orthotropicTsaiWuInteractionTestAxis[key]} in the confirmed material frame` });
    }
  }
  const evidenceIds = [
    ...Object.values(value.strengthEvidence).map((item) => item.id),
    ...Object.values(value.interactionEvidence).map((item) => item.id),
  ];
  if (new Set(evidenceIds).size !== evidenceIds.length) context.addIssue({ code: "custom", path: ["strengthEvidence"], message: "Each Tsai-Wu input requires a distinct evidence ID" });
});
export type OrthotropicTsaiWuCriterion = z.infer<typeof orthotropicTsaiWuCriterionSchema>;
const orthotropicMaterialSchema = z.object({
  youngsModulus2MPa: z.number().finite().positive(),
  youngsModulus3MPa: z.number().finite().positive(),
  poissonRatio13: z.number().finite(),
  poissonRatio23: z.number().finite(),
  shearModulus12MPa: z.number().finite().positive(),
  shearModulus13MPa: z.number().finite().positive(),
  shearModulus23MPa: z.number().finite().positive(),
  evidence: z.object({
    youngsModulus2MPa: youngsModulusEvidenceSchema,
    youngsModulus3MPa: youngsModulusEvidenceSchema,
    poissonRatio13: poissonRatioEvidenceSchema,
    poissonRatio23: poissonRatioEvidenceSchema,
    shearModulus12MPa: youngsModulusEvidenceSchema,
    shearModulus13MPa: youngsModulusEvidenceSchema,
    shearModulus23MPa: youngsModulusEvidenceSchema,
  }).strict(),
  orientation: z.object({
    axis1DirectionGlobal: vector,
    axis2ReferenceDirectionGlobal: vector,
    buildDirectionGlobal: vector,
    evidence: orthotropicOrientationEvidenceSchema,
  }).strict(),
  process: materialCouponProcessSchema.optional(),
  factoredAllowables: orthotropicFactoredAllowablesSchema.optional(),
  couponRecordId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  tsaiWuQualificationRecordId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  tsaiWuCriterion: orthotropicTsaiWuCriterionSchema.optional(),
}).strict().superRefine((orthotropic, context) => {
  const process = orthotropic.process;
  const criterion = orthotropic.tsaiWuCriterion;
  if (orthotropic.tsaiWuQualificationRecordId && criterion) {
    context.addIssue({ code: "custom", path: ["tsaiWuQualificationRecordId"], message: "Provide either a saved Tsai-Wu qualification record ID or inline criterion data, not both" });
  }
  if ((orthotropic.tsaiWuQualificationRecordId || criterion) && process?.layerHeightMm === undefined) {
    context.addIssue({ code: "custom", path: ["process", "layerHeightMm"], message: "A Tsai-Wu FEA material requires the measured slicer layer height" });
  }
  if (!process || !criterion) return;
  const sameProcess = (evidenceProcess: typeof process) => sameMaterialCouponProcess(evidenceProcess, process);
  for (const key of orthotropicTsaiWuStrengthKeys) {
    if (!sameProcess(criterion.strengthEvidence[key].process)) {
      context.addIssue({ code: "custom", path: ["tsaiWuCriterion", "strengthEvidence", key, "process"], message: "Directional strength evidence must match the exact single-material print process" });
    }
  }
  for (const key of ["xy", "xz", "yz"] as const) {
    if (!sameProcess(criterion.interactionEvidence[key].process)) {
      context.addIssue({ code: "custom", path: ["tsaiWuCriterion", "interactionEvidence", key, "process"], message: "Biaxial interaction evidence must match the exact single-material print process" });
    }
  }
});
const factoredVonMisesAllowableEvidenceSchema = evidenceSchema.extend({ unit: z.literal("MPa") }).superRefine((evidence, context) => {
  if (evidence.status !== "measured" && evidence.status !== "sourced") {
    context.addIssue({ code: "custom", path: ["status"], message: "A factored von Mises design allowable must be directly measured or sourced, not assumed or derived from generic strength" });
  }
  if (evidence.value === undefined || !evidence.sourceUrl || !evidence.sourceLocator
    || !evidence.sourceHash || !/^[a-f0-9]{64}$/.test(evidence.sourceHash)) {
    context.addIssue({ code: "custom", message: "A factored von Mises allowable requires its exact value, source URL, SHA-256 and source locator" });
  }
});

const femStaticInputBaseSchema = z.object({
  bodyId: z.number().int().positive(),
  revision: z.string().min(1),
  supportFaceIds: z.array(z.string().min(1)).max(8).default([]).refine((ids) => new Set(ids).size === ids.length, "Support face IDs must be unique"),
  supportConditions: z.array(supportConditionSchema).min(1).max(8).optional()
    .refine((conditions) => !conditions || new Set(conditions.map((condition) => condition.faceId)).size === conditions.length, "Support condition face IDs must be unique"),
  faceLoads: z.array(faceLoadSchema).max(8).default([]).refine((loads) => new Set(loads.map((load) => load.faceId)).size === loads.length, "Loaded face IDs must be unique"),
  resultantLoads: z.array(resultantLoadSchema).max(8).default([]).refine((loads) => new Set(loads.map((load) => load.faceId)).size === loads.length, "Resultant-load face IDs must be unique"),
  loadCases: z.array(loadCaseSchema).max(8).default([]).refine((cases) => new Set(cases.map((item) => item.name.toLowerCase())).size === cases.length, "Load case names must be unique"),
  meshSizeMm: z.number().finite().positive().max(100),
  meshRefinementSteps: z.number().int().min(0).max(3).default(0),
  youngsModulusMPa: z.number().finite().positive(),
  youngsModulusEvidence: youngsModulusEvidenceSchema.optional(),
  poissonRatio: z.number().finite(),
  poissonRatioEvidence: poissonRatioEvidenceSchema,
  orthotropicMaterial: orthotropicMaterialSchema.optional(),
  layerPlanePlan: cohesiveLayerPlanePlanInputSchema.optional(),
  factoredVonMisesAllowableMPa: z.number().finite().positive().optional(),
  factoredVonMisesAllowableEvidence: factoredVonMisesAllowableEvidenceSchema.optional(),
  factoredVonMisesAllowableBasis: z.string().trim().min(12).max(1000).optional(),
  materialCoupon: z.object({
    recordId: z.string().regex(/^[a-f0-9]{64}$/),
    process: exactMaterialCouponProcessSchema,
  }).strict().optional(),
}).strict();

export const femStaticInputSchema = femStaticInputBaseSchema
  .refine((input) => input.supportConditions
    ? input.supportFaceIds.length === 0
    : input.supportFaceIds.length > 0, {
    message: "Provide either legacy supportFaceIds or explicit supportConditions, not both",
  })
  .refine((input) => {
    const selectedSupportIds = input.supportConditions?.map((condition) => condition.faceId) ?? input.supportFaceIds;
    return input.loadCases.length > 0
      ? input.faceLoads.length + input.resultantLoads.length === 0
        && input.loadCases.every((item) => [...item.faceLoads, ...item.resultantLoads].every((load) => !selectedSupportIds.includes(load.faceId)))
      : input.faceLoads.length + input.resultantLoads.length > 0
        && [...input.faceLoads, ...input.resultantLoads].every((load) => !selectedSupportIds.includes(load.faceId));
  }, {
    message: "Provide loads either in named loadCases or in the legacy single-case fields, and keep every loaded face distinct from supports",
  })
  .refine((input) => input.loadCases.every((item) => item.resultantLoads.every((load) => load.forceN.some((component) => component !== 0) || load.momentNmm.some((component) => component !== 0)))
    && input.resultantLoads.every((load) => load.forceN.some((component) => component !== 0) || load.momentNmm.some((component) => component !== 0)), {
    message: "Each resultant load must contain a nonzero force or moment",
  })
  .refine((input) => (input.loadCases.length || 1) * (input.meshRefinementSteps + 1) <= 12, {
    message: "At most 12 static solver jobs may be requested in one analysis",
  })
  .superRefine((input, context) => {
    if (input.materialCoupon && input.youngsModulusEvidence) {
      context.addIssue({ code: "custom", path: ["youngsModulusEvidence"], message: "Use either the exact physical coupon record or standalone Young's modulus evidence, not both" });
    } else if (!input.materialCoupon && !input.youngsModulusEvidence) {
      context.addIssue({ code: "custom", path: ["youngsModulusEvidence"], message: "Young's modulus requires a process-matched coupon record or property evidence" });
    }
    if (input.youngsModulusEvidence && input.youngsModulusEvidence.value !== input.youngsModulusMPa) {
      context.addIssue({ code: "custom", path: ["youngsModulusEvidence", "value"], message: "Young's modulus evidence value must exactly match youngsModulusMPa" });
    }
    if (input.poissonRatioEvidence.value !== input.poissonRatio) {
      context.addIssue({ code: "custom", path: ["poissonRatioEvidence", "value"], message: "Poisson-ratio evidence value must exactly match poissonRatio" });
    }
    if (input.orthotropicMaterial) {
      const orthotropic = input.orthotropicMaterial;
      const materialError = orthotropicElasticConstantsError({
        youngsModulusMPa: input.youngsModulusMPa,
        youngsModulus2MPa: orthotropic.youngsModulus2MPa,
        youngsModulus3MPa: orthotropic.youngsModulus3MPa,
        poissonRatio12: input.poissonRatio,
        poissonRatio13: orthotropic.poissonRatio13,
        poissonRatio23: orthotropic.poissonRatio23,
        shearModulus12MPa: orthotropic.shearModulus12MPa,
        shearModulus13MPa: orthotropic.shearModulus13MPa,
        shearModulus23MPa: orthotropic.shearModulus23MPa,
      });
      if (materialError) context.addIssue({ code: "custom", path: ["orthotropicMaterial"], message: materialError });
      for (const key of Object.keys(orthotropic.evidence) as Array<keyof typeof orthotropic.evidence>) {
        if (orthotropic.evidence[key].value !== orthotropic[key]) {
          context.addIssue({ code: "custom", path: ["orthotropicMaterial", "evidence", key, "value"], message: `Orthotropic evidence value must exactly match ${key}` });
        }
      }
      if (orthotropic.factoredAllowables) {
        for (const key of orthotropicFactoredAllowableKeys) {
          if (orthotropic.factoredAllowables.evidence[key].value !== orthotropic.factoredAllowables[key]) {
            context.addIssue({ code: "custom", path: ["orthotropicMaterial", "factoredAllowables", "evidence", key, "value"], message: `Allowable evidence value must exactly match ${key}` });
          }
        }
      }
      if ((orthotropic.tsaiWuCriterion || orthotropic.tsaiWuQualificationRecordId) && !orthotropic.process) {
        context.addIssue({ code: "custom", path: ["orthotropicMaterial", "process"], message: "An orthotropic Tsai-Wu screen requires the exact single-material printer, filament and slicer-profile identity" });
      }
      if (orthotropic.tsaiWuCriterion) {
        for (const key of orthotropicTsaiWuStrengthKeys) {
          if (orthotropic.tsaiWuCriterion.strengthEvidence[key].value !== orthotropic.tsaiWuCriterion.strengths[key]) {
            context.addIssue({ code: "custom", path: ["orthotropicMaterial", "tsaiWuCriterion", "strengthEvidence", key], message: `Tsai-Wu strength evidence must exactly match ${key}` });
          }
        }
        for (const key of ["xy", "xz", "yz"] as const) {
          if (orthotropic.tsaiWuCriterion.interactionEvidence[key].value !== orthotropic.tsaiWuCriterion.interactions[key]) {
            context.addIssue({ code: "custom", path: ["orthotropicMaterial", "tsaiWuCriterion", "interactionEvidence", key], message: `Tsai-Wu biaxial evidence must exactly match interaction ${key}` });
          }
        }
      }
      if (input.materialCoupon) {
        if (!orthotropic.couponRecordId) {
          context.addIssue({ code: "custom", path: ["materialCoupon"], message: "The physical coupon binding does not qualify a complete orthotropic tensor; bind one exact-process tensor with orthotropicMaterial.couponRecordId or provide separate evidence for each constant" });
        }
      }
      if (orthotropic.couponRecordId) {
        if (!input.materialCoupon || input.materialCoupon.recordId !== orthotropic.couponRecordId) {
          context.addIssue({ code: "custom", path: ["orthotropicMaterial", "couponRecordId"], message: "Full orthotropic coupon binding requires materialCoupon.recordId to reference the same immutable record" });
        }
        if (!orthotropic.process || orthotropic.process.layerHeightMm === undefined) {
          context.addIssue({ code: "custom", path: ["orthotropicMaterial", "process", "layerHeightMm"], message: "Full orthotropic coupon binding requires the exact measured single-material process including slicer layer height" });
        } else if (input.materialCoupon && !sameMaterialCouponProcess(orthotropic.process, input.materialCoupon.process)) {
          context.addIssue({ code: "custom", path: ["orthotropicMaterial", "process"], message: "Orthotropic and isotropic coupon bindings must use the same exact process" });
        }
        if (orthotropic.tsaiWuQualificationRecordId && orthotropic.tsaiWuQualificationRecordId !== orthotropic.couponRecordId) {
          context.addIssue({ code: "custom", path: ["orthotropicMaterial", "tsaiWuQualificationRecordId"], message: "Orthotropic tensor and Tsai-Wu bindings must reference the same immutable coupon record" });
        }
      }
      if (input.factoredVonMisesAllowableMPa !== undefined
        || input.factoredVonMisesAllowableEvidence !== undefined
        || input.factoredVonMisesAllowableBasis !== undefined) {
        context.addIssue({ code: "custom", path: ["factoredVonMisesAllowableMPa"], message: "A von Mises allowable is not a qualified failure criterion for this orthotropic model" });
      }
      try {
        const baseOrientation = resolveOrthotropicOrientation(orthotropic.orientation);
        if (input.layerPlanePlan) {
          const plan = createCohesiveLayerPlanePlan(input.layerPlanePlan);
          if (!orthotropic.process || orthotropic.process.layerHeightMm === undefined) {
            context.addIssue({ code: "custom", path: ["orthotropicMaterial", "process", "layerHeightMm"], message: "Layerwise static FEA requires the exact single-material printer, filament, profile and measured layer-height identity" });
          } else {
            if (orthotropic.process.profileHash !== plan.plan.processProfileHash) {
              context.addIssue({ code: "custom", path: ["layerPlanePlan", "processProfileHash"], message: "Layer-plane plan profile hash must match the exact orthotropic material process" });
            }
            if (Math.abs(orthotropic.process.layerHeightMm - plan.plan.layerHeightMm) > 1e-9) {
              context.addIssue({ code: "custom", path: ["layerPlanePlan", "layerHeightMm"], message: "Layer-plane plan height must match the measured orthotropic material process" });
            }
          }
          if (!plan.plan.roadAxisMapping) {
            context.addIssue({ code: "custom", path: ["layerPlanePlan", "roadAxisMapping"], message: "Layerwise static FEA requires explicit user confirmation that coupon axis 1 represents dominant deposited-road direction" });
          }
          if (Math.abs(baseOrientation.buildDirectionGlobal.reduce((sum, value, axis) => sum + value * plan.plan.buildDirectionGlobal[axis]!, 0)) < 1 - 1e-6) {
            context.addIssue({ code: "custom", path: ["layerPlanePlan", "buildDirectionGlobal"], message: "Layer-plane build direction must match the measured orthotropic coupon frame" });
          }
          if (orthotropic.factoredAllowables) {
            context.addIssue({ code: "custom", path: ["orthotropicMaterial", "factoredAllowables"], message: "Directional component allowables in one fixed material frame cannot screen varying layer-local stress axes" });
          }
        }
      } catch (error) {
        context.addIssue({ code: "custom", path: ["orthotropicMaterial", "orientation"], message: error instanceof Error ? error.message : String(error) });
      }
    } else if (input.poissonRatio <= -1 || input.poissonRatio >= 0.5) {
      context.addIssue({ code: "custom", path: ["poissonRatio"], message: "Isotropic Poisson ratio must be greater than -1 and less than 0.5" });
    }
    if (input.layerPlanePlan && !input.orthotropicMaterial) {
      context.addIssue({ code: "custom", path: ["layerPlanePlan"], message: "Layerwise static FEA requires one measured orthotropic tensor for the selected single material" });
    }
    if (input.youngsModulusEvidence?.id === input.poissonRatioEvidence.id) {
      context.addIssue({ code: "custom", path: ["poissonRatioEvidence", "id"], message: "Young's modulus and Poisson ratio evidence IDs must be distinct" });
    }
    const allowableParts = [input.factoredVonMisesAllowableMPa, input.factoredVonMisesAllowableEvidence, input.factoredVonMisesAllowableBasis];
    if (allowableParts.some((value) => value === undefined) && allowableParts.some((value) => value !== undefined)) {
      context.addIssue({ code: "custom", path: ["factoredVonMisesAllowableMPa"], message: "Provide the factored von Mises allowable, directly traceable evidence and its design basis together" });
    }
    if (input.factoredVonMisesAllowableEvidence
      && input.factoredVonMisesAllowableEvidence.value !== input.factoredVonMisesAllowableMPa) {
      context.addIssue({ code: "custom", path: ["factoredVonMisesAllowableEvidence", "value"], message: "Allowable evidence value must exactly match factoredVonMisesAllowableMPa" });
    }
    const evidenceIds = [
      input.youngsModulusEvidence?.id,
      input.poissonRatioEvidence.id,
      input.factoredVonMisesAllowableEvidence?.id,
      ...Object.values(input.orthotropicMaterial?.evidence ?? {}).map((evidence) => evidence.id),
      ...orthotropicFactoredAllowableKeys.map((key) => input.orthotropicMaterial?.factoredAllowables?.evidence[key].id),
      ...orthotropicTsaiWuStrengthKeys.map((key) => input.orthotropicMaterial?.tsaiWuCriterion?.strengthEvidence[key].id),
      ...(["xy", "xz", "yz"] as const).map((key) => input.orthotropicMaterial?.tsaiWuCriterion?.interactionEvidence[key].id),
    ].filter((id): id is string => !!id);
    if (new Set(evidenceIds).size !== evidenceIds.length) {
      context.addIssue({ code: "custom", path: ["factoredVonMisesAllowableEvidence", "id"], message: "Each FEA material property needs a distinct evidence ID" });
    }
  });

const legacyFemStaticInputSchema = femStaticInputBaseSchema.omit({
  youngsModulusEvidence: true,
  poissonRatioEvidence: true,
  orthotropicMaterial: true,
});
const femReportInputSchema = z.union([femStaticInputSchema, legacyFemStaticInputSchema]);

const binding = z.object({
  sessionId: z.string().min(1),
  documentToken: z.string().min(1),
  revision: z.string().min(1),
  bodyId: z.number().int().positive(),
}).strict();

const mesh = z.object({
  meshFile: z.string().min(1),
  codeAsterMeshFile: z.string().min(1).optional(),
  codeAsterMeshFormat: z.literal("GMSH-2.2").optional(),
  codeAsterPhysicalGroups: z.array(z.object({
    dimension: z.union([z.literal(2), z.literal(3)]),
    tag: z.number().int().positive(),
    name: z.string().min(1),
    faceId: z.string().min(1).nullable(),
  }).strict()).min(1).optional(),
  elementSICNFile: z.string().min(1).optional(),
  meshSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  meshSizeMm: z.number().finite().positive(),
  elementFamily: z.literal("C3D4"),
  nodeCount: z.number().int().min(4).max(1_000_000),
  tetrahedronCount: z.number().int().min(1).max(500_000),
  layerRegionGroups: z.array(z.object({
    layerIndex: z.number().int().positive(),
    elsetName: z.string().regex(/^LAYER_[1-9][0-9]*$/),
    tetrahedronCount: z.number().int().positive(),
  }).strict()).min(2).max(MAX_LAYERWISE_FEA_LAYERS).optional(),
  minimumScaledInverseConditionNumber: z.number().finite().positive().max(1),
  fifthPercentileSampledSICN: z.number().finite().positive().max(1).optional(),
  medianSampledSICN: z.number().finite().positive().max(1).optional(),
  minimumSICNElementId: z.number().int().positive().optional(),
  minimumSICNElementCentroidMm: vector.optional(),
  boundsMm: z.object({ min: vector, max: vector }).strict(),
  nodeSets: z.array(z.object({ faceId: z.string().min(1), setName: z.string().min(1), nodeCount: z.number().int().positive() }).strict()),
  sharedSurfaceNodeCount: z.number().int().nonnegative(),
  loadFile: z.string().min(1).nullable(),
  surfaceLoads: z.array(z.object({
    faceId: z.string().min(1),
    surfaceAreaMm2: z.number().finite().positive(),
    tractionNPerMm2: vector,
    resultantN: vector,
    resultantMomentNmm: vector,
    loadedNodeCount: z.number().int().positive(),
  }).strict()),
  resultantLoads: z.array(z.object({
    faceId: z.string().min(1),
    forceN: vector,
    applicationPointMm: vector,
    momentNmm: vector,
    appliedMomentAtOriginNmm: vector,
  }).strict()),
  totalResultantN: vector,
  totalResultantMomentNmm: vector,
}).strict().superRefine((value, context) => {
  validateMeshQualitySummary(value, context);
  if (value.layerRegionGroups && (value.layerRegionGroups.some((group, index) => group.layerIndex !== index + 1 || group.elsetName !== `LAYER_${index + 1}`)
    || value.layerRegionGroups.reduce((sum, group) => sum + group.tetrahedronCount, 0) !== value.tetrahedronCount)) {
    context.addIssue({ code: "custom", path: ["layerRegionGroups"], message: "Layer region groups must be ordered and partition the solid tetrahedra" });
  }
  const codeAsterFields = [value.codeAsterMeshFile, value.codeAsterMeshFormat, value.codeAsterPhysicalGroups];
  if (codeAsterFields.some((field) => field !== undefined) && codeAsterFields.some((field) => field === undefined)) {
    context.addIssue({ code: "custom", message: "Code_Aster mesh evidence must include its file, format and physical groups together" });
  }
  if (value.codeAsterPhysicalGroups) {
    const tags = value.codeAsterPhysicalGroups.map((group) => `${group.dimension}:${group.tag}`);
    if (new Set(tags).size !== tags.length) {
      context.addIssue({ code: "custom", path: ["codeAsterPhysicalGroups"], message: "Code_Aster physical group dimensions and tags must be unique" });
    }
  }
});

function validateMeshQualitySummary(
  value: {
    minimumScaledInverseConditionNumber: number;
    fifthPercentileSampledSICN?: number | undefined;
    medianSampledSICN?: number | undefined;
    minimumSICNElementId?: number | undefined;
    minimumSICNElementCentroidMm?: [number, number, number] | undefined;
    boundsMm?: { min: [number, number, number]; max: [number, number, number] } | undefined;
  },
  context: z.RefinementCtx,
): void {
  const hasP05 = value.fifthPercentileSampledSICN !== undefined;
  const hasMedian = value.medianSampledSICN !== undefined;
  if (hasP05 !== hasMedian) context.addIssue({ code: "custom", message: "FEA mesh quality distribution must include both P05 and median SICN" });
  if (hasP05 && (value.fifthPercentileSampledSICN! < value.minimumScaledInverseConditionNumber
    || value.medianSampledSICN! < value.fifthPercentileSampledSICN!)) {
    context.addIssue({ code: "custom", message: "FEA mesh SICN distribution is inconsistent with its minimum, P05 and median" });
  }
  const hasElementId = value.minimumSICNElementId !== undefined;
  const hasCentroid = value.minimumSICNElementCentroidMm !== undefined;
  if (hasElementId !== hasCentroid || (hasP05 && !hasElementId)) {
    context.addIssue({ code: "custom", message: "FEA mesh quality summary must include the minimum-SICN element ID and centroid" });
  }
  if (hasCentroid && value.boundsMm
    && value.minimumSICNElementCentroidMm!.some((coordinate, axis) => coordinate < value.boundsMm!.min[axis]! || coordinate > value.boundsMm!.max[axis]!)) {
    context.addIssue({ code: "custom", message: "FEA minimum-SICN element centroid lies outside mesh bounds" });
  }
}

const stressExtremumLocationSchema = z.object({
  elementId: z.number().int().positive(),
  integrationPoint: z.number().int().positive(),
  centroidMm: vector,
}).strict();
const stressTensorComponentExtremaSchema = z.object({
  minimumMPa: z.number().finite(),
  maximumMPa: z.number().finite(),
  minimumLocation: stressExtremumLocationSchema,
  maximumLocation: stressExtremumLocationSchema,
}).strict();
const stressPointLocationSchema = z.object({
  elementId: z.number().int().positive(),
  integrationPoint: z.number().int().positive(),
  centroidMm: vector,
}).strict();
const orthotropicTsaiWuResultSchema = z.object({
  maximumFailureIndex: z.number().finite(),
  maximumFailureIndexLocation: stressPointLocationSchema,
  minimumLoadFactorToIndexOne: z.number().finite().positive().nullable(),
  minimumLoadFactorLocation: stressPointLocationSchema.nullable(),
}).strict().superRefine((result, context) => {
  if ((result.minimumLoadFactorToIndexOne === null) !== (result.minimumLoadFactorLocation === null)) {
    context.addIssue({ code: "custom", message: "Tsai-Wu reserve factor and its mesh location must be present together" });
  }
});

const calculation = z.object({
  solver: z.literal("CalculiX 2.20"),
  elementFamily: z.literal("C3D4"),
  stressCoordinateBasis: z.enum(["global", "material-local", "layer-local"]).optional(),
  stressIntegrationPointCount: z.number().int().positive(),
  stressTensorComponentExtrema: z.object({
    sxx: stressTensorComponentExtremaSchema,
    syy: stressTensorComponentExtremaSchema,
    szz: stressTensorComponentExtremaSchema,
    sxy: stressTensorComponentExtremaSchema,
    sxz: stressTensorComponentExtremaSchema,
    syz: stressTensorComponentExtremaSchema,
  }).strict().optional(),
  orthotropicTsaiWu: orthotropicTsaiWuResultSchema.optional(),
  minimumSxxMPa: z.number().finite(),
  maximumSxxMPa: z.number().finite(),
  maximumVonMisesMPa: z.number().finite().nonnegative(),
  maximumVonMisesLocation: z.object({
    elementId: z.number().int().positive(),
    integrationPoint: z.number().int().positive(),
    centroidMm: vector,
  }).strict().optional(),
  maximumPrincipalStressMPa: z.number().finite().optional(),
  maximumPrincipalStressLocation: z.object({ elementId: z.number().int().positive(), integrationPoint: z.number().int().positive(), centroidMm: vector }).strict().optional(),
  minimumPrincipalStressMPa: z.number().finite().optional(),
  minimumPrincipalStressLocation: z.object({ elementId: z.number().int().positive(), integrationPoint: z.number().int().positive(), centroidMm: vector }).strict().optional(),
  maximumVonMisesElementSICN: z.number().finite().positive().max(1).optional(),
  maximumVonMisesOnMinimumSICNElement: z.boolean().optional(),
  prescribedDisplacementMm: z.number().finite().nullable(),
  displacementObservationNodeSetName: z.string().min(1),
  displacementObservationAxis: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  maximumDisplacementOnSetMm: z.number().finite().nonnegative(),
  supportReactionN: vector,
  supportReactionMomentNmm: vector,
  supportReactionsByNodeSet: z.array(z.object({
    nodeSetName: z.string().min(1),
    forceN: vector,
    momentNmm: vector,
  }).strict()).min(1).max(8).optional(),
  forceEquilibriumResidualN: vector,
  momentEquilibriumResidualNmm: vector,
  jobName: z.string().min(1),
  inputPath: z.string().min(1),
  reportPath: z.string().min(1),
}).strict().superRefine((value, context) => {
  if (value.stressTensorComponentExtrema) {
    for (const [component, extrema] of Object.entries(value.stressTensorComponentExtrema)) {
      if (extrema.minimumMPa > extrema.maximumMPa) {
        context.addIssue({ code: "custom", path: ["stressTensorComponentExtrema", component], message: "Stress tensor component extrema are reversed" });
      }
    }
  }
  const principalFields = [value.maximumPrincipalStressMPa, value.maximumPrincipalStressLocation,
    value.minimumPrincipalStressMPa, value.minimumPrincipalStressLocation];
  if (principalFields.some((field) => field !== undefined)
    && (principalFields.some((field) => field === undefined)
      || value.maximumPrincipalStressMPa! < value.minimumPrincipalStressMPa!)) {
    context.addIssue({ code: "custom", message: "FEA principal stress extrema must include ordered values and mesh-bound locations" });
  }
});

const calculationCase = z.object({
  name: z.string().min(1),
  meshSha256: z.string().regex(/^[a-f0-9]{64}$/),
  loadFile: z.string().min(1),
  surfaceLoads: z.array(mesh.shape.surfaceLoads.element),
  resultantLoads: z.array(mesh.shape.resultantLoads.element),
  totalResultantN: vector,
  totalResultantMomentNmm: vector,
  calculation,
  refinementDiagnostics: z.object({
    maximumVonMisesMPa: z.enum(["increasing", "decreasing", "unchanged", "non-monotonic", "insufficient-levels"]),
    maximumDisplacementOnSetMm: z.enum(["increasing", "decreasing", "unchanged", "non-monotonic", "insufficient-levels"]),
    maximumPrincipalStressMPa: z.enum(["increasing", "decreasing", "unchanged", "non-monotonic", "insufficient-levels"]).optional(),
    minimumPrincipalStressMPa: z.enum(["increasing", "decreasing", "unchanged", "non-monotonic", "insufficient-levels"]).optional(),
    interpretation: z.literal("sampled-trend-only"),
  }).strict().optional(),
  meshLevels: z.array(z.object({
    meshSizeMm: z.number().finite().positive(),
    meshSha256: z.string().regex(/^[a-f0-9]{64}$/),
    nodeCount: z.number().int().min(4).max(1_000_000),
    tetrahedronCount: z.number().int().positive().max(500_000),
    layerRegionGroups: mesh.shape.layerRegionGroups,
    minimumScaledInverseConditionNumber: z.number().finite().positive().max(1),
    fifthPercentileSampledSICN: z.number().finite().positive().max(1).optional(),
    medianSampledSICN: z.number().finite().positive().max(1).optional(),
    minimumSICNElementId: z.number().int().positive().optional(),
    minimumSICNElementCentroidMm: vector.optional(),
    totalResultantN: vector,
    totalResultantMomentNmm: vector,
    calculation,
    relativeChangeFromPreviousPercent: z.object({
      maximumVonMisesMPa: z.number().finite().nullable(),
      maximumDisplacementOnSetMm: z.number().finite().nullable(),
      maximumPrincipalStressMPa: z.number().finite().nullable().optional(),
      minimumPrincipalStressMPa: z.number().finite().nullable().optional(),
      maximumVonMisesLocationShiftMm: z.number().finite().nonnegative().nullable().optional(),
    }).strict().nullable(),
  }).strict().superRefine(validateMeshQualitySummary)).min(1).max(4).optional(),
}).strict();

const faceMapping = z.object({
  faceId: z.string().min(1),
  surfaceEntityTag: z.number().int().positive(),
  surfaceType: z.literal("Plane"),
  centerMm: vector,
  normal: vector,
  boundsMm: z.object({ min: vector, max: vector }).strict(),
  areaMm2: z.number().finite().positive(),
  maxSignatureErrorMm: z.number().finite().nonnegative(),
  normalDot: z.number().finite().min(0.99999).max(1),
}).strict();

const femReportSchema = z.object({
  kind: z.literal("static-fem-linear-elastic"),
  id: z.string().regex(/^[A-Za-z0-9-]{36}$/),
  createdAt: z.iso.datetime(),
  binding,
  input: femReportInputSchema,
  bodyName: z.string().nullable(),
  boundsMm: z.object({ min: vector, max: vector }).strict(),
  gmshVersion: z.string().min(1),
  faceMappings: z.array(faceMapping).min(2).max(16),
  supportFaceAreasMm2: z.array(z.object({ faceId: z.string().min(1), areaMm2: z.number().finite().positive() }).strict()).min(1).max(8),
  supportRigidBodyConstraintRank: z.literal(6).optional(),
  mesh,
  calculation,
  cases: z.array(calculationCase).min(1).max(8).optional(),
}).strict().superRefine((report, context) => {
  const hasOrthotropicMaterial = "orthotropicMaterial" in report.input && !!report.input.orthotropicMaterial;
  const hasLayerwisePlan = "layerPlanePlan" in report.input && !!report.input.layerPlanePlan;
  const expectedStressCoordinateBasis = hasLayerwisePlan ? "layer-local" : hasOrthotropicMaterial ? "material-local" : "global";
  const stressBasisMatchesMaterial = (value: z.infer<typeof calculation>, required: boolean): boolean =>
    value.stressCoordinateBasis === expectedStressCoordinateBasis
      || (!required && value.stressCoordinateBasis === undefined);
  if (!stressBasisMatchesMaterial(report.calculation, hasLayerwisePlan || hasOrthotropicMaterial)) {
    context.addIssue({ code: "custom", message: "FEA calculation stress-coordinate basis does not match its material model" });
  }
  if (report.input.bodyId !== report.binding.bodyId || report.input.revision !== report.binding.revision) {
    context.addIssue({ code: "custom", message: "FEA input and CAD binding disagree" });
  }
  const selectedSupportIds = femSupportFaceIds(report.input);
  const caseInputs = report.input.loadCases.length > 0
    ? report.input.loadCases
    : [{ name: "default", faceLoads: report.input.faceLoads, resultantLoads: report.input.resultantLoads }];
  const firstCase = caseInputs[0]!;
  const selectedLoadIds = firstCase.faceLoads.map((load) => load.faceId);
  const selectedResultantIds = firstCase.resultantLoads.map((load) => load.faceId);
  const allLoadIds = caseInputs.flatMap((item) => [...item.faceLoads.map((load) => load.faceId), ...item.resultantLoads.map((load) => load.faceId)]);
  if (report.mesh.meshSizeMm !== report.input.meshSizeMm || report.mesh.surfaceLoads.length !== selectedLoadIds.length
    || report.mesh.surfaceLoads.some((load, index) => load.faceId !== selectedLoadIds[index]
      || load.tractionNPerMm2.some((component, axis) => component !== firstCase.faceLoads[index]?.tractionNPerMm2[axis])
      || Math.abs(load.surfaceAreaMm2 - (report.faceMappings.find((mapping) => mapping.faceId === load.faceId)?.areaMm2 ?? -1)) > 1e-9
      || load.resultantN.some((component, axis) => Math.abs(component - load.tractionNPerMm2[axis]! * load.surfaceAreaMm2) > Math.max(1e-6, Math.abs(component) * 1e-9)))
    || report.mesh.resultantLoads.length !== selectedResultantIds.length
    || report.mesh.resultantLoads.some((load, index) => load.faceId !== selectedResultantIds[index]
      || load.forceN.some((component, axis) => component !== firstCase.resultantLoads[index]?.forceN[axis])
      || load.applicationPointMm.some((component, axis) => component !== firstCase.resultantLoads[index]?.applicationPointMm[axis])
      || load.momentNmm.some((component, axis) => component !== firstCase.resultantLoads[index]?.momentNmm[axis])
      || load.appliedMomentAtOriginNmm.some((component, axis) => Math.abs(component - (cross(firstCase.resultantLoads[index]!.applicationPointMm, firstCase.resultantLoads[index]!.forceN)[axis]! + firstCase.resultantLoads[index]!.momentNmm[axis]!)) > Math.max(1e-6, Math.abs(component) * 1e-9)))
    || report.mesh.nodeSets.length !== selectedSupportIds.length + new Set(allLoadIds).size
    || selectedSupportIds.some((id) => !report.mesh.nodeSets.some((set) => set.faceId === id))
    || allLoadIds.some((id) => !report.mesh.nodeSets.some((set) => set.faceId === id))
    || report.mesh.totalResultantN.some((component, axis) => Math.abs(component - report.mesh.surfaceLoads.reduce((sum, load) => sum + load.resultantN[axis]!, report.mesh.resultantLoads.reduce((sum, load) => sum + load.forceN[axis]!, 0))) > Math.max(1e-6, Math.abs(component) * 1e-9))
    || report.mesh.totalResultantMomentNmm.some((component, axis) => Math.abs(component - report.mesh.surfaceLoads.reduce((sum, load) => sum + load.resultantMomentNmm[axis]!, report.mesh.resultantLoads.reduce((total, load) => total + load.appliedMomentAtOriginNmm[axis]!, 0))) > Math.max(1e-6, Math.abs(component) * 1e-9))) {
    context.addIssue({ code: "custom", message: "FEA report mesh does not match its support, load, or mesh-size inputs" });
  }
  if (report.calculation.forceEquilibriumResidualN.some((residual, axis) => Math.abs(residual - (report.calculation.supportReactionN[axis]! + report.mesh.totalResultantN[axis]!)) > 1e-9)
    || report.calculation.momentEquilibriumResidualNmm.some((residual, axis) => Math.abs(residual - (report.calculation.supportReactionMomentNmm[axis]! + report.mesh.totalResultantMomentNmm[axis]!)) > 1e-9)) {
    context.addIssue({ code: "custom", message: "FEA equilibrium residual does not match the applied and support resultants" });
  }
  const expectedSupportSetNames = report.mesh.nodeSets.filter((set) => selectedSupportIds.includes(set.faceId)).map((set) => set.setName);
  if (report.calculation.supportReactionsByNodeSet && !supportReactionsMatch(report.calculation, expectedSupportSetNames)) {
    context.addIssue({ code: "custom", message: "FEA per-support reactions do not sum to the total reaction" });
  }
  if (report.calculation.maximumVonMisesOnMinimumSICNElement !== undefined
    && (report.mesh.minimumSICNElementId === undefined
      || report.calculation.maximumVonMisesOnMinimumSICNElement !== (report.calculation.maximumVonMisesLocation?.elementId === report.mesh.minimumSICNElementId))) {
    context.addIssue({ code: "custom", message: "FEA stress-peak and minimum-SICN element overlap evidence is inconsistent" });
  }
  if (report.calculation.maximumVonMisesElementSICN !== undefined
    && report.calculation.maximumVonMisesElementSICN < report.mesh.minimumScaledInverseConditionNumber) {
    context.addIssue({ code: "custom", message: "FEA stress-peak element SICN is below the mesh minimum" });
  }
  if (report.cases) {
    const inputs = report.input.loadCases.length > 0
      ? report.input.loadCases
      : [{ name: "default", faceLoads: report.input.faceLoads, resultantLoads: report.input.resultantLoads }];
    if (report.cases.length !== inputs.length || report.cases.some((result, index) => {
      const loadCase = inputs[index];
      const vectorsMatch = result.totalResultantN.every((value, axis) => Math.abs(value - result.surfaceLoads.reduce((sum, item) => sum + item.resultantN[axis]!, result.resultantLoads.reduce((total, item) => total + item.forceN[axis]!, 0))) <= Math.max(1e-6, Math.abs(value) * 1e-9))
        && result.totalResultantMomentNmm.every((value, axis) => Math.abs(value - result.surfaceLoads.reduce((sum, item) => sum + item.resultantMomentNmm[axis]!, result.resultantLoads.reduce((total, item) => total + item.appliedMomentAtOriginNmm[axis]!, 0))) <= Math.max(1e-6, Math.abs(value) * 1e-9));
      const inputsMatch = !!loadCase && result.name === loadCase.name
        && result.meshSha256 === report.mesh.meshSha256
        && result.loadFile.startsWith("/")
        && result.surfaceLoads.length === loadCase.faceLoads.length
        && result.surfaceLoads.every((item, loadIndex) => item.faceId === loadCase.faceLoads[loadIndex]?.faceId
          && item.tractionNPerMm2.every((value, axis) => value === loadCase.faceLoads[loadIndex]?.tractionNPerMm2[axis])
          && Math.abs(item.surfaceAreaMm2 - (report.faceMappings.find((mapping) => mapping.faceId === item.faceId)?.areaMm2 ?? -1)) <= 1e-9
          && item.resultantN.every((value, axis) => Math.abs(value - item.tractionNPerMm2[axis]! * item.surfaceAreaMm2) <= Math.max(1e-6, Math.abs(value) * 1e-9)))
        && result.resultantLoads.length === loadCase.resultantLoads.length
        && result.resultantLoads.every((item, loadIndex) => item.faceId === loadCase.resultantLoads[loadIndex]?.faceId
          && item.forceN.every((value, axis) => value === loadCase.resultantLoads[loadIndex]?.forceN[axis])
          && item.applicationPointMm.every((value, axis) => value === loadCase.resultantLoads[loadIndex]?.applicationPointMm[axis])
          && item.momentNmm.every((value, axis) => value === loadCase.resultantLoads[loadIndex]?.momentNmm[axis])
          && item.appliedMomentAtOriginNmm.every((value, axis) => Math.abs(value - (cross(item.applicationPointMm, item.forceN)[axis]! + item.momentNmm[axis]!)) <= Math.max(1e-6, Math.abs(value) * 1e-9)));
      const equilibriumMatches = result.calculation.forceEquilibriumResidualN.every((value, axis) => Math.abs(value - (result.calculation.supportReactionN[axis]! + result.totalResultantN[axis]!)) <= 1e-9)
        && result.calculation.momentEquilibriumResidualNmm.every((value, axis) => Math.abs(value - (result.calculation.supportReactionMomentNmm[axis]! + result.totalResultantMomentNmm[axis]!)) <= 1e-9)
        && (!result.calculation.supportReactionsByNodeSet || supportReactionsMatch(result.calculation, expectedSupportSetNames));
      const refinementMatches = result.meshLevels === undefined
        ? report.input.meshRefinementSteps === 0
        : result.meshLevels.length === report.input.meshRefinementSteps + 1
          && result.meshLevels.every((level, levelIndex) => level.meshSizeMm === report.input.meshSizeMm / (2 ** levelIndex)
            && level.totalResultantN.every((value, axis) => Math.abs(value - result.totalResultantN[axis]!) <= Math.max(1e-6, Math.abs(value) * 1e-9))
            && level.totalResultantMomentNmm.every((value, axis) => Math.abs(value - result.totalResultantMomentNmm[axis]!) <= Math.max(1e-6, Math.abs(value) * 1e-9))
            && level.calculation.forceEquilibriumResidualN.every((value, axis) => Math.abs(value - (level.calculation.supportReactionN[axis]! + level.totalResultantN[axis]!)) <= 1e-9)
            && level.calculation.momentEquilibriumResidualNmm.every((value, axis) => Math.abs(value - (level.calculation.supportReactionMomentNmm[axis]! + level.totalResultantMomentNmm[axis]!)) <= 1e-9)
            && (!level.calculation.supportReactionsByNodeSet || supportReactionsMatch(level.calculation, expectedSupportSetNames))
            && (level.calculation.maximumVonMisesOnMinimumSICNElement === undefined
              || level.minimumSICNElementId !== undefined
                && level.calculation.maximumVonMisesOnMinimumSICNElement === (level.calculation.maximumVonMisesLocation?.elementId === level.minimumSICNElementId))
            && (level.calculation.maximumVonMisesElementSICN === undefined
              || level.calculation.maximumVonMisesElementSICN >= level.minimumScaledInverseConditionNumber)
            && (levelIndex === 0 || level.relativeChangeFromPreviousPercent !== null)
            && (levelIndex !== 0 || level.relativeChangeFromPreviousPercent === null)
            && (levelIndex === 0 || relativeChangeMatches(level.relativeChangeFromPreviousPercent!, level.calculation, result.meshLevels![levelIndex - 1]!.calculation)))
          && result.meshLevels[0]?.meshSha256 === result.meshSha256
          && result.meshLevels[0]?.calculation.jobName === result.calculation.jobName;
      const hasLayerwiseRegions = hasLayerwisePlan;
      const layerGroupsMatch = (groups: typeof report.mesh.layerRegionGroups | undefined, tetrahedra: number): boolean =>
        hasLayerwiseRegions
          ? !!groups && groups.length === report.input.layerPlanePlan!.totalLayerCount
            && groups.reduce((sum, group) => sum + group.tetrahedronCount, 0) === tetrahedra
          : groups === undefined;
      const stressBasisMatches = stressBasisMatchesMaterial(result.calculation, hasLayerwisePlan || hasOrthotropicMaterial)
        && (result.meshLevels === undefined || result.meshLevels.every((level) => stressBasisMatchesMaterial(level.calculation, hasLayerwisePlan || hasOrthotropicMaterial)))
        && layerGroupsMatch(report.mesh.layerRegionGroups, report.mesh.tetrahedronCount)
        && (result.meshLevels === undefined || result.meshLevels.every((level) => layerGroupsMatch(level.layerRegionGroups, level.tetrahedronCount)));
      const diagnosticsMatch = result.refinementDiagnostics === undefined
        || (result.meshLevels !== undefined
            && result.refinementDiagnostics.interpretation === "sampled-trend-only"
            && result.refinementDiagnostics.maximumVonMisesMPa === classifyRefinementTrend(result.meshLevels.map((level) => level.calculation.maximumVonMisesMPa))
          && result.refinementDiagnostics.maximumDisplacementOnSetMm === classifyRefinementTrend(result.meshLevels.map((level) => level.calculation.maximumDisplacementOnSetMm))
          && (result.refinementDiagnostics.maximumPrincipalStressMPa === undefined
            || result.meshLevels.every((level) => level.calculation.maximumPrincipalStressMPa !== undefined)
              && result.refinementDiagnostics.maximumPrincipalStressMPa === classifyRefinementTrend(result.meshLevels.map((level) => level.calculation.maximumPrincipalStressMPa!)))
          && (result.refinementDiagnostics.minimumPrincipalStressMPa === undefined
            || result.meshLevels.every((level) => level.calculation.minimumPrincipalStressMPa !== undefined)
              && result.refinementDiagnostics.minimumPrincipalStressMPa === classifyRefinementTrend(result.meshLevels.map((level) => level.calculation.minimumPrincipalStressMPa!))));
      return !inputsMatch || !vectorsMatch || !equilibriumMatches || !refinementMatches || !diagnosticsMatch || !stressBasisMatches;
    })) context.addIssue({ code: "custom", message: "FEA named load case inputs, resultants or equilibrium evidence are inconsistent" });
    if (report.cases[0]?.calculation.jobName !== report.calculation.jobName) context.addIssue({ code: "custom", message: "Legacy calculation summary must match the first named load case" });
    if (!report.mesh.meshSha256 || report.cases.some((result) => result.meshSha256 !== report.mesh.meshSha256)) context.addIssue({ code: "custom", message: "FEA named load cases do not share one verified mesh hash" });
    const levels = report.cases[0]?.meshLevels;
    if (levels && report.cases.some((result) => result.meshLevels?.some((level, index) => level.meshSha256 !== levels[index]?.meshSha256))) {
      context.addIssue({ code: "custom", message: "FEA load cases do not share a mesh at each refinement level" });
    }
  } else if (report.input.meshRefinementSteps > 0) {
    context.addIssue({ code: "custom", message: "FEA report omitted its requested mesh-refinement evidence" });
  }
  if (report.faceMappings.length !== selectedSupportIds.length + new Set(allLoadIds).size
    || new Set(report.faceMappings.map((mapping) => mapping.faceId)).size !== selectedSupportIds.length + new Set(allLoadIds).size
    || selectedSupportIds.some((id) => !report.faceMappings.some((mapping) => mapping.faceId === id))
    || allLoadIds.some((id) => !report.faceMappings.some((mapping) => mapping.faceId === id))) {
    context.addIssue({ code: "custom", message: "FEA report face mapping does not match its selected native faces" });
  }
  if (report.supportFaceAreasMm2.length !== selectedSupportIds.length
    || new Set(report.supportFaceAreasMm2.map((face) => face.faceId)).size !== selectedSupportIds.length
    || report.supportFaceAreasMm2.some((face) => !selectedSupportIds.includes(face.faceId)
      || Math.abs(face.areaMm2 - (report.faceMappings.find((mapping) => mapping.faceId === face.faceId)?.areaMm2 ?? -1)) > 1e-9)
    || report.mesh.sharedSurfaceNodeCount !== 0) {
    context.addIssue({ code: "custom", message: "FEA support mapping or separation evidence is inconsistent" });
  }
});

function relativeChangeMatches(
  reported: {
    maximumVonMisesMPa: number | null;
    maximumDisplacementOnSetMm: number | null;
    maximumPrincipalStressMPa?: number | null | undefined;
    minimumPrincipalStressMPa?: number | null | undefined;
    maximumVonMisesLocationShiftMm?: number | null | undefined;
  },
  current: {
    maximumVonMisesMPa: number; maximumDisplacementOnSetMm: number;
    maximumPrincipalStressMPa?: number | undefined; minimumPrincipalStressMPa?: number | undefined;
    maximumVonMisesLocation?: { centroidMm: [number, number, number] } | undefined;
  },
  previous: {
    maximumVonMisesMPa: number; maximumDisplacementOnSetMm: number;
    maximumPrincipalStressMPa?: number | undefined; minimumPrincipalStressMPa?: number | undefined;
    maximumVonMisesLocation?: { centroidMm: [number, number, number] } | undefined;
  },
): boolean {
  const expected = (value: number, base: number): number | null => base === 0 ? null : (value - base) / Math.abs(base) * 100;
  const close = (actual: number | null, target: number | null): boolean => actual === null || target === null
    ? actual === target
    : Math.abs(actual - target) <= Math.max(1e-9, Math.abs(target) * 1e-9);
  const expectedLocationShift = current.maximumVonMisesLocation && previous.maximumVonMisesLocation
    ? Math.hypot(...current.maximumVonMisesLocation.centroidMm.map((coordinate, axis) => coordinate - previous.maximumVonMisesLocation!.centroidMm[axis]!))
    : null;
  return close(reported.maximumVonMisesMPa, expected(current.maximumVonMisesMPa, previous.maximumVonMisesMPa))
    && close(reported.maximumDisplacementOnSetMm, expected(current.maximumDisplacementOnSetMm, previous.maximumDisplacementOnSetMm))
    && optionalPrincipalChangeMatches(reported.maximumPrincipalStressMPa, current.maximumPrincipalStressMPa, previous.maximumPrincipalStressMPa, expected, close)
    && optionalPrincipalChangeMatches(reported.minimumPrincipalStressMPa, current.minimumPrincipalStressMPa, previous.minimumPrincipalStressMPa, expected, close)
    && (reported.maximumVonMisesLocationShiftMm === undefined
      || close(reported.maximumVonMisesLocationShiftMm, expectedLocationShift));
}

function optionalPrincipalChangeMatches(
  reported: number | null | undefined,
  current: number | undefined,
  previous: number | undefined,
  expected: (value: number, base: number) => number | null,
  close: (actual: number | null, target: number | null) => boolean,
): boolean {
  if (current === undefined || previous === undefined) return reported === undefined;
  return reported !== undefined && close(reported, expected(current, previous));
}

function supportReactionsMatch(value: z.infer<typeof calculation>, expectedSetNames: string[]): boolean {
  const reactions = value.supportReactionsByNodeSet;
  return !!reactions && reactions.length === expectedSetNames.length
    && new Set(reactions.map((reaction) => reaction.nodeSetName)).size === expectedSetNames.length
    && expectedSetNames.every((name) => reactions.some((reaction) => reaction.nodeSetName === name))
    && reactions.reduce<[number, number, number]>((sum, reaction) => [sum[0] + reaction.forceN[0], sum[1] + reaction.forceN[1], sum[2] + reaction.forceN[2]], [0, 0, 0])
      .every((component, axis) => Math.abs(component - value.supportReactionN[axis]!) <= Math.max(1e-6, Math.abs(component) * 1e-9))
    && reactions.reduce<[number, number, number]>((sum, reaction) => [sum[0] + reaction.momentNmm[0], sum[1] + reaction.momentNmm[1], sum[2] + reaction.momentNmm[2]], [0, 0, 0])
      .every((component, axis) => Math.abs(component - value.supportReactionMomentNmm[axis]!) <= Math.max(1e-6, Math.abs(component) * 1e-9));
}

function cross(first: [number, number, number], second: [number, number, number]): [number, number, number] {
  return [first[1] * second[2] - first[2] * second[1], first[2] * second[0] - first[0] * second[2], first[0] * second[1] - first[1] * second[0]];
}

export type FemStaticInput = z.infer<typeof femStaticInputSchema>;
type FemSupportInput = { supportFaceIds: string[]; supportConditions?: SupportConditionInput[] | undefined };

export function resolveFemSupportConditions(input: FemSupportInput): Array<{
  faceId: string;
  fixedTranslationAxes: Array<1 | 2 | 3>;
}> {
  const axisDof = { x: 1, y: 2, z: 3 } as const;
  if (input.supportConditions) {
    return input.supportConditions.map((condition) => ({
      faceId: condition.faceId,
      fixedTranslationAxes: condition.fixedTranslationAxes.map((axis) => axisDof[axis]),
    }));
  }
  return input.supportFaceIds.map((faceId) => ({ faceId, fixedTranslationAxes: [1, 2, 3] }));
}

function femSupportFaceIds(input: FemSupportInput): string[] {
  return input.supportConditions?.map((condition) => condition.faceId) ?? input.supportFaceIds;
}
export type StoredFemReport = z.infer<typeof femReportSchema>;
export type FemReportContent = Omit<StoredFemReport, "id" | "createdAt">;

export class FemReportStore {
  private readonly root: string;

  constructor(root = join(process.cwd(), ".plasticity-mcp", "strength")) {
    this.root = join(root, "fem-reports");
  }

  async createWorkspace(): Promise<string> {
    const jobsRoot = join(this.root, "jobs");
    await mkdir(jobsRoot, { recursive: true, mode: 0o700 });
    const workspace = join(jobsRoot, randomUUID());
    await mkdir(workspace, { mode: 0o700 });
    return workspace;
  }

  async save(content: FemReportContent): Promise<StoredFemReport> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const report = femReportSchema.parse({ ...content, id: randomUUID(), createdAt: new Date().toISOString() });
    const handle = await open(this.path(report.id), "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return structuredClone(report);
  }

  async read(reportId: string): Promise<StoredFemReport> {
    if (!/^[A-Za-z0-9-]{36}$/.test(reportId)) throw new Error("Invalid FEA report ID");
    const path = this.path(reportId);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let value: unknown;
    try {
      if ((await handle.stat()).size > 1024 * 1024) throw new Error("Stored FEA report exceeds 1 MiB");
      value = JSON.parse(await handle.readFile("utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`Invalid stored FEA report: ${reportId}`);
      throw error;
    } finally {
      await handle.close();
    }
    return structuredClone(femReportSchema.parse(value));
  }

  private path(reportId: string): string {
    return join(this.root, `${reportId}.json`);
  }
}
