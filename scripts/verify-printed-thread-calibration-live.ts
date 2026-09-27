#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface PrintedThreadCalibrationAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parsePrintedThreadCalibrationAcceptanceArgs(argv: string[]): PrintedThreadCalibrationAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: PrintedThreadCalibrationAcceptanceOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live printed-thread calibration acceptance requires --target with an explicit Plasticity window ID");
  if (!options.allowDisposableMutations) throw new Error("Live printed-thread calibration acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live printed-thread calibration acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-printed-thread-calibration-live.ts --help
  node scripts/verify-printed-thread-calibration-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

Live mode refuses a nonempty Plasticity document, creates one disposable custom
printed screw and two calibration nuts, validates their exact native B-Reps and
distinct bore radii, restores the empty document, and writes sanitized evidence.`;

async function main(): Promise<void> {
  const options = parsePrintedThreadCalibrationAcceptanceArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const evidence: Record<string, unknown> = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    targetId: options.target!,
    workbenchUsed: false,
    profileCompatibility: "custom matched rounded-print-v1; not ISO metric",
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
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "printed-thread-calibration-live-initial-empty" });

    const calibration = await call(live.client, "plasticity_create_printed_thread_calibration_set", {
      designation: "калибровочный печатный винт M5x8",
      pitchMm: 1.25,
      threadDepthMm: 0.6,
      handedness: "right",
      screwAxisStartMm: [0, 0, 0],
      axis: [0, 0, 1],
      radialDirection: [1, 0, 0],
      flatNormalDirection: [1, 0, 0],
      screwHeadAcrossFlatsMm: 9,
      screwHeadHeightMm: 3,
      screwJunctionOverlapMm: 0.2,
      nutAcrossFlatsMm: 9,
      nutThicknessMm: 8,
      nutMinimumWallThicknessMm: 1.5,
      cutterOvershootMm: 0.5,
      screwName: "Disposable thread calibration screw",
      samples: [
        { id: "clearance-0.10", nutEntryCenterMm: [15, 0, 0], profileClearanceMm: 0.1 },
        { id: "clearance-0.20", nutEntryCenterMm: [30, 0, 0], profileClearanceMm: 0.2 },
      ],
      process: {
        printerId: "Creality K1C",
        materialId: "Generic PLA",
        slicingProfileId: "0.20mm Standard",
        nozzleDiameterMm: 0.4,
        layerHeightMm: 0.2,
        orientation: "all thread axes vertical for acceptance geometry",
        clearanceBasis: "synthetic clearance ladder; physical print test still required",
      },
      sizingBasis: "SYNTHETIC geometry acceptance only; no fit or load-capacity claim",
      intent: "Approved disposable printed-thread calibration acceptance",
      revision: initialState.revision,
    });
    requireCondition(calibration.recipe === "printed-thread-calibration-set", "Calibration recipe did not complete");
    requireCondition(calibration.qualificationStatus === "requires-physical-fit-test", "Calibration result incorrectly claimed physical qualification");
    requireCondition(calibration.undoSteps === 21 && calibration.steps.length === 21, "Calibration set did not return all 21 native history steps");
    requireCondition(calibration.samples?.length === 2, "Calibration set did not return two nut samples");
    requireCondition(calibration.designation?.nominalCrestDiameterMm === 5 && calibration.designation?.threadLengthMm === 8, "Calibration designation did not derive M5x8 dimensions");

    const state = await call(live.client, "plasticity_status", {});
    const screw = requireBody(state, calibration.screw.resultBodyId, "calibration screw");
    const tight = requireBody(state, calibration.samples[0].nut.resultBodyId, "0.10 mm calibration nut");
    const normal = requireBody(state, calibration.samples[1].nut.resultBodyId, "0.20 mm calibration nut");
    requireCondition(state.bodies.filter((body: any) => body.type === "Solid").length === 3, "Calibration document does not contain exactly three Solids");
    near(requireCylinderRadius(screw, 2.5), 2.5, 0.01, "screw crest radius");
    near(requireCylinderRadius(tight, 2), 2, 0.01, "0.10 mm sample bore radius");
    near(requireCylinderRadius(normal, 2.1), 2.1, 0.01, "0.20 mm sample bore radius");
    requireCondition(calibration.samples[0].nut.geometry.femaleBoreDiameterMm === 4, "0.10 mm sample reported the wrong bore diameter");
    requireCondition(calibration.samples[1].nut.geometry.femaleBoreDiameterMm === 4.2, "0.20 mm sample reported the wrong bore diameter");

    const bodyIds = [screw.id, tight.id, normal.id];
    const validation = await call(live.client, "plasticity_validate_bodies", { ids: bodyIds, revision: state.revision });
    requireCondition(validation.bodies.length === 3, "Native validation did not return all calibration Solids");
    requireCondition(validation.bodies.every((body: any) => body.nativeValid && body.printableSolid && body.nativeCheckCodes.length === 0), "A calibration Solid failed native validation");
    evidence.calibration = {
      designation: calibration.designation,
      process: calibration.process,
      sizingBasis: calibration.sizingBasis,
      qualificationStatus: calibration.qualificationStatus,
      selectionInstruction: calibration.selectionInstruction,
      undoSteps: calibration.undoSteps,
      screw: summarizePart(calibration.screw, screw),
      samples: calibration.samples.map((sample: any, index: number) => summarizeSample(sample, index === 0 ? tight : normal)),
      validation: validation.bodies,
    };

    let cleanupState = state;
    while (cleanupState.undoDepth > initialState.undoDepth) {
      cleanupState = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable printed-thread calibration acceptance", revision: cleanupState.revision });
    }
    requireEmpty(cleanupState, "cleaned document");
    const journal = await call(live.client, "plasticity_construction_journal", {});
    requireCleanJournal(journal);
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

function summarizePart(recipe: any, body: any): Record<string, unknown> {
  return { resultBodyId: recipe.resultBodyId, helixBodyId: recipe.helixBodyId, undoSteps: recipe.undoSteps, geometry: recipe.geometry, faceCount: body.faceIds.length, edgeCount: body.edgeIds.length };
}
function summarizeSample(sample: any, body: any): Record<string, unknown> {
  return { id: sample.id, profileClearanceMm: sample.profileClearanceMm, ...summarizePart(sample.nut, body), actualMinimumWallThicknessMm: sample.nut.actualMinimumWallThicknessMm };
}
function requireBody(state: any, id: number, label: string): any { const body = state.bodies.find((candidate: any) => candidate.id === id); requireCondition(body?.type === "Solid", `${label} ${id} is not a current Solid`); return body; }
function requireCylinderRadius(body: any, expectedMm: number): number { const radius = body.faces.find((face: any) => face.surfaceType === "Cylinder" && Number.isFinite(face.radiusMm) && Math.abs(face.radiusMm - expectedMm) <= 0.01)?.radiusMm; requireCondition(Number.isFinite(radius), `Body ${body.id} has no exact cylindrical face with radius ${expectedMm} mm`); return radius; }
async function startMcp(storeRoot: string): Promise<LiveMcp> { const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" }, stderr: "pipe" }); const stderr: string[] = []; transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); }); const client = new Client({ name: "plasticity-printed-thread-calibration-live", version: "1.0.0" }); await client.connect(transport); return { client, stderr }; }
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> { const response = await client.callTool({ name, arguments: args }); const output = toolText(response); if ("isError" in response && response.isError) throw new Error(output); return JSON.parse(output); }
function toolText(response: unknown): string { if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content"); const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string"); if (!item) throw new Error("MCP tool returned no text content"); return item.text; }
async function recover(client: Client, initial: any): Promise<Record<string, unknown>> { for (let count = 0; count < 32; count += 1) { const state = await call(client, "plasticity_status", {}); if (state.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" }; if (state.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: state.bodies.length === 0 && state.regions.length === 0 }; await call(client, "plasticity_undo", { intent: "Recover disposable printed-thread calibration acceptance", revision: state.revision }); } return { restoredEmptyDocument: false, reason: "undo-limit" }; }
function requireCleanJournal(journal: any): void { requireCondition(journal.syncStatus === "in-sync", `Construction journal is ${String(journal.syncStatus)}`); requireCondition(!journal.entries.some((entry: any) => entry.status === "unknown"), "Construction journal contains an uncertain mutation"); }
function requireEmpty(state: any, label: string): void { requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0, `${label} is not empty`); requireCondition((state.groups ?? []).filter((group: any) => group.id !== 0).length === 0, `${label} contains non-root groups`); }
function stateSummary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, regionCount: state.regions.length }; }
function near(actual: number, expected: number, tolerance: number, label: string): void { requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
