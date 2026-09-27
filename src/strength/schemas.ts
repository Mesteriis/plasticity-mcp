import { z } from "zod";

import { MAX_ANALYSIS_IMAGES, type StrengthInput } from "./contracts.ts";
import { validateEvidence } from "./provenance.ts";

const finite = z.number().finite();
const positive = finite.positive();
const nonnegative = finite.nonnegative();
const nonempty = z.string().min(1);

export const evidenceSchema = z.object({
  id: nonempty,
  label: nonempty,
  status: z.enum(["measured", "sourced", "derived", "assumed", "unknown"]),
  /** Physical coupon axes are expressed in the confirmed orthotropic material frame. */
  testAxis: z.enum(["material-1", "material-2", "material-3", "material-1-2", "material-1-3", "material-2-3"]).optional(),
  testMode: z.enum(["tension", "compression", "shear", "biaxial"]).optional(),
  sourceImageIndices: z.array(z.number().int().min(1).max(MAX_ANALYSIS_IMAGES)).max(MAX_ANALYSIS_IMAGES)
    .refine((indices) => new Set(indices).size === indices.length, "sourceImageIndices must be unique").optional(),
  unit: z.enum(["mm", "mm2", "mm4", "N", "Nmm", "kg", "MPa", "MPa/mm", "deg", "C", "ratio", "m/s2"]).optional(),
  value: finite.optional(),
  range: z.tuple([finite, finite]).refine(([low, high]) => low <= high, "range must be ordered").optional(),
  sourceUrl: z.url().refine((url) => url.startsWith("https://") || url.startsWith("http://"), "source URL must use http or https").optional(),
  sourceHash: nonempty.optional(),
  sourceLocator: nonempty.optional(),
  dependsOn: z.array(nonempty),
  derivation: nonempty.optional(),
}).strict();

export const materialSchema = z.object({
  id: nonempty,
  name: nonempty,
  evidenceIds: z.array(nonempty),
  youngMPa: positive.optional(),
  tensileLimitMPa: positive.optional(),
  compressiveLimitMPa: positive.optional(),
  elasticLimitMPa: positive.optional(),
  shearLimitMPa: positive.optional(),
  bearingLimitMPa: positive.optional(),
  couponRecordId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  allowablesBasis: z.string().trim().min(1).max(1000).optional(),
  suitability: z.enum(["matched", "unconfirmed", "mismatch"]),
  manufacturing: z.object({
    printerId: nonempty,
    profileHash: nonempty,
    orientationDeg: z.tuple([finite, finite, finite]),
    infillPercent: finite.min(0).max(100),
    temperatureC: finite,
    effectiveSection: z.enum(["solid", "validated-effective", "unknown"]),
  }).strict(),
}).strict();

export const cadBindingSchema = z.object({
  sessionId: nonempty,
  documentToken: nonempty,
  revision: nonempty,
  bodyId: z.number().int().nonnegative(),
}).strict();

