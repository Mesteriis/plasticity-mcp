#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Evidence } from "../src/strength/contracts.ts";
import { exactMaterialCouponProcessSchema, materialCouponRecordInputSchema } from "../src/strength/material-qualification.ts";
import { isolatedAcceptanceEnvironment } from "./verify-native-measure-datum-files-live.ts";
import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
interface Options { help: boolean; allowLive: boolean; target?: string; output?: string; case?: "registry" | "calculation" }
export function parseMaterialCouponArgs(argv: string[]): Options {
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
      else { if (value !== "registry" && value !== "calculation") throw Error("--case must be registry or calculation"); options.case = value; }
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

// These are schema fixtures, never observations of a physical material. Source
// bytes and simulated measured metadata remain in the new isolated test store.
export function syntheticCouponFixture(kind: "elastic" | "strength" | "conflict" = "elastic") {
  const properties = kind === "strength" ? { youngModulusMPa: 2000, tensileStrengthMPa: 31 }
    : { youngModulusMPa: kind === "conflict" ? 2200 : 2000, shearModulusMPa: 740 };
  const sourceText = JSON.stringify({ fixture: "SYNTHETIC ONLY - NO PHYSICAL TEST", properties: { youngModulusMPa: kind === "conflict" ? 2200 : 2000, shearModulusMPa: 740, tensileStrengthMPa: 31 } });
  const sourceHash = createHash("sha256").update(sourceText).digest("hex");
  const evidence = Object.entries(properties).map(([key, value]) => ({
    id: `coupon-${key}`, label: `SYNTHETIC simulated measured ${key}; not physical data`,
    status: "measured" as const, unit: "MPa" as const, value,
    sourceUrl: "https://example.invalid/synthetic-coupon", sourceHash,
    sourceLocator: `SYNTHETIC fixture property:${key}`, dependsOn: [],
  }));
  const input = materialCouponRecordInputSchema.parse({
    process: { printerId: "synthetic-printer", materialId: "synthetic-not-printable", profileHash: "a".repeat(64),
      orientationDeg: [0, 0, 0], infillPercent: 100, infillPattern: "grid", wallLoops: 2,
      topShellLayers: 5, bottomShellLayers: 3, nozzleTemperatureC: 220, layerHeightMm: 0.2 },
    properties, propertyEvidence: Object.fromEntries(Object.keys(properties).map(key => [key, [`coupon-${key}`]])),
    evidence, testStandard: "SYNTHETIC schema fixture only", specimenCount: 3,
    testedAt: "2026-01-01T00:00:00.000Z", source: "physical-coupon-test", callerConfirmsPhysicalTests: true,
    notes: "SYNTHETIC acceptance simulation in isolated store; no physical tests were performed. Do not use for printing or engineering decisions.",
  });
  return { sourceText, input: { ...input, process: exactMaterialCouponProcessSchema.parse(input.process) } };
}

export function syntheticCouponScenario(method: "axial-rectangle-v1" | "cantilever-tip-rectangle-v1") {
  const forceN = method === "axial-rectangle-v1" ? 1 : 0.1;
  const values: Array<[string, Evidence["unit"], number]> = [
    ["lengthMm", "mm", 100], ["widthMm", "mm", 10], ["heightMm", "mm", 5], ["forceN", "N", forceN],
    ["safetyFactor", "ratio", 2], ["maxDisplacementMm", "mm", 2],
    ["material.tensileLimitMPa", "MPa", 15], ["material.compressiveLimitMPa", "MPa", 20],
  ];
  const evidence: Evidence[] = values.map(([id, unit, value]) => ({ id, label: `SYNTHETIC ONLY ${id}`, status: "assumed", unit: unit!, value, dependsOn: [] }));
  return { process: syntheticCouponFixture().input.process,
    scenario: { goal: "SYNTHETIC coupon-backed scenario, not physical qualification", method,
      lengthMm: 100, widthMm: 10, heightMm: 5, forceN, safetyFactor: 2, maxDisplacementMm: 2,
      evidence, assignments: Object.fromEntries(values.map(([id]) => [id, id])),
      assumptions: ["static-load", "ideal-support", "linear-elastic", "homogeneous-equivalent-section", "negligible-shear-deformation", "no-lateral-instability"].map(code => ({ code, confirmed: true, evidenceIds: [] as string[] })),
    }, allowables: { tensileMPa: 15, compressiveMPa: 20 },
    allowablesBasis: "SYNTHETIC independent assumed allowables; never derived from coupon peak strengths", effectiveSection: "solid" as const,
  };
}

export function assertCouponCalculation(report: any, method: "axial-rectangle-v1" | "cantilever-tip-rectangle-v1", heightMm = 5) {
  assert.equal(report.input.method, method); assert.equal(report.result.method, method);
  assert.equal(report.result.status, "conditional");
  assert.equal(report.input.material.youngMPa, 2000);
  assert.equal(report.input.material.tensileLimitMPa, 15);
  assert.equal(report.input.material.compressiveLimitMPa, 20);
  assert.equal(report.input.material.suitability, "unconfirmed");
  assert.equal(report.input.binding, undefined, "Scenario must not acquire a CAD binding");
  assert(report.result.issues.some((issue: any) => issue.code === "MATERIAL_UNCONFIRMED"));
  const area = 10 * heightMm;
  const stress = method === "axial-rectangle-v1" ? 1 / area : 6 * 0.1 * 100 / (10 * heightMm ** 2);
  const displacement = method === "axial-rectangle-v1" ? 100 / (2000 * area) : 4 * 0.1 * 100 ** 3 / (2000 * 10 * heightMm ** 3);
  near(report.result.stressMPa, stress); near(report.result.displacementMm, displacement);
  near(report.result.strengthUtilization, stress * 2 / 15);
  near(report.result.displacementUtilization, displacement / 2);
}

const HELP = `Usage: npm run accept:material-coupon -- --target ID --allow-live --case registry|calculation --output NEW_DIRECTORY
No args/--help are inert. Synthetic-only production stdio acceptance with isolated
stores and explicit experimental Plasticity connection. Writes only owned test
records/reports; no CAD mutations, physical-test claim, network requests or Codex analysis turns.`;

async function main() {
  const options = parseMaterialCouponArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!); await mkdir(output, { mode: 0o700 });
  const evidence: any = { schemaVersion: 1, startedAt: new Date().toISOString(), case: options.case, syntheticOnly: true, physicalTestsPerformed: false };
  let client: Client | undefined; let initial: any; let snapshot: any;
  const start = async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts/run-server.ts")], cwd: projectRoot,
      env: isolatedAcceptanceEnvironment(join(output, "stores"), process.env), stderr: "pipe" });
    const next = new Client({ name: "plasticity-material-coupon-live", version: "1.0.0" });
    await next.connect(transport); return next;
  };
  try {
    client = await start();
    const windows = await call(client, "plasticity_list_windows", {});
    assert(windows.some((w: any) => w.targetId === options.target), "Explicit experimental target missing");
    initial = await call(client, "plasticity_connect", { targetId: options.target });
    snapshot = await call(client, "plasticity_capture_snapshot", { label: "material-coupon-readonly-baseline" });
    assert.deepEqual((await call(client, "plasticity_list_material_coupon_data", {})).records, []);
    const records: any[] = [];
    for (const kind of ["elastic", "strength"] as const) {
      const fixture = syntheticCouponFixture(kind);
      await writeFile(join(output, `${kind}-synthetic-source.json`), fixture.sourceText, { flag: "wx", mode: 0o600 });
      const saved = await call(client, "plasticity_record_material_coupon_data", fixture.input);
      assert.equal(saved.alreadyExisted, false); records.push(saved.record);
      const repeated = await call(client, "plasticity_record_material_coupon_data", fixture.input);
      assert.equal(repeated.alreadyExisted, true); assert.deepEqual(repeated.record, saved.record);
    }
    const process = syntheticCouponFixture().input.process;
    assert.equal((await call(client, "plasticity_match_material_coupon_data", { process })).status, "ambiguous");
    const composed = await call(client, "plasticity_combine_material_coupon_data", { recordIds: records.map(r => r.id), specimenCount: 6 });
    assert.deepEqual(composed.record.composedFromRecordIds, records.map(r => r.id).sort());
    assert.deepEqual(composed.record.properties, { youngModulusMPa: 2000, shearModulusMPa: 740, tensileStrengthMPa: 31 });
    assert.equal(composed.record.specimenCount, 6);
    const match = await call(client, "plasticity_match_material_coupon_data", { process });
    assert.equal(match.status, "matched"); assert.deepEqual(match.selected, composed.record);
    evidence.recordIds = [...records, composed.record].map(r => r.id);

    if (options.case === "registry") {
      for (const change of [{ orientationDeg: [0, 90, 0] }, { layerHeightMm: 0.3 }, { profileHash: "b".repeat(64) }, { infillPercent: 99 }, { wallLoops: 3 }]) {
        assert.equal((await call(client, "plasticity_match_material_coupon_data", { process: { ...process, ...change } })).status, "no-match");
      }
      await rejected(client, "plasticity_combine_material_coupon_data", { recordIds: [records[0].id, records[0].id], specimenCount: 6 }, /unique/i);
      const invalid = syntheticCouponFixture().input; invalid.evidence[0]!.sourceHash = "bad";
      await rejected(client, "plasticity_record_material_coupon_data", invalid, /SHA-256|sourceHash/i);
      const conflictingFixture = syntheticCouponFixture("conflict");
      await writeFile(join(output, "conflict-synthetic-source.json"), conflictingFixture.sourceText, { flag: "wx", mode: 0o600 });
      const conflict = await call(client, "plasticity_record_material_coupon_data", conflictingFixture.input);
      await rejected(client, "plasticity_combine_material_coupon_data", { recordIds: [records[0].id, conflict.record.id], specimenCount: 6 }, /conflict/i);
      assert.equal((await call(client, "plasticity_match_material_coupon_data", { process })).status, "ambiguous");
      assert.equal((await call(client, "plasticity_list_material_coupon_data", {})).records.length, 4);
      evidence.conflictsRejected = true;
    } else {
      const plan = await call(client, "plasticity_plan_single_material_strength_tests", { process, scopes: ["layerwise-elastic-response", "directional-strength-screen"] });
      assert.deepEqual(plan.process, process); assert.equal(plan.axisConvention.confirmationRequired, true);
      for (const id of ["E1", "E2", "E3", "G12", "G13", "G23", "X_T", "Z_T", "biaxial-12"]) assert(plan.tasks.some((task: any) => task.id === id));
      evidence.reports = [];
      for (const method of ["axial-rectangle-v1", "cantilever-tip-rectangle-v1"] as const) {
        const args = syntheticCouponScenario(method);
        const result = await call(client, "plasticity_calculate_rectangular_strength_from_coupon_data", args);
        assert.equal(result.status, "calculated-conditional"); assert.equal(result.couponRecordId, composed.record.id);
        assertCouponCalculation(result.report, method); evidence.reports.push(result.report);
        const heights = method === "axial-rectangle-v1" ? [10, 5, 8] : [5, 4, 4.5];
        const sizing = await call(client, "plasticity_size_member", { input: result.report.input, heightsMm: heights });
        assert.deepEqual(sizing.candidates.map((c: any) => c.heightMm), [...heights].sort((a, b) => a - b));
        assert.equal(sizing.recommendation, "conditional"); assert.equal(sizing.recommendedHeightMm, Math.min(...heights));
        for (const candidate of sizing.candidates) assertCouponCalculation({ input: result.report.input, result: candidate.result }, method, candidate.heightMm);
        await rejected(client, "plasticity_size_member", { input: result.report.input, heightsMm: [5, 5] }, /unique/i);
      }
      const args = syntheticCouponScenario("cantilever-tip-rectangle-v1");
      await rejected(client, "plasticity_calculate_rectangular_strength_from_coupon_data", { ...args, allowables: { tensileMPa: 15 } }, /compressive allowable/i);
      const noMatch = await call(client, "plasticity_calculate_rectangular_strength_from_coupon_data", { ...args, process: { ...process, layerHeightMm: 0.3 } });
      assert.equal(noMatch.status, "no-match"); assert.equal(noMatch.report, undefined);
      const outside = syntheticCouponScenario("cantilever-tip-rectangle-v1");
      outside.scenario.forceN = 1;
      outside.scenario.evidence.find(e => e.id === "forceN")!.value = 1;
      const unsupported = await call(client, "plasticity_calculate_rectangular_strength_from_coupon_data", outside);
      assert.equal(unsupported.report.result.status, "unsupported");
      assert(unsupported.report.result.issues.some((i: any) => i.code === "DEFLECTION_RATIO_OUTSIDE_PRODUCT_LIMIT"));
      const thick = await call(client, "plasticity_size_member", { input: evidence.reports[1].input, heightsMm: [10] });
      assert.equal(thick.recommendation, "none"); assert.equal(thick.recommendedHeightMm, null);
      assert(thick.candidates[0].result.issues.some((i: any) => i.code === "SLENDERNESS_OUTSIDE_PRODUCT_LIMIT"));
      evidence.methodLimitsRejected = true;
      evidence.planTaskCount = plan.tasks.length;
    }
    const before = await call(client, "plasticity_list_material_coupon_data", {});
    evidence.beforeRestart = await unchanged(client, initial, snapshot);
    await client.close(); client = undefined; snapshot = undefined;
    client = await start();
    assert.deepEqual(await call(client, "plasticity_list_material_coupon_data", {}), before);
    for (const report of evidence.reports ?? []) {
      const recovered = await call(client, "plasticity_strength_report", { reportId: report.id });
      assert.deepEqual(recovered.report, report);
    }
    const after = await call(client, "plasticity_connect", { targetId: options.target });
    for (const key of ["documentToken", "revision", "undoDepth", "redoDepth"]) assert.equal(after[key], initial[key]);
    for (const key of ["bodies", "regions", "groups", "instances", "referenceMeshes", "measurements", "sectionAnalyses", "construction", "activePlaneId"]) assert.deepEqual(after[key], initial[key], `Restart changed ${key}`);
    evidence.restart = { recordsPreserved: true, reportsPreserved: true, nativeIdentityAndHistoryUnchanged: true };
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
