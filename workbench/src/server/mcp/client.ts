import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve, sep } from "node:path";
import { Readable } from "node:stream";

import type {
  Artifact,
  DfmInput,
  ManufacturingAssessmentRequest,
  ConstructionJournalInput,
  ConstructionJournalRecord,
  ManufacturingProfile,
  ManufacturingProfileRecord,
  ManufacturingProfileRegistrationRequest,
  ModelVersionInput,
  PrintSubmissionReconciliation,
  Project,
  ReferenceInput,
  ReferenceRecord,
  SliceJob,
  SliceJobRequest,
  SlicePartsBatchRequest,
  SlicePartsBatchResult,
  StructuredBlockInput,
  WorkbenchEvent,
} from "../../shared/contracts.ts";

export interface ProjectSnapshot {
  project: Project;
  events: WorkbenchEvent[];
}

export interface WorkbenchMutation<T> {
  value: T;
  project: Project;
}

export class WorkbenchApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(`Workbench API returned HTTP ${status}: ${JSON.stringify(body)}`);
    this.name = "WorkbenchApiError";
    this.status = status;
    this.body = body;
  }
}

export class WorkbenchApiClient {
  private readonly origin: string;
  private readonly fetcher: typeof fetch;

  constructor(origin: string, fetcher: typeof fetch = fetch) {
    this.origin = new URL(origin).origin;
    this.fetcher = fetcher;
  }

  projectStatus(projectId: string): Promise<ProjectSnapshot> {
    return this.request("GET", `/api/projects/${encodeURIComponent(projectId)}`);
  }

  projects(): Promise<Project[]> {
    return this.request("GET", "/api/projects");
  }

  createProject(name: string): Promise<Project> {
    return this.request("POST", "/api/projects", { name });
  }

  async uploadProjectArtifact(projectId: string, relativePath: string): Promise<Artifact> {
    if (!relativePath.trim() || isAbsolute(relativePath)) throw new Error("Artifact path must be relative to the project workspace");
    const snapshot = await this.projectStatus(projectId);
    const workspace = await realpath(snapshot.project.workspacePath);
    const candidate = await realpath(resolve(workspace, relativePath));
    if (!candidate.startsWith(`${workspace}${sep}`)) throw new Error("Artifact path escapes the project workspace");
    const metadata = await stat(candidate);
    if (!metadata.isFile()) throw new Error("Artifact path must identify a regular file");
    if (metadata.size > 250 * 1024 * 1024) throw new Error("Artifact exceeds the 250 MiB upload limit");
    const mediaType = mediaTypeFor(candidate);
    const body = Readable.toWeb(createReadStream(candidate)) as ReadableStream<Uint8Array>;
    return await this.requestRaw("POST", `/api/projects/${encodeURIComponent(projectId)}/assets`, body, {
      "content-type": mediaType,
      "content-length": String(metadata.size),
      "x-file-name-encoded": encodeURIComponent(basename(candidate)),
    });
  }

  publishModelVersion(projectId: string, expectedRevision: number, version: ModelVersionInput): Promise<WorkbenchMutation<unknown>> {
    return this.request("POST", `/api/projects/${encodeURIComponent(projectId)}/versions`, { expectedRevision, version });
  }

  publishStructuredBlock(projectId: string, expectedRevision: number, block: StructuredBlockInput): Promise<WorkbenchMutation<unknown>> {
    return this.request("POST", `/api/projects/${encodeURIComponent(projectId)}/blocks`, { expectedRevision, block });
  }

  publishStatus(projectId: string, expectedRevision: number, status: string): Promise<WorkbenchMutation<string>> {
    return this.request("POST", `/api/projects/${encodeURIComponent(projectId)}/status`, { expectedRevision, status });
  }

  registerReference(projectId: string, expectedRevision: number, reference: ReferenceInput): Promise<WorkbenchMutation<ReferenceRecord>> {
    return this.request("POST", `/api/projects/${encodeURIComponent(projectId)}/references`, { expectedRevision, reference });
  }

  references(projectId: string): Promise<ReferenceRecord[]> {
    return this.request("GET", `/api/projects/${encodeURIComponent(projectId)}/references`);
  }

  publishConstructionJournal(projectId: string, expectedRevision: number, journal: ConstructionJournalInput): Promise<WorkbenchMutation<ConstructionJournalRecord>> {
    return this.request("POST", `/api/projects/${encodeURIComponent(projectId)}/construction-journals`, { expectedRevision, journal });
  }

  constructionJournals(projectId: string): Promise<ConstructionJournalRecord[]> {
    return this.request("GET", `/api/projects/${encodeURIComponent(projectId)}/construction-journals`);
  }

  manufacturingProfiles(projectId: string): Promise<{
    profiles: ManufacturingProfile[];
    records: ManufacturingProfileRecord[];
    adapters: Array<{ id: string; available: boolean; executable?: string }>;
  }> {
    return this.request("GET", `/api/projects/${encodeURIComponent(projectId)}/manufacturing/profiles`);
  }

