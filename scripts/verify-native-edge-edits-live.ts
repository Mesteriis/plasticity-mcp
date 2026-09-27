#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LINEAR_TOLERANCE_MM = 0.01;

export interface NativeEdgeEditAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parseNativeEdgeEditAcceptanceArgs(argv: string[]): NativeEdgeEditAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: NativeEdgeEditAcceptanceOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live native-edge-edit acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native-edge-edit acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native-edge-edit acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-edge-edits-live.ts --help
  node scripts/verify-native-edge-edits-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode refuses a nonempty Plasticity document, moves one exact box edge,
offsets two exact box edges with opposite signs, deletes one removable split
edge, checks native B-Rep geometry and validity, exercises Undo/Redo, cleans up,
and writes bounded evidence.`;

async function main(): Promise<void> {
  const options = parseNativeEdgeEditAcceptanceArgs(process.argv.slice(2));
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
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-edge-edits-live-initial-empty" });

    let state = await createBox(live.client, initialState, [0, 0, 0], "Edge move acceptance");
    const movedBodyId = onlyNamedBody(state, "Edge move acceptance").id;
    const moveSource = requireEdge(onlyBody(state, movedBodyId), (edge) => isLine(edge) && nearPoint(edge.centerMm, [10, 0, 10]) && nearValue(edge.lengthMm, 20));
    const beforeMoveDepth = state.undoDepth;
    state = await call(live.client, "plasticity_move_edges", {
      edges: [{ bodyId: movedBodyId, edgeId: moveSource.id }], deltaMm: [0, 0, 5],
      intent: "Move disposable top-front edge by an exact native delta", revision: state.revision,
    });
    requireCondition(state.undoDepth === beforeMoveDepth + 1, "Edge move did not create exactly one history step");
    const moved = onlyBody(state, movedBodyId);
    requireTopology(moved, 6, 12, "moved body");
    const movedEdge = requireEdge(moved, (edge) => isLine(edge) && nearPoint(edge.centerMm, [10, 0, 15]) && nearValue(edge.lengthMm, 20));
    const tiltedTop = requireFace(moved, (face) => face.planar === true && nearValue(face.normal?.[1], 1 / Math.sqrt(5), 1e-6) && nearValue(face.normal?.[2], 2 / Math.sqrt(5), 1e-6));
    const slantedEdges = moved.edges.filter((edge: any) => nearValue(edge.lengthMm, Math.sqrt(125)));
    requireCondition(slantedEdges.length === 2, `Expected two exact slanted edges after edge move; found ${slantedEdges.length}`);
    const movedFinal = compactBody(moved);
    state = await call(live.client, "plasticity_undo", { intent: "Verify native edge move Undo", revision: state.revision });
    requireEdge(onlyBody(state, movedBodyId), (edge) => isLine(edge) && nearPoint(edge.centerMm, [10, 0, 10]) && nearValue(edge.lengthMm, 20));
    state = await call(live.client, "plasticity_redo", { intent: "Verify native edge move Redo", revision: state.revision });
    requireEdge(onlyBody(state, movedBodyId), (edge) => isLine(edge) && nearPoint(edge.centerMm, [10, 0, 15]) && nearValue(edge.lengthMm, 20));
    evidence.move = {
      bodyId: movedBodyId, deltaMm: [0, 0, 5], exactMovedEdge: compactEdge(movedEdge),
      exactTiltedFaceNormal: tiltedTop.normal, exactConnectingEdgeLengthsMm: slantedEdges.map((edge: any) => edge.lengthMm),
      after: movedFinal, oneHistoryStep: true, undoRedo: true,
    };

    state = await createBox(live.client, state, [40, 0, 0], "Edge positive offset acceptance");
    const positiveBodyId = onlyNamedBody(state, "Edge positive offset acceptance").id;
    const positiveSource = requireEdge(onlyBody(state, positiveBodyId), (edge) => isLine(edge) && nearPoint(edge.centerMm, [50, 0, 10]) && nearValue(edge.lengthMm, 20));
    const beforePositiveDepth = state.undoDepth;
    state = await call(live.client, "plasticity_offset_edges", {
      edges: [{ bodyId: positiveBodyId, edgeId: positiveSource.id }], distanceMm: 2,
      intent: "Create a positive native edge offset on a disposable box", revision: state.revision,
    });
    requireCondition(state.undoDepth === beforePositiveDepth + 1, "Positive edge offset did not create exactly one history step");
    const positive = onlyBody(state, positiveBodyId);
    requireTopology(positive, 7, 15, "positive-offset body");
    const positiveOffset = requireEdge(positive, (edge) => edge.curveType === "BCurve" && nearPoint(edge.centerMm, [50, 0, 8]) && nearValue(edge.lengthMm, 20));
    const positiveFragments = positive.edges.filter((edge: any) => nearValue(edge.lengthMm, 2));
    requireCondition(positiveFragments.length === 2, `Expected two exact 2 mm fragments after positive offset; found ${positiveFragments.length}`);
    const positiveFinal = compactBody(positive);
    state = await call(live.client, "plasticity_undo", { intent: "Verify positive native edge-offset Undo", revision: state.revision });
    requireTopology(onlyBody(state, positiveBodyId), 6, 12, "positive-offset undo body");
    state = await call(live.client, "plasticity_redo", { intent: "Verify positive native edge-offset Redo", revision: state.revision });
    requireEdge(onlyBody(state, positiveBodyId), (edge) => edge.curveType === "BCurve" && nearPoint(edge.centerMm, [50, 0, 8]) && nearValue(edge.lengthMm, 20));
    evidence.positiveOffset = {
      bodyId: positiveBodyId, distanceMm: 2, adjacentSurface: "front-y0", exactOffsetEdge: compactEdge(positiveOffset),
      exactFragmentLengthsMm: positiveFragments.map((edge: any) => edge.lengthMm), after: positiveFinal,
      oneHistoryStep: true, undoRedo: true,
    };

    state = await createBox(live.client, state, [80, 0, 0], "Edge negative offset acceptance");
    const negativeBodyId = onlyNamedBody(state, "Edge negative offset acceptance").id;
    const negativeSource = requireEdge(onlyBody(state, negativeBodyId), (edge) => isLine(edge) && nearPoint(edge.centerMm, [90, 0, 10]) && nearValue(edge.lengthMm, 20));
    const beforeNegativeDepth = state.undoDepth;
    state = await call(live.client, "plasticity_offset_edges", {
      edges: [{ bodyId: negativeBodyId, edgeId: negativeSource.id }], distanceMm: -2,
      intent: "Create a negative native edge offset on a disposable box", revision: state.revision,
    });
    requireCondition(state.undoDepth === beforeNegativeDepth + 1, "Negative edge offset did not create exactly one history step");
    const negative = onlyBody(state, negativeBodyId);
    requireTopology(negative, 7, 15, "negative-offset body");
    const negativeOffset = requireEdge(negative, (edge) => edge.curveType === "BCurve" && nearPoint(edge.centerMm, [90, 2, 10]) && nearValue(edge.lengthMm, 20));
    const negativeFragments = negative.edges.filter((edge: any) => nearValue(edge.lengthMm, 2));
    requireCondition(negativeFragments.length === 2, `Expected two exact 2 mm fragments after negative offset; found ${negativeFragments.length}`);
    const negativeFinal = compactBody(negative);
    state = await call(live.client, "plasticity_undo", { intent: "Verify negative native edge-offset Undo", revision: state.revision });
    requireTopology(onlyBody(state, negativeBodyId), 6, 12, "negative-offset undo body");
    state = await call(live.client, "plasticity_redo", { intent: "Verify negative native edge-offset Redo", revision: state.revision });
    requireEdge(onlyBody(state, negativeBodyId), (edge) => edge.curveType === "BCurve" && nearPoint(edge.centerMm, [90, 2, 10]) && nearValue(edge.lengthMm, 20));
    evidence.negativeOffset = {
      bodyId: negativeBodyId, distanceMm: -2, adjacentSurface: "top-z10", exactOffsetEdge: compactEdge(negativeOffset),
      exactFragmentLengthsMm: negativeFragments.map((edge: any) => edge.lengthMm), after: negativeFinal,
      oneHistoryStep: true, undoRedo: true,
    };

    state = await createBox(live.client, state, [120, 0, 0], "Edge deletion acceptance");
    const deletedBodyId = onlyNamedBody(state, "Edge deletion acceptance").id;
    const deleteOffsetSource = requireEdge(onlyBody(state, deletedBodyId), (edge) => isLine(edge) && nearPoint(edge.centerMm, [130, 0, 10]) && nearValue(edge.lengthMm, 20));
    state = await call(live.client, "plasticity_offset_edges", {
      edges: [{ bodyId: deletedBodyId, edgeId: deleteOffsetSource.id }], distanceMm: 2,
      intent: "Create a disposable removable split edge", revision: state.revision,
    });
    const splitBody = onlyBody(state, deletedBodyId);
    requireTopology(splitBody, 7, 15, "pre-deletion split body");
    const splitEdge = requireEdge(splitBody, (edge) => edge.curveType === "BCurve" && nearPoint(edge.centerMm, [130, 0, 8]) && nearValue(edge.lengthMm, 20));
    const beforeDeleteDepth = state.undoDepth;
    state = await call(live.client, "plasticity_delete_edges", {
      edges: [{ bodyId: deletedBodyId, edgeId: splitEdge.id }],
      intent: "Heal a compatible planar split by deleting its exact native edge", revision: state.revision,
    });
    requireCondition(state.undoDepth === beforeDeleteDepth + 1, "Edge deletion did not create exactly one history step");
    const deleted = onlyBody(state, deletedBodyId);
    requireTopology(deleted, 6, 12, "edge-deleted body");
    const restoredEdge = requireEdge(deleted, (edge) => isLine(edge) && nearPoint(edge.centerMm, [130, 0, 10]) && nearValue(edge.lengthMm, 20));
    requireCondition(!deleted.edges.some((edge: any) => edge.curveType === "BCurve"), "Deleted split edge remains in healed topology");
    const deletedFinal = compactBody(deleted);
    state = await call(live.client, "plasticity_undo", { intent: "Verify native edge-deletion Undo", revision: state.revision });
    requireTopology(onlyBody(state, deletedBodyId), 7, 15, "edge-deletion undo body");
    requireEdge(onlyBody(state, deletedBodyId), (edge) => edge.curveType === "BCurve" && nearPoint(edge.centerMm, [130, 0, 8]) && nearValue(edge.lengthMm, 20));
    state = await call(live.client, "plasticity_redo", { intent: "Verify native edge-deletion Redo", revision: state.revision });
    requireTopology(onlyBody(state, deletedBodyId), 6, 12, "edge-deletion redo body");
    evidence.delete = {
      bodyId: deletedBodyId, deletedEdge: compactEdge(splitEdge), exactRestoredBoundary: compactEdge(restoredEdge),
      topologyBefore: { faceCount: 7, edgeCount: 15 }, topologyAfter: { faceCount: 6, edgeCount: 12 },
      after: deletedFinal, oneHistoryStep: true, undoRedo: true,
    };

    const validation = await call(live.client, "plasticity_validate_bodies", { ids: [movedBodyId, positiveBodyId, negativeBodyId, deletedBodyId], revision: state.revision });
    requireCondition(validation.measurementSource === "native-brep", "Unexpected body validation source");
    requireCondition(validation.bodies.length === 4 && validation.bodies.every((body: any) => body.type === "Solid" && body.nativeValid === true && body.printableSolid === true && body.nativeCheckCodes.length === 0), "An edge-edited body failed native validation");
    requireCondition(state.undoDepth === initialState.undoDepth + 9, "Four sources plus five edge edits did not create nine history steps");
    evidence.validation = validation;

    while (state.undoDepth > initialState.undoDepth) state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable native edge-edit acceptance", revision: state.revision });
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

async function createBox(client: Client, state: any, originMm: [number, number, number], name: string): Promise<any> {
  return await call(client, "plasticity_create_box", { originMm, sizeMm: [20, 10, 10], name, intent: `Create disposable source for ${name}`, revision: state.revision });
}
function onlyNamedBody(state: any, name: string): any { const bodies = state.bodies.filter((body: any) => body.name === name); requireCondition(bodies.length === 1, `Expected exactly one body named ${name}`); return bodies[0]; }
function onlyBody(state: any, id: number): any { const body = state.bodies.find((candidate: any) => candidate.id === id); requireCondition(body, `Missing body ${id}`); return body; }
function requireEdge(body: any, predicate: (edge: any) => boolean): any { const edges = body.edges.filter(predicate); requireCondition(edges.length === 1, `Expected one matching edge on body ${body.id}; found ${edges.length}`); return edges[0]; }
function requireFace(body: any, predicate: (face: any) => boolean): any { const faces = body.faces.filter(predicate); requireCondition(faces.length === 1, `Expected one matching face on body ${body.id}; found ${faces.length}`); return faces[0]; }
function requireTopology(body: any, faceCount: number, edgeCount: number, label: string): void { requireCondition(body.faces.length === faceCount && body.edges.length === edgeCount, `${label}: expected ${faceCount} faces and ${edgeCount} edges, got ${body.faces.length} and ${body.edges.length}`); }
function isLine(edge: any): boolean { return edge.curveType === "Line" || edge.line === true; }
function compactEdge(edge: any): Record<string, unknown> { return { id: edge.id, curveType: edge.curveType, lengthMm: edge.lengthMm, centerMm: edge.centerMm, tangent: edge.tangent }; }
function compactBody(body: any): Record<string, unknown> { return { id: body.id, versionId: body.versionId, type: body.type, faceCount: body.faces.length, edgeCount: body.edges.length, faces: body.faces.map((face: any) => ({ id: face.id, surfaceType: face.surfaceType, centerMm: face.centerMm, normal: face.normal })), edges: body.edges.map(compactEdge) }; }
function requireEmpty(state: any, label: string): void { requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0, `${label} is not empty`); requireCondition((state.groups ?? []).filter((group: { id: number }) => group.id !== 0).length === 0, `${label} contains non-root groups`); }
function stateSummary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, regionCount: state.regions.length }; }
function nearPoint(actual: unknown, expected: [number, number, number]): boolean { return Array.isArray(actual) && actual.length === 3 && actual.every((value, index) => nearValue(value, expected[index]!)); }
function nearValue(actual: unknown, expected: number, tolerance = LINEAR_TOLERANCE_MM): boolean { return typeof actual === "number" && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance; }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

async function startMcp(storeRoot: string): Promise<LiveMcp> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" }, stderr: "pipe" });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); });
  const client = new Client({ name: "plasticity-native-edge-edits-live", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> { const response = await client.callTool({ name, arguments: args }); const output = toolText(response); if ("isError" in response && response.isError) throw new Error(output); return JSON.parse(output); }
function toolText(response: unknown): string { if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content"); const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string"); if (!item) throw new Error("MCP tool returned no text content"); return item.text; }
async function recover(client: Client, initial: any): Promise<Record<string, unknown>> { for (let count = 0; count < 24; count += 1) { const status = await call(client, "plasticity_status", {}); if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" }; if (status.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: status.bodies.length === 0 && status.regions.length === 0 }; await call(client, "plasticity_undo", { intent: "Recover disposable native edge-edit acceptance", revision: status.revision }); } return { restoredEmptyDocument: false, reason: "undo-limit" }; }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
