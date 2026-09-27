import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const CURRENT_SCHEMA_VERSION = 9;

export function openDatabase(path: string): DatabaseSync {
  const databasePath = path === ":memory:" ? path : resolve(path);
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  if (databasePath !== ":memory:") database.exec("PRAGMA journal_mode = WAL");
  migrate(database);
  return database;
}

export function immediateTransaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function migrate(database: DatabaseSync): void {
  const row = database.prepare("PRAGMA user_version").get() as { user_version: number };
  if (row.user_version > CURRENT_SCHEMA_VERSION) {
    throw new Error(`Workbench database schema ${row.user_version} is newer than supported ${CURRENT_SCHEMA_VERSION}`);
  }
  if (row.user_version < 1) {
    immediateTransaction(database, () => {
      database.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 0),
        codex_thread_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE artifacts (
        hash TEXT PRIMARY KEY CHECK (length(hash) = 64),
        bytes INTEGER NOT NULL CHECK (bytes >= 0),
        media_type TEXT NOT NULL,
        original_name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE model_versions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        number INTEGER NOT NULL CHECK (number > 0),
        plasticity_document_token TEXT NOT NULL,
        plasticity_revision TEXT NOT NULL,
        step_artifact_hash TEXT NOT NULL REFERENCES artifacts(hash),
        screenshot_artifact_hashes_json TEXT NOT NULL,
        measurements_json TEXT NOT NULL,
        body_mappings_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(project_id, number)
      );

      CREATE TABLE structured_blocks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        block_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE annotations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        model_version_id TEXT NOT NULL REFERENCES model_versions(id) ON DELETE CASCADE,
        annotation_json TEXT NOT NULL,
        remap_status TEXT NOT NULL CHECK (remap_status IN ('exact', 'required', 'unmapped')),
        created_at TEXT NOT NULL
      );

      CREATE TABLE pairing_tokens (
        token_hash TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('view', 'annotate', 'edit')),
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE event_log (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        occurred_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX event_log_project_sequence ON event_log(project_id, sequence);
      CREATE INDEX model_versions_project_number ON model_versions(project_id, number);
      CREATE INDEX annotations_project_version ON annotations(project_id, model_version_id);
        PRAGMA user_version = 1;
      `);
    });
  }
  if (row.user_version < 2) {
    immediateTransaction(database, () => {
      database.exec(`
        CREATE TABLE project_artifacts (
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          artifact_hash TEXT NOT NULL REFERENCES artifacts(hash) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          PRIMARY KEY(project_id, artifact_hash)
        );
        CREATE INDEX project_artifacts_hash ON project_artifacts(artifact_hash);
        PRAGMA user_version = 2;
      `);
    });
  }
  if (row.user_version < 3) {
    immediateTransaction(database, () => {
      database.exec(`
        CREATE TABLE codex_turns (
          client_message_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          turn_id TEXT,
          input_json TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('requested', 'started', 'completed', 'failed')),
          error TEXT,
          requested_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX codex_turns_state ON codex_turns(state);
        PRAGMA user_version = 3;
      `);
    });
  }
  if (row.user_version < 4) {
    immediateTransaction(database, () => {
      database.exec(`
        CREATE TABLE manufacturing_jobs (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          project_revision INTEGER NOT NULL CHECK (project_revision >= 0),
          source_artifact_hash TEXT NOT NULL REFERENCES artifacts(hash),
          gcode_artifact_hash TEXT REFERENCES artifacts(hash),
          profile_json TEXT NOT NULL,
          dfm_report_json TEXT NOT NULL,
          summary_json TEXT,
          state TEXT NOT NULL CHECK (state IN ('slicing', 'ready', 'failed', 'approved', 'submitting', 'submitted', 'unknown')),
          failure TEXT,
          approval_digest TEXT,
          approved_at TEXT,
          submitted_at TEXT,
          remote_filename TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX manufacturing_jobs_project_created ON manufacturing_jobs(project_id, created_at);
        PRAGMA user_version = 4;
      `);
    });
  }
  if (row.user_version < 5) {
    immediateTransaction(database, () => {
      database.exec(`
        CREATE TABLE reference_records (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          artifact_hash TEXT REFERENCES artifacts(hash),
          reference_json TEXT NOT NULL,
          retrieved_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX reference_records_project_created ON reference_records(project_id, created_at);
        PRAGMA user_version = 5;
      `);
    });
  }
  if (row.user_version < 6) {
    immediateTransaction(database, () => {
      database.exec(`
        CREATE TABLE manufacturing_profiles (
          id TEXT PRIMARY KEY,
          printer_id TEXT NOT NULL,
          material_id TEXT NOT NULL,
          slicer_id TEXT NOT NULL,
          record_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(printer_id, material_id, slicer_id)
        );
        PRAGMA user_version = 6;
      `);
    });
  }
  if (row.user_version < 7) {
    immediateTransaction(database, () => {
      database.exec(`
        CREATE TABLE construction_journals (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          document_token TEXT NOT NULL,
          revision TEXT NOT NULL,
          journal_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX construction_journals_project_created ON construction_journals(project_id, created_at);
        PRAGMA user_version = 7;
      `);
    });
  }
  if (row.user_version < 8) {
    immediateTransaction(database, () => {
      database.exec(`
        ALTER TABLE pairing_tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'link'
          CHECK (kind IN ('link', 'session'));
        PRAGMA user_version = 8;
      `);
    });
  }
  if (row.user_version < 9) {
    immediateTransaction(database, () => {
      database.exec(`
        ALTER TABLE manufacturing_jobs ADD COLUMN profile_hash TEXT;
        PRAGMA user_version = 9;
      `);
    });
  }
}