  registerManufacturingProfile(projectId: string, input: ManufacturingProfileRegistrationRequest): Promise<ManufacturingProfileRecord> {
    return this.request("POST", `/api/projects/${encodeURIComponent(projectId)}/manufacturing/profiles`, input);
  }

  assessPrintability(projectId: string, request: ManufacturingAssessmentRequest): Promise<unknown> {
    return this.request("POST", `/api/projects/${encodeURIComponent(projectId)}/manufacturing/assess`, request);
  }

  createSliceJob(projectId: string, request: SliceJobRequest): Promise<SliceJob> {
    return this.request("POST", `/api/projects/${encodeURIComponent(projectId)}/manufacturing/jobs`, request);
  }

  sliceParts(projectId: string, request: SlicePartsBatchRequest): Promise<SlicePartsBatchResult> {
    return this.request("POST", `/api/projects/${encodeURIComponent(projectId)}/manufacturing/jobs/batch`, request);
  }

  interfaceLayerHeights(projectId: string, jobId: string, interfaceLayerIndices: number[]): Promise<unknown> {
    return this.request("POST", `/api/projects/${encodeURIComponent(projectId)}/manufacturing/jobs/${encodeURIComponent(jobId)}/interface-heights`, { interfaceLayerIndices });
  }

  layerPathOrientations(projectId: string, jobId: string, layerIndices: number[]): Promise<unknown> {
    return this.request("POST", `/api/projects/${encodeURIComponent(projectId)}/manufacturing/jobs/${encodeURIComponent(jobId)}/layer-path-orientations`, { layerIndices });
  }

  manufacturingJobs(projectId: string): Promise<SliceJob[]> {
    return this.request("GET", `/api/projects/${encodeURIComponent(projectId)}/manufacturing/jobs`);
  }

  printerStatus(projectId: string, profile: ManufacturingProfile): Promise<unknown> {
    return this.request("POST", `/api/projects/${encodeURIComponent(projectId)}/manufacturing/printer-status`, { profile });
  }

  submitApprovedPrint(projectId: string, jobId: string): Promise<SliceJob> {
    return this.request("POST", `/api/projects/${encodeURIComponent(projectId)}/manufacturing/jobs/${encodeURIComponent(jobId)}/submit`, {});
  }

  reconcilePrintSubmission(projectId: string, jobId: string): Promise<PrintSubmissionReconciliation> {
    return this.request("POST", `/api/projects/${encodeURIComponent(projectId)}/manufacturing/jobs/${encodeURIComponent(jobId)}/reconcile`, {});
  }

  async feedback(projectId: string, afterSequence: number): Promise<{ events: WorkbenchEvent[]; nextSequence: number; revision: number }> {
    const snapshot = await this.projectStatus(projectId);
    const events = snapshot.events.filter((event) => event.sequence > afterSequence && (
      event.payload.type === "annotations.submitted" || event.payload.type === "dimension-changes.submitted"
    ));
    const nextSequence = snapshot.events.reduce((maximum, event) => Math.max(maximum, event.sequence), afterSequence);
    return { events, nextSequence, revision: snapshot.project.revision };
  }

  async waitForFeedback(
    projectId: string,
    afterSequence: number,
    timeoutSeconds: number,
  ): Promise<{ events: WorkbenchEvent[]; nextSequence: number; revision: number; timedOut: boolean }> {
    const deadline = Date.now() + timeoutSeconds * 1_000;
    while (true) {
      const result = await this.feedback(projectId, afterSequence);
      if (result.events.length > 0) return { ...result, timedOut: false };
      if (Date.now() >= deadline) return { ...result, timedOut: true };
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
    }
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method, headers: { accept: "application/json" } };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { ...init.headers, "content-type": "application/json" };
    }
    const response = await this.fetcher(`${this.origin}${path}`, init);
    const payload = await response.json() as unknown;
    if (!response.ok) throw new WorkbenchApiError(response.status, payload);
    return payload as T;
  }

  private async requestRaw<T>(method: "POST", path: string, body: ReadableStream<Uint8Array>, headers: Record<string, string>): Promise<T> {
    const init: RequestInit & { duplex: "half" } = { method, headers: { accept: "application/json", ...headers }, body, duplex: "half" };
    const response = await this.fetcher(`${this.origin}${path}`, init);
    const payload = await response.json() as unknown;
    if (!response.ok) throw new WorkbenchApiError(response.status, payload);
    return payload as T;
  }
}

function mediaTypeFor(path: string): string {
  const mediaType = ({
    ".step": "model/step",
    ".stp": "model/step",
    ".x_t": "model/vnd.parasolid.transmit.text",
    ".x_b": "model/vnd.parasolid.transmit.binary",
    ".iges": "model/iges",
    ".igs": "model/iges",
    ".stl": "model/stl",
    ".obj": "model/obj",
    ".3mf": "model/3mf",
    ".plasticity": "application/vnd.plasticity",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".json": "application/json",
    ".gcode": "text/x-gcode",
  } as Record<string, string>)[extname(path).toLowerCase()];
  if (!mediaType) throw new Error(`Unsupported artifact type: ${extname(path) || "no extension"}`);
  return mediaType;
}
