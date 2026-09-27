#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LINEAR_TOLERANCE_MM = 0.01;

export interface NativeFacePatternAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parseNativeFacePatternAcceptanceArgs(argv: string[]): NativeFacePatternAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: NativeFacePatternAcceptanceOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live native-face-pattern acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native-face-pattern acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native-face-pattern acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-face-patterns-live.ts --help
  node scripts/verify-native-face-patterns-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode refuses a nonempty Plasticity document, repeats exact boss faces in
rectangular and radial native arrays, verifies exact B-Rep axes, topology,
volume, validation and Undo/Redo, then restores the empty document.`;

async function main(): Promise<void> {
  const options = parseNativeFacePatternAcceptanceArgs(process.argv.slice(2));
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
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-face-patterns-live-initial-empty" });

    let state = await createBossPlate(live.client, initialState, {
      name: "Rectangular face-pattern acceptance",
      originMm: [0, 0, 0],
      sizeMm: [60, 30, 5],
      bossCenterMm: [10, 15, 5],
    });
    const rectangularId = namedBody(state, "Rectangular face-pattern acceptance").id;
    let rectangular = bodyById(state, rectangularId);
    requireTopology(rectangular, 8, 14, "rectangular source");
    const rectangularSourceName = rectangular.name;
    const rectangularFaces = requireBossFaces(rectangular, [10, 15, 5], 10);
    const beforeRectangularDepth = state.undoDepth;
    state = await call(live.client, "plasticity_rectangular_face_pattern", {
      faces: rectangularFaces.map((face: any) => ({ bodyId: rectangularId, faceId: face.id })),
      direction1: [1, 0, 0], count1: 3, spacing1Mm: 15,
      direction2: [0, 1, 0], count2: 1, spacing2Mm: 0,
      intent: "Repeat one exact native boss in a three-place linear face array", revision: state.revision,
    });
    requireCondition(state.undoDepth === beforeRectangularDepth + 1, "Rectangular face pattern did not use one native history step");
    rectangular = bodyById(state, rectangularId);
    requireCondition(rectangular.name === rectangularSourceName, "Rectangular face pattern changed the body name");
    requireTopology(rectangular, 12, 18, "rectangular patterned body");
    const rectangularAxes = requireCylinderCenters(rectangular, [[10, 15, 5], [25, 15, 5], [40, 15, 5]]);
    const rectangularProperties = await exactProperties(live.client, rectangularId, state.revision, 9000 + 135 * Math.PI);
    state = await call(live.client, "plasticity_undo", { intent: "Verify rectangular face-pattern Undo", revision: state.revision });
    requireTopology(bodyById(state, rectangularId), 8, 14, "rectangular Undo body");
    requireCylinderCenters(bodyById(state, rectangularId), [[10, 15, 5]]);
    state = await call(live.client, "plasticity_redo", { intent: "Verify rectangular face-pattern Redo", revision: state.revision });
    requireTopology(bodyById(state, rectangularId), 12, 18, "rectangular Redo body");
    requireCylinderCenters(bodyById(state, rectangularId), [[10, 15, 5], [25, 15, 5], [40, 15, 5]]);
    evidence.rectangular = {
      bodyId: rectangularId,
      selectedFaceIds: rectangularFaces.map((face: any) => face.id),
      count1: 3, spacing1Mm: 15, count2: 1,
      exactCylinderAxesMm: rectangularAxes,
      topologyBefore: { faceCount: 8, edgeCount: 14 },
      topologyAfter: { faceCount: 12, edgeCount: 18 },
      exactProperties: rectangularProperties,
      stableBodyIdPreserved: true, bodyNamePreserved: true, oneHistoryStep: true, undoRedo: true,
    };

    state = await createBossPlate(live.client, state, {
      name: "Radial face-pattern acceptance",
      originMm: [0, 60, 0],
      sizeMm: [60, 60, 5],
      bossCenterMm: [45, 90, 5],
    });
    const radialId = namedBody(state, "Radial face-pattern acceptance").id;
    let radial = bodyById(state, radialId);
    requireTopology(radial, 8, 14, "radial source");
    const radialSourceName = radial.name;
    const radialFaces = requireBossFaces(radial, [45, 90, 5], 10);
    const beforeRadialDepth = state.undoDepth;
    state = await call(live.client, "plasticity_radial_face_pattern", {
      faces: radialFaces.map((face: any) => ({ bodyId: radialId, faceId: face.id })),
      centerMm: [30, 90, 0], axis: [0, 0, 1], count: 4, sweepDegrees: 360,
      intent: "Repeat one exact native boss four times around a Z axis", revision: state.revision,
    });
    requireCondition(state.undoDepth === beforeRadialDepth + 1, "Radial face pattern did not use one native history step");
    radial = bodyById(state, radialId);
    requireCondition(radial.name === radialSourceName, "Radial face pattern changed the body name");
    requireTopology(radial, 14, 20, "radial patterned body");
    const radialAxes = requireCylinderCenters(radial, [[45, 90, 5], [30, 105, 5], [15, 90, 5], [30, 75, 5]]);
    const radialProperties = await exactProperties(live.client, radialId, state.revision, 18000 + 180 * Math.PI);
    state = await call(live.client, "plasticity_undo", { intent: "Verify radial face-pattern Undo", revision: state.revision });
    requireTopology(bodyById(state, radialId), 8, 14, "radial Undo body");
    requireCylinderCenters(bodyById(state, radialId), [[45, 90, 5]]);
    state = await call(live.client, "plasticity_redo", { intent: "Verify radial face-pattern Redo", revision: state.revision });
    requireTopology(bodyById(state, radialId), 14, 20, "radial Redo body");
    requireCylinderCenters(bodyById(state, radialId), [[45, 90, 5], [30, 105, 5], [15, 90, 5], [30, 75, 5]]);
    evidence.radial = {
      bodyId: radialId,
      selectedFaceIds: radialFaces.map((face: any) => face.id),
      centerMm: [30, 90, 0], axis: [0, 0, 1], count: 4, sweepDegrees: 360,
      exactCylinderAxesMm: radialAxes,
      topologyBefore: { faceCount: 8, edgeCount: 14 },
      topologyAfter: { faceCount: 14, edgeCount: 20 },
      exactProperties: radialProperties,
      stableBodyIdPreserved: true, bodyNamePreserved: true, oneHistoryStep: true, undoRedo: true,
    };

    const validation = await call(live.client, "plasticity_validate_bodies", { ids: [rectangularId, radialId], revision: state.revision });
    requireCondition(validation.measurementSource === "native-brep", "Unexpected body-validation source");
    requireCondition(validation.bodies.length === 2 && validation.bodies.every((body: any) => body.nativeValid === true && body.printableSolid === true && body.nativeCheckCodes.length === 0), "A face-patterned Solid failed native validation");
    evidence.validation = validation;

    while (state.undoDepth > initialState.undoDepth) state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable native face-pattern acceptance", revision: state.revision });
    requireEmpty(state, "cleaned document");
    const journal = await call(live.client, "plasticity_construction_journal", {});
    requireCondition(journal.syncStatus === "in-sync" && !journal.entries.some((entry: { status: string }) => entry.status === "unknown"), "Construction journal is not clean after face-pattern acceptance");
    const changes = await call(live.client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(changes.diff), "Scene content differs from the initial empty snapshot after cleanup");
    evidence.cleanup = { restoredEmptyDocument: true, sceneContentsRestored: true, journalSyncStatus: journal.syncStatus, uncertainJournalEntries: 0 };
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

async function createBossPlate(client: Client, state: any, options: { name: string; originMm: [number, number, number]; sizeMm: [number, number, number]; bossCenterMm: [number, number, number] }): Promise<any> {
  let next = await call(client, "plasticity_create_box", {
    originMm: options.originMm, sizeMm: options.sizeMm, name: options.name,
    intent: `Create disposable source plate for ${options.name}`, revision: state.revision,
  });
  const plateId = namedBody(next, options.name).id;
  next = await call(client, "plasticity_create_cylinder", {
    centerMm: options.bossCenterMm, radiusMm: 3, heightMm: 5, axis: [0, 0, 1], name: `${options.name} source boss`,
    intent: `Create disposable source boss for ${options.name}`, revision: next.revision,
  });
  const bossId = namedBody(next, `${options.name} source boss`).id;
  next = await call(client, "plasticity_boolean", {
    targetIds: [plateId], toolIds: [bossId], operation: "union", keepTools: false,
    intent: `Join the source boss for ${options.name}`, revision: next.revision,
  });
  requireCondition(bodyById(next, plateId).name === options.name, `Boolean changed ${options.name} identity`);
  return next;
}

function requireBossFaces(body: any, axisOriginMm: [number, number, number], capZMm: number): any[] {
  const cylinder = body.faces.filter((face: any) => face.surfaceType === "Cylinder" && nearValue(face.radiusMm, 3) && vectorNearBoolean(face.axisOriginMm, axisOriginMm));
  const cap = body.faces.filter((face: any) => face.planar === true && face.normal?.[2] > 0.999 && nearValue(face.centerMm?.[0], axisOriginMm[0]) && nearValue(face.centerMm?.[1], axisOriginMm[1]) && nearValue(face.centerMm?.[2], capZMm));
  requireCondition(cylinder.length === 1 && cap.length === 1, `Expected one cylindrical boss wall and cap on body ${body.id}; found ${cylinder.length} and ${cap.length}`);
  return [cylinder[0], cap[0]];
}

function requireCylinderCenters(body: any, expected: Array<[number, number, number]>): number[][] {
  const faces = body.faces.filter((face: any) => face.surfaceType === "Cylinder" && nearValue(face.radiusMm, 3) && face.axisOriginMm);
  requireCondition(faces.length === expected.length, `Expected ${expected.length} radius-3 cylinder faces on body ${body.id}; found ${faces.length}`);
  for (const center of expected) requireCondition(faces.some((face: any) => vectorNearBoolean(face.axisOriginMm, center)), `Missing exact cylinder axis at [${center.join(", ")}] on body ${body.id}`);
  return faces.map((face: any) => face.axisOriginMm).sort(compareVectors);
}

async function exactProperties(client: Client, id: number, revision: string, expectedVolumeMm3: number): Promise<any> {
  const report = await call(client, "plasticity_measure_solid_properties", { ids: [id], revision });
  requireCondition(report.source === "native-brep-mass-properties" && report.bodies.length === 1 && report.bodies[0].id === id, "Exact solid-property evidence is unavailable");
  near(report.bodies[0].volumeMm3, expectedVolumeMm3, 1e-6, `solid ${id} volume`);
  requireCondition(report.bodies[0].nativeCheckCodes.length === 0, `Solid ${id} mass properties found native validation errors`);
  return report.bodies[0];
}

function namedBody(state: any, name: string): any { const bodies = state.bodies.filter((body: any) => body.name === name); requireCondition(bodies.length === 1, `Expected one body named ${name}; found ${bodies.length}`); return bodies[0]; }
function bodyById(state: any, id: number): any { const body = state.bodies.find((candidate: any) => candidate.id === id); requireCondition(body, `Missing body ${id}`); return body; }
function requireTopology(body: any, faceCount: number, edgeCount: number, label: string): void { requireCondition(body.faces.length === faceCount && body.edges.length === edgeCount, `${label}: expected ${faceCount} faces and ${edgeCount} edges; got ${body.faces.length} and ${body.edges.length}`); }
function requireEmpty(state: any, label: string): void { requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0, `${label} is not empty`); requireCondition((state.groups ?? []).filter((group: { id: number }) => group.id !== 0).length === 0, `${label} contains non-root groups`); }
function stateSummary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, regionCount: state.regions.length }; }
function vectorNearBoolean(actual: unknown, expected: [number, number, number], tolerance = LINEAR_TOLERANCE_MM): boolean { return Array.isArray(actual) && actual.length === 3 && actual.every((value, index) => typeof value === "number" && Math.abs(value - expected[index]!) <= tolerance); }
function nearValue(actual: unknown, expected: number, tolerance = LINEAR_TOLERANCE_MM): boolean { return typeof actual === "number" && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance; }
function near(actual: unknown, expected: number, tolerance: number, label: string): void { requireCondition(typeof actual === "number" && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${String(actual)}`); }
function compareVectors(first: number[], second: number[]): number { return first[0]! - second[0]! || first[1]! - second[1]! || first[2]! - second[2]!; }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

async function startMcp(storeRoot: string): Promise<LiveMcp> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" }, stderr: "pipe" });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); });
  const client = new Client({ name: "plasticity-native-face-patterns-live", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> { const response = await client.callTool({ name, arguments: args }); const output = toolText(response); if ("isError" in response && response.isError) throw new Error(output); return JSON.parse(output); }
function toolText(response: unknown): string { if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content"); const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string"); if (!item) throw new Error("MCP tool returned no text content"); return item.text; }
async function recover(client: Client, initial: any): Promise<Record<string, unknown>> { for (let count = 0; count < 24; count += 1) { const status = await call(client, "plasticity_status", {}); if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" }; if (status.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: status.bodies.length === 0 && status.regions.length === 0 }; await call(client, "plasticity_undo", { intent: "Recover disposable native face-pattern acceptance", revision: status.revision }); } return { restoredEmptyDocument: false, reason: "undo-limit" }; }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
