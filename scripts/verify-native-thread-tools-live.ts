#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isolatedAcceptanceEnvironment } from "./verify-native-measure-datum-files-live.ts";

import { hydrateNativeState } from "./native-live-state.ts";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const THREAD_TOOL_CASES = ["external-right", "external-left", "internal-right", "internal-left", "hex-nut", "hex-screw", "internal-right-integral", "internal-left-integral", "hex-nut-integral", "fractional-preflight"] as const;
type ThreadToolCase = typeof THREAD_TOOL_CASES[number];

interface Options { case: ThreadToolCase; help: boolean; target?: string; output?: string; allowDisposableMutations: boolean }

export function parseNativeThreadToolsAcceptanceArgs(argv: string[]): Options {
  const options: Options = { help: argv.length === 0, allowDisposableMutations: false, case: "external-right" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--allow-disposable-mutations") options.allowDisposableMutations = true;
    else if (argument === "--target" || argument === "--output" || argument === "--case") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      if (argument === "--target") options.target = value;
      else if (argument === "--output") options.output = value;
      else {
        if (!(THREAD_TOOL_CASES as readonly string[]).includes(value)) throw new Error(`Unknown catalog case: ${value}`);
        options.case = value as ThreadToolCase;
      }
    } else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Live native-thread-tools acceptance requires --target with an explicit Plasticity window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native-thread-tools acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native-thread-tools acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-thread-tools-live.ts --help
  node scripts/verify-native-thread-tools-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

Cases: ${THREAD_TOOL_CASES.join(", ")} (select with --case).

Original internal-right/internal-left/hex-nut inputs request fractional turns
and remain unsupported. Use their -integral variants for whole-turn qualification;
fractional-preflight verifies rejection without geometry changes.

No-argument and --help modes do not connect to Plasticity. Live mode requires
an explicit empty disposable document, verifies native custom rounded printed-thread tools and
mass properties through stdio MCP, checks Undo/Redo, restores the scene, and
writes sanitized evidence.`;

async function main(): Promise<void> {
  const options = parseNativeThreadToolsAcceptanceArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  await mkdir(output, { recursive: false, mode: 0o700 });
  const evidence: Record<string, unknown> = { schemaVersion: 1, startedAt: new Date().toISOString(), targetId: options.target, workbenchUsed: false };
  let client: Client | undefined;
  let initial: any;
  let state: any;
  try {
    client = await startMcp(join(output, "strength-store"));
    const windows = await call(client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    initial = await call(client, "plasticity_connect", { targetId: options.target });
    requireEmpty(initial);
    evidence.initial = summary(initial);
    const snapshot = await call(client, "plasticity_capture_snapshot", { label: "native-thread-tools-acceptance-initial-empty" });

    evidence.case = options.case;
    state = initial;
    const mutate = async (name: string, args: Record<string, unknown>): Promise<any> => {
      const result = await call(client!, name, { ...args, revision: state.revision });
      if (result.status === "completed" && result.afterRevision) {
        state = await call(client!, "plasticity_status", {});
        requireCondition(result.documentToken === state.documentToken && result.afterRevision === state.revision, "Recipe report/current native state mismatch");
      } else state = result;
      return result;
    };
    const female = options.case.startsWith("internal-") || options.case.startsWith("hex-nut");
    const handedness = options.case.includes("-left") ? "left" : "right";
    const overshoot = options.case.endsWith("-integral") ? 1 : 0.5;
    const extendedLength = 4 + 2 * overshoot;
    const definition = { nominalDiameterMm: 8, pitchMm: 2, threadDepthMm: 0.8, radialDirection: [1, 0, 0], handedness };
    evidence.fixtureParameters = { ...definition, cutterOvershootMm: overshoot, nominalLengthMm: 4, envelopeToleranceMm: 0.01 };
    await mutate("plasticity_create_box", { originMm: [30, 0, 0], sizeMm: [2, 3, 4] });
    const controlId = state.bodies[0].id;
    let targetId: number | undefined;
    if (options.case.startsWith("internal-") || options.case === "fractional-preflight") {
      await mutate("plasticity_create_box", { originMm: [-8, -8, 0], sizeMm: [16, 16, 4] });
      targetId = state.bodies.find((body: any) => body.id !== controlId).id;
    }
    if (options.case === "fractional-preflight") {
      const errors: string[] = [];
      const requests: Array<[string, Record<string, unknown>]> = [
        ["plasticity_create_helix", { axisStartMm: [0,0,0], axisEndMm: [0,0,5], radiusMm: 3.6, turns: 2.5, radialDirection: [1,0,0], handedness: "right" }],
        ["plasticity_create_printed_external_thread", { ...definition, axisStartMm: [0,0,0], axis: [0,0,1], threadLengthMm: 5 }],
        ["plasticity_cut_printed_internal_thread", { ...definition, targetId, entryCenterMm: [0,0,0], axis: [0,0,1], materialDepthMm: 4, profileClearanceMm: 0.2, cutterOvershootMm: 0.5 }],
        ["plasticity_create_printed_hex_nut", { ...definition, entryCenterMm: [0,0,0], axis: [0,0,1], flatNormalDirection: [1,0,0], acrossFlatsMm: 12, thicknessMm: 4, minimumWallThicknessMm: 1, profileClearanceMm: 0.2, cutterOvershootMm: 0.5 }],
        ["plasticity_create_printed_hex_screw", { ...definition, axisStartMm: [0,0,0], axis: [0,0,1], threadLengthMm: 5, flatNormalDirection: [1,0,0], headAcrossFlatsMm: 12, headHeightMm: 3, junctionOverlapMm: 0.5 }],
      ];
      for (const [tool, args] of requests) {
        const before = state; let message = "";
        try { await call(client, tool, { ...args, revision: state.revision }); } catch (error) { message = error instanceof Error ? error.message : String(error); }
        requireCondition(/Fractional Helix turns are unsupported/.test(message), "Fractional preflight did not reject: " + tool + ": " + message);
        state = await call(client, "plasticity_status", {});
        requireCondition(state.revision === before.revision && state.undoDepth === before.undoDepth && state.redoDepth === before.redoDepth, "Fractional rejection changed native state/history");
        errors.push(message);
      }
      while (state.undoDepth > initial.undoDepth) await mutate("plasticity_undo", {});
      requireEmpty(state);
      const changes = await call(client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
      requireCondition(!hasSceneContentChanges(changes.diff), "Fractional preflight fixture not restored");
      const durable = await call(client, "plasticity_construction_history", { limit: 100 });
      requireCondition(durable.total === 9 && durable.entries.filter((entry: any) => entry.status === "failed").length === 5, "Fractional preflight durable history mismatch");
      evidence.preflight = { rejectedTools: requests.map(([tool]) => tool), errors, noNativeRecipeMutation: true };
      evidence.cleanup = { restoredEmptyDocument: true }; evidence.completedAt = new Date().toISOString();
      await writeExclusive(join(output, "evidence.json"), sanitizeEvidence(evidence));
      console.log(JSON.stringify({ ok: true, output })); return;
    }
    const nominalMin = options.case.startsWith("internal-") ? [-8,-8,0] : options.case.startsWith("hex-nut") ? [-6,-4*Math.sqrt(3),0] : options.case === "hex-screw" ? [-6,-4*Math.sqrt(3),-3] : [-4,-4,0];
    const nominalMax = options.case.startsWith("internal-") ? [8,8,4] : options.case.startsWith("hex-") ? [6,4*Math.sqrt(3),4] : [4,4,4];
    // Fixed 0.01 mm envelope; native temporary intersections also validate legacy geometry.
    const envelopeProbeIds: number[] = [];
    for (let axis = 0; axis < 3; axis += 1) for (const side of [-1, 1]) {
      const origin = [-32,-32,-32]; const size = [64,64,64];
      if (side > 0) { origin[axis] = nominalMax[axis]! + 0.01; size[axis] = 32 - origin[axis]!; }
      else size[axis] = nominalMin[axis]! - 0.01 + 32;
      const beforeIds = new Set(state.bodies.map((body: any) => body.id));
      await mutate("plasticity_create_box", { originMm: origin, sizeMm: size });
      const added = state.bodies.filter((body: any) => !beforeIds.has(body.id)); requireCondition(added.length === 1, "Envelope probe creation failed"); envelopeProbeIds.push(added[0].id);
    }
    const source = state;
    const sourceSnapshot = await call(client, "plasticity_capture_snapshot", { label: "thread-tool-source" });
    let steps = 6;
    let report: any;
    if (options.case.startsWith("external-")) {
      report = await mutate("plasticity_create_printed_external_thread", { ...definition, axisStartMm: [0, 0, 0], axis: [0, 0, 1], threadLengthMm: 4 });
    } else if (options.case.startsWith("internal-")) {
      steps = 4;
      report = await mutate("plasticity_cut_printed_internal_thread", { ...definition, targetId, entryCenterMm: [0, 0, 0], axis: [0, 0, 1], materialDepthMm: 4, profileClearanceMm: 0.2, cutterOvershootMm: overshoot });
    } else if (options.case.startsWith("hex-nut")) {
      report = await mutate("plasticity_create_printed_hex_nut", { ...definition, entryCenterMm: [0, 0, 0], axis: [0, 0, 1], flatNormalDirection: [1, 0, 0], acrossFlatsMm: 12, thicknessMm: 4, minimumWallThicknessMm: 1, profileClearanceMm: 0.2, cutterOvershootMm: overshoot });
    } else {
      steps = 9;
      report = await mutate("plasticity_create_printed_hex_screw", { ...definition, axisStartMm: [0, 0, 0], axis: [0, 0, 1], threadLengthMm: 4, flatNormalDirection: [1, 0, 0], headAcrossFlatsMm: 12, headHeightMm: 3, junctionOverlapMm: 0.5 });
    }
    evidence.recipe = report;
    requireCondition(report.status === "completed" && report.undoSteps === steps && report.steps.length === steps && state.undoDepth === source.undoDepth + steps, "Thread recipe/native history contract mismatch");
    near(report.turns, female ? extendedLength / 2 : 2, 1e-12, "reported helix turns");
    requireCondition(report.geometry.profile === "rounded-print-v1", "Unexpected printed-thread profile");
    near(report.geometry.nominalCrestDiameterMm, 8, 1e-12, "crest diameter"); near(report.geometry.coreDiameterMm, 6.4, 1e-12, "core diameter"); near(report.geometry.helixDiameterMm, 7.2, 1e-12, "helix diameter"); near(report.geometry.maleProfileDiameterMm, 0.88, 1e-12, "male profile diameter");
    if (female) { near(report.geometry.femaleBoreDiameterMm, 6.8, 1e-12, "bore diameter"); near(report.geometry.femaleGrooveDiameterMm, 1.28, 1e-12, "groove diameter"); near(report.geometry.femaleGrooveOuterDiameterMm, 8.48, 1e-12, "groove outer diameter"); }
    const resultId = report.resultBodyId ?? report.targetId;
    const profileId = report.profileBodyId ?? report.headProfileBodyId;
    let initialVolume: number | undefined;
    const check = async (): Promise<void> => {
      evidence.observedBodies = state.bodies.map((body: any) => ({ id: body.id, type: body.type, boundsMm: body.boundsMm }));
      const beforeRead = state;
      const solids = state.bodies.filter((body: any) => body.type === "Solid");
      const wires = state.bodies.filter((body: any) => body.type === "Wire");
      requireCondition(solids.length === 2 + envelopeProbeIds.length && wires.length === (profileId === undefined ? 1 : 2) && state.bodies.length === solids.length + wires.length, "Unexpected thread result, retained profiles or leftover cutters");
      requireCondition(JSON.stringify(state.bodies.find((body: any) => body.id === controlId)) === JSON.stringify(source.bodies.find((body: any) => body.id === controlId)), "Thread recipe changed the unrelated control body");
      for (const original of source.bodies.filter((body: any) => body.id !== targetId)) requireCondition(JSON.stringify(state.bodies.find((body: any) => body.id === original.id)) === JSON.stringify(original), "Thread recipe changed an envelope probe/control");
      const result = solids.find((body: any) => body.id === resultId);
      requireCondition(result && wires.some((body: any) => body.id === report.helixBodyId), "Thread body or editable Helix ID missing");
      requireCondition(report.consumedToolIds.every((id: number) => !state.bodies.some((body: any) => body.id === id)), "Thread recipe left a consumed cutter");
      const ids = solids.map((body: any) => body.id);
      const validation = await call(client!, "plasticity_validate_bodies", { ids, revision: state.revision });
      requireCondition(validation.bodies.length === ids.length && ids.every((id: number) => validation.bodies.some((body: any) => body.id === id && body.nativeValid && body.printableSolid && body.nativeCheckCodes.length === 0)), "Thread output failed native Solid validation");
      const mass = await call(client!, "plasticity_measure_solid_properties", { ids, revision: state.revision });
      requireCondition(mass.bodies.length === ids.length && ids.every((id: number) => mass.bodies.some((body: any) => body.id === id)), "Incomplete thread mass identities");
      near(mass.bodies.find((body: any) => body.id === controlId).volumeMm3, 24, 0.0001, "control volume");
      const volume = mass.bodies.find((body: any) => body.id === resultId).volumeMm3;
      const hexArea = 72 * Math.sqrt(3);
      const blankVolume = options.case.startsWith("hex-nut") ? hexArea * 4 : 1024;
      const lower = female ? blankVolume - Math.PI * 4.24 ** 2 * 4 : options.case === "hex-screw" ? hexArea * 3.5 + Math.PI * 3.2 ** 2 * 3.5 : Math.PI * 3.2 ** 2 * 4;
      const upper = female ? blankVolume - Math.PI * 3.4 ** 2 * 4 : options.case === "hex-screw" ? hexArea * 3.5 + Math.PI * 4 ** 2 * 3.5 : Math.PI * 4 ** 2 * 4;
      requireCondition(Number.isFinite(volume) && volume > lower + 0.001 && volume < upper - 0.001, `Thread volume ${volume} is outside independent geometric bounds [${lower}, ${upper}]`);
      if (initialVolume === undefined) initialVolume = volume; else near(volume, initialVolume, 0.0001, "thread volume after Redo");
      evidence.massReadback = { validation, massProperties: mass.bodies, volumeBoundsMm3: [lower, upper] };
      const minimum = options.case.startsWith("internal-") ? [-8, -8, 0] : options.case.startsWith("hex-nut") ? [-6, -4 * Math.sqrt(3), 0] : options.case === "hex-screw" ? [-6, -4 * Math.sqrt(3), -3] : [-4, -4, 0];
      const maximum = options.case.startsWith("internal-") ? [8, 8, 4] : profileId === undefined ? [4, 4, 4] : [6, 4 * Math.sqrt(3), 4];
      // Collect independent read-only diagnostics before reporting a qualification failure.
      const failures: string[] = [];
      const verify = (check: () => void): void => { try { check(); } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); } };
      // Explicit custom-thread envelope tolerance, fixed before live execution.
      if (result.boundsMethod === "native-extrema") {
        verify(() => vectorNear(result.boundsMm.min, minimum, 0.01, "thread envelope minimum"));
        verify(() => vectorNear(result.boundsMm.max, maximum, 0.01, "thread envelope maximum"));
      } else requireCondition(result.boundsMethod === "native-box" && [...result.boundsMm.min, ...result.boundsMm.max].every((value: number) => Math.abs(value) < 32), "Unknown/out-of-probe-range body box");
      const containment = await call(client!, "plasticity_check_interference", { pairs: envelopeProbeIds.map(id => ({ firstBodyId: resultId, secondBodyId: id })), revision: state.revision });
      requireCondition(containment.pairs.length === 6 && containment.pairs.every((pair: any) => pair.status === "no-volumetric-interference"), "Native thread material escapes the 0.01 mm envelope");
      evidence.envelope = { boundsMethod: result.boundsMethod, toleranceMm: 0.01, containment };
      const radius = female ? 3.4 : 3.2;
      requireCondition(result.faces.some((face: any) => face.surfaceType === "Cylinder" && Math.abs(face.radiusMm - radius) <= 0.01), "Expected exact bore/core Cylinder carrier missing");
      const directions = await call(client!, "plasticity_list_curve_directions", {});
      const helix = directions.curves.find((curve: any) => curve.id === report.helixBodyId);
      requireCondition(directions.revision === state.revision && helix?.measurementSource === "native-brep" && helix.segments.length === 1 && !helix.closed, "Native single-segment Helix report missing/stale");
      const segment = helix.segments[0]; const length = female ? extendedLength : 4;
      verify(() => near(segment.lengthMm, Math.hypot(2 * Math.PI * 3.6 * (female ? extendedLength / 2 : 2), length), 0.001, "analytic Helix length"));
      const evaluated = await call(client!, "plasticity_evaluate_curve_segments", { samples: [0, 0.125, 0.375, 0.625, 0.875, 1].map(normalizedParameter => ({ bodyId: report.helixBodyId, segmentEntityId: segment.entityId, normalizedParameter })), revision: state.revision });
      requireCondition(evaluated.samples.length === 6 && evaluated.revision === state.revision, "Native Helix samples incomplete/stale");
      evidence.helixReadback = { helix, samples: evaluated.samples };
      for (const sample of evaluated.samples) {
        requireCondition(sample.measurementSource === "native-brep", "Helix sample is not native");
        const [x, y, z] = sample.positionMm; const [tx, ty, tz] = sample.tangent;
        near(Math.hypot(x, y), 3.6, 0.001, "sampled Helix radius");
        verify(() => requireCondition(z >= (female ? -overshoot : 0) - 0.001 && z <= (female ? 4 + overshoot : 4) + 0.001, "Helix sample escaped explicit axial range"));
        const chirality = (x * ty - y * tx) * tz;
        verify(() => requireCondition(handedness === "right" ? chirality > 1e-6 : chirality < -1e-6, "Helix chirality disagrees with requested handedness in the right-handed XYZ frame"));
      }
      const ends = [evaluated.samples[0].positionMm[2], evaluated.samples.at(-1).positionMm[2]].sort((a: number, b: number) => a - b);
      verify(() => vectorNear(ends, female ? [-overshoot, 4 + overshoot] : [0, 4], 0.001, "Helix axial ends"));
      if (profileId !== undefined) {
        const profile = directions.curves.find((curve: any) => curve.id === profileId);
        requireCondition(profile?.closed && profile.segments.length === 6, "Editable hex profile missing");
        for (const line of profile.segments) near(line.lengthMm, 4 * Math.sqrt(3), 0.00001, "hex side length");
      }
      if (options.case.startsWith("hex-nut")) near(report.actualMinimumWallThicknessMm, 1.76, 1e-12, "reported nut minimum wall");
      evidence.geometry = { validation, massProperties: mass.bodies, volumeBoundsMm3: [lower, upper], helix, samples: evaluated.samples, envelopeToleranceMm: 0.01 };
      evidence.qualificationFailures = failures;
      state = await call(client!, "plasticity_status", {});
      requireCondition(state.revision === beforeRead.revision && state.undoDepth === beforeRead.undoDepth && state.redoDepth === beforeRead.redoDepth, "Read-only thread verification changed native state/history");
      requireCondition(failures.length === 0, failures.join(" | "));
    };
    await check();
    const resultIds = state.bodies.map((body: any) => body.id).sort((a: number, b: number) => a - b);
    for (let index = 0; index < steps; index += 1) await mutate("plasticity_undo", {});
    const undone = await call(client, "plasticity_changes_since", { snapshotId: sourceSnapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(undone.diff) && state.undoDepth === source.undoDepth, "Thread Undo did not restore source snapshot");
    for (let index = 0; index < steps; index += 1) await mutate("plasticity_redo", {});
    requireCondition(JSON.stringify(state.bodies.map((body: any) => body.id).sort((a: number, b: number) => a - b)) === JSON.stringify(resultIds), "Thread Redo changed output IDs");
    await check();
    for (let index = 0; index < steps + source.undoDepth - initial.undoDepth; index += 1) await mutate("plasticity_undo", {});
    requireEmpty(state);
    const changes = await call(client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(changes.diff), "Initial empty thread fixture snapshot not restored");
    const durable = await call(client, "plasticity_construction_history", { limit: 100 });
    const expectedEvents = 2 * (source.undoDepth - initial.undoDepth) + 3 * steps + 1;
    requireCondition(durable.total === expectedEvents && durable.entries.length === expectedEvents && durable.entries.every((entry: any) => entry.status === "completed"), "Durable thread history is incomplete");
    const journal = await call(client, "plasticity_construction_journal", {});
    requireCondition(journal.durableSyncStatus === "in-sync", "Durable thread history is out of sync");
    evidence.durableHistory = { events: durable.total, syncStatus: journal.durableSyncStatus };
    evidence.undoRedo = true;
    evidence.cleanup = { restoredEmptyDocument: true, sceneContentsRestored: true };
    evidence.completedAt = new Date().toISOString();
    await writeExclusive(join(output, "evidence.json"), sanitizeEvidence(evidence));
    console.log(JSON.stringify({ ok: true, output }));
  } catch (error) {
    evidence.error = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
    if (!/timed out|timeout|uncertain|partial geometry|confirmed steps/i.test(String(evidence.error)) && client && initial && state && state.documentToken === initial.documentToken) {
      try {
        const current = await call(client, "plasticity_status", {});
        if (current.documentToken === initial.documentToken && current.revision === state.revision && current.undoDepth > initial.undoDepth) {
          let status = current;
          for (let attempt = 0; attempt < 24 && status.undoDepth > initial.undoDepth; attempt += 1) {
            status = await call(client, "plasticity_undo", { intent: "Recover disposable thread-tools acceptance", revision: status.revision });
          }
          evidence.recovery = { restoredEmptyDocument: status.bodies.length === 0 && status.regions.length === 0 };
        }
      } catch { /* Preserve the primary failure; inspect the disposable scene manually if recovery reads fail. */ }
    }
    await writeExclusive(join(output, "failure.json"), sanitizeEvidence(evidence)).catch(() => {});
    throw error;
  } finally { await client?.close().catch(() => {}); }
}

async function startMcp(storeRoot: string): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: isolatedAcceptanceEnvironment(storeRoot, process.env), stderr: "pipe" });
  const client = new Client({ name: "plasticity-native-thread-tools-live", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await client.callTool({ name, arguments: args });
  const text = toolText(response);
  if ("isError" in response && response.isError) throw new Error(text);
  return await hydrateNativeState(JSON.parse(text), id => call(client, "plasticity_body_info", { id }), (offset, revision) => call(client, "plasticity_list_bodies", { bodyOffset: offset, bodyLimit: 100, expectedRevision: revision }));
}
function toolText(response: unknown): string {
  if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content");
  const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string");
  if (!item) throw new Error("MCP tool returned no text result");
  return item.text;
}
function requireEmpty(state: any): void {
  requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0 && (state.referenceMeshes ?? []).length === 0, "Refusing thread-tools acceptance in a nonempty Plasticity document");
  requireCondition((state.measurements ?? []).length === 0 && (state.sectionAnalyses ?? []).length === 0, "Refusing thread-tools acceptance while document annotations or section analyses exist");
  requireCondition((state.groups ?? []).every((group: { id: number }) => group.id === 0), "Refusing thread-tools acceptance while non-root groups exist");
}
function summary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length }; }
function near(actual: number, expected: number, tolerance: number, label: string): void { requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`); }
function vectorNear(actual: unknown, expected: number[], tolerance: number, label: string): void { requireCondition(Array.isArray(actual) && actual.length === expected.length, `${label}: vector length mismatch`); actual.forEach((value, index) => near(value, expected[index]!, tolerance, `${label}[${index}]`)); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
