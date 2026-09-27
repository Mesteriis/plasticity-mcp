#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { Evidence } from "../src/strength/contracts.ts";
import type { FastenerBinding, FastenerScenarioInput } from "../src/strength/fastener-contracts.ts";
import type { ThreadedReceiverInput } from "../src/strength/threaded-receiver-contracts.ts";
import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface FastenerAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parseFastenerAcceptanceArgs(argv: string[]): FastenerAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: FastenerAcceptanceOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live fastener acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Live fastener acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live fastener acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-fastener-strength-live.ts --help
  node scripts/verify-fastener-strength-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode refuses a nonempty Plasticity document, never chooses a window automatically,
uses a separate stdio MCP process, and writes only sanitized evidence to a new directory.`;

async function main(): Promise<void> {
  const options = parseFastenerAcceptanceArgs(process.argv.slice(2));
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
    requireCondition(initialState.bodies.length === 0, "Refusing disposable mutations in a nonempty Plasticity document");
    evidence.initial = stateSummary(initialState);
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "fastener-strength-live-initial-empty" });

    let state = await call(live.client, "plasticity_create_box", {
      originMm: [0, 0, 0], sizeMm: [40, 20, 2], name: "Disposable fastener plate",
      intent: "Approved disposable single-fastener acceptance", revision: initialState.revision,
    });
    const plateId = state.bodies[0].id;
    state = await call(live.client, "plasticity_create_cylinder", {
      centerMm: [30, 10, -1], radiusMm: 3, heightMm: 4, axis: [0, 0, 1], name: "Disposable fastener hole cutter",
      intent: "Approved disposable single-fastener acceptance", revision: state.revision,
    });
    const cutterId = state.bodies.find((body: { id: number }) => body.id !== plateId).id;
    state = await call(live.client, "plasticity_boolean", {
      targetIds: [plateId], toolIds: [cutterId], operation: "difference", keepTools: false,
      intent: "Approved disposable single-fastener acceptance", revision: state.revision,
    });
    const body = state.bodies.find((candidate: { id: number }) => candidate.id === plateId);
    requireCondition(body !== undefined, "Boolean did not retain the plate body");
    evidence.nativeBody = {
      id: body.id,
      versionId: body.versionId,
      type: body.type,
      faceCount: body.faceIds.length,
      edgeCount: body.edgeIds.length,
      faces: body.faces.map((face: any) => ({ id: face.id, planar: face.planar, surfaceType: face.surfaceType, radiusMm: face.radiusMm, centerMm: face.centerMm, normal: face.normal, edgeCount: face.edgeIds.length })),
    };
    const opposed = opposedZFaces(body);
    const inspected = await call(live.client, "plasticity_inspect_single_fastener_plate", {
      bodyId: plateId,
      frontFaceId: opposed.front.id,
      backFaceId: opposed.back.id,
      revision: state.revision,
      loadDirection: [1, 0, 0],
    });
    requireCondition(inspected.status === "verified", `Fastener geometry was not verified: ${JSON.stringify(inspected.reasons)}`);
    near(inspected.geometry.thicknessMm, 2, 0.01, "plate thickness");
    near(inspected.geometry.holeDiameterMm, 6, 0.01, "hole diameter");
    near(inspected.geometry.loadedEdgeDistanceMm, 10, 0.01, "loaded edge distance");
    near(inspected.geometry.oppositeEdgeDistanceMm, 30, 0.01, "opposite edge distance");
    near(inspected.geometry.grossWidthMm, 20, 0.01, "gross width");
    near(inspected.geometry.sideClearancesMm[0], 7, 0.01, "first side clearance");
    near(inspected.geometry.sideClearancesMm[1], 7, 0.01, "second side clearance");

    const report = await call(live.client, "plasticity_verify_single_fastener_strength", { ...fastenerBenchmark(inspected.binding) });
    requireCondition(report.result.status === "conditional", `Fastener report returned ${String(report.result.status)}`);
    near(report.result.stressMPa.bearing, 25, 1e-10, "bearing stress");
    near(report.result.stressMPa.shearOut, 75 / 7, 1e-10, "shear-out stress");
    near(report.result.stressMPa.netTension, 75 / 7, 1e-10, "net tension stress");
    evidence.fastener = {
      bodyId: plateId,
      frontFaceId: opposed.front.id,
      backFaceId: opposed.back.id,
      binding: inspected.binding,
      geometry: inspected.geometry,
      reportId: report.id,
      result: {
        status: report.result.status,
        method: report.result.method,
        methodVersion: report.result.methodVersion,
        stressMPa: report.result.stressMPa,
        utilization: report.result.utilization,
        geometryRatios: report.result.geometryRatios,
        issueCodes: report.result.issues.map((issue: { code: string }) => issue.code),
        unchecked: report.result.unchecked,
      },
    };

    const resolved = await call(live.client, "plasticity_resolve_fastener_designation", {
      designation: "винт DIN 912 M5x10 в резьбовое отверстие в металле",
      mountingIntent: "fixed",
      analysisIntent: "both",
    });
    requireCondition(resolved.workflow.compatibleTools.includes("plasticity_calculate_threaded_receiver_strength"), "M5 tapped-metal request did not route to the threaded-receiver strength tool");
    const threadedInput = threadedReceiverBenchmark();
    const threadedReport = await call(live.client, "plasticity_calculate_threaded_receiver_strength", threadedInput as unknown as Record<string, unknown>);
    requireCondition(threadedReport.result.status === "pass", `Threaded-receiver report returned ${String(threadedReport.result.status)}`);
    near(threadedReport.result.factoredDemandN, 6_000, 1e-10, "threaded-receiver factored demand");
    near(threadedReport.result.utilization.internalThreadStrip, 0.5, 1e-10, "internal-thread strip utilization");
    requireCondition(threadedReport.result.failureHierarchy.status === "fastener-tension-before-thread-stripping", "Threaded-receiver failure hierarchy was not verified");
    const changedThreadedInput = structuredClone(threadedReport.input);
    changedThreadedInput.configuration.engagementMm = 8.8;
    changedThreadedInput.configuration.completeThreadCount = 11;
    changedThreadedInput.evidence.find((item: { id: string }) => item.id === "configuration.engagementMm").value = 8.8;
    changedThreadedInput.evidence.find((item: { id: string }) => item.id === "configuration.completeThreadCount").value = 11;
    const staleThreaded = await call(live.client, "plasticity_strength_report", { reportId: threadedReport.id, current: changedThreadedInput });
    requireCondition(staleThreaded.freshness === "stale" && staleThreaded.reasons.includes("TASK_OR_MATERIAL_CHANGED"), "Threaded-receiver report did not become stale after an engagement change");
    evidence.threadedReceiver = {
      routedFromDesignation: resolved.normalizedDesignation,
      reportId: threadedReport.id,
      result: {
        status: threadedReport.result.status,
        method: threadedReport.result.method,
        methodVersion: threadedReport.result.methodVersion,
        factoredDemandN: threadedReport.result.factoredDemandN,
        utilization: threadedReport.result.utilization,
        governing: threadedReport.result.governing,
        failureHierarchy: threadedReport.result.failureHierarchy,
        staleReasons: staleThreaded.reasons,
      },
      syntheticQualificationData: true,
    };

    state = await call(live.client, "plasticity_scale", {
      ids: [plateId], pivotMm: [0, 0, 0], factors: [1, 1, 0.5],
      intent: "Disposable fastener report staleness check", revision: state.revision,
    });
    const stale = await call(live.client, "plasticity_strength_report", { reportId: report.id, current: report.input });
    requireCondition(stale.freshness === "stale" && stale.reasons.includes("CAD_REVISION_CHANGED"), "Fastener report did not become stale after thickness edit");
    state = await call(live.client, "plasticity_undo", { intent: "Restore fastener plate thickness", revision: state.revision });
    state = await call(live.client, "plasticity_redo", { intent: "Verify fastener plate redo", revision: state.revision });
    state = await call(live.client, "plasticity_undo", { intent: "Restore accepted fastener plate", revision: state.revision });
    evidence.staleAndHistory = { staleReasons: stale.reasons, thicknessHistoryMm: [2, 1, 2, 1, 2] };

    const journal = await call(live.client, "plasticity_construction_journal", {});
    requireCleanJournal(journal);
    for (let step = 0; step < 3; step += 1) {
      state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable fastener acceptance", revision: state.revision });
    }
    requireCondition(state.documentToken === initialState.documentToken && state.bodies.length === 0, "Cleanup did not restore the empty document");
    const finalJournal = await call(live.client, "plasticity_construction_journal", {});
    requireCleanJournal(finalJournal);
    const changes = await call(live.client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(changes.diff), "Scene content differs from the initial empty snapshot after cleanup");
    evidence.cleanup = {
      restoredEmptyDocument: true,
      sceneContentsRestored: true,
      journalSyncStatus: finalJournal.syncStatus,
      uncertainJournalEntries: finalJournal.entries.filter((entry: { status: string }) => entry.status === "unknown").length,
    };
    evidence.completedAt = new Date().toISOString();
    await writeExclusive(join(output, "evidence.json"), sanitizeEvidence(evidence));
    console.log(JSON.stringify({ ok: true, output, evidence: join(output, "evidence.json") }, null, 2));
  } catch (error) {
    evidence.failure = boundedError(error);
    if (live && initialState && !evidence.cleanup) {
      evidence.cleanup = await recover(live.client, initialState).catch((cleanupError) => ({ restoredEmptyDocument: false, reason: boundedError(cleanupError) }));
    }
    await writeExclusive(join(output, "failure.json"), sanitizeEvidence(evidence)).catch(() => {});
    throw error;
  } finally {
    await live?.client.close().catch(() => {});
  }
}

function opposedZFaces(body: any): { front: any; back: any } {
  const planar = body.faces.filter((face: any) => face.planar && Math.abs(face.normal[2]) > 0.99 && face.edgeIds.length === 5);
  requireCondition(planar.length === 2, `Expected two opposed five-edge planar faces, found ${planar.length}`);
  const front = planar.reduce((highest: any, face: any) => face.centerMm[2] > highest.centerMm[2] ? face : highest);
  const back = planar.find((face: any) => face.id !== front.id);
  return { front, back };
}

function fastenerBenchmark(binding: FastenerBinding): FastenerScenarioInput {
  const geometry = { thicknessMm: 2, holeDiameterMm: 6, loadedEdgeDistanceMm: 10, oppositeEdgeDistanceMm: 30, grossWidthMm: 20, sideClearancesMm: [7, 7] as [number, number] };
  const evidence: Evidence[] = [];
  const assignments: Record<string, string> = {};
  const add = (path: string, value: number, unit: NonNullable<Evidence["unit"]>, status: Evidence["status"], source = false): string => {
    const id = path.replaceAll(/[^A-Za-z0-9]+/g, "-");
    evidence.push({ id, label: `SYNTHETIC acceptance ${path}`, status, unit, value, ...(source ? { sourceUrl: "https://example.invalid/plasticity-mcp-synthetic-acceptance", sourceHash: "sha256:synthetic-not-material-data" } : {}), ...(status === "measured" ? { sourceLocator: "synthetic-caller-geometry-replaced-by-native-verification" } : {}), dependsOn: [] });
    assignments[path] = id;
    return id;
  };
  add("geometry.thicknessMm", 2, "mm", "assumed");
  add("geometry.holeDiameterMm", 6, "mm", "assumed");
  add("geometry.loadedEdgeDistanceMm", 10, "mm", "assumed");
  add("geometry.oppositeEdgeDistanceMm", 30, "mm", "assumed");
  add("geometry.grossWidthMm", 20, "mm", "assumed");
  add("geometry.sideClearancesMm.0", 7, "mm", "assumed");
  add("geometry.sideClearancesMm.1", 7, "mm", "assumed");
  const load = add("loadN", 300, "N", "sourced", true);
  const bearing = add("material.bearingLimitMPa", 100, "MPa", "sourced", true);
  const shear = add("material.shearLimitMPa", 50, "MPa", "sourced", true);
  const tensile = add("material.tensileLimitMPa", 50, "MPa", "sourced", true);
  add("safetyFactor", 2, "ratio", "assumed");
  return {
    kind: "single-fastener-plate",
    goal: "SYNTHETIC live single-fastener benchmark; not printable material data",
    method: "single-fastener-plate-v1",
    geometry,
    loadN: 300,
    material: {
      id: "synthetic-fastener-material", name: "SYNTHETIC acceptance material; not for printing",
      evidenceIds: [bearing, shear, tensile], bearingLimitMPa: 100, shearLimitMPa: 50, tensileLimitMPa: 50,
      suitability: "unconfirmed",
      manufacturing: { printerId: "synthetic-none", profileHash: "synthetic-not-printable", orientationDeg: [0, 0, 0], infillPercent: 100, temperatureC: 20, effectiveSection: "solid" },
    },
    safetyFactor: 2,
    evidence,
    assignments,
    assumptions: [
      { code: "static-in-plane-load", confirmed: true, evidenceIds: [load] },
      { code: "single-fastener-load-path", confirmed: true, evidenceIds: [load] },
      { code: "load-centered-through-thickness", confirmed: true, evidenceIds: [] },
      { code: "homogeneous-equivalent-plate", confirmed: true, evidenceIds: [bearing, shear, tensile] },
      { code: "nominal-bearing-contact", confirmed: true, evidenceIds: [] },
    ],
    binding,
  };
}

function threadedReceiverBenchmark(): ThreadedReceiverInput {
  const values: Record<string, [number, "mm" | "N" | "ratio", "sourced" | "assumed"]> = {
    "configuration.nominalDiameterMm": [5, "mm", "sourced"],
    "configuration.pitchMm": [0.8, "mm", "sourced"],
    "configuration.engagementMm": [8, "mm", "sourced"],
    "configuration.completeThreadCount": [10, "ratio", "sourced"],
    "loads.axialTensionN": [3_000, "N", "sourced"],
    "capacity.internalThreadStripAllowableN": [12_000, "N", "sourced"],
    "capacity.externalThreadStripAllowableN": [14_000, "N", "sourced"],
    "capacity.fastenerTensileAllowableN": [10_000, "N", "sourced"],
    safetyFactor: [2, "ratio", "assumed"],
  };
  const evidence: Evidence[] = Object.entries(values).map(([path, [value, unit, status]]) => ({
    id: path,
    label: `SYNTHETIC acceptance ${path}`,
    status,
    unit,
    value,
    ...(status === "sourced" ? { sourceUrl: "https://example.invalid/plasticity-mcp-synthetic-acceptance", sourceHash: "sha256:synthetic-not-engineering-data" } : {}),
    dependsOn: [],
  }));
  return {
    kind: "threaded-receiver",
    goal: "SYNTHETIC live M5 threaded-receiver benchmark; not engineering capacity data",
    method: "threaded-receiver-axial-v1",
    configuration: {
      threadDesignation: "M5×0.8",
      nominalDiameterMm: 5,
      pitchMm: 0.8,
      engagementMm: 8,
      completeThreadCount: 10,
      receiverType: "tapped-hole",
      capacityBasis: "qualified-shear-area-calculation",
    },
    loads: { axialTensionN: 3_000 },
    capacity: {
      internalThreadStripAllowableN: 12_000,
      externalThreadStripAllowableN: 14_000,
      fastenerTensileAllowableN: 10_000,
      evidenceIds: ["capacity.internalThreadStripAllowableN", "capacity.externalThreadStripAllowableN", "capacity.fastenerTensileAllowableN"],
      suitability: "matched",
    },
    criteria: { requireFastenerTensionBeforeThreadStripping: true },
    safetyFactor: 2,
    evidence,
    assignments: Object.fromEntries(Object.keys(values).map((path) => [path, path])),
    assumptions: [
      "static-axial-load",
      "worst-case-receiver-demand-known",
      "fully-formed-engaged-thread-count-known",
      "capacity-matches-thread-form-class-material-and-engagement",
      "axial-force-includes-applicable-preload",
      "no-prying-bending-or-transverse-load",
    ].map((code) => ({ code, confirmed: true, evidenceIds: [] })),
  };
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
  const client = new Client({ name: "plasticity-fastener-strength-live", version: "1.0.0" });
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
  for (let count = 0; count < 8; count += 1) {
    const status = await call(client, "plasticity_status", {});
    if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" };
    if (status.bodies.length === 0) return { restoredEmptyDocument: true };
    const journal = await call(client, "plasticity_construction_journal", {});
    if (journal.syncStatus !== "in-sync" || journal.entries.some((entry: { status: string }) => entry.status === "unknown")) return { restoredEmptyDocument: false, reason: "unsafe-journal" };
    await call(client, "plasticity_undo", { intent: "Recover disposable fastener acceptance", revision: status.revision });
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

function near(actual: number, expected: number, tolerance: number, label: string): void {
  requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`);
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : []));
}

function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }

async function writeExclusive(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
}
