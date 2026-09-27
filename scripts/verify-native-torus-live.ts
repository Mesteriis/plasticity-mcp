#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface NativeTorusAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parseNativeTorusAcceptanceArgs(argv: string[]): NativeTorusAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: NativeTorusAcceptanceOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live native-torus acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native-torus acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native-torus acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-torus-live.ts --help
  node scripts/verify-native-torus-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode refuses a nonempty Plasticity document, never chooses a window
automatically, creates and verifies a disposable exact ring torus, exercises
Undo/Redo, restores the empty scene, and writes sanitized evidence.`;

async function main(): Promise<void> {
  const options = parseNativeTorusAcceptanceArgs(process.argv.slice(2));
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
    requireEmptyDisposableScene(initialState);
    evidence.initial = stateSummary(initialState);
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-torus-live-initial-empty" });

    const centerMm = [10, 20, 30];
    const majorRadiusMm = 30;
    const minorRadiusMm = 5;
    let state = await call(live.client, "plasticity_create_torus", {
      centerMm, majorRadiusMm, minorRadiusMm, axis: [0, 0, 2], radialDirection: [2, 0, 1], name: "Acceptance torus",
      intent: "Approved disposable native torus acceptance", revision: initialState.revision,
    });
    requireCondition(state.undoDepth === initialState.undoDepth + 1, "Torus and profile did not occupy exactly one history step");
    const profile = state.bodies.find((candidate: { name: string | null }) => candidate.name === "Acceptance torus profile");
    const solid = state.bodies.find((candidate: { name: string | null }) => candidate.name === "Acceptance torus");
    requireCondition(profile?.type === "Wire", "Editable torus profile Wire was not preserved");
    requireCondition(solid?.type === "Solid", "Torus Solid was not created");
    requireCondition(solid.faces.length === 1 && solid.faces[0].surfaceType === "Torus", "Created body is not one exact native Torus face");
    vectorNear(boundsSize(solid.boundsMm), [70, 70, 10], 0.000001, "exact torus bounds");
    vectorNear(boundsCenter(solid.boundsMm), centerMm, 0.000001, "exact torus bounds center");
    vectorNear(boundsSize(profile.boundsMm), [10, 0, 10], 0.000001, "editable profile bounds");

    const validation = await call(live.client, "plasticity_validate_bodies", { ids: [solid.id], revision: state.revision });
    requireCondition(validation.bodies.length === 1 && validation.bodies[0].nativeValid && validation.bodies[0].printableSolid, "Torus did not pass native closed-Solid validation");
    const properties = await call(live.client, "plasticity_measure_solid_properties", { ids: [solid.id], revision: state.revision });
    near(properties.bodies[0].volumeMm3, 2 * Math.PI ** 2 * majorRadiusMm * minorRadiusMm ** 2, 1e-6, "torus volume");
    near(properties.bodies[0].surfaceAreaMm2, 4 * Math.PI ** 2 * majorRadiusMm * minorRadiusMm, 1e-6, "torus surface area");
    vectorNear(properties.bodies[0].volumeCentroidMm, centerMm, 1e-8, "torus volume centroid");
    const afterReads = await call(live.client, "plasticity_status", {});
    requirePersistentStateEqual(state, afterReads);

    const created = stateSummary(state);
    state = await call(live.client, "plasticity_undo", { intent: "Verify one-step native torus Undo", revision: state.revision });
    requireEmptyDisposableScene(state);
    const afterUndo = stateSummary(state);
    state = await call(live.client, "plasticity_redo", { intent: "Verify one-step native torus Redo", revision: state.revision });
    const redoneProfile = state.bodies.find((candidate: { name: string | null }) => candidate.name === "Acceptance torus profile");
    const redoneSolid = state.bodies.find((candidate: { name: string | null }) => candidate.name === "Acceptance torus");
    requireCondition(redoneProfile?.id === profile.id && redoneSolid?.id === solid.id, "Redo did not restore stable torus/profile body IDs");
    vectorNear(boundsSize(redoneSolid.boundsMm), [70, 70, 10], 0.000001, "redone torus bounds");
    evidence.torus = {
      centerMm, majorRadiusMm, minorRadiusMm, profileBodyId: profile.id, solidBodyId: solid.id,
      exactSurfaceType: solid.faces[0].surfaceType,
      boundsMm: solid.boundsMm,
      validation: validation.bodies[0],
      massProperties: properties.bodies[0],
      history: { created, afterUndo, afterRedo: stateSummary(state), oneStep: true },
      readOnlyVerificationChangedDocument: false,
    };

    state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable native torus acceptance", revision: state.revision });
    requireEmptyDisposableScene(state);
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
  const client = new Client({ name: "plasticity-native-torus-live", version: "1.0.0" });
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

function requireEmptyDisposableScene(state: any): void {
  requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0, "Refusing disposable mutations in a nonempty Plasticity document");
  requireCondition((state.groups ?? []).filter((group: { id: number }) => group.id !== 0).length === 0, "Refusing disposable mutations while non-root Plasticity groups exist");
}

async function recover(client: Client, initial: any): Promise<Record<string, unknown>> {
  for (let count = 0; count < 16; count += 1) {
    const status = await call(client, "plasticity_status", {});
    if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" };
    if (status.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: status.bodies.length === 0 && status.regions.length === 0 };
    await call(client, "plasticity_undo", { intent: "Recover disposable native torus acceptance", revision: status.revision });
  }
  return { restoredEmptyDocument: false, reason: "undo-limit" };
}

function requirePersistentStateEqual(before: any, after: any): void {
  for (const field of ["documentToken", "revision", "undoDepth", "redoDepth"] as const) requireCondition(before[field] === after[field], `Read-only torus verification changed ${field}`);
  requireCondition(JSON.stringify(before.bodies) === JSON.stringify(after.bodies), "Read-only torus verification changed body identity or geometry");
}

function boundsSize(bounds: any): number[] { requireCondition(bounds?.min?.length === 3 && bounds?.max?.length === 3, "Native bounds are unavailable"); return bounds.max.map((value: number, index: number) => value - bounds.min[index]); }
function boundsCenter(bounds: any): number[] { requireCondition(bounds?.min?.length === 3 && bounds?.max?.length === 3, "Native bounds are unavailable"); return bounds.max.map((value: number, index: number) => (value + bounds.min[index]) / 2); }
function stateSummary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length }; }
function near(actual: number, expected: number, tolerance: number, label: string): void { requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`); }
function vectorNear(actual: unknown, expected: number[], tolerance: number, label: string): void { requireCondition(Array.isArray(actual) && actual.length === expected.length, `${label}: vector length mismatch`); actual.forEach((value, index) => near(value, expected[index]!, tolerance, `${label}[${index}]`)); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
