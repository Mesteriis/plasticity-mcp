#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, open, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { Evidence, StrengthInput } from "../src/strength/contracts.ts";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const LIVE_CODEX_TIMEOUT_MS = 180_000;

export interface AcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  liveCodex: boolean;
  output?: string;
  image?: string;
}

export interface LiveMcp {
  client: Client;
  transport: StdioClientTransport;
  stderr: string[];
}

interface EvidenceDocument {
  schemaVersion: 1;
  startedAt: string;
  completedAt?: string;
  targetId: string;
  initial: unknown;
  codex?: unknown;
  interview?: unknown;
  cancellation?: unknown;
  benchmark?: unknown;
  geometry?: unknown;
  eulerColumn?: unknown;
  staleAndHistory?: unknown;
  unsupported?: unknown;
  cleanup?: unknown;
  restart?: unknown;
  workbenchUsed: false;
  failure?: string;
}

export function parseAcceptanceArgs(argv: string[]): AcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false, liveCodex: false };
  const options: AcceptanceOptions = { help: false, allowDisposableMutations: false, liveCodex: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--allow-disposable-mutations") options.allowDisposableMutations = true;
    else if (argument === "--live-codex") options.liveCodex = true;
    else if (argument === "--target") {
      const value = argv[++index];
      if (!value) throw new Error("--target requires an explicit Plasticity window ID");
      options.target = value;
    } else if (argument === "--output") {
      const value = argv[++index];
      if (!value) throw new Error("--output requires a new directory path");
      options.output = value;
    } else if (argument === "--image") {
      const value = argv[++index];
      if (!value || !isAbsolute(value)) throw new Error("--image requires an absolute PNG or JPEG path");
      if (options.image) throw new Error("Only one --image may be supplied per live acceptance run");
      options.image = value;
    } else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Live acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Live acceptance requires --allow-disposable-mutations");
  if (!options.liveCodex) throw new Error("Live acceptance requires --live-codex");
  if (!options.output) throw new Error("Live acceptance requires --output with a new directory");
  return options;
}

export function strengthSketchPrompt(imageAttached: boolean): string {
  return imageAttached
    ? "The attached synthetic black-and-white image is an unscaled concept sketch of a mounting bracket. Describe only visible facts, mark exact scale and dimensions unknown, and do not assume its gusseted shape is a constant rectangular member. Ask at most one next-step question package: start by clarifying what it supports, expected load/use and how it is mounted; defer section, material/process and displacement until the answer narrows the next decision."
    : "No image is attached in this text-only acceptance case. Analyze the described synthetic unscaled concept sketch of a gusseted mounting bracket without assuming exact scale or dimensions or treating it as a constant rectangular member. Ask at most one next-step question package, starting with what it supports, expected load/use and mounting; defer section, material/process and displacement until the answer narrows the next decision.";
}

export function isDisposableEmptyDocument(state: unknown): boolean {
  if (!isRecord(state) || state.undoDepth !== 0 || state.redoDepth !== 0) return false;
  for (const key of ["bodies", "regions", "instances", "referenceMeshes", "measurements", "sectionAnalyses"] as const) {
    if (!Array.isArray(state[key]) || state[key].length !== 0) return false;
  }
  if (!Array.isArray(state.groups)) return false;
  return state.groups.every((group) => isRecord(group)
    && isEmptyArray(group.bodyIds)
    && isEmptyArray(group.instanceIds)
    && isEmptyArray(group.referenceMeshIds)
    && isEmptyArray(group.otherNodeKeys)
    && isEmptyArray(group.childGroupIds));
}

const HELP = `Usage:
  node scripts/verify-strength-live.ts --help
  node scripts/verify-strength-live.ts --target ID --allow-disposable-mutations --live-codex --output NEW_DIRECTORY
  node scripts/verify-strength-live.ts --target ID --allow-disposable-mutations --live-codex --output NEW_DIRECTORY --image /absolute/path/to/sketch.png

With no arguments or --help, this command performs no mutations and no Codex calls.
Live mode refuses a nonempty Plasticity document, never chooses a window automatically,
uses a separate stdio MCP process, and writes only sanitized evidence to a new directory.`;

