#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOLERANCE_MM = 0.01;

interface Options { help: boolean; target?: string; output?: string; allowDisposableMutations: boolean }
interface LiveMcp { client: Client; stderr: string[] }

function parseArgs(argv: string[]): Options {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: Options = { help: false, allowDisposableMutations: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--allow-disposable-mutations") options.allowDisposableMutations = true;
    else if (argument === "--target") { const value = argv[++index]; if (!value) throw new Error("--target requires an ID"); options.target = value; }
    else if (argument === "--output") { const value = argv[++index]; if (!value) throw new Error("--output requires a directory"); options.output = value; }
    else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Specify one Plasticity window with --target");
  if (!options.allowDisposableMutations) throw new Error("Pass --allow-disposable-mutations to enable disposable CAD operations");
  if (!options.output) throw new Error("Specify a new evidence directory with --output");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-print-orientation-live.ts --help
  node scripts/verify-native-print-orientation-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

Live mode requires an explicit Plasticity window and an empty document. It creates
one disposable Solid, rejects a mismatched DFM size before mutation, applies a
matching Workbench Euler rotation through public MCP, checks native B-Rep bounds,
exercises Undo/Redo, and restores the initially empty document.`;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  await mkdir(output, { recursive: false, mode: 0o700 });
  const evidence: Record<string, unknown> = { schemaVersion: 1, startedAt: new Date().toISOString(), targetId: options.target };
  let live: LiveMcp | undefined;
  let initial: any;
  try {
    live = await startMcp(join(output, "strength-store"));
    const windows = await call(live.client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    initial = await call(live.client, "plasticity_connect", { targetId: options.target });
    requireEmpty(initial, "initial document");
    evidence.initial = stateSummary(initial);

    let state = await call(live.client, "plasticity_create_box", {
      originMm: [0, 0, 0], sizeMm: [20, 10, 5], name: "Print orientation group A",
      intent: "Create the first disposable Solid for live group-orientation verification", revision: initial.revision,
    });
    state = await call(live.client, "plasticity_create_box", {
      originMm: [30, 0, 0], sizeMm: [10, 10, 5], name: "Print orientation group B",
      intent: "Create a second separated Solid in the same disposable rigid group", revision: state.revision,
    });
    requireCondition(state.bodies.length === 2, "Expected two disposable native Solids");
    const bodyIds = state.bodies.map((body: { id: number }) => body.id);
    requireBounds(unionBodyBounds(state.bodies), [0, 0, 0], [40, 10, 5], "source Solid-group bounds");
    const beforeRotation = stateSummary(state);
    const beforeUndoDepth: number = state.undoDepth;

    const mismatch = await live.client.callTool({ name: "plasticity_orient_bodies_for_print", arguments: {
      bodyIds, rotationDeg: [90, 0, 90], expectedSizeMm: [40, 10, 5],
      intent: "Verify DFM mismatch is refused without changing the disposable Solid group", revision: state.revision,
    } });
    requireCondition("isError" in mismatch && mismatch.isError === true, "Mismatched DFM bounds must be rejected before mutation");
    state = await call(live.client, "plasticity_status", {});
    requireCondition(state.revision === beforeRotation.revision && state.undoDepth === beforeRotation.undoDepth, "Rejected DFM bounds changed Plasticity state");

    state = await call(live.client, "plasticity_orient_bodies_for_print", {
      bodyIds, rotationDeg: [90, 0, 90], expectedSizeMm: [5, 40, 10],
      intent: "Apply the matching Workbench build-volume orientation to both disposable Solids as one rigid group", revision: state.revision,
    });
    requireCondition(state.status === "verified", `Orientation verification status was ${String(state.status)}`);
    requireCondition(state.measurementSource === "native-brep", "Orientation bounds did not come from native B-Rep");
    requireCondition(state.slicerFitVerified === false, "The tool must not claim slicer fit verification");
    nearVector(state.measuredSizeMm, [5, 40, 10], TOLERANCE_MM, "oriented native Solid-group size");
    nearVector(state.pivotMm, [20, 5, 2.5], TOLERANCE_MM, "B-Rep group center pivot");
    requireCondition(JSON.stringify(state.bodyIds) === JSON.stringify(bodyIds), "The result does not identify every transformed body");
    requireCondition(state.maxDeviationMm <= TOLERANCE_MM, "Native B-Rep orientation exceeded its declared tolerance");
    const orientationResult = state;
    const rotatedRevision = state.revision;
    const rotatedBodyBounds = state.measuredBoundsMm;
    const statusAfterRotation = await call(live.client, "plasticity_status", {});
    requireCondition(statusAfterRotation.undoDepth === beforeUndoDepth + 1, "Orientation did not create one Plasticity history step");

    state = await call(live.client, "plasticity_undo", { intent: "Verify print orientation Undo", revision: rotatedRevision });
    requireCondition(state.bodies.length === 2, "Undo removed a member of the source Solid group");
    requireBounds(unionBodyBounds(state.bodies), [0, 0, 0], [40, 10, 5], "Undo-restored source group bounds");
    state = await call(live.client, "plasticity_redo", { intent: "Verify print orientation Redo", revision: state.revision });
    requireBounds(unionBodyBounds(state.bodies), rotatedBodyBounds.min, rotatedBodyBounds.max, "Redo-restored oriented group bounds");
    state = await call(live.client, "plasticity_undo", { intent: "Restore disposable source before final cleanup", revision: state.revision });
    state = await call(live.client, "plasticity_undo", { intent: "Remove the second disposable print-orientation Solid", revision: state.revision });
    state = await call(live.client, "plasticity_undo", { intent: "Remove the first disposable print-orientation Solid", revision: state.revision });
    requireEmpty(state, "final document");
    evidence.result = {
      status: orientationResult.status, rotationDeg: orientationResult.rotationDeg, pivotMm: orientationResult.pivotMm, expectedSizeMm: orientationResult.expectedSizeMm,
      measuredSizeMm: orientationResult.measuredSizeMm, measuredBoundsMm: rotatedBodyBounds,
      maxDeviationMm: orientationResult.maxDeviationMm, toleranceMm: orientationResult.toleranceMm, mismatchRejectedBeforeMutation: true,
      oneHistoryStep: true, undoRedo: true, restoredEmptyDocument: true, final: stateSummary(state),
    };
  } catch (error) {
    evidence.error = boundedError(error);
    if (live && initial) {
      try { evidence.recovery = await recover(live.client, initial); } catch (recoveryError) { evidence.recoveryError = boundedError(recoveryError); }
    }
    throw error;
  } finally {
    evidence.finishedAt = new Date().toISOString();
    if (live) evidence.serverStderr = live.stderr.join("").slice(-8000);
    await writeFile(join(output, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await live?.client.close();
  }
}

async function startMcp(storeRoot: string): Promise<LiveMcp> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot,
    env: selectedEnvironment(process.env, storeRoot), stderr: "pipe" });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); });
  const client = new Client({ name: "plasticity-native-print-orientation-live", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await client.callTool({ name, arguments: args });
  const output = toolText(response);
  if ("isError" in response && response.isError) throw new Error(output);
  return JSON.parse(output);
}
function toolText(response: unknown): string {
  if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content");
  const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string");
  if (!item) throw new Error("MCP tool returned no text content");
  return item.text;
}
function unionBodyBounds(bodies: Array<{ boundsMm?: { min: number[]; max: number[] } }>): { min: number[]; max: number[] } {
  requireCondition(bodies.length > 0 && bodies.every((body) => body.boundsMm), "Every native Solid needs current bounds");
  return {
    min: [0, 1, 2].map((axis) => Math.min(...bodies.map((body) => body.boundsMm!.min[axis]!))),
    max: [0, 1, 2].map((axis) => Math.max(...bodies.map((body) => body.boundsMm!.max[axis]!))),
  };
}
function requireEmpty(state: any, label: string): void { requireCondition(state.bodies.length === 0 && state.regions.length === 0, `${label} is not empty; refusing disposable mutation`); }
function requireBounds(bounds: any, min: number[], max: number[], label: string): void {
  requireCondition(bounds, `${label} are unavailable`);
  nearVector(bounds.min, min, TOLERANCE_MM, `${label} minimum`);
  nearVector(bounds.max, max, TOLERANCE_MM, `${label} maximum`);
}
function nearVector(actual: number[], expected: number[], tolerance: number, label: string): void {
  requireCondition(Array.isArray(actual) && actual.length === 3, `${label} is not a 3-vector`);
  actual.forEach((value, axis) => requireCondition(Number.isFinite(value) && Math.abs(value - expected[axis]!) <= tolerance, `${label}[${axis}] expected ${expected[axis]} ± ${tolerance}, got ${value}`));
}
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function stateSummary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, regionCount: state.regions.length }; }
async function recover(client: Client, initial: any): Promise<Record<string, unknown>> {
  for (let count = 0; count < 24; count += 1) {
    const status = await call(client, "plasticity_status", {});
    if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" };
    if (status.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: status.bodies.length === 0 && status.regions.length === 0 };
    await call(client, "plasticity_undo", { intent: "Recover disposable print-orientation acceptance", revision: status.revision });
  }
  return { restoredEmptyDocument: false, reason: "undo-limit" };
}
function selectedEnvironment(environment: NodeJS.ProcessEnv, storeRoot: string): Record<string, string> {
  return {
    ...Object.fromEntries(["PATH", "HOME", "TMPDIR"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])),
    PLASTICITY_STRENGTH_ROOT: storeRoot,
    PLASTICITY_CDP_URL: environment.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223",
  };
}
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
