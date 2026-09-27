import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { DfmInput, ManufacturingProfile, ManufacturingProfileRecord, ManufacturingProfileRegistrationRequest, PrintSubmissionReconciliation, PrinterStatus, SliceInterfaceLayerHeights, SliceJob, SliceJobRequest, SliceLayerPathOrientations, SlicePartsBatchRequest, SlicePartsBatchResult } from "../../shared/contracts.ts";
import { manufacturingProfileSchema, sliceInterfaceLayerHeightsRequestSchema, sliceJobRequestSchema, sliceLayerPathOrientationsRequestSchema, slicePartsBatchRequestSchema } from "../../shared/schemas.ts";
import type { ArtifactStore } from "../artifact-store.ts";
import { ProjectRevisionConflict, type ProjectStore } from "../project-store.ts";
import { assessPrintability } from "./dfm.ts";
import type { ManufacturingProfileCatalog } from "./profile-registry.ts";
import { ManufacturingProfileStore } from "./profile-store.ts";
import type { PrinterAdapter } from "./printer.ts";
import type { SlicerAdapter } from "./slicer.ts";
import { ManufacturingJobStore } from "./store.ts";

export class ManufacturingService {
  private readonly jobs: ManufacturingJobStore;
  private readonly projects: ProjectStore;
  private readonly artifacts: ArtifactStore;
  private readonly catalog: ManufacturingProfileCatalog;
  private readonly profileStore: ManufacturingProfileStore;
  private readonly slicers: ReadonlyMap<ManufacturingProfile["slicer"]["slicer"], SlicerAdapter>;
  private readonly printers: ReadonlyMap<NonNullable<ManufacturingProfile["printer"]["connection"]>["kind"], PrinterAdapter>;

  constructor(
    jobs: ManufacturingJobStore,
    projects: ProjectStore,
    artifacts: ArtifactStore,
    catalog: ManufacturingProfileCatalog,
    profileStore: ManufacturingProfileStore,
    slicers: ReadonlyMap<ManufacturingProfile["slicer"]["slicer"], SlicerAdapter>,
    printers: ReadonlyMap<NonNullable<ManufacturingProfile["printer"]["connection"]>["kind"], PrinterAdapter>,
  ) {
    this.jobs = jobs;
    this.projects = projects;
    this.artifacts = artifacts;
    this.catalog = catalog;
    this.profileStore = profileStore;
    this.slicers = slicers;
    this.printers = printers;
  }

  profiles(): ManufacturingProfileCatalog {
    const records = this.profileStore.list();
    return { ...this.catalog, records, profiles: [...this.catalog.profiles, ...records.map((record) => record.profile)] };
  }

  async registerProfile(input: ManufacturingProfileRegistrationRequest): Promise<ManufacturingProfileRecord> {
    if ("profile" in input) return await this.profileStore.register(input);
    const matches = this.catalog.profiles.filter((profile) => profile.printer.id === input.discoveredProfile.printerId
      && profile.material.id === input.discoveredProfile.materialId
      && profile.slicer.id === input.discoveredProfile.slicerId);
    if (matches.length !== 1) {
      throw new Error(matches.length === 0
        ? "The selected discovered profile is not available in the installed slicer catalog"
        : "The selected discovered profile is ambiguous; choose a profile with unique printer, material, and slicer IDs");
    }
    const { discoveredProfile: _selection, ...metadata } = input;
    return await this.profileStore.register({ ...metadata, profile: matches[0]! });
  }

  assess(input: DfmInput, profile?: ManufacturingProfile, profileHash?: string) {
    const resolved = this.resolveSliceProfile(profile, profileHash);
    return assessPrintability(input, resolved.profile);
  }

  list(projectId: string): SliceJob[] {
    return this.jobs.list(projectId);
  }

  get(jobId: string): SliceJob | undefined {
    return this.jobs.get(jobId);
  }

