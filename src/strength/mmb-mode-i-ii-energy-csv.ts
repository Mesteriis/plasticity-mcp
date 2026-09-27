import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { z } from "zod";

import { calculateMmbModeIEnergy, mmbModeIEnergyInputSchema } from "./mmb-mode-i-ii-energy.ts";

const MAX_CSV_BYTES = 16 * 1024 * 1024;
const MAX_CSV_RECORDS = 250_000;

const specimenCsvSchema = z.object({
  specimenId: z.string().trim().min(1).max(240),
  widthMm: z.number().finite().positive(),
  totalLengthMm: z.number().finite().positive(),
  armThicknessMm: z.number().finite().positive(),
  halfSpanMm: z.number().finite().positive(),
  leverArmMm: z.number().finite().positive(),
  initialCrackLengthMm: z.number().finite().positive(),
  initiationCriterion: z.enum(["visual-crack-initiation", "first-nonlinearity", "five-percent-compliance-change", "maximum-force", "caller-defined"]),
  failureLocation: z.enum(["interface", "printed-material", "fixture", "unknown"]),
  selectedRecordNumber: z.number().int().min(2),
}).strict().superRefine((specimen, context) => {
  if (specimen.leverArmMm <= specimen.halfSpanMm / 3) {
    context.addIssue({ code: "custom", path: ["leverArmMm"], message: "MMB lever arm must exceed one-third of the MMB half span" });
  }
  if (specimen.initialCrackLengthMm >= specimen.totalLengthMm) {
    context.addIssue({ code: "custom", path: ["initialCrackLengthMm"], message: "Initial crack length must remain inside the specimen" });
  }
});

export const mmbModeIEnergyCsvInputSchema = z.object({
  materialProcess: mmbModeIEnergyInputSchema.shape.materialProcess,
  interfaceNormalGlobal: mmbModeIEnergyInputSchema.shape.interfaceNormalGlobal,
  interfaceShearDirectionGlobal: mmbModeIEnergyInputSchema.shape.interfaceShearDirectionGlobal,
  testProtocolHash: mmbModeIEnergyInputSchema.shape.testProtocolHash,
  testMethod: mmbModeIEnergyInputSchema.shape.testMethod,
  testedAt: mmbModeIEnergyInputSchema.shape.testedAt,
  axesMappingConfirmed: mmbModeIEnergyInputSchema.shape.axesMappingConfirmed,
  leverWeight: mmbModeIEnergyInputSchema.shape.leverWeight,
  flexuralModulus: mmbModeIEnergyInputSchema.shape.flexuralModulus,
  orthotropicModuli: mmbModeIEnergyInputSchema.shape.orthotropicModuli,
  path: z.string().trim().min(1).max(4096),
  specimenIdColumn: z.string().trim().min(1).max(200),
  forceColumn: z.string().trim().min(1).max(200),
  forceUnit: z.enum(["N", "kN", "kgf", "lbf"]),
  forceSign: z.enum(["positive", "negative"]),
  delimiter: z.enum(["comma", "semicolon", "tab"]),
  decimalSeparator: z.enum(["period", "comma"]),
  specimens: z.array(specimenCsvSchema).min(1).max(50),
}).strict().superRefine((input, context) => {
  if (new Set(input.specimens.map(({ specimenId }) => specimenId)).size !== input.specimens.length) {
    context.addIssue({ code: "custom", path: ["specimens"], message: "MMB specimen IDs must be unique" });
  }
  if (input.specimenIdColumn === input.forceColumn) {
    context.addIssue({ code: "custom", path: ["forceColumn"], message: "MMB specimen and force columns must be distinct" });
  }
  if (input.decimalSeparator === "comma" && input.delimiter === "comma") {
    context.addIssue({ code: "custom", path: ["decimalSeparator"], message: "Decimal comma requires semicolon or tab as the CSV delimiter" });
  }
  const rows = input.specimens.map(({ selectedRecordNumber }) => selectedRecordNumber);
  if (new Set(rows).size !== rows.length) {
    context.addIssue({ code: "custom", path: ["specimens"], message: "An MMB CSV initiation record may be selected only once" });
  }
});

export type MmbModeIEnergyCsvInput = z.input<typeof mmbModeIEnergyCsvInputSchema>;

