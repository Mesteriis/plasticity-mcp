#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LINEAR_TOLERANCE_MM = 0.01;

export interface NativeCurveControlPointAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parseNativeCurveControlPointAcceptanceArgs(argv: string[]): NativeCurveControlPointAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: NativeCurveControlPointAcceptanceOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live native-curve-control-point acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native-curve-control-point acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native-curve-control-point acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-curve-control-points-live.ts --help
  node scripts/verify-native-curve-control-points-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode refuses a nonempty Plasticity document, creates one disposable native
B-Spline, selects mixed handles, slides one along its local control direction,
moves two, rotates and scales individual control points, then deletes one. It checks native selection, handle
readback, and exact B-Rep evidence, exercises Undo/Redo, cleans up, and writes
bounded evidence.`;

async function main(): Promise<void> {
  const options = parseNativeCurveControlPointAcceptanceArgs(process.argv.slice(2));
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
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-curve-control-points-live-initial-empty" });

    const sourcePoints: Array<[number, number, number]> = [[0, 0, 0], [10, 15, 0], [20, -10, 0], [30, 20, 0], [40, -5, 0], [50, 10, 0], [60, 0, 0]];
    let state = await call(live.client, "plasticity_create_nurbs_curve", {
      pointsMm: sourcePoints,
      closed: false,
      intent: "Approved disposable native curve control-point source",
      revision: initialState.revision,
    });
    const wires = state.bodies.filter((body: { type: string }) => body.type === "Wire");
    requireCondition(wires.length === 1, "Control-point source did not create exactly one Wire");
    const id = wires[0].id;
    const before = onlyCurve(await call(live.client, "plasticity_list_curve_control_points", { ids: [id], revision: state.revision }), id);
    requireCondition(before.positionSource === "native-control-handle", "Unexpected curve control-point source");
    requireCondition(before.boundaryVertices.length === 2, `Expected two boundary vertices, got ${before.boundaryVertices.length}`);
    requireCondition(before.interiorControlPoints.length === 5, `Expected five interior control points, got ${before.interiorControlPoints.length}`);
    const beforeStructure = onlyStructure(await call(live.client, "plasticity_inspect_curve_structure", { ids: [id], revision: state.revision }), id);
    requireStructure(beforeStructure, { controlPointCount: 7, spanCount: 4, distinctKnotCount: 5 });
    const beforeDirection = onlyDirection(await call(live.client, "plasticity_list_curve_directions", {}), id);

    const boundary = before.boundaryVertices[0];
    const interior = before.interiorControlPoints[2];
    const selectedReferences = [boundary.reference, interior.reference];
    const selected = await call(live.client, "plasticity_select_curve_control_points", { points: selectedReferences, revision: state.revision });
    requireSameReferences(selected.curveControlPoints, selectedReferences, "selection result");
    const currentSelection = await call(live.client, "plasticity_current_selection", {});
    requireSameReferences(currentSelection.curveControlPoints, selectedReferences, "selection readback");
    const afterSelectionState = await call(live.client, "plasticity_status", {});
    requireCondition(afterSelectionState.undoDepth === state.undoDepth && afterSelectionState.revision === state.revision, "Curve handle selection changed document history");
    evidence.selection = { selectedReferences, readBackFromPlasticity: true, historyUnchanged: true };

    const slidePoint = before.interiorControlPoints[1];
    const slideDistanceMm = 5;
    state = await call(live.client, "plasticity_slide_curve_control_points", {
      points: [slidePoint.reference], direction: "positive-u", distanceMm: slideDistanceMm,
      intent: "Approved disposable native curve control-point slide", revision: state.revision,
    });
    const afterSlide = onlyCurve(await call(live.client, "plasticity_list_curve_control_points", { ids: [id], revision: state.revision }), id);
    vectorNear(pointByReference(afterSlide, slidePoint.reference).positionMm, add(slidePoint.positionMm, scale(slidePoint.slideDirections.positiveU, slideDistanceMm)), LINEAR_TOLERANCE_MM, "slid control point");
    requireUnselectedUnchanged(before, afterSlide, [slidePoint.reference]);

    const deltaMm: [number, number, number] = [0, 10, 5];
    state = await call(live.client, "plasticity_move_curve_control_points", {
      points: selectedReferences,
      deltaMm,
      intent: "Approved disposable mixed native curve control-point move",
      revision: state.revision,
    });
    const afterMove = onlyCurve(await call(live.client, "plasticity_list_curve_control_points", { ids: [id], revision: state.revision }), id);
    requireMoved(afterSlide, afterMove, boundary.reference, deltaMm);
    requireMoved(afterSlide, afterMove, interior.reference, deltaMm);
    requireUnselectedUnchanged(afterSlide, afterMove, [boundary.reference, interior.reference]);

    const rotatedReference = afterMove.interiorControlPoints[0].reference;
    const rotatePivotMm: [number, number, number] = [0, 0, 0];
    state = await call(live.client, "plasticity_rotate_curve_control_points", {
      points: [rotatedReference], pivotMm: rotatePivotMm, axis: [0, 0, 2], degrees: 90,
      intent: "Approved disposable native curve control-point rotation", revision: state.revision,
    });
    const afterRotate = onlyCurve(await call(live.client, "plasticity_list_curve_control_points", { ids: [id], revision: state.revision }), id);
    vectorNear(pointByReference(afterRotate, rotatedReference).positionMm, rotateZ90(pointByReference(afterMove, rotatedReference).positionMm, rotatePivotMm), LINEAR_TOLERANCE_MM, "rotated control point");
    requireUnselectedUnchanged(afterMove, afterRotate, [rotatedReference]);

    const scaledReference = afterRotate.interiorControlPoints[afterRotate.interiorControlPoints.length - 1].reference;
    const scalePivotMm: [number, number, number] = [0, 0, 0];
    const scaleFactors: [number, number, number] = [2, 0.5, 1];
    state = await call(live.client, "plasticity_scale_curve_control_points", {
      points: [scaledReference], pivotMm: scalePivotMm, factors: scaleFactors,
      intent: "Approved disposable native curve control-point scaling", revision: state.revision,
    });
    const afterScale = onlyCurve(await call(live.client, "plasticity_list_curve_control_points", { ids: [id], revision: state.revision }), id);
    vectorNear(pointByReference(afterScale, scaledReference).positionMm, scaleAround(pointByReference(afterRotate, scaledReference).positionMm, scalePivotMm, scaleFactors), LINEAR_TOLERANCE_MM, "scaled control point");
    requireUnselectedUnchanged(afterRotate, afterScale, [scaledReference]);
    const beforeDeleteStructure = onlyStructure(await call(live.client, "plasticity_inspect_curve_structure", { ids: [id], revision: state.revision }), id);
    requireStructure(beforeDeleteStructure, { controlPointCount: 7, spanCount: 4, distinctKnotCount: 5 });
    const beforeDeleteDirection = onlyDirection(await call(live.client, "plasticity_list_curve_directions", {}), id);

    const deletedReference = afterScale.interiorControlPoints[2].reference;
    state = await call(live.client, "plasticity_delete_curve_control_points", {
      points: [deletedReference], intent: "Approved disposable native interior control-point deletion", revision: state.revision,
    });
    requireCondition(state.undoDepth === initialState.undoDepth + 6, "Curve creation plus five control-point edits did not create six history steps");
    const afterDelete = onlyCurve(await call(live.client, "plasticity_list_curve_control_points", { ids: [id], revision: state.revision }), id);
    requireCondition(afterDelete.boundaryVertices.length === 2 && afterDelete.interiorControlPoints.length === 4, "Control-point deletion did not remove exactly one interior handle");
    const afterDeleteStructure = onlyStructure(await call(live.client, "plasticity_inspect_curve_structure", { ids: [id], revision: state.revision }), id);
    requireStructure(afterDeleteStructure, { controlPointCount: 6, spanCount: 3, distinctKnotCount: 4 });
    const afterDeleteDirection = onlyDirection(await call(live.client, "plasticity_list_curve_directions", {}), id);
    vectorNear(afterDeleteDirection.startMm, add(boundary.positionMm, deltaMm), LINEAR_TOLERANCE_MM, "native B-Rep start");
    vectorNear(afterDeleteDirection.endMm, beforeDirection.endMm, LINEAR_TOLERANCE_MM, "native B-Rep end");
    vectorNear(afterDeleteDirection.startTangent, beforeDeleteDirection.startTangent, 1e-6, "start tangent after delete");
    vectorNear(afterDeleteDirection.endTangent, beforeDeleteDirection.endTangent, 1e-6, "end tangent after delete");
    evidence.controlPointMove = {
      bodyId: id,
      movedReferences: [boundary.reference, interior.reference],
      deltaMm,
      before: compactCurve(before),
      afterSlide: compactCurve(afterSlide),
      afterMove: compactCurve(afterMove),
      afterRotate: compactCurve(afterRotate),
      afterScale: compactCurve(afterScale),
      afterDelete: compactCurve(afterDelete),
      rotation: { reference: rotatedReference, pivotMm: rotatePivotMm, axis: [0, 0, 2], degrees: 90 },
      scale: { reference: scaledReference, pivotMm: scalePivotMm, factors: scaleFactors },
      slide: { reference: slidePoint.reference, direction: "positive-u", distanceMm: slideDistanceMm, unitDirection: slidePoint.slideDirections.positiveU },
      deletion: { reference: deletedReference, remainingInteriorControlPoints: 4, referencesReindexed: true },
      exactBrep: { startMm: afterDeleteDirection.startMm, endMm: afterDeleteDirection.endMm, lengthMm: afterDeleteDirection.lengthMm, structure: afterDeleteStructure },
      controlHandleToleranceMm: LINEAR_TOLERANCE_MM,
    };

    for (let index = 0; index < 5; index += 1) state = await call(live.client, "plasticity_undo", { intent: "Verify native curve control-point Undo", revision: state.revision });
    const undone = onlyCurve(await call(live.client, "plasticity_list_curve_control_points", { ids: [id], revision: state.revision }), id);
    requireSamePositions(undone, before, "Undo");
    for (let index = 0; index < 5; index += 1) state = await call(live.client, "plasticity_redo", { intent: "Verify native curve control-point Redo", revision: state.revision });
    const redone = onlyCurve(await call(live.client, "plasticity_list_curve_control_points", { ids: [id], revision: state.revision }), id);
    requireSamePositions(redone, afterDelete, "Redo");
    evidence.undoRedo = { undoRestoredAllHandlePositions: true, redoRestoredAllFiveEdits: true };

    while (state.undoDepth > initialState.undoDepth) state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable native curve control-point acceptance", revision: state.revision });
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

function onlyCurve(report: any, id: number): any {
  const curve = report.curves?.find((candidate: { id: number }) => candidate.id === id);
  requireCondition(curve, `Missing control-point evidence for Wire ${id}`);
  return curve;
}
function onlyStructure(report: any, id: number): any { const curve = report.curves?.find((candidate: { id: number }) => candidate.id === id); requireCondition(curve?.segments?.length === 1, `Missing one-segment structure for Wire ${id}`); return curve.segments[0]; }
function onlyDirection(report: any, id: number): any { const curve = report.curves?.find((candidate: { id: number }) => candidate.id === id); requireCondition(curve?.segments?.length === 1, `Missing one-segment direction for Wire ${id}`); return curve.segments[0]; }
function requireStructure(segment: any, expected: { controlPointCount: number; spanCount: number; distinctKnotCount: number }): void { requireCondition(segment.curveType === "BCurve" && segment.degree === 3 && segment.controlPointCount === expected.controlPointCount && segment.spanCount === expected.spanCount && segment.distinctKnotCount === expected.distinctKnotCount && segment.rational === false && segment.periodic === false, "Unexpected native B-Spline structure"); }
function pointKey(reference: any): string { return `${reference.bodyId}:${reference.kind}:${reference.pointId}`; }
function allPoints(curve: any): any[] { return [...curve.boundaryVertices, ...curve.interiorControlPoints]; }
function pointByReference(curve: any, reference: any): any { const point = allPoints(curve).find((candidate) => pointKey(candidate.reference) === pointKey(reference)); requireCondition(point, `Missing control point ${pointKey(reference)}`); return point; }
function requireMoved(before: any, after: any, reference: any, deltaMm: number[]): void { const first = pointByReference(before, reference); const second = pointByReference(after, reference); vectorNear(second.positionMm, add(first.positionMm, deltaMm), LINEAR_TOLERANCE_MM, `moved ${pointKey(reference)}`); }
function requireUnselectedUnchanged(before: any, after: any, selected: any[]): void { const keys = new Set(selected.map(pointKey)); for (const point of allPoints(before)) if (!keys.has(pointKey(point.reference))) vectorNear(pointByReference(after, point.reference).positionMm, point.positionMm, LINEAR_TOLERANCE_MM, `unchanged ${pointKey(point.reference)}`); }
function requireSamePositions(actual: any, expected: any, label: string): void { for (const point of allPoints(expected)) vectorNear(pointByReference(actual, point.reference).positionMm, point.positionMm, LINEAR_TOLERANCE_MM, `${label} ${pointKey(point.reference)}`); }
function requireSameReferences(actual: any[], expected: any[], label: string): void { requireCondition(Array.isArray(actual), `${label}: missing curve control-point references`); const actualKeys = actual.map(pointKey).sort(); const expectedKeys = expected.map(pointKey).sort(); requireCondition(JSON.stringify(actualKeys) === JSON.stringify(expectedKeys), `${label}: expected ${expectedKeys.join(", ")}, got ${actualKeys.join(", ")}`); }
function compactCurve(curve: any): Record<string, unknown> { return { versionId: curve.versionId, positionSource: curve.positionSource, boundaryVertices: curve.boundaryVertices, interiorControlPoints: curve.interiorControlPoints }; }
function add(left: number[], right: number[]): number[] { return left.map((value, index) => value + right[index]!); }
function scale(vector: number[], factor: number): number[] { return vector.map((value) => value * factor); }
function rotateZ90(point: number[], pivot: number[]): number[] { const x = point[0]! - pivot[0]!; const y = point[1]! - pivot[1]!; return [pivot[0]! - y, pivot[1]! + x, point[2]!]; }
function scaleAround(point: number[], pivot: number[], factors: number[]): number[] { return point.map((value, index) => pivot[index]! + (value - pivot[index]!) * factors[index]!); }
function requireEmpty(state: any, label: string): void { requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0, `${label} is not empty`); requireCondition((state.groups ?? []).filter((group: { id: number }) => group.id !== 0).length === 0, `${label} contains non-root groups`); }

async function startMcp(storeRoot: string): Promise<LiveMcp> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" }, stderr: "pipe" });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); });
  const client = new Client({ name: "plasticity-native-curve-control-points-live", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> { const response = await client.callTool({ name, arguments: args }); const output = toolText(response); if ("isError" in response && response.isError) throw new Error(output); return JSON.parse(output); }
function toolText(response: unknown): string { if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content"); const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string"); if (!item) throw new Error("MCP tool returned no text content"); return item.text; }
async function recover(client: Client, initial: any): Promise<Record<string, unknown>> { for (let count = 0; count < 24; count += 1) { const status = await call(client, "plasticity_status", {}); if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" }; if (status.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: status.bodies.length === 0 && status.regions.length === 0 }; await call(client, "plasticity_undo", { intent: "Recover disposable native curve control-point acceptance", revision: status.revision }); } return { restoredEmptyDocument: false, reason: "undo-limit" }; }
function stateSummary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, regionCount: state.regions.length }; }
function near(actual: number, expected: number, tolerance: number, label: string): void { requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`); }
function vectorNear(actual: number[], expected: number[], tolerance: number, label: string): void { requireCondition(actual.length === expected.length, `${label}: vector length mismatch`); actual.forEach((value, index) => near(value, expected[index]!, tolerance, `${label}[${index}]`)); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
