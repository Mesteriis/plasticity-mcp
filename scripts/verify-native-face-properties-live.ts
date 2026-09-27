#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface NativeFacePropertiesAcceptanceOptions { help: boolean; target?: string; allowDisposableMutations: boolean; output?: string }
interface LiveMcp { client: Client; stderr: string[] }

export function parseNativeFacePropertiesAcceptanceArgs(argv: string[]): NativeFacePropertiesAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: NativeFacePropertiesAcceptanceOptions = { help: false, allowDisposableMutations: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--allow-disposable-mutations") options.allowDisposableMutations = true;
    else if (argument === "--target") { const value = argv[++index]; if (!value) throw new Error("--target requires an explicit Plasticity window ID"); options.target = value; }
    else if (argument === "--output") { const value = argv[++index]; if (!value) throw new Error("--output requires a new directory path"); options.output = value; }
    else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Live native face-properties acceptance requires --target with an explicit Plasticity window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native face-properties acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native face-properties acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-face-properties-live.ts --help
  node scripts/verify-native-face-properties-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

Live mode refuses a nonempty Plasticity document, cuts a centered hole through a
disposable box, measures exact native properties of its trimmed top face, proves
the measurement is read-only, restores the empty document, and writes evidence.`;

async function main(): Promise<void> {
  const options = parseNativeFacePropertiesAcceptanceArgs(process.argv.slice(2));
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
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-face-properties-live-initial-empty" });

    let state = await call(live.client, "plasticity_create_box", {
      originMm: [0, 0, 0], sizeMm: [20, 10, 5], name: "Face properties box",
      intent: "Approved disposable native face-properties box", revision: initialState.revision,
    });
    const box = state.bodies.find((body: any) => body.name === "Face properties box" && body.type === "Solid");
    requireCondition(Number.isInteger(box?.id), "Disposable box is unavailable");
    state = await call(live.client, "plasticity_create_cylinder", {
      centerMm: [10, 5, -1], radiusMm: 2, heightMm: 7, axis: [0, 0, 1], name: "Face properties cutter",
      intent: "Approved disposable native face-properties cutter", revision: state.revision,
    });
    const cutter = state.bodies.find((body: any) => body.name === "Face properties cutter" && body.type === "Solid");
    requireCondition(Number.isInteger(cutter?.id), "Disposable cylinder cutter is unavailable");
    state = await call(live.client, "plasticity_boolean", {
      targetIds: [box.id], toolIds: [cutter.id], operation: "difference", keepTools: false,
      intent: "Create a centered trimmed planar face for native face-property acceptance", revision: state.revision,
    });
    const result = state.bodies.find((body: any) => body.type === "Solid");
    requireCondition(result && state.bodies.filter((body: any) => body.type === "Solid").length === 1, "Holed result Solid is unavailable");
    const top = result.faces.find((face: any) => face.planar && Math.abs(face.centerMm[2] - 5) <= 1e-8 && face.normal[2] > 0.999999);
    requireCondition(top, "Trimmed top face is unavailable");
    const beforeMeasurement = stateSummary(state);
    const report = await call(live.client, "plasticity_measure_face_properties", {
      faces: [{ bodyId: result.id, faceId: top.id }], revision: state.revision,
    });
    requireCondition(report.source === "native-brep-face-mass-properties", "Face-property provenance is not native B-Rep");
    requireCondition(report.faces?.length === 1, "Expected one exact face-property result");
    const measured = report.faces[0];
    requireCondition(measured.face.bodyId === result.id && measured.face.faceId === top.id, "Measured face identity mismatch");
    requireCondition(measured.surfaceType === "Plane" && measured.planar === true, "Measured face is not the expected native Plane");
    near(measured.areaMm2, 200 - Math.PI * 4, 1e-6, "trimmed face area");
    near(measured.boundaryLengthMm, 60 + Math.PI * 4, 1e-6, "trimmed face boundary length");
    vectorNear(measured.areaCentroidMm, [10, 5, 5], 1e-8, "trimmed face area centroid");
    requireCondition(measured.loopCount === 2 && measured.innerLoopCount === 1, "Trimmed face did not expose one outer and one inner loop");
    requireCondition(measured.nativeCheckCodes.length === 0, "Measured face failed native validation");
    near(report.totals.areaMm2, measured.areaMm2, 1e-9, "total face area");
    near(report.totals.summedBoundaryLengthMm, measured.boundaryLengthMm, 1e-9, "summed boundary length");
    vectorNear(report.totals.areaWeightedCentroidMm, measured.areaCentroidMm, 1e-9, "area-weighted centroid");
    state = await call(live.client, "plasticity_status", {}); sameDocumentState(stateSummary(state), beforeMeasurement, "Face-property measurement");
    evidence.faceProperties = { report, readOnly: true };

    while (state.undoDepth > initialState.undoDepth) state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable native face-properties acceptance", revision: state.revision });
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

function sameDocumentState(actual: any, expected: any, label: string): void { for (const field of ["documentToken", "revision", "undoDepth", "redoDepth", "bodyCount", "regionCount"]) requireCondition(actual[field] === expected[field], `${label} changed ${field}`); }
function requireEmpty(state: any, label: string): void { requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0, `${label} is not empty`); requireCondition((state.groups ?? []).filter((group: { id: number }) => group.id !== 0).length === 0, `${label} contains non-root groups`); }
async function startMcp(storeRoot: string): Promise<LiveMcp> { const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" }, stderr: "pipe" }); const stderr: string[] = []; transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); }); const client = new Client({ name: "plasticity-native-face-properties-live", version: "1.0.0" }); await client.connect(transport); return { client, stderr }; }
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> { const response = await client.callTool({ name, arguments: args }); const output = toolText(response); if ("isError" in response && response.isError) throw new Error(output); return JSON.parse(output); }
function toolText(response: unknown): string { if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content"); const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string"); if (!item) throw new Error("MCP tool returned no text content"); return item.text; }
async function recover(client: Client, initial: any): Promise<Record<string, unknown>> { for (let count = 0; count < 24; count += 1) { const status = await call(client, "plasticity_status", {}); if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" }; if (status.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: status.bodies.length === 0 && status.regions.length === 0 }; await call(client, "plasticity_undo", { intent: "Recover disposable native face-properties acceptance", revision: status.revision }); } return { restoredEmptyDocument: false, reason: "undo-limit" }; }
function stateSummary(state: any): Record<string, any> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, regionCount: state.regions.length }; }
function near(actual: number, expected: number, tolerance: number, label: string): void { requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`); }
function vectorNear(actual: number[], expected: number[], tolerance: number, label: string): void { requireCondition(actual.length === expected.length, `${label}: vector length mismatch`); actual.forEach((value, index) => near(value, expected[index]!, tolerance, `${label}[${index}]`)); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
