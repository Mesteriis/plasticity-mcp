#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOLERANCE_MM = 0.01;

export interface NativeCurveFilletAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parseNativeCurveFilletAcceptanceArgs(argv: string[]): NativeCurveFilletAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: NativeCurveFilletAcceptanceOptions = { help: false, allowDisposableMutations: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--allow-disposable-mutations") options.allowDisposableMutations = true;
    else if (argument === "--target") {
      const value = argv[++index];
      if (!value) throw new Error("--target requires an explicit Plasticity window ID");
      options.target = value;
    } else if (argument === "--output") {
      const value = argv[++index];
      if (!value) throw new Error("--output requires a new directory path");
      options.output = value;
    } else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Live native-curve-fillet acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native-curve-fillet acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native-curve-fillet acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-curve-fillet-live.ts --help
  node scripts/verify-native-curve-fillet-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode refuses a nonempty Plasticity document, never chooses a window
automatically, verifies four native curve fillets and Undo/Redo, cleans up with
native Undo, and writes sanitized evidence to a new directory.`;

async function main(): Promise<void> {
  const options = parseNativeCurveFilletAcceptanceArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const evidence: Record<string, unknown> = { schemaVersion: 1, startedAt: new Date().toISOString(), targetId: options.target!, workbenchUsed: false };
  let live: LiveMcp | undefined;
  let initialState: any;
  try {
    live = await startMcp(join(output, "strength-store"));
    const windows = await call(live.client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    initialState = await call(live.client, "plasticity_connect", { targetId: options.target });
    requireCondition(initialState.bodies.length === 0 && initialState.regions.length === 0 && (initialState.instances ?? []).length === 0, "Refusing disposable mutations in a nonempty Plasticity document");
    requireCondition((initialState.groups ?? []).filter((group: { id: number }) => group.id !== 0).length === 0, "Refusing disposable mutations while non-root Plasticity groups exist");
    evidence.initial = summary(initialState);
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-curve-fillet-live-initial-empty" });

    let state = await call(live.client, "plasticity_create_rectangle", {
      centerMm: [20, 10, 0], widthMm: 40, heightMm: 20,
      normal: [0, 0, 1], xDirection: [1, 0, 0],
      intent: "Approved disposable native curve-fillet acceptance", revision: initialState.revision,
    });
    const originalWire = requireSingleWire(state);
    const listed = await call(live.client, "plasticity_list_curve_vertices", {});
    requireCondition(listed.revision === state.revision, "Curve vertices were not bound to the current revision");
    requireCondition(listed.vertices.length === 4, `Expected four rectangle vertices, found ${listed.vertices.length}`);
    for (const vertex of listed.vertices) {
      requireCondition(vertex.bodyId === originalWire.id, "Curve vertex belongs to an unexpected Wire");
      requireCondition(vertex.endpoint === false, "Closed rectangle vertex was marked as an endpoint");
      requireCondition(vertex.adjacentEdgeEntityIds.length === 2, "Rectangle vertex does not have two adjacent segments");
    }
    const beforeFilletUndoDepth = state.undoDepth;
    state = await call(live.client, "plasticity_fillet_curve_vertices", {
      vertices: listed.vertices.map((vertex: { bodyId: number; vertexId: number }) => ({ bodyId: vertex.bodyId, vertexId: vertex.vertexId })),
      radiusMm: 3,
      intent: "Round all four disposable rectangle corners R3", revision: state.revision,
    });
    requireCondition(state.undoDepth === beforeFilletUndoDepth + 1, "Four curve fillets did not use one native history step");
    const roundedWire = requireSingleWire(state);
    requireCondition(state.regions.length === 1 && state.regions[0].sketchWireIds.includes(roundedWire.id), "Rounded Wire did not retain one associated Region");
    const roundedDirections = await call(live.client, "plasticity_list_curve_directions", {});
    const rounded = requireRoundedRectangle(roundedDirections, roundedWire.id);
    const roundedVertices = await call(live.client, "plasticity_list_curve_vertices", {});
    requireCondition(roundedVertices.vertices.length === 8, `Expected eight tangent vertices after four fillets, found ${roundedVertices.vertices.length}`);

    state = await call(live.client, "plasticity_undo", { intent: "Verify native curve fillet Undo", revision: state.revision });
    const undone = await call(live.client, "plasticity_list_curve_directions", {});
    requireCondition(undone.curves.length === 1 && undone.curves[0].segments.length === 4, "Fillet Undo did not restore the four-segment rectangle");
    state = await call(live.client, "plasticity_redo", { intent: "Verify native curve fillet Redo", revision: state.revision });
    const redoneWire = requireSingleWire(state);
    const redone = requireRoundedRectangle(await call(live.client, "plasticity_list_curve_directions", {}), redoneWire.id);

    evidence.curveFillet = {
      radiusMm: 3,
      originalBodyId: originalWire.id,
      roundedBodyId: roundedWire.id,
      bodyIdChanged: originalWire.id !== roundedWire.id,
      selectedVertices: listed.vertices,
      roundedVertexCount: roundedVertices.vertices.length,
      lineLengthsMm: rounded.lines,
      arcLengthsMm: rounded.arcs,
      oneHistoryStep: true,
    };
    evidence.undoRedo = { undoRestoredFourSegments: true, redoRestoredEightSegments: redone.lines.length === 4 && redone.arcs.length === 4 };

    while (state.undoDepth > initialState.undoDepth) {
      state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable native curve-fillet acceptance", revision: state.revision });
    }
    requireCondition(state.bodies.length === 0 && state.regions.length === 0, "Cleanup did not restore the empty document");
    const journal = await call(live.client, "plasticity_construction_journal", {});
    requireCondition(journal.syncStatus === "in-sync" && !journal.entries.some((entry: { status: string }) => entry.status === "unknown"), "Construction journal is not clean after curve-fillet acceptance");
    const changes = await call(live.client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(changes.diff), "Scene content differs from the initial empty snapshot after cleanup");
    evidence.cleanup = { restoredEmptyDocument: true, sceneContentsRestored: true, journalSyncStatus: journal.syncStatus, uncertainJournalEntries: 0 };
    evidence.completedAt = new Date().toISOString();
    await writeExclusive(join(output, "evidence.json"), sanitizeEvidence(evidence));
    console.log(JSON.stringify({ ok: true, output, evidence: join(output, "evidence.json") }, null, 2));
  } catch (error) {
    evidence.failure = boundedError(error);
    if (live && initialState && !evidence.cleanup) evidence.cleanup = await recover(live.client, initialState).catch((cleanupError) => ({ restoredEmptyDocument: false, reason: boundedError(cleanupError) }));
    await writeExclusive(join(output, "failure.json"), sanitizeEvidence(evidence)).catch(() => {});
    throw error;
  } finally {
    await live?.client.close().catch(() => {});
  }
}

function requireRoundedRectangle(report: any, bodyId: number): { lines: number[]; arcs: number[] } {
  requireCondition(report.curves.length === 1 && report.curves[0].id === bodyId, "Rounded curve record does not match the current Wire");
  const segments = report.curves[0].segments;
  requireCondition(report.curves[0].closed === true && segments.length === 8, "Rounded rectangle is not one closed eight-segment Wire");
  const lines = segments.map((segment: { lengthMm: number }) => segment.lengthMm).filter((length: number) => Math.abs(length - 14) <= TOLERANCE_MM || Math.abs(length - 34) <= TOLERANCE_MM).toSorted((left: number, right: number) => left - right);
  const arcs = segments.map((segment: { lengthMm: number }) => segment.lengthMm).filter((length: number) => Math.abs(length - Math.PI * 1.5) <= TOLERANCE_MM).toSorted((left: number, right: number) => left - right);
  requireCondition(lines.length === 4, `Expected four exact trimmed lines, found ${lines.length}`);
  [14, 14, 34, 34].forEach((expected, index) => near(lines[index], expected, TOLERANCE_MM, `rounded line ${index}`));
  requireCondition(arcs.length === 4, `Expected four exact R3 quarter arcs, found ${arcs.length}`);
  arcs.forEach((length: number, index: number) => near(length, Math.PI * 1.5, TOLERANCE_MM, `rounded arc ${index}`));
  return { lines, arcs };
}

function requireSingleWire(state: any): any {
  const wires = state.bodies.filter((body: { type: string }) => body.type === "Wire");
  requireCondition(wires.length === 1 && state.bodies.length === 1, `Expected one native Wire, found ${state.bodies.length} bodies and ${wires.length} Wires`);
  return wires[0];
}

async function startMcp(storeRoot: string): Promise<LiveMcp> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" }, stderr: "pipe" });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); });
  const client = new Client({ name: "plasticity-native-curve-fillet-live", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await client.callTool({ name, arguments: args });
  const item = (response.content as Array<{ type: string; text?: string }>).find((entry) => entry.type === "text" && typeof entry.text === "string");
  if (!item?.text) throw new Error("MCP tool returned no text content");
  if (response.isError) throw new Error(item.text);
  return JSON.parse(item.text);
}

async function recover(client: Client, initial: any): Promise<Record<string, unknown>> {
  for (let count = 0; count < 16; count += 1) {
    const status = await call(client, "plasticity_status", {});
    if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" };
    if (status.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: status.bodies.length === 0 && status.regions.length === 0 };
    await call(client, "plasticity_undo", { intent: "Recover disposable native curve-fillet acceptance", revision: status.revision });
  }
  return { restoredEmptyDocument: false, reason: "undo-limit" };
}

function summary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, regionCount: state.regions.length }; }
function near(actual: number, expected: number, tolerance: number, label: string): void { requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
