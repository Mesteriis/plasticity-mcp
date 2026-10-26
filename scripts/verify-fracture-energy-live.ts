#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";



import { syntheticCouponFixture } from "./verify-material-coupon-live.ts";
import { isolatedAcceptanceEnvironment } from "./verify-native-measure-datum-files-live.ts";
import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
interface Options { help: boolean; allowLive: boolean; target?: string; output?: string; case?: "dcb" | "enf" | "mmb" }
export function parseFractureEnergyArgs(argv: string[]): Options {
  const options: Options = { help: argv.length === 0, allowLive: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--help") options.help = true;
    else if (flag === "--allow-live") options.allowLive = true;
    else if (["--target", "--output", "--case"].includes(flag ?? "")) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw Error(`${flag} requires a value`);
      if (flag === "--target") options.target = value;
      else if (flag === "--output") options.output = value;
      else { if (!["dcb", "enf", "mmb"].includes(value)) throw Error("--case must be dcb, enf or mmb"); options.case = value as NonNullable<Options["case"]>; }
    } else throw Error(`Unknown argument: ${flag}`);
  }
  if (!options.help) {
    if (!options.target) throw Error("--target is required");
    if (!options.allowLive) throw Error("--allow-live is required");
    if (!options.output) throw Error("--output must name a new directory");
    if (!options.case) throw Error("--case is required");
  }
  return options;
}


const reviewedInputs = {
dcb: {
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
},
enf: {
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
},
mmb: {
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
},
};

