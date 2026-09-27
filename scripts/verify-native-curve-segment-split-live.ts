#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LINEAR_TOLERANCE_MM = 0.01;

export interface NativeCurveSegmentSplitAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parseNativeCurveSegmentSplitAcceptanceArgs(argv: string[]): NativeCurveSegmentSplitAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: NativeCurveSegmentSplitAcceptanceOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live native curve-segment split acceptance requires --target with an explicit Plasticity window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native curve-segment split acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native curve-segment split acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-curve-segment-split-live.ts --help
  node scripts/verify-native-curve-segment-split-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode refuses a nonempty Plasticity document, evaluates and splits one
B-Spline and one Line through public MCP tools, rejects a periodic Circle,
checks exact B-Rep positions, tangents, lengths, Undo/Redo, cleanup, and writes
bounded evidence.`;

async function main(): Promise<void> {
  const options = parseNativeCurveSegmentSplitAcceptanceArgs(process.argv.slice(2));
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
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-curve-segment-split-live-initial-empty" });

    let state = initialState;
    const beforeIds = new Set<number>();
    state = await call(live.client, "plasticity_create_nurbs_curve", {
      pointsMm: [[0, 0, 0], [10, 15, 0], [20, -10, 0], [30, 20, 0], [40, -5, 0], [50, 10, 0], [60, 0, 0]],
      closed: false, intent: "Approved disposable B-Spline split source", revision: state.revision,
    });
    const nurbsId = requireAddedWire(state, beforeIds, "B-Spline source");
    state.bodies.forEach((body: { id: number }) => beforeIds.add(body.id));
    state = await call(live.client, "plasticity_create_polyline", {
      pointsMm: [[0, 100, 0], [60, 100, 0]], closed: false,
      intent: "Approved disposable Line split source", revision: state.revision,
    });
    const lineId = requireAddedWire(state, beforeIds, "Line source");
    state.bodies.forEach((body: { id: number }) => beforeIds.add(body.id));
    state = await call(live.client, "plasticity_create_circle", {
      centerMm: [100, 100, 0], radiusMm: 30,
      intent: "Approved disposable periodic rejection source", revision: state.revision,
    });
    const circleId = requireAddedWire(state, beforeIds, "Circle source");
    requireCondition(state.undoDepth === initialState.undoDepth + 3, "Three split sources did not create three history steps");

    const beforeDirections = await call(live.client, "plasticity_list_curve_directions", {});
    const nurbsBefore = onlySegment(beforeDirections, nurbsId);
    const lineBefore = onlySegment(beforeDirections, lineId);
    const circleBefore = onlySegment(beforeDirections, circleId);
    const evaluated = await call(live.client, "plasticity_evaluate_curve_segments", {
      samples: [
        { bodyId: nurbsId, segmentEntityId: nurbsBefore.entityId, normalizedParameter: 0.5 },
        { bodyId: lineId, segmentEntityId: lineBefore.entityId, normalizedParameter: 0.5 },
      ],
      revision: state.revision,
    });
    requireCondition(evaluated.samples?.length === 2, "Curve evaluator did not return two exact samples");

    state = await call(live.client, "plasticity_split_curve_segment", {
      segment: { bodyId: nurbsId, segmentEntityId: nurbsBefore.entityId }, normalizedParameter: 0.5,
      intent: "Approved disposable B-Spline segment split", revision: state.revision,
    });
    state = await call(live.client, "plasticity_split_curve_segment", {
      segment: { bodyId: lineId, segmentEntityId: lineBefore.entityId }, normalizedParameter: 0.5,
      intent: "Approved disposable Line segment split", revision: state.revision,
    });
    requireCondition(state.undoDepth === initialState.undoDepth + 5, "Two splits did not create one history step each");
    const beforePeriodicRejection = stateSummary(state);
    const periodicError = await callExpectError(live.client, "plasticity_split_curve_segment", {
      segment: { bodyId: circleId, segmentEntityId: circleBefore.entityId }, normalizedParameter: 0.5,
      intent: "Verify periodic segment rejection", revision: state.revision,
    });
    requireCondition(/periodic closed curve/i.test(periodicError), "Periodic Circle did not return the expected bounded rejection");
    state = await call(live.client, "plasticity_status", {});
    requireCondition(state.revision === beforePeriodicRejection.revision && state.undoDepth === beforePeriodicRejection.undoDepth, "Rejected periodic split changed document state");

    const afterDirections = await call(live.client, "plasticity_list_curve_directions", {});
    const nurbsAfter = requireSplit(afterDirections, nurbsId, evaluated.samples[0], nurbsBefore);
    const lineAfter = requireSplit(afterDirections, lineId, evaluated.samples[1], lineBefore);
    const circleAfter = onlySegment(afterDirections, circleId);
    requireCondition(circleAfter.entityId === circleBefore.entityId && circleAfter.lengthMm === circleBefore.lengthMm, "Rejected periodic Circle changed geometry");
    const structures = await call(live.client, "plasticity_inspect_curve_structure", { ids: [nurbsId, lineId, circleId], revision: state.revision });
    requireCondition(structures.curves.find((curve: { id: number }) => curve.id === nurbsId)?.segments.length === 2, "B-Spline structure does not contain two segments");
    requireCondition(structures.curves.find((curve: { id: number }) => curve.id === lineId)?.segments.length === 2, "Line structure does not contain two segments");
    evidence.split = {
      normalizedParameter: 0.5,
      nurbs: { sample: evaluated.samples[0], before: compactSegment(nurbsBefore), after: nurbsAfter.map(compactSegment) },
      line: { sample: evaluated.samples[1], before: compactSegment(lineBefore), after: lineAfter.map(compactSegment) },
      periodicCircleRejected: true,
      shapeToleranceMm: LINEAR_TOLERANCE_MM,
      measurementSource: "native-brep",
    };

    for (let index = 0; index < 2; index += 1) state = await call(live.client, "plasticity_undo", { intent: "Verify native segment split Undo", revision: state.revision });
    const undone = await call(live.client, "plasticity_list_curve_directions", {});
    requireCondition(curve(undone, nurbsId).segments.length === 1 && curve(undone, lineId).segments.length === 1, "Undo did not restore one segment per source");
    for (let index = 0; index < 2; index += 1) state = await call(live.client, "plasticity_redo", { intent: "Verify native segment split Redo", revision: state.revision });
    const redone = await call(live.client, "plasticity_list_curve_directions", {});
    requireCondition(curve(redone, nurbsId).segments.length === 2 && curve(redone, lineId).segments.length === 2, "Redo did not restore both splits");
    evidence.undoRedo = { undoRestoredSingleSegments: true, redoRestoredSplitSegments: true };

    while (state.undoDepth > initialState.undoDepth) state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable native segment split acceptance", revision: state.revision });
    requireEmpty(state, "cleaned document");
    const changes = await call(live.client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(changes.diff), "Scene content differs from the initial empty snapshot after cleanup");
    evidence.cleanup = { restoredEmptyDocument: true, sceneContentsRestored: true };
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

function requireAddedWire(state: any, beforeIds: Set<number>, label: string): number {
  const added = state.bodies.filter((body: { id: number; type: string }) => !beforeIds.has(body.id) && body.type === "Wire");
  requireCondition(added.length === 1, `${label} did not add exactly one Wire`);
  return added[0].id;
}
function curve(report: any, id: number): any { const found = report.curves.find((candidate: { id: number }) => candidate.id === id); requireCondition(found?.measurementSource === "native-brep", `Missing native Wire ${id}`); return found; }
function onlySegment(report: any, id: number): any { const found = curve(report, id); requireCondition(found.segments?.length === 1, `Expected one segment on Wire ${id}`); return found.segments[0]; }
function requireSplit(report: any, id: number, sample: any, before: any): any[] {
  const segments = curve(report, id).segments;
  requireCondition(segments?.length === 2, `Expected two segments on Wire ${id}`);
  vectorNear(segments[0].endMm, sample.positionMm, LINEAR_TOLERANCE_MM, `Wire ${id} first end`);
  vectorNear(segments[1].startMm, sample.positionMm, LINEAR_TOLERANCE_MM, `Wire ${id} second start`);
  vectorNear(segments[0].endTangent, sample.tangent, 1e-6, `Wire ${id} first tangent`);
  vectorNear(segments[1].startTangent, sample.tangent, 1e-6, `Wire ${id} second tangent`);
  near(segments[0].lengthMm + segments[1].lengthMm, before.lengthMm, LINEAR_TOLERANCE_MM, `Wire ${id} total length`);
  return segments;
}
function compactSegment(segment: any): Record<string, unknown> { return { entityId: segment.entityId, startMm: segment.startMm, endMm: segment.endMm, startTangent: segment.startTangent, endTangent: segment.endTangent, lengthMm: segment.lengthMm }; }
function requireEmpty(state: any, label: string): void { requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0, `${label} is not empty`); requireCondition((state.groups ?? []).filter((group: { id: number }) => group.id !== 0).length === 0, `${label} contains non-root groups`); }
async function startMcp(storeRoot: string): Promise<LiveMcp> { const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" }, stderr: "pipe" }); const stderr: string[] = []; transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); }); const client = new Client({ name: "plasticity-native-curve-segment-split-live", version: "1.0.0" }); await client.connect(transport); return { client, stderr }; }
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> { const response = await client.callTool({ name, arguments: args }); const text = toolText(response); if ("isError" in response && response.isError) throw new Error(text); return JSON.parse(text); }
async function callExpectError(client: Client, name: string, args: Record<string, unknown>): Promise<string> { const response = await client.callTool({ name, arguments: args }); const text = toolText(response); requireCondition("isError" in response && response.isError === true, `${name} unexpectedly succeeded`); return text; }
function toolText(response: unknown): string { if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content"); const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string"); if (!item) throw new Error("MCP tool returned no text content"); return item.text; }
async function recover(client: Client, initial: any): Promise<Record<string, unknown>> { for (let count = 0; count < 24; count += 1) { const status = await call(client, "plasticity_status", {}); if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" }; if (status.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: status.bodies.length === 0 && status.regions.length === 0 }; await call(client, "plasticity_undo", { intent: "Recover disposable native segment split acceptance", revision: status.revision }); } return { restoredEmptyDocument: false, reason: "undo-limit" }; }
function stateSummary(state: any): Record<string, any> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, regionCount: state.regions.length }; }
function near(actual: number, expected: number, tolerance: number, label: string): void { requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`); }
function vectorNear(actual: number[], expected: number[], tolerance: number, label: string): void { requireCondition(actual.length === expected.length, `${label}: vector length mismatch`); actual.forEach((value, index) => near(value, expected[index]!, tolerance, `${label}[${index}]`)); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
