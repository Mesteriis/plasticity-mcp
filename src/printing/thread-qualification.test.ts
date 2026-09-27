import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PrintedThreadQualificationStore,
  qualificationHash,
  type PrintedThreadQualificationInput,
} from "./thread-qualification.ts";

test("persists an immutable physical thread-fit qualification idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-thread-fit-"));
  const store = new PrintedThreadQualificationStore(root);
  const input = qualificationInput();
  const first = await store.record(input);
  const second = await store.record(input);

  assert.equal(first.alreadyExisted, false);
  assert.equal(second.alreadyExisted, true);
  assert.equal(first.record.id, qualificationHash(input));
  assert.equal(second.record.id, first.record.id);
  assert.equal(first.record.qualificationStatus, "user-qualified-physical-fit");
  assert.equal((await store.list()).length, 1);
  assert.equal((await store.get(first.record.id))?.id, first.record.id);
  assert.equal(await store.get("0".repeat(64)), null);
  assert.equal(JSON.parse(await readFile(join(root, `${first.record.id}.json`), "utf8")).profileClearanceMm, 0.15);
});

test("matches only the exact process and a sufficient tested engagement", async () => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-thread-fit-"));
  const store = new PrintedThreadQualificationStore(root);
  const input = qualificationInput();
  const { record } = await store.record(input);
  const query = { process: input.process, thread: input.thread, requiredEngagementLengthMm: 8, fitClass: "normal" as const };

  const matched = await store.match(query);
  assert.equal(matched.status, "matched");
  assert.equal(matched.selected?.id, record.id);
  assert.equal((await store.match({ ...query, requiredEngagementLengthMm: 13 })).status, "no-match");
  assert.equal((await store.match({ ...query, process: { ...query.process, layerHeightMm: 0.28 } })).status, "no-match");
  assert.equal((await store.match({ ...query, thread: { ...query.thread, nominalCrestDiameterMm: 6 } })).status, "no-match");
});

test("does not silently choose between conflicting physical qualifications", async () => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-thread-fit-"));
  const store = new PrintedThreadQualificationStore(root);
  const first = qualificationInput();
  const second = { ...qualificationInput(), selectedSampleId: "clearance-0.20", profileClearanceMm: 0.2, testedAt: "2026-09-24T10:00:00.000Z" };
  await store.record(first);
  await store.record(second);

  const result = await store.match({ process: first.process, thread: first.thread, requiredEngagementLengthMm: 8 });
  assert.equal(result.status, "ambiguous");
  assert.equal(result.selected, null);
  assert.equal(result.records.length, 2);
});

test("rejects unconfirmed, geometrically invalid, and tampered qualification data", async () => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-thread-fit-"));
  const store = new PrintedThreadQualificationStore(root);
  await assert.rejects(() => store.record({ ...qualificationInput(), confirmedPhysicalTest: false } as never), /Invalid input|expected true/i);
  await assert.rejects(() => store.record({ ...qualificationInput(), profileClearanceMm: 0.4 }), /less than thread pitch/i);
  const { record } = await store.record(qualificationInput());
  await writeFile(join(root, `${record.id}.json`), JSON.stringify({ ...record, profileClearanceMm: 0.2 }));
  await assert.rejects(() => store.list(), /hash mismatch/i);
});

function qualificationInput(): PrintedThreadQualificationInput {
  return {
    process: {
      printerId: "creality-k1c-0.4",
      materialId: "generic-pla-k1c-0.4",
      slicingProfileId: "creality-print-k1c-0.20-standard",
      nozzleDiameterMm: 0.4,
      layerHeightMm: 0.2,
      orientation: "thread axes vertical",
      clearanceBasis: "printed calibration ladder 2026-09-23",
    },
    thread: {
      profile: "rounded-print-v1",
      nominalCrestDiameterMm: 5,
      pitchMm: 1.25,
      threadDepthMm: 0.6,
      handedness: "right",
    },
    selectedSampleId: "clearance-0.15",
    profileClearanceMm: 0.15,
    fitClass: "normal",
    testedEngagementLengthMm: 12,
    cyclesCompleted: 20,
    testLoadN: 40,
    testTemperatureC: 23,
    testedAt: "2026-09-23T10:00:00.000Z",
    notes: "Full travel by hand after cooling",
    source: "physical-calibration-specimen",
    confirmedPhysicalTest: true,
  };
}
