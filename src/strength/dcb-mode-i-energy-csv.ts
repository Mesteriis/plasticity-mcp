import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { z } from "zod";

import { dcbModeIEnergyInputSchema, calculateDcbModeIEnergy } from "./dcb-mode-i-energy.ts";

const MAX_CSV_BYTES = 16 * 1024 * 1024;
const MAX_CSV_RECORDS = 250_000;

const specimenSchema = z.object({
  specimenId: z.string().trim().min(1).max(240),
  widthMm: z.number().finite().positive(),
  totalLengthMm: z.number().finite().positive(),
  armThicknessMm: z.number().finite().positive(),
  failureLocation: z.enum(["interface", "printed-material", "fixture", "unknown"]),
  crackObservations: z.array(z.object({
    csvRecordNumber: z.number().int().min(2),
    crackLengthMm: z.number().finite().positive(),
  }).strict()).min(3).max(500),
}).strict().superRefine((specimen, context) => {
  for (let index = 1; index < specimen.crackObservations.length; index += 1) {
    if (specimen.crackObservations[index]!.crackLengthMm <= specimen.crackObservations[index - 1]!.crackLengthMm) {
      context.addIssue({ code: "custom", path: ["crackObservations", index, "crackLengthMm"], message: "Selected DCB crack observations must be strictly increasing" });
    }
  }
  if (new Set(specimen.crackObservations.map(({ csvRecordNumber }) => csvRecordNumber)).size !== specimen.crackObservations.length) {
    context.addIssue({ code: "custom", path: ["crackObservations"], message: "A DCB CSV record may be selected only once per specimen" });
  }
});

export const dcbModeIEnergyCsvInputSchema = z.object({
  path: z.string().trim().min(1).max(4096),
  specimenIdColumn: z.string().trim().min(1).max(200),
  forceColumn: z.string().trim().min(1).max(200),
  forceUnit: z.enum(["N", "kN", "kgf", "lbf"]),
  forceSign: z.enum(["positive", "negative"]),
  displacementColumn: z.string().trim().min(1).max(200),
  displacementUnit: z.enum(["mm", "um"]),
  displacementSign: z.enum(["positive", "negative"]),
  delimiter: z.enum(["comma", "semicolon", "tab"]),
  decimalSeparator: z.enum(["period", "comma"]),
  materialProcess: dcbModeIEnergyInputSchema.shape.materialProcess,
  interfaceNormalGlobal: dcbModeIEnergyInputSchema.shape.interfaceNormalGlobal,
  testProtocolHash: dcbModeIEnergyInputSchema.shape.testProtocolHash,
  testMethod: dcbModeIEnergyInputSchema.shape.testMethod,
  testedAt: dcbModeIEnergyInputSchema.shape.testedAt,
  displacementEvidence: dcbModeIEnergyInputSchema.shape.displacementEvidence,
  linearElasticQuasiStaticEvidence: dcbModeIEnergyInputSchema.shape.linearElasticQuasiStaticEvidence,
  specimens: z.array(specimenSchema).min(1).max(50),
}).strict().superRefine((input, context) => {
  if (new Set(input.specimens.map(({ specimenId }) => specimenId)).size !== input.specimens.length) {
    context.addIssue({ code: "custom", path: ["specimens"], message: "DCB specimen IDs must be unique" });
  }
  const recordNumbers = input.specimens.flatMap((specimen) => specimen.crackObservations.map(({ csvRecordNumber }) => csvRecordNumber));
  if (new Set(recordNumbers).size !== recordNumbers.length) {
    context.addIssue({ code: "custom", path: ["specimens"], message: "A DCB CSV record may be selected only once across the test" });
  }
  const columns = [input.specimenIdColumn, input.forceColumn, input.displacementColumn];
  if (new Set(columns).size !== columns.length) {
    context.addIssue({ code: "custom", path: ["specimenIdColumn"], message: "Specimen, force and displacement columns must be distinct" });
  }
  if (input.decimalSeparator === "comma" && input.delimiter === "comma") {
    context.addIssue({ code: "custom", path: ["decimalSeparator"], message: "Decimal comma requires semicolon or tab as the CSV delimiter" });
  }
});

export type DcbModeIEnergyCsvInput = z.input<typeof dcbModeIEnergyCsvInputSchema>;

