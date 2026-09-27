import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";

import { evidenceSchema } from "./schemas.ts";
import { resolveOrthotropicOrientation } from "./fem/orthotropic-material.ts";

const id = z.string().trim().min(1).max(240);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const finite = z.number().finite();
const positive = finite.positive();
const propertyNames = ["youngModulusMPa", "shearModulusMPa", "tensileStrengthMPa", "shearStrengthMPa"] as const;

export const materialCouponProcessSchema = z.object({
  printerId: id,
  materialId: id,
  profileHash: sha256,
  orientationDeg: z.tuple([finite, finite, finite]),
  infillPercent: finite.min(0).max(100),
  infillPattern: id.optional(),
  wallLoops: z.number().int().min(0).max(20).optional(),
  topShellLayers: z.number().int().min(0).max(100).optional(),
  bottomShellLayers: z.number().int().min(0).max(100).optional(),
  nozzleTemperatureC: finite.min(0).max(500),
  layerHeightMm: positive.optional(),
}).strict();
export const exactMaterialCouponProcessSchema = materialCouponProcessSchema.extend({
  layerHeightMm: z.number({ error: "An exact material coupon process requires the measured slicer layer height" }).finite().positive(),
}).superRefine((process, context) => {
  for (const key of ["infillPattern", "wallLoops", "topShellLayers", "bottomShellLayers"] as const) {
    if (process[key] === undefined) context.addIssue({ code: "custom", path: [key], message: `An exact material process requires the measured slicer ${key} setting` });
  }
});

const propertyEvidenceSchema = z.object({
  youngModulusMPa: z.array(id).min(1),
  shearModulusMPa: z.array(id).min(1).optional(),
  tensileStrengthMPa: z.array(id).min(1).optional(),
  shearStrengthMPa: z.array(id).min(1).optional(),
}).strict();
const orthotropicStrengthKeys = ["xTensionMPa", "xCompressionMPa", "yTensionMPa", "yCompressionMPa", "zTensionMPa", "zCompressionMPa", "xyShearMPa", "xzShearMPa", "yzShearMPa"] as const;
export const orthotropicTsaiWuTestMetadata = {
  xTensionMPa: { testAxis: "material-1", testMode: "tension" },
  xCompressionMPa: { testAxis: "material-1", testMode: "compression" },
  yTensionMPa: { testAxis: "material-2", testMode: "tension" },
  yCompressionMPa: { testAxis: "material-2", testMode: "compression" },
  zTensionMPa: { testAxis: "material-3", testMode: "tension" },
  zCompressionMPa: { testAxis: "material-3", testMode: "compression" },
  xyShearMPa: { testAxis: "material-1-2", testMode: "shear" },
  xzShearMPa: { testAxis: "material-1-3", testMode: "shear" },
  yzShearMPa: { testAxis: "material-2-3", testMode: "shear" },
} as const satisfies Record<typeof orthotropicStrengthKeys[number], { testAxis: string; testMode: string }>;
export const orthotropicTsaiWuInteractionTestAxis = {
  xy: "material-1-2", xz: "material-1-3", yz: "material-2-3",
} as const;
const orthotropicStrengthEvidenceSchema = z.object(Object.fromEntries(orthotropicStrengthKeys.map((key) => [key, z.array(id).length(1)])) as Record<typeof orthotropicStrengthKeys[number], z.ZodArray<typeof id>>).strict();
const orthotropicInteractionEvidenceSchema = z.object({ xy: id, xz: id, yz: id }).strict();
const orthotropicTsaiWuSchema = z.object({
  strengths: z.object({
    xTensionMPa: positive, xCompressionMPa: positive, yTensionMPa: positive, yCompressionMPa: positive,
    zTensionMPa: positive, zCompressionMPa: positive, xyShearMPa: positive, xzShearMPa: positive, yzShearMPa: positive,
  }).strict(),
  interactions: z.object({ xy: finite, xz: finite, yz: finite }).strict().superRefine((value, context) => {
    const { xy, xz, yz } = value;
    const determinant = 1 + 2 * xy * xz * yz - xy * xy - xz * xz - yz * yz;
    if ([xy, xz, yz].some((coefficient) => Math.abs(coefficient) >= 1)
      || 1 - xy * xy <= 0 || !Number.isFinite(determinant) || determinant <= 1e-12) {
      context.addIssue({ code: "custom", message: "Normalized Tsai-Wu interaction matrix must be positive definite" });
    }
  }),
  strengthEvidence: orthotropicStrengthEvidenceSchema,
  interactionEvidence: orthotropicInteractionEvidenceSchema,
}).strict();
const orthotropicPropertyNames = ["youngsModulus2MPa", "youngsModulus3MPa", "poissonRatio13", "poissonRatio23", "shearModulus12MPa", "shearModulus13MPa", "shearModulus23MPa"] as const;
export const orthotropicMaterialSchema = z.object({
  youngsModulus2MPa: positive, youngsModulus3MPa: positive,
  poissonRatio13: finite, poissonRatio23: finite,
  shearModulus12MPa: positive, shearModulus13MPa: positive, shearModulus23MPa: positive,
  propertyEvidence: z.object({
    youngsModulus2MPa: z.array(id).min(1), youngsModulus3MPa: z.array(id).min(1),
    poissonRatio13: z.array(id).min(1), poissonRatio23: z.array(id).min(1),
    shearModulus12MPa: z.array(id).min(1), shearModulus13MPa: z.array(id).min(1), shearModulus23MPa: z.array(id).min(1),
  }).strict(),
  orientation: z.object({
    axis1DirectionGlobal: z.tuple([finite, finite, finite]), axis2ReferenceDirectionGlobal: z.tuple([finite, finite, finite]), buildDirectionGlobal: z.tuple([finite, finite, finite]),
    evidence: z.object({
      status: z.enum(["user-confirmed", "measured", "sourced"]), description: id.max(1000),
      sourceUrl: z.url().refine((url) => url.startsWith("https://") || url.startsWith("http://"), "Source URL must use http or https").optional(), sourceHash: sha256.optional(), sourceLocator: id.optional(),
    }).strict(),
  }).strict(),
  tsaiWuCriterion: orthotropicTsaiWuSchema.optional(),
}).strict();

