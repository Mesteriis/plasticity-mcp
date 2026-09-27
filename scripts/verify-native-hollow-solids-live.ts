#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOLERANCE_MM = 0.01;

export interface NativeHollowSolidsAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parseNativeHollowSolidsAcceptanceArgs(argv: string[]): NativeHollowSolidsAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: NativeHollowSolidsAcceptanceOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live native-hollow-solids acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native-hollow-solids acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native-hollow-solids acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-hollow-solids-live.ts --help
  node scripts/verify-native-hollow-solids-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode refuses a nonempty Plasticity document, never chooses a window
automatically, verifies exact inward closed and selected-face open hollows plus
their Undo/Redo behavior, cleans up with native Undo, and writes sanitized
evidence to a new directory.`;

async function main(): Promise<void> {
  const options = parseNativeHollowSolidsAcceptanceArgs(process.argv.slice(2));
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
    requireCondition(initialState.bodies.length === 0 && initialState.regions.length === 0 && (initialState.instances ?? []).length === 0, "Refusing disposable mutations in a nonempty Plasticity document");
    requireCondition((initialState.groups ?? []).filter((group: { id: number }) => group.id !== 0).length === 0, "Refusing disposable mutations while non-root Plasticity groups exist");
    evidence.initial = summary(initialState);
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-hollow-solids-live-initial-empty" });

    let state = await call(live.client, "plasticity_create_box", {
      originMm: [0, 0, 0], sizeMm: [100, 80, 40], name: "Closed hollow acceptance",
      intent: "Approved disposable closed-hollow acceptance", revision: initialState.revision,
    });
    const original = requireSingleSolid(state);
    const beforeProperties = await call(live.client, "plasticity_measure_solid_properties", { ids: [original.id], revision: state.revision });
    near(beforeProperties.bodies[0].volumeMm3, 320_000, TOLERANCE_MM, "original box volume");
    const beforeHollowUndoDepth = state.undoDepth;

    state = await call(live.client, "plasticity_hollow_solids", {
      ids: [original.id], wallThicknessMm: 2, direction: "inward",
      intent: "Create a fully enclosed inward 2 mm cavity", revision: state.revision,
    });
    requireCondition(state.undoDepth === beforeHollowUndoDepth + 1, "Closed hollowing did not use one native history step");
    const hollow = requireSingleSolid(state);
    requireBounds(hollow.boundsMm, [0, 0, 0], [100, 80, 40]);
    const hollowDetail = (await call(live.client, "plasticity_body_info", { id: hollow.id })).body;
    requireCondition(hollowDetail.faces.length === 12 && hollowDetail.edges.length === 24, `Expected 12 faces and 24 edges, found ${hollowDetail.faces.length} and ${hollowDetail.edges.length}`);

    const validation = await call(live.client, "plasticity_validate_bodies", { ids: [hollow.id], revision: state.revision });
    const validated = validation.bodies[0];
    requireCondition(validated.nativeValid === true && validated.closed === true && validated.printableSolid === true, "Closed hollow did not remain a valid closed native Solid");
    const properties = await call(live.client, "plasticity_measure_solid_properties", { ids: [hollow.id], revision: state.revision });
    const measured = properties.bodies[0];
    near(measured.volumeMm3, 57_344, TOLERANCE_MM, "closed-shell material volume");
    near(measured.surfaceAreaMm2, 57_376, TOLERANCE_MM, "closed-shell surface area");
    [50, 40, 20].forEach((expected, axis) => near(measured.volumeCentroidMm[axis], expected, TOLERANCE_MM, `centroid axis ${axis}`));

    const cavityDimensionsMm: number[] = [];
    const wallThicknessesMm: number[] = [];
    for (const [axis, positions] of [[0, [0, 2, 98, 100]], [1, [0, 2, 78, 80]], [2, [0, 2, 38, 40]]] as const) {
      const faces = positions.map((position) => requirePlanarFaceAt(hollowDetail, axis, position));
      const cavity = await measureFaces(live.client, hollow.id, faces[1].id, faces[2].id, state.revision);
      const firstWall = await measureFaces(live.client, hollow.id, faces[0].id, faces[1].id, state.revision);
      const secondWall = await measureFaces(live.client, hollow.id, faces[2].id, faces[3].id, state.revision);
      const expectedCavity = positions[2] - positions[1];
      near(cavity.separationMm, expectedCavity, TOLERANCE_MM, `cavity axis ${axis}`);
      near(firstWall.separationMm, 2, TOLERANCE_MM, `first wall axis ${axis}`);
      near(secondWall.separationMm, 2, TOLERANCE_MM, `second wall axis ${axis}`);
      cavityDimensionsMm.push(cavity.separationMm);
      wallThicknessesMm.push(firstWall.separationMm, secondWall.separationMm);
    }

    state = await call(live.client, "plasticity_undo", { intent: "Verify closed-hollow Undo", revision: state.revision });
    const undone = requireSingleSolid(state);
    const undoneDetail = (await call(live.client, "plasticity_body_info", { id: undone.id })).body;
    requireCondition(undoneDetail.faces.length === 6 && undoneDetail.edges.length === 12, "Closed-hollow Undo did not restore the six-face box");
    const undoneProperties = await call(live.client, "plasticity_measure_solid_properties", { ids: [undone.id], revision: state.revision });
    near(undoneProperties.bodies[0].volumeMm3, 320_000, TOLERANCE_MM, "Undo box volume");

    state = await call(live.client, "plasticity_redo", { intent: "Verify closed-hollow Redo", revision: state.revision });
    const redone = requireSingleSolid(state);
    const redoneDetail = (await call(live.client, "plasticity_body_info", { id: redone.id })).body;
    requireCondition(redoneDetail.faces.length === 12 && redoneDetail.edges.length === 24, "Closed-hollow Redo did not restore the twelve-face shell");

    evidence.closedHollow = {
      direction: "inward",
      wallThicknessMm: 2,
      originalBoundsMm: original.boundsMm,
      hollowBoundsMm: hollow.boundsMm,
      cavityDimensionsMm,
      measuredWallThicknessesMm: wallThicknessesMm,
      materialVolumeMm3: measured.volumeMm3,
      surfaceAreaMm2: measured.surfaceAreaMm2,
      centroidMm: measured.volumeCentroidMm,
      faceCount: hollowDetail.faces.length,
      edgeCount: hollowDetail.edges.length,
      nativeValid: validated.nativeValid,
      closed: validated.closed,
      printableSolid: validated.printableSolid,
      oneHistoryStep: true,
    };
    evidence.undoRedo = { undoRestoredSolidBox: true, redoRestoredClosedShell: true };

    while (state.undoDepth > initialState.undoDepth) {
      state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable closed-hollow acceptance", revision: state.revision });
    }
    requireCondition(state.bodies.length === 0 && state.regions.length === 0, "Cleanup did not restore the empty document");

    state = await call(live.client, "plasticity_create_box", {
      originMm: [0, 0, 0], sizeMm: [40, 30, 20], name: "Open hollow acceptance",
      intent: "Approved disposable open-hollow acceptance", revision: state.revision,
    });
    const openBox = requireSingleSolid(state);
    const openBoxDetail = (await call(live.client, "plasticity_body_info", { id: openBox.id })).body;
    const topFaces = openBoxDetail.faces.filter((face: any) => face.planar === true
      && Math.abs(face.centerMm[2] - 20) <= TOLERANCE_MM && face.normal[2] > 0.999);
    requireCondition(topFaces.length === 1, `Expected one upward planar top face, found ${topFaces.length}`);
    const beforeOpenHollowUndoDepth = state.undoDepth;

    state = await call(live.client, "plasticity_hollow_faces", {
      id: openBox.id, faceIds: [topFaces[0].id], wallThicknessMm: 2, direction: "inward",
      intent: "Create an open enclosure with a measured 2 mm wall", revision: state.revision,
    });
    requireCondition(state.undoDepth === beforeOpenHollowUndoDepth + 1, "Open-face hollowing did not use one native history step");
    const openHollow = requireSingleSolid(state);
    requireBounds(openHollow.boundsMm, [0, 0, 0], [40, 30, 20]);
    const openHollowDetail = (await call(live.client, "plasticity_body_info", { id: openHollow.id })).body;
    requireCondition(openHollowDetail.faces.length === 11 && openHollowDetail.edges.length === 24,
      `Expected 11 faces and 24 edges on the open enclosure, found ${openHollowDetail.faces.length} and ${openHollowDetail.edges.length}`);
    const openValidation = await call(live.client, "plasticity_validate_bodies", { ids: [openHollow.id], revision: state.revision });
    const validatedOpenHollow = openValidation.bodies[0];
    requireCondition(validatedOpenHollow.nativeValid === true && validatedOpenHollow.closed === true && validatedOpenHollow.printableSolid === true,
      "Open enclosure did not remain a valid closed native Solid");
    const openProperties = await call(live.client, "plasticity_measure_solid_properties", { ids: [openHollow.id], revision: state.revision });
    const openMeasured = openProperties.bodies[0];
    near(openMeasured.volumeMm3, 7_152, TOLERANCE_MM, "open-enclosure material volume");

    const openFaceProperties = await call(live.client, "plasticity_measure_face_properties", {
      faces: openHollowDetail.faces.map((face: any) => ({ bodyId: openHollow.id, faceId: face.id })), revision: state.revision,
    });
    requireCondition(openFaceProperties.source === "native-brep-face-mass-properties", "Expected native face properties for the open enclosure");
    const openingRim = openFaceProperties.faces.find((face: any) => face.planar === true && face.innerLoopCount === 1
      && Math.abs(face.areaMm2 - 264) <= TOLERANCE_MM);
    requireCondition(openingRim, "The removed top face was not replaced by a single planar rim around an open inner loop");

    const innerXLow = requirePlanarFaceAt(openHollowDetail, 0, 2);
    const innerXHigh = requirePlanarFaceAt(openHollowDetail, 0, 38);
    const innerYLow = requirePlanarFaceAt(openHollowDetail, 1, 2);
    const innerYHigh = requirePlanarFaceAt(openHollowDetail, 1, 28);
    const outerXLow = requirePlanarFaceAt(openHollowDetail, 0, 0);
    const outerXHigh = requirePlanarFaceAt(openHollowDetail, 0, 40);
    const outerYLow = requirePlanarFaceAt(openHollowDetail, 1, 0);
    const outerYHigh = requirePlanarFaceAt(openHollowDetail, 1, 30);
    const innerFloor = requirePlanarFaceAt(openHollowDetail, 2, 2);
    const outerFloor = requirePlanarFaceAt(openHollowDetail, 2, 0);
    const openingTop = requirePlanarFaceAt(openHollowDetail, 2, 20);
    const openMeasurements = {
      cavityWidthMm: await measureFaces(live.client, openHollow.id, innerXLow.id, innerXHigh.id, state.revision),
      cavityLengthMm: await measureFaces(live.client, openHollow.id, innerYLow.id, innerYHigh.id, state.revision),
      cavityDepthMm: await measureFaces(live.client, openHollow.id, innerFloor.id, openingTop.id, state.revision),
      wallXLowMm: await measureFaces(live.client, openHollow.id, outerXLow.id, innerXLow.id, state.revision),
      wallXHighMm: await measureFaces(live.client, openHollow.id, innerXHigh.id, outerXHigh.id, state.revision),
      wallYLowMm: await measureFaces(live.client, openHollow.id, outerYLow.id, innerYLow.id, state.revision),
      wallYHighMm: await measureFaces(live.client, openHollow.id, innerYHigh.id, outerYHigh.id, state.revision),
      bottomWallMm: await measureFaces(live.client, openHollow.id, outerFloor.id, innerFloor.id, state.revision),
    };
    near(openMeasurements.cavityWidthMm.separationMm, 36, TOLERANCE_MM, "open-enclosure cavity width");
    near(openMeasurements.cavityLengthMm.separationMm, 26, TOLERANCE_MM, "open-enclosure cavity length");
    near(openMeasurements.cavityDepthMm.separationMm, 18, TOLERANCE_MM, "open-enclosure cavity depth");
    for (const [name, measurement] of Object.entries(openMeasurements).filter(([name]) => name.startsWith("wall"))) {
      near(measurement.separationMm, 2, TOLERANCE_MM, `open-enclosure ${name}`);
    }
    near(openMeasurements.bottomWallMm.separationMm, 2, TOLERANCE_MM, "open-enclosure bottom wall");

    state = await call(live.client, "plasticity_undo", { intent: "Verify open-hollow Undo", revision: state.revision });
    const undoneOpenHollow = requireSingleSolid(state);
    const undoneOpenHollowDetail = (await call(live.client, "plasticity_body_info", { id: undoneOpenHollow.id })).body;
    requireCondition(undoneOpenHollow.id === openBox.id && undoneOpenHollowDetail.faces.length === 6 && undoneOpenHollowDetail.edges.length === 12,
      "Open-hollow Undo did not restore the original six-face box");
    const undoneOpenProperties = await call(live.client, "plasticity_measure_solid_properties", { ids: [undoneOpenHollow.id], revision: state.revision });
    near(undoneOpenProperties.bodies[0].volumeMm3, 24_000, TOLERANCE_MM, "open-hollow Undo box volume");

    state = await call(live.client, "plasticity_redo", { intent: "Verify open-hollow Redo", revision: state.revision });
    const redoneOpenHollow = requireSingleSolid(state);
    const redoneOpenHollowDetail = (await call(live.client, "plasticity_body_info", { id: redoneOpenHollow.id })).body;
    requireCondition(redoneOpenHollow.id === openHollow.id && redoneOpenHollowDetail.faces.length === 11 && redoneOpenHollowDetail.edges.length === 24,
      "Open-hollow Redo did not restore the open enclosure topology");
    const redoneOpenProperties = await call(live.client, "plasticity_measure_solid_properties", { ids: [redoneOpenHollow.id], revision: state.revision });
    near(redoneOpenProperties.bodies[0].volumeMm3, openMeasured.volumeMm3, TOLERANCE_MM, "open-hollow Redo material volume");
    evidence.openFaceHollow = {
      direction: "inward", wallThicknessMm: 2, selectedFaceId: topFaces[0].id,
      outerBoundsMm: openHollow.boundsMm, cavityDimensionsMm: [36, 26, 18],
      measuredWallThicknessesMm: [2, 2, 2, 2, 2], materialVolumeMm3: openMeasured.volumeMm3,
      openingRimAreaMm2: openingRim.areaMm2, openingRimInnerLoops: openingRim.innerLoopCount,
      faceCount: openHollowDetail.faces.length, edgeCount: openHollowDetail.edges.length,
      nativeValid: validatedOpenHollow.nativeValid, closed: validatedOpenHollow.closed,
      printableSolid: validatedOpenHollow.printableSolid, oneHistoryStep: true,
    };
    evidence.openFaceUndoRedo = { undoRestoredOriginalBox: true, redoRestoredOpenEnclosure: true };

    while (state.undoDepth > initialState.undoDepth) {
      state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable open-hollow acceptance", revision: state.revision });
    }
    requireCondition(state.bodies.length === 0 && state.regions.length === 0, "Open-hollow cleanup did not restore the empty document");
    const journal = await call(live.client, "plasticity_construction_journal", {});
    requireCondition(journal.syncStatus === "in-sync" && !journal.entries.some((entry: { status: string }) => entry.status === "unknown"), "Construction journal is not clean after hollow acceptance");
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

function requireSingleSolid(state: any): any {
  const solids = state.bodies.filter((body: { type: string }) => body.type === "Solid");
  requireCondition(solids.length === 1 && state.bodies.length === 1, `Expected one native Solid, found ${state.bodies.length} bodies and ${solids.length} Solids`);
  return solids[0];
}

function requirePlanarFaceAt(body: any, axis: number, positionMm: number): any {
  const faces = body.faces.filter((face: any) => face.planar === true && Math.abs(face.centerMm[axis] - positionMm) <= TOLERANCE_MM && Math.abs(Math.abs(face.normal[axis]) - 1) <= 1e-6);
  requireCondition(faces.length === 1, `Expected one planar face at axis ${axis}, position ${positionMm}; found ${faces.length}`);
  return faces[0];
}

async function measureFaces(client: Client, bodyId: number, firstFaceId: string, secondFaceId: string, revision: string): Promise<any> {
  const result = await call(client, "plasticity_measure_planar_faces", {
    first: { bodyId, faceId: firstFaceId }, second: { bodyId, faceId: secondFaceId }, revision,
  });
  requireCondition(result.measurementSource === "native-brep" && result.parallel === true, "Expected an exact parallel native face measurement");
  return result;
}

function requireBounds(bounds: any, min: number[], max: number[]): void {
  requireCondition(bounds && Array.isArray(bounds.min) && Array.isArray(bounds.max), "Solid bounds are unavailable");
  min.forEach((expected, axis) => near(bounds.min[axis], expected, TOLERANCE_MM, `minimum bound axis ${axis}`));
  max.forEach((expected, axis) => near(bounds.max[axis], expected, TOLERANCE_MM, `maximum bound axis ${axis}`));
}

async function startMcp(storeRoot: string): Promise<LiveMcp> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" }, stderr: "pipe" });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); });
  const client = new Client({ name: "plasticity-native-hollow-solids-live", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await client.callTool({ name, arguments: args });
  const item = (response.content as Array<{ type: string; text?: string }>).find((entry) => entry.type === "text" && typeof entry.text === "string");
  if (!item?.text) throw new Error("MCP tool returned no text content");
  if (response.isError) throw new Error(item.text);
  return JSON.parse(item.text);
}

async function recover(client: Client, initial: any): Promise<Record<string, unknown>> {
  for (let count = 0; count < 16; count += 1) {
    const status = await call(client, "plasticity_status", {});
    if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" };
    if (status.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: status.bodies.length === 0 && status.regions.length === 0 };
    await call(client, "plasticity_undo", { intent: "Recover disposable closed-hollow acceptance", revision: status.revision });
  }
  return { restoredEmptyDocument: false, reason: "undo-limit" };
}

function summary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, regionCount: state.regions.length }; }
function near(actual: number, expected: number, tolerance: number, label: string): void { requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
