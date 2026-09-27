#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LINEAR_TOLERANCE_MM = 0.01;

export interface NativeFaceDeformationAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parseNativeFaceDeformationAcceptanceArgs(argv: string[]): NativeFaceDeformationAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: NativeFaceDeformationAcceptanceOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live native-face-deformation acceptance requires --target with an explicit Plasticity window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native-face-deformation acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native-face-deformation acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-face-deformation-live.ts --help
  node scripts/verify-native-face-deformation-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode refuses a nonempty Plasticity document, unwraps an analytic Cylinder,
maps a separate Solid from that planar source onto the Cylinder through the
public MCP tool, verifies preserved inputs, exact B-Rep output and Undo/Redo,
cleans up with native Undo, and writes sanitized evidence.`;

async function main(): Promise<void> {
  const options = parseNativeFaceDeformationAcceptanceArgs(process.argv.slice(2));
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
    requireEmpty(initialState, "initial document");
    evidence.initial = stateSummary(initialState);
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-face-deformation-live-initial-empty" });

    let state = await call(live.client, "plasticity_create_cylinder", {
      centerMm: [0, 0, 0], radiusMm: 10, heightMm: 30, axis: [0, 0, 1], name: "Face deformation target",
      intent: "Create disposable curved target for native face-deformation acceptance", revision: initialState.revision,
    });
    const target = requireNamedBody(state, "Face deformation target");
    const targetFace = requireSingleFace(target, (face) => face.surfaceType === "Cylinder", "target Cylinder face");

    state = await call(live.client, "plasticity_unwrap_face", {
      face: { bodyId: target.id, faceId: targetFace.id },
      intent: "Create the exact planar source surface for native face deformation", revision: state.revision,
    });
    const source = state.bodies.find((body: any) => body.id !== target.id);
    requireCondition(source?.type === "Sheet" && source.faces.length === 1, "Cylinder unwrap did not create one planar source Sheet");
    const sourceFace = requireSingleFace(source, (face) => face.surfaceType === "Plane", "planar source face");
    requireBounds(source, [-Math.PI * 10, -15, 0], [Math.PI * 10, 15, 0], "unwrapped source Sheet");

    state = await call(live.client, "plasticity_create_box", {
      originMm: [-5, -2, 0], sizeMm: [10, 4, 2], name: "Face deformation object",
      intent: "Create a disposable Solid to map onto the Cylinder", revision: state.revision,
    });
    const deformSource = requireNamedBody(state, "Face deformation object");
    const beforeBodies = new Map(state.bodies.map((body: any) => [body.id, compactBody(body)]));
    const beforeIds = new Set(state.bodies.map((body: any) => body.id));
    const sourceProperties = await exactSolidProperties(live.client, deformSource.id, state.revision);
    near(sourceProperties.volumeMm3, 80, 1e-7, "source Solid volume");
    vectorNear(sourceProperties.volumeCentroidMm, [0, 0, 1], 1e-8, "source Solid centroid");

    const beforeDeformationDepth = state.undoDepth;
    state = await call(live.client, "plasticity_deform_bodies_between_faces", {
      ids: [deformSource.id],
      sourceFace: { bodyId: source.id, faceId: sourceFace.id },
      targetFace: { bodyId: target.id, faceId: targetFace.id },
      scaleU: 1, scaleV: 1, scaleNormal: 1,
      intent: "Map the disposable Solid from the planar development onto the exact Cylinder", revision: state.revision,
    });
    requireCondition(state.undoDepth === beforeDeformationDepth + 1, "Face deformation did not use one native history step");
    requireCondition(state.bodies.length === 4, `Face deformation should preserve three inputs and add one body; found ${state.bodies.length}`);
    for (const [id, compact] of beforeBodies) {
      const preserved = state.bodies.find((body: any) => body.id === id);
      requireCondition(preserved, `Face deformation consumed input body ${id}`);
      requireCondition(JSON.stringify(compactBody(preserved)) === JSON.stringify(compact), `Face deformation changed preserved input body ${id}`);
    }
    const result = state.bodies.find((body: any) => !beforeIds.has(body.id));
    requireCondition(result?.type === "Solid", "Face deformation did not create one independent Solid");
    requireCondition(result.faces.length === 6 && result.edges.length === 12, "Deformed Solid has unexpected topology");
    requireCondition(result.faces.filter((face: any) => face.surfaceType === "BSurf").length === 2, "Deformed Solid should contain two B-Surface faces");
    requireCondition(result.faces.filter((face: any) => face.surfaceType === "Plane").length === 4, "Deformed Solid should contain four Plane faces");
    requireBounds(
      result,
      [-12.513330756240514, -5.753106463250434, 13.000000000003864],
      [-8.215206034277173, 5.753106463250432, 16.99999999999613],
      "deformed Solid",
    );
    const resultProperties = await exactSolidProperties(live.client, result.id, state.revision);
    requireCondition(Number.isFinite(resultProperties.volumeMm3) && resultProperties.volumeMm3 > 0, "Deformed Solid has no positive exact volume");
    requireCondition(Number.isFinite(resultProperties.surfaceAreaMm2) && resultProperties.surfaceAreaMm2 > 0, "Deformed Solid has no positive exact surface area");
    const validation = await call(live.client, "plasticity_validate_bodies", {
      ids: [target.id, source.id, deformSource.id, result.id], revision: state.revision,
    });
    const byId = new Map<number, any>(validation.bodies.map((body: any) => [body.id, body]));
    requireCondition(validation.measurementSource === "native-brep", "Unexpected body validation source");
    requireCondition(validation.bodies.every((body: any) => body.nativeValid === true && body.nativeCheckCodes.length === 0), "A deformation input or result failed native validation");
    requireCondition(byId.get(result.id)?.printableSolid === true && byId.get(result.id)?.boundaryEdgeIds.length === 0, "Deformed Solid is not a closed printable native body");
    requireCondition(byId.get(source.id)?.type === "Sheet" && byId.get(source.id)?.printableSolid === false, "Planar source Sheet validation changed unexpectedly");

    const beforeVariantIds = new Set(state.bodies.map((body: any) => body.id));
    const beforeVariantDepth = state.undoDepth;
    state = await call(live.client, "plasticity_deform_bodies_between_faces", {
      ids: [deformSource.id],
      sourceFace: { bodyId: source.id, faceId: sourceFace.id },
      targetFace: { bodyId: target.id, faceId: targetFace.id },
      scaleU: 1.25, scaleV: 0.75, scaleNormal: 0.5,
      flipUV: true, flipNormal: true, mirror: true,
      intent: "Exercise every verified native face-deformation mapping control", revision: state.revision,
    });
    requireCondition(state.undoDepth === beforeVariantDepth + 1, "Controlled deformation variant did not use one native history step");
    requireCondition(state.bodies.length === 5, "Controlled deformation variant did not preserve all existing bodies");
    const variant = state.bodies.find((body: any) => !beforeVariantIds.has(body.id));
    requireCondition(variant?.type === "Solid", "Controlled deformation variant did not create one independent Solid");
    requireCondition(JSON.stringify(variant.boundsMm) !== JSON.stringify(result.boundsMm), "Nondefault deformation controls did not produce observably different exact bounds");
    const variantProperties = await exactSolidProperties(live.client, variant.id, state.revision);
    const variantValidation = await call(live.client, "plasticity_validate_bodies", { ids: [variant.id], revision: state.revision });
    requireCondition(variantValidation.bodies.length === 1 && variantValidation.bodies[0].nativeValid === true && variantValidation.bodies[0].printableSolid === true && variantValidation.bodies[0].boundaryEdgeIds.length === 0, "Controlled deformation variant is not a closed valid native Solid");
    state = await call(live.client, "plasticity_undo", { intent: "Remove controlled face-deformation variant", revision: state.revision });
    requireCondition(state.bodies.length === 4 && !state.bodies.some((body: any) => body.id === variant.id) && state.bodies.some((body: any) => body.id === result.id), "Controlled deformation variant Undo changed the wrong bodies");

    state = await call(live.client, "plasticity_undo", { intent: "Verify native face-deformation Undo", revision: state.revision });
    requireCondition(state.bodies.length === 3 && !state.bodies.some((body: any) => body.id === result.id), "Face-deformation Undo did not remove only the mapped copy");
    for (const id of beforeIds) requireCondition(state.bodies.some((body: any) => body.id === id), `Face-deformation Undo lost input body ${id}`);
    state = await call(live.client, "plasticity_redo", { intent: "Verify native face-deformation Redo", revision: state.revision });
    const redone = state.bodies.find((body: any) => body.id === result.id);
    requireCondition(redone, "Face-deformation Redo changed the mapped body's stable ID");
    requireBounds(redone, result.boundsMm.min, result.boundsMm.max, "redone deformed Solid");

    evidence.faceDeformation = {
      sourceFace: { bodyId: source.id, faceId: sourceFace.id, surfaceType: sourceFace.surfaceType },
      targetFace: { bodyId: target.id, faceId: targetFace.id, surfaceType: targetFace.surfaceType },
      inputBodyId: deformSource.id,
      resultBodyId: result.id,
      inputBodiesPreserved: true,
      mapping: { scaleU: 1, scaleV: 1, scaleNormal: 1, flipUV: false, flipNormal: false, mirror: false },
      resultBoundsMm: result.boundsMm,
      resultTopology: { faces: result.faces.length, edges: result.edges.length, surfaceTypes: result.faces.map((face: any) => face.surfaceType).sort() },
      exactSourceProperties: sourceProperties,
      exactResultProperties: resultProperties,
      controlledVariant: {
        bodyId: variant.id,
        mapping: { scaleU: 1.25, scaleV: 0.75, scaleNormal: 0.5, flipUV: true, flipNormal: true, mirror: true },
        resultBoundsMm: variant.boundsMm,
        exactProperties: variantProperties,
        nativeValid: true,
        printableSolid: true,
        undoRemovedOnlyVariant: true,
      },
      oneHistoryStep: true,
      undoRedoStableId: true,
    };
    evidence.validation = validation;

    while (state.undoDepth > initialState.undoDepth) {
      state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable native face-deformation acceptance", revision: state.revision });
    }
    requireEmpty(state, "cleaned document");
    const journal = await call(live.client, "plasticity_construction_journal", {});
    requireCondition(journal.syncStatus === "in-sync" && !journal.entries.some((entry: { status: string }) => entry.status === "unknown"), "Construction journal is not clean after face-deformation acceptance");
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

function requireNamedBody(state: any, name: string): any { const bodies = state.bodies.filter((body: any) => body.name === name); requireCondition(bodies.length === 1, `Expected exactly one body named ${name}`); return bodies[0]; }
function requireSingleFace(body: any, predicate: (face: any) => boolean, label: string): any { const faces = body.faces.filter(predicate); requireCondition(faces.length === 1, `Expected one ${label}; found ${faces.length}`); return faces[0]; }
function compactBody(body: any): Record<string, unknown> { return { id: body.id, type: body.type, name: body.name, boundsMm: body.boundsMm, faceIds: body.faceIds, edgeIds: body.edgeIds, faces: body.faces.map((face: any) => ({ id: face.id, surfaceType: face.surfaceType, boundsMm: face.boundsMm })), edges: body.edges.map((edge: any) => ({ id: edge.id, curveType: edge.curveType, lengthMm: edge.lengthMm })) }; }
function requireBounds(body: any, min: [number, number, number], max: [number, number, number], label: string): void { requireCondition(body.boundsMm, `${label} has no bounds`); vectorNear(body.boundsMm.min, min, LINEAR_TOLERANCE_MM, `${label} minimum`); vectorNear(body.boundsMm.max, max, LINEAR_TOLERANCE_MM, `${label} maximum`); }
function requireEmpty(state: any, label: string): void { requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0, `${label} is not empty`); requireCondition((state.groups ?? []).filter((group: { id: number }) => group.id !== 0).length === 0, `${label} contains non-root groups`); }
function stateSummary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, regionCount: state.regions.length }; }
async function exactSolidProperties(client: Client, id: number, revision: string): Promise<any> { const report = await call(client, "plasticity_measure_solid_properties", { ids: [id], revision }); requireCondition(report.source === "native-brep-mass-properties" && report.bodies.length === 1 && report.bodies[0].id === id, `Exact solid-property evidence is unavailable for body ${id}`); requireCondition(report.bodies[0].nativeCheckCodes.length === 0, `Solid ${id} has native validation errors`); return report.bodies[0]; }
function vectorNear(actual: unknown, expected: [number, number, number], tolerance: number, label: string): void { requireCondition(Array.isArray(actual) && actual.length === 3 && actual.every((value, index) => typeof value === "number" && Math.abs(value - expected[index]!) <= tolerance), `${label}: expected [${expected.join(", ")}], got ${JSON.stringify(actual)}`); }
function near(actual: unknown, expected: number, tolerance: number, label: string): void { requireCondition(typeof actual === "number" && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${String(actual)}`); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

async function startMcp(storeRoot: string): Promise<LiveMcp> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" }, stderr: "pipe" });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); });
  const client = new Client({ name: "plasticity-native-face-deformation-live", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> { const response = await client.callTool({ name, arguments: args }); const output = toolText(response); if ("isError" in response && response.isError) throw new Error(output); return JSON.parse(output); }
function toolText(response: unknown): string { if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content"); const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string"); if (!item) throw new Error("MCP tool returned no text content"); return item.text; }
async function recover(client: Client, initial: any): Promise<Record<string, unknown>> { for (let count = 0; count < 16; count += 1) { const status = await call(client, "plasticity_status", {}); if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" }; if (status.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: status.bodies.length === 0 && status.regions.length === 0 }; await call(client, "plasticity_undo", { intent: "Recover disposable native face-deformation acceptance", revision: status.revision }); } return { restoredEmptyDocument: false, reason: "undo-limit" }; }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
