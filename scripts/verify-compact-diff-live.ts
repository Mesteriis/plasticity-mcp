#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BODY_COUNT = 201;
const PAGE_SIZE = 100;

export interface CompactDiffAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

export function parseCompactDiffAcceptanceArgs(argv: string[]): CompactDiffAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: CompactDiffAcceptanceOptions = { help: false, allowDisposableMutations: false };
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
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Compact-diff acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Compact-diff acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Compact-diff acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-compact-diff-live.ts --help
  node scripts/verify-compact-diff-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection or mutation.
Live mode requires an explicitly selected disposable Plasticity document with
no saved regions, instances, non-root groups, or redo history. It captures the
current scene as a baseline, creates 201 temporary boxes through the production
stdio MCP server, verifies paginated compact scene changes, then removes only
those confirmed boxes with native Undo only while the selected document matches
and its current revision matches the last confirmed mutation. Evidence
directories are never overwritten.`;

interface LiveMcp { client: Client; stderr: string[] }

async function main(): Promise<void> {
  const options = parseCompactDiffAcceptanceArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const evidence: Record<string, unknown> = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    explicitlySelectedTarget: true,
    documentMutationAttempted: false,
    confirmedCreates: 0,
    temporaryBodyCount: BODY_COUNT,
  };
  let live: LiveMcp | undefined;
  let initialState: any;
  let latestConfirmedState: any;
  let mutationOutcomeUncertain = false;
  try {
    live = await startMcp(output);
    const windows = await call(live.client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    initialState = await call(live.client, "plasticity_connect", { targetId: options.target });
    latestConfirmedState = initialState;
    evidence.preflight = {
      bodyCount: initialState.bodyPagination.total,
      undoDepth: initialState.undoDepth,
      redoDepth: initialState.redoDepth,
      regionCount: (initialState.regions ?? []).length,
      instanceCount: (initialState.instances ?? []).length,
      nonRootGroupCount: (initialState.groups ?? []).filter((group: { id: number }) => group.id !== 0).length,
    };
    requireCondition(initialState.redoDepth === 0, "Refusing disposable changes because a new edit would clear this document's redo history");
    requireCondition((initialState.regions ?? []).length === 0 && (initialState.instances ?? []).length === 0, "Refusing disposable changes in a document with regions or instances");
    requireCondition((initialState.groups ?? []).filter((group: { id: number }) => group.id !== 0).length === 0, "Refusing disposable changes while non-root groups exist");
    const initialBodyCount = initialState.bodyPagination.total;
    evidence.initial = evidence.preflight;
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "compact-diff-live-initial-baseline" });
    const mutationResponseBytes: number[] = [];

    for (let index = 0; index < BODY_COUNT; index += 1) {
      mutationOutcomeUncertain = true;
      evidence.documentMutationAttempted = true;
      const state = await call(live.client, "plasticity_create_box", {
        originMm: [index * 3, 0, 0],
        sizeMm: [1, 1, 1],
        name: `Compact diff acceptance ${String(index + 1).padStart(3, "0")}`,
        intent: "Temporary compact scene-diff acceptance geometry",
        revision: latestConfirmedState.revision,
      });
      requireCondition(bodyCount(state) === initialBodyCount + index + 1, `Create ${index + 1} returned an unexpected scene body count`);
      requireCompactMutationState(state, initialBodyCount + index + 1);
      mutationResponseBytes.push(byteCount(state));
      requireSameDocumentIdentity(latestConfirmedState, state);
      latestConfirmedState = state;
      mutationOutcomeUncertain = false;
      evidence.confirmedCreates = index + 1;
    }
    evidence.documentMutated = true;
    evidence.mutationResponses = {
      count: mutationResponseBytes.length,
      maximumBytes: Math.max(...mutationResponseBytes),
      meanBytes: Math.round(mutationResponseBytes.reduce((sum, size) => sum + size, 0) / mutationResponseBytes.length),
      maximumSummaryBodies: 20,
      changedBodySummaryPerCreate: 1,
      fullTopologyArraysOmitted: true,
    };

    const diffPages: any[] = [];
    let bodyOffset = 0;
    while (true) {
      const page = await call(live.client, "plasticity_changes_since", {
        snapshotId: snapshot.snapshotId,
        bodyOffset,
        bodyLimit: PAGE_SIZE,
        ...(diffPages.length > 0 ? { expectedRevision: latestConfirmedState.revision } : {}),
      });
      requireSameDocument(latestConfirmedState, page.current);
      if (diffPages.length === 0) requireCondition(page.diff.sceneChanged === true, "New bodies were not reported as a scene change");
      requireCondition(page.bodyPagination.total === BODY_COUNT && page.bodyPagination.offset === bodyOffset, `Compact diff page ${diffPages.length + 1} has invalid pagination metadata`);
      const expectedPageCount = Math.min(PAGE_SIZE, BODY_COUNT - bodyOffset);
      requireCondition(page.diff.added.length === expectedPageCount, `Compact diff page ${diffPages.length + 1} returned an unexpected number of added bodies`);
      requireCompactBodies(page.diff.added);
      diffPages.push(page);
      if (page.bodyPagination.nextOffset === null) break;
      requireCondition(page.bodyPagination.nextOffset === bodyOffset + expectedPageCount, "Compact diff pagination did not advance by the page size");
      bodyOffset = page.bodyPagination.nextOffset;
    }

    const addedIds = diffPages.flatMap((page) => page.diff.added).map((body: { id: number }) => body.id);
    requireCondition(new Set(addedIds).size === BODY_COUNT, "Paginated compact diff duplicated body IDs");
    const journalPages: any[] = [];
    let journalOffset = 0;
    while (true) {
      const page = await call(live.client, "plasticity_construction_journal", { offset: journalOffset, limit: PAGE_SIZE });
      requireCondition(page.journalPagination.total === BODY_COUNT && page.journalPagination.offset === journalOffset, `Construction journal page ${journalPages.length + 1} has invalid pagination metadata`);
      const expectedPageCount = Math.min(PAGE_SIZE, BODY_COUNT - journalOffset);
      requireCondition(page.entries.length === expectedPageCount, `Construction journal page ${journalPages.length + 1} returned an unexpected number of entries`);
      requireCondition(page.entries.every((entry: any) => entry.diff.added.every((body: Record<string, unknown>) => !("faces" in body) && !("edges" in body))), "Construction journal retained detailed B-Rep topology");
      journalPages.push(page);
      if (page.journalPagination.nextOffset === null) break;
      requireCondition(page.journalPagination.nextOffset === journalOffset + expectedPageCount, "Construction journal pagination did not advance by the page size");
      journalOffset = page.journalPagination.nextOffset;
    }
    const journalEntryCount = journalPages.reduce((sum, page) => sum + page.entries.length, 0);
    requireCondition(journalEntryCount === BODY_COUNT, "Construction journal pagination omitted confirmed creations");
    evidence.pagination = {
      addedBodyCount: addedIds.length,
      diffPageCounts: diffPages.map((page) => page.diff.added.length),
      noDuplicateBodyIds: true,
      changedScene: diffPages[0].diff.sceneChanged,
      journalPageCounts: journalPages.map((page) => page.entries.length),
    };
    evidence.responses = {
      connectBytes: byteCount(initialState),
      diffPageBytes: diffPages.map(byteCount),
      journalPageBytes: journalPages.map(byteCount),
    };

    latestConfirmedState = await undoConfirmedChanges(live.client, initialState, latestConfirmedState, (uncertain) => { mutationOutcomeUncertain = uncertain; });
    mutationOutcomeUncertain = false;
    const cleanedDiff = await call(live.client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireSameDocument(latestConfirmedState, cleanedDiff.current);
    evidence.cleanupDiff = summarizeCleanupDiff(cleanedDiff.diff);
    requireCondition(sceneMatchesBaseline(cleanedDiff, initialBodyCount), "Undo did not restore the initial scene content");
    requireCondition(bodyCount(latestConfirmedState) === initialBodyCount, "Undo did not restore the initial body count");
    const cleanup = { sceneContentsRestored: true, undoDepthRestored: latestConfirmedState.undoDepth === initialState.undoDepth, redoDepthAfterCleanup: latestConfirmedState.redoDepth };
    evidence.cleanup = cleanup;
    requireCondition(cleanup.undoDepthRestored, "Undo depth did not return to its initial value");
    evidence.completedAt = new Date().toISOString();
    await writeExclusive(join(output, "evidence.json"), sanitizeEvidence(evidence));
    console.log(JSON.stringify({ ok: true, output, evidence: join(output, "evidence.json"), originalSceneRestored: true, discardDisposableDocumentAfterward: true }, null, 2));
  } catch (error) {
    evidence.failure = boundedError(error);
    if (live && initialState && latestConfirmedState && !mutationOutcomeUncertain && latestConfirmedState.undoDepth > initialState.undoDepth) {
      evidence.cleanup = await undoConfirmedChanges(live.client, initialState, latestConfirmedState, (uncertain) => { mutationOutcomeUncertain = uncertain; })
        .then((state) => ({ sceneContentsRestored: bodyCount(state) === bodyCount(initialState), undoDepthRestored: state.undoDepth === initialState.undoDepth, redoDepthAfterCleanup: state.redoDepth }))
        .catch((cleanupError) => ({ sceneContentsRestored: false, reason: boundedError(cleanupError) }));
    } else if (mutationOutcomeUncertain) {
      evidence.cleanup = { sceneContentsRestored: false, reason: "native mutation outcome is uncertain; automatic Undo was refused" };
    }
    await writeExclusive(join(output, "failure.json"), sanitizeEvidence(evidence)).catch(() => {});
    throw error;
  } finally {
    await live?.client.close().catch(() => {});
  }
}

async function undoConfirmedChanges(client: Client, initial: any, latest: any, setUncertain: (uncertain: boolean) => void): Promise<any> {
  let state = latest;
  while (state.undoDepth > initial.undoDepth) {
    const current = await call(client, "plasticity_status", {});
    requireSameDocument(state, current);
    setUncertain(true);
    state = await call(client, "plasticity_undo", { intent: "Cleanup compact scene-diff acceptance", revision: current.revision });
    setUncertain(false);
  }
  requireCondition(state.documentToken === initial.documentToken, "Plasticity document changed during cleanup");
  requireCondition(bodyCount(state) === bodyCount(initial), "Cleanup changed the disposable document's initial body count");
  return state;
}

export function bodyCount(state: any): number {
  if (typeof state?.bodyPagination?.total === "number") return state.bodyPagination.total;
  if (Array.isArray(state?.bodies)) return state.bodies.length;
  throw new Error("Plasticity response omitted its body count");
}

export function requireCompactMutationState(state: any, expectedBodyCount: number): void {
  requireCondition(state?.bodyPagination?.total === expectedBodyCount, "Mutation response omitted its total scene body count");
  requireCondition(Array.isArray(state.bodies) && state.bodies.length <= 20, "Mutation response did not use a compact page of at most 20 body summaries");
  requireCondition(state.bodyPagination.limit === 20, "Mutation response used an unexpected body-summary page limit");
  requireCondition(state.bodyPagination.offset === 0, "Mutation response did not start its summary page at offset zero");
  requireCondition(state.change?.sceneChanged === true && state.change?.revisionChanged === true, "Mutation response omitted the verified scene/revision change");
  requireCondition(Array.isArray(state.change.added) && state.change.added.length === 1, "A single-body create did not return exactly one added-body summary");
  requireCompactBodies(state.bodies);
  requireCompactBodies(state.change.added);
}

export function sceneMatchesBaseline(diff: any, expectedBodyCount: number): boolean {
  return diff?.diff?.sceneChanged === false && diff?.current?.bodyCount === expectedBodyCount;
}

async function startMcp(output: string): Promise<LiveMcp> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(projectRoot, "scripts", "run-server.ts")],
    cwd: projectRoot,
    env: {
      ...selectedEnvironment(process.env),
      PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223",
      PLASTICITY_STRENGTH_ROOT: join(output, "strength"),
      PLASTICITY_CONSTRUCTION_HISTORY_ROOT: join(output, "history"),
      PLASTICITY_REFERENCE_ROOT: join(output, "references"),
      PLASTICITY_REFERENCE_ARTIFACT_ROOT: join(output, "artifacts"),
    },
    stderr: "pipe",
  });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk) => {
    stderr.push(String(chunk).slice(-4096));
    while (stderr.join("").length > 16384) stderr.shift();
  });
  const client = new Client({ name: "plasticity-compact-diff-live", version: "1.0.0" });
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

function requireCompactBodies(bodies: Array<Record<string, unknown>>): void {
  requireCondition(bodies.every((body) => typeof body.id === "number" && typeof body.faceCount === "number" && typeof body.edgeCount === "number"), "Changed-body summary is missing stable IDs or topology counts");
  requireCondition(bodies.every((body) => !("faceIds" in body) && !("edgeIds" in body) && !("faces" in body) && !("edges" in body) && !("vertices" in body)), "Changed-body response included full B-Rep topology");
}

function summarizeCleanupDiff(diff: any): Record<string, unknown> {
  return {
    sceneChanged: diff.sceneChanged,
    revisionChanged: diff.revisionChanged,
    addedIds: diff.added.map((body: { id: number }) => body.id),
    removedIds: diff.removed.map((body: { id: number }) => body.id),
    modifiedBodies: diff.modified.map((body: { id: number; renamed: boolean; geometryChanged: boolean; appearanceChanged: boolean; visibilityChanged: boolean }) => ({
      id: body.id,
      renamed: body.renamed,
      geometryChanged: body.geometryChanged,
      appearanceChanged: body.appearanceChanged,
      visibilityChanged: body.visibilityChanged,
    })),
    regionCounts: [diff.regionsAdded.length, diff.regionsRemoved.length, diff.regionsModified.length],
    constructionPlaneCounts: [diff.constructionPlanesAdded.length, diff.constructionPlanesRemoved.length, diff.constructionPlanesModified.length],
    activeWorkplaneChanged: diff.activeWorkplaneChanged !== null,
    materialsChanged: diff.materialsChanged,
    measurementsChanged: diff.measurementsChanged,
    sectionAnalysesChanged: diff.sectionAnalysesChanged,
    instancesChanged: diff.instancesChanged,
    referenceMeshesChanged: diff.referenceMeshesChanged,
    groupsChanged: diff.groupsChanged,
  };
}

function requireSameDocument(expected: any, actual: any): void {
  requireSameDocumentIdentity(expected, actual);
  if ("revision" in expected) requireCondition(actual.revision === expected.revision, "Plasticity revision changed unexpectedly during acceptance");
}

export function requireSameDocumentIdentity(expected: any, actual: any): void {
  requireCondition(actual.documentToken === expected.documentToken, "Plasticity document changed during acceptance");
}

function byteCount(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)); }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : []));
}
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4_000); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function writeExclusive(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
}
