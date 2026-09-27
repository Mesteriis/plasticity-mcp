#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface NativeParasolidAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parseNativeParasolidAcceptanceArgs(argv: string[]): NativeParasolidAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: NativeParasolidAcceptanceOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live native-Parasolid acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native-Parasolid acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native-Parasolid acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-parasolid-live.ts --help
  node scripts/verify-native-parasolid-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode refuses a nonempty Plasticity document, exports one exact disposable
box to Parasolid text and binary files, imports both through the public MCP,
verifies exact native B-Rep geometry and Undo/Redo, restores the empty document,
and writes sanitized evidence.`;

async function main(): Promise<void> {
  const options = parseNativeParasolidAcceptanceArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const textPath = join(output, "box-20x10x5.x_t");
  const binaryPath = join(output, "box-20x10x5.x_b");
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
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-parasolid-live-initial-empty" });

    let state = await call(live.client, "plasticity_create_box", {
      originMm: [0, 0, 0], sizeMm: [20, 10, 5], name: "Parasolid exchange box",
      intent: "Approved disposable native Parasolid acceptance", revision: initialState.revision,
    });
    const source = onlySolid(state, "created source");
    vectorNear(boundsSize(source.boundsMm), [20, 10, 5], 0.000001, "source exact bounds");
    const beforeExports = state;
    const textExport = await call(live.client, "plasticity_export_parasolid", { ids: [source.id], path: textPath, revision: state.revision });
    const binaryExport = await call(live.client, "plasticity_export_parasolid", { ids: [source.id], path: binaryPath, revision: state.revision });
    const afterExports = await call(live.client, "plasticity_status", {});
    requirePersistentStateEqual(beforeExports, afterExports);
    requireCondition(textExport.format === "parasolid-text" && binaryExport.format === "parasolid-binary", "Parasolid export formats were not identified correctly");
    const textFile = await readFile(textPath);
    const binaryFile = await readFile(binaryPath);
    requireParasolidHeader(textFile, "text Parasolid");
    requireParasolidHeader(binaryFile, "binary Parasolid");
    requireCondition(textExport.bytes === textFile.length && binaryExport.bytes === binaryFile.length, "Parasolid byte counts do not match saved files");
    evidence.exports = [
      { report: textExport, sha256: createHash("sha256").update(textFile).digest("hex") },
      { report: binaryExport, sha256: createHash("sha256").update(binaryFile).digest("hex") },
    ];

    state = await call(live.client, "plasticity_undo", { intent: "Remove disposable Parasolid source before round-trip import", revision: state.revision });
    requireEmptyDisposableScene(state);

    state = await call(live.client, "plasticity_import_parasolid", { path: textPath, intent: "Round-trip Parasolid text acceptance", revision: state.revision });
    const importedText = onlySolid(state, "text import");
    verifyImportedBox(importedText, "text import");
    const textValidation = await validateSolid(live.client, state, importedText.id, "text import");
    const textImportedState = stateSummary(state);
    state = await call(live.client, "plasticity_undo", { intent: "Verify Parasolid text import Undo", revision: state.revision });
    requireEmptyDisposableScene(state);
    const textUndoState = stateSummary(state);
    state = await call(live.client, "plasticity_redo", { intent: "Verify Parasolid text import Redo", revision: state.revision });
    const redoneText = onlySolid(state, "redone text import");
    requireCondition(redoneText.id === importedText.id, "Redo did not restore the stable Parasolid text body ID");
    verifyImportedBox(redoneText, "redone text import");
    const textRedoState = stateSummary(state);
    state = await call(live.client, "plasticity_undo", { intent: "Clean up Parasolid text import", revision: state.revision });
    requireEmptyDisposableScene(state);

    state = await call(live.client, "plasticity_import_parasolid", { path: binaryPath, intent: "Round-trip Parasolid binary acceptance", revision: state.revision });
    const importedBinary = onlySolid(state, "binary import");
    verifyImportedBox(importedBinary, "binary import");
    const binaryValidation = await validateSolid(live.client, state, importedBinary.id, "binary import");
    const binaryImportedState = stateSummary(state);
    state = await call(live.client, "plasticity_undo", { intent: "Clean up Parasolid binary import", revision: state.revision });
    requireEmptyDisposableScene(state);

    evidence.roundTrips = {
      text: { bodyId: importedText.id, boundsMm: importedText.boundsMm, faceCount: importedText.faces.length, edgeCount: importedText.edges.length, validation: textValidation, history: { imported: textImportedState, undo: textUndoState, redo: textRedoState } },
      binary: { bodyId: importedBinary.id, boundsMm: importedBinary.boundsMm, faceCount: importedBinary.faces.length, edgeCount: importedBinary.edges.length, validation: binaryValidation, imported: binaryImportedState },
    };
    const changes = await call(live.client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(changes.diff), "Scene content differs from the initial empty snapshot after cleanup");
    evidence.cleanup = { restoredEmptyDocument: true, sceneContentsRestored: true };
    evidence.completedAt = new Date().toISOString();
    await writeExclusive(join(output, "evidence.json"), sanitizeEvidence(evidence));
    console.log(JSON.stringify({ ok: true, output, files: [textPath, binaryPath], evidence: join(output, "evidence.json") }, null, 2));
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
  const client = new Client({ name: "plasticity-native-parasolid-live", version: "1.0.0" });
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

function onlySolid(state: any, label: string): any {
  requireCondition(state.bodies.length === 1 && state.bodies[0]?.type === "Solid", `${label} did not produce exactly one Solid`);
  return state.bodies[0];
}

function verifyImportedBox(body: any, label: string): void {
  vectorNear(boundsSize(body.boundsMm), [20, 10, 5], 0.000001, `${label} exact bounds`);
  requireCondition(body.faces.length === 6 && body.edges.length === 12, `${label} topology is not the expected six-face box`);
}

async function validateSolid(client: Client, state: any, id: number, label: string): Promise<any> {
  const validation = await call(client, "plasticity_validate_bodies", { ids: [id], revision: state.revision });
  requireCondition(validation.bodies.length === 1 && validation.bodies[0].nativeValid && validation.bodies[0].printableSolid, `${label} did not pass native closed-Solid validation`);
  return validation.bodies[0];
}

async function recover(client: Client, initial: any): Promise<Record<string, unknown>> {
  for (let count = 0; count < 16; count += 1) {
    const status = await call(client, "plasticity_status", {});
    if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" };
    if (status.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: status.bodies.length === 0 && status.regions.length === 0 };
    await call(client, "plasticity_undo", { intent: "Recover disposable native Parasolid acceptance", revision: status.revision });
  }
  return { restoredEmptyDocument: false, reason: "undo-limit" };
}

function requirePersistentStateEqual(before: any, after: any): void {
  for (const field of ["documentToken", "revision", "undoDepth", "redoDepth"] as const) requireCondition(before[field] === after[field], `Parasolid export changed ${field}`);
  requireCondition(JSON.stringify(before.bodies) === JSON.stringify(after.bodies), "Parasolid export changed body identity or geometry");
}

function requireParasolidHeader(data: Buffer, label: string): void {
  const header = data.subarray(0, Math.min(data.length, 512)).toString("latin1");
  requireCondition(data.length >= 96 && header.startsWith("**") && header.includes("PARASOLID"), `${label} header is invalid`);
}

function boundsSize(bounds: any): number[] { requireCondition(bounds?.min?.length === 3 && bounds?.max?.length === 3, "Native bounds are unavailable"); return bounds.max.map((value: number, index: number) => value - bounds.min[index]); }
function stateSummary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length }; }
function near(actual: number, expected: number, tolerance: number, label: string): void { requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`); }
function vectorNear(actual: unknown, expected: number[], tolerance: number, label: string): void { requireCondition(Array.isArray(actual) && actual.length === expected.length, `${label}: vector length mismatch`); actual.forEach((value, index) => near(value, expected[index]!, tolerance, `${label}[${index}]`)); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
