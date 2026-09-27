import { z } from "zod";

import type { FastenerMemberInput } from "./fastener-member-contracts.ts";
import { validateFastenerMemberEvidence } from "./fastener-member-provenance.ts";
import { evidenceSchema } from "./schemas.ts";

const finite = z.number().finite();
const positive = finite.positive();
const nonempty = z.string().min(1);

export const fastenerMemberInputSchema = z.object({
  kind: z.literal("fastener-member"),
  goal: nonempty,
  method: z.literal("fastener-member-v1"),
  geometry: z.object({
    nominalDiameterMm: positive,
    tensileStressAreaMm2: positive,
    shearAreaPerPlaneMm2: positive,
    shearPlaneCount: z.union([z.literal(1), z.literal(2)]),
    shearPlaneLocation: z.enum(["unthreaded-shank", "threads"]),
  }).strict(),
  loads: z.object({
    axialTensionN: finite.nonnegative(),
    transverseShearN: finite.nonnegative(),
  }).strict().refine((loads) => loads.axialTensionN > 0 || loads.transverseShearN > 0, "at least one fastener load must be positive"),
  material: z.object({
    id: nonempty,
    name: nonempty,
    tensileLimitMPa: positive.optional(),
    shearLimitMPa: positive.optional(),
    evidenceIds: z.array(nonempty),
    suitability: z.enum(["matched", "unconfirmed", "mismatch"]),
  }).strict(),
  safetyFactor: positive,
  evidence: z.array(evidenceSchema),
  assignments: z.record(z.string(), nonempty),
  assumptions: z.array(z.object({
    code: nonempty,
    confirmed: z.boolean(),
    evidenceIds: z.array(nonempty),
  }).strict()),
}).strict().superRefine((input, context) => {
  for (const issue of validateFastenerMemberEvidence(input as FastenerMemberInput)) {
    context.addIssue({ code: "custom", message: issue });
  }
});
