import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EnfModeIIEnergyTestStore } from "./enf-mode-ii-energy-store.ts";

const input = {
  materialProcess: {
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
  },
  interfaceNormalGlobal: [0, 0, 1] as [number, number, number],
  interfaceShearDirectionGlobal: [1, 0, 0] as [number, number, number],
  testProtocolHash: "c".repeat(64),
  testMethod: "ENF Mode-II compliance calibration",
  testedAt: "2026-09-25T12:00:00Z",
  complianceEvidence: "inverse-initial-linear-force-displacement-slope-same-fixture" as const,
  linearElasticQuasiStaticEvidence: "confirmed-linear-elastic-quasi-static-test" as const,
  callerConfirmsPhysicalTests: true as const,
  specimens: [{
    specimenId: "ENF-1",
    widthMm: 20,
    totalLengthMm: 160,
    armThicknessMm: 2,
    failureLocation: "interface" as const,
    calibration: [
      { crackLengthMm: 20, complianceMmPerN: 0.009, sourceHash: "d".repeat(64), sourceLocator: "run.csv!records 2,3,4" },
      { crackLengthMm: 30, complianceMmPerN: 0.028, sourceHash: "d".repeat(64), sourceLocator: "run.csv!records 5,6,7" },
      { crackLengthMm: 40, complianceMmPerN: 0.065, sourceHash: "d".repeat(64), sourceLocator: "run.csv!records 8,9,10" },
    ],
    fracture: { initialCrackLengthMm: 30, peakForceN: 100, sourceHash: "e".repeat(64), sourceLocator: "run.csv!record 11" },
  }],
};

test("persists ENF energy records immutably and matches exact process, normal, shear axis and protocol", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-enf-energy-store-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const store = new EnfModeIIEnergyTestStore(root);
  const first = await store.record(input);
  const repeat = await store.record(input);
  assert.equal(first.alreadyExisted, false);
  assert.equal(repeat.alreadyExisted, true);
  assert.equal(first.record.id, repeat.record.id);
  assert.equal(first.record.recordStatus, "caller-attested-physical-enf-mode-ii-energy-test");
  assert.equal(first.record.calculation.specimens[0]?.energyReleaseRateJPerM2, 675);
  const query = {
    materialProcess: input.materialProcess,
    interfaceNormalGlobal: input.interfaceNormalGlobal,
    interfaceShearDirectionGlobal: input.interfaceShearDirectionGlobal,
    testProtocolHash: input.testProtocolHash,
  };
  const matched = await store.match(query);
  assert.equal(matched.status, "matched");
  assert.equal(matched.selected?.id, first.record.id);
  assert.equal((await store.match({ ...query, interfaceShearDirectionGlobal: [0, 1, 0] })).status, "no-match");
  await assert.rejects(store.match({ ...query, interfaceShearDirectionGlobal: [0, 0, 1] }), /must lie in the interface plane/i);
  assert.equal((await store.match({ ...query, interfaceNormalGlobal: [0, 1, 0] })).status, "no-match");
  assert.equal((await store.match({ ...query, testProtocolHash: "f".repeat(64) })).status, "no-match");
  const conflicting = await store.record({
    ...input,
    testedAt: "2026-09-26T12:00:00Z",
    specimens: input.specimens.map((specimen) => ({
      ...specimen,
      fracture: { ...specimen.fracture, sourceHash: "a".repeat(64), peakForceN: specimen.fracture.peakForceN * 1.1 },
    })),
  });
  assert.equal(conflicting.alreadyExisted, false);
  assert.equal((await store.match(query)).status, "ambiguous");
  assert.equal((await store.list()).length, 2);
});

test("requires caller confirmation and detects tampered or un-recomputable records", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-enf-energy-tamper-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const store = new EnfModeIIEnergyTestStore(root);
  await assert.rejects(store.record({ ...input, callerConfirmsPhysicalTests: false }), /expected true/i);
  const { record } = await store.record(input);
  const recordPath = join(root, `${record.id}.json`);
  const parsed = JSON.parse(await readFile(recordPath, "utf8"));
  parsed.calculation.specimens[0].energyReleaseRateJPerM2 += 1;
  await writeFile(recordPath, JSON.stringify(parsed));
  await assert.rejects(store.read(record.id), /result no longer matches its immutable test input/i);
});