const materialCouponQualificationBaseSchema = z.object({
  process: materialCouponProcessSchema,
  poissonRatio: finite.optional(),
  poissonRatioEvidence: z.array(id).min(1).optional(),
  properties: z.object({
    youngModulusMPa: positive,
    shearModulusMPa: positive.optional(),
    tensileStrengthMPa: positive.optional(),
    shearStrengthMPa: positive.optional(),
  }).strict(),
  propertyEvidence: propertyEvidenceSchema,
  orthotropicMaterial: orthotropicMaterialSchema.optional(),
  evidence: z.array(evidenceSchema).min(1).max(64),
  testStandard: id.max(200),
  specimenCount: z.number().int().positive().max(1000),
  testedAt: z.iso.datetime(),
  composedFromRecordIds: z.array(sha256).min(2).max(8).refine((ids) => new Set(ids).size === ids.length, "Composed record IDs must be unique").optional(),
  notes: z.string().trim().min(1).max(4000).optional(),
  source: z.literal("physical-coupon-test"),
  callerConfirmsPhysicalTests: z.literal(true),
}).strict();

const materialCouponQualificationValidationSchema = materialCouponQualificationBaseSchema.superRefine((input, context) => {
  const evidenceById = new Map(input.evidence.map((item) => [item.id, item]));
  if (evidenceById.size !== input.evidence.length) context.addIssue({ code: "custom", path: ["evidence"], message: "Evidence IDs must be unique" });
  const usedIds = new Set<string>();
  if ((input.poissonRatio === undefined) !== (input.poissonRatioEvidence === undefined)) {
    context.addIssue({ code: "custom", path: ["poissonRatioEvidence"], message: "nu12 and its measured evidence must be recorded together" });
  }
  if (input.poissonRatio !== undefined && input.poissonRatioEvidence) {
    for (const evidenceId of input.poissonRatioEvidence) {
      if (usedIds.has(evidenceId)) context.addIssue({ code: "custom", path: ["poissonRatioEvidence"], message: `Evidence ${evidenceId} must be assigned to only one material property` });
      usedIds.add(evidenceId);
      const evidence = evidenceById.get(evidenceId);
      if (!evidence) {
        context.addIssue({ code: "custom", path: ["poissonRatioEvidence"], message: `Missing evidence ${evidenceId}` });
        continue;
      }
      if (evidence.status !== "measured" || evidence.unit !== "ratio" || evidence.value !== input.poissonRatio) {
        context.addIssue({ code: "custom", path: ["poissonRatioEvidence"], message: "nu12 requires matching measured ratio evidence with the exact recorded value" });
      }
      if (!evidence.sourceUrl || !evidence.sourceHash || !/^[a-f0-9]{64}$/.test(evidence.sourceHash) || !evidence.sourceLocator) {
        context.addIssue({ code: "custom", path: ["poissonRatioEvidence"], message: `Evidence ${evidenceId} needs sourceUrl, SHA-256 sourceHash and sourceLocator` });
      }
    }
  }
  for (const property of propertyNames) {
    const ids = input.propertyEvidence[property];
    const value = input.properties[property];
    if ((ids === undefined) !== (value === undefined)) {
      context.addIssue({ code: "custom", path: ["propertyEvidence", property], message: `${property} and its measured evidence must be recorded together` });
      continue;
    }
    if (!ids || value === undefined) continue;
    for (const evidenceId of ids) {
      if (usedIds.has(evidenceId)) context.addIssue({ code: "custom", path: ["propertyEvidence", property], message: `Evidence ${evidenceId} must be assigned to only one property` });
      usedIds.add(evidenceId);
      const evidence = evidenceById.get(evidenceId);
      if (!evidence) {
        context.addIssue({ code: "custom", path: ["propertyEvidence", property], message: `Missing evidence ${evidenceId}` });
        continue;
      }
      if (evidence.status !== "measured" || evidence.unit !== "MPa" || evidence.value !== value) {
        context.addIssue({ code: "custom", path: ["evidence"], message: `${property} must link to a measured MPa evidence value equal to the recorded property` });
      }
      if (!evidence.sourceUrl || !evidence.sourceHash || !/^[a-f0-9]{64}$/.test(evidence.sourceHash) || !evidence.sourceLocator) {
        context.addIssue({ code: "custom", path: ["evidence"], message: `Evidence ${evidenceId} needs sourceUrl, SHA-256 sourceHash and sourceLocator` });
      }
    }
  }
  if (input.orthotropicMaterial) {
    const orientationEvidence = input.orthotropicMaterial.orientation.evidence;
    if (orientationEvidence.description.trim().length < 12) context.addIssue({ code: "custom", path: ["orthotropicMaterial", "orientation", "evidence", "description"], message: "Print-axis evidence must describe how the global frame was established" });
    if (orientationEvidence.status !== "user-confirmed"
      && (!orientationEvidence.sourceUrl || !orientationEvidence.sourceHash || !orientationEvidence.sourceLocator)) {
      context.addIssue({ code: "custom", path: ["orthotropicMaterial", "orientation", "evidence"], message: "Measured/sourced print axes require URL, SHA-256 and locator" });
    }
    try { resolveOrthotropicOrientation(input.orthotropicMaterial.orientation); }
    catch (error) { context.addIssue({ code: "custom", path: ["orthotropicMaterial", "orientation"], message: error instanceof Error ? error.message : "Invalid orthotropic print axes" }); }
    for (const property of orthotropicPropertyNames) {
      const evidenceIds = input.orthotropicMaterial.propertyEvidence[property];
      for (const evidenceId of evidenceIds) {
        if (usedIds.has(evidenceId)) context.addIssue({ code: "custom", path: ["orthotropicMaterial", "propertyEvidence", property], message: `Evidence ${evidenceId} must be assigned to only one property` });
        usedIds.add(evidenceId);
        const evidence = evidenceById.get(evidenceId);
        if (!evidence) {
          context.addIssue({ code: "custom", path: ["orthotropicMaterial", "propertyEvidence", property], message: `Missing evidence ${evidenceId}` });
          continue;
        }
        const value = input.orthotropicMaterial[property];
        const unit = property.startsWith("poisson") ? "ratio" : "MPa";
        if (evidence.status !== "measured" || evidence.unit !== unit || evidence.value !== value) {
          context.addIssue({ code: "custom", path: ["orthotropicMaterial", "propertyEvidence", property], message: `${property} requires exact measured coupon evidence with the matching unit and value` });
        }
        if (!evidence.sourceUrl || !evidence.sourceHash || !/^[a-f0-9]{64}$/.test(evidence.sourceHash) || !evidence.sourceLocator) {
          context.addIssue({ code: "custom", path: ["evidence"], message: `Orthotropic evidence ${evidenceId} needs URL, SHA-256 sourceHash and sourceLocator` });
        }
      }
    }
    if (input.orthotropicMaterial.tsaiWuCriterion) {
      const criterion = input.orthotropicMaterial.tsaiWuCriterion;
      const assignments = [
        ...orthotropicStrengthKeys.map((key) => ({ id: criterion.strengthEvidence[key][0]!, status: "measured", unit: "MPa", value: criterion.strengths[key], label: key })),
        ...(["xy", "xz", "yz"] as const).map((key) => ({ id: criterion.interactionEvidence[key], status: "derived", unit: "ratio", value: criterion.interactions[key], label: `Tsai-Wu ${key}` })),
      ];
      for (const assignment of assignments) {
        if (usedIds.has(assignment.id)) context.addIssue({ code: "custom", path: ["orthotropicMaterial", "tsaiWuCriterion"], message: `Evidence ${assignment.id} must be assigned to only one material property` });
        usedIds.add(assignment.id);
        const evidence = evidenceById.get(assignment.id);
        if (!evidence) {
          context.addIssue({ code: "custom", path: ["orthotropicMaterial", "tsaiWuCriterion"], message: `Missing evidence ${assignment.id}` });
          continue;
        }
        if (evidence.status !== assignment.status || evidence.unit !== assignment.unit || evidence.value !== assignment.value
          || !evidence.sourceUrl || !evidence.sourceHash || !/^[a-f0-9]{64}$/.test(evidence.sourceHash) || !evidence.sourceLocator) {
          context.addIssue({ code: "custom", path: ["evidence"], message: `${assignment.label} requires exact measured Tsai-Wu evidence with its matching unit, value and source` });
        }
        if (assignment.status === "derived" && (!evidence.derivation || evidence.dependsOn.length === 0)) {
          context.addIssue({ code: "custom", path: ["evidence"], message: `${assignment.label} must cite its biaxial test evidence and derivation` });
        }
        for (const dependencyId of evidence.dependsOn) {
          const dependency = evidenceById.get(dependencyId);
          if (!dependency) {
            context.addIssue({ code: "custom", path: ["evidence"], message: `Tsai-Wu interaction evidence ${assignment.id} references missing evidence ${dependencyId}` });
          } else if (assignment.status === "derived"
            && (dependency.status !== "measured" || !dependency.sourceUrl || !dependency.sourceLocator
              || !dependency.sourceHash || !/^[a-f0-9]{64}$/.test(dependency.sourceHash))) {
            context.addIssue({ code: "custom", path: ["evidence"], message: `Tsai-Wu interaction dependency ${dependencyId} must be a traceable measured biaxial test record` });
          }
        }
      }
    }
  }
});

