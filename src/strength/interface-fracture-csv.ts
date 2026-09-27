import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { z } from "zod";

import { analyzeMaterialInterfaceTestCurve, analyzeMixedModeMaterialInterfaceTestCurve } from "./interface-test.ts";

const MAX_CSV_BYTES = 16 * 1024 * 1024;
const MAX_CSV_RECORDS = 250_000;
const shared = {
  path: z.string().trim().min(1).max(4096),
  processingAttestation: z.literal("already-compliance-corrected-traction-separation"),
  specimenIdColumn: z.string().trim().min(1).max(200),
  separationUnit: z.enum(["mm", "um"]),
  tractionUnit: z.enum(["MPa", "kPa"]),
  delimiter: z.enum(["comma", "semicolon", "tab"]),
  decimalSeparator: z.enum(["period", "comma"]),
};

export const interfaceFractureCsvInputSchema = z.discriminatedUnion("fractureMethod", [
  z.object({
    ...shared,
    fractureMethod: z.enum(["dcb-mode-i", "enf-mode-ii"]),
    separationColumn: z.string().trim().min(1).max(200),
    tractionColumn: z.string().trim().min(1).max(200),
  }).strict(),
  z.object({
    ...shared,
    fractureMethod: z.literal("mmb-mixed-mode"),
    normalSeparationColumn: z.string().trim().min(1).max(200),
    tangentialSeparationColumn: z.string().trim().min(1).max(200),
    normalTractionColumn: z.string().trim().min(1).max(200),
    tangentialTractionColumn: z.string().trim().min(1).max(200),
  }).strict(),
]).superRefine((input, context) => {
  const columns = input.fractureMethod === "mmb-mixed-mode"
    ? [input.specimenIdColumn, input.normalSeparationColumn, input.tangentialSeparationColumn, input.normalTractionColumn, input.tangentialTractionColumn]
    : [input.specimenIdColumn, input.separationColumn, input.tractionColumn];
  if (new Set(columns).size !== columns.length) {
    context.addIssue({ code: "custom", path: ["specimenIdColumn"], message: "Specimen and measurement columns must be distinct" });
  }
  if (input.decimalSeparator === "comma" && input.delimiter === "comma") {
    context.addIssue({ code: "custom", path: ["decimalSeparator"], message: "Decimal comma requires semicolon or tab as the CSV delimiter" });
  }
});

export type InterfaceFractureCsvInput = z.input<typeof interfaceFractureCsvInputSchema>;

