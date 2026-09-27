import { z } from "zod";

import type { TongueRootInput } from "./tongue-root-contracts.ts";
import { validateTongueRootEvidence } from "./tongue-root-provenance.ts";
import { evidenceSchema, materialSchema } from "./schemas.ts";

const finite = z.number().finite();
const positive = finite.positive();
const nonempty = z.string().min(1);
const vector3 = z.tuple([finite, finite, finite]);

export const tongueRootBindingSchema = z.object({
  sessionId: nonempty,
  documentToken: nonempty,
  revision: nonempty,
  bodyId: z.number().int().positive(),
  plane: z.object({ originMm: vector3, normal: vector3, xDirection: vector3 }).strict(),
  topologySignature: nonempty,
}).strict();

export const tongueRootInputSchema = z.object({
  kind: z.literal("tongue-root"),
  goal: nonempty,
  method: z.literal("tongue-root-transverse-v1"),
  geometry: z.object({ rootWidthMm: positive, rootThicknessMm: positive, leverArmMm: positive }).strict(),
  loads: z.object({ transverseForceN: positive }).strict(),
  material: z.object({
    id: nonempty,
    name: nonempty,
    youngModulusMPa: positive,
    shearModulusMPa: positive,
    tensileAllowableMPa: positive,
    shearAllowableMPa: positive,
    suitability: z.enum(["matched", "unconfirmed", "mismatch"]),
    evidenceIds: z.array(nonempty),
    couponRecordId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    allowablesBasis: nonempty.max(1000).optional(),
    manufacturing: materialSchema.shape.manufacturing.extend({
      profileHash: z.string().regex(/^[a-f0-9]{64}$/, "profileHash must be the SHA-256 hash of a registered Workbench profile"),
    }),
  }).strict(),
  shearCorrectionFactor: finite.gt(0).max(1),
  safetyFactor: positive,
  maxDeflectionMm: positive,
  evidence: z.array(evidenceSchema),
  assignments: z.record(z.string(), nonempty),
  binding: tongueRootBindingSchema.optional(),
  assumptions: z.array(z.object({ code: nonempty, confirmed: z.boolean(), evidenceIds: z.array(nonempty) }).strict()),
}).strict().superRefine((input, context) => {
  for (const issue of validateTongueRootEvidence(input as TongueRootInput)) context.addIssue({ code: "custom", message: issue });
});
