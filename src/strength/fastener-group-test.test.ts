import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FastenerGroupTestStore,
  fastenerGroupTestHash,
  fastenerGroupTestInputSchema,
  type FastenerGroupTestInput,
} from "./fastener-group-test.ts";

test("stores physical multi-hole joint test results immutably and matches exact geometry independent of hole order", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-fastener-group-tests-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const store = new FastenerGroupTestStore(root);
  const input = testInput();
  const first = await store.record(input);
  const repeated = await store.record(input);

  assert.equal(first.alreadyExisted, false);
  assert.equal(repeated.alreadyExisted, true);
  assert.equal(first.record.id, fastenerGroupTestHash(input));
  assert.equal((await store.list()).length, 1);
  const match = await store.match({
    process: input.process,
    geometry: { ...input.geometry, holes: [...input.geometry.holes].reverse() },
    fixture: input.fixture,
  });
  assert.equal(match.status, "matched");
  assert.equal(match.selected?.id, first.record.id);
  assert.deepEqual(match.selected?.outcomes.map((item) => item.peakLoadN), [420, 450]);
});

test("does not match a changed setup and returns ambiguous for conflicting exact-configuration tests", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-fastener-group-tests-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const store = new FastenerGroupTestStore(root);
  const first = testInput();
  await store.record(first);
  assert.equal((await store.match({ process: first.process, geometry: { ...first.geometry, thicknessMm: 4.01 }, fixture: first.fixture })).status, "no-match");

  const second = testInput();
  second.testedAt = "2026-09-24T10:00:00.000Z";
  second.outcomes.find((item) => item.evidenceIds.includes("peak-load-1"))!.peakLoadN = 410;
  second.evidence.find((item) => item.id === "peak-load-1")!.value = 410;
  await store.record(second);
  const match = await store.match({ process: first.process, geometry: first.geometry, fixture: first.fixture });
  assert.equal(match.status, "ambiguous");
  assert.equal(match.selected, null);
  assert.equal(match.records.length, 2);
});

test("requires traceable measured peak loads and rejects a tampered registry record", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-fastener-group-tests-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const store = new FastenerGroupTestStore(root);
  const invalid = testInput();
  invalid.evidence.find((item) => item.id === "peak-load-1")!.sourceHash = "invalid";
  assert.throws(() => fastenerGroupTestInputSchema.parse(invalid), /SHA-256 hash and report locator/i);
  const overlapping = testInput();
  overlapping.geometry.holes[1]!.xMm = 19;
  assert.throws(() => fastenerGroupTestInputSchema.parse(overlapping), /cannot overlap or touch/i);
  const { record } = await store.record(testInput());
  await writeFile(join(root, record.id + ".json"), JSON.stringify({ ...record, notes: "tampered" }));
  await assert.rejects(() => store.list(), /record hash mismatch/i);
});

function testInput(): FastenerGroupTestInput {
  const sourceHash = "a".repeat(64);
  return {
    process: {
      printerId: "creality-k1c-0.4",
      materialId: "pla-matched",
      profileHash: "b".repeat(64),
      orientationDeg: [0, 0, 0],
      infillPercent: 100,
      infillPattern: "grid",
      wallLoops: 2,
      topShellLayers: 5,
      bottomShellLayers: 3,
      nozzleTemperatureC: 220,
      layerHeightMm: 0.2,
    },
    geometry: {
      widthMm: 50,
      heightMm: 30,
      thicknessMm: 4,
      holes: [
        { xMm: 15, yMm: 15, diameterMm: 5 },
        { xMm: 35, yMm: 15, diameterMm: 5 },
      ],
    },
    fixture: {
      testMethod: "documented double-lap pin-group coupon test",
      loadAxis: "x",
      jointConfiguration: "double-lap",
      fastenerDiameterMm: 5,
      radialClearanceMm: 0.2,
      clampCondition: "no intentional preload; clearance fit",
    },
    outcomes: [
      { peakLoadN: 450, failureMode: "shared-ligament", evidenceIds: ["peak-load-2"] },
      { peakLoadN: 420, failureMode: "shared-ligament", evidenceIds: ["peak-load-1"] },
    ],
    evidence: [
      { id: "specimen-geometry", label: "Measured specimen geometry", status: "measured", sourceHash, sourceLocator: "report:geometry", dependsOn: [] },
      { id: "test-report", label: "Test procedure and fixture report", status: "measured", sourceHash, sourceLocator: "report:procedure", dependsOn: [] },
      { id: "peak-load-1", label: "Specimen 1 peak load", status: "measured", unit: "N", value: 420, sourceHash, sourceLocator: "report:specimen-1", dependsOn: [] },
      { id: "peak-load-2", label: "Specimen 2 peak load", status: "measured", unit: "N", value: 450, sourceHash, sourceLocator: "report:specimen-2", dependsOn: [] },
    ],
    specimenMeasurementEvidenceId: "specimen-geometry",
    testReportEvidenceId: "test-report",
    testedAt: "2026-09-23T10:00:00.000Z",
    notes: "Fixture-specific test data only.",
    source: "physical-multi-hole-joint-test",
    callerConfirmsPhysicalTests: true,
  };
}
