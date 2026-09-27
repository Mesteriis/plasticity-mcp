import { z } from "zod";

import { evidenceSchema } from "./schemas.ts";
import { fastenerGroupInputSchema } from "./fastener-group-schemas.ts";
import { exactMaterialCouponProcessSchema } from "./material-qualification.ts";

export const fastenerGroupPlateBearingInputSchema = z.object({
  group: fastenerGroupInputSchema,
  plate: z.object({
    boundaryFaceId: z.string().trim().min(1),
    opposedFaceId: z.string().trim().min(1),
    bearingDesignAllowableMPa: z.number().finite().positive(),
    allowableEvidence: evidenceSchema,
    materialConfiguration: z.string().trim().min(1).max(500),
    materialSuitability: z.enum(["matched", "unconfirmed", "mismatch"]),
    assumptions: z.object({
      homogeneousEquivalentPlate: z.boolean(),
      nominalBearingContact: z.boolean(),
      loadCenteredThroughThickness: z.boolean(),
    }).strict(),
  }).strict().refine((plate) => plate.boundaryFaceId !== plate.opposedFaceId, {
    path: ["opposedFaceId"],
    message: "Opposed plate faces must be distinct",
  }),
  netTension: z.object({
    axis: z.enum(["x", "y"]),
    demandN: z.number().finite().positive(),
    tensileDesignAllowableMPa: z.number().finite().positive(),
    allowableEvidence: evidenceSchema,
    assumptions: z.object({
      uniformMembraneTension: z.boolean(),
      loadCenteredThroughThickness: z.boolean(),
      straightCutFailurePath: z.boolean(),
    }).strict(),
  }).strict().optional(),
  edgeShearOut: z.object({
    shearDesignAllowableMPa: z.number().finite().positive(),
    allowableEvidence: evidenceSchema,
    assumptions: z.object({
      homogeneousEquivalentPlate: z.boolean(),
      loadCenteredThroughThickness: z.boolean(),
      twoPlaneShearOut: z.boolean(),
    }).strict(),
  }).strict().optional(),
  physicalTest: z.object({
    recordId: z.string().regex(/^[a-f0-9]{64}$/),
    process: exactMaterialCouponProcessSchema,
    safetyFactor: z.number().finite().positive(),
    geometryToleranceMm: z.number().finite().positive(),
    geometryToleranceEvidence: evidenceSchema,
    processMatchesPartConfirmed: z.literal(true),
    fixtureAndLoadPathMatchConfirmed: z.literal(true),
  }).strict().optional(),
}).strict().superRefine(({ group, plate, netTension, edgeShearOut, physicalTest }, context) => {
  if (!group.binding) context.addIssue({ code: "custom", path: ["group", "binding"], message: "A revision-bound native fastener group is required" });
  if (plate.allowableEvidence.unit !== "MPa" || plate.allowableEvidence.value !== plate.bearingDesignAllowableMPa) {
    context.addIssue({ code: "custom", path: ["plate", "allowableEvidence"], message: "The evidence must equal the bearing design allowable in MPa" });
  }
  const evidence = plate.allowableEvidence;
  if (evidence.status === "measured" ? evidence.sourceLocator === undefined
      : evidence.status === "sourced" ? evidence.sourceUrl === undefined || evidence.sourceHash === undefined
        : true) {
    context.addIssue({ code: "custom", path: ["plate", "allowableEvidence"], message: "The allowable needs directly traceable measured or sourced evidence" });
  }
  if (netTension) {
    const tensileEvidence = netTension.allowableEvidence;
    if (tensileEvidence.unit !== "MPa" || tensileEvidence.value !== netTension.tensileDesignAllowableMPa) {
      context.addIssue({ code: "custom", path: ["netTension", "allowableEvidence"], message: "Evidence must exactly match the tensile design allowable in MPa" });
    }
    if (tensileEvidence.status === "measured" ? tensileEvidence.sourceLocator === undefined
        : tensileEvidence.status === "sourced" ? tensileEvidence.sourceUrl === undefined || tensileEvidence.sourceHash === undefined
          : true) {
      context.addIssue({ code: "custom", path: ["netTension", "allowableEvidence"], message: "The tensile allowable needs directly traceable measured or sourced evidence" });
    }
  }
  if (edgeShearOut) {
    const shearEvidence = edgeShearOut.allowableEvidence;
    if (shearEvidence.unit !== "MPa" || shearEvidence.value !== edgeShearOut.shearDesignAllowableMPa) {
      context.addIssue({ code: "custom", path: ["edgeShearOut", "allowableEvidence"], message: "Evidence must exactly match the shear-out design allowable in MPa" });
    }
    if (shearEvidence.status === "measured" ? shearEvidence.sourceLocator === undefined
        : shearEvidence.status === "sourced" ? shearEvidence.sourceUrl === undefined || shearEvidence.sourceHash === undefined
          : true) {
      context.addIssue({ code: "custom", path: ["edgeShearOut", "allowableEvidence"], message: "The shear-out allowable needs directly traceable measured or sourced evidence" });
    }
  }
  if (physicalTest && !netTension) {
    context.addIssue({ code: "custom", path: ["physicalTest"], message: "A physical group-test comparison requires an explicit external netTension resultant" });
  }
  if (physicalTest && (physicalTest.geometryToleranceEvidence.unit !== "mm"
      || physicalTest.geometryToleranceEvidence.value !== physicalTest.geometryToleranceMm
      || physicalTest.geometryToleranceEvidence.status === "assumed"
      || physicalTest.geometryToleranceEvidence.status === "unknown"
      || physicalTest.geometryToleranceEvidence.status === "measured" && (!physicalTest.geometryToleranceEvidence.sourceLocator || !/^[a-f0-9]{64}$/.test(physicalTest.geometryToleranceEvidence.sourceHash ?? ""))
      || physicalTest.geometryToleranceEvidence.status === "sourced" && (!physicalTest.geometryToleranceEvidence.sourceUrl || !/^[a-f0-9]{64}$/.test(physicalTest.geometryToleranceEvidence.sourceHash ?? "")))) {
    context.addIssue({ code: "custom", path: ["physicalTest", "geometryToleranceEvidence"], message: "Geometry equivalence tolerance must match traceable measured or sourced mm evidence" });
  }
});
