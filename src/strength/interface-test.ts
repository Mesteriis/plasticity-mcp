import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";

import { exactMaterialCouponProcessSchema, materialCouponProcessSchema } from "./material-qualification.ts";
import { evidenceSchema } from "./schemas.ts";

const id = z.string().trim().min(1).max(240);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().finite().positive();
const direction = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]).refine((value) => {
  const magnitude = Math.hypot(...value);
  return Math.abs(magnitude - 1) <= 1e-6;
}, "Interface normal must be a unit vector in the global build frame");

const evidenceItemSchema = evidenceSchema.extend({ unit: z.literal("MPa") }).superRefine((item, context) => {
  if (item.status !== "measured" || item.value === undefined || !item.sourceHash || !/^[a-f0-9]{64}$/.test(item.sourceHash) || !item.sourceLocator) {
    context.addIssue({ code: "custom", message: "Interface strength evidence must be measured and include MPa value, SHA-256 and source locator" });
  }
});

const tractionSeparationCurveSchema = z.object({
  sourceHash: sha256,
  sourceLocator: id.max(2000),
  points: z.array(z.object({
    separationMm: z.number().finite().nonnegative(),
    tractionMPa: z.number().finite().nonnegative(),
  }).strict()).min(3).max(10_000),
}).strict();

const mixedModeTractionSeparationCurveSchema = z.object({
  sourceHash: sha256,
  sourceLocator: id.max(2000),
  points: z.array(z.object({
    normalSeparationMm: z.number().finite().nonnegative(),
    tangentialSeparationMm: z.number().finite().nonnegative(),
    normalTractionMPa: z.number().finite().nonnegative(),
    tangentialTractionMPa: z.number().finite().nonnegative(),
  }).strict()).min(3).max(10_000),
}).strict();

const interfaceFailureLocationSchema = z.enum(["interface", "material-a", "material-b", "mixed", "fixture", "unknown"]);
const interfaceFractureMethodSchema = z.enum(["dcb-mode-i", "enf-mode-ii", "mmb-mixed-mode"]);
const interfaceSpecimenCalculationItemSchema = z.object({
  specimenId: id,
  peakForceN: positive,
  netCrossSectionMm2: positive,
  failureLocation: interfaceFailureLocationSchema,
  sourceHash: sha256,
  sourceLocator: id.max(2000),
}).strict();
const interfaceSpecimenCalculationInputSchema = z.object({
  specimens: z.array(interfaceSpecimenCalculationItemSchema).min(1).max(1000),
}).strict().superRefine((input, context) => {
  if (new Set(input.specimens.map((specimen) => specimen.specimenId)).size !== input.specimens.length) {
    context.addIssue({ code: "custom", path: ["specimens"], message: "Interface specimen IDs must be unique" });
  }
});
const interfaceSpecimenResultSchema = interfaceSpecimenCalculationItemSchema.extend({
  nominalPeakStrengthMPa: positive,
}).strict().superRefine((specimen, context) => {
  const calculated = specimen.peakForceN / specimen.netCrossSectionMm2;
  if (!Number.isFinite(calculated) || calculated <= 0
    || Math.abs(calculated - specimen.nominalPeakStrengthMPa) > Math.max(1e-9, calculated * 1e-9)) {
    context.addIssue({ code: "custom", path: ["nominalPeakStrengthMPa"], message: "Nominal peak strength must equal measured peak force divided by the measured net cross-section (N/mm² = MPa)" });
  }
});

const unitVector = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]).refine((value) =>
  Math.abs(Math.hypot(...value) - 1) <= 1e-6, "G-code frame directions must be unit vectors");
const depositionPathEvidenceSchema = z.object({
  jobId: id,
  profileHash: sha256,
  sourceArtifactHash: sha256,
  gcodeArtifactHash: sha256,
  layerCount: z.number().int().positive().max(2_000_000),
  coordinateFrame: z.literal("slicer-build"),
  layers: z.array(z.object({
    layerIndex: z.number().int().positive(),
    depositionLayerZMm: z.number().finite(),
    planarPathLengthMm: z.number().finite().nonnegative(),
    principalDirectionDeg: z.number().finite().min(0).lt(180).nullable(),
    directionalConcentration: z.number().finite().min(0).max(1).nullable(),
    curvedExtrusionMoves: z.number().int().nonnegative(),
    coverage: z.enum(["complete-linear", "complete-planar", "partial-curved", "no-planar-extrusion"]),
  }).strict().superRefine((layer, context) => {
    if (layer.planarPathLengthMm === 0 && (layer.principalDirectionDeg !== null || layer.directionalConcentration !== null)) {
      context.addIssue({ code: "custom", path: ["principalDirectionDeg"], message: "A layer without planar extrusion cannot claim a road direction or concentration" });
    }
    if (layer.planarPathLengthMm > 0 && layer.directionalConcentration === null) {
      context.addIssue({ code: "custom", path: ["directionalConcentration"], message: "Planar extrusion requires measured directional concentration" });
    }
  })).min(1).max(2000),
  slicerXDirectionGlobal: unitVector,
  slicerYDirectionGlobal: unitVector,
  buildDirectionGlobal: unitVector,
  mappingEvidence: z.object({
    status: z.literal("user-confirmed"),
    description: id.max(1000),
  }).strict(),
}).strict();

