#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LINEAR_TOLERANCE_MM = 0.01;
const DIRECTION_TOLERANCE = 1e-6;

export interface NativeCurveBridgeAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }
type Continuity = "G0" | "G1" | "G2" | "G3";

const cases: Array<{
  continuity: Continuity;
  offsetMm: number;
  expected: { degree: number; controlPointCount: number; spanCount: number; lengthMm: number; tangent: number[] };
}> = [
  { continuity: "G0", offsetMm: 0, expected: { degree: 1, controlPointCount: 2, spanCount: 1, lengthMm: Math.sqrt(200), tangent: [Math.SQRT1_2, Math.SQRT1_2, 0] } },
  { continuity: "G1", offsetMm: 30, expected: { degree: 3, controlPointCount: 4, spanCount: 1, lengthMm: 15.258813430624569, tangent: [1, 0, 0] } },
  { continuity: "G2", offsetMm: 60, expected: { degree: 5, controlPointCount: 6, spanCount: 1, lengthMm: 16.419665974002086, tangent: [1, 0, 0] } },
  { continuity: "G3", offsetMm: 90, expected: { degree: 7, controlPointCount: 8, spanCount: 1, lengthMm: 17.34788994740282, tangent: [1, 0, 0] } },
];

export function parseNativeCurveBridgeAcceptanceArgs(argv: string[]): NativeCurveBridgeAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: NativeCurveBridgeAcceptanceOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live native-curve-bridge acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native-curve-bridge acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native-curve-bridge acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-curve-bridge-live.ts --help
  node scripts/verify-native-curve-bridge-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode refuses a nonempty Plasticity document, never chooses a window
