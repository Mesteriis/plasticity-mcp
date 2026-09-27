import { z } from "zod";

import type {
  AnnotationBatchInput,
  AnnotationInput,
  ConstructionJournalInput,
  DfmInput,
  DimensionChangeBatchInput,
  ManufacturingAssessmentRequest,
  ManufacturingProfile,
  ManufacturingProfileRegistrationRequest,
  ModelVersionInput,
  ReferenceInput,
  SliceJobRequest,
  SlicePartsBatchRequest,
  StructuredBlockInput,
} from "./contracts.ts";

export const idSchema = z.string().uuid();
export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const isoTimestampSchema = z.string().datetime({ offset: true });
const httpUrlSchema = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "URL must use HTTP or HTTPS");
export const vector3MmSchema = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);

export const measurementSourceSchema = z.enum([
  "native-brep",
  "display-mesh",
  "reference-document",
  "user",
  "assumption",
]);

export const confidenceSchema = z.enum([
  "verified",
  "probable",
  "approximate",
  "assumed",
  "measurement-required",
]);

export const reviewStatusSchema = z.enum([
  "verified",
  "needs-review",
  "assumed",
  "invalid",
]);

export const geometryRefSchema = z.object({
  bodyId: z.number().int().positive(),
  faceId: z.string().min(1).optional(),
  edgeId: z.string().min(1).optional(),
}).strict();

export const measurementSchema = z.object({
  key: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(240),
  value: z.number().finite(),
  actual: z.number().finite().optional(),
  tolerance: z.number().finite().nonnegative().optional(),
  unit: z.enum(["mm", "deg", "count", "%"]),
  source: measurementSourceSchema,
  confidence: confidenceSchema,
  status: reviewStatusSchema,
  linkedEntities: z.array(geometryRefSchema).max(4096).optional(),
  input: z.object({
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    step: z.number().finite().positive().optional(),
  }).strict().refine((value) => value.min === undefined || value.max === undefined || value.min <= value.max, "Input minimum must not exceed maximum").optional(),
}).strict();

const requirementRowSchema = z.object({
  key: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(240),
  value: z.string().max(4000),
  status: reviewStatusSchema,
  linkedEntities: z.array(geometryRefSchema).max(4096).optional(),
}).strict();

const assumptionRowSchema = requirementRowSchema.extend({
  confidence: confidenceSchema,
}).strict();

const sourceRowSchema = z.object({
  key: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(240),
  url: httpUrlSchema.optional(),
  artifactHash: sha256Schema.optional(),
  confidence: confidenceSchema,
  status: reviewStatusSchema,
}).strict().refine((row) => row.url !== undefined || row.artifactHash !== undefined, {
  message: "A source needs a URL or artifact hash",
});

const validationRowSchema = z.object({
  key: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(240),
  severity: z.enum(["info", "warning", "error"]),
  status: z.enum(["pass", "fail", "unknown"]),
  message: z.string().max(4000),
  linkedEntities: z.array(geometryRefSchema).max(4096).optional(),
}).strict();

const comparisonRowSchema = z.object({
  key: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(240),
  before: z.union([z.string(), z.number().finite()]).optional(),
  after: z.union([z.string(), z.number().finite()]).optional(),
  unit: z.enum(["mm", "deg", "count", "%"]).optional(),
  status: z.enum(["added", "removed", "changed", "unchanged"]),
  linkedEntities: z.array(geometryRefSchema).max(4096).optional(),
}).strict();

export const structuredBlockInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("dimensions"),
    title: z.string().trim().min(1).max(240),
    rows: z.array(measurementSchema).max(4096),
  }).strict(),
  z.object({
    type: z.literal("requirements"),
    title: z.string().trim().min(1).max(240),
    rows: z.array(requirementRowSchema).max(4096),
  }).strict(),
  z.object({
    type: z.literal("assumptions"),
    title: z.string().trim().min(1).max(240),
    rows: z.array(assumptionRowSchema).max(4096),
  }).strict(),
  z.object({
    type: z.literal("sources"),
    title: z.string().trim().min(1).max(240),
    rows: z.array(sourceRowSchema).max(4096),
  }).strict(),
  z.object({
    type: z.literal("validation"),
    title: z.string().trim().min(1).max(240),
    rows: z.array(validationRowSchema).max(4096),
  }).strict(),
  z.object({
    type: z.literal("comparison"),
    title: z.string().trim().min(1).max(240),
    rows: z.array(comparisonRowSchema).max(4096),
  }).strict(),
]) satisfies z.ZodType<StructuredBlockInput>;

