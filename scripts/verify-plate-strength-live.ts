#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { Evidence, StrengthInput } from "../src/strength/contracts.ts";
import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface PlateAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp {
  client: Client;
  stderr: string[];
}

interface AcceptanceEvidence {
  schemaVersion: 1;
  startedAt: string;
  completedAt?: string;
  targetId: string;
  initial: unknown;
  plate?: unknown;
  integralWall?: unknown;
  staleAndHistory?: unknown;
  cleanup?: unknown;
  workbenchUsed: false;
  failure?: string;
}

export function parsePlateAcceptanceArgs(argv: string[]): PlateAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: PlateAcceptanceOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live plate acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Live plate acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live plate acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-plate-strength-live.ts --help
  node scripts/verify-plate-strength-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode refuses a nonempty Plasticity document, never chooses a window automatically,
uses a separate stdio MCP process, and writes only sanitized evidence to a new directory.`;

async function main(): Promise<void> {
  const options = parsePlateAcceptanceArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const evidence: AcceptanceEvidence = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    targetId: options.target!,
    initial: null,
    workbenchUsed: false,
  };
  let live: LiveMcp | undefined;
  let initialState: any;
  try {
    live = await startMcp(join(output, "strength-store"));
    const windows = await call(live.client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    initialState = await call(live.client, "plasticity_connect", { targetId: options.target });
    requireCondition(Array.isArray(initialState.bodies) && initialState.bodies.length === 0, "Refusing disposable mutations in a nonempty Plasticity document");
    evidence.initial = stateSummary(initialState);
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "plate-strength-live-initial-empty" });

    let state = await call(live.client, "plasticity_create_box", {
      originMm: [0, 0, 0],
      sizeMm: [80, 40, 2],
      name: "Disposable uniform-pressure plate",
      intent: "Approved disposable rectangular-plate acceptance",
      revision: initialState.revision,
    });
    requireCondition(state.bodies.length === 1, "Plate creation did not produce exactly one body");
    const bodyId = state.bodies[0].id;
    let member = await inspectPlate(live.client, bodyId, state.revision);
    requireDimensions(member, [80, 40, 2]);

    const input = plateBenchmark(member.binding);
    const scenario = await call(live.client, "plasticity_calculate_strength", { ...input });
    requireCondition(scenario.input.binding === undefined, "Plate scenario retained an unverified CAD binding");
    const report = await call(live.client, "plasticity_verify_member_strength", {
      input,
      lengthAxis: [1, 0, 0],
      heightAxis: [0, 0, 1],
    });
    requireCondition(report.result.status === "conditional", `Verified plate returned ${String(report.result.status)}`);
    requireCondition(report.result.method === "simply-supported-plate-uniform-pressure-v1", "Verified plate used the wrong method");
    near(report.result.displacementMm, 0.1706477151542879, 1e-11, "plate centre deflection");
    near(report.result.stressMPa, 2.4612890977821666, 1e-11, "plate governing stress");
    near(report.result.plate.centerMomentsN.x, 0.818772282683262, 1e-11, "plate centre Mx");
    near(report.result.plate.centerMomentsN.y, 1.6408593985214444, 1e-11, "plate centre My");
    evidence.plate = {
      bodyId,
      binding: member.binding,
      dimensions: member.dimensions,
      source: member.source,
      reportId: report.id,
      result: resultSummary(report.result),
    };

    state = await call(live.client, "plasticity_scale", {
      ids: [bodyId],
      pivotMm: [0, 0, 0],
      factors: [1, 1, 0.5],
      intent: "Disposable plate thickness applicability check",
      revision: state.revision,
    });
    const stale = await call(live.client, "plasticity_strength_report", { reportId: report.id, current: report.input });
    requireCondition(stale.freshness === "stale" && stale.reasons.includes("CAD_REVISION_CHANGED"), "Plate report did not become stale after thickness change");
    member = await inspectPlate(live.client, bodyId, state.revision);
    requireDimensions(member, [80, 40, 1]);
    const thinReport = await call(live.client, "plasticity_verify_member_strength", {
      input: plateBenchmark(member.binding, 1),
      lengthAxis: [1, 0, 0],
      heightAxis: [0, 0, 1],
    });
    requireCondition(thinReport.result.status === "unsupported", "One-millimetre plate should be outside the small-deflection passport");
    requireCondition(thinReport.result.issues.some((issue: { code: string }) => issue.code === "DEFLECTION_OUTSIDE_LINEAR_PLATE_LIMIT"), "Thin plate report omitted its large-deflection issue");
    near(thinReport.result.displacementMm, 1.3651817212343031, 1e-10, "thin plate centre deflection");

    state = await call(live.client, "plasticity_undo", { intent: "Verify plate thickness undo", revision: state.revision });
    member = await inspectPlate(live.client, bodyId, state.revision);
    requireDimensions(member, [80, 40, 2]);
    state = await call(live.client, "plasticity_redo", { intent: "Verify plate thickness redo", revision: state.revision });
    member = await inspectPlate(live.client, bodyId, state.revision);
    requireDimensions(member, [80, 40, 1]);
    state = await call(live.client, "plasticity_undo", { intent: "Restore accepted plate thickness", revision: state.revision });
    member = await inspectPlate(live.client, bodyId, state.revision);
    requireDimensions(member, [80, 40, 2]);
    evidence.staleAndHistory = {
      staleReasons: stale.reasons,
      thinReportId: thinReport.id,
      thinStatus: thinReport.result.status,
      thinIssueCodes: thinReport.result.issues.map((issue: { code: string }) => issue.code),
      thicknessHistoryMm: [2, 1, 2, 1, 2],
    };

    state = await call(live.client, "plasticity_create_box", {
      originMm: [100, 0, 0],
      sizeMm: [80, 40, 24],
      name: "Disposable integral rectangular enclosure wall",
      intent: "Approved disposable integral-wall plate acceptance",
      revision: state.revision,
    });
    const wallBodyId = state.bodies.find((candidate: { id: number }) => candidate.id !== bodyId)?.id;
    requireCondition(wallBodyId !== undefined, "Integral-wall body was not created");
    const cavity = await call(live.client, "plasticity_create_box", {
      originMm: [102, 2, 2],
      sizeMm: [76, 36, 20],
      name: "Disposable enclosure cavity cutter",
      intent: "Approved disposable integral-wall plate acceptance",
      revision: state.revision,
    });
    const cavityId = cavity.bodies.find((candidate: { id: number }) => candidate.id !== bodyId && candidate.id !== wallBodyId)?.id;
    requireCondition(cavityId !== undefined, "Integral-wall cavity cutter was not created");
    state = await call(live.client, "plasticity_boolean", {
      targetIds: [wallBodyId],
      toolIds: [cavityId],
      operation: "difference",
      keepTools: false,
      intent: "Approved disposable integral-wall plate acceptance",
      revision: cavity.revision,
    });
    const outerFace = await findPanelFace(live.client, wallBodyId, state.revision, [140, 0, 12], [0, -1, 0]);
    const innerFace = await findPanelFace(live.client, wallBodyId, state.revision, [140, 2, 12], [0, 1, 0]);
    const panel = await call(live.client, "plasticity_inspect_integral_rectangular_plate", {
      bodyId: wallBodyId,
      frontFaceId: outerFace.id,
      backFaceId: innerFace.id,
      revision: state.revision,
      xDirection: [1, 0, 0],
    });
    requireCondition(panel.status === "verified", `Integral panel inspection failed: ${JSON.stringify(panel.reasons)}`);
    requireCondition(panel.geometry, "Integral panel inspection omitted geometry");
    near(panel.geometry.lengthMm, 78, 0.01, "integral panel length");
    near(panel.geometry.widthMm, 22, 0.01, "integral panel width");
    near(panel.geometry.thicknessMm, 2, 0.01, "integral panel thickness");
    const panelInput = plateBenchmark({ ...panel.binding, bodyId: wallBodyId }, 2, 78, 22);
    const panelReport = await call(live.client, "plasticity_verify_integral_plate_strength", {
      input: panelInput,
      frontFaceId: outerFace.id,
      backFaceId: innerFace.id,
      xDirection: [1, 0, 0],
    });
    near(panelReport.input.lengthMm, 78, 0.01, "verified integral panel length");
    near(panelReport.input.widthMm, 22, 0.01, "verified integral panel width");
    near(panelReport.input.heightMm, 2, 0.01, "verified integral panel thickness");
    requireCondition(panelReport.result.method === "simply-supported-plate-uniform-pressure-v1", "Integral wall did not use the plate method");
    requireCondition(panelReport.result.status === "conditional", `Integral wall material uncertainty was lost: ${String(panelReport.result.status)}`);
    evidence.integralWall = {
      bodyId: wallBodyId,
      faceIds: { outer: outerFace.id, inner: innerFace.id },
      dimensions: panel.geometry,
      reportId: panelReport.id,
      result: resultSummary(panelReport.result),
    };

    const journal = await call(live.client, "plasticity_construction_journal", {});
    requireCleanJournal(journal);
    state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable enclosure cavity Boolean", revision: state.revision });
    state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable enclosure cavity cutter", revision: state.revision });
    state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable enclosure wall", revision: state.revision });
    state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable pressure plate", revision: state.revision });
    requireCondition(state.documentToken === initialState.documentToken, "Cleanup switched Plasticity documents");
    requireCondition(state.bodies.length === 0, "Cleanup did not restore the empty document");
    const finalJournal = await call(live.client, "plasticity_construction_journal", {});
    requireCleanJournal(finalJournal);
    const changes = await call(live.client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(changes.diff), "Scene content differs from the initial empty snapshot after cleanup");
    evidence.cleanup = {
      restoredEmptyDocument: true,
      sceneContentsRestored: true,
      journalSyncStatus: finalJournal.syncStatus,
      uncertainJournalEntries: finalJournal.entries.filter((entry: { status: string }) => entry.status === "unknown").length,
      revisionChanged: changes.diff.fromRevision !== changes.diff.toRevision,
    };

    evidence.completedAt = new Date().toISOString();
    await writeExclusive(join(output, "evidence.json"), sanitizeEvidence(evidence));
    console.log(JSON.stringify({ ok: true, output, evidence: join(output, "evidence.json") }, null, 2));
  } catch (error) {
    evidence.failure = boundedError(error);
    if (live && initialState && !evidence.cleanup) {
      evidence.cleanup = await recoverDisposableScene(live.client, initialState).catch((cleanupError) => ({
        restoredEmptyDocument: false,
        reason: boundedError(cleanupError),
      }));
    }
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
    env: {
      ...selectedEnvironment(process.env),
      PLASTICITY_STRENGTH_ROOT: storeRoot,
      PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223",
    },
    stderr: "pipe",
  });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk) => {
    stderr.push(String(chunk).slice(-4_096));
    while (stderr.join("").length > 16_384) stderr.shift();
  });
  const client = new Client({ name: "plasticity-plate-strength-live", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await client.callTool({ name, arguments: args });
  if ("isError" in response && response.isError) throw new Error(toolText(response));
  return JSON.parse(toolText(response));
}

function toolText(response: unknown): string {
  if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) {
    throw new Error("MCP tool returned no content");
  }
  const item = response.content.find((entry): entry is { type: "text"; text: string } =>
    typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string"
  );
  if (!item) throw new Error("MCP tool returned no text content");
  return item.text;
}

async function inspectPlate(client: Client, bodyId: number, revision: string): Promise<any> {
  return await call(client, "plasticity_inspect_rectangular_member", {
    bodyId,
    revision,
    lengthAxis: [1, 0, 0],
    heightAxis: [0, 0, 1],
  });
}

async function findPanelFace(client: Client, bodyId: number, revision: string, pointMm: [number, number, number], normal: [number, number, number]): Promise<any> {
  const result = await call(client, "plasticity_find_faces", {
    revision,
    query: {
      bodyIds: [bodyId],
      planar: true,
      normal: { vector: normal, toleranceDeg: 0.01, oriented: true },
      edgeCount: 4,
    },
  });
  const matches = result.matches.filter((face: any) => face.centerMm?.every((value: number, axis: number) => Math.abs(value - pointMm[axis]!) <= 0.01));
  requireCondition(matches.length === 1, `Expected one integral wall face at ${pointMm}, found ${matches.length}; candidates=${JSON.stringify(result.matches.map((face: any) => ({ id: face.id, centerMm: face.centerMm, normal: face.normal, boundsMm: face.boundsMm })))}`);
  return matches[0];
}

function plateBenchmark(binding: StrengthInput["binding"], thicknessMm = 2, lengthMm = 80, widthMm = 40): StrengthInput {
  const evidence: Evidence[] = [];
  const assignments: Record<string, string> = {};
  const add = (
    id: string,
    path: string,
    value: number,
    unit: NonNullable<Evidence["unit"]>,
    status: Evidence["status"],
    sourceLocator?: string,
  ): string => {
    evidence.push({ id, label: `SYNTHETIC acceptance ${path}`, status, unit, value, ...(sourceLocator ? { sourceLocator } : {}), dependsOn: [] });
    assignments[path] = id;
    return id;
  };
  const length = add("length", "lengthMm", lengthMm, "mm", "assumed");
  const width = add("width", "widthMm", widthMm, "mm", "assumed");
  const height = add("height", "heightMm", thicknessMm, "mm", "assumed");
  const pressure = add("pressure", "pressureMPa", 0.01, "MPa", "assumed");
  const poisson = add("poisson", "poissonRatio", 0.35, "ratio", "sourced", "synthetic-software-acceptance-fixture");
  const young = add("young", "material.youngMPa", 2_000, "MPa", "sourced", "synthetic-software-acceptance-fixture");
  const tensile = add("tensile", "material.tensileLimitMPa", 20, "MPa", "sourced", "synthetic-software-acceptance-fixture");
  const compressive = add("compressive", "material.compressiveLimitMPa", 20, "MPa", "sourced", "synthetic-software-acceptance-fixture");
  const safety = add("safety", "safetyFactor", 2, "ratio", "assumed");
  const displacement = add("displacement", "maxDisplacementMm", 0.5, "mm", "assumed");
  return {
    goal: "SYNTHETIC live rectangular-plate benchmark; not printable material data",
    method: "simply-supported-plate-uniform-pressure-v1",
    lengthMm,
    widthMm,
    heightMm: thicknessMm,
    pressureMPa: 0.01,
    poissonRatio: 0.35,
    material: {
      id: "synthetic-live-plate-material",
      name: "SYNTHETIC acceptance material; not for printing",
      evidenceIds: [young, tensile, compressive],
      youngMPa: 2_000,
      tensileLimitMPa: 20,
      compressiveLimitMPa: 20,
      suitability: "unconfirmed",
      manufacturing: {
        printerId: "synthetic-none",
        profileHash: "synthetic-not-printable",
        orientationDeg: [0, 0, 0],
        infillPercent: 100,
        temperatureC: 20,
        effectiveSection: "solid",
      },
    },
    safetyFactor: 2,
    maxDisplacementMm: 0.5,
    evidence,
    assignments,
    assumptions: [
      { code: "static-load", confirmed: true, evidenceIds: [pressure] },
      { code: "uniform-pressure", confirmed: true, evidenceIds: [pressure] },
      { code: "ideal-simply-supported-four-edges", confirmed: true, evidenceIds: [] },
      { code: "linear-elastic", confirmed: true, evidenceIds: [young] },
      { code: "homogeneous-isotropic-equivalent-plate", confirmed: true, evidenceIds: [young, poisson] },
      { code: "thin-plate-kinematics", confirmed: true, evidenceIds: [length, width, height] },
    ],
    ...(binding === undefined ? {} : { binding: structuredClone(binding) }),
  };
}

function requireDimensions(member: any, expected: [number, number, number]): void {
  requireCondition(member?.status === "verified" && member.dimensions, `Plate geometry was not verified: ${JSON.stringify(member?.reasons ?? [])}`);
  near(member.dimensions.lengthMm, expected[0], 0.01, "plate length");
  near(member.dimensions.widthMm, expected[1], 0.01, "plate width");
  near(member.dimensions.heightMm, expected[2], 0.01, "plate thickness");
}

function resultSummary(result: any): Record<string, unknown> {
  return {
    status: result.status,
    method: result.method,
    methodVersion: result.methodVersion,
    stressMPa: result.stressMPa,
    displacementMm: result.displacementMm,
    strengthUtilization: result.strengthUtilization,
    displacementUtilization: result.displacementUtilization,
    plate: result.plate,
    issueCodes: result.issues.map((issue: { code: string }) => issue.code),
    unchecked: result.unchecked,
  };
}

function requireCleanJournal(journal: any): void {
  requireCondition(journal.syncStatus === "in-sync", `Construction journal is ${String(journal.syncStatus)}`);
  requireCondition(!journal.entries.some((entry: { status: string }) => entry.status === "unknown"), "Construction journal contains an uncertain mutation");
}

function near(actual: number, expected: number, tolerance: number, label: string): void {
  requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`);
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function stateSummary(state: any): Record<string, unknown> {
  return { revision: state.revision, bodyCount: state.bodies.length, undoDepth: state.undoDepth, redoDepth: state.redoDepth };
}

async function recoverDisposableScene(client: Client, initialState: any): Promise<Record<string, unknown>> {
  let state = await call(client, "plasticity_status", {});
  if (state.documentToken !== initialState.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" };
  const journal = await call(client, "plasticity_construction_journal", {});
  if (journal.syncStatus === "manual-edit-detected" || journal.entries.some((entry: { status: string }) => entry.status === "unknown")) {
    return { restoredEmptyDocument: false, reason: "manual-or-uncertain-edit-detected" };
  }
  let undoCount = 0;
  while (state.bodies.length > 0 && state.undoDepth > initialState.undoDepth && undoCount < 16) {
    state = await call(client, "plasticity_undo", { intent: "Plate acceptance failure cleanup", revision: state.revision });
    undoCount += 1;
  }
  return { restoredEmptyDocument: state.documentToken === initialState.documentToken && state.bodies.length === 0, bodyCount: state.bodies.length, undoCount };
}

async function writeExclusive(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

function selectedEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ["CODEX_HOME", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "SSL_CERT_FILE", "LANG", "LC_ALL"]) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replaceAll(/\s+/g, " ").slice(0, 1_000);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(boundedError(error));
    process.exitCode = 1;
  });
}