const rawBaseSchema = z.object({
  interfaceKind: z.enum(["same-material-layer", "dissimilar-material-bond"]),
  materialAProcess: materialCouponProcessSchema,
  materialBProcess: materialCouponProcessSchema,
  testMode: z.enum(["normal-tension", "interface-shear", "mixed-mode"]),
  fractureMethod: interfaceFractureMethodSchema.optional(),
  interfaceNormalGlobal: direction,
  loadDirectionGlobal: direction,
  testMethod: id.max(200),
  testProtocolHash: sha256,
  specimenDescription: z.string().trim().min(12).max(2000),
  fixtureDescription: z.string().trim().min(12).max(2000),
  measuredPeakStrengthMPa: positive,
  specimenResults: z.array(interfaceSpecimenResultSchema).min(1).max(1000).optional(),
  representativeSpecimenId: id.optional(),
  tractionSeparationCurve: tractionSeparationCurveSchema.optional(),
  mixedModeTractionSeparationCurve: mixedModeTractionSeparationCurveSchema.optional(),
  depositionPathEvidence: depositionPathEvidenceSchema.optional(),
  failureLocation: z.enum(["interface", "material-a", "material-b", "mixed", "fixture", "unknown"]),
  evidence: z.array(evidenceItemSchema).min(1).max(16),
  specimenCount: z.number().int().positive().max(1000),
  testedAt: z.iso.datetime(),
  notes: z.string().trim().min(1).max(4000).optional(),
  source: z.literal("physical-material-interface-test"),
  callerConfirmsPhysicalTests: z.literal(true),
}).strict();

