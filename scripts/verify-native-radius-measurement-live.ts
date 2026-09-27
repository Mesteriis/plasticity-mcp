#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface NativeRadiusMeasurementAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parseNativeRadiusMeasurementAcceptanceArgs(argv: string[]): NativeRadiusMeasurementAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: NativeRadiusMeasurementAcceptanceOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live native radius-measurement acceptance requires --target with an explicit Plasticity window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native radius-measurement acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native radius-measurement acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-radius-measurement-live.ts --help
  node scripts/verify-native-radius-measurement-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode refuses a nonempty Plasticity document, creates persistent native
radius measurements on an R10 Wire and an R5 Solid edge, verifies exact values,
Undo/Redo, topology targets, and cleanup, then writes bounded evidence.`;

async function main(): Promise<void> {
  const options = parseNativeRadiusMeasurementAcceptanceArgs(process.argv.slice(2));
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
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-radius-measurement-live-initial-empty" });

    let state = await call(live.client, "plasticity_create_circle", {
      centerMm: [0, 0, 0], radiusMm: 10,
      intent: "Approved disposable native Wire radius-measurement source", revision: initialState.revision,
    });
    const circle = onlyNewBody(initialState, state, "Wire", "circle");
    const directions = await call(live.client, "plasticity_list_curve_directions", {});
    const circleDirection = directions.curves.find((curve: any) => curve.id === circle.id);
    requireCondition(circleDirection?.segments?.length === 1, "Circle did not expose one native segment");
    state = await call(live.client, "plasticity_create_radius_measurement", {
      edge: { bodyId: circle.id, segmentEntityId: circleDirection.segments[0].entityId },
      name: "Wire R10", intent: "Persist exact Wire radius", revision: state.revision,
    });
    const wireMeasurement = onlyMeasurement(state, "Wire R10");
    verifyRadius(wireMeasurement, circle.id, 10, 20, "Wire measurement");

    const beforeCylinder = state;
    state = await call(live.client, "plasticity_create_cylinder", {
      centerMm: [40, 0, 0], radiusMm: 5, heightMm: 10, axis: [0, 0, 1],
      intent: "Approved disposable native Solid radius-measurement source", revision: state.revision,
    });
    const cylinder = onlyNewBody(beforeCylinder, state, "Solid", "cylinder");
    const circularEdge = cylinder.edges.find((edge: any) => edge.circle === true);
    requireCondition(circularEdge, "Cylinder did not expose a circular shell edge");
    state = await call(live.client, "plasticity_create_radius_measurement", {
      edge: { bodyId: cylinder.id, edgeId: circularEdge.id },
      name: "Solid R5", intent: "Persist exact Solid-edge radius", revision: state.revision,
    });
    const solidMeasurement = onlyMeasurement(state, "Solid R5");
    verifyRadius(solidMeasurement, cylinder.id, 5, 10, "Solid measurement");

    const listed = await call(live.client, "plasticity_list_measurements", {});
    requireCondition(listed.measurements.length === 2, "Expected exactly two persistent radius measurements");
    verifyRadius(onlyMeasurement(listed, "Wire R10"), circle.id, 10, 20, "Listed Wire measurement");
    verifyRadius(onlyMeasurement(listed, "Solid R5"), cylinder.id, 5, 10, "Listed Solid measurement");
    evidence.measurements = listed.measurements;

    state = await call(live.client, "plasticity_undo", { intent: "Verify radius-measurement Undo", revision: state.revision });
    requireCondition((state.measurements ?? []).length === 1 && onlyMeasurement(state, "Wire R10").id === wireMeasurement.id, "Undo did not remove only the Solid radius measurement");
    state = await call(live.client, "plasticity_redo", { intent: "Verify radius-measurement Redo", revision: state.revision });
    requireCondition((state.measurements ?? []).some((measurement: any) => measurement.id === solidMeasurement.id), "Redo did not restore the Solid radius measurement");
    evidence.undoRedo = { undoRemovedSolidMeasurement: true, redoRestoredStableMeasurementId: solidMeasurement.id };

    while (state.undoDepth > initialState.undoDepth) state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable native radius-measurement acceptance", revision: state.revision });
    requireEmpty(state, "cleaned document");
    requireCondition((state.measurements ?? []).length === 0, "Cleanup left persistent measurements");
    const changes = await call(live.client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(changes.diff), "Scene content differs from the initial empty snapshot after cleanup");
    evidence.cleanup = { restoredEmptyDocument: true, measurementsRemoved: true, sceneContentsRestored: true };
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

function onlyNewBody(before: any, after: any, type: string, label: string): any { const ids = new Set(before.bodies.map((body: { id: number }) => body.id)); const bodies = after.bodies.filter((body: any) => body.type === type && !ids.has(body.id)); requireCondition(bodies.length === 1, `Expected exactly one new ${label} ${type}`); return bodies[0]; }
function onlyMeasurement(state: any, name: string): any { const measurements = (state.measurements ?? []).filter((measurement: any) => measurement.name === name); requireCondition(measurements.length === 1, `Expected exactly one measurement named ${name}`); return measurements[0]; }
function verifyRadius(measurement: any, bodyId: number, radiusMm: number, diameterMm: number, label: string): void { requireCondition(measurement.type === "RadialMeasurement", `${label} has type ${measurement.type}`); requireCondition(measurement.first?.bodyId === bodyId, `${label} lost its body target`); near(measurement.radiusMm, radiusMm, 0.000001, `${label} radius`); near(measurement.diameterMm, diameterMm, 0.000002, `${label} diameter`); }
function requireEmpty(state: any, label: string): void { requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0, `${label} is not empty`); requireCondition((state.groups ?? []).filter((group: { id: number }) => group.id !== 0).length === 0, `${label} contains non-root groups`); }
async function startMcp(storeRoot: string): Promise<LiveMcp> { const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" }, stderr: "pipe" }); const stderr: string[] = []; transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); }); const client = new Client({ name: "plasticity-native-radius-measurement-live", version: "1.0.0" }); await client.connect(transport); return { client, stderr }; }
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> { const response = await client.callTool({ name, arguments: args }); const text = toolText(response); if ("isError" in response && response.isError) throw new Error(text); return JSON.parse(text); }
function toolText(response: unknown): string { if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content"); const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string"); if (!item) throw new Error("MCP tool returned no text content"); return item.text; }
async function recover(client: Client, initial: any): Promise<Record<string, unknown>> { for (let count = 0; count < 24; count += 1) { const status = await call(client, "plasticity_status", {}); if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" }; if (status.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: status.bodies.length === 0 && status.regions.length === 0 && (status.measurements ?? []).length === 0 }; await call(client, "plasticity_undo", { intent: "Recover disposable native radius-measurement acceptance", revision: status.revision }); } return { restoredEmptyDocument: false, reason: "undo-limit" }; }
function stateSummary(state: any): Record<string, any> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, regionCount: state.regions.length, measurementCount: (state.measurements ?? []).length }; }
function near(actual: number, expected: number, tolerance: number, label: string): void { requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
