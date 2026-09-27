#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LINEAR_TOLERANCE_MM = 0.01;

export interface NativeSheetInsertionAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parseNativeSheetInsertionAcceptanceArgs(argv: string[]): NativeSheetInsertionAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: NativeSheetInsertionAcceptanceOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live native-sheet-insertion acceptance requires --target with an explicit Plasticity window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native-sheet-insertion acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native-sheet-insertion acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-sheet-insertion-live.ts --help
  node scripts/verify-native-sheet-insertion-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode refuses a nonempty Plasticity document, never chooses a window
automatically, unjoins one box face, reinserts that exact Sheet through the
public MCP tool, verifies the rebuilt Solid with exact B-Rep evidence and
Undo/Redo, cleans up with native Undo, and writes sanitized evidence.`;

async function main(): Promise<void> {
  const options = parseNativeSheetInsertionAcceptanceArgs(process.argv.slice(2));
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
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-sheet-insertion-live-initial-empty" });

    let state = await call(live.client, "plasticity_create_box", {
      originMm: [0, 0, 0], sizeMm: [20, 10, 5], name: "Sheet insertion acceptance",
      intent: "Create disposable source for native Sheet insertion acceptance", revision: initialState.revision,
    });
    const source = requireSingleSolid(state, "source box");
    const sourceProperties = await exactProperties(live.client, source.id, state.revision);
    const top = source.faces.find((face: any) => face.planar && face.normal[2] > 0.999 && nearBoolean(face.centerMm[2], 5));
    requireCondition(top, "Source top face is unavailable");
    state = await call(live.client, "plasticity_unjoin_faces", {
      faces: [{ bodyId: source.id, faceId: top.id }],
      intent: "Detach the exact top face before native Sheet insertion", revision: state.revision,
    });
    requireCondition(state.bodies.length === 2 && state.bodies.every((body: any) => body.type === "Sheet"), "Face unjoin did not produce two Sheet bodies");
    const target = state.bodies.find((body: any) => body.id === source.id);
    const fill = state.bodies.find((body: any) => body.id !== source.id);
    requireCondition(target && fill, "Target or fill Sheet is unavailable after face unjoin");
    requireTopology(target, 5, 12, "open target Sheet");
    requireTopology(fill, 1, 4, "fill Sheet");
    const boundaryEdges = target.edges.filter((edge: any) => edge.faceIds.length === 1 && nearBoolean(edge.centerMm[2], 5));
    requireCondition(boundaryEdges.length === 4, `Expected four target boundary edges, found ${boundaryEdges.length}`);
    const beforeInsertDepth = state.undoDepth;
    state = await call(live.client, "plasticity_insert_sheet", {
      targetSheetId: target.id, edgeIds: boundaryEdges.map((edge: any) => edge.id), fillSheetId: fill.id,
      intent: "Reinsert the exact detached top Sheet and restore the closed box", revision: state.revision,
    });
    requireCondition(state.undoDepth === beforeInsertDepth + 1, "Sheet insertion did not use one native history step");
    const rebuilt = requireSingleSolid(state, "rebuilt box");
    requireCondition(rebuilt.id === fill.id, "Plasticity 26.1.3 did not preserve the fill Sheet stable ID on insertion");
    requireTopology(rebuilt, 6, 12, "rebuilt Solid");
    requireBounds(rebuilt, [0, 0, 0], [20, 10, 5], "rebuilt Solid");
    const rebuiltProperties = await exactProperties(live.client, rebuilt.id, state.revision);
    const validation = await call(live.client, "plasticity_validate_bodies", { ids: [rebuilt.id], revision: state.revision });
    requireCondition(validation.measurementSource === "native-brep", "Unexpected body validation source");
    requireCondition(validation.bodies.length === 1 && validation.bodies[0].nativeValid === true && validation.bodies[0].printableSolid === true && validation.bodies[0].boundaryEdgeIds.length === 0 && validation.bodies[0].nativeCheckCodes.length === 0, "Rebuilt Solid failed native validation");

    state = await call(live.client, "plasticity_undo", { intent: "Verify native Sheet insertion Undo", revision: state.revision });
    requireCondition(state.bodies.length === 2 && state.bodies.every((body: any) => body.type === "Sheet"), "Sheet insertion Undo did not restore both Sheet bodies");
    state = await call(live.client, "plasticity_redo", { intent: "Verify native Sheet insertion Redo", revision: state.revision });
    const redone = requireSingleSolid(state, "Sheet insertion Redo result");
    requireCondition(redone.id === rebuilt.id, "Sheet insertion Redo changed the result stable ID");
    requireTopology(redone, 6, 12, "Sheet insertion Redo result");

    evidence.sheetInsertion = {
      sourceBodyId: source.id,
      targetSheetId: target.id,
      fillSheetId: fill.id,
      targetBoundaryEdgeIds: boundaryEdges.map((edge: any) => edge.id),
      resultBodyId: rebuilt.id,
      resultType: rebuilt.type,
      resultBoundsMm: rebuilt.boundsMm,
      topologyBefore: { targetFaces: 5, targetEdges: 12, fillFaces: 1, fillEdges: 4 },
      topologyAfter: { faces: 6, edges: 12 },
      exactPropertiesBefore: sourceProperties,
      exactPropertiesAfter: rebuiltProperties,
      inputsConsumed: true,
      fillStableIdPreserved: true,
      oneHistoryStep: true,
      undoRedo: true,
    };
    evidence.validation = validation;

    while (state.undoDepth > initialState.undoDepth) {
      state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable native Sheet insertion acceptance", revision: state.revision });
    }
    requireEmpty(state, "cleaned document");
    const journal = await call(live.client, "plasticity_construction_journal", {});
    requireCondition(journal.syncStatus === "in-sync" && !journal.entries.some((entry: { status: string }) => entry.status === "unknown"), "Construction journal is not clean after Sheet insertion acceptance");
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

async function exactProperties(client: Client, id: number, revision: string): Promise<any> {
  const report = await call(client, "plasticity_measure_solid_properties", { ids: [id], revision });
  requireCondition(report.source === "native-brep-mass-properties" && report.bodies.length === 1 && report.bodies[0].id === id, "Exact solid-property evidence is unavailable");
  near(report.bodies[0].volumeMm3, 1000, 1e-6, "solid volume");
  near(report.bodies[0].surfaceAreaMm2, 700, 1e-6, "solid surface area");
  vectorNear(report.bodies[0].volumeCentroidMm, [10, 5, 2.5], 1e-8, "solid centroid");
  requireCondition(report.bodies[0].nativeCheckCodes.length === 0, "Solid-property measurement found native validation errors");
  return report.bodies[0];
}

function requireSingleSolid(state: any, label: string): any { requireCondition(state.bodies.length === 1 && state.bodies[0].type === "Solid", `${label}: expected one native Solid, found ${state.bodies.length} bodies`); return state.bodies[0]; }
function requireTopology(body: any, faceCount: number, edgeCount: number, label: string): void { requireCondition(body.faces.length === faceCount && body.edges.length === edgeCount, `${label}: expected ${faceCount} faces and ${edgeCount} edges; got ${body.faces.length} and ${body.edges.length}`); }
function requireBounds(body: any, min: [number, number, number], max: [number, number, number], label: string): void { requireCondition(body.boundsMm, `${label} has no bounds`); vectorNear(body.boundsMm.min, min, LINEAR_TOLERANCE_MM, `${label} minimum`); vectorNear(body.boundsMm.max, max, LINEAR_TOLERANCE_MM, `${label} maximum`); }
function requireEmpty(state: any, label: string): void { requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0, `${label} is not empty`); requireCondition((state.groups ?? []).filter((group: { id: number }) => group.id !== 0).length === 0, `${label} contains non-root groups`); }
function stateSummary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, regionCount: state.regions.length }; }
function nearBoolean(actual: unknown, expected: number, tolerance = LINEAR_TOLERANCE_MM): boolean { return typeof actual === "number" && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance; }
function vectorNearBoolean(actual: unknown, expected: [number, number, number], tolerance = LINEAR_TOLERANCE_MM): boolean { return Array.isArray(actual) && actual.length === 3 && actual.every((value, index) => typeof value === "number" && Math.abs(value - expected[index]!) <= tolerance); }
function vectorNear(actual: unknown, expected: [number, number, number], tolerance: number, label: string): void { requireCondition(vectorNearBoolean(actual, expected, tolerance), `${label}: expected [${expected.join(", ")}], got ${JSON.stringify(actual)}`); }
function near(actual: unknown, expected: number, tolerance: number, label: string): void { requireCondition(typeof actual === "number" && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${String(actual)}`); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

async function startMcp(storeRoot: string): Promise<LiveMcp> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" }, stderr: "pipe" });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); });
  const client = new Client({ name: "plasticity-native-sheet-insertion-live", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> { const response = await client.callTool({ name, arguments: args }); const output = toolText(response); if ("isError" in response && response.isError) throw new Error(output); return JSON.parse(output); }
function toolText(response: unknown): string { if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content"); const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string"); if (!item) throw new Error("MCP tool returned no text content"); return item.text; }
async function recover(client: Client, initial: any): Promise<Record<string, unknown>> { for (let count = 0; count < 16; count += 1) { const status = await call(client, "plasticity_status", {}); if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" }; if (status.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: status.bodies.length === 0 && status.regions.length === 0 }; await call(client, "plasticity_undo", { intent: "Recover disposable native Sheet insertion acceptance", revision: status.revision }); } return { restoredEmptyDocument: false, reason: "undo-limit" }; }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