async function main(): Promise<void> {
  const options = parseAcceptanceArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const storeRoot = join(output, "strength-store");
  const evidence: EvidenceDocument = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    targetId: options.target!,
    initial: null,
    workbenchUsed: false,
  };
  let live: LiveMcp | undefined;
  let initialState: any;
  let stagedImage: { path: string; format: "png" | "jpeg" | "heic" | "heif"; byteSize: number } | undefined;
  try {
    stagedImage = options.image ? await stageImage(options.image, output) : undefined;
    live = await startMcp(storeRoot, output);
    const methods = await call(live.client, "plasticity_strength_methods", {});
    requireCondition(methods.analysis?.available === true, `Codex analysis unavailable: ${String(methods.analysis?.reason ?? "unknown")}`);

    const windows = await call(live.client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    initialState = await call(live.client, "plasticity_connect", { targetId: options.target });
    requireCondition(isDisposableEmptyDocument(initialState), "Refusing disposable mutations unless the selected Plasticity document and its Undo/Redo history are completely empty");
    evidence.initial = stateSummary(initialState);
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "strength-live-initial-empty" });

    const analysisRequest = {
      requestId: "live-unscaled-sketch",
      prompt: strengthSketchPrompt(stagedImage !== undefined),
      imagePaths: stagedImage ? [stagedImage.path] : [],
      evidence: [],
      answers: [],
    };
    const analysis = await call(live.client, "plasticity_analyze_strength_task", analysisRequest, LIVE_CODEX_TIMEOUT_MS);
    requireCondition(analysis.state === "completed", `Live analysis did not complete: ${analysis.state}`);
    const unknownScale = analysis.result.observations.some((item: { status: string; label: string }) =>
      item.status === "unknown" && /scale|dimension|size/i.test(item.label)
    ) || analysis.result.questions.some((item: { question: string }) => /dimension|length|width|height|distance|scale/i.test(item.question));
    requireCondition(unknownScale, "Structured analysis did not preserve unknown scale");
    requireCondition(analysis.result.questions.length === 1, "Unscaled bracket analysis must ask exactly one next-step question package");
    evidence.codex = {
      requestId: analysis.id,
      state: analysis.state,
      proposedMethod: analysis.result.proposedMethod,
      observationStatuses: analysis.result.observations.map((item: { status: string }) => item.status),
      questionCount: analysis.result.questions.length,
      unknownScale,
      image: stagedImage ? { included: true, format: stagedImage.format, byteSize: stagedImage.byteSize } : { included: false },
    };

    const firstQuestion = analysis.result.questions[0];
    const followupAnswer = "I don't know the load magnitude, supported object or mounting details yet. I only know it will be stationary indoors, with no expected impact or repeated movement.";
    const followup = await call(live.client, "plasticity_analyze_strength_task", {
      ...analysisRequest,
      requestId: "live-unscaled-sketch-followup",
      answers: [{ questionId: firstQuestion.id, question: firstQuestion.question, answer: followupAnswer }],
    }, LIVE_CODEX_TIMEOUT_MS);
    requireCondition(followup.state === "completed", `Follow-up analysis did not complete: ${followup.state}`);
    requireCondition(followup.result.questions.length === 1, "Follow-up must ask exactly one focused next-step question package");
    requireCondition(followup.result.questions[0].id !== firstQuestion.id, "Follow-up repeated the previous unresolved question ID");
    evidence.interview = {
      firstTurnQuestionPackages: analysis.result.questions.length,
      answerProvided: true,
      priorQuestionTextProvided: true,
      followupTurnQuestionPackages: followup.result.questions.length,
      followupQuestionResolves: followup.result.questions[0].resolves,
      questionPackagesPerTurnWithinLimit: true,
    };

    const cancelled = await cancelLiveAnalysis(live, "live-cancelled-analysis");
    requireCondition(cancelled.state === "interrupted", `Cancelled analysis ended as ${cancelled.state}`);
    const survivingChildren = await ownedCodexChildren(live.transport.pid);
    requireCondition(survivingChildren.length === 0, `Owned Codex process survived cancellation: ${survivingChildren.join(", ")}`);
    evidence.cancellation = { requestId: cancelled.id, state: cancelled.state, survivingOwnedProcesses: 0 };

    const benchmarkInput = syntheticBenchmark(10);
    const sizing = await call(live.client, "plasticity_size_member", {
      input: benchmarkInput,
      heightsMm: [7, 8, 9, 10],
    });
    const candidate9 = sizing.candidates.find((item: { heightMm: number }) => item.heightMm === 9);
    const candidate10 = sizing.candidates.find((item: { heightMm: number }) => item.heightMm === 10);
    near(candidate9.result.stressMPa, 0.7407407407, 1e-8, "candidate 9 stress");
    near(candidate9.result.displacementMm, 1.09739369, 1e-8, "candidate 9 displacement");
    near(candidate10.result.stressMPa, 0.6, 1e-10, "candidate 10 stress");
    near(candidate10.result.displacementMm, 0.8, 1e-10, "candidate 10 displacement");
    requireCondition(sizing.recommendedHeightMm === 10 && sizing.recommendation === "conditional", "Unexpected candidate recommendation");
    evidence.benchmark = {
      candidates: sizing.candidates.map((item: { heightMm: number; result: { status: string; stressMPa?: number; displacementMm?: number } }) => ({
        heightMm: item.heightMm,
        status: item.result.status,
        stressMPa: item.result.stressMPa,
        displacementMm: item.result.displacementMm,
      })),
      recommendedHeightMm: sizing.recommendedHeightMm,
      recommendation: sizing.recommendation,
    };

    let state = await call(live.client, "plasticity_create_box", {
      originMm: [0, 0, 0],
      sizeMm: [200, 20, 10],
      name: "Disposable strength benchmark",
      intent: "Approved disposable live strength acceptance package",
      revision: initialState.revision,
    });
    requireCondition(state.bodies.length === 1, "Benchmark box did not create exactly one body");
    const bodyId = state.bodies[0].id;
    let member = await call(live.client, "plasticity_inspect_rectangular_member", {
      bodyId,
      revision: state.revision,
      lengthAxis: [1, 0, 0],
      heightAxis: [0, 0, 1],
    });
    requireVerifiedDimensions(member, [200, 20, 10]);
    const boundInput = { ...benchmarkInput, binding: member.binding };
    const report10 = await call(live.client, "plasticity_verify_member_strength", {
      input: boundInput,
      lengthAxis: [1, 0, 0],
      heightAxis: [0, 0, 1],
    });
    near(report10.result.stressMPa, 0.6, 1e-10, "verified stress");
    near(report10.result.displacementMm, 0.8, 1e-10, "verified displacement");
    requireCondition(report10.result.status === "conditional", "Synthetic material provenance must remain conditional");
    evidence.geometry = {
      bodyId,
      binding: member.binding,
      dimensions: member.dimensions,
      source: member.source,
      reportId: report10.id,
      status: report10.result.status,
      stressMPa: report10.result.stressMPa,
      displacementMm: report10.result.displacementMm,
    };

    const eulerColumn = await call(live.client, "plasticity_verify_member_strength", {
      input: { ...syntheticEulerBenchmark(), binding: member.binding },
      lengthAxis: [1, 0, 0],
      heightAxis: [0, 0, 1],
    });
    requireCondition(eulerColumn.result.method === "euler-column-buckling-v1", "Member verification did not preserve the Euler column method");
    requireCondition(eulerColumn.result.status === "conditional", "Synthetic material properties must remain conditional");
    near(eulerColumn.result.buckling.secondMomentMm4, 1_666.6666666666667, 1e-10, "Euler weak-axis second moment");
    near(eulerColumn.result.buckling.criticalLoadN, 822.4670334241132, 1e-9, "Euler critical load");
    near(eulerColumn.result.buckling.bucklingUtilization, 200 / 822.4670334241132, 1e-12, "Euler utilization");
    requireCondition(eulerColumn.result.issues.some((issue: { code: string }) => issue.code === "MATERIAL_UNCONFIRMED"), "Synthetic material uncertainty was not preserved");
    const eulerFreshness = await call(live.client, "plasticity_strength_report", {
      reportId: eulerColumn.id,
      current: eulerColumn.input,
    });
    requireCondition(eulerFreshness.freshness === "current", "New Euler report was not current against its exact live B-rep binding");
    const eulerEvidence = {
      reportId: eulerColumn.id,
      method: eulerColumn.result.method,
      status: eulerColumn.result.status,
      exactDimensionsMm: [eulerColumn.input.lengthMm, eulerColumn.input.widthMm, eulerColumn.input.heightMm],
      weakAxisSecondMomentMm4: eulerColumn.result.buckling.secondMomentMm4,
      criticalLoadN: eulerColumn.result.buckling.criticalLoadN,
      criticalStressMPa: eulerColumn.result.buckling.criticalStressMPa,
      bucklingUtilization: eulerColumn.result.buckling.bucklingUtilization,
      compressiveUtilization: eulerColumn.result.buckling.compressiveUtilization,
      freshnessBeforeEdit: eulerFreshness.freshness,
      materialConditional: true,
    };
    evidence.eulerColumn = eulerEvidence;

    state = await call(live.client, "plasticity_scale", {
      ids: [bodyId],
      pivotMm: [0, 0, 0],
      factors: [1, 1, 0.8],
      intent: "Disposable failing supported section",
      revision: state.revision,
    });
    const stale = await call(live.client, "plasticity_strength_report", { reportId: report10.id, current: report10.input });
    requireCondition(stale.freshness === "stale" && stale.reasons.includes("CAD_REVISION_CHANGED"), "Old bound report did not become stale");
    const staleEuler = await call(live.client, "plasticity_strength_report", {
      reportId: eulerColumn.id,
      current: eulerColumn.input,
    });
    requireCondition(staleEuler.freshness === "stale" && staleEuler.reasons.includes("CAD_REVISION_CHANGED"), "Euler report did not become stale after the native Solid changed");
    evidence.eulerColumn = { ...eulerEvidence, freshnessAfterEdit: staleEuler.freshness, staleReasons: staleEuler.reasons };
    member = await call(live.client, "plasticity_inspect_rectangular_member", {
      bodyId,
      revision: state.revision,
      lengthAxis: [1, 0, 0],
      heightAxis: [0, 0, 1],
    });
    requireVerifiedDimensions(member, [200, 20, 8]);
    const report8 = await call(live.client, "plasticity_verify_member_strength", {
      input: { ...syntheticBenchmark(8), binding: member.binding },
      lengthAxis: [1, 0, 0],
      heightAxis: [0, 0, 1],
    });
    near(report8.result.stressMPa, 0.9375, 1e-10, "failing section stress");
    near(report8.result.displacementMm, 1.5625, 1e-10, "failing section displacement");
    requireCondition(report8.result.status === "fail", "8 mm section must fail the displacement limit");

    state = await call(live.client, "plasticity_undo", { intent: "Verify scale undo", revision: state.revision });
    member = await inspect(live.client, bodyId, state.revision);
    requireVerifiedDimensions(member, [200, 20, 10]);
    state = await call(live.client, "plasticity_redo", { intent: "Verify scale redo", revision: state.revision });
    member = await inspect(live.client, bodyId, state.revision);
    requireVerifiedDimensions(member, [200, 20, 8]);
    state = await call(live.client, "plasticity_undo", { intent: "Restore selected 10 mm section", revision: state.revision });
    member = await inspect(live.client, bodyId, state.revision);
    requireVerifiedDimensions(member, [200, 20, 10]);
    evidence.staleAndHistory = {
      staleReasons: stale.reasons,
      changedReportId: report8.id,
      changedStatus: report8.result.status,
      changedStressMPa: report8.result.stressMPa,
      changedDisplacementMm: report8.result.displacementMm,
      undoRedoDimensionsMm: [[200, 20, 10], [200, 20, 8], [200, 20, 10]],
    };

    const withCylinder = await call(live.client, "plasticity_create_cylinder", {
      centerMm: [100, 10, -1],
      radiusMm: 2,
      heightMm: 12,
      axis: [0, 0, 1],
      name: "Disposable hole cutter",
      intent: "Same-bounds unsupported topology check",
      revision: state.revision,
    });
    const cutter = withCylinder.bodies.find((body: { id: number }) => body.id !== bodyId);
    requireCondition(cutter !== undefined, "Hole cutter was not created");
    state = await call(live.client, "plasticity_boolean", {
      targetIds: [bodyId],
      toolIds: [cutter.id],
      operation: "difference",
      keepTools: false,
      intent: "Same-bounds unsupported topology check",
      revision: withCylinder.revision,
    });
    const holed = await inspect(live.client, bodyId, state.revision);
    requireCondition(holed.status === "unsupported", "Holed same-bounds body passed the rectangular-member gate");
    evidence.unsupported = { status: holed.status, reasons: holed.reasons };

    state = await call(live.client, "plasticity_undo", { intent: "Remove disposable Boolean", revision: state.revision });
    state = await call(live.client, "plasticity_undo", { intent: "Remove disposable cutter", revision: state.revision });
    state = await call(live.client, "plasticity_undo", { intent: "Remove disposable benchmark", revision: state.revision });
    requireCondition(state.documentToken === initialState.documentToken, "Cleanup switched documents");
    requireCondition(state.bodies.length === 0, "Cleanup did not restore the empty document");
    const changes = await call(live.client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(changes.diff), "Scene content differs from the initial empty snapshot after cleanup");
    evidence.cleanup = {
      restoredEmptyDocument: true,
      documentToken: state.documentToken,
      sceneContentsRestored: true,
      revisionChanged: changes.diff.fromRevision !== changes.diff.toRevision,
    };

    const unfinishedRequest = {
      requestId: "live-restart-interrupted",
      prompt: "Analyze this synthetic unscaled rectangular bracket and list only the missing dimensions and load facts. Do not use tools.",
      imagePaths: [], evidence: [], answers: [],
    };
    const unfinished = live.client.callTool({ name: "plasticity_analyze_strength_task", arguments: unfinishedRequest });
    await waitForRequestState(live.client, unfinishedRequest.requestId, "requested", 10_000);
    const oldPid = live.transport.pid;
    requireCondition(oldPid !== null, "Test MCP process PID is unavailable");
    const ownedBeforeRestart = await ownedCodexChildren(oldPid);
    process.kill(oldPid, "SIGTERM");
    await Promise.allSettled([unfinished]);
    await waitForProcessExit(oldPid, 10_000);
    for (const child of ownedBeforeRestart) {
      const childPid = Number(child.match(/^(\d+)/)?.[1]);
      if (Number.isInteger(childPid)) await waitForProcessExit(childPid, 10_000);
    }
    await live.transport.close().catch(() => {});
    live = undefined;

    const restarted = await startMcp(storeRoot, output);
    live = restarted;
    const replay = await call(restarted.client, "plasticity_analyze_strength_task", unfinishedRequest);
    requireCondition(replay.state === "interrupted", `Restart replay returned ${replay.state}`);
    const survivingAfterReplay = await ownedCodexChildren(restarted.transport.pid);
    requireCondition(survivingAfterReplay.length === 0, "Restart replay started another Codex process");
    const persistedReport = await call(restarted.client, "plasticity_strength_report", { reportId: report10.id });
    requireCondition(persistedReport.freshness !== "current", "Restarted CAD-bound report was incorrectly current without revalidation");
    evidence.restart = {
      requestId: replay.id,
      requestState: replay.state,
      reportId: report10.id,
      reportFreshness: persistedReport.freshness,
      reportReasons: persistedReport.reasons,
      ownedProcessesBeforeRestart: ownedBeforeRestart.length,
      replayOwnedProcesses: 0,
    };

    evidence.completedAt = new Date().toISOString();
    await writeExclusive(join(output, "evidence.json"), evidence);
    console.log(JSON.stringify({ ok: true, output, evidence: join(output, "evidence.json") }, null, 2));
  } catch (error) {
    evidence.failure = boundedError(error);
    if (live && initialState && !evidence.cleanup) {
      evidence.cleanup = await recoverDisposableScene(live.client, initialState).catch((cleanupError) => ({
        restoredEmptyDocument: false,
        reason: boundedError(cleanupError),
      }));
    }
    await writeExclusive(join(output, "failure.json"), evidence).catch(() => {});
    throw error;
  } finally {
    await live?.client.close().catch(() => {});
  }
}