const baseSchema = rawBaseSchema.superRefine((input, context) => {
  if (input.interfaceKind === "same-material-layer") {
    if (input.materialAProcess.materialId !== input.materialBProcess.materialId
      || canonicalJson(input.materialAProcess) !== canonicalJson(input.materialBProcess)) {
      context.addIssue({ code: "custom", path: ["materialBProcess"], message: "A same-material layer test requires matching material process records on both sides" });
    }
  } else if (input.materialAProcess.materialId === input.materialBProcess.materialId) {
    context.addIssue({ code: "custom", path: ["materialBProcess", "materialId"], message: "A dissimilar-material bond test requires two distinct materials" });
  }
  const alignment = Math.abs(input.interfaceNormalGlobal.reduce((sum, value, axis) => sum + value * input.loadDirectionGlobal[axis]!, 0));
  const pathEvidence = input.depositionPathEvidence;
  if (pathEvidence) {
    if (pathEvidence.profileHash !== input.materialAProcess.profileHash) {
      context.addIssue({ code: "custom", path: ["depositionPathEvidence", "profileHash"], message: "G-code path evidence profile hash must match the tested material process" });
    }
    if (pathEvidence.layers.some((layer) => layer.layerIndex > pathEvidence.layerCount)
      || new Set(pathEvidence.layers.map((layer) => layer.layerIndex)).size !== pathEvidence.layers.length) {
      context.addIssue({ code: "custom", path: ["depositionPathEvidence", "layers"], message: "G-code layer evidence indices must be unique and within the sliced layer count" });
    }
    for (const [axisName, axis] of [["slicerXDirectionGlobal", pathEvidence.slicerXDirectionGlobal], ["slicerYDirectionGlobal", pathEvidence.slicerYDirectionGlobal]] as const) {
      if (Math.abs(axis.reduce((sum, value, index) => sum + value * pathEvidence.buildDirectionGlobal[index]!, 0)) > 1e-6) {
        context.addIssue({ code: "custom", path: ["depositionPathEvidence", axisName], message: "Slicer XY axes must lie in the confirmed build plane" });
      }
      if (Math.abs(axis.reduce((sum, value, index) => sum + value * input.interfaceNormalGlobal[index]!, 0)) > Math.sin(Math.PI / 180)) {
        context.addIssue({ code: "custom", path: ["depositionPathEvidence", axisName], message: "Slicer XY axes must lie in the tested interface plane within one degree" });
      }
    }
    const xyAlignment = Math.abs(pathEvidence.slicerXDirectionGlobal.reduce((sum, value, index) => sum + value * pathEvidence.slicerYDirectionGlobal[index]!, 0));
    const buildAlignment = Math.abs(pathEvidence.buildDirectionGlobal.reduce((sum, value, index) => sum + value * input.interfaceNormalGlobal[index]!, 0));
    if (xyAlignment > 1e-6) context.addIssue({ code: "custom", path: ["depositionPathEvidence", "slicerYDirectionGlobal"], message: "Confirmed slicer X and Y directions must be orthogonal" });
    if (buildAlignment < Math.cos(Math.PI / 180)) context.addIssue({ code: "custom", path: ["depositionPathEvidence", "buildDirectionGlobal"], message: "Confirmed build direction must align with the tested layer-interface normal within one degree" });
    if (pathEvidence.mappingEvidence.description.trim().length < 12) context.addIssue({ code: "custom", path: ["depositionPathEvidence", "mappingEvidence", "description"], message: "Explain how the slicer-to-global frame was confirmed" });
  }
  if (input.testMode === "normal-tension" && alignment < Math.cos(Math.PI / 180)) {
    context.addIssue({ code: "custom", path: ["loadDirectionGlobal"], message: "Normal-tension test load direction must align with the interface normal within one degree" });
  }
  if (input.testMode === "interface-shear" && alignment > Math.sin(Math.PI / 180)) {
    context.addIssue({ code: "custom", path: ["loadDirectionGlobal"], message: "Interface-shear test load direction must lie in the interface plane within one degree" });
  }
  if (input.testMode === "mixed-mode" && (alignment <= Math.sin(Math.PI / 180) || alignment >= Math.cos(Math.PI / 180))) {
    context.addIssue({ code: "custom", path: ["loadDirectionGlobal"], message: "Mixed-mode test load direction must include normal and tangential loading, each more than one degree from a pure mode" });
  }
  if (input.testMode === "mixed-mode") {
    if (input.tractionSeparationCurve || !input.mixedModeTractionSeparationCurve) {
      context.addIssue({ code: "custom", path: ["mixedModeTractionSeparationCurve"], message: "A mixed-mode test requires only its full vector traction-separation curve; scalar curves can only be attached to their matching test mode" });
    } else {
      try { analyzeMixedModeMaterialInterfaceTestCurve(input); }
      catch (error) { context.addIssue({ code: "custom", path: ["mixedModeTractionSeparationCurve"], message: error instanceof Error ? error.message : String(error) }); }
    }
  } else if (input.mixedModeTractionSeparationCurve) {
    context.addIssue({ code: "custom", path: ["mixedModeTractionSeparationCurve"], message: "Vector traction-separation curves can only be attached to a mixed-mode test" });
  }
  if (input.fractureMethod) {
    const expectedMethod = input.testMode === "normal-tension" ? "dcb-mode-i"
      : input.testMode === "interface-shear" ? "enf-mode-ii" : "mmb-mixed-mode";
    if (input.fractureMethod !== expectedMethod) {
      context.addIssue({ code: "custom", path: ["fractureMethod"], message: `fractureMethod must be ${expectedMethod} for ${input.testMode}` });
    }
    const expectedProtocol = input.fractureMethod.startsWith("dcb-") ? "DCB"
      : input.fractureMethod.startsWith("enf-") ? "ENF" : "MMB";
    if (!new RegExp(`\\b${expectedProtocol}\\b`, "i").test(input.testMethod)) {
      context.addIssue({ code: "custom", path: ["testMethod"], message: `testMethod must explicitly identify the ${expectedProtocol} physical test declared by fractureMethod` });
    }
  }
  if (new Set(input.evidence.map((item) => item.id)).size !== input.evidence.length) {
    context.addIssue({ code: "custom", path: ["evidence"], message: "Interface-test evidence IDs must be unique" });
  }
  if (input.evidence.some((item) => item.value !== input.measuredPeakStrengthMPa)) {
    context.addIssue({ code: "custom", path: ["evidence"], message: "Every interface-test evidence value must exactly match measuredPeakStrengthMPa" });
  }
  if (input.specimenResults) {
    if (input.specimenResults.length !== input.specimenCount) {
      context.addIssue({ code: "custom", path: ["specimenResults"], message: "specimenResults length must equal specimenCount" });
    }
    if (new Set(input.specimenResults.map((specimen) => specimen.specimenId)).size !== input.specimenResults.length) {
      context.addIssue({ code: "custom", path: ["specimenResults"], message: "Interface specimen IDs must be unique" });
    }
    const hasTractionCurve = input.tractionSeparationCurve !== undefined || input.mixedModeTractionSeparationCurve !== undefined;
    const representative = input.specimenResults.find((specimen) => specimen.specimenId === input.representativeSpecimenId);
    if (hasTractionCurve) {
      if (input.representativeSpecimenId) {
        context.addIssue({ code: "custom", path: ["representativeSpecimenId"], message: "A traction-separation curve peak is not interchangeable with a force-over-area representative specimen value" });
      }
    } else if (!representative) {
      context.addIssue({ code: "custom", path: ["representativeSpecimenId"], message: "Choose one measured specimen as the representative result for this direct interface-strength record" });
    } else {
      if (Math.abs(representative.nominalPeakStrengthMPa - input.measuredPeakStrengthMPa) > Math.max(1e-9, input.measuredPeakStrengthMPa * 1e-9)) {
        context.addIssue({ code: "custom", path: ["measuredPeakStrengthMPa"], message: "measuredPeakStrengthMPa must equal the selected representative specimen's force-over-area result" });
      }
      if (representative.failureLocation !== input.failureLocation) {
        context.addIssue({ code: "custom", path: ["failureLocation"], message: "Record failureLocation must match the selected representative specimen" });
      }
      if (!input.evidence.some((item) => item.value === representative.nominalPeakStrengthMPa
        && item.sourceHash === representative.sourceHash && item.sourceLocator === representative.sourceLocator)) {
        context.addIssue({ code: "custom", path: ["evidence"], message: "Representative specimen evidence must cite its force-over-area value, SHA-256 and exact specimen locator" });
      }
    }
  } else if (input.representativeSpecimenId) {
    context.addIssue({ code: "custom", path: ["representativeSpecimenId"], message: "representativeSpecimenId requires specimenResults" });
  }
  if (input.tractionSeparationCurve) {
    try {
      analyzeMaterialInterfaceTestCurve(input);
    } catch (error) {
      context.addIssue({ code: "custom", path: ["tractionSeparationCurve"], message: error instanceof Error ? error.message : String(error) });
    }
  }
});

