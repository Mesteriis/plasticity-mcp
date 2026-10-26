#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { syntheticCouponFixture } from "./verify-material-coupon-live.ts";
import { isolatedAcceptanceEnvironment } from "./native-live-environment.ts";
import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
interface Options { help: boolean; allowDisposableMutations: boolean; target?: string; output?: string; case?: "scenarios" | "coupon-root" | "thread-registry" }
export function parseStrengthCatalogArgs(argv: string[]): Options {
  const options: Options = { help: argv.length === 0, allowDisposableMutations: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--help") options.help = true;
    else if (flag === "--allow-disposable-mutations") options.allowDisposableMutations = true;
    else if (["--target", "--output", "--case"].includes(flag ?? "")) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw Error(`${flag} requires a value`);
      if (flag === "--target") options.target = value;
      else if (flag === "--output") options.output = value;
      else { if (!["scenarios", "coupon-root", "thread-registry"].includes(value)) throw Error("--case must be scenarios, coupon-root or thread-registry"); options.case = value as NonNullable<Options["case"]>; }
    } else throw Error(`Unknown argument: ${flag}`);
  }
  if (!options.help) {
    if (!options.target) throw Error("--target is required");
    if (!options.allowDisposableMutations) throw Error("--allow-disposable-mutations is required");
    if (!options.output) throw Error("--output must name a new directory");
    if (!options.case) throw Error("--case is required");
  }
  return options;
}


// These modules contain only pure synthetic fixture factories (no tests or I/O).
import { fastenerScenarioFixture } from "../src/strength/fastener-fixtures.test.ts";
import { fastenerMemberFixture } from "../src/strength/fastener-member-fixtures.test.ts";
import { insertRetentionFixture } from "../src/strength/insert-retention-fixtures.test.ts";
import { tongueRootFixture } from "../src/strength/tongue-root-fixtures.test.ts";
import { fastenerGroupFixture } from "../src/strength/fastener-group-fixtures.test.ts";
import { isDisposableEmptyDocument } from "./verify-strength-live.ts";
import { permitsNativeFailureRecovery } from "./native-live-recovery.ts";

