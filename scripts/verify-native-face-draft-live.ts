#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface NativeFaceDraftAcceptanceOptions { help: boolean; target?: string; allowDisposableMutations: boolean; output?: string }
interface LiveMcp { client: Client; stderr: string[] }

export function parseNativeFaceDraftAcceptanceArgs(argv: string[]): NativeFaceDraftAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: NativeFaceDraftAcceptanceOptions = { help: false, allowDisposableMutations: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--allow-disposable-mutations") options.allowDisposableMutations = true;
    else if (argument === "--target") { const value = argv[++index]; if (!value) throw new Error("--target requires an explicit Plasticity window ID"); options.target = value; }
    else if (argument === "--output") { const value = argv[++index]; if (!value) throw new Error("--output requires a new directory path"); options.output = value; }
    else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Live native face-draft acceptance requires --target with an explicit Plasticity window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native face-draft acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native face-draft acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-face-draft-live.ts --help
  node scripts/verify-native-face-draft-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

Live mode refuses a nonempty Plasticity document, creates a disposable box and
cylinder, classifies their native face-normal grids relative to +Z, proves the
analysis is read-only, restores the empty document, and writes bounded evidence.`;

async function main(): Promise<void> {
  const options = parseNativeFaceDraftAcceptanceArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!); await mkdir(output, { mode: 0o700 });
  const evidence: Record<string, unknown> = { schemaVersion: 1, startedAt: new Date().toISOString(), targetId: options.target!, workbenchUsed: false };
  let live: LiveMcp | undefined; let initialState: any;
  try {
    live = await startMcp(join(output, "strength-store"));
    const windows = await call(live.client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    initialState = await call(live.client, "plasticity_connect", { targetId: options.target });
    requireEmpty(initialState, "initial document"); evidence.initial = stateSummary(initialState);
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-face-draft-live-initial-empty" });

    let state = await call(live.client, "plasticity_create_box", {
      originMm: [0, 0, 0], sizeMm: [20, 10, 5], name: "Draft box",
      intent: "Approved disposable native face-draft box", revision: initialState.revision,
    });
    const box = state.bodies.find((body: any) => body.name === "Draft box" && body.type === "Solid");
    requireCondition(box?.faces?.length === 6, "Disposable draft box is unavailable");
    state = await call(live.client, "plasticity_create_cylinder", {
      centerMm: [40, 0, 0], radiusMm: 5, heightMm: 10, axis: [0, 0, 1], name: "Draft cylinder",
      intent: "Approved disposable native face-draft cylinder", revision: state.revision,
    });
    const cylinder = state.bodies.find((body: any) => body.name === "Draft cylinder" && body.type === "Solid");
    requireCondition(cylinder?.faces?.length === 3, "Disposable draft cylinder is unavailable");
    const beforeAnalysis = stateSummary(state);
    const boxFaceIds = new Set(box.faces.map((face: any) => face.id));
    const references = [...box.faces.map((face: any) => ({ bodyId: box.id, faceId: face.id })), ...cylinder.faces.map((face: any) => ({ bodyId: cylinder.id, faceId: face.id }))];
    const report = await call(live.client, "plasticity_analyze_face_draft", {
      faces: references, pullDirection: [0, 0, 1], minimumDraftDeg: 2, samplesPerDirection: 8, revision: state.revision,
    });
    requireCondition(report.analyses?.length === 9, "Expected nine native face-draft analyses");
    const boxAnalyses = report.analyses.filter((analysis: any) => boxFaceIds.has(analysis.face.faceId));
    const cylinderAnalyses = report.analyses.filter((analysis: any) => analysis.face.bodyId === cylinder.id);
    requireClassCounts(boxAnalyses, { positive: 1, negative: 1, neutral: 4, mixed: 0 }, "box");
    requireClassCounts(cylinderAnalyses, { positive: 1, negative: 1, neutral: 1, mixed: 0 }, "cylinder");
    const cylindrical = cylinderAnalyses.find((analysis: any) => analysis.surfaceType === "Cylinder");
    requireCondition(cylindrical?.classification === "neutral", "Cylinder wall was not neutral relative to its axis");
    near(cylindrical.minimumSignedDraft.valueDeg, 0, 1e-9, "cylinder minimum signed draft");
    near(cylindrical.maximumSignedDraft.valueDeg, 0, 1e-9, "cylinder maximum signed draft");
    requireCondition(report.analyses.every((analysis: any) => analysis.measurementSource === "native-brep-face-normal-grid" && analysis.sampleCount > 0), "Draft provenance or sample count is missing");
    state = await call(live.client, "plasticity_status", {}); sameDocumentState(state, beforeAnalysis, "Face-draft analysis");
    evidence.analysis = { pullDirection: report.pullDirection, minimumDraftDeg: report.minimumDraftDeg, samplesPerDirection: report.samplesPerDirection, box: boxAnalyses, cylinder: cylinderAnalyses, limitation: report.limitation, readOnly: true };

    while (state.undoDepth > initialState.undoDepth) state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable native face-draft acceptance", revision: state.revision });
    requireEmpty(state, "cleaned document");
    const changes = await call(live.client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(changes.diff), "Scene content differs from the initial empty snapshot after cleanup");
    evidence.cleanup = { restoredEmptyDocument: true, sceneContentsRestored: true };
    evidence.completedAt = new Date().toISOString(); await writeExclusive(join(output, "evidence.json"), sanitizeEvidence(evidence));
    console.log(JSON.stringify({ ok: true, output, evidence: join(output, "evidence.json") }, null, 2));
  } catch (error) {
    evidence.failure = boundedError(error);
    if (live && initialState && !evidence.cleanup) evidence.cleanup = await recover(live.client, initialState).catch((cleanupError) => ({ restoredEmptyDocument: false, reason: boundedError(cleanupError) }));
    await writeExclusive(join(output, "failure.json"), sanitizeEvidence(evidence)).catch(() => {}); throw error;
  } finally { await live?.client.close().catch(() => {}); }
}

function requireClassCounts(analyses: any[], expected: Record<string, number>, label: string): void { const actual = { positive: 0, negative: 0, neutral: 0, mixed: 0 }; for (const analysis of analyses) { requireCondition(analysis.classification in actual, `${label} returned an unknown classification`); actual[analysis.classification as keyof typeof actual] += 1; } requireCondition(JSON.stringify(actual) === JSON.stringify(expected), `${label} draft classes: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
function sameDocumentState(actual: any, expected: any, label: string): void { requireCondition(actual.documentToken === expected.documentToken && actual.revision === expected.revision, `${label} changed the document or revision`); requireCondition(actual.undoDepth === expected.undoDepth && actual.redoDepth === expected.redoDepth, `${label} changed Undo/Redo history`); }
function requireEmpty(state: any, label: string): void { requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0, `${label} is not empty`); requireCondition((state.groups ?? []).filter((group: { id: number }) => group.id !== 0).length === 0, `${label} contains non-root groups`); }
async function startMcp(storeRoot: string): Promise<LiveMcp> { const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" }, stderr: "pipe" }); const stderr: string[] = []; transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); }); const client = new Client({ name: "plasticity-native-face-draft-live", version: "1.0.0" }); await client.connect(transport); return { client, stderr }; }
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> { const response = await client.callTool({ name, arguments: args }); const output = toolText(response); if ("isError" in response && response.isError) throw new Error(output); return JSON.parse(output); }
function toolText(response: unknown): string { if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content"); const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string"); if (!item) throw new Error("MCP tool returned no text content"); return item.text; }
async function recover(client: Client, initial: any): Promise<Record<string, unknown>> { for (let count = 0; count < 24; count += 1) { const status = await call(client, "plasticity_status", {}); if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" }; if (status.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: status.bodies.length === 0 && status.regions.length === 0 }; await call(client, "plasticity_undo", { intent: "Recover disposable native face-draft acceptance", revision: status.revision }); } return { restoredEmptyDocument: false, reason: "undo-limit" }; }
function stateSummary(state: any): Record<string, any> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, regionCount: state.regions.length }; }
function near(actual: number, expected: number, tolerance: number, label: string): void { requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
