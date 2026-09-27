#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LINEAR_TOLERANCE_MM = 0.01;

export interface NativeCurveLoftAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parseNativeCurveLoftAcceptanceArgs(argv: string[]): NativeCurveLoftAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: NativeCurveLoftAcceptanceOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live native-curve-loft acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native-curve-loft acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native-curve-loft acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-curve-loft-live.ts --help
  node scripts/verify-native-curve-loft-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode refuses a nonempty Plasticity document, never chooses a window
automatically, verifies guided open and closed-sequence Wire lofts through the
public MCP tool, checks exact B-Rep topology, Undo/Redo, journal sync and final
cleanup, then writes bounded evidence.`;

async function main(): Promise<void> {
  const options = parseNativeCurveLoftAcceptanceArgs(process.argv.slice(2));
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
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-curve-loft-live-initial-empty" });
    let state = initialState;

    const openFirst = await createPolyline(live.client, state, [[0, 0, 0], [20, 0, 0]]);
    state = openFirst.state;
    const openSecond = await createPolyline(live.client, state, [[0, 10, 20], [20, 10, 20]]);
    state = openSecond.state;
    const guide = await createNurbs(live.client, state, [[0, 0, 0], [8, 8, 10], [0, 10, 20]]);
    state = guide.state;
    const openSourceIds = [openFirst.id, openSecond.id, guide.id];
    const openBeforeIds = new Set<number>(state.bodies.map((body: { id: number }) => body.id));
    const openBeforeDepth = state.undoDepth;
    state = await call(live.client, "plasticity_loft_curves", {
      profileIds: [openFirst.id, openSecond.id], guideIds: [guide.id],
      trimGuides: true, trimProfiles: true, closed: false, simplify: true,
      curvature: "clamped", startMagnitude: 1.5, endMagnitude: 0.75,
      intent: "Approved disposable guided open Wire loft acceptance", revision: state.revision,
    });
    requireCondition(state.undoDepth === openBeforeDepth + 1, "Guided Wire loft did not use one native history step");
    openSourceIds.forEach((id) => requireBody(state, id, "Wire"));
    const openResult = onlyNewBody(state, openBeforeIds, "guided Wire loft");
    requireCondition(openResult.type === "Sheet" && openResult.faces.length === 1, "Guided Wire loft did not create one-face Sheet");
    requireCondition(openResult.faces[0].surfaceType === "BSurf" && openResult.faces[0].planar === false, "Guided Wire loft did not create a nonplanar B-Surface");
    requireCondition(openResult.edges.length === 4 && openResult.edges.some((edge: any) => edge.curveType === "BCurve"), "Guided Wire loft boundary topology is unexpected");
    requireBounds(openResult, [0, 0, 0], [20, 10.179077037396247, 20], "guided Wire loft");
    const openValidation = await call(live.client, "plasticity_validate_bodies", { ids: [openResult.id], revision: state.revision });
    requireCondition(openValidation.bodies.length === 1 && openValidation.bodies[0].nativeValid === true && openValidation.bodies[0].nativeCheckCodes.length === 0, "Guided Wire loft failed native validation");
    state = await call(live.client, "plasticity_undo", { intent: "Verify guided Wire loft Undo", revision: state.revision });
    requireCondition(!state.bodies.some((body: any) => body.id === openResult.id), "Guided Wire loft Undo retained the result");
    openSourceIds.forEach((id) => requireBody(state, id, "Wire"));
    state = await call(live.client, "plasticity_redo", { intent: "Verify guided Wire loft Redo", revision: state.revision });
    requireBody(state, openResult.id, "Sheet");
    evidence.guidedOpenLoft = {
      profileIds: [openFirst.id, openSecond.id], guideId: guide.id, resultBodyId: openResult.id,
      curvature: "clamped", startMagnitude: 1.5, endMagnitude: 0.75,
      resultBoundsMm: openResult.boundsMm, resultTopology: { faceCount: 1, edgeCount: 4, surfaceType: "BSurf" },
      validation: openValidation, sourcesPreserved: true, oneHistoryStep: true, undoRedoStableId: true,
    };

    const closedFirst = await createPolyline(live.client, state, [[50, 0, 0], [70, 0, 0]]);
    state = closedFirst.state;
    const closedSecond = await createPolyline(live.client, state, [[50, 10, 10], [70, 10, 10]]);
    state = closedSecond.state;
    const closedThird = await createPolyline(live.client, state, [[50, 0, 20], [70, 0, 20]]);
    state = closedThird.state;
    const closedSourceIds = [closedFirst.id, closedSecond.id, closedThird.id];
    const closedBeforeIds = new Set<number>(state.bodies.map((body: { id: number }) => body.id));
    const closedBeforeDepth = state.undoDepth;
    state = await call(live.client, "plasticity_loft_curves", {
      profileIds: closedSourceIds, guideIds: [], trimGuides: true, trimProfiles: true,
      closed: true, simplify: true, curvature: "unconstrained", startMagnitude: 1, endMagnitude: 1,
      intent: "Approved disposable closed-sequence Wire loft acceptance", revision: state.revision,
    });
    requireCondition(state.undoDepth === closedBeforeDepth + 1, "Closed Wire loft did not use one native history step");
    closedSourceIds.forEach((id) => requireBody(state, id, "Wire"));
    const closedResult = onlyNewBody(state, closedBeforeIds, "closed Wire loft");
    requireCondition(closedResult.type === "Sheet" && closedResult.faces.length === 1 && closedResult.faces[0].surfaceType === "BSurf", "Closed Wire loft did not create one B-Surface Sheet");
    requireCondition(closedResult.edges.length === 3 && closedResult.edges.filter((edge: any) => edge.curveType === "BCurve").length === 2, "Closed Wire loft boundary topology is unexpected");
    requireBounds(closedResult, [50, -3.9180581244561212, -0.69035593728849], [70, 10, 20.69035593728849], "closed Wire loft");
    const closedValidation = await call(live.client, "plasticity_validate_bodies", { ids: [closedResult.id], revision: state.revision });
    requireCondition(closedValidation.bodies.length === 1 && closedValidation.bodies[0].nativeValid === true && closedValidation.bodies[0].nativeCheckCodes.length === 0, "Closed Wire loft failed native validation");
    state = await call(live.client, "plasticity_undo", { intent: "Verify closed Wire loft Undo", revision: state.revision });
    requireCondition(!state.bodies.some((body: any) => body.id === closedResult.id), "Closed Wire loft Undo retained the result");
    state = await call(live.client, "plasticity_redo", { intent: "Verify closed Wire loft Redo", revision: state.revision });
    requireBody(state, closedResult.id, "Sheet");
    evidence.closedLoft = {
      profileIds: closedSourceIds, resultBodyId: closedResult.id, resultBoundsMm: closedResult.boundsMm,
      resultTopology: { faceCount: 1, edgeCount: 3, surfaceType: "BSurf" }, validation: closedValidation,
      sourcesPreserved: true, oneHistoryStep: true, undoRedoStableId: true,
    };

    while (state.undoDepth > initialState.undoDepth) state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable native Wire loft acceptance", revision: state.revision });
    requireEmpty(state, "cleaned document");
    const changes = await call(live.client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(changes.diff), "Scene content differs from the initial empty snapshot after cleanup");
    const journal = await call(live.client, "plasticity_construction_journal", {});
    requireCondition(journal.syncStatus === "in-sync" && !journal.entries.some((entry: { status: string }) => entry.status === "unknown"), "Construction journal diverged during Wire loft acceptance");
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

async function createPolyline(client: Client, state: any, pointsMm: number[][]): Promise<{ state: any; id: number }> {
  return await createWire(client, state, "plasticity_create_polyline", { pointsMm, closed: false });
}
async function createNurbs(client: Client, state: any, pointsMm: number[][]): Promise<{ state: any; id: number }> {
  return await createWire(client, state, "plasticity_create_nurbs_curve", { pointsMm, closed: false });
}
async function createWire(client: Client, state: any, tool: string, input: Record<string, unknown>): Promise<{ state: any; id: number }> {
  const before = new Set(state.bodies.map((body: { id: number }) => body.id));
  const next = await call(client, tool, { ...input, intent: "Approved disposable native Wire loft source", revision: state.revision });
  const added = next.bodies.filter((body: any) => !before.has(body.id) && body.type === "Wire");
  requireCondition(added.length === 1, `${tool} did not add exactly one Wire`);
  return { state: next, id: added[0].id };
}
function onlyNewBody(state: any, before: Set<number>, label: string): any { const added = state.bodies.filter((body: any) => !before.has(body.id)); requireCondition(added.length === 1, `${label} did not add exactly one body`); return added[0]; }
function requireBody(state: any, id: number, type: string): any { const body = state.bodies.find((candidate: any) => candidate.id === id); requireCondition(body?.type === type, `Missing current ${type} body ${id}`); return body; }
function requireBounds(body: any, min: number[], max: number[], label: string): void { requireCondition(body.boundsMm, `${label} has no bounds`); vectorNear(body.boundsMm.min, min, LINEAR_TOLERANCE_MM, `${label} min`); vectorNear(body.boundsMm.max, max, LINEAR_TOLERANCE_MM, `${label} max`); }
function requireEmpty(state: any, label: string): void { requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0, `${label} is not empty`); requireCondition((state.groups ?? []).filter((group: { id: number }) => group.id !== 0).length === 0, `${label} contains non-root groups`); }

async function startMcp(storeRoot: string): Promise<LiveMcp> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" }, stderr: "pipe" });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); });
  const client = new Client({ name: "plasticity-native-curve-loft-live", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> { const response = await client.callTool({ name, arguments: args }); const text = toolText(response); if ("isError" in response && response.isError) throw new Error(text); return JSON.parse(text); }
function toolText(response: unknown): string { if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content"); const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string"); if (!item) throw new Error("MCP tool returned no text content"); return item.text; }
async function recover(client: Client, initial: any): Promise<Record<string, unknown>> { for (let count = 0; count < 32; count += 1) { const status = await call(client, "plasticity_status", {}); if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" }; if (status.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: status.bodies.length === 0 && status.regions.length === 0 }; await call(client, "plasticity_undo", { intent: "Recover disposable native Wire loft acceptance", revision: status.revision }); } return { restoredEmptyDocument: false, reason: "undo-limit" }; }
function stateSummary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, regionCount: state.regions.length }; }
function vectorNear(actual: number[], expected: number[], tolerance: number, label: string): void { requireCondition(actual.length === expected.length, `${label}: vector length mismatch`); actual.forEach((value, index) => requireCondition(Number.isFinite(value) && Math.abs(value - expected[index]!) <= tolerance, `${label}[${index}]: expected ${expected[index]} ± ${tolerance}, got ${value}`)); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
