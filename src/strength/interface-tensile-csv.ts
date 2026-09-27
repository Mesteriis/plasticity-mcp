import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { z } from "zod";

import { calculateInterfaceSpecimenStrengths } from "./interface-test.ts";

const MAX_INTERFACE_TEST_CSV_BYTES = 16 * 1024 * 1024;
const MAX_INTERFACE_TEST_CSV_RECORDS = 250_000;

export const interfaceTensileCsvInputSchema = z.object({
  path: z.string().trim().min(1).max(4096),
  specimenIdColumn: z.string().trim().min(1).max(200),
  forceColumn: z.string().trim().min(1).max(200),
  forceUnit: z.enum(["N", "kN", "kgf", "lbf"]),
  forceSign: z.enum(["positive", "negative"]),
  delimiter: z.enum(["comma", "semicolon", "tab"]),
  decimalSeparator: z.enum(["period", "comma"]),
  specimens: z.array(z.object({
    specimenId: z.string().trim().min(1).max(240),
    netCrossSectionMm2: z.number().finite().positive(),
    failureLocation: z.enum(["interface", "printed-material", "fixture", "unknown"]),
  }).strict()).min(1).max(1000),
}).strict().superRefine((input, context) => {
  if (input.specimenIdColumn === input.forceColumn) {
    context.addIssue({ code: "custom", path: ["forceColumn"], message: "Specimen ID and force columns must be different" });
  }
  if (new Set(input.specimens.map(({ specimenId }) => specimenId)).size !== input.specimens.length) {
    context.addIssue({ code: "custom", path: ["specimens"], message: "Specimen IDs must be unique" });
  }
  if (input.decimalSeparator === "comma" && input.delimiter === "comma") {
    context.addIssue({ code: "custom", path: ["decimalSeparator"], message: "Decimal comma requires semicolon or tab as the CSV delimiter" });
  }
});

export type InterfaceTensileCsvInput = z.input<typeof interfaceTensileCsvInputSchema>;