export async function stageImage(sourcePath: string, output: string, name = "analysis-input"): Promise<{ path: string; format: "png" | "jpeg" | "heic" | "heif"; byteSize: number }> {
  const source = await realpath(sourcePath);
  const extension = extname(source).toLowerCase();
  const format = extension === ".png" ? "png"
    : extension === ".jpg" || extension === ".jpeg" ? "jpeg"
      : extension === ".heic" ? "heic"
        : extension === ".heif" ? "heif"
          : undefined;
  if (!format) throw new Error("Live acceptance image must use the .png, .jpg, .jpeg, .heic, or .heif extension");
  const metadata = await stat(source);
  if (!metadata.isFile()) throw new Error("Live acceptance image must be a regular file");
  if (metadata.size > 20 * 1024 * 1024) throw new Error("Live acceptance image exceeds 20 MiB");
  const path = join(output, `${name}${extension}`);
  const bytes = await readFile(source);
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(bytes); } finally { await handle.close(); }
  return { path, format, byteSize: metadata.size };
}

export async function startMcp(storeRoot: string, assetRoot: string): Promise<LiveMcp> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(projectRoot, "scripts", "run-server.ts")],
    cwd: projectRoot,
    env: {
      ...selectedEnvironment(process.env),
      PLASTICITY_STRENGTH_ROOT: storeRoot,
      PLASTICITY_STRENGTH_ASSET_ROOT: assetRoot,
      PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223",
    },
    stderr: "pipe",
  });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk) => {
    stderr.push(String(chunk).slice(-4_096));
    while (stderr.join("").length > 16_384) stderr.shift();
  });
  const client = new Client({ name: "plasticity-strength-live", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport, stderr };
}

