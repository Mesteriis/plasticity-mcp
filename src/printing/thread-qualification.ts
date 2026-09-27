import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";

const boundedId = z.string().trim().min(1).max(240);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const printedThreadProcessIdentitySchema = z.object({
  printerId: boundedId,
  materialId: boundedId,
  slicingProfileId: boundedId,
  nozzleDiameterMm: z.number().finite().positive().max(5),
  layerHeightMm: z.number().finite().positive().max(5),
  orientation: z.string().trim().min(1).max(500),
  clearanceBasis: z.string().trim().min(1).max(1000),
  processFingerprintSha256: sha256.optional(),
}).strict();

export const printedThreadQualificationInputSchema = z.object({
  process: printedThreadProcessIdentitySchema,
  thread: z.object({
    profile: z.literal("rounded-print-v1"),
    nominalCrestDiameterMm: z.number().finite().positive(),
    pitchMm: z.number().finite().positive(),
    threadDepthMm: z.number().finite().positive(),
    handedness: z.enum(["right", "left"]),
  }).strict(),
  selectedSampleId: z.string().trim().min(1).max(80),
  profileClearanceMm: z.number().finite().nonnegative(),
  fitClass: z.enum(["free-running", "normal", "snug"]),
  testedEngagementLengthMm: z.number().finite().positive(),
  cyclesCompleted: z.number().int().positive().max(1_000_000),
  testLoadN: z.number().finite().nonnegative().max(1_000_000).optional(),
  testTemperatureC: z.number().finite().min(-100).max(500).optional(),
  testedAt: z.iso.datetime(),
  notes: z.string().trim().min(1).max(4000).optional(),
  source: z.literal("physical-calibration-specimen"),
  confirmedPhysicalTest: z.literal(true),
}).strict().superRefine((input, context) => {
  const maleProfileDiameterMm = input.thread.threadDepthMm * 1.1;
  if (maleProfileDiameterMm >= input.thread.pitchMm) {
    context.addIssue({ code: "custom", path: ["thread", "threadDepthMm"], message: "Male rounded profile diameter must be less than thread pitch" });
  }
  if (maleProfileDiameterMm + input.profileClearanceMm * 2 >= input.thread.pitchMm) {
    context.addIssue({ code: "custom", path: ["profileClearanceMm"], message: "Qualified female rounded profile plus clearance must be less than thread pitch" });
  }
});

export const printedThreadQualificationRecordSchema = printedThreadQualificationInputSchema.extend({
  id: sha256,
  createdAt: z.iso.datetime(),
  qualificationStatus: z.literal("user-qualified-physical-fit"),
}).strict();

export const printedThreadQualificationFilterSchema = z.object({
  printerId: boundedId.optional(),
  materialId: boundedId.optional(),
  slicingProfileId: boundedId.optional(),
  nominalCrestDiameterMm: z.number().finite().positive().optional(),
  pitchMm: z.number().finite().positive().optional(),
  threadDepthMm: z.number().finite().positive().optional(),
  handedness: z.enum(["right", "left"]).optional(),
  fitClass: z.enum(["free-running", "normal", "snug"]).optional(),
}).strict();

export const printedThreadQualificationMatchSchema = z.object({
  process: printedThreadProcessIdentitySchema,
  thread: z.object({
    profile: z.literal("rounded-print-v1"),
    nominalCrestDiameterMm: z.number().finite().positive(),
    pitchMm: z.number().finite().positive(),
    threadDepthMm: z.number().finite().positive(),
    handedness: z.enum(["right", "left"]),
  }).strict(),
  requiredEngagementLengthMm: z.number().finite().positive(),
  fitClass: z.enum(["free-running", "normal", "snug"]).optional(),
}).strict();

export type PrintedThreadProcessIdentity = z.infer<typeof printedThreadProcessIdentitySchema>;
export type PrintedThreadQualificationInput = z.infer<typeof printedThreadQualificationInputSchema>;
export type PrintedThreadQualificationRecord = z.infer<typeof printedThreadQualificationRecordSchema>;
export type PrintedThreadQualificationFilter = z.infer<typeof printedThreadQualificationFilterSchema>;
export type PrintedThreadQualificationMatch = z.infer<typeof printedThreadQualificationMatchSchema>;

export interface PrintedThreadQualificationMatchResult {
  status: "no-match" | "matched" | "ambiguous";
  source: "immutable-local-physical-test-registry";
  records: PrintedThreadQualificationRecord[];
  selected: PrintedThreadQualificationRecord | null;
  reasons: string[];
}

export class PrintedThreadQualificationStore {
  private readonly root: string;

  constructor(root = join(process.cwd(), ".plasticity-mcp", "thread-qualifications")) {
    this.root = resolve(root);
  }

  async record(rawInput: PrintedThreadQualificationInput): Promise<{ record: PrintedThreadQualificationRecord; alreadyExisted: boolean }> {
    const input = printedThreadQualificationInputSchema.parse(rawInput);
    const id = qualificationHash(input);
    const path = this.recordPath(id);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const record = printedThreadQualificationRecordSchema.parse({
      ...input,
      id,
      createdAt: new Date().toISOString(),
      qualificationStatus: "user-qualified-physical-fit",
    });
    try {
      await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      return { record: structuredClone(record), alreadyExisted: false };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const existing = await this.readRecord(id);
      if (qualificationHash(stripRecord(existing)) !== id) throw new Error(`Stored printed-thread qualification does not match its content hash: ${id}`);
      return { record: existing, alreadyExisted: true };
    }
  }

