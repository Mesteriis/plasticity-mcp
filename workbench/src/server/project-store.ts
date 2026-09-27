import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type {
  Annotation,
  AnnotationBatchInput,
  ConstructionJournalInput,
  ConstructionJournalRecord,
  DimensionChangeBatch,
  DimensionChangeBatchInput,
  ModelVersion,
  ModelVersionInput,
  Project,
  ReferenceInput,
  ReferenceRecord,
  StructuredBlock,
  StructuredBlockInput,
  WorkbenchEvent,
  WorkbenchEventPayload,
} from "../shared/contracts.ts";
import { annotationBatchSchema, constructionJournalInputSchema, dimensionChangeBatchSchema, modelVersionInputSchema, referenceInputSchema, structuredBlockInputSchema } from "../shared/schemas.ts";
import { immediateTransaction } from "./database.ts";

interface ProjectRow {
  id: string;
  name: string;
  workspace_path: string;
  revision: number;
  codex_thread_id: string | null;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  sequence: number;
  project_id: string;
  occurred_at: string;
  payload_json: string;
}

export interface ProjectMutation<T> {
  value: T;
  project: Project;
}

export interface ProjectStore {
  create(name: string, workspacePath: string): Project;
  get(projectId: string): Project | undefined;
  list(): Project[];
  bindCodexThread(projectId: string, expectedRevision: number, threadId: string): Project;
  addModelVersion(projectId: string, expectedRevision: number, input: ModelVersionInput): ProjectMutation<ModelVersion>;
  addStructuredBlock(projectId: string, expectedRevision: number, block: StructuredBlockInput): ProjectMutation<StructuredBlock>;
  addAnnotationBatch(projectId: string, input: AnnotationBatchInput): ProjectMutation<Annotation[]>;
  addDimensionChanges(projectId: string, input: DimensionChangeBatchInput): ProjectMutation<DimensionChangeBatch>;
  addReference(projectId: string, expectedRevision: number, input: ReferenceInput): ProjectMutation<ReferenceRecord>;
  listReferences(projectId: string): ReferenceRecord[];
  addConstructionJournal(projectId: string, expectedRevision: number, input: ConstructionJournalInput): ProjectMutation<ConstructionJournalRecord>;
  listConstructionJournals(projectId: string): ConstructionJournalRecord[];
  publishStatus(projectId: string, expectedRevision: number, status: string): ProjectMutation<string>;
  appendEvent(projectId: string, payload: WorkbenchEventPayload): WorkbenchEvent;
  appendCodexEvent(projectId: string, event: Record<string, unknown>): WorkbenchEvent;
  eventsAfter(projectId: string, sequence: number): WorkbenchEvent[];
  subscribe(listener: (event: WorkbenchEvent) => void): () => void;
}

export class ProjectRevisionConflict extends Error {
  readonly currentRevision: number;

  constructor(currentRevision: number) {
    super(`Project revision conflict; current revision is ${currentRevision}`);
    this.name = "ProjectRevisionConflict";
    this.currentRevision = currentRevision;
  }
}

