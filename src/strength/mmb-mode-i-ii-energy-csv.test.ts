import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { importMmbModeIEnergyCsv, mmbModeIEnergyCsvInputSchema } from "./mmb-mode-i-ii-energy-csv.ts";

const materialProcess = {
  printerId: "creality-k1c", materialId: "creality-cr-pla", profileHash: "b".repeat(64),
  orientationDeg: [0, 0, 0] as [number, number, number], infillPercent: 100, infillPattern: "grid",
  wallLoops: 2, topShellLayers: 5, bottomShellLayers: 3, nozzleTemperatureC: 220, layerHeightMm: 0.2,
};
const csv = [
  "specimen,force_kN,displacement_mm,note",
  "A,0.1,0.5,pre-initiation",
  "A,0.12,0.7,selected initiation",
  "A,0.15,1.2,later maximum",
  "B,-0.2,-0.8,selected negative-sign test",
  "",
].join("\n");

async function fixture(contents = csv) {
  const root = await mkdtemp(join(tmpdir(), "plasticity-mmb-energy-csv-"));
  const path = join(root, "mmb-machine.csv");
  await writeFile(path, contents);
  return { root, path };
}

function base(path: string) {
  return {
    path, specimenIdColumn: "specimen", forceColumn: "force_kN", forceUnit: "kN" as const,
    forceSign: "positive" as const, delimiter: "comma" as const, decimalSeparator: "period" as const,
    materialProcess, interfaceNormalGlobal: [0, 0, 1] as [number, number, number],
    interfaceShearDirectionGlobal: [1, 0, 0] as [number, number, number], testProtocolHash: "c".repeat(64),
    testMethod: "MMB beam-theory initiation screen", testedAt: "2026-09-25T12:00:00Z",
    axesMappingConfirmed: "moduli-axis-1-matches-shear-axis-2-is-in-plane-transverse-3-is-interface-normal" as const,
    leverWeight: "measured-negligible-or-counterbalanced" as const,
    flexuralModulus: { valueMPa: 1800, sourceHash: "d".repeat(64), sourceLocator: "flexure.csv!records 20-40" },
    orthotropicModuli: { E11MPa: 2000, E22MPa: 1500, G13MPa: 500, sourceHash: "e".repeat(64), sourceLocator: "coupon.pdf!table 3" },
    specimens: [
      { specimenId: "A", selectedRecordNumber: 3, initiationCriterion: "visual-crack-initiation" as const, widthMm: 25, totalLengthMm: 150, armThicknessMm: 2.5, halfSpanMm: 50, leverArmMm: 100, initialCrackLengthMm: 50, failureLocation: "interface" as const },
    ],
  };
}

test("previews MMB initiation energy from manually selected CSV force records with hash provenance", async (context) => {
  const { root, path } = await fixture();
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const result = await importMmbModeIEnergyCsv(base(path));
  assert.equal(result.sourceName, "mmb-machine.csv");
  assert.equal(result.sourceHash.length, 64);
  assert.deepEqual(result.selectedCsvRecordNumbers, [3]);
  assert.equal(result.recordInput.specimens[0]!.criticalForceN, 120);
  assert.equal(result.recordInput.specimens[0]!.sourceHash, result.sourceHash);
  assert.equal(result.recordInput.specimens[0]!.sourceLocator, "mmb-machine.csv!record 3");
  assert.equal(result.recordInput.specimens[0]!.initiationCriterion, "visual-crack-initiation");
  assert.equal(result.calculation.specimens[0]!.criticalForceN, 120);
  assert.ok(result.calculation.specimens[0]!.totalEnergyReleaseRateJPerM2 > 0);
  assert.ok(result.limitations.some((limitation) => limitation.includes("does not identify crack initiation")));
});

test("validates selected MMB CSV row identity, force sign, units, and symlink safety", async (context) => {
  const { root, path } = await fixture();
  context.after(async () => await rm(root, { recursive: true, force: true }));
  await assert.rejects(importMmbModeIEnergyCsv({ ...base(path), specimens: [{ ...base(path).specimens[0], selectedRecordNumber: 5 }] }), /identifies specimen B, expected A/i);
  await assert.rejects(importMmbModeIEnergyCsv({ ...base(path), forceSign: "negative" }), /force sign/i);
  await assert.rejects(importMmbModeIEnergyCsv({ ...base(path), specimens: [{ ...base(path).specimens[0], selectedRecordNumber: 99 }] }), /does not exist/i);
  assert.equal(mmbModeIEnergyCsvInputSchema.safeParse({ ...base(path), forceColumn: "specimen" }).success, false);
  await symlink(path, join(root, "linked.csv"));
  await assert.rejects(importMmbModeIEnergyCsv({ ...base(path), path: join(root, "linked.csv") }), /regular non-symlink/i);
});
