#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface NativeSolidPropertiesAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parseNativeSolidPropertiesAcceptanceArgs(argv: string[]): NativeSolidPropertiesAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: NativeSolidPropertiesAcceptanceOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live native-solid-properties acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native-solid-properties acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native-solid-properties acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-solid-properties-live.ts --help
  node scripts/verify-native-solid-properties-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode refuses a nonempty Plasticity document, never chooses a window
automatically, cleans up with native Undo, and writes sanitized evidence.`;

async function main(): Promise<void> {
  const options = parseNativeSolidPropertiesAcceptanceArgs(process.argv.slice(2));
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
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-solid-properties-live-initial-empty" });

    let state = await call(live.client, "plasticity_create_box", {
      originMm: [10, 20, 30], sizeMm: [20, 10, 5], name: "Solid properties box",
      intent: "Approved disposable native solid-properties acceptance", revision: initialState.revision,
    });
    const body = state.bodies.find((candidate: { name: string | null }) => candidate.name === "Solid properties box");
    requireCondition(Number.isInteger(body?.id), "Disposable Solid was not found");
    const beforeMeasurement = state;
    const report = await call(live.client, "plasticity_measure_solid_properties", { ids: [body.id], revision: state.revision });
    const afterMeasurement = await call(live.client, "plasticity_status", {});
    requirePersistentStateEqual(beforeMeasurement, afterMeasurement);
    requireCondition(report.source === "native-brep-mass-properties", "Solid-property source is not exact native B-Rep");
    requireCondition(report.bodies.length === 1 && report.bodies[0].id === body.id, "Solid-property body identity mismatch");
    near(report.bodies[0].volumeMm3, 1000, 1e-6, "volume");
    near(report.bodies[0].surfaceAreaMm2, 700, 1e-6, "surface area");
    vectorNear(report.bodies[0].volumeCentroidMm, [20, 25, 32.5], 1e-8, "volume centroid");
    near(report.totals.volumeMm3, 1000, 1e-6, "total volume");
    near(report.totals.surfaceAreaMm2, 700, 1e-6, "total surface area");
    vectorNear(report.totals.volumeWeightedCentroidMm, [20, 25, 32.5], 1e-8, "weighted centroid");
    requireCondition(report.bodies[0].nativeCheckCodes.length === 0, "Measured Solid failed native validation");
    requireCondition(!("massG" in report) && !("massG" in report.bodies[0]), "Geometry measurement invented a physical mass without density");
    evidence.solidProperties = { report, persistentDocumentUnchanged: true, physicalDensityRequiredSeparately: true };

    while (state.undoDepth > initialState.undoDepth) {
      state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable native solid-properties acceptance", revision: state.revision });
    }
    requireCondition(state.bodies.length === 0 && (state.instances ?? []).length === 0, "Cleanup did not restore the empty document");
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
  const client = new Client({ name: "plasticity-native-solid-properties-live", version: "1.0.0" });
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
    if (status.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: status.bodies.length === 0 };
    await call(client, "plasticity_undo", { intent: "Recover disposable native solid-properties acceptance", revision: status.revision });
  }
  return { restoredEmptyDocument: false, reason: "undo-limit" };
}

function requirePersistentStateEqual(before: any, after: any): void {
  for (const field of ["documentToken", "revision", "undoDepth", "redoDepth"] as const) {
    requireCondition(before[field] === after[field], `Read-only solid-property measurement changed ${field}`);
  }
  requireCondition(JSON.stringify(before.bodies) === JSON.stringify(after.bodies), "Read-only solid-property measurement changed body identity or geometry");
}

function stateSummary(state: any): Record<string, unknown> {
  return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length };
}
function near(actual: number, expected: number, tolerance: number, label: string): void { requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`); }
function vectorNear(actual: number[], expected: number[], tolerance: number, label: string): void { requireCondition(actual.length === expected.length, `${label}: vector length mismatch`); actual.forEach((value, index) => near(value, expected[index]!, tolerance, `${label}[${index}]`)); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
