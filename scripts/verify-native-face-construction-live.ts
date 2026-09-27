#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LINEAR_TOLERANCE_MM = 0.01;

export interface NativeFaceConstructionAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parseNativeFaceConstructionAcceptanceArgs(argv: string[]): NativeFaceConstructionAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: NativeFaceConstructionAcceptanceOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live native-face-construction acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native-face-construction acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native-face-construction acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-face-construction-live.ts --help
  node scripts/verify-native-face-construction-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode refuses a nonempty Plasticity document, verifies native face
thickening, face-loop offset, Solid-loop Sheet patching, and complete shell
unjoining, exact analytic Cylinder-face unwrapping, and capped planar-face
lofting, with exact B-Rep evidence and Undo/Redo, then restores the initial
empty document.`;

async function main(): Promise<void> {
  const options = parseNativeFaceConstructionAcceptanceArgs(process.argv.slice(2));
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
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-face-construction-live-initial-empty" });

    let state = await call(live.client, "plasticity_create_box", {
      originMm: [0, 0, 0], sizeMm: [20, 10, 5], name: "Face thickening source",
      intent: "Create disposable source for native face thickening", revision: initialState.revision,
    });
    const thickeningSource = namedBody(state, "Face thickening source");
    const top = requirePlanarFace(thickeningSource, (face) => face.normal[2] > 0.999 && nearValue(face.centerMm[2], 5));
    const beforeThickenDepth = state.undoDepth;
    state = await call(live.client, "plasticity_thicken_faces", {
      faces: [{ bodyId: thickeningSource.id, faceId: top.id }], frontMm: 2, backMm: 1,
      intent: "Create an independent three-millimeter wall from the top face", revision: state.revision,
    });
    requireCondition(state.undoDepth === beforeThickenDepth + 1, "Face thickening did not use one native history step");
    const sourceAfterThicken = bodyById(state, thickeningSource.id);
    requireTopology(sourceAfterThicken, 6, 12, "preserved thickening source");
    requireBounds(sourceAfterThicken, [0, 0, 0], [20, 10, 5], "preserved thickening source");
    const thickened = onlyNewBody(state, new Set([thickeningSource.id]), "thickened face body");
    requireCondition(thickened.type === "Solid", "Face thickening did not create a Solid");
    requireTopology(thickened, 6, 12, "thickened face body");
    requireBounds(thickened, [0, 0, 4], [20, 10, 7], "thickened face body");
    const thickenedProperties = await exactProperties(live.client, thickened.id, state.revision, 600);
    state = await call(live.client, "plasticity_undo", { intent: "Verify native face-thickening Undo", revision: state.revision });
    requireCondition(state.bodies.length === 1 && bodyById(state, thickeningSource.id), "Face-thickening Undo did not preserve only the source");
    state = await call(live.client, "plasticity_redo", { intent: "Verify native face-thickening Redo", revision: state.revision });
    const redoneThickened = onlyNewBody(state, new Set([thickeningSource.id]), "redone thickened face body");
    requireBounds(redoneThickened, [0, 0, 4], [20, 10, 7], "redone thickened face body");
    evidence.faceThickening = {
      sourceBodyId: thickeningSource.id, resultBodyId: thickened.id, selectedFaceId: top.id,
      frontMm: 2, backMm: 1, resultBoundsMm: thickened.boundsMm,
      exactProperties: thickenedProperties, sourcePreserved: true, oneHistoryStep: true, undoRedo: true,
    };

    state = await call(live.client, "plasticity_create_box", {
      originMm: [40, 0, 0], sizeMm: [20, 10, 5], name: "Face loop-offset source",
      intent: "Create disposable source for native face-loop offset", revision: state.revision,
    });
    const loopSource = namedBody(state, "Face loop-offset source");
    const loopTop = requirePlanarFace(loopSource, (face) => face.normal[2] > 0.999 && nearValue(face.centerMm[2], 5));
    const loopVolumeBefore = await exactProperties(live.client, loopSource.id, state.revision, 1000);
    const beforeLoopDepth = state.undoDepth;
    state = await call(live.client, "plasticity_offset_face_loops", {
      faces: [{ bodyId: loopSource.id, faceId: loopTop.id }], distanceMm: 2, individual: true,
      intent: "Insert an exact two-millimeter inner loop on the top face", revision: state.revision,
    });
    requireCondition(state.undoDepth === beforeLoopDepth + 1, "Face-loop offset did not use one native history step");
    const loopResult = bodyById(state, loopSource.id);
    requireTopology(loopResult, 7, 16, "face-loop offset result");
    const insetFace = requirePlanarFace(loopResult, (face) => face.normal[2] > 0.999 && face.edgeIds.length === 4);
    const insetEdges = insetFace.edgeIds.map((id: string) => loopResult.edges.find((edge: any) => edge.id === id));
    requireCondition(insetEdges.every(Boolean), "Inset face edges are unavailable");
    const insetLengths = insetEdges.map((edge: any) => edge.lengthMm).sort((left: number, right: number) => left - right);
    nearArray(insetLengths, [6, 6, 16, 16], 1e-6, "inset edge lengths");
    const insetVertices = insetFace.edgeIds.flatMap((id: string) => loopResult.edges.find((edge: any) => edge.id === id)?.vertexIds ?? []);
    const distinctVertexIds = [...new Set(insetVertices)];
    const distinctVertices = distinctVertexIds.map((id) => loopResult.vertices.find((vertex: any) => vertex.id === id));
    requireCondition(distinctVertices.length === 4 && distinctVertices.every(Boolean), "Inset loop did not expose four exact vertices");
    for (const position of [[42, 2, 5], [58, 2, 5], [58, 8, 5], [42, 8, 5]] as Array<[number, number, number]>) {
      requireCondition(distinctVertices.some((vertex: any) => vectorNearBoolean(vertex.positionMm, position)), `Missing inset vertex [${position.join(", ")}]`);
    }
    const loopVolumeAfter = await exactProperties(live.client, loopSource.id, state.revision, 1000);
    state = await call(live.client, "plasticity_undo", { intent: "Verify native face-loop-offset Undo", revision: state.revision });
    requireTopology(bodyById(state, loopSource.id), 6, 12, "face-loop-offset Undo body");
    state = await call(live.client, "plasticity_redo", { intent: "Verify native face-loop-offset Redo", revision: state.revision });
    requireTopology(bodyById(state, loopSource.id), 7, 16, "face-loop-offset Redo body");
    evidence.faceLoopOffset = {
      bodyId: loopSource.id, selectedFaceId: loopTop.id, distanceMm: 2, individual: true,
      topologyBefore: { faceCount: 6, edgeCount: 12 }, topologyAfter: { faceCount: 7, edgeCount: 16 },
      insetEdgeLengthsMm: insetLengths, insetVertexPositionsMm: distinctVertices.map((vertex: any) => vertex.positionMm),
      exactVolumeBeforeMm3: loopVolumeBefore.volumeMm3, exactVolumeAfterMm3: loopVolumeAfter.volumeMm3,
      stableBodyIdPreserved: true, oneHistoryStep: true, undoRedo: true,
    };

    state = await call(live.client, "plasticity_create_box", {
      originMm: [80, 0, 0], sizeMm: [20, 20, 5], name: "Solid loop-patch source",
      intent: "Create disposable source for native Solid loop patching", revision: state.revision,
    });
    const patchSourceId = namedBody(state, "Solid loop-patch source").id;
    state = await call(live.client, "plasticity_create_cylinder", {
      centerMm: [90, 10, -1], radiusMm: 3, heightMm: 7, axis: [0, 0, 1], name: "Solid loop-patch cutter",
      intent: "Create a disposable through-hole cutter", revision: state.revision,
    });
    const cutterId = namedBody(state, "Solid loop-patch cutter").id;
    state = await call(live.client, "plasticity_boolean", {
      targetIds: [patchSourceId], toolIds: [cutterId], operation: "difference", keepTools: false,
      intent: "Create the source through-hole for native loop patching", revision: state.revision,
    });
    const holed = bodyById(state, patchSourceId);
    requireTopology(holed, 7, 14, "Solid loop-patch source");
    const topRing = requireCircularEdge(holed, (edge) => nearValue(edge.centerMm[2], 5), 3);
    const patchSourceProperties = await exactProperties(live.client, patchSourceId, state.revision, 2000 - 45 * Math.PI);
    const beforePatchDepth = state.undoDepth;
    state = await call(live.client, "plasticity_patch_solid_edge_loops", {
      edges: [{ bodyId: patchSourceId, edgeId: topRing.id }],
      intent: "Create an independent native Sheet over the top hole loop", revision: state.revision,
    });
    requireCondition(state.undoDepth === beforePatchDepth + 1, "Solid loop patch did not use one native history step");
    requireTopology(bodyById(state, patchSourceId), 7, 14, "preserved holed Solid");
    const patch = onlyNewBody(state, new Set([thickeningSource.id, redoneThickened.id, loopSource.id, patchSourceId]), "Solid loop Sheet patch");
    requireCondition(patch.type === "Sheet", "Solid edge-loop patch did not create a Sheet");
    requireTopology(patch, 1, 1, "Solid loop Sheet patch");
    const patchFace = requirePlanarFace(patch, (face) => face.normal[2] > 0.999 && nearValue(face.centerMm[2], 5));
    const patchEdge = requireCircularEdge(patch, () => true, 3);
    near(patchEdge.lengthMm, 6 * Math.PI, 1e-6, "Sheet patch circular edge length");
    const patchValidation = await call(live.client, "plasticity_validate_bodies", { ids: [patchSourceId, patch.id], revision: state.revision });
    const sourceValidation = patchValidation.bodies.find((body: any) => body.id === patchSourceId);
    const sheetValidation = patchValidation.bodies.find((body: any) => body.id === patch.id);
    requireCondition(sourceValidation?.nativeValid === true && sourceValidation.printableSolid === true && sourceValidation.nativeCheckCodes.length === 0, "Source Solid failed validation after Sheet patching");
    requireCondition(sheetValidation?.nativeValid === true && sheetValidation.printableSolid === false && sheetValidation.nativeCheckCodes.length === 0 && sheetValidation.boundaryEdgeIds.length === 1, "Independent Sheet patch validation mismatch");
    const sourcePropertiesAfterPatch = await exactProperties(live.client, patchSourceId, state.revision, 2000 - 45 * Math.PI);
    state = await call(live.client, "plasticity_undo", { intent: "Verify native Solid-loop-patch Undo", revision: state.revision });
    requireCondition(!state.bodies.some((body: any) => body.type === "Sheet"), "Solid-loop-patch Undo retained the Sheet");
    state = await call(live.client, "plasticity_redo", { intent: "Verify native Solid-loop-patch Redo", revision: state.revision });
    const redonePatches = state.bodies.filter((body: any) => body.type === "Sheet");
    requireCondition(redonePatches.length === 1, "Solid-loop-patch Redo did not restore one Sheet");
    requireTopology(redonePatches[0], 1, 1, "redone Solid loop Sheet patch");
    evidence.solidLoopPatch = {
      sourceBodyId: patchSourceId, selectedEdgeId: topRing.id, patchBodyId: patch.id,
      patchFaceId: patchFace.id, patchEdgeLengthMm: patchEdge.lengthMm,
      sourceTopologyPreserved: { faceCount: 7, edgeCount: 14 },
      sourceExactPropertiesBefore: patchSourceProperties, sourceExactPropertiesAfter: sourcePropertiesAfterPatch,
      sourceSolidPreserved: true, independentSheetCreated: true, holeNotFilled: true,
      validation: patchValidation, oneHistoryStep: true, undoRedo: true,
    };

    state = await call(live.client, "plasticity_create_box", {
      originMm: [120, 0, 0], sizeMm: [40, 30, 20], name: "Complete shell-unjoin source",
      intent: "Create disposable source for complete native shell unjoining", revision: state.revision,
    });
    const shellSourceId = namedBody(state, "Complete shell-unjoin source").id;
    state = await call(live.client, "plasticity_hollow_solids", {
      ids: [shellSourceId], wallThicknessMm: 2, direction: "inward",
      intent: "Create outer and inner faces for complete shell unjoining", revision: state.revision,
    });
    const shellSource = bodyById(state, shellSourceId);
    requireCondition(shellSource.type === "Solid", "Closed hollow source is not a Solid");
    requireTopology(shellSource, 12, 24, "closed hollow shell-unjoin source");
    const shellSourceProperties = await exactProperties(live.client, shellSourceId, state.revision, 9024);
    const bodiesBeforeUnjoin = new Set(state.bodies.map((body: any) => body.id));
    const beforeUnjoinDepth = state.undoDepth;
    state = await call(live.client, "plasticity_unjoin_shells", {
      ids: [shellSourceId], intent: "Explode the complete hollow Solid into independent one-face Sheets", revision: state.revision,
    });
    requireCondition(state.undoDepth === beforeUnjoinDepth + 1, "Complete shell unjoin did not use one native history step");
    const unjoined = state.bodies.filter((body: any) => body.id === shellSourceId || !bodiesBeforeUnjoin.has(body.id));
    requireCondition(unjoined.length === 12, `Complete shell unjoin returned ${unjoined.length} bodies instead of 12`);
    requireCondition(unjoined.every((body: any) => body.type === "Sheet" && body.faces.length === 1 && body.edges.length === 4), "Complete shell unjoin did not return twelve single-face Sheets");
    const fixedCoordinates = unjoined.map((body: any) => {
      requireCondition(body.boundsMm, `Unjoined Sheet ${body.id} has no exact bounds`);
      const axis = [0, 1, 2].find((index) => nearValue(body.boundsMm.min[index], body.boundsMm.max[index], 1e-6));
      requireCondition(axis !== undefined, `Unjoined Sheet ${body.id} is not planar in one world axis`);
      return body.boundsMm.min[axis];
    }).sort((left: number, right: number) => left - right);
    nearArray(fixedCoordinates, [0, 0, 2, 2, 18, 20, 28, 30, 120, 122, 158, 160], 1e-6, "unjoined face plane coordinates");
    const unjoinedIds = unjoined.map((body: any) => body.id).sort((left: number, right: number) => left - right);
    const unjoinedValidation = await call(live.client, "plasticity_validate_bodies", { ids: unjoinedIds, revision: state.revision });
    requireCondition(unjoinedValidation.bodies.length === 12 && unjoinedValidation.bodies.every((body: any) => body.type === "Sheet" && body.faceCount === 1 && body.edgeCount === 4 && body.boundaryEdgeIds.length === 4 && body.nativeValid === true && body.printableSolid === false && body.nativeCheckCodes.length === 0), "An unjoined single-face Sheet failed native validation");
    state = await call(live.client, "plasticity_undo", { intent: "Verify complete shell-unjoin Undo", revision: state.revision });
    requireCondition(bodyById(state, shellSourceId).type === "Solid" && bodyById(state, shellSourceId).faces.length === 12, "Shell-unjoin Undo did not restore the hollow Solid");
    state = await call(live.client, "plasticity_redo", { intent: "Verify complete shell-unjoin Redo", revision: state.revision });
    requireCondition(unjoinedIds.every((id: number) => state.bodies.some((body: any) => body.id === id && body.type === "Sheet")), "Shell-unjoin Redo did not restore stable Sheet IDs");
    evidence.completeShellUnjoin = {
      sourceBodyId: shellSourceId, sourceTopology: { faceCount: 12, edgeCount: 24 }, sourceExactProperties: shellSourceProperties,
      resultBodyIds: unjoinedIds, resultTopology: { bodyCount: 12, faceCountEach: 1, edgeCountEach: 4 },
      fixedPlaneCoordinatesMm: fixedCoordinates, validation: unjoinedValidation,
      oneHistoryStep: true, sourceReplaced: true, sourceIdReusedByOneSheet: true, undoRedo: true,
    };

    state = await call(live.client, "plasticity_create_cylinder", {
      centerMm: [200, 0, 0], radiusMm: 10, heightMm: 30, axis: [0, 0, 1], name: "Cylinder unwrap source",
      intent: "Create disposable source for exact analytic Cylinder-face unwrapping", revision: state.revision,
    });
    const unwrapSource = namedBody(state, "Cylinder unwrap source");
    requireCondition(unwrapSource.type === "Solid", "Cylinder unwrap source is not a Solid");
    requireBounds(unwrapSource, [190, -10, 0], [210, 10, 30], "Cylinder unwrap source");
    const cylinderFaces = unwrapSource.faces.filter((face: any) => face.surfaceType === "Cylinder");
    requireCondition(cylinderFaces.length === 1, `Cylinder unwrap source exposes ${cylinderFaces.length} Cylinder faces instead of one`);
    const cylinderFace = cylinderFaces[0];
    near(cylinderFace.radiusMm, 10, 1e-6, "Cylinder unwrap source radius");
    const unwrapSourceProperties = await exactProperties(live.client, unwrapSource.id, state.revision, 3000 * Math.PI);
    const bodyIdsBeforeUnwrap = new Set<number>(state.bodies.map((body: any) => body.id));
    const beforeUnwrapDepth = state.undoDepth;
    state = await call(live.client, "plasticity_unwrap_face", {
      face: { bodyId: unwrapSource.id, faceId: cylinderFace.id },
      intent: "Create an exact planar development of the disposable Cylinder face", revision: state.revision,
    });
    requireCondition(state.undoDepth === beforeUnwrapDepth + 1, "Cylinder-face unwrap did not use one native history step");
    requireCondition(bodyById(state, unwrapSource.id).type === "Solid", "Cylinder-face unwrap did not preserve the source Solid");
    const unwrapped = onlyNewBody(state, bodyIdsBeforeUnwrap, "unwrapped Cylinder face");
    requireCondition(unwrapped.type === "Sheet", "Cylinder-face unwrap did not create a Sheet");
    requireTopology(unwrapped, 1, 4, "unwrapped Cylinder face");
    requireCondition(unwrapped.faces[0]?.surfaceType === "Plane" && unwrapped.faces[0]?.planar === true, "Unwrapped Cylinder face is not one analytic Plane");
    requireCondition(unwrapped.edges.every((edge: any) => edge.curveType === "Line"), "Unwrapped Cylinder face contains a non-Line edge");
    requireCondition(unwrapped.boundsMm, "Unwrapped Cylinder face has no exact bounds");
    const unwrapSizes = [0, 1, 2].map((axis) => unwrapped.boundsMm.max[axis] - unwrapped.boundsMm.min[axis]).sort((left, right) => left - right);
    nearArray(unwrapSizes, [0, 30, 20 * Math.PI], LINEAR_TOLERANCE_MM, "unwrapped Cylinder face bounds sizes");
    const unwrapEdgeLengths = unwrapped.edges.map((edge: any) => edge.lengthMm).sort((left: number, right: number) => left - right);
    nearArray(unwrapEdgeLengths, [30, 30, 20 * Math.PI, 20 * Math.PI], LINEAR_TOLERANCE_MM, "unwrapped Cylinder face edge lengths");
    const unwrapValidation = await call(live.client, "plasticity_validate_bodies", { ids: [unwrapSource.id, unwrapped.id], revision: state.revision });
    const unwrapSourceValidation = unwrapValidation.bodies.find((body: any) => body.id === unwrapSource.id);
    const unwrappedValidation = unwrapValidation.bodies.find((body: any) => body.id === unwrapped.id);
    requireCondition(unwrapSourceValidation?.nativeValid === true && unwrapSourceValidation.printableSolid === true && unwrapSourceValidation.nativeCheckCodes.length === 0, "Cylinder source failed native validation after unwrap");
    requireCondition(unwrappedValidation?.nativeValid === true && unwrappedValidation.printableSolid === false && unwrappedValidation.boundaryEdgeIds.length === 4 && unwrappedValidation.nativeCheckCodes.length === 0, "Unwrapped Sheet failed native validation");
    const unwrapSourcePropertiesAfter = await exactProperties(live.client, unwrapSource.id, state.revision, 3000 * Math.PI);
    state = await call(live.client, "plasticity_undo", { intent: "Verify exact Cylinder-face unwrap Undo", revision: state.revision });
    requireCondition(!state.bodies.some((body: any) => body.id === unwrapped.id), "Cylinder-face unwrap Undo retained the planar Sheet");
    requireCondition(bodyById(state, unwrapSource.id).type === "Solid", "Cylinder-face unwrap Undo removed the source Solid");
    state = await call(live.client, "plasticity_redo", { intent: "Verify exact Cylinder-face unwrap Redo", revision: state.revision });
    const redoneUnwrapped = bodyById(state, unwrapped.id);
    requireCondition(redoneUnwrapped.type === "Sheet", "Cylinder-face unwrap Redo did not restore the same Sheet ID");
    requireCondition(redoneUnwrapped.boundsMm, "Redone unwrapped Cylinder face has no exact bounds");
    const redoneSizes = [0, 1, 2].map((axis) => redoneUnwrapped.boundsMm.max[axis] - redoneUnwrapped.boundsMm.min[axis]).sort((left: number, right: number) => left - right);
    nearArray(redoneSizes, [0, 30, 20 * Math.PI], LINEAR_TOLERANCE_MM, "redone unwrapped Cylinder face bounds sizes");
    evidence.cylindricalFaceUnwrap = {
      sourceBodyId: unwrapSource.id, selectedFaceId: cylinderFace.id, resultBodyId: unwrapped.id,
      radiusMm: 10, axialLengthMm: 30, expectedCircumferenceMm: 20 * Math.PI,
      resultBoundsMm: unwrapped.boundsMm, resultSizeMm: unwrapSizes, resultEdgeLengthsMm: unwrapEdgeLengths,
      sourceExactPropertiesBefore: unwrapSourceProperties, sourceExactPropertiesAfter: unwrapSourcePropertiesAfter,
      validation: unwrapValidation, sourcePreserved: true, oneHistoryStep: true, undoRedoStableId: true,
    };

    state = await call(live.client, "plasticity_create_box", {
      originMm: [240, 0, 0], sizeMm: [20, 10, 5], name: "Face loft source A",
      intent: "Create first disposable planar profile body for native face loft", revision: state.revision,
    });
    const loftSourceA = namedBody(state, "Face loft source A");
    state = await call(live.client, "plasticity_create_box", {
      originMm: [245, 2.5, 20], sizeMm: [10, 5, 5], name: "Face loft source B",
      intent: "Create second disposable planar profile body for native face loft", revision: state.revision,
    });
    const loftSourceB = namedBody(state, "Face loft source B");
    const loftFaceA = requirePlanarFace(loftSourceA, (face) => face.normal[2] > 0.999 && nearValue(face.centerMm[2], 5));
    const loftFaceB = requirePlanarFace(loftSourceB, (face) => face.normal[2] < -0.999 && nearValue(face.centerMm[2], 20));
    const bodyIdsBeforeLoft = new Set<number>(state.bodies.map((body: any) => body.id));
    const beforeLoftDepth = state.undoDepth;
    state = await call(live.client, "plasticity_loft_faces", {
      faces: [{ bodyId: loftSourceA.id, faceId: loftFaceA.id }, { bodyId: loftSourceB.id, faceId: loftFaceB.id }],
      guideIds: [], trimGuides: true, simplify: true,
      startCondition: "natural", endCondition: "natural", startMagnitude: 1, endMagnitude: 1,
      intent: "Create an independent exact natural loft between two disposable planar faces", revision: state.revision,
    });
    requireCondition(state.undoDepth === beforeLoftDepth + 1, "Planar-face loft did not use one native history step");
    requireCondition(bodyById(state, loftSourceA.id).type === "Solid" && bodyById(state, loftSourceB.id).type === "Solid", "Planar-face loft did not preserve both source Solids");
    const loftResult = onlyNewBody(state, bodyIdsBeforeLoft, "planar-face loft result");
    requireCondition(loftResult.type === "Solid", "Planar-face loft did not create a capped Solid");
    requireTopology(loftResult, 6, 12, "planar-face loft result");
    requireBounds(loftResult, [240, 0, 5], [260, 10, 20], "planar-face loft result");
    requireCondition(loftResult.faces.every((face: any) => face.planar === true && face.surfaceType === "Plane"), "Natural planar-face loft contains a nonplanar face");
    requireCondition(loftResult.edges.every((edge: any) => edge.line === true && edge.curveType === "Line"), "Natural planar-face loft contains a nonlinear edge");
    const loftProperties = await exactProperties(live.client, loftResult.id, state.revision, 1750);
    const loftValidation = await call(live.client, "plasticity_validate_bodies", { ids: [loftSourceA.id, loftSourceB.id, loftResult.id], revision: state.revision });
    requireCondition(loftValidation.bodies.length === 3 && loftValidation.bodies.every((body: any) => body.nativeValid === true && body.printableSolid === true && body.nativeCheckCodes.length === 0), "A planar-face loft source or result failed native validation");
    state = await call(live.client, "plasticity_undo", { intent: "Verify native planar-face loft Undo", revision: state.revision });
    requireCondition(!state.bodies.some((body: any) => body.id === loftResult.id), "Planar-face loft Undo retained the result Solid");
    requireCondition(bodyById(state, loftSourceA.id).type === "Solid" && bodyById(state, loftSourceB.id).type === "Solid", "Planar-face loft Undo removed a source Solid");
    state = await call(live.client, "plasticity_redo", { intent: "Verify native planar-face loft Redo", revision: state.revision });
    const redoneLoft = bodyById(state, loftResult.id);
    requireTopology(redoneLoft, 6, 12, "redone planar-face loft result");
    requireBounds(redoneLoft, [240, 0, 5], [260, 10, 20], "redone planar-face loft result");
    evidence.planarFaceLoft = {
      sourceBodyIds: [loftSourceA.id, loftSourceB.id],
      selectedFaces: [{ bodyId: loftSourceA.id, faceId: loftFaceA.id }, { bodyId: loftSourceB.id, faceId: loftFaceB.id }],
      resultBodyId: loftResult.id, conditions: ["natural", "natural"], magnitudes: [1, 1],
      resultBoundsMm: loftResult.boundsMm, resultTopology: { faceCount: 6, edgeCount: 12 },
      exactProperties: loftProperties, validation: loftValidation,
      sourceBodiesPreserved: true, oneHistoryStep: true, undoRedoStableId: true,
    };

    while (state.undoDepth > initialState.undoDepth) state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable native face-construction acceptance", revision: state.revision });
    requireEmpty(state, "cleaned document");
    const journal = await call(live.client, "plasticity_construction_journal", {});
    requireCondition(journal.syncStatus === "in-sync" && !journal.entries.some((entry: { status: string }) => entry.status === "unknown"), "Construction journal is not clean after face-construction acceptance");
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

function namedBody(state: any, name: string): any { const bodies = state.bodies.filter((body: any) => body.name === name); requireCondition(bodies.length === 1, `Expected one body named ${name}; found ${bodies.length}`); return bodies[0]; }
function bodyById(state: any, id: number): any { const body = state.bodies.find((candidate: any) => candidate.id === id); requireCondition(body, `Missing body ${id}`); return body; }
function onlyNewBody(state: any, knownIds: Set<number>, label: string): any { const bodies = state.bodies.filter((body: any) => !knownIds.has(body.id)); requireCondition(bodies.length === 1, `${label}: expected one new body, found ${bodies.length}`); return bodies[0]; }
function requirePlanarFace(body: any, predicate: (face: any) => boolean): any { const faces = body.faces.filter((face: any) => face.planar === true && predicate(face)); requireCondition(faces.length === 1, `Expected one matching planar face on body ${body.id}; found ${faces.length}`); return faces[0]; }
function requireCircularEdge(body: any, predicate: (edge: any) => boolean, radiusMm: number): any { const edges = body.edges.filter((edge: any) => edge.circle === true && nearValue(edge.lengthMm, 2 * Math.PI * radiusMm) && predicate(edge)); requireCondition(edges.length === 1, `Expected one matching R${radiusMm} circular edge on body ${body.id}; found ${edges.length}`); return edges[0]; }
function requireTopology(body: any, faceCount: number, edgeCount: number, label: string): void { requireCondition(body.faces.length === faceCount && body.edges.length === edgeCount, `${label}: expected ${faceCount} faces and ${edgeCount} edges; got ${body.faces.length} and ${body.edges.length}`); }
function requireBounds(body: any, min: [number, number, number], max: [number, number, number], label: string): void { requireCondition(body.boundsMm, `${label} has no bounds`); for (let index = 0; index < 3; index += 1) { near(body.boundsMm.min[index], min[index]!, LINEAR_TOLERANCE_MM, `${label} min[${index}]`); near(body.boundsMm.max[index], max[index]!, LINEAR_TOLERANCE_MM, `${label} max[${index}]`); } }
async function exactProperties(client: Client, id: number, revision: string, expectedVolumeMm3: number): Promise<any> { const report = await call(client, "plasticity_measure_solid_properties", { ids: [id], revision }); requireCondition(report.source === "native-brep-mass-properties" && report.bodies.length === 1 && report.bodies[0].id === id, "Exact solid-property evidence is unavailable"); near(report.bodies[0].volumeMm3, expectedVolumeMm3, 1e-6, `solid ${id} volume`); requireCondition(report.bodies[0].nativeCheckCodes.length === 0, `Solid ${id} mass properties found native validation errors`); return report.bodies[0]; }
function requireEmpty(state: any, label: string): void { requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0, `${label} is not empty`); requireCondition((state.groups ?? []).filter((group: { id: number }) => group.id !== 0).length === 0, `${label} contains non-root groups`); }
function stateSummary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, regionCount: state.regions.length }; }
function vectorNearBoolean(actual: unknown, expected: [number, number, number], tolerance = LINEAR_TOLERANCE_MM): boolean { return Array.isArray(actual) && actual.length === 3 && actual.every((value, index) => typeof value === "number" && Math.abs(value - expected[index]!) <= tolerance); }
function nearValue(actual: unknown, expected: number, tolerance = LINEAR_TOLERANCE_MM): boolean { return typeof actual === "number" && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance; }
function near(actual: unknown, expected: number, tolerance: number, label: string): void { requireCondition(typeof actual === "number" && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${String(actual)}`); }
function nearArray(actual: unknown[], expected: number[], tolerance: number, label: string): void { requireCondition(actual.length === expected.length, `${label}: expected ${expected.length} values, got ${actual.length}`); actual.forEach((value, index) => near(value, expected[index]!, tolerance, `${label}[${index}]`)); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

async function startMcp(storeRoot: string): Promise<LiveMcp> { const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" }, stderr: "pipe" }); const stderr: string[] = []; transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); }); const client = new Client({ name: "plasticity-native-face-construction-live", version: "1.0.0" }); await client.connect(transport); return { client, stderr }; }
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> { const response = await client.callTool({ name, arguments: args }); const output = toolText(response); if ("isError" in response && response.isError) throw new Error(output); return JSON.parse(output); }
function toolText(response: unknown): string { if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content"); const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string"); if (!item) throw new Error("MCP tool returned no text content"); return item.text; }
async function recover(client: Client, initial: any): Promise<Record<string, unknown>> { for (let count = 0; count < 32; count += 1) { const status = await call(client, "plasticity_status", {}); if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" }; if (status.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: status.bodies.length === 0 && status.regions.length === 0 }; await call(client, "plasticity_undo", { intent: "Recover disposable native face-construction acceptance", revision: status.revision }); } return { restoredEmptyDocument: false, reason: "undo-limit" }; }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
