import { z } from "zod";

import type { InsertRetentionInput } from "./insert-retention-contracts.ts";
import { validateInsertRetentionEvidence } from "./insert-retention-provenance.ts";
import { evidenceSchema } from "./schemas.ts";

const finite = z.number().finite();
const positive = finite.positive();
const nonempty = z.string().min(1);

export const insertRetentionInputSchema = z.object({
  kind: z.literal("heat-set-insert-retention"),
  goal: nonempty,
  method: z.literal("heat-set-insert-retention-v1"),
  configuration: z.object({
    insertId: nonempty,
    threadDesignation: nonempty,
    insertLengthMm: positive,
    threadPitchMm: positive,
    holeDiameterMm: positive,
    holeDepthMm: positive,
    hostMaterialId: nonempty,
    printerId: nonempty,
    profileHash: nonempty,
    orientationDeg: z.tuple([finite, finite, finite]),
    installationMethod: z.enum(["heat", "ultrasonic"]),
    installationProcessId: nonempty,
  }).strict(),
  demands: z.object({
    axialPulloutPerInsertN: finite.nonnegative(),
    torquePerInsertNmm: finite.nonnegative(),
  }).strict().refine((demand) => demand.axialPulloutPerInsertN > 0 || demand.torquePerInsertNmm > 0, "at least one per-insert demand must be positive"),
  capacity: z.object({
    pulloutN: positive,
    torqueOutNmm: positive,
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
  for (const issue of validateInsertRetentionEvidence(input as InsertRetentionInput)) {
    context.addIssue({ code: "custom", message: issue });
  }
});
