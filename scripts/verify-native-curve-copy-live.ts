#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LINEAR_TOLERANCE_MM = 0.01;

export interface NativeCurveCopyAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parseNativeCurveCopyAcceptanceArgs(argv: string[]): NativeCurveCopyAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: NativeCurveCopyAcceptanceOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live native-curve-copy acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native-curve-copy acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native-curve-copy acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-curve-copy-live.ts --help
  node scripts/verify-native-curve-copy-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode refuses a nonempty document, verifies exact independent Wire duplication
and Region-boundary curve creation with Undo/Redo, then restores the empty scene.`;

async function main(): Promise<void> {
  const options = parseNativeCurveCopyAcceptanceArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const evidence: Record<string, unknown> = { schemaVersion: 1, startedAt: new Date().toISOString(), targetId: options.target!, workbenchUsed: false };
  let live: LiveMcp | undefined;
  let initialState: any;
  try {
    live = await startMcp(join(output, "strength-store"));
    const tools = await live.client.listTools();
    for (const name of ["plasticity_duplicate_curves", "plasticity_create_curves_from_regions"]) {
      requireCondition(tools.tools.some((tool) => tool.name === name), `MCP did not expose ${name}`);
    }
    const windows = await call(live.client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    initialState = await call(live.client, "plasticity_connect", { targetId: options.target });
    requireEmpty(initialState, "initial document");
    evidence.initial = stateSummary(initialState);
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-curve-copy-live-initial-empty" });

    let state = await call(live.client, "plasticity_create_nurbs_curve", {
      pointsMm: [[0, 0, 0], [10, 5, 0], [20, -5, 0], [30, 10, 0], [40, 0, 0]], closed: false,
      intent: "Create disposable B-Spline for native curve-copy acceptance", revision: initialState.revision,
    });
    const source = onlyBodyOfType(state, "Wire", "source B-Spline");
    const sourceStructure = onlyCurve(await inspectCurves(live.client, [source.id], state.revision), "source B-Spline");
    const beforeDuplicateDepth = state.undoDepth;
    state = await call(live.client, "plasticity_duplicate_curves", {
      ids: [source.id], intent: "Duplicate the exact native B-Spline independently", revision: state.revision,
    });
    requireCondition(state.undoDepth === beforeDuplicateDepth + 1, "Curve duplication did not use one history step");
    const duplicate = onlyAddedBody([source.id], state, "duplicated Wire");
    const duplicateStructure = onlyCurve(await inspectCurves(live.client, [duplicate.id], state.revision), "duplicated B-Spline");
    requireBoundsNear(duplicate.boundsMm, source.boundsMm, "duplicated B-Spline bounds");
    requireEquivalentCurveStructure(duplicateStructure, sourceStructure, "duplicated B-Spline structure");
    state = await call(live.client, "plasticity_undo", { intent: "Verify curve-duplicate Undo", revision: state.revision });
    requireCondition(!state.bodies.some((body: any) => body.id === duplicate.id) && state.bodies.some((body: any) => body.id === source.id), "Curve-duplicate Undo did not preserve only the source");
    state = await call(live.client, "plasticity_redo", { intent: "Verify curve-duplicate Redo", revision: state.revision });
    requireCondition(state.bodies.some((body: any) => body.id === duplicate.id), "Curve-duplicate Redo did not restore the independent copy");
    evidence.curveDuplicate = {
      sourceBodyId: source.id, duplicateBodyId: duplicate.id,
      sourceBoundsMm: source.boundsMm, duplicateBoundsMm: duplicate.boundsMm,
      sourceStructure, duplicateStructure, sourcePreserved: true,
      independentStableBodyId: true, oneHistoryStep: true, undoRedo: true,
    };

    const idsBeforeRegionSource = state.bodies.map((body: any) => body.id);
    state = await call(live.client, "plasticity_create_polyline", {
      pointsMm: [[50, 0, 0], [80, 0, 0], [80, 20, 0], [50, 20, 0]], closed: true,
      intent: "Create a disposable exact Region for boundary-copy acceptance", revision: state.revision,
    });
    requireCondition(state.regions.length === 1, `Expected one exact Region, found ${state.regions.length}`);
    const region = state.regions[0];
    const regionSource = onlyAddedBody(idsBeforeRegionSource, state, "Region source Wire");
    requireCondition(regionSource?.type === "Wire", "Region source Wire was not found");
    const idsBeforeRegionCopy = state.bodies.map((body: any) => body.id);
    const beforeRegionDepth = state.undoDepth;
    state = await call(live.client, "plasticity_create_curves_from_regions", {
      regionIds: [region.id], intent: "Create an independent exact Wire from the Region boundary", revision: state.revision,
    });
    requireCondition(state.undoDepth === beforeRegionDepth + 1, "Region-boundary copy did not use one history step");
    const regionCopy = onlyAddedBody(idsBeforeRegionCopy, state, "Region-boundary Wire");
    const sourceBoundaryStructure = onlyCurve(await inspectCurves(live.client, [regionSource.id], state.revision), "Region source boundary");
    const regionCopyStructure = onlyCurve(await inspectCurves(live.client, [regionCopy.id], state.revision), "Region boundary copy");
    requireBoundsNear(regionCopy.boundsMm, regionSource.boundsMm, "Region-boundary copy bounds");
    requireEquivalentCurveStructure(regionCopyStructure, sourceBoundaryStructure, "Region-boundary structure");
    requireCondition(state.bodies.some((body: any) => body.id === regionSource.id), "Region-boundary copy consumed the source Wire");
    requireCondition(!state.regions.some((candidate: any) => candidate.id === region.id), "Region-boundary copy did not invalidate the prior automatic Region reference");
    requireCondition(state.regions.length === 1, `Expected one recomputed Region after boundary copy, found ${state.regions.length}`);
    const recomputedRegion = state.regions[0];
    state = await call(live.client, "plasticity_undo", { intent: "Verify Region-boundary copy Undo", revision: state.revision });
    requireCondition(!state.bodies.some((body: any) => body.id === regionCopy.id) && state.regions.some((candidate: any) => candidate.id === region.id), "Region-boundary copy Undo did not restore the prior Region identity");
    state = await call(live.client, "plasticity_redo", { intent: "Verify Region-boundary copy Redo", revision: state.revision });
    requireCondition(state.bodies.some((body: any) => body.id === regionCopy.id), "Region-boundary copy Redo did not restore the independent Wire");
    requireCondition(state.regions.some((candidate: any) => candidate.id === recomputedRegion.id), "Region-boundary copy Redo did not restore the recomputed Region identity");
    evidence.regionBoundaryCopy = {
      sourceRegionId: region.id, recomputedRegionId: recomputedRegion.id,
      sourceBodyId: regionSource.id, copiedBodyId: regionCopy.id,
      sourceBoundsMm: regionSource.boundsMm, copiedBoundsMm: regionCopy.boundsMm,
      sourceStructure: sourceBoundaryStructure, copiedStructure: regionCopyStructure,
      sourceWirePreserved: true, priorRegionReferenceInvalidated: true,
      independentStableBodyId: true,
      oneHistoryStep: true, undoRedo: true,
    };

    while (state.undoDepth > initialState.undoDepth) {
      state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable native curve-copy acceptance", revision: state.revision });
    }
    requireEmpty(state, "cleanup document");
    const journal = await call(live.client, "plasticity_construction_journal", {});
    requireCondition(journal.syncStatus === "in-sync" && !journal.entries.some((entry: { status: string }) => entry.status === "unknown"), "Construction journal is not clean after native curve-copy acceptance");
    const changes = await call(live.client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(changes.diff), "Scene content differs from the initial empty snapshot after cleanup");
    evidence.cleanup = { restoredEmptyDocument: true, sceneContentsRestored: true, journalSyncStatus: journal.syncStatus };
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

async function inspectCurves(client: Client, ids: number[], revision: string): Promise<any> { return await call(client, "plasticity_inspect_curve_structure", { ids, revision }); }
function onlyCurve(report: any, label: string): any { requireCondition(report.curves?.length === 1, `${label}: expected one curve, found ${report.curves?.length ?? 0}`); return report.curves[0]; }
function onlyBodyOfType(state: any, type: string, label: string): any { const matches = state.bodies.filter((body: any) => body.type === type); requireCondition(matches.length === 1, `${label}: expected one ${type}, found ${matches.length}`); return matches[0]; }
function onlyAddedBody(previousIds: number[], state: any, label: string): any { const previous = new Set(previousIds); const added = state.bodies.filter((body: any) => !previous.has(body.id)); requireCondition(added.length === 1, `${label}: expected one new body, found ${added.length}`); return added[0]; }
function requireEquivalentCurveStructure(actual: any, expected: any, label: string): void { const compact = (curve: any) => curve.segments.map((segment: any) => ({ curveType: segment.curveType, lengthMm: rounded(segment.lengthMm), degree: segment.degree ?? null, controlPointCount: segment.controlPointCount ?? null, spanCount: segment.spanCount ?? null, distinctKnotCount: segment.distinctKnotCount ?? null, rational: segment.rational ?? null, periodic: segment.periodic ?? null })).toSorted((left: any, right: any) => JSON.stringify(left).localeCompare(JSON.stringify(right))); requireCondition(JSON.stringify(compact(actual)) === JSON.stringify(compact(expected)), `${label} differs`); }
function requireBoundsNear(actual: any, expected: any, label: string): void { requireCondition(actual && expected, `${label}: bounds are unavailable`); for (const side of ["min", "max"]) for (let axis = 0; axis < 3; axis += 1) requireCondition(Math.abs(actual[side][axis] - expected[side][axis]) <= LINEAR_TOLERANCE_MM, `${label} ${side}[${axis}] differs`); }
function rounded(value: number): number { return Math.round(value * 1e9) / 1e9; }
function requireEmpty(state: any, label: string): void { const nonRootGroups = (state.groups ?? []).filter((group: any) => group.id !== 0); requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0 && nonRootGroups.length === 0, `${label} is not empty`); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function stateSummary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, regionCount: state.regions.length }; }

async function startMcp(storeRoot: string): Promise<LiveMcp> { const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" }, stderr: "pipe" }); const stderr: string[] = []; transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); }); const client = new Client({ name: "plasticity-native-curve-copy-live", version: "1.0.0" }); await client.connect(transport); return { client, stderr }; }
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> { const response = await client.callTool({ name, arguments: args }); const item = (response.content as Array<{ type: string; text?: string }>).find((entry) => entry.type === "text" && typeof entry.text === "string"); if (!item?.text) throw new Error("MCP tool returned no text content"); if (response.isError) throw new Error(item.text); return JSON.parse(item.text); }
async function recover(client: Client, initial: any): Promise<Record<string, unknown>> { for (let count = 0; count < 32; count += 1) { const status = await call(client, "plasticity_status", {}); if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" }; if (status.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: status.bodies.length === 0 && status.regions.length === 0 }; await call(client, "plasticity_undo", { intent: "Recover disposable native curve-copy acceptance", revision: status.revision }); } return { restoredEmptyDocument: false, reason: "undo-limit" }; }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
