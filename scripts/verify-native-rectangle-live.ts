#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LINEAR_TOLERANCE_MM = 0.01;

export interface NativeRectangleAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parseNativeRectangleAcceptanceArgs(argv: string[]): NativeRectangleAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: NativeRectangleAcceptanceOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live native-rectangle acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native-rectangle acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native-rectangle acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-rectangle-live.ts --help
  node scripts/verify-native-rectangle-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode refuses a nonempty Plasticity document, never chooses a window
automatically, verifies exact native curve geometry and Undo/Redo, cleans up
with native Undo, and writes sanitized evidence to a new directory.`;

async function main(): Promise<void> {
  const options = parseNativeRectangleAcceptanceArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const evidence: Record<string, unknown> = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    targetId: options.target!,
    workbenchUsed: false,
  };
  let live: LiveMcp | undefined;
  let initialState: any;
  try {
    live = await startMcp(join(output, "strength-store"));
    const windows = await call(live.client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    initialState = await call(live.client, "plasticity_connect", { targetId: options.target });
    requireCondition(initialState.bodies.length === 0 && initialState.regions.length === 0 && (initialState.instances ?? []).length === 0, "Refusing disposable mutations in a nonempty Plasticity document");
    requireCondition((initialState.groups ?? []).filter((group: { id: number }) => group.id !== 0).length === 0, "Refusing disposable mutations while non-root Plasticity groups exist");
    evidence.initial = stateSummary(initialState);
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-rectangle-live-initial-empty" });

    const center = [10, 20, 30];
    const normal = unit([1, 1, 1]);
    let state = await call(live.client, "plasticity_create_rectangle", {
      centerMm: center,
      widthMm: 40,
      heightMm: 20,
      normal,
      xDirection: [1, -1, 0],
      angleDegrees: 30,
      intent: "Approved disposable exact native rectangle acceptance",
      revision: initialState.revision,
    });
    requireCondition(state.undoDepth === initialState.undoDepth + 1, "Native rectangle did not create exactly one history step");
    const wire = requireSingleWire(state);
    requireCondition(state.regions.length === 1 && state.regions[0].sketchWireIds.includes(wire.id), "Native rectangle did not create one associated Region");
    const regionChanges = await call(live.client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(regionChanges.diff.changed && regionChanges.diff.regionsAdded.length === 1 && regionChanges.diff.regionsAdded[0].id === state.regions[0].id,
      "Scene diff did not report the newly created native sketch Region");
    evidence.sceneDiff = {
      changed: regionChanges.diff.changed,
      addedRegionIds: regionChanges.diff.regionsAdded.map((region: { id: string }) => region.id),
      currentRegionCount: regionChanges.current.regions.length,
    };
    const directions = await call(live.client, "plasticity_list_curve_directions", {});
    const curve = requireRectangleCurve(directions, wire.id, center, normal);
    evidence.rectangle = {
      bodyId: wire.id,
      revision: state.revision,
      undoDepth: state.undoDepth,
      regionId: state.regions[0].id,
      measurementSource: curve.measurementSource,
      closed: curve.closed,
      segmentLengthsMm: curve.segments.map((segment: { lengthMm: number }) => segment.lengthMm),
      segmentPointsMm: curve.segments.map((segment: { startMm: number[]; endMm: number[] }) => ({ startMm: segment.startMm, endMm: segment.endMm })),
    };

    state = await call(live.client, "plasticity_undo", { intent: "Verify native rectangle Undo", revision: state.revision });
    requireCondition(state.bodies.length === 0 && state.regions.length === 0, "Rectangle Undo did not restore the empty scene");
    state = await call(live.client, "plasticity_redo", { intent: "Verify native rectangle Redo", revision: state.revision });
    const redoneWire = requireSingleWire(state);
    requireCondition(state.regions.length === 1 && state.regions[0].sketchWireIds.includes(redoneWire.id), "Rectangle Redo did not restore its Region");
    const redoneDirections = await call(live.client, "plasticity_list_curve_directions", {});
    const redoneCurve = requireRectangleCurve(redoneDirections, redoneWire.id, center, normal);
    evidence.undoRedo = {
      undoRestoredEmptyScene: true,
      redoRestoredExactRectangle: true,
      redoneBodyId: redoneWire.id,
      redoneSegmentLengthsMm: redoneCurve.segments.map((segment: { lengthMm: number }) => segment.lengthMm),
    };

    while (state.undoDepth > initialState.undoDepth) {
      state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable native rectangle acceptance", revision: state.revision });
    }
    requireCondition(state.bodies.length === 0 && state.regions.length === 0, "Cleanup did not restore the empty document");
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

function requireSingleWire(state: any): any {
  const wires = state.bodies.filter((body: { type: string }) => body.type === "Wire");
  requireCondition(wires.length === 1 && state.bodies.length === 1, `Expected one native Wire, found ${state.bodies.length} bodies and ${wires.length} Wires`);
  return wires[0];
}

function requireRectangleCurve(report: any, bodyId: number, center: number[], normal: number[]): any {
  requireCondition(report.curves.length === 1, `Expected one curve direction record, found ${report.curves.length}`);
  const curve = report.curves[0];
  requireCondition(curve.id === bodyId, "Curve direction record does not match the rectangle body");
  requireCondition(curve.measurementSource === "native-brep", "Rectangle segment evidence is not native B-Rep");
  requireCondition(curve.closed === true && curve.segments.length === 4, "Rectangle is not one closed four-segment Wire");
  const lengths = curve.segments.map((segment: { lengthMm: number }) => segment.lengthMm).toSorted((left: number, right: number) => left - right);
  [20, 20, 40, 40].forEach((expected, index) => near(lengths[index], expected, LINEAR_TOLERANCE_MM, `rectangle segment ${index}`));
  const starts = curve.segments.map((segment: { startMm: number[] }) => segment.startMm);
  const measuredCenter = [0, 1, 2].map((axis) => starts.reduce((sum: number, point: number[]) => sum + point[axis]!, 0) / starts.length);
  vectorNear(measuredCenter, center, LINEAR_TOLERANCE_MM, "rectangle center");
  for (const point of starts) near(dot(subtract(point, center), normal), 0, LINEAR_TOLERANCE_MM, "rectangle planarity");
  return curve;
}

async function startMcp(storeRoot: string): Promise<LiveMcp> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(projectRoot, "scripts", "run-server.ts")],
    cwd: projectRoot,
    env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" },
    stderr: "pipe",
  });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); });
  const client = new Client({ name: "plasticity-native-rectangle-live", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await client.callTool({ name, arguments: args });
  const text = toolText(response);
  if ("isError" in response && response.isError) throw new Error(text);
  return JSON.parse(text);
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
    await call(client, "plasticity_undo", { intent: "Recover disposable native rectangle acceptance", revision: status.revision });
  }
  return { restoredEmptyDocument: false, reason: "undo-limit" };
}

function unit(value: number[]): number[] { const length = Math.hypot(...value); return value.map((component) => component / length); }
function subtract(left: number[], right: number[]): number[] { return left.map((value, index) => value - right[index]!); }
function dot(left: number[], right: number[]): number { return left.reduce((sum, value, index) => sum + value * right[index]!, 0); }
function stateSummary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, regionCount: state.regions.length }; }
function near(actual: number, expected: number, tolerance: number, label: string): void { requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`); }
function vectorNear(actual: number[], expected: number[], tolerance: number, label: string): void { requireCondition(actual.length === expected.length, `${label}: vector length mismatch`); actual.forEach((value, index) => near(value, expected[index]!, tolerance, `${label}[${index}]`)); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