export const strengthInputSchema = z.object({
  goal: nonempty,
  method: z.enum(["axial-rectangle-v1", "cantilever-tip-rectangle-v1", "simply-supported-plate-uniform-pressure-v1", "euler-column-buckling-v1"]),
  lengthMm: positive.optional(),
  widthMm: positive.optional(),
  heightMm: positive.optional(),
  forceN: finite.optional(),
  effectiveLengthFactor: positive.optional(),
  pressureMPa: nonnegative.optional(),
  poissonRatio: finite.gt(-1).lt(0.5).optional(),
  material: materialSchema,
  safetyFactor: positive.optional(),
  maxDisplacementMm: nonnegative.optional(),
  evidence: z.array(evidenceSchema),
  assignments: z.record(z.string(), nonempty),
  assumptions: z.array(z.object({
    code: nonempty,
    confirmed: z.boolean(),
    evidenceIds: z.array(nonempty),
  }).strict()),
  binding: cadBindingSchema.optional(),
}).strict().superRefine((input, context) => {
  for (const issue of validateEvidence(input as StrengthInput)) {
    context.addIssue({ code: "custom", message: issue });
  }
  const plate = input.method === "simply-supported-plate-uniform-pressure-v1";
  if (plate && input.forceN !== undefined) {
    context.addIssue({ code: "custom", path: ["forceN"], message: "forceN is not used by the uniform-pressure plate method" });
  }
  if (!plate && input.pressureMPa !== undefined) {
    context.addIssue({ code: "custom", path: ["pressureMPa"], message: "pressureMPa is only valid for the uniform-pressure plate method" });
  }
  if (!plate && input.poissonRatio !== undefined) {
    context.addIssue({ code: "custom", path: ["poissonRatio"], message: "poissonRatio is only valid for the uniform-pressure plate method" });
  }
  if (input.method === "euler-column-buckling-v1") {
    if (input.forceN !== undefined && input.forceN >= 0) {
      context.addIssue({ code: "custom", path: ["forceN"], message: "Euler column buckling requires forceN to be negative to denote compression" });
    }
    if (input.effectiveLengthFactor === undefined) {
      context.addIssue({ code: "custom", path: ["effectiveLengthFactor"], message: "effectiveLengthFactor is required for the Euler column method" });
    }
  } else if (input.effectiveLengthFactor !== undefined) {
    context.addIssue({ code: "custom", path: ["effectiveLengthFactor"], message: "effectiveLengthFactor is only valid for the Euler column method" });
  }
});

export const analysisRequestSchema = z.object({
  requestId: nonempty,
  prompt: nonempty,
  imagePaths: z.array(nonempty).max(MAX_ANALYSIS_IMAGES, `At most ${MAX_ANALYSIS_IMAGES} images are allowed`),
  evidence: z.array(evidenceSchema),
  answers: z.array(z.object({ questionId: nonempty, question: nonempty.max(2_000), answer: nonempty }).strict()),
  context: strengthInputSchema.optional(),
}).strict();

export const designInterpretationSchema = z.object({
  articleType: nonempty.max(120),
  functionalIntent: nonempty.max(2_000),
  scaleStatus: z.enum(["dimensioned", "calibrated", "unscaled", "unknown"]),
  interfaces: z.array(z.object({
    id: nonempty.max(80),
    kind: z.enum(["mounting", "contact", "support", "connector-access", "moving-envelope", "fastener", "other", "unknown"]),
    description: nonempty.max(1_000),
    confidence: z.enum(["clear", "probable", "ambiguous"]),
    evidenceIds: z.array(nonempty.max(80)).max(32),
  }).strict()).max(64),
  featureCandidates: z.array(z.object({
    id: nonempty.max(80),
    type: z.enum(["solid", "sheet", "hole", "slot", "rib", "boss", "fillet", "chamfer", "connector-opening", "keepout", "other", "unknown"]),
    description: nonempty.max(1_000),
    confidence: z.enum(["clear", "probable", "ambiguous"]),
    evidenceIds: z.array(nonempty.max(80)).max(32),
  }).strict()).max(128),
}).strict();

export const analysisResultSchema = z.object({
  observations: z.array(evidenceSchema),
  proposedMethod: z.enum(["axial-rectangle-v1", "cantilever-tip-rectangle-v1", "simply-supported-plate-uniform-pressure-v1", "euler-column-buckling-v1", "planar-section-resultants-v1", "single-fastener-plate-v1", "fastener-member-v1", "tongue-root-transverse-v1", "threaded-receiver-axial-v1", "heat-set-insert-retention-v1", "fastener-group-elastic-in-plane-v1"]).nullable(),
  questions: z.array(z.object({
    id: nonempty,
    question: nonempty,
    resolves: z.array(nonempty),
    reason: nonempty,
  }).strict()).max(1),
  unsupportedConditions: z.array(nonempty),
  designInterpretation: designInterpretationSchema.nullable().default(null),
}).strict();
