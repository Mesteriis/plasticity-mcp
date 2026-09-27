import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DcbModeIEnergyTestStore } from "./dcb-mode-i-energy-store.ts";

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
  testProtocolHash: "c".repeat(64),
  testMethod: "DCB Mode-I MBT study",
  testedAt: "2026-09-25T12:00:00Z",
  displacementEvidence: "machine-compliance-corrected-load-point-displacement" as const,
  linearElasticQuasiStaticEvidence: "confirmed-linear-elastic-quasi-static-test" as const,
  callerConfirmsPhysicalTests: true as const,
  specimens: [{
    specimenId: "DCB-1",
    widthMm: 25,
    totalLengthMm: 125,
    armThicknessMm: 2.5,
    failureLocation: "interface" as const,
    sourceHash: "a".repeat(64),
    points: [
      { crackLengthMm: 40, forceN: 10, loadPointDisplacementMm: 2.16, sourceLocator: "run.csv!row 2" },
      { crackLengthMm: 50, forceN: 8, loadPointDisplacementMm: 2.744, sourceLocator: "run.csv!row 3" },
      { crackLengthMm: 60, forceN: 6, loadPointDisplacementMm: 3.072, sourceLocator: "run.csv!row 4" },
    ],
  }],
};

test("persists caller-attested DCB energy curves immutably and matches exact process/direction/protocol", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-dcb-energy-store-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const store = new DcbModeIEnergyTestStore(root);

  const first = await store.record(input);
  const repeat = await store.record(input);
  assert.equal(first.alreadyExisted, false);
  assert.equal(repeat.alreadyExisted, true);
  assert.equal(first.record.id, repeat.record.id);
  assert.equal(first.record.recordStatus, "caller-attested-physical-dcb-mode-i-energy-test");
  assert.equal(first.record.calculation.specimens[0]?.eligibleForLayerInterfaceEvidence, true);

  const query = {
    materialProcess: input.materialProcess,
    interfaceNormalGlobal: input.interfaceNormalGlobal,
    testProtocolHash: input.testProtocolHash,
  };
  const matched = await store.match(query);
  assert.equal(matched.status, "matched");
  assert.equal(matched.selected?.id, first.record.id);
  assert.equal((await store.match({ ...query, interfaceNormalGlobal: [1, 0, 0] })).status, "no-match");
  assert.equal((await store.match({ ...query, testProtocolHash: "d".repeat(64) })).status, "no-match");

  const conflicting = await store.record({
    ...input,
    testedAt: "2026-09-26T12:00:00Z",
    specimens: input.specimens.map((specimen) => ({
      ...specimen,
      sourceHash: "e".repeat(64),
      points: specimen.points.map((point) => ({ ...point, forceN: point.forceN * 1.1 })),
    })),
  });
  assert.equal(conflicting.alreadyExisted, false);
  assert.equal((await store.match(query)).status, "ambiguous");
  assert.equal((await store.list()).length, 2);
});

test("refuses unconfirmed physical tests and detects record tampering", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-dcb-energy-tamper-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const store = new DcbModeIEnergyTestStore(root);
  await assert.rejects(store.record({ ...input, callerConfirmsPhysicalTests: false }), /expected true/i);
  const { record } = await store.record(input);
  const recordPath = join(root, `${record.id}.json`);
  const parsed = JSON.parse(await readFile(recordPath, "utf8"));
  parsed.calculation.specimens[0].points[0].energyReleaseRateJPerM2 += 1;
  await (await import("node:fs/promises")).writeFile(recordPath, JSON.stringify(parsed));
  await assert.rejects(store.read(record.id), /result no longer matches its immutable test input/i);
});
