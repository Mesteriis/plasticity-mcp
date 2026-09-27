import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MmbModeIEnergyTestStore } from "./mmb-mode-i-ii-energy-store.ts";

const input = {
  materialProcess: {
    printerId: "creality-k1c", materialId: "creality-cr-pla", profileHash: "b".repeat(64),
    orientationDeg: [0, 0, 0] as [number, number, number], infillPercent: 100, infillPattern: "grid",
    wallLoops: 2, topShellLayers: 5, bottomShellLayers: 3, nozzleTemperatureC: 220, layerHeightMm: 0.2,
  },
  interfaceNormalGlobal: [0, 0, 1] as [number, number, number],
  interfaceShearDirectionGlobal: [1, 0, 0] as [number, number, number],
  testProtocolHash: "c".repeat(64), testMethod: "MMB beam-theory initiation screen",
  testedAt: "2026-09-25T12:00:00Z",
  axesMappingConfirmed: "moduli-axis-1-matches-shear-axis-2-is-in-plane-transverse-3-is-interface-normal" as const,
  leverWeight: "measured-negligible-or-counterbalanced" as const,
  flexuralModulus: { valueMPa: 1800, sourceHash: "d".repeat(64), sourceLocator: "flexure.csv!records 20-40" },
  orthotropicModuli: { E11MPa: 2000, E22MPa: 1500, G13MPa: 500, sourceHash: "e".repeat(64), sourceLocator: "coupon.pdf!table 3" },
  callerConfirmsPhysicalTests: true as const,
  specimens: [{
    specimenId: "MMB-1", widthMm: 25, totalLengthMm: 150, armThicknessMm: 2.5,
    halfSpanMm: 50, leverArmMm: 100, initialCrackLengthMm: 50, criticalForceN: 120,
    initiationCriterion: "visual-crack-initiation" as const,
    failureLocation: "interface" as const, sourceHash: "f".repeat(64), sourceLocator: "mmb.csv!record 12",
  }],
};

test("persists MMB energy records immutably and matches exact process, axes and protocol", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-mmb-energy-store-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const store = new MmbModeIEnergyTestStore(root);
  const first = await store.record(input);
  const repeat = await store.record(input);
  assert.equal(first.alreadyExisted, false);
  assert.equal(repeat.alreadyExisted, true);
  assert.equal(first.record.id, repeat.record.id);
  assert.equal(first.record.recordStatus, "caller-attested-physical-mmb-mode-i-ii-energy-test");
  assert.equal(first.record.calculation.specimens[0]?.criticalForceN, 120);
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
    specimens: input.specimens.map((specimen) => ({ ...specimen, criticalForceN: specimen.criticalForceN * 1.1, sourceHash: "a".repeat(64) })),
  });
  assert.equal(conflicting.alreadyExisted, false);
  assert.equal((await store.match(query)).status, "ambiguous");
  assert.equal((await store.list()).length, 2);
});

test("requires caller confirmation and detects tampered or un-recomputable MMB records", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-mmb-energy-tamper-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const store = new MmbModeIEnergyTestStore(root);
  await assert.rejects(store.record({ ...input, callerConfirmsPhysicalTests: false }), /expected true/i);
  const { record } = await store.record(input);
  const recordPath = join(root, `${record.id}.json`);
  const parsed = JSON.parse(await readFile(recordPath, "utf8"));
  parsed.calculation.specimens[0].totalEnergyReleaseRateJPerM2 += 1;
  await writeFile(recordPath, JSON.stringify(parsed));
  await assert.rejects(store.read(record.id), /result no longer matches its immutable test input/i);
});
