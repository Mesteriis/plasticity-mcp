import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { z } from "zod";

import { calculateEnfModeIIEnergy, enfModeIIEnergyInputSchema } from "./enf-mode-ii-energy.ts";

const MAX_CSV_BYTES = 16 * 1024 * 1024;
const MAX_CSV_RECORDS = 250_000;
const MAX_SELECTED_RECORDS = 100_000;

const calibrationRunSchema = z.object({
  runId: z.string().trim().min(1).max(240),
  crackLengthMm: z.number().finite().positive(),
  csvRecordNumbers: z.array(z.number().int().min(2)).min(3).max(5000),
}).strict().superRefine((run, context) => {
  if (new Set(run.csvRecordNumbers).size !== run.csvRecordNumbers.length) {
    context.addIssue({ code: "custom", path: ["csvRecordNumbers"], message: "An ENF compliance calibration row may be selected only once per run" });
  }
});

const specimenSchema = z.object({
  specimenId: z.string().trim().min(1).max(240),
  widthMm: z.number().finite().positive(),
  totalLengthMm: z.number().finite().positive(),
  armThicknessMm: z.number().finite().positive(),
  failureLocation: z.enum(["interface", "printed-material", "fixture", "unknown"]),
  calibrationRuns: z.array(calibrationRunSchema).min(3).max(20),
  fractureRunId: z.string().trim().min(1).max(240),
  fracturePeakRecordNumber: z.number().int().min(2),
  initialCrackLengthMm: z.number().finite().positive(),
}).strict().superRefine((specimen, context) => {
  const runIds = specimen.calibrationRuns.map(({ runId }) => runId);
  if (new Set(runIds).size !== runIds.length) {
    context.addIssue({ code: "custom", path: ["calibrationRuns"], message: "ENF calibration run IDs must be unique within a specimen" });
  }
  if (runIds.includes(specimen.fractureRunId)) {
    context.addIssue({ code: "custom", path: ["fractureRunId"], message: "ENF fracture run ID must differ from the compliance-calibration run IDs" });
  }
  const calibrationCracks = specimen.calibrationRuns.map(({ crackLengthMm }) => crackLengthMm);
  if (new Set(calibrationCracks).size !== calibrationCracks.length) {
    context.addIssue({ code: "custom", path: ["calibrationRuns"], message: "ENF calibration crack lengths must be unique within a specimen" });
  }
  const selected = [...specimen.calibrationRuns.flatMap(({ csvRecordNumbers }) => csvRecordNumbers), specimen.fracturePeakRecordNumber];
  if (new Set(selected).size !== selected.length) {
    context.addIssue({ code: "custom", path: ["fracturePeakRecordNumber"], message: "An ENF CSV record may be selected only once per specimen" });
  }
  if (selected.length > MAX_SELECTED_RECORDS) {
    context.addIssue({ code: "custom", path: [], message: `ENF preview may select at most ${MAX_SELECTED_RECORDS} CSV records` });
  }
});

export const enfModeIIEnergyCsvInputSchema = z.object({
  path: z.string().trim().min(1).max(4096),
  specimenIdColumn: z.string().trim().min(1).max(200),
  runIdColumn: z.string().trim().min(1).max(200),
  forceColumn: z.string().trim().min(1).max(200),
  forceUnit: z.enum(["N", "kN", "kgf", "lbf"]),
  forceSign: z.enum(["positive", "negative"]),
  displacementColumn: z.string().trim().min(1).max(200),
  displacementUnit: z.enum(["mm", "um"]),
  displacementSign: z.enum(["positive", "negative"]),
  delimiter: z.enum(["comma", "semicolon", "tab"]),
  decimalSeparator: z.enum(["period", "comma"]),
  materialProcess: enfModeIIEnergyInputSchema.shape.materialProcess,
  interfaceNormalGlobal: enfModeIIEnergyInputSchema.shape.interfaceNormalGlobal,
  interfaceShearDirectionGlobal: enfModeIIEnergyInputSchema.shape.interfaceShearDirectionGlobal,
  testProtocolHash: enfModeIIEnergyInputSchema.shape.testProtocolHash,
  testMethod: enfModeIIEnergyInputSchema.shape.testMethod,
  testedAt: enfModeIIEnergyInputSchema.shape.testedAt,
  complianceEvidence: enfModeIIEnergyInputSchema.shape.complianceEvidence,
  linearElasticQuasiStaticEvidence: enfModeIIEnergyInputSchema.shape.linearElasticQuasiStaticEvidence,
  specimens: z.array(specimenSchema).min(1).max(50),
}).strict().superRefine((input, context) => {
  const normalShearDot = input.interfaceNormalGlobal.reduce((sum, value, axis) => sum + value * input.interfaceShearDirectionGlobal[axis]!, 0);
  if (Math.abs(normalShearDot) > 1e-6) {
    context.addIssue({ code: "custom", path: ["interfaceShearDirectionGlobal"], message: "ENF Mode-II shear direction must lie in the measured interface plane" });
  }
  if (new Set(input.specimens.map(({ specimenId }) => specimenId)).size !== input.specimens.length) {
    context.addIssue({ code: "custom", path: ["specimens"], message: "ENF specimen IDs must be unique" });
  }
  const columns = [input.specimenIdColumn, input.runIdColumn, input.forceColumn, input.displacementColumn];
  if (new Set(columns).size !== columns.length) {
    context.addIssue({ code: "custom", path: ["specimenIdColumn"], message: "ENF specimen, run, force and displacement columns must be distinct" });
  }
  if (input.decimalSeparator === "comma" && input.delimiter === "comma") {
    context.addIssue({ code: "custom", path: ["decimalSeparator"], message: "Decimal comma requires semicolon or tab as the CSV delimiter" });
  }
  const allRecords = input.specimens.flatMap((specimen) => [
    ...specimen.calibrationRuns.flatMap(({ csvRecordNumbers }) => csvRecordNumbers),
    specimen.fracturePeakRecordNumber,
  ]);
  if (new Set(allRecords).size !== allRecords.length) {
    context.addIssue({ code: "custom", path: ["specimens"], message: "An ENF CSV record may be selected only once across this test" });
  }
  if (allRecords.length > MAX_SELECTED_RECORDS) {
    context.addIssue({ code: "custom", path: ["specimens"], message: `ENF preview may select at most ${MAX_SELECTED_RECORDS} CSV records` });
  }
});