  interfaceLayerHeights(projectId: string, jobId: string, interfaceLayerIndices: number[]): SliceInterfaceLayerHeights {
    const request = sliceInterfaceLayerHeightsRequestSchema.parse({ interfaceLayerIndices });
    const job = this.jobs.get(jobId);
    if (!job || job.projectId !== projectId) throw new Error(`Slice job not found in project: ${jobId}`);
    const depositionLayerZMm = job.summary?.depositionLayerZMm;
    const layerPathOrientations = job.summary?.depositionLayerPathOrientations;
    const hasLayerPathOrientations = layerPathOrientations?.length === job.summary?.layers;
    if (!job.gcodeArtifactHash || !depositionLayerZMm || job.summary?.layers !== depositionLayerZMm.length) {
      throw new Error("Slice job does not contain a complete G-code deposition-height schedule");
    }
    if (request.interfaceLayerIndices.some((index) => index >= depositionLayerZMm.length)) {
      throw new Error(`Interface layer indices must be between 1 and ${depositionLayerZMm.length - 1}`);
    }
    return {
      jobId: job.id,
      ...(job.profileHash ? { profileHash: job.profileHash } : {}),
      sourceArtifactHash: job.sourceArtifactHash,
      gcodeArtifactHash: job.gcodeArtifactHash,
      layerCount: depositionLayerZMm.length,
      coordinateFrame: "slicer-build",
      firstDepositionLayerZMm: depositionLayerZMm[0]!,
      interfaces: request.interfaceLayerIndices.map((interfaceLayerIndex) => {
        const layerZ = depositionLayerZMm[interfaceLayerIndex - 1]!;
        return {
          interfaceLayerIndex,
          depositionLayerZMm: layerZ,
          relativeOffsetMm: Number((layerZ - depositionLayerZMm[0]!).toFixed(6)),
          ...(hasLayerPathOrientations && layerPathOrientations?.[interfaceLayerIndex - 1]
            ? { depositionPathOrientation: layerPathOrientations[interfaceLayerIndex - 1] }
            : {}),
        };
      }),
    };
  }

  layerPathOrientations(projectId: string, jobId: string, layerIndices: number[]): SliceLayerPathOrientations {
    const request = sliceLayerPathOrientationsRequestSchema.parse({ layerIndices });
    const job = this.jobs.get(jobId);
    if (!job || job.projectId !== projectId) throw new Error(`Slice job not found in project: ${jobId}`);
    const layerCount = job.summary?.layers;
    const depositionLayerZMm = job.summary?.depositionLayerZMm;
    const orientations = job.summary?.depositionLayerPathOrientations;
    if (!job.gcodeArtifactHash || !layerCount || depositionLayerZMm?.length !== layerCount || orientations?.length !== layerCount) {
      throw new Error("Slice job does not contain a complete G-code deposition-height and path-orientation schedule");
    }
    if (request.layerIndices.some((index) => index > layerCount)) {
      throw new Error(`Layer indices must be between 1 and ${layerCount}`);
    }
    if (orientations.some((orientation, index) => orientation.layerIndex !== index + 1)) {
      throw new Error("Slice job G-code path-orientation indices do not match its complete layer schedule");
    }
    return {
      jobId: job.id,
      ...(job.profileHash ? { profileHash: job.profileHash } : {}),
      sourceArtifactHash: job.sourceArtifactHash,
      gcodeArtifactHash: job.gcodeArtifactHash,
      layerCount,
      coordinateFrame: "slicer-build",
      layers: request.layerIndices.map((layerIndex) => ({
        layerIndex,
        depositionLayerZMm: depositionLayerZMm[layerIndex - 1]!,
        pathOrientation: orientations[layerIndex - 1]!,
      })),
    };
  }

