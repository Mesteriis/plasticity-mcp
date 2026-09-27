import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { DfmReport, ManufacturingProfile, SliceJob, SliceJobState, SliceSummary } from "../../shared/contracts.ts";

interface JobRow {
  id: string;
  project_id: string;
  project_revision: number;
  source_artifact_hash: string;
  gcode_artifact_hash: string | null;
  profile_hash: string | null;
  profile_json: string;
  dfm_report_json: string;
  summary_json: string | null;
  state: SliceJobState;
  failure: string | null;
  approval_digest: string | null;
  approved_at: string | null;
  submitted_at: string | null;
  remote_filename: string | null;
  created_at: string;
  updated_at: string;
}

export class ManufacturingJobStore {
  private readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  create(projectId: string, projectRevision: number, sourceArtifactHash: string, profile: ManufacturingProfile, report: DfmReport, profileHash?: string): SliceJob {
    const project = this.database.prepare("SELECT revision FROM projects WHERE id = ?").get(projectId) as { revision: number } | undefined;
    if (!project) throw new Error(`Project not found: ${projectId}`);
    if (project.revision !== projectRevision) throw new Error(`Project revision changed to ${project.revision}`);
    const artifact = this.database.prepare(`SELECT 1 FROM project_artifacts WHERE project_id = ? AND artifact_hash = ?`).get(projectId, sourceArtifactHash);
    if (!artifact) throw new Error(`Source artifact is not attached to project: ${sourceArtifactHash}`);
    const now = new Date().toISOString();
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO manufacturing_jobs (
        id, project_id, project_revision, source_artifact_hash, profile_json, profile_hash,
        dfm_report_json, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'slicing', ?, ?)
    `).run(id, projectId, projectRevision, sourceArtifactHash, JSON.stringify(profile), profileHash ?? null, JSON.stringify(report), now, now);
    return this.require(id);
  }

  get(id: string): SliceJob | undefined {
    const row = this.database.prepare("SELECT * FROM manufacturing_jobs WHERE id = ?").get(id) as JobRow | undefined;
    return row ? mapJob(row) : undefined;
  }

  list(projectId: string): SliceJob[] {
    const rows = this.database.prepare("SELECT * FROM manufacturing_jobs WHERE project_id = ? ORDER BY created_at DESC").all(projectId) as unknown as JobRow[];
    return rows.map(mapJob);
  }

  complete(id: string, gcodeArtifactHash: string, summary: SliceSummary): SliceJob {
    return this.update(id, "ready", {
      gcodeArtifactHash,
      summary,
      failure: null,
      approvalDigest: null,
      approvedAt: null,
    });
  }

  fail(id: string, failure: string): SliceJob {
    return this.update(id, "failed", { failure: failure.slice(0, 4_000), approvalDigest: null, approvedAt: null });
  }

  approve(id: string, currentProjectRevision: number): SliceJob {
    const job = this.require(id);
    if (job.state !== "ready") throw new Error(`Only a ready slice can be approved; current state is ${job.state}`);
    if (!job.gcodeArtifactHash) throw new Error("Ready slice has no G-code artifact");
    if (job.projectRevision !== currentProjectRevision) throw new Error("The project changed after slicing; slice again before approval");
    return this.update(id, "approved", {
      approvalDigest: approvalDigest(job),
      approvedAt: new Date().toISOString(),
    });
  }

  beginSubmission(id: string, currentProjectRevision: number): SliceJob {
    const job = this.require(id);
    if (job.state !== "approved") throw new Error(`Print job is not approved; current state is ${job.state}`);
    if (job.projectRevision !== currentProjectRevision) throw new Error("The project changed after approval; approval is invalid");
    const row = this.database.prepare("SELECT approval_digest FROM manufacturing_jobs WHERE id = ?").get(id) as { approval_digest: string | null };
    if (!row.approval_digest || row.approval_digest !== approvalDigest(job)) throw new Error("Print approval does not match the exact G-code, profile, warnings, and estimates");
    return this.update(id, "submitting", {});
  }

  submitted(id: string, remoteFilename: string): SliceJob {
    return this.update(id, "submitted", { remoteFilename, submittedAt: new Date().toISOString() });
  }

  uncertain(id: string, failure: string): SliceJob {
    return this.update(id, "unknown", { failure: failure.slice(0, 4_000) });
  }

  reconcileSubmitted(id: string, remoteFilename: string): SliceJob {
    const job = this.require(id);
    if (job.state !== "unknown") throw new Error(`Only an unknown submission can be reconciled; current state is ${job.state}`);
    return this.update(id, "submitted", {
      remoteFilename,
      submittedAt: new Date().toISOString(),
      failure: null,
    });
  }

  reconcileAbsent(id: string, currentProjectRevision: number): SliceJob {
    const job = this.require(id);
    if (job.state !== "unknown") throw new Error(`Only an unknown submission can be reconciled; current state is ${job.state}`);
    if (job.projectRevision !== currentProjectRevision) {
      throw new Error("The project changed after approval; the uncertain print cannot be restored for submission");
    }
    return this.update(id, "approved", { failure: null });
  }

  private require(id: string): SliceJob {
    const job = this.get(id);
    if (!job) throw new Error(`Manufacturing job not found: ${id}`);
    return job;
  }

  private update(id: string, state: SliceJobState, values: {
    gcodeArtifactHash?: string;
    summary?: SliceSummary;
    failure?: string | null;
    approvalDigest?: string | null;
    approvedAt?: string | null;
    submittedAt?: string;
    remoteFilename?: string;
  }): SliceJob {
    const now = new Date().toISOString();
    const current = this.database.prepare("SELECT * FROM manufacturing_jobs WHERE id = ?").get(id) as JobRow | undefined;
    if (!current) throw new Error(`Manufacturing job not found: ${id}`);
    this.database.prepare(`
      UPDATE manufacturing_jobs SET
        state = ?, gcode_artifact_hash = ?, summary_json = ?, failure = ?, approval_digest = ?,
        approved_at = ?, submitted_at = ?, remote_filename = ?, updated_at = ?
      WHERE id = ?
    `).run(
      state,
      values.gcodeArtifactHash ?? current.gcode_artifact_hash,
      values.summary ? JSON.stringify(values.summary) : current.summary_json,
      values.failure === undefined ? current.failure : values.failure,
      values.approvalDigest === undefined ? current.approval_digest : values.approvalDigest,
      values.approvedAt === undefined ? current.approved_at : values.approvedAt,
      values.submittedAt ?? current.submitted_at,
      values.remoteFilename ?? current.remote_filename,
      now,
      id,
    );
    return this.require(id);
  }
}

function approvalDigest(job: SliceJob): string {
  return createHash("sha256").update(JSON.stringify({
    jobId: job.id,
    projectId: job.projectId,
    projectRevision: job.projectRevision,
    sourceArtifactHash: job.sourceArtifactHash,
    gcodeArtifactHash: job.gcodeArtifactHash,
    profileHash: job.profileHash,
    printer: job.profile.printer,
    material: job.profile.material,
    slicer: job.profile.slicer,
    dfmReport: job.dfmReport,
    summary: job.summary,
  })).digest("hex");
}

function mapJob(row: JobRow): SliceJob {
  return {
    id: row.id,
    projectId: row.project_id,
    projectRevision: row.project_revision,
    sourceArtifactHash: row.source_artifact_hash,
    ...(row.gcode_artifact_hash ? { gcodeArtifactHash: row.gcode_artifact_hash } : {}),
    ...(row.profile_hash ? { profileHash: row.profile_hash } : {}),
    profile: JSON.parse(row.profile_json) as ManufacturingProfile,
    dfmReport: JSON.parse(row.dfm_report_json) as DfmReport,
    ...(row.summary_json ? { summary: JSON.parse(row.summary_json) as SliceSummary } : {}),
    state: row.state,
    ...(row.failure ? { failure: row.failure } : {}),
    ...(row.approved_at ? { approvedAt: row.approved_at } : {}),
    ...(row.submitted_at ? { submittedAt: row.submitted_at } : {}),
    ...(row.remote_filename ? { remoteFilename: row.remote_filename } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
