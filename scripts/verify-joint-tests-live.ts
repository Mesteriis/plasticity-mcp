#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { fastenerGroupTestInputSchema } from "../src/strength/fastener-group-test.ts";
import { interfaceTestMcpInputSchema } from "../src/strength/interface-test.ts";
import { syntheticCouponFixture } from "./verify-material-coupon-live.ts";
import { isolatedAcceptanceEnvironment } from "./verify-native-measure-datum-files-live.ts";
import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
interface Options { help: boolean; allowLive: boolean; target?: string; output?: string; case?: "fastener-registry" | "interface-strength" | "interface-curve" }
export function parseJointTestArgs(argv: string[]): Options {
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
      else { if (!["fastener-registry", "interface-strength", "interface-curve"].includes(value)) throw Error("--case must be fastener-registry, interface-strength or interface-curve"); options.case = value as NonNullable<Options["case"]>; }
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


export const TENSILE_CSV = "specimen,force_N\nA,20\nA,40\nB,30\nB,60\nC,400\n";
export const CURVE_CSV = "specimen,opening_um,traction_kPa\nA,0,0\nA,10,1000\nA,20,500\nA,30,0\n";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const fixtureProcess = () => syntheticCouponFixture().input.process;
const notes = "SYNTHETIC isolated acceptance; no physical tests performed; not printable material or design evidence.";
export function fastenerTestFixture(peak = 420) {
  const sourceText = JSON.stringify({ fixture: notes, peak, otherPeak: 450 });
  const sourceHash = hash(sourceText);
  return { sourceText, input: fastenerGroupTestInputSchema.parse({
    process: fixtureProcess(), geometry: { widthMm: 50, heightMm: 30, thicknessMm: 4,
      holes: [{ xMm: 15, yMm: 15, diameterMm: 5 }, { xMm: 35, yMm: 15, diameterMm: 5 }] },
    fixture: { testMethod: "SYNTHETIC double-lap pin-group fixture", loadAxis: "x", jointConfiguration: "double-lap", fastenerDiameterMm: 5, radialClearanceMm: 0.2, clampCondition: "SYNTHETIC no preload" },
    outcomes: [{ peakLoadN: peak, failureMode: "shared-ligament", evidenceIds: ["load-a"] }, { peakLoadN: 450, failureMode: "bearing", evidenceIds: ["load-b"] }],
    evidence: [
      { id: "geometry", label: "SYNTHETIC geometry", status: "measured", sourceHash, sourceLocator: "fixture:geometry", dependsOn: [] },
      { id: "report", label: "SYNTHETIC report", status: "measured", sourceHash, sourceLocator: "fixture:protocol", dependsOn: [] },
      ...[["load-a", peak], ["load-b", 450]].map(([id, value]) => ({ id, label: "SYNTHETIC peak", status: "measured", unit: "N", value, sourceHash, sourceLocator: `fixture:${id}`, dependsOn: [] })),
    ], specimenMeasurementEvidenceId: "geometry", testReportEvidenceId: "report",
    testedAt: "2026-01-01T00:00:00.000Z", source: "physical-multi-hole-joint-test", callerConfirmsPhysicalTests: true, notes,
  }) };
}
export function interfaceTestFixture(curve = false) {
  const sourceText = curve ? CURVE_CSV : TENSILE_CSV;
  const sourceHash = hash(sourceText);
  const specimens = [["A", 40, "interface"], ["B", 60, "interface"], ["C", 400, "printed-material"]].map(([id, force, failure]) => ({ specimenId: String(id), peakForceN: Number(force), netCrossSectionMm2: 4,
    nominalPeakStrengthMPa: Number(force) / 4, failureLocation: failure, sourceHash, sourceLocator: `fixture:specimen-${id}` }));
  return { sourceText, input: interfaceTestMcpInputSchema.parse({
    materialProcess: fixtureProcess(), testMode: "normal-tension", interfaceNormalGlobal: [0, 0, 1], loadDirectionGlobal: [0, 0, 1],
    testMethod: curve ? "SYNTHETIC DCB corrected traction-separation" : "SYNTHETIC normal tensile series", testProtocolHash: hash("SYNTHETIC joint protocol"),
    specimenDescription: "SYNTHETIC one-material printed layer interface", fixtureDescription: "SYNTHETIC axial grips normal to layer plane",
    measuredPeakStrengthMPa: curve ? 1 : 10, failureLocation: "interface",
    ...(curve ? { fractureMethod: "dcb-mode-i", tractionSeparationCurve: { sourceHash, sourceLocator: "fixture:curve-A", points: [{ separationMm: 0, tractionMPa: 0 }, { separationMm: 0.01, tractionMPa: 1 }, { separationMm: 0.02, tractionMPa: 0.5 }, { separationMm: 0.03, tractionMPa: 0 }] } }
      : { specimenResults: specimens, representativeSpecimenId: "A" }),
    evidence: [{ id: "peak", label: "SYNTHETIC peak only", status: "measured", unit: "MPa", value: curve ? 1 : 10, sourceHash, sourceLocator: curve ? "fixture:curve-A" : "fixture:specimen-A", dependsOn: [] }],
    specimenCount: curve ? 1 : 3, testedAt: "2026-01-01T00:00:00.000Z", source: "physical-material-interface-test", callerConfirmsPhysicalTests: true, notes,
  }) };
}
export function assertSpecimenSummary(result: any) {
  assert.deepEqual(result.specimens.map((s: any) => s.nominalPeakStrengthMPa), [10, 15, 100]);
  assert.equal(result.specimens[2].failureLocation, "printed-material", "Public one-material failure location was not preserved");
  assert.equal(result.summary.specimenCount, 3); assert.equal(result.summary.interfaceFailureCount, 2);
  near(result.summary.minimumPeakStrengthMPa, 10); near(result.summary.maximumPeakStrengthMPa, 15);
  near(result.summary.meanPeakStrengthMPa, 12.5); near(result.summary.sampleStandardDeviationMPa, Math.sqrt(12.5));
  assert.equal(result.summary.interpretation, "descriptive-interface-failure-specimen-statistics-only");
}
export function assertCurveSummary(analysis: any) {
  assert.equal(analysis.mode, "normal-tension"); assert.equal(analysis.interpretation, "measured-curve-summary-only");
  near(analysis.peakStrengthMPa, 1); near(analysis.peakSeparationMm, 0.01); near(analysis.initialSegmentStiffnessMPaPerMm, 100);
  near(analysis.fractureEnergyNPerMm, 0.015); near(analysis.finalSeparationMm, 0.03);
}
const HELP = `Usage: npm run accept:joint-tests -- --target ID --allow-live --case fastener-registry|interface-strength|interface-curve --output NEW_DIRECTORY
No args/--help are inert. Synthetic-only production stdio checks with isolated
stores, explicit experimental Plasticity connection and no CAD mutations,
network requests, physical-test claims or Codex analysis turns.`;
async function main() {
  const options = parseJointTestArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!); await mkdir(output, { mode: 0o700 });
  const evidence: any = { schemaVersion: 1, startedAt: new Date().toISOString(), case: options.case, syntheticOnly: true, physicalTestsPerformed: false };
  let client: Client | undefined; let initial: any; let snapshot: any;
  const start = async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts/run-server.ts")], cwd: projectRoot,
      env: isolatedAcceptanceEnvironment(join(output, "stores"), process.env), stderr: "pipe" });
    const next = new Client({ name: "plasticity-joint-tests-live", version: "1.0.0" });
    await next.connect(transport); return next;
  };
  try {
    client = await start();
    const windows = await call(client, "plasticity_list_windows", {});
    assert(windows.some((w: any) => w.targetId === options.target), "Explicit experimental target missing");
    initial = await call(client, "plasticity_connect", { targetId: options.target });
    snapshot = await call(client, "plasticity_capture_snapshot", { label: "joint-test-readonly-baseline" });
    const listTool = options.case === "fastener-registry" ? "plasticity_list_fastener_group_tests" : "plasticity_list_material_interface_tests";
    assert.deepEqual((await call(client, listTool, {})).records, []);
    if (options.case === "fastener-registry") {
      const fixture = fastenerTestFixture();
      await writeFile(join(output, "synthetic-joint-source.json"), fixture.sourceText, { flag: "wx", mode: 0o600 });
      const saved = await call(client, "plasticity_record_fastener_group_test", fixture.input);
      assert.equal(saved.alreadyExisted, false);
      const repeated = await call(client, "plasticity_record_fastener_group_test", fixture.input);
      assert.equal(repeated.alreadyExisted, true); assert.deepEqual(repeated.record, saved.record);
      const { process, geometry, fixture: setup } = fixture.input;
      const query = { process, geometry: { ...geometry, holes: [...geometry.holes].reverse() }, fixture: setup };
      const match = await call(client, "plasticity_match_fastener_group_test", query);
      assert.equal(match.status, "matched"); assert.deepEqual(match.selected, saved.record);
      for (const change of [{ geometry: { ...geometry, thicknessMm: 4.01 } }, { fixture: { ...setup, clampCondition: "different clamp" } }, { process: { ...process, layerHeightMm: 0.3 } }]) {
        assert.equal((await call(client, "plasticity_match_fastener_group_test", { ...query, ...change })).status, "no-match");
      }
      const overlap = structuredClone(fixture.input); overlap.geometry.holes[1]!.xMm = 19;
      await rejected(client, "plasticity_record_fastener_group_test", overlap, /overlap|touch/i);
      const invalid = structuredClone(fixture.input); invalid.evidence[2]!.sourceHash = "bad";
      await rejected(client, "plasticity_record_fastener_group_test", invalid, /SHA-256/i);
      const conflict = fastenerTestFixture(410);
      await writeFile(join(output, "synthetic-conflict-source.json"), conflict.sourceText, { flag: "wx", mode: 0o600 });
      await call(client, "plasticity_record_fastener_group_test", conflict.input);
      const ambiguous = await call(client, "plasticity_match_fastener_group_test", query);
      assert.equal(ambiguous.status, "ambiguous"); assert.equal(ambiguous.selected, null);
      assert.equal((await call(client, listTool, {})).records.length, 2);
      evidence.exactMatchAndConflicts = true;
    } else {
      const isCurve = options.case === "interface-curve";
      const fixture = interfaceTestFixture(isCurve);
      const path = join(output, "synthetic-interface.csv"); await writeFile(path, fixture.sourceText, { flag: "wx", mode: 0o600 });
      if (!isCurve) {
        const specimens = fixture.input.specimenResults!.map(({ nominalPeakStrengthMPa: _, ...s }) => s);
        evidence.strength = await call(client, "plasticity_calculate_interface_specimen_strengths", { specimens });
        assertSpecimenSummary(evidence.strength);
        const excluded = await call(client, "plasticity_calculate_interface_specimen_strengths", { specimens: specimens.map(s => ({ ...s, failureLocation: "fixture" })) });
        assert.equal(excluded.summary.interfaceFailureCount, 0);
        for (const key of ["minimumPeakStrengthMPa", "maximumPeakStrengthMPa", "meanPeakStrengthMPa", "sampleStandardDeviationMPa"]) assert.equal(excluded.summary[key], null);
        evidence.preview = await call(client, "plasticity_import_interface_tensile_csv", { path, specimenIdColumn: "specimen", forceColumn: "force_N", forceUnit: "N", forceSign: "positive", delimiter: "comma", decimalSeparator: "period", specimens: specimens.map(({ specimenId, netCrossSectionMm2, failureLocation }) => ({ specimenId, netCrossSectionMm2, failureLocation })) });
        assertSpecimenSummary(evidence.preview);
      } else {
        evidence.preview = await call(client, "plasticity_import_interface_fracture_csv", { path, fractureMethod: "dcb-mode-i", processingAttestation: "already-compliance-corrected-traction-separation", specimenIdColumn: "specimen", separationColumn: "opening_um", tractionColumn: "traction_kPa", separationUnit: "um", tractionUnit: "kPa", delimiter: "comma", decimalSeparator: "period" });
        assertCurveSummary(evidence.preview.specimens[0].analysis);
      }
      assert.equal(evidence.preview.sourceHash, hash(fixture.sourceText));
      assert.equal(await readFile(path, "utf8"), fixture.sourceText, "CSV preview changed source bytes");
      assert.equal((await call(client, listTool, {})).records.length, 0, "Preview registered a test");
      const saved = await call(client, "plasticity_record_material_interface_test", fixture.input);
      assert.equal(saved.alreadyExisted, false);
      const repeated = await call(client, "plasticity_record_material_interface_test", fixture.input);
      assert.equal(repeated.alreadyExisted, true); assert.deepEqual(repeated.record, saved.record);
      const { materialProcess, testMode, interfaceNormalGlobal, loadDirectionGlobal, testProtocolHash } = fixture.input;
      const query = { materialProcess, testMode, interfaceNormalGlobal, loadDirectionGlobal, testProtocolHash };
      const match = await call(client, "plasticity_match_material_interface_test", query);
      assert.equal(match.status, "matched"); assert.deepEqual(match.selected, saved.record);
      assert.equal((await call(client, "plasticity_match_material_interface_test", { ...query, materialProcess: { ...materialProcess, layerHeightMm: 0.3 } })).status, "no-match");
      const wrongDirection = { ...fixture.input, loadDirectionGlobal: [1, 0, 0] };
      await rejected(client, "plasticity_record_material_interface_test", wrongDirection, /align|normal/i);
      if (isCurve) {
        const analyzed = await call(client, "plasticity_analyze_material_interface_test_curve", { recordId: saved.record.id });
        assertCurveSummary(analyzed.analysis); evidence.curve = analyzed;
        const incomplete = structuredClone(fixture.input); incomplete.tractionSeparationCurve!.points.at(-1)!.tractionMPa = 0.1;
        await rejected(client, "plasticity_record_material_interface_test", incomplete, /end at zero/i);
        await rejected(client, "plasticity_record_material_interface_test", { ...fixture.input, fractureMethod: "enf-mode-ii" }, /fractureMethod|dcb-mode-i/i);
      } else {
        assert.equal(saved.record.specimenResults[2].failureLocation, "printed-material");
        await rejected(client, "plasticity_analyze_material_interface_test_curve", { recordId: saved.record.id }, /classification|curve/i);
      }
    }
    const before = await call(client, listTool, {});
    evidence.beforeRestart = await unchanged(client, initial, snapshot);
    await client.close(); client = undefined; snapshot = undefined;
    client = await start();
    assert.deepEqual(await call(client, listTool, {}), before);
    if (evidence.curve) assert.deepEqual(await call(client, "plasticity_analyze_material_interface_test_curve", { recordId: evidence.curve.recordId }), evidence.curve);
    const after = await call(client, "plasticity_connect", { targetId: options.target });
    for (const key of ["documentToken", "revision", "undoDepth", "redoDepth"]) assert.equal(after[key], initial[key]);
    for (const key of ["bodies", "regions", "groups", "instances", "referenceMeshes", "measurements", "sectionAnalyses", "construction", "activePlaneId"]) assert.deepEqual(after[key], initial[key], `Restart changed ${key}`);
    evidence.restart = { recordsPreserved: true, curvePreserved: Boolean(evidence.curve), nativeIdentityAndHistoryUnchanged: true };
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