export const materialCouponQualificationInputSchema = materialCouponQualificationValidationSchema.safeExtend({
  process: exactMaterialCouponProcessSchema,
}).superRefine((input, context) => {
  const criterion = input.orthotropicMaterial?.tsaiWuCriterion;
  if (!criterion) return;
  const evidenceById = new Map(input.evidence.map((item) => [item.id, item]));
  for (const key of orthotropicStrengthKeys) {
    const evidence = evidenceById.get(criterion.strengthEvidence[key][0]!);
    const expected = orthotropicTsaiWuTestMetadata[key];
    if (evidence && (evidence.testAxis !== expected.testAxis || evidence.testMode !== expected.testMode)) {
      context.addIssue({ code: "custom", path: ["evidence"], message: `${key} evidence must identify a ${expected.testMode} test along ${expected.testAxis} in the confirmed material frame` });
    }
  }
  for (const key of ["xy", "xz", "yz"] as const) {
    const expectedAxis = orthotropicTsaiWuInteractionTestAxis[key];
    const interaction = evidenceById.get(criterion.interactionEvidence[key]);
    if (interaction && (interaction.testAxis !== expectedAxis || interaction.testMode !== "biaxial")) {
      context.addIssue({ code: "custom", path: ["evidence"], message: `${key} Tsai-Wu interaction evidence must identify a biaxial test along ${expectedAxis} in the confirmed material frame` });
    }
    for (const dependencyId of interaction?.dependsOn ?? []) {
      const dependency = evidenceById.get(dependencyId);
      if (dependency && (dependency.testAxis !== expectedAxis || dependency.testMode !== "biaxial")) {
        context.addIssue({ code: "custom", path: ["evidence"], message: `Biaxial evidence ${dependencyId} must identify its ${expectedAxis} material axes` });
      }
    }
  }
});