  async list(rawFilter: PrintedThreadQualificationFilter = {}): Promise<PrintedThreadQualificationRecord[]> {
    const filter = printedThreadQualificationFilterSchema.parse(rawFilter);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.root, { withFileTypes: true });
    const records: PrintedThreadQualificationRecord[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      const record = await this.readRecord(entry.name.slice(0, -5));
      if (matchesFilter(record, filter)) records.push(record);
    }
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((record) => structuredClone(record));
  }

  async get(id: string): Promise<PrintedThreadQualificationRecord | null> {
    try {
      return await this.readRecord(id);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
  }

  async match(rawQuery: PrintedThreadQualificationMatch): Promise<PrintedThreadQualificationMatchResult> {
    const query = printedThreadQualificationMatchSchema.parse(rawQuery);
    const records = (await this.list()).filter((record) =>
      sameProcess(record.process, query.process)
      && sameThread(record.thread, query.thread)
      && record.testedEngagementLengthMm + 1e-9 >= query.requiredEngagementLengthMm
      && (query.fitClass === undefined || record.fitClass === query.fitClass));
    if (records.length === 0) {
      return {
        status: "no-match",
        source: "immutable-local-physical-test-registry",
        records: [],
        selected: null,
        reasons: ["No physical calibration record exactly matches the process, rounded thread definition, fit class, and required engagement length"],
      };
    }
    const clearances = new Set(records.map((record) => canonicalNumber(record.profileClearanceMm)));
    if (clearances.size > 1) {
      return {
        status: "ambiguous",
        source: "immutable-local-physical-test-registry",
        records,
        selected: null,
        reasons: ["Multiple physically qualified records match but select different profile clearances; choose the intended test result explicitly"],
      };
    }
    const selected = records.toSorted((a, b) => b.testedEngagementLengthMm - a.testedEngagementLengthMm || b.testedAt.localeCompare(a.testedAt))[0]!;
    return {
      status: "matched",
      source: "immutable-local-physical-test-registry",
      records,
      selected,
      reasons: [],
    };
  }

  private recordPath(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error(`Invalid printed-thread qualification ID: ${id}`);
    return join(this.root, `${id}.json`);
  }

  private async readRecord(id: string): Promise<PrintedThreadQualificationRecord> {
    const handle = await open(this.recordPath(id), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size <= 0 || stat.size > 1_000_000) throw new Error(`Invalid printed-thread qualification file: ${id}`);
      const parsed: unknown = JSON.parse(await handle.readFile("utf8"));
      const record = printedThreadQualificationRecordSchema.parse(parsed);
      if (record.id !== id || qualificationHash(stripRecord(record)) !== id) throw new Error(`Printed-thread qualification hash mismatch: ${id}`);
      return structuredClone(record);
    } finally {
      await handle.close();
    }
  }
}

export function qualificationHash(input: PrintedThreadQualificationInput): string {
  const parsed = printedThreadQualificationInputSchema.parse(input);
  return createHash("sha256").update(JSON.stringify(parsed)).digest("hex");
}

function stripRecord(record: PrintedThreadQualificationRecord): PrintedThreadQualificationInput {
  const { id: _id, createdAt: _createdAt, qualificationStatus: _qualificationStatus, ...input } = record;
  return printedThreadQualificationInputSchema.parse(input);
}

function matchesFilter(record: PrintedThreadQualificationRecord, filter: PrintedThreadQualificationFilter): boolean {
  return (filter.printerId === undefined || record.process.printerId === filter.printerId)
    && (filter.materialId === undefined || record.process.materialId === filter.materialId)
    && (filter.slicingProfileId === undefined || record.process.slicingProfileId === filter.slicingProfileId)
    && (filter.nominalCrestDiameterMm === undefined || sameNumber(record.thread.nominalCrestDiameterMm, filter.nominalCrestDiameterMm))
    && (filter.pitchMm === undefined || sameNumber(record.thread.pitchMm, filter.pitchMm))
    && (filter.threadDepthMm === undefined || sameNumber(record.thread.threadDepthMm, filter.threadDepthMm))
    && (filter.handedness === undefined || record.thread.handedness === filter.handedness)
    && (filter.fitClass === undefined || record.fitClass === filter.fitClass);
}

function sameProcess(first: PrintedThreadProcessIdentity, second: PrintedThreadProcessIdentity): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

function sameThread(first: PrintedThreadQualificationInput["thread"], second: PrintedThreadQualificationInput["thread"]): boolean {
  return first.profile === second.profile
    && sameNumber(first.nominalCrestDiameterMm, second.nominalCrestDiameterMm)
    && sameNumber(first.pitchMm, second.pitchMm)
    && sameNumber(first.threadDepthMm, second.threadDepthMm)
    && first.handedness === second.handedness;
}

function sameNumber(first: number, second: number): boolean { return Math.abs(first - second) <= 1e-9; }
function canonicalNumber(value: number): string { return String(Math.round(value * 1e12) / 1e12); }
function errorCode(error: unknown): string | undefined { return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined; }