const exactBaseSchema = baseSchema.safeExtend({
  materialAProcess: exactMaterialCouponProcessSchema,
  materialBProcess: exactMaterialCouponProcessSchema,
});

export const interfaceTestInputSchema = exactBaseSchema.superRefine((input, context) => {
  const hasTractionCurve = input.tractionSeparationCurve !== undefined || input.mixedModeTractionSeparationCurve !== undefined;
  if (hasTractionCurve && !input.fractureMethod) {
    context.addIssue({ code: "custom", path: ["fractureMethod"], message: "A measured traction-separation curve must declare its physical fracture-test method (DCB, ENF or MMB); loading mode alone does not establish fracture methodology" });
  }
  if (!hasTractionCurve && input.fractureMethod) {
    context.addIssue({ code: "custom", path: ["fractureMethod"], message: "fractureMethod applies only to a record with its measured traction-separation curve" });
  }
  if (input.interfaceKind !== "same-material-layer") return;
  if (input.materialAProcess.layerHeightMm === undefined || input.materialBProcess.layerHeightMm === undefined) {
    context.addIssue({ code: "custom", path: ["materialAProcess", "layerHeightMm"], message: "A same-material layer test requires the measured slicer layer height on both sides" });
  }
  if (!input.specimenResults && !input.tractionSeparationCurve && !input.mixedModeTractionSeparationCurve) {
    context.addIssue({ code: "custom", path: ["specimenResults"], message: "A direct interface-strength record requires raw specimen force and cross-section measurements" });
  }
});
export const interfaceTestRecordSchema = baseSchema.extend({
  id: sha256,
  createdAt: z.iso.datetime(),
  recordStatus: z.literal("caller-attested-physical-material-interface-test"),
}).strict();

export const interfaceTestQuerySchema = z.object({
  interfaceKind: baseSchema.shape.interfaceKind,
  materialAProcess: exactMaterialCouponProcessSchema,
  materialBProcess: exactMaterialCouponProcessSchema,
  testMode: baseSchema.shape.testMode,
  interfaceNormalGlobal: direction,
  loadDirectionGlobal: direction,
  testProtocolHash: sha256,
}).strict().superRefine((query, context) => {
  if (query.interfaceKind === "same-material-layer"
    && canonicalJson(query.materialAProcess) !== canonicalJson(query.materialBProcess)) {
    context.addIssue({ code: "custom", path: ["materialBProcess"], message: "A same-material layer query requires matching material process records on both sides" });
  }
  if (query.interfaceKind === "dissimilar-material-bond"
    && query.materialAProcess.materialId === query.materialBProcess.materialId) {
    context.addIssue({ code: "custom", path: ["materialBProcess", "materialId"], message: "A dissimilar-material query requires two distinct materials" });
  }
  const alignment = Math.abs(query.interfaceNormalGlobal.reduce((sum, value, axis) => sum + value * query.loadDirectionGlobal[axis]!, 0));
  if (query.testMode === "normal-tension" && alignment < Math.cos(Math.PI / 180)) {
    context.addIssue({ code: "custom", path: ["loadDirectionGlobal"], message: "Normal-tension test load direction must align with the interface normal within one degree" });
  }
  if (query.testMode === "interface-shear" && alignment > Math.sin(Math.PI / 180)) {
    context.addIssue({ code: "custom", path: ["loadDirectionGlobal"], message: "Interface-shear test load direction must lie in the interface plane within one degree" });
  }
  if (query.testMode === "mixed-mode" && (alignment <= Math.sin(Math.PI / 180) || alignment >= Math.cos(Math.PI / 180))) {
    context.addIssue({ code: "custom", path: ["loadDirectionGlobal"], message: "Mixed-mode test load direction must include normal and tangential loading, each more than one degree from a pure mode" });
  }
});