const modelBodyMappingSchema = z.object({
  bodyId: z.number().int().positive(),
  name: z.string().trim().min(1).max(240).optional(),
  meshIndex: z.number().int().nonnegative().optional(),
  faceIds: z.array(z.string().min(1)).max(100_000).optional(),
}).strict();

export const modelVersionInputSchema = z.object({
  plasticityDocumentToken: z.string().min(1),
  plasticityRevision: z.string().min(1),
  stepArtifactHash: sha256Schema,
  screenshotArtifactHashes: z.array(sha256Schema).max(32).optional(),
  measurements: z.array(measurementSchema).max(4096),
  bodyMappings: z.array(modelBodyMappingSchema).max(4096).optional(),
}).strict() satisfies z.ZodType<ModelVersionInput>;

const cameraSnapshotSchema = z.object({
  id: idSchema,
  projection: z.enum(["perspective", "orthographic"]),
  positionMm: vector3MmSchema,
  targetMm: vector3MmSchema,
  up: vector3MmSchema,
  viewMatrix: z.array(z.number().finite()).length(16),
  projectionMatrix: z.array(z.number().finite()).length(16),
  viewport: z.tuple([z.number().int().positive(), z.number().int().positive()]),
}).strict();

const annotationAnchorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("world"), pointMm: vector3MmSchema }).strict(),
  z.object({ kind: z.literal("body"), bodyId: z.number().int().positive(), pointMm: vector3MmSchema }).strict(),
  z.object({ kind: z.literal("face"), bodyId: z.number().int().positive(), faceId: z.string().min(1), pointMm: vector3MmSchema }).strict(),
  z.object({ kind: z.literal("edge"), bodyId: z.number().int().positive(), edgeId: z.string().min(1), pointMm: vector3MmSchema }).strict(),
  z.object({ kind: z.literal("screen"), cameraId: idSchema, point: z.tuple([z.number().finite(), z.number().finite()]) }).strict(),
]);

const inkPointSchema = z.object({
  point: z.tuple([z.number().finite(), z.number().finite()]),
  pressure: z.number().finite().min(0).max(1),
  tilt: z.tuple([z.number().finite().min(-90).max(90), z.number().finite().min(-90).max(90)]),
  timestampMs: z.number().finite().nonnegative(),
}).strict();

export const annotationInputSchema = z.object({
  kind: z.enum(["pen", "highlighter", "arrow", "marker", "note", "dimension"]),
  text: z.string().max(4000).optional(),
  anchor: annotationAnchorSchema,
  camera: cameraSnapshotSchema.optional(),
  stroke: z.array(inkPointSchema).min(2).max(100_000).optional(),
}).strict().superRefine((annotation, context) => {
  if ((annotation.kind === "note" || annotation.kind === "dimension") && !annotation.text?.trim()) {
    context.addIssue({ code: "custom", message: `${annotation.kind} annotations require text` });
  }
  if ((annotation.kind === "pen" || annotation.kind === "highlighter") && !annotation.stroke) {
    context.addIssue({ code: "custom", message: `${annotation.kind} annotations require a stroke` });
  }
}) satisfies z.ZodType<AnnotationInput>;

export const annotationBatchSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  modelVersionId: idSchema,
  annotations: z.array(annotationInputSchema).min(1).max(500),
}).strict() satisfies z.ZodType<AnnotationBatchInput>;

export const dimensionChangeBatchSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  blockId: idSchema,
  changes: z.array(z.object({
    key: z.string().trim().min(1).max(120),
    value: z.number().finite(),
  }).strict()).min(1).max(4096),
}).strict() satisfies z.ZodType<DimensionChangeBatchInput>;

