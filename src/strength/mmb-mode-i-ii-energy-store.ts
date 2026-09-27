import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";

import { calculateMmbModeIEnergy, mmbModeIEnergyInputSchema } from "./mmb-mode-i-ii-energy.ts";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/i);

export const mmbModeIEnergyRecordInputSchema = mmbModeIEnergyInputSchema.safeExtend({
  callerConfirmsPhysicalTests: z.literal(true),
});

export const mmbModeIEnergyQuerySchema = z.object({
  materialProcess: mmbModeIEnergyInputSchema.shape.materialProcess,
  interfaceNormalGlobal: mmbModeIEnergyInputSchema.shape.interfaceNormalGlobal,
  interfaceShearDirectionGlobal: mmbModeIEnergyInputSchema.shape.interfaceShearDirectionGlobal,
  testProtocolHash: sha256,
}).strict().superRefine((query, context) => {
  const dot = query.interfaceNormalGlobal.reduce((sum, value, axis) => sum + value * query.interfaceShearDirectionGlobal[axis]!, 0);
  if (Math.abs(dot) > 1e-6) {
    context.addIssue({ code: "custom", path: ["interfaceShearDirectionGlobal"], message: "MMB query shear direction must lie in the interface plane" });
  }
});

const recordEnvelopeSchema = z.object({
  input: mmbModeIEnergyRecordInputSchema,
  calculation: z.unknown(),
  id: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(),
  recordStatus: z.literal("caller-attested-physical-mmb-mode-i-ii-energy-test"),
}).strict();

export type MmbModeIEnergyRecordInput = z.infer<typeof mmbModeIEnergyRecordInputSchema>;
export type MmbModeIEnergyQuery = z.infer<typeof mmbModeIEnergyQuerySchema>;
export type MmbModeIEnergyRecord = {
  input: MmbModeIEnergyRecordInput;
  calculation: ReturnType<typeof calculateMmbModeIEnergy>;
  id: string;
  createdAt: string;
  recordStatus: "caller-attested-physical-mmb-mode-i-ii-energy-test";
};

export class MmbModeIEnergyTestStore {
  private readonly root: string;

  constructor(root: string) { this.root = resolve(root); }

  async record(rawInput: unknown): Promise<{ record: MmbModeIEnergyRecord; alreadyExisted: boolean }> {
    const input = mmbModeIEnergyRecordInputSchema.parse(rawInput);
    const { callerConfirmsPhysicalTests: _confirmation, ...calculationInput } = input;
    const calculation = calculateMmbModeIEnergy(calculationInput);
    const id = hashInput(input);
    const record = {
      input,
      calculation,
      id,
      createdAt: new Date().toISOString(),
      recordStatus: "caller-attested-physical-mmb-mode-i-ii-energy-test" as const,
    };
    const serialized = `${JSON.stringify(record, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > 16 * 1024 * 1024) throw new Error("MMB energy test record exceeds 16 MiB");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      await writeFile(this.recordPath(id), serialized, { flag: "wx", mode: 0o600 });
      return { record: structuredClone(record), alreadyExisted: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await this.readRecord(id);
      if (canonicalJson(existing.input) !== canonicalJson(input)) throw new Error(`Stored MMB energy record does not match its content hash: ${id}`);
      return { record: existing, alreadyExisted: true };
    }
  }

  async list(): Promise<MmbModeIEnergyRecord[]> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.root, { withFileTypes: true });
    const records: MmbModeIEnergyRecord[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      records.push(await this.readRecord(entry.name.slice(0, -5)));
    }
    return records.sort((left, right) => left.input.testedAt.localeCompare(right.input.testedAt)).map((record) => structuredClone(record));
  }

  async match(rawQuery: MmbModeIEnergyQuery) {
    const query = mmbModeIEnergyQuerySchema.parse(rawQuery);
    const records = (await this.list()).filter((record) =>
      canonicalJson(record.input.materialProcess) === canonicalJson(query.materialProcess)
      && canonicalJson(record.input.interfaceNormalGlobal) === canonicalJson(query.interfaceNormalGlobal)
      && canonicalJson(record.input.interfaceShearDirectionGlobal) === canonicalJson(query.interfaceShearDirectionGlobal)
      && record.input.testProtocolHash === query.testProtocolHash);
    if (records.length === 0) return {
      status: "no-match" as const,
      source: "immutable-local-physical-mmb-mode-i-ii-energy-registry" as const,
      records: [],
      selected: null,
      reasons: ["No recorded MMB energy test exactly matches the material process, interface normal, in-plane shear direction and protocol hash"],
    };
    const fingerprints = new Set(records.map((record) => canonicalJson(record.calculation.specimens)));
    if (fingerprints.size > 1) return {
      status: "ambiguous" as const,
      source: "immutable-local-physical-mmb-mode-i-ii-energy-registry" as const,
      records,
      selected: null,
      reasons: ["Conflicting MMB energy results exist for the exact process, interface normal, shear direction and protocol"],
    };
    const selected = records.toSorted((left, right) => right.input.testedAt.localeCompare(left.input.testedAt))[0]!;
    return {
      status: "matched" as const,
      source: "immutable-local-physical-mmb-mode-i-ii-energy-registry" as const,
      records,
      selected,
      reasons: [],
    };
  }

  async read(recordId: string): Promise<MmbModeIEnergyRecord> { return await this.readRecord(recordId); }

  private recordPath(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`Invalid MMB energy record ID: ${hash}`);
    return join(this.root, `${hash}.json`);
  }

  private async readRecord(hash: string): Promise<MmbModeIEnergyRecord> {
    const handle = await open(this.recordPath(hash), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size <= 0 || stat.size > 16 * 1024 * 1024) throw new Error(`Invalid MMB energy record file: ${hash}`);
      const parsed: unknown = JSON.parse(await handle.readFile("utf8"));
      const envelope = recordEnvelopeSchema.parse(parsed);
      if (envelope.id !== hash || hashInput(envelope.input) !== hash) throw new Error(`MMB energy record content hash mismatch: ${hash}`);
      const { callerConfirmsPhysicalTests: _confirmation, ...calculationInput } = envelope.input;
      const calculation = calculateMmbModeIEnergy(calculationInput);
      if (canonicalJson(calculation) !== canonicalJson(envelope.calculation)) throw new Error(`MMB energy result no longer matches its immutable test input: ${hash}`);
      return {
        input: envelope.input,
        calculation,
        id: envelope.id,
        createdAt: envelope.createdAt,
        recordStatus: envelope.recordStatus,
      };
    } finally {
      await handle.close();
    }
  }
}

function hashInput(input: MmbModeIEnergyRecordInput): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