/** Public MCP contract intentionally models one material/process on both sides. */
export const interfaceTestMcpInputSchema = rawBaseSchema
  .omit({ interfaceKind: true, materialAProcess: true, materialBProcess: true, specimenResults: true })
  .extend({
    materialProcess: exactMaterialCouponProcessSchema,
    failureLocation: z.enum(["interface", "printed-material", "mixed", "fixture", "unknown"]),
    specimenResults: z.array(z.object({
      specimenId: id,
      peakForceN: positive,
      netCrossSectionMm2: positive,
      nominalPeakStrengthMPa: positive,
      failureLocation: z.enum(["interface", "printed-material", "mixed", "fixture", "unknown"]),
      sourceHash: sha256,
      sourceLocator: id.max(2000),
    }).strict()).min(1).max(1000).optional(),
  })
  .strict();

/** Public MCP contract intentionally matches one material/process only. */
export const interfaceTestMcpQuerySchema = z.object({
  materialProcess: exactMaterialCouponProcessSchema,
  testMode: rawBaseSchema.shape.testMode,
  interfaceNormalGlobal: direction,
  loadDirectionGlobal: direction,
  testProtocolHash: sha256,
}).strict();

export const interfaceSpecimenStrengthMcpInputSchema = z.object({
  specimens: z.array(interfaceSpecimenCalculationItemSchema.extend({
    failureLocation: z.enum(["interface", "printed-material", "mixed", "fixture", "unknown"]),
  }).strict()).min(1).max(1000),
}).strict();

export type InterfaceTestMcpInput = z.infer<typeof interfaceTestMcpInputSchema>;

export type InterfaceTestInput = z.infer<typeof interfaceTestInputSchema>;
export type InterfaceTestRecord = z.infer<typeof interfaceTestRecordSchema>;
export type InterfaceTestQuery = z.infer<typeof interfaceTestQuerySchema>;
export const interfaceSpecimenStrengthInputSchema = interfaceSpecimenCalculationInputSchema;
export type InterfaceSpecimenStrengthInput = z.infer<typeof interfaceSpecimenStrengthInputSchema>;
export interface InterfaceSpecimenStrengthCalculation {
  specimens: Array<z.infer<typeof interfaceSpecimenResultSchema>>;
  summary: {
    specimenCount: number;
    interfaceFailureCount: number;
    minimumPeakStrengthMPa: number | null;
    maximumPeakStrengthMPa: number | null;
    meanPeakStrengthMPa: number | null;
    sampleStandardDeviationMPa: number | null;
    interpretation: "descriptive-interface-failure-specimen-statistics-only";
    limitations: string[];
  };
}
export type InterfaceTestMatch = {
  status: "no-match" | "matched" | "ambiguous";
  source: "immutable-local-physical-material-interface-test-registry";
  records: InterfaceTestRecord[];
  selected: InterfaceTestRecord | null;
  reasons: string[];
};

export function calculateInterfaceSpecimenStrengths(rawInput: unknown): InterfaceSpecimenStrengthCalculation {
  const input = interfaceSpecimenStrengthInputSchema.parse(rawInput);
  const specimens = input.specimens.map((specimen) => ({
    ...specimen,
    nominalPeakStrengthMPa: specimen.peakForceN / specimen.netCrossSectionMm2,
  }));
  const interfaceValues = specimens
    .filter((specimen) => specimen.failureLocation === "interface")
    .map((specimen) => specimen.nominalPeakStrengthMPa);
  const meanPeakStrengthMPa = interfaceValues.length === 0
    ? null
    : interfaceValues.reduce((sum, value) => sum + value, 0) / interfaceValues.length;
  const sampleStandardDeviationMPa = interfaceValues.length < 2 ? null : Math.sqrt(
    interfaceValues.reduce((sum, value) => sum + ((value - meanPeakStrengthMPa!) ** 2), 0) / (interfaceValues.length - 1),
  );
  return {
    specimens,
    summary: {
      specimenCount: specimens.length,
      interfaceFailureCount: specimens.filter((specimen) => specimen.failureLocation === "interface").length,
      minimumPeakStrengthMPa: interfaceValues.length === 0 ? null : Math.min(...interfaceValues),
      maximumPeakStrengthMPa: interfaceValues.length === 0 ? null : Math.max(...interfaceValues),
      meanPeakStrengthMPa,
      sampleStandardDeviationMPa,
      interpretation: "descriptive-interface-failure-specimen-statistics-only",
      limitations: [
        "Nominal force divided by measured net area is not an isolated local interface traction or a cohesive law.",
        "Only specimens with failureLocation=interface contribute to the summary range, mean and sample standard deviation; other failure locations remain visible per specimen but are excluded from those statistics.",
        "The interface-failure summary statistics are descriptive only; they are not design allowables or statistically qualified bounds.",
      ],
    },
  };
}