export async function importMmbModeIEnergyCsv(rawInput: unknown) {
  const input = mmbModeIEnergyCsvInputSchema.parse(rawInput);
  const filePath = resolve(input.path);
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error("MMB initiation-energy CSV must be a regular non-symlink file");
    throw error;
  }
  let bytes: Buffer;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("MMB initiation-energy CSV must be a regular non-symlink file");
    if (metadata.size === 0 || metadata.size > MAX_CSV_BYTES) throw new Error(`MMB initiation-energy CSV must be nonempty and at most ${MAX_CSV_BYTES} bytes`);
    const bounded = Buffer.alloc(MAX_CSV_BYTES + 1);
    const { bytesRead } = await handle.read(bounded, 0, bounded.length, 0);
    bytes = bounded.subarray(0, bytesRead);
    if (bytes.length === 0 || bytes.length > MAX_CSV_BYTES) throw new Error(`MMB initiation-energy CSV must be nonempty and at most ${MAX_CSV_BYTES} bytes`);
  } finally {
    await handle.close();
  }

  const sourceText = bytes.toString("utf8");
  if (sourceText.includes("\u0000") || sourceText.includes("\uFFFD")) throw new Error("MMB initiation-energy CSV must be valid UTF-8 text");
  const delimiter = input.delimiter === "comma" ? "," : input.delimiter === "semicolon" ? ";" : "\t";
  const records = parseCsvRecords(sourceText.replace(/^\uFEFF/, ""), delimiter);
  const header = records[0]?.map((cell) => cell.trim());
  if (!header || header.length < 2) throw new Error("MMB initiation-energy CSV requires a header and selected specimen/force columns");
  if (header.some((cell) => cell.length === 0) || new Set(header).size !== header.length) throw new Error("MMB initiation-energy CSV column names must be nonempty and unique");
  const selectedIndexes = [input.specimenIdColumn, input.forceColumn].map((column) => header.indexOf(column));
  if (selectedIndexes.some((index) => index < 0)) throw new Error("Selected MMB specimen and force columns must exactly match CSV headers");
  if (records.length <= 1) throw new Error("MMB initiation-energy CSV has no measurement records");
  if (records.length - 1 > MAX_CSV_RECORDS) throw new Error(`MMB initiation-energy CSV exceeds ${MAX_CSV_RECORDS} measurement records`);

  const sourceHash = createHash("sha256").update(bytes).digest("hex");
  const fileName = basename(filePath);
  const selectedByRecord = new Map(input.specimens.map((specimen) => [specimen.selectedRecordNumber, specimen]));
  for (const csvRecordNumber of selectedByRecord.keys()) {
    if (csvRecordNumber > records.length) throw new Error(`Selected MMB CSV record ${csvRecordNumber} does not exist`);
  }
  const selectedForces = new Map<number, number>();
  const forceFactor = forceToNewtons(input.forceUnit);
  for (let index = 1; index < records.length; index += 1) {
    const csvRecordNumber = index + 1;
    const record = records[index]!;
    if (record.length !== header.length) throw new Error(`MMB initiation-energy CSV record ${csvRecordNumber} has ${record.length} fields; expected ${header.length}`);
    const specimen = selectedByRecord.get(csvRecordNumber);
    if (!specimen) continue;
    const observedSpecimenId = record[selectedIndexes[0]!]!.trim();
    if (observedSpecimenId !== specimen.specimenId) throw new Error(`Selected MMB CSV record ${csvRecordNumber} identifies specimen ${observedSpecimenId}, expected ${specimen.specimenId}`);
    const rawForce = parseDecimal(record[selectedIndexes[1]!]!, input.decimalSeparator, csvRecordNumber);
    if (rawForce === 0 || Math.sign(rawForce) !== (input.forceSign === "positive" ? 1 : -1)) {
      throw new Error(`MMB CSV force sign at record ${csvRecordNumber} does not match the selected test force sign`);
    }
    const forceN = Math.abs(rawForce) * forceFactor;
    if (!Number.isFinite(forceN) || forceN <= 0) throw new Error(`MMB CSV force at record ${csvRecordNumber} is outside the supported numeric range`);
    selectedForces.set(csvRecordNumber, forceN);
  }

  const recordInput = mmbModeIEnergyInputSchema.parse({
    materialProcess: input.materialProcess,
    interfaceNormalGlobal: input.interfaceNormalGlobal,
    interfaceShearDirectionGlobal: input.interfaceShearDirectionGlobal,
    testProtocolHash: input.testProtocolHash,
    testMethod: input.testMethod,
    testedAt: input.testedAt,
    axesMappingConfirmed: input.axesMappingConfirmed,
    leverWeight: input.leverWeight,
    flexuralModulus: input.flexuralModulus,
    orthotropicModuli: input.orthotropicModuli,
    specimens: input.specimens.map((specimen) => ({
      specimenId: specimen.specimenId,
      widthMm: specimen.widthMm,
      totalLengthMm: specimen.totalLengthMm,
      armThicknessMm: specimen.armThicknessMm,
      halfSpanMm: specimen.halfSpanMm,
      leverArmMm: specimen.leverArmMm,
      initialCrackLengthMm: specimen.initialCrackLengthMm,
      criticalForceN: selectedForces.get(specimen.selectedRecordNumber)!,
      initiationCriterion: specimen.initiationCriterion,
      failureLocation: specimen.failureLocation,
      sourceHash,
      sourceLocator: `${fileName}!record ${specimen.selectedRecordNumber}`,
    })),
  });
  return {
    calculation: calculateMmbModeIEnergy(recordInput),
    recordInput,
    sourceHash,
    sourceName: fileName,
    sourceColumns: {
      specimenId: input.specimenIdColumn,
      force: input.forceColumn,
      forceUnit: input.forceUnit,
      forceSign: input.forceSign,
      delimiter: input.delimiter,
      decimalSeparator: input.decimalSeparator,
    },
    selectedCsvRecordNumbers: [...selectedByRecord.keys()].sort((left, right) => left - right),
    interpretation: "caller-selected-mmb-initiation-record-preview-only" as const,
    limitations: [
      "The caller selects the physical initiation record and classification for every specimen. The importer does not identify crack initiation, detect a compliance change, or find a peak force.",
      "Force is unit-converted only; crack length, geometry, initiation criterion, failure location, moduli, axes, fixture validity, and process matching remain caller-supplied physical evidence.",
      "The preview hashes the raw CSV and returns exact record locators but does not register a physical test. Review the selected records and observations before recording any result.",
      "The derived MMB energy partition is exploratory printed-PLA beam theory, not ASTM D6671 conformity, a traction-separation curve, cohesive law, design allowable, or material qualification.",
    ],
  };
}

