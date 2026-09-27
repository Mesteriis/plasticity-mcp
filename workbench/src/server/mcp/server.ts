import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { constructionJournalInputSchema, dfmInputSchema, manufacturingAssessmentRequestSchema, manufacturingProfileRegistrationSchema, manufacturingProfileSchema, modelVersionInputSchema, referenceInputSchema, sliceJobRequestSchema, slicePartsBatchRequestSchema, structuredBlockInputSchema } from "../../shared/schemas.ts";
import type { ManufacturingProfile, ManufacturingProfileRecord, SliceJob, SlicePartsBatchResult } from "../../shared/contracts.ts";
import type { WorkbenchApiClient } from "./client.ts";
import { WORKBENCH_MCP_INSTRUCTIONS } from "./instructions.ts";

const projectIdSchema = z.string().uuid();
const revisionSchema = z.number().int().nonnegative();
const sequenceSchema = z.number().int().nonnegative();
const manufacturingProfileQuerySchema = z.object({
  projectId: projectIdSchema,
  slicer: z.enum(["creality-print", "orca-slicer", "bambu-studio"]).optional(),
  printerVendor: z.string().trim().min(1).max(80).optional(),
  printerModel: z.string().trim().min(1).max(120).optional(),
  material: z.string().trim().min(1).max(80).optional(),
  nozzleDiameterMm: z.number().finite().min(0.1).max(2.4).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).max(10_000).default(0),
}).strict();

