import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { z } from "zod";

import { discoverPlasticityTargets } from "./cdp/discovery.ts";
import { diffScenes, type SceneDiff, type TrackedDatum } from "./plasticity/change-tracker.ts";
import { ConstructionHistoryStore, type ConstructionHistoryEntry } from "./plasticity/construction-history.ts";
import { StepImportReferenceStore } from "./plasticity/import-reference-store.ts";
import { StepReferenceDownloader, type StepReferenceDownloaderLike } from "./plasticity/step-reference-downloader.ts";
import { PlasticityOperations } from "./plasticity/operations.ts";
import { boundsCenter, quaternionFromXyzDegrees, rotateBoundsAroundPivot, unionBounds } from "./plasticity/print-orientation.ts";
import { PlasticityRecipes } from "./plasticity/recipes.ts";
import { SplitSolidByPlaneRecipe } from "./plasticity/split-solid.ts";
import { SplitSolidByPlanesRecipe } from "./plasticity/split-solid-by-planes.ts";
import { SplitSolidToVolumeRecipe } from "./plasticity/split-solid-to-volume.ts";
import { PrintedThreadRecipes } from "./plasticity/printed-thread-recipes.ts";
import { acquireWindowOwnership, type WindowOwnership } from "./plasticity/ownership.ts";
import { connectSessionWindow, type SessionConnection } from "./plasticity/session-lifecycle.ts";
import { LONG_NATIVE_IMPORT_TIMEOUT_MS, NATIVE_STATE_READ_TIMEOUT_MS, PlasticityRuntime, type RuntimeState } from "./plasticity/runtime.ts";
import { findEdges, findFaces, type EdgeQuery, type FaceQuery } from "./plasticity/semantic.ts";
import { fastenerDesignationInputSchema, resolveFastenerDesignation } from "./fasteners/designation.ts";
import { checkFastenerStack, fastenerStackInputSchema } from "./fasteners/stack.ts";
import type { AnalysisClient } from "./codex/analysis-client.ts";
import type { ReferenceSearchClient } from "./codex/reference-search-client.ts";
import type { CadBinding } from "./strength/contracts.ts";
import { registerStrengthTools, type StrengthDependencies } from "./strength/mcp.ts";
import { StrengthStore } from "./strength/store.ts";
import { FemReportStore } from "./strength/fem/fem-report-store.ts";
import { CohesiveReportStore } from "./strength/fem/cohesive-report-store.ts";
import { analyzeStaticSolid } from "./strength/fem/analyze-static.ts";
import { analyzeCohesiveInterface, type CohesiveAnalysisRequest } from "./strength/fem/cohesive-analysis.ts";
import {
  PrintedThreadQualificationStore,
  printedThreadProcessIdentitySchema,
  printedThreadQualificationFilterSchema,
  printedThreadQualificationInputSchema,
  printedThreadQualificationMatchSchema,
} from "./printing/thread-qualification.ts";
import { PLASTICITY_MCP_INSTRUCTIONS } from "./server-instructions.ts";
import { exposeDirectTool, type ToolCatalogMode } from "./tool-catalog.ts";

const vector = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const vector2 = z.tuple([z.number().finite(), z.number().finite()]);
const positiveVector = vector.refine((values) => values.every((value) => value > 0), "All values must be positive");

function compactStatusSummary(state: RuntimeState, bodyOffset: number, bodyLimit: number) {
  const totalBodies = state.bodies.length;
  const bodies = state.bodies.slice(bodyOffset, bodyOffset + bodyLimit);
  return {
    ...state,
    bodies: bodies.map((body) => {
      const summary: Partial<RuntimeState["bodies"][number]> = { ...body };
      delete summary.faceIds;
      delete summary.edgeIds;
      delete summary.faces;
      delete summary.edges;
      delete summary.vertices;
      return {
        ...summary,
        faceCount: body.faces.length,
        edgeCount: body.edges.length,
        vertexCount: body.vertices?.length ?? null,
      };
    }),
    bodyPagination: {
      offset: bodyOffset,
      limit: bodyLimit,
      total: totalBodies,
      nextOffset: bodyOffset + bodies.length < totalBodies ? bodyOffset + bodies.length : null,
    },
  };
}

function isRuntimeState(value: unknown): value is RuntimeState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.targetId === "string"
    && typeof candidate.title === "string"
    && typeof candidate.documentToken === "string"
    && typeof candidate.revision === "string"
    && Array.isArray(candidate.bodies)
    && candidate.bodies.every((body) => typeof body === "object" && body !== null
      && Array.isArray((body as Record<string, unknown>).faces)
      && Array.isArray((body as Record<string, unknown>).edges));
}

function compactChangedBody(body: RuntimeState["bodies"][number]) {
  return {
    id: body.id,
    versionId: body.versionId,
    type: body.type,
    name: body.name,
    boundsMm: body.boundsMm,
    faceCount: body.faces.length,
    edgeCount: body.edges.length,
    vertexCount: body.vertices?.length ?? null,
  };
}

function compactMutationResult<T>(value: RuntimeState, change: SceneDiff): T {
  return {
    ...compactStatusSummary(value, 0, 20),
    change: {
      sceneChanged: change.sceneChanged,
      revisionChanged: change.revisionChanged,
      changed: change.changed,
      documentChanged: change.documentChanged,
      added: change.added.map(compactChangedBody),
      removed: change.removed.map(compactChangedBody),
      modified: change.modified.map((item) => ({
        id: item.id,
        renamed: item.renamed,
        geometryChanged: item.geometryChanged,
        appearanceChanged: item.appearanceChanged,
        visibilityChanged: item.visibilityChanged,
        before: compactChangedBody(item.before),
        after: compactChangedBody(item.after),
      })),
      regionsAdded: change.regionsAdded.map(({ id, displayBoundsMm }) => ({ id, displayBoundsMm })),
      regionsRemoved: change.regionsRemoved.map(({ id, displayBoundsMm }) => ({ id, displayBoundsMm })),
      regionsModified: change.regionsModified.map(({ id, before, after }) => ({
        id,
        before: { displayBoundsMm: before.displayBoundsMm },
        after: { displayBoundsMm: after.displayBoundsMm },
      })),
      constructionPlanesAdded: change.constructionPlanesAdded.map((plane) => ({ nativeId: plane.nativeId, name: plane.name })),
      constructionPlanesRemoved: change.constructionPlanesRemoved.map((plane) => ({ nativeId: plane.nativeId, name: plane.name })),
      constructionPlanesModified: change.constructionPlanesModified.map(({ nativeId, before, after }) => ({
        nativeId,
        before: { name: before.name },
        after: { name: after.name },
      })),
      activeWorkplaneChanged: change.activeWorkplaneChanged,
      materialsChanged: change.materialsChanged,
      measurementsChanged: change.measurementsChanged,
      sectionAnalysesChanged: change.sectionAnalysesChanged,
      instancesChanged: change.instancesChanged,
      referenceMeshesChanged: change.referenceMeshesChanged,
      groupsChanged: change.groupsChanged,
    },
  } as T;
}

type SceneChangeResult = {
  snapshotId: string;
  label: string | null;
  capturedAt: string;
  diff: SceneDiff;
  selection: unknown;
  current: RuntimeState;
  timedOut?: boolean;
};

type SceneSnapshotResult = {
  snapshotId: string;
  label: string | null;
  capturedAt: string;
  state: RuntimeState;
  datums: TrackedDatum[];
};

function isSceneSnapshotResult(value: unknown): value is SceneSnapshotResult {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const state = candidate.state;
  if (typeof state !== "object" || state === null) return false;
  const stateRecord = state as Record<string, unknown>;
  return typeof candidate.snapshotId === "string"
    && typeof candidate.capturedAt === "string"
    && Array.isArray(candidate.datums)
    && typeof stateRecord.documentToken === "string"
    && typeof stateRecord.revision === "string"
    && Array.isArray(stateRecord.bodies);
}

function compactSceneSnapshot(rawSnapshot: unknown) {
  if (!isSceneSnapshotResult(rawSnapshot)) throw new Error("Plasticity returned an invalid scene snapshot");
  const { snapshotId, label, capturedAt, state, datums } = rawSnapshot;
  return {
    snapshotId,
    label,
    capturedAt,
    documentToken: state.documentToken,
    revision: state.revision,
    targetId: state.targetId,
    title: state.title,
    bodyCount: state.bodies.length,
    regionCount: state.regions.length,
    constructionPlaneCount: state.construction.planes.length,
    trackedDatumCount: datums.length,
  };
}

function isSceneChangeResult(value: unknown): value is SceneChangeResult {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const diff = candidate.diff;
  const current = candidate.current;
  if (typeof diff !== "object" || diff === null || typeof current !== "object" || current === null) return false;
  const diffRecord = diff as Record<string, unknown>;
  const currentRecord = current as Record<string, unknown>;
  return typeof candidate.snapshotId === "string"
    && typeof candidate.capturedAt === "string"
    && Array.isArray(diffRecord.added)
    && Array.isArray(diffRecord.removed)
    && Array.isArray(diffRecord.modified)
    && typeof currentRecord.documentToken === "string"
    && typeof currentRecord.revision === "string"
    && Array.isArray(currentRecord.bodies);
}

function compactSceneChanges(
  rawResult: unknown,
  bodyOffset: number,
  bodyLimit: number,
  expectedRevision?: string,
) {
  if (!isSceneChangeResult(rawResult)) throw new Error("Plasticity returned an invalid scene change response");
  const result = rawResult;
  if (expectedRevision !== undefined && expectedRevision !== result.current.revision) {
    throw new Error("CAD revision changed between scene-change pages; restart pagination from bodyOffset 0");
  }
  const allBodyChanges = [
    ...result.diff.added.map((body) => ({ kind: "added" as const, body })),
    ...result.diff.removed.map((body) => ({ kind: "removed" as const, body })),
    ...result.diff.modified.map((change) => ({ kind: "modified" as const, change })),
  ];
  const page = allBodyChanges.slice(bodyOffset, bodyOffset + bodyLimit);
  const current = result.current;
  const { timedOut, ...metadata } = result;
  return {
    ...metadata,
    ...(timedOut === undefined ? {} : { timedOut }),
    current: {
      targetId: current.targetId,
      title: current.title,
      documentToken: current.documentToken,
      revision: current.revision,
      dbVersion: current.dbVersion,
      undoDepth: current.undoDepth,
      redoDepth: current.redoDepth,
      bodyCount: current.bodies.length,
      regionCount: current.regions.length,
    },
    diff: {
      ...result.diff,
      added: page.filter((item) => item.kind === "added").map((item) => compactChangedBody(item.body)),
      removed: page.filter((item) => item.kind === "removed").map((item) => compactChangedBody(item.body)),
      modified: page.filter((item) => item.kind === "modified").map(({ change }) => ({
        id: change.id,
        renamed: change.renamed,
        geometryChanged: change.geometryChanged,
        appearanceChanged: change.appearanceChanged,
        visibilityChanged: change.visibilityChanged,
        before: compactChangedBody(change.before),
        after: compactChangedBody(change.after),
      })),
    },
    bodyPagination: {
      offset: bodyOffset,
      limit: bodyLimit,
      total: allBodyChanges.length,
      nextOffset: bodyOffset + page.length < allBodyChanges.length ? bodyOffset + page.length : null,
    },
  };
}

const importedReferenceSourceSchema = z.object({
  sourceKind: z.enum(["official-manufacturer-cad", "official-documentation", "official-distributor-cad", "established-cad-library", "verified-community-cad"]),
  sourceUrl: z.string().url().max(4_096).refine((value) => value.startsWith("https://"), "Reference source URL must use HTTPS"),
  sourcePageUrl: z.string().url().max(4_096).refine((value) => value.startsWith("https://"), "Reference source-page URL must use HTTPS").optional(),
  license: z.string().trim().min(1).max(1_000).optional(),
  confidence: z.enum(["verified", "probable", "approximate", "assumed", "measurement-required"]),
}).strict();
const direction = vector.refine((values) => values.some((value) => value !== 0), "Direction must be nonzero");
const ids = z.array(z.number().int().positive()).min(1).max(4096);
const uniqueBodyIds = ids.refine(
  (values) => new Set(values).size === values.length,
  "Body IDs must be unique",
);
const curveIds = z.array(z.number().int().positive()).min(1).max(64).refine(
  (values) => new Set(values).size === values.length,
  "Wire IDs must be unique",
);
const instanceIds = z.array(z.number().int().nonnegative()).min(1).max(4096).refine(
  (values) => new Set(values).size === values.length,
  "Instance IDs must be unique",
);
const referenceMeshIds = z.array(z.number().int().nonnegative()).min(1).max(4096).refine(
  (values) => new Set(values).size === values.length,
  "Reference mesh IDs must be unique",
);
const optionalBodyIds = z.array(z.number().int().positive()).max(4096).refine(
  (values) => new Set(values).size === values.length,
  "Body IDs must be unique",
).default([]);
const optionalInstanceIds = z.array(z.number().int().nonnegative()).max(4096).refine(
  (values) => new Set(values).size === values.length,
  "Instance IDs must be unique",
).default([]);
const optionalReferenceMeshIds = z.array(z.number().int().nonnegative()).max(4096).refine(
  (values) => new Set(values).size === values.length,
  "Reference mesh IDs must be unique",
).default([]);
const optionalGroupIds = z.array(z.number().int().nonnegative()).max(4096).refine(
  (values) => new Set(values).size === values.length,
  "Group IDs must be unique",
).default([]);
const regionIds = z.array(z.string().trim().min(1)).min(1).max(4096);
const fragmentIds = z.array(z.string().trim().min(1)).min(1).max(4096);
const endpointIds = z.array(z.string().trim().min(1)).min(1).max(4096);
const nonzeroDistance = z.number().finite().refine((value) => value !== 0, "Distance must be nonzero");
const regionOffsets = z.array(nonzeroDistance).min(1).max(2).refine(
  (values) => new Set(values).size === values.length,
  "Region offset distances must be unique",
);
const faceRef = z.object({ bodyId: z.number().int().positive(), faceId: z.string().min(1) }).strict();
const edgeRef = z.object({ bodyId: z.number().int().positive(), edgeId: z.string().min(1) }).strict();
const circularEdgeMeasurementRef = z.union([
  edgeRef,
  z.object({ bodyId: z.number().int().positive(), segmentEntityId: z.number().int().nonnegative() }).strict(),
]);
const curvatureWireSegmentRef = z.object({ bodyId: z.number().int().positive(), segmentEntityId: z.number().int().positive() }).strict();
const sampledCurveEdgeRef = z.union([edgeRef, curvatureWireSegmentRef]);
const measurementVertexRef = z.object({ bodyId: z.number().int().positive(), vertexId: z.number().int().nonnegative() }).strict();
const surfaceFaceRefs = z.array(faceRef).min(1).max(4096).refine(
  (values) => new Set(values.map((value) => `${value.bodyId}:${value.faceId}`)).size === values.length,
  "Face references must be unique",
);
const curveControlPointRef = z.discriminatedUnion("kind", [
  z.object({ bodyId: z.number().int().positive(), kind: z.literal("vertex"), pointId: z.number().int().nonnegative() }).strict(),
  z.object({ bodyId: z.number().int().positive(), kind: z.literal("control-point"), pointId: z.number().int().positive() }).strict(),
]);
const curveControlPointRefs = z.array(curveControlPointRef).min(1).max(4096).refine(
  (values) => new Set(values.map((value) => `${value.bodyId}:${value.kind}:${value.pointId}`)).size === values.length,
  "Curve control point references must be unique",
);
const interiorCurveControlPointRefs = z.array(
  z.object({ bodyId: z.number().int().positive(), kind: z.literal("control-point"), pointId: z.number().int().positive() }).strict(),
).min(1).max(4096).refine(
  (values) => new Set(values.map((value) => `${value.bodyId}:${value.pointId}`)).size === values.length,
  "Interior curve control point references must be unique",
).refine(
  (values) => new Set(values.map((value) => value.bodyId)).size === 1,
  "Deleted curve control points must belong to one Wire",
);
const fastenerGripLayer = z.object({ id: z.string().trim().min(1).max(120), first: faceRef, second: faceRef }).strict().refine(
  (layer) => layer.first.bodyId === layer.second.bodyId,
  "Each fastener grip layer must use two faces from the same body",
).refine(
  (layer) => layer.first.faceId !== layer.second.faceId,
  "Each fastener grip layer requires two different faces",
);
const revision = z.string().min(1);
const intent = z.string().trim().min(1).max(1000).optional();
const surfaceContinuityInputSchema = z.object({
  edges: z.array(edgeRef).min(1).max(4096).refine(
    (values) => new Set(values.map((value) => `${value.bodyId}:${value.edgeId}`)).size === values.length,
    "Edge references must be unique",
  ),
  positionToleranceMm: z.number().finite().positive().default(0.01),
  normalAngleToleranceDeg: z.number().finite().positive().max(180).default(0.1),
  relativeCurvatureTolerance: z.number().finite().positive().default(0.05),
  revision,
}).strict();
const edgeCurvatureInputSchema = z.object({
  edges: z.array(z.union([edgeRef, curvatureWireSegmentRef])).min(1).max(4096).refine(
    (values) => new Set(values.map((value) => "edgeId" in value ? `${value.bodyId}:shell:${value.edgeId}` : `${value.bodyId}:wire:${value.segmentEntityId}`)).size === values.length,
    "Edge references must be unique",
  ),
  revision,
}).strict();
const faceDraftInputSchema = z.object({
  faces: surfaceFaceRefs.max(256),
  pullDirection: direction,
  minimumDraftDeg: z.number().finite().positive().lt(90).default(2),
  samplesPerDirection: z.number().int().min(3).max(32).default(8),
  revision,
}).strict();
const bodyInterferencePair = z.object({
  firstBodyId: z.number().int().positive(),
  secondBodyId: z.number().int().positive(),
}).strict().refine((pair) => pair.firstBodyId !== pair.secondBodyId, "An interference pair must contain two different bodies");
const bodyInterferenceInputSchema = z.object({
  pairs: z.array(bodyInterferencePair).min(1).max(256),
  revision,
}).strict().superRefine((input, context) => {
  const keys = input.pairs.map((pair) => [pair.firstBodyId, pair.secondBodyId].sort((left, right) => left - right).join(":"));
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: "custom", path: ["pairs"], message: "Unordered body pairs must be unique" });
  }
});
const solidPropertiesInputSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(256).refine(
    (values) => new Set(values).size === values.length,
    "Solid body IDs must be unique",
  ),
  revision,
}).strict();
const facePropertiesInputSchema = z.object({
  faces: surfaceFaceRefs.max(256),
  revision,
}).strict();
const cylindricalAlignmentInputSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(4096).refine((values) => new Set(values).size === values.length, "Moving body IDs must be unique"),
  sourceFace: faceRef,
  targetFace: faceRef,
  relation: z.enum(["opposed", "same"]).default("same"),
  axialMode: z.enum(["preserve", "anchor"]).default("preserve"),
  axialOffsetMm: z.number().finite().default(0),
  rotationAroundAxisDeg: z.number().finite().default(0),
  intent,
  revision,
}).strict().superRefine((input, context) => {
  if (input.axialMode === "preserve" && input.axialOffsetMm !== 0) {
    context.addIssue({ code: "custom", path: ["axialOffsetMm"], message: "Axial offset is available only in anchor mode" });
  }
});
const vertexAlignmentInputSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(4096).refine((values) => new Set(values).size === values.length, "Moving body IDs must be unique"),
  sourceVertex: measurementVertexRef,
  targetVertex: measurementVertexRef,
  offsetMm: vector.default([0, 0, 0]),
  intent,
  revision,
}).strict();
const linearEdgeAlignmentInputSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(4096).refine((values) => new Set(values).size === values.length, "Moving body IDs must be unique"),
  sourceEdge: edgeRef,
  targetEdge: edgeRef,
  relation: z.enum(["opposed", "same"]).default("same"),
  axialOffsetMm: z.number().finite().default(0),
  rotationAroundAxisDeg: z.number().finite().default(0),
  intent,
  revision,
}).strict();
const measurementPointRef = z.discriminatedUnion("type", [
  z.object({ type: z.literal("coordinates"), pointMm: vector }).strict(),
  z.object({ type: z.literal("vertex"), bodyId: z.number().int().positive(), vertexId: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal("edge-midpoint"), bodyId: z.number().int().positive(), edgeId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("face-center"), bodyId: z.number().int().positive(), faceId: z.string().min(1) }).strict(),
]);
const topologyMeasurementPointRef = z.discriminatedUnion("type", [
  z.object({ type: z.literal("vertex"), bodyId: z.number().int().positive(), vertexId: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal("edge-midpoint"), bodyId: z.number().int().positive(), edgeId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("face-center"), bodyId: z.number().int().positive(), faceId: z.string().min(1) }).strict(),
]);
const groupSelectionFields = {
  bodyIds: optionalBodyIds,
  instanceIds: optionalInstanceIds,
  referenceMeshIds: optionalReferenceMeshIds,
  groupIds: optionalGroupIds,
};
const requireNodeSelection = (input: { bodyIds: number[]; instanceIds: number[]; referenceMeshIds: number[]; groupIds: number[] }, context: z.RefinementCtx) => {
  if (input.bodyIds.length + input.instanceIds.length + input.referenceMeshIds.length + input.groupIds.length === 0) {
    context.addIssue({ code: "custom", message: "At least one body, instance, reference mesh, or group ID is required" });
  }
};
const appearanceMaterialInputSchema = z.object({
  ids,
  materialId: z.number().int().nonnegative().optional(),
  name: z.string().trim().min(1).max(120).optional(),
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  roughness: z.number().finite().min(0).max(1).optional(),
  metalness: z.number().finite().min(0).max(1).optional(),
  opacity: z.number().finite().min(0).max(1).optional(),
  intent,
  revision,
}).strict().superRefine((input, context) => {
  const appearanceFields = [input.name, input.colorHex, input.roughness, input.metalness, input.opacity];
  if (input.materialId !== undefined && appearanceFields.some((value) => value !== undefined)) {
    context.addIssue({ code: "custom", path: ["materialId"], message: "Use an existing materialId or define a new appearance, not both" });
  }
  if (input.materialId === undefined && (input.name === undefined || input.colorHex === undefined)) {
    context.addIssue({ code: "custom", path: ["name"], message: "A new appearance requires both name and colorHex" });
  }
});
const fastenerGroupInspectionInputSchema = z.object({
  bodyId: z.number().int().positive(),
  cylindricalFaceIds: z.array(z.string().trim().min(1)).min(2).max(256).refine(
    (values) => new Set(values).size === values.length,
    "Cylindrical face IDs must be unique",
  ),
  frame: z.object({ originMm: vector, normal: direction, xDirection: direction }).strict(),
  revision,
}).strict();
const fastenerGroupLayoutEnvelopeSchema = z.object({
  id: z.string().trim().min(1).max(120),
  diameterMm: z.number().finite().positive(),
  minimumBoundaryClearanceMm: z.number().finite().nonnegative().default(0),
  minimumMutualClearanceMm: z.number().finite().nonnegative().default(0),
}).strict();
const fastenerGroupLayoutRequirementsSchema = z.object({
  basis: z.string().trim().min(1).max(1000),
  minimumCenterToEdgeMm: z.number().finite().nonnegative().optional(),
  minimumHoleEdgeClearanceMm: z.number().finite().nonnegative().optional(),
  minimumCenterSpacingMm: z.number().finite().nonnegative().optional(),
  minimumHoleLigamentMm: z.number().finite().nonnegative().optional(),
  envelopes: z.array(fastenerGroupLayoutEnvelopeSchema).max(16).refine(
    (values) => new Set(values.map((value) => value.id)).size === values.length,
    "Envelope IDs must be unique",
  ).optional(),
}).strict().superRefine((input, context) => {
  if (input.minimumCenterToEdgeMm === undefined
      && input.minimumHoleEdgeClearanceMm === undefined
      && input.minimumCenterSpacingMm === undefined
      && input.minimumHoleLigamentMm === undefined
      && (input.envelopes?.length ?? 0) === 0) {
    context.addIssue({ code: "custom", message: "At least one layout requirement or envelope is required" });
  }
});
const fastenerGroupLayoutInputSchema = z.object({
  bodyId: z.number().int().positive(),
  boundaryFaceId: z.string().trim().min(1),
  opposedFaceId: z.string().trim().min(1).optional(),
  cylindricalFaceIds: z.array(z.string().trim().min(1)).min(2).max(256).refine(
    (values) => new Set(values).size === values.length,
    "Cylindrical face IDs must be unique",
  ),
  frame: z.object({ originMm: vector, normal: direction, xDirection: direction }).strict(),
  requirements: fastenerGroupLayoutRequirementsSchema.optional(),
  revision,
}).strict();
const counterboreInputSchema = z.object({
  targetId: z.number().int().positive(),
  entryCenterMm: vector,
  axis: direction,
  throughDiameterMm: z.number().finite().positive(),
  counterboreDiameterMm: z.number().finite().positive(),
  counterboreDepthMm: z.number().finite().positive(),
  throughDepthMm: z.number().finite().positive(),
  overshootMm: z.number().finite().nonnegative().default(0.5),
  intent,
  revision,
}).strict().superRefine((input, context) => {
  if (input.counterboreDiameterMm <= input.throughDiameterMm) {
    context.addIssue({ code: "custom", path: ["counterboreDiameterMm"], message: "Counterbore diameter must exceed through diameter" });
  }
  if (input.counterboreDepthMm >= input.throughDepthMm) {
    context.addIssue({ code: "custom", path: ["counterboreDepthMm"], message: "Counterbore depth must be less than through depth" });
  }
});
const counterborePatternInputSchema = z.object({
  targetId: z.number().int().positive(),
  entryCentersMm: z.array(vector).min(2).max(128),
  axis: direction,
  throughDiameterMm: z.number().finite().positive(),
  counterboreDiameterMm: z.number().finite().positive(),
  counterboreDepthMm: z.number().finite().positive(),
  throughDepthMm: z.number().finite().positive(),
  overshootMm: z.number().finite().nonnegative().default(0.5),
  intent,
  revision,
}).strict().superRefine((input, context) => {
  if (input.counterboreDiameterMm <= input.throughDiameterMm) {
    context.addIssue({ code: "custom", path: ["counterboreDiameterMm"], message: "Counterbore diameter must exceed through diameter" });
  }
  if (input.counterboreDepthMm >= input.throughDepthMm) {
    context.addIssue({ code: "custom", path: ["counterboreDepthMm"], message: "Counterbore depth must be less than through depth" });
  }
  for (let first = 0; first < input.entryCentersMm.length; first += 1) {
    for (let second = first + 1; second < input.entryCentersMm.length; second += 1) {
      const distance = Math.hypot(...input.entryCentersMm[first]!.map((value, index) => value - input.entryCentersMm[second]![index]!));
      if (distance <= 1e-9) {
        context.addIssue({ code: "custom", path: ["entryCentersMm", second], message: `Entry center duplicates index ${first}` });
      }
    }
  }
});
const throughHoleInputSchema = z.object({
  targetId: z.number().int().positive(),
  entryCenterMm: vector,
  axis: direction,
  holeDiameterMm: z.number().finite().positive(),
  throughDepthMm: z.number().finite().positive(),
  overshootMm: z.number().finite().nonnegative().default(0.5),
  intent,
  revision,
}).strict();
const throughHolePatternInputSchema = z.object({
  targetId: z.number().int().positive(),
  entryCentersMm: z.array(vector).min(2).max(256),
  axis: direction,
  holeDiameterMm: z.number().finite().positive(),
  throughDepthMm: z.number().finite().positive(),
  overshootMm: z.number().finite().nonnegative().default(0.5),
  intent,
  revision,
}).strict().superRefine((input, context) => {
  for (let first = 0; first < input.entryCentersMm.length; first += 1) {
    for (let second = first + 1; second < input.entryCentersMm.length; second += 1) {
      const distance = Math.hypot(...input.entryCentersMm[first]!.map((value, index) => value - input.entryCentersMm[second]![index]!));
      if (distance <= 1e-9) {
        context.addIssue({ code: "custom", path: ["entryCentersMm", second], message: `Entry center duplicates index ${first}` });
      }
    }
  }
});
const blindHoleInputSchema = z.object({
  targetId: z.number().int().positive(),
  entryCenterMm: vector,
  axis: direction,
  holeDiameterMm: z.number().finite().positive(),
  holeDepthMm: z.number().finite().positive(),
  materialDepthMm: z.number().finite().positive(),
  overshootMm: z.number().finite().nonnegative().default(0.5),
  intent,
  revision,
}).strict().superRefine((input, context) => {
  if (input.holeDepthMm >= input.materialDepthMm) {
    context.addIssue({ code: "custom", path: ["holeDepthMm"], message: "Blind-hole depth must be less than material depth" });
  }
});
const blindHolePatternInputSchema = z.object({
  targetId: z.number().int().positive(),
  entryCentersMm: z.array(vector).min(2).max(256),
  axis: direction,
  holeDiameterMm: z.number().finite().positive(),
  holeDepthMm: z.number().finite().positive(),
  materialDepthMm: z.number().finite().positive(),
  overshootMm: z.number().finite().nonnegative().default(0.5),
  intent,
  revision,
}).strict().superRefine((input, context) => {
  if (input.holeDepthMm >= input.materialDepthMm) {
    context.addIssue({ code: "custom", path: ["holeDepthMm"], message: "Blind-hole depth must be less than material depth" });
  }
  for (let first = 0; first < input.entryCentersMm.length; first += 1) {
    for (let second = first + 1; second < input.entryCentersMm.length; second += 1) {
      const distance = Math.hypot(...input.entryCentersMm[first]!.map((value, index) => value - input.entryCentersMm[second]![index]!));
      if (distance <= 1e-9) {
        context.addIssue({ code: "custom", path: ["entryCentersMm", second], message: `Entry center duplicates index ${first}` });
      }
    }
  }
});
const countersinkInputSchema = z.object({
  targetId: z.number().int().positive(),
  entryCenterMm: vector,
  axis: direction,
  radialDirection: direction,
  throughDiameterMm: z.number().finite().positive(),
  countersinkMajorDiameterMm: z.number().finite().positive(),
  includedAngleDeg: z.number().finite().gt(0).lt(180),
  throughDepthMm: z.number().finite().positive(),
  overshootMm: z.number().finite().nonnegative().default(0.5),
  intent,
  revision,
}).strict().superRefine((input, context) => {
  if (input.countersinkMajorDiameterMm <= input.throughDiameterMm) {
    context.addIssue({ code: "custom", path: ["countersinkMajorDiameterMm"], message: "Countersink major diameter must exceed through diameter" });
  } else {
    const depth = (input.countersinkMajorDiameterMm - input.throughDiameterMm)
      / (2 * Math.tan(input.includedAngleDeg * Math.PI / 360));
    if (!(depth < input.throughDepthMm)) {
      context.addIssue({ code: "custom", path: ["throughDepthMm"], message: "Derived countersink depth must be less than through depth" });
    }
  }
  const dot = input.axis.reduce((sum, value, index) => sum + value * input.radialDirection[index]!, 0);
  const magnitude = Math.hypot(...input.axis) * Math.hypot(...input.radialDirection);
  if (Math.abs(dot) > magnitude * 1e-6) {
    context.addIssue({ code: "custom", path: ["radialDirection"], message: "Radial direction must be perpendicular to axis" });
  }
});
const countersinkPatternInputSchema = z.object({
  targetId: z.number().int().positive(),
  entryCentersMm: z.array(vector).min(2).max(64),
  axis: direction,
  radialDirection: direction,
  throughDiameterMm: z.number().finite().positive(),
  countersinkMajorDiameterMm: z.number().finite().positive(),
  includedAngleDeg: z.number().finite().gt(0).lt(180),
  throughDepthMm: z.number().finite().positive(),
  overshootMm: z.number().finite().nonnegative().default(0.5),
  intent,
  revision,
}).strict().superRefine((input, context) => {
  if (input.countersinkMajorDiameterMm <= input.throughDiameterMm) {
    context.addIssue({ code: "custom", path: ["countersinkMajorDiameterMm"], message: "Countersink major diameter must exceed through diameter" });
  } else {
    const depth = (input.countersinkMajorDiameterMm - input.throughDiameterMm)
      / (2 * Math.tan(input.includedAngleDeg * Math.PI / 360));
    if (!(depth < input.throughDepthMm)) {
      context.addIssue({ code: "custom", path: ["throughDepthMm"], message: "Derived countersink depth must be less than through depth" });
    }
  }
  const dot = input.axis.reduce((sum, value, index) => sum + value * input.radialDirection[index]!, 0);
  const magnitude = Math.hypot(...input.axis) * Math.hypot(...input.radialDirection);
  if (Math.abs(dot) > magnitude * 1e-6) {
    context.addIssue({ code: "custom", path: ["radialDirection"], message: "Radial direction must be perpendicular to axis" });
  }
  for (let first = 0; first < input.entryCentersMm.length; first += 1) {
    for (let second = first + 1; second < input.entryCentersMm.length; second += 1) {
      const distance = Math.hypot(...input.entryCentersMm[first]!.map((value, index) => value - input.entryCentersMm[second]![index]!));
      if (distance <= 1e-9) {
        context.addIssue({ code: "custom", path: ["entryCentersMm", second], message: `Entry center duplicates index ${first}` });
      }
    }
  }
});
const hexNutPocketInputSchema = z.object({
  targetId: z.number().int().positive(),
  entryCenterMm: vector,
  axis: direction,
  flatNormalDirection: direction,
  acrossFlatsMm: z.number().finite().positive(),
  pocketDepthMm: z.number().finite().positive(),
  materialDepthMm: z.number().finite().positive(),
  overshootMm: z.number().finite().nonnegative().default(0.5),
  intent,
  revision,
}).strict().superRefine((input, context) => {
  if (input.pocketDepthMm >= input.materialDepthMm) {
    context.addIssue({ code: "custom", path: ["pocketDepthMm"], message: "Pocket depth must be less than material depth" });
  }
  const dot = input.axis.reduce((sum, value, index) => sum + value * input.flatNormalDirection[index]!, 0);
  const magnitude = Math.hypot(...input.axis) * Math.hypot(...input.flatNormalDirection);
  if (Math.abs(dot) > magnitude * 1e-6) {
    context.addIssue({ code: "custom", path: ["flatNormalDirection"], message: "Flat normal direction must be perpendicular to axis" });
  }
});
const hexNutPocketPatternInputSchema = z.object({
  targetId: z.number().int().positive(),
  entryCentersMm: z.array(vector).min(2).max(128),
  axis: direction,
  flatNormalDirection: direction,
  acrossFlatsMm: z.number().finite().positive(),
  pocketDepthMm: z.number().finite().positive(),
  materialDepthMm: z.number().finite().positive(),
  overshootMm: z.number().finite().nonnegative().default(0.5),
  intent,
  revision,
}).strict().superRefine((input, context) => {
  if (input.pocketDepthMm >= input.materialDepthMm) {
    context.addIssue({ code: "custom", path: ["pocketDepthMm"], message: "Pocket depth must be less than material depth" });
  }
  const dot = input.axis.reduce((sum, value, index) => sum + value * input.flatNormalDirection[index]!, 0);
  const magnitude = Math.hypot(...input.axis) * Math.hypot(...input.flatNormalDirection);
  if (Math.abs(dot) > magnitude * 1e-6) {
    context.addIssue({ code: "custom", path: ["flatNormalDirection"], message: "Flat normal direction must be perpendicular to axis" });
  }
  for (let first = 0; first < input.entryCentersMm.length; first += 1) {
    for (let second = first + 1; second < input.entryCentersMm.length; second += 1) {
      const distance = Math.hypot(...input.entryCentersMm[first]!.map((value, index) => value - input.entryCentersMm[second]![index]!));
      if (distance <= 1e-9) {
        context.addIssue({ code: "custom", path: ["entryCentersMm", second], message: `Entry center duplicates index ${first}` });
      }
    }
  }
});
const slottedHoleInputSchema = z.object({
  targetId: z.number().int().positive(),
  entryCenterMm: vector,
  axis: direction,
  slotDirection: direction,
  overallLengthMm: z.number().finite().positive(),
  widthMm: z.number().finite().positive(),
  throughDepthMm: z.number().finite().positive(),
  overshootMm: z.number().finite().nonnegative().default(0.5),
  intent,
  revision,
}).strict().superRefine((input, context) => {
  if (input.overallLengthMm <= input.widthMm) {
    context.addIssue({ code: "custom", path: ["overallLengthMm"], message: "Slot overall length must exceed width" });
  }
  const dot = input.axis.reduce((sum, value, index) => sum + value * input.slotDirection[index]!, 0);
  const magnitude = Math.hypot(...input.axis) * Math.hypot(...input.slotDirection);
  if (Math.abs(dot) > magnitude * 1e-6) {
    context.addIssue({ code: "custom", path: ["slotDirection"], message: "Slot direction must be perpendicular to axis" });
  }
});
const slottedHolePatternInputSchema = z.object({
  targetId: z.number().int().positive(),
  entryCentersMm: z.array(vector).min(2).max(64),
  axis: direction,
  slotDirection: direction,
  overallLengthMm: z.number().finite().positive(),
  widthMm: z.number().finite().positive(),
  throughDepthMm: z.number().finite().positive(),
  overshootMm: z.number().finite().nonnegative().default(0.5),
  intent,
  revision,
}).strict().superRefine((input, context) => {
  if (input.overallLengthMm <= input.widthMm) {
    context.addIssue({ code: "custom", path: ["overallLengthMm"], message: "Slot overall length must exceed width" });
  }
  const dot = input.axis.reduce((sum, value, index) => sum + value * input.slotDirection[index]!, 0);
  const magnitude = Math.hypot(...input.axis) * Math.hypot(...input.slotDirection);
  if (Math.abs(dot) > magnitude * 1e-6) {
    context.addIssue({ code: "custom", path: ["slotDirection"], message: "Slot direction must be perpendicular to axis" });
  }
  for (let first = 0; first < input.entryCentersMm.length; first += 1) {
    for (let second = first + 1; second < input.entryCentersMm.length; second += 1) {
      const distance = Math.hypot(...input.entryCentersMm[first]!.map((value, index) => value - input.entryCentersMm[second]![index]!));
      if (distance <= 1e-9) context.addIssue({ code: "custom", path: ["entryCentersMm", second], message: `Entry center duplicates index ${first}` });
    }
  }
});
const heatSetInsertPocketInputSchema = z.object({
  targetId: z.number().int().positive(),
  entryCenterMm: vector,
  axis: direction,
  pilotDiameterMm: z.number().finite().positive(),
  pilotDepthMm: z.number().finite().positive(),
  insertDiameterMm: z.number().finite().positive(),
  insertDepthMm: z.number().finite().positive(),
  leadInDiameterMm: z.number().finite().positive(),
  leadInDepthMm: z.number().finite().positive(),
  materialDepthMm: z.number().finite().positive(),
  overshootMm: z.number().finite().nonnegative().default(0.5),
  intent,
  revision,
}).strict().superRefine((input, context) => {
  if (input.pilotDiameterMm >= input.insertDiameterMm) {
    context.addIssue({ code: "custom", path: ["pilotDiameterMm"], message: "Pilot diameter must be less than insert diameter" });
  }
  if (input.insertDiameterMm >= input.leadInDiameterMm) {
    context.addIssue({ code: "custom", path: ["insertDiameterMm"], message: "Insert diameter must be less than lead-in diameter" });
  }
  if (input.leadInDepthMm >= input.insertDepthMm) {
    context.addIssue({ code: "custom", path: ["leadInDepthMm"], message: "Lead-in depth must be less than insert depth" });
  }
  if (input.insertDepthMm >= input.pilotDepthMm) {
    context.addIssue({ code: "custom", path: ["insertDepthMm"], message: "Insert depth must be less than pilot depth" });
  }
  if (input.pilotDepthMm >= input.materialDepthMm) {
    context.addIssue({ code: "custom", path: ["pilotDepthMm"], message: "Pilot depth must be less than material depth" });
  }
});
const heatSetInsertPocketPatternInputSchema = z.object({
  targetId: z.number().int().positive(),
  entryCentersMm: z.array(vector).min(2).max(64),
  axis: direction,
  pilotDiameterMm: z.number().finite().positive(),
  pilotDepthMm: z.number().finite().positive(),
  insertDiameterMm: z.number().finite().positive(),
  insertDepthMm: z.number().finite().positive(),
  leadInDiameterMm: z.number().finite().positive(),
  leadInDepthMm: z.number().finite().positive(),
  materialDepthMm: z.number().finite().positive(),
  overshootMm: z.number().finite().nonnegative().default(0.5),
  intent,
  revision,
}).strict().superRefine((input, context) => {
  if (input.pilotDiameterMm >= input.insertDiameterMm) context.addIssue({ code: "custom", path: ["pilotDiameterMm"], message: "Pilot diameter must be less than insert diameter" });
  if (input.insertDiameterMm >= input.leadInDiameterMm) context.addIssue({ code: "custom", path: ["insertDiameterMm"], message: "Insert diameter must be less than lead-in diameter" });
  if (input.leadInDepthMm >= input.insertDepthMm) context.addIssue({ code: "custom", path: ["leadInDepthMm"], message: "Lead-in depth must be less than insert depth" });
  if (input.insertDepthMm >= input.pilotDepthMm) context.addIssue({ code: "custom", path: ["insertDepthMm"], message: "Insert depth must be less than pilot depth" });
  if (input.pilotDepthMm >= input.materialDepthMm) context.addIssue({ code: "custom", path: ["pilotDepthMm"], message: "Pilot depth must be less than material depth" });
  for (let first = 0; first < input.entryCentersMm.length; first += 1) {
    for (let second = first + 1; second < input.entryCentersMm.length; second += 1) {
      const distance = Math.hypot(...input.entryCentersMm[first]!.map((value, index) => value - input.entryCentersMm[second]![index]!));
      if (distance <= 1e-9) context.addIssue({ code: "custom", path: ["entryCentersMm", second], message: `Entry center duplicates index ${first}` });
    }
  }
});
const screwBossInputSchema = z.object({
  targetId: z.number().int().positive(),
  baseCenterMm: vector,
  axis: direction,
  outerDiameterMm: z.number().finite().positive(),
  heightMm: z.number().finite().positive(),
  holeDiameterMm: z.number().finite().positive(),
  holeDepthMm: z.number().finite().positive(),
  baseOverlapMm: z.number().finite().positive().default(0.5),
  cutterOvershootMm: z.number().finite().nonnegative().default(0.5),
  intent,
  revision,
}).strict().superRefine((input, context) => {
  if (input.holeDiameterMm >= input.outerDiameterMm) {
    context.addIssue({ code: "custom", path: ["holeDiameterMm"], message: "Hole diameter must be less than boss outer diameter" });
  }
  if (input.holeDepthMm > input.heightMm) {
    context.addIssue({ code: "custom", path: ["holeDepthMm"], message: "Hole depth must not exceed boss height" });
  }
});
const screwBossPatternInputSchema = z.object({
  targetId: z.number().int().positive(),
  baseCentersMm: z.array(vector).min(2).max(64),
  axis: direction,
  outerDiameterMm: z.number().finite().positive(),
  heightMm: z.number().finite().positive(),
  holeDiameterMm: z.number().finite().positive(),
  holeDepthMm: z.number().finite().positive(),
  baseOverlapMm: z.number().finite().positive().default(0.5),
  cutterOvershootMm: z.number().finite().nonnegative().default(0.5),
  intent,
  revision,
}).strict().superRefine((input, context) => {
  if (input.holeDiameterMm >= input.outerDiameterMm) {
    context.addIssue({ code: "custom", path: ["holeDiameterMm"], message: "Hole diameter must be less than boss outer diameter" });
  }
  if (input.holeDepthMm > input.heightMm) {
    context.addIssue({ code: "custom", path: ["holeDepthMm"], message: "Hole depth must not exceed boss height" });
  }
  for (let first = 0; first < input.baseCentersMm.length; first += 1) {
    for (let second = first + 1; second < input.baseCentersMm.length; second += 1) {
      const distance = Math.hypot(...input.baseCentersMm[first]!.map((value, index) => value - input.baseCentersMm[second]![index]!));
      if (distance <= 1e-9) context.addIssue({ code: "custom", path: ["baseCentersMm", second], message: `Base center duplicates index ${first}` });
    }
  }
});
const ribInputSchema = z.object({
  targetId: z.number().int().positive(),
  profilePointsMm: z.array(vector).min(3).max(1000),
  thicknessMm: nonzeroDistance,
  intent,
  revision,
}).strict();
const roundVentArrayInputSchema = z.object({
  targetId: z.number().int().positive(),
  firstCenterMm: vector,
  axis: direction,
  holeDiameterMm: z.number().finite().positive(),
  throughDepthMm: z.number().finite().positive(),
  direction1: direction,
  count1: z.number().int().min(1).max(20),
  spacing1Mm: z.number().finite().positive(),
  direction2: direction,
  count2: z.number().int().min(1).max(20),
  spacing2Mm: z.number().finite().positive(),
  overshootMm: z.number().finite().nonnegative().default(0.5),
  intent,
  revision,
}).strict().superRefine((input, context) => {
  if (input.count1 > 1 && input.spacing1Mm <= input.holeDiameterMm) {
    context.addIssue({ code: "custom", path: ["spacing1Mm"], message: "Direction 1 spacing must exceed hole diameter" });
  }
  if (input.count2 > 1 && input.spacing2Mm <= input.holeDiameterMm) {
    context.addIssue({ code: "custom", path: ["spacing2Mm"], message: "Direction 2 spacing must exceed hole diameter" });
  }
});
const cantileverSnapFitInputSchema = z.object({
  targetId: z.number().int().positive(),
  baseCenterMm: vector,
  beamDirection: direction,
  thicknessDirection: direction,
  lengthMm: z.number().finite().positive(),
  widthMm: z.number().finite().positive(),
  thicknessMm: z.number().finite().positive(),
  hookLengthMm: z.number().finite().positive(),
  hookHeightMm: z.number().finite().positive(),
  baseOverlapMm: z.number().finite().positive().default(0.5),
  intent,
  revision,
}).strict().superRefine((input, context) => {
  if (input.hookLengthMm >= input.lengthMm) {
    context.addIssue({ code: "custom", path: ["hookLengthMm"], message: "Hook length must be less than beam length" });
  }
});
const hingeBarrelInputSchema = z.object({
  targetId: z.number().int().positive(),
  axisStartMm: vector,
  axis: direction,
  lengthMm: z.number().finite().positive(),
  outerDiameterMm: z.number().finite().positive(),
  pinBoreDiameterMm: z.number().finite().positive(),
  cutterOvershootMm: z.number().finite().nonnegative().default(0.5),
  intent,
  revision,
}).strict().superRefine((input, context) => {
  if (input.pinBoreDiameterMm >= input.outerDiameterMm) {
    context.addIssue({ code: "custom", path: ["pinBoreDiameterMm"], message: "Pin bore diameter must be less than outer diameter" });
  }
});
const cableChannelInputSchema = z.object({
  targetId: z.number().int().positive(),
  spineIds: ids,
  channelDiameterMm: z.number().finite().positive(),
  intent,
  revision,
}).strict().superRefine((input, context) => {
  if (input.spineIds.includes(input.targetId)) {
    context.addIssue({ code: "custom", path: ["spineIds"], message: "Target must not also be a spine" });
  }
  if (new Set(input.spineIds).size !== input.spineIds.length) {
    context.addIssue({ code: "custom", path: ["spineIds"], message: "Spine IDs must be unique" });
  }
});
const connectorOpeningInputSchema = z.object({
  targetId: z.number().int().positive(),
  entryCenterMm: vector,
  axis: direction,
  widthDirection: direction,
  widthMm: z.number().finite().positive(),
  heightMm: z.number().finite().positive(),
  cornerRadiusMm: z.number().finite().nonnegative().default(0),
  throughDepthMm: z.number().finite().positive(),
  overshootMm: z.number().finite().nonnegative().default(0.5),
  intent,
  revision,
}).strict().superRefine((input, context) => {
  if (input.cornerRadiusMm >= Math.min(input.widthMm, input.heightMm) / 2) {
    context.addIssue({ code: "custom", path: ["cornerRadiusMm"], message: "Corner radius must be less than half the opening width and height" });
  }
});
const splitSolidByPlaneInputSchema = z.object({
  targetId: z.number().int().positive(),
  originMm: vector,
  normal: direction,
  xDirection: direction,
  intent,
  revision,
}).strict().superRefine((input, context) => {
  const dot = input.normal.reduce((sum, value, index) => sum + value * input.xDirection[index]!, 0);
  const magnitude = Math.hypot(...input.normal) * Math.hypot(...input.xDirection);
  if (Math.abs(dot) > magnitude * (1 - 1e-6)) {
    context.addIssue({ code: "custom", path: ["xDirection"], message: "Split plane x direction must not be parallel to its normal" });
  }
});
const splitSolidByPlanesInputSchema = z.object({
  targetId: z.number().int().positive(),
  planes: z.array(z.object({ originMm: vector, normal: direction, xDirection: direction }).strict()).min(1).max(64),
  intent,
  revision,
}).strict();
const splitSolidToVolumeInputSchema = z.object({
  targetId: z.number().int().positive(),
  usableBuildVolumeMm: z.tuple([z.number().finite().positive(), z.number().finite().positive(), z.number().finite().positive()]),
  intent,
  revision,
}).strict();
const matingEnclosureJointInputSchema = z.object({
  maleTargetId: z.number().int().positive(),
  femaleTargetId: z.number().int().positive(),
  seamOriginMm: vector,
  outerWidthMm: z.number().finite().positive(),
  outerDepthMm: z.number().finite().positive(),
  wallThicknessMm: z.number().finite().positive(),
  lipThicknessMm: z.number().finite().positive(),
  lipHeightMm: z.number().finite().positive(),
  clearanceMm: z.number().finite().nonnegative(),
  overlapMm: z.number().finite().positive().default(0.25),
  cutterOvershootMm: z.number().finite().positive().default(0.25),
  intent,
  revision,
}).strict().superRefine((input, context) => {
  if (input.maleTargetId === input.femaleTargetId) {
    context.addIssue({ code: "custom", path: ["femaleTargetId"], message: "Male and female halves must be different bodies" });
  }
  if (input.wallThicknessMm <= input.overlapMm + input.clearanceMm) {
    context.addIssue({ code: "custom", path: ["wallThicknessMm"], message: "Wall thickness must exceed overlap plus clearance" });
  }
  const requiredInset = input.wallThicknessMm + input.lipThicknessMm + input.clearanceMm;
  if (input.outerWidthMm <= requiredInset * 2 || input.outerDepthMm <= requiredInset * 2) {
    context.addIssue({ code: "custom", path: ["outerWidthMm"], message: "Outer dimensions are too small for the wall, lip, and clearance" });
  }
});
const locatingPinPairInputSchema = z.object({
  maleTargetId: z.number().int().positive(),
  femaleTargetId: z.number().int().positive(),
  baseCenterMm: vector,
  axis: direction,
  pinDiameterMm: z.number().finite().positive(),
  pinHeightMm: z.number().finite().positive(),
  radialClearanceMm: z.number().finite().nonnegative(),
  axialClearanceMm: z.number().finite().nonnegative(),
  baseOverlapMm: z.number().finite().positive().default(0.5),
  cutterOvershootMm: z.number().finite().positive().default(0.5),
  intent,
  revision,
}).strict().superRefine((input, context) => {
  if (input.maleTargetId === input.femaleTargetId) {
    context.addIssue({ code: "custom", path: ["femaleTargetId"], message: "Male and female halves must be different bodies" });
  }
});
const locatingPinPairPatternInputSchema = z.object({
  maleTargetId: z.number().int().positive(),
  femaleTargetId: z.number().int().positive(),
  baseCentersMm: z.array(vector).min(2).max(64),
  axis: direction,
  pinDiameterMm: z.number().finite().positive(),
  pinHeightMm: z.number().finite().positive(),
  radialClearanceMm: z.number().finite().nonnegative(),
  axialClearanceMm: z.number().finite().nonnegative(),
  baseOverlapMm: z.number().finite().positive().default(0.5),
  cutterOvershootMm: z.number().finite().positive().default(0.5),
  intent,
  revision,
}).strict().superRefine((input, context) => {
  if (input.maleTargetId === input.femaleTargetId) {
    context.addIssue({ code: "custom", path: ["femaleTargetId"], message: "Male and female halves must be different bodies" });
  }
  for (let first = 0; first < input.baseCentersMm.length; first += 1) {
    for (let second = first + 1; second < input.baseCentersMm.length; second += 1) {
      const distance = Math.hypot(...input.baseCentersMm[first]!.map((value, index) => value - input.baseCentersMm[second]![index]!));
      if (distance <= 1e-9) context.addIssue({ code: "custom", path: ["baseCentersMm", second], message: `Base center duplicates index ${first}` });
    }
  }
});
const splitScrewInsertJointInputSchema = z.object({
  maleTargetId: z.number().int().positive(),
  femaleTargetId: z.number().int().positive(),
  screwEntryCentersMm: z.array(vector).min(1).max(64),
  insertEntryCentersMm: z.array(vector).min(1).max(64),
  axis: direction,
  fastenerDesignation: z.string().trim().min(1).max(240),
  screwLengthMm: z.number().finite().positive(),
  minimumEngagementMm: z.number().finite().positive(),
  maximumEngagementMm: z.number().finite().positive(),
  insertPartNumber: z.string().trim().min(1).max(160),
  insertThreadNominalDiameterMm: z.number().finite().positive(),
  insertThreadPitchMm: z.number().finite().positive(),
  insertSourceUrl: z.string().url().refine((value) => value.startsWith("https://"), "Insert source URL must use HTTPS"),
  holeDiameterMm: z.number().finite().positive(),
  maleThroughDepthMm: z.number().finite().positive(),
  holeOvershootMm: z.number().finite().nonnegative().default(0.5),
  pilotDiameterMm: z.number().finite().positive(),
  pilotDepthMm: z.number().finite().positive(),
  insertDiameterMm: z.number().finite().positive(),
  insertDepthMm: z.number().finite().positive(),
  leadInDiameterMm: z.number().finite().positive(),
  leadInDepthMm: z.number().finite().positive(),
  femaleMaterialDepthMm: z.number().finite().positive(),
  insertOvershootMm: z.number().finite().nonnegative().default(0.5),
  intent,
  revision,
}).strict().superRefine((input, context) => {
  if (input.maleTargetId === input.femaleTargetId) {
    context.addIssue({ code: "custom", path: ["femaleTargetId"], message: "Male and female halves must be different bodies" });
  }
  if (input.screwEntryCentersMm.length !== input.insertEntryCentersMm.length) {
    context.addIssue({ code: "custom", path: ["insertEntryCentersMm"], message: "Screw and insert center counts must match" });
  }
  if (input.minimumEngagementMm > input.maximumEngagementMm) {
    context.addIssue({ code: "custom", path: ["maximumEngagementMm"], message: "Maximum engagement must not be less than minimum engagement" });
  }
  for (const centers of [input.screwEntryCentersMm, input.insertEntryCentersMm]) {
    for (let first = 0; first < centers.length; first += 1) {
      for (let second = first + 1; second < centers.length; second += 1) {
        const distance = Math.hypot(...centers[first]!.map((value, index) => value - centers[second]![index]!));
        if (distance <= 1e-9) context.addIssue({ code: "custom", path: ["screwEntryCentersMm", second], message: `Joint center duplicates index ${first}` });
      }
    }
  }
});
const tongueGrooveJointInputSchema = z.object({
  tongueTargetId: z.number().int().positive(),
  grooveTargetId: z.number().int().positive(),
  baseCenterMm: vector,
  axis: direction,
  widthDirection: direction,
  tongueWidthMm: z.number().finite().positive(),
  tongueThicknessMm: z.number().finite().positive(),
  tongueHeightMm: z.number().finite().positive(),
  radialClearanceMm: z.number().finite().nonnegative(),
  axialClearanceMm: z.number().finite().nonnegative(),
  baseOverlapMm: z.number().finite().positive().default(0.5),
  cutterOvershootMm: z.number().finite().positive().default(0.5),
  intent,
  revision,
}).strict().superRefine((input, context) => {
  if (input.tongueTargetId === input.grooveTargetId) {
    context.addIssue({ code: "custom", path: ["grooveTargetId"], message: "Tongue and groove targets must be different bodies" });
  }
});
const dovetailJointInputSchema = z.object({
  maleTargetId: z.number().int().positive(),
  femaleTargetId: z.number().int().positive(),
  baseCenterMm: vector,
  axis: direction,
  widthDirection: direction,
  rootWidthMm: z.number().finite().positive(),
  flareMm: z.number().finite().positive(),
  tongueThicknessMm: z.number().finite().positive(),
  tongueHeightMm: z.number().finite().positive(),
  radialClearanceMm: z.number().finite().nonnegative(),
  axialClearanceMm: z.number().finite().nonnegative(),
  baseOverlapMm: z.number().finite().positive().default(0.5),
  cutterOvershootMm: z.number().finite().positive().default(0.5),
  intent,
  revision,
}).strict().superRefine((input, context) => {
  if (input.maleTargetId === input.femaleTargetId) {
    context.addIssue({ code: "custom", path: ["femaleTargetId"], message: "Dovetail halves must be different bodies" });
  }
});
const scalarMatch = z.object({
  value: z.number().finite(),
  tolerance: z.number().finite().nonnegative().default(0.01),
}).strict();
const printedThreadDefinitionFields = {
  nominalDiameterMm: z.number().finite().positive(),
  pitchMm: z.number().finite().positive(),
  threadDepthMm: z.number().finite().positive(),
  radialDirection: direction.default([1, 0, 0]),
  handedness: z.enum(["right", "left"]).default("right"),
};
const printedExternalThreadInputSchema = z.object({
  ...printedThreadDefinitionFields,
  axisStartMm: vector,
  axis: direction,
  threadLengthMm: z.number().finite().positive(),
  name: z.string().trim().min(1).max(120).optional(),
  intent,
  revision,
}).strict();
const printedInternalThreadInputSchema = z.object({
  ...printedThreadDefinitionFields,
  targetId: z.number().int().positive(),
  entryCenterMm: vector,
  axis: direction,
  materialDepthMm: z.number().finite().positive(),
  profileClearanceMm: z.number().finite().nonnegative(),
  cutterOvershootMm: z.number().finite().positive().default(0.5),
  intent,
  revision,
}).strict();
const printedHexNutInputSchema = z.object({
  ...printedThreadDefinitionFields,
  entryCenterMm: vector,
  axis: direction,
  flatNormalDirection: direction,
  acrossFlatsMm: z.number().finite().positive(),
  thicknessMm: z.number().finite().positive(),
  minimumWallThicknessMm: z.number().finite().positive(),
  profileClearanceMm: z.number().finite().nonnegative(),
  cutterOvershootMm: z.number().finite().positive().default(0.5),
  intent,
  revision,
}).strict();
const printedHexScrewInputSchema = z.object({
  ...printedThreadDefinitionFields,
  axisStartMm: vector,
  axis: direction,
  threadLengthMm: z.number().finite().positive(),
  flatNormalDirection: direction,
  headAcrossFlatsMm: z.number().finite().positive(),
  headHeightMm: z.number().finite().positive(),
  junctionOverlapMm: z.number().finite().positive(),
  name: z.string().trim().min(1).max(120).optional(),
  intent,
  revision,
}).strict();
const printedThreadProcessSchema = printedThreadProcessIdentitySchema;
const printedHexPairInputSchema = z.object({
  designation: z.string().trim().min(1).max(500),
  pitchMm: z.number().finite().positive(),
  threadDepthMm: z.number().finite().positive(),
  profileClearanceMm: z.number().finite().nonnegative(),
  handedness: z.enum(["right", "left"]).default("right"),
  screwAxisStartMm: vector,
  nutEntryCenterMm: vector,
  axis: direction,
  radialDirection: direction.default([1, 0, 0]),
  flatNormalDirection: direction,
  screwHeadAcrossFlatsMm: z.number().finite().positive(),
  screwHeadHeightMm: z.number().finite().positive(),
  screwJunctionOverlapMm: z.number().finite().positive(),
  nutAcrossFlatsMm: z.number().finite().positive(),
  nutThicknessMm: z.number().finite().positive(),
  nutMinimumWallThicknessMm: z.number().finite().positive(),
  cutterOvershootMm: z.number().finite().positive().default(0.5),
  screwName: z.string().trim().min(1).max(120).optional(),
  qualificationId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  process: printedThreadProcessSchema,
  sizingBasis: z.string().trim().min(1).max(2000),
  intent,
  revision,
}).strict();
const printedThreadCalibrationInputSchema = z.object({
  designation: z.string().trim().min(1).max(500),
  pitchMm: z.number().finite().positive(),
  threadDepthMm: z.number().finite().positive(),
  handedness: z.enum(["right", "left"]).default("right"),
  screwAxisStartMm: vector,
  axis: direction,
  radialDirection: direction.default([1, 0, 0]),
  flatNormalDirection: direction,
  screwHeadAcrossFlatsMm: z.number().finite().positive(),
  screwHeadHeightMm: z.number().finite().positive(),
  screwJunctionOverlapMm: z.number().finite().positive(),
  nutAcrossFlatsMm: z.number().finite().positive(),
  nutThicknessMm: z.number().finite().positive(),
  nutMinimumWallThicknessMm: z.number().finite().positive(),
  cutterOvershootMm: z.number().finite().positive().default(0.5),
  screwName: z.string().trim().min(1).max(120).optional(),
  samples: z.array(z.object({
    id: z.string().trim().min(1).max(80),
    nutEntryCenterMm: vector,
    profileClearanceMm: z.number().finite().nonnegative(),
  }).strict()).min(2).max(8),
  process: printedThreadProcessSchema,
  sizingBasis: z.string().trim().min(1).max(2000),
  intent,
  revision,
}).strict().superRefine((input, context) => {
  const ids = new Set<string>();
  const centers = new Set<string>();
  for (let index = 0; index < input.samples.length; index += 1) {
    const sample = input.samples[index]!;
    if (ids.has(sample.id)) context.addIssue({ code: "custom", path: ["samples", index, "id"], message: "Calibration sample IDs must be unique" });
    ids.add(sample.id);
    const center = sample.nutEntryCenterMm.join(",");
    if (centers.has(center)) context.addIssue({ code: "custom", path: ["samples", index, "nutEntryCenterMm"], message: "Calibration nut centers must be unique" });
    centers.add(center);
    if (input.samples.slice(0, index).some((previous) => Math.abs(previous.profileClearanceMm - sample.profileClearanceMm) <= 1e-9)) {
      context.addIssue({ code: "custom", path: ["samples", index, "profileClearanceMm"], message: "Calibration profile clearances must be unique" });
    }
  }
});
const pointMatch = z.object({
  pointMm: vector,
  toleranceMm: z.number().finite().nonnegative().default(0.01),
}).strict();
const directionMatch = z.object({
  vector: direction,
  toleranceDeg: z.number().finite().min(0).max(180).default(1),
  oriented: z.boolean().default(false),
}).strict();
const normalMatch = z.object({
  vector: direction,
  toleranceDeg: z.number().finite().min(0).max(180).default(1),
  oriented: z.boolean().default(true),
}).strict();
const bounds = z.object({ min: vector, max: vector }).strict().refine(
  ({ min, max }) => min.every((value, axis) => value <= max[axis]!),
  "Bounds minimum must not exceed maximum",
);
const faceQuerySchema = z.object({
  bodyIds: z.array(z.number().int().positive()).max(4096).optional(),
  surfaceTypes: z.array(z.string().trim().min(1).max(80)).max(32).optional(),
  planar: z.boolean().optional(),
  normal: normalMatch.optional(),
  radiusMm: scalarMatch.optional(),
  blendRadiusMm: scalarMatch.optional(),
  center: pointMatch.optional(),
  boundsMm: bounds.optional(),
  edgeCount: z.number().int().nonnegative().optional(),
  adjacentEdgeIds: z.array(z.string().min(1)).max(4096).optional(),
}).strict();
const edgeQuerySchema = z.object({
  bodyIds: z.array(z.number().int().positive()).max(4096).optional(),
  curveTypes: z.array(z.string().trim().min(1).max(80)).max(32).optional(),
  line: z.boolean().optional(),
  circle: z.boolean().optional(),
  direction: directionMatch.optional(),
  lengthMm: scalarMatch.optional(),
  center: pointMatch.optional(),
  boundsMm: bounds.optional(),
  adjacentFaceIds: z.array(z.string().min(1)).max(4096).optional(),
}).strict();
const referenceIdentitySchema = z.object({
  id: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
  documentToken: z.string().trim().min(1),
  revision,
}).strict();
const datumPointDefinitionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("coordinates"), pointMm: vector }).strict(),
  z.object({ type: z.literal("face-center"), bodyId: z.number().int().positive(), faceId: z.string().trim().min(1) }).strict(),
  z.object({ type: z.literal("edge-midpoint"), bodyId: z.number().int().positive(), edgeId: z.string().trim().min(1) }).strict(),
]);
const datumAxisDefinitionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("two-points"), firstId: z.string().trim().min(1), secondId: z.string().trim().min(1) }).strict()
    .refine((value) => value.firstId !== value.secondId, "Axis point references must be different"),
  z.object({ type: z.literal("origin-direction"), originMm: vector, direction }).strict(),
  z.object({ type: z.literal("linear-edge"), bodyId: z.number().int().positive(), edgeId: z.string().trim().min(1) }).strict(),
  z.object({ type: z.literal("cylindrical-face"), bodyId: z.number().int().positive(), faceId: z.string().trim().min(1) }).strict(),
]);
const constructionPlaneDefinitionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("explicit"), originMm: vector, normal: direction, xDirection: direction }).strict(),
  z.object({ type: z.literal("three-points"), firstId: z.string().trim().min(1), secondId: z.string().trim().min(1), thirdId: z.string().trim().min(1) }).strict()
    .refine((value) => new Set([value.firstId, value.secondId, value.thirdId]).size === 3, "Plane point references must be different"),
  z.object({ type: z.literal("planar-face"), bodyId: z.number().int().positive(), faceId: z.string().trim().min(1), offsetMm: z.number().finite().default(0) }).strict(),
  z.object({ type: z.literal("offset"), planeId: z.string().trim().min(1), offsetMm: z.number().finite() }).strict(),
  z.object({ type: z.literal("rotated"), planeId: z.string().trim().min(1), axisId: z.string().trim().min(1), angleDegrees: z.number().finite() }).strict(),
]);
const polylineInputSchema = z.union([
  z.object({ pointsMm: z.array(vector).min(2).max(1000), closed: z.boolean().default(false), intent, revision }).strict(),
  z.object({ pointsMm: z.array(vector2).min(2).max(1000), plane: referenceIdentitySchema, closed: z.boolean().default(false), intent, revision }).strict(),
]);
const circleInputSchema = z.union([
  z.object({ centerMm: vector, radiusMm: z.number().finite().positive(), normal: direction.default([0, 0, 1]), intent, revision }).strict(),
  z.object({ centerMm: vector2, radiusMm: z.number().finite().positive(), plane: referenceIdentitySchema, intent, revision }).strict(),
]);
const twoPointCircleInputSchema = z.union([
  z.object({ diameterStartMm: vector, diameterEndMm: vector, normal: direction.default([0, 0, 1]), intent, revision }).strict(),
  z.object({ diameterStartMm: vector2, diameterEndMm: vector2, plane: referenceIdentitySchema, intent, revision }).strict(),
]);
const threePointCircleInputSchema = z.union([
  z.object({ firstMm: vector, secondMm: vector, thirdMm: vector, intent, revision }).strict(),
  z.object({ firstMm: vector2, secondMm: vector2, thirdMm: vector2, plane: referenceIdentitySchema, intent, revision }).strict(),
]);
const arcSweepDegrees = z.number().finite().refine(
  (value) => value !== 0 && Math.abs(value) < 360,
  "Arc sweep angle must be nonzero and have magnitude less than 360 degrees",
);
const centerArcInputSchema = z.union([
  z.object({
    centerMm: vector,
    radiusMm: z.number().finite().positive(),
    startAngleDegrees: z.number().finite().default(0),
    sweepAngleDegrees: arcSweepDegrees,
    normal: direction.default([0, 0, 1]),
    xDirection: direction.default([1, 0, 0]),
    intent,
    revision,
  }).strict(),
  z.object({
    centerMm: vector2,
    radiusMm: z.number().finite().positive(),
    startAngleDegrees: z.number().finite().default(0),
    sweepAngleDegrees: arcSweepDegrees,
    plane: referenceIdentitySchema,
    intent,
    revision,
  }).strict(),
]);
const threePointArcInputSchema = z.union([
  z.object({
    startMm: vector,
    throughMm: vector,
    endMm: vector,
    intent,
    revision,
  }).strict(),
  z.object({
    startMm: vector2,
    throughMm: vector2,
    endMm: vector2,
    plane: referenceIdentitySchema,
    intent,
    revision,
  }).strict(),
]);
const tangentArcCommon = {
  bodyId: z.number().int().positive(),
  segmentEntityId: z.number().int().positive(),
  startAt: z.enum(["start", "end"]),
  flipTangent: z.boolean().default(false),
  intent,
  revision,
};
const tangentArcInputSchema = z.union([
  z.object({ ...tangentArcCommon, endMm: vector }).strict(),
  z.object({ ...tangentArcCommon, endMm: vector2, plane: referenceIdentitySchema }).strict(),
]);
const curveSegmentSchema = z.object({
  bodyId: z.number().int().positive(),
  segmentEntityId: z.number().int().positive(),
}).strict();
const curveSegmentSampleSchema = z.object({
  bodyId: z.number().int().positive(),
  segmentEntityId: z.number().int().positive(),
  normalizedParameter: z.number().finite().min(0).max(1),
}).strict();
const tangentCircleCommon = {
  first: curveSegmentSchema,
  second: curveSegmentSchema,
  radiusMm: z.number().finite().positive(),
  intent,
  revision,
};
const tangentCircleInputSchema = z.union([
  z.object({ ...tangentCircleCommon, solutionPointMm: vector, normal: direction.default([0, 0, 1]) }).strict(),
  z.object({ ...tangentCircleCommon, solutionPointMm: vector2, plane: referenceIdentitySchema }).strict(),
]).refine(
  (value) => value.first.bodyId !== value.second.bodyId || value.first.segmentEntityId !== value.second.segmentEntityId,
  "Tangent-circle segment references must be different",
);
const curveSegmentEndpointSchema = z.object({
  bodyId: z.number().int().positive(),
  segmentEntityId: z.number().int().positive(),
  at: z.enum(["start", "end"]),
}).strict();
const bridgeCurveInputSchema = z.object({
  first: curveSegmentEndpointSchema,
  second: curveSegmentEndpointSchema,
  startContinuity: z.enum(["G0", "G1", "G2", "G3"]).default("G2"),
  endContinuity: z.enum(["G0", "G1", "G2", "G3"]).default("G2"),
  intent,
  revision,
}).strict().refine(
  (value) => value.first.bodyId !== value.second.bodyId || value.first.segmentEntityId !== value.second.segmentEntityId || value.first.at !== value.second.at,
  "Curve Bridge endpoint references must be different",
);
const bridgeCurveVerticesInputSchema = z.object({
  first: measurementVertexRef,
  second: measurementVertexRef,
  startContinuity: z.enum(["G0", "G1", "G2", "G3"]).default("G2"),
  endContinuity: z.enum(["G0", "G1", "G2", "G3"]).default("G2"),
  intent,
  revision,
}).strict().refine(
  (value) => value.first.bodyId !== value.second.bodyId || value.first.vertexId !== value.second.vertexId,
  "Curve Vertex Bridge endpoint references must be different",
);
const shellEdgeEndpointSchema = edgeRef.extend({
  vertexId: z.number().int().nonnegative(),
}).strict();
const bridgeShellEdgesInputSchema = z.object({
  first: shellEdgeEndpointSchema,
  second: shellEdgeEndpointSchema,
  startContinuity: z.enum(["G0", "G1", "G2", "G3"]).default("G2"),
  endContinuity: z.enum(["G0", "G1", "G2", "G3"]).default("G2"),
  intent,
  revision,
}).strict().refine(
  (value) => value.first.bodyId !== value.second.bodyId || value.first.edgeId !== value.second.edgeId,
  "Shell Edge Bridge requires two different source edges",
);
const ellipseInputSchema = z.union([
  z.object({
    centerMm: vector,
    majorRadiusMm: z.number().finite().positive(),
    minorRadiusMm: z.number().finite().positive(),
    normal: direction.default([0, 0, 1]),
    xDirection: direction.default([1, 0, 0]),
    angleDegrees: z.number().finite().default(0),
    intent,
    revision,
  }).strict().refine((value) => value.minorRadiusMm <= value.majorRadiusMm, "Ellipse minor radius must not exceed its major radius"),
  z.object({
    centerMm: vector2,
    majorRadiusMm: z.number().finite().positive(),
    minorRadiusMm: z.number().finite().positive(),
    plane: referenceIdentitySchema,
    angleDegrees: z.number().finite().default(0),
    intent,
    revision,
  }).strict().refine((value) => value.minorRadiusMm <= value.majorRadiusMm, "Ellipse minor radius must not exceed its major radius"),
]);
const regularPolygonInputSchema = z.union([
  z.object({
    centerMm: vector,
    radiusMm: z.number().finite().positive(),
    radiusMode: z.enum(["circumradius", "inradius"]).default("circumradius"),
    vertexCount: z.number().int().min(3).max(256),
    normal: direction.default([0, 0, 1]),
    xDirection: direction.default([1, 0, 0]),
    angleDegrees: z.number().finite().default(0),
    intent,
    revision,
  }).strict(),
  z.object({
    centerMm: vector2,
    radiusMm: z.number().finite().positive(),
    radiusMode: z.enum(["circumradius", "inradius"]).default("circumradius"),
    vertexCount: z.number().int().min(3).max(256),
    plane: referenceIdentitySchema,
    angleDegrees: z.number().finite().default(0),
    intent,
    revision,
  }).strict(),
]);
const rebuildCurveCommon = {
  ids: curveIds,
  preserveParameterization: z.boolean().default(false),
  preserveChain: z.boolean().default(true),
  keepCorners: z.boolean().default(true),
  intent,
  revision,
};
const rebuildCurveInputSchema = z.discriminatedUnion("method", [
  z.object({
    ...rebuildCurveCommon,
    method: z.literal("tolerance"),
    toleranceMm: z.number().finite().min(0.001).max(100),
  }).strict(),
  z.object({
    ...rebuildCurveCommon,
    method: z.literal("control-points"),
    pointCount: z.number().int().min(4).max(1000),
  }).strict(),
  z.object({
    ...rebuildCurveCommon,
    method: z.literal("degree-spans"),
    degree: z.number().int().min(1).max(15),
    spans: z.number().int().min(1).max(1000),
  }).strict(),
]).superRefine((value, context) => {
  if (value.method === "degree-spans" && value.degree + value.spans > 1000) {
    context.addIssue({ code: "custom", path: ["spans"], message: "Degree plus spans must not exceed 1000 control points" });
  }
});
const rectangleInputSchema = z.union([
  z.object({
    centerMm: vector,
    widthMm: z.number().finite().positive(),
    heightMm: z.number().finite().positive(),
    normal: direction.default([0, 0, 1]),
    xDirection: direction.default([1, 0, 0]),
    angleDegrees: z.number().finite().default(0),
    intent,
    revision,
  }).strict(),
  z.object({
    centerMm: vector2,
    widthMm: z.number().finite().positive(),
    heightMm: z.number().finite().positive(),
    plane: referenceIdentitySchema,
    angleDegrees: z.number().finite().default(0),
    intent,
    revision,
  }).strict(),
]);
const textValue = z.string().max(120).refine((value) => value.trim().length > 0, "Text must be nonempty")
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "Text must not contain control characters");
const textInputSchema = z.union([
  z.object({
    text: textValue,
    fontSizeMm: z.number().finite().positive().max(10_000),
    originMm: vector,
    font: z.literal("inter").default("inter"),
    name: z.string().trim().min(1).max(120).optional(),
    normal: direction.default([0, 0, 1]),
    xDirection: direction.default([1, 0, 0]),
    angleDegrees: z.number().finite().default(0),
    intent,
    revision,
  }).strict(),
  z.object({
    text: textValue,
    fontSizeMm: z.number().finite().positive().max(10_000),
    originMm: vector2,
    plane: referenceIdentitySchema,
    font: z.literal("inter").default("inter"),
    name: z.string().trim().min(1).max(120).optional(),
    angleDegrees: z.number().finite().default(0),
    intent,
    revision,
  }).strict(),
]);

interface JournalEntry {
  id: string;
  operation: string;
  intent: string | null;
  input: unknown;
  documentToken: string;
  beforeRevision: string;
  afterDocumentToken: string | null;
  afterRevision: string | null;
  status: "completed" | "failed" | "unknown";
  diff: ConstructionHistoryEntry["change"] | null;
  error: string | null;
  occurredAt: string;
}

function compactJournalChange(diff: SceneDiff | null): ConstructionHistoryEntry["change"] {
  const summarizeBody = (body: RuntimeState["bodies"][number]) => ({
    id: body.id,
    type: body.type,
    name: body.name,
    boundsMm: body.boundsMm,
    faceCount: body.faces.length,
    edgeCount: body.edges.length,
  });
  return {
    changed: diff?.changed ?? false,
    documentChanged: diff?.documentChanged ?? false,
    added: diff?.added.map(summarizeBody) ?? [],
    removed: diff?.removed.map(summarizeBody) ?? [],
    modified: diff?.modified.map(({ id, renamed, geometryChanged, appearanceChanged, visibilityChanged, after }) => ({
      id, renamed, geometryChanged, appearanceChanged, visibilityChanged, body: summarizeBody(after),
    })) ?? [],
    addedConstructionPlaneIds: diff?.constructionPlanesAdded.map((plane) => plane.nativeId) ?? [],
    removedConstructionPlaneIds: diff?.constructionPlanesRemoved.map((plane) => plane.nativeId) ?? [],
    modifiedConstructionPlaneIds: diff?.constructionPlanesModified.map((plane) => plane.nativeId) ?? [],
    activeWorkplaneChanged: diff?.activeWorkplaneChanged !== null && diff?.activeWorkplaneChanged !== undefined,
    materialsChanged: diff?.materialsChanged ?? false,
    measurementsChanged: diff?.measurementsChanged ?? false,
    sectionAnalysesChanged: diff?.sectionAnalysesChanged ?? false,
    instancesChanged: diff?.instancesChanged ?? false,
    referenceMeshesChanged: diff?.referenceMeshesChanged ?? false,
    groupsChanged: diff?.groupsChanged ?? false,
    staleDatumCount: diff?.staleDatums.length ?? 0,
  };
}

interface NamedSelection {
  id: string;
  name: string;
  kind: "faces" | "edges";
  query: FaceQuery | EdgeQuery;
  expectedCount: number | null;
  documentToken: string;
  createdRevision: string;
  createdAt: string;
}

export class PlasticitySession {
  private runtime: PlasticityRuntime | undefined;
  private operations: PlasticityOperations | undefined;
  private ownership: WindowOwnership | undefined;
  private targetId: string | undefined;
  private readonly snapshots = new Map<string, {
    label: string | null;
    capturedAt: string;
    state: Awaited<ReturnType<PlasticityOperations["state"]>>;
    datums: TrackedDatum[];
  }>();

  async windows() {
    return await discoverPlasticityTargets(process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223");
  }

  async connect(targetId: string) {
    const target = (await this.windows()).find((candidate) => candidate.id === targetId);
    if (!target) throw new Error(`Plasticity window not found: ${targetId}`);
    const current: SessionConnection<RuntimeState, PlasticityRuntime, PlasticityOperations, WindowOwnership> | undefined =
      this.runtime && this.operations && this.ownership && this.targetId
        ? { targetId: this.targetId, runtime: this.runtime, operations: this.operations, ownership: this.ownership }
        : undefined;
    const result = await connectSessionWindow({
      targetId,
      target,
      current,
      acquireOwnership: acquireWindowOwnership,
      connectRuntime: (selectedTarget) => PlasticityRuntime.connect(selectedTarget),
      createOperations: (runtime) => new PlasticityOperations(runtime),
    });
    this.runtime = result.connection.runtime;
    this.operations = result.connection.operations;
    this.ownership = result.connection.ownership;
    this.targetId = result.connection.targetId;
    if (current !== result.connection) this.snapshots.clear();
    return result.state;
  }

  get(): PlasticityOperations {
    if (!this.operations) throw new Error("Connect to an explicit Plasticity window first");
    return this.operations;
  }

  capabilities(): {
    bindings: string[];
    operations: ReturnType<PlasticityOperations["constructionCapabilities"]>;
  } {
    if (!this.runtime) throw new Error("Connect to an explicit Plasticity window first");
    return { bindings: this.runtime.getCapabilities(), operations: this.get().constructionCapabilities() };
  }

  async captureSnapshot(label?: string) {
    if (!this.runtime) throw new Error("Connect to an explicit Plasticity window first");
    await this.runtime.reconnect();
    const state = await this.get().state();
    const construction = await this.get().listConstructionGeometry();
    const datums: TrackedDatum[] = [...construction.points, ...construction.axes]
      .filter((datum) => datum.documentToken === state.documentToken && datum.revision === state.revision)
      .map((datum) => ({ ...datum.identity, kind: datum.kind }));
    const snapshotId = randomUUID();
    const snapshot = { label: label ?? null, capturedAt: new Date().toISOString(), state, datums };
    this.snapshots.set(snapshotId, snapshot);
    while (this.snapshots.size > 32) {
      const oldest = this.snapshots.keys().next().value as string | undefined;
      if (!oldest) break;
      this.snapshots.delete(oldest);
    }
    return { snapshotId, ...snapshot };
  }

  async changesSince(snapshotId: string) {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) throw new Error(`Unknown or expired scene snapshot: ${snapshotId}`);
    if (!this.runtime) throw new Error("Connect to an explicit Plasticity window first");
    await this.runtime.reconnect();
    const current = await this.get().state();
    return {
      snapshotId,
      label: snapshot.label,
      capturedAt: snapshot.capturedAt,
      diff: diffScenes(snapshot.state, current, snapshot.datums),
      selection: await this.get().selection(),
      current,
    };
  }

  async waitForChange(snapshotId: string, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    do {
      const result = await this.changesSince(snapshotId);
      if (result.diff.sceneChanged) return { timedOut: false, ...result };
      if (Date.now() >= deadline) return { timedOut: true, ...result };
      await new Promise((resolve) => setTimeout(resolve, Math.min(750, deadline - Date.now())));
    } while (true);
  }

  async close(): Promise<void> {
    this.runtime?.close();
    await this.ownership?.release();
    this.runtime = undefined;
    this.operations = undefined;
    this.ownership = undefined;
    this.targetId = undefined;
    this.snapshots.clear();
  }
}

export interface SessionLike {
  windows(): Promise<Array<{ id: string; title: string; url: string }>>;
  connect(targetId: string): Promise<unknown>;
  get(): PlasticityOperations;
  capabilities(): {
    bindings: string[];
    operations: ReturnType<PlasticityOperations["constructionCapabilities"]>;
  };
  captureSnapshot(label?: string): Promise<unknown>;
  changesSince(snapshotId: string): Promise<unknown>;
  waitForChange(snapshotId: string, timeoutMs: number): Promise<unknown>;
  close?(): void | Promise<void>;
}

export function strengthDependenciesForSession(
  session: SessionLike,
  options: {
    store?: StrengthStore;
    femReports?: FemReportStore;
    cohesiveReports?: CohesiveReportStore;
    analysis?: AnalysisClient | null;
    analysisUnavailableReason?: string;
    referenceSearch?: ReferenceSearchClient | null;
    referenceSearchUnavailableReason?: string;
  } = {},
): StrengthDependencies {
  const store = options.store ?? new StrengthStore();
  const femReports = options.femReports ?? new FemReportStore();
  const cohesiveReports = options.cohesiveReports ?? new CohesiveReportStore();
  return {
    store,
    femReports,
    cohesiveReports,
    analysis: options.analysis ?? null,
    ...(options.analysisUnavailableReason === undefined ? {} : { analysisUnavailableReason: options.analysisUnavailableReason }),
    referenceSearch: options.referenceSearch ?? null,
    ...(options.referenceSearchUnavailableReason === undefined ? {} : { referenceSearchUnavailableReason: options.referenceSearchUnavailableReason }),
    async inspectMember(request) {
      return await session.get().inspectRectangularMember(request);
    },
    async inspectIntegralPlate(request) {
      return await session.get().inspectIntegralRectangularPlate(request);
    },
    async inspectSection(request) {
      return await session.get().inspectPlanarSection(request);
    },
    async inspectArbitrarySection(request) {
      return await session.get().inspectArbitrarySection(request);
    },
    async inspectFastenerPlate(request) {
      return await session.get().inspectSingleFastenerPlate(request);
    },
    async readCadBinding(bodyId): Promise<CadBinding> {
      const operations = session.get();
      const state = await operations.state();
      if (!state.bodies.some((body) => body.id === bodyId)) throw new Error(`Unknown body ID: ${bodyId}`);
      return {
        sessionId: operations.datumRegistry.sessionId,
        documentToken: state.documentToken,
        revision: state.revision,
        bodyId,
      };
    },
    async readSectionBinding(request) {
      const operations = session.get();
      const state = await operations.state();
      const evidence = await operations.inspectPlanarSection({ ...request, revision: state.revision });
      return evidence.binding;
    },
    async readFastenerBinding(request) {
      const operations = session.get();
      const state = await operations.state();
      const evidence = await operations.inspectSingleFastenerPlate({ ...request, revision: state.revision });
      return evidence.binding;
    },
    async inspectFastenerGroup(request) {
      return await session.get().inspectFastenerGroup(request);
    },
    async inspectFastenerGroupLayout(request) {
      return await session.get().inspectFastenerGroupLayout(request);
    },
    async readFastenerGroupBinding(request) {
      const operations = session.get();
      const state = await operations.state();
      const evidence = await operations.inspectFastenerGroup({ ...request, revision: state.revision });
      return evidence.binding;
    },
    async analyzeStaticFem(input, workspace, signal) {
      return await analyzeStaticSolid(session.get(), input, workspace, signal);
    },
    async analyzeCohesive(input: CohesiveAnalysisRequest, workspace, signal) {
      return await analyzeCohesiveInterface(session.get(), input, workspace, {
        interfaceTests: store.materialInterfaceTests,
        coupons: store.materialQualifications,
      }, signal);
    },
  };
}

export function createServer(
  session?: SessionLike,
  suppliedStrength?: StrengthDependencies,
  threadQualifications?: PrintedThreadQualificationStore,
  stepImportReferences?: StepImportReferenceStore,
  constructionHistory?: ConstructionHistoryStore | null,
  stepReferenceDownloader?: StepReferenceDownloaderLike,
): McpServer {
  return createServerWithCatalog("full", session, suppliedStrength, threadQualifications, stepImportReferences, constructionHistory, stepReferenceDownloader);
}

export function createCompactServer(...args: Parameters<typeof createServer>): McpServer {
  return createServerWithCatalog("compact", ...args);
}

function createServerWithCatalog(
  catalogMode: ToolCatalogMode,
  session: SessionLike = new PlasticitySession(),
  suppliedStrength?: StrengthDependencies,
  threadQualifications: PrintedThreadQualificationStore = new PrintedThreadQualificationStore(),
  stepImportReferences: StepImportReferenceStore = new StepImportReferenceStore(process.env.PLASTICITY_REFERENCE_ROOT),
  constructionHistory: ConstructionHistoryStore | null = new ConstructionHistoryStore(process.env.PLASTICITY_CONSTRUCTION_HISTORY_ROOT),
  stepReferenceDownloader: StepReferenceDownloaderLike = new StepReferenceDownloader(process.env.PLASTICITY_REFERENCE_ARTIFACT_ROOT
    ? { root: process.env.PLASTICITY_REFERENCE_ARTIFACT_ROOT }
    : {}),
): McpServer {
  const server = new McpServer({ name: "plasticity-mcp", version: "0.2.1" }, { instructions: PLASTICITY_MCP_INSTRUCTIONS });
  const strength = suppliedStrength ?? strengthDependenciesForSession(session, {
    analysisUnavailableReason: "The isolated Codex analysis profile was not initialized by this server launcher",
  });
  const journal: JournalEntry[] = [];
  const journalPersistenceWarnings: Array<{ id: string; error: string }> = [];
  const namedSelections = new Map<string, NamedSelection>();
  const closeServer = server.close.bind(server);
  server.close = async () => {
    await strength.analysis?.close();
    await strength.referenceSearch?.close();
    await session.close?.();
    await closeServer();
  };
  type ToolResult = ReturnType<typeof result>;
  type ToolExtra = {
    _meta?: { progressToken?: string | number };
    sendNotification(notification: {
      method: "notifications/progress";
      params: { progressToken: string | number; progress: number; message?: string };
    }): Promise<void>;
  };
  type RegisterTool = (
    name: string,
    config: {
      title?: string;
      description: string;
      inputSchema: z.ZodType;
      annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
    },
    callback: (input: unknown, extra: ToolExtra) => Promise<ToolResult>,
  ) => unknown;
  type RoutedTool = {
    name: string;
    description: string;
    inputSchema: z.ZodType;
    annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
    callback: (input: unknown, extra: ToolExtra) => Promise<ToolResult>;
  };
  const routedTools = new Map<string, RoutedTool>();
  const rawRegisterTool = server.registerTool.bind(server) as unknown as RegisterTool;
  (server as unknown as { registerTool: RegisterTool }).registerTool = (name, config, callback) => {
    const registered = exposeDirectTool(catalogMode, name) ? rawRegisterTool(name, config, callback) : undefined;
    routedTools.set(name, { name, description: config.description, inputSchema: config.inputSchema, annotations: config.annotations, callback });
    return registered;
  };
  const registerTool = server.registerTool.bind(server) as unknown as RegisterTool;
  const plasticityCallSchema = z.object({
    toolName: z.string().trim().min(1).max(128).default("catalog"),
    arguments: z.record(z.string(), z.unknown()).default({}),
    query: z.string().trim().min(1).max(200).optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(25).default(10),
  }).strict();
  rawRegisterTool("plasticity_call", {
    title: "Plasticity tool catalog and dispatcher",
    description: "Browse the bounded catalog of registered Plasticity MCP operations or invoke one by its exact tool name. Use toolName='catalog' with query/offset/limit to read descriptions and JSON input schemas; set toolName to a returned operation name and pass its arguments object to invoke it. Only registered MCP operations are callable; the selected operation's original Zod schema and safety checks are applied. This is not JavaScript execution.",
    inputSchema: plasticityCallSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async (rawInput, extra) => {
    const input = plasticityCallSchema.parse(rawInput);
    if (input.toolName !== "catalog") {
      const selected = routedTools.get(input.toolName);
      if (!selected || input.toolName === "plasticity_call") throw new Error(`Unknown Plasticity MCP operation: ${input.toolName}`);
      const parsedArguments = await selected.inputSchema.parseAsync(input.arguments);
      return await selected.callback(parsedArguments, extra);
    }

    const query = input.query?.toLocaleLowerCase();
    const matching = [...routedTools.values()]
      .filter((candidate) => candidate.name !== "plasticity_call")
      .filter((candidate) => !query || candidate.name.toLocaleLowerCase().includes(query) || candidate.description.toLocaleLowerCase().includes(query))
      .sort((left, right) => left.name.localeCompare(right.name));
    const page = matching.slice(input.offset, input.offset + input.limit);
    return result({
      total: matching.length,
      offset: input.offset,
      limit: input.limit,
      nextOffset: input.offset + page.length < matching.length ? input.offset + page.length : null,
      validationNote: "The original server-side Zod schema is authoritative; cross-field refinements may be stricter than the exported JSON Schema.",
      tools: page.map((candidate) => ({
        name: candidate.name,
        description: candidate.description,
        annotations: candidate.annotations,
        inputSchema: z.toJSONSchema(candidate.inputSchema, { unrepresentable: "any" }),
      })),
    });
  });
  let toolTail: Promise<void> = Promise.resolve();
  const exclusive = async <T>(operation: () => Promise<T>): Promise<T> => {
    const prior = toolTail;
    let release: (() => void) | undefined;
    toolTail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      return await operation();
    } finally {
      release?.();
    }
  };
  const persistJournalEntry = async (entry: JournalEntry): Promise<void> => {
    if (!constructionHistory) return;
    const record: ConstructionHistoryEntry = {
      id: entry.id,
      occurredAt: entry.occurredAt,
      operation: entry.operation,
      intent: entry.intent,
      input: JSON.parse(JSON.stringify(entry.input)) as ConstructionHistoryEntry["input"],
      documentToken: entry.documentToken,
      beforeRevision: entry.beforeRevision,
      afterDocumentToken: entry.afterDocumentToken,
      afterRevision: entry.afterRevision,
      status: entry.status,
      error: entry.error?.slice(0, 4_000) ?? null,
      change: entry.diff ?? compactJournalChange(null),
    };
    try {
      await constructionHistory.append(record);
    } catch (error) {
      journalPersistenceWarnings.push({ id: entry.id, error: (error instanceof Error ? error.message : String(error)).slice(0, 1_000) });
      if (journalPersistenceWarnings.length > 20) journalPersistenceWarnings.shift();
    }
  };
  const tool = <T extends z.ZodType>(
    name: string,
    description: string,
    schema: T,
    handler: (input: z.output<T>, extra: ToolExtra) => Promise<unknown>,
    readOnly = false,
    annotationOverrides: Partial<{ readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean }> = {},
  ) => registerTool(name, {
    description,
    inputSchema: schema,
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: false, ...annotationOverrides },
  }, async (input, extra) => {
    const progressToken = extra._meta?.progressToken;
    const startedAt = Date.now();
    const progressTimer = progressToken === undefined ? undefined : setInterval(() => {
      void extra.sendNotification({
        method: "notifications/progress",
        params: {
          progressToken,
          progress: Date.now() - startedAt,
          message: `Plasticity MCP operation ${name} is still running.`,
        },
      }).catch(() => undefined);
    }, 10_000);
    try {
      return result(await exclusive(() => handler(schema.parse(input) as z.output<T>, extra)));
    } finally {
      if (progressTimer) clearInterval(progressTimer);
    }
  });
  const journaled = async <T>(
    operation: string,
    intent: string | undefined,
    input: unknown,
    mutation: () => Promise<T>,
    onCompleted?: (before: RuntimeState, after: RuntimeState) => void,
    stateTimeoutMs = NATIVE_STATE_READ_TIMEOUT_MS,
  ): Promise<T> => {
    const before = await session.get().state(stateTimeoutMs);
    const entry: JournalEntry = {
      id: randomUUID(),
      operation,
      intent: intent ?? null,
      input,
      documentToken: before.documentToken,
      beforeRevision: before.revision,
      afterDocumentToken: null,
      afterRevision: null,
      status: "failed",
      diff: null,
      error: null,
      occurredAt: new Date().toISOString(),
    };
    try {
      const value = await mutation();
      const after = await session.get().state(stateTimeoutMs);
      entry.afterDocumentToken = after.documentToken;
      entry.afterRevision = after.revision;
      entry.status = "completed";
      const sceneDiff = diffScenes(before, after);
      entry.diff = compactJournalChange(sceneDiff);
      journal.push(entry);
      await persistJournalEntry(entry);
      onCompleted?.(before, after);
      return isRuntimeState(value) ? compactMutationResult(after, sceneDiff) : value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      entry.status = /timed?\s*out|(?:socket|connection|transport|session|client)\s+(?:was\s+)?closed|uncertain/i.test(message) ? "unknown" : "failed";
      entry.error = message;
      try {
        const after = await session.get().state(stateTimeoutMs);
        entry.afterDocumentToken = after.documentToken;
        entry.afterRevision = after.revision;
        entry.diff = compactJournalChange(diffScenes(before, after));
      } catch {
        // Preserve the original mutation error. A dead CDP connection may make
        // even this read-only reconciliation snapshot unavailable.
      }
      journal.push(entry);
      await persistJournalEntry(entry);
      throw error;
    }
  };
  type CadReferenceAcquisition = {
    bytes: number;
    finalUrl: string;
    sourceArchive?: { sha256: string; bytes: number; memberPath: string };
  };
  const importCadReference = async (
    path: string,
    format: "step" | "parasolid",
    importFile: (path: string, revision: string) => Promise<RuntimeState>,
    source: z.infer<typeof importedReferenceSourceSchema> | undefined,
    purpose: string | undefined,
    current: string,
    acquisition?: CadReferenceAcquisition,
    expectedHash?: string,
  ) => {
    const referencePath = format === "step" ? await validatedStepPath(path) : await validatedParasolidPath(path);
    const importedArtifactHash = await sha256File(referencePath);
    if (expectedHash && importedArtifactHash !== expectedHash) throw new Error(`Downloaded ${format} artifact changed before native import; inspect the private reference artifact before retrying`);
    const sourceReference = source ? {
      ...source,
      sourceUrl: provenanceSafeUrl(source.sourceUrl),
      ...(source.sourcePageUrl ? { sourcePageUrl: provenanceSafeUrl(source.sourcePageUrl) } : {}),
      artifactHash: importedArtifactHash,
    } : undefined;
    let importSnapshot: { before: RuntimeState; after: RuntimeState } | undefined;
    const state = await journaled(`import-${format}`, purpose, {
      path: referencePath,
      format,
      importedArtifactHash,
      ...(sourceReference ? { sourceReference } : {}),
      ...(acquisition ? { acquisition } : {}),
    }, async () => {
      const imported = await importFile(referencePath, current);
      const postImportHash = await sha256File(referencePath);
      if (postImportHash !== importedArtifactHash) {
        throw new Error(`${format} file changed during import; source identity is uncertain, inspect Plasticity state and construction journal before retrying`);
      }
      return imported;
    }, (before, after) => { importSnapshot = { before, after }; }, LONG_NATIVE_IMPORT_TIMEOUT_MS);
    if (!importSnapshot) throw new Error(`Native ${format} import completed without a captured scene snapshot; reconcile the construction journal before retrying`);
    const { before, after } = importSnapshot;
    const changes = diffScenes(before, after);
    const changedBodies = [...changes.added, ...changes.modified.map((change) => change.after)];
    let referenceRecord: Awaited<ReturnType<typeof stepImportReferences.create>> | undefined;
    let persistenceError: string | undefined;
    try {
      referenceRecord = await stepImportReferences.create({
        artifactHash: importedArtifactHash,
        sourcePath: referencePath,
        format,
        ...(acquisition?.sourceArchive ? { sourceArchive: acquisition.sourceArchive } : {}),
        ...(sourceReference ? { sourceReference } : {}),
        documentToken: after.documentToken,
        revision: after.revision,
        documentTitle: after.title,
        bodies: changedBodies.map((body) => ({
          id: body.id,
          type: body.type,
          name: body.name,
          boundsMm: body.boundsMm,
          faceCount: body.faces.length,
          edgeCount: body.edges.length,
        })),
      });
    } catch (error) {
      persistenceError = error instanceof Error ? error.message : String(error);
    }
    return {
      targetId: state.targetId,
      title: state.title,
      documentToken: state.documentToken,
      revision: state.revision,
      dbVersion: state.dbVersion,
      undoDepth: state.undoDepth,
      redoDepth: state.redoDepth,
      importedFormat: format,
      importedBodyCount: changedBodies.length,
      importedBodyIds: changedBodies.map((body) => body.id),
      importedArtifactHash,
      ...(sourceReference ? { sourceReference } : {}),
      ...(referenceRecord ? { referenceRecordId: referenceRecord.id, provenancePersisted: true } : { provenancePersisted: false, persistenceError }),
      ...(acquisition ? { acquisition } : {}),
    };
  };
  const importStepReference = (
    path: string,
    source: z.infer<typeof importedReferenceSourceSchema> | undefined,
    purpose: string | undefined,
    current: string,
    acquisition?: CadReferenceAcquisition,
    expectedHash?: string,
  ) => importCadReference(path, "step", (inputPath, expectedRevision) => session.get().importStep(inputPath, expectedRevision), source, purpose, current, acquisition, expectedHash);
  const importParasolidReference = (
    path: string,
    source: z.infer<typeof importedReferenceSourceSchema> | undefined,
    purpose: string | undefined,
    current: string,
    acquisition?: CadReferenceAcquisition,
    expectedHash?: string,
  ) => importCadReference(path, "parasolid", (inputPath, expectedRevision) => session.get().importParasolid(inputPath, expectedRevision), source, purpose, current, acquisition, expectedHash);
  const importReferenceThreeMfArtifact = async (
    path: string,
    source: z.infer<typeof importedReferenceSourceSchema> | undefined,
    purpose: string | undefined,
    current: string,
    acquisition?: { bytes: number; finalUrl: string },
    expectedHash?: string,
    expectedDocumentToken?: string,
  ) => {
    const beforeImport = await session.get().state();
    if (beforeImport.revision !== current) throw new Error(`Stale document revision ${current}; current revision is ${beforeImport.revision}`);
    if (expectedDocumentToken && beforeImport.documentToken !== expectedDocumentToken) {
      throw new Error("Plasticity document changed while the 3MF reference was downloading; inspect the document before importing");
    }
    const artifactHash = await sha256File(path);
    if (expectedHash && artifactHash !== expectedHash) throw new Error("Downloaded 3MF reference changed before native import; inspect the private artifact before retrying");
    const sourceReference = source ? {
      ...source,
      sourceUrl: provenanceSafeUrl(source.sourceUrl),
      ...(source.sourcePageUrl ? { sourcePageUrl: provenanceSafeUrl(source.sourcePageUrl) } : {}),
      artifactHash,
      format: "3mf" as const,
      geometryKind: "approximate-reference-mesh" as const,
      unitSource: "embedded-3mf-model-metadata" as const,
      exactGeometry: false as const,
    } : undefined;
    let snapshots: { before: RuntimeState; after: RuntimeState } | undefined;
    const imported = await journaled("import-reference-3mf", purpose, {
      artifactHash,
      ...(sourceReference ? { sourceReference } : {}),
      ...(acquisition ? { acquisition } : {}),
    }, async () => {
      if (await sha256File(path) !== artifactHash) throw new Error("3MF reference changed before native import; inspect it before retrying");
      const state = await session.get().importReference3mf(path, current);
      if (await sha256File(path) !== artifactHash) throw new Error("3MF reference changed during import; inspect Plasticity and construction history before retrying");
      return state;
    }, (before, after) => { snapshots = { before, after }; }, LONG_NATIVE_IMPORT_TIMEOUT_MS);
    if (!snapshots) throw new Error("Native 3MF import completed without a captured scene snapshot; reconcile the construction journal before retrying");
    const previousIds = new Set((snapshots.before.referenceMeshes ?? []).map((mesh) => mesh.id));
    const importedMeshes = (snapshots.after.referenceMeshes ?? []).filter((mesh) => !previousIds.has(mesh.id));
    if (importedMeshes.length === 0 || importedMeshes.some((mesh) => mesh.sourceFormat !== "3mf")) {
      throw new Error("Plasticity 3MF import did not produce identifiable 3MF reference meshes; inspect the document and construction journal before retrying");
    }
    let referenceRecord: Awaited<ReturnType<typeof stepImportReferences.create>> | undefined;
    let persistenceError: string | undefined;
    try {
      referenceRecord = await stepImportReferences.create({
        artifactHash,
        format: "3mf",
        sourcePath: path,
        ...(acquisition ? { acquisition: { bytes: acquisition.bytes, finalUrl: provenanceSafeUrl(acquisition.finalUrl) } } : {}),
        ...(sourceReference ? { sourceReference } : {}),
        documentToken: snapshots.after.documentToken,
        revision: snapshots.after.revision,
        documentTitle: snapshots.after.title,
        bodies: [],
        referenceMeshes: importedMeshes.map((mesh) => ({
          id: mesh.id,
          name: mesh.name,
          sourcePath: mesh.sourcePath,
          boundsMm: mesh.boundsMm,
          vertexEntries: mesh.vertexEntries,
          triangles: mesh.triangles,
        })),
      });
    } catch (error) {
      persistenceError = error instanceof Error ? error.message : String(error);
    }
    return {
      ...imported,
      referenceArtifactHash: artifactHash,
      ...(sourceReference ? { sourceReference } : {}),
      ...(acquisition ? { acquisition } : {}),
      approximateReference: true,
      measurementSource: "reference-mesh",
      importedMeshes,
      ...(referenceRecord ? { referenceRecordId: referenceRecord.id, provenancePersisted: true } : { provenancePersisted: false, persistenceError }),
    };
  };
  const evaluateNamedSelection = (selection: NamedSelection, state: RuntimeState) => {
    if (selection.documentToken !== state.documentToken) {
      return { ...selection, status: "document-changed" as const, matches: [] };
    }
    const matches = selection.kind === "faces"
      ? findFaces(state, selection.query as FaceQuery)
      : findEdges(state, selection.query as EdgeQuery);
    const expected = selection.expectedCount;
    const status = matches.length === 0 || (expected !== null && matches.length < expected)
      ? "unresolved" as const
      : expected !== null && matches.length > expected
        ? "ambiguous" as const
        : "resolved" as const;
    return { ...selection, status, currentRevision: state.revision, matches };
  };

  tool("plasticity_list_windows", "List Plasticity document windows exposed on loopback CDP.", z.object({}), async () =>
    (await session.windows()).map(({ id, title, url }) => ({ targetId: id, title, url })), true);
  tool("plasticity_diagnose", "Report MCP runtime and reachable Plasticity windows without changing a document.", z.object({}), async () =>
    ({ node: process.version, platform: process.platform, architecture: process.arch, supportedPlasticity: "26.1.3", endpoint: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223", windows: await session.windows() }), true);
  tool("plasticity_resolve_fastener_designation", "Interpret a bounded fastening request such as 'крепится на 4 болта M5x10 с гайками' or 'печать винта M6x20 и ответной части'. It defaults to combined strength and geometry intent, parses thread metadata, quantity, selected ISO/DIN head and drive family, explicit joint phrases and fixed/adjustable/pivot intent, and returns one active question package plus compatible Plasticity geometry/strength tools. Its bounded catalog recognizes common hex, socket-cap, button, pan, countersunk and headless set-screw standards with source URLs; set-screw standards also identify flat, truncated-cone, dog, or cup points and require the mating contact function to be resolved. Printed screw, nut, and generic mating-part phrases route to the custom matched-thread tools without importing an ISO pitch. A slot is proposed only for explicit adjustment. It never treats nominal thread diameter as a finished hole, insert pocket, head recess, or nut envelope.", fastenerDesignationInputSchema, async (input) =>
    resolveFastenerDesignation(input), true);
  tool("plasticity_record_printed_thread_qualification", "Persist an immutable physically tested rounded-print-v1 thread fit for one exact printer, material, slicer profile, nozzle, layer height, orientation, and thread definition. Requires explicit confirmation that a real specimen completed full-travel testing; geometric interference checks alone are not accepted. Repeating the same record is idempotent.", printedThreadQualificationInputSchema, async (input) =>
    await threadQualifications.record(input), false, { destructiveHint: false });
  tool("plasticity_list_printed_thread_qualifications", "List immutable local physical thread-fit qualifications, optionally filtered by printer, material, slicer profile, rounded thread dimensions, handedness, or fit class. This registry is available without Workbench and contains no inferred or geometry-only passes.", printedThreadQualificationFilterSchema, async (filter) =>
    ({ source: "immutable-local-physical-test-registry", records: await threadQualifications.list(filter) }), true);
  tool("plasticity_match_printed_thread_qualification", "Find a physical rounded-print-v1 thread-fit qualification for an exact process and thread definition. A record is eligible only when its tested engagement is at least the requested engagement. Conflicting qualified clearances return ambiguous and are never selected silently.", printedThreadQualificationMatchSchema, async (query) =>
    await threadQualifications.match(query), true);
  tool("plasticity_check_fastener_stack", "Check whether the nominal length in an ISO metric screw or bolt designation fits an explicit clamped stack and either a nut or threaded receiver. All layers, nut/washer envelope, engagement, tip clearance, and the product's under-head versus overall length datum remain explicit inputs. This deterministic check does not claim strength, preload, access, fit, or thread-stripping capacity.", fastenerStackInputSchema, async (input) =>
    checkFastenerStack(input), true);
  tool("plasticity_connect", "Connect this MCP process to one explicit Plasticity window and return its compact initial scene summary. Body bounds/counts are paginated; use plasticity_body_info for exact topology of a selected body.", z.object({ targetId: z.string().min(1) }), async ({ targetId }) => {
    const state = await session.connect(targetId);
    if (!isRuntimeState(state)) throw new Error("Plasticity returned an invalid connected document state");
    return compactStatusSummary(state, 0, 50);
  });
  tool("plasticity_status", "Read a compact document summary with identity, revision, exact body bounds, topology counts, and Undo/Redo state. Body summaries are paginated with bodyOffset/bodyLimit (default 0/50, maximum 200); follow bodyPagination.nextOffset and pass the prior page's revision as expectedRevision so scene edits cannot mix pages. Use plasticity_body_info for exact face/edge/vertex geometry of one body, or plasticity_list_bodies for paginated topology details.", z.object({
    bodyOffset: z.number().int().min(0).max(1_000_000).default(0),
    bodyLimit: z.number().int().min(1).max(200).default(50),
    expectedRevision: z.string().min(1).optional(),
  }).strict(), async ({ bodyOffset, bodyLimit, expectedRevision }) => {
    const state = await session.get().state();
    if (expectedRevision !== undefined && expectedRevision !== state.revision) {
      throw new Error("CAD revision changed between status pages; restart pagination from bodyOffset 0");
    }
    return compactStatusSummary(state, bodyOffset, bodyLimit);
  }, true);
  tool("plasticity_current_selection", "Read bodies, linked instances, approximate reference meshes, groups, faces, edges, regions, and native Wire boundary/control handles currently selected by the user in Plasticity.", z.object({}), async () =>
    await session.get().selection(), true);
  tool("plasticity_select_bodies", "Replace the current Plasticity selection with stable body IDs.", z.object({ ids, revision }), async ({ ids: bodyIds, revision: current }) =>
    await session.get().selectBodies(bodyIds, current));
  tool("plasticity_select_curves", "Replace the current Plasticity selection with whole native Wire curves, using current revision-bound Wire IDs. The returned curveIds identify selected Wires; bodyIds may also contain the same native Wire IDs.", z.object({ ids, revision }).strict(), async ({ ids: curveIds, revision: current }) =>
    await session.get().selectCurves(curveIds, current));
  tool("plasticity_select_nodes", "Replace the current Plasticity selection with a mixed set of current bodies, linked instances, approximate reference meshes, and native groups so the agent can point out assembly content in the application.", z.object({ ...groupSelectionFields, revision }).strict().superRefine(requireNodeSelection), async ({ bodyIds, instanceIds: currentInstanceIds, referenceMeshIds: currentReferenceMeshIds, groupIds: currentGroupIds, revision: current }) =>
    await session.get().selectNodes(bodyIds, currentInstanceIds, currentReferenceMeshIds, currentGroupIds, current));
  tool("plasticity_select_reference_meshes", "Replace the current Plasticity selection with current imported STL/OBJ reference meshes so the agent and user can point at the same approximate reference objects in the application.", z.object({ ids: referenceMeshIds, revision }).strict(), async ({ ids: currentIds, revision: current }) =>
    await session.get().selectReferenceMeshes(currentIds, current));
  tool("plasticity_select_faces", "Replace the current Plasticity selection with exact revision-bound B-Rep faces so the agent can point out surfaces in the application.", z.object({ faces: z.array(faceRef).min(1).max(4096).refine((values) => new Set(values.map((value) => `${value.bodyId}:${value.faceId}`)).size === values.length, "Face references must be unique"), revision }).strict(), async ({ faces, revision: current }) =>
    await session.get().selectFaces(faces, current));
  tool("plasticity_select_edges", "Replace the current Plasticity selection with exact revision-bound B-Rep edges so the agent can point out boundaries in the application.", z.object({ edges: z.array(edgeRef).min(1).max(4096).refine((values) => new Set(values.map((value) => `${value.bodyId}:${value.edgeId}`)).size === values.length, "Edge references must be unique"), revision }).strict(), async ({ edges, revision: current }) =>
    await session.get().selectEdges(edges, current));
  tool("plasticity_select_curve_control_points", "Replace the current Plasticity selection with revision-bound Wire boundary vertices and interior B-Spline control points so the agent can point out the handles it will edit. References must come from plasticity_list_curve_control_points.", z.object({ points: curveControlPointRefs, revision }).strict(), async ({ points, revision: current }) =>
    await session.get().selectCurveControlPoints(points, current));
  tool("plasticity_align_planar_faces", "Rigidly rotate and move current bodies so the center and normal of one exact planar source face align with a fixed exact planar target face. The opposed relation seats outward face normals against each other; same keeps them parallel. Positive gap is measured from the target along its outward normal. The normal-to-normal rotation is the shortest rotation and does not independently align in-plane edges. All moving bodies preserve their relative placement and the alignment occupies one native Undo step.", z.object({
    ids: z.array(z.number().int().positive()).min(1).max(4096).refine((values) => new Set(values).size === values.length, "Moving body IDs must be unique"),
    sourceFace: faceRef,
    targetFace: faceRef,
    relation: z.enum(["opposed", "same"]).default("opposed"),
    gapMm: z.number().finite().default(0),
    intent,
    revision,
  }).strict(), async ({ ids: bodyIds, sourceFace, targetFace, relation, gapMm, intent: purpose, revision: current }) =>
    await journaled("align-planar-faces", purpose, { bodyIds, sourceFace, targetFace, relation, gapMm }, () => session.get().alignPlanarFaces(bodyIds, sourceFace, targetFace, relation, gapMm, current)));
  tool("plasticity_align_cylindrical_faces", "Rigidly align exact native cylinder axes for one or more moving bodies in one Undo step. The preserve mode removes only transverse axis offset and keeps the cluster's axial position; anchor aligns the source axis origin to the target origin plus a signed axial offset along the target axis. The same/opposed relation controls axis direction, and an optional rotation around the fixed target axis controls roll. This is a direct placement, not a persistent concentric constraint.", cylindricalAlignmentInputSchema, async ({ ids: bodyIds, sourceFace, targetFace, relation, axialMode, axialOffsetMm, rotationAroundAxisDeg, intent: purpose, revision: current }) =>
    await journaled("align-cylindrical-faces", purpose, { bodyIds, sourceFace, targetFace, relation, axialMode, axialOffsetMm, rotationAroundAxisDeg }, () => session.get().alignCylindricalFaces(bodyIds, sourceFace, targetFace, relation, axialMode, axialOffsetMm, rotationAroundAxisDeg, current)));
  tool("plasticity_align_vertices", "Rigidly translate one or more moving bodies so one exact current B-Rep source vertex reaches a fixed target vertex plus an explicit world-space millimeter offset. The moving bodies retain their relative placement and the operation occupies one Undo step. This is direct placement, not a persistent coincident constraint.", vertexAlignmentInputSchema, async ({ ids: bodyIds, sourceVertex, targetVertex, offsetMm, intent: purpose, revision: current }) =>
    await journaled("align-vertices", purpose, { bodyIds, sourceVertex, targetVertex, offsetMm }, () => session.get().alignVertices(bodyIds, sourceVertex, targetVertex, offsetMm, current)));
  tool("plasticity_align_linear_edges", "Rigidly align one exact native Line edge from a moving body set to a fixed Line edge in one Undo step. Source and target edge midpoints are aligned with an optional signed axial offset along the fixed target tangent; same/opposed controls tangent direction, and rotationAroundAxisDeg controls roll around the fixed target line. Re-read the exact edges after placement because native edge parameter direction is topological, not a semantic assembly direction.", linearEdgeAlignmentInputSchema, async ({ ids: bodyIds, sourceEdge, targetEdge, relation, axialOffsetMm, rotationAroundAxisDeg, intent: purpose, revision: current }) =>
    await journaled("align-linear-edges", purpose, { bodyIds, sourceEdge, targetEdge, relation, axialOffsetMm, rotationAroundAxisDeg }, () => session.get().alignLinearEdges(bodyIds, sourceEdge, targetEdge, relation, axialOffsetMm, rotationAroundAxisDeg, current)));
  tool("plasticity_check_interference", "Check explicit pairs of current Solid bodies for exact volumetric interference by intersecting native B-Rep clones in a temporary database. The check does not change the document or Undo history. A no-volumetric-interference result does not distinguish touching from separation and is not a minimum-clearance measurement.", bodyInterferenceInputSchema, async ({ pairs, revision: current }) =>
    await session.get().checkInterference(pairs, current), true);
  tool("plasticity_measure_solid_properties", "Measure exact native B-Rep volume, surface area, and volume centroid for one or more current Solid bodies without changing the document or Undo history. Totals include the volume-weighted centroid. This is geometric evidence; physical mass still requires an explicit qualified density.", solidPropertiesInputSchema, async ({ ids: bodyIds, revision: current }) =>
    await session.get().measureSolidProperties(bodyIds, current), true);
  tool("plasticity_measure_face_properties", "Measure exact native B-Rep area, full trimmed boundary length, area centroid, surface type, and outer/inner loop counts for selected current Solid or Sheet faces without changing the document or Undo history. Totals include the area-weighted centroid; summed boundary length counts shared edges independently for each selected face.", facePropertiesInputSchema, async ({ faces, revision: current }) =>
    await session.get().measureFaceProperties(faces, current), true);
  tool("plasticity_capture_snapshot", "Capture an in-memory scene baseline before manual edits. Returns only the snapshot ID, document/revision identity and object counts; use that ID with plasticity_changes_since or plasticity_wait_for_change.", z.object({ label: z.string().trim().min(1).max(120).optional() }), async ({ label }) =>
    compactSceneSnapshot(await session.captureSnapshot(label)), true);
  const sceneChangeInput = z.object({
    snapshotId: z.string().uuid(),
    bodyOffset: z.number().int().min(0).max(1_000_000).default(0),
    bodyLimit: z.number().int().min(1).max(100).default(20),
    expectedRevision: z.string().min(1).optional(),
  });
  tool("plasticity_changes_since", "Return a structured diff from a captured scene baseline. Exact changed-body B-Rep descriptors are summarized and paginated (bodyOffset default 0, bodyLimit default 20, maximum 100); follow bodyPagination.nextOffset with expectedRevision set to current.revision. Use plasticity_body_info for detailed topology of selected bodies. The diff also reports sketch Regions, construction planes, materials, visibility, instances, groups, and selection. Check sceneChanged for a reportable scene edit; revisionChanged can be true without a reportable scene diff.", sceneChangeInput, async ({ snapshotId, bodyOffset, bodyLimit, expectedRevision }) =>
    compactSceneChanges(await session.changesSince(snapshotId), bodyOffset, bodyLimit, expectedRevision), true);
  tool("plasticity_wait_for_change", "Wait for a reportable scene edit, then return a compact paginated diff. Revision-only advances do not end the wait. Follow bodyPagination.nextOffset with expectedRevision set to current.revision; use plasticity_body_info for detailed topology of selected bodies.", sceneChangeInput.extend({ timeoutMs: z.number().int().min(0).max(30_000).default(5_000) }), async ({ snapshotId, bodyOffset, bodyLimit, expectedRevision, timeoutMs }) =>
    compactSceneChanges(await session.waitForChange(snapshotId, timeoutMs), bodyOffset, bodyLimit, expectedRevision), true);
  tool("plasticity_list_bodies", "List exact native B-Rep body details with topology IDs. Results are paginated (bodyOffset default 0, bodyLimit default 10, maximum 100); follow bodyPagination.nextOffset and pass the previous page's revision as expectedRevision so edits cannot mix pages. Prefer plasticity_body_info when only one body is needed. Cone faces also report native basis radius, axis origin/direction, and semi-angle in radians when Plasticity provides them.", z.object({
    bodyOffset: z.number().int().min(0).max(1_000_000).default(0),
    bodyLimit: z.number().int().min(1).max(100).default(10),
    expectedRevision: z.string().min(1).optional(),
  }).strict(), async ({ bodyOffset, bodyLimit, expectedRevision }) => {
    const state = await session.get().state();
    if (expectedRevision !== undefined && expectedRevision !== state.revision) {
      throw new Error("CAD revision changed between body pages; restart pagination from bodyOffset 0");
    }
    const bodies = state.bodies.slice(bodyOffset, bodyOffset + bodyLimit);
    return {
      targetId: state.targetId,
      title: state.title,
      documentToken: state.documentToken,
      revision: state.revision,
      bodies,
      bodyPagination: {
        offset: bodyOffset,
        limit: bodyLimit,
        total: state.bodies.length,
        nextOffset: bodyOffset + bodies.length < state.bodies.length ? bodyOffset + bodies.length : null,
      },
    };
  }, true);
  tool("plasticity_list_regions", "List revision-bound planar regions generated by closed coplanar curves.", z.object({}), async () =>
    await session.get().listRegions(), true);
  tool("plasticity_list_curve_fragments", "List exact revision-bound curve fragments created by native intersections.", z.object({}), async () =>
    await session.get().listCurveFragments(), true);
  tool("plasticity_list_curve_endpoints", "List exact revision-bound endpoints of open native Wire bodies.", z.object({}), async () =>
    await session.get().listCurveEndpoints(), true);
  tool("plasticity_list_curve_vertices", "List every exact native Wire vertex with its body, position, endpoint flag, and adjacent native segment entity IDs. Use the returned revision-bound bodyId/vertexId pairs to select profile corners for curve filleting.", z.object({}), async () =>
    await session.get().listCurveVertices(), true);
  tool("plasticity_list_curve_directions", "List exact start/end points and tangents for every native Wire segment.", z.object({}), async () =>
    await session.get().listCurveDirections(), true);
  tool("plasticity_evaluate_curve_segments", "Evaluate exact native positions and unit tangents at normalized parameters from 0 to 1 on current Wire segments. Parameters follow each segment's start-to-end direction from plasticity_list_curve_directions. This is read-only and is useful for placing or verifying local curve edits.", z.object({ samples: z.array(curveSegmentSampleSchema).min(1).max(256), revision }).strict(), async ({ samples, revision: current }) =>
    await session.get().evaluateCurveSegments(samples, current), true);
  tool("plasticity_inspect_curve_structure", "Read compact exact native B-Rep structure for selected current Wire bodies: segment type and length, analytic Circle center/radius/normal, plus NURBS degree, control-point count, Plasticity's raw span count, active normalized span count, carrier-knot parameters mapped into each segment's normalized coordinates, multiplicities, rationality, and periodicity when available. Periodic native span count can include wrapped extension knots; activeSpanCount counts only intervals across the normalized edge. A knot with withinSegment=false belongs to the underlying carrier outside that trimmed segment.", z.object({ ids: curveIds, revision }).strict(), async ({ ids: wireIds, revision: current }) =>
    await session.get().inspectCurveStructure(wireIds, current), true);
  tool("plasticity_inspect_surface_structure", "Read compact exact native B-Rep structure for selected current Solid or Sheet faces without changing the document: carrier surface type, whether the face is trimmed, face and natural UV parameter bounds, plus B-Surface degrees, span counts, control-point counts, and rationality. UV values are native parameters rather than millimeter distances.", z.object({ faces: surfaceFaceRefs, revision }).strict(), async ({ faces, revision: current }) =>
    await session.get().inspectSurfaceStructure(faces, current), true);
  tool("plasticity_inspect_curve_planarity", "Ask the native B-Rep kernel whether each selected current Wire is exactly planar and return its native plane origin and normal when available.", z.object({ ids: curveIds, revision }).strict(), async ({ ids: wireIds, revision: current }) =>
    await session.get().inspectCurvePlanarity(wireIds, current), true);
  tool("plasticity_list_curve_control_points", "List every editable native control handle for selected current Wire bodies. Boundary vertices and interior B-Spline control points are returned separately with revision-bound references, positions in millimeters, and native local positive-U/negative-U unit slide directions. Handle positions and directions come from Plasticity's native editor representation; use exact B-Rep measurements to validate the resulting curve geometry.", z.object({ ids: curveIds, revision }).strict(), async ({ ids: wireIds, revision: current }) =>
    await session.get().listCurveControlPoints(wireIds, current), true);
  tool("plasticity_list_curve_intersections", "List exact revision-bound native intersections between Wire bodies.", z.object({}), async () =>
    await session.get().listCurveIntersections(), true);
  tool("plasticity_body_info", "Read one body from the current document revision.", z.object({ id: z.number().int().positive() }), async ({ id }) => {
    const state = await session.get().state();
    const body = state.bodies.find((candidate) => candidate.id === id);
    if (!body) throw new Error(`Unknown body ID: ${id}`);
    return { documentToken: state.documentToken, revision: state.revision, measurementSource: "native-brep", body };
  }, true);
  tool("plasticity_inspect_fastener_group", "Read exact in-plane centers and diameters from two or more explicitly selected cylindrical faces on one current Solid. The returned revision-bound native B-Rep evidence and assignments can be passed into fastener-group load distribution; coaxial duplicate faces, stale references, and axes not normal to the supplied frame are rejected.", fastenerGroupInspectionInputSchema, async (request) =>
    await session.get().inspectFastenerGroup(request), true);
  tool("plasticity_check_fastener_group_layout", "Measure and optionally check a fastener group on one exact rectangular planar face. Returns center-to-edge and hole-edge distances, every pair's center spacing and remaining ligament, plus clearance for supplied circular head, washer, nut, or driver envelopes. Optionally provide opposedFaceId to verify the matching perforated opposite face and exact native B-rep plate thickness. A pass is returned only when explicit layout requirements with a recorded basis are supplied. Geometry verification remains a layout check, not a strength or tool-motion analysis.", fastenerGroupLayoutInputSchema, async (request) =>
    await session.get().inspectFastenerGroupLayout(request), true);
  tool("plasticity_find_faces", "Find current B-Rep faces semantically by body, surface type, normal, radius, center, bounds, edge count, or adjacency.", z.object({ revision, query: faceQuerySchema }), async ({ revision: expected, query }) => {
    const state = await session.get().state();
    if (state.revision !== expected) throw new Error(`Stale reference: expected revision ${expected}, current revision is ${state.revision}`);
    const matches = findFaces(state, query);
    return { documentToken: state.documentToken, revision: state.revision, measurementSource: "native-brep", count: matches.length, matches };
  }, true);
  tool("plasticity_find_edges", "Find current B-Rep edges semantically by body, curve type, direction, exact length, center, bounds, or adjacent faces.", z.object({ revision, query: edgeQuerySchema }), async ({ revision: expected, query }) => {
    const state = await session.get().state();
    if (state.revision !== expected) throw new Error(`Stale reference: expected revision ${expected}, current revision is ${state.revision}`);
    const matches = findEdges(state, query);
    return { documentToken: state.documentToken, revision: state.revision, measurementSource: "native-brep", count: matches.length, matches };
  }, true);
  tool("plasticity_save_named_selection", "Save a semantic face or edge query and re-evaluate it after topology changes.", z.discriminatedUnion("kind", [
    z.object({ name: z.string().trim().min(1).max(120), kind: z.literal("faces"), query: faceQuerySchema, expectedCount: z.number().int().positive().max(4096).optional(), revision }).strict(),
    z.object({ name: z.string().trim().min(1).max(120), kind: z.literal("edges"), query: edgeQuerySchema, expectedCount: z.number().int().positive().max(4096).optional(), revision }).strict(),
  ]), async ({ name, kind, query, expectedCount, revision: expected }) => {
    const state = await session.get().state();
    if (state.revision !== expected) throw new Error(`Stale reference: expected revision ${expected}, current revision is ${state.revision}`);
    if ([...namedSelections.values()].some((selection) => selection.name === name && selection.documentToken === state.documentToken)) {
      throw new Error(`Named selection already exists in this document: ${name}`);
    }
    const selection: NamedSelection = {
      id: randomUUID(),
      name,
      kind,
      query,
      expectedCount: expectedCount ?? null,
      documentToken: state.documentToken,
      createdRevision: state.revision,
      createdAt: new Date().toISOString(),
    };
    namedSelections.set(selection.id, selection);
    return evaluateNamedSelection(selection, state);
  });
  tool("plasticity_list_named_selections", "Re-evaluate all semantic named selections against the current document revision.", z.object({}), async () => {
    const state = await session.get().state();
    return {
      documentToken: state.documentToken,
      revision: state.revision,
      selections: [...namedSelections.values()].map((selection) => evaluateNamedSelection(selection, state)),
    };
  }, true);
  tool("plasticity_delete_named_selection", "Delete one MCP semantic named selection without changing Plasticity geometry.", z.object({ selectionId: z.string().uuid() }).strict(), async ({ selectionId }) => {
    if (!namedSelections.delete(selectionId)) throw new Error(`Unknown named selection: ${selectionId}`);
    return { deleted: selectionId };
  });
  tool("plasticity_construction_history", "Read the private local construction-event history, including operation inputs, outcomes and compact added/removed/modified B-Rep measurements. History survives MCP restarts and does not require a connected Plasticity window. Use offset/limit for paging; records are historical and never authorize replay.", z.object({ offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(20) }).strict(), async ({ offset, limit }) => constructionHistory
    ? await constructionHistory.list(offset, limit)
    : { total: 0, offset, limit, entries: [] }, true);
  tool("plasticity_construction_journal", "Read current-process MCP mutation inputs and compact B-Rep change measurements in pages. This does not replay commands. The response also detects document changes made outside the journal and compares the live document against the last durable construction event.", z.object({ offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(20) }).strict(), async ({ offset, limit }) => {
    const current = await session.get().state();
    const completed = journal.filter((entry) => entry.status === "completed");
    const head = completed.at(-1);
    const syncStatus = !head
      ? "empty"
        : (head.afterDocumentToken ?? head.documentToken) !== current.documentToken
        ? "document-changed"
        : head.afterRevision === current.revision
          ? "in-sync"
          : "manual-edit-detected";
    let historyReadError: string | undefined;
    let history: Awaited<ReturnType<ConstructionHistoryStore["list"]>> = { total: 0, offset: 0, limit: 1, entries: [] };
    try {
      if (constructionHistory) history = await constructionHistory.list(0, 1);
    } catch (error) {
      historyReadError = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
    }
    const latestDurable = history.entries[0];
    const durableSyncStatus = historyReadError
      ? "history-unavailable"
      : !latestDurable
      ? "empty"
      : latestDurable.status === "unknown"
        || latestDurable.afterDocumentToken === null
        || latestDurable.afterRevision === null
        || (latestDurable.status === "failed" && latestDurable.change.changed)
        ? "unknown-outcome-requires-inspection"
        : latestDurable.afterDocumentToken !== null && latestDurable.afterDocumentToken !== current.documentToken
          ? "document-changed"
          : latestDurable.afterRevision === current.revision
            ? "in-sync"
            : "manual-edit-detected";
    return {
      documentToken: current.documentToken,
      revision: current.revision,
      syncStatus,
      durableSyncStatus,
      latestDurableEvent: latestDurable ?? null,
      journalPersistenceWarnings: [
        ...journalPersistenceWarnings,
        ...(historyReadError ? [{ id: "history-read", error: historyReadError }] : []),
      ],
      entries: journal.slice(offset, offset + limit),
      journalPagination: {
        offset,
        limit,
        total: journal.length,
        nextOffset: offset + limit < journal.length ? offset + limit : null,
      },
    };
  }, true);
  const importReferenceListInput = z.object({ offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(20) }).strict();
  const listImportReferences = async ({ offset, limit }: { offset: number; limit: number }) => {
    const page = await stepImportReferences.list(offset, limit);
    return {
      ...page,
    records: page.records.map(({ id, importedAt, artifactHash, format, sourcePath, sourceArchive, sourceReference, documentToken, revision: importedRevision, documentTitle, bodies, referenceMeshes }) => ({
        id, importedAt, artifactHash, ...(format ? { format } : {}), sourcePath, ...(sourceArchive ? { sourceArchive } : {}), ...(sourceReference ? { sourceReference } : {}),
        documentToken, revision: importedRevision, documentTitle, bodyCount: bodies.length, ...(referenceMeshes ? { referenceMeshCount: referenceMeshes.length } : {}),
        historical: true as const,
      })),
    };
  };
  for (const name of ["plasticity_list_cad_reference_imports", "plasticity_list_step_imports"] as const) {
    tool(name, "List persistent CAD reference import provenance records (STEP, Parasolid, and approximate 3MF reference meshes) from the local MCP store. Records are historical evidence tied to the document/revision at import time; their body or mesh IDs are not current references. Use offset/limit to page results.", importReferenceListInput, listImportReferences, true);
  }
  const getImportReference = async ({ id }: { id: string }) => ({
    ...(await stepImportReferences.get(id)),
    historical: true as const,
  });
  for (const name of ["plasticity_get_cad_reference_import", "plasticity_get_step_import"] as const) {
    tool(name, "Read one persistent CAD reference import provenance record (STEP, Parasolid, or 3MF). STEP and Parasolid records contain exact native B-Rep measurements; 3MF records contain approximate reference-mesh bounds and topology counts, not editable B-Rep. The record is historical; verify the current scene before using any stored body or mesh ID.", z.object({ id: z.string().uuid() }).strict(), getImportReference, true);
  }
  tool("plasticity_measure", "Measure a body's axis-aligned native B-Rep bounds in millimeters.", z.object({ id: z.number().int().positive() }), async ({ id }) => {
    const state = await session.get().state();
    const body = state.bodies.find((candidate) => candidate.id === id);
    if (!body?.boundsMm) throw new Error(`Body has no native B-Rep bounds: ${id}`);
    return { id, revision: state.revision, source: "native-brep", boundsMm: body.boundsMm, sizeMm: body.boundsMm.max.map((value, index) => value - body.boundsMm!.min[index]!) };
  }, true);
  tool("plasticity_measure_point_distance", "Measure the exact straight-line distance and XYZ delta between two explicit coordinates or current native B-Rep vertices, edge midpoints, or face points. Topology references are revision-bound.", z.object({ first: measurementPointRef, second: measurementPointRef, revision }).strict(), async ({ first, second, revision: current }) =>
    await session.get().measurePointDistance(first, second, current), true);
  tool("plasticity_measure_point_to_linear_edge", "Measure the exact distance from an explicit coordinate or current B-Rep vertex to a finite straight B-Rep edge centerline. Returns the projected point, the clamped closest point on the finite edge, supporting-line distance and finite-segment distance. This is centerline geometry, not minimum clearance to the owning faces or bodies; references are revision-bound.", z.object({ point: measurementPointRef, edge: edgeRef, revision }).strict(), async ({ point, edge, revision: current }) =>
    await session.get().measurePointToLinearEdge(point, edge, current), true);
  tool("plasticity_measure_point_to_curved_edge", "Estimate point distance to a non-linear, non-circular Solid/Sheet B-Rep edge or native Wire segment using an adaptively sampled polyline of native Plasticity edge evaluations. For Solid/Sheet, pass bodyId plus edgeId; for Wire, pass bodyId plus segmentEntityId from plasticity_list_curve_directions. Returns an explicitly approximate closest point/distance, sample count and maximum midpoint chord deviation observed at those samples. `toleranceObserved` only means the sampled deviation criterion was met; it is not a certified global error bound. For dimensions that need exact 0.01 mm proof, use exact line/circle tools or request a more suitable native analytic method; never report this estimate as exact or as body clearance. Current body/topology references are revision-bound.", z.object({ point: measurementPointRef, edge: sampledCurveEdgeRef, requestedToleranceMm: z.number().finite().positive().max(1).default(0.01), maxSegments: z.number().int().min(64).max(8192).default(2048), revision }).strict(), async ({ point, edge, requestedToleranceMm, maxSegments, revision: current }) =>
    await session.get().measurePointToSampledCurveEdge(point, edge, current, requestedToleranceMm, maxSegments), true);
  tool("plasticity_measure_point_to_circular_edge", "Measure exact distance from an explicit coordinate or current B-Rep vertex to a native circular boundary. Use bodyId plus edgeId for Solid/Sheet topology, or bodyId plus segmentEntityId from plasticity_list_curve_directions for a Wire. Returns distance to the supporting circle, minimum distance to the trimmed arc, closest point, normalized arc parameter, and endpoint-clamp status. Requires verified native circle basis and trim samples; unsupported or stale references are rejected. This is distance to the edge curve centerline, not clearance to adjacent faces or the owning body.", z.object({ point: measurementPointRef, edge: circularEdgeMeasurementRef, revision }).strict(), async ({ point, edge, revision: current }) =>
    await session.get().measurePointToCircularEdge(point, edge, current), true);
  tool("plasticity_measure_point_to_planar_face", "Measure the exact minimum distance from an explicit coordinate or current B-Rep vertex to a trimmed planar face. Supports closed polygonal loops, complete circles, and exact trimmed circular arcs, including holes; returns signed supporting-plane distance, minimum distance to the actual trimmed face, closest point, and whether that point lies in the face interior or on a boundary edge. Other curved boundaries, non-planar faces, incomplete topology, and stale references are rejected; this does not measure clearance between two bodies.", z.object({ point: measurementPointRef, face: faceRef, revision }).strict(), async ({ point, face, revision: current }) =>
    await session.get().measurePointToPlanarFace(point, face, current), true);
  tool("plasticity_measure_planar_faces", "Measure the angle between two current planar B-Rep faces and, when parallel, the signed/absolute separation of their infinite supporting planes in millimeters (separationKind='supporting-planes'). It does not test overlap of the trimmed faces or measure their actual gap/clearance; use only when supporting-plane spacing is the intended quantity.", z.object({ first: faceRef, second: faceRef, angularToleranceDeg: z.number().finite().positive().max(10).default(0.01), revision }).strict(), async ({ first, second, angularToleranceDeg, revision: current }) =>
    await session.get().measurePlanarFaces(first, second, current, angularToleranceDeg), true);
  tool("plasticity_measure_parallel_planar_face_clearance", "Measure exact minimum distance between two revision-bound parallel planar B-Rep faces, including polygonal regions, complete circular boundaries and exact trimmed circular arcs (including holes). Computes planar overlap or boundary separation together with the normal plane gap and closest 3D points. Requires parallel faces within 1e-7 degrees and closed boundaries composed of straight edges and exact circular edges, at most 512 edges per face; other curved edges, nonparallel faces, incomplete topology and stale references are rejected rather than approximated. This is face-to-face clearance, not body-to-body collision detection.", z.object({ first: faceRef, second: faceRef, revision }).strict(), async ({ first, second, revision: current }) =>
    await session.get().measureParallelPlanarFaceClearance(first, second, current), true);
  tool("plasticity_measure_nonparallel_planar_polygon_clearance", "Measure exact minimum Euclidean distance between two nonparallel trimmed planar B-Rep faces with simple straight-edged polygon boundaries. Concave outlines, holes and multiple nested/disjoint loops are supported; face regions use even-odd loop filling. Reports exact closest 3D points and zero when the finite face regions intersect. Limits each face to 512 boundary vertices and 4096 exact decomposition triangles. Faces with parallel supporting planes, circular/curved edges, self-intersecting or touching loops, incomplete native topology, or stale references are rejected; use plasticity_measure_parallel_planar_face_clearance for supported circular boundaries. This measures a selected face pair, not whole-body clearance or collision.", z.object({ first: faceRef, second: faceRef, revision }).strict(), async ({ first, second, revision: current }) =>
    await session.get().measureNonparallelPlanarPolygonFaceClearance(first, second, current), true);
  tool("plasticity_measure_fastener_grip_stack", "Measure the exact thickness of 1-64 clamped Solid layers from explicit pairs of parallel native planar faces aligned with the fastener axis. Returns revision-bound gripItems that can be passed directly to plasticity_check_fastener_stack. Washers or other layers must be modeled and selected explicitly.", z.object({ layers: z.array(fastenerGripLayer).min(1).max(64).refine((items) => new Set(items.map((item) => item.id)).size === items.length, "Fastener grip layer IDs must be unique").refine((items) => new Set(items.map((item) => `${item.first.bodyId}:${[item.first.faceId, item.second.faceId].sort().join(":")}`)).size === items.length, "Fastener grip face pairs must be unique"), axis: direction, angularToleranceDeg: z.number().finite().positive().max(10).default(0.01), revision }).strict(), async ({ layers, axis, angularToleranceDeg, revision: current }) =>
    await session.get().measureFastenerGripStack(layers, axis, current, angularToleranceDeg), true);
  tool("plasticity_measure_linear_edges", "Measure the exact angle and closest approach between two current linear B-Rep edges. Returns both infinite supporting-line clearance and the exact distance/closest points between the finite edge centerline segments. Finite-edge distance is centerline geometry only; it is not minimum clearance between the owning faces or bodies.", z.object({ first: edgeRef, second: edgeRef, angularToleranceDeg: z.number().finite().positive().max(10).default(0.01), revision }).strict(), async ({ first, second, angularToleranceDeg, revision: current }) =>
    await session.get().measureLinearEdges(first, second, current, angularToleranceDeg), true);
  tool("plasticity_analyze_edge_curvature", "Sample Plasticity's native B-Rep curvature vector at 100 positions along each selected current edge. Reference Wire segments by bodyId plus segmentEntityId from plasticity_list_curve_directions; reference Solid or Sheet edges by bodyId plus edgeId from state. Returns curvature magnitude in 1/mm, finite radii of curvature in millimeters, extrema locations, and whether any sampled point is straight. This compact sampled analysis does not use the display mesh, does not claim an exact continuous maximum, and does not change the document.", edgeCurvatureInputSchema, async ({ edges, revision: current }) =>
    await session.get().analyzeEdgeCurvature(edges, current), true);
  tool("plasticity_analyze_face_draft", "Sample exact native B-Rep face normals on a finite interior grid and classify each selected Solid or Sheet face as positive, negative, neutral, or mixed draft relative to an explicit pull direction and minimum draft angle. Signed draft is asin(normal dot pull): walls parallel to pull are 0 degrees, outward normals toward pull are positive, and opposite normals are negative. The compact extrema do not prove continuous extrema, mold parting, release paths, or print support requirements.", faceDraftInputSchema, async ({ faces, pullDirection, minimumDraftDeg, samplesPerDirection, revision: current }) =>
    await session.get().analyzeFaceDraft(faces, pullDirection, minimumDraftDeg, samplesPerDirection, current), true);
  tool("plasticity_analyze_surface_continuity", "Sample Plasticity's native B-Rep continuity evaluator at 100 positions along each selected current Solid or Sheet edge shared by exactly two faces. Returns maximum G0 position deviation in millimeters, G1 normal-angle deviation in degrees, Plasticity's dimensionless relative G2 curvature deviation, their locations, and hierarchical G0/G1/G2 tolerance results. This is native surface sampling rather than an exact continuous maximum; it does not use the display mesh and does not change the document.", surfaceContinuityInputSchema, async ({ edges, positionToleranceMm, normalAngleToleranceDeg, relativeCurvatureTolerance, revision: current }) =>
    await session.get().analyzeSurfaceContinuity(edges, current, positionToleranceMm, normalAngleToleranceDeg, relativeCurvatureTolerance), true);
  tool("plasticity_list_measurements", "List native measurements stored in the Plasticity document with stable measurement IDs, current topology targets, and exact values when both targets still resolve.", z.object({}).strict(), async () =>
    await session.get().listMeasurements(), true);
  tool("plasticity_create_vertex_distance_measurement", "Create a persistent native Plasticity point-to-point distance measurement between two current B-Rep vertices. The measurement participates in document Undo/Redo and remains attached to its topology.", z.object({ first: measurementVertexRef, second: measurementVertexRef, name: z.string().trim().min(1).max(120).optional(), intent, revision }).strict(), async ({ first, second, name, intent: purpose, revision: current }) =>
    await journaled("create-vertex-distance-measurement", purpose, { first, second, name }, () => session.get().createVertexDistanceMeasurement(first, second, name, current)), false, { destructiveHint: false });
  tool("plasticity_create_topology_distance_measurement", "Create a persistent native Plasticity point-to-point distance measurement between two current Solid or Sheet topology points. Each endpoint may be an exact vertex, edge midpoint, or face center. The measurement remains attached to topology, participates in Undo/Redo, and is listed with stable measurement and topology identities.", z.object({ first: topologyMeasurementPointRef, second: topologyMeasurementPointRef, name: z.string().trim().min(1).max(120).optional(), intent, revision }).strict(), async ({ first, second, name, intent: purpose, revision: current }) =>
    await journaled("create-topology-distance-measurement", purpose, { first, second, name }, () => session.get().createTopologyDistanceMeasurement(first, second, name, current)), false, { destructiveHint: false });
  tool("plasticity_create_radius_measurement", "Create a persistent native Plasticity radius measurement on one exact current circular edge. Reference a Wire segment by bodyId plus segmentEntityId from plasticity_list_curve_directions, or a Solid/Sheet edge by bodyId plus edgeId from state. The measurement remains attached to topology, participates in Undo/Redo, and plasticity_list_measurements reports both radius and derived diameter in millimeters.", z.object({ edge: z.union([edgeRef, curvatureWireSegmentRef]), name: z.string().trim().min(1).max(120).optional(), intent, revision }).strict(), async ({ edge, name, intent: purpose, revision: current }) =>
    await journaled("create-radius-measurement", purpose, { edge, name }, () => session.get().createRadiusMeasurement(edge, name, current)), false, { destructiveHint: false });
  tool("plasticity_delete_measurement", "Delete one current native Plasticity measurement by stable measurement ID through document Undo/Redo history.", z.object({ id: z.number().int().positive(), intent, revision }).strict(), async ({ id, intent: purpose, revision: current }) =>
    await journaled("delete-measurement", purpose, { id }, () => session.get().deleteMeasurement(id, current)));
  tool("plasticity_list_section_analyses", "List the active native Plasticity viewport section plane, including its session-stable analysis ID, origin, clipped-half-space normal, visibility, and number of viewports using it. This reads the section currently applied by Plasticity shading state; sections are viewport state and do not modify B-Rep or Undo history.", z.object({}).strict(), async () =>
    await session.get().listSectionAnalyses(), true);
  tool("plasticity_create_section_analysis", "Apply a native Plasticity section plane to the current viewport from a world-space origin and normal. The normal points toward the half-space to clip. An optional nonparallel xDirection sets the plane helper orientation; otherwise MCP derives one. Plasticity supports one active section plane at a time; delete it before applying another. The change is immediately visible in Plasticity and changes the MCP revision, but does not modify B-Rep or Undo history.", z.object({ originMm: vector, normal: direction, xDirection: direction.optional(), name: z.string().trim().min(1).max(120).optional(), intent, revision }).strict(), async ({ originMm, normal, xDirection, name, intent: purpose, revision: current }) =>
    await journaled("create-section-analysis", purpose, { originMm, normal, xDirection, name }, () => session.get().createSectionAnalysis(originMm, normal, xDirection, name, current)), false, { destructiveHint: false });
  tool("plasticity_delete_section_analysis", "Clear the active native Plasticity section plane by its current session-stable analysis ID. The viewport returns to an unclipped state; B-Rep and Undo history are unchanged, while the MCP revision is updated.", z.object({ id: z.number().int().positive(), intent, revision }).strict(), async ({ id, intent: purpose, revision: current }) =>
    await journaled("delete-section-analysis", purpose, { id }, () => session.get().deleteSectionAnalysis(id, current)), false, { destructiveHint: false });
  tool("plasticity_list_instances", "List current native linked instances, their revision-bound IDs, source bodies, and exact transforms. Instance geometry remains linked to its source until realized.", z.object({}).strict(), async () =>
    await session.get().listInstances(), true);
  tool("plasticity_create_instance", "Create one native linked instance from a current source body, optionally translated in millimeters. Later source-body edits propagate through the instance.", z.object({ bodyId: z.number().int().positive(), translationMm: vector.default([0, 0, 0]), intent, revision }).strict(), async ({ bodyId, translationMm, intent: purpose, revision: current }) =>
    await journaled("create-instance", purpose, { bodyId, translationMm }, () => session.get().createInstance(bodyId, translationMm, current)), false, { destructiveHint: false });
  tool("plasticity_duplicate_bodies", "Create independent exact native copies of current Solid or Sheet bodies, preserve every source, and translate the complete copied set by an explicit world-space millimeter delta in one Plasticity history step. The copies receive new stable body IDs and are ordinary editable B-Rep bodies rather than linked instances. A zero translation deliberately creates coincident copies.", z.object({ ids: uniqueBodyIds, translationMm: vector.default([0, 0, 0]), intent, revision }).strict(), async ({ ids: bodyIds, translationMm, intent: purpose, revision: current }) =>
    await journaled("duplicate-bodies", purpose, { ids: bodyIds, translationMm }, () => session.get().duplicateBodies(bodyIds, translationMm, current)), false, { destructiveHint: false });
  tool("plasticity_move_instances", "Move current native linked instances by a world-space millimeter delta without changing their source geometry.", z.object({ ids: instanceIds, deltaMm: vector, intent, revision }).strict(), async ({ ids: currentIds, deltaMm, intent: purpose, revision: current }) =>
    await journaled("move-instances", purpose, { ids: currentIds, deltaMm }, () => session.get().moveInstances(currentIds, deltaMm, current)));
  tool("plasticity_rotate_instances", "Rotate current native linked instances around a world-space pivot and axis. The angle is in degrees.", z.object({ ids: instanceIds, pivotMm: vector, axis: direction, degrees: z.number().finite(), intent, revision }).strict(), async ({ ids: currentIds, pivotMm, axis, degrees, intent: purpose, revision: current }) =>
    await journaled("rotate-instances", purpose, { ids: currentIds, pivotMm, axis, degrees }, () => session.get().rotateInstances(currentIds, pivotMm, axis, degrees, current)));
  tool("plasticity_scale_instances", "Scale current native linked instances around a world-space pivot with positive XYZ factors, preserving their link to the source geometry.", z.object({ ids: instanceIds, pivotMm: vector, factors: positiveVector, intent, revision }).strict(), async ({ ids: currentIds, pivotMm, factors, intent: purpose, revision: current }) =>
    await journaled("scale-instances", purpose, { ids: currentIds, pivotMm, factors }, () => session.get().scaleInstances(currentIds, pivotMm, factors, current)));
  tool("plasticity_realize_instances", "Convert current linked instances into independent native Plasticity bodies. Use this before an instance needs geometry edits, Boolean operations, or independent fabrication changes.", z.object({ ids: instanceIds, intent, revision }).strict(), async ({ ids: currentIds, intent: purpose, revision: current }) =>
    await journaled("realize-instances", purpose, { ids: currentIds }, () => session.get().realizeInstances(currentIds, current)));
  tool("plasticity_delete_instances", "Delete current native linked instances through Plasticity Undo/Redo history without deleting their source bodies.", z.object({ ids: instanceIds, intent, revision }).strict(), async ({ ids: currentIds, intent: purpose, revision: current }) =>
    await journaled("delete-instances", purpose, { ids: currentIds }, () => session.get().deleteInstances(currentIds, current)));
  tool("plasticity_list_reference_meshes", "List imported STL/OBJ reference meshes with stable IDs, source paths, approximate world-space bounds, buffer counts, and transforms. Reference-mesh bounds come from tessellated data and are never native B-Rep dimensional proof.", z.object({}).strict(), async () =>
    await session.get().listReferenceMeshes(), true);
  tool("plasticity_move_reference_meshes", "Move current approximate STL/OBJ reference meshes by a world-space millimeter delta in one Plasticity history step.", z.object({ ids: referenceMeshIds, deltaMm: vector, intent, revision }).strict(), async ({ ids: currentIds, deltaMm, intent: purpose, revision: current }) =>
    await journaled("move-reference-meshes", purpose, { ids: currentIds, deltaMm }, () => session.get().moveReferenceMeshes(currentIds, deltaMm, current)));
  tool("plasticity_rotate_reference_meshes", "Rotate current approximate STL/OBJ reference meshes around an explicit world-space pivot and nonzero axis. The angle is in degrees and the edit occupies one Plasticity history step.", z.object({ ids: referenceMeshIds, pivotMm: vector, axis: direction, degrees: z.number().finite(), intent, revision }).strict(), async ({ ids: currentIds, pivotMm, axis, degrees, intent: purpose, revision: current }) =>
    await journaled("rotate-reference-meshes", purpose, { ids: currentIds, pivotMm, axis, degrees }, () => session.get().rotateReferenceMeshes(currentIds, pivotMm, axis, degrees, current)));
  tool("plasticity_scale_reference_meshes", "Scale current approximate STL/OBJ reference meshes around an explicit world-space pivot with positive XYZ factors in one Plasticity history step. Re-read the returned mesh bounds; scaling does not make the source dimensionally authoritative.", z.object({ ids: referenceMeshIds, pivotMm: vector, factors: positiveVector, intent, revision }).strict(), async ({ ids: currentIds, pivotMm, factors, intent: purpose, revision: current }) =>
    await journaled("scale-reference-meshes", purpose, { ids: currentIds, pivotMm, factors }, () => session.get().scaleReferenceMeshes(currentIds, pivotMm, factors, current)));
  tool("plasticity_delete_reference_meshes", "Delete current approximate STL/OBJ reference meshes through Plasticity Undo/Redo history without touching native B-Rep bodies.", z.object({ ids: referenceMeshIds, intent, revision }).strict(), async ({ ids: currentIds, intent: purpose, revision: current }) =>
    await journaled("delete-reference-meshes", purpose, { ids: currentIds }, () => session.get().deleteReferenceMeshes(currentIds, current)));
  tool("plasticity_rename_reference_mesh", "Rename one current imported STL/OBJ reference mesh through Plasticity document history.", z.object({ id: z.number().int().nonnegative(), name: z.string().trim().min(1).max(120), intent, revision }).strict(), async ({ id, name, intent: purpose, revision: current }) =>
    await journaled("rename-reference-mesh", purpose, { id, name }, () => session.get().renameReferenceMesh(id, name, current)));
  tool("plasticity_list_groups", "List the current native Plasticity group hierarchy, active group, direct body, linked-instance, and reference-mesh members, visibility, and lock state.", z.object({}).strict(), async () =>
    await session.get().listGroups(), true);
  tool("plasticity_create_group", "Create one native Plasticity group around the supplied current bodies, linked instances, approximate reference meshes, or child groups. The root Scene group cannot be nested.", z.object({ ...groupSelectionFields, name: z.string().trim().min(1).max(120).optional(), intent, revision }).strict().superRefine(requireNodeSelection), async ({ bodyIds, instanceIds: currentInstanceIds, referenceMeshIds: currentReferenceMeshIds, groupIds: currentGroupIds, name, intent: purpose, revision: current }) =>
    await journaled("create-group", purpose, { bodyIds, instanceIds: currentInstanceIds, referenceMeshIds: currentReferenceMeshIds, groupIds: currentGroupIds, name }, () => session.get().createGroup(bodyIds, currentInstanceIds, currentReferenceMeshIds, currentGroupIds, name, current)), false, { destructiveHint: false });
  tool("plasticity_move_to_group", "Move current bodies, linked instances, approximate reference meshes, or whole child groups into an existing destination group in one native history step. Group cycles are rejected.", z.object({ ...groupSelectionFields, destinationGroupId: z.number().int().nonnegative(), intent, revision }).strict().superRefine(requireNodeSelection), async ({ bodyIds, instanceIds: currentInstanceIds, referenceMeshIds: currentReferenceMeshIds, groupIds: currentGroupIds, destinationGroupId, intent: purpose, revision: current }) =>
    await journaled("move-to-group", purpose, { bodyIds, instanceIds: currentInstanceIds, referenceMeshIds: currentReferenceMeshIds, groupIds: currentGroupIds, destinationGroupId }, () => session.get().moveToGroup(bodyIds, currentInstanceIds, currentReferenceMeshIds, currentGroupIds, destinationGroupId, current)));
  tool("plasticity_rename_group", "Rename one current non-root native Plasticity group through document history.", z.object({ id: z.number().int().positive(), name: z.string().trim().min(1).max(120), intent, revision }).strict(), async ({ id, name, intent: purpose, revision: current }) =>
    await journaled("rename-group", purpose, { id, name }, () => session.get().renameGroup(id, name, current)));
  tool("plasticity_activate_group", "Make a current native Plasticity group the active destination for newly created objects. Use group ID 0 to return creation to the root Scene group.", z.object({ id: z.number().int().nonnegative(), intent, revision }).strict(), async ({ id, intent: purpose, revision: current }) =>
    await journaled("activate-group", purpose, { id }, () => session.get().activateGroup(id, current)));
  tool("plasticity_dissolve_groups", "Dissolve current non-root Plasticity groups and promote their contents to each parent without deleting the contained geometry.", z.object({ ids: z.array(z.number().int().positive()).min(1).max(4096).refine((values) => new Set(values).size === values.length, "Group IDs must be unique"), intent, revision }).strict(), async ({ ids: currentIds, intent: purpose, revision: current }) =>
    await journaled("dissolve-groups", purpose, { ids: currentIds }, () => session.get().dissolveGroups(currentIds, current)));
  tool("plasticity_set_visibility", "Set exact native visibility for current bodies, linked instances, approximate reference meshes, or groups. Hidden geometry remains in the document and can be restored with the same tool.", z.object({ ...groupSelectionFields, visible: z.boolean(), intent, revision }).strict().superRefine(requireNodeSelection), async ({ bodyIds, instanceIds: currentInstanceIds, referenceMeshIds: currentReferenceMeshIds, groupIds: currentGroupIds, visible, intent: purpose, revision: current }) =>
    await journaled("set-visibility", purpose, { bodyIds, instanceIds: currentInstanceIds, referenceMeshIds: currentReferenceMeshIds, groupIds: currentGroupIds, visible }, () => session.get().setNodeVisibility(bodyIds, currentInstanceIds, currentReferenceMeshIds, currentGroupIds, visible, current)));
  tool("plasticity_set_locked", "Set the native Plasticity lock state for current bodies, linked instances, approximate reference meshes, or groups. Locked geometry remains readable but resists manual selection and editing.", z.object({ ...groupSelectionFields, locked: z.boolean(), intent, revision }).strict().superRefine(requireNodeSelection), async ({ bodyIds, instanceIds: currentInstanceIds, referenceMeshIds: currentReferenceMeshIds, groupIds: currentGroupIds, locked, intent: purpose, revision: current }) =>
    await journaled("set-locked", purpose, { bodyIds, instanceIds: currentInstanceIds, referenceMeshIds: currentReferenceMeshIds, groupIds: currentGroupIds, locked }, () => session.get().setNodeLocked(bodyIds, currentInstanceIds, currentReferenceMeshIds, currentGroupIds, locked, current)));
  tool("plasticity_validate_bodies", "Run Plasticity's native B-Rep Check and report exact topology closure and solid printability for current revision-bound bodies.", z.object({ ids, revision }).strict(), async ({ ids: bodyIds, revision: current }) =>
    await session.get().validateBodies(bodyIds, current), true);
  tool("plasticity_capabilities", "Page through native renderer bindings found in Plasticity 26.1.3. Defaults to 100 bindings per page; filter by case-insensitive substring with query. Returns total and matching counts plus nextOffset so large binding lists do not flood MCP context.", z.object({
    query: z.string().trim().min(1).max(200).optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(250).default(100),
  }).strict(), async ({ query, offset, limit }) => {
    const capabilities = session.capabilities();
    const normalizedQuery = query?.toLowerCase();
    const filtered = normalizedQuery
      ? capabilities.bindings.filter((binding) => binding.toLowerCase().includes(normalizedQuery))
      : capabilities.bindings;
    const bindings = filtered.slice(offset, offset + limit);
    const nextOffset = offset + bindings.length < filtered.length ? offset + bindings.length : null;
    return {
      totalBindings: capabilities.bindings.length,
      matchingBindings: filtered.length,
      offset,
      limit,
      bindings,
      nextOffset,
      operations: capabilities.operations,
    };
  }, true);
  tool("plasticity_reconcile", "Read the document after a timeout or disconnect and allow later mutations without retrying the uncertain command.", z.object({}), async () =>
    await session.get().runtime.reconcile(), true);
  tool("plasticity_list_appearance_materials", "List Plasticity document appearance materials and each body's assigned material ID. These visual properties are not manufacturing or strength evidence.", z.object({}).strict(), async () =>
    await session.get().listAppearanceMaterials(), true);

  tool("plasticity_define_datum_point", "Define a revision-bound point from coordinates or exact current topology.", z.object({ definition: datumPointDefinitionSchema, revision, intent }).strict(), async ({ definition, revision: current, intent: purpose }) =>
    await journaled("define-datum-point", purpose, { definition }, () => session.get().defineDatumPoint(definition, current)), false, { destructiveHint: false });
  tool("plasticity_define_datum_axis", "Define a revision-bound axis from points, coordinates, a linear edge, or a cylindrical face.", z.object({ definition: datumAxisDefinitionSchema, revision, intent }).strict(), async ({ definition, revision: current, intent: purpose }) =>
    await journaled("define-datum-axis", purpose, { definition }, () => session.get().defineDatumAxis(definition, current)), false, { destructiveHint: false });
  tool("plasticity_create_construction_plane", "Create a native saved construction plane from an exact plane definition.", z.object({ definition: constructionPlaneDefinitionSchema, name: z.string().trim().min(1).max(120).optional(), revision, intent }).strict(), async ({ definition, name, revision: current, intent: purpose }) =>
    await journaled("create-construction-plane", purpose, { definition, name }, () => session.get().createConstructionPlane(definition, name, current)));
  tool("plasticity_list_construction_geometry", "List session datums and current standard and saved construction planes.", z.object({}).strict(), async () =>
    await session.get().listConstructionGeometry(), true);
  tool("plasticity_set_workplane", "Activate a current construction plane in the selected Plasticity window.", z.object({ plane: referenceIdentitySchema, intent }).strict(), async ({ plane, intent: purpose }) =>
    await journaled("set-workplane", purpose, { plane }, () => session.get().setConstructionWorkplane(plane)));
  tool("plasticity_remove_construction_plane", "Remove one current saved construction plane. Standard planes are protected.", z.object({ plane: referenceIdentitySchema, intent }).strict(), async ({ plane, intent: purpose }) =>
    await journaled("remove-construction-plane", purpose, { plane }, () => session.get().removeConstructionPlane(plane)));
  tool("plasticity_refresh_datum", "Re-resolve a geometry-backed datum after a document revision change.", z.object({ reference: referenceIdentitySchema, intent }).strict(), async ({ reference, intent: purpose }) =>
    await journaled("refresh-datum", purpose, { reference }, () => session.get().refreshDatum(reference)), false, { destructiveHint: false });

  tool("plasticity_create_box", "Create an axis-aligned exact CAD box. Coordinates and size are millimeters.", z.object({ originMm: vector, sizeMm: positiveVector, name: z.string().trim().min(1).max(120).optional(), intent, revision }), async ({ originMm, sizeMm, name, intent: purpose, revision: current }) =>
    await journaled("create-box", purpose, { originMm, sizeMm, name }, () => session.get().createBox(originMm, sizeMm, name, current)));
  tool("plasticity_create_cylinder", "Create an exact CAD cylinder along a world-space axis. Dimensions are millimeters.", z.object({ centerMm: vector, radiusMm: z.number().finite().positive(), heightMm: z.number().finite().positive(), axis: direction.default([0, 0, 1]), name: z.string().trim().min(1).max(120).optional(), intent, revision }), async ({ centerMm, radiusMm, heightMm, axis, name, intent: purpose, revision: current }) =>
    await journaled("create-cylinder", purpose, { centerMm, radiusMm, heightMm, axis, name }, () => session.get().createCylinder(centerMm, radiusMm, heightMm, name, current, axis)));
  tool("plasticity_create_cone", "Create an exact cone or conical frustum Solid and preserve its editable meridional polyline profile in one Plasticity history step. The bottom center, unequal bottom and top radii, height, axis, and nonparallel radial direction are explicit. Use topRadiusMm=0 for a pointed cone and plasticity_create_cylinder when the radii are equal.", z.object({
    bottomCenterMm: vector,
    bottomRadiusMm: z.number().finite().positive(),
    topRadiusMm: z.number().finite().nonnegative(),
    heightMm: z.number().finite().positive(),
    axis: direction.default([0, 0, 1]),
    radialDirection: direction.default([1, 0, 0]),
    name: z.string().trim().min(1).max(120).optional(),
    intent,
    revision,
  }).strict(), async ({ bottomCenterMm, bottomRadiusMm, topRadiusMm, heightMm, axis, radialDirection, name, intent: purpose, revision: current }) =>
    await journaled("create-cone", purpose, { bottomCenterMm, bottomRadiusMm, topRadiusMm, heightMm, axis, radialDirection, name }, () =>
      session.get().createCone(bottomCenterMm, bottomRadiusMm, topRadiusMm, heightMm, axis, radialDirection, name, current)));
  tool("plasticity_create_torus", "Create an exact ring torus Solid and preserve its editable native circular profile in one Plasticity history step. Center, major radius to the tube centerline, minor tube radius, symmetry axis, and radial zero direction are explicit; the major radius must exceed the minor radius.", z.object({
    centerMm: vector,
    majorRadiusMm: z.number().finite().positive(),
    minorRadiusMm: z.number().finite().positive(),
    axis: direction.default([0, 0, 1]),
    radialDirection: direction.default([1, 0, 0]),
    name: z.string().trim().min(1).max(120).optional(),
    intent,
    revision,
  }).strict(), async ({ centerMm, majorRadiusMm, minorRadiusMm, axis, radialDirection, name, intent: purpose, revision: current }) =>
    await journaled("create-torus", purpose, { centerMm, majorRadiusMm, minorRadiusMm, axis, radialDirection, name }, () =>
      session.get().createTorus(centerMm, majorRadiusMm, minorRadiusMm, axis, radialDirection, name, current)));
  tool("plasticity_create_countersink", "Cut an exact through hole with a concentric conical countersink into one Solid. The caller supplies the finished through diameter, major diameter, included angle, material depth, and an in-plane radial direction from the selected standard or manufacturer record. The recipe preserves its editable annular meridional Wire and records through cutter, profile, Revolve, and Boolean as four native history steps.", countersinkInputSchema, async ({ intent: purpose, ...input }) =>
    await journaled("recipe-countersink", purpose, input, () => new PlasticityRecipes(session.get()).createCountersink(input)));
  tool("plasticity_create_countersink_pattern", "Cut 2-64 equal through holes with concentric conical countersinks at explicit entry centers on one current Solid. Each center creates a through cutter and an editable meridional Wire revolved into a countersink cutter; one final Boolean consumes every cutter while preserving the source Wires. Finished dimensions must come from the selected fastener standard, fit, process, and actual material depth.", countersinkPatternInputSchema, async ({ intent: purpose, ...input }) =>
    await journaled("recipe-countersink-pattern", purpose, input, () => new PlasticityRecipes(session.get()).createCountersinkPattern(input)));
  tool("plasticity_create_hex_nut_pocket", "Cut an exact blind regular-hex pocket into one Solid. Across-flats size, pocket depth, material depth, orientation, and clearance must come from the selected nut, manufacturing process, and access requirements; nominal thread diameter is not used as pocket geometry. The profile Wire remains editable and the recipe records profile, Extrude, and Boolean as three native history steps.", hexNutPocketInputSchema, async ({ intent: purpose, ...input }) =>
    await journaled("recipe-hex-nut-pocket", purpose, input, () => new PlasticityRecipes(session.get()).createHexNutPocket(input)));
  tool("plasticity_create_hex_nut_pocket_pattern", "Cut 2-128 equal blind regular-hex nut pockets at explicit entry centers on one current Solid. Each center creates one editable profile and one extruded cutter; one final Boolean consumes every cutter while preserving the source Wires. Across-flats size, depth, orientation, clearance, and material depth must come from the selected nut and manufacturing process.", hexNutPocketPatternInputSchema, async ({ intent: purpose, ...input }) =>
    await journaled("recipe-hex-nut-pocket-pattern", purpose, input, () => new PlasticityRecipes(session.get()).createHexNutPocketPattern(input)));
  tool("plasticity_create_printed_external_thread", "Create a standalone exact one-start rounded thread intended for a matched printed part. It creates and preserves a native Helix, forms the ridge with Pipe and Boolean, and clips the result to the explicit crest diameter and length. Nominal diameter is geometry only: this rounded-print profile is not an ISO metric thread and needs printer/material/profile-qualified depth and pitch.", printedExternalThreadInputSchema, async ({ intent: purpose, ...input }) =>
    await journaled("recipe-printed-external-thread", purpose, input, () => new PrintedThreadRecipes(session.get()).createExternalThread(input)));
  tool("plasticity_cut_printed_internal_thread", "Cut an exact one-start rounded internal thread into one current Solid for a matched printed external thread. The bore, helical groove, normal profile clearance, material depth and overshoot are explicit. This custom rounded-print profile is not an ISO tap and must not be assumed compatible from an M designation alone.", printedInternalThreadInputSchema, async ({ intent: purpose, ...input }) =>
    await journaled("recipe-printed-internal-thread", purpose, input, () => new PrintedThreadRecipes(session.get()).cutInternalThread(input)));
  tool("plasticity_create_printed_hex_nut", "Create an exact extruded hex nut with a matched one-start rounded internal print thread. Across-flats size, thickness, minimum remaining wall, pitch, depth and normal profile clearance are explicit; the source hex Wire and Helix remain editable. It is a custom printed mating part, not an ISO nut unless a separate verified standard-profile workflow is used.", printedHexNutInputSchema, async ({ intent: purpose, ...input }) =>
    await journaled("recipe-printed-hex-nut", purpose, input, () => new PrintedThreadRecipes(session.get()).createHexNut(input)));
  tool("plasticity_create_printed_hex_screw", "Create an exact wrenchable hex-head screw with a standalone one-start rounded print thread. The thread is clipped to its explicit crest envelope and joined to an overlapping hex head; the source head Wire and Helix remain editable. This is a custom matched print profile and is not ISO metric hardware solely because its crest diameter is named M5 or similar.", printedHexScrewInputSchema, async ({ intent: purpose, ...input }) =>
    await journaled("recipe-printed-hex-screw", purpose, input, () => new PrintedThreadRecipes(session.get()).createHexScrew(input)));
  tool("plasticity_create_printed_hex_pair", "Create a complete matched printable hex screw and nut from a designation such as 'printed M5x10 pair'. The designation supplies only crest diameter and screw thread length; pitch, rounded-profile depth, normal clearance, head and nut envelopes remain explicit and shared. Printer, material, slicer profile, nozzle, layer height, orientation, clearance evidence and sizing basis are recorded. An optional immutable physical qualification ID is checked against the exact process, thread definition, clearance, and required engagement before mutation. Without it, the result remains marked as requiring a physical fit test. This custom rounded-print-v1 pair is not ISO metric hardware.", printedHexPairInputSchema, async ({ designation, process, sizingBasis, qualificationId, intent: purpose, ...input }) => {
    const resolved = resolveFastenerDesignation({
      designation,
      jointIntent: "printed-threaded-pair",
      mountingIntent: "fixed",
      analysisIntent: "geometry",
      decisionMode: "agent-may-select-qualified",
    });
    const nominalDiameterMm = resolved.thread.nominalDiameterMm;
    const threadLengthMm = resolved.lengthMm;
    if (resolved.issues.some((issue) => issue.code === "JOINT_INTENT_CONFLICT")) {
      throw new Error("Printed pair designation conflicts with a different receiving feature; resolve the joint intent before modifying CAD");
    }
    if (resolved.standard !== undefined) {
      throw new Error("Printed pair designation must not name an ISO, DIN, or GOST hardware standard; this tool creates only a custom rounded-print pair");
    }
    if (nominalDiameterMm === undefined || threadLengthMm === undefined || resolved.ambiguousTrailingValueMm !== undefined) {
      throw new Error("Printed pair designation must contain an unambiguous M-like crest diameter and screw length, for example M5x10");
    }
    if (resolved.thread.pitchMm !== undefined && Math.abs(resolved.thread.pitchMm - input.pitchMm) > 1e-9) {
      throw new Error(`Printed pair designation pitch ${resolved.thread.pitchMm} mm does not match the explicit custom profile pitch ${input.pitchMm} mm`);
    }
    let fitQualification: { status: "requires-physical-fit-test" } | { status: "user-qualified-physical-fit"; recordId: string; fitClass: string; testedEngagementLengthMm: number; cyclesCompleted: number } = { status: "requires-physical-fit-test" };
    if (qualificationId !== undefined) {
      const qualification = await threadQualifications.get(qualificationId);
      if (!qualification) throw new Error(`Unknown printed-thread qualification ID: ${qualificationId}`);
      const requiredEngagementLengthMm = Math.min(threadLengthMm, input.nutThicknessMm);
      const matching = await threadQualifications.match({
        process,
        thread: {
          profile: "rounded-print-v1",
          nominalCrestDiameterMm: nominalDiameterMm,
          pitchMm: input.pitchMm,
          threadDepthMm: input.threadDepthMm,
          handedness: input.handedness,
        },
        requiredEngagementLengthMm,
      });
      if (!matching.records.some((record) => record.id === qualificationId)) {
        throw new Error(`Printed-thread qualification ${qualificationId} does not match the exact process, thread definition, or required ${requiredEngagementLengthMm} mm engagement`);
      }
      if (Math.abs(qualification.profileClearanceMm - input.profileClearanceMm) > 1e-9) {
        throw new Error(`Printed-thread qualification clearance ${qualification.profileClearanceMm} mm does not match the requested ${input.profileClearanceMm} mm`);
      }
      fitQualification = {
        status: "user-qualified-physical-fit",
        recordId: qualification.id,
        fitClass: qualification.fitClass,
        testedEngagementLengthMm: qualification.testedEngagementLengthMm,
        cyclesCompleted: qualification.cyclesCompleted,
      };
    }
    const pair = await journaled("recipe-printed-hex-pair", purpose, { designation, nominalDiameterMm, threadLengthMm, process, sizingBasis, qualificationId, ...input }, () =>
      new PrintedThreadRecipes(session.get()).createHexPair({ ...input, nominalDiameterMm, threadLengthMm }));
    return {
      ...pair,
      designation: {
        original: designation,
        normalizedCustomDesignation: `custom-rounded Ø${nominalDiameterMm}×P${input.pitchMm}×L${threadLengthMm}`,
        nominalCrestDiameterMm: nominalDiameterMm,
        threadLengthMm,
      },
      process,
      sizingBasis,
      fitQualification,
    };
  });
  tool("plasticity_create_printed_thread_calibration_set", "Create one custom rounded-print-v1 hex screw and 2-8 separate hex nuts with explicit, unique normal profile clearances. Use this process-specific clearance ladder before choosing the working fit for a printer, material, slicing profile, and orientation. The result remains unqualified until the specimens are physically printed and tested; it is not ISO metric hardware even when the crest diameter is written like M5.", printedThreadCalibrationInputSchema, async ({ designation, process, sizingBasis, intent: purpose, ...input }) => {
    const resolved = resolveFastenerDesignation({
      designation,
      jointIntent: "printed-threaded-pair",
      mountingIntent: "fixed",
      analysisIntent: "geometry",
      decisionMode: "agent-may-select-qualified",
    });
    const nominalDiameterMm = resolved.thread.nominalDiameterMm;
    const threadLengthMm = resolved.lengthMm;
    if (resolved.issues.some((issue) => issue.code === "JOINT_INTENT_CONFLICT")) {
      throw new Error("Printed calibration designation conflicts with a different receiving feature; resolve the joint intent before modifying CAD");
    }
    if (resolved.standard !== undefined) {
      throw new Error("Printed calibration designation must not name an ISO, DIN, or GOST hardware standard; this tool creates only a custom rounded-print calibration set");
    }
    if (nominalDiameterMm === undefined || threadLengthMm === undefined || resolved.ambiguousTrailingValueMm !== undefined) {
      throw new Error("Printed calibration designation must contain an unambiguous M-like crest diameter and screw length, for example M5x10");
    }
    if (resolved.thread.pitchMm !== undefined && Math.abs(resolved.thread.pitchMm - input.pitchMm) > 1e-9) {
      throw new Error(`Printed calibration designation pitch ${resolved.thread.pitchMm} mm does not match the explicit custom profile pitch ${input.pitchMm} mm`);
    }
    const calibration = await journaled("recipe-printed-thread-calibration-set", purpose, { designation, nominalDiameterMm, threadLengthMm, process, sizingBasis, ...input }, () =>
      new PrintedThreadRecipes(session.get()).createCalibrationSet({ ...input, nominalDiameterMm, threadLengthMm }));
    return {
      ...calibration,
      designation: {
        original: designation,
        normalizedCustomDesignation: `custom-rounded Ø${nominalDiameterMm}×P${input.pitchMm}×L${threadLengthMm}`,
        nominalCrestDiameterMm: nominalDiameterMm,
        threadLengthMm,
      },
      process,
      sizingBasis,
      selectionInstruction: "Physically print the complete set with exactly this process, test full screw travel and the intended reuse/load behavior, then record the selected sample ID and profile clearance in the manufacturing profile before creating production geometry.",
    };
  });
  tool("plasticity_create_slotted_hole", "Cut an exact straight through-slot with semicircular ends into one Solid. Overall length includes the round ends and must exceed width; entry center, in-plane slot direction, cutting axis, material depth, positive edge distance, and clearance-adjusted finished dimensions are explicit. Exact tangency to an exterior boundary is invalid. The editable center profile remains and five native history steps are returned.", slottedHoleInputSchema, async ({ intent: purpose, ...input }) =>
    await journaled("recipe-slotted-hole", purpose, input, () => new PlasticityRecipes(session.get()).createSlottedHole(input)));
  tool("plasticity_create_slotted_hole_pattern", "Cut 2-64 equal exact straight through-slots with semicircular ends at explicit entry centers on one Solid. Shared in-plane adjustment direction, overall length, finished width, cutting axis, actual material depth, and positive edge distance are explicit; exact tangency to an exterior boundary is invalid. One editable center profile and three cutters are created per slot; one final Boolean yields 4N+1 confirmed history steps.", slottedHolePatternInputSchema, async ({ intent: purpose, ...input }) =>
    await journaled("recipe-slotted-hole-pattern", purpose, input, () => new PlasticityRecipes(session.get()).createSlottedHolePattern(input)));
  tool("plasticity_create_counterbore", "Cut an exact through hole with a concentric flat-bottom counterbore into one Solid. The entry point lies on the target surface and the axis points into it. The recipe uses three explicit native history steps and returns each confirmed revision.", counterboreInputSchema, async ({ intent: purpose, ...input }) =>
    await journaled("recipe-counterbore", purpose, input, () => new PlasticityRecipes(session.get()).createCounterbore(input)));
  tool("plasticity_create_counterbore_pattern", "Cut 2-128 equal through holes with concentric flat-bottom counterbores at explicit entry centers on one current Solid. Each center creates one through cutter and one recess cutter; one final Boolean consumes every cutter. Finished dimensions must come from the selected head, fit, manufacturing process, and actual material depth.", counterborePatternInputSchema, async ({ intent: purpose, ...input }) =>
    await journaled("recipe-counterbore-pattern", purpose, input, () => new PlasticityRecipes(session.get()).createCounterborePattern(input)));
  tool("plasticity_create_through_hole", "Cut one exact round through-hole into a current Solid. The entry center lies on the target surface, the axis points into the material, and the finished diameter and material depth must come from the selected fit or qualified process rather than the nominal thread diameter. The cutter and Boolean are two explicit native history steps.", throughHoleInputSchema, async ({ intent: purpose, ...input }) =>
    await journaled("recipe-through-hole", purpose, input, () => new PlasticityRecipes(session.get()).createThroughHole(input)));
  tool("plasticity_create_through_hole_pattern", "Cut 2-256 equal exact round through-holes at explicit entry centers on one current Solid. The shared axis points into the material; finished diameter and material depth must come from the selected fit or qualified process. Each native cylinder is a confirmed history step and one final Boolean consumes every cutter.", throughHolePatternInputSchema, async ({ intent: purpose, ...input }) =>
    await journaled("recipe-through-hole-pattern", purpose, input, () => new PlasticityRecipes(session.get()).createThroughHolePattern(input)));
  tool("plasticity_create_blind_hole", "Cut one exact flat-bottom blind round hole into a current Solid. The entry center lies on the target surface, the axis points into the material, and the explicit finished diameter and depth must come from the selected tap, screw, insert, or qualified process rather than the nominal thread diameter or fastener length. Material depth is required and must exceed hole depth. The cutter and Boolean are two explicit native history steps.", blindHoleInputSchema, async ({ intent: purpose, ...input }) =>
    await journaled("recipe-blind-hole", purpose, input, () => new PlasticityRecipes(session.get()).createBlindHole(input)));
  tool("plasticity_create_blind_hole_pattern", "Cut 2-256 equal exact flat-bottom blind round holes at explicit entry centers on one current Solid. The shared axis points into the material; qualified finished diameter and hole depth are explicit, and material depth must be greater than hole depth. Each native cylinder is a confirmed history step and one final Boolean consumes every cutter.", blindHolePatternInputSchema, async ({ intent: purpose, ...input }) =>
    await journaled("recipe-blind-hole-pattern", purpose, input, () => new PlasticityRecipes(session.get()).createBlindHolePattern(input)));
  tool("plasticity_create_heat_set_insert_pocket", "Cut an exact three-stage pocket for a heat-set insert: a deep pilot, insert bore, and wider shallow lead-in. The entry point lies on the target surface and the axis points into it. Explicit material depth must exceed pilot depth. The recipe uses four explicit native history steps and returns each confirmed revision.", heatSetInsertPocketInputSchema, async ({ intent: purpose, ...input }) =>
    await journaled("recipe-heat-set-insert-pocket", purpose, input, () => new PlasticityRecipes(session.get()).createHeatSetInsertPocket(input)));
  tool("plasticity_create_heat_set_insert_pocket_pattern", "Cut 2-64 equal exact three-stage heat-set-insert pockets at explicit entry centers on one Solid. Qualified pilot, insert-bore, lead-in, and material depths are shared; three native cylinders per center and one final Boolean yield 3N+1 confirmed history steps.", heatSetInsertPocketPatternInputSchema, async ({ intent: purpose, ...input }) =>
    await journaled("recipe-heat-set-insert-pocket-pattern", purpose, input, () => new PlasticityRecipes(session.get()).createHeatSetInsertPocketPattern(input)));
  tool("plasticity_create_screw_boss", "Create an exact cylindrical screw boss joined to an existing Solid, then cut a blind pilot hole from its top. The base point lies on the support surface and the axis points outward. The recipe uses four explicit native history steps and returns each confirmed revision.", screwBossInputSchema, async ({ intent: purpose, ...input }) =>
    await journaled("recipe-screw-boss", purpose, input, () => new PlasticityRecipes(session.get()).createScrewBoss(input)));
  tool("plasticity_create_screw_boss_pattern", "Create 2-64 equal exact cylindrical screw bosses at explicit base centers, join all bosses to one existing Solid in one native union, then cut every blind pilot in one native difference. The shared axis points outward; base overlap gives every boss real union volume. The recipe returns 2N+2 confirmed history steps.", screwBossPatternInputSchema, async ({ intent: purpose, ...input }) =>
    await journaled("recipe-screw-boss-pattern", purpose, input, () => new PlasticityRecipes(session.get()).createScrewBossPattern(input)));
  tool("plasticity_create_rib", "Create an exact rib from a closed coplanar world-space profile, extrude it by a signed thickness, and join it to one existing Solid. The profile Wire remains editable. The recipe uses three explicit native history steps and returns each confirmed revision.", ribInputSchema, async ({ intent: purpose, ...input }) =>
    await journaled("recipe-rib", purpose, input, () => new PlasticityRecipes(session.get()).createRib(input)));
  tool("plasticity_create_round_vent_array", "Cut an exact rectangular array of round through-vents into one Solid. The first center lies on the entry surface, the axis points into it, and both array directions lie in that surface plane. One seed cylinder, one native rectangular pattern, and one Boolean produce up to 400 holes in three history steps.", roundVentArrayInputSchema, async ({ intent: purpose, ...input }) =>
    await journaled("recipe-round-vent-array", purpose, input, () => new PlasticityRecipes(session.get()).createRoundVentArray(input)));
  tool("plasticity_create_cantilever_snap_fit", "Create an exact cantilever snap-fit beam with an integral end hook and join it to one Solid. The base point lies on the support, beam and thickness directions define the profile plane, and width is centered across its normal. The editable profile remains in the document and the recipe uses three native history steps.", cantileverSnapFitInputSchema, async ({ intent: purpose, ...input }) =>
    await journaled("recipe-cantilever-snap-fit", purpose, input, () => new PlasticityRecipes(session.get()).createCantileverSnapFit(input)));
  tool("plasticity_create_hinge_barrel", "Create an exact hollow cylindrical hinge barrel along a world-space axis and join it to one existing Solid. The bore diameter is the finished pin-clearance diameter. The recipe uses four native history steps and returns every confirmed revision.", hingeBarrelInputSchema, async ({ intent: purpose, ...input }) =>
    await journaled("recipe-hinge-barrel", purpose, input, () => new PlasticityRecipes(session.get()).createHingeBarrel(input)));
  tool("plasticity_cut_cable_channel", "Cut one or more exact circular cable channels along current editable Wire paths. The finished channel diameter includes required cable clearance. Native solid Pipe cutters are consumed by one Boolean while source Wires remain in the document. The recipe uses two history steps.", cableChannelInputSchema, async ({ intent: purpose, ...input }) =>
    await journaled("recipe-cable-channel", purpose, input, () => new PlasticityRecipes(session.get()).cutCableChannel(input)));
  tool("plasticity_create_connector_opening", "Cut an exact rectangular or rounded-rectangular connector opening into one Solid. The entry center lies on the target surface, the axis points into it, and width direction lies in that surface. The editable profile remains in the document; native extrusion, optional fillet, and Boolean steps are recorded separately.", connectorOpeningInputSchema, async ({ intent: purpose, ...input }) =>
    await journaled("recipe-connector-opening", purpose, input, () => new PlasticityRecipes(session.get()).createConnectorOpening(input)));
  tool("plasticity_create_mating_enclosure_joint", "Add an exact male lip and clearance-matched female groove to two existing axis-aligned enclosure halves. The seam origin is the lower-left outer corner at the mating plane. All temporary ring solids are consumed and eight native history steps are returned.", matingEnclosureJointInputSchema, async ({ intent: purpose, ...input }) =>
    await journaled("recipe-mating-enclosure-joint", purpose, input, () => new PlasticityRecipes(session.get()).createMatingEnclosureJoint(input)));
  tool("plasticity_create_locating_pin_pair", "Add one exact cylindrical locating pin to a male Solid and cut its clearance-matched socket into a different female Solid. The base center lies on the mating plane and the axis points from the pin into the socket. Radial and axial clearances are explicit millimeter inputs.", locatingPinPairInputSchema, async ({ intent: purpose, ...input }) =>
    await journaled("recipe-locating-pin-pair", purpose, input, () => new PlasticityRecipes(session.get()).createLocatingPinPair(input)));
  tool("plasticity_create_locating_pin_pair_pattern", "Add 2-64 explicit cylindrical locating pins to a male Solid and cut matching radially and axially clearanced sockets into a different female Solid. Centers lie on the mating plane; the axis points from pins into sockets. One native union joins all pins and one native Boolean cuts all sockets. Clearances are exact geometric inputs, not process-qualified print-fit recommendations.", locatingPinPairPatternInputSchema, async ({ intent: purpose, ...input }) =>
    await journaled("recipe-locating-pin-pair-pattern", purpose, input, () => new PlasticityRecipes(session.get()).createLocatingPinPairPattern(input)));
  tool("plasticity_create_split_screw_insert_joint", "Build a split-half fastener pattern in one logical recipe: cut matched clearance holes through the male half, then create exact pilot, heat-set insert, and lead-in pockets from the mating plane into the female half. Supply paired coaxial centers, a resolved headed screw designation and under-head length, exact insert part number and HTTPS source, matching insert thread diameter/pitch, explicit engagement limits, and qualified process-specific pocket dimensions. The tool rejects thread or length mismatches before CAD mutation and verifies that all stations align within 0.01 mm. It does not infer insert geometry, thread capacity, print clearance, head seat, or joint strength.", splitScrewInsertJointInputSchema, async ({ intent: purpose, ...input }) => {
    const resolved = resolveFastenerDesignation({
      designation: input.fastenerDesignation,
      jointIntent: "machine-screw-into-heat-set-insert",
      mountingIntent: "fixed",
      analysisIntent: "geometry",
      decisionMode: "agent-may-select-qualified",
    });
    if (resolved.lengthMm === undefined || Math.abs(resolved.lengthMm - input.screwLengthMm) > 1e-9) {
      throw new Error(`Fastener designation ${input.fastenerDesignation} does not resolve to the explicit ${input.screwLengthMm} mm screw length`);
    }
    if (resolved.status !== "resolved" || resolved.thread.nominalDiameterMm === undefined || resolved.thread.pitchMm === undefined) {
      throw new Error(`Fastener designation ${input.fastenerDesignation} must resolve to an unambiguous metric diameter, pitch, and length`);
    }
    if (Math.abs(resolved.thread.nominalDiameterMm - input.insertThreadNominalDiameterMm) > 1e-9
      || Math.abs(resolved.thread.pitchMm - input.insertThreadPitchMm) > 1e-9) {
      throw new Error("Insert thread diameter and pitch must exactly match the resolved screw designation");
    }
    if (resolved.headStyle === "countersunk") {
      throw new Error("Countersunk fasteners require a separately qualified head-seat operation; this split-joint recipe supports under-head screw lengths only");
    }
    if (resolved.thread.nominalDiameterMm !== undefined && input.holeDiameterMm <= resolved.thread.nominalDiameterMm) {
      throw new Error("Clearance hole diameter must exceed the resolved nominal thread diameter");
    }
    const recipe = await journaled("recipe-split-screw-insert-joint", purpose, input, () => new PlasticityRecipes(session.get()).createSplitScrewInsertJoint(input));
    return { ...recipe, resolvedFastener: { normalizedDesignation: resolved.normalizedDesignation, ...(resolved.standard ? { standard: resolved.standard } : {}), nominalDiameterMm: resolved.thread.nominalDiameterMm, pitchMm: resolved.thread.pitchMm, screwLengthMm: resolved.lengthMm } };
  });
  tool("plasticity_create_tongue_groove_joint", "Add an exact rectangular tongue to one Solid and cut its clearance-matched blind groove into another. The base center lies on the mating plane, the axis points from tongue to groove, and width direction lies in that plane. Both source profiles remain editable.", tongueGrooveJointInputSchema, async ({ intent: purpose, ...input }) =>
    await journaled("recipe-tongue-groove-joint", purpose, input, () => new PlasticityRecipes(session.get()).createTongueGrooveJoint(input)));
  tool("plasticity_create_dovetail_joint", "Create an exact flared trapezoidal male dovetail on one Solid and cut the radially and axially clearance-expanded female socket into another. rootWidthMm is the narrow root, each side flares by flareMm toward the tip, widthDirection lies in the mating plane, and the explicitly supplied clearances are geometric inputs rather than qualified print-fit recommendations. Both editable profiles remain in the document; six native history steps are returned.", dovetailJointInputSchema, async ({ intent: purpose, ...input }) =>
    await journaled("recipe-dovetail-joint", purpose, input, () => new PlasticityRecipes(session.get()).createDovetailJoint(input)));
  tool("plasticity_create_sphere", "Create an exact CAD sphere in millimeters.", z.object({ centerMm: vector, radiusMm: z.number().finite().positive(), name: z.string().trim().min(1).max(120).optional(), intent, revision }), async ({ centerMm, radiusMm, name, intent: purpose, revision: current }) =>
    await journaled("create-sphere", purpose, { centerMm, radiusMm, name }, () => session.get().createSphere(centerMm, radiusMm, name, current)));
  tool("plasticity_create_polyline", "Create a native polyline or closed profile in world coordinates or a referenced construction plane.", polylineInputSchema, async (input) =>
    await journaled("create-polyline", input.intent, { pointsMm: input.pointsMm, closed: input.closed, plane: "plane" in input ? input.plane : undefined }, () =>
      session.get().createPolyline(input.pointsMm, input.closed, input.revision, "plane" in input ? input.plane : undefined)));
  tool("plasticity_create_slot_profiles", "Create exact closed constant-width slot or channel profiles around one or more current planar Wire spines in one native Plasticity history step. Each source Wire is preserved and each result is a separate editable Wire suitable for Region extrusion or cutting. Width is the full finished profile width. A lone straight segment does not define a unique native plane; use a planar multi-segment or curved spine, or use plasticity_create_slotted_hole for a straight fastener slot.", z.object({
    wireIds: z.array(z.number().int().positive()).min(1).max(256).refine((ids) => new Set(ids).size === ids.length, "Wire IDs must be unique"),
    widthMm: z.number().finite().positive(),
    intent,
    revision,
  }).strict(), async ({ wireIds, widthMm, intent: purpose, revision: current }) =>
    await journaled("create-slot-profiles", purpose, { wireIds, widthMm }, () => session.get().createSlotProfiles(wireIds, widthMm, current)));
  tool("plasticity_create_nurbs_curve", "Create a native interpolating NURBS curve through three or more world-space points in millimeters.", z.object({ pointsMm: z.array(vector).min(3).max(1000), closed: z.boolean().default(false), intent, revision }).strict(), async ({ pointsMm, closed, intent: purpose, revision: current }) =>
    await journaled("create-nurbs-curve", purpose, { pointsMm, closed }, () => session.get().createNurbsCurve(pointsMm, closed, current)));
  tool("plasticity_create_helix", "Create a constant-radius native helix around a world-space axis. Coordinates and radius are millimeters.", z.object({ axisStartMm: vector, axisEndMm: vector, radiusMm: z.number().finite().positive(), turns: z.number().finite().positive().max(10_000), radialDirection: direction.default([1, 0, 0]), handedness: z.enum(["right", "left"]).default("right"), intent, revision }).strict(), async ({ axisStartMm, axisEndMm, radiusMm, turns, radialDirection, handedness, intent: purpose, revision: current }) =>
    await journaled("create-helix", purpose, { axisStartMm, axisEndMm, radiusMm, turns, radialDirection, handedness }, () => session.get().createHelix(axisStartMm, axisEndMm, radiusMm, turns, radialDirection, handedness, current)));
  tool("plasticity_create_circle", "Create a native circle in world coordinates or a referenced construction plane.", circleInputSchema, async (input) =>
    await journaled("create-circle", input.intent, { centerMm: input.centerMm, radiusMm: input.radiusMm, plane: "plane" in input ? input.plane : undefined, normal: "normal" in input ? input.normal : undefined }, () =>
      session.get().createCircle(input.centerMm, input.radiusMm, input.revision, "normal" in input ? input.normal : [0, 0, 1], "plane" in input ? input.plane : undefined)));
  tool("plasticity_create_two_point_circle", "Create one exact native circle from the two endpoints of its diameter. In world coordinates, the explicit plane normal must be perpendicular to the diameter; plane-local inputs inherit the referenced construction plane. The result is a closed Wire with an automatic Region.", twoPointCircleInputSchema, async (input) =>
    await journaled("create-two-point-circle", input.intent, input, () => session.get().createTwoPointCircle(
      input.diameterStartMm,
      input.diameterEndMm,
      input.revision,
      "normal" in input ? input.normal : [0, 0, 1],
      "plane" in input ? input.plane : undefined,
    )));
  tool("plasticity_create_three_point_circle", "Create one exact native circle through three distinct non-collinear points. The three points determine its plane, center, and radius; plane-local inputs are resolved through the referenced construction plane. The result is a closed Wire with an automatic Region.", threePointCircleInputSchema, async (input) =>
    await journaled("create-three-point-circle", input.intent, input, () => session.get().createThreePointCircle(
      input.firstMm,
      input.secondMm,
      input.thirdMm,
      input.revision,
      "plane" in input ? input.plane : undefined,
    )));
  tool("plasticity_create_center_arc", "Create one exact native circular arc from center, radius, start angle, and signed sweep. Positive sweep is counterclockwise around the plane normal; the sweep magnitude must be below 360 degrees. Inputs may use world coordinates or a referenced construction plane.", centerArcInputSchema, async (input) =>
    await journaled("create-center-arc", input.intent, input, () => session.get().createCenterArc(
      input.centerMm,
      input.radiusMm,
      input.startAngleDegrees,
      input.sweepAngleDegrees,
      input.revision,
      "normal" in input ? input.normal : [0, 0, 1],
      "xDirection" in input ? input.xDirection : [1, 0, 0],
      "plane" in input ? input.plane : undefined,
    )));
  tool("plasticity_create_three_point_arc", "Create one exact native circular arc from a start point through a second point to an end point. Point order selects the minor or major arc and preserves start-to-end curve direction. Inputs may use world coordinates or a referenced construction plane.", threePointArcInputSchema, async (input) =>
    await journaled("create-three-point-arc", input.intent, input, () => session.get().createThreePointArc(
      input.startMm,
      input.throughMm,
      input.endMm,
      input.revision,
      "plane" in input ? input.plane : undefined,
    )));
  tool("plasticity_create_tangent_arc", "Create one exact native circular arc tangent to a selected current Wire segment at its start or end and terminating at an explicit point. Use plasticity_list_curve_directions to obtain the segment entity and its exact endpoints. flipTangent selects the opposite tangent sense, which can select the major rather than minor arc. The end may use world coordinates or a referenced construction plane.", tangentArcInputSchema, async (input) =>
    await journaled("create-tangent-arc", input.intent, input, () => session.get().createTangentArc(
      input.bodyId,
      input.segmentEntityId,
      input.startAt,
      input.endMm,
      input.flipTangent,
      input.revision,
      "plane" in input ? input.plane : undefined,
    )));
  tool("plasticity_create_tangent_circle", "Create one exact fixed-radius native circle tangent to two current Wire segments. Use plasticity_list_curve_directions immediately before this call. solutionPointMm selects the intended solution near one of the possible circle centers; it is not an additional geometric constraint. World-space inputs require the sketch-plane normal, while plane-local inputs inherit the referenced construction plane. Both source Wires remain unchanged.", tangentCircleInputSchema, async (input) =>
    await journaled("create-tangent-circle", input.intent, input, () => session.get().createTangentCircle(
      input.first,
      input.second,
      input.solutionPointMm,
      input.radiusMm,
      input.revision,
      "normal" in input ? input.normal : [0, 0, 1],
      "plane" in input ? input.plane : undefined,
    )));
  tool("plasticity_bridge_curves", "Create one independent native B-Spline between two exact current Wire segment endpoints while preserving both source Wires. Use plasticity_list_curve_directions immediately before this call. G0 matches position, G1 adds tangent continuity, G2 adds curvature continuity, and G3 adds third-order geometric continuity at each end. The operation occupies one Plasticity history step.", bridgeCurveInputSchema, async ({ first, second, startContinuity, endContinuity, intent: purpose, revision: current }) =>
    await journaled("bridge-curves", purpose, { first, second, startContinuity, endContinuity }, () =>
      session.get().bridgeCurves(first, second, startContinuity, endContinuity, current)));
  tool("plasticity_bridge_curve_vertices", "Create one independent native B-Spline between two exact current open Wire vertices while preserving both source Wires. Use plasticity_list_curve_vertices immediately before this call and pass its numeric vertexId values. G0 through G3 continuity is selected independently at the two ends; internal or stale vertices are rejected before mutation.", bridgeCurveVerticesInputSchema, async ({ first, second, startContinuity, endContinuity, intent: purpose, revision: current }) =>
    await journaled("bridge-curve-vertices", purpose, { first, second, startContinuity, endContinuity }, () =>
      session.get().bridgeCurveVertices(first, second, startContinuity, endContinuity, current)));
  tool("plasticity_bridge_shell_edges", "Create one independent native B-Spline between explicitly selected endpoints of two exact current Solid or Sheet edges while preserving both source bodies. Each reference must pair a current edgeId with one of that edge's returned vertexIds. G0 through G3 continuity is selected independently at the two ends; exact endpoint and tangent read-back is required after the one-step operation.", bridgeShellEdgesInputSchema, async ({ first, second, startContinuity, endContinuity, intent: purpose, revision: current }) =>
    await journaled("bridge-shell-edges", purpose, { first, second, startContinuity, endContinuity }, () =>
      session.get().bridgeShellEdges(first, second, startContinuity, endContinuity, current)));
  tool("plasticity_create_ellipse", "Create one exact native closed elliptical Wire and Region from explicit major and minor radii. The major axis follows xDirection rotated by angleDegrees in the selected plane. Inputs may use world coordinates or a referenced construction plane.", ellipseInputSchema, async (input) =>
    await journaled("create-ellipse", input.intent, input, () => session.get().createEllipse(
      input.centerMm,
      input.majorRadiusMm,
      input.minorRadiusMm,
      input.revision,
      "normal" in input ? input.normal : [0, 0, 1],
      "xDirection" in input ? input.xDirection : [1, 0, 0],
      "plane" in input ? input.plane : undefined,
      input.angleDegrees,
    )));
  tool("plasticity_create_regular_polygon", "Create one exact native closed regular-polygon Wire and Region with 3-256 vertices. radiusMode=circumradius places every vertex on the supplied radius; radiusMode=inradius uses the supplied center-to-edge distance. Inputs may use world coordinates or a referenced construction plane.", regularPolygonInputSchema, async (input) =>
    await journaled("create-regular-polygon", input.intent, input, () => session.get().createRegularPolygon(
      input.centerMm,
      input.radiusMm,
      input.radiusMode,
      input.vertexCount,
      input.revision,
      "normal" in input ? input.normal : [0, 0, 1],
      "xDirection" in input ? input.xDirection : [1, 0, 0],
      "plane" in input ? input.plane : undefined,
      input.angleDegrees,
    )));
  tool("plasticity_create_rectangle", "Create an exact native rectangular Wire and Region from its center, width, and height in world coordinates or a referenced construction plane. Positive angle rotates the width axis around the plane normal in degrees.", rectangleInputSchema, async (input) =>
    await journaled("create-rectangle", input.intent, {
      centerMm: input.centerMm,
      widthMm: input.widthMm,
      heightMm: input.heightMm,
      plane: "plane" in input ? input.plane : undefined,
      normal: "normal" in input ? input.normal : undefined,
      xDirection: "xDirection" in input ? input.xDirection : undefined,
      angleDegrees: input.angleDegrees,
    }, () => session.get().createRectangle(
      input.centerMm,
      input.widthMm,
      input.heightMm,
      input.revision,
      "normal" in input ? input.normal : [0, 0, 1],
      "xDirection" in input ? input.xDirection : [1, 0, 0],
      "plane" in input ? input.plane : undefined,
      input.angleDegrees,
    )));
  tool("plasticity_create_text", "Create Plasticity-native closed Wire outlines for text at a world or construction-plane baseline origin. Font size is nominal millimeters; inspect the resulting exact curve bounds before using the outlines for embossing, engraving, or clearance-critical geometry. Plasticity may create multiple Wires and Regions.", textInputSchema, async (input) =>
    await journaled("create-text", input.intent, input, () => session.get().createText({
      text: input.text,
      fontSizeMm: input.fontSizeMm,
      originMm: input.originMm,
      font: input.font,
      revision: input.revision,
      angleDegrees: input.angleDegrees,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...("normal" in input ? { normal: input.normal, xDirection: input.xDirection } : {}),
      ...("plane" in input ? { plane: input.plane } : {}),
    })));

  tool("plasticity_move", "Move bodies. Requires the current revision; delta is millimeters.", z.object({ ids, deltaMm: vector, intent, revision }), async ({ ids: bodyIds, deltaMm, intent: purpose, revision: current }) =>
    await journaled("move", purpose, { bodyIds, deltaMm }, () => session.get().move(bodyIds, deltaMm, current)));
  tool("plasticity_rotate", "Rotate bodies around a world pivot and axis. Angle is degrees.", z.object({ ids, pivotMm: vector, axis: direction, degrees: z.number().finite(), intent, revision }), async ({ ids: bodyIds, pivotMm, axis, degrees, intent: purpose, revision: current }) =>
    await journaled("rotate", purpose, { bodyIds, pivotMm, axis, degrees }, () => session.get().rotate(bodyIds, pivotMm, axis, degrees, current)));
  tool("plasticity_orient_bodies_for_print", "Apply a Workbench workbench_assess_printability rotationDeg to one or more exact native Solids as one rigid group in one Plasticity history step, around the union B-Rep bounding-box center. Pass the same expectedSizeMm from that DFM result; the tool refuses a rotation whose predicted group bounds disagree with it, then returns actual native group bounds and verification status. The orientation is rotation about X, then Y, then Z (Workbench Euler XYZ convention); it does not split the bodies or prove slicer fit, so re-run DFM and slicing afterward.", z.object({
    bodyIds: z.array(z.number().int().positive()).min(1).max(64).refine((values) => new Set(values).size === values.length, "Body IDs must be unique"),
    rotationDeg: vector.refine((angles) => angles.every((angle) => Math.abs(angle) <= 360), "Rotation angles must be within ±360 degrees"),
    expectedSizeMm: positiveVector,
    intent,
    revision,
  }).strict(), async ({ bodyIds, rotationDeg, expectedSizeMm, intent: purpose, revision: current }) => {
    const operations = session.get();
    const before = await operations.state();
    if (before.revision !== current) throw new Error(`Stale reference: expected revision ${current}, current revision is ${before.revision}`);
    const bodies = bodyIds.map((id) => before.bodies.find((candidate) => candidate.id === id));
    if (bodies.some((body) => !body || body.type !== "Solid" || !body.boundsMm)) throw new Error("Print orientation requires current bounded native Solids for every body ID");
    const beforeBounds = unionBounds(bodies.map((body) => body!.boundsMm!));
    const pivotMm = boundsCenter(beforeBounds);
    const quaternion = quaternionFromXyzDegrees(rotationDeg);
    if (Math.hypot(quaternion[0], quaternion[1], quaternion[2]) < 1e-12) throw new Error("Print orientation is zero; no CAD mutation is required");
    const expectedBoundsMm = rotateBoundsAroundPivot(beforeBounds, pivotMm, quaternion);
    const predictedSizeMm = expectedBoundsMm.max.map((value, axis) => value - expectedBoundsMm.min[axis]!) as [number, number, number];
    const dfmSizeMatches = predictedSizeMm.every((value, axis) => Math.abs(value - expectedSizeMm[axis]!) <= 0.01);
    if (!dfmSizeMatches) throw new Error(`Workbench orientation does not match these exact Solids: predicted ${predictedSizeMm.join(" × ")} mm, DFM reported ${expectedSizeMm.join(" × ")} mm`);
    const after = await journaled("orient-bodies-for-print", purpose, { bodyIds, rotationDeg, expectedSizeMm, pivotMm },
      () => operations.rotateBodiesByXyz(bodyIds, pivotMm, rotationDeg, current));
    const actualBodies = bodyIds.map((id) => after.bodies.find((candidate) => candidate.id === id));
    if (actualBodies.some((body) => !body || body.type !== "Solid" || !body.boundsMm)) throw new Error("An oriented Solid is missing from the current native B-Rep state");
    const measuredBoundsMm = unionBounds(actualBodies.map((body) => body!.boundsMm!));
    const deviationsMm = measuredBoundsMm.min.map((value, axis) => Math.max(
      Math.abs(value - expectedBoundsMm.min[axis]!),
      Math.abs(measuredBoundsMm.max[axis]! - expectedBoundsMm.max[axis]!),
    )) as [number, number, number];
    const maxDeviationMm = Math.max(...deviationsMm);
    return {
      status: maxDeviationMm <= 0.01 ? "verified" : "bounds-mismatch",
      measurementSource: "native-brep",
      bodyIds,
      documentToken: after.documentToken,
      revision: after.revision,
      rotationDeg,
      pivotMm,
      expectedBoundsMm,
      measuredBoundsMm,
      expectedSizeMm,
      measuredSizeMm: measuredBoundsMm.max.map((value, axis) => value - measuredBoundsMm.min[axis]!) as [number, number, number],
      deviationsMm,
      toleranceMm: 0.01,
      maxDeviationMm,
      slicerFitVerified: false,
      message: maxDeviationMm <= 0.01
        ? "Native B-Rep group bounds match the Workbench orientation; re-assess and slice this exact geometry before creating print approval."
        : "Plasticity applied the requested group orientation, but native bounds differ from the predicted result; inspect the geometry and do not repeat the command automatically.",
    };
  });
  tool("plasticity_scale", "Scale bodies around a world pivot with positive XYZ factors.", z.object({ ids, pivotMm: vector, factors: positiveVector, intent, revision }), async ({ ids: bodyIds, pivotMm, factors, intent: purpose, revision: current }) =>
    await journaled("scale", purpose, { bodyIds, pivotMm, factors }, () => session.get().scale(bodyIds, pivotMm, factors, current)));
  tool("plasticity_set_block_dimensions", "Set the exact local width, length, and height of one current Solid that Plasticity still recognizes as a dimensionable block. This is a one-step native direct edit centered on the existing block; it does not create a persistent parametric constraint. Read the resulting B-Rep dimensions back after the edit.", z.object({ id: z.number().int().positive(), widthMm: z.number().finite().positive(), lengthMm: z.number().finite().positive(), heightMm: z.number().finite().positive(), intent, revision }).strict(), async ({ id, widthMm, lengthMm, heightMm, intent: purpose, revision: current }) =>
    await journaled("set-block-dimensions", purpose, { id, widthMm, lengthMm, heightMm }, () => session.get().setBlockDimensions(id, widthMm, lengthMm, heightMm, current)));
  tool("plasticity_set_radius_dimension", "Set the exact radius of one current cylindrical B-Rep face through Plasticity's native direct-dimension command. This changes recognized coaxial geometry in one Undo step; it is not a fillet command or persistent parametric constraint. Read the resulting cylindrical face radius back after the edit.", z.object({ face: faceRef, radiusMm: z.number().finite().positive(), intent, revision }).strict(), async ({ face, radiusMm, intent: purpose, revision: current }) =>
    await journaled("set-radius-dimension", purpose, { face, radiusMm }, () => session.get().setRadiusDimension(face, radiusMm, current)));
  tool("plasticity_set_rectangle_dimensions", "Set Plasticity's exact local width and length for one closed planar Wire that the native dimension command recognizes as a rectangle. The profile remains centered and its Region updates in one Undo step. This is a direct edit, not a persistent constraint; read the resulting Wire B-Rep bounds back.", z.object({ id: z.number().int().positive(), widthMm: z.number().finite().positive(), lengthMm: z.number().finite().positive(), intent, revision }).strict(), async ({ id, widthMm, lengthMm, intent: purpose, revision: current }) =>
    await journaled("set-rectangle-dimensions", purpose, { id, widthMm, lengthMm }, () => session.get().setRectangleDimensions(id, widthMm, lengthMm, current)));
  tool("plasticity_boolean", "Apply exact CAD union, difference, or intersection.", z.object({ targetIds: ids, toolIds: ids, operation: z.enum(["union", "difference", "intersection"]), keepTools: z.boolean().default(false), intent, revision }), async ({ targetIds, toolIds, operation, keepTools, intent: purpose, revision: current }) =>
    await journaled(`boolean-${operation}`, purpose, { targetIds, toolIds, keepTools }, () => session.get().boolean(targetIds, toolIds, operation, keepTools, current)));
  tool("plasticity_cut_with_faces", "Split current Solid or Sheet bodies with current planar cutter faces. Cutter bodies are preserved. To trim an open Sheet, inspect the returned exact Sheet parts and delete only the unwanted part at the returned revision.", z.object({ targetIds: ids, cutterFaces: z.array(faceRef).min(1).max(4096), intent, revision }).strict(), async ({ targetIds, cutterFaces, intent: purpose, revision: current }) =>
    await journaled("cut-with-faces", purpose, { targetIds, cutterFaces }, () => session.get().cutWithFaces(targetIds, cutterFaces, current)));
  tool("plasticity_split_solid_by_plane", "Split one current Solid into exactly two native Solid parts with one explicit plane that crosses its interior. The tool derives an oversized planar cutter from exact B-Rep bounds, cuts the Solid, verifies both native volumes sum to the original within tolerance, checks unrelated bodies are unchanged, and removes its temporary cutter geometry. It does not add an assembly joint; create a qualified locating-pin or tongue-and-groove joint afterward if required. The plane origin, normal, and in-plane x direction are millimeters/world vectors and the tool occupies four native history steps.", splitSolidByPlaneInputSchema, async (input) =>
    await journaled("split-solid-by-plane", input.intent, input, () => new SplitSolidByPlaneRecipe(session.get()).split(input)));
  tool("plasticity_split_solid_by_planes", "Split one current Solid into a grid using an ordered list of explicit world-space planes. Each plane is applied only to current Solid parts whose exact B-Rep bounds it crosses; each native cut must produce exactly two valid Solid results and preserve volume, temporary cutters are removed, and the final part volumes are checked against the source. Planes are processed sequentially and partial results remain if a later cut fails; reconcile and inspect before continuing. This tool does not choose planes from a Workbench splitPlan, orient the source, or add joints. Each successful cut uses four native history steps.", splitSolidByPlanesInputSchema, async (input) =>
    await journaled("split-solid-by-planes", input.intent, input, () => new SplitSolidByPlanesRecipe(session.get()).split(input)));
  tool("plasticity_split_solid_to_build_volume", "After orienting a current Solid to the printer's world X/Y/Z axes, split it into an even grid sized from its exact native B-Rep bounds and the selected profile's usable build volume in millimeters. The tool derives world-space cut planes, performs the bounded native multi-plane recipe, validates exact total volume and native Solids, and verifies every result's exact bounds fit the usable volume within 0.01 mm. It does not rotate the part or create assembly joints; a failed operation can leave confirmed earlier cuts, so inspect the revision and scene before continuing.", splitSolidToVolumeInputSchema, async (input) =>
    await journaled("split-solid-to-build-volume", input.intent, input, () => new SplitSolidToVolumeRecipe(session.get()).split(input)));
  tool("plasticity_set_appearance_material", "Assign an existing Plasticity appearance material, create and assign a bounded color/roughness/metalness/opacity appearance, or clear an assignment with materialId 0. This changes display appearance only and uses one native Undo step.", appearanceMaterialInputSchema, async ({ ids: bodyIds, materialId, name, colorHex, roughness, metalness, opacity, intent: purpose, revision: current }) => {
    const material = materialId !== undefined
      ? { materialId }
      : { name: name!, colorHex: colorHex!, roughness: roughness ?? 0.6, metalness: metalness ?? 0, opacity: opacity ?? 1 };
    return await journaled("set-appearance-material", purpose, { bodyIds, material }, () => session.get().setAppearanceMaterial(bodyIds, material, current));
  });
  tool("plasticity_fillet", "Fillet current edge IDs with a radius in millimeters.", z.object({ id: z.number().int().positive(), edgeIds: z.array(z.string()).min(1), radiusMm: z.number().finite().positive(), intent, revision }), async ({ id, edgeIds, radiusMm, intent: purpose, revision: current }) =>
    await journaled("fillet", purpose, { id, edgeIds, radiusMm }, () => session.get().fillet(id, edgeIds, radiusMm, current)));
  tool("plasticity_chamfer", "Chamfer current edge IDs by an equal distance in millimeters.", z.object({ id: z.number().int().positive(), edgeIds: z.array(z.string()).min(1), distanceMm: z.number().finite().positive(), intent, revision }), async ({ id, edgeIds, distanceMm, intent: purpose, revision: current }) =>
    await journaled("chamfer", purpose, { id, edgeIds, distanceMm }, () => session.get().chamfer(id, edgeIds, distanceMm, current)));
  tool("plasticity_remove_fillets", "Remove every native fillet recognized on one or more current Solid or Sheet bodies.", z.object({ ids, intent, revision }).strict(), async ({ ids: bodyIds, intent: purpose, revision: current }) =>
    await journaled("remove-fillets", purpose, { ids: bodyIds }, () => session.get().removeFillets(bodyIds, current)));
  tool("plasticity_refillet_faces", "Change recognized native fillet faces by a signed radius delta in millimeters.", z.object({ faces: z.array(faceRef).min(1).max(4096), deltaMm: nonzeroDistance, intent, revision }).strict(), async ({ faces, deltaMm, intent: purpose, revision: current }) =>
    await journaled("refillet-faces", purpose, { faces, deltaMm }, () => session.get().refilletFaces(faces, deltaMm, current)));
  tool("plasticity_extrude_faces", "Extrude current face IDs by a distance in millimeters.", z.object({ id: z.number().int().positive(), faceIds: z.array(z.string()).min(1), distanceMm: z.number().finite(), intent, revision }), async ({ id, faceIds, distanceMm, intent: purpose, revision: current }) =>
    await journaled("extrude-faces", purpose, { id, faceIds, distanceMm }, () => session.get().extrudeFaces(id, faceIds, distanceMm, current)));
  tool("plasticity_extrude_profile", "Extrude one unambiguous closed planar Wire profile into a native Solid.", z.object({ id: z.number().int().positive(), distanceMm: z.number().finite(), intent, revision }), async ({ id, distanceMm, intent: purpose, revision: current }) =>
    await journaled("extrude-profile", purpose, { id, distanceMm }, () => session.get().extrudeProfile(id, distanceMm, current)));
  tool("plasticity_extrude_regions", "Extrude one or more explicit revision-bound planar regions into native solids.", z.object({ regionIds, distanceMm: z.number().finite(), intent, revision }).strict(), async ({ regionIds: selectedRegions, distanceMm, intent: purpose, revision: current }) =>
    await journaled("extrude-regions", purpose, { regionIds: selectedRegions, distanceMm }, () => session.get().extrudeRegions(selectedRegions, distanceMm, current)));
  tool("plasticity_offset_planar_curves", "Create native offsets from planar Wire bodies. Signed distance follows each Wire orientation and is measured in millimeters.", z.object({ ids, distanceMm: nonzeroDistance, intent, revision }).strict(), async ({ ids: wireIds, distanceMm, intent: purpose, revision: current }) =>
    await journaled("offset-planar-curves", purpose, { ids: wireIds, distanceMm }, () => session.get().offsetPlanarCurves(wireIds, distanceMm, current)));
  tool("plasticity_offset_regions", "Create one or two native signed offsets from explicit Regions in the same sketch, preserving the source curves.", z.object({ regionIds, offsetsMm: regionOffsets, individual: z.boolean().default(true), intent, revision }).strict(), async ({ regionIds: selectedRegions, offsetsMm, individual, intent: purpose, revision: current }) =>
    await journaled("offset-regions", purpose, { regionIds: selectedRegions, offsetsMm, individual }, () => session.get().offsetRegions(selectedRegions, offsetsMm, individual, current)));
  tool("plasticity_trim_curve_fragments", "Remove one or more explicit revision-bound curve fragments using Plasticity's native Trim operation.", z.object({ fragmentIds, intent, revision }).strict(), async ({ fragmentIds: selectedFragments, intent: purpose, revision: current }) =>
    await journaled("trim-curve-fragments", purpose, { fragmentIds: selectedFragments }, () => session.get().trimCurveFragments(selectedFragments, current)));
  tool("plasticity_extend_curve_endpoints", "Extend one or more explicit revision-bound open Wire endpoints by a positive distance in millimeters.", z.object({ endpointIds, distanceMm: z.number().finite().positive(), intent, revision }).strict(), async ({ endpointIds: selectedEndpoints, distanceMm, intent: purpose, revision: current }) =>
    await journaled("extend-curve-endpoints", purpose, { endpointIds: selectedEndpoints, distanceMm }, () => session.get().extendCurveEndpoints(selectedEndpoints, distanceMm, current)));
  tool("plasticity_convert_curve_vertices_to_control_points", "Convert one or more exact current interior or closed Wire vertices into native B-Spline control vertices in one Plasticity history step. References must come from plasticity_list_curve_vertices at the current revision. Open endpoints are not convertible. The Wire path, segment structure, length, and topology change, so discard every old vertex and segment reference and inspect the returned Wire before continuing.", z.object({
    vertices: z.array(measurementVertexRef).min(1).max(4096).refine((values) => new Set(values.map((value) => `${value.bodyId}:${value.vertexId}`)).size === values.length, "Curve vertex references must be unique"),
    intent,
    revision,
  }).strict(), async ({ vertices, intent: purpose, revision: current }) =>
    await journaled("convert-curve-vertices-to-control-points", purpose, { vertices }, () => session.get().convertCurveVerticesToControlPoints(vertices, current)));
  tool("plasticity_fillet_curve_vertices", "Round one or more exact interior or closed Wire vertices with Plasticity's native curve fillet in one history step. Vertex references come from plasticity_list_curve_vertices and are revision-bound; the positive radius is in millimeters. The edited Wire may receive a new stable body ID, so use the returned state before further work.", z.object({ vertices: z.array(measurementVertexRef).min(1).max(128).refine((values) => new Set(values.map((value) => `${value.bodyId}:${value.vertexId}`)).size === values.length, "Curve vertex references must be unique"), radiusMm: z.number().finite().positive(), intent, revision }).strict(), async ({ vertices, radiusMm, intent: purpose, revision: current }) =>
    await journaled("fillet-curve-vertices", purpose, { vertices, radiusMm }, () => session.get().filletCurveVertices(vertices, radiusMm, current)));
  tool("plasticity_unjoin_curves", "Split compound native Wire bodies into separate editable curve bodies.", z.object({ ids, intent, revision }).strict(), async ({ ids: wireIds, intent: purpose, revision: current }) =>
    await journaled("unjoin-curves", purpose, { ids: wireIds }, () => session.get().unjoinCurves(wireIds, current)));
  tool("plasticity_duplicate_curves", "Create independent exact native copies of one or more current Wire bodies in place while preserving the sources. The copies receive new stable body IDs and can be transformed or edited separately.", z.object({ ids, intent, revision }).strict(), async ({ ids: wireIds, intent: purpose, revision: current }) =>
    await journaled("duplicate-curves", purpose, { ids: wireIds }, () => session.get().duplicateCurves(wireIds, current)), false, { destructiveHint: false });
  tool("plasticity_create_curves_from_regions", "Create independent exact native Wire copies of the boundaries of explicit current planar Regions while preserving the source Wire geometry. Coincident boundary copies make Plasticity recompute automatic Regions, so all previous Region references become stale; use the returned state or plasticity_list_regions before downstream work.", z.object({ regionIds, intent, revision }).strict(), async ({ regionIds: selectedRegions, intent: purpose, revision: current }) =>
    await journaled("create-curves-from-regions", purpose, { regionIds: selectedRegions }, () => session.get().createCurvesFromRegions(selectedRegions, current)), false, { destructiveHint: false });
  tool("plasticity_join_curves", "Join two or more native Wire bodies into one editable compound curve.", z.object({ ids: ids.min(2), intent, revision }).strict(), async ({ ids: wireIds, intent: purpose, revision: current }) =>
    await journaled("join-curves", purpose, { ids: wireIds }, () => session.get().joinCurves(wireIds, current)));
  tool("plasticity_rebuild_curves", "Rebuild current native Wire bodies in one Plasticity history step. tolerance asks Plasticity to fit within an explicit millimeter target; control-points sets the native control-point count; degree-spans sets exact NURBS degree and span count. Read plasticity_inspect_curve_structure before and after, and measure geometric drift because a requested fit setting is not independent proof of deviation.", rebuildCurveInputSchema, async ({ ids: wireIds, intent: purpose, revision: current, ...options }) =>
    await journaled("rebuild-curves", purpose, { ids: wireIds, ...options }, () => session.get().rebuildCurves(wireIds, options, current)));
  tool("plasticity_raise_curve_degree", "Raise the native degree of every B-Spline segment in one or more current Wire bodies by one while preserving its shape. This adds edit freedom without adding shape detail. Inspect native curve structure before and after; each call occupies one Plasticity history step.", z.object({ ids, intent, revision }).strict(), async ({ ids: wireIds, intent: purpose, revision: current }) =>
    await journaled("raise-curve-degree", purpose, { ids: wireIds }, () => session.get().raiseCurveDegree(wireIds, current)));
  tool("plasticity_subdivide_curves", "Insert native knots into one or more current B-Spline Wire bodies while preserving degree and shape. This adds local edit points without changing the curve's path. Inspect native curve structure before and after; each call occupies one Plasticity history step.", z.object({ ids, intent, revision }).strict(), async ({ ids: wireIds, intent: purpose, revision: current }) =>
    await journaled("subdivide-curves", purpose, { ids: wireIds }, () => session.get().subdivideCurves(wireIds, current)));
  tool("plasticity_insert_curve_knot", "Insert one native knot into one exact current B-Spline Wire segment while preserving its path and degree. Use plasticity_list_curve_directions immediately before this call and pass a normalizedParameter strictly between 0 and 1, where 0 is the returned segment start and 1 is its end. This adds one local control point in one Plasticity history step; inspect native structure and functional geometry afterward.", z.object({ segment: curveSegmentSchema, normalizedParameter: z.number().finite().gt(0).lt(1), intent, revision }).strict(), async ({ segment, normalizedParameter, intent: purpose, revision: current }) =>
    await journaled("insert-curve-knot", purpose, { segment, normalizedParameter }, () => session.get().insertCurveKnot(segment, normalizedParameter, current)));
  tool("plasticity_split_curve_segment", "Split one exact nonperiodic current Wire segment into two consecutive segments at a normalized parameter strictly between 0 and 1. Evaluate the intended point first with plasticity_evaluate_curve_segments. The Wire body remains one body and its path is preserved, but every old segment reference becomes stale. Full periodic circles are rejected because one split point only relocates their seam.", z.object({ segment: curveSegmentSchema, normalizedParameter: z.number().finite().gt(0).lt(1), intent, revision }).strict(), async ({ segment, normalizedParameter, intent: purpose, revision: current }) =>
    await journaled("split-curve-segment", purpose, { segment, normalizedParameter }, () => session.get().splitCurveSegment(segment, normalizedParameter, current)));
  tool("plasticity_planarize_curves", "Orthogonally project one or more current Wire bodies onto an explicit world-space plane. This changes a spatial curve's path and may reverse its parameter direction, unlike degree elevation or subdivision. Verify planarity, endpoints, direction, and functional measurements afterward. The operation occupies one Plasticity history step.", z.object({ ids, originMm: vector, normal: direction, intent, revision }).strict(), async ({ ids: wireIds, originMm, normal, intent: purpose, revision: current }) =>
    await journaled("planarize-curves", purpose, { ids: wireIds, originMm, normal }, () => session.get().planarizeCurves(wireIds, originMm, normal, current)));
  tool("plasticity_move_curve_control_points", "Move one or more exact current Wire control handles by a shared world-space millimeter delta in one Plasticity history step. References must come from plasticity_list_curve_control_points at the current revision. Boundary vertices edit curve ends or joins; interior control points reshape B-Splines. Re-read control points and exact B-Rep geometry afterward.", z.object({
    points: curveControlPointRefs,
    deltaMm: vector.refine((value) => Math.hypot(...value) > 0, "Curve control point move delta must be nonzero"),
    intent,
    revision,
  }).strict(), async ({ points, deltaMm, intent: purpose, revision: current }) =>
    await journaled("move-curve-control-points", purpose, { points, deltaMm }, () => session.get().moveCurveControlPoints(points, deltaMm, current)));
  tool("plasticity_slide_curve_control_points", "Slide one or more exact current Wire handles by a positive millimeter distance along each handle's local positive-U or negative-U control-polygon direction. Use the unit directions returned by plasticity_list_curve_control_points to predict the world-space result. All handles share one direction sense and distance, and the edit occupies one Plasticity history step. Re-read handles and exact B-Rep geometry afterward.", z.object({
    points: curveControlPointRefs,
    direction: z.enum(["positive-u", "negative-u"]),
    distanceMm: z.number().finite().positive(),
    intent,
    revision,
  }).strict(), async ({ points, direction: slideDirection, distanceMm, intent: purpose, revision: current }) =>
    await journaled("slide-curve-control-points", purpose, { points, direction: slideDirection, distanceMm }, () => session.get().slideCurveControlPoints(points, slideDirection, distanceMm, current)));
  tool("plasticity_rotate_curve_control_points", "Rotate exact current Wire control handles around an explicit world-space pivot and axis in one Plasticity history step. References must come from plasticity_list_curve_control_points at the current revision. The angle is in degrees; re-read handles and exact B-Rep geometry afterward.", z.object({
    points: curveControlPointRefs,
    pivotMm: vector,
    axis: direction,
    degrees: z.number().finite().refine((value) => value !== 0, "Rotation angle must be nonzero"),
    intent,
    revision,
  }).strict(), async ({ points, pivotMm, axis, degrees, intent: purpose, revision: current }) =>
    await journaled("rotate-curve-control-points", purpose, { points, pivotMm, axis, degrees }, () => session.get().rotateCurveControlPoints(points, pivotMm, axis, degrees, current)));
  tool("plasticity_scale_curve_control_points", "Scale exact current Wire control handles around an explicit world-space pivot with positive XYZ factors in one Plasticity history step. References must come from plasticity_list_curve_control_points at the current revision. Re-read handles and exact B-Rep geometry afterward.", z.object({
    points: curveControlPointRefs,
    pivotMm: vector,
    factors: positiveVector.refine((values) => values.some((value) => value !== 1), "Scale must change at least one factor"),
    intent,
    revision,
  }).strict(), async ({ points, pivotMm, factors, intent: purpose, revision: current }) =>
    await journaled("scale-curve-control-points", purpose, { points, pivotMm, factors }, () => session.get().scaleCurveControlPoints(points, pivotMm, factors, current)));
  tool("plasticity_delete_curve_control_points", "Delete one or more current interior B-Spline control points from a single Wire in one Plasticity history step. References must come from plasticity_list_curve_control_points at the current revision. This changes the curve path and reindexes the remaining control-point IDs, so discard every old handle reference and re-read structure, handles, endpoints, tangents, and functional geometry afterward.", z.object({
    points: interiorCurveControlPointRefs,
    intent,
    revision,
  }).strict(), async ({ points, intent: purpose, revision: current }) =>
    await journaled("delete-curve-control-points", purpose, { points }, () => session.get().deleteCurveControlPoints(points, current)));
  tool("plasticity_reverse_curves", "Reverse the native direction of one or more current Wire bodies.", z.object({ ids, intent, revision }).strict(), async ({ ids: wireIds, intent: purpose, revision: current }) =>
    await journaled("reverse-curves", purpose, { ids: wireIds }, () => session.get().reverseCurves(wireIds, current)));
  tool("plasticity_reverse_sheets", "Reverse the native surface normal orientation of one or more current Sheet bodies.", z.object({ ids, intent, revision }).strict(), async ({ ids: sheetIds, intent: purpose, revision: current }) =>
    await journaled("reverse-sheets", purpose, { ids: sheetIds }, () => session.get().reverseSheets(sheetIds, current)));
  tool("plasticity_create_body_outlines", "Create exact native Wire silhouettes from current Solid or Sheet bodies on an explicit current construction plane. Source placement keeps each outline at the source silhouette plane; workplane placement projects it onto the selected plane. Source bodies are preserved and the selected plane becomes active.", z.object({
    ids: z.array(z.number().int().positive()).min(1).max(4096).refine((values) => new Set(values).size === values.length, "Body IDs must be unique"),
    plane: referenceIdentitySchema,
    placement: z.enum(["source", "workplane"]).default("workplane"),
    intent,
    revision,
  }).strict(), async ({ ids: bodyIds, plane, placement, intent: purpose, revision: current }) =>
    await journaled("create-body-outlines", purpose, { bodyIds, plane, placement }, () =>
      session.get().createBodyOutlines(bodyIds, plane, placement, current)));
  tool("plasticity_project_curves_onto_body", "Project native Wire bodies onto a surface body along an explicit world-space vector while preserving the source curves.", z.object({
    targetId: z.number().int().positive(),
    curveIds: ids,
    direction,
    bidirectional: z.boolean().default(false),
    occlude: z.boolean().default(true),
    completion: z.enum(["none", "edge", "face-set"]).default("none"),
    intent,
    revision,
  }).strict(), async ({ targetId, curveIds, direction: projectionDirection, bidirectional, occlude, completion, intent: purpose, revision: current }) =>
    await journaled("project-curves-onto-body", purpose, { targetId, curveIds, direction: projectionDirection, bidirectional, occlude, completion }, () =>
      session.get().projectCurvesOntoBody(targetId, curveIds, projectionDirection, { bidirectional, occlude, completion }, current)));
  tool("plasticity_create_body_intersection_curves", "Create independent exact Wire curves at every native intersection between one Solid or Sheet target and one or more Solid or Sheet tools. All source bodies are preserved and the complete operation occupies one Plasticity history step.", z.object({
    targetId: z.number().int().positive(),
    toolIds: ids,
    intent,
    revision,
  }).strict(), async ({ targetId, toolIds, intent: purpose, revision: current }) =>
    await journaled("create-body-intersection-curves", purpose, { targetId, toolIds }, () =>
      session.get().createBodyIntersectionCurves(targetId, toolIds, current)));
  tool("plasticity_project_curve_pair", "Create an independent 3D Wire by intersecting the bidirectional extrusion surfaces of two distinct native Wire bodies. Supply one explicit world-space projection direction for each source and a depth in millimeters large enough for both temporary surfaces to overlap. Source curves are preserved and the operation occupies one Plasticity history step.", z.object({
    firstId: z.number().int().positive(),
    firstDirection: direction,
    secondId: z.number().int().positive(),
    secondDirection: direction,
    projectionDepthMm: z.number().finite().positive(),
    intent,
    revision,
  }).strict(), async ({ firstId, firstDirection, secondId, secondDirection, projectionDepthMm, intent: purpose, revision: current }) =>
    await journaled("project-curve-pair", purpose, { firstId, firstDirection, secondId, secondDirection, projectionDepthMm }, () =>
      session.get().projectCurvePair(firstId, firstDirection, secondId, secondDirection, projectionDepthMm, current)));
  tool("plasticity_insert_isoparam_edges", "Insert native U- or V-isoparametric edges into one current Solid or Sheet face. This splits the selected face in place while preserving the body ID and occupies one Plasticity history step; it does not create independent Wire bodies. U/V follow the face's native parameterization, so inspect the resulting analytic surfaces, dimensions, topology, and mass properties instead of assuming a world direction or unchanged numerical integration.", z.object({
    face: faceRef,
    direction: z.enum(["u", "v"]),
    count: z.number().int().min(1).max(1000).default(1),
    intent,
    revision,
  }).strict(), async ({ face, direction: paramDirection, count, intent: purpose, revision: current }) =>
    await journaled("insert-isoparam-edges", purpose, { face, direction: paramDirection, count }, () =>
      session.get().insertIsoparamEdges(face, paramDirection, count, current)));
  tool("plasticity_raise_surface_degree", "Raise the U and V degree of every selected current native B-Surface face by one Plasticity step in one history entry. Plasticity 26.1.3 may also change span/control-point counts and exact geometry; inspect the surface structure, bounds, topology, and functional dimensions before and after instead of assuming shape preservation.", z.object({ faces: surfaceFaceRefs, intent, revision }).strict(), async ({ faces, intent: purpose, revision: current }) =>
    await journaled("raise-surface-degree", purpose, { faces }, () => session.get().raiseSurfaceDegree(faces, current)));
  tool("plasticity_untrim_faces", "Restore selected current Solid or Sheet faces to the natural bounds of their carrier surfaces in one native history entry. The selected trim boundaries are discarded, the result can overlap neighboring geometry, and all topology references become stale; inspect surface structure, bounds, validation, and intersections before continuing.", z.object({ faces: surfaceFaceRefs, intent, revision }).strict(), async ({ faces, intent: purpose, revision: current }) =>
    await journaled("untrim-faces", purpose, { faces }, () => session.get().untrimFaces(faces, current)));
  tool("plasticity_imprint_curves_on_body", "Project native Wire bodies onto a Solid or Sheet and split its exact faces along the projected curves.", z.object({
    targetId: z.number().int().positive(),
    curveIds: ids,
    direction,
    bidirectional: z.boolean().default(false),
    occlude: z.boolean().default(true),
    completion: z.enum(["none", "edge", "face-set"]).default("none"),
    intent,
    revision,
  }).strict(), async ({ targetId, curveIds, direction: imprintDirection, bidirectional, occlude, completion, intent: purpose, revision: current }) =>
    await journaled("imprint-curves-on-body", purpose, { targetId, curveIds, direction: imprintDirection, bidirectional, occlude, completion }, () =>
      session.get().imprintCurvesOnBody(targetId, curveIds, imprintDirection, { bidirectional, occlude, completion }, current)));
  tool("plasticity_imprint_bodies", "Split a Solid or Sheet target along exact intersections with preserved Solid or Sheet tool bodies.", z.object({ targetId: z.number().int().positive(), toolIds: ids, intent, revision }).strict(), async ({ targetId, toolIds, intent: purpose, revision: current }) =>
    await journaled("imprint-bodies", purpose, { targetId, toolIds }, () => session.get().imprintBodies(targetId, toolIds, current)));
  tool("plasticity_sweep_regions", "Sweep one or more explicit closed Regions along a native Wire spine to create exact Solid geometry.", z.object({
    regionIds,
    spineId: z.number().int().positive(),
    alignment: z.enum(["normal", "parallel", "transport"]).default("normal"),
    corner: z.enum(["miter", "round"]).default("miter"),
    twistDegrees: z.number().finite().default(0),
    scale: z.number().finite().positive().default(1),
    simplify: z.boolean().default(false),
    intent,
    revision,
  }).strict(), async ({ regionIds: selectedRegions, spineId, alignment, corner, twistDegrees, scale, simplify, intent: purpose, revision: current }) =>
    await journaled("sweep-regions", purpose, { regionIds: selectedRegions, spineId, alignment, corner, twistDegrees, scale, simplify }, () =>
      session.get().sweepRegions(selectedRegions, spineId, { alignment, corner, twistDegrees, scale, simplify }, current)));
  tool("plasticity_loft_regions", "Loft an ordered list of closed Regions from different sketch planes into exact capped geometry, optionally shaped by native Wire guide curves that intersect every profile.", z.object({
    regionIds: regionIds.min(2),
    guideIds: z.array(z.number().int().positive()).max(4096).default([]),
    trimGuides: z.boolean().default(true),
    closed: z.boolean().default(false),
    simplify: z.boolean().default(true),
    intent,
    revision,
  }).strict(), async ({ regionIds: selectedRegions, guideIds, trimGuides, closed, simplify, intent: purpose, revision: current }) =>
    await journaled("loft-regions", purpose, { regionIds: selectedRegions, guideIds, trimGuides, closed, simplify }, () =>
      session.get().loftRegions(selectedRegions, { guideIds, trimGuides, closed, simplify }, current)));
  tool("plasticity_loft_curves", "Create one independent native loft surface through an ordered list of current Wire profiles while preserving every profile and guide. Optional Wire guides must intersect every profile. Closed mode requires at least three profiles and closes the loft sequence; natural, unconstrained, or clamped native curvature plus positive dimensionless end magnitudes control shape. The operation never joins the result to source bodies; verify the returned Sheet topology and bounds.", z.object({
    profileIds: z.array(z.number().int().positive()).min(2).max(32).refine((values) => new Set(values).size === values.length, "Curve loft profile IDs must be unique"),
    guideIds: z.array(z.number().int().positive()).max(64).refine((values) => new Set(values).size === values.length, "Curve loft guide IDs must be unique").default([]),
    trimGuides: z.boolean().default(true),
    trimProfiles: z.boolean().default(true),
    closed: z.boolean().default(false),
    simplify: z.boolean().default(true),
    curvature: z.enum(["natural", "unconstrained", "clamped"]).default("unconstrained"),
    startMagnitude: z.number().finite().positive().default(1),
    endMagnitude: z.number().finite().positive().default(1),
    intent,
    revision,
  }).strict(), async ({ profileIds, guideIds, trimGuides, trimProfiles, closed, simplify, curvature, startMagnitude, endMagnitude, intent: purpose, revision: current }) =>
    await journaled("loft-curves", purpose, { profileIds, guideIds, trimGuides, trimProfiles, closed, simplify, curvature, startMagnitude, endMagnitude }, () =>
      session.get().loftCurves(profileIds, { guideIds, trimGuides, trimProfiles, closed, simplify, curvature, startMagnitude, endMagnitude }, current)));
  tool("plasticity_loft_faces", "Create one independent native capped loft Solid through an ordered list of exact planar faces from different current Solid or Sheet source bodies while preserving every source. Optional current Wire guides must intersect every profile. Natural, unconstrained, or clamped native end conditions and positive magnitudes control the two ends; verify the returned B-Rep rather than treating magnitude as a millimeter distance.", z.object({
    faces: z.array(faceRef).min(2).max(32),
    guideIds: z.array(z.number().int().positive()).max(64).default([]),
    trimGuides: z.boolean().default(true),
    simplify: z.boolean().default(true),
    startCondition: z.enum(["natural", "unconstrained", "clamped"]).default("unconstrained"),
    endCondition: z.enum(["natural", "unconstrained", "clamped"]).default("unconstrained"),
    startMagnitude: z.number().finite().positive().default(1),
    endMagnitude: z.number().finite().positive().default(1),
    intent,
    revision,
  }).strict(), async ({ faces, guideIds, trimGuides, simplify, startCondition, endCondition, startMagnitude, endMagnitude, intent: purpose, revision: current }) =>
    await journaled("loft-faces", purpose, { faces, guideIds, trimGuides, simplify, startCondition, endCondition, startMagnitude, endMagnitude }, () =>
      session.get().loftFaces(faces, { guideIds, trimGuides, simplify, startCondition, endCondition, startMagnitude, endMagnitude }, current)));
  tool("plasticity_patch_regions", "Create native Sheet bodies that fill explicit revision-bound closed Regions.", z.object({ regionIds, intent, revision }).strict(), async ({ regionIds: selectedRegions, intent: purpose, revision: current }) =>
    await journaled("patch-regions", purpose, { regionIds: selectedRegions }, () => session.get().patchRegions(selectedRegions, current)));
  tool("plasticity_patch_closed_wires", "Create independent native Sheet patches from current closed Wire bodies while preserving every source Wire. Unlike planar Region patching, this accepts nonplanar closed boundaries and can create B-Surfaces. Re-read exact boundaries, surface structure, area, and native validity; the native fill is not a constrained engineering surface unless those properties are separately verified.", z.object({ ids: uniqueBodyIds, intent, revision }).strict(), async ({ ids: wireIds, intent: purpose, revision: current }) =>
    await journaled("patch-closed-wires", purpose, { wireIds }, () => session.get().patchClosedWires(wireIds, current)), false, { destructiveHint: false });
  tool("plasticity_bridge_surface", "Create a native G2 transition surface between boundary sides of two Sheet faces. Pick points and width are millimeters; each pick point must lie on the intended boundary edge.", z.object({
    first: faceRef.extend({ pickPointMm: vector }).strict(),
    second: faceRef.extend({ pickPointMm: vector }).strict(),
    widthMm: z.number().finite().positive(),
    softness: z.number().finite().positive().default(1),
    intent,
    revision,
  }).strict().refine((value) => value.first.bodyId !== value.second.bodyId, "Surface Bridge requires two different Sheet bodies"), async ({ first, second, widthMm, softness, intent: purpose, revision: current }) =>
    await journaled("bridge-surface", purpose, { first, second, widthMm, softness }, () =>
      session.get().bridgeSurface(first, second, widthMm, softness, current)));
  tool("plasticity_join_sheets", "Sew two or more native Sheet bodies along coincident edges.", z.object({ ids: ids.min(2), intent, revision }).strict(), async ({ ids: sheetIds, intent: purpose, revision: current }) =>
    await journaled("join-sheets", purpose, { ids: sheetIds }, () => session.get().joinSheets(sheetIds, current)));
  tool("plasticity_create_constrained_surface", "Create a native B-Surface constrained by paired 3D points and normal vectors.", z.object({
    pointsMm: z.array(vector).min(4).max(1000),
    normals: z.array(direction).min(4).max(1000),
    toleranceMm: z.number().finite().positive().default(0.01),
    angularToleranceDegrees: z.number().finite().positive().max(90).default(5),
    optimization: z.enum(["performance", "smoothness"]).default("performance"),
    intent,
    revision,
  }).strict().refine((value) => value.pointsMm.length === value.normals.length, "Provide one normal per point"), async ({ pointsMm, normals, toleranceMm, angularToleranceDegrees, optimization, intent: purpose, revision: current }) =>
    await journaled("create-constrained-surface", purpose, { pointsMm, normals, toleranceMm, angularToleranceDegrees, optimization }, () =>
      session.get().createConstrainedSurface(pointsMm, normals, { toleranceMm, angularToleranceDegrees, optimization }, current)));
  tool("plasticity_rebuild_face", "Refit one exact current Solid or Sheet face as a native B-Surface with projected boundary edges. The positive millimeter tolerance is an approximation setting, not a measured deviation bound. Plasticity rebuilds the owning body in one history step and invalidates every prior topology reference; re-read dimensions, surface structure, continuity, mass properties, and native validity afterward.", z.object({
    face: faceRef,
    toleranceMm: z.number().finite().positive().max(10),
    intent,
    revision,
  }).strict(), async ({ face, toleranceMm, intent: purpose, revision: current }) =>
    await journaled("rebuild-face", purpose, { face, toleranceMm }, () => session.get().rebuildFace(face, toleranceMm, current)));
  tool("plasticity_match_faces", "Replace one or more exact current Solid or Sheet face surfaces with the carrier surface of one separate current replacement face. Plasticity extends or trims adjacent faces to meet the replacement surface and performs the direct edit in one history step. An external replacement body is preserved; the edited bodies keep their stable IDs, but all prior topology references become stale. Verify bounds, analytic surface type, mass properties, interference, and native validity afterward.", z.object({
    faces: surfaceFaceRefs,
    replacement: faceRef,
    intent,
    revision,
  }).strict().refine(
    (value) => !value.faces.some((face) => face.bodyId === value.replacement.bodyId && face.faceId === value.replacement.faceId),
    "Replacement face must be separate from the faces being matched",
  ), async ({ faces, replacement, intent: purpose, revision: current }) =>
    await journaled("match-faces", purpose, { faces, replacement }, () => session.get().matchFaces(faces, replacement, current)));
  tool("plasticity_extract_faces", "Copy exact current faces into separate native Sheet bodies while preserving their source bodies.", z.object({ faces: z.array(faceRef).min(1).max(4096), intent, revision }).strict(), async ({ faces, intent: purpose, revision: current }) =>
    await journaled("extract-faces", purpose, { faces }, () => session.get().extractFaces(faces, current)));
  tool("plasticity_unwrap_face", "Create an exact planar native Sheet development from one current analytic Cylinder face while preserving the source body. This is geometric surface unwrapping; it does not add sheet thickness, bend radii, bend allowances, or manufacturing compensation. Plasticity chooses the seam and planar placement, so inspect the returned Sheet bounds and edges.", z.object({ face: faceRef, intent, revision }).strict(), async ({ face, intent: purpose, revision: current }) =>
    await journaled("unwrap-face", purpose, { face }, () => session.get().unwrapFace(face, current)), false, { destructiveHint: false });
  tool("plasticity_analyze_cone_development", "Calculate an area-preserving annular-sector profile from one complete native conical-frustum face bounded by two full circles and one straight seam. Returns exact B-Rep source identity, radii, sector radii, slant length and included angle; it does not create geometry. Pointed cones, partial cone faces and faces with additional boundaries are rejected.", z.object({ face: faceRef, intent, revision }).strict(), async ({ face, intent: purpose, revision: current }) =>
    await journaled("analyze-cone-development", purpose, { face }, () => session.get().analyzeConeDevelopment(face, current)), true);
  tool("plasticity_create_cone_development", "Create an exact area-preserving planar annular-sector Sheet from one complete native conical-frustum face. The profile is placed in the world XY plane with its inner arc starting at originMm; source Solid is preserved. This performs six native history steps (two arcs, two radial lines, join and patch), validates the Sheet and compares exact B-Rep boundary lengths and face area with the source. If interrupted or an error is returned after edits begin, inspect plasticity_status/changes before deciding whether to continue or undo; this tool never retries or rolls back automatically. Pointed cones, partial cone faces, and faces with additional boundary loops are unsupported.", z.object({
    face: faceRef,
    originMm: vector,
    intent,
    revision,
  }).strict(), async ({ face, originMm, intent: purpose, revision: current }) =>
    await journaled("create-cone-development", purpose, { face, originMm }, () => session.get().createConeDevelopment(face, originMm, current)), false, { destructiveHint: false });
  tool("plasticity_deform_bodies_between_faces", "Create independent native Solid or Sheet copies by mapping all faces of selected bodies from one exact source face onto a different exact target face. Source bodies and both reference-face bodies are preserved. Scale U/V/normal and orientation flags are dimensionless native mapping controls; inspect the resulting exact geometry because deformation intentionally changes shape and dimensions.", z.object({
    ids: uniqueBodyIds,
    sourceFace: faceRef,
    targetFace: faceRef,
    scaleU: z.number().finite().positive().max(1000).default(1),
    scaleV: z.number().finite().positive().max(1000).default(1),
    scaleNormal: z.number().finite().positive().max(1000).default(1),
    flipUV: z.boolean().default(false),
    flipNormal: z.boolean().default(false),
    mirror: z.boolean().default(false),
    intent,
    revision,
  }).strict().refine(
    (value) => value.sourceFace.bodyId !== value.targetFace.bodyId || value.sourceFace.faceId !== value.targetFace.faceId,
    "Source and target deformation faces must be different",
  ).refine(
    (value) => !value.ids.includes(value.sourceFace.bodyId) && !value.ids.includes(value.targetFace.bodyId),
    "Deformation bodies must be separate from source and target face bodies",
  ), async ({ ids: bodyIds, sourceFace, targetFace, scaleU, scaleV, scaleNormal, flipUV, flipNormal, mirror, intent: purpose, revision: current }) =>
    await journaled("deform-bodies-between-faces", purpose, { bodyIds, sourceFace, targetFace, scaleU, scaleV, scaleNormal, flipUV, flipNormal, mirror }, () =>
      session.get().deformBodiesBetweenFaces(bodyIds, sourceFace, targetFace, { scaleU, scaleV, scaleNormal, flipUV, flipNormal, mirror }, current)), false, { destructiveHint: false });
  tool("plasticity_deform_curves_between_faces", "Create independent native Wire copies by mapping selected curves from one exact source face onto a different exact target face. Source Wires and both reference-face bodies are preserved. Scale U/V/normal and orientation flags are dimensionless native mapping controls; inspect the returned exact curve points, tangents, lengths, and bounds because deformation intentionally changes geometry.", z.object({
    ids: uniqueBodyIds,
    sourceFace: faceRef,
    targetFace: faceRef,
    scaleU: z.number().finite().positive().max(1000).default(1),
    scaleV: z.number().finite().positive().max(1000).default(1),
    scaleNormal: z.number().finite().positive().max(1000).default(1),
    flipUV: z.boolean().default(false),
    flipNormal: z.boolean().default(false),
    mirror: z.boolean().default(false),
    intent,
    revision,
  }).strict().refine(
    (value) => value.sourceFace.bodyId !== value.targetFace.bodyId || value.sourceFace.faceId !== value.targetFace.faceId,
    "Source and target deformation faces must be different",
  ).refine(
    (value) => !value.ids.includes(value.sourceFace.bodyId) && !value.ids.includes(value.targetFace.bodyId),
    "Deformation curves must be separate from source and target face bodies",
  ), async ({ ids: curveIds, sourceFace, targetFace, scaleU, scaleV, scaleNormal, flipUV, flipNormal, mirror, intent: purpose, revision: current }) =>
    await journaled("deform-curves-between-faces", purpose, { curveIds, sourceFace, targetFace, scaleU, scaleV, scaleNormal, flipUV, flipNormal, mirror }, () =>
      session.get().deformCurvesBetweenFaces(curveIds, sourceFace, targetFace, { scaleU, scaleV, scaleNormal, flipUV, flipNormal, mirror }, current)), false, { destructiveHint: false });
  tool("plasticity_extract_edges", "Copy exact current body edges into native Wire curves while preserving their source bodies.", z.object({ edges: z.array(edgeRef).min(1).max(4096), intent, revision }).strict(), async ({ edges, intent: purpose, revision: current }) =>
    await journaled("extract-edges", purpose, { edges }, () => session.get().extractEdges(edges, current)));
  tool("plasticity_unjoin_faces", "Detach exact current faces from their native shells into separate Sheet bodies.", z.object({ faces: z.array(faceRef).min(1).max(4096), intent, revision }).strict(), async ({ faces, intent: purpose, revision: current }) =>
    await journaled("unjoin-faces", purpose, { faces }, () => session.get().unjoinFaces(faces, current)));
  tool("plasticity_insert_sheet", "Insert one separate current fill Sheet into explicit boundary edges of another current target Sheet. Plasticity consumes both input bodies and returns one rebuilt Sheet or Solid in one history step; every prior body and topology reference becomes stale, so inspect the returned state and validate the result.", z.object({
    targetSheetId: z.number().int().positive(),
    edgeIds: z.array(z.string().trim().min(1)).min(1).max(4096).refine((values) => new Set(values).size === values.length, "Target boundary edge IDs must be unique"),
    fillSheetId: z.number().int().positive(),
    intent,
    revision,
  }).strict().refine((value) => value.targetSheetId !== value.fillSheetId, "Target and fill Sheet IDs must be different"), async ({ targetSheetId, edgeIds, fillSheetId, intent: purpose, revision: current }) =>
    await journaled("insert-sheet", purpose, { targetSheetId, edgeIds, fillSheetId }, () => session.get().insertSheet(targetSheetId, edgeIds, fillSheetId, current)));
  tool("plasticity_unjoin_shells", "Explode every face of one or more current multi-face Solid or Sheet bodies into independent single-face native Sheets in one Plasticity history step. The selected bodies are replaced, one result may reuse a source stable ID, and all prior body and topology references become stale; use the returned state.", z.object({ ids: uniqueBodyIds, intent, revision }).strict(), async ({ ids: bodyIds, intent: purpose, revision: current }) =>
    await journaled("unjoin-shells", purpose, { ids: bodyIds }, () => session.get().unjoinShells(bodyIds, current)));
  tool("plasticity_create_solid_from_sheet", "Create a native Solid from one closed Sheet shell while preserving the source Sheet.", z.object({ id: z.number().int().positive(), intent, revision }).strict(), async ({ id, intent: purpose, revision: current }) =>
    await journaled("create-solid-from-sheet", purpose, { id }, () => session.get().createSolidFromSheet(id, current)));
  tool("plasticity_delete_faces", "Delete exact current faces from Solid or Sheet bodies, leaving the remaining native shell editable.", z.object({ faces: z.array(faceRef).min(1).max(4096), intent, revision }).strict(), async ({ faces, intent: purpose, revision: current }) =>
    await journaled("delete-faces", purpose, { faces }, () => session.get().deleteFaces(faces, current)));
  tool("plasticity_dissolve_faces", "Remove selected exact face boundaries by merging the faces into compatible adjacent native surfaces.", z.object({ faces: z.array(faceRef).min(1).max(4096), intent, revision }).strict(), async ({ faces, intent: purpose, revision: current }) =>
    await journaled("dissolve-faces", purpose, { faces }, () => session.get().dissolveFaces(faces, current)));
  tool("plasticity_patch_sheet_hole", "Fill one closed boundary loop on a native Sheet using exact current edge IDs.", z.object({ id: z.number().int().positive(), edgeIds: z.array(z.string().min(1)).min(3).max(4096), intent, revision }).strict(), async ({ id, edgeIds, intent: purpose, revision: current }) =>
    await journaled("patch-sheet-hole", purpose, { id, edgeIds }, () => session.get().patchSheetHole(id, edgeIds, current)));
  tool("plasticity_cap_sheet_holes", "Cap every planar open boundary of one or more native Sheet bodies in one history step.", z.object({ ids, intent, revision }).strict(), async ({ ids: sheetIds, intent: purpose, revision: current }) =>
    await journaled("cap-sheet-holes", purpose, { ids: sheetIds }, () => session.get().capSheetHoles(sheetIds, current)));
  tool("plasticity_extend_sheet_edges", "Linearly extend selected boundary edges of one native Sheet by a positive millimeter distance.", z.object({ id: z.number().int().positive(), edgeIds: z.array(z.string().trim().min(1)).min(1).max(4096), distanceMm: z.number().finite().positive(), intent, revision }).strict(), async ({ id, edgeIds, distanceMm, intent: purpose, revision: current }) =>
    await journaled("extend-sheet-edges", purpose, { id, edgeIds, distanceMm }, () => session.get().extendSheetEdges(id, edgeIds, distanceMm, current)));
  tool("plasticity_create_pipes", "Create native solid or hollow circular pipes along one or more Wire spines. Diameter and optional wall thickness are millimeters.", z.object({
    spineIds: ids,
    diameterMm: z.number().finite().positive(),
    wallThicknessMm: z.number().finite().nonnegative().default(0),
    intent,
    revision,
  }).strict(), async ({ spineIds, diameterMm, wallThicknessMm, intent: purpose, revision: current }) =>
    await journaled("create-pipes", purpose, { spineIds, diameterMm, wallThicknessMm }, () =>
      session.get().createPipes(spineIds, diameterMm, wallThicknessMm, current)));
  tool("plasticity_revolve_profile", "Revolve a planar Wire profile around a world-space axis. Axis origin is millimeters and the positive angle is degrees.", z.object({ id: z.number().int().positive(), axisOriginMm: vector, axis: direction, angleDegrees: z.number().finite().positive().max(360), intent, revision }).strict(), async ({ id, axisOriginMm, axis, angleDegrees, intent: purpose, revision: current }) =>
    await journaled("revolve-profile", purpose, { id, axisOriginMm, axis, angleDegrees }, () => session.get().revolveProfile(id, axisOriginMm, axis, angleDegrees, current)));
  tool("plasticity_thicken_sheets", "Thicken native Sheet bodies into solids. Front and back distances are nonnegative millimeters on opposite sides of each sheet.", z.object({ ids, frontMm: z.number().finite().nonnegative(), backMm: z.number().finite().nonnegative(), intent, revision }).strict().refine((value) => value.frontMm + value.backMm > 0, "At least one thicken distance must be positive"), async ({ ids: bodyIds, frontMm, backMm, intent: purpose, revision: current }) =>
    await journaled("thicken-sheets", purpose, { bodyIds, frontMm, backMm }, () => session.get().thickenSheets(bodyIds, frontMm, backMm, current)));
  tool("plasticity_draft_faces", "Draft exact faces by a signed angle around a planar neutral reference face. Positive angles open away from the reference face.", z.object({ id: z.number().int().positive(), faceIds: z.array(z.string()).min(1), referenceFace: faceRef, angleDegrees: z.number().finite().gt(-89).lt(89).refine((value) => value !== 0, "Draft angle must be nonzero"), intent, revision }).strict(), async ({ id, faceIds, referenceFace, angleDegrees, intent: purpose, revision: current }) =>
    await journaled("draft-faces", purpose, { id, faceIds, referenceFace, angleDegrees }, () => session.get().draftFaces(id, faceIds, referenceFace, angleDegrees, current)));
  tool("plasticity_offset_faces", "Offset exact B-Rep faces by a signed distance in millimeters.", z.object({ id: z.number().int().positive(), faceIds: z.array(z.string()).min(1), distanceMm: z.number().finite().refine((value) => value !== 0, "Distance must be nonzero"), intent, revision }), async ({ id, faceIds, distanceMm, intent: purpose, revision: current }) =>
    await journaled("offset-faces", purpose, { id, faceIds, distanceMm }, () => session.get().offsetFaces(id, faceIds, distanceMm, current)));
  tool("plasticity_move_faces", "Move exact current B-Rep faces by one nonzero world-space delta in millimeters. Plasticity extends and retrims adjacent faces; all topology references become stale after the edit.", z.object({ faces: z.array(faceRef).min(1).max(4096), deltaMm: direction, intent, revision }).strict(), async ({ faces, deltaMm, intent: purpose, revision: current }) =>
    await journaled("move-faces", purpose, { faces, deltaMm }, () => session.get().moveFaces(faces, deltaMm, current)));
  tool("plasticity_rotate_faces", "Rotate exact current B-Rep faces around a world-space pivot and axis. Pivot is millimeters and angle is degrees; Plasticity extends and retrims adjacent faces, invalidating old topology references.", z.object({ faces: z.array(faceRef).min(1).max(4096), pivotMm: vector, axis: direction, degrees: z.number().finite().refine((value) => value !== 0, "Angle must be nonzero"), intent, revision }).strict(), async ({ faces, pivotMm, axis, degrees, intent: purpose, revision: current }) =>
    await journaled("rotate-faces", purpose, { faces, pivotMm, axis, degrees }, () => session.get().rotateFaces(faces, pivotMm, axis, degrees, current)));
  tool("plasticity_scale_faces", "Scale exact current B-Rep face surfaces by positive world-space XYZ factors about a millimeter pivot. This is a direct surface edit: adjacent faces are retrimmed, and scaling a planar face within its unchanged infinite plane may be a no-op. Re-read exact geometry afterward.", z.object({
    faces: z.array(faceRef).min(1).max(4096),
    pivotMm: vector,
    factors: positiveVector.refine((values) => values.some((value) => value !== 1), "At least one scale factor must change"),
    intent,
    revision,
  }).strict(), async ({ faces, pivotMm, factors, intent: purpose, revision: current }) =>
    await journaled("scale-faces", purpose, { faces, pivotMm, factors }, () => session.get().scaleFaces(faces, pivotMm, factors, current)));
  tool("plasticity_thicken_faces", "Copy exact current faces from one Solid or Sheet into a new independent native body with nonnegative front and back thicknesses in millimeters. The original body is preserved. Front follows each selected face normal and back goes against it; at least one side must be positive. Re-read all topology and identify the new bodies after success.", z.object({
    faces: z.array(faceRef).min(1).max(4096),
    frontMm: z.number().finite().nonnegative(),
    backMm: z.number().finite().nonnegative(),
    intent,
    revision,
  }).strict().refine((value) => value.frontMm > 0 || value.backMm > 0, "At least one face-thickening distance must be positive"), async ({ faces, frontMm, backMm, intent: purpose, revision: current }) =>
    await journaled("thicken-faces", purpose, { faces, frontMm, backMm }, () => session.get().thickenFaces(faces, frontMm, backMm, current)));
  tool("plasticity_offset_face_loops", "Insert native offset loops around exact current faces from one Solid or Sheet at a signed millimeter distance. Positive and negative signs follow Plasticity's face and adjacent-surface orientation; they can place the new loop on the selected face or propagate it over adjacent faces. This splits topology without intentionally changing volume. Re-read the exact new faces and edges instead of assuming a world direction.", z.object({ faces: z.array(faceRef).min(1).max(4096), distanceMm: z.number().finite().refine((value) => value !== 0, "Distance must be nonzero"), individual: z.boolean().default(true), intent, revision }).strict(), async ({ faces, distanceMm, individual, intent: purpose, revision: current }) =>
    await journaled("offset-face-loops", purpose, { faces, distanceMm, individual }, () => session.get().offsetFaceLoops(faces, distanceMm, individual, current)));
  tool("plasticity_patch_solid_edge_loops", "Create independent native Sheet patches from exact edge loops selected on one current Solid. The source Solid, including any opening or through-hole, is preserved; this tool constructs covering surfaces and does not claim to heal, fill, or Boolean-close the Solid. Re-read the returned Sheets before thickening, sewing, or other downstream work.", z.object({ edges: z.array(edgeRef).min(1).max(4096), intent, revision }).strict(), async ({ edges, intent: purpose, revision: current }) =>
    await journaled("patch-solid-edge-loops", purpose, { edges }, () => session.get().patchSolidEdgeLoops(edges, current)));
  tool("plasticity_move_edges", "Move exact current B-Rep edges from one body by a nonzero world-space millimeter delta. Plasticity rebuilds adjacent faces, invalidating all prior topology references.", z.object({ edges: z.array(edgeRef).min(1).max(4096), deltaMm: direction, intent, revision }).strict(), async ({ edges, deltaMm, intent: purpose, revision: current }) =>
    await journaled("move-edges", purpose, { edges, deltaMm }, () => session.get().moveEdges(edges, deltaMm, current)));
  tool("plasticity_offset_edges", "Create native parallel edge offsets on one body at a signed millimeter distance. The sign chooses an adjacent surface according to Plasticity's oriented edge, so re-read the added strip and all topology after the edit.", z.object({ edges: z.array(edgeRef).min(1).max(4096), distanceMm: z.number().finite().refine((value) => value !== 0, "Distance must be nonzero"), intent, revision }).strict(), async ({ edges, distanceMm, intent: purpose, revision: current }) =>
    await journaled("offset-edges", purpose, { edges, distanceMm }, () => session.get().offsetEdges(edges, distanceMm, current)));
  tool("plasticity_delete_edges", "Remove exact current B-Rep edges from one body through Plasticity's native surface healing. Use for removable split or seam edges between compatible adjacent faces; the native operation can reject structural edges. Re-read all topology after success.", z.object({ edges: z.array(edgeRef).min(1).max(4096), intent, revision }).strict(), async ({ edges, intent: purpose, revision: current }) =>
    await journaled("delete-edges", purpose, { edges }, () => session.get().deleteEdges(edges, current)));
  tool("plasticity_offset_vertices", "Insert exact native split vertices at one positive millimeter distance along every incident edge of one or more current Solid or Sheet vertices from the same body. This preserves the outer shape and volume while rebuilding topology; it does not move the corner, chamfer it, or fillet it. Re-read every topology reference after success.", z.object({ vertices: z.array(measurementVertexRef).min(1).max(4096).refine((values) => new Set(values.map((value) => `${value.bodyId}:${value.vertexId}`)).size === values.length, "Shell vertex references must be unique"), distanceMm: z.number().finite().positive(), intent, revision }).strict(), async ({ vertices, distanceMm, intent: purpose, revision: current }) =>
    await journaled("offset-vertices", purpose, { vertices, distanceMm }, () => session.get().offsetVertices(vertices, distanceMm, current)));
  tool("plasticity_rectangular_face_pattern", "Repeat one exact connected feature-face set on the same Solid or Sheet in a native rectangular array. Counts include the source feature and spacing is center-to-center in millimeters. Re-read all topology and validate the result because Plasticity must recognize the selected faces as a repeatable feature.", z.object({
    faces: z.array(faceRef).min(1).max(4096),
    direction1: direction,
    count1: z.number().int().min(2).max(1000),
    spacing1Mm: z.number().finite().positive(),
    direction2: direction.default([0, 1, 0]),
    count2: z.number().int().min(1).max(1000).default(1),
    spacing2Mm: z.number().finite().nonnegative().default(0),
    intent,
    revision,
  }).strict().refine((value) => value.count2 === 1 || value.spacing2Mm > 0, "Second-axis spacing must be positive when count2 is greater than one"), async ({ faces, direction1, count1, spacing1Mm, direction2, count2, spacing2Mm, intent: purpose, revision: current }) =>
    await journaled("rectangular-face-pattern", purpose, { faces, direction1, count1, spacing1Mm, direction2, count2, spacing2Mm }, () => session.get().rectangularFacePattern(faces, direction1, count1, spacing1Mm, direction2, count2, spacing2Mm, current)));
  tool("plasticity_radial_face_pattern", "Repeat one exact connected feature-face set on the same Solid or Sheet around a world-space axis in a native radial array. Count includes the source feature and sweep is in degrees. Re-read all topology and validate the result because Plasticity must recognize the selected faces as a repeatable feature.", z.object({ faces: z.array(faceRef).min(1).max(4096), centerMm: vector, axis: direction, count: z.number().int().min(2).max(1000), sweepDegrees: z.number().finite().positive().max(360).default(360), intent, revision }).strict(), async ({ faces, centerMm, axis, count, sweepDegrees, intent: purpose, revision: current }) =>
    await journaled("radial-face-pattern", purpose, { faces, centerMm, axis, count, sweepDegrees }, () => session.get().radialFacePattern(faces, centerMm, axis, count, sweepDegrees, current)));
  tool("plasticity_hollow_faces", "Remove selected faces and shell a solid with an inward or outward wall thickness in millimeters.", z.object({ id: z.number().int().positive(), faceIds: z.array(z.string()).min(1), wallThicknessMm: z.number().finite().positive(), direction: z.enum(["inward", "outward"]).default("inward"), intent, revision }), async ({ id, faceIds, wallThicknessMm, direction: shellDirection, intent: purpose, revision: current }) =>
    await journaled("hollow-faces", purpose, { id, faceIds, wallThicknessMm, direction: shellDirection }, () => session.get().hollowFaces(id, faceIds, wallThicknessMm, shellDirection, current)));
  tool("plasticity_hollow_solids", "Turn one or more current Solid bodies into closed hollow Solids without removing an opening face. Inward preserves the outside envelope; outward preserves the original interior envelope. Wall thickness is in millimeters and every body is changed in one native history step.", z.object({
    ids: z.array(z.number().int().positive()).min(1).max(4096).refine((values) => new Set(values).size === values.length, "Solid IDs must be unique"),
    wallThicknessMm: z.number().finite().positive(),
    direction: z.enum(["inward", "outward"]).default("inward"),
    intent,
    revision,
  }).strict(), async ({ ids: solidIds, wallThicknessMm, direction: shellDirection, intent: purpose, revision: current }) =>
    await journaled("hollow-solids", purpose, { ids: solidIds, wallThicknessMm, direction: shellDirection }, () => session.get().hollowSolids(solidIds, wallThicknessMm, shellDirection, current)));
  tool("plasticity_mirror", "Mirror exact bodies across a world-space plane, either copying or moving the originals.", z.object({ ids, planeOriginMm: vector, planeNormal: direction, keepOriginal: z.boolean().default(true), intent, revision }), async ({ ids: bodyIds, planeOriginMm, planeNormal, keepOriginal, intent: purpose, revision: current }) =>
    await journaled("mirror", purpose, { bodyIds, planeOriginMm, planeNormal, keepOriginal }, () => session.get().mirror(bodyIds, planeOriginMm, planeNormal, keepOriginal, current)));
  tool("plasticity_rectangular_pattern", "Create a native rectangular body pattern using counts and center-to-center spacing in millimeters.", z.object({
    ids,
    direction1: direction,
    count1: z.number().int().min(2).max(1000),
    spacing1Mm: z.number().finite().positive(),
    direction2: direction.default([0, 1, 0]),
    count2: z.number().int().min(1).max(1000).default(1),
    spacing2Mm: z.number().finite().nonnegative().default(0),
    intent,
    revision,
  }).strict().refine((value) => value.count2 === 1 || value.spacing2Mm > 0, "Second-axis spacing must be positive when count2 is greater than one"), async ({ ids: bodyIds, direction1, count1, spacing1Mm, direction2, count2, spacing2Mm, intent: purpose, revision: current }) =>
    await journaled("rectangular-pattern", purpose, { bodyIds, direction1, count1, spacing1Mm, direction2, count2, spacing2Mm }, () => session.get().rectangularPattern(bodyIds, direction1, count1, spacing1Mm, direction2, count2, spacing2Mm, current)));
  tool("plasticity_radial_pattern", "Create a native radial body pattern around a world-space axis.", z.object({ ids, centerMm: vector, axis: direction, count: z.number().int().min(2).max(1000), sweepDegrees: z.number().finite().positive().max(360).default(360), intent, revision }).strict(), async ({ ids: bodyIds, centerMm, axis, count, sweepDegrees, intent: purpose, revision: current }) =>
    await journaled("radial-pattern", purpose, { bodyIds, centerMm, axis, count, sweepDegrees }, () => session.get().radialPattern(bodyIds, centerMm, axis, count, sweepDegrees, current)));
  tool("plasticity_curve_pattern", "Distribute current Solid or Sheet bodies along the full length of one native Wire spine. Count includes the source position; Plasticity creates independent native bodies, preserves the spine, and applies its verified tangent-following orientation in one history step.", z.object({
    ids: z.array(z.number().int().positive()).min(1).max(4096).refine((values) => new Set(values).size === values.length, "Curve-pattern body IDs must be unique"),
    spineId: z.number().int().positive(),
    count: z.number().int().min(2).max(1000),
    intent,
    revision,
  }).strict(), async ({ ids: bodyIds, spineId, count, intent: purpose, revision: current }) =>
    await journaled("curve-pattern", purpose, { bodyIds, spineId, count }, () => session.get().curvePattern(bodyIds, spineId, count, current)));
  tool("plasticity_rename", "Rename one body with Undo support.", z.object({ id: z.number().int().positive(), name: z.string().trim().min(1).max(120), intent, revision }), async ({ id, name, intent: purpose, revision: current }) =>
    await journaled("rename", purpose, { id, name }, () => session.get().rename(id, name, current)));
  tool("plasticity_delete", "Delete selected body IDs with Undo support.", z.object({ ids, intent, revision }), async ({ ids: bodyIds, intent: purpose, revision: current }) =>
    await journaled("delete", purpose, { bodyIds }, () => session.get().remove(bodyIds, current)));
  tool("plasticity_undo", "Undo the most recent document edit.", z.object({ intent, revision }), async ({ intent: purpose, revision: current }) =>
    await journaled("undo", purpose, {}, () => session.get().undo(current)));
  tool("plasticity_redo", "Redo the most recent undone document edit.", z.object({ intent, revision }), async ({ intent: purpose, revision: current }) =>
    await journaled("redo", purpose, {}, () => session.get().redo(current)));

  tool("plasticity_set_view", "Set a named viewport orientation and optionally fit all geometry.", z.object({ view: z.enum(["front", "back", "left", "right", "top", "bottom", "isometric"]), fit: z.boolean().default(false) }), async ({ view, fit }) =>
    await session.get().setView(view, fit));
  tool("plasticity_screenshot", "Save a PNG screenshot of the visible Plasticity renderer viewport to a new file without overwriting. Refuses hidden windows to avoid stale frames.", z.object({ path: z.string().min(1) }), async ({ path }) =>
    await session.get().screenshot(path), false, { destructiveHint: false });
  tool("plasticity_save_copy", "Save the current document to a new .plasticity file without overwriting.", z.object({ path: z.string().min(1) }), async ({ path }) =>
    await session.get().saveCopy(path), false, { destructiveHint: false });
  tool("plasticity_open_document", "Open a .plasticity document after writing the current document to a new backup file.", z.object({ path: z.string().min(1), backupPath: z.string().min(1), intent, revision }), async ({ path, backupPath, intent: purpose, revision: current }) =>
    await journaled("open-document", purpose, { path, backupPath }, () => session.get().openDocument(path, backupPath, current)));
  tool("plasticity_export_step", "Export exact B-Rep bodies to a new STEP file without overwriting.", z.object({ ids, path: z.string().min(1), revision }), async ({ ids: bodyIds, path, revision: current }) =>
    await session.get().exportStep(bodyIds, path, current), false, { destructiveHint: false });
  tool("plasticity_export_parasolid", "Export exact native B-Rep bodies to a new Parasolid text (.x_t) or binary (.x_b) file without overwriting. Use this for high-fidelity exchange with software that supports the Parasolid kernel format.", z.object({ ids, path: z.string().min(1), revision }), async ({ ids: bodyIds, path, revision: current }) =>
    await session.get().exportParasolid(bodyIds, path, current), false, { destructiveHint: false });
  tool("plasticity_export_stl", "Tessellate exact B-Rep bodies to a new millimeter-scaled binary STL for slicing. The result is a derived mesh, while STEP remains the editable source.", z.object({
    ids,
    path: z.string().min(1),
    chordToleranceMm: z.number().finite().positive().max(10).default(0.05),
    angleToleranceDegrees: z.number().finite().positive().max(90).default(15),
    revision,
  }).strict(), async ({ ids: bodyIds, path, chordToleranceMm, angleToleranceDegrees, revision: current }) =>
    await session.get().exportStl(bodyIds, path, current, chordToleranceMm, angleToleranceDegrees), false, { destructiveHint: false });
  tool("plasticity_export_3mf", "Tessellate current exact Solid or Sheet bodies to a new validated 3MF for slicers. Plasticity 26.1.3 declares meters, so the adapter applies its verified 0.001 scale to preserve millimeter dimensions and reports mesh bounds from the saved package. The result is a derived mesh; keep .plasticity or STEP as the editable source.", z.object({
    ids,
    path: z.string().min(1),
    chordToleranceMm: z.number().finite().positive().max(10).default(0.05),
    angleToleranceDegrees: z.number().finite().positive().max(90).default(15),
    revision,
  }).strict(), async ({ ids: bodyIds, path, chordToleranceMm, angleToleranceDegrees, revision: current }) =>
    await session.get().export3mf(bodyIds, path, current, chordToleranceMm, angleToleranceDegrees), false, { destructiveHint: false });
  tool("plasticity_export_obj", "Tessellate current exact Solid or Sheet bodies to a new validated Wavefront OBJ without overwriting. Coordinates are written in millimeters with Z up; the result reports counts and bounds parsed from the saved file. OBJ is a derived mesh for interchange or rendering, so retain .plasticity, STEP, or Parasolid as the editable source.", z.object({
    ids,
    path: z.string().min(1),
    chordToleranceMm: z.number().finite().positive().max(10).default(0.05),
    angleToleranceDegrees: z.number().finite().positive().max(90).default(15),
    revision,
  }).strict(), async ({ ids: bodyIds, path, chordToleranceMm, angleToleranceDegrees, revision: current }) =>
    await session.get().exportObj(bodyIds, path, current, chordToleranceMm, angleToleranceDegrees), false, { destructiveHint: false });
  tool("plasticity_export_svg", "Export coplanar native Wire profiles as a new millimeter-scaled SVG without overwriting. B-Rep Lines, full circles, trimmed circular arcs, and native Ellipse segments remain exact when Plasticity exposes their analytic carrier data; non-rational polynomial BCurves of integer degree 1 through 3, including periodic curves, are exported span-by-span as cubic Bezier commands only after additional exact B-Rep validation samples pass. Degree-1 and degree-2 non-rational fixtures have live production stdio verification with independent B-Rep samples on Plasticity 26.1.3. Rational BCurves that fit a conic and agree with 65 dense exact B-Rep samples are represented by an SVG ellipse/arc and marked with sampled-validation metadata; this does not prove global equality, and anything that fails validation uses the approximation path. Other planar B-Rep curves use an adaptive polyline checked at quarter samples against curveChordToleranceMm and curveChordAngleDegrees and are explicitly marked as approximations in SVG metadata. Returned deviation is the maximum tested chord deviation, not a proof of global error. Noncoplanar Wires are rejected; for Solid drawings use plasticity_export_hiddenline_svg. Keep the .plasticity or STEP file as the editable source.", z.object({
    ids: z.array(z.number().int().positive()).min(1).max(4096).refine((values) => new Set(values).size === values.length, "Wire IDs must be unique"),
    path: z.string().min(1),
    curveChordToleranceMm: z.number().finite().positive().max(5).default(0.05),
    curveChordAngleDegrees: z.number().finite().positive().max(30).default(5),
    revision,
  }).strict(), async ({ ids: wireIds, path, revision: current, curveChordToleranceMm, curveChordAngleDegrees }) =>
    await session.get().exportSvg(wireIds, path, current, curveChordToleranceMm, curveChordAngleDegrees), false, { destructiveHint: false });
  tool("plasticity_export_hiddenline_svg", "Project current native Solid B-rep geometry through Plasticity's hidden-line generator into a new vector SVG without overwriting. Requires an orthographic current view; output geometry is calibrated to projected model millimeters and includes visible and hidden line styles. Set a named orthographic camera with plasticity_set_view first when needed. This is a derived drawing, not an editable CAD model; retain .plasticity or STEP.", z.object({
    ids: z.array(z.number().int().positive()).min(1).max(128).refine((values) => new Set(values).size === values.length, "Solid IDs must be unique"),
    path: z.string().min(1),
    curveChordToleranceMm: z.number().finite().positive().max(5).default(0.05),
    curveChordAngleDegrees: z.number().finite().positive().max(30).default(5),
    marginMm: z.number().finite().min(0).max(1_000).default(1),
    revision,
  }).strict(), async ({ ids: bodyIds, path, curveChordToleranceMm, curveChordAngleDegrees, marginMm, revision: current }) =>
    await session.get().exportHiddenLineSvg(bodyIds, path, current, curveChordToleranceMm, curveChordAngleDegrees, marginMm), false, { destructiveHint: false });
  tool("plasticity_import_step", "Import exact STEP geometry into the current document. Returns compact document state, imported body IDs/count, source SHA-256, and a persistent local provenance record with native B-Rep measurements. Optionally provide HTTPS source provenance. The record is historical after further edits; use plasticity_body_info for selected bodies and plasticity_measure_solid_properties for measurements.", z.object({
    path: z.string().min(1),
    source: importedReferenceSourceSchema.optional(),
    intent,
    revision,
  }).strict(), async ({ path, source, intent: purpose, revision: current }) => {
    return await importStepReference(path, source, purpose, current);
  });
  tool("plasticity_download_and_import_step", "Download one explicitly selected HTTPS STEP file or ZIP containing exactly one STEP member from a public hostname and import it as exact native CAD geometry. Returns compact document state and changed body IDs/count; use plasticity_body_info for selected exact B-Rep detail. Provide source.sourceUrl as the direct file/archive URL and source.sourcePageUrl as the candidate page URL when available. The downloader pins a resolved public IPv4 address per request, limits redirects, archive size and response size, validates the STEP envelope and archive CRC, stores private content-addressed source and import artifacts, and records both source/archive provenance hashes. Search candidates first with plasticity_search_product_references, review the source, license, format and fit, then select one before calling this importer. Never use arbitrary, untrusted candidates as exact dimensions.", z.object({
    source: importedReferenceSourceSchema,
    intent,
    revision,
  }).strict(), async ({ source, intent: purpose, revision: current }) => {
    const beforeDownload = await session.get().state();
    if (beforeDownload.revision !== current) throw new Error(`Stale document revision ${current}; current revision is ${beforeDownload.revision}`);
    const downloaded = await stepReferenceDownloader.download(source.sourceUrl);
    const sourceReference = {
      ...source,
      sourceUrl: provenanceSafeUrl(source.sourceUrl),
      ...(source.sourcePageUrl ? { sourcePageUrl: provenanceSafeUrl(source.sourcePageUrl) } : {}),
    };
    const acquisition = {
      bytes: downloaded.bytes,
      finalUrl: provenanceSafeUrl(downloaded.finalUrl),
      ...(downloaded.sourceArchive ? { sourceArchive: downloaded.sourceArchive } : {}),
    };
    return await importStepReference(downloaded.path, sourceReference, purpose, current, acquisition, downloaded.sha256);
  }, false, { openWorldHint: true });
  tool("plasticity_list_reference_assets", "Read one explicitly selected product or CAD source page and list its direct STEP/Parasolid, mesh (including 3MF), and drawing links. This performs one bounded HTTPS GET of the selected HTML page only; it does not download an asset, import geometry, run page scripts, or mutate Plasticity. Provide the same explicit allowedDomains used for the selected search. Page hosts, redirects, and returned asset hosts must match those domains, DNS is pinned to public IPv4, and all query-bearing asset links are omitted to avoid exposing expiring credentials. Review the returned exact asset URL, format, license, and fit before separately choosing a download/import tool.", z.object({
    sourcePageUrl: z.string().url().max(4_096),
    allowedDomains: z.array(z.string().trim().min(1).max(253)).min(1).max(20),
  }).strict(), async ({ sourcePageUrl, allowedDomains }) => {
    const listAssets = stepReferenceDownloader.listReferenceAssets;
    if (!listAssets) throw new Error("This server runtime does not provide selected-page reference asset discovery");
    return await listAssets.call(stepReferenceDownloader, sourcePageUrl, allowedDomains);
  }, true, { openWorldHint: true });
  tool("plasticity_download_and_import_reference_mesh", "Download one explicitly selected HTTPS STL or OBJ file from a public hostname and import it into Plasticity as an approximate reference mesh. Declare sourceUnit because STL is unitless and community mesh scale can be ambiguous. The downloader pins a public IPv4 address, limits redirects and payloads to 64 MiB, validates the mesh structure and finite coordinates, and stores a private SHA-256-addressed artifact. The import is journaled with redacted source provenance and measured mesh bounds. This is tessellated reference geometry, not native B-rep or proof of exact product dimensions; do not use it as a fit-critical datum without checking official drawings or user-confirmed measurements.", z.object({
    source: importedReferenceSourceSchema,
    format: z.enum(["stl", "obj"]),
    sourceUnit: z.enum(["millimeter", "centimeter", "meter", "inch", "foot"]),
    intent,
    revision,
  }).strict(), async ({ source, format, sourceUnit, intent: purpose, revision: current }) => {
    const downloader = stepReferenceDownloader.downloadReferenceMesh;
    if (!downloader) throw new Error("This server runtime does not provide validated reference-mesh downloads");
    const beforeDownload = await session.get().state();
    if (beforeDownload.revision !== current) throw new Error(`Stale document revision ${current}; current revision is ${beforeDownload.revision}`);
    const downloaded = await downloader.call(stepReferenceDownloader, source.sourceUrl, format);
    if (downloaded.format !== `reference-mesh-${format}`) throw new Error(`Reference-mesh downloader returned ${downloaded.format}; expected reference-mesh-${format}`);
    const sourceHash = await sha256File(downloaded.path);
    if (sourceHash !== downloaded.sha256) throw new Error("Downloaded reference-mesh artifact changed before import; inspect the private artifact before retrying");
    const currentState = await session.get().state();
    if (currentState.documentToken !== beforeDownload.documentToken || currentState.revision !== beforeDownload.revision) {
      throw new Error("Plasticity document changed while the reference mesh was downloading; inspect the document before retrying the import");
    }
    const sourceReference = {
      ...source,
      sourceUrl: provenanceSafeUrl(source.sourceUrl),
      ...(source.sourcePageUrl ? { sourcePageUrl: provenanceSafeUrl(source.sourcePageUrl) } : {}),
      artifactHash: downloaded.sha256,
      format,
      sourceUnit,
      exactGeometry: false as const,
    };
    const acquisition = { bytes: downloaded.bytes, finalUrl: provenanceSafeUrl(downloaded.finalUrl) };
    let snapshots: { before: RuntimeState; after: RuntimeState } | undefined;
    const imported = await journaled("download-and-import-reference-mesh", purpose, {
      sourceReference,
      acquisition,
      sourceArtifactHash: downloaded.sha256,
    }, async () => {
      const beforeImportHash = await sha256File(downloaded.path);
      if (beforeImportHash !== downloaded.sha256) throw new Error("Downloaded reference-mesh artifact changed before native import");
      const state = await session.get().importReferenceMesh(downloaded.path, sourceUnit, current);
      if (await sha256File(downloaded.path) !== downloaded.sha256) {
        throw new Error("Reference-mesh file changed during import; inspect Plasticity and construction history before retrying");
      }
      return state;
    }, (before, after) => { snapshots = { before, after }; }, LONG_NATIVE_IMPORT_TIMEOUT_MS);
    if (!snapshots) throw new Error("Native reference-mesh import completed without a captured scene snapshot; reconcile the construction journal before retrying");
    const previousIds = new Set((snapshots.before.referenceMeshes ?? []).map((mesh) => mesh.id));
    const importedMeshes = (snapshots.after.referenceMeshes ?? []).filter((mesh) => !previousIds.has(mesh.id));
    return {
      ...imported,
      referenceArtifactHash: downloaded.sha256,
      sourceReference,
      acquisition,
      approximateReference: true,
      measurementSource: "reference-mesh",
      importedMeshes,
    };
  }, false, { openWorldHint: true });
  tool("plasticity_download_and_import_reference_3mf", "Download one explicitly selected direct HTTPS 3MF file from a public hostname and import it through Plasticity as approximate reference mesh geometry. The embedded 3MF unit is used by the native importer; returned bounds are reference-mesh measurements, not native B-rep accuracy or proof of exact product dimensions. The downloader pins public IPv4, limits redirects and payloads to 64 MiB, validates the bounded ZIP/XML package, CRCs, paths and mesh indices, then stores a private SHA-256-addressed artifact. It records the artifact hash, source, acquisition and all import-time meshes in the persistent CAD reference-import registry; read the historical record with plasticity_get_cad_reference_import. Review source, license and product/SKU first; this does not import exact editable CAD or start a print.", z.object({
    source: importedReferenceSourceSchema,
    intent,
    revision,
  }).strict(), async ({ source, intent: purpose, revision: current }) => {
    const downloader = stepReferenceDownloader.downloadReferenceThreeMf;
    if (!downloader) throw new Error("This server runtime does not provide validated 3MF reference downloads");
    const beforeDownload = await session.get().state();
    if (beforeDownload.revision !== current) throw new Error(`Stale document revision ${current}; current revision is ${beforeDownload.revision}`);
    const downloaded = await downloader.call(stepReferenceDownloader, source.sourceUrl);
    if (downloaded.format !== "reference-mesh-3mf") throw new Error(`3MF downloader returned ${downloaded.format}; expected reference-mesh-3mf`);
    const acquisition = { bytes: downloaded.bytes, finalUrl: provenanceSafeUrl(downloaded.finalUrl) };
    return await importReferenceThreeMfArtifact(downloaded.path, source, purpose, current, acquisition, downloaded.sha256, beforeDownload.documentToken);
  }, false, { openWorldHint: true });
  tool("plasticity_import_svg", "Import a local SVG as editable native planar Wires in one Plasticity history step. The source unit explicitly defines how SVG coordinate values map to physical length. Closed non-self-intersecting contours also produce revision-bound planar Regions that can be extruded or used as profiles; verify exact Wire geometry after import because SVG transforms and curve content can change the resulting placement and topology.", z.object({
    path: z.string().min(1),
    sourceUnit: z.enum(["millimeter", "centimeter", "meter", "inch", "foot"]),
    intent,
    revision,
  }).strict(), async ({ path, sourceUnit, intent: purpose, revision: current }) =>
    await journaled("import-svg", purpose, { path, sourceUnit }, () => session.get().importSvg(path, sourceUnit, current)));
  tool("plasticity_import_reference_mesh", "Import a local STL or OBJ as an approximate reference mesh in one Plasticity history step. The source unit is explicit because STL is unitless and community OBJ scale is often ambiguous. The result can be selected and transformed, but its mesh bounds and triangles are reference evidence only; use manufacturer CAD, drawings, or user-confirmed dimensions for exact modeling.", z.object({
    path: z.string().min(1),
    sourceUnit: z.enum(["millimeter", "centimeter", "meter", "inch", "foot"]),
    intent,
    revision,
  }).strict(), async ({ path, sourceUnit, intent: purpose, revision: current }) =>
    await journaled("import-reference-mesh", purpose, { path, sourceUnit }, () => session.get().importReferenceMesh(path, sourceUnit, current)));
  tool("plasticity_import_reference_3mf", "Import a local 3MF as approximate reference mesh geometry through Plasticity's native importer. The file's embedded unit determines scale; read the returned mesh bounds and keep them distinct from exact native B-rep dimensions. The server stores the artifact hash, import-time document/revision, mesh IDs, bounds and topology counts in the persistent CAD reference-import registry; optional source URLs are redacted and retain license and confidence. Read the historical record with plasticity_get_cad_reference_import.", z.object({
    path: z.string().min(1),
    source: importedReferenceSourceSchema.optional(),
    intent,
    revision,
  }).strict(), async ({ path, source, intent: purpose, revision: current }) =>
    await importReferenceThreeMfArtifact(path, source, purpose, current));
  tool("plasticity_import_parasolid", "Import a validated Parasolid text (.x_t) or binary (.x_b) file as native editable B-Rep geometry. Returns compact document state, imported body IDs/count, artifact SHA-256, and historical document/revision provenance with exact imported-body measurements. Optional source metadata records the direct asset and source page. Use plasticity_body_info for selected bodies.", z.object({ path: z.string().min(1), source: importedReferenceSourceSchema.optional(), intent, revision }).strict(), async ({ path, source, intent: purpose, revision: current }) =>
    await importParasolidReference(path, source, purpose, current));
  tool("plasticity_download_and_import_parasolid", "Download one explicitly selected HTTPS Parasolid file or ZIP containing exactly one compatible member from a public hostname and import it as exact native B-Rep geometry. Returns compact document state and changed body IDs/count; use plasticity_body_info for selected exact B-Rep detail. Select the source page and license first; source.sourceUrl is the direct file/archive URL and source.sourcePageUrl should identify the product page. Choose the exact representation explicitly; .xmt_txt is text and .xmt_bin is binary. DNS is pinned to public IPv4 addresses; redirects, archive/response size, content header, revision, hashes and imported B-Rep provenance are checked.", z.object({
    source: importedReferenceSourceSchema,
    representation: z.enum(["x_t", "x_b", "xmt_txt", "xmt_bin"]),
    intent,
    revision,
  }).strict(), async ({ source, representation, intent: purpose, revision: current }) => {
    const beforeDownload = await session.get().state();
    if (beforeDownload.revision !== current) throw new Error(`Stale document revision ${current}; current revision is ${beforeDownload.revision}`);
    const downloaded = await stepReferenceDownloader.downloadParasolid(source.sourceUrl, representation);
    const sourceReference = {
      ...source,
      sourceUrl: provenanceSafeUrl(source.sourceUrl),
      ...(source.sourcePageUrl ? { sourcePageUrl: provenanceSafeUrl(source.sourcePageUrl) } : {}),
    };
    const acquisition = {
      bytes: downloaded.bytes,
      finalUrl: provenanceSafeUrl(downloaded.finalUrl),
      ...(downloaded.sourceArchive ? { sourceArchive: downloaded.sourceArchive } : {}),
    };
    return await importParasolidReference(downloaded.path, sourceReference, purpose, current, acquisition, downloaded.sha256);
  }, false, { openWorldHint: true });

  server.registerPrompt("plasticity_model_from_reference", {
    description: "Guide an agent from a photo or sketch to a verified editable Plasticity model.",
    argsSchema: {
      referenceDescription: z.string().min(1),
      intendedUse: z.string().optional(),
      defaultUnits: z.enum(["mm", "inch"]).default("mm"),
    },
  }, ({ referenceDescription, intendedUse, defaultUnits }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Create an editable native Plasticity model from this reference: ${referenceDescription}

## SVG export limits

Use \`plasticity_export_svg\` for coplanar Wire profiles when all selected Wires share one plane. It preserves exact native Line endpoints, analytic full circles/arcs, and native Ellipse segments when the exact carrier interval is available. Non-rational polynomial BCurves of integer degree 1 through 3, including periodic curves, export span-by-span as cubic Bezier commands only after extra exact B-Rep samples pass a tight numerical residual check. Non-rational degree-1 and degree-2 fixtures now also have live production-stdio coverage in Plasticity 26.1.3 via \`npm run accept:native-svg-polynomial-degrees\`; each SVG span is checked against independent native B-Rep samples. Rational BCurves are represented by SVG ellipse/arcs only if five exact B-Rep samples fit a stable conic and 65 further exact samples agree within a scale-aware tolerance; the SVG labels this as a sampled ellipse fit because finite samples do not prove global equality. Anything that fails the conic checks uses adaptive polylines. Other planar B-Rep curves become adaptive polylines controlled by \`curveChordToleranceMm\` and \`curveChordAngleDegrees\`; the SVG marks those paths as approximations and the returned maximum is based on quarter-point checks, not a global error proof. Periodic BCurve knot metadata may include wrapped extension knots; use the returned exact curve structure as raw native metadata, not as the active SVG span count. For a Solid drawing, set an orthographic view with \`plasticity_set_view\`, then use \`plasticity_export_hiddenline_svg\`; it uses Plasticity's native hidden-line projector and reports dimensions in the orthographic model plane. Hidden-line output is a derived drawing, so keep the native .plasticity or STEP file as the editable model. Perspective views, Sheets, and instances are not accepted by this tool.

## Reference, design decisions, and practical strength checks

For an attached photo or sketch, first call \`plasticity_analyze_design_reference\` with its accessible local image path and this task description. Read its structured observations, per-request one-based \`sourceImageIndices\`, scale status, functional interfaces, feature candidates and single next question package; map each index to the supplied attachment order when explaining evidence in Codex. An empty source index list means the observation is not image-derived. Use \`plasticity_design_reference_request\` only to read a persisted result, never to retry. Compare distinct views for agreement and keep conflicting observations separate; ask about a conflict only if it affects the next design decision. Do not start CAD changes while the next decision-relevant question is unanswered unless the user explicitly delegates that modeling action. Treat image observations as evidence, not dimensions: never derive exact millimeters from an unscaled photo or sketch. A clear drawing dimension or native B-Rep read-back is measured evidence; a visual estimate is not.

For a named product, call \`plasticity_search_product_references\` and prefer official manufacturer CAD and drawings, then qualified distributors and established CAD libraries. It uses only the isolated Codex live-web search capability, has no CAD, shell, local-file or import tools, and returns candidate source-page URLs plus only direct asset URLs exposed by web-search/open-page results. Review the source, license, file format, confidence and fit-critical dimensions; search never downloads or imports. If a selected source page names CAD files but search events do not expose their complete URLs, call \`plasticity_list_reference_assets\` with that exact page URL and the same explicit allowed-domain list; it makes one bounded, non-scripted HTML GET and returns only CAD/drawing links on the selected domains. It rejects non-public DNS, off-domain redirects/assets and all query-bearing asset links, and never downloads an asset. Do not invent or construct file URLs. Review the exact returned link, license, format and product/SKU before continuing. A direct STEP file or ZIP containing exactly one STEP member can be passed to \`plasticity_download_and_import_step\` with \`sourceUrl\` set to the selected direct asset URL and optional \`sourcePageUrl\` set to the candidate page; archive hash and selected member path are retained with the import provenance. Capture the current Plasticity revision before calling it. For a Parasolid file or ZIP, use \`plasticity_download_and_import_parasolid\` and set \`representation\` to \`x_t\`, \`x_b\`, \`xmt_txt\`, or \`xmt_bin\` only when the exact text/binary representation is known; never infer it when the candidate omits it. The archive must contain exactly one matching member. Both native CAD import tools require HTTPS to public DNS-resolved IPv4 hosts, pin the resolved address, limit redirects, archive and expanded-member sizes, validate the file header and ZIP CRC, check the Plasticity revision and imported-file hash, and save private artifact plus native-B-Rep provenance. Query values are redacted in provenance. For a 3MF reference, use \`plasticity_download_and_import_reference_3mf\` only after reviewing the selected direct file, source page, license, and product/SKU; it creates approximate mesh references, not editable native B-Rep. The bounded downloader checks HTTPS/public DNS, redirects, package limits and mesh structure. Local and downloaded 3MF imports save a persistent provenance record containing artifact hash, source and import-time mesh IDs, bounds and topology counts. Read it with \`plasticity_get_cad_reference_import\` or list it with \`plasticity_list_cad_reference_imports\`; compare the historical document/revision and imported mesh list with the current scene before using any mesh ID or measurement. The reference-import records survive an MCP restart; the construction journal has separate durability and must be read from its dedicated history resource. If Workbench is enabled, upload the original artifact and register the same returned hash only after upload succeeds.

Resolve only facts that can change the next geometry decision. For a bracket or support, first establish what it carries, how it is mounted, the likely load direction, and whether use is ordinary/static or includes impact or safety-critical consequences. If the user cannot provide a force, ask what object is supported and how it is used; research reliable mass/material data for named products when useful and show the source and remaining uncertainty. Ask one compact logical package at a time. Do not repeat later questions before their answers establish that they matter. The user may delegate ordinary choices; explain the proposed choice and its effect, record it as an assumption, and keep critical unknowns visible.

Use strength checks at the decision point where they help: after the load path and a first geometry are understood, and before presenting a load-bearing design as ready to manufacture. For ordinary printed enclosures, covers, stands, and brackets, keep the first pass practical: use the known load/use, mounting, material, printer/process, wall dimensions, and clearances to identify obvious concerns and propose a reasonable provisional geometry. Do not require physical coupon campaigns or detailed FEA before making a useful first model. Do not claim that a rule-of-thumb or unsupported estimate is a verified strength result. If the part is safety-critical, sees impact/fatigue, carries an unclear or high load, or a supported calculation would change the design, ask only for the missing decision-relevant facts and use the appropriate deterministic strength tools. Load the \`plasticity_strength_first\` prompt and \`plasticity://strength/workflow\` resource for that deeper check; if essential evidence or a supported method is missing, explain the limit and keep the result provisional. Then make the accepted or delegated native Plasticity changes, read exact B-Rep dimensions back, check function and printability, and report remaining assumptions. Workbench is optional; keep the conversation in Codex.

After MCP restarts, read \`plasticity_construction_history\` before further CAD edits. Connect to the explicit Plasticity window and call \`plasticity_construction_journal\`; check \`durableSyncStatus\` against the last event. Inspect the current status, bodies and selection if the document/revision diverged or the last outcome is unknown. Durable history supports reconciliation only: never replay a command or issue Undo from an old record automatically.

Use plasticity_hollow_solids only when the design requires a fully enclosed cavity. Use plasticity_hollow_faces when an enclosure needs one or more explicit openings, and select those opening faces from the current exact B-Rep.

When an existing Solid or Sheet must drive a gasket, lid, clearance envelope, or mating profile, use plasticity_create_body_outlines with an explicit current construction plane. Use source placement to retain the silhouette at the source geometry and workplane placement to project it onto the selected plane; verify the returned exact Wire and Region before offsetting or extruding it.

When an existing Wire needs an independent editable copy, use plasticity_duplicate_curves and transform the returned new stable body IDs. When a current Region boundary must become a separate Wire, use plasticity_create_curves_from_regions. Coincident copied boundaries make Plasticity recompute automatic Regions: discard every prior Region reference, read the returned state or call plasticity_list_regions, and only then continue to Extrude, Sweep, Loft, or offsets.

Use plasticity_create_torus when the design needs an exact ring torus such as a circular seal body, rounded ring, or toroidal reference envelope. Supply the center, symmetry axis, a nonparallel radial zero direction, major radius to the tube centerline, and minor tube radius; the verified ring-torus contract requires major radius greater than minor radius. The tool preserves its exact circular Wire profile and creates the Torus Solid in one history step. Verify the Torus surface type, bounds, native validity, and mass properties before downstream Boolean work.

For a routed channel, gasket, or curved slot with a known centerline, create or select a planar multi-segment or curved Wire spine and use plasticity_create_slot_profiles with the full finished width. It preserves the spine and creates a separate closed Region-ready Wire. A lone straight segment does not define the native plane, so use plasticity_create_slotted_hole for a straight fastener slot.

Use plasticity_create_cone for a pointed cone or unequal-radius conical transition. Supply the bottom center, bottom and top radii, axial height, axis, and a nonparallel radial direction; topRadiusMm=0 creates a pointed cone. Equal radii belong to plasticity_create_cylinder. The tool preserves its closed meridional Wire and creates the exact revolved Solid in one history step. Verify analytic Cone and Plane faces, bounds, native validity, and volume before downstream Boolean work.

When a Solid or rigid multi-Solid assembly exceeds the selected printer's usable build volume, call workbench_assess_printability and treat its rotationDeg and sizeMm as a recommendation for that exact model revision. Pass every exact native Solid ID that forms the rigid printed group to plasticity_orient_bodies_for_print with the same expectedSizeMm; the tool rotates them together around the union B-Rep center, refuses a predicted-size mismatch before mutation, and returns measured union bounds. Re-run workbench_assess_printability and slicing on those exact bounds; the orientation tool does not prove slicer fit. If the part or rigid group is aligned to the printer axes but still exceeds the usable X/Y/Z volume (subtract the agreed bed margin first), use plasticity_split_solid_to_build_volume for one Solid to derive evenly spaced world planes and split it; use plasticity_split_solid_by_plane(s) only when the user needs a specific seam or nonuniform cells. Do not treat separate assembly components as a single Solid split target: preserve the assembly and split only the component(s) that need it. Never infer plane placement from an unscaled photo or reference mesh. The automatic grid tool does not optimize seams for strength/support/assembly or add joints. Before any CAD split or joint mutation, explain why the DFM plan needs multiple parts, show the available supported joint choices and their effect on strength, assembly and printability, then get the user's agreement; the user may explicitly delegate ordinary joint selection. Offer only joints backed by a callable native Plasticity recipe; if a DFM option has no implemented native recipe, state that limitation instead of implying it can be built. Never invent fit clearance: use an exact printer/material/profile qualification only when it matches this process, otherwise ask the user or propose a separate calibration print and retain the fit as unqualified. A flat split is only a manufacturable assembly when the agreed adhesive, fastener or other retention method is defined. For alignment pins, resolve each explicit pin center on the mating plane and prefer plasticity_create_locating_pin_pair_pattern for 2–64 locations; it joins all pins in one Boolean and cuts all matching sockets in another. Use plasticity_create_locating_pin_pair for a single location. Require exact, user-approved or process-qualified pin dimensions and radial/axial clearances; never infer a print fit from non-interference. After agreement, split only one Solid, identify every exact adjacent pair from current B-Rep bounds, apply the chosen native joint, then validate all bodies with native Check, inspect interference and exact bounds, and run DFM again before exporting distinct artifacts for slicing. Geometric non-interference is not proof of assembly clearance, physical fit, joint strength or safety. If a multi-plane recipe reports partial completion or uncertain outcome, reconcile and inspect the scene before taking another action; never resubmit or automatically undo it.

Use plasticity_rebuild_face when one imported or constructed Solid/Sheet face needs a simpler native B-Surface carrier before later surface work. Supply one current exact face and an explicit positive refit tolerance. The verified mode projects the existing boundary onto the rebuilt surface; the tolerance is a Plasticity approximation input rather than independently measured deviation. Re-read the entire owning body, surface structure, continuity, functional dimensions, mass properties, and plasticity_validate_bodies because every old face and edge reference becomes stale and the shape can move within the requested tolerance.

Use plasticity_match_faces when one or more current Solid/Sheet faces must terminate exactly on another current face's carrier surface, for example fitting a protrusion or enclosure feature to a cylindrical or sculpted reference. Select the faces to change separately from the replacement face. Plasticity extends or retrims adjacent faces, preserves a replacement body that is external to the edited bodies, and keeps the edited body IDs, but every prior topology reference becomes stale. Re-read the returned bodies and verify the new analytic surface type, bounds, mass properties, interference, and native validity; do not assume that nearby or visually overlapping faces are matchable.

For exact B-Spline refinement, inspect the current Wire first. Use plasticity_raise_curve_degree when downstream editing needs a higher polynomial degree without adding shape detail. Use plasticity_subdivide_curves when local editing needs more knots across every B-Spline segment while preserving the existing degree and path. Use plasticity_insert_curve_knot when only one exact segment needs one additional local control point: obtain its entity ID and direction first, choose a normalized parameter strictly between the returned start and end, then inspect the result. Use plasticity_evaluate_curve_segments to read the exact position and tangent before a parameter-based local edit. Use plasticity_split_curve_segment when one nonperiodic segment must become two selectable consecutive segments without changing the path; discard every prior segment reference afterward. Each call applies one native refinement step; inspect the resulting structure and functional geometry before continuing. When a spatial Wire must lie on a known plane, use plasticity_planarize_curves with that explicit world-space plane; this changes the path by orthogonal projection and can reverse its parameter direction, so confirm the native plane with plasticity_inspect_curve_planarity and recheck endpoints, direction, and functional dimensions.

When the user reshapes a Wire manually or asks for a local B-Spline adjustment, call plasticity_list_curve_control_points at the current revision. Read a manual handle selection through plasticity_current_selection, or call plasticity_select_curve_control_points to highlight the exact handles under discussion without changing document history. Transform only the returned boundary vertices or interior control points: use plasticity_move_curve_control_points for a shared world-space delta, plasticity_slide_curve_control_points for a positive distance along each handle's returned local positive-U or negative-U direction, plasticity_rotate_curve_control_points for an explicit pivot/axis/angle, and plasticity_scale_curve_control_points for explicit positive XYZ factors about a pivot. Use plasticity_delete_curve_control_points only for explicitly selected interior points on one Wire; deletion changes the path and reindexes the remaining handle IDs, so discard every old reference. After any edit, re-read the handles and verify the resulting exact B-Rep endpoints, tangents, structure, and functional dimensions. Treat native control-handle positions as edit coordinates, not independent dimensional proof.

When the user pushes, tilts, or resizes existing Solid or Sheet surfaces, resolve the current exact face references and use plasticity_move_faces, plasticity_rotate_faces, or plasticity_scale_faces. These are direct B-Rep edits: Plasticity extends and retrims adjacent surfaces, so discard all prior topology references and re-read the body after every call. Verify the result with exact face normals, radii, edge lengths, planar-face measurements, and plasticity_validate_bodies. Scaling acts on the underlying face surface in world XYZ; scaling a planar face only within its unchanged infinite plane can legitimately produce no geometric change, so use moved or rotated supporting faces when the design intent is a taper and never accept requested factors as proof of the result. Use plasticity_thicken_faces when selected existing surfaces should become a new independent wall, cover, insert, or reinforcement with explicit front and back thickness; it preserves the source body, and the sign direction comes from each face normal. Use plasticity_offset_face_loops to create inset or propagated topology loops before a later face edit, but inspect where Plasticity placed the loop because the signed distance follows oriented face adjacency rather than a world direction and does not itself change volume. Use plasticity_patch_solid_edge_loops only to construct independent Sheet patches from selected Solid loops; the original hole remains until a separately planned sewing, thickening, or Boolean workflow modifies it, so never report that this tool alone repaired or filled the Solid. When a separately modeled Sheet must close or rebuild an explicit open boundary of another Sheet shell, use plasticity_insert_sheet with the target boundary-edge loop and fill Sheet; it consumes both bodies, may return a Solid when closure succeeds, and invalidates all previous references. Re-read exact topology, mass properties, and native validity after insertion.

Before handing geometry to a slicer, validate the current exact B-Rep bodies and keep a new .plasticity, STEP, or Parasolid file as the editable source. Use plasticity_export_parasolid for exact native .x_t/.x_b exchange and plasticity_import_parasolid to recover those files as editable B-Rep geometry. Prefer plasticity_export_3mf when the slicer accepts 3MF: the adapter applies Plasticity 26.1.3's verified meter conversion, validates the OPC package and embedded mesh, and returns the actual mesh bounds in millimeters for comparison with the exact body. Use plasticity_export_stl when the selected slicer workflow specifically requires STL. Use plasticity_export_obj for a millimeter-scaled, Z-up derived mesh when an interchange or rendering workflow requires Wavefront OBJ; compare its parsed saved-file bounds with the exact source. All three are derived tessellations, so never use a mesh as proof of native CAD accuracy and never infer that a successful export authorizes starting a print.

When the user moves a local Solid or Sheet boundary, resolve current exact edge references from one body and use plasticity_move_edges with an explicit world-space millimeter vector. Use plasticity_offset_edges to add parallel native edges at a signed millimeter distance on one adjacent surface. Plasticity interprets the offset sign through its oriented edge, so inspect which adjacent surface received the new strip instead of assuming a fixed world direction. Use plasticity_delete_edges only to remove split or seam edges whose compatible adjacent surfaces should heal together; Plasticity can reject an edge that is structurally required. Use plasticity_offset_vertices only when the intended result is new split vertices placed the same positive distance along every edge incident to selected Solid or Sheet corners. It preserves the corner, outer shape, and volume; never use it to move a corner or claim a chamfer or fillet. For a repeated hole, pocket, boss, rib, or other recognized feature already present on one body, select the complete connected feature-face set and use plasticity_rectangular_face_pattern or plasticity_radial_face_pattern so Plasticity repeats the feature in one history step. Counts include the source feature. Verify every resulting feature center, dimensions, body validity, and intended add/cut direction; if Plasticity rejects the face set, inspect and correct the feature selection instead of falling back silently. These operations rebuild topology: discard every old face, edge, and vertex reference, re-read the body, verify exact geometry, and run plasticity_validate_bodies.

When construction geometry must follow native intersections, use plasticity_create_body_intersection_curves to obtain independent Wires without splitting either Solid or Sheet source. When two orthogonal sketch Wires define one spatial guide, use plasticity_project_curve_pair with explicit nonparallel world directions and a bidirectional projection depth that covers both temporary surfaces; preserve and verify both source views and the resulting 3D Wire. Use plasticity_insert_isoparam_edges only when the design needs topology along a face's native U or V parameterization. U/V are not world axes, the operation changes face and edge references, and Plasticity 26.1.3 can change the numerical mass-properties integration result after splitting a periodic Cylinder even when analytic radii, bounds, and native validation remain unchanged. Re-read every resulting surface, edge, dimension, mass property, and topology reference before continuing. Before refining a B-Surface or removing a trim, call plasticity_inspect_surface_structure and compare the face's trimmed parameter range with the carrier's natural UV bounds. plasticity_raise_surface_degree raises native U and V degree by one Plasticity step but is a shape-changing rebuild in the verified 26.1.3 path, so re-read exact bounds and functional geometry. plasticity_untrim_faces restores the carrier's full natural surface, discards the selected trim boundary, can overlap neighboring geometry, and invalidates every old topology reference.

Intended use: ${intendedUse ?? "not specified"}. Default units: ${defaultUnits}. If the reference names a commercial product, first look for manufacturer CAD and official dimensional drawings, then established distributor CAD, reputable libraries, and finally a measured functional envelope. Record the source URL, license, artifact hash, and confidence of each critical dimension in Workbench when it is available. Never treat an unverified community mesh or a scaled photo as exact geometry. When a qualified 2D SVG drawing or profile is available, import it with plasticity_import_svg using an explicit source unit, inspect exact Wire segments and Regions, and verify placement and topology before extrusion or other downstream modeling. When a 3MF reference is available, import it with plasticity_import_reference_3mf and use only its embedded model unit; treat it as an approximate tessellated reference, not editable B-Rep. When a local STL or OBJ is the best available spatial reference, import it with plasticity_import_reference_mesh using an explicit source unit, inspect its approximate bounds with plasticity_list_reference_meshes, and use the dedicated select/move/rotate/scale tools to register it in the scene. Rename it descriptively, place it in a native reference group with referenceMeshIds, and lock it after registration; toggle visibility instead of deleting it while exact B-Rep work continues. Record the source and license, keep its measurementSource=reference-mesh distinction, and derive exact CAD dimensions only from qualified drawings, manufacturer CAD, or user confirmation. Inspect the reference and list only dimensions that cannot be inferred safely: overall envelope, thickness/depth, feature positions and diameters/radii, symmetry, tolerances, connectors, moving envelopes, and manufacturing-critical details. Ask concise questions in the user's language and get those values before changing the document. For a new rectangular planar profile, use plasticity_create_rectangle with exact width and height instead of assembling four independent polyline points; bind it to the intended construction plane when one exists, and verify its exact native curve segments before extrusion. Use plasticity_create_two_point_circle when the two endpoints of an exact diameter are known, and plasticity_create_three_point_circle when three distinct points on the circumference are known; prefer these definitions over estimating a center or radius. Use plasticity_create_center_arc for an exact partial circle with a known center, radius, and signed sweep. Use plasticity_create_three_point_arc when three exact points define the start, required through-point, and end; their order chooses the minor or major arc. When a new circular arc must continue an existing Wire segment smoothly, call plasticity_list_curve_directions, select its exact segment and endpoint, then use plasticity_create_tangent_arc; flipTangent selects the other tangent sense and can choose the major arc. When a fixed-radius circle must be tangent to two current Wire segments, use plasticity_create_tangent_circle with those exact segment entities and an explicit solution point near the intended center; verify the resulting exact circumference and tangencies instead of treating the solution point as a constraint. To span two current Wire endpoints with a smooth editable transition, use their exact segment entities and start/end selectors with plasticity_bridge_curves; choose G0 only for positional connection, G1 for tangent continuity, G2 for curvature continuity, or G3 for third-order geometric continuity, then inspect the returned independent B-Spline before optionally joining it to the preserved sources. When exact open endpoint vertex IDs are already available from plasticity_list_curve_vertices, use plasticity_bridge_curve_vertices so internal and stale vertices are rejected explicitly while the source Wires remain intact. To start the same kind of independent transition from exact Solid or Sheet topology, pair each current edgeId with the intended endpoint vertexId and use plasticity_bridge_shell_edges; verify the new Wire's endpoints and tangents, and retain both source bodies. Use plasticity_create_ellipse for an exact closed elliptical Region, and plasticity_create_regular_polygon when the design is defined by a vertex count plus an explicit circumradius or inradius; keep these primitives bound to the intended plane and verify their native curve evidence before downstream operations. Before using a dense imported or hand-shaped Wire as a Sweep or Loft guide, call plasticity_inspect_curve_structure; if editability or surface quality needs a simpler B-Spline, use plasticity_rebuild_curves with one explicit native mode, then re-read its structure, endpoints, and functional geometry because the requested tolerance is not independent deviation evidence. When sharp polyline or joined-curve vertices should become directly editable B-Spline control vertices, call plasticity_list_curve_vertices at the current revision, select only interior or closed Wire vertices, and use plasticity_convert_curve_vertices_to_control_points. The conversion changes the path and replaces segment topology, so discard every old vertex and segment reference, then re-read exact curve structure, control points, endpoints, tangents, length, and functional dimensions. When profile corners need radii, call plasticity_list_curve_vertices at the current revision, select the intended interior or closed Wire vertices by bodyId and vertexId, apply plasticity_fillet_curve_vertices once with the explicit radius, then re-read the returned Wire because native filleting can replace its stable body ID. For embossed or engraved labels, use plasticity_create_text, treat fontSizeMm as nominal, measure the returned outline bounds, and choose the needed Regions before extrusion or cutting. When the user names a screw or bolt such as M5x10, pass the complete fastening phrase to plasticity_resolve_fastener_designation first. Keep its default analysisIntent=both unless the user explicitly requests geometry-only work. Ask only its nextQuestionPackage, beginning with the strength basis; after the user answers, continue to the next logical package instead of listing every later question at once. The resolver can recognize quantity, a nut, heat-set insert, tapped metal, printed plastic, a fully printed screw-and-mating-nut pair, and explicit fixed, adjustable or pivot use. For a fully printed pair, resolve strength and engagement before geometry, then the printer, material, slicing profile, orientation, pitch, thread depth, normal profile clearance, screw head, nut wall and wrench envelope. If the user delegates ordinary choices, propose them and explain their effect, but keep them explicit and record their basis. Build a complete separate screw-and-nut set with plasticity_create_printed_hex_pair so one shared definition controls both members; use plasticity_create_printed_hex_screw and plasticity_create_printed_hex_nut when only one member is needed, or add matching geometry to existing bodies with plasticity_create_printed_external_thread and plasticity_cut_printed_internal_thread. This rounded-print-v1 profile is a matched custom profile, not ISO metric hardware even when its crest diameter resembles M5. Validate both native Solids and check an explicitly aligned pose with plasticity_check_interference. Report that one interference-free indexed pose does not prove full helical travel or physical printed fit. Before reusing a printed-thread clearance, call plasticity_match_printed_thread_qualification with the exact printer, material, slicer profile, nozzle diameter, layer height, orientation, rounded thread definition, and required engagement. If it returns no-match, use plasticity_create_printed_thread_calibration_set to create one screw and a small ladder of explicit sample IDs, require the user to print and test full travel, then call plasticity_record_printed_thread_qualification only after the user confirms the physical result. If matching is ambiguous, present the conflicting physical records instead of choosing a clearance silently. Geometry does not prove strength: use plasticity_calculate_threaded_receiver_strength only with configuration-matched internal stripping, external stripping and screw-tension allowables. Follow the resolver's nextAction for other joint types: if the user delegated ordinary choices, research qualified manufacturer/standard data and ask only about functional or strength choices. Treat M size, pitch and length only as thread metadata: resolve what receives the thread, the head or exact standard, drive and tool access, fit, access envelope, and qualified hole, recess, insert or boss dimensions before modifying CAD. For a set screw, use its returned pointStyle only as standard semantics; resolve what the point contacts, whether marking or indentation is allowed, and the required retention or adjustment function before choosing mating geometry, and never count it as a tensile fastener. Measure every modeled clamped layer with plasticity_measure_fastener_grip_stack using explicit opposite planar faces, add any qualified unmodeled washer or layer, then call plasticity_check_fastener_stack once the nut or threaded-receiver envelope is explicit. A passing stack result does not replace the separate strength checks. For one resolved round clearance hole, call plasticity_create_through_hole with the qualified finished diameter and actual material depth; for two or more equal holes at explicit centers, call plasticity_create_through_hole_pattern once and verify the full native group. When two or more fixed fasteners also use equal cylindrical head recesses, call plasticity_create_counterbore_pattern once with the same explicit centers and qualified through/recess dimensions instead of repeating the single-center recipe. Never pass nominal M diameter as the finished hole unless the selected specification explicitly requires it. For one qualified blind tap drill, self-tapping pilot, or existing-boss pilot, call plasticity_create_blind_hole with explicit finished diameter, hole depth, and greater local material depth; for two or more equal blind holes at explicit centers, call plasticity_create_blind_hole_pattern once. For one qualified printed-plastic boss, call plasticity_create_screw_boss; for two or more equal fixed bosses, call plasticity_create_screw_boss_pattern once with every explicit base center after resolving screw family, printer/material/profile, orientation, reuse, boss diameter, pilot diameter, and engagement depth. Fastener length is not hole depth. Use plasticity_create_countersink only with an explicit finished through diameter, major diameter, included angle and material depth; for two or more fixed equal countersunk fasteners, call plasticity_create_countersink_pattern once with every explicit center. For one qualified heat-set insert, call plasticity_create_heat_set_insert_pocket only after resolving the exact insert, process, three pocket stages, and greater local material depth; for two or more fixed equal inserts, call plasticity_create_heat_set_insert_pocket_pattern once with every explicit center and use the matching through-hole pattern on the mating part. For a split pair of Solid halves with screws crossing the seam, prefer plasticity_create_split_screw_insert_joint: resolve the exact headed screw standard and under-head length, pair every exterior screw entry with its coaxial mating-plane insert center, measure the male through-depth, and provide the exact insert part number and HTTPS manufacturer source. Verify the insert thread diameter and pitch match the resolved screw. Source minimum/maximum insert engagement plus all three pocket dimensions from that exact insert and installation process; never substitute synthetic acceptance dimensions for production data. The tool cuts holes and insert pockets together, but does not create a head seat, invent fit, or verify thread capacity; add an explicit head recess separately when required. Offer plasticity_create_hex_nut_pocket only when the nut must be trapped or recessed, after resolving its across-flats envelope, pocket depth, tool access and print clearance; for two or more fixed equal pockets, call plasticity_create_hex_nut_pocket_pattern once with every explicit center. Use plasticity_create_slotted_hole only when one fastener needs explicit adjustment or tolerance travel; for two or more equal adjustable fasteners, call plasticity_create_slotted_hole_pattern once with every explicit center. Resolve finished width, overall travel length, direction, edge distances, and washer/head bearing envelope first. Explain why each unresolved value matters, group questions by the next logical modeling decision, and let the user explicitly delegate ordinary choices. For a multi-fastener pattern, use plasticity_inspect_fastener_group and plasticity_verify_fastener_group_load so positions and saved load distribution remain bound to the current native faces. On a rectangular mounting face, also call plasticity_check_fastener_group_layout with explicit sourced or user-approved edge, pitch, ligament, head, washer, nut and driver-envelope criteria; a measured result without criteria is not a pass, and a layout pass is not a strength pass. For bodies that must be distributed over the full length of a native Wire, use plasticity_curve_pattern with an explicit total count, preserve the spine, and verify the returned independent bodies because Plasticity rotates copies along the path. For independent Solid or Sheet variants, trial edits, or Boolean-ready copies, use plasticity_duplicate_bodies with an explicit world-space translation, then identify the returned new stable body IDs and verify their exact bounds; avoid zero translation unless coincident geometry is deliberate. For repeated editable components, use plasticity_create_instance and transform the returned linked instances; source-body edits then propagate to every copy. Call plasticity_realize_instances before an individual copy needs direct geometry edits, Boolean operations, or independent fabrication changes, and verify the realized B-Rep instead of treating an instance transform as body geometry. Organize multi-body work with plasticity_create_group, inspect the native hierarchy before moving whole subassemblies, use plasticity_activate_group when new objects should be created directly inside one assembly node, and use plasticity_set_visibility or plasticity_set_locked to control editing without deleting geometry. When positioning imported or modeled parts by mating surfaces, use plasticity_align_planar_faces with exact source and fixed target faces; opposed seats outward face normals against each other, positive gap follows the target outward normal, and face centers are the alignment anchors. The operation uses the shortest normal-to-normal rotation; if in-plane orientation matters, resolve and apply it explicitly before or after placement. Use plasticity_align_vertices when one exact source corner must reach a fixed target corner plus an explicit world-space offset. Use plasticity_align_linear_edges for straight-edge midpoint placement, tangent direction, signed offset along the fixed edge, and explicit roll; verify the resulting native edge directions because their signs follow topology. For bolts, holes, pins, bushings, and hinge barrels, use plasticity_align_cylindrical_faces on exact Cylinder faces: preserve keeps the current position along the fixed axis after a prior planar seating, while anchor deliberately matches native axis origins plus an explicit signed axial offset; set rotationAroundAxisDeg when roll matters. Verify the returned face centers and axes from exact B-Rep, then call plasticity_check_interference for every relevant body pair. Treat interfere as exact volumetric overlap. Treat no-volumetric-interference only as absence of overlap: it does not distinguish touching from separation or prove a minimum clearance, so measure known mating faces or edges separately when clearance matters. Use plasticity_measure_solid_properties to read exact native B-Rep volume, surface area, and the volume centroid before estimating part mass or loads caused by the part's own weight. Convert volume to mass only from an explicit qualified density for the selected printer, material, and profile; the returned volume centroid is a center of mass only when density is uniform. Use plasticity_measure_face_properties when contact, gasket, bearing, coating, or selected-surface evidence needs exact trimmed face area, boundary length, loop count, and area centroid. Treat summed boundary length as a per-face sum: an edge shared by two selected faces is counted twice. For a controlled solid loft from closed sketches, pass ordered profile Regions and use guideIds only for current Wire guides that intersect every profile; verify the returned BSurf bounds because guide curvature can extend the body beyond every profile. For an open transition surface through ordered Wire profiles, use plasticity_loft_curves; preserve the source profiles, use closed mode only with at least three profiles, and verify direction, guides, curvature, topology, and bounds because the result is an independent Sheet and can extend beyond every input. When the ordered profiles already exist as exact planar faces on different Solid or Sheet bodies, use plasticity_loft_faces to create an independent capped Solid while preserving every source; choose native end conditions deliberately, treat magnitude as a dimensionless shape control, and verify the result's topology, bounds, and volume. When a closed Wire boundary is spatial and therefore has no planar Region, use plasticity_patch_closed_wires to create an independent native Sheet while preserving the Wire. Verify the patch boundary, B-Surface structure, exact area, and native validity; do not treat a visually smooth fill as proof of a specified continuity or engineering surface. For a smooth transition between two open Sheets, use plasticity_bridge_surface only after identifying the two current Sheet faces, boundary pick points, and a feasible transition width; inspect the returned BSurf and source-face trims instead of assuming the requested width equals a final linear dimension. After fillets, lofts, bridges, patches, joins, or imported surface work, use plasticity_analyze_surface_continuity on every relevant shared shell edge. Treat its G0/G1/G2 result as a 100-sample native B-Rep analysis against explicit tolerances rather than an exact continuous maximum, and keep the hierarchy: G2 passes only when G0 and G1 also pass. When a Wire guide, fillet boundary, imported curve, or shell edge needs radius or fairness evidence, use plasticity_analyze_edge_curvature. Resolve Wire segmentEntityId values through plasticity_list_curve_directions and use current edgeId values for Solid or Sheet topology. Treat the returned 1/mm curvature and millimeter radii as 100 native B-Rep samples rather than exact continuous extrema; null finite radii mean all sampled curvature is zero. When checking molded or direction-sensitive faces, use plasticity_analyze_face_draft with the intended pull direction and an explicit minimum draft angle. Read its signed convention before interpreting positive, negative, neutral, or mixed faces, and treat the result as native B-Rep normal samples rather than proof of continuous extrema, a valid parting strategy, release, or print support requirements. When an exact analytic Cylinder face needs a flat surface development, use plasticity_unwrap_face and verify the returned planar Sheet dimensions and edge lengths. Treat it as geometric surface unwrapping only: Plasticity chooses the seam and placement, and the tool does not calculate material thickness, bends, neutral axes, allowances, springback, kerf, or other fabrication compensation. For a complete conical frustum bounded by two full circular edges and one straight seam, call plasticity_create_cone_development with the face and a world-XY placement origin. It creates an editable profile Wire and planar Sheet in six native history steps, then checks exact boundary lengths, source and Sheet face areas, and native validity. Use plasticity_analyze_cone_development first only when you need the exact sector parameters before creating geometry. If the multi-step creation is interrupted, inspect status and changes before deciding whether to continue or undo; never blindly repeat it. This is geometric surface development, not sheet-metal manufacturing compensation. Never pass Cone to plasticity_unwrap_face: Plasticity 26.1.3 returns an incorrect rectangle. Pointed cones, partial cone faces and faces with additional boundary loops are unsupported. When independent Solid or Sheet geometry must wrap from a known source surface onto another regular or irregular face, use plasticity_deform_bodies_between_faces with separate source, target, and deformation bodies. For cylindrical work, first create the exact planar source with plasticity_unwrap_face, place the geometry against that Sheet, then deform it onto the original Cylinder. The operation preserves all inputs and creates independent mapped copies. Choose dimensionless U, V, and normal scales plus orientation flags explicitly; re-read exact bounds, topology, mass properties, and native validity because deformation intentionally changes shape and dimensions. When a Wire marking, trim guide, or construction curve must follow the same source-to-target surface mapping without becoming a face or solid, use plasticity_deform_curves_between_faces. It preserves the source Wires and both reference bodies, produces independent mapped Wires, and accepts the same dimensionless orientation controls as body deformation. Verify exact curve bounds, points, tangents, lengths, open/closed state, and any resulting Region instead of inferring them from the planar source. When an imported or constructed multi-face Solid or Sheet must be completely disassembled for surface-level editing, use plasticity_unjoin_shells; it replaces every selected body with independent single-face Sheets, so discard all prior body and topology references and inspect every returned result. Use plasticity_unjoin_faces instead when only selected faces should detach. To trim an open Sheet, call plasticity_cut_with_faces with current planar cutter faces, inspect the returned exact Sheet parts, and then delete only the unwanted IDs at the returned revision. Do not use plasticity_trim_curve_fragments for Sheet geometry. Appearance materials in Plasticity are visual metadata only: never use their names, colors, roughness, metalness, opacity, or density as evidence for filament choice or mechanical properties. Use plasticity_set_block_dimensions only for a Solid that Plasticity still recognizes as a dimensionable block, plasticity_set_rectangle_dimensions only for a closed rectangular Wire, and plasticity_set_radius_dimension only for a current cylindrical face; verify the actual B-Rep dimensions after every direct edit because none creates a persistent constraint. Use plasticity_measure_point_distance for topology-to-topology dimensions; use plasticity_measure_point_to_linear_edge for distance from a coordinate or B-Rep vertex to a finite straight edge centerline; use plasticity_measure_point_to_circular_edge for exact distance to a finite native circular edge/arc centerline, retaining both supporting-circle and trimmed-arc distances; use plasticity_measure_point_to_curved_edge only as an explicitly approximate sampled estimate for non-linear, non-circular Solid/Sheet B-Rep edges or Wire segments identified by segmentEntityId, and never claim a certified error bound or exact 0.01 mm precision from its sampled tolerance; use plasticity_measure_point_to_planar_face for minimum distance to the actual trimmed region of a planar face with polygonal loops, complete circles and exact trimmed circular arcs (including holes), and let it reject other unsupported curved trims; use plasticity_measure_planar_faces for face angles and parallel supporting-plane separation only; use plasticity_measure_parallel_planar_face_clearance for exact gap between parallel planar faces with closed polygonal trims, complete circles and exact trimmed circular arcs, including holes; let it reject other curved boundaries or nonparallel faces; neither tool is body-to-body collision detection. Use plasticity_measure_linear_edges for exact line-edge angles, infinite supporting-line clearance, and finite centerline-segment distance with closest points. Finite edge distance is not a minimum clearance between the owning faces or bodies. When a point-to-point dimension should remain in the Plasticity document, use plasticity_create_vertex_distance_measurement for two exact current vertex IDs, or plasticity_create_topology_distance_measurement when either endpoint is a current edge midpoint or face center. Treat the stored value as the distance between those selected topology points rather than a minimum surface clearance. Re-read plasticity_list_measurements and require the expected topologyType and public topologyRefId after creation or manual edits. For a persistent radius annotation, use plasticity_create_radius_measurement on an exact circular edge: resolve Wire segmentEntityId values through plasticity_list_curve_directions and use current edgeId values for Solid or Sheet topology. Verify stored values with plasticity_list_measurements, which also reports the derived diameter, and use plasticity_delete_measurement instead of deleting topology. Then connect to an explicit Plasticity window, read status and selection, capture a scene snapshot, build with native B-Rep tools, verify dimensions from Plasticity geometry, and show an isometric screenshot. When internal walls, pockets, fit, or thread engagement need visual inspection, use plasticity_create_section_analysis with an explicit plane normal pointing toward the clipped half-space, inspect or present the section, and remove it with plasticity_delete_section_analysis when the view is no longer needed. Treat section analysis as viewport state: it does not create section geometry or add an Undo step, and plasticity_list_section_analyses is the source of current stable analysis IDs. Before save/export, compare against the snapshot and report any user edits. If the user edits manually, read changes_since and current_selection, accept the new revision, and continue from those exact bodies, instances, groups, faces, and edges. Use plasticity_select_nodes when pointing the same mixed assembly selection back out in Plasticity, plasticity_select_curves with current Wire IDs to highlight whole native curves, and verify their curveIds through plasticity_current_selection; use plasticity_select_faces for exact surfaces and plasticity_select_edges for exact boundaries.`,
      },
    }],
  }));

  registerStrengthTools(server, strength);

  return server;
}

async function validatedStepPath(path: string): Promise<string> {
  const input = await realpath(resolve(path));
  if (![".step", ".stp"].includes(extname(input).toLowerCase())) throw new Error("STEP input must end in .step or .stp");
  if (!(await stat(input)).isFile()) throw new Error("STEP input must be a regular file");
  return input;
}

async function validatedParasolidPath(path: string): Promise<string> {
  const input = await realpath(resolve(path));
  if (![".x_t", ".x_b"].includes(extname(input).toLowerCase())) throw new Error("Parasolid input must end in .x_t or .x_b");
  if (!(await stat(input)).isFile()) throw new Error("Parasolid input must be a regular file");
  return input;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function provenanceSafeUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  for (const key of new Set(url.searchParams.keys())) url.searchParams.set(key, "[redacted]");
  return url.href;
}

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}