  async slice(projectId: string, rawRequest: SliceJobRequest): Promise<SliceJob> {
    const request = sliceJobRequestSchema.parse(rawRequest);
    const { profile, profileHash } = this.resolveSliceProfile(request.profile, request.profileHash);
    const slicer = this.slicers.get(profile.slicer.slicer);
    if (!slicer) throw new Error(`No verified automated slicing adapter is available for ${profile.slicer.slicer}`);
    const project = this.projects.get(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    if (project.revision !== request.expectedRevision) throw new ProjectRevisionConflict(project.revision);
    const source = this.artifacts.get(request.sourceArtifactHash);
    if (!source || !this.artifacts.isAttachedToProject(projectId, source.hash)) {
      throw new Error(`Source artifact is not attached to project: ${request.sourceArtifactHash}`);
    }
    const report = assessPrintability(request.dfm, profile);
    if (!report.printable) throw new Error("DFM check failed; split or resize the part before slicing");
    let job = this.jobs.create(projectId, request.expectedRevision, source.hash, profile, report, profileHash);
    this.publish(job);
    try {
      const sourcePath = await this.artifacts.localPath(source.hash);
      const result = await slicer.slice(sourcePath, source.originalName, profile, join(project.workspacePath, "manufacturing", job.id));
      assertSlicedBoundsFit(result.summary, profile);
      const gcode = await this.artifacts.put(result.gcode, {
        originalName: `${source.originalName.replace(/\.[^.]+$/, "")}-${job.id.slice(0, 8)}.gcode`,
        mediaType: "text/x-gcode",
      });
      this.artifacts.attachToProject(projectId, gcode.hash);
      job = this.jobs.complete(job.id, gcode.hash, result.summary);
      this.publish(job);
      return job;
    } catch (error) {
      job = this.jobs.fail(job.id, error instanceof Error ? error.message : String(error));
      this.publish(job);
      throw new SlicingFailedError(job, error instanceof Error ? error.message : String(error));
    }
  }

  async sliceParts(projectId: string, rawRequest: SlicePartsBatchRequest): Promise<SlicePartsBatchResult> {
    const request = slicePartsBatchRequestSchema.parse(rawRequest);
    const { profile } = this.resolveSliceProfile(request.profile, request.profileHash);
    if (!this.slicers.has(profile.slicer.slicer)) {
      throw new Error(`No verified automated slicing adapter is available for ${profile.slicer.slicer}`);
    }
    const project = this.projects.get(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    if (project.revision !== request.expectedRevision) throw new ProjectRevisionConflict(project.revision);

    // Validate the entire set before creating the first persistent job so a bad
    // artifact or DFM result cannot leave a misleading partially-created batch.
    for (const part of request.parts) {
      const source = this.artifacts.get(part.sourceArtifactHash);
      if (!source || !this.artifacts.isAttachedToProject(projectId, source.hash)) {
        throw new Error(`Source artifact for ${part.label} is not attached to project: ${part.sourceArtifactHash}`);
      }
      if (!assessPrintability(part.dfm, profile).printable) {
        throw new Error(`DFM check failed for ${part.label}; split or resize the part before slicing`);
      }
    }

    const items: SlicePartsBatchResult["items"] = [];
    for (const part of request.parts) {
      try {
        const job = await this.slice(projectId, {
          expectedRevision: request.expectedRevision,
          sourceArtifactHash: part.sourceArtifactHash,
          profile,
          dfm: part.dfm,
        });
        items.push({ label: part.label, sourceArtifactHash: part.sourceArtifactHash, job });
      } catch (error) {
        const failedJob = error instanceof SlicingFailedError ? error.job : undefined;
        items.push({
          label: part.label,
          sourceArtifactHash: part.sourceArtifactHash,
          ...(failedJob ? { job: failedJob } : {}),
          failure: (error instanceof Error ? error.message : String(error)).slice(0, 4_000),
        });
      }
    }
    return { status: items.every((item) => item.job?.state === "ready") ? "completed" : "partial", items };
  }

  approve(projectId: string, jobId: string, confirmed: boolean): SliceJob {
    if (!confirmed) throw new Error("Explicit print confirmation is required");
    const project = this.projects.get(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const job = this.requireProjectJob(projectId, jobId);
    const approved = this.jobs.approve(job.id, project.revision);
    this.publish(approved);
    return approved;
  }

  async printerStatus(profile: ManufacturingProfile): Promise<PrinterStatus> {
    const printer = this.canonicalProfile(profile).printer;
    return await this.printerAdapter(printer).status(printer);
  }

  async submit(projectId: string, jobId: string): Promise<SliceJob> {
    const project = this.projects.get(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    let job = this.requireProjectJob(projectId, jobId);
    const printer = this.printerAdapter(job.profile.printer);
    if (!job.gcodeArtifactHash) throw new Error("Approved print job has no G-code artifact");
    const gcode = await readFile(await this.artifacts.localPath(job.gcodeArtifactHash));
    const remoteName = createRemoteGcodeFilename(project.name, job.id, job.gcodeArtifactHash);

    job = this.jobs.beginSubmission(job.id, project.revision);
    this.publish(job);
    try {
      const result = await printer.uploadAndStart(job.profile.printer, gcode, remoteName);
      job = this.jobs.submitted(job.id, result.remoteFilename);
      this.publish(job);
      return job;
    } catch (error) {
      job = this.jobs.uncertain(job.id, error instanceof Error ? error.message : String(error));
      this.publish(job);
      throw new Error(`Printer submission outcome is unknown; inspect the printer queue before retrying: ${job.failure}`);
    }
  }

  async reconcileSubmission(projectId: string, jobId: string): Promise<PrintSubmissionReconciliation> {
    const project = this.projects.get(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    let job = this.requireProjectJob(projectId, jobId);
    if (job.state !== "unknown") throw new Error(`Only an unknown submission can be reconciled; current state is ${job.state}`);
    if (!job.gcodeArtifactHash) throw new Error("Uncertain print job has no G-code artifact");
    const observation = await this.printerAdapter(job.profile.printer).reconcileSubmission(
      job.profile.printer,
      createRemoteGcodeFilename(project.name, job.id, job.gcodeArtifactHash),
    );
    if (observation.outcome === "submitted") {
      job = this.jobs.reconcileSubmitted(job.id, observation.expectedRemoteFilename);
      this.publish(job);
    } else if (observation.outcome === "absent") {
      job = this.jobs.reconcileAbsent(job.id, project.revision);
      this.publish(job);
    }
    return { job, observation };
  }

  private requireProjectJob(projectId: string, jobId: string): SliceJob {
    const job = this.jobs.get(jobId);
    if (!job || job.projectId !== projectId) throw new Error(`Manufacturing job not found in project: ${jobId}`);
    return job;
  }

  private canonicalProfile(input: ManufacturingProfile): ManufacturingProfile {
    const parsed = manufacturingProfileSchema.parse(input);
    const key = profileKey(parsed);
    const candidate = this.profiles().profiles.find((profile) => profileKey(profile) === key);
    if (!candidate || JSON.stringify(manufacturingProfileSchema.parse(candidate)) !== JSON.stringify(parsed)) {
      throw new Error("Manufacturing profile is not registered or does not match its immutable registry copy");
    }
    return candidate;
  }

  private resolveSliceProfile(input: ManufacturingProfile | undefined, profileHash: string | undefined): { profile: ManufacturingProfile; profileHash?: string } {
    if (profileHash !== undefined) {
      const record = this.profileStore.findByHash(profileHash);
      if (!record) throw new Error(`Immutable manufacturing profile not found: ${profileHash}`);
      return { profile: record.profile, profileHash: record.profileHash };
    }
    if (!input) throw new Error("A registered profile hash or inline registered profile is required");
    const profile = this.canonicalProfile(input);
    const record = this.profileStore.list().find((candidate) =>
      profileKey(candidate.profile) === profileKey(profile)
      && JSON.stringify(manufacturingProfileSchema.parse(candidate.profile)) === JSON.stringify(profile));
    return { profile, ...(record ? { profileHash: record.profileHash } : {}) };
  }

  private printerAdapter(profile: ManufacturingProfile["printer"]): PrinterAdapter {
    const kind = profile.connection?.kind;
    if (!kind) throw new Error(`Printer profile has no connection: ${profile.model}`);
    const adapter = this.printers.get(kind);
    if (!adapter && kind === "bambu-lan") {
      throw new Error("Direct Bambu LAN status and print control are not available. This MCP will not connect to the printer or send a command; the approved G-code remains available as a local artifact for manual handling.");
    }
    if (!adapter) throw new Error(`No verified printer adapter is available for ${kind}`);
    return adapter;
  }

  private publish(job: SliceJob): void {
    this.projects.appendEvent(job.projectId, { type: "manufacturing.job-updated", job });
  }
}

class SlicingFailedError extends Error {
  readonly job: SliceJob;

  constructor(job: SliceJob, message: string) {
    super(message);
    this.name = "SlicingFailedError";
    this.job = job;
  }
}

function profileKey(profile: ManufacturingProfile): string {
  return [profile.printer.id, profile.material.id, profile.slicer.id].join("|");
}

export function createRemoteGcodeFilename(projectName: string, jobId: string, gcodeArtifactHash: string): string {
  const projectSlug = projectName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  const prefix = projectSlug || "plasticity";
  return `${prefix}-${jobId.slice(0, 8)}-${gcodeArtifactHash.slice(0, 12)}.gcode`;
}

export function assertSlicedBoundsFit(summary: NonNullable<SliceJob["summary"]>, profile: ManufacturingProfile): void {
  if (!summary.boundsMm || summary.boundsSource === undefined || summary.boundsSource === "extrusion-path-estimate") {
    throw new Error("Slicer output lacks model-bound metadata; estimated extrusion bounds cannot certify printer fit");
  }
  const origin = profile.printer.buildOriginMm ?? [0, 0, 0];
  const size = summary.boundsMm.max.map((value, axis) => value - summary.boundsMm!.min[axis]!) as [number, number, number];
  const outside = size.some((value, axis) => value > profile.printer.buildVolumeMm[axis]! + 0.01)
    || summary.boundsMm.min.some((value, axis) => value < origin[axis]! - 0.01)
    || summary.boundsMm.max.some((value, axis) => value > origin[axis]! + profile.printer.buildVolumeMm[axis]! + 0.01);
  if (outside) {
    throw new Error(`Sliced toolpath ${size.map((value) => Number(value.toFixed(2))).join(" × ")} mm exceeds printer build volume ${profile.printer.buildVolumeMm.join(" × ")} mm`);
  }
}