export type EnfModeIIEnergyCsvInput = z.input<typeof enfModeIIEnergyCsvInputSchema>;

export async function importEnfModeIIEnergyCsv(rawInput: unknown) {
  const input = enfModeIIEnergyCsvInputSchema.parse(rawInput);
  const filePath = resolve(input.path);
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error("ENF Mode-II energy CSV must be a regular non-symlink file");
    throw error;
  }
  let bytes: Buffer;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("ENF Mode-II energy CSV must be a regular non-symlink file");
    if (metadata.size === 0 || metadata.size > MAX_CSV_BYTES) throw new Error(`ENF Mode-II energy CSV must be nonempty and at most ${MAX_CSV_BYTES} bytes`);
    const bounded = Buffer.alloc(MAX_CSV_BYTES + 1);
    const { bytesRead } = await handle.read(bounded, 0, bounded.length, 0);
    bytes = bounded.subarray(0, bytesRead);
    if (bytes.length === 0 || bytes.length > MAX_CSV_BYTES) throw new Error(`ENF Mode-II energy CSV must be nonempty and at most ${MAX_CSV_BYTES} bytes`);
  } finally {
    await handle.close();
  }

  const sourceText = bytes.toString("utf8");
  if (sourceText.includes("\u0000") || sourceText.includes("\uFFFD")) throw new Error("ENF Mode-II energy CSV must be valid UTF-8 text");
  const delimiter = input.delimiter === "comma" ? "," : input.delimiter === "semicolon" ? ";" : "\t";
  const records = parseCsvRecords(sourceText.replace(/^\uFEFF/, ""), delimiter);
  const header = records[0]?.map((cell) => cell.trim());
  if (!header || header.length < 4) throw new Error("ENF Mode-II energy CSV requires a header and selected specimen, run, force and displacement columns");
  if (header.some((cell) => cell.length === 0) || new Set(header).size !== header.length) throw new Error("ENF Mode-II energy CSV column names must be nonempty and unique");
  const selectedNames = [input.specimenIdColumn, input.runIdColumn, input.forceColumn, input.displacementColumn];
  const selectedIndexes = selectedNames.map((column) => header.indexOf(column));
  if (selectedIndexes.some((index) => index < 0)) throw new Error("Selected ENF specimen, run, force and displacement columns must exactly match CSV headers");
  if (records.length <= 1) throw new Error("ENF Mode-II energy CSV has no measurement records");
  if (records.length - 1 > MAX_CSV_RECORDS) throw new Error(`ENF Mode-II energy CSV exceeds ${MAX_CSV_RECORDS} measurement records`);

  const sourceHash = createHash("sha256").update(bytes).digest("hex");
  const fileName = basename(filePath);
  const selectedRows = new Map<number, { specimenId: string; runId: string; role: "calibration" | "fracture" }>();
  for (const specimen of input.specimens) {
    for (const run of specimen.calibrationRuns) {
      for (const csvRecordNumber of run.csvRecordNumbers) selectedRows.set(csvRecordNumber, { specimenId: specimen.specimenId, runId: run.runId, role: "calibration" });
    }
    selectedRows.set(specimen.fracturePeakRecordNumber, { specimenId: specimen.specimenId, runId: specimen.fractureRunId, role: "fracture" });
  }
  for (const csvRecordNumber of selectedRows.keys()) {
    if (csvRecordNumber > records.length) throw new Error(`Selected ENF CSV record ${csvRecordNumber} does not exist`);
  }

  const factorN = forceToNewtons(input.forceUnit);
  const factorMm = input.displacementUnit === "um" ? 0.001 : 1;
  const measurements = new Map<number, { specimenId: string; runId: string; forceN: number; displacementMm: number }>();
  for (let index = 1; index < records.length; index += 1) {
    const csvRecordNumber = index + 1;
    const record = records[index]!;
    if (record.length !== header.length) throw new Error(`ENF Mode-II energy CSV record ${csvRecordNumber} has ${record.length} fields; expected ${header.length}`);
    if (!selectedRows.has(csvRecordNumber)) continue;
    const selected = selectedRows.get(csvRecordNumber)!;
    const specimenId = record[selectedIndexes[0]!]!.trim();
    const runId = record[selectedIndexes[1]!]!.trim();
    if (specimenId !== selected.specimenId) throw new Error(`Selected ENF CSV record ${csvRecordNumber} identifies specimen ${specimenId}, expected ${selected.specimenId}`);
    if (runId !== selected.runId) throw new Error(`Selected ENF CSV record ${csvRecordNumber} identifies run ID ${runId}, expected ${selected.runId}`);
    const rawForce = parseDecimal(record[selectedIndexes[2]!]!, input.decimalSeparator, csvRecordNumber, "force");
    const rawDisplacement = parseDecimal(record[selectedIndexes[3]!]!, input.decimalSeparator, csvRecordNumber, "displacement");
    if (rawForce === 0 || Math.sign(rawForce) !== (input.forceSign === "positive" ? 1 : -1)) throw new Error(`ENF CSV force sign at record ${csvRecordNumber} does not match the selected test force sign`);
    if (rawDisplacement === 0 || Math.sign(rawDisplacement) !== (input.displacementSign === "positive" ? 1 : -1)) throw new Error(`ENF CSV displacement sign at record ${csvRecordNumber} does not match the selected specimen displacement sign`);
    const forceN = Math.abs(rawForce) * factorN;
    const displacementMm = Math.abs(rawDisplacement) * factorMm;
    if (!Number.isFinite(forceN) || !Number.isFinite(displacementMm) || forceN <= 0 || displacementMm <= 0) throw new Error(`ENF CSV converted measurement at record ${csvRecordNumber} is outside the supported numeric range`);
    measurements.set(csvRecordNumber, { specimenId, runId, forceN, displacementMm });
  }

  const complianceFits: Array<{
    specimenId: string;
    runId: string;
    crackLengthMm: number;
    sampleCount: number;
    complianceMmPerN: number;
    displacementInterceptMm: number;
    linearFitRSquared: number;
    selectedCsvRecordNumbers: number[];
  }> = [];
  const recordInput = enfModeIIEnergyInputSchema.parse({
    materialProcess: input.materialProcess,
    interfaceNormalGlobal: input.interfaceNormalGlobal,
    interfaceShearDirectionGlobal: input.interfaceShearDirectionGlobal,
    testProtocolHash: input.testProtocolHash,
    testMethod: input.testMethod,
    testedAt: input.testedAt,
    complianceEvidence: input.complianceEvidence,
    linearElasticQuasiStaticEvidence: input.linearElasticQuasiStaticEvidence,
    specimens: input.specimens.map((specimen) => ({
      specimenId: specimen.specimenId,
      widthMm: specimen.widthMm,
      totalLengthMm: specimen.totalLengthMm,
      armThicknessMm: specimen.armThicknessMm,
      failureLocation: specimen.failureLocation,
      calibration: specimen.calibrationRuns.map((run) => {
        const sampleRows = run.csvRecordNumbers.map((csvRecordNumber) => ({ csvRecordNumber, measurement: measurements.get(csvRecordNumber)! }));
        const fit = fitLinearCompliance(specimen.specimenId, run.runId, sampleRows.map(({ measurement }) => measurement));
        complianceFits.push({
          specimenId: specimen.specimenId,
          runId: run.runId,
          crackLengthMm: run.crackLengthMm,
          sampleCount: sampleRows.length,
          complianceMmPerN: fit.complianceMmPerN,
          displacementInterceptMm: fit.interceptMm,
          linearFitRSquared: fit.rSquared,
          selectedCsvRecordNumbers: [...run.csvRecordNumbers].sort((left, right) => left - right),
        });
        return {
          crackLengthMm: run.crackLengthMm,
          complianceMmPerN: fit.complianceMmPerN,
          sourceHash,
          sourceLocator: `${fileName}!records ${formatRecordList(run.csvRecordNumbers)}`,
        };
      }),
      fracture: {
        initialCrackLengthMm: specimen.initialCrackLengthMm,
        peakForceN: measurements.get(specimen.fracturePeakRecordNumber)!.forceN,
        sourceHash,
        sourceLocator: `${fileName}!record ${specimen.fracturePeakRecordNumber}`,
      },
    })),
  });
  const calculation = calculateEnfModeIIEnergy(recordInput);
  return {
    calculation,
    recordInput,
    sourceHash,
    sourceName: fileName,
    sourceColumns: {
      specimenId: input.specimenIdColumn,
      runId: input.runIdColumn,
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
    complianceFits,
    interpretation: "caller-selected-enf-compliance-and-initiation-preview-only" as const,
    limitations: [
      "The caller manually selects the linear-region CSV records for every calibration run, supplies crack lengths, and selects the fracture initiation/peak record; the importer does not identify linear regions, infer crack growth, or infer or select a peak.",
      "Compliance is calculated by least-squares displacement-versus-force fit with an intercept from selected rows only. Review each fit's R-squared, slope, intercept, selected records and physical source against the fixture log; no universal fit-quality threshold is imposed.",
      "Force and displacement are unit-converted only. The caller attests that compliance is based on machine-compliance-addressed measurements, all runs use the same fixture/load point, and the response is quasi-static and linear elastic.",
      "The preview hashes and returns source locators for the raw CSV but does not register a physical test. Review the selected records and observations before separately using a physical evidence recording tool.",
      "The derived ENF Mode-II G_IIc is an exploratory initiation-energy estimate for printed PLA, not ASTM conformity, propagation resistance, an R-curve, a traction-separation curve, cohesive law, design allowable, or material qualification.",
    ],
  };
}

