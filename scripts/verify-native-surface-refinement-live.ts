#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LINEAR_TOLERANCE_MM = 0.01;
const PARAMETER_TOLERANCE = 1e-10;

export interface NativeSurfaceRefinementAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parseNativeSurfaceRefinementAcceptanceArgs(argv: string[]): NativeSurfaceRefinementAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: NativeSurfaceRefinementAcceptanceOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live native-surface-refinement acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native-surface-refinement acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native-surface-refinement acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-surface-refinement-live.ts --help
  node scripts/verify-native-surface-refinement-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode refuses a nonempty document, verifies native face matching, exact
B-Surface structure, degree elevation and untrim with Undo/Redo, then restores
the empty scene.`;

async function main(): Promise<void> {
  const options = parseNativeSurfaceRefinementAcceptanceArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const evidence: Record<string, unknown> = { schemaVersion: 1, startedAt: new Date().toISOString(), targetId: options.target!, workbenchUsed: false };
  let live: LiveMcp | undefined;
  let initialState: any;
  try {
    live = await startMcp(join(output, "strength-store"));
    const tools = await live.client.listTools();
    for (const name of ["plasticity_inspect_surface_structure", "plasticity_raise_surface_degree", "plasticity_rebuild_face", "plasticity_match_faces", "plasticity_untrim_faces"]) {
      requireCondition(tools.tools.some((tool) => tool.name === name), `MCP did not expose ${name}`);
    }
    const windows = await call(live.client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    initialState = await call(live.client, "plasticity_connect", { targetId: options.target });
    requireEmpty(initialState, "initial document");
    evidence.initial = stateSummary(initialState);
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-surface-refinement-live-initial-empty" });

    let state = await call(live.client, "plasticity_create_box", {
      originMm: [0, -5, 0], sizeMm: [18, 10, 10], name: "Face match source",
      intent: "Create a disposable exact Solid for native face-match acceptance", revision: initialState.revision,
    });
    state = await call(live.client, "plasticity_create_cylinder", {
      centerMm: [0, 0, 0], radiusMm: 20, heightMm: 10, axis: [0, 0, 1], name: "Face match reference",
      intent: "Create a disposable exact cylindrical replacement surface", revision: state.revision,
    });
    const matchSource = namedBody(state, "Face match source");
    const matchReference = namedBody(state, "Face match reference");
    const planarMatchFace = matchSource.faces.find((face: any) => face.planar === true && face.normal[0] > 0.9);
    const cylindricalReplacement = matchReference.faces.find((face: any) => face.surfaceType === "Cylinder");
    requireCondition(planarMatchFace && cylindricalReplacement, "Native face-match source or cylindrical replacement face was not found");
    const beforeMatchProperties = await call(live.client, "plasticity_measure_solid_properties", { ids: [matchSource.id, matchReference.id], revision: state.revision });
    const beforeMatchDepth = state.undoDepth;
    state = await call(live.client, "plasticity_match_faces", {
      faces: [{ bodyId: matchSource.id, faceId: planarMatchFace.id }],
      replacement: { bodyId: matchReference.id, faceId: cylindricalReplacement.id },
      intent: "Match one disposable planar Solid face to an exact cylindrical reference surface", revision: state.revision,
    });
    requireCondition(state.undoDepth === beforeMatchDepth + 1, "Face matching did not use one history step");
    const matchedBody = bodyById(state, matchSource.id);
    const preservedReference = bodyById(state, matchReference.id);
    const matchedCylinder = matchedBody.faces.find((face: any) => face.surfaceType === "Cylinder");
    requireCondition(matchedCylinder && Math.abs(matchedCylinder.radiusMm - 20) <= LINEAR_TOLERANCE_MM, "Matched face is not an exact R20 Cylinder");
    requireCondition(matchedBody.faces.length === 6 && matchedBody.boundsMm.max[0] > 19 && matchedBody.boundsMm.max[0] <= 20 + LINEAR_TOLERANCE_MM, "Matched Solid did not extend to the cylindrical replacement surface");
    requireCondition(preservedReference.versionId === matchReference.versionId && preservedReference.faceIds.includes(cylindricalReplacement.id), "Face matching changed the replacement body");
    const matchedValidation = await call(live.client, "plasticity_validate_bodies", { ids: [matchedBody.id], revision: state.revision });
    requireCondition(matchedValidation.bodies[0]?.nativeValid === true && matchedValidation.bodies[0]?.printableSolid === true, "Face-matched Solid failed native validation");
    const afterMatchProperties = await call(live.client, "plasticity_measure_solid_properties", { ids: [matchedBody.id, preservedReference.id], revision: state.revision });
    requireCondition(afterMatchProperties.bodies[0].volumeMm3 > beforeMatchProperties.bodies[0].volumeMm3, "Face matching did not increase the source volume toward the cylinder");
    requireCondition(Math.abs(afterMatchProperties.bodies[1].volumeMm3 - beforeMatchProperties.bodies[1].volumeMm3) <= 1e-6, "Face matching changed the replacement body's exact volume");
    state = await call(live.client, "plasticity_undo", { intent: "Verify native face-match Undo", revision: state.revision });
    requireCondition(bodyById(state, matchSource.id).faces.every((face: any) => face.surfaceType === "Plane"), "Face-match Undo did not restore the planar source");
    state = await call(live.client, "plasticity_redo", { intent: "Verify native face-match Redo", revision: state.revision });
    requireCondition(bodyById(state, matchSource.id).faces.some((face: any) => face.surfaceType === "Cylinder"), "Face-match Redo did not restore the cylindrical surface");
    evidence.faceMatch = {
      sourceBodyId: matchSource.id, replacementBodyId: matchReference.id,
      sourceFaceId: planarMatchFace.id, replacementFaceId: cylindricalReplacement.id,
      matchedFaceId: matchedCylinder.id, matchedSurfaceType: matchedCylinder.surfaceType,
      matchedRadiusMm: matchedCylinder.radiusMm, boundsBeforeMm: matchSource.boundsMm, boundsAfterMm: matchedBody.boundsMm,
      sourceVolumeBeforeMm3: beforeMatchProperties.bodies[0].volumeMm3,
      sourceVolumeAfterMm3: afterMatchProperties.bodies[0].volumeMm3,
      replacementVolumeBeforeMm3: beforeMatchProperties.bodies[1].volumeMm3,
      replacementVolumeAfterMm3: afterMatchProperties.bodies[1].volumeMm3,
      stableSourceBodyIdPreserved: true, replacementBodyPreserved: true,
      nativeValid: true, printableSolid: true, oneHistoryStep: true, undoRedo: true,
    };
    state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable face match", revision: state.revision });
    state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable face-match reference", revision: state.revision });
    state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable face-match source", revision: state.revision });
    requireEmpty(state, "post-face-match cleanup");

    state = await call(live.client, "plasticity_create_box", {
      originMm: [0, 0, 0], sizeMm: [20, 10, 5], name: "Face rebuild source",
      intent: "Create a disposable exact Solid for native face-rebuild acceptance", revision: state.revision,
    });
    const rebuildSource = namedBody(state, "Face rebuild source");
    const rebuildFace = rebuildSource.faces.find((face: any) => face.planar === true && face.normal[2] > 0.9);
    requireCondition(rebuildFace, "Top planar face for rebuild acceptance was not found");
    const beforeRebuildProperties = await call(live.client, "plasticity_measure_solid_properties", { ids: [rebuildSource.id], revision: state.revision });
    const beforeRebuildDepth = state.undoDepth;
    state = await call(live.client, "plasticity_rebuild_face", {
      face: { bodyId: rebuildSource.id, faceId: rebuildFace.id }, toleranceMm: 0.01,
      intent: "Refit one disposable exact face as a native B-Surface", revision: state.revision,
    });
    requireCondition(state.undoDepth === beforeRebuildDepth + 1, "Face rebuild did not use one history step");
    const rebuiltBody = bodyById(state, rebuildSource.id);
    const rebuiltFace = rebuiltBody.faces.find((face: any) => face.surfaceType === "BSurf");
    requireCondition(rebuiltFace && rebuiltBody.faces.length === 6, "Face rebuild did not replace exactly one face with a B-Surface");
    const rebuiltStructure = onlySurface(await call(live.client, "plasticity_inspect_surface_structure", {
      faces: [{ bodyId: rebuiltBody.id, faceId: rebuiltFace.id }], revision: state.revision,
    }), "rebuilt face");
    const rebuiltValidation = await call(live.client, "plasticity_validate_bodies", { ids: [rebuiltBody.id], revision: state.revision });
    requireCondition(rebuiltValidation.bodies[0]?.nativeValid === true && rebuiltValidation.bodies[0]?.printableSolid === true, "Face-rebuilt Solid failed native validation");
    const afterRebuildProperties = await call(live.client, "plasticity_measure_solid_properties", { ids: [rebuiltBody.id], revision: state.revision });
    const maximumBoundsChangeMm = maxBoundsDelta(rebuildSource.boundsMm, rebuiltBody.boundsMm);
    requireCondition(maximumBoundsChangeMm <= 0.01, `Face rebuild exceeded its 0.01 mm bounds tolerance: ${maximumBoundsChangeMm}`);
    state = await call(live.client, "plasticity_undo", { intent: "Verify native face-rebuild Undo", revision: state.revision });
    requireCondition(bodyById(state, rebuildSource.id).faces.every((face: any) => face.surfaceType === "Plane"), "Face-rebuild Undo did not restore the analytic Plane");
    state = await call(live.client, "plasticity_redo", { intent: "Verify native face-rebuild Redo", revision: state.revision });
    requireCondition(bodyById(state, rebuildSource.id).faces.some((face: any) => face.surfaceType === "BSurf"), "Face-rebuild Redo did not restore the B-Surface");
    evidence.faceRebuild = {
      bodyId: rebuildSource.id, originalFaceId: rebuildFace.id, rebuiltFaceId: rebuiltFace.id,
      toleranceMm: 0.01, edgeMethod: "Project", method: "Refit", rebuiltStructure,
      boundsBeforeMm: rebuildSource.boundsMm, boundsAfterMm: rebuiltBody.boundsMm, maximumBoundsChangeMm,
      volumeBeforeMm3: beforeRebuildProperties.bodies[0].volumeMm3,
      volumeAfterMm3: afterRebuildProperties.bodies[0].volumeMm3,
      nativeValid: true, printableSolid: true, stableBodyIdPreserved: true, oneHistoryStep: true, undoRedo: true,
      exactShapePreservationClaimed: false,
    };
    state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable face rebuild", revision: state.revision });
    state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable face-rebuild source", revision: state.revision });
    requireEmpty(state, "post-face-rebuild cleanup");

    state = await call(live.client, "plasticity_create_constrained_surface", {
      pointsMm: [[0, 0, 0], [20, 0, 2], [0, 20, 4], [20, 20, 8], [10, 10, 7]],
      normals: [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1]],
      toleranceMm: 0.01, angularToleranceDegrees: 10, optimization: "smoothness",
      intent: "Create a disposable exact B-Surface for native refinement acceptance", revision: state.revision,
    });
    const source = onlyBodyOfType(state, "Sheet", "constrained B-Surface");
    requireCondition(source.faces.length === 1 && source.faces[0].surfaceType === "BSurf", "Constrained source is not a one-face B-Surface");
    const sourceStructure = onlySurface(await inspect(live.client, source, state.revision), "source B-Surface");
    requireCondition(sourceStructure.trimmed === false, "Fresh constrained B-Surface should be untrimmed");
    requireBSpline(sourceStructure, { uDegree: 3, vDegree: 3, uSpanCount: 3, vSpanCount: 2, uControlPointCount: 6, vControlPointCount: 5 });
    requireUvEqual(sourceStructure.faceParameterBounds, sourceStructure.naturalParameterBounds, "fresh B-Surface natural bounds");

    const beforeRaiseDepth = state.undoDepth;
    state = await call(live.client, "plasticity_raise_surface_degree", {
      faces: [{ bodyId: source.id, faceId: source.faces[0].id }],
      intent: "Raise native U and V B-Surface degree once", revision: state.revision,
    });
    requireCondition(state.undoDepth === beforeRaiseDepth + 1, "Surface degree elevation did not use one history step");
    const raisedBody = bodyById(state, source.id);
    const raisedStructure = onlySurface(await inspect(live.client, raisedBody, state.revision), "raised B-Surface");
    requireBSpline(raisedStructure, { uDegree: 4, vDegree: 4, uSpanCount: 5, vSpanCount: 3, uControlPointCount: 9, vControlPointCount: 7 });
    requireCondition(maxBoundsDelta(source.boundsMm, raisedBody.boundsMm) > 0.1, "Verified Plasticity degree elevation unexpectedly preserved every exact bound");
    state = await call(live.client, "plasticity_undo", { intent: "Verify surface-degree Undo", revision: state.revision });
    const undoRaise = bodyById(state, source.id);
    requireBoundsNear(undoRaise.boundsMm, source.boundsMm, "surface-degree Undo bounds");
    requireBSpline(onlySurface(await inspect(live.client, undoRaise, state.revision), "surface-degree Undo"), { uDegree: 3, vDegree: 3, uSpanCount: 3, vSpanCount: 2, uControlPointCount: 6, vControlPointCount: 5 });
    state = await call(live.client, "plasticity_redo", { intent: "Verify surface-degree Redo", revision: state.revision });
    requireBSpline(onlySurface(await inspect(live.client, bodyById(state, source.id), state.revision), "surface-degree Redo"), { uDegree: 4, vDegree: 4, uSpanCount: 5, vSpanCount: 3, uControlPointCount: 9, vControlPointCount: 7 });
    evidence.degreeElevation = {
      bodyId: source.id, structureBefore: sourceStructure, structureAfter: raisedStructure,
      boundsBeforeMm: source.boundsMm, boundsAfterMm: raisedBody.boundsMm,
      maximumExactBoundsChangeMm: maxBoundsDelta(source.boundsMm, raisedBody.boundsMm),
      stableBodyIdPreserved: true, oneHistoryStep: true, undoRedo: true,
      shapePreservationClaimed: false,
    };

    state = await call(live.client, "plasticity_undo", { intent: "Restore original B-Surface before untrim acceptance", revision: state.revision });
    state = await call(live.client, "plasticity_create_box", {
      originMm: [10, -10, -20], sizeMm: [1, 40, 40], name: "Surface refinement cutter",
      intent: "Create a disposable planar cutter body", revision: state.revision,
    });
    const cutter = namedBody(state, "Surface refinement cutter");
    const cutterFace = cutter.faces.find((face: any) => face.planar === true && Math.abs(face.centerMm[0] - 10) <= LINEAR_TOLERANCE_MM);
    requireCondition(cutterFace, "Planar cutter face at X=10 mm was not found");
    state = await call(live.client, "plasticity_cut_with_faces", {
      targetIds: [source.id], cutterFaces: [{ bodyId: cutter.id, faceId: cutterFace.id }],
      intent: "Split the B-Surface so native untrim can restore its carrier bounds", revision: state.revision,
    });
    const splitSheets = state.bodies.filter((body: any) => body.type === "Sheet");
    requireCondition(splitSheets.length === 2, `Expected two split Sheet bodies, found ${splitSheets.length}`);
    const splitStructures = [];
    for (const sheet of splitSheets) {
      const structure = onlySurface(await inspect(live.client, sheet, state.revision), `split Sheet ${sheet.id}`);
      requireCondition(structure.trimmed === true, `Split Sheet ${sheet.id} is not marked trimmed`);
      splitStructures.push({ bodyId: sheet.id, boundsMm: sheet.boundsMm, structure });
    }
    const selected = splitSheets.toSorted((left: any, right: any) => left.boundsMm.max[0] - right.boundsMm.max[0])[0];
    const beforeUntrimDepth = state.undoDepth;
    state = await call(live.client, "plasticity_untrim_faces", {
      faces: [{ bodyId: selected.id, faceId: selected.faces[0].id }],
      intent: "Restore one trimmed half to the natural carrier surface", revision: state.revision,
    });
    requireCondition(state.undoDepth === beforeUntrimDepth + 1, "Surface untrim did not use one history step");
    const untrimmedBody = bodyById(state, selected.id);
    const untrimmedStructure = onlySurface(await inspect(live.client, untrimmedBody, state.revision), "untrimmed B-Surface");
    requireCondition(untrimmedStructure.trimmed === false, "Untrim result is still marked trimmed");
    requireUvEqual(untrimmedStructure.faceParameterBounds, untrimmedStructure.naturalParameterBounds, "untrimmed natural bounds");
    requireBoundsNear(untrimmedBody.boundsMm, source.boundsMm, "untrimmed exact body bounds");
    const validation = await call(live.client, "plasticity_validate_bodies", { ids: [selected.id], revision: state.revision });
    requireCondition(validation.bodies[0]?.nativeValid === true && validation.bodies[0]?.printableSolid === false, "Untrimmed Sheet failed native validation");
    state = await call(live.client, "plasticity_undo", { intent: "Verify surface-untrim Undo", revision: state.revision });
    const undoUntrim = bodyById(state, selected.id);
    requireCondition(onlySurface(await inspect(live.client, undoUntrim, state.revision), "surface-untrim Undo").trimmed === true, "Surface-untrim Undo did not restore the trim");
    state = await call(live.client, "plasticity_redo", { intent: "Verify surface-untrim Redo", revision: state.revision });
    const redoUntrim = bodyById(state, selected.id);
    requireCondition(onlySurface(await inspect(live.client, redoUntrim, state.revision), "surface-untrim Redo").trimmed === false, "Surface-untrim Redo did not restore the natural surface");
    evidence.untrim = {
      sourceBodyId: source.id, selectedSplitBodyId: selected.id,
      sourceBoundsMm: source.boundsMm, splitSurfaces: splitStructures,
      untrimmedBoundsMm: untrimmedBody.boundsMm, untrimmedStructure,
      stableBodyIdPreserved: true, nativeValid: true, selectedTrimEdgesDiscarded: true,
      oneHistoryStep: true, undoRedo: true,
    };

    while (state.undoDepth > initialState.undoDepth) {
      state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable native surface-refinement acceptance", revision: state.revision });
    }
    requireEmpty(state, "cleanup document");
    const journal = await call(live.client, "plasticity_construction_journal", {});
    requireCondition(journal.syncStatus === "in-sync" && !journal.entries.some((entry: { status: string }) => entry.status === "unknown"), "Construction journal is not clean after native surface-refinement acceptance");
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

async function inspect(client: Client, body: any, revision: string): Promise<any> {
  return await call(client, "plasticity_inspect_surface_structure", {
    faces: body.faces.map((face: any) => ({ bodyId: body.id, faceId: face.id })), revision,
  });
}
function onlySurface(report: any, label: string): any { requireCondition(report.surfaces?.length === 1, `${label}: expected one surface, found ${report.surfaces?.length ?? 0}`); return report.surfaces[0]; }
function requireBSpline(surface: any, expected: Record<string, number>): void { requireCondition(surface.surfaceType === "BSurf" && surface.bSpline, "Expected native B-Surface structure"); for (const [key, value] of Object.entries(expected)) requireCondition(surface.bSpline[key] === value, `B-Surface ${key}: expected ${value}, got ${surface.bSpline[key]}`); }
function requireUvEqual(actual: any, expected: any, label: string): void { requireCondition(actual && expected, `${label}: UV bounds are unavailable`); for (const key of ["uMin", "uMax", "vMin", "vMax"]) requireCondition(Math.abs(actual[key] - expected[key]) <= PARAMETER_TOLERANCE, `${label} ${key} differs: ${actual[key]} vs ${expected[key]}`); }
function requireBoundsNear(actual: any, expected: any, label: string): void { requireCondition(actual && expected, `${label}: bounds are unavailable`); for (const side of ["min", "max"]) for (let axis = 0; axis < 3; axis += 1) requireCondition(Math.abs(actual[side][axis] - expected[side][axis]) <= LINEAR_TOLERANCE_MM, `${label} ${side}[${axis}] differs: ${actual[side][axis]} vs ${expected[side][axis]}`); }
function maxBoundsDelta(left: any, right: any): number { return Math.max(...["min", "max"].flatMap((side) => left[side].map((value: number, axis: number) => Math.abs(value - right[side][axis])))); }
function requireEmpty(state: any, label: string): void { const nonRootGroups = (state.groups ?? []).filter((group: any) => group.id !== 0); requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0 && nonRootGroups.length === 0, `${label} is not empty`); }
function bodyById(state: any, id: number): any { const body = state.bodies.find((candidate: any) => candidate.id === id); requireCondition(body, `Missing body ID: ${id}`); return body; }
function namedBody(state: any, name: string): any { const matches = state.bodies.filter((body: any) => body.name === name); requireCondition(matches.length === 1, `Expected one body named ${name}, found ${matches.length}`); return matches[0]; }
function onlyBodyOfType(state: any, type: string, label: string): any { const matches = state.bodies.filter((body: any) => body.type === type); requireCondition(matches.length === 1, `${label}: expected one ${type}, found ${matches.length}`); return matches[0]; }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function stateSummary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, regionCount: state.regions.length }; }

async function startMcp(storeRoot: string): Promise<LiveMcp> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" }, stderr: "pipe" });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); });
  const client = new Client({ name: "plasticity-native-surface-refinement-live", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr };
}
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> { const response = await client.callTool({ name, arguments: args }); const item = (response.content as Array<{ type: string; text?: string }>).find((entry) => entry.type === "text" && typeof entry.text === "string"); if (!item?.text) throw new Error("MCP tool returned no text content"); if (response.isError) throw new Error(item.text); return JSON.parse(item.text); }
async function recover(client: Client, initial: any): Promise<Record<string, unknown>> { for (let count = 0; count < 32; count += 1) { const status = await call(client, "plasticity_status", {}); if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" }; if (status.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: status.bodies.length === 0 && status.regions.length === 0 }; await call(client, "plasticity_undo", { intent: "Recover disposable native surface-refinement acceptance", revision: status.revision }); } return { restoredEmptyDocument: false, reason: "undo-limit" }; }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
