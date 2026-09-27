#!/usr/bin/env node
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Options { help: boolean; target?: string; allowDisposableMutations: boolean; output?: string }
interface LiveMcp { client: Client }

export function parseCurvedEdgeDistanceArgs(argv: string[]): Options {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: Options = { help: false, allowDisposableMutations: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--allow-disposable-mutations") options.allowDisposableMutations = true;
    else if (argument === "--target") options.target = requiredValue(argv, ++index, argument);
    else if (argument === "--output") options.output = requiredValue(argv, ++index, argument);
    else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Curved-edge distance acceptance requires an explicit --target Plasticity window ID");
  if (!options.allowDisposableMutations) throw new Error("Curved-edge distance acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Curved-edge distance acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-curved-edge-distance-live.ts --help
  node scripts/verify-native-curved-edge-distance-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

Default/help mode is inert. Live mode requires a selected empty Plasticity document,
creates and extrudes a disposable closed NURBS profile, measures to a non-analytic
native B-Rep edge through production stdio MCP, confirms the result stays explicitly
approximate, then undoes all test geometry and verifies the scene is restored.`;

async function main(): Promise<void> {
  const options = parseCurvedEdgeDistanceArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  await mkdirFresh(output);
  const evidence: Record<string, unknown> = { schemaVersion: 1, startedAt: new Date().toISOString(), targetId: options.target, workbenchUsed: false };
  let live: LiveMcp | undefined;
  let initialState: any;
  let currentState: any;
  try {
    live = await startMcp(join(output, "store"));
    const windows = await call(live.client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity window was not found");
    initialState = await call(live.client, "plasticity_connect", { targetId: options.target });
    currentState = initialState;
    requireEmpty(initialState, "initial document");
    evidence.initial = summary(initialState);
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-curved-edge-distance-initial-empty" });

    currentState = await call(live.client, "plasticity_create_nurbs_curve", {
      pointsMm: [[0, 0, 0], [12, 0, 0], [14, 5, 0], [9, 11, 0], [1, 9, 0], [-2, 4, 0]],
      closed: true,
      intent: "Disposable arbitrary-curve distance acceptance",
      revision: currentState.revision,
    });
    const regions = await call(live.client, "plasticity_list_regions", {});
    requireCondition(regions.regions.length === 1, `Expected one NURBS profile region; got ${regions.regions.length}`);
    const beforeSolidIds = new Set(currentState.bodies.map((body: { id: number }) => body.id));
    currentState = await call(live.client, "plasticity_extrude_regions", {
      regionIds: [regions.regions[0].id], distanceMm: 5,
      intent: "Disposable arbitrary-curve distance acceptance",
      revision: currentState.revision,
    });
    const solid = currentState.bodies.find((body: any) => body.type === "Solid" && !beforeSolidIds.has(body.id));
    requireCondition(solid, "Extruding the NURBS region did not create a new Solid");
    const edge = solid.edges.find((candidate: any) => !candidate.line && !candidate.circle);
    requireCondition(edge, "Test Solid did not expose a non-linear, non-circular native B-Rep edge");
    evidence.testEdge = { bodyId: solid.id, edgeId: edge.id, curveType: edge.curveType, lengthMm: edge.lengthMm };

    const beforeMeasurement = summary(currentState);
    const measurement = await call(live.client, "plasticity_measure_point_to_curved_edge", {
      point: { type: "coordinates", pointMm: edge.centerMm },
      edge: { bodyId: solid.id, edgeId: edge.id },
      requestedToleranceMm: 0.01,
      maxSegments: 2048,
      revision: currentState.revision,
    });
    requireCondition(measurement.exact === false, "Curved-edge tool omitted its explicit approximate-result flag");
    requireCondition(measurement.measurementSource === "native-brep-sampled-polyline", "Curved-edge tool did not report its sampled native source");
    requireCondition(measurement.toleranceObserved === true, "The sampled midpoint deviation did not meet the requested criterion");
    requireCondition(measurement.sampleCount >= 65 && measurement.sampleCount <= 2049, "Unexpected adaptive sample count");
    requireCondition(measurement.estimatedDistanceMm <= 0.01, "A point taken from the native edge midpoint did not measure near zero");
    const afterMeasurement = await call(live.client, "plasticity_status", {});
    requireSameState(afterMeasurement, beforeMeasurement, "read-only measurement");
    evidence.measurement = measurement;

    const beforeWireIds = new Set(currentState.bodies.filter((body: { type: string }) => body.type === "Wire").map((body: { id: number }) => body.id));
    currentState = await call(live.client, "plasticity_create_nurbs_curve", {
      pointsMm: [[30, 0, 0], [35, 8, 2], [42, -3, 7], [50, 0, 0]],
      closed: false,
      intent: "Disposable Wire spline distance acceptance",
      revision: currentState.revision,
    });
    const wire = currentState.bodies.find((body: any) => body.type === "Wire" && !beforeWireIds.has(body.id));
    requireCondition(wire, "Creating an open NURBS curve did not create a Wire");
    const directions = await call(live.client, "plasticity_list_curve_directions", {});
    const wireCurve = directions.curves.find((curve: any) => curve.id === wire.id);
    requireCondition(wireCurve?.segments?.length === 1, "Open NURBS Wire did not expose one current segment");
    const segmentEntityId = wireCurve.segments[0].entityId;
    const evaluated = await call(live.client, "plasticity_evaluate_curve_segments", {
      samples: [{ bodyId: wire.id, segmentEntityId, normalizedParameter: 0.5 }], revision: currentState.revision,
    });
    const wirePoint = evaluated.samples[0]?.positionMm;
    requireCondition(Array.isArray(wirePoint) && wirePoint.length === 3, "Native Wire midpoint could not be evaluated");
    const beforeWireMeasurement = summary(currentState);
    const wireMeasurement = await call(live.client, "plasticity_measure_point_to_curved_edge", {
      point: { type: "coordinates", pointMm: wirePoint },
      edge: { bodyId: wire.id, segmentEntityId },
      requestedToleranceMm: 0.01,
      maxSegments: 2048,
      revision: currentState.revision,
    });
    requireCondition(wireMeasurement.exact === false, "Wire measurement omitted its explicit approximate-result flag");
    requireCondition(wireMeasurement.measurementSource === "native-brep-sampled-polyline", "Wire measurement did not report its native sampled source");
    requireCondition(wireMeasurement.toleranceObserved === true, "Wire sampled midpoint deviation did not meet the requested criterion");
    requireCondition(wireMeasurement.sampleCount >= 65 && wireMeasurement.sampleCount <= 2049, "Unexpected adaptive Wire sample count");
    requireCondition(wireMeasurement.estimatedDistanceMm <= 0.01, "A native Wire midpoint did not measure near zero");
    const afterWireMeasurement = await call(live.client, "plasticity_status", {});
    requireSameState(afterWireMeasurement, beforeWireMeasurement, "read-only Wire measurement");
    evidence.wireMeasurement = { segmentEntityId, curveType: wireCurve.segments[0].curveType, measurement: wireMeasurement };
    evidence.readOnly = { unchangedRevisionAndUndoRedo: true, forBothBRepAndWire: true };

    while (currentState.undoDepth > initialState.undoDepth) {
      currentState = await call(live.client, "plasticity_undo", { intent: "Clean up disposable curved-edge distance acceptance", revision: currentState.revision });
    }
    requireEmpty(currentState, "cleaned document");
    const changes = await call(live.client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(changes.diff), "Scene content did not return to the initial empty snapshot");
    evidence.cleanup = { restoredEmptyDocument: true, sceneContentsRestored: true };
    evidence.completedAt = new Date().toISOString();
    await writeExclusive(join(output, "evidence.json"), sanitizeEvidence(evidence));
    console.log(JSON.stringify({ ok: true, output, evidence: join(output, "evidence.json") }, null, 2));
  } catch (error) {
    evidence.failure = boundedError(error);
    if (live && initialState && currentState) evidence.cleanup = await recover(live.client, initialState).catch((cleanupError) => ({ restoredEmptyDocument: false, reason: boundedError(cleanupError) }));
    await writeExclusive(join(output, "failure.json"), sanitizeEvidence(evidence)).catch(() => {});
    throw error;
  } finally {
    await live?.client.close().catch(() => {});
  }
}

function requiredValue(argv: string[], index: number, flag: string): string { const value = argv[index]; if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`); return value; }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function requireEmpty(state: any, label: string): void { requireCondition(state.bodies.length === 0 && state.regions.length === 0, `${label} is not empty`); }
function summary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, regionCount: state.regions.length }; }
function requireSameState(actual: any, expected: any, label: string): void { requireCondition(actual.documentToken === expected.documentToken && actual.revision === expected.revision, `${label} changed the document or revision`); requireCondition(actual.undoDepth === expected.undoDepth && actual.redoDepth === expected.redoDepth, `${label} changed Undo/Redo state`); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 1200); }
async function mkdirFresh(path: string): Promise<void> { try { await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await mkdir(path, { mode: 0o700 }); return; } throw new Error("Output directory already exists; choose a new path"); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 }); }
async function startMcp(storeRoot: string): Promise<LiveMcp> { const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" }, stderr: "pipe" }); const client = new Client({ name: "plasticity-curved-edge-distance-acceptance", version: "1.0.0" }); await client.connect(transport); return { client }; }
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> { const response = await client.callTool({ name, arguments: args }); const text = toolText(response); if ("isError" in response && response.isError) throw new Error(text); return JSON.parse(text); }
function toolText(response: unknown): string { if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content"); const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string"); if (!item) throw new Error("MCP tool returned no text content"); return item.text; }
async function recover(client: Client, initial: any): Promise<Record<string, unknown>> { for (let count = 0; count < 24; count += 1) { const status = await call(client, "plasticity_status", {}); if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" }; if (status.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: status.bodies.length === 0 && status.regions.length === 0 }; await call(client, "plasticity_undo", { intent: "Recover disposable curved-edge distance acceptance", revision: status.revision }); } return { restoredEmptyDocument: false, reason: "undo-limit" }; }
function selectedEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv { return Object.fromEntries(Object.entries(environment).filter(([key]) => !["NODE_OPTIONS", "NODE_PATH", "TS_NODE_PROJECT"].includes(key))); }

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) await main();
