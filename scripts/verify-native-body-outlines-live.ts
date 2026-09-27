#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOLERANCE_MM = 0.01;

export interface NativeBodyOutlinesAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parseNativeBodyOutlinesAcceptanceArgs(argv: string[]): NativeBodyOutlinesAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: NativeBodyOutlinesAcceptanceOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live native-body-outlines acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native-body-outlines acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native-body-outlines acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-body-outlines-live.ts --help
  node scripts/verify-native-body-outlines-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode refuses a nonempty Plasticity document, never chooses a window
automatically, verifies exact source and workplane outlines plus Undo/Redo,
cleans up with native Undo, and writes sanitized evidence to a new directory.`;

async function main(): Promise<void> {
  const options = parseNativeBodyOutlinesAcceptanceArgs(process.argv.slice(2));
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
  let initialActivePlaneId: string | null = null;
  try {
    live = await startMcp(join(output, "strength-store"));
    const windows = await call(live.client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    initialState = await call(live.client, "plasticity_connect", { targetId: options.target });
    requireCondition(initialState.bodies.length === 0 && initialState.regions.length === 0 && (initialState.instances ?? []).length === 0, "Refusing disposable mutations in a nonempty Plasticity document");
    requireCondition((initialState.groups ?? []).filter((group: { id: number }) => group.id !== 0).length === 0, "Refusing disposable mutations while non-root Plasticity groups exist");
    const initialConstruction = await call(live.client, "plasticity_list_construction_geometry", {});
    initialActivePlaneId = initialConstruction.activePlaneId;
    evidence.initial = { ...stateSummary(initialState), activePlaneId: initialActivePlaneId };
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-body-outlines-live-initial-empty" });

    let state = await call(live.client, "plasticity_create_box", {
      originMm: [0, 0, 10], sizeMm: [20, 10, 5], name: "Outline source box",
      intent: "Approved disposable native body-outline acceptance", revision: initialState.revision,
    });
    const sourceSolid = requireSingleSolid(state);
    requireBounds(sourceSolid.boundsMm, [0, 0, 10], [20, 10, 15], "source Solid");
    const sourceProperties = await call(live.client, "plasticity_measure_solid_properties", { ids: [sourceSolid.id], revision: state.revision });
    near(sourceProperties.bodies[0].volumeMm3, 1_000, TOLERANCE_MM, "source Solid volume");

    let construction = await call(live.client, "plasticity_list_construction_geometry", {});
    const topPlane = requirePlane(construction, "standard:top");
    const sourceOutlineUndoDepth = state.undoDepth;
    state = await call(live.client, "plasticity_create_body_outlines", {
      ids: [sourceSolid.id], plane: identity(topPlane), placement: "source",
      intent: "Create an exact source-plane silhouette", revision: state.revision,
    });
    requireCondition(state.undoDepth === sourceOutlineUndoDepth + 1, "Source outline did not use one native history step");
    requireCondition(state.bodies.filter((body: any) => body.type === "Solid").length === 1, "Source outline did not preserve its Solid");
    requireCondition(state.regions.length === 1, `Expected one source-outline Region, found ${state.regions.length}`);
    const sourceWire = requireWireAtZ(state, 10);
    const sourceCurve = requireRectangleCurve(await call(live.client, "plasticity_list_curve_directions", {}), sourceWire.id, 10);

    state = await call(live.client, "plasticity_undo", { intent: "Verify source body-outline Undo", revision: state.revision });
    requireCondition(state.bodies.length === 1 && state.bodies[0].type === "Solid" && state.regions.length === 0, "Source-outline Undo did not restore only the Solid");
    state = await call(live.client, "plasticity_redo", { intent: "Verify source body-outline Redo", revision: state.revision });
    const redoneSolid = requireSingleSolid(state);
    const redoneSourceWire = requireWireAtZ(state, 10);
    requireRectangleCurve(await call(live.client, "plasticity_list_curve_directions", {}), redoneSourceWire.id, 10);

    construction = await call(live.client, "plasticity_list_construction_geometry", {});
    const refreshedTopPlane = requirePlane(construction, "standard:top");
    const projectedOutlineUndoDepth = state.undoDepth;
    state = await call(live.client, "plasticity_create_body_outlines", {
      ids: [redoneSolid.id], plane: identity(refreshedTopPlane), placement: "workplane",
      intent: "Project an exact body silhouette onto the Top workplane", revision: state.revision,
    });
    requireCondition(state.undoDepth === projectedOutlineUndoDepth + 1, "Workplane outline did not use one native history step");
    requireCondition(state.regions.length === 2, `Expected two outline Regions, found ${state.regions.length}`);
    const workplaneWire = requireWireAtZ(state, 0);
    const workplaneCurve = requireRectangleCurve(await call(live.client, "plasticity_list_curve_directions", {}), workplaneWire.id, 0);
    const finalSolid = requireSingleSolid(state);
    requireBounds(finalSolid.boundsMm, [0, 0, 10], [20, 10, 15], "preserved Solid");
    const finalProperties = await call(live.client, "plasticity_measure_solid_properties", { ids: [finalSolid.id], revision: state.revision });
    near(finalProperties.bodies[0].volumeMm3, 1_000, TOLERANCE_MM, "preserved Solid volume");

    state = await call(live.client, "plasticity_undo", { intent: "Verify workplane body-outline Undo", revision: state.revision });
    requireCondition(state.bodies.filter((body: any) => body.type === "Wire").length === 1 && state.regions.length === 1, "Workplane-outline Undo did not preserve only the source outline");
    requireWireAtZ(state, 10);
    state = await call(live.client, "plasticity_redo", { intent: "Verify workplane body-outline Redo", revision: state.revision });
    requireWireAtZ(state, 0);
    requireWireAtZ(state, 10);

    evidence.outlines = {
      source: curveEvidence(sourceCurve, sourceWire),
      workplane: curveEvidence(workplaneCurve, workplaneWire),
      sourceSolidPreserved: true,
      sourceSolidVolumeMm3: finalProperties.bodies[0].volumeMm3,
      oneHistoryStepEach: true,
    };
    evidence.undoRedo = { sourceOutline: true, workplaneOutline: true };

    while (state.undoDepth > initialState.undoDepth) {
      state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable native body-outline acceptance", revision: state.revision });
    }
    requireCondition(state.bodies.length === 0 && state.regions.length === 0, "Cleanup did not restore the empty document");
    await restoreWorkplane(live.client, initialActivePlaneId);
    const journal = await call(live.client, "plasticity_construction_journal", {});
    requireCondition(journal.syncStatus === "in-sync" && !journal.entries.some((entry: { status: string }) => entry.status === "unknown"), "Construction journal is not clean after body-outline acceptance");
    const changes = await call(live.client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(changes.diff), "Scene content differs from the initial empty snapshot after cleanup");
    evidence.cleanup = { restoredEmptyDocument: true, activePlaneRestored: true, sceneContentsRestored: true, journalSyncStatus: journal.syncStatus };
    evidence.completedAt = new Date().toISOString();
    await writeExclusive(join(output, "evidence.json"), sanitizeEvidence(evidence));
    console.log(JSON.stringify({ ok: true, output, evidence: join(output, "evidence.json") }, null, 2));
  } catch (error) {
    evidence.failure = boundedError(error);
    if (live && initialState && !evidence.cleanup) evidence.cleanup = await recover(live.client, initialState, initialActivePlaneId).catch((cleanupError) => ({ restoredEmptyDocument: false, reason: boundedError(cleanupError) }));
    await writeExclusive(join(output, "failure.json"), sanitizeEvidence(evidence)).catch(() => {});
    throw error;
  } finally {
    await live?.client.close().catch(() => {});
  }
}

function requireSingleSolid(state: any): any {
  const solids = state.bodies.filter((body: { type: string }) => body.type === "Solid");
  requireCondition(solids.length === 1, `Expected one native Solid, found ${solids.length}`);
  return solids[0];
}

function requireWireAtZ(state: any, zMm: number): any {
  const wires = state.bodies.filter((body: any) => body.type === "Wire" && body.boundsMm && Math.abs(body.boundsMm.min[2] - zMm) <= TOLERANCE_MM && Math.abs(body.boundsMm.max[2] - zMm) <= TOLERANCE_MM);
  requireCondition(wires.length === 1, `Expected one planar Wire at Z=${zMm} mm, found ${wires.length}`);
  requireBounds(wires[0].boundsMm, [0, 0, zMm], [20, 10, zMm], `Wire at Z=${zMm}`);
  return wires[0];
}

function requireRectangleCurve(report: any, bodyId: number, zMm: number): any {
  const curve = report.curves.find((candidate: any) => candidate.id === bodyId);
  requireCondition(curve, `No native curve evidence for body ${bodyId}`);
  requireCondition(curve.measurementSource === "native-brep", "Outline evidence is not native B-Rep");
  requireCondition(curve.closed === true && curve.segments.length === 4, "Outline is not one closed four-segment Wire");
  const lengths = curve.segments.map((segment: any) => segment.lengthMm).toSorted((left: number, right: number) => left - right);
  [10, 10, 20, 20].forEach((expected, index) => near(lengths[index], expected, TOLERANCE_MM, `outline segment ${index}`));
  for (const segment of curve.segments) {
    near(segment.startMm[2], zMm, TOLERANCE_MM, "outline start Z");
    near(segment.endMm[2], zMm, TOLERANCE_MM, "outline end Z");
  }
  return curve;
}

function requirePlane(construction: any, id: string): any {
  const plane = construction.planes.find((candidate: any) => candidate.id === id);
  requireCondition(plane, `Required construction plane is unavailable: ${id}`);
  return plane;
}

function identity(reference: any): Record<string, unknown> {
  return { id: reference.id, sessionId: reference.sessionId, documentToken: reference.documentToken, revision: reference.revision };
}

function curveEvidence(curve: any, wire: any): Record<string, unknown> {
  return {
    bodyId: wire.id,
    boundsMm: wire.boundsMm,
    measurementSource: curve.measurementSource,
    closed: curve.closed,
    segmentLengthsMm: curve.segments.map((segment: any) => segment.lengthMm),
    segmentPointsMm: curve.segments.map((segment: any) => ({ startMm: segment.startMm, endMm: segment.endMm })),
  };
}

function requireBounds(bounds: any, min: number[], max: number[], label: string): void {
  requireCondition(bounds && Array.isArray(bounds.min) && Array.isArray(bounds.max), `${label} bounds are unavailable`);
  min.forEach((expected, axis) => near(bounds.min[axis], expected, TOLERANCE_MM, `${label} minimum axis ${axis}`));
  max.forEach((expected, axis) => near(bounds.max[axis], expected, TOLERANCE_MM, `${label} maximum axis ${axis}`));
}

async function restoreWorkplane(client: Client, initialActivePlaneId: string | null): Promise<void> {
  if (!initialActivePlaneId) return;
  const construction = await call(client, "plasticity_list_construction_geometry", {});
  if (construction.activePlaneId === initialActivePlaneId) return;
  const plane = requirePlane(construction, initialActivePlaneId);
  await call(client, "plasticity_set_workplane", { plane: identity(plane), intent: "Restore the workplane after native body-outline acceptance" });
}

async function startMcp(storeRoot: string): Promise<LiveMcp> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" }, stderr: "pipe" });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); });
  const client = new Client({ name: "plasticity-native-body-outlines-live", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await client.callTool({ name, arguments: args });
  const item = (response.content as Array<{ type: string; text?: string }>).find((entry) => entry.type === "text" && typeof entry.text === "string");
  if (!item?.text) throw new Error("MCP tool returned no text content");
  if (response.isError) throw new Error(item.text);
  return JSON.parse(item.text);
}

async function recover(client: Client, initial: any, initialActivePlaneId: string | null): Promise<Record<string, unknown>> {
  for (let count = 0; count < 16; count += 1) {
    const status = await call(client, "plasticity_status", {});
    if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" };
    if (status.undoDepth <= initial.undoDepth) {
      await restoreWorkplane(client, initialActivePlaneId);
      return { restoredEmptyDocument: status.bodies.length === 0 && status.regions.length === 0, activePlaneRestored: true };
    }
    await call(client, "plasticity_undo", { intent: "Recover disposable native body-outline acceptance", revision: status.revision });
  }
  return { restoredEmptyDocument: false, reason: "undo-limit" };
}

function stateSummary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, regionCount: state.regions.length }; }
function near(actual: number, expected: number, tolerance: number, label: string): void { requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
