#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface NativePointPlanarCircularFaceAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parseNativePointPlanarCircularFaceAcceptanceArgs(argv: string[]): NativePointPlanarCircularFaceAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: NativePointPlanarCircularFaceAcceptanceOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live circular-face acceptance requires --target with an explicit Plasticity window ID");
  if (!options.allowDisposableMutations) throw new Error("Live circular-face acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live circular-face acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-point-planar-circular-face-live.ts --help
  node scripts/verify-native-point-planar-circular-face-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection or mutation.
Live mode refuses a nonempty Plasticity document, creates a disposable native
plate with one circular through-hole, measures a point to the trimmed planar
face through the production stdio MCP, then repeats the measurement on a
rounded plate whose top face has mixed line/arc boundaries. It verifies exact
B-Rep geometry, measures the exact parallel-face clearance between two native
rounded plates, verifies Undo/Redo and cleanup, then writes bounded evidence.`;

async function main(): Promise<void> {
  const options = parseNativePointPlanarCircularFaceAcceptanceArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const evidence: Record<string, unknown> = { schemaVersion: 1, startedAt: new Date().toISOString(), targetId: options.target!, workbenchUsed: false };
  let live: LiveMcp | undefined;
  let initialState: any;
  let snapshotId: string | undefined;
  try {
    live = await startMcp(join(output, "strength-store"));
    const windows = await call(live.client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    initialState = await call(live.client, "plasticity_connect", { targetId: options.target });
    requireEmpty(initialState, "initial document");
    evidence.initial = stateSummary(initialState);
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-point-planar-circular-face-empty" });
    snapshotId = snapshot.snapshotId;

    let state = await mutate(live.client, "plasticity_create_box", {
      originMm: [0, 0, 0], sizeMm: [20, 20, 5], name: "Circular face measurement fixture",
      intent: "Disposable live acceptance fixture", revision: initialState.revision,
    });
    const plate = onlyBody(state, "Solid");
    const plateId = plate.id;

    state = await mutate(live.client, "plasticity_create_cylinder", {
      centerMm: [10, 10, 0], radiusMm: 2, heightMm: 5, axis: [0, 0, 1], name: "Circular through-hole cutter",
      intent: "Disposable through-hole cutter", revision: state.revision,
    });
    const cutter = state.bodies.find((body: any) => body.id !== plateId && body.type === "Solid");
    requireCondition(cutter, "Native cylinder creation returned no cutter Solid");

    state = await mutate(live.client, "plasticity_boolean", {
      operation: "difference", targetIds: [plateId], toolIds: [cutter.id], keepTools: false,
      intent: "Create a circular opening in the disposable plate", revision: state.revision,
    });
    const resultBody = onlyBody(state, "Solid");
    const topFaces = resultBody.faces.filter((face: any) => face.planar && Math.abs(face.centerMm[2] - 5) <= 1e-5);
    requireCondition(topFaces.length === 1, `Expected one top planar face; found ${topFaces.length}`);
    const topFace = topFaces[0];
    const faceEdges = resultBody.edges.filter((edge: any) => topFace.edgeIds.includes(edge.id));
    const circleEdges = faceEdges.filter((edge: any) => edge.circle && edge.circleGeometry);
    requireCondition(circleEdges.length === 1, `Expected one native circular trim edge; found ${circleEdges.length}`);
    const circle = circleEdges[0];
    near(circle.circleGeometry.radiusMm, 2, 1e-6, "Native through-hole radius");
    near(circle.lengthMm, 4 * Math.PI, 1e-5, "Native through-hole circumference");
    requireCondition(circle.vertexIds.length === 0, "Plasticity full-circle edge unexpectedly reports distinct endpoint vertices");

    const measurementRevision = state.revision;
    const overHole = await call(live.client, "plasticity_measure_point_to_planar_face", {
      point: { type: "coordinates", pointMm: [10, 10, 7] },
      face: { bodyId: resultBody.id, faceId: topFace.id }, revision: measurementRevision,
    });
    near(overHole.minimumDistanceMm, Math.sqrt(8), 0.01, "Point-to-circular-hole face distance");
    near(overHole.supportingPlaneDistanceMm, 2, 0.01, "Point-to-supporting-plane distance");
    requireCondition(overHole.closestFeature.type === "boundary-edge" && overHole.closestFeature.edgeId === circle.id, "Closest boundary is not the exact circular hole edge");
    const radialDistance = Math.hypot(overHole.closestPointMm[0] - circle.circleGeometry.centerMm[0], overHole.closestPointMm[1] - circle.circleGeometry.centerMm[1]);
    near(radialDistance, 2, 0.01, "Closest point radius on native circular trim");
    near(overHole.closestPointMm[2], 5, 0.01, "Closest point lies on trimmed planar face");

    const overFace = await call(live.client, "plasticity_measure_point_to_planar_face", {
      point: { type: "coordinates", pointMm: [5, 5, 7] },
      face: { bodyId: resultBody.id, faceId: topFace.id }, revision: measurementRevision,
    });
    near(overFace.minimumDistanceMm, 2, 0.01, "Point-to-planar-face interior distance");
    requireCondition(overFace.closestFeature.type === "face-interior", "Interior projection did not classify as face interior");
    const afterReads = await call(live.client, "plasticity_status", {});
    requireCondition(afterReads.revision === measurementRevision && afterReads.undoDepth === state.undoDepth, "Read-only measurement changed document revision or Undo depth");
    evidence.nativeCircle = { edgeId: circle.id, radiusMm: circle.circleGeometry.radiusMm, lengthMm: circle.lengthMm, vertexIds: circle.vertexIds };
    evidence.measurements = { overHole, overFace };
    evidence.readOnly = { revisionUnchanged: true, undoDepthUnchanged: true };

    state = await mutate(live.client, "plasticity_undo", { intent: "Verify circular-face fixture Boolean Undo", revision: state.revision });
    requireCondition(state.bodies.length === 2, "Boolean Undo did not restore plate and cutter bodies");
    state = await mutate(live.client, "plasticity_redo", { intent: "Verify circular-face fixture Boolean Redo", revision: state.revision });
    requireCondition(state.bodies.length === 1 && state.bodies[0]?.id === resultBody.id, "Boolean Redo did not restore the same result body");
    evidence.undoRedo = { undoRestoredSeparatePlateAndCutter: true, redoRestoredStableBodyId: resultBody.id };

    while (state.undoDepth > initialState.undoDepth) {
      state = await mutate(live.client, "plasticity_undo", { intent: "Cleanup disposable circular-face acceptance", revision: state.revision });
    }
    requireEmpty(state, "cleaned document");

    state = await mutate(live.client, "plasticity_create_box", {
      originMm: [0, 0, 0], sizeMm: [20, 20, 5], name: "Rounded face measurement fixture",
      intent: "Disposable live mixed-arc acceptance fixture", revision: state.revision,
    });
    const roundedPlate = onlyBody(state, "Solid");
    const verticalEdges = roundedPlate.edges.filter((edge: any) =>
      Math.abs(edge.boundsMm.max[0] - edge.boundsMm.min[0]) <= 1e-5
      && Math.abs(edge.boundsMm.max[1] - edge.boundsMm.min[1]) <= 1e-5
      && Math.abs(edge.boundsMm.max[2] - edge.boundsMm.min[2] - 5) <= 0.01);
    requireCondition(verticalEdges.length === 4, `Expected four vertical fixture edges; found ${verticalEdges.length}`);
    state = await mutate(live.client, "plasticity_fillet", {
      id: roundedPlate.id, edgeIds: verticalEdges.map((edge: any) => edge.id), radiusMm: 2,
      intent: "Create exact rounded-square top boundary", revision: state.revision,
    });
    const roundedBody = onlyBody(state, "Solid");
    const roundedTopFaces = roundedBody.faces.filter((face: any) => face.planar && Math.abs(face.centerMm[2] - 5) <= 1e-5);
    requireCondition(roundedTopFaces.length === 1, `Expected one rounded top face; found ${roundedTopFaces.length}`);
    const roundedTop = roundedTopFaces[0];
    const roundedTopEdges = roundedBody.edges.filter((edge: any) => roundedTop.edgeIds.includes(edge.id));
    const trimmedArcs = roundedTopEdges.filter((edge: any) => edge.circle && edge.circleGeometry && edge.vertexIds.length === 2);
    requireCondition(trimmedArcs.length === 4, `Expected four native trimmed circular arcs; found ${trimmedArcs.length}`);
    for (const arc of trimmedArcs) near(arc.circleGeometry.radiusMm, 2, 1e-5, "Rounded-face native arc radius");

    const roundedMeasurement = await call(live.client, "plasticity_measure_point_to_planar_face", {
      point: { type: "coordinates", pointMm: [0, 0, 5] },
      face: { bodyId: roundedBody.id, faceId: roundedTop.id }, revision: state.revision,
    });
    near(roundedMeasurement.minimumDistanceMm, Math.sqrt(8) - 2, 0.01, "Point-to-rounded-corner face distance");
    requireCondition(roundedMeasurement.closestFeature.type === "boundary-edge" && trimmedArcs.some((arc: any) => arc.id === roundedMeasurement.closestFeature.edgeId), "Closest boundary is not one of the exact native circular arcs");
    evidence.mixedArc = {
      faceId: roundedTop.id,
      lineEdgeCount: roundedTopEdges.filter((edge: any) => edge.line).length,
      arcEdges: trimmedArcs.map((arc: any) => ({ edgeId: arc.id, radiusMm: arc.circleGeometry.radiusMm, lengthMm: arc.lengthMm, vertexIds: arc.vertexIds })),
      measurement: roundedMeasurement,
      nativeTrimmedArcAcceptance: true,
    };

    state = await mutate(live.client, "plasticity_create_box", {
      originMm: [22, 22, 0], sizeMm: [20, 20, 5], name: "Parallel rounded clearance fixture",
      intent: "Disposable parallel rounded-face clearance fixture", revision: state.revision,
    });
    const secondPlate = state.bodies.find((body: any) => body.type === "Solid" && body.id !== roundedBody.id);
    requireCondition(secondPlate, "Native second rounded plate creation returned no additional Solid");
    const secondVerticalEdges = secondPlate.edges.filter((edge: any) =>
      Math.abs(edge.boundsMm.max[0] - edge.boundsMm.min[0]) <= 1e-5
      && Math.abs(edge.boundsMm.max[1] - edge.boundsMm.min[1]) <= 1e-5
      && Math.abs(edge.boundsMm.max[2] - edge.boundsMm.min[2] - 5) <= 0.01);
    requireCondition(secondVerticalEdges.length === 4, `Expected four vertical edges on second fixture; found ${secondVerticalEdges.length}`);
    state = await mutate(live.client, "plasticity_fillet", {
      id: secondPlate.id, edgeIds: secondVerticalEdges.map((edge: any) => edge.id), radiusMm: 2,
      intent: "Create exact trimmed arcs on the second parallel face", revision: state.revision,
    });
    const secondRoundedBody = state.bodies.find((body: any) => body.type === "Solid" && body.id !== roundedBody.id);
    requireCondition(secondRoundedBody, "Rounded second plate disappeared after native fillet");
    const secondTopFaces = secondRoundedBody.faces.filter((face: any) => face.planar && Math.abs(face.centerMm[2] - 5) <= 1e-5);
    requireCondition(secondTopFaces.length === 1, `Expected one second rounded top face; found ${secondTopFaces.length}`);
    const secondTop = secondTopFaces[0];
    const secondTopEdges = secondRoundedBody.edges.filter((edge: any) => secondTop.edgeIds.includes(edge.id));
    const secondTrimmedArcs = secondTopEdges.filter((edge: any) => edge.circle && edge.circleGeometry && edge.vertexIds.length === 2);
    requireCondition(secondTrimmedArcs.length === 4, `Expected four native trimmed arcs on second top face; found ${secondTrimmedArcs.length}`);
    const roundedClearance = await call(live.client, "plasticity_measure_parallel_planar_face_clearance", {
      first: { bodyId: roundedBody.id, faceId: roundedTop.id },
      second: { bodyId: secondRoundedBody.id, faceId: secondTop.id },
      revision: state.revision,
    });
    near(roundedClearance.parallelPlaneGapMm, 0, 1e-6, "Parallel rounded-face plane gap");
    near(roundedClearance.inPlaneClearanceMm, Math.sqrt(72) - 4, 0.01, "Native trimmed-arc clearance");
    near(roundedClearance.closestPointsMm.first[0], 18 + Math.SQRT2, 0.01, "First native closest point X");
    near(roundedClearance.closestPointsMm.first[1], 18 + Math.SQRT2, 0.01, "First native closest point Y");
    near(roundedClearance.closestPointsMm.second[0], 24 - Math.SQRT2, 0.01, "Second native closest point X");
    near(roundedClearance.closestPointsMm.second[1], 24 - Math.SQRT2, 0.01, "Second native closest point Y");
    evidence.parallelTrimmedArcClearance = {
      firstFace: { bodyId: roundedBody.id, faceId: roundedTop.id, arcCount: trimmedArcs.length },
      secondFace: { bodyId: secondRoundedBody.id, faceId: secondTop.id, arcCount: secondTrimmedArcs.length },
      measurement: roundedClearance,
      exactNativeTrimmedArcAcceptance: true,
    };
    const afterClearanceRead = await call(live.client, "plasticity_status", {});
    requireCondition(afterClearanceRead.revision === state.revision && afterClearanceRead.undoDepth === state.undoDepth, "Parallel trimmed-arc clearance changed document revision or Undo depth");

    while (state.undoDepth > initialState.undoDepth) {
      state = await mutate(live.client, "plasticity_undo", { intent: "Cleanup disposable mixed-arc acceptance", revision: state.revision });
    }
    requireEmpty(state, "cleaned document after mixed-arc acceptance");
    const changes = await call(live.client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(changes.diff), "Scene content differs from its initial empty snapshot after cleanup");
    evidence.cleanup = { restoredEmptyDocument: true, sceneContentsRestored: true };
    evidence.completedAt = new Date().toISOString();
    await writeExclusive(join(output, "evidence.json"), sanitizeEvidence(evidence));
    console.log(JSON.stringify({ ok: true, output, evidence: join(output, "evidence.json") }, null, 2));
  } catch (error) {
    evidence.failure = boundedError(error);
    if (live && initialState && !evidence.cleanup) evidence.reconciledState = await reconcileFailure(live.client, initialState, snapshotId).catch((reconcileError) => ({ available: false, reason: boundedError(reconcileError) }));
    await writeExclusive(join(output, "failure.json"), sanitizeEvidence(evidence)).catch(() => {});
    throw error;
  } finally {
    await live?.client.close().catch(() => {});
  }
}

function onlyBody(state: any, type: string): any { const bodies = state.bodies.filter((body: any) => body.type === type); requireCondition(bodies.length === 1, `Expected one ${type}`); return bodies[0]; }
export function combineDetailedBodyPage(summary: any, page: any): any {
  requireCondition(page.documentToken === summary.documentToken, "Document changed before detailed body read; reconcile the live acceptance state");
  requireCondition(page.revision === summary.revision, "CAD revision changed before detailed body read; reconcile the live acceptance state");
  requireCondition(page.bodyPagination?.offset === 0 && page.bodyPagination?.nextOffset === null, "Detailed body page is incomplete; acceptance requires all bodies in one revision-bound read");
  requireCondition(page.bodyPagination.total === page.bodies.length, "Detailed body page count does not match its total");
  return { ...summary, bodies: page.bodies };
}
async function mutate(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const summary = await call(client, name, args);
  const page = await call(client, "plasticity_list_bodies", { bodyOffset: 0, bodyLimit: 100, expectedRevision: summary.revision });
  return combineDetailedBodyPage(summary, page);
}
function requireEmpty(state: any, label: string): void { requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0, `${label} is not empty`); requireCondition((state.groups ?? []).filter((group: { id: number }) => group.id !== 0).length === 0, `${label} contains non-root groups`); }
function stateSummary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, regionCount: state.regions.length }; }
function near(actual: number, expected: number, tolerance: number, label: string): void { requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function startMcp(storeRoot: string): Promise<LiveMcp> { const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" }, stderr: "pipe" }); const stderr: string[] = []; transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); }); const client = new Client({ name: "plasticity-native-point-planar-circular-face-live", version: "1.0.0" }); await client.connect(transport); return { client, stderr }; }
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> { const response = await client.callTool({ name, arguments: args }); const text = toolText(response); if ("isError" in response && response.isError) throw new Error(text); return JSON.parse(text); }
function toolText(response: unknown): string { if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content"); const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string"); if (!item) throw new Error("MCP tool returned no text content"); return item.text; }
async function reconcileFailure(client: Client, initial: any, snapshotId?: string): Promise<Record<string, unknown>> {
  const status = await call(client, "plasticity_status", {});
  const changes = snapshotId ? await call(client, "plasticity_changes_since", { snapshotId }) : undefined;
  return {
    available: true,
    sameDocument: status.documentToken === initial.documentToken,
    state: stateSummary(status),
    bodyIds: status.bodies.map((body: any) => body.id),
    sceneChanged: changes ? hasSceneContentChanges(changes.diff) : null,
    note: "Failure reconciliation is read-only; inspect before any manual recovery action.",
  };
}
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