export async function importInterfaceFractureCsv(rawInput: unknown) {
  const input = interfaceFractureCsvInputSchema.parse(rawInput);
  const filePath = resolve(input.path);
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error("Interface fracture CSV must be a regular non-symlink file");
    }
    throw error;
  }

  let bytes: Buffer;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("Interface fracture CSV must be a regular non-symlink file");
    if (metadata.size === 0 || metadata.size > MAX_CSV_BYTES) {
      throw new Error(`Interface fracture CSV must be nonempty and at most ${MAX_CSV_BYTES} bytes`);
    }
    const boundedRead = Buffer.alloc(MAX_CSV_BYTES + 1);
    const { bytesRead } = await handle.read(boundedRead, 0, boundedRead.length, 0);
    bytes = boundedRead.subarray(0, bytesRead);
    if (bytes.length === 0 || bytes.length > MAX_CSV_BYTES) {
      throw new Error(`Interface fracture CSV must be nonempty and at most ${MAX_CSV_BYTES} bytes`);
    }
  } finally {
    await handle.close();
  }

  const text = bytes.toString("utf8");
  if (text.includes("\u0000") || text.includes("\uFFFD")) throw new Error("Interface fracture CSV must be valid UTF-8 text");
  const delimiter = input.delimiter === "comma" ? "," : input.delimiter === "semicolon" ? ";" : "\t";
  const records = parseCsvRecords(text.replace(/^\uFEFF/, ""), delimiter);
  const header = records.shift();
  if (!header || header.length < 3) throw new Error("Interface fracture CSV requires a header row and measurement columns");
  const normalizedHeader = header.map((cell) => cell.trim());
  if (normalizedHeader.some((cell) => cell.length === 0) || new Set(normalizedHeader).size !== normalizedHeader.length) {
    throw new Error("Interface fracture CSV column names must be nonempty and unique");
  }
  const selectedNames = input.fractureMethod === "mmb-mixed-mode"
    ? [input.specimenIdColumn, input.normalSeparationColumn, input.tangentialSeparationColumn, input.normalTractionColumn, input.tangentialTractionColumn]
    : [input.specimenIdColumn, input.separationColumn, input.tractionColumn];
  const selectedIndexes = selectedNames.map((name) => normalizedHeader.indexOf(name));
  if (selectedIndexes.some((index) => index < 0)) throw new Error("Selected specimen and measurement columns must exactly match CSV headers");
  if (records.length === 0) throw new Error("Interface fracture CSV has no measurement records");
  if (records.length > MAX_CSV_RECORDS) throw new Error(`Interface fracture CSV exceeds ${MAX_CSV_RECORDS} measurement records`);

  const sourceHash = createHash("sha256").update(bytes).digest("hex");
  const specimens = new Map<string, { records: number[]; points: number[][] }>();
  let totalPoints = 0;
  const separationFactor = input.separationUnit === "um" ? 0.001 : 1;
  const tractionFactor = input.tractionUnit === "kPa" ? 0.001 : 1;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const recordNumber = index + 2;
    if (record.every((cell) => cell.trim() === "")) continue;
    if (record.length !== normalizedHeader.length) throw new Error(`Interface fracture CSV record ${recordNumber} has ${record.length} fields; expected ${normalizedHeader.length}`);
    const specimenId = record[selectedIndexes[0]!]!.trim();
    if (!specimenId) throw new Error(`Interface fracture CSV record ${recordNumber} has an empty specimen ID`);
    let specimen = specimens.get(specimenId);
    if (!specimen) {
      if (specimens.size >= 100) throw new Error("Interface fracture CSV exceeds 100 distinct specimens");
      specimen = { records: [], points: [] };
      specimens.set(specimenId, specimen);
    }
    specimen.records.push(recordNumber);
    const point = selectedIndexes.slice(1).map((columnIndex, valueIndex) => {
      const parsed = parseDecimal(record[columnIndex]!, input.decimalSeparator, recordNumber);
      if (parsed < 0) throw new Error(`Interface fracture CSV measurements must be nonnegative at record ${recordNumber}`);
      return parsed * ((input.fractureMethod === "mmb-mixed-mode" && valueIndex >= 2) || (input.fractureMethod !== "mmb-mixed-mode" && valueIndex === 1)
        ? tractionFactor : separationFactor);
    });
    if (point.some((value) => !Number.isFinite(value))) throw new Error(`Interface fracture CSV converted value at record ${recordNumber} is outside the supported numeric range`);
    specimen.points.push(point);
    totalPoints += 1;
    if (specimen.points.length > 10_000) throw new Error(`Interface fracture CSV specimen ${specimenId} exceeds 10000 measured points`);
    if (totalPoints > 50_000) throw new Error("Interface fracture CSV exceeds 50000 total measured points");
  }
  if (specimens.size === 0) throw new Error("Interface fracture CSV has no nonempty measurement records");

  const preview = [...specimens.entries()].map(([specimenId, specimen]) => {
    const sourceLocator = `${basename(filePath)}!records ${compressRecordNumbers(specimen.records)}`;
    if (input.fractureMethod === "mmb-mixed-mode") {
      const curve = {
        sourceHash,
        sourceLocator,
        points: specimen.points.map(([normalSeparationMm, tangentialSeparationMm, normalTractionMPa, tangentialTractionMPa]) => ({
          normalSeparationMm: normalSeparationMm!,
          tangentialSeparationMm: tangentialSeparationMm!,
          normalTractionMPa: normalTractionMPa!,
          tangentialTractionMPa: tangentialTractionMPa!,
        })),
      };
      const measuredPeakStrengthMPa = curve.points.reduce((maximum, point) => Math.max(maximum, Math.hypot(point.normalTractionMPa, point.tangentialTractionMPa)), 0);
      const analysis = analyzeMixedModeMaterialInterfaceTestCurve({ testMode: "mixed-mode", failureLocation: "interface", measuredPeakStrengthMPa, mixedModeTractionSeparationCurve: curve });
      return { specimenId, measuredPeakStrengthMPa, sourceLocator, mixedModeTractionSeparationCurve: curve, analysis };
    }
    const curve = {
      sourceHash,
      sourceLocator,
      points: specimen.points.map(([separationMm, tractionMPa]) => ({ separationMm: separationMm!, tractionMPa: tractionMPa! })),
    };
    const measuredPeakStrengthMPa = curve.points.reduce((maximum, point) => Math.max(maximum, point.tractionMPa), 0);
    const testMode = input.fractureMethod === "dcb-mode-i" ? "normal-tension" : "interface-shear";
    const analysis = analyzeMaterialInterfaceTestCurve({ testMode, failureLocation: "interface", measuredPeakStrengthMPa, tractionSeparationCurve: curve });
    return { specimenId, measuredPeakStrengthMPa, sourceLocator, tractionSeparationCurve: curve, analysis };
  });

  return {
    fractureMethod: input.fractureMethod,
    specimens: preview,
    sourceHash,
    sourceName: basename(filePath),
    processingAttestation: input.processingAttestation,
    interpretation: "processed-physical-fracture-curve-preview-only" as const,
    limitations: [
      "The caller attests that input columns are physical traction-separation data already compliance-corrected using a documented method; raw force-displacement data are not converted here.",
      "This import is a read-only preview and does not register a physical test; the caller must verify specimen, fixture, process, failure plane, units and corrections before recording it.",
      "Curve integration and peak summaries describe supplied samples only; they are not a qualified cohesive law, design allowable or print approval.",
    ],
  };
}