export const materialCouponQualificationRecordSchema = materialCouponQualificationValidationSchema.extend({
  id: sha256,
  createdAt: z.iso.datetime(),
  recordStatus: z.literal("caller-attested-physical-coupon-record"),
}).strict();

// Composition provenance is assigned only by the consolidation operation, never by a raw record call.
export const materialCouponRecordInputSchema = materialCouponQualificationInputSchema.superRefine((input, context) => {
  if (input.composedFromRecordIds) {
    context.addIssue({ code: "custom", path: ["composedFromRecordIds"], message: "Use plasticity_combine_material_coupon_data to create composition provenance" });
  }
});

export const materialCouponQualificationQuerySchema = z.object({
  process: exactMaterialCouponProcessSchema,
}).strict();

export type MaterialCouponQualificationInput = z.infer<typeof materialCouponQualificationInputSchema>;
export type MaterialCouponQualificationRecord = z.infer<typeof materialCouponQualificationRecordSchema>;
export type OrthotropicCouponMaterial = z.infer<typeof orthotropicMaterialSchema>;
export type MaterialCouponQualificationQuery = z.infer<typeof materialCouponQualificationQuerySchema>;
export type MaterialCouponProcess = z.infer<typeof materialCouponProcessSchema>;

export function sameMaterialCouponProcess(a: MaterialCouponProcess, b: MaterialCouponProcess): boolean {
  return a.printerId === b.printerId && a.materialId === b.materialId && a.profileHash === b.profileHash
    && a.orientationDeg.every((value, axis) => value === b.orientationDeg[axis])
    && a.infillPercent === b.infillPercent && a.infillPattern === b.infillPattern
    && a.wallLoops === b.wallLoops && a.topShellLayers === b.topShellLayers && a.bottomShellLayers === b.bottomShellLayers
    && a.nozzleTemperatureC === b.nozzleTemperatureC
    && a.layerHeightMm === b.layerHeightMm;
}

