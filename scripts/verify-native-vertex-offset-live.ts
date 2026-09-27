#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LINEAR_TOLERANCE_MM = 0.01;

export interface NativeVertexOffsetAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parseNativeVertexOffsetAcceptanceArgs(argv: string[]): NativeVertexOffsetAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: NativeVertexOffsetAcceptanceOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live native-vertex-offset acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native-vertex-offset acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native-vertex-offset acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-vertex-offset-live.ts --help
  node scripts/verify-native-vertex-offset-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode refuses a nonempty Plasticity document, never chooses a window
automatically, offsets two opposite native shell vertices, verifies exact B-Rep
topology, volume and Undo/Redo, cleans up with native Undo, and writes sanitized
evidence to a new directory.`;

async function main(): Promise<void> {
  const options = parseNativeVertexOffsetAcceptanceArgs(process.argv.slice(2));
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
    requireEmpty(initialState, "initial document");
    evidence.initial = stateSummary(initialState);
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-vertex-offset-live-initial-empty" });

    let state = await call(live.client, "plasticity_create_box", {
      originMm: [0, 0, 0], sizeMm: [20, 10, 10], name: "Vertex offset acceptance",
      intent: "Create disposable source for native vertex-offset acceptance", revision: initialState.revision,
    });
    const source = requireSingleBody(state);
    requireTopology(source, 6, 12, 8, "source body");
    const sourceProperties = await exactProperties(live.client, source.id, state.revision);
    const selected = [
      requireVertex(source, [20, 10, 10]),
      requireVertex(source, [0, 0, 0]),
    ];
    const beforeOffsetDepth = state.undoDepth;
    state = await call(live.client, "plasticity_offset_vertices", {
      vertices: selected.map((vertex: any) => ({ bodyId: source.id, vertexId: vertex.id })),
      distanceMm: 2,
      intent: "Insert exact native split vertices two millimeters from two opposite corners",
      revision: state.revision,
    });
    requireCondition(state.undoDepth === beforeOffsetDepth + 1, "Two vertex offsets did not use one native history step");
    const offset = requireSingleBody(state);
    requireCondition(offset.id === source.id, "Native vertex offset changed the stable body ID");
    requireCondition(offset.name === source.name, "Native vertex offset changed the body name");
    requireTopology(offset, 6, 18, 14, "offset body");
    const expectedInserted = [
      [18, 10, 10], [20, 8, 10], [20, 10, 8],
      [2, 0, 0], [0, 2, 0], [0, 0, 2],
    ] as Array<[number, number, number]>;
    const inserted = expectedInserted.map((position) => requireVertex(offset, position));
    requireVertex(offset, [20, 10, 10]);
    requireVertex(offset, [0, 0, 0]);
    const offsetProperties = await exactProperties(live.client, offset.id, state.revision);
    near(offsetProperties.volumeMm3, sourceProperties.volumeMm3, 1e-6, "volume after vertex offset");
    vectorNear(offsetProperties.volumeCentroidMm, sourceProperties.volumeCentroidMm, 1e-8, "centroid after vertex offset");
    const validation = await call(live.client, "plasticity_validate_bodies", { ids: [offset.id], revision: state.revision });
    requireCondition(validation.measurementSource === "native-brep", "Unexpected body validation source");
    requireCondition(validation.bodies.length === 1 && validation.bodies[0].nativeValid === true && validation.bodies[0].printableSolid === true && validation.bodies[0].nativeCheckCodes.length === 0, "Vertex-offset Solid failed native validation");

    state = await call(live.client, "plasticity_undo", { intent: "Verify native vertex-offset Undo", revision: state.revision });
    requireTopology(requireSingleBody(state), 6, 12, 8, "vertex-offset Undo body");
    state = await call(live.client, "plasticity_redo", { intent: "Verify native vertex-offset Redo", revision: state.revision });
    const redone = requireSingleBody(state);
    requireTopology(redone, 6, 18, 14, "vertex-offset Redo body");
    expectedInserted.forEach((position) => requireVertex(redone, position));

    evidence.vertexOffset = {
      bodyId: source.id,
      selectedVertices: selected.map((vertex: any) => ({ id: vertex.id, positionMm: vertex.positionMm })),
      distanceMm: 2,
      insertedVertices: inserted.map((vertex: any) => ({ id: vertex.id, positionMm: vertex.positionMm })),
      topologyBefore: { faceCount: 6, edgeCount: 12, vertexCount: 8 },
      topologyAfter: { faceCount: 6, edgeCount: 18, vertexCount: 14 },
      exactPropertiesBefore: sourceProperties,
      exactPropertiesAfter: offsetProperties,
      stableBodyIdPreserved: true,
      bodyNamePreserved: true,
      oneHistoryStep: true,
      undoRedo: true,
    };
    evidence.validation = validation;

    while (state.undoDepth > initialState.undoDepth) {
      state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable native vertex-offset acceptance", revision: state.revision });
    }
    requireEmpty(state, "cleaned document");
    const journal = await call(live.client, "plasticity_construction_journal", {});
    requireCondition(journal.syncStatus === "in-sync" && !journal.entries.some((entry: { status: string }) => entry.status === "unknown"), "Construction journal is not clean after vertex-offset acceptance");
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
  near(report.bodies[0].volumeMm3, 2000, 1e-6, "solid volume");
  vectorNear(report.bodies[0].volumeCentroidMm, [10, 5, 5], 1e-8, "solid centroid");
  requireCondition(report.bodies[0].nativeCheckCodes.length === 0, "Solid-property measurement found native validation errors");
  return report.bodies[0];
}

function requireSingleBody(state: any): any {
  requireCondition(state.bodies.length === 1 && state.bodies[0].type === "Solid", `Expected one native Solid, found ${state.bodies.length} bodies`);
  return state.bodies[0];
}
function requireVertex(body: any, positionMm: [number, number, number]): any {
  const matches = (body.vertices ?? []).filter((vertex: any) => vectorNearBoolean(vertex.positionMm, positionMm));
  requireCondition(matches.length === 1, `Expected one vertex at [${positionMm.join(", ")}], found ${matches.length}`);
  return matches[0];
}
function requireTopology(body: any, faceCount: number, edgeCount: number, vertexCount: number, label: string): void {
  requireCondition(body.faces.length === faceCount && body.edges.length === edgeCount && (body.vertices ?? []).length === vertexCount, `${label}: expected ${faceCount} faces, ${edgeCount} edges and ${vertexCount} vertices; got ${body.faces.length}, ${body.edges.length} and ${(body.vertices ?? []).length}`);
}
function requireEmpty(state: any, label: string): void { requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0, `${label} is not empty`); requireCondition((state.groups ?? []).filter((group: { id: number }) => group.id !== 0).length === 0, `${label} contains non-root groups`); }
function stateSummary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, regionCount: state.regions.length }; }
function vectorNearBoolean(actual: unknown, expected: [number, number, number], tolerance = LINEAR_TOLERANCE_MM): boolean { return Array.isArray(actual) && actual.length === 3 && actual.every((value, index) => typeof value === "number" && Math.abs(value - expected[index]!) <= tolerance); }
function vectorNear(actual: unknown, expected: [number, number, number], tolerance: number, label: string): void { requireCondition(vectorNearBoolean(actual, expected, tolerance), `${label}: expected [${expected.join(", ")}], got ${JSON.stringify(actual)}`); }
function near(actual: unknown, expected: number, tolerance: number, label: string): void { requireCondition(typeof actual === "number" && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${String(actual)}`); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

async function startMcp(storeRoot: string): Promise<LiveMcp> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" }, stderr: "pipe" });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); });
  const client = new Client({ name: "plasticity-native-vertex-offset-live", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> { const response = await client.callTool({ name, arguments: args }); const output = toolText(response); if ("isError" in response && response.isError) throw new Error(output); return JSON.parse(output); }
function toolText(response: unknown): string { if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content"); const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string"); if (!item) throw new Error("MCP tool returned no text content"); return item.text; }
async function recover(client: Client, initial: any): Promise<Record<string, unknown>> { for (let count = 0; count < 16; count += 1) { const status = await call(client, "plasticity_status", {}); if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" }; if (status.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: status.bodies.length === 0 && status.regions.length === 0 }; await call(client, "plasticity_undo", { intent: "Recover disposable native vertex-offset acceptance", revision: status.revision }); } return { restoredEmptyDocument: false, reason: "undo-limit" }; }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
