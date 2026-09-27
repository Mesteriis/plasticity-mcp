import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";

import { exactMaterialCouponProcessSchema } from "./material-qualification.ts";
import { evidenceSchema } from "./schemas.ts";

const positive = z.number().finite().positive();
const hole = z.object({ xMm: z.number().finite(), yMm: z.number().finite(), diameterMm: positive }).strict();
const geometry = z.object({
  widthMm: positive,
  heightMm: positive,
  thicknessMm: positive,
  holes: z.array(hole).min(2).max(64),
}).strict().superRefine((shape, context) => {
  for (let index = 0; index < shape.holes.length; index += 1) {
    const current = shape.holes[index]!;
    const radius = current.diameterMm / 2;
    if (current.xMm - radius < 0 || current.yMm - radius < 0
        || current.xMm + radius > shape.widthMm || current.yMm + radius > shape.heightMm) {
      context.addIssue({ code: "custom", path: ["holes", index], message: "Every measured hole must lie inside the specimen outline" });
    }
    if (shape.holes.slice(index + 1).some((other) => other.xMm === current.xMm && other.yMm === current.yMm)) {
      context.addIssue({ code: "custom", path: ["holes", index], message: "Hole centers must be unique" });
    }
    if (shape.holes.slice(index + 1).some((other) => Math.hypot(other.xMm - current.xMm, other.yMm - current.yMm) <= (other.diameterMm + current.diameterMm) / 2)) {
      context.addIssue({ code: "custom", path: ["holes", index], message: "Distinct circular test holes cannot overlap or touch" });
    }
  }
});
const fixture = z.object({
  testMethod: z.string().trim().min(1).max(200),
  loadAxis: z.enum(["x", "y"]),
  jointConfiguration: z.enum(["single-lap", "double-lap", "pin-bearing-fixture", "other"]),
  fastenerDiameterMm: positive,
  radialClearanceMm: z.number().finite().nonnegative(),
  clampCondition: z.string().trim().min(1).max(500),
}).strict();
const outcome = z.object({
  peakLoadN: positive,
  failureMode: z.enum(["bearing", "net-tension", "shear-out", "cleavage", "shared-ligament", "mixed", "other"]),
  evidenceIds: z.array(z.string().trim().min(1).max(240)).min(1).max(32),
}).strict();

const base = z.object({
  process: exactMaterialCouponProcessSchema,
  geometry,
  fixture,
  outcomes: z.array(outcome).min(1).max(100),
  evidence: z.array(evidenceSchema).min(1).max(320),
  specimenMeasurementEvidenceId: z.string().trim().min(1).max(240),
  testReportEvidenceId: z.string().trim().min(1).max(240),
  testedAt: z.iso.datetime(),
  notes: z.string().trim().min(1).max(4000).optional(),
  source: z.literal("physical-multi-hole-joint-test"),
  callerConfirmsPhysicalTests: z.literal(true),
}).strict().superRefine((input, context) => {
  const byId = new Map(input.evidence.map((item) => [item.id, item]));
  if (byId.size !== input.evidence.length) context.addIssue({ code: "custom", path: ["evidence"], message: "Evidence IDs must be unique" });
  for (const [field, id] of [["specimenMeasurementEvidenceId", input.specimenMeasurementEvidenceId], ["testReportEvidenceId", input.testReportEvidenceId]] as const) {
    const evidence = byId.get(id);
    if (!evidence || evidence.status !== "measured" || !evidence.sourceHash || !/^[a-f0-9]{64}$/.test(evidence.sourceHash) || !evidence.sourceLocator) {
      context.addIssue({ code: "custom", path: [field], message: "Specimen metrology and physical test report each need measured evidence with a SHA-256 hash and locator" });
    }
  }
  const usedOutcomeEvidence = new Set<string>();
  for (let index = 0; index < input.outcomes.length; index += 1) {
    const item = input.outcomes[index]!;
    if (new Set(item.evidenceIds).size !== item.evidenceIds.length) context.addIssue({ code: "custom", path: ["outcomes", index, "evidenceIds"], message: "Outcome evidence IDs must be unique" });
    for (const id of item.evidenceIds) {
      if (usedOutcomeEvidence.has(id)) context.addIssue({ code: "custom", path: ["outcomes", index, "evidenceIds"], message: "Each specimen outcome needs its own measured evidence" });
      usedOutcomeEvidence.add(id);
      const evidence = byId.get(id);
      if (!evidence) {
        context.addIssue({ code: "custom", path: ["outcomes", index, "evidenceIds"], message: "Outcome evidence ID is missing" });
      } else if (evidence.status !== "measured" || evidence.unit !== "N" || evidence.value !== item.peakLoadN
          || !evidence.sourceHash || !/^[a-f0-9]{64}$/.test(evidence.sourceHash) || !evidence.sourceLocator) {
        context.addIssue({ code: "custom", path: ["outcomes", index, "evidenceIds"], message: "Peak load needs matching measured N evidence with a SHA-256 hash and report locator" });
      }
    }
  }
});

export const fastenerGroupTestInputSchema = base;
export const fastenerGroupTestRecordSchema = base.extend({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(),
  recordStatus: z.literal("caller-attested-physical-multi-hole-joint-test"),
}).strict();
export const fastenerGroupTestQuerySchema = z.object({
  process: exactMaterialCouponProcessSchema,
  geometry,
  fixture,
}).strict();