export interface MaterialInterfaceCurveAnalysis {
  mode: InterfaceTestInput["testMode"];
  sourceHash: string;
  sourceLocator: string;
  peakStrengthMPa: number;
  peakSeparationMm: number;
  initialSegmentStiffnessMPaPerMm: number;
  fractureEnergyNPerMm: number;
  finalSeparationMm: number;
  interpretation: "measured-curve-summary-only";
  limitations: string[];
}

export interface MixedModeMaterialInterfaceCurveAnalysis {
  mode: "mixed-mode";
  sourceHash: string;
  sourceLocator: string;
  peakResultantStrengthMPa: number;
  normalFractureEnergyNPerMm: number;
  tangentialFractureEnergyNPerMm: number;
  totalFractureEnergyNPerMm: number;
  tangentialEnergyFraction: number;
  initialResultantStiffnessMPaPerMm: number;
  finalNormalSeparationMm: number;
  finalTangentialSeparationMm: number;
  interpretation: "measured-mixed-mode-curve-summary-only";
  limitations: string[];
}

export function analyzeMaterialInterfaceTestCurve(
  rawInput: Pick<InterfaceTestInput, "testMode" | "failureLocation" | "measuredPeakStrengthMPa" | "tractionSeparationCurve">,
): MaterialInterfaceCurveAnalysis {
  if (!rawInput.tractionSeparationCurve) throw new Error("The stored interface-test record has no complete measured traction-separation curve");
  if (rawInput.testMode === "mixed-mode") throw new Error("A scalar traction-separation curve cannot summarize a mixed-mode physical test");
  if (rawInput.failureLocation !== "interface") throw new Error("A cohesive-interface curve summary requires observed failure at the tested interface");
  const input = z.object({
    testMode: baseSchema.shape.testMode,
    failureLocation: baseSchema.shape.failureLocation,
    measuredPeakStrengthMPa: positive,
    tractionSeparationCurve: tractionSeparationCurveSchema,
  }).parse(rawInput);
  const points = input.tractionSeparationCurve.points;
  if (points[0]?.separationMm !== 0 || points[0]?.tractionMPa !== 0) {
    throw new Error("A traction-separation curve must start at zero separation and zero traction");
  }
  if (points.at(-1)?.tractionMPa !== 0) throw new Error("A complete traction-separation curve must end at zero traction");
  for (let index = 1; index < points.length; index += 1) {
    if (points[index]!.separationMm <= points[index - 1]!.separationMm) {
      throw new Error("Curve separation values must be strictly increasing");
    }
  }
  const peakStrengthMPa = Math.max(...points.map((point) => point.tractionMPa));
  if (peakStrengthMPa !== input.measuredPeakStrengthMPa) {
    throw new Error("Curve peak traction must exactly match measuredPeakStrengthMPa");
  }
  const peakPoint = points.find((point) => point.tractionMPa === peakStrengthMPa)!;
  const first = points[1]!;
  const initialSegmentStiffnessMPaPerMm = first.tractionMPa / first.separationMm;
  if (initialSegmentStiffnessMPaPerMm <= 0) throw new Error("The first measured curve segment must have positive stiffness");
  let fractureEnergyNPerMm = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    fractureEnergyNPerMm += (current.separationMm - previous.separationMm)
      * (current.tractionMPa + previous.tractionMPa) / 2;
  }
  if (!Number.isFinite(fractureEnergyNPerMm) || fractureEnergyNPerMm <= 0) {
    throw new Error("A traction-separation curve must have positive integrated fracture energy");
  }
  return {
    mode: input.testMode,
    sourceHash: input.tractionSeparationCurve.sourceHash,
    sourceLocator: input.tractionSeparationCurve.sourceLocator,
    peakStrengthMPa,
    peakSeparationMm: peakPoint.separationMm,
    initialSegmentStiffnessMPaPerMm,
    fractureEnergyNPerMm,
    finalSeparationMm: points.at(-1)!.separationMm,
    interpretation: "measured-curve-summary-only",
    limitations: [
      "This curve summary is not a qualified cohesive law or design allowable.",
      "The initial stiffness is the slope of the first measured segment and may be sensitive to fixture compliance and sampling resolution.",
      "Mixed-mode interaction, fatigue, rate, temperature and process variation are not modeled.",
    ],
  };
}

