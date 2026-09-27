#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LINEAR_TOLERANCE_MM = 0.01;

export interface NativeCurveDeformationAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parseNativeCurveDeformationAcceptanceArgs(argv: string[]): NativeCurveDeformationAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: NativeCurveDeformationAcceptanceOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live native-curve-deformation acceptance requires --target with an explicit Plasticity window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native-curve-deformation acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native-curve-deformation acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-curve-deformation-live.ts --help
  node scripts/verify-native-curve-deformation-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode refuses a nonempty Plasticity document, unwraps an analytic Cylinder,
maps open and closed planar Wires onto it through one public MCP call, verifies
preserved inputs, exact B-Rep curves and Undo/Redo, cleans up, and writes evidence.`;

async function main(): Promise<void> {
  const options = parseNativeCurveDeformationAcceptanceArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const evidence: Record<string, unknown> = { schemaVersion: 1, startedAt: new Date().toISOString(), targetId: options.target!, workbenchUsed: false };
  let live: LiveMcp | undefined;
  let initialState: any;
  try {
    live = await startMcp(join(output, "strength-store"));
    const windows = await call(live.client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    initialState = await call(live.client, "plasticity_connect", { targetId: options.target });
    requireEmpty(initialState, "initial document");
    evidence.initial = stateSummary(initialState);
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-curve-deformation-live-initial-empty" });

    let state = await call(live.client, "plasticity_create_cylinder", {
      centerMm: [0, 0, 0], radiusMm: 10, heightMm: 30, axis: [0, 0, 1], name: "Curve deformation target",
      intent: "Create a disposable curved target for native curve-deformation acceptance", revision: initialState.revision,
    });
    const target = requireNamedBody(state, "Curve deformation target");
    const targetFace = requireSingleFace(target, (face) => face.surfaceType === "Cylinder", "target Cylinder face");

    state = await call(live.client, "plasticity_unwrap_face", {
      face: { bodyId: target.id, faceId: targetFace.id },
      intent: "Create the exact planar source surface for native curve deformation", revision: state.revision,
    });
    const source = state.bodies.find((body: any) => body.id !== target.id);
    requireCondition(source?.type === "Sheet" && source.faces.length === 1, "Cylinder unwrap did not create one planar source Sheet");
    const sourceFace = requireSingleFace(source, (face) => face.surfaceType === "Plane", "planar source face");
    requireBounds(source, [-Math.PI * 10, -15, 0], [Math.PI * 10, 15, 0], "unwrapped source Sheet");

    state = await call(live.client, "plasticity_create_polyline", {
      pointsMm: [[-5, -2, 0], [0, 4, 0], [5, -2, 0]], closed: false,
      intent: "Create an open planar marking curve", revision: state.revision,
    });
    const openSource = state.bodies.find((body: any) => body.type === "Wire");
    requireCondition(openSource, "Open source Wire was not created");
    state = await call(live.client, "plasticity_create_circle", {
      centerMm: [12, 0, 0], radiusMm: 3, normal: [0, 0, 1],
      intent: "Create a closed planar marking curve", revision: state.revision,
    });
    const closedSource = state.bodies.find((body: any) => body.type === "Wire" && body.id !== openSource.id);
    requireCondition(closedSource, "Closed source Wire was not created");
    const beforeBodies = new Map(state.bodies.map((body: any) => [body.id, compactBody(body)]));
    const beforeIds = new Set(state.bodies.map((body: any) => body.id));
    const sourceDirections = await call(live.client, "plasticity_list_curve_directions", {});
    const openBefore = requireCurve(sourceDirections, openSource.id);
    const closedBefore = requireCurve(sourceDirections, closedSource.id);
    requireCondition(openBefore.closed === false && openBefore.segments.length === 2, "Open source topology is unexpected");
    requireCondition(closedBefore.closed === true && closedBefore.segments.length === 1, "Closed source topology is unexpected");
    near(sumLengths(openBefore), 2 * Math.sqrt(61), 1e-8, "open source length");
    near(sumLengths(closedBefore), 6 * Math.PI, 1e-8, "closed source length");

    const beforeDepth = state.undoDepth;
    state = await call(live.client, "plasticity_deform_curves_between_faces", {
      ids: [openSource.id, closedSource.id],
      sourceFace: { bodyId: source.id, faceId: sourceFace.id },
      targetFace: { bodyId: target.id, faceId: targetFace.id },
      scaleU: 1, scaleV: 1, scaleNormal: 1,
      intent: "Map open and closed planar marking curves onto the exact Cylinder", revision: state.revision,
    });
    requireCondition(state.undoDepth === beforeDepth + 1, "Curve deformation did not use one native history step");
    requireCondition(state.bodies.length === 6, `Curve deformation should preserve four inputs and add two Wires; found ${state.bodies.length}`);
    for (const [id, compact] of beforeBodies) {
      const preserved = state.bodies.find((body: any) => body.id === id);
      requireCondition(preserved && JSON.stringify(compactBody(preserved)) === JSON.stringify(compact), `Curve deformation changed preserved input body ${id}`);
    }
    const results = state.bodies.filter((body: any) => !beforeIds.has(body.id));
    requireCondition(results.length === 2 && results.every((body: any) => body.type === "Wire"), "Curve deformation did not create two independent Wires");
    const directions = await call(live.client, "plasticity_list_curve_directions", {});
    const mappedCurves = results.map((body: any) => requireCurve(directions, body.id));
    const openResult = mappedCurves.find((curve: any) => curve.closed === false);
    const closedResult = mappedCurves.find((curve: any) => curve.closed === true);
    requireCondition(openResult?.segments.length === 2, "Mapped open Wire topology is unexpected");
    requireCondition(closedResult?.segments.length === 1, "Mapped closed Wire topology is unexpected");
    near(sumLengths(openResult), sumLengths(openBefore), LINEAR_TOLERANCE_MM, "mapped open length");
    near(sumLengths(closedResult), sumLengths(closedBefore), LINEAR_TOLERANCE_MM, "mapped closed length");
    const resultIds = [openResult.id, closedResult.id];
    requireCondition(state.regions.length === 1 && state.regions.every((region: any) => resultIds.every((id) => !region.sketchWireIds.includes(id))), "Mapped closed Wire unexpectedly produced a planar Region");
    const planarity = await call(live.client, "plasticity_inspect_curve_planarity", { ids: resultIds, revision: state.revision });
    requireCondition(planarity.curves.length === 2 && planarity.curves.every((curve: any) => curve.planar === false), "Mapped Cylinder curves should be nonplanar");
    const samples = await sampleCurves(live.client, mappedCurves, state.revision);
    for (const sample of samples.samples) {
      near(Math.hypot(sample.positionMm[0], sample.positionMm[1]), 10, LINEAR_TOLERANCE_MM, "mapped point Cylinder radius");
      near(Math.hypot(...sample.tangent), 1, 1e-8, "mapped curve unit tangent");
    }

    const beforeVariantIds = new Set(state.bodies.map((body: any) => body.id));
    const beforeVariantDepth = state.undoDepth;
    state = await call(live.client, "plasticity_deform_curves_between_faces", {
      ids: [openSource.id],
      sourceFace: { bodyId: source.id, faceId: sourceFace.id },
      targetFace: { bodyId: target.id, faceId: targetFace.id },
      scaleU: 1.25, scaleV: 0.75, scaleNormal: 0.5,
      flipUV: true, flipNormal: true, mirror: true,
      intent: "Exercise every verified native curve-deformation mapping control", revision: state.revision,
    });
    requireCondition(state.undoDepth === beforeVariantDepth + 1 && state.bodies.length === 7, "Controlled curve-deformation variant did not add one Wire in one history step");
    const variant = state.bodies.find((body: any) => !beforeVariantIds.has(body.id));
    requireCondition(variant?.type === "Wire", "Controlled curve-deformation variant did not create one Wire");
    const variantDirections = await call(live.client, "plasticity_list_curve_directions", {});
    const variantCurve = requireCurve(variantDirections, variant.id);
    requireCondition(variantCurve.closed === false && variantCurve.segments.length === 2, "Controlled curve-deformation variant topology is unexpected");
    requireCondition(JSON.stringify(variant.boundsMm) !== JSON.stringify(state.bodies.find((body: any) => body.id === openResult.id)?.boundsMm), "Nondefault curve-deformation controls did not change exact bounds");
    const variantSamples = await sampleCurves(live.client, [variantCurve], state.revision);
    for (const sample of variantSamples.samples) {
      near(Math.hypot(sample.positionMm[0], sample.positionMm[1]), 10, LINEAR_TOLERANCE_MM, "controlled mapped point Cylinder radius");
      near(Math.hypot(...sample.tangent), 1, 1e-8, "controlled mapped curve unit tangent");
    }
    state = await call(live.client, "plasticity_undo", { intent: "Remove controlled curve-deformation variant", revision: state.revision });
    requireCondition(state.bodies.length === 6 && !state.bodies.some((body: any) => body.id === variant.id), "Controlled curve-deformation variant Undo changed the wrong bodies");

    state = await call(live.client, "plasticity_undo", { intent: "Verify native curve-deformation Undo", revision: state.revision });
    requireCondition(state.bodies.length === 4 && resultIds.every((id) => !state.bodies.some((body: any) => body.id === id)), "Curve-deformation Undo did not remove only both mapped Wires");
    state = await call(live.client, "plasticity_redo", { intent: "Verify native curve-deformation Redo", revision: state.revision });
    requireCondition(resultIds.every((id) => state.bodies.some((body: any) => body.id === id && body.type === "Wire")), "Curve-deformation Redo changed a mapped Wire identity or type");

    evidence.curveDeformation = {
      sourceFace: { bodyId: source.id, faceId: sourceFace.id, surfaceType: sourceFace.surfaceType },
      targetFace: { bodyId: target.id, faceId: targetFace.id, surfaceType: targetFace.surfaceType },
      inputWireIds: [openSource.id, closedSource.id], resultWireIds: resultIds,
      inputBodiesPreserved: true,
      mapping: { scaleU: 1, scaleV: 1, scaleNormal: 1, flipUV: false, flipNormal: false, mirror: false },
      sourceLengthsMm: { open: sumLengths(openBefore), closed: sumLengths(closedBefore) },
      resultLengthsMm: { open: sumLengths(openResult), closed: sumLengths(closedResult) },
      resultBoundsMm: results.map((body: any) => ({ id: body.id, boundsMm: body.boundsMm })),
      exactSampleCount: samples.samples.length, allSamplesOnCylinderRadiusMm: 10,
      planarity: planarity.curves,
      controlledVariant: { bodyId: variant.id, boundsMm: variant.boundsMm, lengthMm: sumLengths(variantCurve), allSamplesOnCylinderRadiusMm: 10, undoRemovedOnlyVariant: true },
      oneHistoryStep: true, undoRedoStableIds: true,
    };

    while (state.undoDepth > initialState.undoDepth) state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable native curve-deformation acceptance", revision: state.revision });
    requireEmpty(state, "cleaned document");
    const journal = await call(live.client, "plasticity_construction_journal", {});
    requireCondition(journal.syncStatus === "in-sync" && !journal.entries.some((entry: { status: string }) => entry.status === "unknown"), "Construction journal is not clean after curve-deformation acceptance");
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
  } finally { await live?.client.close().catch(() => {}); }
}

function requireNamedBody(state: any, name: string): any { const bodies = state.bodies.filter((body: any) => body.name === name); requireCondition(bodies.length === 1, `Expected exactly one body named ${name}`); return bodies[0]; }
function requireSingleFace(body: any, predicate: (face: any) => boolean, label: string): any { const faces = body.faces.filter(predicate); requireCondition(faces.length === 1, `Expected one ${label}; found ${faces.length}`); return faces[0]; }
function requireCurve(report: any, id: number): any { const curves = report.curves.filter((curve: any) => curve.id === id); requireCondition(curves.length === 1, `Expected one exact curve report for body ${id}`); return curves[0]; }
function sumLengths(curve: any): number { return curve.segments.reduce((sum: number, segment: any) => sum + segment.lengthMm, 0); }
async function sampleCurves(client: Client, curves: any[], revision: string): Promise<any> { const samples = curves.flatMap((curve) => curve.segments.flatMap((segment: any) => [0, 0.25, 0.5, 0.75, 1].map((normalizedParameter) => ({ bodyId: curve.id, segmentEntityId: segment.entityId, normalizedParameter })))); return await call(client, "plasticity_evaluate_curve_segments", { samples, revision }); }
function compactBody(body: any): Record<string, unknown> { return { id: body.id, type: body.type, name: body.name, boundsMm: body.boundsMm, faceIds: body.faceIds, edgeIds: body.edgeIds }; }
function requireBounds(body: any, min: [number, number, number], max: [number, number, number], label: string): void { requireCondition(body.boundsMm, `${label} has no bounds`); vectorNear(body.boundsMm.min, min, LINEAR_TOLERANCE_MM, `${label} minimum`); vectorNear(body.boundsMm.max, max, LINEAR_TOLERANCE_MM, `${label} maximum`); }
function vectorNear(actual: unknown, expected: [number, number, number], tolerance: number, label: string): void { requireCondition(Array.isArray(actual) && actual.length === 3 && actual.every((value, index) => typeof value === "number" && Math.abs(value - expected[index]!) <= tolerance), `${label}: expected [${expected.join(", ")}], got ${JSON.stringify(actual)}`); }
function near(actual: unknown, expected: number, tolerance: number, label: string): void { requireCondition(typeof actual === "number" && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${String(actual)}`); }
function requireEmpty(state: any, label: string): void { requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0, `${label} is not empty`); requireCondition((state.groups ?? []).filter((group: { id: number }) => group.id !== 0).length === 0, `${label} contains non-root groups`); }
function stateSummary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, regionCount: state.regions.length }; }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

async function startMcp(storeRoot: string): Promise<LiveMcp> { const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" }, stderr: "pipe" }); const stderr: string[] = []; transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); }); const client = new Client({ name: "plasticity-native-curve-deformation-live", version: "1.0.0" }); await client.connect(transport); return { client, stderr }; }
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> { const response = await client.callTool({ name, arguments: args }); const output = toolText(response); if ("isError" in response && response.isError) throw new Error(output); return JSON.parse(output); }
function toolText(response: unknown): string { if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content"); const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string"); if (!item) throw new Error("MCP tool returned no text content"); return item.text; }
async function recover(client: Client, initial: any): Promise<Record<string, unknown>> { for (let count = 0; count < 20; count += 1) { const status = await call(client, "plasticity_status", {}); if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" }; if (status.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: status.bodies.length === 0 && status.regions.length === 0 }; await call(client, "plasticity_undo", { intent: "Recover disposable native curve-deformation acceptance", revision: status.revision }); } return { restoredEmptyDocument: false, reason: "undo-limit" }; }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