export type FastenerGroupTestInput = z.infer<typeof fastenerGroupTestInputSchema>;
export type FastenerGroupTestRecord = z.infer<typeof fastenerGroupTestRecordSchema>;
export type FastenerGroupTestQuery = z.infer<typeof fastenerGroupTestQuerySchema>;
export type FastenerGroupTestMatch = {
  status: "no-match" | "matched" | "ambiguous";
  source: "immutable-local-physical-fastener-group-test-registry";
  records: FastenerGroupTestRecord[];
  selected: FastenerGroupTestRecord | null;
  reasons: string[];
};

export class FastenerGroupTestStore {
  private readonly root: string;
  constructor(root: string) { this.root = resolve(root); }

  async record(raw: FastenerGroupTestInput): Promise<{ record: FastenerGroupTestRecord; alreadyExisted: boolean }> {
    const input = normalizeInput(fastenerGroupTestInputSchema.parse(raw));
    const id = fastenerGroupTestHash(input);
    const record = fastenerGroupTestRecordSchema.parse({
      ...input, id, createdAt: new Date().toISOString(), recordStatus: "caller-attested-physical-multi-hole-joint-test",
    });
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      await writeFile(this.path(id), JSON.stringify(record, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      return { record: structuredClone(record), alreadyExisted: false };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      return { record: await this.read(id), alreadyExisted: true };
    }
  }

  async list(): Promise<FastenerGroupTestRecord[]> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.root, { withFileTypes: true });
    const records: FastenerGroupTestRecord[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name)) records.push(await this.read(entry.name.slice(0, -5)));
    }
    return records.sort((a, b) => a.testedAt.localeCompare(b.testedAt));
  }

  async match(raw: FastenerGroupTestQuery): Promise<FastenerGroupTestMatch> {
    const query = normalizeQuery(fastenerGroupTestQuerySchema.parse(raw));
    const key = configurationHash(query);
    const records = (await this.list()).filter((record) => configurationHash(record) === key);
    const source = "immutable-local-physical-fastener-group-test-registry" as const;
    if (records.length === 0) return {
      status: "no-match", source, records: [], selected: null,
      reasons: ["No physical test matches the exact print process, multi-hole geometry, fixture and load axis"],
    };
    const resultSets = new Set(records.map((record) => canonical(record.outcomes.map(({ peakLoadN, failureMode }) => ({ peakLoadN, failureMode })))));
    if (resultSets.size > 1) return {
      status: "ambiguous", source, records, selected: null,
      reasons: ["Conflicting physical test outcomes exist for the exact configuration; review the records explicitly"],
    };
    const selected = records.toSorted((a, b) => b.testedAt.localeCompare(a.testedAt))[0]!;
    return { status: "matched", source, records, selected, reasons: [] };
  }

  async read(id: string): Promise<FastenerGroupTestRecord> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid fastener-group test record ID");
    const handle = await open(this.path(id), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size <= 0 || stat.size > 1_000_000) throw new Error("Invalid fastener-group test record file");
      const record = fastenerGroupTestRecordSchema.parse(JSON.parse(await handle.readFile("utf8")));
      if (record.id !== id || fastenerGroupTestHash(stripRecord(record)) !== id) throw new Error("Fastener-group test record hash mismatch");
      return structuredClone(record);
    } finally {
      await handle.close();
    }
  }

  private path(id: string): string { return join(this.root, id + ".json"); }
}

export function fastenerGroupTestHash(input: FastenerGroupTestInput): string {
  return createHash("sha256").update(canonical(normalizeInput(fastenerGroupTestInputSchema.parse(input)))).digest("hex");
}

function configurationHash(input: FastenerGroupTestQuery | FastenerGroupTestRecord): string {
  const query = fastenerGroupTestQuerySchema.parse({ process: input.process, geometry: input.geometry, fixture: input.fixture });
  return createHash("sha256").update(canonical(normalizeQuery(query))).digest("hex");
}

function normalizeInput(input: FastenerGroupTestInput): FastenerGroupTestInput {
  return {
    ...input,
    geometry: { ...input.geometry, holes: sortHoles(input.geometry.holes) },
    outcomes: input.outcomes.map((item) => ({ ...item, evidenceIds: item.evidenceIds.toSorted() }))
      .toSorted((a, b) => a.peakLoadN - b.peakLoadN || a.failureMode.localeCompare(b.failureMode) || a.evidenceIds.join("\0").localeCompare(b.evidenceIds.join("\0"))),
    evidence: input.evidence.toSorted((a, b) => a.id.localeCompare(b.id)),
  };
}

function normalizeQuery(input: FastenerGroupTestQuery): FastenerGroupTestQuery {
  return { ...input, geometry: { ...input.geometry, holes: sortHoles(input.geometry.holes) } };
}

function sortHoles<T extends { xMm: number; yMm: number; diameterMm: number }>(holes: T[]): T[] {
  return holes.toSorted((a, b) => a.xMm - b.xMm || a.yMm - b.yMm || a.diameterMm - b.diameterMm);
}

function stripRecord(record: FastenerGroupTestRecord): FastenerGroupTestInput {
  const { id: _id, createdAt: _createdAt, recordStatus: _status, ...input } = record;
  return fastenerGroupTestInputSchema.parse(input);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ":" + canonical(item)).join(",") + "}";
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
