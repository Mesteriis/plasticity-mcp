#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LINEAR_TOLERANCE_MM = 0.01;
const ANGULAR_TOLERANCE_DEG = 0.001;

export interface NativeFaceTransformAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parseNativeFaceTransformAcceptanceArgs(argv: string[]): NativeFaceTransformAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: NativeFaceTransformAcceptanceOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live native-face-transform acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native-face-transform acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native-face-transform acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-face-transforms-live.ts --help
  node scripts/verify-native-face-transforms-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode refuses a nonempty Plasticity document, moves and rotates exact planar
faces, scales an exact cylindrical face, checks native B-Rep measurements and
validity, exercises Undo/Redo, cleans up, and writes bounded evidence.`;

async function main(): Promise<void> {
  const options = parseNativeFaceTransformAcceptanceArgs(process.argv.slice(2));
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
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-face-transforms-live-initial-empty" });

    let state = await call(live.client, "plasticity_create_box", {
      originMm: [0, 0, 0], sizeMm: [20, 10, 10], name: "Face move acceptance",
      intent: "Create disposable native face-move source", revision: initialState.revision,
    });
    const movedBodyId = onlyNamedBody(state, "Face move acceptance").id;
    const moveTop = requirePlanarFace(onlyBody(state, movedBodyId), (face) => face.normal[2] > 0.999 && nearValue(face.centerMm[2], 10));
    const beforeMoveDepth = state.undoDepth;
    state = await call(live.client, "plasticity_move_faces", {
      faces: [{ bodyId: movedBodyId, faceId: moveTop.id }], deltaMm: [0, 0, 5],
      intent: "Move disposable top face by an exact native delta", revision: state.revision,
    });
    requireCondition(state.undoDepth === beforeMoveDepth + 1, "Face move did not create exactly one history step");
    const moved = onlyBody(state, movedBodyId);
    const movedTop = requirePlanarFace(moved, (face) => face.normal[2] > 0.999 && nearValue(face.centerMm[2], 15));
    const movedBottom = requirePlanarFace(moved, (face) => face.normal[2] < -0.999 && nearValue(face.centerMm[2], 0));
    const movedHeight = await measureFaces(live.client, movedBodyId, movedBottom.id, movedTop.id, state.revision);
    near(movedHeight.separationMm, 15, LINEAR_TOLERANCE_MM, "moved box height");
    const movedFinal = compactBody(moved);
    state = await call(live.client, "plasticity_undo", { intent: "Verify native face move Undo", revision: state.revision });
    await requirePlanarSeparation(live.client, state, movedBodyId, 10);
    state = await call(live.client, "plasticity_redo", { intent: "Verify native face move Redo", revision: state.revision });
    await requirePlanarSeparation(live.client, state, movedBodyId, 15);
    evidence.move = { bodyId: movedBodyId, deltaMm: [0, 0, 5], exactHeightMm: movedHeight.separationMm, after: movedFinal, oneHistoryStep: true, undoRedo: true };

    state = await call(live.client, "plasticity_create_box", {
      originMm: [40, 0, 0], sizeMm: [20, 10, 10], name: "Face rotate acceptance",
      intent: "Create disposable native face-rotation source", revision: state.revision,
    });
    const rotatedBodyId = onlyNamedBody(state, "Face rotate acceptance").id;
    const rotateTop = requirePlanarFace(onlyBody(state, rotatedBodyId), (face) => face.normal[2] > 0.999 && nearValue(face.centerMm[2], 10));
    const beforeRotateDepth = state.undoDepth;
    state = await call(live.client, "plasticity_rotate_faces", {
      faces: [{ bodyId: rotatedBodyId, faceId: rotateTop.id }], pivotMm: [40, 0, 10], axis: [0, 1, 0], degrees: -10,
      intent: "Rotate disposable top face around an exact world axis", revision: state.revision,
    });
    requireCondition(state.undoDepth === beforeRotateDepth + 1, "Face rotation did not create exactly one history step");
    const rotated = onlyBody(state, rotatedBodyId);
    const rotatedTop = requirePlanarFace(rotated, (face) => face.normal[2] > 0.9 && Math.abs(face.normal[0]) > 0.1);
    const rotatedBottom = requirePlanarFace(rotated, (face) => face.normal[2] < -0.999);
    const rotatedAngle = await measureFaces(live.client, rotatedBodyId, rotatedBottom.id, rotatedTop.id, state.revision);
    near(rotatedAngle.planeAngleDeg, 10, ANGULAR_TOLERANCE_DEG, "rotated face plane angle");
    near(Math.abs(rotatedTop.normal[0]), Math.sin(Math.PI / 18), 1e-6, "rotated face normal X magnitude");
    near(rotatedTop.normal[2], Math.cos(Math.PI / 18), 1e-6, "rotated face normal Z");
    const rotatedFinal = compactBody(rotated);
    state = await call(live.client, "plasticity_undo", { intent: "Verify native face rotation Undo", revision: state.revision });
    await requirePlanarSeparation(live.client, state, rotatedBodyId, 10);
    state = await call(live.client, "plasticity_redo", { intent: "Verify native face rotation Redo", revision: state.revision });
    const redoneRotated = onlyBody(state, rotatedBodyId);
    const redoneTop = requirePlanarFace(redoneRotated, (face) => face.normal[2] > 0.9 && Math.abs(face.normal[0]) > 0.1);
    const redoneBottom = requirePlanarFace(redoneRotated, (face) => face.normal[2] < -0.999);
    near((await measureFaces(live.client, rotatedBodyId, redoneBottom.id, redoneTop.id, state.revision)).planeAngleDeg, 10, ANGULAR_TOLERANCE_DEG, "redone face angle");
    evidence.rotate = { bodyId: rotatedBodyId, pivotMm: [40, 0, 10], axis: [0, 1, 0], degrees: -10, exactPlaneAngleDeg: rotatedAngle.planeAngleDeg, exactNormal: rotatedTop.normal, after: rotatedFinal, oneHistoryStep: true, undoRedo: true };

    state = await call(live.client, "plasticity_create_cylinder", {
      centerMm: [90, 0, 0], radiusMm: 5, heightMm: 10, axis: [0, 0, 1], name: "Face scale acceptance",
      intent: "Create disposable native face-scale source", revision: state.revision,
    });
    const scaledBodyId = onlyNamedBody(state, "Face scale acceptance").id;
    const scaleSide = requireCylinderFace(onlyBody(state, scaledBodyId), 5);
    const beforeScaleDepth = state.undoDepth;
    state = await call(live.client, "plasticity_scale_faces", {
      faces: [{ bodyId: scaledBodyId, faceId: scaleSide.id }], pivotMm: [90, 0, 0], factors: [2, 2, 1],
      intent: "Scale disposable native cylindrical face in world XY", revision: state.revision,
    });
    requireCondition(state.undoDepth === beforeScaleDepth + 1, "Face scale did not create exactly one history step");
    const scaled = onlyBody(state, scaledBodyId);
    const scaledSide = requireCylinderFace(scaled, 10);
    const scaledFinal = compactBody(scaled);
    state = await call(live.client, "plasticity_undo", { intent: "Verify native face scale Undo", revision: state.revision });
    requireCylinderFace(onlyBody(state, scaledBodyId), 5);
    state = await call(live.client, "plasticity_redo", { intent: "Verify native face scale Redo", revision: state.revision });
    requireCylinderFace(onlyBody(state, scaledBodyId), 10);
    evidence.scale = { bodyId: scaledBodyId, pivotMm: [90, 0, 0], factors: [2, 2, 1], exactRadiusMm: scaledSide.radiusMm, after: scaledFinal, oneHistoryStep: true, undoRedo: true };

    const validation = await call(live.client, "plasticity_validate_bodies", { ids: [movedBodyId, rotatedBodyId, scaledBodyId], revision: state.revision });
    requireCondition(validation.measurementSource === "native-brep", "Unexpected body validation source");
    requireCondition(validation.bodies.length === 3 && validation.bodies.every((body: any) => body.type === "Solid" && body.nativeValid === true && body.printableSolid === true && body.nativeCheckCodes.length === 0), "A face-transformed body failed native validation");
    requireCondition(state.undoDepth === initialState.undoDepth + 6, "Three sources plus three face transforms did not create six history steps");
    evidence.validation = validation;

    while (state.undoDepth > initialState.undoDepth) state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable native face-transform acceptance", revision: state.revision });
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

function onlyNamedBody(state: any, name: string): any { const bodies = state.bodies.filter((body: any) => body.name === name); requireCondition(bodies.length === 1, `Expected exactly one body named ${name}`); return bodies[0]; }
function onlyBody(state: any, id: number): any { const body = state.bodies.find((candidate: any) => candidate.id === id); requireCondition(body, `Missing body ${id}`); return body; }
function requirePlanarFace(body: any, predicate: (face: any) => boolean): any { const faces = body.faces.filter((face: any) => face.planar === true && predicate(face)); requireCondition(faces.length === 1, `Expected one matching planar face on body ${body.id}; found ${faces.length}`); return faces[0]; }
function requireCylinderFace(body: any, radiusMm: number): any { const faces = body.faces.filter((face: any) => face.surfaceType === "Cylinder" && nearValue(face.radiusMm, radiusMm)); requireCondition(faces.length === 1, `Expected one radius ${radiusMm} mm Cylinder face on body ${body.id}; found ${faces.length}`); return faces[0]; }
async function requirePlanarSeparation(client: Client, state: any, bodyId: number, expectedMm: number): Promise<void> { const body = onlyBody(state, bodyId); const top = requirePlanarFace(body, (face) => face.normal[2] > 0.999); const bottom = requirePlanarFace(body, (face) => face.normal[2] < -0.999); near((await measureFaces(client, bodyId, bottom.id, top.id, state.revision)).separationMm, expectedMm, LINEAR_TOLERANCE_MM, `body ${bodyId} planar separation`); }
async function measureFaces(client: Client, bodyId: number, firstFaceId: string, secondFaceId: string, revision: string): Promise<any> { const result = await call(client, "plasticity_measure_planar_faces", { first: { bodyId, faceId: firstFaceId }, second: { bodyId, faceId: secondFaceId }, revision }); requireCondition(result.measurementSource === "native-brep", "Expected exact native planar-face evidence"); return result; }
function compactBody(body: any): Record<string, unknown> { return { id: body.id, versionId: body.versionId, type: body.type, faceCount: body.faces.length, edgeCount: body.edges.length, faces: body.faces.map((face: any) => ({ id: face.id, surfaceType: face.surfaceType, centerMm: face.centerMm, normal: face.normal, radiusMm: face.radiusMm })), edges: body.edges.map((edge: any) => ({ id: edge.id, curveType: edge.curveType, lengthMm: edge.lengthMm })) }; }
function requireEmpty(state: any, label: string): void { requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0, `${label} is not empty`); requireCondition((state.groups ?? []).filter((group: { id: number }) => group.id !== 0).length === 0, `${label} contains non-root groups`); }
function stateSummary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, regionCount: state.regions.length }; }
function nearValue(actual: number | null, expected: number): boolean { return typeof actual === "number" && Number.isFinite(actual) && Math.abs(actual - expected) <= LINEAR_TOLERANCE_MM; }
function near(actual: number, expected: number, tolerance: number, label: string): void { requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

async function startMcp(storeRoot: string): Promise<LiveMcp> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" }, stderr: "pipe" });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); });
  const client = new Client({ name: "plasticity-native-face-transforms-live", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> { const response = await client.callTool({ name, arguments: args }); const output = toolText(response); if ("isError" in response && response.isError) throw new Error(output); return JSON.parse(output); }
function toolText(response: unknown): string { if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content"); const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string"); if (!item) throw new Error("MCP tool returned no text content"); return item.text; }
async function recover(client: Client, initial: any): Promise<Record<string, unknown>> { for (let count = 0; count < 24; count += 1) { const status = await call(client, "plasticity_status", {}); if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" }; if (status.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: status.bodies.length === 0 && status.regions.length === 0 }; await call(client, "plasticity_undo", { intent: "Recover disposable native face-transform acceptance", revision: status.revision }); } return { restoredEmptyDocument: false, reason: "undo-limit" }; }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
