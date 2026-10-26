import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { calculateDcbModeIEnergy } from "../src/strength/dcb-mode-i-energy.ts";
import { calculateEnfModeIIEnergy } from "../src/strength/enf-mode-ii-energy.ts";
import { calculateMmbModeIEnergy } from "../src/strength/mmb-mode-i-ii-energy.ts";
import { importDcbModeIEnergyCsv } from "../src/strength/dcb-mode-i-energy-csv.ts";
import { importEnfModeIIEnergyCsv } from "../src/strength/enf-mode-ii-energy-csv.ts";
import { importMmbModeIEnergyCsv } from "../src/strength/mmb-mode-i-ii-energy-csv.ts";
import { assertEnergyCalculation, energyCsvFixture, fractureEnergyFixture, parseFractureEnergyArgs } from "./verify-fracture-energy-live.ts";

test("fracture-energy runner is inert by default and requires explicit live case/target/output", () => {
  assert.equal(parseFractureEnergyArgs([]).help, true);
  const args = ["--target", "experimental", "--allow-live", "--case", "dcb", "--output", "new-dir"];
  assert.equal(parseFractureEnergyArgs(args).case, "dcb");
  for (const flag of ["--target", "--allow-live", "--case", "--output"]) {
    const copy = [...args]; copy.splice(copy.indexOf(flag), flag === "--allow-live" ? 1 : 2);
    assert.throws(() => parseFractureEnergyArgs(copy), /required|new directory/);
  }
  assert.throws(() => parseFractureEnergyArgs(["--case", "unknown"]), /must be/);
  assert.throws(() => parseFractureEnergyArgs(["--target", "--allow-live"]), /requires a value/);
  assert.throws(() => parseFractureEnergyArgs(["--source", "unreviewed"]), /Unknown argument/);
});

test("reviewed synthetic direct inputs and explicitly selected CSV rows satisfy independent energy gates", async context => {
  const root = await mkdtemp(join(tmpdir(), "fracture-energy-fixtures-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const calculators = { dcb: calculateDcbModeIEnergy, enf: calculateEnfModeIIEnergy, mmb: calculateMmbModeIEnergy };
  const importers = { dcb: importDcbModeIEnergyCsv, enf: importEnfModeIIEnergyCsv, mmb: importMmbModeIEnergyCsv };
  for (const mode of ["dcb", "enf", "mmb"] as const) {
    const { input, sourceText } = fractureEnergyFixture(mode);
    assert.match(sourceText, /NO PHYSICAL TEST/);
    assert.equal(input.materialProcess.printerId, "synthetic-printer");
    const { callerConfirmsPhysicalTests: _, ...raw } = input;
    const result = calculators[mode](raw);
    assertEnergyCalculation(mode, result);
    const path = join(root, mode + ".csv");
    const csv = energyCsvFixture(mode, path); await writeFile(path, csv.text, { flag: "wx" });
    assertEnergyCalculation(mode, (await importers[mode](csv.args)).calculation);
    const changed = structuredClone(result);
    if (mode === "dcb") (changed.specimens[0] as any).points[0].energyReleaseRateJPerM2 *= 1000;
    else if (mode === "enf") (changed.specimens[0] as any).energyReleaseRateJPerM2 = NaN;
    else (changed.specimens[0] as any).modeIEnergyReleaseRateJPerM2 *= 8;
    assert.throws(() => assertEnergyCalculation(mode, changed));
  }
});
