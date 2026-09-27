import { z } from "zod";

import { strengthInputSchema } from "./schemas.ts";
import type { StrengthInput } from "./contracts.ts";
import { evidenceSchema } from "./schemas.ts";
import { exactMaterialCouponProcessSchema } from "./material-qualification.ts";
import type { MaterialCouponQualificationMatch, MaterialCouponQualificationRecord } from "./material-qualification.ts";
import type { StrengthStore } from "./store.ts";

const scenarioSchema = z.object({
  goal: z.string().min(1),
  method: z.enum(["axial-rectangle-v1", "cantilever-tip-rectangle-v1"]),
  lengthMm: z.number().finite().positive(),
  widthMm: z.number().finite().positive(),
  heightMm: z.number().finite().positive(),
  forceN: z.number().finite(),
  safetyFactor: z.number().finite().positive(),
  maxDisplacementMm: z.number().finite().nonnegative().optional(),
  evidence: z.array(evidenceSchema),
  assignments: z.record(z.string(), z.string().min(1)),
  assumptions: z.array(z.object({ code: z.string().min(1), confirmed: z.boolean(), evidenceIds: z.array(z.string().min(1)) }).strict()),
  binding: strengthInputSchema.shape.binding,
}).strict();

export const rectangularCouponInputSchema = z.object({
  process: exactMaterialCouponProcessSchema,
  scenario: scenarioSchema,
  allowables: z.object({ tensileMPa: z.number().finite().positive(), compressiveMPa: z.number().finite().positive().optional() }).strict(),
  allowablesBasis: z.string().trim().min(1).max(1000),
  effectiveSection: z.enum(["solid", "validated-effective", "unknown"]),
}).strict().superRefine(({ scenario, allowables }, context) => {
  if ("material.youngMPa" in scenario.assignments) {
    context.addIssue({ code: "custom", path: ["scenario", "assignments", "material.youngMPa"], message: "Coupon-backed modulus assignment is generated from the selected record" });
  }
  for (const path of ["material.tensileLimitMPa", ...(scenario.method === "cantilever-tip-rectangle-v1" ? ["material.compressiveLimitMPa"] : [])]) {
    if (!scenario.assignments[path]) context.addIssue({ code: "custom", path: ["scenario", "assignments", path], message: `${path} needs independent traceable design-allowable evidence` });
  }
  if (scenario.method === "cantilever-tip-rectangle-v1" && allowables.compressiveMPa === undefined) {
    context.addIssue({ code: "custom", path: ["allowables", "compressiveMPa"], message: "Cantilever analysis needs a separately sourced compressive allowable" });
  }
});
type RectangularCouponInput = z.infer<typeof rectangularCouponInputSchema>;

export async function materializeRectangularCouponInput(
  store: StrengthStore,
  raw: RectangularCouponInput,
): Promise<
  | { match: MaterialCouponQualificationMatch; record: null; input: null }
  | { match: MaterialCouponQualificationMatch; record: MaterialCouponQualificationRecord; input: StrengthInput }
> {
  const match = await store.materialQualifications.match({ process: raw.process });
  if (match.status !== "matched" || !match.selected) return { match, record: null, input: null };
  const record = match.selected;
  const scenarioEvidenceIds = new Set(raw.scenario.evidence.map((item) => item.id));
  const duplicateIds = record.evidence.filter((item) => scenarioEvidenceIds.has(item.id)).map((item) => item.id);
  if (duplicateIds.length > 0) throw new Error(`Coupon and scenario evidence IDs overlap: ${duplicateIds.join(", ")}`);
  const youngEvidenceId = record.propertyEvidence.youngModulusMPa[0]!;
  const allowanceEvidenceIds = [
    raw.scenario.assignments["material.tensileLimitMPa"],
    raw.scenario.assignments["material.compressiveLimitMPa"],
  ].filter((id): id is string => id !== undefined);
  const couponEvidenceIds = Object.values(record.propertyEvidence).flatMap((ids) => ids ?? []);
  const input = strengthInputSchema.parse({
    ...raw.scenario,
    material: {
      id: raw.process.materialId,
      name: raw.process.materialId,
      evidenceIds: [...new Set([...couponEvidenceIds, ...allowanceEvidenceIds])],
      youngMPa: record.properties.youngModulusMPa,
      tensileLimitMPa: raw.allowables.tensileMPa,
      ...(raw.allowables.compressiveMPa === undefined ? {} : { compressiveLimitMPa: raw.allowables.compressiveMPa }),
      suitability: "unconfirmed",
      couponRecordId: record.id,
      allowablesBasis: raw.allowablesBasis,
      manufacturing: {
        printerId: raw.process.printerId,
        profileHash: raw.process.profileHash,
        orientationDeg: raw.process.orientationDeg,
        infillPercent: raw.process.infillPercent,
        temperatureC: raw.process.nozzleTemperatureC,
        effectiveSection: raw.effectiveSection,
      },
    },
    evidence: [...raw.scenario.evidence, ...record.evidence],
    assignments: { ...raw.scenario.assignments, "material.youngMPa": youngEvidenceId },
  }) as StrengthInput;
  return { match, record, input };
}
