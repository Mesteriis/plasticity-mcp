import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FastenerGroupTestStore } from "../src/strength/fastener-group-test.ts";
import { analyzeMaterialInterfaceTestCurve } from "../src/strength/interface-test.ts";
import { assertCurveSummary, assertSpecimenSummary, fastenerTestFixture, interfaceTestFixture, parseJointTestArgs } from "./verify-joint-tests-live.ts";

test("joint runner defaults to inert help and requires explicit live isolation arguments", () => {
  assert.equal(parseJointTestArgs([]).help, true);
  const help = spawnSync(process.execPath, [new URL("./verify-joint-tests-live.ts", import.meta.url).pathname], { encoding: "utf8" });
  assert.equal(help.status, 0); assert.match(help.stdout, /No args\/--help are inert/);
  const args = ["--target", "experimental", "--allow-live", "--case", "interface-strength", "--output", "new-dir"];
  assert.equal(parseJointTestArgs(args).case, "interface-strength");
  for (const flag of ["--target", "--allow-live", "--case", "--output"]) {
    const copy = [...args]; copy.splice(copy.indexOf(flag), flag === "--allow-live" ? 1 : 2);
    assert.throws(() => parseJointTestArgs(copy), /required|new directory/);
  }
  assert.throws(() => parseJointTestArgs(["--case", "physical-test"]), /must be/);
  assert.throws(() => parseJointTestArgs(["--target", "--allow-live"]), /requires a value/);
  assert.throws(() => parseJointTestArgs(["--url", "https://example.com/"]), /Unknown argument/);
});

test("reviewed synthetic fastener fixtures match with reversed holes and retain conflicts", async context => {
  const root = await mkdtemp(join(tmpdir(), "joint-registry-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new FastenerGroupTestStore(root);
  const { input } = fastenerTestFixture();
  assert.match(input.notes!, /no physical tests/);
  const saved = await store.record(input);
  assert.equal((await store.record(input)).alreadyExisted, true);
  const query = { process: input.process, geometry: { ...input.geometry, holes: [...input.geometry.holes].reverse() }, fixture: input.fixture };
  assert.equal((await store.match(query)).selected?.id, saved.record.id);
  await store.record(fastenerTestFixture(410).input);
  assert.equal((await store.match(query)).status, "ambiguous");
});

test("curve gate checks independently integrated work and rejects wrong units or metadata", () => {
  const input = interfaceTestFixture(true).input;
  const result = analyzeMaterialInterfaceTestCurve({ ...input, failureLocation: "interface" });
  assert.doesNotThrow(() => assertCurveSummary(result));
  for (const change of [{ fractureEnergyNPerMm: 15 }, { initialSegmentStiffnessMPaPerMm: 0.1 }, { peakStrengthMPa: 1000 }, { finalSeparationMm: NaN }, { interpretation: "qualified" }]) {
    assert.throws(() => assertCurveSummary({ ...result, ...change }));
  }
});

test("specimen gate excludes bulk failure from statistics and preserves public terminology", () => {
  const result = { specimens: [{ nominalPeakStrengthMPa: 10 }, { nominalPeakStrengthMPa: 15 }, { nominalPeakStrengthMPa: 100, failureLocation: "printed-material" }],
    summary: { specimenCount: 3, interfaceFailureCount: 2, minimumPeakStrengthMPa: 10, maximumPeakStrengthMPa: 15, meanPeakStrengthMPa: 12.5, sampleStandardDeviationMPa: Math.sqrt(12.5), interpretation: "descriptive-interface-failure-specimen-statistics-only" } };
  assert.doesNotThrow(() => assertSpecimenSummary(result));
  assert.throws(() => assertSpecimenSummary({ ...result, summary: { ...result.summary, maximumPeakStrengthMPa: 100 } }));
  const internal = structuredClone(result); internal.specimens[2]!.failureLocation = "material-a";
  assert.throws(() => assertSpecimenSummary(internal), /Public one-material/);
});