export const RECORD_MATERIAL_COUPON_DESCRIPTION = "Store immutable physical coupon data for one exact single-material printer/material/profile hash, orientation, infill percentage and pattern, wall loops, top/bottom shell layers, nozzle temperature, and measured layer height. E1 (youngModulusMPa) with measured evidence is required. Isotropic shear modulus and tensile/shear strengths are optional and must each be paired with evidence; record them only when measured for a selected analysis. Optionally include measured Poisson ratio nu12 with its evidence IDs. Add E2/E3, nu13/nu23, G12/G13/G23 under orthotropicMaterial; its propertyEvidence IDs point to exact measured entries in evidence[]. Include the three global print axes; axis 3 must align with the build direction, and orientation.evidence must be user-confirmed or traceable. An optional tsaiWuCriterion can store nine directly measured directional failure strengths and three derived normalized interaction coefficients from biaxial tests. Each test evidence entry must state testAxis and testMode in the confirmed material frame (X/Y/Z tension or compression, XY/XZ/YZ shear, and corresponding-plane biaxial interactions); interaction evidence dependencies must carry the same biaxial plane. These attestations are stored with each exact evidence entry and the process in the immutable record hash. This model uses one material per part; it does not model multi-material prints. These un-factored strengths are not design allowables or proof of part strength.";
export const MATCH_MATERIAL_COUPON_DESCRIPTION = "Match coupon data only for an exact printer, material, profile SHA-256, orientation, infill percentage and pattern, wall loops, top/bottom shell layers, nozzle temperature, and layer height. Returns no-match, matched or ambiguous; conflicting isotropic properties, orthotropic tensors, Tsai-Wu strengths/interactions or print axes are never selected silently. A single record may be selected over compatible records that contain only a subset of its measured values. Complementary partial records remain ambiguous; call plasticity_combine_material_coupon_data with their IDs only after the user confirms the unique physical specimen count. The combine tool never averages or infers values and rejects conflicts. A match returns its measured/derived evidence and dependencies for review. Coupon strengths are not design allowables.";