export function createWorkbenchMcpServer(api: WorkbenchApiClient): McpServer {
  const server = new McpServer({ name: "plasticity-workbench", version: "0.1.0" }, { instructions: WORKBENCH_MCP_INSTRUCTIONS });

  server.registerTool("workbench_list_projects", {
    description: "List local Workbench projects and their workspace paths and current revisions.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => result(await api.projects()));

  server.registerTool("workbench_create_project", {
    description: "Create a local Workbench project and its isolated workspace for CAD exports and reviewed reference files.",
    inputSchema: z.object({ name: z.string().trim().min(1).max(120) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ name }) => result(await api.createProject(name)));

  server.registerTool("workbench_project_status", {
    description: "Read a Workbench project, its revision, and persisted review events.",
    inputSchema: z.object({ projectId: projectIdSchema }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ projectId }) => result(await api.projectStatus(projectId)));

  server.registerTool("workbench_publish_model_version", {
    description: "Publish an immutable STEP-backed Plasticity model version with native measurements.",
    inputSchema: z.object({
      projectId: projectIdSchema,
      expectedRevision: revisionSchema,
      version: modelVersionInputSchema,
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ projectId, expectedRevision, version }) =>
    result(await api.publishModelVersion(projectId, expectedRevision, version)));

  server.registerTool("workbench_upload_project_artifact", {
    description: "Upload a STEP, Parasolid, IGES, STL, OBJ, 3MF, Plasticity, PDF, image, JSON, or G-code file from a relative path inside this project's workspace. Paths outside the workspace and symlink escapes are rejected.",
    inputSchema: z.object({
      projectId: projectIdSchema,
      relativePath: z.string().trim().min(1).max(1000),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ projectId, relativePath }) => result(await api.uploadProjectArtifact(projectId, relativePath)));

  server.registerTool("workbench_publish_structured_block", {
    description: "Publish a revision-checked dimensions, requirements, assumptions, sources, validation, or comparison block.",
    inputSchema: z.object({
      projectId: projectIdSchema,
      expectedRevision: revisionSchema,
      block: structuredBlockInputSchema,
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ projectId, expectedRevision, block }) =>
    result(await api.publishStructuredBlock(projectId, expectedRevision, block)));

  server.registerTool("workbench_publish_status", {
    description: "Publish a short project status for the browser review workspace.",
    inputSchema: z.object({
      projectId: projectIdSchema,
      expectedRevision: revisionSchema,
      status: z.string().trim().min(1).max(4_000),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ projectId, expectedRevision, status }) =>
    result(await api.publishStatus(projectId, expectedRevision, status)));

  server.registerTool("workbench_register_reference", {
    description: "Register provenance for a source already inspected by Codex. Attach downloaded files to the project first; the Workbench never fetches arbitrary URLs.",
    inputSchema: z.object({
      projectId: projectIdSchema,
      expectedRevision: revisionSchema,
      reference: referenceInputSchema,
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ projectId, expectedRevision, reference }) =>
    result(await api.registerReference(projectId, expectedRevision, reference)));

  server.registerTool("workbench_references", {
    description: "List persisted reference sources, immutable artifact hashes, licenses, confidence, critical dimensions, and unresolved measurements.",
    inputSchema: z.object({ projectId: projectIdSchema }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ projectId }) => result(await api.references(projectId)));

  server.registerTool("workbench_publish_construction_journal", {
    description: "Persist an exact Plasticity MCP construction journal checkpoint, including failed or uncertain operations and manual-edit detection.",
    inputSchema: z.object({
      projectId: projectIdSchema,
      expectedRevision: revisionSchema,
      journal: constructionJournalInputSchema,
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ projectId, expectedRevision, journal }) =>
    result(await api.publishConstructionJournal(projectId, expectedRevision, journal)));

  server.registerTool("workbench_construction_journals", {
    description: "List persisted Plasticity construction journal checkpoints for a project.",
    inputSchema: z.object({ projectId: projectIdSchema }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ projectId }) => result(await api.constructionJournals(projectId)));

  server.registerTool("workbench_get_feedback", {
    description: "Read submitted annotations and validated dimension changes after an event sequence.",
    inputSchema: z.object({
      projectId: projectIdSchema,
      afterSequence: sequenceSchema.default(0),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ projectId, afterSequence }) => result(await api.feedback(projectId, afterSequence)));

  server.registerTool("workbench_manufacturing_profiles", {
    description: "Search installed printer, material, and slicer profiles. Filter by slicer, printer vendor/model, material, or nozzle diameter. Returns catalog matches plus paged registered-profile records containing the immutable profile hash, verification status, layer height, resolved nominal sparse-infill settings, and configuration hashes; machine-local config paths and printer connection addresses are omitted. Sparse infill and shell settings are profile defaults and may not describe object-specific modifiers. Use a registered profile hash when binding physical strength tests to a print process. Returns 20 matches by default; use offset/limit to page. Includes adapter availability.",
    inputSchema: manufacturingProfileQuerySchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ projectId, ...query }) => result(filterManufacturingProfileCatalog(await api.manufacturingProfiles(projectId), query)));

  server.registerTool("workbench_register_manufacturing_profile", {
    description: "Copy a printer, material, and slicer preset set into the immutable local registry. For an installed catalog entry, select it by the printerId/materialId/slicerId returned by workbench_manufacturing_profiles; Workbench resolves local config files internally, so the agent never needs machine-local paths. Alternatively provide a full profile for an imported preset. Draft and imported profiles remain visibly distinct from verified profiles.",
    inputSchema: z.object({ projectId: projectIdSchema, registration: manufacturingProfileRegistrationSchema }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ projectId, registration }) => result(summarizeManufacturingProfileRecord(await api.registerManufacturingProfile(projectId, registration))));

  server.registerTool("workbench_assess_printability", {
    description: "Check build-volume fit, choose a basic orientation, and report wall, hole, and overhang warnings. Select a registered profile by immutable profileHash from workbench_manufacturing_profiles; Workbench resolves it locally so no config paths are required. For an oversized oriented part, the caller may provide sourced protected coordinate bands and a full explicit cut-offset set; the result flags cuts through those bands and verifies every resulting segment fits. Protected-zone references are caller-supplied and are not independently validated as strength evidence.",
    inputSchema: z.object({ projectId: projectIdSchema, ...manufacturingAssessmentRequestSchema.shape }).strict().refine((request) => (request.profile === undefined) !== (request.profileHash === undefined), {
      path: ["profileHash"], message: "Supply exactly one immutable profileHash or inline registered profile",
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ projectId, dfm, profile, profileHash }) => result(await api.assessPrintability(projectId, { dfm, ...(profile ? { profile } : {}), ...(profileHash ? { profileHash } : {}) })));

  server.registerTool("workbench_slice_model", {
    description: "Slice an attached artifact accepted by the selected registered profile. Obtain profileHash from workbench_manufacturing_profiles and pass it in request; Workbench resolves its immutable local config copy, so no local paths are required. Creality Print 7.2 accepts STL, OBJ, or AMF; export STL from Plasticity for this adapter. A complete G-code parse reports depositionLayerZCount; call workbench_slicer_interface_heights for the selected layer interfaces. Returned Z values use the slicer's build frame; map only relative heights onto a separately confirmed CAD print axis and anchor. Does not contact a printer.",
    inputSchema: z.object({ projectId: projectIdSchema, request: sliceJobRequestSchema }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ projectId, request }) => result(summarizeSliceJob(await api.createSliceJob(projectId, request))));

  server.registerTool("workbench_slice_parts", {
    description: "Slice 2–32 attached model artifacts as one batch of independent jobs using the same registered printer/material/slicer profile. Every part is prevalidated before slicing starts; a slicer failure is reported per part and does not stop later parts. This only creates G-code jobs: it does not approve or contact a printer. Each resulting job still needs its own explicit review and confirmation.",
    inputSchema: z.object({ projectId: projectIdSchema, request: slicePartsBatchRequestSchema }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ projectId, request }) => result(summarizeSliceParts(await api.sliceParts(projectId, request))));

  server.registerTool("workbench_slicer_interface_heights", {
    description: "Read selected exact interface heights and deposited XY path direction summaries from one completed G-code slice without returning full per-layer schedules. Indices are 1-based interfaces after each deposition layer and must be between 1 and layerCount - 1. Returns Z values in the slicer's build frame, relativeOffsetMm from the first deposition layer ready for plasticity_plan_cohesive_layer_planes, a length-weighted dominant XY road axis and directional concentration when available, curved-move coverage limitations, and exact job/profile/G-code hashes. These are toolpath descriptors, not measured material properties or a validated layer strength model. Map relative offsets only onto a separately confirmed CAD print axis and anchor.",
    inputSchema: z.object({
      projectId: projectIdSchema,
      jobId: projectIdSchema,
      interfaceLayerIndices: z.array(z.number().int().positive()).min(1).max(32),
    }).strict().superRefine((input, context) => {
      if (input.interfaceLayerIndices.some((index, position) => position > 0 && input.interfaceLayerIndices[position - 1]! >= index)) {
        context.addIssue({ code: "custom", path: ["interfaceLayerIndices"], message: "Interface layer indices must be strictly increasing and unique" });
      }
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ projectId, jobId, interfaceLayerIndices }) => result(await api.interfaceLayerHeights(projectId, jobId, interfaceLayerIndices)));

  server.registerTool("workbench_slicer_layer_path_orientations", {
    description: "Read selected exact deposition Z values and XY road-direction summaries for actual layers in one completed G-code slice. Request 1–32 strictly increasing, 1-based layer indices; use batches of 32 to read a larger stack. The complete per-layer schedule must be available. Returns dominant road axis, directional concentration, curved-move coverage, and job/profile/source/G-code hashes in the slicer build frame. These are toolpath descriptors, not material properties or a validated layer-strength model. Map directions to CAD only after the user confirms the slicer-to-CAD frame mapping.",
    inputSchema: z.object({
      projectId: projectIdSchema,
      jobId: projectIdSchema,
      layerIndices: z.array(z.number().int().positive()).min(1).max(32),
    }).strict().superRefine((input, context) => {
      if (input.layerIndices.some((index, position) => position > 0 && input.layerIndices[position - 1]! >= index)) {
        context.addIssue({ code: "custom", path: ["layerIndices"], message: "Layer indices must be strictly increasing and unique" });
      }
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ projectId, jobId, layerIndices }) => result(await api.layerPathOrientations(projectId, jobId, layerIndices)));

  server.registerTool("workbench_print_jobs", {
    description: "List persistent slice and print jobs, including browser approval and uncertain submission states.",
    inputSchema: z.object({ projectId: projectIdSchema }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ projectId }) => result((await api.manufacturingJobs(projectId)).map(summarizeSliceJob)));

  server.registerTool("workbench_printer_status", {
    description: "Read the selected printer identity and readiness without uploading or starting a print.",
    inputSchema: z.object({ projectId: projectIdSchema, profile: manufacturingProfileSchema }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async ({ projectId, profile }) => result(await api.printerStatus(projectId, profile)));

  server.registerTool("workbench_submit_approved_print", {
    description: "Upload and start a print only when the exact G-code, profile, printer, and project revision were explicitly approved in Workbench. A timeout produces an unknown state and is never retried automatically.",
    inputSchema: z.object({ projectId: projectIdSchema, jobId: projectIdSchema }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async ({ projectId, jobId }) => result(summarizeSliceJob(await api.submitApprovedPrint(projectId, jobId))));

  server.registerTool("workbench_reconcile_print_submission", {
    description: "Inspect printer state and storage after an uncertain submission without uploading, starting, deleting, or retrying anything. Restores the approved state only when the exact G-code is confirmed absent; an existing but inactive file remains unknown.",
    inputSchema: z.object({ projectId: projectIdSchema, jobId: projectIdSchema }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ projectId, jobId }) => result(await api.reconcilePrintSubmission(projectId, jobId)));

  server.registerTool("workbench_wait_for_feedback", {
    description: "Wait up to 30 seconds for submitted Workbench annotations or validated dimension changes.",
    inputSchema: z.object({
      projectId: projectIdSchema,
      afterSequence: sequenceSchema.default(0),
      timeoutSeconds: z.number().finite().min(0).max(30).default(5),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ projectId, afterSequence, timeoutSeconds }) =>
    result(await api.waitForFeedback(projectId, afterSequence, timeoutSeconds)));

  server.registerPrompt("plasticity_workbench_review", {
    description: "Guide Codex through publishing and reviewing a Plasticity model in Workbench.",
    argsSchema: { projectId: projectIdSchema },
  }, ({ projectId }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Review Plasticity work for project ${projectId}. Read project status and use its current revision for every publication. Export a new STEP file through Plasticity MCP, upload it to this Workbench project, then publish a model version with Plasticity document identity, revision, and native B-Rep measurements. Publish concise dimensions and validation blocks plus the current Plasticity construction journal checkpoint. Wait for a submitted feedback batch before changing geometry. Treat annotations on an older model version as requiring explicit remapping. Never repeat an uncertain CAD or Codex operation automatically.`,
      },
    }],
  }));

  return server;
}

export interface ManufacturingProfileQuery {
  slicer?: "creality-print" | "orca-slicer" | "bambu-studio" | undefined;
  printerVendor?: string | undefined;
  printerModel?: string | undefined;
  material?: string | undefined;
  nozzleDiameterMm?: number | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export function filterManufacturingProfileCatalog(catalog: {
  profiles: ManufacturingProfile[];
  records?: ManufacturingProfileRecord[];
  adapters: Array<{ id: string; available: boolean; executable?: string }>;
}, query: ManufacturingProfileQuery = {}) {
  const matches = catalog.profiles.filter((profile) => profileMatchesQuery(profile, query));
  const registered = (catalog.records ?? []).filter((record) => profileMatchesQuery(record.profile, query));
  const limit = query.limit ?? 20;
  const offset = query.offset ?? 0;
  return {
    adapters: catalog.adapters.map(({ id, available }) => ({ id, available })),
    profiles: matches.slice(offset, offset + limit).map(summarizeManufacturingProfile),
    totalCount: matches.length,
    offset,
    limit,
    hasMore: offset + limit < matches.length,
    registeredProfiles: registered.slice(offset, offset + limit).map(summarizeManufacturingProfileRecord),
    registeredProfileCount: registered.length,
    registeredProfilesHasMore: offset + limit < registered.length,
  };
}

function summarizeManufacturingProfile(profile: ManufacturingProfile) {
  const { printer, material, slicer } = profile;
  return {
    printer: {
      id: printer.id, vendor: printer.vendor, model: printer.model,
      buildVolumeMm: printer.buildVolumeMm, nozzleDiameterMm: printer.nozzleDiameterMm, source: printer.source,
    },
    material: {
      id: material.id, name: material.name, type: material.type, vendor: material.vendor,
      nozzleTemperatureC: material.nozzleTemperatureC, bedTemperatureC: material.bedTemperatureC,
      ...(material.densityGcm3 === undefined ? {} : { densityGcm3: material.densityGcm3 }),
      ...(material.maxVolumetricSpeedMm3s === undefined ? {} : { maxVolumetricSpeedMm3s: material.maxVolumetricSpeedMm3s }),
      source: material.source,
    },
    slicer: {
      id: slicer.id, slicer: slicer.slicer, name: slicer.name, layerHeightMm: slicer.layerHeightMm,
      ...(slicer.nominalInfillPercent === undefined ? {} : { nominalInfillPercent: slicer.nominalInfillPercent }),
      ...(slicer.sparseInfillPattern === undefined ? {} : { sparseInfillPattern: slicer.sparseInfillPattern }),
      ...(slicer.wallLoops === undefined ? {} : { wallLoops: slicer.wallLoops }),
      ...(slicer.topShellLayers === undefined ? {} : { topShellLayers: slicer.topShellLayers }),
      ...(slicer.bottomShellLayers === undefined ? {} : { bottomShellLayers: slicer.bottomShellLayers }),
      ...(slicer.qualityTarget === undefined ? {} : { qualityTarget: slicer.qualityTarget }),
      ...(slicer.supportsEnabled === undefined ? {} : { supportsEnabled: slicer.supportsEnabled }),
      source: slicer.source,
    },
  };
}

function summarizeSliceJob(job: SliceJob) {
  const { depositionLayerZMm, depositionLayerPathOrientations, ...summary } = job.summary ?? {};
  return {
    ...job,
    ...(job.summary ? {
      summary: {
        ...summary,
        ...(depositionLayerZMm ? { depositionLayerZCount: depositionLayerZMm.length } : {}),
        ...(depositionLayerPathOrientations ? { depositionLayerPathOrientationCount: depositionLayerPathOrientations.length } : {}),
      },
    } : {}),
    profile: summarizeManufacturingProfile(job.profile),
  };
}

function summarizeSliceParts(result: SlicePartsBatchResult) {
  return {
    ...result,
    items: result.items.map((item) => ({
      ...item,
      ...(item.job ? { job: summarizeSliceJob(item.job) } : {}),
    })),
  };
}

function profileMatchesQuery(profile: ManufacturingProfile, query: ManufacturingProfileQuery): boolean {
  return (!query.slicer || profile.slicer.slicer === query.slicer)
    && (!query.printerVendor || includesFolded(profile.printer.vendor, query.printerVendor))
    && (!query.printerModel || includesFolded(profile.printer.model, query.printerModel))
    && (!query.material || [profile.material.name, profile.material.type, profile.material.vendor].some((value) => includesFolded(value, query.material!)))
    && (query.nozzleDiameterMm === undefined || Math.abs(profile.printer.nozzleDiameterMm - query.nozzleDiameterMm) <= 0.001);
}

function summarizeManufacturingProfileRecord(record: ManufacturingProfileRecord) {
  return {
    id: record.id,
    profileHash: record.profileHash,
    verification: record.verification,
    ...(record.sourceUrl ? { sourceUrl: record.sourceUrl } : {}),
    createdAt: record.createdAt,
    configHashes: record.configHashes,
    profile: summarizeManufacturingProfile(record.profile),
  };
}

function includesFolded(value: string, query: string): boolean {
  return value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}