export const referenceInputSchema = z.object({
  label: z.string().trim().min(1).max(240),
  sourceKind: z.enum([
    "official-manufacturer-cad",
    "official-documentation",
    "official-distributor-cad",
    "established-cad-library",
    "verified-community-cad",
    "functional-envelope",
    "scaled-image",
  ]),
  format: z.enum(["step", "parasolid", "iges", "drawing-pdf", "stl", "obj", "image", "other"]),
  sourceUrl: httpUrlSchema.optional(),
  artifactHash: sha256Schema.optional(),
  license: z.string().trim().min(1).max(1000).optional(),
  overallConfidence: confidenceSchema,
  dimensions: z.array(z.object({
    key: z.string().trim().min(1).max(120),
    label: z.string().trim().min(1).max(240),
    value: z.number().finite().optional(),
    unit: z.enum(["mm", "deg", "count"]),
    confidence: confidenceSchema,
    critical: z.boolean(),
    sourceLocator: z.string().trim().min(1).max(500).optional(),
    note: z.string().trim().min(1).max(2000).optional(),
  }).strict()).max(4096),
  sceneRole: z.enum(["locked-reference", "functional-envelope"]),
  bodyIds: z.array(z.number().int().positive()).max(4096).optional(),
}).strict().refine((reference) => reference.sourceUrl !== undefined || reference.artifactHash !== undefined, {
  message: "A reference needs a source URL or an attached artifact hash",
}).superRefine((reference, context) => {
  const keys = new Set<string>();
  for (const [index, dimension] of reference.dimensions.entries()) {
    if (keys.has(dimension.key)) context.addIssue({ code: "custom", message: `Duplicate dimension key: ${dimension.key}`, path: ["dimensions", index, "key"] });
    keys.add(dimension.key);
    if (dimension.confidence === "measurement-required" && dimension.value !== undefined) {
      context.addIssue({ code: "custom", message: "A dimension requiring measurement must not claim a value", path: ["dimensions", index, "value"] });
    }
  }
}) satisfies z.ZodType<ReferenceInput>;

const constructionJournalEntrySchema = z.object({
  id: idSchema,
  operation: z.string().trim().min(1).max(120),
  intent: z.string().trim().min(1).max(1000).nullable(),
  input: z.json(),
  documentToken: z.string().min(1).max(1000),
  beforeRevision: z.string().min(1).max(1000),
  afterDocumentToken: z.string().min(1).max(1000).nullable(),
  afterRevision: z.string().min(1).max(1000).nullable(),
  status: z.enum(["completed", "failed", "unknown"]),
  diff: z.json().nullable(),
  error: z.string().max(20_000).nullable(),
  occurredAt: isoTimestampSchema,
}).strict();

export const constructionJournalInputSchema = z.object({
  documentToken: z.string().min(1).max(1000),
  revision: z.string().min(1).max(1000),
  syncStatus: z.enum(["empty", "in-sync", "manual-edit-detected", "document-changed"]),
  entries: z.array(constructionJournalEntrySchema).max(100_000),
}).strict().superRefine((journal, context) => {
  const ids = new Set<string>();
  for (const [index, entry] of journal.entries.entries()) {
    if (ids.has(entry.id)) context.addIssue({ code: "custom", message: `Duplicate journal entry: ${entry.id}`, path: ["entries", index, "id"] });
    ids.add(entry.id);
    if (entry.status === "completed" && entry.afterRevision === null) {
      context.addIssue({ code: "custom", message: "Completed journal entries need an after revision", path: ["entries", index, "afterRevision"] });
    }
    if (entry.status === "completed" && entry.afterDocumentToken === null) {
      context.addIssue({ code: "custom", message: "Completed journal entries need an after document token", path: ["entries", index, "afterDocumentToken"] });
    }
  }
}) satisfies z.ZodType<ConstructionJournalInput>;

export const printerProfileSchema = z.object({
  id: z.string().trim().min(1).max(240),
  vendor: z.string().trim().min(1).max(120),
  model: z.string().trim().min(1).max(240),
  buildVolumeMm: vector3MmSchema.refine((value) => value.every((item) => item > 0), "Build volume must be positive"),
  buildOriginMm: vector3MmSchema.optional(),
  nozzleDiameterMm: z.number().finite().positive().max(5),
  nozzleMaterial: z.string().trim().min(1).max(120).optional(),
  connection: z.object({
    kind: z.enum(["moonraker", "bambu-lan", "manual"]),
    host: z.string().regex(/^(?:\d{1,3}\.){3}\d{1,3}$/).optional(),
    port: z.number().int().min(1).max(65535).optional(),
  }).strict().optional(),
  source: z.enum(["installed-slicer", "user", "verified-device"]),
}).strict();