export function analyzeMixedModeMaterialInterfaceTestCurve(
  rawInput: Pick<InterfaceTestInput, "testMode" | "failureLocation" | "measuredPeakStrengthMPa" | "mixedModeTractionSeparationCurve">,
): MixedModeMaterialInterfaceCurveAnalysis {
  if (!rawInput.mixedModeTractionSeparationCurve) throw new Error("The stored mixed-mode interface test has no full vector traction-separation curve");
  if (rawInput.testMode !== "mixed-mode") throw new Error("A vector traction-separation curve requires a mixed-mode physical test");
  if (rawInput.failureLocation !== "interface") throw new Error("A mixed-mode cohesive calibration requires observed failure at the tested interface");
  const input = z.object({
    testMode: z.literal("mixed-mode"),
    failureLocation: baseSchema.shape.failureLocation,
    measuredPeakStrengthMPa: positive,
    mixedModeTractionSeparationCurve: mixedModeTractionSeparationCurveSchema,
  }).parse(rawInput);
  const { points } = input.mixedModeTractionSeparationCurve;
  const first = points[0]!;
  if (first.normalSeparationMm !== 0 || first.tangentialSeparationMm !== 0
    || first.normalTractionMPa !== 0 || first.tangentialTractionMPa !== 0) {
    throw new Error("A mixed-mode traction-separation curve must start at zero separation and traction in both components");
  }
  const last = points.at(-1)!;
  if (last.normalTractionMPa !== 0 || last.tangentialTractionMPa !== 0) {
    throw new Error("A complete mixed-mode curve must end at zero traction in both components");
  }

  let normalFractureEnergyNPerMm = 0;
  let tangentialFractureEnergyNPerMm = 0;
  let peakResultantStrengthMPa = 0;
  let previousEffectiveSeparationMm = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const resultantTraction = Math.hypot(current.normalTractionMPa, current.tangentialTractionMPa);
    peakResultantStrengthMPa = Math.max(peakResultantStrengthMPa, resultantTraction);
    const effectiveSeparationMm = Math.hypot(current.normalSeparationMm, current.tangentialSeparationMm);
    if (index === 0) continue;
    const previous = points[index - 1]!;
    if (current.normalSeparationMm < previous.normalSeparationMm
      || current.tangentialSeparationMm < previous.tangentialSeparationMm
      || effectiveSeparationMm <= previousEffectiveSeparationMm) {
      throw new Error("Mixed-mode separation components must be nondecreasing and the total separation must strictly increase");
    }
    normalFractureEnergyNPerMm += (current.normalSeparationMm - previous.normalSeparationMm)
      * (current.normalTractionMPa + previous.normalTractionMPa) / 2;
    tangentialFractureEnergyNPerMm += (current.tangentialSeparationMm - previous.tangentialSeparationMm)
      * (current.tangentialTractionMPa + previous.tangentialTractionMPa) / 2;
    previousEffectiveSeparationMm = effectiveSeparationMm;
  }
  if (peakResultantStrengthMPa !== input.measuredPeakStrengthMPa) {
    throw new Error("Mixed-mode resultant peak traction must exactly match measuredPeakStrengthMPa");
  }
  if (!Number.isFinite(normalFractureEnergyNPerMm) || normalFractureEnergyNPerMm <= 0
    || !Number.isFinite(tangentialFractureEnergyNPerMm) || tangentialFractureEnergyNPerMm <= 0) {
    throw new Error("A mixed-mode curve must contain positive measured work in both normal and tangential components");
  }
  const totalFractureEnergyNPerMm = normalFractureEnergyNPerMm + tangentialFractureEnergyNPerMm;
  const initialResultantStiffnessMPaPerMm = Math.hypot(points[1]!.normalTractionMPa, points[1]!.tangentialTractionMPa)
    / Math.hypot(points[1]!.normalSeparationMm, points[1]!.tangentialSeparationMm);
  if (!Number.isFinite(initialResultantStiffnessMPaPerMm) || initialResultantStiffnessMPaPerMm <= 0) {
    throw new Error("The first measured mixed-mode curve segment must have positive resultant stiffness");
  }
  return {
    mode: "mixed-mode",
    sourceHash: input.mixedModeTractionSeparationCurve.sourceHash,
    sourceLocator: input.mixedModeTractionSeparationCurve.sourceLocator,
    peakResultantStrengthMPa,
    normalFractureEnergyNPerMm,
    tangentialFractureEnergyNPerMm,
    totalFractureEnergyNPerMm,
    tangentialEnergyFraction: tangentialFractureEnergyNPerMm / totalFractureEnergyNPerMm,
    initialResultantStiffnessMPaPerMm,
    finalNormalSeparationMm: last.normalSeparationMm,
    finalTangentialSeparationMm: last.tangentialSeparationMm,
    interpretation: "measured-mixed-mode-curve-summary-only",
    limitations: [
      "This mixed-mode curve summary is measured evidence, not a qualified cohesive law or design allowable.",
      "The componentwise trapezoidal work integral uses the supplied compliance-corrected traction and separation data.",
      "One mixed-mode test does not establish whether a single Benzeggagh-Kenane exponent describes other mode-mix ratios or process variation.",
    ],
  };
}

