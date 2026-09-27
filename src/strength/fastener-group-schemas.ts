import { z } from "zod";

import type { FastenerGroupInput } from "./fastener-group-contracts.ts";
import { validateFastenerGroupEvidence } from "./fastener-group-provenance.ts";
import { evidenceSchema } from "./schemas.ts";

const finite = z.number().finite();
const nonempty = z.string().min(1);
const vector3 = z.tuple([finite, finite, finite]);

export const fastenerGroupBindingSchema = z.object({
  sessionId: nonempty,
  documentToken: nonempty,
  revision: nonempty,
  bodyId: z.number().int().positive(),
  cylindricalFaceIds: z.array(nonempty).min(2).max(256).refine(
    (values) => new Set(values).size === values.length,
    "cylindrical face IDs must be unique",
  ),
  frame: z.object({
    originMm: vector3,
    normal: vector3,
    xDirection: vector3,
    yDirection: vector3,
  }).strict(),
  topologySignature: nonempty,
}).strict();

export const fastenerGroupInputSchema = z.object({
  kind: z.literal("fastener-group-load"),
  goal: nonempty,
  method: z.literal("fastener-group-elastic-in-plane-v1"),
  fasteners: z.array(z.object({ id: nonempty, xMm: finite, yMm: finite }).strict()).min(2).max(256),
  shearCapacities: z.array(z.object({ fastenerId: nonempty, configuration: nonempty.max(240), allowableShearN: finite.positive() }).strict()).min(2).max(256).optional(),
  load: z.object({
    forceXN: finite,
    forceYN: finite,
    applicationPointXmm: finite,
    applicationPointYmm: finite,
    freeMomentNmm: finite,
  }).strict().refine((load) => load.forceXN !== 0 || load.forceYN !== 0 || load.freeMomentNmm !== 0, "force or free moment must be nonzero"),
  evidence: z.array(evidenceSchema),
  assignments: z.record(z.string(), nonempty),
  assumptions: z.array(z.object({
    code: nonempty,
    confirmed: z.boolean(),
    evidenceIds: z.array(nonempty),
  }).strict()),
  binding: fastenerGroupBindingSchema.optional(),
}).strict().superRefine((input, context) => {
  const ids = new Set<string>();
  const positions = new Set<string>();
  for (const [index, fastener] of input.fasteners.entries()) {
    if (ids.has(fastener.id)) context.addIssue({ code: "custom", path: ["fasteners", index, "id"], message: `duplicate fastener ID: ${fastener.id}` });
    ids.add(fastener.id);
    const position = `${normalizeZero(fastener.xMm)},${normalizeZero(fastener.yMm)}`;
    if (positions.has(position)) context.addIssue({ code: "custom", path: ["fasteners", index], message: "fastener transfer points must be distinct" });
    positions.add(position);
  }
  if (input.shearCapacities) {
    const capacityIds = new Set<string>();
    for (const [index, capacity] of input.shearCapacities.entries()) {
      if (capacityIds.has(capacity.fastenerId)) context.addIssue({ code: "custom", path: ["shearCapacities", index, "fastenerId"], message: `duplicate shear capacity for fastener: ${capacity.fastenerId}` });
      capacityIds.add(capacity.fastenerId);
      if (!ids.has(capacity.fastenerId)) context.addIssue({ code: "custom", path: ["shearCapacities", index, "fastenerId"], message: `shear capacity references unknown fastener: ${capacity.fastenerId}` });
    }
    for (const fastener of input.fasteners) if (!capacityIds.has(fastener.id)) {
      context.addIssue({ code: "custom", path: ["shearCapacities"], message: `missing traceable shear allowable for fastener: ${fastener.id}` });
    }
  }
  for (const issue of validateFastenerGroupEvidence(input as FastenerGroupInput)) {
    context.addIssue({ code: "custom", message: issue });
  }
});

function normalizeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}