export async function call(client: Client, name: string, args: Record<string, unknown>, timeout?: number): Promise<any> {
  const response = await client.callTool({ name, arguments: args }, undefined, timeout === undefined ? undefined : { timeout });
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

async function cancelLiveAnalysis(live: LiveMcp, requestId: string): Promise<any> {
  const request = {
    requestId,
    prompt: "Synthetic unscaled rectangle with unknown dimensions. Identify only missing strength inputs and do not use any tools.",
    imagePaths: [], evidence: [], answers: [],
  };
  const controller = new AbortController();
  const running = live.client.callTool({ name: "plasticity_analyze_strength_task", arguments: request }, undefined, { signal: controller.signal });
  await waitForRequestState(live.client, requestId, "requested", 10_000);
  controller.abort();
  await Promise.allSettled([running]);
  return await waitForTerminalRequest(live.client, requestId, 10_000);
}

async function waitForRequestState(client: Client, requestId: string, expected: string, timeoutMs: number): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const record = await call(client, "plasticity_strength_request", { requestId });
      if (record.state === expected) return record;
      if (record.state !== "requested") throw new Error(`Request became ${record.state} before ${expected} was observed`);
    } catch (error) {
      if (!/ENOENT|no such file/i.test(boundedError(error))) throw error;
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for request ${requestId} to become ${expected}`);
}

async function waitForTerminalRequest(client: Client, requestId: string, timeoutMs: number): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = await call(client, "plasticity_strength_request", { requestId });
    if (record.state !== "requested") return record;
    await delay(20);
  }
  throw new Error(`Timed out waiting for terminal request ${requestId}`);
}

async function inspect(client: Client, bodyId: number, revision: string): Promise<any> {
  return await call(client, "plasticity_inspect_rectangular_member", {
    bodyId, revision, lengthAxis: [1, 0, 0], heightAxis: [0, 0, 1],
  });
}

function syntheticBenchmark(heightMm: number): StrengthInput {
  const values: Array<[string, string, Evidence["status"], NonNullable<Evidence["unit"]>, number]> = [
    ["length", "SYNTHETIC benchmark length", "assumed", "mm", 200],
    ["width", "SYNTHETIC benchmark width", "assumed", "mm", 20],
    ["height", "SYNTHETIC benchmark candidate height", "derived", "mm", heightMm],
    ["force", "SYNTHETIC benchmark tip load", "assumed", "N", 1],
    ["young", "SYNTHETIC benchmark Young modulus", "assumed", "MPa", 2000],
    ["tensile", "SYNTHETIC benchmark tensile limit", "assumed", "MPa", 30],
    ["compressive", "SYNTHETIC benchmark compressive limit", "assumed", "MPa", 30],
    ["safety", "SYNTHETIC benchmark safety factor", "assumed", "ratio", 2],
    ["displacement", "SYNTHETIC benchmark displacement limit", "assumed", "mm", 1],
  ];
  const evidence: Evidence[] = values.map(([id, label, status, unit, value]) => ({ id, label, status, unit, value, dependsOn: [] }));
  return {
    goal: "SYNTHETIC live cantilever benchmark; not printable material data",
    method: "cantilever-tip-rectangle-v1",
    lengthMm: 200,
    widthMm: 20,
    heightMm,
    forceN: 1,
    material: {
      id: "synthetic-live-material",
      name: "SYNTHETIC benchmark material; not for printing",
      evidenceIds: ["young", "tensile", "compressive"],
      youngMPa: 2000,
      tensileLimitMPa: 30,
      compressiveLimitMPa: 30,
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
    maxDisplacementMm: 1,
    evidence,
    assignments: {
      lengthMm: "length", widthMm: "width", heightMm: "height", forceN: "force",
      "material.youngMPa": "young", "material.tensileLimitMPa": "tensile",
      "material.compressiveLimitMPa": "compressive", safetyFactor: "safety",
      maxDisplacementMm: "displacement",
    },
    assumptions: [
      { code: "static-load", confirmed: true, evidenceIds: ["force"] },
      { code: "ideal-support", confirmed: true, evidenceIds: [] },
      { code: "linear-elastic", confirmed: true, evidenceIds: ["young"] },
      { code: "homogeneous-equivalent-section", confirmed: true, evidenceIds: ["young"] },
      { code: "negligible-shear-deformation", confirmed: true, evidenceIds: [] },
      { code: "no-lateral-instability", confirmed: true, evidenceIds: [] },
    ],
  };
}

export function syntheticEulerBenchmark(): StrengthInput {
  const base = syntheticBenchmark(10);
  const evidence = base.evidence.map((item) => {
    if (item.id === "young" || item.id === "compressive") {
      return { ...item, status: "derived" as const, derivation: "SYNTHETIC acceptance value; not a material property" };
    }
    if (item.id === "force") return { ...item, value: -100 };
    return item;
  });
  evidence.push(
    { id: "elastic-limit", label: "SYNTHETIC elastic limit; not a material property", status: "derived", unit: "MPa", value: 20, dependsOn: [], derivation: "SYNTHETIC acceptance value only" },
    { id: "effective-length", label: "SYNTHETIC effective-length factor; ideal pinned ends", status: "derived", unit: "ratio", value: 1, dependsOn: [], derivation: "SYNTHETIC acceptance idealization only" },
  );
  return {
    ...base,
    goal: "SYNTHETIC Euler column acceptance; not printable material data",
    method: "euler-column-buckling-v1",
    forceN: -100,
    effectiveLengthFactor: 1,
    material: {
      ...base.material,
      evidenceIds: [...base.material.evidenceIds, "elastic-limit"],
      elasticLimitMPa: 20,
      suitability: "unconfirmed",
    },
    evidence,
    assignments: {
      ...base.assignments,
      forceN: "force",
      effectiveLengthFactor: "effective-length",
      "material.elasticLimitMPa": "elastic-limit",
    },
    assumptions: [
      { code: "static-load", confirmed: true, evidenceIds: ["force"] },
      { code: "centred-axial-compression", confirmed: true, evidenceIds: ["force"] },
      { code: "straight-prismatic-column", confirmed: true, evidenceIds: ["length", "width", "height"] },
      { code: "ideal-effective-length-factor", confirmed: true, evidenceIds: ["effective-length"] },
      { code: "linear-elastic", confirmed: true, evidenceIds: ["young", "elastic-limit"] },
      { code: "homogeneous-equivalent-section", confirmed: true, evidenceIds: ["young"] },
    ],
  };
}

function requireVerifiedDimensions(member: any, expected: [number, number, number]): void {
  requireCondition(member.status === "verified", `Member inspection failed: ${JSON.stringify(member.reasons)}`);
  near(member.dimensions.lengthMm, expected[0], 0.01, "native length");
  near(member.dimensions.widthMm, expected[1], 0.01, "native width");
  near(member.dimensions.heightMm, expected[2], 0.01, "native height");
}

function near(actual: number, expected: number, tolerance: number, label: string): void {
  requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`);
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEmptyArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length === 0;
}

