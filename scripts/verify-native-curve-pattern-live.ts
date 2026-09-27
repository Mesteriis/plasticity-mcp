#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOLERANCE_MM = 0.01;

export interface NativeCurvePatternAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parseNativeCurvePatternAcceptanceArgs(argv: string[]): NativeCurvePatternAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: NativeCurvePatternAcceptanceOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live native-curve-pattern acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native-curve-pattern acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native-curve-pattern acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-curve-pattern-live.ts --help
  node scripts/verify-native-curve-pattern-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode refuses a nonempty Plasticity document, never chooses a window
automatically, verifies a five-body native curve pattern plus Undo/Redo, cleans
up with native Undo, and writes sanitized evidence to a new directory.`;

async function main(): Promise<void> {
  const options = parseNativeCurvePatternAcceptanceArgs(process.argv.slice(2));
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
    evidence.initial = stateSummary(initialState);
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-curve-pattern-live-initial-empty" });

    let state = await call(live.client, "plasticity_create_nurbs_curve", {
      pointsMm: [[0, 0, 0], [50, 50, 0], [100, 0, 0]], closed: false,
      intent: "Create a disposable exact path for native curve-pattern acceptance", revision: initialState.revision,
    });
    const spine = requireSingle(state.bodies, "Wire", "curve-pattern spine");
    state = await call(live.client, "plasticity_create_box", {
      originMm: [-5, -2, 0], sizeMm: [10, 4, 2], name: "Curve pattern source",
      intent: "Create a disposable asymmetric source for native curve-pattern acceptance", revision: state.revision,
    });
    const source = requireSingle(state.bodies, "Solid", "curve-pattern source");
    const patternUndoDepth = state.undoDepth;

    state = await call(live.client, "plasticity_curve_pattern", {
      ids: [source.id], spineId: spine.id, count: 5,
      intent: "Distribute five independent native bodies over the complete test path", revision: state.revision,
    });
    requireCondition(state.undoDepth === patternUndoDepth + 1, "Curve pattern did not use one native history step");
    requireCondition(state.bodies.filter((body: any) => body.type === "Wire").length === 1, "Curve pattern did not preserve exactly one spine Wire");
    requireCondition(state.bodies.some((body: any) => body.id === spine.id && body.type === "Wire"), "Curve pattern replaced its spine Wire");
    const solids = state.bodies.filter((body: any) => body.type === "Solid");
    requireCondition(solids.length === 5, `Expected five patterned Solids, found ${solids.length}`);
    requireCondition((state.instances ?? []).length === 0, "Curve pattern created linked instances instead of independent native bodies");

    const validation = await call(live.client, "plasticity_validate_bodies", { ids: solids.map((body: any) => body.id), revision: state.revision });
    requireCondition(validation.bodies.every((body: any) => body.nativeValid === true && body.closed === true && body.printableSolid === true), "At least one patterned body is not a valid closed native Solid");
    const properties = await call(live.client, "plasticity_measure_solid_properties", { ids: solids.map((body: any) => body.id), revision: state.revision });
    requireCondition(properties.bodies.length === 5, "Mass-property read did not return five bodies");
    for (const body of properties.bodies) near(body.volumeMm3, 80, TOLERANCE_MM, `patterned body ${body.id} volume`);
    near(properties.totals.volumeMm3, 400, TOLERANCE_MM, "curve-pattern total volume");
    const centroids = properties.bodies.map((body: any) => body.volumeCentroidMm).toSorted((left: number[], right: number[]) => left[0]! - right[0]!);
    vectorNear(centroids[0], [0, 0, 1], TOLERANCE_MM, "first patterned centroid");
    vectorNear(centroids[2], [50, 50, 1], TOLERANCE_MM, "middle patterned centroid");
    vectorNear(centroids[4], [100, 0, 1], TOLERANCE_MM, "last patterned centroid");
    near(centroids[1][0], 100 - centroids[3][0], TOLERANCE_MM, "symmetric inner centroid X");
    near(centroids[1][1], centroids[3][1], TOLERANCE_MM, "symmetric inner centroid Y");
    requireCondition(solids.slice(1).some((body: any) => {
      const x = body.boundsMm.max[0] - body.boundsMm.min[0];
      const y = body.boundsMm.max[1] - body.boundsMm.min[1];
      return x > 4 + TOLERANCE_MM && y > 4 + TOLERANCE_MM;
    }), "Curve-pattern copies did not show the verified tangent-following orientation");

    state = await call(live.client, "plasticity_undo", { intent: "Verify native curve-pattern Undo", revision: state.revision });
    requireCondition(state.bodies.filter((body: any) => body.type === "Solid").length === 1 && state.bodies.some((body: any) => body.id === spine.id), "Curve-pattern Undo did not restore the source and spine");
    state = await call(live.client, "plasticity_redo", { intent: "Verify native curve-pattern Redo", revision: state.revision });
    requireCondition(state.bodies.filter((body: any) => body.type === "Solid").length === 5 && state.bodies.some((body: any) => body.id === spine.id), "Curve-pattern Redo did not restore five Solids and the spine");

    evidence.curvePattern = {
      count: 5,
      spineBodyId: spine.id,
      sourceBodyId: source.id,
      resultBodyIds: solids.map((body: any) => body.id),
      independentNativeBodies: true,
      tangentFollowingOrientationObserved: true,
      bodyVolumesMm3: properties.bodies.map((body: any) => body.volumeMm3),
      totalVolumeMm3: properties.totals.volumeMm3,
      centroidsMm: centroids,
      oneHistoryStep: true,
    };
    evidence.undoRedo = { undoRestoredSourceAndSpine: true, redoRestoredPattern: true };

    while (state.undoDepth > initialState.undoDepth) {
      state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable native curve-pattern acceptance", revision: state.revision });
    }
    requireCondition(state.bodies.length === 0 && state.regions.length === 0, "Cleanup did not restore the empty document");
    const journal = await call(live.client, "plasticity_construction_journal", {});
    requireCondition(journal.syncStatus === "in-sync" && !journal.entries.some((entry: { status: string }) => entry.status === "unknown"), "Construction journal is not clean after curve-pattern acceptance");
    const changes = await call(live.client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(changes.diff), "Scene content differs from the initial empty snapshot after cleanup");
    evidence.cleanup = { restoredEmptyDocument: true, sceneContentsRestored: true, journalSyncStatus: journal.syncStatus };
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

function requireSingle(bodies: any[], type: string, label: string): any {
  const found = bodies.filter((body) => body.type === type);
  requireCondition(found.length === 1, `Expected one ${label}, found ${found.length}`);
  return found[0];
}

async function startMcp(storeRoot: string): Promise<LiveMcp> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" }, stderr: "pipe" });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); });
  const client = new Client({ name: "plasticity-native-curve-pattern-live", version: "1.0.0" });
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
    await call(client, "plasticity_undo", { intent: "Recover disposable native curve-pattern acceptance", revision: status.revision });
  }
  return { restoredEmptyDocument: false, reason: "undo-limit" };
}

function stateSummary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, regionCount: state.regions.length }; }
function near(actual: number, expected: number, tolerance: number, label: string): void { requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`); }
function vectorNear(actual: number[], expected: number[], tolerance: number, label: string): void { requireCondition(actual.length === expected.length, `${label}: vector length mismatch`); actual.forEach((value, index) => near(value, expected[index]!, tolerance, `${label}[${index}]`)); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