function fitLinearCompliance(
  specimenId: string,
  runId: string,
  samples: Array<{ forceN: number; displacementMm: number }>,
) {
  const x = samples.map(({ forceN }) => forceN);
  const y = samples.map(({ displacementMm }) => displacementMm);
  const meanX = average(x);
  const meanY = average(y);
  const sxx = x.reduce((sum, value) => sum + (value - meanX) ** 2, 0);
  const syy = y.reduce((sum, value) => sum + (value - meanY) ** 2, 0);
  if (!(sxx > 0) || !(syy > 0) || !Number.isFinite(sxx) || !Number.isFinite(syy)) {
    throw new Error(`ENF calibration run ${runId} for specimen ${specimenId} requires varying force and displacement samples`);
  }
  const complianceMmPerN = x.reduce((sum, value, index) => sum + (value - meanX) * (y[index]! - meanY), 0) / sxx;
  const interceptMm = meanY - complianceMmPerN * meanX;
  const residual = y.reduce((sum, value, index) => sum + (value - (complianceMmPerN * x[index]! + interceptMm)) ** 2, 0);
  const rSquared = 1 - residual / syy;
  if (![complianceMmPerN, interceptMm, rSquared].every(Number.isFinite) || complianceMmPerN <= 0) {
    throw new Error(`ENF calibration run ${runId} for specimen ${specimenId} has a nonpositive or unsupported compliance fit`);
  }
  return { complianceMmPerN, interceptMm, rSquared };
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
    throw new Error(`ENF Mode-II energy CSV ${field} at record ${recordNumber} is not a valid decimal number`);
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) throw new Error(`ENF Mode-II energy CSV ${field} at record ${recordNumber} is not finite`);
  return parsed;
}

function formatRecordList(records: number[]): string {
  return [...records].sort((left, right) => left - right).join(",");
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
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
    if (afterQuote && character !== delimiter && character !== "\n" && character !== "\r") throw new Error("ENF Mode-II energy CSV has unexpected content after a quoted field");
    if (character === "\"") {
      if (field.length > 0) throw new Error("ENF Mode-II energy CSV has a quote inside an unquoted field");
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
        if (records.length > MAX_CSV_RECORDS + 1) throw new Error(`ENF Mode-II energy CSV exceeds ${MAX_CSV_RECORDS} measurement records`);
      }
      record = [];
      afterQuote = false;
      if (character === "\r" && text[index + 1] === "\n") index += 1;
    } else field += character;
  }
  if (quoted) throw new Error("ENF Mode-II energy CSV contains an unterminated quoted field");
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    if (record.some((cell) => cell.length > 0)) records.push(record);
  }
  return records;
}
