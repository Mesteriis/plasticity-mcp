import { constants } from "node:fs";
import { link, mkdir, open, readdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";

const boundsSchema = z.object({
  min: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
  max: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
}).strict();

export const constructionHistoryEntrySchema = z.object({
  id: z.string().uuid(),
  occurredAt: z.string().datetime(),
  operation: z.string().min(1).max(120),
  intent: z.string().max(1_000).nullable(),
  input: z.json(),
  documentToken: z.string().min(1).max(512),
  beforeRevision: z.string().min(1).max(512),
  afterDocumentToken: z.string().max(512).nullable(),
  afterRevision: z.string().max(512).nullable(),
  status: z.enum(["completed", "failed", "unknown"]),
  error: z.string().max(4_000).nullable(),
  change: z.object({
    changed: z.boolean(),
    documentChanged: z.boolean(),
    added: z.array(z.object({ id: z.number().int().positive(), type: z.string(), name: z.string().nullable(), boundsMm: boundsSchema.nullable(), faceCount: z.number().int().nonnegative(), edgeCount: z.number().int().nonnegative() }).strict()).max(10_000),
    removed: z.array(z.object({ id: z.number().int().positive(), type: z.string(), name: z.string().nullable(), boundsMm: boundsSchema.nullable(), faceCount: z.number().int().nonnegative(), edgeCount: z.number().int().nonnegative() }).strict()).max(10_000),
    modified: z.array(z.object({ id: z.number().int().positive(), renamed: z.boolean(), geometryChanged: z.boolean(), appearanceChanged: z.boolean(), visibilityChanged: z.boolean(), body: z.object({ id: z.number().int().positive(), type: z.string(), name: z.string().nullable(), boundsMm: boundsSchema.nullable(), faceCount: z.number().int().nonnegative(), edgeCount: z.number().int().nonnegative() }).strict() }).strict()).max(10_000),
    addedConstructionPlaneIds: z.array(z.string().max(512)).max(10_000),
    removedConstructionPlaneIds: z.array(z.string().max(512)).max(10_000),
    modifiedConstructionPlaneIds: z.array(z.string().max(512)).max(10_000),
    activeWorkplaneChanged: z.boolean(),
    materialsChanged: z.boolean(),
    measurementsChanged: z.boolean(),
    sectionAnalysesChanged: z.boolean(),
    instancesChanged: z.boolean(),
    referenceMeshesChanged: z.boolean(),
    groupsChanged: z.boolean(),
    staleDatumCount: z.number().int().nonnegative(),
  }).strict(),
}).strict();

export type ConstructionHistoryEntry = z.infer<typeof constructionHistoryEntrySchema>;
const MAX_HISTORY_ENTRY_BYTES = 1_000_000;

export class ConstructionHistoryStore {
  private readonly root: string;

  constructor(root = join(process.cwd(), ".plasticity-mcp", "construction-history")) {
    this.root = root;
  }

  async append(input: ConstructionHistoryEntry): Promise<void> {
    const entry = constructionHistoryEntrySchema.parse(input);
    const serialized = `${JSON.stringify(entry)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_HISTORY_ENTRY_BYTES) {
      throw new Error(`Construction history entry exceeds the ${MAX_HISTORY_ENTRY_BYTES} byte write limit`);
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const filename = `${entry.occurredAt.replace(/[-:.TZ]/g, "")}-${entry.id}.json`;
    const finalPath = join(this.root, filename);
    const temporary = join(this.root, `.tmp-${randomUUID()}`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close();
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    await handle.close();
    try {
      await link(temporary, finalPath);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async list(offset = 0, limit = 20): Promise<{ total: number; offset: number; limit: number; entries: ConstructionHistoryEntry[] }> {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Construction history offset must be a non-negative integer");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Construction history limit must be an integer from 1 to 100");
    let filenames: string[];
    try {
      filenames = await readdir(this.root);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return { total: 0, offset, limit, entries: [] };
      throw error;
    }
    const selected = filenames
      .filter((filename) => /^\d{17}-[0-9a-f-]{36}\.json$/.test(filename))
      .sort()
      .reverse()
      .slice(offset, offset + limit);
    const entries = await Promise.all(selected.map((filename) => readEntry(join(this.root, filename))));
    return { total: filenames.filter((filename) => /^\d{17}-[0-9a-f-]{36}\.json$/.test(filename)).length, offset, limit, entries };
  }
}

async function readEntry(path: string): Promise<ConstructionHistoryEntry> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isErrorCode(error, "ELOOP")) throw new Error(`Refusing symbolic link in construction history: ${path}`);
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error(`Construction history entry is not a regular file: ${path}`);
    if (metadata.size > MAX_HISTORY_ENTRY_BYTES) throw new Error(`Construction history entry exceeds the read limit: ${path}`);
    let raw: unknown;
    try {
      raw = JSON.parse(await handle.readFile("utf8")) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`Invalid JSON in construction history: ${path}`);
      throw error;
    }
    const parsed = constructionHistoryEntrySchema.safeParse(raw);
    if (!parsed.success) throw new Error(`Invalid construction history entry: ${parsed.error.issues[0]?.message ?? "schema error"}`);
    return structuredClone(parsed.data);
  } finally {
    await handle.close();
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
