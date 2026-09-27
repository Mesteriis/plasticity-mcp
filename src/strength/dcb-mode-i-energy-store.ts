import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";

import {
  calculateDcbModeIEnergy,
  dcbModeIEnergyInputSchema,
} from "./dcb-mode-i-energy.ts";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/i);

export const dcbModeIEnergyRecordInputSchema = dcbModeIEnergyInputSchema.safeExtend({
  callerConfirmsPhysicalTests: z.literal(true),
});

export const dcbModeIEnergyQuerySchema = z.object({
  materialProcess: dcbModeIEnergyInputSchema.shape.materialProcess,
  interfaceNormalGlobal: dcbModeIEnergyInputSchema.shape.interfaceNormalGlobal,
  testProtocolHash: sha256,
}).strict();

const recordEnvelopeSchema = z.object({
  input: dcbModeIEnergyRecordInputSchema,
  calculation: z.unknown(),
  id: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(),
  recordStatus: z.literal("caller-attested-physical-dcb-mode-i-energy-test"),
}).strict();

export type DcbModeIEnergyRecordInput = z.infer<typeof dcbModeIEnergyRecordInputSchema>;
export type DcbModeIEnergyQuery = z.infer<typeof dcbModeIEnergyQuerySchema>;
export type DcbModeIEnergyRecord = {
  input: DcbModeIEnergyRecordInput;
  calculation: ReturnType<typeof calculateDcbModeIEnergy>;
  id: string;
  createdAt: string;
  recordStatus: "caller-attested-physical-dcb-mode-i-energy-test";
};

export class DcbModeIEnergyTestStore {
  private readonly root: string;

  constructor(root: string) { this.root = resolve(root); }

  async record(rawInput: unknown): Promise<{ record: DcbModeIEnergyRecord; alreadyExisted: boolean }> {
    const input = dcbModeIEnergyRecordInputSchema.parse(rawInput);
    const { callerConfirmsPhysicalTests: _confirmation, ...calculationInput } = input;
    const calculation = calculateDcbModeIEnergy(calculationInput);
    const id = hashInput(input);
    const record = {
      input,
      calculation,
      id,
      createdAt: new Date().toISOString(),
      recordStatus: "caller-attested-physical-dcb-mode-i-energy-test" as const,
    };
    const serialized = `${JSON.stringify(record, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > 16 * 1024 * 1024) throw new Error("DCB Mode-I energy test record exceeds 16 MiB");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      await writeFile(this.recordPath(id), serialized, { flag: "wx", mode: 0o600 });
      return { record: structuredClone(record), alreadyExisted: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await this.readRecord(id);
      if (canonicalJson(existing.input) !== canonicalJson(input)) throw new Error(`Stored DCB Mode-I energy record does not match its content hash: ${id}`);
      return { record: existing, alreadyExisted: true };
    }
  }

  async list(): Promise<DcbModeIEnergyRecord[]> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.root, { withFileTypes: true });
    const records: DcbModeIEnergyRecord[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      records.push(await this.readRecord(entry.name.slice(0, -5)));
    }
    return records.sort((left, right) => left.input.testedAt.localeCompare(right.input.testedAt)).map((record) => structuredClone(record));
  }

  async match(rawQuery: DcbModeIEnergyQuery) {
    const query = dcbModeIEnergyQuerySchema.parse(rawQuery);
    const records = (await this.list()).filter((record) =>
      canonicalJson(record.input.materialProcess) === canonicalJson(query.materialProcess)
      && canonicalJson(record.input.interfaceNormalGlobal) === canonicalJson(query.interfaceNormalGlobal)
      && record.input.testProtocolHash === query.testProtocolHash);
    if (records.length === 0) return {
      status: "no-match" as const,
      source: "immutable-local-physical-dcb-mode-i-energy-registry" as const,
      records: [],
      selected: null,
      reasons: ["No recorded DCB Mode-I energy test exactly matches the material process, interface normal and protocol hash"],
    };
    const fingerprints = new Set(records.map((record) => canonicalJson(record.calculation.specimens)));
    if (fingerprints.size > 1) return {
      status: "ambiguous" as const,
      source: "immutable-local-physical-dcb-mode-i-energy-registry" as const,
      records,
      selected: null,
      reasons: ["Conflicting measured DCB Mode-I energy curves exist for the exact material process, interface normal and test protocol"],
    };
    const selected = records.toSorted((left, right) => right.input.testedAt.localeCompare(left.input.testedAt))[0]!;
    return {
      status: "matched" as const,
      source: "immutable-local-physical-dcb-mode-i-energy-registry" as const,
      records,
      selected,
      reasons: [],
    };
  }

  async read(recordId: string): Promise<DcbModeIEnergyRecord> { return await this.readRecord(recordId); }

  private recordPath(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`Invalid DCB Mode-I energy record ID: ${hash}`);
    return join(this.root, `${hash}.json`);
  }

  private async readRecord(hash: string): Promise<DcbModeIEnergyRecord> {
    const handle = await open(this.recordPath(hash), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size <= 0 || stat.size > 16 * 1024 * 1024) throw new Error(`Invalid DCB Mode-I energy record file: ${hash}`);
      const parsed: unknown = JSON.parse(await handle.readFile("utf8"));
      const envelope = recordEnvelopeSchema.parse(parsed);
      if (envelope.id !== hash || hashInput(envelope.input) !== hash) throw new Error(`DCB Mode-I energy record content hash mismatch: ${hash}`);
      const { callerConfirmsPhysicalTests: _confirmation, ...calculationInput } = envelope.input;
      const calculation = calculateDcbModeIEnergy(calculationInput);
      if (canonicalJson(calculation) !== canonicalJson(envelope.calculation)) throw new Error(`DCB Mode-I energy result no longer matches its immutable test input: ${hash}`);
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

function hashInput(input: DcbModeIEnergyRecordInput): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