export interface MaterialCouponQualificationMatch {
  status: "no-match" | "matched" | "ambiguous";
  source: "immutable-local-physical-coupon-registry";
  records: MaterialCouponQualificationRecord[];
  selected: MaterialCouponQualificationRecord | null;
  reasons: string[];
}

export class MaterialCouponQualificationStore {
  private readonly root: string;

  constructor(root = join(process.cwd(), ".plasticity-mcp", "strength", "material-qualifications")) {
    this.root = resolve(root);
  }

  async record(rawInput: MaterialCouponQualificationInput): Promise<{ record: MaterialCouponQualificationRecord; alreadyExisted: boolean }> {
    const input = materialCouponQualificationInputSchema.parse(rawInput);
    for (const sourceId of input.composedFromRecordIds ?? []) {
      const source = await this.readRecord(sourceId);
      if (!sameMaterialCouponProcess(source.process, input.process)) {
        throw new Error(`Composed coupon source ${sourceId} has a different print process`);
      }
    }
    const hash = materialCouponQualificationHash(input);
    const record = materialCouponQualificationRecordSchema.parse({
      ...input,
      id: hash,
      createdAt: new Date().toISOString(),
      recordStatus: "caller-attested-physical-coupon-record",
    });
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      await writeFile(this.recordPath(hash), `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      return { record: structuredClone(record), alreadyExisted: false };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const existing = await this.readRecord(hash);
      if (hashValidatedMaterialCouponInput(stripRecord(existing)) !== hash) throw new Error(`Stored material qualification does not match its content hash: ${hash}`);
      return { record: existing, alreadyExisted: true };
    }
  }

  async list(): Promise<MaterialCouponQualificationRecord[]> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.root, { withFileTypes: true });
    const records: MaterialCouponQualificationRecord[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      records.push(await this.readRecord(entry.name.slice(0, -5)));
    }
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((record) => structuredClone(record));
  }

  async match(rawQuery: MaterialCouponQualificationQuery): Promise<MaterialCouponQualificationMatch> {
    const query = materialCouponQualificationQuerySchema.parse(rawQuery);
    const records = (await this.list()).filter((record) => sameMaterialCouponProcess(record.process, query.process));
    if (records.length === 0) return {
      status: "no-match",
      source: "immutable-local-physical-coupon-registry",
      records: [],
      selected: null,
      reasons: ["No physical coupon record exactly matches printer, material, profile hash, orientation, infill percentage and pattern, wall loops, top/bottom shell layers, nozzle temperature, and layer height"],
    };
    const incompatiblePair = records.some((record, index) => records.slice(index + 1).some((other) => !couponRecordsCompatible(record, other)));
    if (incompatiblePair) return {
      status: "ambiguous",
      source: "immutable-local-physical-coupon-registry",
      records,
      selected: null,
      reasons: ["Conflicting measured properties exist for the exact process; review the records and choose the applicable result explicitly"],
    };
    const candidates = records.filter((record) => records.every((other) => couponRecordCovers(record, other)));
    if (candidates.length === 0) return {
      status: "ambiguous",
      source: "immutable-local-physical-coupon-registry",
      records,
      selected: null,
      reasons: ["Compatible partial coupon records exist for the exact process, but no single record contains all of their measurements; consolidate the measured properties and evidence into one physical coupon record before binding an analysis"],
    };
    const selected = candidates.toSorted((a, b) => couponRecordCoverage(b) - couponRecordCoverage(a)
      || b.testedAt.localeCompare(a.testedAt))[0]!;
    return { status: "matched", source: "immutable-local-physical-coupon-registry", records, selected, reasons: [] };
  }

  async combine(recordIds: string[], specimenCount: number): Promise<{ record: MaterialCouponQualificationRecord; alreadyExisted: boolean }> {
    if (recordIds.length < 2 || recordIds.length > 8 || new Set(recordIds).size !== recordIds.length
      || recordIds.some((recordId) => !/^[a-f0-9]{64}$/.test(recordId))) {
      throw new Error("Provide 2–8 unique material coupon record IDs");
    }
    if (!Number.isInteger(specimenCount) || specimenCount < 1 || specimenCount > 1000) {
      throw new Error("specimenCount must be the confirmed number of unique physical specimens across the selected records");
    }
    const records = await Promise.all([...recordIds].toSorted().map((recordId) => this.readRecord(recordId)));
    const process = records[0]!.process;
    if (records.some((record) => !sameMaterialCouponProcess(record.process, process))) {
      throw new Error("Coupon records can be combined only when printer, material, profile hash, orientation, infill percentage and pattern, wall loops, top/bottom shell layers, nozzle temperature and layer height all match exactly");
    }
    if (records.some((record, index) => records.slice(index + 1).some((other) => !couponRecordsCompatible(record, other)))) {
      throw new Error("Conflicting coupon values or orthotropic print frames cannot be combined");
    }

    const evidenceById = new Map<string, z.infer<typeof evidenceSchema>>();
    for (const record of records) {
      for (const item of record.evidence) {
        const existing = evidenceById.get(item.id);
        if (existing && canonicalJson(existing) !== canonicalJson(item)) throw new Error(`Evidence ID ${item.id} has conflicting contents across selected records`);
        evidenceById.set(item.id, item);
      }
    }
    const evidenceIds = (ids: string[]) => [...new Set(ids)];
    const properties = Object.fromEntries(propertyNames.flatMap((property) => {
      const value = records.find((record) => record.properties[property] !== undefined)?.properties[property];
      return value === undefined ? [] : [[property, value]];
    })) as MaterialCouponQualificationInput["properties"];
    const propertyEvidence = Object.fromEntries(propertyNames.flatMap((property) => {
      const ids = evidenceIds(records.flatMap((record) => record.propertyEvidence[property] ?? []));
      return ids.length === 0 ? [] : [[property, ids]];
    })) as MaterialCouponQualificationInput["propertyEvidence"];
    const poissonSource = records.find((record) => record.poissonRatio !== undefined);
    const orthotropicSources = records.flatMap((record) => record.orthotropicMaterial ? [record.orthotropicMaterial] : []);
    const orthotropicMaterial = orthotropicSources.length === 0 ? undefined : {
      ...structuredClone(orthotropicSources[0]!),
      propertyEvidence: Object.fromEntries(orthotropicPropertyNames.map((property) => [
        property,
        evidenceIds(orthotropicSources.flatMap((material) => material.propertyEvidence[property])),
      ])) as OrthotropicCouponMaterial["propertyEvidence"],
    };
    const composedFromRecordIds = [...new Set(records.flatMap((record) => record.composedFromRecordIds ?? [record.id]))].toSorted();
    if (composedFromRecordIds.length < 2 || composedFromRecordIds.length > 8) {
      throw new Error("The combined source chain must contain between 2 and 8 original coupon records");
    }
    const standards = [...new Set(records.map((record) => record.testStandard))];
    const testStandard = standards.join("; ");
    if (testStandard.length > 200) throw new Error("Combined test-standard description exceeds 200 characters");
    const testedAt = records.toSorted((a, b) => Date.parse(a.testedAt) - Date.parse(b.testedAt)).at(-1)!.testedAt;
    const input = materialCouponQualificationInputSchema.parse({
      process,
      properties,
      propertyEvidence,
      ...(poissonSource ? { poissonRatio: poissonSource.poissonRatio, poissonRatioEvidence: evidenceIds(records.flatMap((record) => record.poissonRatioEvidence ?? [])) } : {}),
      ...(orthotropicMaterial ? { orthotropicMaterial } : {}),
      evidence: [...evidenceById.values()],
      testStandard,
      specimenCount,
      testedAt,
      composedFromRecordIds,
      notes: "Consolidated from immutable source coupon records; specimenCount is the caller-confirmed unique specimen count, and testedAt is the latest constituent test date.",
      source: "physical-coupon-test",
      callerConfirmsPhysicalTests: true,
    });
    return await this.record(input);
  }

  async read(recordId: string): Promise<MaterialCouponQualificationRecord> {
    return await this.readRecord(recordId);
  }

  private recordPath(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`Invalid material qualification ID: ${hash}`);
    return join(this.root, `${hash}.json`);
  }

  private async readRecord(hash: string): Promise<MaterialCouponQualificationRecord> {
    const handle = await open(this.recordPath(hash), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size <= 0 || stat.size > 1_000_000) throw new Error(`Invalid material qualification file: ${hash}`);
      const parsed: unknown = JSON.parse(await handle.readFile("utf8"));
      const record = materialCouponQualificationRecordSchema.parse(parsed);
      if (record.id !== hash || hashValidatedMaterialCouponInput(stripRecord(record)) !== hash) throw new Error(`Material qualification hash mismatch: ${hash}`);
      return structuredClone(record);
    } finally {
      await handle.close();
    }
  }
}

export function materialCouponQualificationHash(input: MaterialCouponQualificationInput): string {
  return createHash("sha256").update(canonicalJson(materialCouponQualificationInputSchema.parse(input))).digest("hex");
}

function stripRecord(record: MaterialCouponQualificationRecord): z.output<typeof materialCouponQualificationValidationSchema> {
  const { id: _id, createdAt: _createdAt, recordStatus: _recordStatus, ...input } = record;
  return materialCouponQualificationValidationSchema.parse(input);
}

function hashValidatedMaterialCouponInput(input: z.output<typeof materialCouponQualificationValidationSchema>): string {
  return createHash("sha256").update(canonicalJson(materialCouponQualificationValidationSchema.parse(input))).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

function orthotropicMaterialFingerprint(material: OrthotropicCouponMaterial): unknown {
  const { propertyEvidence: _propertyEvidence, orientation, tsaiWuCriterion, ...properties } = material;
  return { ...properties, orientation: {
    axis1DirectionGlobal: orientation.axis1DirectionGlobal,
    axis2ReferenceDirectionGlobal: orientation.axis2ReferenceDirectionGlobal,
    buildDirectionGlobal: orientation.buildDirectionGlobal,
  }, ...(tsaiWuCriterion ? { tsaiWuCriterion: {
    strengths: tsaiWuCriterion.strengths,
    interactions: tsaiWuCriterion.interactions,
  } } : {}) };
}

function couponRecordsCompatible(a: MaterialCouponQualificationRecord, b: MaterialCouponQualificationRecord): boolean {
  return propertyNames.every((property) => a.properties[property] === undefined || b.properties[property] === undefined
    || a.properties[property] === b.properties[property])
    && (a.poissonRatio === undefined || b.poissonRatio === undefined || a.poissonRatio === b.poissonRatio)
    && (!a.orthotropicMaterial || !b.orthotropicMaterial
      || canonicalJson(orthotropicMaterialFingerprint(a.orthotropicMaterial)) === canonicalJson(orthotropicMaterialFingerprint(b.orthotropicMaterial)));
}

function couponRecordCovers(candidate: MaterialCouponQualificationRecord, other: MaterialCouponQualificationRecord): boolean {
  return propertyNames.every((property) => other.properties[property] === undefined
    || candidate.properties[property] === other.properties[property])
    && (other.poissonRatio === undefined || candidate.poissonRatio === other.poissonRatio)
    && (!other.orthotropicMaterial || (candidate.orthotropicMaterial !== undefined
      && canonicalJson(orthotropicMaterialFingerprint(candidate.orthotropicMaterial)) === canonicalJson(orthotropicMaterialFingerprint(other.orthotropicMaterial))));
}

function couponRecordCoverage(record: MaterialCouponQualificationRecord): number {
  return propertyNames.filter((property) => record.properties[property] !== undefined).length
    + Number(record.poissonRatio !== undefined)
    + (record.orthotropicMaterial ? orthotropicPropertyNames.length + 3
      + Number(record.orthotropicMaterial.tsaiWuCriterion !== undefined) * 12 : 0);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