export const materialProfileSchema = z.object({
  id: z.string().trim().min(1).max(240),
  name: z.string().trim().min(1).max(240),
  type: z.string().trim().min(1).max(80),
  vendor: z.string().trim().min(1).max(120),
  nozzleTemperatureC: z.number().finite().min(0).max(500),
  bedTemperatureC: z.number().finite().min(0).max(200),
  densityGcm3: z.number().finite().positive().max(10).optional(),
  maxVolumetricSpeedMm3s: z.number().finite().positive().max(200).optional(),
  color: z.string().trim().min(1).max(120).optional(),
  jointClearanceMm: z.number().finite().nonnegative().max(5).optional(),
  source: z.enum(["installed-slicer", "user"]),
}).strict();

export const slicerProfileSchema = z.object({
  id: z.string().trim().min(1).max(240),
  slicer: z.enum(["creality-print", "orca-slicer", "bambu-studio"]),
  name: z.string().trim().min(1).max(240),
  layerHeightMm: z.number().finite().positive().max(5),
  nominalInfillPercent: z.number().finite().min(0).max(100).optional(),
  sparseInfillPattern: z.string().trim().min(1).max(80).optional(),
  wallLoops: z.number().int().min(0).max(20).optional(),
  topShellLayers: z.number().int().min(0).max(100).optional(),
  bottomShellLayers: z.number().int().min(0).max(100).optional(),
  qualityTarget: z.enum(["draft", "standard", "fine", "strong", "custom"]).optional(),
  supportsEnabled: z.boolean().optional(),
  dimensionalScalePercent: z.number().finite().min(50).max(150).optional(),
  holeCompensationMm: z.number().finite().min(-5).max(5).optional(),
  machineConfigPath: z.string().min(1),
  processConfigPath: z.string().min(1),
  filamentConfigPath: z.string().min(1),
  source: z.enum(["installed-slicer", "user"]),
}).strict();

export const manufacturingProfileSchema = z.object({
  printer: printerProfileSchema,
  material: materialProfileSchema,
  slicer: slicerProfileSchema,
  functionalIntent: z.enum(["prototype", "visual", "functional", "load-bearing", "heat-resistant"]).optional(),
  expectedLoadN: z.number().finite().nonnegative().max(1_000_000).optional(),
}).strict() satisfies z.ZodType<ManufacturingProfile>;

const manufacturingProfileRegistrationMetadataSchema = {
  verification: z.enum(["official", "imported", "user-verified", "draft"]),
  sourceUrl: httpUrlSchema.optional(),
  notes: z.string().trim().min(1).max(4000).optional(),
};

export const manufacturingProfileRegistrationSchema = z.union([
  z.object({ profile: manufacturingProfileSchema, ...manufacturingProfileRegistrationMetadataSchema }).strict(),
  z.object({
    discoveredProfile: z.object({ printerId: z.string().trim().min(1), materialId: z.string().trim().min(1), slicerId: z.string().trim().min(1) }).strict(),
    ...manufacturingProfileRegistrationMetadataSchema,
  }).strict(),
]) satisfies z.ZodType<ManufacturingProfileRegistrationRequest>;