automatically, verifies native Wire Curve Bridge G0 through G3, an exact open
Wire-vertex bridge, and a G2 bridge between explicit Solid edge endpoints
through public MCP tools, checks exact B-Rep structure and directions, exercises
Undo/Redo, cleans up, and writes bounded evidence.`;

async function main(): Promise<void> {
  const options = parseNativeCurveBridgeAcceptanceArgs(process.argv.slice(2));
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
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-curve-bridge-live-initial-empty" });

    let state = initialState;
    const sourceIds: number[] = [];
    const endpoints: Array<{ first: { bodyId: number; segmentEntityId: number; at: "end" }; second: { bodyId: number; segmentEntityId: number; at: "start" } }> = [];
    for (const testCase of cases) {
      const first = await createLine(live.client, state, [0, testCase.offsetMm, 0], [10, testCase.offsetMm, 0]);
      state = first.state;
      const second = await createLine(live.client, state, [20, testCase.offsetMm + 10, 0], [30, testCase.offsetMm + 10, 0]);
      state = second.state;
      sourceIds.push(first.bodyId, second.bodyId);
      const directions = await call(live.client, "plasticity_list_curve_directions", {});
      endpoints.push({
        first: { bodyId: first.bodyId, segmentEntityId: onlySegment(directions, first.bodyId).entityId, at: "end" },
        second: { bodyId: second.bodyId, segmentEntityId: onlySegment(directions, second.bodyId).entityId, at: "start" },
      });
    }
    requireCondition(state.undoDepth === initialState.undoDepth + 8, "Eight source lines did not create eight history steps");

    const bridgeIds: number[] = [];
    for (let index = 0; index < cases.length; index += 1) {
      const testCase = cases[index]!;
      const beforeIds = new Set(state.bodies.map((body: { id: number }) => body.id));
      state = await call(live.client, "plasticity_bridge_curves", {
        ...endpoints[index], startContinuity: testCase.continuity, endContinuity: testCase.continuity,
        intent: `Approved disposable native ${testCase.continuity} Curve Bridge acceptance`, revision: state.revision,
      });
      const added = state.bodies.filter((body: { id: number; type: string }) => !beforeIds.has(body.id) && body.type === "Wire");
      requireCondition(added.length === 1, `${testCase.continuity} Curve Bridge did not add exactly one Wire`);
      bridgeIds.push(added[0].id);
      sourceIds.forEach((id) => requireCondition(state.bodies.some((body: { id: number }) => body.id === id), `Curve Bridge removed source Wire ${id}`));
    }
    requireCondition(state.undoDepth === initialState.undoDepth + 12, "Four bridges did not create one history step each");

    const structure = await call(live.client, "plasticity_inspect_curve_structure", { ids: bridgeIds, revision: state.revision });
    const directions = await call(live.client, "plasticity_list_curve_directions", {});
    const observed = cases.map((testCase, index) => {
      const segment = requireStructure(structure, bridgeIds[index]!, testCase.expected);
      const direction = onlySegment(directions, bridgeIds[index]!);
      vectorNear(direction.startMm, [10, testCase.offsetMm, 0], LINEAR_TOLERANCE_MM, `${testCase.continuity} start`);
      vectorNear(direction.endMm, [20, testCase.offsetMm + 10, 0], LINEAR_TOLERANCE_MM, `${testCase.continuity} end`);
      vectorNear(direction.startTangent, testCase.expected.tangent, DIRECTION_TOLERANCE, `${testCase.continuity} start tangent`);
      vectorNear(direction.endTangent, testCase.expected.tangent, DIRECTION_TOLERANCE, `${testCase.continuity} end tangent`);
      near(direction.lengthMm, testCase.expected.lengthMm, LINEAR_TOLERANCE_MM, `${testCase.continuity} length`);
      return {
        continuity: testCase.continuity, bodyId: bridgeIds[index], sourceBodyIds: [endpoints[index]!.first.bodyId, endpoints[index]!.second.bodyId],
        curveType: segment.curveType, degree: segment.degree, controlPointCount: segment.controlPointCount,
        spanCount: segment.spanCount, lengthMm: direction.lengthMm, startMm: direction.startMm, endMm: direction.endMm,
        startTangent: direction.startTangent, endTangent: direction.endTangent,
      };
    });
    evidence.bridges = { sourceWiresPreserved: true, measurementSource: "native-brep", cases: observed };

    for (let index = 0; index < 4; index += 1) state = await call(live.client, "plasticity_undo", { intent: "Verify native Curve Bridge Undo", revision: state.revision });
    requireCondition(state.bodies.length === 8 && sourceIds.every((id) => state.bodies.some((body: { id: number }) => body.id === id)), "Undo did not preserve all source Wires");
    requireCondition(bridgeIds.every((id) => !state.bodies.some((body: { id: number }) => body.id === id)), "Undo left a Curve Bridge Wire behind");
    for (let index = 0; index < 4; index += 1) state = await call(live.client, "plasticity_redo", { intent: "Verify native Curve Bridge Redo", revision: state.revision });
    const redone = await call(live.client, "plasticity_inspect_curve_structure", { ids: bridgeIds, revision: state.revision });
    cases.forEach((testCase, index) => requireStructure(redone, bridgeIds[index]!, testCase.expected));
    evidence.undoRedo = { undoRemovedOnlyBridges: true, sourceWiresPreserved: true, redoRestoredAllBridgeStructures: true };

    const firstVertexSource = await createLine(live.client, state, [0, 120, 0], [10, 120, 0]);
    state = firstVertexSource.state;
    const secondVertexSource = await createLine(live.client, state, [20, 130, 0], [30, 130, 0]);
    state = secondVertexSource.state;
    requireCondition(state.undoDepth === initialState.undoDepth + 14, "Two Curve Vertex Bridge source lines did not create two history steps");
    const curveVertices = await call(live.client, "plasticity_list_curve_vertices", {});
    const firstCurveVertex = requireCurveVertexAt(curveVertices, firstVertexSource.bodyId, [10, 120, 0], "first Curve Vertex Bridge endpoint");
    const secondCurveVertex = requireCurveVertexAt(curveVertices, secondVertexSource.bodyId, [20, 130, 0], "second Curve Vertex Bridge endpoint");
    requireCondition(firstCurveVertex.endpoint && secondCurveVertex.endpoint, "Curve Vertex Bridge references are not open endpoints");
    const beforeVertexBridgeIds = new Set(state.bodies.map((body: { id: number }) => body.id));
    state = await call(live.client, "plasticity_bridge_curve_vertices", {
      first: { bodyId: firstVertexSource.bodyId, vertexId: firstCurveVertex.vertexId },
      second: { bodyId: secondVertexSource.bodyId, vertexId: secondCurveVertex.vertexId },
      startContinuity: "G2", endContinuity: "G2",
      intent: "Approved disposable exact native G2 Curve Vertex Bridge acceptance", revision: state.revision,
    });
    requireCondition(state.undoDepth === initialState.undoDepth + 15, "Curve Vertex Bridge did not create exactly one history step");
    const vertexBridgeBodies = state.bodies.filter((body: { id: number; type: string }) => !beforeVertexBridgeIds.has(body.id) && body.type === "Wire");
    requireCondition(vertexBridgeBodies.length === 1, "Curve Vertex Bridge did not add exactly one independent Wire");
    const vertexBridgeId = vertexBridgeBodies[0].id;
    requireCondition(state.bodies.some((body: { id: number }) => body.id === firstVertexSource.bodyId) && state.bodies.some((body: { id: number }) => body.id === secondVertexSource.bodyId), "Curve Vertex Bridge removed a source Wire");
    const vertexStructure = await call(live.client, "plasticity_inspect_curve_structure", { ids: [vertexBridgeId], revision: state.revision });
    const vertexSegmentStructure = requireStructure(vertexStructure, vertexBridgeId, { degree: 5, controlPointCount: 6, spanCount: 1 });
    const vertexDirections = await call(live.client, "plasticity_list_curve_directions", {});
    const vertexDirection = onlySegment(vertexDirections, vertexBridgeId);
    vectorNear(vertexDirection.startMm, [10, 120, 0], LINEAR_TOLERANCE_MM, "Curve Vertex Bridge start");
    vectorNear(vertexDirection.endMm, [20, 130, 0], LINEAR_TOLERANCE_MM, "Curve Vertex Bridge end");
    vectorNear(vertexDirection.startTangent, [1, 0, 0], DIRECTION_TOLERANCE, "Curve Vertex Bridge start tangent");
    vectorNear(vertexDirection.endTangent, [1, 0, 0], DIRECTION_TOLERANCE, "Curve Vertex Bridge end tangent");
    near(vertexDirection.lengthMm, 16.419665974002086, LINEAR_TOLERANCE_MM, "Curve Vertex Bridge length");
    evidence.curveVertexBridge = {
      bodyId: vertexBridgeId, sourceWiresPreserved: true,
      sources: [
        { bodyId: firstVertexSource.bodyId, vertexId: firstCurveVertex.vertexId },
        { bodyId: secondVertexSource.bodyId, vertexId: secondCurveVertex.vertexId },
      ],
      continuity: ["G2", "G2"], measurementSource: "native-brep",
      curveType: vertexSegmentStructure.curveType, degree: vertexSegmentStructure.degree,
      controlPointCount: vertexSegmentStructure.controlPointCount, spanCount: vertexSegmentStructure.spanCount,
      startMm: vertexDirection.startMm, endMm: vertexDirection.endMm,
      startTangent: vertexDirection.startTangent, endTangent: vertexDirection.endTangent,
      lengthMm: vertexDirection.lengthMm,
    };
    state = await call(live.client, "plasticity_undo", { intent: "Verify native Curve Vertex Bridge Undo", revision: state.revision });
    requireCondition(!state.bodies.some((body: { id: number }) => body.id === vertexBridgeId), "Undo left the Curve Vertex Bridge Wire behind");
    requireCondition(state.bodies.some((body: { id: number }) => body.id === firstVertexSource.bodyId) && state.bodies.some((body: { id: number }) => body.id === secondVertexSource.bodyId), "Curve Vertex Bridge Undo removed a source Wire");
    state = await call(live.client, "plasticity_redo", { intent: "Verify native Curve Vertex Bridge Redo", revision: state.revision });
    const redoneVertex = await call(live.client, "plasticity_inspect_curve_structure", { ids: [vertexBridgeId], revision: state.revision });
    requireStructure(redoneVertex, vertexBridgeId, { degree: 5, controlPointCount: 6, spanCount: 1 });
    evidence.undoRedo = { ...(evidence.undoRedo as object), curveVertexBridgeUndoPreservedSources: true, curveVertexBridgeRedoRestoredStructure: true };

    const firstBox = await createBox(live.client, state, [0, 150, 0], [10, 10, 10], "Shell bridge source A");
    state = firstBox.state;
    const secondBox = await createBox(live.client, state, [30, 170, 20], [10, 10, 10], "Shell bridge source B");
    state = secondBox.state;
    requireCondition(state.undoDepth === initialState.undoDepth + 17, "Two Shell Edge Bridge source boxes did not create two history steps");
    const firstBody = requireBody(state, firstBox.bodyId, "first Shell Edge Bridge source");
    const secondBody = requireBody(state, secondBox.bodyId, "second Shell Edge Bridge source");
    const firstEdge = requireEdgeByBounds(firstBody, [10, 160, 0], [10, 160, 10], "first Shell Edge Bridge source");
    const secondEdge = requireEdgeByBounds(secondBody, [30, 170, 20], [30, 170, 30], "second Shell Edge Bridge source");
    const firstVertex = requireVertexAt(firstBody, [10, 160, 10], "first Shell Edge Bridge endpoint");
    const secondVertex = requireVertexAt(secondBody, [30, 170, 20], "second Shell Edge Bridge endpoint");
    requireCondition(firstEdge.vertexIds.includes(firstVertex.id) && secondEdge.vertexIds.includes(secondVertex.id), "Selected Shell Edge Bridge vertices do not belong to their exact edges");

    const beforeShellBridgeIds = new Set(state.bodies.map((body: { id: number }) => body.id));
    state = await call(live.client, "plasticity_bridge_shell_edges", {
      first: { bodyId: firstBody.id, edgeId: firstEdge.id, vertexId: firstVertex.id },
      second: { bodyId: secondBody.id, edgeId: secondEdge.id, vertexId: secondVertex.id },
      startContinuity: "G2", endContinuity: "G2",
      intent: "Approved disposable exact native G2 Shell Edge Bridge acceptance", revision: state.revision,
    });
    requireCondition(state.undoDepth === initialState.undoDepth + 18, "Shell Edge Bridge did not create exactly one history step");
    const shellBridgeBodies = state.bodies.filter((body: { id: number; type: string }) => !beforeShellBridgeIds.has(body.id) && body.type === "Wire");
    requireCondition(shellBridgeBodies.length === 1, "Shell Edge Bridge did not add exactly one independent Wire");
    const shellBridgeId = shellBridgeBodies[0].id;
    requireCondition(state.bodies.some((body: { id: number }) => body.id === firstBody.id) && state.bodies.some((body: { id: number }) => body.id === secondBody.id), "Shell Edge Bridge removed a source Solid");
    const shellStructure = await call(live.client, "plasticity_inspect_curve_structure", { ids: [shellBridgeId], revision: state.revision });
    const shellSegmentStructure = requireStructure(shellStructure, shellBridgeId, { degree: 5, controlPointCount: 6, spanCount: 1 });
    const shellDirections = await call(live.client, "plasticity_list_curve_directions", {});
    const shellDirection = onlySegment(shellDirections, shellBridgeId);
    vectorNear(shellDirection.startMm, [10, 160, 10], LINEAR_TOLERANCE_MM, "Shell Edge Bridge start");
    vectorNear(shellDirection.endMm, [30, 170, 20], LINEAR_TOLERANCE_MM, "Shell Edge Bridge end");
    vectorNear(shellDirection.startTangent, [0, 0, 1], DIRECTION_TOLERANCE, "Shell Edge Bridge start tangent");
    vectorNear(shellDirection.endTangent, [0, 0, 1], DIRECTION_TOLERANCE, "Shell Edge Bridge end tangent");
    near(shellDirection.lengthMm, 33.59680690035184, LINEAR_TOLERANCE_MM, "Shell Edge Bridge length");
    evidence.shellEdgeBridge = {
      bodyId: shellBridgeId,
      sourceBodiesPreserved: true,
      sources: [
        { bodyId: firstBody.id, edgeId: firstEdge.id, vertexId: firstVertex.id },
        { bodyId: secondBody.id, edgeId: secondEdge.id, vertexId: secondVertex.id },
      ],
      continuity: ["G2", "G2"], measurementSource: "native-brep",
      curveType: shellSegmentStructure.curveType, degree: shellSegmentStructure.degree,
      controlPointCount: shellSegmentStructure.controlPointCount, spanCount: shellSegmentStructure.spanCount,
      startMm: shellDirection.startMm, endMm: shellDirection.endMm,
      startTangent: shellDirection.startTangent, endTangent: shellDirection.endTangent,
      lengthMm: shellDirection.lengthMm,
    };

    state = await call(live.client, "plasticity_undo", { intent: "Verify native Shell Edge Bridge Undo", revision: state.revision });
    requireCondition(!state.bodies.some((body: { id: number }) => body.id === shellBridgeId), "Undo left the Shell Edge Bridge Wire behind");
    requireCondition(state.bodies.some((body: { id: number }) => body.id === firstBody.id) && state.bodies.some((body: { id: number }) => body.id === secondBody.id), "Shell Edge Bridge Undo removed a source Solid");
    state = await call(live.client, "plasticity_redo", { intent: "Verify native Shell Edge Bridge Redo", revision: state.revision });
    const redoneShell = await call(live.client, "plasticity_inspect_curve_structure", { ids: [shellBridgeId], revision: state.revision });
    requireStructure(redoneShell, shellBridgeId, { degree: 5, controlPointCount: 6, spanCount: 1 });
    evidence.undoRedo = { ...(evidence.undoRedo as object), shellEdgeBridgeUndoPreservedSources: true, shellEdgeBridgeRedoRestoredStructure: true };

    while (state.undoDepth > initialState.undoDepth) state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable native Curve Bridge acceptance", revision: state.revision });
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

async function createLine(client: Client, state: any, startMm: number[], endMm: number[]): Promise<{ state: any; bodyId: number }> {
  const beforeIds = new Set(state.bodies.map((body: { id: number }) => body.id));
  const next = await call(client, "plasticity_create_polyline", { pointsMm: [startMm, endMm], closed: false, intent: "Approved disposable Curve Bridge source", revision: state.revision });
  const added = next.bodies.filter((body: { id: number; type: string }) => !beforeIds.has(body.id) && body.type === "Wire");
  requireCondition(added.length === 1, "Curve Bridge source did not add exactly one Wire");
  return { state: next, bodyId: added[0].id };
}

async function createBox(client: Client, state: any, originMm: number[], sizeMm: number[], name: string): Promise<{ state: any; bodyId: number }> {
  const beforeIds = new Set(state.bodies.map((body: { id: number }) => body.id));
  const next = await call(client, "plasticity_create_box", { originMm, sizeMm, name, intent: "Approved disposable Shell Edge Bridge source", revision: state.revision });
  const added = next.bodies.filter((body: { id: number; type: string }) => !beforeIds.has(body.id) && body.type === "Solid");
  requireCondition(added.length === 1, "Shell Edge Bridge source did not add exactly one Solid");
  return { state: next, bodyId: added[0].id };
}

function requireBody(state: any, id: number, label: string): any {
  const body = state.bodies.find((candidate: { id: number }) => candidate.id === id);
  requireCondition(body, `${label} body is missing`);
  return body;
}

function requireEdgeByBounds(body: any, min: number[], max: number[], label: string): any {
  const matches = body.edges.filter((edge: { boundsMm: { min: number[]; max: number[] } }) => vectorsNear(edge.boundsMm.min, min, LINEAR_TOLERANCE_MM) && vectorsNear(edge.boundsMm.max, max, LINEAR_TOLERANCE_MM));
  requireCondition(matches.length === 1, `${label} did not resolve to one exact native edge`);
  return matches[0];
}

function requireVertexAt(body: any, positionMm: number[], label: string): any {
  const matches = (body.vertices ?? []).filter((vertex: { positionMm: number[] }) => vectorsNear(vertex.positionMm, positionMm, LINEAR_TOLERANCE_MM));
  requireCondition(matches.length === 1, `${label} did not resolve to one exact native vertex`);
  return matches[0];
}

function requireCurveVertexAt(report: any, bodyId: number, positionMm: number[], label: string): any {
  const matches = (report.vertices ?? []).filter((vertex: { bodyId: number; positionMm: number[] }) => vertex.bodyId === bodyId && vectorsNear(vertex.positionMm, positionMm, LINEAR_TOLERANCE_MM));
  requireCondition(matches.length === 1, `${label} did not resolve to one exact native curve vertex`);
  return matches[0];
}

function onlySegment(report: any, id: number): any {
  const curve = report.curves.find((candidate: { id: number }) => candidate.id === id);
  requireCondition(curve?.measurementSource === "native-brep" && curve.segments?.length === 1, `Missing one-segment native direction evidence for Wire ${id}`);
  return curve.segments[0];
}

function requireStructure(report: any, id: number, expected: { degree: number; controlPointCount: number; spanCount: number }): any {
  const curve = report.curves.find((candidate: { id: number }) => candidate.id === id);
  requireCondition(curve?.measurementSource === "native-brep" && curve.segments?.length === 1, `Missing one-segment native structure evidence for Wire ${id}`);
  const segment = curve.segments[0];
  requireCondition(segment.curveType === "BCurve", `Wire ${id}: expected BCurve, got ${String(segment.curveType)}`);
  for (const key of ["degree", "controlPointCount", "spanCount"] as const) requireCondition(segment[key] === expected[key], `Wire ${id} ${key}: expected ${expected[key]}, got ${segment[key]}`);
  requireCondition(segment.rational === false && segment.periodic === false, `Wire ${id}: expected a non-rational non-periodic BCurve`);
  return segment;
}

function requireEmpty(state: any, label: string): void { requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0, `${label} is not empty`); requireCondition((state.groups ?? []).filter((group: { id: number }) => group.id !== 0).length === 0, `${label} contains non-root groups`); }

async function startMcp(storeRoot: string): Promise<LiveMcp> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" }, stderr: "pipe" });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); });
  const client = new Client({ name: "plasticity-native-curve-bridge-live", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> { const response = await client.callTool({ name, arguments: args }); const text = toolText(response); if ("isError" in response && response.isError) throw new Error(text); return JSON.parse(text); }
function toolText(response: unknown): string { if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content"); const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string"); if (!item) throw new Error("MCP tool returned no text content"); return item.text; }
async function recover(client: Client, initial: any): Promise<Record<string, unknown>> { for (let count = 0; count < 32; count += 1) { const status = await call(client, "plasticity_status", {}); if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" }; if (status.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: status.bodies.length === 0 && status.regions.length === 0 }; await call(client, "plasticity_undo", { intent: "Recover disposable native Curve Bridge acceptance", revision: status.revision }); } return { restoredEmptyDocument: false, reason: "undo-limit" }; }
function stateSummary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, regionCount: state.regions.length }; }
function near(actual: number, expected: number, tolerance: number, label: string): void { requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`); }
function vectorNear(actual: number[], expected: number[], tolerance: number, label: string): void { requireCondition(actual.length === expected.length, `${label}: vector length mismatch`); actual.forEach((value, index) => near(value, expected[index]!, tolerance, `${label}[${index}]`)); }
function vectorsNear(actual: number[], expected: number[], tolerance: number): boolean { return actual.length === expected.length && actual.every((value, index) => Number.isFinite(value) && Math.abs(value - expected[index]!) <= tolerance); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
