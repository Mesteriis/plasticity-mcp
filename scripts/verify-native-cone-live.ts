#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface NativeConeAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parseNativeConeAcceptanceArgs(argv: string[]): NativeConeAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: NativeConeAcceptanceOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live native-cone acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native-cone acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native-cone acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-cone-live.ts --help
  node scripts/verify-native-cone-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode refuses a nonempty Plasticity document, never chooses a window
automatically, creates and verifies a disposable exact conical frustum and its
planar development Sheet, exercises Undo/Redo, restores the empty scene, and
writes sanitized evidence.`;

async function main(): Promise<void> {
  const options = parseNativeConeAcceptanceArgs(process.argv.slice(2));
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
    requireEmptyDisposableScene(initialState);
    evidence.initial = stateSummary(initialState);
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-cone-live-initial-empty" });

    let state = initialState;
    const frustum = { bottomCenterMm: [40, 0, 0], bottomRadiusMm: 12, topRadiusMm: 6, heightMm: 18 };
    state = await call(live.client, "plasticity_create_cone", {
      ...frustum, axis: [0, 0, 1], radialDirection: [1, 0, 0], name: "Acceptance frustum",
      intent: "Approved disposable native frustum acceptance", revision: state.revision,
    });
    requireCondition(state.undoDepth === initialState.undoDepth + 1, "Frustum and profile did not occupy exactly one history step");
    const frustumProfile = requireNamedBody(state, "Acceptance frustum profile", "Wire");
    const frustumSolid = requireNamedBody(state, "Acceptance frustum", "Solid");
    requireSurfaceTypes(frustumSolid, { Cone: 1, Plane: 2 }, "conical frustum");
    const conicalFace = frustumSolid.faces.find((face: { surfaceType: string }) => face.surfaceType === "Cone");
    requireCondition(conicalFace, "Native conical face metadata is missing");
    vectorNear(conicalFace.axisOriginMm, frustum.bottomCenterMm, 0.000001, "cone axis origin");
    vectorNear(conicalFace.axisDirection, [0, 0, -1], 0.000001, "cone axis direction");
    near(conicalFace.coneSemiAngleRad, Math.atan((frustum.bottomRadiusMm - frustum.topRadiusMm) / frustum.heightMm), 0.000000001, "cone semi-angle in radians");
    near(conicalFace.coneBasisRadiusMm, frustum.bottomRadiusMm, 0.000001, "cone basis radius");
    const development = await call(live.client, "plasticity_analyze_cone_development", {
      face: { bodyId: frustumSolid.id, faceId: conicalFace.id },
      intent: "Verify exact conical frustum development parameters",
      revision: state.revision,
    });
    near(development.boundaryRadiusMm[0], frustum.topRadiusMm, 0.000001, "inner boundary radius");
    near(development.boundaryRadiusMm[1], frustum.bottomRadiusMm, 0.000001, "outer boundary radius");
    near(development.development.axialHeightMm, frustum.heightMm, 0.000001, "frustum axial height");
    near(development.development.innerRadiusMm, 18.973665961010276, 0.000001, "developed inner radius");
    near(development.development.outerRadiusMm, 37.94733192202055, 0.000001, "developed outer radius");
    near(development.development.includedAngleRad, 1.98691765315922, 0.000000001, "developed included angle");
    vectorNear(boundsSize(frustumSolid.boundsMm), [24, 24, 18], 0.000001, "exact frustum bounds");
    vectorNear(boundsCenter(frustumSolid.boundsMm), [40, 0, 9], 0.000001, "exact frustum bounds center");
    vectorNear(boundsSize(frustumProfile.boundsMm), [12, 0, 18], 0.000001, "editable frustum profile bounds");
    const frustumValidation = await call(live.client, "plasticity_validate_bodies", { ids: [frustumSolid.id], revision: state.revision });
    requireCondition(frustumValidation.bodies.length === 1 && frustumValidation.bodies[0].nativeValid && frustumValidation.bodies[0].printableSolid, "Frustum did not pass native closed-Solid validation");
    const frustumProperties = await call(live.client, "plasticity_measure_solid_properties", { ids: [frustumSolid.id], revision: state.revision });
    const expectedFrustumVolume = Math.PI * frustum.heightMm * (frustum.bottomRadiusMm ** 2 + frustum.bottomRadiusMm * frustum.topRadiusMm + frustum.topRadiusMm ** 2) / 3;
    near(frustumProperties.bodies[0].volumeMm3, expectedFrustumVolume, 1e-6, "frustum volume");

    const sheetDevelopment = await call(live.client, "plasticity_create_cone_development", {
      face: { bodyId: frustumSolid.id, faceId: conicalFace.id }, originMm: [100, 100, 0],
      intent: "Verify native cone development Sheet creation", revision: state.revision,
    });
    requireCondition(sheetDevelopment.historySteps === 6, "Cone development did not report six native history steps");
    requireCondition(sheetDevelopment.validation?.nativeValid === true, "Cone development Sheet failed native validation");
    near(sheetDevelopment.sheetAreaMm2, sheetDevelopment.sourceAreaMm2, Math.max(0.01, sheetDevelopment.sourceAreaMm2 * 1e-6), "developed Sheet area vs native source face area");
    const developmentState = await call(live.client, "plasticity_status", {});
    requireCondition(developmentState.undoDepth === state.undoDepth + 6, "Cone development did not create exactly six history steps");
    const developmentWire = developmentState.bodies.find((body: { id: number }) => body.id === sheetDevelopment.profileWireId);
    const developmentSheet = developmentState.bodies.find((body: { id: number }) => body.id === sheetDevelopment.sheetBodyId);
    requireCondition(developmentWire?.type === "Wire" && developmentSheet?.type === "Sheet", "Cone development did not leave the editable profile Wire and planar Sheet");
    requireCondition(developmentSheet.faces.length === 1 && developmentSheet.faces[0].planar && developmentSheet.faces[0].edgeIds.length === 4, "Cone development result is not a one-face planar four-edge Sheet");
    for (const source of [frustumProfile, frustumSolid]) {
      const present = developmentState.bodies.find((body: { id: number }) => body.id === source.id);
      requireCondition(JSON.stringify(present) === JSON.stringify(source), `Cone development modified source body ${source.id}`);
    }
    vectorNear(sheetDevelopment.originMm, [100, 100, 0], 0, "developed Sheet placement");
    const developmentCreated = stateSummary(developmentState);
    let developmentHistoryState = developmentState;
    for (let index = 0; index < 6; index += 1) {
      developmentHistoryState = await call(live.client, "plasticity_undo", { intent: `Verify cone development Undo ${index + 1}/6`, revision: developmentHistoryState.revision });
    }
    requireCondition(!developmentHistoryState.bodies.some((body: { id: number }) => body.id === sheetDevelopment.profileWireId || body.id === sheetDevelopment.sheetBodyId), "Six Undo steps did not remove the developed Wire and Sheet");
    requireCondition(developmentHistoryState.bodies.some((body: { id: number }) => body.id === frustumSolid.id) && developmentHistoryState.bodies.some((body: { id: number }) => body.id === frustumProfile.id), "Undoing the development also removed the source frustum");
    const developmentAfterUndo = stateSummary(developmentHistoryState);
    let developmentUndoState = developmentHistoryState;
    for (let index = 0; index < 6; index += 1) {
      developmentUndoState = await call(live.client, "plasticity_redo", { intent: `Verify cone development Redo ${index + 1}/6`, revision: developmentUndoState.revision });
    }
    const redoneDevelopmentWire = developmentUndoState.bodies.find((body: { id: number }) => body.id === sheetDevelopment.profileWireId);
    const redoneDevelopmentSheet = developmentUndoState.bodies.find((body: { id: number }) => body.id === sheetDevelopment.sheetBodyId);
    requireCondition(redoneDevelopmentWire?.type === "Wire" && redoneDevelopmentSheet?.type === "Sheet", "Six Redo steps did not restore the development Wire and Sheet");
    requireCondition(JSON.stringify(redoneDevelopmentSheet) === JSON.stringify(developmentSheet), "Redo did not restore the same stable development Sheet geometry");
    state = developmentUndoState;
    const afterReads = await call(live.client, "plasticity_status", {});
    requirePersistentStateEqual(state, afterReads);
    const readVerifiedState = stateSummary(state);
    evidence.geometry = {
      frustum: { ...frustum, profileBodyId: frustumProfile.id, solidBodyId: frustumSolid.id, boundsMm: frustumSolid.boundsMm, conicalFace, development, validation: frustumValidation.bodies[0], massProperties: frustumProperties.bodies[0] },
      coneDevelopmentSheet: { ...sheetDevelopment, created: developmentCreated, afterUndo: developmentAfterUndo, afterRedo: readVerifiedState, boundaryBodyTypes: [redoneDevelopmentWire.type, redoneDevelopmentSheet.type] },
      history: { oneStepForFrustum: true, sixStepsForDevelopment: true, developmentUndoRedoRestoredStableIds: true },
      readOnlyVerificationChangedDocument: false,
    };

    for (let index = 0; index < 6; index += 1) {
      state = await call(live.client, "plasticity_undo", { intent: `Cleanup disposable cone development step ${index + 1}/6`, revision: state.revision });
    }
    state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable native frustum acceptance", revision: state.revision });
    requireEmptyDisposableScene(state);
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

async function startMcp(storeRoot: string): Promise<LiveMcp> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(projectRoot, "scripts", "run-server.ts")],
    cwd: projectRoot,
    env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" },
    stderr: "pipe",
  });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); });
  const client = new Client({ name: "plasticity-native-cone-live", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await client.callTool({ name, arguments: args });
  const text = toolText(response);
  if ("isError" in response && response.isError) throw new Error(text);
  return JSON.parse(text);
}

function toolText(response: unknown): string {
  if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content");
  const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string");
  if (!item) throw new Error("MCP tool returned no text content");
  return item.text;
}

function requireEmptyDisposableScene(state: any): void {
  requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0, "Refusing disposable mutations in a nonempty Plasticity document");
  requireCondition((state.groups ?? []).filter((group: { id: number }) => group.id !== 0).length === 0, "Refusing disposable mutations while non-root Plasticity groups exist");
}

async function recover(client: Client, initial: any): Promise<Record<string, unknown>> {
  for (let count = 0; count < 16; count += 1) {
    const status = await call(client, "plasticity_status", {});
    if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" };
    if (status.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: status.bodies.length === 0 && status.regions.length === 0 };
    await call(client, "plasticity_undo", { intent: "Recover disposable native cone acceptance", revision: status.revision });
  }
  return { restoredEmptyDocument: false, reason: "undo-limit" };
}

function requirePersistentStateEqual(before: any, after: any): void {
  for (const field of ["documentToken", "revision", "undoDepth", "redoDepth"] as const) requireCondition(before[field] === after[field], `Read-only cone verification changed ${field}`);
  requireCondition(JSON.stringify(before.bodies) === JSON.stringify(after.bodies), "Read-only cone verification changed body identity or geometry");
}

function requireNamedBody(state: any, name: string, type: string): any {
  const matches = state.bodies.filter((candidate: { name: string | null; type: string }) => candidate.name === name && candidate.type === type);
  requireCondition(matches.length === 1, `Expected exactly one ${type} named ${name}, found ${matches.length}`);
  return matches[0];
}

function requireSurfaceTypes(body: any, expected: Record<string, number>, label: string): void {
  const actual = body.faces.reduce((counts: Record<string, number>, face: { surfaceType: string }) => {
    counts[face.surfaceType] = (counts[face.surfaceType] ?? 0) + 1;
    return counts;
  }, {});
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  requireCondition([...keys].every((key) => actual[key] === expected[key]), `${label} surface types: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function boundsSize(bounds: any): number[] { requireCondition(bounds?.min?.length === 3 && bounds?.max?.length === 3, "Native bounds are unavailable"); return bounds.max.map((value: number, index: number) => value - bounds.min[index]); }
function boundsCenter(bounds: any): number[] { requireCondition(bounds?.min?.length === 3 && bounds?.max?.length === 3, "Native bounds are unavailable"); return bounds.max.map((value: number, index: number) => (value + bounds.min[index]) / 2); }
function stateSummary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length }; }
function near(actual: number, expected: number, tolerance: number, label: string): void { requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`); }
function vectorNear(actual: unknown, expected: number[], tolerance: number, label: string): void { requireCondition(Array.isArray(actual) && actual.length === expected.length, `${label}: vector length mismatch`); actual.forEach((value, index) => near(value, expected[index]!, tolerance, `${label}[${index}]`)); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