function forceToNewtons(unit: "N" | "kN" | "kgf" | "lbf"): number {
  switch (unit) {
    case "N": return 1;
    case "kN": return 1000;
    case "kgf": return 9.80665;
    case "lbf": return 4.4482216152605;
  }
}

function parseDecimal(value: string, separator: "period" | "comma", recordNumber: number): number {
  const trimmed = value.trim();
  const normalized = separator === "comma" ? trimmed.replace(",", ".") : trimmed;
  if (!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(normalized)) throw new Error(`MMB initiation-energy CSV force at record ${recordNumber} is not a valid decimal number`);
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) throw new Error(`MMB initiation-energy CSV force at record ${recordNumber} is not finite`);
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
        if (text[index + 1] === "\"") { field += "\""; index += 1; }
        else { quoted = false; afterQuote = true; }
      } else field += character;
      continue;
    }
    if (afterQuote && character !== delimiter && character !== "\n" && character !== "\r") throw new Error("MMB initiation-energy CSV has unexpected content after a quoted field");
    if (character === "\"") {
      if (field.length > 0) throw new Error("MMB initiation-energy CSV has a quote inside an unquoted field");
      quoted = true;
      afterQuote = false;
    } else if (character === delimiter) {
      record.push(field); field = ""; afterQuote = false;
    } else if (character === "\n" || character === "\r") {
      record.push(field); field = "";
      if (record.some((cell) => cell.length > 0)) {
        records.push(record);
        if (records.length > MAX_CSV_RECORDS + 1) throw new Error(`MMB initiation-energy CSV exceeds ${MAX_CSV_RECORDS} measurement records`);
      }
      record = []; afterQuote = false;
      if (character === "\r" && text[index + 1] === "\n") index += 1;
    } else field += character;
  }
  if (quoted) throw new Error("MMB initiation-energy CSV contains an unterminated quoted field");
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    if (record.some((cell) => cell.length > 0)) records.push(record);
  }
  return records;
}
