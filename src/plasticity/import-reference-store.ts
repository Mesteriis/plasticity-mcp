import { constants } from "node:fs";
import { link, mkdir, open, readdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const boundsSchema = z.object({
  min: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
  max: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
}).strict();
const sourceSchema = z.object({
  sourceKind: z.enum(["official-manufacturer-cad", "official-documentation", "official-distributor-cad", "established-cad-library", "verified-community-cad"]),
  sourceUrl: z.string().url().refine((value) => value.startsWith("https://")),
  sourcePageUrl: z.string().url().refine((value) => value.startsWith("https://")).optional(),
  license: z.string().trim().min(1).max(1_000).optional(),
  confidence: z.enum(["verified", "probable", "approximate", "assumed", "measurement-required"]),
  artifactHash: hashSchema,
  format: z.literal("3mf").optional(),
  geometryKind: z.literal("approximate-reference-mesh").optional(),
  unitSource: z.literal("embedded-3mf-model-metadata").optional(),
  exactGeometry: z.literal(false).optional(),
}).strict();

const importedBodySchema = z.object({
  id: z.number().int().positive(),
  type: z.string().min(1).max(80),
  name: z.string().max(500).nullable(),
  boundsMm: boundsSchema.nullable(),
  faceCount: z.number().int().nonnegative(),
  edgeCount: z.number().int().nonnegative(),
}).strict();

export const stepImportRecordSchema = z.object({
  id: z.string().uuid(),
  importedAt: z.string().datetime(),
  artifactHash: hashSchema,
  format: z.enum(["step", "parasolid", "3mf"]).optional(),
  sourcePath: z.string().min(1).max(8_192),
  sourceArchive: z.object({
    sha256: hashSchema,
    bytes: z.number().int().positive().max(134_217_728),
    memberPath: z.string().min(1).max(4_096),
  }).strict().optional(),
  acquisition: z.object({
    bytes: z.number().int().positive().max(67_108_864),
    finalUrl: z.string().url().refine((value) => value.startsWith("https://")),
  }).strict().optional(),
  sourceReference: sourceSchema.optional(),
  documentToken: z.string().min(1).max(512),
  revision: z.string().min(1).max(512),
  documentTitle: z.string().max(2_000),
  bodies: z.array(importedBodySchema).max(10_000),
  referenceMeshes: z.array(z.object({
    id: z.number().int().nonnegative(),
    name: z.string().max(500).nullable(),
    sourcePath: z.string().min(1).max(8_192),
    boundsMm: boundsSchema.nullable(),
    vertexEntries: z.number().int().nonnegative(),
    triangles: z.number().int().nonnegative(),
  }).strict()).max(10_000).optional(),
}).strict().refine((record) => !record.sourceReference || record.sourceReference.artifactHash === record.artifactHash, {
  message: "Source provenance hash must match the imported artifact",
}).refine((record) => record.format !== "3mf" || (record.bodies.length === 0 && (record.referenceMeshes?.length ?? 0) > 0), {
  message: "A 3MF import record must contain approximate reference meshes and no native B-Rep bodies",
}).refine((record) => record.format !== "3mf" || record.sourceReference === undefined || record.sourceReference.format === "3mf", {
  message: "A 3MF import record cannot contain provenance for another format",
});

export type StepImportRecord = z.infer<typeof stepImportRecordSchema>;

export interface StepImportRecordInput extends Omit<StepImportRecord, "id" | "importedAt"> {
  id?: string;
  importedAt?: string;
}

export class StepImportReferenceStore {
  private readonly root: string;

  constructor(root = join(process.cwd(), ".plasticity-mcp", "references")) {
    this.root = root;
  }

  async create(input: StepImportRecordInput): Promise<StepImportRecord> {
    const record = stepImportRecordSchema.parse({
      ...input,
      id: input.id ?? randomUUID(),
      importedAt: input.importedAt ?? new Date().toISOString(),
    });
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = this.recordPath(record.id);
    const temporary = join(this.root, `.tmp-${record.id}-${randomUUID()}`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close();
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    await handle.close();
    try {
      await link(temporary, path);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    return structuredClone(record);
  }

  async get(id: string): Promise<StepImportRecord> {
    const path = this.recordPath(id);
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (isErrorCode(error, "ELOOP")) throw new Error(`Refusing symbolic link in STEP reference store: ${id}`);
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error(`STEP reference record is not a regular file: ${id}`);
      if (stat.size > 1_000_000) throw new Error(`STEP reference record exceeds the read limit: ${id}`);
      let raw: unknown;
      try {
        raw = JSON.parse(await handle.readFile("utf8")) as unknown;
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error(`Invalid JSON in STEP reference record: ${id}`);
        throw error;
      }
      const parsed = stepImportRecordSchema.safeParse(raw);
      if (!parsed.success) throw new Error(`Invalid STEP reference record ${id}: ${parsed.error.issues[0]?.message ?? "schema error"}`);
      if (parsed.data.id !== id) throw new Error(`STEP reference filename does not match record ID: ${id}`);
      return structuredClone(parsed.data);
    } finally {
      await handle.close();
    }
  }

  async list(offset = 0, limit = 20): Promise<{ total: number; offset: number; limit: number; records: StepImportRecord[] }> {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("STEP reference offset must be a non-negative integer");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("STEP reference limit must be an integer from 1 to 100");
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return { total: 0, offset, limit, records: [] };
      throw error;
    }
    const ids = names.filter((name) => /^[0-9a-f-]{36}\.json$/.test(name)).map((name) => name.slice(0, -5)).sort().reverse();
    const selected = ids.slice(offset, offset + limit);
    const records = await Promise.all(selected.map((id) => this.get(id)));
    return { total: ids.length, offset, limit, records };
  }

  private recordPath(id: string): string {
    if (!z.string().uuid().safeParse(id).success) throw new Error("STEP reference ID must be a UUID");
    return join(this.root, `${id}.json`);
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
