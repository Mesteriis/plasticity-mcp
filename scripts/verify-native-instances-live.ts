#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface NativeInstanceAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parseNativeInstanceAcceptanceArgs(argv: string[]): NativeInstanceAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: NativeInstanceAcceptanceOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live native-instance acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native-instance acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native-instance acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-instances-live.ts --help
  node scripts/verify-native-instances-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode refuses a nonempty Plasticity document, never chooses a window automatically,
uses a separate stdio MCP process, and writes only sanitized evidence to a new directory.`;

async function main(): Promise<void> {
  const options = parseNativeInstanceAcceptanceArgs(process.argv.slice(2));
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
    requireCondition(initialState.bodies.length === 0 && initialState.regions.length === 0 && initialState.instances.length === 0, "Refusing disposable mutations in a nonempty Plasticity document");
    evidence.initial = stateSummary(initialState);
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-instances-live-initial-empty" });

    let state = await call(live.client, "plasticity_create_box", {
      originMm: [0, 0, 0], sizeMm: [20, 10, 5], name: "Disposable instance source",
      intent: "Approved disposable native-instance acceptance", revision: initialState.revision,
    });
    const sourceId = state.bodies[0]?.id;
    requireCondition(Number.isInteger(sourceId), "Source creation did not return a body ID");
    let priorDepth = state.undoDepth;
    state = await call(live.client, "plasticity_create_instance", {
      bodyId: sourceId, translationMm: [30, 0, 0], intent: "Create linked native copy", revision: state.revision,
    });
    requireHistoryStep(state, priorDepth, "Create instance");
    requireCondition(state.instances.length === 1, "Create did not return exactly one instance");
    const instanceId = state.instances[0].id;
    requireCondition(state.instances[0].sourceBodyIds.includes(sourceId), "Instance did not retain its source-body identity");
    vectorNear(state.instances[0].translationMm, [30, 0, 0], 0.01, "initial translation");
    vectorNear(state.instances[0].matrixWorldMm.slice(12, 15), [30, 0, 0], 0.01, "world-matrix translation components");
    const listed = await call(live.client, "plasticity_list_instances", {});
    requireCondition(listed.instances.length === 1 && listed.instances[0].id === instanceId, "Read-only instance listing disagrees with document state");

    priorDepth = state.undoDepth;
    state = await call(live.client, "plasticity_move_instances", { ids: [instanceId], deltaMm: [5, 0, 0], intent: "Verify linked-instance move", revision: state.revision });
    requireHistoryStep(state, priorDepth, "Move instance");
    vectorNear(state.instances[0].translationMm, [35, 0, 0], 0.01, "moved translation");

    priorDepth = state.undoDepth;
    state = await call(live.client, "plasticity_rotate_instances", { ids: [instanceId], pivotMm: [35, 0, 0], axis: [0, 0, 1], degrees: 90, intent: "Verify linked-instance rotation", revision: state.revision });
    requireHistoryStep(state, priorDepth, "Rotate instance");
    vectorNear(state.instances[0].translationMm, [35, 0, 0], 0.01, "rotated translation");
    const rotationQuaternion = state.instances[0].rotationQuaternion;
    near(Math.abs(rotationQuaternion[2]), Math.SQRT1_2, 1e-6, "rotation quaternion Z");
    near(Math.abs(rotationQuaternion[3]), Math.SQRT1_2, 1e-6, "rotation quaternion W");

    priorDepth = state.undoDepth;
    state = await call(live.client, "plasticity_scale_instances", { ids: [instanceId], pivotMm: [35, 0, 0], factors: [2, 1, 1], intent: "Verify linked-instance scale", revision: state.revision });
    requireHistoryStep(state, priorDepth, "Scale instance");
    vectorNear(state.instances[0].scale, [1, 2, 1], 1e-6, "local scale decomposition after world-X scale");
    const scaledMatrix = state.instances[0].matrixWorldMm;
    state = await call(live.client, "plasticity_undo", { intent: "Verify instance-scale Undo", revision: state.revision });
    vectorNear(state.instances[0].scale, [1, 1, 1], 1e-6, "scale Undo");
    state = await call(live.client, "plasticity_redo", { intent: "Verify instance-scale Redo", revision: state.revision });
    vectorNear(state.instances[0].matrixWorldMm, scaledMatrix, 1e-9, "scale Redo matrix");

    state = await call(live.client, "plasticity_undo", { intent: "Restore before scale", revision: state.revision });
    state = await call(live.client, "plasticity_undo", { intent: "Restore before rotation", revision: state.revision });
    state = await call(live.client, "plasticity_undo", { intent: "Restore instance creation transform", revision: state.revision });
    vectorNear(state.instances[0].translationMm, [30, 0, 0], 0.01, "restored creation transform");

    state = await call(live.client, "plasticity_create_instance", { bodyId: sourceId, translationMm: [60, 0, 0], intent: "Create disposable second instance", revision: state.revision });
    const secondId = state.instances.find((instance: { id: number }) => instance.id !== instanceId)?.id;
    requireCondition(Number.isInteger(secondId), "Second native instance was not created");
    priorDepth = state.undoDepth;
    state = await call(live.client, "plasticity_delete_instances", { ids: [secondId], intent: "Verify native instance deletion", revision: state.revision });
    requireHistoryStep(state, priorDepth, "Delete instance");
    requireCondition(!state.instances.some((instance: { id: number }) => instance.id === secondId), "Deleted instance remains current");
    state = await call(live.client, "plasticity_undo", { intent: "Verify instance-delete Undo", revision: state.revision });
    requireCondition(state.instances.some((instance: { id: number }) => instance.id === secondId), "Delete Undo did not restore the instance");
    state = await call(live.client, "plasticity_redo", { intent: "Verify instance-delete Redo", revision: state.revision });
    requireCondition(!state.instances.some((instance: { id: number }) => instance.id === secondId), "Delete Redo did not remove the instance");

    priorDepth = state.undoDepth;
    state = await call(live.client, "plasticity_realize_instances", { ids: [instanceId], intent: "Realize linked copy for independent B-Rep editing", revision: state.revision });
    requireHistoryStep(state, priorDepth, "Realize instance");
    requireCondition(state.instances.length === 0 && state.bodies.length === 2, "Realize did not replace one instance with one independent body");
    const realized = state.bodies.find((body: { id: number }) => body.id !== sourceId);
    requireCondition(realized?.boundsMm, "Realized body has no exact B-Rep bounds");
    vectorNear(realized.boundsMm.min, [30, 0, 0], 0.01, "realized bounds minimum");
    vectorNear(realized.boundsMm.max, [50, 10, 5], 0.01, "realized bounds maximum");
    state = await call(live.client, "plasticity_undo", { intent: "Verify instance-realize Undo", revision: state.revision });
    requireCondition(state.instances.length === 1 && state.bodies.length === 1, "Realize Undo did not restore the linked instance");
    state = await call(live.client, "plasticity_redo", { intent: "Verify instance-realize Redo", revision: state.revision });
    requireCondition(state.instances.length === 0 && state.bodies.length === 2, "Realize Redo did not restore independent geometry");

    const sourceIds = new Set(state.bodies.map((body: { id: number }) => body.id));
    requireCondition(sourceIds.has(sourceId) && sourceIds.has(realized.id), "Realize Redo changed the expected source-body identities");
    priorDepth = state.undoDepth;
    state = await call(live.client, "plasticity_duplicate_bodies", {
      ids: [sourceId, realized.id], translationMm: [0, 30, 0],
      intent: "Verify independent multi-body B-Rep duplication", revision: state.revision,
    });
    requireHistoryStep(state, priorDepth, "Duplicate bodies");
    requireCondition(state.instances.length === 0 && state.bodies.length === 4, "Multi-body duplication did not produce two independent bodies");
    const copied = state.bodies.filter((body: { id: number }) => !sourceIds.has(body.id));
    requireCondition(copied.length === 2 && copied.every((body: { boundsMm?: unknown }) => body.boundsMm), "Multi-body duplication did not return two new exact B-Rep bodies");
    const sourceCopy = copied.find((body: any) => Math.abs(body.boundsMm.min[0]) <= 0.01);
    const realizedCopy = copied.find((body: any) => Math.abs(body.boundsMm.min[0] - 30) <= 0.01);
    requireCondition(sourceCopy?.boundsMm && realizedCopy?.boundsMm, "Could not identify both translated independent copies");
    vectorNear(sourceCopy.boundsMm.min, [0, 30, 0], 0.01, "source-copy bounds minimum");
    vectorNear(sourceCopy.boundsMm.max, [20, 40, 5], 0.01, "source-copy bounds maximum");
    vectorNear(realizedCopy.boundsMm.min, [30, 30, 0], 0.01, "realized-copy bounds minimum");
    vectorNear(realizedCopy.boundsMm.max, [50, 40, 5], 0.01, "realized-copy bounds maximum");
    const copiedIds = copied.map((body: { id: number }) => body.id).sort((first: number, second: number) => first - second);
    const validation = await call(live.client, "plasticity_validate_bodies", { ids: copiedIds, revision: state.revision });
    requireCondition(validation.bodies.length === 2 && validation.bodies.every((body: any) => body.nativeValid === true && body.printableSolid === true && body.nativeCheckCodes.length === 0), "An independent body copy failed native validation");
    state = await call(live.client, "plasticity_undo", { intent: "Verify independent-body duplication Undo", revision: state.revision });
    requireCondition(state.instances.length === 0 && state.bodies.length === 2, "Duplicate Undo did not restore the two source bodies");
    state = await call(live.client, "plasticity_redo", { intent: "Verify independent-body duplication Redo", revision: state.revision });
    requireCondition(state.instances.length === 0 && state.bodies.length === 4, "Duplicate Redo did not restore both independent copies");
    requireCondition(copiedIds.every((id: number) => state.bodies.some((body: { id: number }) => body.id === id)), "Duplicate Redo changed copied stable body IDs");

    const bodiesBeforeSheet = new Set(state.bodies.map((body: { id: number }) => body.id));
    const currentSource = state.bodies.find((body: { id: number }) => body.id === sourceId);
    const sourceFaceId = currentSource?.faces?.[0]?.id;
    requireCondition(typeof sourceFaceId === "string", "Source Solid has no exact face for Sheet acceptance");
    priorDepth = state.undoDepth;
    state = await call(live.client, "plasticity_extract_faces", {
      faces: [{ bodyId: sourceId, faceId: sourceFaceId }], intent: "Create disposable native Sheet source", revision: state.revision,
    });
    requireHistoryStep(state, priorDepth, "Extract Sheet");
    const sheet = state.bodies.find((body: { id: number; type: string }) => !bodiesBeforeSheet.has(body.id) && body.type === "Sheet");
    requireCondition(sheet?.boundsMm, "Face extraction did not return an exact native Sheet");
    const bodiesBeforeSheetCopy = new Set(state.bodies.map((body: { id: number }) => body.id));
    priorDepth = state.undoDepth;
    state = await call(live.client, "plasticity_duplicate_bodies", {
      ids: [sheet.id], translationMm: [0, 0, 20], intent: "Verify independent Sheet duplication", revision: state.revision,
    });
    requireHistoryStep(state, priorDepth, "Duplicate Sheet");
    const sheetCopy = state.bodies.find((body: { id: number; type: string }) => !bodiesBeforeSheetCopy.has(body.id) && body.type === "Sheet");
    requireCondition(sheetCopy?.boundsMm, "Sheet duplication did not return a new exact Sheet");
    vectorNear(sheetCopy.boundsMm.min, [sheet.boundsMm.min[0], sheet.boundsMm.min[1], sheet.boundsMm.min[2] + 20], 0.01, "Sheet-copy bounds minimum");
    vectorNear(sheetCopy.boundsMm.max, [sheet.boundsMm.max[0], sheet.boundsMm.max[1], sheet.boundsMm.max[2] + 20], 0.01, "Sheet-copy bounds maximum");
    const sheetValidation = await call(live.client, "plasticity_validate_bodies", { ids: [sheet.id, sheetCopy.id], revision: state.revision });
    requireCondition(sheetValidation.bodies.length === 2 && sheetValidation.bodies.every((body: any) => body.type === "Sheet" && body.nativeValid === true && body.printableSolid === false && body.nativeCheckCodes.length === 0), "A native Sheet source or copy failed validation");
    state = await call(live.client, "plasticity_undo", { intent: "Verify independent-Sheet duplication Undo", revision: state.revision });
    requireCondition(!state.bodies.some((body: { id: number }) => body.id === sheetCopy.id), "Sheet duplicate Undo did not remove the copy");
    state = await call(live.client, "plasticity_redo", { intent: "Verify independent-Sheet duplication Redo", revision: state.revision });
    requireCondition(state.bodies.some((body: { id: number }) => body.id === sheetCopy.id), "Sheet duplicate Redo did not restore its stable body ID");

    evidence.instances = { sourceBodyId: sourceId, instanceId, linkedSourceBodyIds: listed.instances[0].sourceBodyIds, initialTranslationMm: [30, 0, 0], initialMatrixWorldMm: listed.instances[0].matrixWorldMm, movedTranslationMm: [35, 0, 0], rotationQuaternion, worldScaleInput: [2, 1, 1], localScaleDecomposition: [1, 2, 1] };
    evidence.realized = { bodyId: realized.id, boundsMm: realized.boundsMm, measurementSource: "native-brep" };
    evidence.independentCopies = { sourceBodyIds: [sourceId, realized.id], copiedBodyIds: copiedIds, translationMm: [0, 30, 0], boundsMm: copied.map((body: any) => ({ id: body.id, boundsMm: body.boundsMm })), nativeValidation: validation.bodies };
    evidence.independentSheetCopy = { sourceBodyId: sheet.id, copiedBodyId: sheetCopy.id, translationMm: [0, 0, 20], sourceBoundsMm: sheet.boundsMm, copiedBoundsMm: sheetCopy.boundsMm, nativeValidation: sheetValidation.bodies };
    evidence.history = { steps: { create: 1, move: 1, rotate: 1, scale: 1, delete: 1, realize: 1, duplicateBodies: 1, extractSheet: 1, duplicateSheet: 1 }, undoRedo: { scale: true, delete: true, realize: true, duplicateBodies: true, duplicateSheet: true } };

    const journal = await call(live.client, "plasticity_construction_journal", {});
    requireCleanJournal(journal);
    while (state.undoDepth > initialState.undoDepth) state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable native-instance acceptance", revision: state.revision });
    requireCondition(state.bodies.length === 0 && state.regions.length === 0 && state.instances.length === 0, "Cleanup did not restore the empty document");
    const changes = await call(live.client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(changes.diff), "Scene content differs from the initial empty snapshot after cleanup");
    evidence.cleanup = { restoredEmptyDocument: true, sceneContentsRestored: true, instanceCount: state.instances.length };
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
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" }, stderr: "pipe" });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); });
  const client = new Client({ name: "plasticity-native-instances-live", version: "1.0.0" });
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
  for (let count = 0; count < 32; count += 1) {
    const status = await call(client, "plasticity_status", {});
    if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" };
    if (status.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: status.bodies.length === 0 && status.instances.length === 0 };
    await call(client, "plasticity_undo", { intent: "Recover disposable native-instance acceptance", revision: status.revision });
  }
  return { restoredEmptyDocument: false, reason: "undo-limit" };
}

function requireCleanJournal(journal: any): void {
  requireCondition(journal.syncStatus === "in-sync", `Construction journal is ${String(journal.syncStatus)}`);
  requireCondition(!journal.entries.some((entry: { status: string }) => entry.status === "unknown"), "Construction journal contains an uncertain mutation");
}

function stateSummary(state: any): Record<string, unknown> {
  return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, instanceCount: state.instances.length };
}

function requireHistoryStep(state: any, priorDepth: number, label: string): void { requireCondition(state.undoDepth === priorDepth + 1, `${label} did not occupy exactly one history step`); }
function vectorNear(actual: number[], expected: number[], tolerance: number, label: string): void { requireCondition(actual.length === expected.length, `${label}: vector length mismatch`); actual.forEach((value, index) => near(value, expected[index]!, tolerance, `${label}[${index}]`)); }
function near(actual: number, expected: number, tolerance: number, label: string): void { requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
