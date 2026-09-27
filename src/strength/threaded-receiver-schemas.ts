import { z } from "zod";

import type { ThreadedReceiverInput } from "./threaded-receiver-contracts.ts";
import { validateThreadedReceiverEvidence } from "./threaded-receiver-provenance.ts";
import { evidenceSchema } from "./schemas.ts";

const positive = z.number().finite().positive();
const nonempty = z.string().min(1);

export const threadedReceiverInputSchema = z.object({
  kind: z.literal("threaded-receiver"),
  goal: nonempty,
  method: z.literal("threaded-receiver-axial-v1"),
  configuration: z.object({
    threadDesignation: nonempty,
    nominalDiameterMm: positive,
    pitchMm: positive,
    engagementMm: positive,
    completeThreadCount: z.number().int().positive(),
    receiverType: z.enum(["tapped-hole", "nut", "threaded-insert"]),
    capacityBasis: z.enum(["specified-assembly-load", "dedicated-test", "qualified-shear-area-calculation"]),
  }).strict(),
  loads: z.object({ axialTensionN: positive }).strict(),
  capacity: z.object({
    internalThreadStripAllowableN: positive,
    externalThreadStripAllowableN: positive,
    fastenerTensileAllowableN: positive,
    evidenceIds: z.array(nonempty),
    suitability: z.enum(["matched", "unconfirmed", "mismatch"]),
  }).strict(),
  criteria: z.object({ requireFastenerTensionBeforeThreadStripping: z.boolean() }).strict(),
  safetyFactor: positive,
  evidence: z.array(evidenceSchema),
  assignments: z.record(z.string(), nonempty),
  assumptions: z.array(z.object({
    code: nonempty,
    confirmed: z.boolean(),
    evidenceIds: z.array(nonempty),
  }).strict()),
}).strict().superRefine((input, context) => {
  if (input.configuration.completeThreadCount * input.configuration.pitchMm > input.configuration.engagementMm + 1e-9) {
    context.addIssue({ code: "custom", path: ["configuration", "completeThreadCount"], message: "Complete engaged threads cannot occupy more than the stated engagement length" });
  }
  for (const issue of validateThreadedReceiverEvidence(input as ThreadedReceiverInput)) {
    context.addIssue({ code: "custom", message: issue });
  }
});