function compressRecordNumbers(records: number[]): string {
  const ranges: string[] = [];
  let start = records[0]!;
  let previous = start;
  for (const record of records.slice(1)) {
    if (record === previous + 1) {
      previous = record;
      continue;
    }
    ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
    start = record;
    previous = record;
  }
  ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
  return ranges.join(",");
}

function parseDecimal(value: string, separator: "period" | "comma", recordNumber: number): number {
  const trimmed = value.trim();
  const normalized = separator === "comma" ? trimmed.replace(",", ".") : trimmed;
  if (!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(normalized)) {
    throw new Error(`Interface fracture CSV measurement at record ${recordNumber} is not a valid decimal number`);
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) throw new Error(`Interface fracture CSV measurement at record ${recordNumber} is not finite`);
  return parsed;
}

function parseCsvRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let afterQuote = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character === "\"") {
        if (text[index + 1] === "\"") {
          field += "\"";
          index += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else field += character;
      continue;
    }
    if (afterQuote && character !== delimiter && character !== "\n" && character !== "\r") {
      throw new Error("Interface fracture CSV has unexpected content after a quoted field");
    }
    if (character === "\"") {
      if (field.length > 0) throw new Error("Interface fracture CSV has a quote inside an unquoted field");
      quoted = true;
      afterQuote = false;
    } else if (character === delimiter) {
      record.push(field);
      field = "";
      afterQuote = false;
    } else if (character === "\n" || character === "\r") {
      record.push(field);
      field = "";
      if (record.some((cell) => cell.length > 0)) {
        records.push(record);
        if (records.length > MAX_CSV_RECORDS + 1) throw new Error(`Interface fracture CSV exceeds ${MAX_CSV_RECORDS} measurement records`);
      }
      record = [];
      afterQuote = false;
      if (character === "\r" && text[index + 1] === "\n") index += 1;
    } else field += character;
  }
  if (quoted) throw new Error("Interface fracture CSV contains an unterminated quoted field");
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    if (record.some((cell) => cell.length > 0)) records.push(record);
  }
  return records;
}