export async function importDcbModeIEnergyCsv(rawInput: unknown) {
  const input = dcbModeIEnergyCsvInputSchema.parse(rawInput);
  const filePath = resolve(input.path);
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error("DCB Mode-I energy CSV must be a regular non-symlink file");
    throw error;
  }

  let bytes: Buffer;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("DCB Mode-I energy CSV must be a regular non-symlink file");
    if (metadata.size === 0 || metadata.size > MAX_CSV_BYTES) {
      throw new Error(`DCB Mode-I energy CSV must be nonempty and at most ${MAX_CSV_BYTES} bytes`);
    }
    const boundedRead = Buffer.alloc(MAX_CSV_BYTES + 1);
    const { bytesRead } = await handle.read(boundedRead, 0, boundedRead.length, 0);
    bytes = boundedRead.subarray(0, bytesRead);
    if (bytes.length === 0 || bytes.length > MAX_CSV_BYTES) {
      throw new Error(`DCB Mode-I energy CSV must be nonempty and at most ${MAX_CSV_BYTES} bytes`);
    }
  } finally {
    await handle.close();
  }

  const text = bytes.toString("utf8");
  if (text.includes("\u0000") || text.includes("\uFFFD")) throw new Error("DCB Mode-I energy CSV must be valid UTF-8 text");
  const delimiter = input.delimiter === "comma" ? "," : input.delimiter === "semicolon" ? ";" : "\t";
  const records = parseCsvRecords(text.replace(/^\uFEFF/, ""), delimiter);
  const header = records[0];
  if (!header || header.length < 3) throw new Error("DCB Mode-I energy CSV requires a header and selected measurement columns");
  const normalizedHeader = header.map((cell) => cell.trim());
  if (normalizedHeader.some((cell) => cell.length === 0) || new Set(normalizedHeader).size !== normalizedHeader.length) {
    throw new Error("DCB Mode-I energy CSV column names must be nonempty and unique");
  }
  const selectedColumns = [input.specimenIdColumn, input.forceColumn, input.displacementColumn];
  const selectedIndexes = selectedColumns.map((column) => normalizedHeader.indexOf(column));
  if (selectedIndexes.some((index) => index < 0)) throw new Error("Selected DCB specimen, force and displacement columns must exactly match CSV headers");
  if (records.length <= 1) throw new Error("DCB Mode-I energy CSV has no measurement records");
  if (records.length - 1 > MAX_CSV_RECORDS) throw new Error(`DCB Mode-I energy CSV exceeds ${MAX_CSV_RECORDS} measurement records`);

  const sourceHash = createHash("sha256").update(bytes).digest("hex");
  const selectedRows = new Map<number, { specimenId: string; crackLengthMm: number }>();
  for (const specimen of input.specimens) {
    for (const observation of specimen.crackObservations) {
      selectedRows.set(observation.csvRecordNumber, { specimenId: specimen.specimenId, crackLengthMm: observation.crackLengthMm });
    }
  }
  const measurements = new Map<number, { specimenId: string; forceN: number; displacementMm: number }>();
  for (const recordNumber of selectedRows.keys()) {
    if (recordNumber > records.length) throw new Error(`Selected DCB CSV record ${recordNumber} does not exist`);
  }

  const forceFactor = forceToNewtons(input.forceUnit);
  const displacementFactor = input.displacementUnit === "um" ? 0.001 : 1;
  for (let index = 1; index < records.length; index += 1) {
    const recordNumber = index + 1;
    const record = records[index]!;
    if (record.length !== normalizedHeader.length) {
      throw new Error(`DCB Mode-I energy CSV record ${recordNumber} has ${record.length} fields; expected ${normalizedHeader.length}`);
    }
    const selected = selectedRows.get(recordNumber);
    if (!selected) continue;
    const specimenId = record[selectedIndexes[0]!]!.trim();
    if (specimenId !== selected.specimenId) {
      throw new Error(`Selected DCB CSV record ${recordNumber} identifies specimen ${specimenId}, expected ${selected.specimenId}`);
    }
    const rawForce = parseDecimal(record[selectedIndexes[1]!]!, input.decimalSeparator, recordNumber, "force");
    if (rawForce === 0 || Math.sign(rawForce) !== (input.forceSign === "positive" ? 1 : -1)) {
      throw new Error(`DCB CSV force sign at record ${recordNumber} does not match the selected tensile sign`);
    }
    const rawDisplacement = parseDecimal(record[selectedIndexes[2]!]!, input.decimalSeparator, recordNumber, "displacement");
    if (rawDisplacement === 0 || Math.sign(rawDisplacement) !== (input.displacementSign === "positive" ? 1 : -1)) {
      throw new Error(`DCB CSV displacement sign at record ${recordNumber} does not match the selected opening sign`);
    }
    const forceN = Math.abs(rawForce) * forceFactor;
    const displacementMm = Math.abs(rawDisplacement) * displacementFactor;
    if (!Number.isFinite(forceN) || !Number.isFinite(displacementMm) || forceN <= 0 || displacementMm <= 0) {
      throw new Error(`DCB CSV converted measurement at record ${recordNumber} is outside the supported numeric range`);
    }
    measurements.set(recordNumber, { specimenId, forceN, displacementMm });
  }

  const specimens = input.specimens.map((specimen) => ({
    specimenId: specimen.specimenId,
    widthMm: specimen.widthMm,
    totalLengthMm: specimen.totalLengthMm,
    armThicknessMm: specimen.armThicknessMm,
    failureLocation: specimen.failureLocation,
    sourceHash,
    points: specimen.crackObservations.map((observation) => {
      const measurement = measurements.get(observation.csvRecordNumber);
      if (!measurement) throw new Error(`Selected DCB CSV record ${observation.csvRecordNumber} does not exist`);
      return {
        crackLengthMm: observation.crackLengthMm,
        forceN: measurement.forceN,
        loadPointDisplacementMm: measurement.displacementMm,
        sourceLocator: `${basename(filePath)}!record ${observation.csvRecordNumber}`,
      };
    }),
  }));
  const recordInput = dcbModeIEnergyInputSchema.parse({
    materialProcess: input.materialProcess,
    interfaceNormalGlobal: input.interfaceNormalGlobal,
    testProtocolHash: input.testProtocolHash,
    testMethod: input.testMethod,
    testedAt: input.testedAt,
    displacementEvidence: input.displacementEvidence,
    linearElasticQuasiStaticEvidence: input.linearElasticQuasiStaticEvidence,
    specimens,
  });
  const calculation = calculateDcbModeIEnergy(recordInput);
  return {
    calculation,
    recordInput,
    sourceHash,
    sourceName: basename(filePath),
    sourceColumns: {
      specimenId: input.specimenIdColumn,
      force: input.forceColumn,
      forceUnit: input.forceUnit,
      forceSign: input.forceSign,
      displacement: input.displacementColumn,
      displacementUnit: input.displacementUnit,
      displacementSign: input.displacementSign,
      delimiter: input.delimiter,
      decimalSeparator: input.decimalSeparator,
    },
    selectedCsvRecordNumbers: [...selectedRows.keys()].sort((left, right) => left - right),
    interpretation: "caller-selected-physical-dcb-mode-i-energy-preview-only" as const,
    limitations: [
      "The caller manually selects one CSV record for each observed crack-growth point and supplies its crack length; the importer does not infer crack growth, filter acquisition samples, or select peak loads.",
      "Force/displacement values are unit-converted only. The caller attests that displacement is machine-compliance-corrected load-point displacement and that the test is quasi-static and linear elastic.",
      "The preview does not register a physical test. Review the source hash, selected record numbers, specimen IDs, crack lengths, failure locations and correction method before using recordInput with plasticity_record_dcb_mode_i_energy_test.",
      "The derived MBT G_I-versus-crack-length result is exploratory fracture-energy evidence only, not a traction-separation curve, cohesive law, design allowable or standards-conformance determination.",
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

function parseDecimal(value: string, separator: "period" | "comma", recordNumber: number, field: string): number {
  const trimmed = value.trim();
  const normalized = separator === "comma" ? trimmed.replace(",", ".") : trimmed;
  if (!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(normalized)) {
    throw new Error(`DCB Mode-I energy CSV ${field} at record ${recordNumber} is not a valid decimal number`);
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) throw new Error(`DCB Mode-I energy CSV ${field} at record ${recordNumber} is not finite`);
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
      throw new Error("DCB Mode-I energy CSV has unexpected content after a quoted field");
    }
    if (character === "\"") {
      if (field.length > 0) throw new Error("DCB Mode-I energy CSV has a quote inside an unquoted field");
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
        if (records.length > MAX_CSV_RECORDS + 1) throw new Error(`DCB Mode-I energy CSV exceeds ${MAX_CSV_RECORDS} measurement records`);
      }
      record = [];
      afterQuote = false;
      if (character === "\r" && text[index + 1] === "\n") index += 1;
    } else field += character;
  }
  if (quoted) throw new Error("DCB Mode-I energy CSV contains an unterminated quoted field");
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    if (record.some((cell) => cell.length > 0)) records.push(record);
  }
  return records;
}
