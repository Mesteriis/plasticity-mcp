import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { ManufacturingProfileRecord, ManufacturingProfileRegistrationInput } from "../../shared/contracts.ts";
import { manufacturingProfileRegistrationSchema } from "../../shared/schemas.ts";

interface ProfileRow {
  record_json: string;
}

export class ManufacturingProfileStore {
  private readonly database: DatabaseSync;
  private readonly root: string;

  constructor(database: DatabaseSync, root: string) {
    this.database = database;
    this.root = resolve(root);
  }

  list(): ManufacturingProfileRecord[] {
    const rows = this.database.prepare(`
      SELECT record_json FROM manufacturing_profiles ORDER BY created_at ASC, rowid ASC
    `).all() as unknown as ProfileRow[];
    return rows.map((row) => JSON.parse(row.record_json) as ManufacturingProfileRecord);
  }

  findByHash(profileHash: string): ManufacturingProfileRecord | undefined {
    return this.list().find((record) => record.profileHash === profileHash);
  }

  async register(input: ManufacturingProfileRegistrationInput): Promise<ManufacturingProfileRecord> {
    const parsed = manufacturingProfileRegistrationSchema.parse(input);
    if (!("profile" in parsed)) throw new Error("Discovered profiles must be resolved by the manufacturing service before registration");
    const paths = parsed.profile.slicer;
    const [machine, process, filament] = await Promise.all([
      readRegularFile(paths.machineConfigPath),
      readRegularFile(paths.processConfigPath),
      readRegularFile(paths.filamentConfigPath),
    ]);
    const id = randomUUID();
    const directory = join(this.root, id);
    await mkdir(this.root, { recursive: true });
    await mkdir(directory, { recursive: false });
    try {
      const copiedPaths = {
        machineConfigPath: join(directory, "machine.json"),
        processConfigPath: join(directory, "process.json"),
        filamentConfigPath: join(directory, "filament.json"),
      };
      await Promise.all([
        writeFile(copiedPaths.machineConfigPath, machine, { flag: "wx" }),
        writeFile(copiedPaths.processConfigPath, process, { flag: "wx" }),
        writeFile(copiedPaths.filamentConfigPath, filament, { flag: "wx" }),
      ]);
      const configHashes = {
        machine: sha256(machine),
        process: sha256(process),
        filament: sha256(filament),
      };
      const record: ManufacturingProfileRecord = {
        ...parsed,
        id,
        profile: {
          ...parsed.profile,
          slicer: { ...parsed.profile.slicer, ...copiedPaths },
        },
        configHashes,
        profileHash: sha256(Buffer.from(canonicalJson({
          profile: parsed.profile,
          configHashes,
          verification: parsed.verification,
          sourceUrl: parsed.sourceUrl,
          notes: parsed.notes,
        }))),
        createdAt: new Date().toISOString(),
      };
      this.database.prepare(`
        INSERT INTO manufacturing_profiles (
          id, printer_id, material_id, slicer_id, record_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        record.id,
        record.profile.printer.id,
        record.profile.material.id,
        record.profile.slicer.id,
        JSON.stringify(record),
        record.createdAt,
      );
      return record;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
}

async function readRegularFile(path: string): Promise<Buffer> {
  const resolved = await realpath(resolve(path));
  if (!(await stat(resolved)).isFile()) throw new Error(`Profile config is not a regular file: ${path}`);
  const data = await readFile(resolved);
  if (data.byteLength === 0 || data.byteLength > 10 * 1024 * 1024) throw new Error(`Profile config size is invalid: ${path}`);
  const value: unknown = JSON.parse(data.toString("utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Profile config is not a JSON object: ${path}`);
  return data;
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value === undefined) return "null";
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}