type Mode = "dcb" | "enf" | "mmb";
const keys = { dcb: "dcb_mode_i", enf: "enf_mode_ii", mmb: "mmb_mode_i_ii" };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export function fractureEnergyFixture(mode: Mode, conflict = false): { input: any; sourceText: string } {
  const input: any = structuredClone(reviewedInputs[mode]);
  input.materialProcess = syntheticCouponFixture().input.process;
  input.testMethod = "SYNTHETIC " + input.testMethod;
  if (conflict) {
    if (mode === "dcb") for (const p of input.specimens[0].points) p.forceN *= 1.1;
    else if (mode === "enf") input.specimens[0].fracture.peakForceN = 110;
    else input.specimens[0].criticalForceN = 121;
  }
  const sourceText = JSON.stringify({ fixture: "SYNTHETIC ONLY - NO PHYSICAL TEST", input });
  const sourceHash = hash(sourceText);
  function update(value: any): void {
    if (!value || typeof value !== "object") return;
    for (const k of Object.keys(value)) {
      if (k === "sourceHash") value[k] = sourceHash;
      else if (k === "sourceLocator") value[k] = "SYNTHETIC:" + value[k];
      else update(value[k]);
    }
  }
  update(input); input.testProtocolHash = hash("SYNTHETIC " + mode + " protocol");
  return { input, sourceText };
}
export function assertEnergyCalculation(mode: Mode, result: any) {
  const s = result.specimens[0]; assert.equal(result.specimens.length, 1);
  assert.equal(s.eligibleForLayerInterfaceEvidence, true); assert.equal(s.failureLocation, "interface");
  if (mode === "dcb") {
    near(s.crackLengthCorrectionMm, 20);
    const energies = [21.6, 18.816, 13.824];
    for (const [i, p] of s.points.entries()) near(p.energyReleaseRateJPerM2, energies[i]!);
  } else if (mode === "enf") {
    near(s.complianceFitSlopeMmPerNPerMm3, 0.000001); near(s.complianceFitRSquared, 1); near(s.energyReleaseRateJPerM2, 675);
  } else {
    // Decimal-60 independent evaluation with h=one arm=2.5 mm. These fixed
    // numeric oracles do not call or derive expectations from the product.
    near(s.modeIEnergyReleaseRateJPerM2, 41486.7787876807657);
    near(s.modeIIEnergyReleaseRateJPerM2, 10714.1168920638601);
    near(s.totalEnergyReleaseRateJPerM2, 52200.8956797446258);
    near(s.modeIIModeMixFraction, 0.20524775968971027);
  }
}
export function energyCsvFixture(mode: Mode, path: string) {
  const { input } = fractureEnergyFixture(mode);
  const { callerConfirmsPhysicalTests: _, specimens, ...base } = input;
  const spec = specimens[0];
  const common = { ...base, path, specimenIdColumn: "id", forceColumn: "force", forceUnit: "kN", forceSign: "positive", delimiter: "comma", decimalSeparator: "period" };
  if (mode === "mmb") {
    const { sourceHash: _, sourceLocator: __, criticalForceN: ___, ...shape } = spec;
    return { text: "id,force\nMMB-1,0.12\n", args: { ...common, specimens: [{ ...shape, selectedRecordNumber: 2 }] } };
  }
  const withDisplacement = { ...common, displacementColumn: "disp", displacementUnit: "um", displacementSign: "positive" };
  if (mode === "dcb") {
    const { sourceHash: _, points, ...shape } = spec;
    return { text: "id,force,disp\nDCB-1,0.01,2160\nDCB-1,0.008,2744\nDCB-1,0.006,3072\n", args: { ...withDisplacement, specimens: [{ ...shape, crackObservations: points.map((p: any, i: number) => ({ csvRecordNumber: i + 2, crackLengthMm: p.crackLengthMm })) }] } };
  }
  let text = "id,run,force,disp\n";
  for (const [i, point] of spec.calibration.entries()) for (const f of [10, 20, 30]) text += `ENF-1,r${i},${f/1000},${f * point.complianceMmPerN * 1000}\n`;
  text += "ENF-1,fracture,0.1,1000\n";
  const { calibration, fracture, ...shape } = spec;
  return { text, args: { ...withDisplacement, runIdColumn: "run", specimens: [{ ...shape, calibrationRuns: calibration.map((p: any, i: number) => ({ runId: `r${i}`, crackLengthMm: p.crackLengthMm, csvRecordNumbers: [2+3*i,3+3*i,4+3*i] })), fractureRunId: "fracture", fracturePeakRecordNumber: 11, initialCrackLengthMm: fracture.initialCrackLengthMm }] } };
}
const HELP = `Usage: npm run accept:fracture-energy -- --target ID --allow-live --case dcb|enf|mmb --output NEW_DIRECTORY
No args/--help are inert. Synthetic-only production stdio verification with isolated
stores, explicit experimental Plasticity connection, no CAD mutations, no physical
tests, no downloads or Codex analysis turns.`;
async function main() {
  const options = parseFractureEnergyArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!); await mkdir(output, { mode: 0o700 });
  const evidence: any = { schemaVersion: 1, startedAt: new Date().toISOString(), case: options.case, syntheticOnly: true, physicalTestsPerformed: false };
  let client: Client | undefined; let initial: any; let snapshot: any;
  const start = async (storeRoot = join(output, "stores")) => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts/run-server.ts")], cwd: projectRoot,
      env: isolatedAcceptanceEnvironment(storeRoot, process.env), stderr: "pipe" });
    const next = new Client({ name: "plasticity-fracture-energy-live", version: "1.0.0" });
    await next.connect(transport); return next;
  };
  try {
    client = await start();
    const windows = await call(client, "plasticity_list_windows", {});
    assert(windows.some((w: any) => w.targetId === options.target), "Explicit experimental target missing");
    initial = await call(client, "plasticity_connect", { targetId: options.target });
    snapshot = await call(client, "plasticity_capture_snapshot", { label: "fracture-energy-readonly-baseline" });
    const mode = options.case!; const key = keys[mode];
    const listTool = `plasticity_list_${key}_energy_tests`;
    const readTool = `plasticity_read_${key}_energy_test`;
    const matchTool = `plasticity_match_${key}_energy_test`;
    const recordTool = `plasticity_record_${key}_energy_test`;
    assert.deepEqual((await call(client, listTool, {})).records, []);
    const fixture = fractureEnergyFixture(mode);
    await writeFile(join(output, "synthetic-energy-source.json"), fixture.sourceText, { flag: "wx", mode: 0o600 });
    const { callerConfirmsPhysicalTests: _, ...raw } = fixture.input;
    evidence.calculation = await call(client, `plasticity_calculate_${key}_energy`, raw);
    assertEnergyCalculation(mode, evidence.calculation);
    const csvPath = join(output, "synthetic-energy.csv");
    const csv = energyCsvFixture(mode, csvPath); await writeFile(csvPath, csv.text, { flag: "wx", mode: 0o600 });
    const preview = await call(client, `plasticity_import_${key}_energy_csv`, csv.args);
    assertEnergyCalculation(mode, preview.calculation); assert.equal(preview.sourceHash, hash(csv.text));
    assert.equal(await readFile(csvPath, "utf8"), csv.text); assert.deepEqual((await call(client, listTool, {})).records, []);
    evidence.preview = preview;
    const saved = await call(client, recordTool, fixture.input);
    assert.equal(saved.alreadyExisted, false); assert.deepEqual(saved.record.calculation, evidence.calculation);
    const repeated = await call(client, recordTool, fixture.input);
    assert.equal(repeated.alreadyExisted, true); assert.deepEqual(repeated.record, saved.record);
    assert.deepEqual(await call(client, readTool, { recordId: saved.record.id }), saved.record);
    const query = { materialProcess: fixture.input.materialProcess, interfaceNormalGlobal: fixture.input.interfaceNormalGlobal, testProtocolHash: fixture.input.testProtocolHash,
      ...(mode === "dcb" ? {} : { interfaceShearDirectionGlobal: fixture.input.interfaceShearDirectionGlobal }) };
    const matched = await call(client, matchTool, query);
    assert.equal(matched.status, "matched"); assert.equal(matched.selectedRecordId, saved.record.id);
    assert.equal((await call(client, matchTool, { ...query, materialProcess: { ...query.materialProcess, layerHeightMm: 0.3 } })).status, "no-match");
    await rejected(client, recordTool, { ...fixture.input, callerConfirmsPhysicalTests: false }, /true/i);
    const invalid = structuredClone(raw); invalid.specimens[0].widthMm = 0;
    await rejected(client, `plasticity_calculate_${key}_energy`, invalid, /greater|positive|small/i);
    const conflict = fractureEnergyFixture(mode, true);
    await writeFile(join(output, "synthetic-conflict-source.json"), conflict.sourceText, { flag: "wx", mode: 0o600 });
    const second = await call(client, recordTool, conflict.input);
    const ambiguous = await call(client, matchTool, query);
    assert.equal(ambiguous.status, "ambiguous"); assert.equal(ambiguous.selectedRecordId, null);
    const before = await call(client, listTool, {}); assert.equal(before.records.length, 2);
    evidence.beforeRestart = await unchanged(client, initial, snapshot);
    await client.close(); client = undefined; snapshot = undefined;
    client = await start();
    assert.deepEqual(await call(client, listTool, {}), before);
    assert.deepEqual(await call(client, readTool, { recordId: saved.record.id }), saved.record);
    assert.deepEqual(await call(client, readTool, { recordId: second.record.id }), second.record);
    if (mode === "mmb") {
      await client.close(); client = undefined;
      const legacyBytes = await readFile(join(projectRoot, "src/strength/fixtures/mmb-v1-synthetic.json"), "utf8");
      const legacy = JSON.parse(legacyBytes);
      const legacyRoot = join(output, "legacy-stores");
      const legacyDirectory = join(legacyRoot, "mmb-mode-i-ii-energy-tests");
      await mkdir(legacyDirectory, { recursive: true, mode: 0o700 });
      const legacyPath = join(legacyDirectory, legacy.id + ".json");
      await writeFile(legacyPath, legacyBytes, { flag: "wx", mode: 0o600 });
      client = await start(legacyRoot);
      const recovered = await call(client, readTool, { recordId: legacy.id });
      assert.equal(recovered.recalculatedFromVersion, 1);
      assert.equal(recovered.recalculationReason, "MMB_V1_ARM_THICKNESS_HALVED");
      assert.equal(recovered.calculation.calculationVersion, 2); assertEnergyCalculation(mode, recovered.calculation);
      const listed = await call(client, listTool, {});
      assert.equal(listed.records[0].recalculatedFromVersion, 1);
      const legacyMatch = await call(client, matchTool, query);
      assert.equal(legacyMatch.status, "matched"); assert.equal(legacyMatch.records[0].recalculatedFromVersion, 1);
      assert.equal((await call(client, recordTool, legacy.input)).alreadyExisted, true);
      await client.close(); client = undefined; client = await start(legacyRoot);
      assert.deepEqual(await call(client, readTool, { recordId: legacy.id }), recovered);
      assert.equal(await readFile(legacyPath, "utf8"), legacyBytes);
      evidence.legacyV1 = { explicitlyRecomputedAsVersion: 2, listAndMatchAnnotated: true, sourceBytesUnchanged: true, restartPreserved: true };
    }
    const after = await call(client, "plasticity_connect", { targetId: options.target });
    for (const key of ["documentToken", "revision", "undoDepth", "redoDepth"]) assert.equal(after[key], initial[key]);
    for (const key of ["bodies", "regions", "groups", "instances", "referenceMeshes", "measurements", "sectionAnalyses", "construction", "activePlaneId"]) assert.deepEqual(after[key], initial[key], `Restart changed ${key}`);
    evidence.restart = { recordsPreserved: true, calculationsPreserved: true, nativeIdentityAndHistoryUnchanged: true };
    evidence.completedAt = new Date().toISOString(); await writeEvidence(join(output, "evidence.json"), evidence);
    console.log(JSON.stringify({ ok: true, output }));
  } catch (error) {
    evidence.error = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
    evidence.readOnly = { verified: false };
    if (client && initial && snapshot) evidence.readOnly = await unchanged(client, initial, snapshot).catch(() => ({ verified: false }));
    await writeEvidence(join(output, "failure.json"), evidence).catch(() => {}); throw error;
  } finally { await client?.close().catch(() => {}); }
}
async function unchanged(client: Client, initial: any, snapshot: any) {
  const state = await call(client, "plasticity_status", {});
  for (const key of ["documentToken", "revision", "undoDepth", "redoDepth"]) assert.equal(state[key], initial[key]);
  assert(!hasSceneContentChanges((await call(client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId })).diff));
  assert.equal((await call(client, "plasticity_construction_history", { offset: 0, limit: 100 })).total, 0);
  const journal = await call(client, "plasticity_construction_journal", {});
  assert.equal(journal.durableSyncStatus, "empty"); assert.equal(journal.journalPagination.total, 0);
  return { sceneAndHistoryUnchanged: true, mutationEvents: 0 };
}
function near(actual: number, expected: number) { assert(Number.isFinite(actual)); assert(Math.abs(actual - expected) <= 1e-10, `Numeric gate: ${actual} != ${expected}`); }
async function rejected(client: Client, name: string, args: any, pattern: RegExp) { await assert.rejects(call(client, name, args), pattern); }
async function call(client: Client, name: string, args: any): Promise<any> {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 30_000 });
  const text = (result.content as any[]).find(item => item.type === "text")?.text;
  assert.equal(typeof text, "string"); if (result.isError) throw Error(text); return JSON.parse(text);
}
async function writeEvidence(path: string, value: unknown) { await writeFile(path, JSON.stringify(sanitizeEvidence(value), null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
