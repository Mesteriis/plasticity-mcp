#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LINEAR_TOLERANCE_MM = 0.01;

export interface NativeClosedWirePatchAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parseNativeClosedWirePatchAcceptanceArgs(argv: string[]): NativeClosedWirePatchAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: NativeClosedWirePatchAcceptanceOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live native-closed-Wire-patch acceptance requires --target with an explicit Plasticity window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native-closed-Wire-patch acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native-closed-Wire-patch acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-closed-wire-patch-live.ts --help
  node scripts/verify-native-closed-wire-patch-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode refuses a nonempty Plasticity document, creates two closed nonplanar
Wires with no Regions, patches both through one public MCP call, verifies the
independent native B-Surfaces and Undo/Redo, cleans up, and writes evidence.`;

async function main(): Promise<void> {
  const options = parseNativeClosedWirePatchAcceptanceArgs(process.argv.slice(2));
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
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-closed-wire-patch-live-initial-empty" });

    let state = await call(live.client, "plasticity_create_polyline", {
      pointsMm: [[0, 0, 0], [20, 0, 0], [20, 10, 5], [0, 10, 0]], closed: true,
      intent: "Create a disposable closed nonplanar boundary for native surface patching", revision: initialState.revision,
    });
    requireCondition(state.bodies.length === 1 && state.bodies[0].type === "Wire", "Nonplanar source Wire was not created");
    requireCondition(state.regions.length === 0, "Nonplanar source unexpectedly produced a planar Region");
    const source = state.bodies[0];
    const sourceBefore = compactBody(source);
    const directions = await call(live.client, "plasticity_list_curve_directions", {});
    const curve = directions.curves.find((candidate: any) => candidate.id === source.id);
    requireCondition(curve?.closed === true && curve.segments.length === 4, "Source is not one exact four-segment closed Wire");
    const sourceLengths = curve.segments.map((segment: any) => segment.lengthMm).sort((a: number, b: number) => a - b);
    numberListNear(sourceLengths, [10, Math.sqrt(125), 20, Math.sqrt(425)], 1e-8, "source boundary lengths");

    state = await call(live.client, "plasticity_create_polyline", {
      pointsMm: [[40, 0, 0], [60, 0, 0], [60, 10, -5], [40, 10, 0]], closed: true,
      intent: "Create a second closed spatial boundary for one batched native surface patch", revision: state.revision,
    });
    requireCondition(state.bodies.length === 2 && state.regions.length === 0, "Second nonplanar source Wire was not created without a Region");
    const secondSource = state.bodies.find((body: any) => body.id !== source.id);
    requireCondition(secondSource?.type === "Wire", "Second nonplanar source is unavailable");
    const secondSourceBefore = compactBody(secondSource);
    const secondDirections = await call(live.client, "plasticity_list_curve_directions", {});
    const secondCurve = secondDirections.curves.find((candidate: any) => candidate.id === secondSource.id);
    requireCondition(secondCurve?.closed === true && secondCurve.segments.length === 4, "Second source is not one exact four-segment closed Wire");
    const secondSourceLengths = secondCurve.segments.map((segment: any) => segment.lengthMm).sort((a: number, b: number) => a - b);
    numberListNear(secondSourceLengths, sourceLengths, 1e-8, "second source boundary lengths");

    const beforePatchDepth = state.undoDepth;
    state = await call(live.client, "plasticity_patch_closed_wires", {
      ids: [source.id, secondSource.id], intent: "Fill two closed spatial boundaries with independent native surfaces in one command", revision: state.revision,
    });
    requireCondition(state.undoDepth === beforePatchDepth + 1, "Closed-Wire patch did not use one native history step");
    requireCondition(state.bodies.length === 4 && state.bodies.some((body: any) => body.id === source.id) && state.bodies.some((body: any) => body.id === secondSource.id), "Closed-Wire patch did not preserve both source Wires or create two results");
    requireCondition(JSON.stringify(compactBody(state.bodies.find((body: any) => body.id === source.id))) === JSON.stringify(sourceBefore), "Closed-Wire patch changed the source Wire");
    requireCondition(JSON.stringify(compactBody(state.bodies.find((body: any) => body.id === secondSource.id))) === JSON.stringify(secondSourceBefore), "Closed-Wire patch changed the second source Wire");
    const results = state.bodies.filter((body: any) => body.id !== source.id && body.id !== secondSource.id);
    requireCondition(results.length === 2 && results.every((body: any) => body.type === "Sheet"), "Closed-Wire patch did not create two independent Sheets");
    const result = results.find((body: any) => body.faces[0]?.centerMm[0] < 30);
    const secondResult = results.find((body: any) => body.faces[0]?.centerMm[0] > 30);
    requireCondition(result?.type === "Sheet", "Closed-Wire patch did not create one independent Sheet");
    requireCondition(secondResult?.type === "Sheet", "Closed-Wire patch did not create the second independent Sheet");
    requireCondition(result.faces.length === 1 && result.edges.length === 4, "Patched Sheet has unexpected topology");
    requireCondition(secondResult.faces.length === 1 && secondResult.edges.length === 4 && secondResult.faces[0].surfaceType === "BSurf" && secondResult.faces[0].planar === false, "Second patched Sheet has unexpected topology");
    const face = result.faces[0];
    requireCondition(face.surfaceType === "BSurf" && face.planar === false, "Spatial Wire did not produce a nonplanar B-Surface");
    vectorNear(face.boundsMm.min, [0, 0, 0], LINEAR_TOLERANCE_MM, "patch face minimum");
    vectorNear(face.boundsMm.max, [20, 10, 5], LINEAR_TOLERANCE_MM, "patch face maximum");
    const resultLengths = result.edges.map((edge: any) => edge.lengthMm).sort((a: number, b: number) => a - b);
    numberListNear(resultLengths, sourceLengths, 1e-8, "patch boundary lengths");
    const properties = await call(live.client, "plasticity_measure_face_properties", {
      faces: [{ bodyId: result.id, faceId: face.id }], revision: state.revision,
    });
    requireCondition(properties.source === "native-brep-face-mass-properties" && properties.faces.length === 1, "Exact patch face properties are unavailable");
    const measured = properties.faces[0];
    requireCondition(measured.surfaceType === "BSurf" && measured.planar === false && measured.loopCount === 1 && measured.innerLoopCount === 0, "Exact patch face topology is unexpected");
    requireCondition(Number.isFinite(measured.areaMm2) && measured.areaMm2 > 0, "Patch has no positive exact area");
    near(measured.boundaryLengthMm, sourceLengths.reduce((sum: number, length: number) => sum + length, 0), 1e-7, "patch boundary length");
    requireCondition(measured.nativeCheckCodes.length === 0, "Patch face failed native validation");
    vectorNear(secondResult.faces[0].boundsMm.min, [40, 0, -5], LINEAR_TOLERANCE_MM, "second patch face minimum");
    vectorNear(secondResult.faces[0].boundsMm.max, [60, 10, 0], LINEAR_TOLERANCE_MM, "second patch face maximum");
    const validation = await call(live.client, "plasticity_validate_bodies", { ids: [result.id, secondResult.id], revision: state.revision });
    requireCondition(validation.bodies.length === 2 && validation.bodies.every((body: any) => body.nativeValid === true && body.type === "Sheet" && body.printableSolid === false && body.boundaryEdgeIds.length === 4), "One or more patched Sheets failed native validation");

    state = await call(live.client, "plasticity_undo", { intent: "Verify native closed-Wire patch Undo", revision: state.revision });
    requireCondition(state.bodies.length === 2 && state.bodies.every((body: any) => body.id === source.id || body.id === secondSource.id), "Closed-Wire patch Undo did not remove only both Sheets");
    state = await call(live.client, "plasticity_redo", { intent: "Verify native closed-Wire patch Redo", revision: state.revision });
    const redone = state.bodies.find((body: any) => body.id === result.id);
    const secondRedone = state.bodies.find((body: any) => body.id === secondResult.id);
    requireCondition(redone?.type === "Sheet" && redone.faces.length === 1 && redone.faces[0].surfaceType === "BSurf" && secondRedone?.type === "Sheet" && secondRedone.faces.length === 1 && secondRedone.faces[0].surfaceType === "BSurf", "Closed-Wire patch Redo changed a result identity or type");

    evidence.closedWirePatch = {
      sourceBodyId: source.id,
      sourceRegionCount: 0,
      sourceBoundsMm: source.boundsMm,
      sourceSegmentLengthsMm: sourceLengths,
      secondSourceBodyId: secondSource.id,
      resultBodyIds: [result.id, secondResult.id],
      resultType: result.type,
      resultFaceType: face.surfaceType,
      resultFaceBoundsMm: face.boundsMm,
      secondResultFaceBoundsMm: secondResult.faces[0].boundsMm,
      resultBoundaryLengthsMm: resultLengths,
      exactFaceProperties: measured,
      sourcePreserved: true,
      oneHistoryStep: true,
      undoRedoStableId: true,
    };
    evidence.validation = validation;

    while (state.undoDepth > initialState.undoDepth) state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable native closed-Wire patch acceptance", revision: state.revision });
    requireEmpty(state, "cleaned document");
    const journal = await call(live.client, "plasticity_construction_journal", {});
    requireCondition(journal.syncStatus === "in-sync" && !journal.entries.some((entry: { status: string }) => entry.status === "unknown"), "Construction journal is not clean after closed-Wire patch acceptance");
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
  } finally { await live?.client.close().catch(() => {}); }
}

function compactBody(body: any): Record<string, unknown> { return { id: body.id, type: body.type, name: body.name, boundsMm: body.boundsMm, faceIds: body.faceIds, edgeIds: body.edgeIds }; }
function numberListNear(actual: number[], expected: number[], tolerance: number, label: string): void { requireCondition(actual.length === expected.length, `${label}: expected ${expected.length} values, got ${actual.length}`); actual.forEach((value, index) => near(value, expected[index]!, tolerance, `${label}[${index}]`)); }
function vectorNear(actual: number[], expected: number[], tolerance: number, label: string): void { numberListNear(actual, expected, tolerance, label); }
function near(actual: unknown, expected: number, tolerance: number, label: string): void { requireCondition(typeof actual === "number" && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${String(actual)}`); }
function requireEmpty(state: any, label: string): void { requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0, `${label} is not empty`); requireCondition((state.groups ?? []).filter((group: { id: number }) => group.id !== 0).length === 0, `${label} contains non-root groups`); }
function stateSummary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, regionCount: state.regions.length }; }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

async function startMcp(storeRoot: string): Promise<LiveMcp> { const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" }, stderr: "pipe" }); const stderr: string[] = []; transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); }); const client = new Client({ name: "plasticity-native-closed-wire-patch-live", version: "1.0.0" }); await client.connect(transport); return { client, stderr }; }
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> { const response = await client.callTool({ name, arguments: args }); const output = toolText(response); if ("isError" in response && response.isError) throw new Error(output); return JSON.parse(output); }
function toolText(response: unknown): string { if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content"); const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string"); if (!item) throw new Error("MCP tool returned no text content"); return item.text; }
async function recover(client: Client, initial: any): Promise<Record<string, unknown>> { for (let count = 0; count < 16; count += 1) { const status = await call(client, "plasticity_status", {}); if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" }; if (status.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: status.bodies.length === 0 && status.regions.length === 0 }; await call(client, "plasticity_undo", { intent: "Recover disposable native closed-Wire patch acceptance", revision: status.revision }); } return { restoredEmptyDocument: false, reason: "undo-limit" }; }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