export class InterfaceTestStore {
  private readonly root: string;

  constructor(root: string) { this.root = resolve(root); }

  async record(rawInput: InterfaceTestInput): Promise<{ record: InterfaceTestRecord; alreadyExisted: boolean }> {
    const input = interfaceTestInputSchema.parse(rawInput);
    const hash = interfaceTestHash(input);
    const record = interfaceTestRecordSchema.parse({
      ...input,
      id: hash,
      createdAt: new Date().toISOString(),
      recordStatus: "caller-attested-physical-material-interface-test",
    });
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      await writeFile(this.recordPath(hash), `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      return { record: structuredClone(record), alreadyExisted: false };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const existing = await this.readRecord(hash);
      if (hashValidatedInterfaceTestInput(stripRecord(existing)) !== hash) throw new Error(`Stored interface-test record does not match its content hash: ${hash}`);
      return { record: existing, alreadyExisted: true };
    }
  }

  async list(): Promise<InterfaceTestRecord[]> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.root, { withFileTypes: true });
    const records: InterfaceTestRecord[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      records.push(await this.readRecord(entry.name.slice(0, -5)));
    }
    return records.sort((a, b) => a.testedAt.localeCompare(b.testedAt)).map((record) => structuredClone(record));
  }

  async match(rawQuery: InterfaceTestQuery): Promise<InterfaceTestMatch> {
    const query = interfaceTestQuerySchema.parse(rawQuery);
    const records = (await this.list()).filter((record) =>
      record.interfaceKind === query.interfaceKind
      && record.testMode === query.testMode
      && record.testProtocolHash === query.testProtocolHash
      && canonicalJson(record.interfaceNormalGlobal) === canonicalJson(query.interfaceNormalGlobal)
      && canonicalJson(record.loadDirectionGlobal) === canonicalJson(query.loadDirectionGlobal)
      && canonicalJson(record.materialAProcess) === canonicalJson(query.materialAProcess)
      && canonicalJson(record.materialBProcess) === canonicalJson(query.materialBProcess));
    if (records.length === 0) return {
      status: "no-match",
      source: "immutable-local-physical-material-interface-test-registry",
      records: [], selected: null,
      reasons: ["No physical material-interface test exactly matches both process identities, interface mode, normal direction and test protocol"],
    };
    const fingerprints = new Set(records.map((record) => canonicalJson({
      fractureMethod: record.fractureMethod ?? null,
      measuredPeakStrengthMPa: record.measuredPeakStrengthMPa,
      failureLocation: record.failureLocation,
      tractionSeparationCurvePoints: record.tractionSeparationCurve?.points ?? null,
      mixedModeTractionSeparationCurvePoints: record.mixedModeTractionSeparationCurve?.points ?? null,
    })));
    if (fingerprints.size > 1) return {
      status: "ambiguous",
      source: "immutable-local-physical-material-interface-test-registry",
      records, selected: null,
      reasons: ["Conflicting peak strengths, failure locations or traction-separation curves exist for the exact material pair and test protocol; resolve the test records explicitly"],
    };
    const selected = records.toSorted((a, b) => b.testedAt.localeCompare(a.testedAt))[0]!;
    return { status: "matched", source: "immutable-local-physical-material-interface-test-registry", records, selected, reasons: [] };
  }

  async read(recordId: string): Promise<InterfaceTestRecord> { return await this.readRecord(recordId); }

  private recordPath(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`Invalid interface-test record ID: ${hash}`);
    return join(this.root, `${hash}.json`);
  }

  private async readRecord(hash: string): Promise<InterfaceTestRecord> {
    const handle = await open(this.recordPath(hash), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size <= 0 || stat.size > 1_000_000) throw new Error(`Invalid interface-test record file: ${hash}`);
      const parsed: unknown = JSON.parse(await handle.readFile("utf8"));
      const record = interfaceTestRecordSchema.parse(parsed);
      if (record.id !== hash || hashValidatedInterfaceTestInput(stripRecord(record)) !== hash) throw new Error(`Interface-test content hash mismatch: ${hash}`);
      return structuredClone(record);
    } finally {
      await handle.close();
    }
  }
}

export function interfaceTestHash(input: InterfaceTestInput | z.output<typeof baseSchema>): string {
  return hashValidatedInterfaceTestInput(baseSchema.parse(input));
}

function stripRecord(record: InterfaceTestRecord): z.output<typeof baseSchema> {
  const { id: _id, createdAt: _createdAt, recordStatus: _recordStatus, ...input } = record;
  return baseSchema.parse(input);
}

function hashValidatedInterfaceTestInput(input: z.output<typeof baseSchema>): string {
  return createHash("sha256").update(canonicalJson(baseSchema.parse(input))).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
