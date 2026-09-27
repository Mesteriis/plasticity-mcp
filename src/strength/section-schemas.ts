import { z } from "zod";

import type { SectionScenarioInput } from "./section-contracts.ts";
import { evidenceSchema, materialSchema } from "./schemas.ts";
import { validateSectionEvidence } from "./provenance.ts";

const finite = z.number().finite();
const positive = finite.positive();
const nonempty = z.string().min(1);
const vector2 = z.tuple([finite, finite]);
const vector3 = z.tuple([finite, finite, finite]);

const lineSchema = z.object({
  kind: z.literal("line"),
  start: vector2,
  end: vector2,
}).strict();

const arcSchema = z.object({
  kind: z.literal("arc"),
  center: vector2,
  radius: positive,
  startRadians: finite,
  sweepRadians: finite,
}).strict();

export const sectionLoopSchema = z.object({
  segments: z.array(z.discriminatedUnion("kind", [lineSchema, arcSchema])).min(1),
}).strict();

export const localSectionPropertiesSchema = z.object({
  areaMm2: positive,
  centroidLocalMm: vector2,
  ixxMm4: positive,
  iyyMm4: positive,
  ixyMm4: finite,
  principal: z.object({
    majorMm4: positive,
    minorMm4: positive,
    angleDegrees: finite,
  }).strict(),
  innerLoopCount: z.number().int().nonnegative(),
  boundaryKinds: z.array(z.enum(["line", "circle"])),
  rectangular: z.boolean(),
  topologySignature: nonempty,
}).strict();

const pointForceSchema = z.object({
  id: nonempty,
  forceN: vector3,
  pointMm: vector3,
  evidenceIds: z.array(nonempty),
}).strict();

const freeMomentSchema = z.object({
  id: nonempty,
  momentNmm: vector3,
  evidenceIds: z.array(nonempty),
}).strict();

export const sectionBindingSchema = z.object({
  sessionId: nonempty,
  documentToken: nonempty,
  revision: nonempty,
  bodyId: z.number().int().nonnegative(),
  faceId: nonempty.optional(),
  plane: z.object({ originMm: vector3, normal: vector3, xDirection: vector3 }).strict().optional(),
  topologySignature: nonempty,
}).strict().refine((binding) => (binding.faceId !== undefined) !== (binding.plane !== undefined), {
  message: "Section binding must identify exactly one planar face or arbitrary plane",
});

export const sectionScenarioInputSchema = z.object({
  kind: z.literal("planar-section"),
  goal: nonempty,
  method: z.literal("planar-section-resultants-v1"),
  frame: z.object({ originMm: vector3, normal: vector3, xDirection: vector3 }).strict(),
  loops: z.array(sectionLoopSchema).min(1),
  properties: localSectionPropertiesSchema,
  pointForces: z.array(pointForceSchema).min(1),
  freeMoments: z.array(freeMomentSchema),
  material: materialSchema,
  safetyFactor: positive.optional(),
  evidence: z.array(evidenceSchema),
  assignments: z.record(z.string(), nonempty),
  assumptions: z.array(z.object({
    code: nonempty,
    confirmed: z.boolean(),
    evidenceIds: z.array(nonempty),
  }).strict()),
  binding: sectionBindingSchema.optional(),
}).strict().superRefine((input, context) => {
  for (const issue of validateSectionEvidence(input as SectionScenarioInput)) {
    context.addIssue({ code: "custom", message: issue });
  }
});
