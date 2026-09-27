#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOLERANCE_MM = 0.01;

export interface NativeSurfaceCurveAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parseNativeSurfaceCurveAcceptanceArgs(argv: string[]): NativeSurfaceCurveAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: NativeSurfaceCurveAcceptanceOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live native-surface-curve acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native-surface-curve acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native-surface-curve acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-surface-curves-live.ts --help
  node scripts/verify-native-surface-curves-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode refuses a nonempty Plasticity document, verifies exact body-intersection
curves, two-view 3D curve projection, and native U/V isoparam edge insertion with
Undo/Redo, then restores the initial empty scene.`;

async function main(): Promise<void> {
  const options = parseNativeSurfaceCurveAcceptanceArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const evidence: Record<string, unknown> = { schemaVersion: 1, startedAt: new Date().toISOString(), targetId: options.target!, workbenchUsed: false };
  let live: LiveMcp | undefined;
  let initialState: any;
  try {
    live = await startMcp(join(output, "strength-store"));
    const tools = await live.client.listTools();
    for (const name of ["plasticity_create_body_intersection_curves", "plasticity_project_curve_pair", "plasticity_insert_isoparam_edges"]) {
      requireCondition(tools.tools.some((tool) => tool.name === name), `MCP did not expose ${name}`);
    }
    const windows = await call(live.client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    initialState = await call(live.client, "plasticity_connect", { targetId: options.target });
    requireEmpty(initialState, "initial document");
    evidence.initial = stateSummary(initialState);
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-surface-curves-live-initial-empty" });

    let state = await call(live.client, "plasticity_create_box", {
      originMm: [0, 0, 0], sizeMm: [20, 20, 5], name: "Intersection target",
      intent: "Create disposable target for exact body intersection curves", revision: initialState.revision,
    });
    state = await call(live.client, "plasticity_create_cylinder", {
      centerMm: [10, 10, -1], radiusMm: 3, heightMm: 7, axis: [0, 0, 1], name: "Intersection tool",
      intent: "Create disposable tool for exact body intersection curves", revision: state.revision,
    });
    const target = namedBody(state, "Intersection target");
    const tool = namedBody(state, "Intersection tool");
    const bodyIntersectionSources = new Set(state.bodies.map((body: any) => body.id));
    const bodyIntersectionUndoDepth = state.undoDepth;
    state = await call(live.client, "plasticity_create_body_intersection_curves", {
      targetId: target.id, toolIds: [tool.id],
      intent: "Create exact circular intersection curves without modifying either source", revision: state.revision,
    });
    requireCondition(state.undoDepth === bodyIntersectionUndoDepth + 1, "Body-intersection curves did not use one history step");
    const intersectionWires = state.bodies.filter((body: any) => body.type === "Wire" && !bodyIntersectionSources.has(body.id));
    requireCondition(intersectionWires.length === 2, `Expected two body-intersection Wires, found ${intersectionWires.length}`);
    requireCondition(state.bodies.some((body: any) => body.id === target.id) && state.bodies.some((body: any) => body.id === tool.id), "Body-intersection sources were not preserved");
    const intersectionCurves = await call(live.client, "plasticity_list_curve_directions", {});
    for (const z of [0, 5]) {
      const wire = intersectionWires.find((candidate: any) => candidate.boundsMm && nearValue(candidate.boundsMm.min[2], z) && nearValue(candidate.boundsMm.max[2], z));
      requireCondition(wire, `Missing circular intersection Wire at Z=${z} mm`);
      requireBounds(wire.boundsMm, [7, 7, z], [13, 13, z], `intersection Wire at Z=${z}`);
      const curve = intersectionCurves.curves.find((candidate: any) => candidate.id === wire.id);
      requireCondition(curve?.measurementSource === "native-brep" && curve.closed === true && curve.segments.length === 1, `Intersection Wire at Z=${z} is not one exact closed curve`);
      near(curve.segments[0].lengthMm, 6 * Math.PI, TOLERANCE_MM, `intersection circumference at Z=${z}`);
    }
    state = await call(live.client, "plasticity_undo", { intent: "Verify body-intersection curve Undo", revision: state.revision });
    requireCondition(state.bodies.filter((body: any) => body.type === "Wire").length === 0, "Body-intersection Undo did not remove both result Wires");
    state = await call(live.client, "plasticity_redo", { intent: "Verify body-intersection curve Redo", revision: state.revision });
    requireCondition(state.bodies.filter((body: any) => body.type === "Wire").length === 2, "Body-intersection Redo did not restore both result Wires");
    evidence.bodyIntersectionCurves = {
      sourceBodyIds: [target.id, tool.id], resultBodyIds: intersectionWires.map((body: any) => body.id),
      resultBoundsMm: intersectionWires.map((body: any) => body.boundsMm), circumferencesMm: [6 * Math.PI, 6 * Math.PI],
      measurementSource: "native-brep", sourcesPreserved: true, oneHistoryStep: true, undoRedo: true,
    };

    const beforeFirstSketchIds = new Set<number>(state.bodies.map((body: any) => Number(body.id)));
    state = await call(live.client, "plasticity_create_polyline", {
      pointsMm: [[30, -5, 0], [40, 5, 0], [50, -5, 0]], closed: false,
      intent: "Create disposable XY view curve", revision: state.revision,
    });
    const firstCurve = onlyNewBody(state, beforeFirstSketchIds, "first projected source Wire");
    const beforeSecondSketchIds = new Set<number>(state.bodies.map((body: any) => Number(body.id)));
    state = await call(live.client, "plasticity_create_polyline", {
      pointsMm: [[30, 0, 0], [40, 0, 5], [50, 0, 0]], closed: false,
      intent: "Create disposable XZ view curve", revision: state.revision,
    });
    const secondCurve = onlyNewBody(state, beforeSecondSketchIds, "second projected source Wire");
    const curvePairSources = new Set<number>(state.bodies.map((body: any) => Number(body.id)));
    const curvePairUndoDepth = state.undoDepth;
    state = await call(live.client, "plasticity_project_curve_pair", {
      firstId: firstCurve.id, firstDirection: [0, 0, 1], secondId: secondCurve.id, secondDirection: [0, 1, 0], projectionDepthMm: 1000,
      intent: "Create a spatial Wire from two orthogonal sketch views", revision: state.revision,
    });
    requireCondition(state.undoDepth === curvePairUndoDepth + 1, "Curve-pair projection did not use one history step");
    const spatialCurve = onlyNewBody(state, curvePairSources, "projected spatial Wire");
    requireCondition(spatialCurve.type === "Wire", "Curve-pair projection did not create a Wire");
    requireBounds(spatialCurve.boundsMm, [30, -5, 0], [50, 5, 5], "projected spatial Wire");
    const projectedDirections = await call(live.client, "plasticity_list_curve_directions", {});
    const projectedCurve = projectedDirections.curves.find((candidate: any) => candidate.id === spatialCurve.id);
    requireCondition(projectedCurve?.measurementSource === "native-brep" && projectedCurve.closed === false && projectedCurve.segments.length === 2, "Projected spatial Wire is not an exact two-segment open curve");
    const projectedPoints = projectedCurve.segments.flatMap((segment: any) => [segment.startMm, segment.endMm]);
    for (const point of [[30, -5, 0], [40, 5, 5], [50, -5, 0]]) {
      requireCondition(projectedPoints.some((candidate: number[]) => vectorNear(candidate, point)), `Projected spatial Wire is missing [${point.join(", ")}]`);
    }
    state = await call(live.client, "plasticity_undo", { intent: "Verify curve-pair projection Undo", revision: state.revision });
    requireCondition(!state.bodies.some((body: any) => body.id === spatialCurve.id), "Curve-pair projection Undo retained the result Wire");
    state = await call(live.client, "plasticity_redo", { intent: "Verify curve-pair projection Redo", revision: state.revision });
    requireCondition(state.bodies.some((body: any) => body.id === spatialCurve.id), "Curve-pair projection Redo did not restore the result Wire");
    evidence.curvePairProjection = {
      sourceBodyIds: [firstCurve.id, secondCurve.id], resultBodyId: spatialCurve.id, resultBoundsMm: spatialCurve.boundsMm,
      expectedPointsMm: [[30, -5, 0], [40, 5, 5], [50, -5, 0]], projectionDepthMm: 1000,
      measurementSource: projectedCurve.measurementSource, sourcesPreserved: true, oneHistoryStep: true, undoRedo: true,
    };

    state = await call(live.client, "plasticity_create_cylinder", {
      centerMm: [80, 0, 0], radiusMm: 5, heightMm: 20, axis: [0, 0, 1], name: "Isoparam source",
      intent: "Create disposable cylinder for exact isoparam insertion", revision: state.revision,
    });
    const isoparamSource = namedBody(state, "Isoparam source");
    const cylinderFace = isoparamSource.faces.find((face: any) => face.surfaceType === "Cylinder");
    requireCondition(cylinderFace, "Cylinder face is unavailable for isoparam insertion");
    requireTopology(isoparamSource, 3, 2, "isoparam source before insertion");
    const volumeBefore = await exactVolume(live.client, isoparamSource.id, state.revision);
    const isoparamUndoDepth = state.undoDepth;
    state = await call(live.client, "plasticity_insert_isoparam_edges", {
      face: { bodyId: isoparamSource.id, faceId: cylinderFace.id }, direction: "v", count: 3,
      intent: "Insert three exact horizontal isoparametric edges", revision: state.revision,
    });
    requireCondition(state.undoDepth === isoparamUndoDepth + 1, "Isoparam insertion did not use one history step");
    const dividedCylinder = bodyById(state, isoparamSource.id);
    requireTopology(dividedCylinder, 6, 5, "isoparam result");
    requireBounds(dividedCylinder.boundsMm, [75, -5, 0], [85, 5, 20], "isoparam result");
    const dividedCylinderFaces = dividedCylinder.faces.filter((face: any) => face.surfaceType === "Cylinder");
    requireCondition(dividedCylinderFaces.length === 4, `Expected four analytic cylindrical result faces, found ${dividedCylinderFaces.length}`);
    for (const face of dividedCylinderFaces) near(face.radiusMm, 5, TOLERANCE_MM, "isoparam result face radius");
    const inserted = dividedCylinder.edges.filter((edge: any) => edge.curveType === "SPCurve");
    requireCondition(inserted.length === 3, `Expected three inserted V-isoparam edges, found ${inserted.length}`);
    const insertedHeights = inserted.map((edge: any) => edge.centerMm[2]).toSorted((left: number, right: number) => left - right);
    [5, 10, 15].forEach((expected, index) => near(insertedHeights[index], expected, TOLERANCE_MM, `isoparam height ${index}`));
    for (const edge of inserted) near(edge.lengthMm, 10 * Math.PI, TOLERANCE_MM, "isoparam circumference");
    const volumeAfter = await exactVolume(live.client, isoparamSource.id, state.revision);
    const validation = await call(live.client, "plasticity_validate_bodies", { ids: [isoparamSource.id], revision: state.revision });
    requireCondition(validation.bodies[0]?.nativeValid === true && validation.bodies[0]?.printableSolid === true, "Isoparam-edited Solid failed native validation");
    state = await call(live.client, "plasticity_undo", { intent: "Verify isoparam insertion Undo", revision: state.revision });
    requireTopology(bodyById(state, isoparamSource.id), 3, 2, "isoparam Undo result");
    state = await call(live.client, "plasticity_redo", { intent: "Verify isoparam insertion Redo", revision: state.revision });
    requireTopology(bodyById(state, isoparamSource.id), 6, 5, "isoparam Redo result");
    evidence.isoparamInsertion = {
      bodyId: isoparamSource.id, selectedFaceId: cylinderFace.id, direction: "v", count: 3,
      topologyBefore: { faceCount: 3, edgeCount: 2 }, topologyAfter: { faceCount: 6, edgeCount: 5 },
      resultBoundsMm: dividedCylinder.boundsMm, analyticCylinderFaceCount: dividedCylinderFaces.length,
      analyticCylinderRadiiMm: dividedCylinderFaces.map((face: any) => face.radiusMm),
      insertedEdgeHeightsMm: insertedHeights, insertedEdgeLengthsMm: inserted.map((edge: any) => edge.lengthMm),
      exactVolumeBeforeMm3: volumeBefore, exactVolumeAfterMm3: volumeAfter,
      nativeMassPropertyDeltaMm3: volumeAfter - volumeBefore,
      stableBodyIdPreserved: true, nativeValid: true, oneHistoryStep: true, undoRedo: true,
    };

    while (state.undoDepth > initialState.undoDepth) {
      state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable native surface-curve acceptance", revision: state.revision });
    }
    requireEmpty(state, "cleanup document");
    const journal = await call(live.client, "plasticity_construction_journal", {});
    requireCondition(journal.syncStatus === "in-sync" && !journal.entries.some((entry: { status: string }) => entry.status === "unknown"), "Construction journal is not clean after native surface-curve acceptance");
    const changes = await call(live.client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(changes.diff), "Scene content differs from the initial empty snapshot after cleanup");
    evidence.cleanup = { restoredEmptyDocument: true, sceneContentsRestored: true, journalSyncStatus: journal.syncStatus };
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

function requireEmpty(state: any, label: string): void {
  const nonRootGroups = (state.groups ?? []).filter((group: any) => group.id !== 0);
  requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0 && nonRootGroups.length === 0, `${label} is not empty`);
}
function namedBody(state: any, name: string): any { const body = state.bodies.find((candidate: any) => candidate.name === name); requireCondition(body, `Missing named body: ${name}`); return body; }
function bodyById(state: any, id: number): any { const body = state.bodies.find((candidate: any) => candidate.id === id); requireCondition(body, `Missing body ID: ${id}`); return body; }
function onlyNewBody(state: any, previousIds: Set<number>, label: string): any { const added = state.bodies.filter((body: any) => !previousIds.has(body.id)); requireCondition(added.length === 1, `${label}: expected one new body, found ${added.length}`); return added[0]; }
function requireTopology(body: any, faceCount: number, edgeCount: number, label: string): void { requireCondition(body.faceIds.length === faceCount && body.edgeIds.length === edgeCount, `${label}: expected ${faceCount} faces and ${edgeCount} edges, got ${body.faceIds.length} and ${body.edgeIds.length}`); }
function requireBounds(bounds: any, min: number[], max: number[], label: string): void { requireCondition(bounds, `${label} bounds are unavailable`); min.forEach((expected, axis) => near(bounds.min[axis], expected, TOLERANCE_MM, `${label} minimum axis ${axis}`)); max.forEach((expected, axis) => near(bounds.max[axis], expected, TOLERANCE_MM, `${label} maximum axis ${axis}`)); }
async function exactVolume(client: Client, id: number, revision: string): Promise<number> { const report = await call(client, "plasticity_measure_solid_properties", { ids: [id], revision }); requireCondition(report.source === "native-brep-mass-properties" && report.bodies.length === 1 && report.bodies[0]?.id === id, `Exact native mass properties are unavailable for body ${id}`); requireCondition(report.bodies[0].nativeCheckCodes.length === 0, `Native mass properties found validation errors for body ${id}`); const value = report.bodies[0].volumeMm3; requireCondition(Number.isFinite(value) && value > 0, `Native volume is invalid for body ${id}`); return value; }
function vectorNear(actual: number[], expected: number[]): boolean { return actual.length === expected.length && actual.every((value, index) => Math.abs(value - expected[index]!) <= TOLERANCE_MM); }
function nearValue(value: number, expected: number): boolean { return Number.isFinite(value) && Math.abs(value - expected) <= TOLERANCE_MM; }
function near(actual: number, expected: number, tolerance: number, label: string): void { requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function stateSummary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, regionCount: state.regions.length }; }

async function startMcp(storeRoot: string): Promise<LiveMcp> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" }, stderr: "pipe" });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); });
  const client = new Client({ name: "plasticity-native-surface-curves-live", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr };
}
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> { const response = await client.callTool({ name, arguments: args }); const item = (response.content as Array<{ type: string; text?: string }>).find((entry) => entry.type === "text" && typeof entry.text === "string"); if (!item?.text) throw new Error("MCP tool returned no text content"); if (response.isError) throw new Error(item.text); return JSON.parse(item.text); }
async function recover(client: Client, initial: any): Promise<Record<string, unknown>> { for (let count = 0; count < 32; count += 1) { const status = await call(client, "plasticity_status", {}); if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" }; if (status.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: status.bodies.length === 0 && status.regions.length === 0 }; await call(client, "plasticity_undo", { intent: "Recover disposable native surface-curve acceptance", revision: status.revision }); } return { restoredEmptyDocument: false, reason: "undo-limit" }; }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
