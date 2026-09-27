#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface PrintedThreadAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parsePrintedThreadAcceptanceArgs(argv: string[]): PrintedThreadAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: PrintedThreadAcceptanceOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live printed-thread acceptance requires --target with an explicit Plasticity window ID");
  if (!options.allowDisposableMutations) throw new Error("Live printed-thread acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live printed-thread acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-printed-threads-live.ts --help
  node scripts/verify-printed-threads-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode refuses a nonempty Plasticity document, never chooses a window automatically,
uses a separate stdio MCP process, and writes only sanitized evidence to a new directory.`;

async function main(): Promise<void> {
  const options = parsePrintedThreadAcceptanceArgs(process.argv.slice(2));
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
  let state: any;
  try {
    live = await startMcp(join(output, "strength-store"));
    const windows = await call(live.client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    initialState = await call(live.client, "plasticity_connect", { targetId: options.target });
    requireCondition(initialState.bodies.length === 0 && initialState.regions.length === 0 && (initialState.instances ?? []).length === 0, "Refusing disposable mutations in a nonempty Plasticity document");
    evidence.initial = stateSummary(initialState);
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "printed-threads-live-initial-empty" });

    const intentResolution = await call(live.client, "plasticity_resolve_fastener_designation", {
      designation: "напечатай винт M5x10 и ответную гайку",
      mountingIntent: "fixed",
      analysisIntent: "geometry",
      decisionMode: "agent-may-select-qualified",
    });
    requireCondition(intentResolution.jointIntent === "printed-threaded-pair", "Printed screw-and-nut phrase did not resolve to the custom pair route");
    requireCondition(intentResolution.thread?.system === "custom-rounded-print", "Printed pair was incorrectly classified as an ISO metric thread");
    requireCondition(intentResolution.workflow?.route === "printed-threaded-pair", "Printed pair did not return its dedicated workflow");
    requireCondition(intentResolution.workflow.compatibleTools.includes("plasticity_create_printed_hex_screw") && intentResolution.workflow.compatibleTools.includes("plasticity_create_printed_hex_nut"), "Printed pair workflow omitted its native screw or nut tool");
    requireCondition(intentResolution.thread.pitchMm === undefined, "Printed pair incorrectly inherited an ISO coarse pitch");
    evidence.intentResolution = {
      jointIntent: intentResolution.jointIntent,
      threadSystem: intentResolution.thread.system,
      nominalDiameterMm: intentResolution.thread.nominalDiameterMm,
      lengthMm: intentResolution.lengthMm,
      route: intentResolution.workflow.route,
      nextQuestionPackageId: intentResolution.nextQuestionPackage?.id,
      compatibleTools: intentResolution.workflow.compatibleTools,
    };

    const commercialFastener = await call(live.client, "plasticity_resolve_fastener_designation", {
      designation: "кронштейн крепится на 4 болта M5x10 с гайками",
      mountingIntent: "fixed",
      analysisIntent: "geometry",
    });
    requireCondition(commercialFastener.interpretation.quantity === 4, "Four-fastener quantity was not resolved");
    requireCondition(commercialFastener.jointIntent === "through-bolt-with-nut", "Bolt-and-nut phrase did not resolve to a through joint");
    requireCondition(commercialFastener.thread?.system === "ISO-metric" && commercialFastener.thread.nominalDiameterMm === 5 && commercialFastener.lengthMm === 10, "Commercial M5x10 dimensions were not parsed");
    requireCondition(commercialFastener.form === "bolt-unspecified", "The resolver silently inferred an unspecified bolt-head form");
    requireCondition(commercialFastener.workflow.compatibleTools.includes("plasticity_create_through_hole_pattern"), "Fixed fastener group did not return a grouped through-hole workflow");
    const stack = await call(live.client, "plasticity_check_fastener_stack", {
      designation: "кронштейн крепится на 4 болта M5x10 с гайками",
      lengthMeasurement: "under-head",
      gripItems: [{ id: "bracket", thicknessMm: 2 }, { id: "housing-wall", thicknessMm: 2 }],
      receiver: { kind: "nut", nutThicknessMm: 4, minimumProtrusionMm: 1.6, maximumProtrusionMm: 3 },
    });
    requireCondition(stack.status === "pass" && stack.receiver?.actualProtrusionMm === 2, "M5x10 fastener stack did not return the expected axial fit");
    evidence.commercialFastener = {
      jointIntent: commercialFastener.jointIntent,
      quantity: commercialFastener.interpretation.quantity,
      form: commercialFastener.form,
      thread: commercialFastener.thread,
      lengthMm: commercialFastener.lengthMm,
      nextQuestionPackageId: commercialFastener.nextQuestionPackage?.id,
      compatibleTools: commercialFastener.workflow.compatibleTools,
      stack,
    };

    const definition = {
      nominalDiameterMm: 5,
      pitchMm: 1.25,
      threadDepthMm: 0.6,
      handedness: "right",
      radialDirection: [1, 0, 0],
    };
    const pair = await call(live.client, "plasticity_create_printed_hex_pair", {
      designation: "напечатай винт M5x10 и ответную гайку",
      pitchMm: definition.pitchMm,
      threadDepthMm: definition.threadDepthMm,
      profileClearanceMm: 0.15,
      handedness: definition.handedness,
      screwAxisStartMm: [0, 0, 0], nutEntryCenterMm: [15, 0, 0],
      axis: [0, 0, 1], radialDirection: definition.radialDirection, flatNormalDirection: [1, 0, 0],
      screwHeadAcrossFlatsMm: 9, screwHeadHeightMm: 3, screwJunctionOverlapMm: 0.2,
      nutAcrossFlatsMm: 9, nutThicknessMm: 8, nutMinimumWallThicknessMm: 1.5,
      cutterOvershootMm: 0.5, screwName: "Disposable printed hex screw",
      process: {
        printerId: "Creality K1C",
        materialId: "Generic PLA",
        slicingProfileId: "0.20mm Standard",
        nozzleDiameterMm: 0.4,
        layerHeightMm: 0.2,
        orientation: "screw and nut axes vertical for acceptance geometry",
        clearanceBasis: "synthetic 0.15 mm acceptance value; physical calibration still required",
      },
      sizingBasis: "SYNTHETIC geometry acceptance only; no load capacity claim",
      intent: "Approved disposable complete printed-pair acceptance", revision: initialState.revision,
    });
    requireCondition(pair.recipe === "printed-hex-pair" && pair.undoSteps === 15, "Printed pair recipe did not complete all fifteen native steps");
    requireCondition(pair.fitQualification?.status === "requires-physical-fit-test", "Synthetic acceptance geometry incorrectly claimed a physical fit qualification");
    requireCondition(pair.designation.nominalCrestDiameterMm === 5 && pair.designation.threadLengthMm === 10, "Printed pair did not derive its crest diameter and length from M5x10");
    requireCondition(pair.designation.normalizedCustomDesignation === "custom-rounded Ø5×P1.25×L10", "Printed pair returned an unexpected normalized custom designation");
    const screw = pair.screw;
    const nut = pair.nut;
    requireCondition(screw.recipe === "printed-hex-screw" && screw.undoSteps === 9, "Printed screw recipe did not complete all nine native steps");
    requireCondition(nut.recipe === "printed-hex-nut" && nut.undoSteps === 6, "Printed nut recipe did not complete all six native steps");
    near(nut.geometry.femaleBoreDiameterMm, 4.1, 1e-12, "female bore diameter");
    near(nut.geometry.femaleGrooveDiameterMm, 0.96, 1e-12, "female groove diameter");
    near(nut.actualMinimumWallThicknessMm, 1.82, 1e-12, "reported minimum nut wall");
    state = await call(live.client, "plasticity_status", {});
    const screwBody = requireBody(state, screw.resultBodyId, "printed screw");
    near(requireCylinderRadius(screwBody, 2.5), 2.5, 0.01, "screw crest radius");
    near(requireCylinderRadius(screwBody, 1.9), 1.9, 0.01, "screw core radius");
    const nutBody = requireBody(state, nut.resultBodyId, "printed nut");
    near(requireCylinderRadius(nutBody, 2.05), 2.05, 0.01, "nut bore radius");

    const validation = await call(live.client, "plasticity_validate_bodies", { ids: [screw.resultBodyId, nut.resultBodyId], revision: state.revision });
    requireCondition(validation.bodies.length === 2, "Native validation did not return both printed parts");
    requireCondition(validation.bodies.every((body: { nativeValid: boolean; printableSolid: boolean; nativeCheckCodes: number[] }) => body.nativeValid && body.printableSolid && body.nativeCheckCodes.length === 0), "A printed thread body failed native validation");

    state = await call(live.client, "plasticity_move", {
      ids: [nut.resultBodyId], deltaMm: [-15, 0, 0.5],
      intent: "Align the matched nut axis and helix phase for disposable acceptance", revision: state.revision,
    });
    const aligned = await call(live.client, "plasticity_check_interference", {
      pairs: [{ firstBodyId: screw.resultBodyId, secondBodyId: nut.resultBodyId }], revision: state.revision,
    });
    requireCondition(aligned.pairs[0]?.status === "no-volumetric-interference", `Aligned custom thread pair did not clear: ${JSON.stringify(aligned.pairs[0])}`);

    state = await call(live.client, "plasticity_rotate", {
      ids: [nut.resultBodyId], pivotMm: [0, 0, 0.5], axis: [0, 0, 1], degrees: 90,
      intent: "Deliberately misalign the printed thread phase for disposable acceptance", revision: state.revision,
    });
    const misaligned = await call(live.client, "plasticity_check_interference", {
      pairs: [{ firstBodyId: screw.resultBodyId, secondBodyId: nut.resultBodyId }], revision: state.revision,
    });
    requireCondition(misaligned.pairs[0]?.status === "interfere", "A 90-degree thread phase error did not produce exact volumetric interference");

    state = await call(live.client, "plasticity_undo", { intent: "Restore aligned printed-thread phase", revision: state.revision });
    const realigned = await call(live.client, "plasticity_check_interference", {
      pairs: [{ firstBodyId: screw.resultBodyId, secondBodyId: nut.resultBodyId }], revision: state.revision,
    });
    requireCondition(realigned.pairs[0]?.status === "no-volumetric-interference", "Undo did not restore the interference-free aligned thread phase");
    const journal = await call(live.client, "plasticity_construction_journal", {});
    requireCleanJournal(journal);
    evidence.threadPair = {
      definition,
      profileClearanceMm: 0.15,
      designation: pair.designation,
      process: pair.process,
      sizingBasis: pair.sizingBasis,
      fitQualification: pair.fitQualification,
      undoSteps: pair.undoSteps,
      screw: summarizeRecipe(screw, screwBody),
      nut: summarizeRecipe(nut, nutBody),
      validation: validation.bodies,
      alignedStatus: aligned.pairs[0].status,
      deliberatelyMisalignedStatus: misaligned.pairs[0].status,
      realignedAfterUndoStatus: realigned.pairs[0].status,
      alignmentAxialOffsetMm: 0.5,
    };

    while (state.undoDepth > initialState.undoDepth) {
      state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable printed-thread acceptance", revision: state.revision });
    }
    requireCondition(state.bodies.length === 0 && state.regions.length === 0, "Cleanup did not restore the empty document");
    const finalJournal = await call(live.client, "plasticity_construction_journal", {});
    requireCleanJournal(finalJournal);
    const changes = await call(live.client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(changes.diff), "Scene content differs from the initial empty snapshot after cleanup");
    evidence.cleanup = { restoredEmptyDocument: true, sceneContentsRestored: true, journalSyncStatus: finalJournal.syncStatus, uncertainJournalEntries: 0 };
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

function summarizeRecipe(recipe: any, body: any): Record<string, unknown> {
  return {
    resultBodyId: recipe.resultBodyId,
    helixBodyId: recipe.helixBodyId,
    profileBodyId: recipe.profileBodyId ?? recipe.headProfileBodyId,
    undoSteps: recipe.undoSteps,
    turns: recipe.turns,
    geometry: recipe.geometry,
    faceCount: body.faceIds.length,
    edgeCount: body.edgeIds.length,
    exactCylinderRadiiMm: body.faces.filter((face: any) => face.surfaceType === "Cylinder").map((face: any) => face.radiusMm).filter(Number.isFinite).sort((a: number, b: number) => a - b),
  };
}

function requireBody(state: any, id: number, label: string): any {
  const body = state.bodies.find((candidate: { id: number }) => candidate.id === id);
  requireCondition(body?.type === "Solid", `${label} ${id} is not a current Solid`);
  return body;
}

function requireCylinderRadius(body: any, expectedMm: number): number {
  const radius = body.faces.find((face: any) => face.surfaceType === "Cylinder" && Number.isFinite(face.radiusMm) && Math.abs(face.radiusMm - expectedMm) <= 0.01)?.radiusMm;
  requireCondition(Number.isFinite(radius), `Body ${body.id} has no exact cylindrical face with radius ${expectedMm} mm`);
  return radius;
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
  const client = new Client({ name: "plasticity-printed-thread-live", version: "1.0.0" });
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

async function recover(client: Client, initial: any): Promise<Record<string, unknown>> {
  for (let count = 0; count < 32; count += 1) {
    const status = await call(client, "plasticity_status", {});
    if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" };
    if (status.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: status.bodies.length === 0 };
    await call(client, "plasticity_undo", { intent: "Recover disposable printed-thread acceptance", revision: status.revision });
  }
  return { restoredEmptyDocument: false, reason: "undo-limit" };
}

function requireCleanJournal(journal: any): void {
  requireCondition(journal.syncStatus === "in-sync", `Construction journal is ${String(journal.syncStatus)}`);
  requireCondition(!journal.entries.some((entry: { status: string }) => entry.status === "unknown"), "Construction journal contains an uncertain mutation");
}

function stateSummary(state: any): Record<string, unknown> {
  return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length };
}
function near(actual: number, expected: number, tolerance: number, label: string): void { requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
