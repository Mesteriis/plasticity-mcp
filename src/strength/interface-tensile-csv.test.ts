import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { importInterfaceTensileCsv } from "./interface-tensile-csv.ts";

test("imports measured tensile peaks by specimen and preserves source traceability", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "plasticity-interface-csv-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "coupons.csv");
  const csv = "specimen,force_N,extension_mm\nA,120,0\nA,640,0.2\nA,510,0.3\nB,80,0\nB,800,0.4\nB,760,0.5\n";
  await writeFile(path, csv);

  const result = await importInterfaceTensileCsv({
    path,
    specimenIdColumn: "specimen",
    forceColumn: "force_N",
    forceUnit: "N",
    forceSign: "positive",
    delimiter: "comma",
    decimalSeparator: "period",
    specimens: [
      { specimenId: "A", netCrossSectionMm2: 16, failureLocation: "interface" },
      { specimenId: "B", netCrossSectionMm2: 20, failureLocation: "fixture" },
    ],
  });

  assert.equal(result.sourceHash, createHash("sha256").update(csv).digest("hex"));
  assert.equal(result.specimens.length, 2);
  assert.deepEqual(result.specimens.map(({ specimenId, peakForceN, nominalPeakStrengthMPa, failureLocation }) => ({ specimenId, peakForceN, nominalPeakStrengthMPa, failureLocation })), [
    { specimenId: "A", peakForceN: 640, nominalPeakStrengthMPa: 40, failureLocation: "interface" },
    { specimenId: "B", peakForceN: 800, nominalPeakStrengthMPa: 40, failureLocation: "fixture" },
  ]);
  assert.match(result.specimens[0]!.sourceLocator, /coupons\.csv.*peak record 3/);
  assert.equal(result.summary.meanPeakStrengthMPa, 40);
  assert.equal(result.summary.interfaceFailureCount, 1);
  assert.equal(result.interpretation, "nominal-interface-coupon-strength-screen-only");
});

test("imports semicolon CSV decimal commas and normalizes explicitly signed kgf loads", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "plasticity-interface-csv-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "mesures.csv");
  await writeFile(path, "sample;load;extension\nC1;-1,5;0\nC1;-3,0;0,2\n");

  const result = await importInterfaceTensileCsv({
    path,
    specimenIdColumn: "sample",
    forceColumn: "load",
    forceUnit: "kgf",
    forceSign: "negative",
    delimiter: "semicolon",
    decimalSeparator: "comma",
    specimens: [{ specimenId: "C1", netCrossSectionMm2: 4, failureLocation: "printed-material" }],
  });

  assert.equal(result.specimens[0]!.peakForceN, 3 * 9.80665);
  assert.equal(result.specimens[0]!.nominalPeakStrengthMPa, 3 * 9.80665 / 4);
  assert.equal(result.specimens[0]!.failureLocation, "printed-material");
});

test("parses quoted CRLF records and applies each explicitly selected force unit", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "plasticity-interface-csv-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "quoted.csv");
  const base = {
    path,
    specimenIdColumn: "specimen,id",
    forceColumn: "measured load",
    forceSign: "positive" as const,
    delimiter: "comma" as const,
    decimalSeparator: "period" as const,
    specimens: [{ specimenId: "A,1", netCrossSectionMm2: 2, failureLocation: "interface" as const }],
  };
  const factors = { N: 1, kN: 1000, kgf: 9.80665, lbf: 4.4482216152605 } as const;

  for (const [forceUnit, factor] of Object.entries(factors) as Array<[keyof typeof factors, number]>) {
    await writeFile(path, `"specimen,id","measured load"\r\n"A,1",2\r\n"A,1",2.5\r\n`);
    const result = await importInterfaceTensileCsv({ ...base, forceUnit });
    assert.equal(result.specimens[0]!.peakForceN, 2.5 * factor);
  }
});

test("rejects incomplete, contradictory, or sign-inconsistent specimen data", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "plasticity-interface-csv-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "coupons.csv");
  await writeFile(path, "specimen,force\nA,2\nB,-3\n");
  const request = {
    path,
    specimenIdColumn: "specimen",
    forceColumn: "force",
    forceUnit: "N" as const,
    forceSign: "positive" as const,
    delimiter: "comma" as const,
    decimalSeparator: "period" as const,
    specimens: [{ specimenId: "A", netCrossSectionMm2: 2, failureLocation: "interface" as const }],
  };

  await assert.rejects(importInterfaceTensileCsv(request), /unexpected specimen ID.*B/i);
  await writeFile(path, "specimen,force\nA,2\n");
  await assert.rejects(importInterfaceTensileCsv({ ...request, specimens: [] }), /expected array to have >=1 items/i);
  await assert.rejects(importInterfaceTensileCsv({ ...request, forceSign: "negative" }), /does not match the selected tensile sign/i);
});

test("refuses a symbolic-link input instead of following it", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "plasticity-interface-csv-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const actualPath = join(directory, "actual.csv");
  const linkPath = join(directory, "link.csv");
  await writeFile(actualPath, "specimen,force\nA,2\n");
  await symlink(actualPath, linkPath);

  await assert.rejects(importInterfaceTensileCsv({
    path: linkPath,
    specimenIdColumn: "specimen",
    forceColumn: "force",
    forceUnit: "N",
    forceSign: "positive",
    delimiter: "comma",
    decimalSeparator: "period",
    specimens: [{ specimenId: "A", netCrossSectionMm2: 2, failureLocation: "interface" }],
  }), /regular non-symlink file/i);
});

test("rejects ambiguous decimal/delimiter settings and malformed quoted fields", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "plasticity-interface-csv-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "malformed.csv");
  await writeFile(path, 'specimen,force\n"A"oops,2\n');
  const request = {
    path,
    specimenIdColumn: "specimen",
    forceColumn: "force",
    forceUnit: "N" as const,
    forceSign: "positive" as const,
    delimiter: "comma" as const,
    decimalSeparator: "period" as const,
    specimens: [{ specimenId: "A", netCrossSectionMm2: 2, failureLocation: "interface" as const }],
  };
  await assert.rejects(importInterfaceTensileCsv({ ...request, decimalSeparator: "comma" }), /decimal comma requires semicolon or tab/i);
  await assert.rejects(importInterfaceTensileCsv(request), /unexpected content after a quoted field/i);
});
