#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface NativeEdgeCurvatureAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parseNativeEdgeCurvatureAcceptanceArgs(argv: string[]): NativeEdgeCurvatureAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: NativeEdgeCurvatureAcceptanceOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live native edge-curvature acceptance requires --target with an explicit Plasticity window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native edge-curvature acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native edge-curvature acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-edge-curvature-live.ts --help
  node scripts/verify-native-edge-curvature-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode refuses a nonempty Plasticity document, measures a point against an
R10 native Wire circle by its revision-bound segment ID, analyzes that circle,
a straight Wire, and an R5 Solid cylinder edge through public MCP tools,
proves the read-only operations leave document/history unchanged, checks
Undo/Redo and cleanup, and writes bounded evidence.`;

async function main(): Promise<void> {
  const options = parseNativeEdgeCurvatureAcceptanceArgs(process.argv.slice(2));
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
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-edge-curvature-live-initial-empty" });

    let state = await call(live.client, "plasticity_create_circle", {
      centerMm: [0, 0, 0], radiusMm: 10,
      intent: "Approved disposable native edge-curvature acceptance", revision: initialState.revision,
    });
    const circle = onlyNewWire(initialState, state, "circle");
    const beforeLineIds = new Set(state.bodies.map((body: { id: number }) => body.id));
    state = await call(live.client, "plasticity_create_polyline", {
      pointsMm: [[30, 0, 0], [50, 0, 0]], closed: false,
      intent: "Approved disposable straight curvature reference", revision: state.revision,
    });
    const line = state.bodies.find((body: any) => body.type === "Wire" && !beforeLineIds.has(body.id));
    requireCondition(line, "Polyline did not create one Wire");
    const directions = await call(live.client, "plasticity_list_curve_directions", {});
    const circleDirection = directions.curves.find((curve: any) => curve.id === circle.id);
    const lineDirection = directions.curves.find((curve: any) => curve.id === line.id);
    requireCondition(circleDirection?.segments?.length === 1, "Circle did not expose one native segment");
    requireCondition(lineDirection?.segments?.length === 1, "Line did not expose one native segment");
    const circleSegment = circleDirection.segments[0];
    requireCondition(circleSegment.circleGeometry, "Runtime did not expose exact circle geometry for the native Wire segment");
    const beforePointCircle = stateSummary(state);
    const pointCircle = await call(live.client, "plasticity_measure_point_to_circular_edge", {
      point: { type: "coordinates", pointMm: [10, 0, 2] },
      edge: { bodyId: circle.id, segmentEntityId: circleSegment.entityId },
      revision: state.revision,
    });
    near(pointCircle.supportingCircleDistanceMm, 2, 1e-6, "point-to-circle supporting distance");
    near(pointCircle.finiteArcDistanceMm, 2, 1e-6, "point-to-circle finite distance");
    requireCondition(pointCircle.edge.fullCircle === true && pointCircle.clampedToEndpoint === false, "Point-to-circle result lost full-circle semantics");
    const afterPointCircle = await call(live.client, "plasticity_status", {});
    sameDocumentState(afterPointCircle, beforePointCircle, "Point-to-circular-edge measurement");
    evidence.pointToCircularEdge = pointCircle;
    const beforeCylinderIds = new Set(state.bodies.map((body: { id: number }) => body.id));
    state = await call(live.client, "plasticity_create_cylinder", {
      centerMm: [70, 0, 0], radiusMm: 5, heightMm: 10, axis: [0, 0, 1],
      intent: "Approved disposable shell-edge curvature reference", revision: state.revision,
    });
    const cylinder = state.bodies.find((body: any) => body.type === "Solid" && !beforeCylinderIds.has(body.id));
    requireCondition(cylinder, "Cylinder did not create one Solid");
    const cylinderEdge = cylinder.edges.find((edge: any) => edge.circle === true);
    requireCondition(cylinderEdge, "Cylinder did not expose a circular shell edge");

    const beforeAnalysis = stateSummary(state);
    const report = await call(live.client, "plasticity_analyze_edge_curvature", {
      edges: [
        { bodyId: circle.id, segmentEntityId: circleDirection.segments[0].entityId },
        { bodyId: line.id, segmentEntityId: lineDirection.segments[0].entityId },
        { bodyId: cylinder.id, edgeId: cylinderEdge.id },
      ],
      revision: state.revision,
    });
    requireCondition(report.analyses?.length === 3, "Expected three curvature results");
    const circleAnalysis = report.analyses.find((analysis: any) => analysis.edge.bodyId === circle.id);
    const lineAnalysis = report.analyses.find((analysis: any) => analysis.edge.bodyId === line.id);
    const cylinderAnalysis = report.analyses.find((analysis: any) => analysis.edge.bodyId === cylinder.id);
    requireCondition(circleAnalysis && lineAnalysis && cylinderAnalysis, "Curvature results did not preserve edge identities");
    requireCondition(circleAnalysis.measurementSource === "native-brep-100-samples" && circleAnalysis.sampleCount === 100, "Circle curvature provenance is missing");
    near(circleAnalysis.minimumCurvaturePerMm, 0.1, 1e-6, "circle minimum curvature");
    near(circleAnalysis.maximumCurvaturePerMm, 0.1, 1e-6, "circle maximum curvature");
    near(circleAnalysis.meanCurvaturePerMm, 0.1, 1e-6, "circle mean curvature");
    near(circleAnalysis.minimumRadiusOfCurvatureMm, 10, 0.001, "circle minimum radius");
    near(circleAnalysis.maximumFiniteRadiusOfCurvatureMm, 10, 0.001, "circle maximum finite radius");
    requireCondition(circleAnalysis.containsZeroCurvature === false, "Circle incorrectly contains zero curvature");
    near(lineAnalysis.minimumCurvaturePerMm, 0, 1e-12, "line minimum curvature");
    near(lineAnalysis.maximumCurvaturePerMm, 0, 1e-12, "line maximum curvature");
    requireCondition(lineAnalysis.minimumRadiusOfCurvatureMm === null && lineAnalysis.maximumFiniteRadiusOfCurvatureMm === null, "Straight line returned a finite curvature radius");
    requireCondition(lineAnalysis.containsZeroCurvature === true, "Straight line did not report zero curvature");
    near(cylinderAnalysis.minimumCurvaturePerMm, 0.2, 1e-6, "cylinder-edge minimum curvature");
    near(cylinderAnalysis.maximumCurvaturePerMm, 0.2, 1e-6, "cylinder-edge maximum curvature");
    near(cylinderAnalysis.minimumRadiusOfCurvatureMm, 5, 0.001, "cylinder-edge minimum radius");
    near(cylinderAnalysis.maximumFiniteRadiusOfCurvatureMm, 5, 0.001, "cylinder-edge maximum finite radius");
    requireCondition(cylinderAnalysis.containsZeroCurvature === false, "Cylinder edge incorrectly contains zero curvature");
    state = await call(live.client, "plasticity_status", {});
    sameDocumentState(state, beforeAnalysis, "Edge-curvature analysis");
    evidence.analysis = { wireCircle: circleAnalysis, wireLine: lineAnalysis, solidCylinderEdge: cylinderAnalysis };

    state = await call(live.client, "plasticity_undo", { intent: "Verify curvature-source Undo", revision: state.revision });
    requireCondition(state.bodies.some((body: any) => body.id === circle.id) && state.bodies.some((body: any) => body.id === line.id) && !state.bodies.some((body: any) => body.id === cylinder.id), "Undo did not remove only the cylinder");
    state = await call(live.client, "plasticity_redo", { intent: "Verify curvature-source Redo", revision: state.revision });
    requireCondition(state.bodies.some((body: any) => body.id === cylinder.id), "Redo did not restore the cylinder");
    evidence.undoRedo = { undoRemovedCylinder: true, redoRestoredCylinder: true };

    while (state.undoDepth > initialState.undoDepth) state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable native edge-curvature acceptance", revision: state.revision });
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

function onlyNewWire(before: any, after: any, label: string): any { const ids = new Set(before.bodies.map((body: { id: number }) => body.id)); const bodies = after.bodies.filter((body: any) => body.type === "Wire" && !ids.has(body.id)); requireCondition(bodies.length === 1, `Expected exactly one new ${label} Wire`); return bodies[0]; }
function sameDocumentState(actual: any, expected: any, label: string): void { requireCondition(actual.documentToken === expected.documentToken, `${label} changed the document`); requireCondition(actual.revision === expected.revision, `${label} changed the revision`); requireCondition(actual.undoDepth === expected.undoDepth && actual.redoDepth === expected.redoDepth, `${label} changed Undo/Redo history`); }
function requireEmpty(state: any, label: string): void { requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0, `${label} is not empty`); requireCondition((state.groups ?? []).filter((group: { id: number }) => group.id !== 0).length === 0, `${label} contains non-root groups`); }
async function startMcp(storeRoot: string): Promise<LiveMcp> { const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" }, stderr: "pipe" }); const stderr: string[] = []; transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); }); const client = new Client({ name: "plasticity-native-edge-curvature-live", version: "1.0.0" }); await client.connect(transport); return { client, stderr }; }
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> { const response = await client.callTool({ name, arguments: args }); const text = toolText(response); if ("isError" in response && response.isError) throw new Error(text); return JSON.parse(text); }
function toolText(response: unknown): string { if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content"); const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string"); if (!item) throw new Error("MCP tool returned no text content"); return item.text; }
async function recover(client: Client, initial: any): Promise<Record<string, unknown>> { for (let count = 0; count < 24; count += 1) { const status = await call(client, "plasticity_status", {}); if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" }; if (status.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: status.bodies.length === 0 && status.regions.length === 0 }; await call(client, "plasticity_undo", { intent: "Recover disposable native edge-curvature acceptance", revision: status.revision }); } return { restoredEmptyDocument: false, reason: "undo-limit" }; }
function stateSummary(state: any): Record<string, any> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, regionCount: state.regions.length }; }
function near(actual: number, expected: number, tolerance: number, label: string): void { requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
