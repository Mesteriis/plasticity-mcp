#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface SplitSolidAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client }

export function parseSplitSolidAcceptanceArgs(argv: string[]): SplitSolidAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: SplitSolidAcceptanceOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live split acceptance requires --target with an explicit Plasticity window ID");
  if (!options.allowDisposableMutations) throw new Error("Live split acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live split acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-split-solid-live.ts --help
  node scripts/verify-split-solid-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode refuses a nonempty document, creates and splits one disposable box through
the public MCP tools, checks exact bounds and native volume, exercises Undo/Redo,
adds a clearance-matched tongue-and-groove joint between the pieces, validates
the fit and native Solids, validates a paired M5 screw/heat-set-insert recipe,
then exercises a two-plane four-part grid. It finishes with Undo/Redo, restores
the original empty scene, and writes sanitized evidence. Insert pocket dimensions
in the screw/insert scenario are synthetic acceptance-fixture values only.`;

async function main(): Promise<void> {
  const options = parseSplitSolidAcceptanceArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const evidence: Record<string, unknown> = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    targetId: options.target!,
    operation: "plasticity_split_solid_by_plane",
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
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "split-solid-live-initial-empty" });

    let state = await call(live.client, "plasticity_create_box", {
      originMm: [0, 0, 0], sizeMm: [20, 20, 20], name: "Disposable split acceptance box",
      intent: "Create a synthetic disposable Solid to validate one exact print split", revision: initialState.revision,
    });
    requireCondition(state.bodies.length === 1 && state.bodies[0].type === "Solid", "Disposable source box was not created as one Solid");
    const source = state.bodies[0];
    const sourceProperties = await call(live.client, "plasticity_measure_solid_properties", { ids: [source.id], revision: state.revision });
    near(sourceProperties.bodies[0]?.volumeMm3, 8_000, 0.01, "source volume");
    evidence.source = { id: source.id, boundsMm: source.boundsMm, volumeMm3: sourceProperties.bodies[0].volumeMm3 };

    const split = await call(live.client, "plasticity_split_solid_by_plane", {
      targetId: source.id,
      originMm: [10, 0, 0], normal: [1, 0, 0], xDirection: [0, 1, 0],
      intent: "Split the disposable box into two equal native parts for print-fit acceptance",
      revision: state.revision,
    });
    requireCondition(split.recipe === "split-solid-by-plane" && split.status === "completed", "MCP split recipe did not complete");
    requireCondition(split.resultBodyIds.length === 2, "Split recipe did not return exactly two result bodies");
    near(split.inputVolumeMm3, 8_000, 0.01, "reported source volume");
    near(split.resultVolumeMm3, 8_000, 0.01, "reported result volume");
    requireCondition(split.volumeDifferenceMm3 <= 0.01, "Split recipe reports a volume-conservation error");
    requireCondition(split.temporaryBodyIds.length === 2, "Split recipe did not record both temporary cutter bodies");
    state = await call(live.client, "plasticity_status", {});
    const parts = split.resultBodyIds.map((id: number) => state.bodies.find((body: any) => body.id === id));
    requireCondition(parts.every((body: any) => body?.type === "Solid"), "One or more split results are not native Solids");
    const ordered = parts.sort((left: any, right: any) => left.boundsMm.min[0] - right.boundsMm.min[0]);
    vectorNear(ordered[0].boundsMm.min, [0, 0, 0], 0.01, "left part minimum");
    vectorNear(ordered[0].boundsMm.max, [10, 20, 20], 0.01, "left part maximum");
    vectorNear(ordered[1].boundsMm.min, [10, 0, 0], 0.01, "right part minimum");
    vectorNear(ordered[1].boundsMm.max, [20, 20, 20], 0.01, "right part maximum");
    const validation = await call(live.client, "plasticity_validate_bodies", { ids: split.resultBodyIds, revision: state.revision });
    requireCondition(validation.bodies.length === 2 && validation.bodies.every((body: any) => body.nativeValid && body.printableSolid && body.nativeCheckCodes.length === 0), "One or more split pieces failed native Solid validation");
    evidence.split = {
      resultBodyIds: split.resultBodyIds,
      cutPlane: split.cutPlane,
      cutterSizeMm: split.cutterSizeMm,
      cutterMarginMm: split.cutterMarginMm,
      resultBoundsMm: ordered.map((body: any) => body.boundsMm),
      inputVolumeMm3: split.inputVolumeMm3,
      resultVolumeMm3: split.resultVolumeMm3,
      volumeDifferenceMm3: split.volumeDifferenceMm3,
      temporaryBodyIds: split.temporaryBodyIds,
      undoSteps: split.undoSteps,
      validation: validation.bodies,
    };

    for (let count = 0; count < split.undoSteps; count += 1) {
      state = await call(live.client, "plasticity_undo", { intent: "Verify native split Undo", revision: state.revision });
    }
    requireCondition(state.bodies.length === 1 && state.bodies[0].id === source.id && state.bodies[0].type === "Solid", "Four Undo steps did not restore the source box");
    vectorNear(state.bodies[0].boundsMm.min, [0, 0, 0], 0.01, "undo source minimum");
    vectorNear(state.bodies[0].boundsMm.max, [20, 20, 20], 0.01, "undo source maximum");
    for (let count = 0; count < split.undoSteps; count += 1) {
      state = await call(live.client, "plasticity_redo", { intent: "Verify native split Redo", revision: state.revision });
    }
    const redoneIds = split.resultBodyIds.slice().sort((left: number, right: number) => left - right);
    requireCondition(state.bodies.filter((body: any) => body.type === "Solid").map((body: any) => body.id).sort((left: number, right: number) => left - right).join(",") === redoneIds.join(","), "Redo did not restore the same split result identities");

    const left = ordered[0];
    const right = ordered[1];
    const joint = await call(live.client, "plasticity_create_tongue_groove_joint", {
      tongueTargetId: left.id,
      grooveTargetId: right.id,
      baseCenterMm: [10, 10, 10],
      axis: [1, 0, 0],
      widthDirection: [0, 1, 0],
      tongueWidthMm: 8,
      tongueThicknessMm: 4,
      tongueHeightMm: 4,
      radialClearanceMm: 0.25,
      axialClearanceMm: 0.25,
      baseOverlapMm: 0.25,
      cutterOvershootMm: 0.25,
      intent: "Fit a disposable clearance-matched tongue-and-groove joint to validate split assembly geometry",
      revision: state.revision,
    });
    requireCondition(joint.recipe === "tongue-groove-joint" && joint.status === "completed", "Native tongue-and-groove recipe did not complete");
    requireCondition(joint.resultBodyIds.length === 2 && joint.resultBodyIds.every((id: number) => split.resultBodyIds.includes(id)), "Tongue-and-groove recipe changed the split part identities");
    state = await call(live.client, "plasticity_status", {});
    const jointValidation = await call(live.client, "plasticity_validate_bodies", { ids: joint.resultBodyIds, revision: state.revision });
    requireCondition(jointValidation.bodies.length === 2 && jointValidation.bodies.every((body: any) => body.nativeValid && body.printableSolid && body.nativeCheckCodes.length === 0), "One or more jointed parts failed native Solid validation");
    const interference = await call(live.client, "plasticity_check_interference", {
      pairs: [{ firstBodyId: left.id, secondBodyId: right.id }], revision: state.revision,
    });
    requireCondition(interference.pairs.length === 1 && interference.pairs[0].status === "no-volumetric-interference", "Clearance-matched tongue and groove have volumetric interference");
    evidence.joint = {
      resultBodyIds: joint.resultBodyIds,
      recipeSteps: joint.steps,
      undoSteps: joint.undoSteps,
      radialClearanceMm: 0.25,
      axialClearanceMm: 0.25,
      validation: jointValidation.bodies,
      interference: interference.pairs[0],
    };

    for (let count = 0; count < joint.undoSteps; count += 1) {
      state = await call(live.client, "plasticity_undo", { intent: "Verify native tongue-and-groove Undo", revision: state.revision });
    }
    requireCondition(state.bodies.filter((body: any) => body.type === "Solid").length === 2, "Undo did not restore both plain split halves");
    for (let count = 0; count < joint.undoSteps; count += 1) {
      state = await call(live.client, "plasticity_redo", { intent: "Verify native tongue-and-groove Redo", revision: state.revision });
    }
    requireCondition(state.bodies.filter((body: any) => body.type === "Solid").length === 2, "Redo did not restore the two jointed Solid halves");

    const splitParts = split.resultBodyIds.map((id: number) => state.bodies.find((body: any) => body.id === id));
    const malePart = splitParts.find((body: any) => Math.abs(body.boundsMm.min[0]) <= 0.01)!;
    const femalePart = splitParts.find((body: any) => Math.abs(body.boundsMm.max[0] - 20) <= 0.01)!;
    const screwInsertJoint = await call(live.client, "plasticity_create_split_screw_insert_joint", {
      maleTargetId: malePart.id,
      femaleTargetId: femalePart.id,
      screwEntryCentersMm: [[0, 10, 10]],
      insertEntryCentersMm: [[10, 10, 10]],
      axis: [1, 0, 0],
      fastenerDesignation: "ISO 4762 M5x15",
      screwLengthMm: 15,
      minimumEngagementMm: 3,
      maximumEngagementMm: 5,
      insertPartNumber: "synthetic-acceptance-fixture-M5-P0.8",
      insertThreadNominalDiameterMm: 5,
      insertThreadPitchMm: 0.8,
      insertSourceUrl: "https://www.ruthex.de/products/ruthex-gewindeeinsatz-m5-50-stuck-rx-m5x9-5-messing-gewindebuchsen",
      holeDiameterMm: 5.3,
      maleThroughDepthMm: 10,
      holeOvershootMm: 0.5,
      pilotDiameterMm: 6.2,
      pilotDepthMm: 11,
      insertDiameterMm: 7,
      insertDepthMm: 9.5,
      leadInDiameterMm: 7.4,
      leadInDepthMm: 1,
      femaleMaterialDepthMm: 12,
      insertOvershootMm: 0.5,
      intent: "Validate the native split screw/insert recipe with disposable synthetic pocket dimensions; no fit or material qualification is claimed",
      revision: state.revision,
    });
    requireCondition(screwInsertJoint.recipe === "split-screw-insert-joint" && screwInsertJoint.status === "completed", "Native split screw-and-insert recipe did not complete");
    requireCondition(screwInsertJoint.fastenerCount === 1 && Math.abs(screwInsertJoint.screwEngagementMm - 5) <= 1e-9, "M5 screw engagement was not derived from screw length and measured male depth");
    requireCondition(screwInsertJoint.insertPartNumber === "synthetic-acceptance-fixture-M5-P0.8" && screwInsertJoint.insertThreadPitchMm === 0.8, "Insert identity or thread metadata was not retained in the recipe result");
    state = await call(live.client, "plasticity_status", {});
    const screwInsertValidation = await call(live.client, "plasticity_validate_bodies", { ids: screwInsertJoint.resultBodyIds, revision: state.revision });
    requireCondition(screwInsertValidation.bodies.length === 2 && screwInsertValidation.bodies.every((body: any) => body.nativeValid && body.printableSolid && body.nativeCheckCodes.length === 0), "One or more screw/insert parts failed native Solid validation");
    const screwInsertInterference = await call(live.client, "plasticity_check_interference", {
      pairs: [{ firstBodyId: malePart.id, secondBodyId: femalePart.id }], revision: state.revision,
    });
    requireCondition(screwInsertInterference.pairs.length === 1 && screwInsertInterference.pairs[0].status === "no-volumetric-interference", "Split screw-and-insert parts have volumetric interference");
    evidence.screwInsertJoint = {
      resultBodyIds: screwInsertJoint.resultBodyIds,
      fastenerDesignation: screwInsertJoint.fastenerDesignation,
      insertPartNumber: screwInsertJoint.insertPartNumber,
      insertThreadNominalDiameterMm: screwInsertJoint.insertThreadNominalDiameterMm,
      insertThreadPitchMm: screwInsertJoint.insertThreadPitchMm,
      insertSourceUrl: screwInsertJoint.insertSourceUrl,
      insertDimensionsMm: { pilotDiameter: 6.2, pilotDepth: 11, insertDiameter: 7, insertDepth: 9.5, leadInDiameter: 7.4, leadInDepth: 1 },
      dimensionsAreSyntheticAcceptanceFixture: true,
      screwEngagementMm: screwInsertJoint.screwEngagementMm,
      recipeSteps: screwInsertJoint.steps,
      undoSteps: screwInsertJoint.undoSteps,
      validation: screwInsertValidation.bodies,
      interference: screwInsertInterference.pairs[0],
    };
    for (let count = 0; count < screwInsertJoint.undoSteps; count += 1) {
      state = await call(live.client, "plasticity_undo", { intent: "Verify split screw-and-insert Undo", revision: state.revision });
    }
    requireCondition(state.bodies.filter((body: any) => body.type === "Solid").length === 2, "Undo did not restore both unmodified split halves after screw/insert edits");
    for (let count = 0; count < screwInsertJoint.undoSteps; count += 1) {
      state = await call(live.client, "plasticity_redo", { intent: "Verify split screw-and-insert Redo", revision: state.revision });
    }
    requireCondition(state.bodies.filter((body: any) => body.type === "Solid").length === 2, "Redo did not restore both screw/insert split halves");

    while (state.undoDepth > initialState.undoDepth) state = await call(live.client, "plasticity_undo", { intent: "Reset disposable split-and-joint acceptance before grid test", revision: state.revision });
    requireEmpty(state, "document before split-grid acceptance");
    const gridSourceState = await call(live.client, "plasticity_create_box", {
      originMm: [0, 0, 0], sizeMm: [40, 20, 20], name: "Disposable split grid acceptance box",
      intent: "Create a synthetic box to validate ordered multi-plane split execution", revision: state.revision,
    });
    requireCondition(gridSourceState.bodies.length === 1 && gridSourceState.bodies[0].type === "Solid", "Disposable split-grid source was not created as one Solid");
    const gridSource = gridSourceState.bodies[0];
    const grid = await call(live.client, "plasticity_split_solid_to_build_volume", {
      targetId: gridSource.id,
      usableBuildVolumeMm: [20, 10, 20],
      intent: "Split the disposable box into four equal native parts with two explicit planes",
      revision: gridSourceState.revision,
    });
    requireCondition(grid.recipe === "split-solid-to-build-volume" && grid.status === "completed", "Native automatic build-volume split recipe did not complete");
    requireCondition(grid.expectedGridCellCount === 4 && grid.segmentCounts.join(",") === "2,2,1", "Exact bounds did not map to the expected two-by-two grid");
    requireCondition(grid.split.cutCount === 3 && grid.resultBodyIds.length === 4 && grid.split.undoSteps === 12, "Two-plane split did not produce four parts through three binary cuts");
    near(grid.split.inputVolumeMm3, 16_000, 0.01, "grid source volume");
    near(grid.split.resultVolumeMm3, 16_000, 0.01, "grid result volume");
    requireCondition(grid.split.volumeDifferenceMm3 <= 0.01, "Multi-plane recipe reports a volume-conservation error");
    state = await call(live.client, "plasticity_status", {});
    const gridParts = grid.resultBodyIds.map((id: number) => state.bodies.find((body: any) => body.id === id)).sort((a: any, b: any) => a.boundsMm.min[0] - b.boundsMm.min[0] || a.boundsMm.min[1] - b.boundsMm.min[1]);
    requireCondition(gridParts.every((body: any) => body?.type === "Solid"), "One or more grid results are not native Solids");
    const expectedGridBounds: Array<[number[], number[]]> = [
      [[0, 0, 0], [20, 10, 20]], [[0, 10, 0], [20, 20, 20]],
      [[20, 0, 0], [40, 10, 20]], [[20, 10, 0], [40, 20, 20]],
    ];
    gridParts.forEach((body: any, index: number) => {
      vectorNear(body.boundsMm.min, expectedGridBounds[index]![0], 0.01, `grid part ${index + 1} minimum`);
      vectorNear(body.boundsMm.max, expectedGridBounds[index]![1], 0.01, `grid part ${index + 1} maximum`);
    });
    const gridValidation = await call(live.client, "plasticity_validate_bodies", { ids: grid.resultBodyIds, revision: state.revision });
    requireCondition(gridValidation.bodies.length === 4 && gridValidation.bodies.every((body: any) => body.nativeValid && body.printableSolid && body.nativeCheckCodes.length === 0), "One or more grid parts failed native Solid validation");
    evidence.grid = {
      resultBodyIds: grid.resultBodyIds,
      cuts: grid.split.cuts,
      undoSteps: grid.split.undoSteps,
      resultBoundsMm: gridParts.map((body: any) => body.boundsMm),
      inputVolumeMm3: grid.split.inputVolumeMm3,
      resultVolumeMm3: grid.split.resultVolumeMm3,
      volumeDifferenceMm3: grid.split.volumeDifferenceMm3,
      validation: gridValidation.bodies,
    };
    for (let count = 0; count < grid.split.undoSteps; count += 1) {
      state = await call(live.client, "plasticity_undo", { intent: "Verify native split-grid Undo", revision: state.revision });
    }
    requireCondition(state.bodies.length === 1 && state.bodies[0].id === gridSource.id, "Multi-plane Undo did not restore the original grid source");
    for (let count = 0; count < grid.split.undoSteps; count += 1) {
      state = await call(live.client, "plasticity_redo", { intent: "Verify native split-grid Redo", revision: state.revision });
    }
    requireCondition(state.bodies.filter((body: any) => body.type === "Solid").length === 4, "Multi-plane Redo did not restore all four grid parts");

    while (state.undoDepth > initialState.undoDepth) state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable split acceptance", revision: state.revision });
    requireEmpty(state, "cleaned document");
    const changes = await call(live.client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(changes.diff), "Scene content differs from the initial empty snapshot after cleanup");
    const journal = await call(live.client, "plasticity_construction_journal", {});
    requireCondition(journal.syncStatus === "in-sync" && !journal.entries.some((entry: { status: string }) => entry.status === "unknown"), "Construction journal is not clean after split acceptance");
    evidence.cleanup = { restoredEmptyDocument: true, sceneContentsRestored: true, journalSyncStatus: journal.syncStatus, uncertainJournalEntries: 0 };
    evidence.completedAt = new Date().toISOString();
    await writeExclusive(join(output, "evidence.json"), sanitizeEvidence(evidence));
    console.log(JSON.stringify({ ok: true, output, evidence: join(output, "evidence.json") }, null, 2));
  } catch (error) {
    evidence.failure = (error instanceof Error ? error.message : String(error)).slice(0, 4000);
    if (live && initialState && !evidence.cleanup) evidence.cleanup = await recover(live.client, initialState).catch((cleanupError) => ({ restoredEmptyDocument: false, reason: (cleanupError instanceof Error ? cleanupError.message : String(cleanupError)).slice(0, 2000) }));
    await writeExclusive(join(output, "failure.json"), sanitizeEvidence(evidence)).catch(() => {});
    throw error;
  } finally { await live?.client.close().catch(() => {}); }
}

async function startMcp(storeRoot: string): Promise<LiveMcp> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(projectRoot, "scripts", "run-server.ts")],
    cwd: projectRoot,
    env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" },
    stderr: "pipe",
  });
  const client = new Client({ name: "plasticity-split-solid-live", version: "1.0.0" });
  await client.connect(transport);
  return { client };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await client.callTool({ name, arguments: args });
  const output = toolText(response);
  if (typeof response === "object" && response !== null && "isError" in response && response.isError) throw new Error(output);
  return JSON.parse(output);
}

function toolText(response: unknown): string {
  if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content");
  const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string");
  if (!item) throw new Error("MCP tool returned no text content");
  return item.text;
}

async function recover(client: Client, initial: any): Promise<Record<string, unknown>> {
  for (let count = 0; count < 32; count += 1) {
    const state = await call(client, "plasticity_status", {});
    if (state.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" };
    if (state.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: state.bodies.length === 0 };
    await call(client, "plasticity_undo", { intent: "Recover disposable split acceptance", revision: state.revision });
  }
  return { restoredEmptyDocument: false, reason: "undo-limit" };
}

function requireEmpty(state: any, label: string): void {
  requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0, `${label} is not empty`);
  requireCondition((state.groups ?? []).filter((group: { id: number }) => group.id !== 0).length === 0, `${label} contains non-root groups`);
}
function stateSummary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, regionCount: state.regions.length }; }
function vectorNear(actual: number[], expected: number[], tolerance: number, label: string): void { requireCondition(actual.length === expected.length && actual.every((value, index) => Math.abs(value - expected[index]!) <= tolerance), `${label}: expected ${expected.join(",")}, got ${actual.join(",")}`); }
function near(actual: unknown, expected: number, tolerance: number, label: string): void { requireCondition(typeof actual === "number" && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${String(actual)}`); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
