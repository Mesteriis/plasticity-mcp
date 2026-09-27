import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { enfModeIIEnergyCsvInputSchema, importEnfModeIIEnergyCsv } from "./enf-mode-ii-energy-csv.ts";

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

const csvLines = [
  "specimen,run,force_kN,opening_um,note",
  "A,c20,-0.01,90,1",
  "A,c20,-0.02,180,2",
  "A,c20,-0.03,270,3",
  "A,c30,-0.01,280,4",
  "A,c30,-0.02,560,5",
  "A,c30,-0.03,840,6",
  "A,c40,-0.01,650,7",
  "A,c40,-0.02,1300,8",
  "A,c40,-0.03,1950,9",
  "A,fracture,-0.1,600,selected initiation peak",
  "A,fracture,-0.2,1200,unselected later load",
  "",
].join("\n");

async function fixture(contents = csvLines) {
  const root = await mkdtemp(join(tmpdir(), "plasticity-enf-energy-csv-"));
  const path = join(root, "enf-machine.csv");
  await writeFile(path, contents);
  return { root, path };
}

function base(path: string) {
  return {
    path,
    specimenIdColumn: "specimen",
    runIdColumn: "run",
    forceColumn: "force_kN",
    forceUnit: "kN" as const,
    forceSign: "negative" as const,
    displacementColumn: "opening_um",
    displacementUnit: "um" as const,
    displacementSign: "positive" as const,
    delimiter: "comma" as const,
    decimalSeparator: "period" as const,
    materialProcess: process,
    interfaceNormalGlobal: [0, 0, 1] as [number, number, number],
    interfaceShearDirectionGlobal: [1, 0, 0] as [number, number, number],
    testProtocolHash: "c".repeat(64),
    testMethod: "ENF Mode-II compliance calibration",
    testedAt: "2026-09-25T12:00:00Z",
    complianceEvidence: "inverse-initial-linear-force-displacement-slope-same-fixture" as const,
    linearElasticQuasiStaticEvidence: "confirmed-linear-elastic-quasi-static-test" as const,
    specimens: [{
      specimenId: "A",
      widthMm: 20,
      totalLengthMm: 160,
      armThicknessMm: 2,
      failureLocation: "interface" as const,
      calibrationRuns: [
        { runId: "c20", crackLengthMm: 20, csvRecordNumbers: [2, 3, 4] },
        { runId: "c30", crackLengthMm: 30, csvRecordNumbers: [5, 6, 7] },
        { runId: "c40", crackLengthMm: 40, csvRecordNumbers: [8, 9, 10] },
      ],
      fractureRunId: "fracture",
      fracturePeakRecordNumber: 11,
      initialCrackLengthMm: 30,
    }],
  };
}

test("previews ENF energy from explicit calibration record groups and selected fracture peak", async (context) => {
  const { root, path } = await fixture();
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const result = await importEnfModeIIEnergyCsv(base(path));
  assert.equal(result.sourceHash.length, 64);
  assert.equal(result.sourceName, "enf-machine.csv");
  assert.deepEqual(result.selectedCsvRecordNumbers, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.equal(result.complianceFits.length, 3);
  assert.ok(Math.abs(result.recordInput.specimens[0]!.calibration[0]!.complianceMmPerN - 0.009) < 1e-12);
  assert.ok(Math.abs(result.recordInput.specimens[0]!.calibration[1]!.complianceMmPerN - 0.028) < 1e-12);
  assert.ok(Math.abs(result.recordInput.specimens[0]!.calibration[2]!.complianceMmPerN - 0.065) < 1e-12);
  assert.equal(result.recordInput.specimens[0]!.fracture.peakForceN, 100);
  assert.equal(result.recordInput.specimens[0]!.fracture.sourceLocator, "enf-machine.csv!record 11");
  assert.equal(result.recordInput.specimens[0]!.fracture.sourceHash, result.sourceHash);
  assert.equal(result.calculation.specimens[0]!.energyReleaseRateJPerM2, 675);
  assert.ok(result.complianceFits.every((fit) => fit.linearFitRSquared > 0.99));
  assert.ok(result.limitations.some((limitation) => limitation.includes("does not identify linear regions, infer crack growth, or infer or select a peak")));
});

test("validates required selected row groups, unique selectors, axes, and explicit unit parsing", () => {
  const valid = base("/tmp/enf.csv");
  assert.equal(enfModeIIEnergyCsvInputSchema.safeParse(valid).success, true);
  assert.equal(enfModeIIEnergyCsvInputSchema.safeParse({ ...valid, specimenIdColumn: valid.runIdColumn }).success, false);
  assert.equal(enfModeIIEnergyCsvInputSchema.safeParse({ ...valid, interfaceShearDirectionGlobal: [0, 0, 1] }).success, false);
  assert.equal(enfModeIIEnergyCsvInputSchema.safeParse({ ...valid, decimalSeparator: "comma", delimiter: "comma" }).success, false);
  assert.equal(enfModeIIEnergyCsvInputSchema.safeParse({
    ...valid,
    specimens: [{ ...valid.specimens[0]!, calibrationRuns: valid.specimens[0]!.calibrationRuns.slice(0, 2) }],
  }).success, false);
  assert.equal(enfModeIIEnergyCsvInputSchema.safeParse({
    ...valid,
    specimens: [{ ...valid.specimens[0]!, fracturePeakRecordNumber: 2 }],
  }).success, false);
});

test("rejects wrong selected run, sign mismatch, malformed CSV and symlink", async (context) => {
  const { root, path } = await fixture();
  context.after(async () => await rm(root, { recursive: true, force: true }));
  await assert.rejects(importEnfModeIIEnergyCsv({
    ...base(path),
    specimens: [{ ...base(path).specimens[0]!, calibrationRuns: [
      { runId: "wrong", crackLengthMm: 20, csvRecordNumbers: [2, 3, 4] },
      ...base(path).specimens[0]!.calibrationRuns.slice(1),
    ] }],
  }), /run ID c20, expected wrong/i);
  await assert.rejects(importEnfModeIIEnergyCsv({ ...base(path), forceSign: "positive" }), /force sign/i);
  await writeFile(path, "specimen,run,force_kN,opening_um\nA,c20,-0.01,90\nA,c20,-0.02,180\nA,c20,-0.03,\"bad\n");
  await assert.rejects(importEnfModeIIEnergyCsv(base(path)), /unterminated quoted field/i);
  const link = join(root, "linked.csv");
  await symlink(path, link);
  await assert.rejects(importEnfModeIIEnergyCsv(base(link)), /regular non-symlink file/i);
});