export function hasSceneContentChanges(diff: {
  documentChanged: boolean;
  added: unknown[];
  removed: unknown[];
  modified: unknown[];
  constructionPlanesAdded: unknown[];
  constructionPlanesRemoved: unknown[];
  constructionPlanesModified: unknown[];
  activeWorkplaneChanged: unknown | null;
}): boolean {
  return diff.documentChanged
    || diff.added.length > 0
    || diff.removed.length > 0
    || diff.modified.length > 0
    || diff.constructionPlanesAdded.length > 0
    || diff.constructionPlanesRemoved.length > 0
    || diff.constructionPlanesModified.length > 0
    || diff.activeWorkplaneChanged !== null;
}

function stateSummary(state: any): Record<string, unknown> {
  return {
    documentToken: state.documentToken,
    revision: state.revision,
    bodyCount: state.bodies.length,
    undoDepth: state.undoDepth,
    redoDepth: state.redoDepth,
  };
}

async function recoverDisposableScene(client: Client, initialState: any): Promise<Record<string, unknown>> {
  let state = await call(client, "plasticity_status", {});
  if (state.documentToken !== initialState.documentToken) {
    return { restoredEmptyDocument: false, reason: "document-changed" };
  }
  const journal = await call(client, "plasticity_construction_journal", {});
  if (journal.syncStatus === "manual-edit-detected" || journal.entries.some((entry: { status: string }) => entry.status === "unknown")) {
    return { restoredEmptyDocument: false, reason: "manual-or-uncertain-edit-detected" };
  }
  let undoCount = 0;
  while (state.bodies.length > 0 && state.undoDepth > initialState.undoDepth && undoCount < 64) {
    state = await call(client, "plasticity_undo", { intent: "Acceptance failure cleanup", revision: state.revision });
    undoCount += 1;
  }
  return {
    restoredEmptyDocument: state.documentToken === initialState.documentToken && state.bodies.length === 0,
    bodyCount: state.bodies.length,
    undoCount,
  };
}

async function ownedCodexChildren(parentPid: number | null): Promise<string[]> {
  if (parentPid === null) return [];
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  return stdout.split("\n").map((line) => line.trim()).filter((line) => {
    const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
    return match?.[2] === String(parentPid) && /codex\s+app-server.*--stdio.*--strict-config/i.test(match[3]!);
  });
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await delay(25);
  }
  throw new Error(`Test MCP process ${pid} did not exit`);
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

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(boundedError(error));
    process.exitCode = 1;
  });
}
