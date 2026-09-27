import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { importInterfaceFractureCsv } from "./interface-fracture-csv.ts";

test("previews fully processed DCB CSV curves per specimen with converted units and source provenance", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-interface-fracture-csv-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const path = join(root, "dcb.csv");
  const contents = "specimen,opening_um,traction_kPa\nA,0,0\nB,0,0\nA,10,1000\nB,10,1200\nA,20,500\nB,20,600\nA,30,0\nB,30,0\n";
  await writeFile(path, contents);

  const result = await importInterfaceFractureCsv({
    path,
    fractureMethod: "dcb-mode-i",
    processingAttestation: "already-compliance-corrected-traction-separation",
    specimenIdColumn: "specimen",
    separationColumn: "opening_um",
    tractionColumn: "traction_kPa",
    separationUnit: "um",
    tractionUnit: "kPa",
    delimiter: "comma",
    decimalSeparator: "period",
  });

  assert.equal(result.sourceHash, createHash("sha256").update(contents).digest("hex"));
  assert.equal(result.fractureMethod, "dcb-mode-i");
  assert.equal(result.specimens.length, 2);
  const specimenA = result.specimens[0]!;
  assert.ok("tractionSeparationCurve" in specimenA);
  assert.ok("fractureEnergyNPerMm" in specimenA.analysis);
  assert.deepEqual(specimenA.tractionSeparationCurve.points, [
    { separationMm: 0, tractionMPa: 0 },
    { separationMm: 0.01, tractionMPa: 1 },
    { separationMm: 0.02, tractionMPa: 0.5 },
    { separationMm: 0.03, tractionMPa: 0 },
  ]);
  assert.equal(specimenA.analysis.fractureEnergyNPerMm, 0.015);
  assert.equal(specimenA.analysis.peakStrengthMPa, 1);
  assert.match(specimenA.sourceLocator, /records 2,4,6,8/);
  assert.equal(result.interpretation, "processed-physical-fracture-curve-preview-only");
});

test("previews MMB vector curves without collapsing normal and shear channels", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-interface-fracture-csv-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const path = join(root, "mmb.csv");
  await writeFile(path, "id,dn,dt,tn,tt\nM1,0,0,0,0\nM1,0.01,0.01,1,1\nM1,0.02,0.02,0,0\n");
  const result = await importInterfaceFractureCsv({
    path,
    fractureMethod: "mmb-mixed-mode",
    processingAttestation: "already-compliance-corrected-traction-separation",
    specimenIdColumn: "id",
    normalSeparationColumn: "dn",
    tangentialSeparationColumn: "dt",
    normalTractionColumn: "tn",
    tangentialTractionColumn: "tt",
    separationUnit: "mm",
    tractionUnit: "MPa",
    delimiter: "comma",
    decimalSeparator: "period",
  });
  const specimen = result.specimens[0]!;
  assert.ok("mixedModeTractionSeparationCurve" in specimen);
  assert.ok("tangentialEnergyFraction" in specimen.analysis);
  assert.equal(specimen.mixedModeTractionSeparationCurve.points[1]?.normalTractionMPa, 1);
  assert.equal(specimen.mixedModeTractionSeparationCurve.points[1]?.tangentialTractionMPa, 1);
  assert.equal(specimen.analysis.tangentialEnergyFraction, 0.5);
});

test("rejects uncorrected, incomplete, malformed and symlinked fracture CSV inputs", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-interface-fracture-csv-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const path = join(root, "bad.csv");
  const base = {
    path,
    fractureMethod: "dcb-mode-i" as const,
    processingAttestation: "already-compliance-corrected-traction-separation" as const,
    specimenIdColumn: "specimen",
    separationColumn: "opening",
    tractionColumn: "traction",
    separationUnit: "mm" as const,
    tractionUnit: "MPa" as const,
    delimiter: "comma" as const,
    decimalSeparator: "period" as const,
  };
  await writeFile(path, "specimen,opening,traction\nA,0,0\nA,0.01,1\nA,0.02,0.1\n");
  await assert.rejects(importInterfaceFractureCsv({ ...base, processingAttestation: "raw-force-displacement" }), /already-compliance-corrected/i);
  await assert.rejects(importInterfaceFractureCsv(base), /at least three|start at zero|end at zero|strictly increasing/i);
  await writeFile(path, "specimen,opening,traction\nA,0,0\nA,0.01,1\nA,0.01,0.5\nA,0.02,0\n");
  await assert.rejects(importInterfaceFractureCsv(base), /strictly increasing/i);
  const link = join(root, "alias.csv");
  await symlink(path, link);
  await assert.rejects(importInterfaceFractureCsv({ ...base, path: link }), /regular non-symlink/i);
});
