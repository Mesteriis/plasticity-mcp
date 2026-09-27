import { z } from "zod";

import type { FastenerScenarioInput } from "./fastener-contracts.ts";
import { validateFastenerEvidence } from "./fastener-provenance.ts";
import { evidenceSchema, materialSchema } from "./schemas.ts";

const finite = z.number().finite();
const positive = finite.positive();
const nonempty = z.string().min(1);

export const fastenerBindingSchema = z.object({
  sessionId: nonempty,
  documentToken: nonempty,
  revision: nonempty,
  bodyId: z.number().int().nonnegative(),
  frontFaceId: nonempty,
  backFaceId: nonempty,
  loadDirection: z.tuple([finite, finite, finite]).refine((value) => value.some((component) => component !== 0), "loadDirection must be nonzero"),
  topologySignature: nonempty,
}).strict();

export const fastenerScenarioInputSchema = z.object({
  kind: z.literal("single-fastener-plate"),
  goal: nonempty,
  method: z.literal("single-fastener-plate-v1"),
  geometry: z.object({
    thicknessMm: positive,
    holeDiameterMm: positive,
    loadedEdgeDistanceMm: positive,
    oppositeEdgeDistanceMm: positive,
    grossWidthMm: positive,
    sideClearancesMm: z.tuple([finite.nonnegative(), finite.nonnegative()]),
  }).strict(),
  loadN: finite.nonnegative(),
  material: materialSchema,
  safetyFactor: positive,
  evidence: z.array(evidenceSchema),
  assignments: z.record(z.string(), nonempty),
  assumptions: z.array(z.object({
    code: nonempty,
    confirmed: z.boolean(),
    evidenceIds: z.array(nonempty),
  }).strict()),
  binding: fastenerBindingSchema.optional(),
}).strict().superRefine((input, context) => {
  for (const issue of validateFastenerEvidence(input as FastenerScenarioInput)) {
    context.addIssue({ code: "custom", message: issue });
  }
});