export const dfmInputSchema = z.object({
  sizeMm: vector3MmSchema.refine((value) => value.every((item) => item > 0), "Part size must be positive"),
  minimumWallMm: z.number().finite().positive().optional(),
  minimumHoleDiameterMm: z.number().finite().positive().optional(),
  maximumOverhangDeg: z.number().finite().min(0).max(90).optional(),
  split: z.object({
    bedMarginMm: z.number().finite().nonnegative().max(100).optional(),
    joint: z.enum(["flat", "alignment-pins", "tongue-and-groove", "dovetail", "screws-and-inserts"]).optional(),
    clearanceMm: z.number().finite().nonnegative().max(10).optional(),
    protectedZones: z.array(z.object({
      id: z.string().trim().min(1).max(120),
      sourceId: z.string().trim().min(1).max(240),
      basis: z.enum(["strength-report", "user-marked"]),
      axis: z.enum(["x", "y", "z"]),
      minMm: z.number().finite().nonnegative(),
      maxMm: z.number().finite().positive(),
    }).strict().refine((zone) => zone.minMm < zone.maxMm, { message: "Protected zone maxMm must exceed minMm" })).max(128).optional(),
    cutOffsetsMm: z.array(z.object({
      axis: z.enum(["x", "y", "z"]),
      offsetsMm: z.array(z.number().finite().positive()).max(128),
    }).strict()).max(3).optional(),
  }).strict().optional(),
}).strict().superRefine((input, context) => {
  const zones = input.split?.protectedZones ?? [];
  for (let index = 0; index < zones.length; index += 1) {
    if (zones.slice(0, index).some((zone) => zone.id === zones[index]!.id)) {
      context.addIssue({ code: "custom", path: ["split", "protectedZones", index, "id"], message: "Protected zone IDs must be unique" });
    }
  }
  const cuts = input.split?.cutOffsetsMm ?? [];
  for (let index = 0; index < cuts.length; index += 1) {
    if (cuts.slice(0, index).some((cut) => cut.axis === cuts[index]!.axis)) {
      context.addIssue({ code: "custom", path: ["split", "cutOffsetsMm", index, "axis"], message: "Explicit cut offsets may appear once per axis" });
    }
  }
}) satisfies z.ZodType<DfmInput>;

export const manufacturingAssessmentRequestSchema = z.object({
  dfm: dfmInputSchema,
  profile: manufacturingProfileSchema.optional(),
  profileHash: sha256Schema.optional(),
}).strict().refine((request) => (request.profile === undefined) !== (request.profileHash === undefined), {
  path: ["profileHash"], message: "Supply exactly one immutable profileHash or inline registered profile",
}) satisfies z.ZodType<ManufacturingAssessmentRequest>;

export const sliceJobRequestSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  sourceArtifactHash: sha256Schema,
  profile: manufacturingProfileSchema.optional(),
  profileHash: sha256Schema.optional(),
  dfm: dfmInputSchema,
}).strict().refine((request) => (request.profile === undefined) !== (request.profileHash === undefined), {
  path: ["profileHash"], message: "Supply exactly one immutable profileHash or inline registered profile",
}) satisfies z.ZodType<SliceJobRequest>;

export const slicePartsBatchRequestSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  profile: manufacturingProfileSchema.optional(),
  profileHash: sha256Schema.optional(),
  parts: z.array(z.object({
    label: z.string().trim().min(1).max(100),
    sourceArtifactHash: sha256Schema,
    dfm: dfmInputSchema,
  }).strict()).min(2).max(32),
}).strict().superRefine((request, context) => {
  if ((request.profile === undefined) === (request.profileHash === undefined)) {
    context.addIssue({ code: "custom", path: ["profileHash"], message: "Supply exactly one immutable profileHash or inline registered profile" });
  }
  const labels = new Set<string>();
  request.parts.forEach((part, index) => {
    if (labels.has(part.label)) {
      context.addIssue({ code: "custom", path: ["parts", index, "label"], message: "Part labels must be unique" });
    }
    labels.add(part.label);
  });
}) satisfies z.ZodType<SlicePartsBatchRequest>;

export const sliceInterfaceLayerHeightsRequestSchema = z.object({
  interfaceLayerIndices: z.array(z.number().int().positive()).min(1).max(32),
}).strict().superRefine((request, context) => {
  if (request.interfaceLayerIndices.some((index, position) => position > 0 && request.interfaceLayerIndices[position - 1]! >= index)) {
    context.addIssue({ code: "custom", path: ["interfaceLayerIndices"], message: "Interface layer indices must be strictly increasing and unique" });
  }
});

export const sliceLayerPathOrientationsRequestSchema = z.object({
  layerIndices: z.array(z.number().int().positive()).min(1).max(32),
}).strict().superRefine((request, context) => {
  if (request.layerIndices.some((index, position) => position > 0 && request.layerIndices[position - 1]! >= index)) {
    context.addIssue({ code: "custom", path: ["layerIndices"], message: "Layer indices must be strictly increasing and unique" });
  }
});
