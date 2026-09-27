import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, open as openFile, stat, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Readable } from "node:stream";

import type { Artifact } from "../shared/contracts.ts";
import { sha256Schema } from "../shared/schemas.ts";

export interface ArtifactMetadata {
  mediaType: string;
  originalName: string;
}

export interface ArtifactStoreOptions {
  maxBytes?: number;
}

interface ArtifactRow {
  hash: string;
  bytes: number;
  media_type: string;
  original_name: string;
  created_at: string;
}

export class ArtifactStore {
  private readonly root: string;
  private readonly database: DatabaseSync;
  private readonly maxBytes: number;

  constructor(root: string, database: DatabaseSync, options: ArtifactStoreOptions = {}) {
    this.root = resolve(root);
    this.database = database;
    this.maxBytes = options.maxBytes ?? 250 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) {
      throw new Error("Artifact byte limit must be a positive safe integer");
    }
  }

  async put(
    content: Uint8Array | AsyncIterable<Uint8Array>,
    metadata: ArtifactMetadata,
  ): Promise<Artifact> {
    validateMetadata(metadata);
    await mkdir(join(this.root, ".staging"), { recursive: true });
    const stagingPath = join(this.root, ".staging", randomUUID());
    const handle = await openFile(stagingPath, "wx", 0o600);
    const digest = createHash("sha256");
    let bytes = 0;
    try {
      for await (const sourceChunk of chunks(content)) {
        const chunk = Buffer.from(sourceChunk);
        bytes += chunk.byteLength;
        if (bytes > this.maxBytes) throw new Error(`Artifact exceeds the ${this.maxBytes} byte limit`);
        digest.update(chunk);
        await writeFully(handle, chunk);
      }
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(stagingPath).catch(() => undefined);
      throw error;
    }
    await handle.close();

    const hash = digest.digest("hex");
    const directory = join(this.root, hash.slice(0, 2));
    const target = join(directory, hash);
    await mkdir(directory, { recursive: true });
    try {
      await link(stagingPath, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        await unlink(stagingPath).catch(() => undefined);
        throw error;
      }
    }
    await unlink(stagingPath).catch(() => undefined);

    const createdAt = new Date().toISOString();
    this.database.prepare(`
      INSERT OR IGNORE INTO artifacts (hash, bytes, media_type, original_name, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(hash, bytes, metadata.mediaType, metadata.originalName, createdAt);
    const artifact = this.get(hash);
    if (!artifact) throw new Error(`Artifact metadata was not persisted: ${hash}`);
    return artifact;
  }

  get(hash: string): Artifact | undefined {
    if (!sha256Schema.safeParse(hash).success) return undefined;
    const row = this.database.prepare("SELECT * FROM artifacts WHERE hash = ?").get(hash) as ArtifactRow | undefined;
    return row ? mapArtifact(row) : undefined;
  }

  attachToProject(projectId: string, hash: string): void {
    const parsed = sha256Schema.parse(hash);
    const artifact = this.get(parsed);
    if (!artifact) throw new Error(`Artifact not found: ${hash}`);
    const project = this.database.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    this.database.prepare(`
      INSERT OR IGNORE INTO project_artifacts (project_id, artifact_hash, created_at)
      VALUES (?, ?, ?)
    `).run(projectId, parsed, new Date().toISOString());
  }

  isAttachedToProject(projectId: string, hash: string): boolean {
    if (!sha256Schema.safeParse(hash).success) return false;
    return this.database.prepare(`
      SELECT 1 FROM project_artifacts WHERE project_id = ? AND artifact_hash = ?
    `).get(projectId, hash) !== undefined;
  }

  async open(hash: string): Promise<Readable> {
    const parsed = sha256Schema.safeParse(hash);
    if (!parsed.success || !this.get(parsed.data)) throw new Error(`Artifact not found: ${hash}`);
    const path = this.pathFor(parsed.data);
    try {
      await stat(path);
    } catch {
      throw new Error(`Artifact content not found: ${hash}`);
    }
    return createReadStream(path);
  }

  async localPath(hash: string): Promise<string> {
    const parsed = sha256Schema.safeParse(hash);
    if (!parsed.success || !this.get(parsed.data)) throw new Error(`Artifact not found: ${hash}`);
    const path = this.pathFor(parsed.data);
    await stat(path).catch(() => { throw new Error(`Artifact content not found: ${hash}`); });
    return path;
  }

  private pathFor(hash: string): string {
    return join(this.root, hash.slice(0, 2), hash);
  }
}

async function* chunks(content: Uint8Array | AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  if (content instanceof Uint8Array) {
    yield content;
    return;
  }
  yield* content;
}

async function writeFully(handle: Awaited<ReturnType<typeof openFile>>, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const result = await handle.write(chunk, offset, chunk.byteLength - offset, null);
    if (result.bytesWritten <= 0) throw new Error("Artifact staging write made no progress");
    offset += result.bytesWritten;
  }
}

function validateMetadata(metadata: ArtifactMetadata): void {
  const name = metadata.originalName.trim();
  if (!name || name.length > 255 || basename(name) !== name || /[\\/]/.test(name)) {
    throw new Error("Artifact file name must be a safe display name without path separators");
  }
  if (!metadata.mediaType.trim() || metadata.mediaType.length > 200 || !/^[\w.+-]+\/[\w.+-]+$/.test(metadata.mediaType)) {
    throw new Error("Artifact media type is invalid");
  }
}

function mapArtifact(row: ArtifactRow): Artifact {
  return {
    hash: row.hash,
    bytes: row.bytes,
    mediaType: row.media_type,
    originalName: row.original_name,
    createdAt: row.created_at,
  };
}
