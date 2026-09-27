#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const toleranceMm = 1e-6;

interface Options { help: boolean; target?: string; allowDisposableMutations: boolean; output?: string }
interface LiveMcp { client: Client; stderr: string[] }

export function parseNativeSlotProfilesAcceptanceArgs(argv: string[]): Options {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: Options = { help: false, allowDisposableMutations: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--allow-disposable-mutations") options.allowDisposableMutations = true;
    else if (argument === "--target") options.target = requireValue(argv, ++index, "--target");
    else if (argument === "--output") options.output = requireValue(argv, ++index, "--output");
    else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Live slot-profile acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Live slot-profile acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live slot-profile acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-slot-profiles-live.ts --help
  node scripts/verify-native-slot-profiles-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

Live mode refuses a nonempty Plasticity document, creates one disposable
L-shaped Wire through the public MCP, builds an exact 6 mm slot profile,
extrudes and validates it, verifies Undo/Redo, and restores the empty document.`;

async function main(): Promise<void> {
  const options = parseNativeSlotProfilesAcceptanceArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const evidence: Record<string, unknown> = { schemaVersion: 1, startedAt: new Date().toISOString(), targetId: options.target!, workbenchUsed: false };
  let live: LiveMcp | undefined;
  let initial: any;
  try {
    live = await startMcp(join(output, "strength-store"));
    const tools = await live.client.listTools();
    for (const name of ["plasticity_create_polyline", "plasticity_create_slot_profiles", "plasticity_list_curve_directions", "plasticity_extrude_regions", "plasticity_validate_bodies", "plasticity_undo", "plasticity_redo"]) {
      requireCondition(tools.tools.some((tool) => tool.name === name), `MCP did not expose ${name}`);
    }
    const windows = await call(live.client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    initial = await call(live.client, "plasticity_connect", { targetId: options.target });
    requireEmpty(initial, "initial scene");
    evidence.initial = summary(initial);
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-slot-profiles-live-initial-empty" });

    let state = await call(live.client, "plasticity_create_polyline", {
      pointsMm: [[0, 0, 0], [20, 0, 0], [20, 10, 0]], closed: false,
      intent: "Create disposable L-shaped native slot spine", revision: initial.revision,
    });
    requireCondition(state.undoDepth === initial.undoDepth + 1, "Spine creation did not create exactly one history step");
    const spine = onlyWire(state, "slot spine");

    state = await call(live.client, "plasticity_create_slot_profiles", {
      wireIds: [spine.id], widthMm: 6, intent: "Create disposable exact 6 mm slot profile", revision: state.revision,
    });
    requireCondition(state.undoDepth === initial.undoDepth + 2, "Slot profile did not create exactly one history step");
    requireCondition(state.bodies.filter((body: { type: string }) => body.type === "Wire").length === 2, "Slot operation did not preserve the spine and create one result Wire");
    const slot = state.bodies.find((body: { id: number }) => body.id !== spine.id);
    requireCondition(slot?.type === "Wire", "Slot result is not a Wire");
    boundsNear(slot.boundsMm, [-3, -3, 0], [23, 13, 0], "slot Wire");
    requireCondition(state.regions.length === 1 && state.regions[0].sketchWireIds.includes(slot.id), "Slot result did not produce an associated Region");
    const directions = await call(live.client, "plasticity_list_curve_directions", {});
    const exact = directions.curves.find((curve: { id: number }) => curve.id === slot.id);
    requireCondition(exact?.measurementSource === "native-brep" && exact.closed === true && exact.segments.length === 7, "Slot result is not one exact closed seven-segment B-Rep Wire");
    const lengths = exact.segments.map((segment: { lengthMm: number }) => segment.lengthMm).toSorted((left: number, right: number) => left - right);
    [1.5 * Math.PI, 7, 3 * Math.PI, 3 * Math.PI, 10, 17, 20].forEach((expected, index) => near(lengths[index], expected, toleranceMm, `slot segment ${index}`));
    const slotState = summary(state);

    state = await call(live.client, "plasticity_extrude_regions", {
      regionIds: [state.regions[0].id], distanceMm: 4, intent: "Prove slot Region is an editable native extrusion profile", revision: state.revision,
    });
    const solid = state.bodies.find((body: { type: string }) => body.type === "Solid");
    requireCondition(solid, "Slot Region extrusion did not create a Solid");
    boundsNear(solid.boundsMm, [-3, -3, 0], [23, 13, 4], "slot extrusion");
    requireCondition(solid.faceIds.length === 9 && solid.edgeIds.length === 21, "Slot extrusion has unexpected exact topology");
    const validation = await call(live.client, "plasticity_validate_bodies", { ids: [solid.id], revision: state.revision });
    requireCondition(validation.bodies.length === 1 && validation.bodies[0].nativeValid && validation.bodies[0].printableSolid, "Slot extrusion failed native validation");

    state = await call(live.client, "plasticity_undo", { intent: "Verify slot extrusion Undo", revision: state.revision });
    requireCondition(!state.bodies.some((body: { type: string }) => body.type === "Solid"), "First Undo did not remove the slot extrusion");
    state = await call(live.client, "plasticity_undo", { intent: "Verify slot profile Undo", revision: state.revision });
    requireCondition(state.bodies.length === 1 && state.bodies[0].id === spine.id, "Second Undo did not restore only the source spine");
    state = await call(live.client, "plasticity_redo", { intent: "Verify slot profile Redo", revision: state.revision });
    const redoneSlot = state.bodies.find((body: { id: number }) => body.id !== spine.id);
    requireCondition(redoneSlot?.id === slot.id, "Slot Redo did not restore the stable result Wire ID");
    boundsNear(redoneSlot.boundsMm, [-3, -3, 0], [23, 13, 0], "redone slot Wire");
    evidence.slot = {
      sourceWireId: spine.id, resultWireId: slot.id, widthMm: 6, boundsMm: slot.boundsMm,
      exactSegmentLengthsMm: lengths, history: { created: slotState, undoRemovedResult: true, redoRestoredStableId: true },
      extrusion: { solidBodyId: solid.id, boundsMm: solid.boundsMm, faceCount: solid.faceIds.length, edgeCount: solid.edgeIds.length, validation: validation.bodies[0] },
    };

    state = await undoToDepth(live.client, state, initial.undoDepth, "Clean up slot-profile acceptance");
    requireEmpty(state, "final cleanup");
    const changes = await call(live.client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(changes.diff), "Scene content differs from the initial snapshot after cleanup");
    const journal = await call(live.client, "plasticity_construction_journal", {});
    requireCondition(journal.syncStatus === "in-sync", "Construction journal is not synchronized after slot cleanup");
    evidence.cleanup = { restoredEmptyDocument: true, sceneContentsRestored: true, journal: journal.syncStatus };
    evidence.completedAt = new Date().toISOString();
    await writeExclusive(join(output, "evidence.json"), sanitizeEvidence(evidence));
    console.log(JSON.stringify({ ok: true, output, evidence: join(output, "evidence.json") }, null, 2));
  } catch (error) {
    evidence.failure = boundedError(error);
    if (live && initial) evidence.cleanup = await recover(live.client, initial).catch((cleanupError) => ({ restoredEmptyDocument: false, reason: boundedError(cleanupError) }));
    await writeExclusive(join(output, "failure.json"), sanitizeEvidence(evidence)).catch(() => {});
    throw error;
  } finally {
    await live?.client.close().catch(() => {});
  }
}

async function startMcp(storeRoot: string): Promise<LiveMcp> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" }, stderr: "pipe" });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); });
  const client = new Client({ name: "plasticity-native-slot-profiles-live", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await client.callTool({ name, arguments: args });
  const message = toolText(response);
  if ("isError" in response && response.isError) throw new Error(message);
  return JSON.parse(message);
}

function toolText(response: unknown): string {
  if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content");
  const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string");
  if (!item) throw new Error("MCP tool returned no text content");
  return item.text;
}

function onlyWire(state: any, label: string): any {
  const wires = state.bodies.filter((body: { type: string }) => body.type === "Wire");
  requireCondition(wires.length === 1 && state.bodies.length === 1, `${label}: expected one Wire and no other bodies`);
  return wires[0];
}

function boundsNear(bounds: any, expectedMin: number[], expectedMax: number[], label: string): void {
  requireCondition(bounds?.min?.length === 3 && bounds?.max?.length === 3, `${label}: native bounds are unavailable`);
  bounds.min.forEach((value: number, index: number) => near(value, expectedMin[index]!, toleranceMm, `${label}.min[${index}]`));
  bounds.max.forEach((value: number, index: number) => near(value, expectedMax[index]!, toleranceMm, `${label}.max[${index}]`));
}

function requireEmpty(state: any, label: string): void {
  requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0 && (state.referenceMeshes ?? []).length === 0, `${label}: expected no scene geometry`);
  requireCondition((state.groups ?? []).filter((group: { id: number }) => group.id !== 0).length === 0, `${label}: expected no non-root groups`);
}

async function undoToDepth(client: Client, initialState: any, depth: number, intent: string): Promise<any> {
  let state = initialState;
  for (let count = 0; state.undoDepth > depth && count < 16; count += 1) state = await call(client, "plasticity_undo", { intent, revision: state.revision });
  requireCondition(state.undoDepth === depth, `Undo cleanup did not reach initial depth ${depth}`);
  return state;
}

async function recover(client: Client, initial: any): Promise<Record<string, unknown>> {
  const state = await undoToDepth(client, await call(client, "plasticity_status", {}), initial.undoDepth, "Recover disposable slot-profile acceptance");
  return { restoredEmptyDocument: state.documentToken === initial.documentToken && state.bodies.length === 0 && state.regions.length === 0 };
}

function summary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, regionCount: state.regions.length }; }
function near(actual: number, expected: number, tolerance: number, label: string): void { requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function requireValue(argv: string[], index: number, option: string): string { const value = argv[index]; if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`); return value; }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
