#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LINEAR_TOLERANCE_MM = 0.01;

export interface NativeCurvePlanarizeAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parseNativeCurvePlanarizeAcceptanceArgs(argv: string[]): NativeCurvePlanarizeAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: NativeCurvePlanarizeAcceptanceOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live native-curve-planarize acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native-curve-planarize acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native-curve-planarize acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-curve-planarize-live.ts --help
  node scripts/verify-native-curve-planarize-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode refuses a nonempty Plasticity document, never chooses a window
automatically, projects one spatial B-Spline onto an explicit plane through the
public MCP tool, verifies native planarity, exercises Undo/Redo, cleans up, and
writes bounded evidence.`;

async function main(): Promise<void> {
  const options = parseNativeCurvePlanarizeAcceptanceArgs(process.argv.slice(2));
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
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-curve-planarize-live-initial-empty" });

    const sourcePoints = [[0, 0, 0], [10, 15, 10], [20, -10, -5], [30, 20, 12], [40, -5, -8], [50, 10, 7], [60, 0, 0]];
    let state = await call(live.client, "plasticity_create_nurbs_curve", {
      pointsMm: sourcePoints, closed: false, intent: "Approved disposable native curve planarization source", revision: initialState.revision,
    });
    requireCondition(state.undoDepth === initialState.undoDepth + 1, "Source curve did not create one history step");
    requireCondition(state.bodies.length === 1 && state.bodies[0].type === "Wire", "Source did not create exactly one Wire");
    const id = state.bodies[0].id;
    const sourceBounds = state.bodies[0].boundsMm;
    requireCondition(sourceBounds && sourceBounds.max[2] - sourceBounds.min[2] > 1, "Source curve was not spatial");
    const beforePlanarity = await call(live.client, "plasticity_inspect_curve_planarity", { ids: [id], revision: state.revision });
    requireCondition(beforePlanarity.curves.length === 1 && beforePlanarity.curves[0].planar === false && beforePlanarity.curves[0].plane === null, "Native kernel unexpectedly classified the source as planar");
    const beforeStructure = await call(live.client, "plasticity_inspect_curve_structure", { ids: [id], revision: state.revision });
    requireStructure(beforeStructure.curves[0]);

    state = await call(live.client, "plasticity_planarize_curves", {
      ids: [id], originMm: [0, 0, 5], normal: [0, 0, 2],
      intent: "Approved disposable native curve planarization acceptance", revision: state.revision,
    });
    requireCondition(state.undoDepth === initialState.undoDepth + 2, "Planarization did not create one history step");
    const planarizedBody = state.bodies.find((body: { id: number }) => body.id === id);
    requireCondition(planarizedBody?.boundsMm, "Planarized Wire has no native bounds");
    near(planarizedBody.boundsMm.min[2], 5, LINEAR_TOLERANCE_MM, "planarized minimum Z");
    near(planarizedBody.boundsMm.max[2], 5, LINEAR_TOLERANCE_MM, "planarized maximum Z");
    const afterPlanarity = await call(live.client, "plasticity_inspect_curve_planarity", { ids: [id], revision: state.revision });
    const plane = requirePlane(afterPlanarity.curves[0]);
    near(plane.originMm[2], 5, LINEAR_TOLERANCE_MM, "native plane origin Z");
    requireCondition(Math.abs(plane.normal[2]) >= 1 - 1e-9, `Native plane normal is not parallel to Z: ${JSON.stringify(plane.normal)}`);
    const afterStructure = await call(live.client, "plasticity_inspect_curve_structure", { ids: [id], revision: state.revision });
    requireStructure(afterStructure.curves[0]);
    const directions = await call(live.client, "plasticity_list_curve_directions", {});
    const segment = onlyDirection(directions, id);
    const forward = vectorWithin(segment.startMm, [0, 0, 5], LINEAR_TOLERANCE_MM) && vectorWithin(segment.endMm, [60, 0, 5], LINEAR_TOLERANCE_MM);
    const reversed = vectorWithin(segment.startMm, [60, 0, 5], LINEAR_TOLERANCE_MM) && vectorWithin(segment.endMm, [0, 0, 5], LINEAR_TOLERANCE_MM);
    requireCondition(forward || reversed, `Planarization did not preserve the projected endpoint pair: ${JSON.stringify(segment)}`);
    evidence.planarization = {
      bodyId: id, targetPlane: { originMm: [0, 0, 5], suppliedNormal: [0, 0, 2], normalizedNormal: [0, 0, 1] },
      sourceBoundsMm: sourceBounds, resultingBoundsMm: planarizedBody.boundsMm,
      before: { planar: false, structure: compactCurve(beforeStructure.curves[0]) },
      after: { planar: true, nativePlane: plane, structure: compactCurve(afterStructure.curves[0]), lengthMm: segment.lengthMm, startMm: segment.startMm, endMm: segment.endMm, directionReversed: reversed },
      measurementSource: "native-brep",
    };

    state = await call(live.client, "plasticity_undo", { intent: "Verify native curve planarization Undo", revision: state.revision });
    const undone = await call(live.client, "plasticity_inspect_curve_planarity", { ids: [id], revision: state.revision });
    requireCondition(undone.curves[0]?.planar === false, "Undo did not restore the spatial source curve");
    state = await call(live.client, "plasticity_redo", { intent: "Verify native curve planarization Redo", revision: state.revision });
    requirePlane((await call(live.client, "plasticity_inspect_curve_planarity", { ids: [id], revision: state.revision })).curves[0]);
    evidence.undoRedo = { undoRestoredSpatialCurve: true, redoRestoredNativePlanarity: true };

    while (state.undoDepth > initialState.undoDepth) state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable native curve planarization acceptance", revision: state.revision });
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

function requireStructure(curve: any): any {
  requireCondition(curve?.measurementSource === "native-brep" && curve.segments?.length === 1, "Expected one native curve segment");
  const segment = curve.segments[0];
  requireCondition(segment.curveType === "BCurve" && segment.degree === 3 && segment.controlPointCount === 7 && segment.spanCount === 4 && segment.distinctKnotCount === 5, `Unexpected B-Spline structure: ${JSON.stringify(segment)}`);
  requireCondition(segment.rational === false && segment.periodic === false, "Expected a non-rational non-periodic BCurve");
  return segment;
}

function requirePlane(curve: any): { originMm: [number, number, number]; normal: [number, number, number] } {
  requireCondition(curve?.measurementSource === "native-brep" && curve.planar === true && curve.plane, "Native kernel did not classify the Wire as planar");
  return curve.plane;
}

function onlyDirection(report: any, id: number): any {
  const curve = report.curves.find((candidate: { id: number }) => candidate.id === id);
  requireCondition(curve?.measurementSource === "native-brep" && curve.segments?.length === 1, `Missing one-segment native direction evidence for Wire ${id}`);
  return curve.segments[0];
}

function compactCurve(curve: any): Record<string, unknown> { return { id: curve.id, segments: curve.segments.map((segment: any) => ({ curveType: segment.curveType, lengthMm: segment.lengthMm, degree: segment.degree, controlPointCount: segment.controlPointCount, spanCount: segment.spanCount, distinctKnotCount: segment.distinctKnotCount, rational: segment.rational, periodic: segment.periodic })) }; }
function requireEmpty(state: any, label: string): void { requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0, `${label} is not empty`); requireCondition((state.groups ?? []).filter((group: { id: number }) => group.id !== 0).length === 0, `${label} contains non-root groups`); }

async function startMcp(storeRoot: string): Promise<LiveMcp> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" }, stderr: "pipe" });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); });
  const client = new Client({ name: "plasticity-native-curve-planarize-live", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> { const response = await client.callTool({ name, arguments: args }); const text = toolText(response); if ("isError" in response && response.isError) throw new Error(text); return JSON.parse(text); }
function toolText(response: unknown): string { if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content"); const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string"); if (!item) throw new Error("MCP tool returned no text content"); return item.text; }
async function recover(client: Client, initial: any): Promise<Record<string, unknown>> { for (let count = 0; count < 16; count += 1) { const status = await call(client, "plasticity_status", {}); if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" }; if (status.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: status.bodies.length === 0 && status.regions.length === 0 }; await call(client, "plasticity_undo", { intent: "Recover disposable native curve planarization acceptance", revision: status.revision }); } return { restoredEmptyDocument: false, reason: "undo-limit" }; }
function stateSummary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, regionCount: state.regions.length }; }
function near(actual: number, expected: number, tolerance: number, label: string): void { requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`); }
function vectorWithin(actual: number[], expected: number[], tolerance: number): boolean { return actual.length === expected.length && actual.every((value, index) => Number.isFinite(value) && Math.abs(value - expected[index]!) <= tolerance); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