export function strengthScenarioCases(): Array<{ tool: string; input: any; gate: (report: any) => void }> {
  return [
    { tool: "plasticity_calculate_single_fastener_strength", input: fastenerScenarioFixture(), gate: (r: any) => { near(r.result.stressMPa.bearing, 10); near(r.result.stressMPa.shearOut, 100/30); near(r.result.stressMPa.netTension, 2.5); } },
    { tool: "plasticity_calculate_fastener_member_strength", input: fastenerMemberFixture(), gate: (r: any) => { near(r.result.stressMPa.tension, 50); near(r.result.stressMPa.shear, 500/(Math.PI*9)); near(r.result.interactionValue, 0.2**2+(1000/(300*Math.PI*9))**3); } },
    { tool: "plasticity_calculate_heat_set_insert_retention", input: insertRetentionFixture(), gate: (r: any) => { near(r.result.utilization.pullout, 0.5); near(r.result.utilization.torqueOut, 0); near(r.result.minimumHoleDepthGuidanceMm, 5); } },
    { tool: "plasticity_calculate_tongue_root_strength", input: tongueRootFixture(), gate: (r: any) => assertRootScreen(r, 700) },
    { tool: "plasticity_distribute_fastener_group_load", input: fastenerGroupFixture(), gate: (r: any) => { near(r.result.totalMomentAboutCentroidNmm, -3000); near(r.result.polarSumMm2, 2000); assert.deepEqual(r.result.fasteners.map((f: any) => [f.resultantN.x,f.resultantN.y]), [[10,30],[10,-30],[40,30],[40,-30]]); near(r.result.equilibrium.forceResidualN, 0); near(r.result.equilibrium.momentResidualNmm, 0); } },
  ].map(c => ({ ...c, input: { ...c.input, goal: "SYNTHETIC SOFTWARE SCENARIO ONLY: " + c.input.goal } }));
}
export function assertRootScreen(report: any, shearMPa: number) {
  assert.equal(report.result.status, "conditional");
  near(report.result.stressMPa.rootBending, 4.8); near(report.result.stressMPa.maximumTransverseShear, 0.3);
  near(report.result.deflectionMm.bending, 0.128); near(report.result.deflectionMm.shear, 200/((5/6)*shearMPa*50));
}
export function couponRootArgs() {
  const { material, ...scenario } = tongueRootFixture();
  scenario.goal = "SYNTHETIC ONLY coupon-backed root screen; not physical strength";
  const assignments = { ...scenario.assignments };
  delete assignments["material.youngModulusMPa"]; delete assignments["material.shearModulusMPa"];
  const evidence = scenario.evidence.filter(e => e.id !== "material.youngModulusMPa" && e.id !== "material.shearModulusMPa");
  return { process: syntheticCouponFixture().input.process, scenario: { ...scenario, assignments, evidence },
    allowables: { tensileMPa: material.tensileAllowableMPa, shearMPa: material.shearAllowableMPa },
    allowablesBasis: "SYNTHETIC independent assumed design allowables, not raw coupon peak strength", effectiveSection: "solid" };
}
export function syntheticThreadFit() {
  return { process: { printerId: "synthetic-printer", materialId: "synthetic-not-printable", slicingProfileId: "synthetic-profile", nozzleDiameterMm: 0.4, layerHeightMm: 0.2, orientation: "SYNTHETIC axes vertical", clearanceBasis: "SYNTHETIC fixture only" },
    thread: { profile: "rounded-print-v1", nominalCrestDiameterMm: 5, pitchMm: 1.25, threadDepthMm: 0.6, handedness: "right" },
    selectedSampleId: "synthetic-clearance-0.15", profileClearanceMm: 0.15, fitClass: "normal", testedEngagementLengthMm: 12, cyclesCompleted: 20, testLoadN: 40, testTemperatureC: 23,
    testedAt: "2026-01-01T00:00:00.000Z", notes: "SYNTHETIC registry contract only; no physical fit tests performed", source: "physical-calibration-specimen", confirmedPhysicalTest: true };
}
const HELP = `Usage: npm run accept:strength-catalog -- --target ID --allow-disposable-mutations --case scenarios|coupon-root|thread-registry --output NEW_DIRECTORY
No args/--help are inert. Synthetic-only production stdio verification in isolated
stores. Coupon-root creates/undoes one owned box in the explicit experimental copy.
No physical qualifications, network requests or Codex analysis turns are claimed.`;
async function main() {
  const options = parseStrengthCatalogArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!); await mkdir(output, { mode: 0o700 });
  const evidence: any = { schemaVersion: 1, startedAt: new Date().toISOString(), case: options.case, syntheticOnly: true, physicalTestsPerformed: false };
  let client: Client | undefined; let initial: any; let snapshot: any; let ownedState: any;
  const start = async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts/run-server.ts")], cwd: projectRoot,
      env: isolatedAcceptanceEnvironment(join(output, "stores"), process.env), stderr: "pipe" });
    const next = new Client({ name: "plasticity-strength-catalog-live", version: "1.0.0" });
    await next.connect(transport); return next;
  };
  try {
    client = await start();
    const windows = await call(client, "plasticity_list_windows", {});
    assert(windows.some((w: any) => w.targetId === options.target), "Explicit experimental target missing");
    initial = await call(client, "plasticity_connect", { targetId: options.target });
    snapshot = await call(client, "plasticity_capture_snapshot", { label: "strength-catalog-baseline" });
    assert(isDisposableEmptyDocument(initial), "Refusing nonempty or dirty native qualification document");
    const reports: any[] = [];
    if (options.case === "scenarios") {
      for (const c of strengthScenarioCases()) {
        const report = await call(client, c.tool, c.input); c.gate(report);
        assert.match(report.result.checkedScope, /scenario/i); assert.equal(report.input.binding, undefined);
        reports.push(report);
      }
    } else if (options.case === "thread-registry") {
      assert.deepEqual((await call(client, "plasticity_list_printed_thread_qualifications", {})).records, []);
      const input = syntheticThreadFit();
      const saved = await call(client, "plasticity_record_printed_thread_qualification", input);
      assert.equal(saved.alreadyExisted, false);
      const repeated = await call(client, "plasticity_record_printed_thread_qualification", input);
      assert.equal(repeated.alreadyExisted, true); assert.deepEqual(repeated.record, saved.record);
      const query = { process: input.process, thread: input.thread, requiredEngagementLengthMm: 8 };
      const match = await call(client, "plasticity_match_printed_thread_qualification", query);
      assert.equal(match.status, "matched"); assert.equal(match.selected.id, saved.record.id);
      for (const changed of [{ requiredEngagementLengthMm: 13 }, { process: { ...input.process, layerHeightMm: 0.3 } }]) assert.equal((await call(client, "plasticity_match_printed_thread_qualification", { ...query, ...changed })).status, "no-match");
      await rejected(client, "plasticity_record_printed_thread_qualification", { ...input, confirmedPhysicalTest: false }, /true/i);
      await call(client, "plasticity_record_printed_thread_qualification", { ...input, selectedSampleId: "synthetic-other", profileClearanceMm: 0.2 });
      const conflict = await call(client, "plasticity_match_printed_thread_qualification", query);
      assert.equal(conflict.status, "ambiguous"); assert.equal(conflict.selected, null);
      evidence.threadRecords = await call(client, "plasticity_list_printed_thread_qualifications", {});
      assert.equal(evidence.threadRecords.records.length, 2);
    } else {
      const fixture = syntheticCouponFixture();
      await writeFile(join(output, "synthetic-root-coupon-source.json"), fixture.sourceText, { flag: "wx", mode: 0o600 });
      const coupon = await call(client, "plasticity_record_material_coupon_data", fixture.input);
      const args = couponRootArgs();
      const calculated = await call(client, "plasticity_calculate_tongue_root_strength_from_coupon_data", args);
      assert.equal(calculated.status, "calculated-conditional"); assert.equal(calculated.couponRecordId, coupon.record.id);
      assertRootScreen(calculated.report, 740); assert.equal(calculated.report.input.binding, undefined); reports.push(calculated.report);
      const noMatch = await call(client, "plasticity_calculate_tongue_root_strength_from_coupon_data", { ...args, process: { ...args.process, layerHeightMm: 0.3 } });
      assert.equal(noMatch.status, "no-match"); assert.equal(noMatch.report, undefined);
      ownedState = await call(client, "plasticity_create_box", { originMm: [0,0,0], sizeMm: [30,10,5], name: "SYNTHETIC coupon root", revision: initial.revision, intent: "Owned disposable coupon-root verification" });
      const bodyId = ownedState.bodies[0].id;
      const sections = await call(client, "plasticity_inspect_arbitrary_sections", { bodyId, revision: ownedState.revision, planes: [{ originMm: [5,0,0], normal: [1,0,0], xDirection: [0,1,0] }] });
      assert.equal(sections.sections[0].status, "verified");
      const verified = await call(client, "plasticity_verify_tongue_root_strength_from_coupon_data", { ...args, scenario: { ...args.scenario, binding: sections.sections[0].binding } });
      assertRootScreen(verified.report, 740); assert.equal(verified.couponRecordId, coupon.record.id);
      assert.deepEqual(verified.report.input.geometry, { rootWidthMm: 10, rootThicknessMm: 5, leverArmMm: 20 });
      reports.push(verified.report);
      const current = await call(client, "plasticity_status", {});
      assert.equal(current.documentToken, ownedState.documentToken); assert.equal(current.revision, ownedState.revision);
      await call(client, "plasticity_undo", { revision: current.revision, intent: "Restore owned coupon-root fixture" }); ownedState = undefined;
      const view = await call(client, "plasticity_strength_report", { reportId: verified.report.id }); assert.equal(view.freshness, "stale");
    }
    const before = await call(client, "plasticity_status", {});
    assert.equal(before.documentToken, initial.documentToken); assert.equal(before.bodies.length, 0);
    assert(!hasSceneContentChanges((await call(client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId })).diff));
    if (options.case !== "coupon-root") evidence.readOnly = await unchanged(client, initial, snapshot);
    else { const journal = await call(client, "plasticity_construction_journal", {}); assert.equal(journal.syncStatus, "in-sync"); assert(journal.entries.every((e: any) => e.status === "completed")); }
    evidence.reports = reports;
    await client.close(); client = undefined; snapshot = undefined; client = await start();
    for (const r of reports) assert.deepEqual((await call(client, "plasticity_strength_report", { reportId: r.id })).report, r);
    if (evidence.threadRecords) assert.deepEqual(await call(client, "plasticity_list_printed_thread_qualifications", {}), evidence.threadRecords);
    const after = await call(client, "plasticity_connect", { targetId: options.target });
    for (const key of ["documentToken", "revision", "undoDepth", "redoDepth", "bodies", "regions", "groups", "instances", "referenceMeshes", "measurements", "sectionAnalyses"]) assert.deepEqual(after[key], before[key], `Restart changed ${key}`);
    evidence.restart = { reportsAndRecordsPreserved: true, nativeStatePreserved: true };
    evidence.completedAt = new Date().toISOString(); await writeEvidence(join(output, "evidence.json"), evidence);
    console.log(JSON.stringify({ ok: true, output }));
  } catch (error) {
    evidence.error = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
    if (client && initial && ownedState && permitsNativeFailureRecovery(error)) {
      const current = await call(client, "plasticity_status", {});
      if (current.documentToken === ownedState.documentToken && current.revision === ownedState.revision) evidence.cleanup = await call(client, "plasticity_undo", { revision: current.revision, intent: "Restore owned failed coupon-root fixture" });
    }
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