export async function importInterfaceTensileCsv(rawInput: unknown) {
  const input = interfaceTensileCsvInputSchema.parse(rawInput);
  const filePath = resolve(input.path);
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error("Interface tensile CSV must be a regular non-symlink file");
    }
    throw error;
  }

  let bytes: Buffer;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("Interface tensile CSV must be a regular non-symlink file");
    if (metadata.size === 0 || metadata.size > MAX_INTERFACE_TEST_CSV_BYTES) {
      throw new Error(`Interface tensile CSV must be nonempty and at most ${MAX_INTERFACE_TEST_CSV_BYTES} bytes`);
    }
    const boundedRead = Buffer.alloc(MAX_INTERFACE_TEST_CSV_BYTES + 1);
    const { bytesRead } = await handle.read(boundedRead, 0, boundedRead.length, 0);
    bytes = boundedRead.subarray(0, bytesRead);
    if (bytes.length === 0 || bytes.length > MAX_INTERFACE_TEST_CSV_BYTES) {
      throw new Error(`Interface tensile CSV must be nonempty and at most ${MAX_INTERFACE_TEST_CSV_BYTES} bytes`);
    }
  } finally {
    await handle.close();
  }

  const text = bytes.toString("utf8");
  if (text.includes("\u0000") || text.includes("\uFFFD")) throw new Error("Interface tensile CSV must be valid UTF-8 text");
  const delimiter = input.delimiter === "comma" ? "," : input.delimiter === "semicolon" ? ";" : "\t";
  const records = parseCsvRecords(text.replace(/^\uFEFF/, ""), delimiter);
  const header = records.shift();
  if (!header || header.length < 2) throw new Error("Interface tensile CSV requires a header row and at least two columns");
  const normalizedHeader = header.map((cell) => cell.trim());
  if (normalizedHeader.some((cell) => cell.length === 0) || new Set(normalizedHeader).size !== normalizedHeader.length) {
    throw new Error("Interface tensile CSV column names must be nonempty and unique");
  }
  const specimenIdIndex = normalizedHeader.indexOf(input.specimenIdColumn);
  const forceIndex = normalizedHeader.indexOf(input.forceColumn);
  if (specimenIdIndex < 0 || forceIndex < 0) throw new Error("Selected specimen ID and force columns must exactly match CSV headers");
  if (records.length === 0) throw new Error("Interface tensile CSV has no measurement records");
  if (records.length > MAX_INTERFACE_TEST_CSV_RECORDS) throw new Error(`Interface tensile CSV exceeds ${MAX_INTERFACE_TEST_CSV_RECORDS} measurement records`);

  const bySpecimen = new Map(input.specimens.map((specimen) => [specimen.specimenId, {
    ...specimen,
    firstRecord: Number.POSITIVE_INFINITY,
    lastRecord: 0,
    peakForceN: 0,
    peakRecord: 0,
  }]));
  const factor = forceFactor(input.forceUnit);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const recordNumber = index + 2;
    if (record.every((cell) => cell.trim() === "")) continue;
    if (record.length !== normalizedHeader.length) throw new Error(`Interface tensile CSV record ${recordNumber} has ${record.length} fields; expected ${normalizedHeader.length}`);
    const specimenId = record[specimenIdIndex]!.trim();
    if (!specimenId) throw new Error(`Interface tensile CSV record ${recordNumber} has an empty specimen ID`);
    const specimen = bySpecimen.get(specimenId);
    if (!specimen) throw new Error(`Interface tensile CSV contains an unexpected specimen ID at record ${recordNumber}: ${specimenId}`);
    const rawForce = parseDecimal(record[forceIndex]!, input.decimalSeparator, recordNumber);
    if (rawForce !== 0 && Math.sign(rawForce) !== (input.forceSign === "positive" ? 1 : -1)) {
      throw new Error(`Interface tensile CSV force sign at record ${recordNumber} does not match the selected tensile sign`);
    }
    const forceN = Math.abs(rawForce) * factor;
    if (!Number.isFinite(forceN)) throw new Error(`Interface tensile CSV force at record ${recordNumber} is outside the supported numeric range`);
    specimen.firstRecord = Math.min(specimen.firstRecord, recordNumber);
    specimen.lastRecord = recordNumber;
    if (forceN > specimen.peakForceN) {
      specimen.peakForceN = forceN;
      specimen.peakRecord = recordNumber;
    }
  }

  const specimens = [...bySpecimen.values()];
  const missing = specimens.filter(({ peakRecord }) => peakRecord === 0);
  if (missing.length > 0) throw new Error(`Interface tensile CSV has no force measurements for specimen ID(s): ${missing.map(({ specimenId }) => specimenId).join(", ")}`);
  const sourceHash = createHash("sha256").update(bytes).digest("hex");
  const calculation = calculateInterfaceSpecimenStrengths({
    specimens: specimens.map(({ specimenId, netCrossSectionMm2, failureLocation, peakForceN, firstRecord, lastRecord, peakRecord }) => ({
      specimenId,
      peakForceN,
      netCrossSectionMm2,
      failureLocation: failureLocation === "printed-material" ? "material-a" : failureLocation,
      sourceHash,
      sourceLocator: `${basename(filePath)}!records ${firstRecord}-${lastRecord}; peak record ${peakRecord}`,
    })),
  });
  return {
    ...calculation,
    specimens: calculation.specimens.map((specimen) => ({
      ...specimen,
      failureLocation: specimen.failureLocation === "material-a" || specimen.failureLocation === "material-b"
        ? "printed-material" as const
        : specimen.failureLocation,
    })),
    sourceHash,
    sourceName: basename(filePath),
    forceUnitInSource: input.forceUnit,
    forceSignInSource: input.forceSign,
    interpretation: "nominal-interface-coupon-strength-screen-only" as const,
    limitations: [
      "The peak is the maximum sampled force for each specimen; the importer does not apply machine compliance correction, filtering, or standards-based processing.",
      "Nominal force divided by the caller-provided measured net area is a coupon stress, not local interface traction, a design allowable, or a cohesive law.",
      "Failure location and specimen areas are caller-supplied physical observations and are not inferred from CSV data.",
      "This CSV peak importer is for direct tensile coupon screening only; it does not derive DCB/ENF/MMB traction-separation curves or fracture energy.",
    ],
  };
}

function parseDecimal(value: string, separator: "period" | "comma", recordNumber: number): number {
  const trimmed = value.trim();
  const normalized = separator === "comma" ? trimmed.replace(",", ".") : trimmed;
  if (!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(normalized)) {
    throw new Error(`Interface tensile CSV force at record ${recordNumber} is not a valid decimal number`);
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) throw new Error(`Interface tensile CSV force at record ${recordNumber} is not finite`);
  return parsed;
}

function forceFactor(unit: "N" | "kN" | "kgf" | "lbf"): number {
  switch (unit) {
    case "N": return 1;
    case "kN": return 1000;
    case "kgf": return 9.80665;
    case "lbf": return 4.4482216152605;
  }
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
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (afterQuote && character !== delimiter && character !== "\n" && character !== "\r") {
      throw new Error("Interface tensile CSV has unexpected content after a quoted field");
    }
    if (character === '"') {
      if (field.length > 0) throw new Error("Interface tensile CSV has a quote inside an unquoted field");
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
        if (records.length > MAX_INTERFACE_TEST_CSV_RECORDS + 1) {
          throw new Error(`Interface tensile CSV exceeds ${MAX_INTERFACE_TEST_CSV_RECORDS} measurement records`);
        }
      }
      record = [];
      afterQuote = false;
      if (character === "\r" && text[index + 1] === "\n") index += 1;
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("Interface tensile CSV contains an unterminated quoted field");
  record.push(field);
  if (record.some((cell) => cell.length > 0)) {
    records.push(record);
    if (records.length > MAX_INTERFACE_TEST_CSV_RECORDS + 1) {
      throw new Error(`Interface tensile CSV exceeds ${MAX_INTERFACE_TEST_CSV_RECORDS} measurement records`);
    }
  }
  return records;
}
