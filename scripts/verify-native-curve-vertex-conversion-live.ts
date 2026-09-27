#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOLERANCE_MM = 0.01;

export interface NativeCurveVertexConversionAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parseNativeCurveVertexConversionAcceptanceArgs(argv: string[]): NativeCurveVertexConversionAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: NativeCurveVertexConversionAcceptanceOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live native-curve-vertex-conversion acceptance requires --target with an explicit Plasticity window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native-curve-vertex-conversion acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native-curve-vertex-conversion acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-curve-vertex-conversion-live.ts --help
  node scripts/verify-native-curve-vertex-conversion-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode refuses a nonempty Plasticity document, converts two selected
interior vertices of a disposable polyline through the public stdio MCP tool,
verifies exact curve structure and endpoint/length behavior, tests Undo/Redo,
cleans up with native Undo, and writes sanitized evidence.`;

async function main(): Promise<void> {
  const options = parseNativeCurveVertexConversionAcceptanceArgs(process.argv.slice(2));
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
    evidence.initial = summary(initialState);
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-curve-vertex-conversion-live-initial-empty" });

    let state = await call(live.client, "plasticity_create_polyline", {
      pointsMm: [[0, 0, 0], [10, 0, 0], [10, 10, 0], [20, 10, 0]], closed: false,
      intent: "Create a disposable three-segment polyline for native vertex-conversion acceptance", revision: initialState.revision,
    });
    const source = requireSingleWire(state);
    const originalBounds = source.boundsMm;
    const originalDirections = await call(live.client, "plasticity_list_curve_directions", {});
    const original = requireCurve(originalDirections, source.id);
    requireCondition(original.closed === false && original.segments.length === 3, "Source curve is not the expected open three-segment polyline");
    near(sumLengths(original), 30, 1e-8, "original exact polyline length");
    const listed = await call(live.client, "plasticity_list_curve_vertices", {});
    requireCondition(listed.revision === state.revision, "Curve vertices are not bound to the current revision");
    const interior = listed.vertices.filter((vertex: any) => vertex.bodyId === source.id && vertex.endpoint === false);
    requireCondition(interior.length === 2 && interior.every((vertex: any) => vertex.adjacentEdgeEntityIds.length === 2), "Expected two exact interior vertices with degree two");
    const endpoints = listed.vertices.filter((vertex: any) => vertex.bodyId === source.id && vertex.endpoint === true);
    requireCondition(endpoints.length === 2, "Expected two open Wire endpoints");

    const beforeRejectedCallDepth = state.undoDepth;
    const rejected = await callError(live.client, "plasticity_convert_curve_vertices_to_control_points", {
      vertices: [{ bodyId: source.id, vertexId: endpoints[0].vertexId }],
      intent: "Confirm open endpoint conversion is rejected", revision: state.revision,
    });
    requireCondition(/interior or closed Wire vertices/u.test(rejected), "Open endpoint was not rejected with a precise validation error");
    state = await call(live.client, "plasticity_status", {});
    requireCondition(state.undoDepth === beforeRejectedCallDepth && state.bodies.length === 1, "Rejected endpoint conversion changed the document");

    const beforeIds = new Set(state.bodies.map((body: any) => body.id));
    const beforeDepth = state.undoDepth;
    state = await call(live.client, "plasticity_convert_curve_vertices_to_control_points", {
      vertices: interior.map((vertex: any) => ({ bodyId: vertex.bodyId, vertexId: vertex.vertexId })),
      intent: "Convert both disposable interior polyline corners to editable B-Spline control vertices", revision: state.revision,
    });
    requireCondition(state.undoDepth === beforeDepth + 1, "Vertex conversion did not use one native history step");
    requireCondition(state.bodies.length === 1 && state.bodies[0].type === "Wire", "Vertex conversion did not preserve one Wire body");
    const result = state.bodies[0];
    requireCondition(beforeIds.has(result.id), "Vertex conversion unexpectedly changed the Wire stable ID");
    requireCondition(JSON.stringify(result.boundsMm) === JSON.stringify(originalBounds), "Converted Wire bounds changed");
    const convertedDirections = await call(live.client, "plasticity_list_curve_directions", {});
    const converted = requireCurve(convertedDirections, result.id);
    requireCondition(converted.closed === false && converted.segments.length === 1, "Converted Wire is not one open B-Spline segment");
    const convertedStructure = await call(live.client, "plasticity_inspect_curve_structure", { ids: [result.id], revision: state.revision });
    requireCondition(convertedStructure.curves.length === 1 && convertedStructure.curves[0].segments.length === 1, "Converted B-Spline structure is unavailable");
    const segment = convertedStructure.curves[0].segments[0];
    requireCondition(segment.curveType === "BCurve", `Converted segment is ${JSON.stringify(segment)}, expected BCurve`);
    requireCondition(segment.degree === 3 && segment.controlPointCount === 7 && segment.spanCount === 4, "Converted curve does not have the expected cubic seven-point structure");
    near(segment.lengthMm, 26.8290800990068, TOLERANCE_MM, "converted native B-Rep curve length");
    const verticesAfter = await call(live.client, "plasticity_list_curve_vertices", {});
    requireCondition(verticesAfter.vertices.length === 2 && verticesAfter.vertices.every((vertex: any) => vertex.endpoint), "Converted Wire should contain only its two exact endpoints");
    const ends = endpoints.map((vertex: any) => vertex.positionMm).toSorted(compareVector);
    const newEnds = verticesAfter.vertices.map((vertex: any) => vertex.positionMm).toSorted(compareVector);
    requireCondition(newEnds.length === ends.length && newEnds.every((point: number[], index: number) => vectorDistance(point, ends[index]!) <= TOLERANCE_MM), "Conversion did not preserve exact endpoint coordinates");
    const controlPoints = await call(live.client, "plasticity_list_curve_control_points", { ids: [result.id], revision: state.revision });
    requireCondition(controlPoints.curves.length === 1 && controlPoints.curves[0].interiorControlPoints.length === 5, "Converted Wire did not expose five interior B-Spline control points");

    state = await call(live.client, "plasticity_undo", { intent: "Verify native curve-vertex conversion Undo", revision: state.revision });
    const undoneDirections = await call(live.client, "plasticity_list_curve_directions", {});
    const undone = requireCurve(undoneDirections, source.id);
    requireCondition(undone.closed === false && undone.segments.length === 3, "Undo did not restore the original three-segment polyline");
    near(sumLengths(undone), 30, 1e-8, "undone exact polyline length");
    state = await call(live.client, "plasticity_redo", { intent: "Verify native curve-vertex conversion Redo", revision: state.revision });
    const redoneStructure = await call(live.client, "plasticity_inspect_curve_structure", { ids: [source.id], revision: state.revision });
    requireCondition(redoneStructure.curves[0]?.segments[0]?.degree === 3 && redoneStructure.curves[0]?.segments[0]?.controlPointCount === 7, "Redo did not restore the converted B-Spline structure");

    evidence.vertexConversion = {
      bodyId: source.id,
      selectedVertices: interior.map((vertex: any) => ({ bodyId: vertex.bodyId, vertexId: vertex.vertexId, positionMm: vertex.positionMm })),
      source: { segmentCount: original.segments.length, segmentTypes: original.segments.map((item: any) => item.curveType), lengthMm: sumLengths(original), endpointPositionsMm: ends },
      converted: { segmentCount: converted.segments.length, curveType: segment.curveType, degree: segment.degree, controlPointCount: segment.controlPointCount, spanCount: segment.spanCount, lengthMm: segment.lengthMm, endpointPositionsMm: newEnds, interiorControlPointCount: controlPoints.curves[0].interiorControlPoints.length },
      endpointConversionRejectedWithoutMutation: true,
      oneHistoryStep: true,
      undoRedoRestoredBothRepresentations: true,
    };

    while (state.undoDepth > initialState.undoDepth) {
      state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable native curve-vertex-conversion acceptance", revision: state.revision });
    }
    requireEmpty(state, "cleaned document");
    const journal = await call(live.client, "plasticity_construction_journal", {});
    const unknownJournalEntries = journal.entries.filter((entry: { status: string }) => entry.status === "unknown");
    requireCondition(journal.syncStatus !== "document-changed" && unknownJournalEntries.length === 0, `Construction journal is unsafe after curve-vertex-conversion acceptance: ${journal.syncStatus}; unknown=${JSON.stringify(unknownJournalEntries.map((entry: any) => ({ operation: entry.operation, error: entry.error })))}`);
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

function requireSingleWire(state: any): any {
  requireCondition(state.bodies.length === 1 && state.bodies[0].type === "Wire", `Expected one Wire, found ${state.bodies.length} bodies`);
  return state.bodies[0];
}
function requireCurve(report: any, bodyId: number): any {
  requireCondition(report.curves.length === 1 && report.curves[0].id === bodyId, `Curve report does not match current Wire ${bodyId}`);
  return report.curves[0];
}
function sumLengths(curve: any): number { return curve.segments.reduce((sum: number, segment: any) => sum + segment.lengthMm, 0); }
function compareVector(a: number[], b: number[]): number { return a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!; }
function vectorDistance(a: number[], b: number[]): number { return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!); }
function requireEmpty(state: any, label: string): void {
  requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0, `${label} is not empty`);
  requireCondition((state.groups ?? []).filter((group: { id: number }) => group.id !== 0).length === 0, `${label} contains non-root groups`);
}
function summary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, regionCount: state.regions.length }; }
function near(actual: unknown, expected: number, tolerance: number, label: string): void { requireCondition(typeof actual === "number" && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${String(actual)}`); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

async function startMcp(storeRoot: string): Promise<LiveMcp> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" }, stderr: "pipe" });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); });
  const client = new Client({ name: "plasticity-native-curve-vertex-conversion-live", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr };
}
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await client.callTool({ name, arguments: args });
  if (response.isError) throw new Error(toolText(response));
  return JSON.parse(toolText(response));
}
async function callError(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const response = await client.callTool({ name, arguments: args });
  requireCondition(response.isError === true, `Expected ${name} to return a validation error`);
  return toolText(response);
}
function toolText(response: unknown): string {
  if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content");
  const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string");
  if (!item) throw new Error("MCP tool returned no text content");
  return item.text;
}
async function recover(client: Client, initial: any): Promise<Record<string, unknown>> {
  for (let count = 0; count < 16; count += 1) {
    const status = await call(client, "plasticity_status", {});
    if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" };
    if (status.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: status.bodies.length === 0 && status.regions.length === 0 };
    await call(client, "plasticity_undo", { intent: "Recover disposable native curve-vertex-conversion acceptance", revision: status.revision });
  }
  return { restoredEmptyDocument: false, reason: "undo-limit" };
}
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
