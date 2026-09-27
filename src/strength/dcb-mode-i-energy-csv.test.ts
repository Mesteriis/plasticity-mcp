import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { importDcbModeIEnergyCsv, dcbModeIEnergyCsvInputSchema } from "./dcb-mode-i-energy-csv.ts";

const process = {
  printerId: "creality-k1c",
  materialId: "creality-cr-pla",
  profileHash: "b".repeat(64),
  orientationDeg: [0, 0, 0] as [number, number, number],
  infillPercent: 100,
  infillPattern: "grid",
  wallLoops: 2,
  topShellLayers: 5,
  bottomShellLayers: 3,
  nozzleTemperatureC: 220,
  layerHeightMm: 0.2,
};

async function fixture(contents = [
  "specimen,load_kN,opening_um,note",
  'A,-0.01,2160,"crack at a"',
  'A,-0.008,2744,"crack at b"',
  'A,-0.006,3072,"crack at c"',
  'A,-0.005,3200,"unselected acquisition sample"',
  "",
].join("\n")) {
  const root = await mkdtemp(join(tmpdir(), "plasticity-dcb-energy-csv-"));
  const path = join(root, "instrument.csv");
  await writeFile(path, contents);
  return { root, path };
}

function base(path: string) {
  return {
    path,
    specimenIdColumn: "specimen",
    forceColumn: "load_kN",
    forceUnit: "kN" as const,
    forceSign: "negative" as const,
    displacementColumn: "opening_um",
    displacementUnit: "um" as const,
    displacementSign: "positive" as const,
    delimiter: "comma" as const,
    decimalSeparator: "period" as const,
    materialProcess: process,
    interfaceNormalGlobal: [0, 0, 1] as [number, number, number],
    testProtocolHash: "c".repeat(64),
    testMethod: "DCB Mode-I MBT study",
    testedAt: "2026-09-25T12:00:00Z",
    displacementEvidence: "machine-compliance-corrected-load-point-displacement" as const,
    linearElasticQuasiStaticEvidence: "confirmed-linear-elastic-quasi-static-test" as const,
    specimens: [{
      specimenId: "A",
      widthMm: 25,
      totalLengthMm: 125,
      armThicknessMm: 2.5,
      failureLocation: "interface" as const,
      crackObservations: [
        { csvRecordNumber: 2, crackLengthMm: 40 },
        { csvRecordNumber: 3, crackLengthMm: 50 },
        { csvRecordNumber: 4, crackLengthMm: 60 },
      ],
    }],
  };
}

test("previews manually selected DCB crack-growth rows, normalizes units, hashes source and returns record-ready measurements", async (context) => {
  const { root, path } = await fixture();
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const result = await importDcbModeIEnergyCsv(base(path));
  assert.equal(result.sourceName, "instrument.csv");
  assert.equal(result.sourceHash.length, 64);
  assert.equal(result.calculation.method, "modified-beam-theory");
  assert.equal(result.calculation.specimens[0]?.points.length, 3);
  assert.equal(result.calculation.specimens[0]?.points[0]?.forceN, 10);
  assert.equal(result.calculation.specimens[0]?.points[0]?.loadPointDisplacementMm, 2.16);
  assert.equal(result.calculation.specimens[0]?.points[0]?.sourceLocator, "instrument.csv!record 2");
  assert.equal(result.recordInput.specimens[0]?.points[2]?.crackLengthMm, 60);
  assert.equal(result.recordInput.specimens[0]?.sourceHash, result.sourceHash);
  assert.ok(result.limitations.some((limitation) => limitation.includes("does not infer crack growth, filter acquisition samples, or select peak loads")));
  assert.ok(result.limitations.some((limitation) => limitation.includes("does not register a physical test")));
});

test("requires explicit non-overlapping columns, crack-row selection and valid unit/sign choices", () => {
  const valid = base("/tmp/dcb.csv");
  assert.equal(dcbModeIEnergyCsvInputSchema.safeParse(valid).success, true);
  assert.equal(dcbModeIEnergyCsvInputSchema.safeParse({ ...valid, forceColumn: valid.specimenIdColumn }).success, false);
  assert.equal(dcbModeIEnergyCsvInputSchema.safeParse({ ...valid, decimalSeparator: "comma", delimiter: "comma" }).success, false);
  assert.equal(dcbModeIEnergyCsvInputSchema.safeParse({
    ...valid,
    specimens: [{ ...valid.specimens[0]!, crackObservations: valid.specimens[0]!.crackObservations.slice(0, 2) }],
  }).success, false);
  assert.equal(dcbModeIEnergyCsvInputSchema.safeParse({
    ...valid,
    specimens: [{ ...valid.specimens[0]!, crackObservations: [
      { csvRecordNumber: 2, crackLengthMm: 40 },
      { csvRecordNumber: 2, crackLengthMm: 50 },
      { csvRecordNumber: 4, crackLengthMm: 60 },
    ] }],
  }).success, false);
});

test("rejects wrong specimen row, missing rows, displacement sign, malformed CSV and symlinks", async (context) => {
  const { root, path } = await fixture();
  context.after(async () => await rm(root, { recursive: true, force: true }));
  await assert.rejects(importDcbModeIEnergyCsv({
    ...base(path),
    specimens: [{ ...base(path).specimens[0]!, crackObservations: [
      { csvRecordNumber: 2, crackLengthMm: 40 },
      { csvRecordNumber: 3, crackLengthMm: 50 },
      { csvRecordNumber: 99, crackLengthMm: 60 },
    ] }],
  }), /does not exist/i);
  await assert.rejects(importDcbModeIEnergyCsv({
    ...base(path),
    specimens: [{ ...base(path).specimens[0]!, specimenId: "wrong" }],
  }), /Selected DCB CSV record 2 identifies specimen A, expected wrong/i);
  await assert.rejects(importDcbModeIEnergyCsv({
    ...base(path),
    displacementSign: "negative",
  }), /displacement sign/i);
  await writeFile(path, "specimen,load_kN,opening_um\nA,-0.01,2160\nA,-0.008,2744\nA,-0.006,\"bad\n");
  await assert.rejects(importDcbModeIEnergyCsv(base(path)), /unterminated quoted field/i);
  const link = join(root, "linked.csv");
  await symlink(path, link);
  await assert.rejects(importDcbModeIEnergyCsv(base(link)), /regular non-symlink file/i);
});