export class SqliteProjectStore implements ProjectStore {
  private readonly database: DatabaseSync;
  private readonly listeners = new Set<(event: WorkbenchEvent) => void>();

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  create(name: string, workspacePath: string): Project {
    const trimmedName = name.trim();
    if (!trimmedName) throw new Error("Project name is required");
    if (!workspacePath.trim()) throw new Error("Project workspace path is required");
    const now = new Date().toISOString();
    const project: Project = {
      id: randomUUID(),
      name: trimmedName,
      workspacePath,
      revision: 0,
      createdAt: now,
      updatedAt: now,
    };
    const created = immediateTransaction(this.database, () => {
      this.database.prepare(`
        INSERT INTO projects (id, name, workspace_path, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(project.id, project.name, project.workspacePath, project.revision, project.createdAt, project.updatedAt);
      const event = this.insertEvent(project.id, now, { type: "project.updated", project });
      return { project, event };
    });
    this.emit(created.event);
    return created.project;
  }

  get(projectId: string): Project | undefined {
    const row = this.database.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRow | undefined;
    return row ? mapProject(row) : undefined;
  }

  list(): Project[] {
    const rows = this.database.prepare("SELECT * FROM projects ORDER BY created_at DESC, rowid DESC").all() as unknown as ProjectRow[];
    return rows.map(mapProject);
  }

  bindCodexThread(projectId: string, expectedRevision: number, threadId: string): Project {
    const trimmedThreadId = threadId.trim();
    if (!trimmedThreadId) throw new Error("Codex thread ID is required");
    return this.mutate(projectId, expectedRevision, (nextProject) => {
      this.database.prepare("UPDATE projects SET codex_thread_id = ? WHERE id = ?").run(trimmedThreadId, projectId);
      const value = { ...nextProject, codexThreadId: trimmedThreadId };
      return { value, event: { type: "project.updated", project: value } };
    }).value;
  }

  addModelVersion(
    projectId: string,
    expectedRevision: number,
    input: ModelVersionInput,
  ): ProjectMutation<ModelVersion> {
    const parsed = modelVersionInputSchema.parse(input);
    return this.mutate(projectId, expectedRevision, () => {
      const artifact = this.database.prepare(`
        SELECT artifact_hash FROM project_artifacts WHERE project_id = ? AND artifact_hash = ?
      `).get(projectId, parsed.stepArtifactHash);
      if (!artifact) throw new Error(`STEP artifact is not registered: ${parsed.stepArtifactHash}`);
      const numberRow = this.database.prepare(`
        SELECT coalesce(max(number), 0) + 1 AS number FROM model_versions WHERE project_id = ?
      `).get(projectId) as { number: number };
      const version: ModelVersion = {
        id: randomUUID(),
        projectId,
        number: numberRow.number,
        ...parsed,
        createdAt: new Date().toISOString(),
      };
      this.database.prepare(`
        INSERT INTO model_versions (
          id, project_id, number, plasticity_document_token, plasticity_revision,
          step_artifact_hash, screenshot_artifact_hashes_json, measurements_json,
          body_mappings_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        version.id,
        version.projectId,
        version.number,
        version.plasticityDocumentToken,
        version.plasticityRevision,
        version.stepArtifactHash,
        JSON.stringify(version.screenshotArtifactHashes ?? []),
        JSON.stringify(version.measurements),
        JSON.stringify(version.bodyMappings ?? []),
        version.createdAt,
      );
      return { value: version, event: { type: "model-version.published", version } };
    });
  }

  addStructuredBlock(
    projectId: string,
    expectedRevision: number,
    input: StructuredBlockInput,
  ): ProjectMutation<StructuredBlock> {
    const parsed = structuredBlockInputSchema.parse(input);
    return this.mutate(projectId, expectedRevision, () => {
      const block: StructuredBlock = {
        ...parsed,
        id: randomUUID(),
        projectId,
        createdAt: new Date().toISOString(),
      };
      this.database.prepare(`
        INSERT INTO structured_blocks (id, project_id, block_json, created_at) VALUES (?, ?, ?, ?)
      `).run(block.id, projectId, JSON.stringify(block), block.createdAt);
      return { value: block, event: { type: "structured-block.published", block } };
    });
  }

  addAnnotationBatch(projectId: string, input: AnnotationBatchInput): ProjectMutation<Annotation[]> {
    const parsed = annotationBatchSchema.parse(input);
    return this.mutate(projectId, parsed.expectedRevision, () => {
      const target = this.database.prepare(`
        SELECT id FROM model_versions WHERE id = ? AND project_id = ?
      `).get(parsed.modelVersionId, projectId);
      if (!target) throw new Error(`Model version is not part of this project: ${parsed.modelVersionId}`);
      const latest = this.database.prepare(`
        SELECT id FROM model_versions WHERE project_id = ? ORDER BY number DESC LIMIT 1
      `).get(projectId) as { id: string };
      const remapStatus = latest.id === parsed.modelVersionId ? "exact" : "required";
      const createdAt = new Date().toISOString();
      const annotations: Annotation[] = parsed.annotations.map((annotation) => ({
        ...annotation,
        id: randomUUID(),
        projectId,
        modelVersionId: parsed.modelVersionId,
        remapStatus,
        createdAt,
      }));
      const insert = this.database.prepare(`
        INSERT INTO annotations (
          id, project_id, model_version_id, annotation_json, remap_status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const annotation of annotations) {
        insert.run(
          annotation.id,
          projectId,
          annotation.modelVersionId,
          JSON.stringify(annotation),
          annotation.remapStatus,
          annotation.createdAt,
        );
      }
      return { value: annotations, event: { type: "annotations.submitted", annotations } };
    });
  }

  addDimensionChanges(projectId: string, input: DimensionChangeBatchInput): ProjectMutation<DimensionChangeBatch> {
    const parsed = dimensionChangeBatchSchema.parse(input);
    return this.mutate(projectId, parsed.expectedRevision, () => {
      const row = this.database.prepare(`
        SELECT block_json FROM structured_blocks WHERE id = ? AND project_id = ?
      `).get(parsed.blockId, projectId) as { block_json: string } | undefined;
      if (!row) throw new Error(`Structured block is not part of this project: ${parsed.blockId}`);
      const block = JSON.parse(row.block_json) as StructuredBlock;
      if (block.type !== "dimensions") throw new Error("Only dimension blocks accept numeric changes");
      const keys = new Set<string>();
      for (const change of parsed.changes) {
        if (keys.has(change.key)) throw new Error(`Duplicate dimension key: ${change.key}`);
        keys.add(change.key);
        const measurement = block.rows.find((candidate) => candidate.key === change.key);
        if (!measurement) throw new Error(`Dimension is not present in the block: ${change.key}`);
        if (measurement.unit === "count" && !Number.isInteger(change.value)) throw new Error(`${change.key} must be an integer`);
        if (measurement.input?.min !== undefined && change.value < measurement.input.min) throw new Error(`${change.key} must be at least ${measurement.input.min}`);
        if (measurement.input?.max !== undefined && change.value > measurement.input.max) throw new Error(`${change.key} must be at most ${measurement.input.max}`);
        if (measurement.input?.step !== undefined && !isStepAligned(change.value, measurement.input.step, measurement.input.min ?? 0)) {
          throw new Error(`${change.key} must use step ${measurement.input.step}`);
        }
      }
      const batch: DimensionChangeBatch = {
        ...parsed,
        id: randomUUID(),
        projectId,
        createdAt: new Date().toISOString(),
      };
      return { value: batch, event: { type: "dimension-changes.submitted", batch } };
    });
  }

  addReference(projectId: string, expectedRevision: number, input: ReferenceInput): ProjectMutation<ReferenceRecord> {
    const parsed = referenceInputSchema.parse(input);
    return this.mutate(projectId, expectedRevision, () => {
      let retrievedAt = new Date().toISOString();
      if (parsed.artifactHash) {
        const artifact = this.database.prepare(`
          SELECT artifacts.created_at
          FROM project_artifacts
          JOIN artifacts ON artifacts.hash = project_artifacts.artifact_hash
          WHERE project_artifacts.project_id = ? AND project_artifacts.artifact_hash = ?
        `).get(projectId, parsed.artifactHash) as { created_at: string } | undefined;
        if (!artifact) throw new Error(`Reference artifact is not attached to this project: ${parsed.artifactHash}`);
        retrievedAt = artifact.created_at;
      }
      const reference: ReferenceRecord = {
        ...parsed,
        id: randomUUID(),
        projectId,
        retrievedAt,
        createdAt: new Date().toISOString(),
      };
      this.database.prepare(`
        INSERT INTO reference_records (id, project_id, artifact_hash, reference_json, retrieved_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        reference.id,
        projectId,
        reference.artifactHash ?? null,
        JSON.stringify(reference),
        reference.retrievedAt,
        reference.createdAt,
      );
      return { value: reference, event: { type: "reference.registered", reference } };
    });
  }

  listReferences(projectId: string): ReferenceRecord[] {
    if (!this.get(projectId)) throw new Error(`Project not found: ${projectId}`);
    const rows = this.database.prepare(`
      SELECT reference_json FROM reference_records WHERE project_id = ? ORDER BY created_at ASC, rowid ASC
    `).all(projectId) as unknown as Array<{ reference_json: string }>;
    return rows.map((row) => JSON.parse(row.reference_json) as ReferenceRecord);
  }

  addConstructionJournal(projectId: string, expectedRevision: number, input: ConstructionJournalInput): ProjectMutation<ConstructionJournalRecord> {
    const parsed = constructionJournalInputSchema.parse(input);
    return this.mutate(projectId, expectedRevision, () => {
      const journal: ConstructionJournalRecord = {
        ...parsed,
        id: randomUUID(),
        projectId,
        createdAt: new Date().toISOString(),
      };
      this.database.prepare(`
        INSERT INTO construction_journals (id, project_id, document_token, revision, journal_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(journal.id, projectId, journal.documentToken, journal.revision, JSON.stringify(journal), journal.createdAt);
      return { value: journal, event: { type: "construction-journal.published", journal } };
    });
  }

  listConstructionJournals(projectId: string): ConstructionJournalRecord[] {
    if (!this.get(projectId)) throw new Error(`Project not found: ${projectId}`);
    const rows = this.database.prepare(`
      SELECT journal_json FROM construction_journals WHERE project_id = ? ORDER BY created_at ASC, rowid ASC
    `).all(projectId) as unknown as Array<{ journal_json: string }>;
    return rows.map((row) => JSON.parse(row.journal_json) as ConstructionJournalRecord);
  }

  publishStatus(projectId: string, expectedRevision: number, status: string): ProjectMutation<string> {
    const trimmed = status.trim();
    if (!trimmed || trimmed.length > 4_000) throw new Error("Status must contain 1 to 4000 characters");
    return this.mutate(projectId, expectedRevision, () => ({
      value: trimmed,
      event: { type: "status.published", status: trimmed },
    }));
  }

  appendCodexEvent(projectId: string, event: Record<string, unknown>): WorkbenchEvent {
    return this.appendEvent(projectId, { type: "codex.event", event });
  }

  appendEvent(projectId: string, payload: WorkbenchEventPayload): WorkbenchEvent {
    if (!this.get(projectId)) throw new Error(`Project not found: ${projectId}`);
    const workbenchEvent = immediateTransaction(this.database, () =>
      this.insertEvent(projectId, new Date().toISOString(), payload));
    this.emit(workbenchEvent);
    return workbenchEvent;
  }

  eventsAfter(projectId: string, sequence: number): WorkbenchEvent[] {
    const rows = this.database.prepare(`
      SELECT sequence, project_id, occurred_at, payload_json
      FROM event_log WHERE project_id = ? AND sequence > ? ORDER BY sequence ASC
    `).all(projectId, sequence) as unknown as EventRow[];
    return rows.map((row) => ({
      sequence: row.sequence,
      projectId: row.project_id,
      occurredAt: row.occurred_at,
      payload: JSON.parse(row.payload_json) as WorkbenchEventPayload,
    }));
  }

  subscribe(listener: (event: WorkbenchEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private mutate<T>(
    projectId: string,
    expectedRevision: number,
    operation: (nextProject: Project) => { value: T; event: WorkbenchEventPayload },
  ): ProjectMutation<T> {
    const committed = immediateTransaction(this.database, () => {
      const row = this.database.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRow | undefined;
      if (!row) throw new Error(`Project not found: ${projectId}`);
      const current = mapProject(row);
      if (current.revision !== expectedRevision) throw new ProjectRevisionConflict(current.revision);
      const updatedAt = new Date().toISOString();
      const project: Project = { ...current, revision: current.revision + 1, updatedAt };
      const { value, event } = operation(project);
      this.database.prepare(`
        UPDATE projects SET revision = ?, updated_at = ? WHERE id = ?
      `).run(project.revision, project.updatedAt, projectId);
      const workbenchEvent = this.insertEvent(projectId, updatedAt, event);
      return { mutation: { value, project }, event: workbenchEvent };
    });
    this.emit(committed.event);
    return committed.mutation;
  }

  private insertEvent(projectId: string, occurredAt: string, payload: WorkbenchEventPayload): WorkbenchEvent {
    const result = this.database.prepare(`
      INSERT INTO event_log (project_id, occurred_at, payload_json) VALUES (?, ?, ?)
    `).run(projectId, occurredAt, JSON.stringify(payload));
    return {
      sequence: Number(result.lastInsertRowid),
      projectId,
      occurredAt,
      payload,
    };
  }

  private emit(event: WorkbenchEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function isStepAligned(value: number, step: number, base: number): boolean {
  const steps = (value - base) / step;
  return Math.abs(steps - Math.round(steps)) <= Number.EPSILON * Math.max(16, Math.abs(steps) * 16);
}

function mapProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    workspacePath: row.workspace_path,
    revision: row.revision,
    ...(row.codex_thread_id ? { codexThreadId: row.codex_thread_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
