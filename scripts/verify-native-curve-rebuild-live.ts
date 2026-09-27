#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LINEAR_TOLERANCE_MM = 0.01;

export interface NativeCurveRebuildAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parseNativeCurveRebuildAcceptanceArgs(argv: string[]): NativeCurveRebuildAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: NativeCurveRebuildAcceptanceOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live native-curve-rebuild acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native-curve-rebuild acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native-curve-rebuild acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-curve-rebuild-live.ts --help
  node scripts/verify-native-curve-rebuild-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode refuses a nonempty Plasticity document, never chooses a window
automatically, verifies all three native curve rebuild modes and compact native
curve structure read-back, checks Undo/Redo, cleans up, and writes evidence.`;

async function main(): Promise<void> {
  const options = parseNativeCurveRebuildAcceptanceArgs(process.argv.slice(2));
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
    requireEmpty(initialState, "initial document");
    evidence.initial = stateSummary(initialState);
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-curve-rebuild-live-initial-empty" });

    const offsets = [0, 50, 100];
    const ids: number[] = [];
    let state = initialState;
    for (const offset of offsets) {
      const beforeIds = new Set(state.bodies.map((body: { id: number }) => body.id));
      state = await call(live.client, "plasticity_create_nurbs_curve", {
        pointsMm: basePoints(offset), closed: false,
        intent: "Approved disposable curve rebuild acceptance source", revision: state.revision,
      });
      const added = state.bodies.filter((body: { id: number; type: string }) => !beforeIds.has(body.id) && body.type === "Wire");
      requireCondition(added.length === 1, "NURBS source did not add exactly one Wire");
      ids.push(added[0].id);
    }
    requireCondition(state.undoDepth === initialState.undoDepth + 3, "Three source curves did not create three history steps");
    const before = await call(live.client, "plasticity_inspect_curve_structure", { ids, revision: state.revision });
    before.curves.forEach((curve: any) => requireStructure(curve, { degree: 3, controlPointCount: 7, spanCount: 4 }));

    state = await call(live.client, "plasticity_rebuild_curves", {
      ids: [ids[0]], method: "tolerance", toleranceMm: 0.1,
      intent: "Approved disposable tolerance rebuild acceptance", revision: state.revision,
    });
    state = await call(live.client, "plasticity_rebuild_curves", {
      ids: [ids[1]], method: "control-points", pointCount: 9,
      intent: "Approved disposable control-point rebuild acceptance", revision: state.revision,
    });
    state = await call(live.client, "plasticity_rebuild_curves", {
      ids: [ids[2]], method: "degree-spans", degree: 5, spans: 3,
      intent: "Approved disposable degree and spans rebuild acceptance", revision: state.revision,
    });
    requireCondition(state.undoDepth === initialState.undoDepth + 6, "Three rebuilds did not create one history step each");
    const after = await call(live.client, "plasticity_inspect_curve_structure", { ids, revision: state.revision });
    const tolerance = requireStructure(after.curves[0], { degree: 3 });
    requireCondition(tolerance.controlPointCount > 7 && tolerance.spanCount === tolerance.controlPointCount - tolerance.degree, "Tolerance rebuild did not produce a consistent fitted cubic BCurve");
    const controlPoints = requireStructure(after.curves[1], { degree: 3, controlPointCount: 9, spanCount: 6 });
    const degreeSpans = requireStructure(after.curves[2], { degree: 5, controlPointCount: 8, spanCount: 3 });
    const directions = await call(live.client, "plasticity_list_curve_directions", {});
    ids.forEach((id, index) => requireEndpoints(directions, id, [0, offsets[index]!, 0], [60, offsets[index]!, 0]));
    evidence.rebuild = {
      source: before.curves.map(compactCurve),
      tolerance: { requestedToleranceMm: 0.1, observed: compactSegment(tolerance) },
      controlPoints: { requestedControlPointCount: 9, observed: compactSegment(controlPoints) },
      degreeSpans: { requestedDegree: 5, requestedSpans: 3, observed: compactSegment(degreeSpans) },
      endpointsPreserved: true,
      measurementSource: "native-brep",
    };

    for (let index = 0; index < 3; index += 1) state = await call(live.client, "plasticity_undo", { intent: "Verify native curve rebuild Undo", revision: state.revision });
    const undone = await call(live.client, "plasticity_inspect_curve_structure", { ids, revision: state.revision });
    undone.curves.forEach((curve: any) => requireStructure(curve, { degree: 3, controlPointCount: 7, spanCount: 4 }));
    for (let index = 0; index < 3; index += 1) state = await call(live.client, "plasticity_redo", { intent: "Verify native curve rebuild Redo", revision: state.revision });
    const redone = await call(live.client, "plasticity_inspect_curve_structure", { ids, revision: state.revision });
    requireStructure(redone.curves[1], { degree: 3, controlPointCount: 9, spanCount: 6 });
    requireStructure(redone.curves[2], { degree: 5, controlPointCount: 8, spanCount: 3 });
    evidence.undoRedo = { undoRestoredOriginalStructures: true, redoRestoredRebuiltStructures: true };

    while (state.undoDepth > initialState.undoDepth) state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable native curve rebuild acceptance", revision: state.revision });
    requireEmpty(state, "cleaned document");
    const changes = await call(live.client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(changes.diff), "Scene content differs from the initial empty snapshot after cleanup");
    evidence.cleanup = { restoredEmptyDocument: true, sceneContentsRestored: true };
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

function basePoints(offset: number): number[][] {
  return [[0, 0, 0], [10, 15, 0], [20, -10, 0], [30, 20, 0], [40, -5, 0], [50, 10, 0], [60, 0, 0]].map(([x, y, z]) => [x!, y! + offset, z!]);
}

function requireStructure(curve: any, expected: { degree?: number; controlPointCount?: number; spanCount?: number }): any {
  requireCondition(curve?.measurementSource === "native-brep" && curve.segments?.length === 1, "Expected one native curve segment");
  const segment = curve.segments[0];
  requireCondition(segment.curveType === "BCurve", `Expected BCurve, got ${String(segment.curveType)}`);
  for (const [key, value] of Object.entries(expected)) requireCondition(segment[key] === value, `${key}: expected ${value}, got ${segment[key]}`);
  requireCondition(segment.rational === false && segment.periodic === false, "Expected a non-rational non-periodic BCurve");
  return segment;
}

function requireEndpoints(report: any, id: number, start: number[], end: number[]): void {
  const curve = report.curves.find((candidate: { id: number }) => candidate.id === id);
  requireCondition(curve?.measurementSource === "native-brep" && curve.segments.length === 1, `Missing native direction evidence for Wire ${id}`);
  vectorNear(curve.segments[0].startMm, start, LINEAR_TOLERANCE_MM, `Wire ${id} start`);
  vectorNear(curve.segments[0].endMm, end, LINEAR_TOLERANCE_MM, `Wire ${id} end`);
}

function compactCurve(curve: any): Record<string, unknown> { return { id: curve.id, segments: curve.segments.map(compactSegment) }; }
function compactSegment(segment: any): Record<string, unknown> { return { entityId: segment.entityId, curveType: segment.curveType, lengthMm: segment.lengthMm, degree: segment.degree, controlPointCount: segment.controlPointCount, spanCount: segment.spanCount, distinctKnotCount: segment.distinctKnotCount, rational: segment.rational, periodic: segment.periodic }; }
function requireEmpty(state: any, label: string): void { requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0, `${label} is not empty`); requireCondition((state.groups ?? []).filter((group: { id: number }) => group.id !== 0).length === 0, `${label} contains non-root groups`); }

async function startMcp(storeRoot: string): Promise<LiveMcp> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" }, stderr: "pipe" });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); });
  const client = new Client({ name: "plasticity-native-curve-rebuild-live", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> { const response = await client.callTool({ name, arguments: args }); const text = toolText(response); if ("isError" in response && response.isError) throw new Error(text); return JSON.parse(text); }
function toolText(response: unknown): string { if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content"); const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string"); if (!item) throw new Error("MCP tool returned no text content"); return item.text; }
async function recover(client: Client, initial: any): Promise<Record<string, unknown>> { for (let count = 0; count < 24; count += 1) { const status = await call(client, "plasticity_status", {}); if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" }; if (status.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: status.bodies.length === 0 && status.regions.length === 0 }; await call(client, "plasticity_undo", { intent: "Recover disposable native curve rebuild acceptance", revision: status.revision }); } return { restoredEmptyDocument: false, reason: "undo-limit" }; }
function stateSummary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, regionCount: state.regions.length }; }
function near(actual: number, expected: number, tolerance: number, label: string): void { requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`); }
function vectorNear(actual: number[], expected: number[], tolerance: number, label: string): void { requireCondition(actual.length === expected.length, `${label}: vector length mismatch`); actual.forEach((value, index) => near(value, expected[index]!, tolerance, `${label}[${index}]`)); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
