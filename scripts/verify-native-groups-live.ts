#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface NativeGroupAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parseNativeGroupAcceptanceArgs(argv: string[]): NativeGroupAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: NativeGroupAcceptanceOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live native-group acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native-group acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native-group acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-groups-live.ts --help
  node scripts/verify-native-groups-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode refuses a nonempty Plasticity document or leftover non-root groups, never
chooses a window automatically, uses a separate stdio MCP process, verifies native
group state plus planar, cylindrical, vertex, and linear-edge placement, and writes
only sanitized evidence to a new directory.`;

async function main(): Promise<void> {
  const options = parseNativeGroupAcceptanceArgs(process.argv.slice(2));
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
    requireCondition(initialState.bodies.length === 0 && initialState.regions.length === 0 && initialState.instances.length === 0, "Refusing disposable mutations in a nonempty Plasticity document");
    requireCondition(nonRootGroups(initialState).length === 0, "Refusing disposable mutations while non-root Plasticity groups exist");
    evidence.initial = stateSummary(initialState);
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-groups-live-initial-empty" });

    let state = await call(live.client, "plasticity_create_box", {
      originMm: [0, 0, 0], sizeMm: [20, 10, 5], name: "Disposable bracket",
      intent: "Approved disposable native-group acceptance", revision: initialState.revision,
    });
    const bracketId = bodyIdNamed(state, "Disposable bracket");
    const bracketBounds = bodyById(state, bracketId).boundsMm;
    requireCondition(bracketBounds, "Bracket has no exact B-Rep bounds");

    state = await call(live.client, "plasticity_create_box", {
      originMm: [40, 0, 0], sizeMm: [30, 20, 8], name: "Disposable housing",
      intent: "Approved disposable native-group acceptance", revision: state.revision,
    });
    const housingBodyId = bodyIdNamed(state, "Disposable housing");
    const housingBounds = bodyById(state, housingBodyId).boundsMm;
    requireCondition(housingBounds, "Housing body has no exact B-Rep bounds");

    state = await call(live.client, "plasticity_create_instance", {
      bodyId: bracketId, translationMm: [0, 20, 0], intent: "Create grouped linked bracket", revision: state.revision,
    });
    const instanceId = state.instances[0]?.id;
    requireCondition(Number.isInteger(instanceId), "Linked bracket instance was not created");

    let priorDepth = state.undoDepth;
    state = await call(live.client, "plasticity_create_group", {
      bodyIds: [bracketId], instanceIds: [instanceId], name: "Bracket module",
      intent: "Group reusable bracket components", revision: state.revision,
    });
    requireHistoryStep(state, priorDepth, "Create bracket group");
    const bracketGroup = groupNamed(state, "Bracket module");
    requireCondition(bracketGroup.bodyIds.includes(bracketId), "Bracket group does not contain its source body");
    requireCondition(bracketGroup.instanceIds.includes(instanceId), "Bracket group does not contain its linked instance");

    priorDepth = state.undoDepth;
    state = await call(live.client, "plasticity_create_group", {
      bodyIds: [housingBodyId], name: "Housing assembly",
      intent: "Group the housing body", revision: state.revision,
    });
    requireHistoryStep(state, priorDepth, "Create housing group");
    const housingGroup = groupNamed(state, "Housing assembly");
    requireCondition(housingGroup.bodyIds.includes(housingBodyId), "Housing group does not contain its body");

    priorDepth = state.undoDepth;
    state = await call(live.client, "plasticity_activate_group", {
      id: housingGroup.id, intent: "Create later geometry directly in the housing assembly", revision: state.revision,
    });
    requireHistoryStep(state, priorDepth, "Activate housing group");
    requireCondition(state.activeGroupId === housingGroup.id, "Housing group did not become active");
    state = await call(live.client, "plasticity_undo", { intent: "Verify active-group Undo", revision: state.revision });
    requireCondition(state.activeGroupId === 0, "Active-group Undo did not restore the root Scene group");
    state = await call(live.client, "plasticity_redo", { intent: "Verify active-group Redo", revision: state.revision });
    requireCondition(state.activeGroupId === housingGroup.id, "Active-group Redo did not restore the housing group");

    state = await call(live.client, "plasticity_create_box", {
      originMm: [80, 0, 0], sizeMm: [5, 5, 5], name: "Disposable active-group child",
      intent: "Verify creation in the active native group", revision: state.revision,
    });
    const activeChildBodyId = bodyIdNamed(state, "Disposable active-group child");
    requireCondition(groupById(state, housingGroup.id).bodyIds.includes(activeChildBodyId), "New geometry was not created in the active housing group");

    priorDepth = state.undoDepth;
    state = await call(live.client, "plasticity_move_to_group", {
      groupIds: [bracketGroup.id], destinationGroupId: housingGroup.id,
      intent: "Nest the bracket module in the housing assembly", revision: state.revision,
    });
    requireHistoryStep(state, priorDepth, "Nest bracket group");
    requireNested(state, bracketGroup.id, housingGroup.id);
    state = await call(live.client, "plasticity_undo", { intent: "Verify group nesting Undo", revision: state.revision });
    requireCondition(groupById(state, bracketGroup.id).parentId === 0, "Nesting Undo did not restore the bracket group to Scene");
    state = await call(live.client, "plasticity_redo", { intent: "Verify group nesting Redo", revision: state.revision });
    requireNested(state, bracketGroup.id, housingGroup.id);

    priorDepth = state.undoDepth;
    state = await call(live.client, "plasticity_rename_group", {
      id: bracketGroup.id, name: "Bracket module revised", intent: "Verify native group rename", revision: state.revision,
    });
    requireHistoryStep(state, priorDepth, "Rename bracket group");
    requireCondition(groupById(state, bracketGroup.id).name === "Bracket module revised", "Group rename did not persist");
    state = await call(live.client, "plasticity_undo", { intent: "Verify group rename Undo", revision: state.revision });
    requireCondition(groupById(state, bracketGroup.id).name === "Bracket module", "Rename Undo did not restore the old name");
    state = await call(live.client, "plasticity_redo", { intent: "Verify group rename Redo", revision: state.revision });
    requireCondition(groupById(state, bracketGroup.id).name === "Bracket module revised", "Rename Redo did not restore the new name");

    const selected = await call(live.client, "plasticity_select_nodes", {
      bodyIds: [housingBodyId], instanceIds: [instanceId], groupIds: [bracketGroup.id], revision: state.revision,
    });
    requireExactIds(selected.bodyIds, [housingBodyId], "selected bodies");
    requireExactIds(selected.instanceIds, [instanceId], "selected instances");
    requireExactIds(selected.groupIds, [bracketGroup.id], "selected groups");
    const rereadSelection = await call(live.client, "plasticity_current_selection", {});
    requireExactIds(rereadSelection.bodyIds, [housingBodyId], "re-read selected bodies");
    requireExactIds(rereadSelection.instanceIds, [instanceId], "re-read selected instances");
    requireExactIds(rereadSelection.groupIds, [bracketGroup.id], "re-read selected groups");
    const topologyBody = bodyById(state, bracketId);
    const faceReference = { bodyId: bracketId, faceId: topologyBody.faceIds[0] };
    const faceSelection = await call(live.client, "plasticity_select_faces", { faces: [faceReference], revision: state.revision });
    requireCondition(faceSelection.faces.length === 1 && faceSelection.faces[0].bodyId === bracketId && faceSelection.faces[0].faceId === faceReference.faceId, "Exact face selection did not round-trip");
    const edgeReference = { bodyId: bracketId, edgeId: topologyBody.edgeIds[0] };
    const edgeSelection = await call(live.client, "plasticity_select_edges", { edges: [edgeReference], revision: state.revision });
    requireCondition(edgeSelection.edges.length === 1 && edgeSelection.edges[0].bodyId === bracketId && edgeSelection.edges[0].edgeId === edgeReference.edgeId, "Exact edge selection did not round-trip");

    const alignmentSource = planarFaceWithNormal(state, bracketId, [-1, 0, 0]);
    const alignmentTarget = planarFaceWithNormal(state, housingBodyId, [0, 0, 1]);
    const companionBounds = bodyById(state, activeChildBodyId).boundsMm;
    const initialCenterDistance = distanceBetween(bodyCenter(bracketBounds), bodyCenter(companionBounds));
    priorDepth = state.undoDepth;
    state = await call(live.client, "plasticity_align_planar_faces", {
      ids: [bracketId, activeChildBodyId],
      sourceFace: { bodyId: bracketId, faceId: alignmentSource.id },
      targetFace: { bodyId: housingBodyId, faceId: alignmentTarget.id },
      relation: "opposed", gapMm: 2,
      intent: "Verify exact native face-to-face assembly placement", revision: state.revision,
    });
    requireHistoryStep(state, priorDepth, "Align planar faces");
    const alignedSource = planarFaceWithNormal(state, bracketId, [0, 0, -1]);
    const expectedSourceCenter = [alignmentTarget.centerMm[0], alignmentTarget.centerMm[1], alignmentTarget.centerMm[2] + 2];
    vectorNear(alignedSource.centerMm, expectedSourceCenter, 0.01, "aligned source face center");
    vectorNear(alignedSource.normal, [0, 0, -1], 1e-8, "aligned source face normal");
    vectorNear(bodyById(state, housingBodyId).boundsMm.min, housingBounds.min, 0.01, "fixed target bounds minimum after alignment");
    vectorNear(bodyById(state, housingBodyId).boundsMm.max, housingBounds.max, 0.01, "fixed target bounds maximum after alignment");
    requireCondition(Math.abs(distanceBetween(bodyCenter(bodyById(state, bracketId).boundsMm), bodyCenter(bodyById(state, activeChildBodyId).boundsMm)) - initialCenterDistance) <= 0.01, "Alignment did not preserve the moving body set as a rigid cluster");
    const alignedBounds = bodyById(state, bracketId).boundsMm;
    state = await call(live.client, "plasticity_undo", { intent: "Verify planar-face alignment Undo", revision: state.revision });
    vectorNear(bodyById(state, bracketId).boundsMm.min, bracketBounds.min, 0.01, "alignment Undo bracket minimum");
    vectorNear(bodyById(state, activeChildBodyId).boundsMm.min, companionBounds.min, 0.01, "alignment Undo companion minimum");
    state = await call(live.client, "plasticity_redo", { intent: "Verify planar-face alignment Redo", revision: state.revision });
    vectorNear(bodyById(state, bracketId).boundsMm.min, alignedBounds.min, 0.01, "alignment Redo bracket minimum");
    state = await call(live.client, "plasticity_undo", { intent: "Restore bodies after planar-face acceptance", revision: state.revision });
    vectorNear(bodyById(state, bracketId).boundsMm.min, bracketBounds.min, 0.01, "alignment final restore bracket minimum");

    priorDepth = state.undoDepth;
    state = await call(live.client, "plasticity_set_visibility", {
      bodyIds: [housingBodyId], visible: false, intent: "Verify exact native body visibility", revision: state.revision,
    });
    requireHistoryStep(state, priorDepth, "Hide housing body");
    requireCondition(bodyById(state, housingBodyId).visible === false, "Housing body remains visible");
    state = await call(live.client, "plasticity_undo", { intent: "Verify visibility Undo", revision: state.revision });
    requireCondition(bodyById(state, housingBodyId).visible === true, "Visibility Undo did not show the housing body");
    state = await call(live.client, "plasticity_redo", { intent: "Verify visibility Redo", revision: state.revision });
    requireCondition(bodyById(state, housingBodyId).visible === false, "Visibility Redo did not hide the housing body");

    priorDepth = state.undoDepth;
    state = await call(live.client, "plasticity_set_locked", {
      instanceIds: [instanceId], locked: true, intent: "Verify exact native instance lock", revision: state.revision,
    });
    requireHistoryStep(state, priorDepth, "Lock linked instance");
    requireCondition(instanceById(state, instanceId).locked === true, "Linked instance remains unlocked");
    state = await call(live.client, "plasticity_undo", { intent: "Verify lock Undo", revision: state.revision });
    requireCondition(instanceById(state, instanceId).locked === false, "Lock Undo did not unlock the linked instance");
    state = await call(live.client, "plasticity_redo", { intent: "Verify lock Redo", revision: state.revision });
    requireCondition(instanceById(state, instanceId).locked === true, "Lock Redo did not relock the linked instance");

    priorDepth = state.undoDepth;
    state = await call(live.client, "plasticity_dissolve_groups", {
      ids: [bracketGroup.id], intent: "Promote bracket contents into the housing assembly", revision: state.revision,
    });
    requireHistoryStep(state, priorDepth, "Dissolve bracket group");
    requireCondition(!state.groups.some((group: { id: number }) => group.id === bracketGroup.id), "Dissolved group remains current");
    requirePromotedContents(state, housingGroup.id, bracketId, instanceId);
    state = await call(live.client, "plasticity_undo", { intent: "Verify group dissolve Undo", revision: state.revision });
    requireNested(state, bracketGroup.id, housingGroup.id);
    state = await call(live.client, "plasticity_redo", { intent: "Verify group dissolve Redo", revision: state.revision });
    requireCondition(!state.groups.some((group: { id: number }) => group.id === bracketGroup.id), "Dissolve Redo restored the removed group");
    requirePromotedContents(state, housingGroup.id, bracketId, instanceId);

    vectorNear(bodyById(state, bracketId).boundsMm.min, bracketBounds.min, 0.01, "bracket bounds minimum after hierarchy edits");
    vectorNear(bodyById(state, bracketId).boundsMm.max, bracketBounds.max, 0.01, "bracket bounds maximum after hierarchy edits");
    vectorNear(bodyById(state, housingBodyId).boundsMm.min, housingBounds.min, 0.01, "housing bounds minimum after hierarchy edits");
    vectorNear(bodyById(state, housingBodyId).boundsMm.max, housingBounds.max, 0.01, "housing bounds maximum after hierarchy edits");

    state = await call(live.client, "plasticity_create_cylinder", {
      centerMm: [0, 40, 0], radiusMm: 3, heightMm: 12, axis: [1, 0, 0], name: "Disposable moving cylinder",
      intent: "Create source axis for cylindrical alignment", revision: state.revision,
    });
    const movingCylinderId = bodyIdNamed(state, "Disposable moving cylinder");
    const movingCylinderBounds = bodyById(state, movingCylinderId).boundsMm;
    state = await call(live.client, "plasticity_create_cylinder", {
      centerMm: [50, 50, 5], radiusMm: 4, heightMm: 15, axis: [0, 0, 1], name: "Disposable fixed cylinder",
      intent: "Create target axis for cylindrical alignment", revision: state.revision,
    });
    const fixedCylinderId = bodyIdNamed(state, "Disposable fixed cylinder");
    const fixedCylinderBounds = bodyById(state, fixedCylinderId).boundsMm;
    const sourceCylinderFace = cylindricalFace(state, movingCylinderId);
    const targetCylinderFace = cylindricalFace(state, fixedCylinderId);
    const cylinderCompanionBounds = bodyById(state, activeChildBodyId).boundsMm;
    const initialCylinderClusterDistance = distanceBetween(bodyCenter(movingCylinderBounds), bodyCenter(cylinderCompanionBounds));

    priorDepth = state.undoDepth;
    state = await call(live.client, "plasticity_align_cylindrical_faces", {
      ids: [movingCylinderId, activeChildBodyId],
      sourceFace: { bodyId: movingCylinderId, faceId: sourceCylinderFace.id },
      targetFace: { bodyId: fixedCylinderId, faceId: targetCylinderFace.id },
      relation: "same", axialMode: "preserve", axialOffsetMm: 0, rotationAroundAxisDeg: 30,
      intent: "Verify coaxial placement while preserving axial position", revision: state.revision,
    });
    requireHistoryStep(state, priorDepth, "Align cylindrical faces in preserve mode");
    let alignedCylinderFace = cylindricalFace(state, movingCylinderId);
    vectorNear(alignedCylinderFace.axisOriginMm, [50, 50, 0], 0.01, "preserved cylindrical source origin");
    vectorNear(alignedCylinderFace.axisDirection, [0, 0, 1], 1e-8, "preserved cylindrical source direction");
    vectorNear(bodyById(state, fixedCylinderId).boundsMm.min, fixedCylinderBounds.min, 0.01, "fixed cylinder minimum after preserve alignment");
    vectorNear(bodyById(state, fixedCylinderId).boundsMm.max, fixedCylinderBounds.max, 0.01, "fixed cylinder maximum after preserve alignment");
    requireCondition(Math.abs(distanceBetween(bodyCenter(bodyById(state, movingCylinderId).boundsMm), bodyCenter(bodyById(state, activeChildBodyId).boundsMm)) - initialCylinderClusterDistance) <= 0.01, "Cylindrical alignment did not preserve the moving body set as a rigid cluster");
    state = await call(live.client, "plasticity_undo", { intent: "Verify cylindrical preserve Undo", revision: state.revision });
    vectorNear(bodyById(state, movingCylinderId).boundsMm.min, movingCylinderBounds.min, 0.01, "cylindrical preserve Undo minimum");
    vectorNear(bodyById(state, activeChildBodyId).boundsMm.min, cylinderCompanionBounds.min, 0.01, "cylindrical preserve Undo companion minimum");
    state = await call(live.client, "plasticity_redo", { intent: "Verify cylindrical preserve Redo", revision: state.revision });
    vectorNear(cylindricalFace(state, movingCylinderId).axisOriginMm, [50, 50, 0], 0.01, "cylindrical preserve Redo origin");
    state = await call(live.client, "plasticity_undo", { intent: "Restore cylinders before anchor mode", revision: state.revision });

    priorDepth = state.undoDepth;
    state = await call(live.client, "plasticity_align_cylindrical_faces", {
      ids: [movingCylinderId],
      sourceFace: { bodyId: movingCylinderId, faceId: cylindricalFace(state, movingCylinderId).id },
      targetFace: { bodyId: fixedCylinderId, faceId: cylindricalFace(state, fixedCylinderId).id },
      relation: "same", axialMode: "anchor", axialOffsetMm: 2, rotationAroundAxisDeg: 0,
      intent: "Verify anchored coaxial placement with signed offset", revision: state.revision,
    });
    requireHistoryStep(state, priorDepth, "Align cylindrical faces in anchor mode");
    alignedCylinderFace = cylindricalFace(state, movingCylinderId);
    vectorNear(alignedCylinderFace.axisOriginMm, [50, 50, 7], 0.01, "anchored cylindrical source origin");
    vectorNear(alignedCylinderFace.axisDirection, [0, 0, 1], 1e-8, "anchored cylindrical source direction");
    state = await call(live.client, "plasticity_undo", { intent: "Verify cylindrical anchor Undo", revision: state.revision });
    vectorNear(bodyById(state, movingCylinderId).boundsMm.min, movingCylinderBounds.min, 0.01, "cylindrical anchor Undo minimum");
    state = await call(live.client, "plasticity_redo", { intent: "Verify cylindrical anchor Redo", revision: state.revision });
    vectorNear(cylindricalFace(state, movingCylinderId).axisOriginMm, [50, 50, 7], 0.01, "cylindrical anchor Redo origin");

    state = await call(live.client, "plasticity_create_box", {
      originMm: [100, 0, 0], sizeMm: [10, 10, 10], name: "Disposable moving vertex box",
      intent: "Create source corner for vertex alignment", revision: state.revision,
    });
    const movingVertexBoxId = bodyIdNamed(state, "Disposable moving vertex box");
    const movingVertexBounds = bodyById(state, movingVertexBoxId).boundsMm;
    state = await call(live.client, "plasticity_create_box", {
      originMm: [130, 20, 5], sizeMm: [10, 10, 10], name: "Disposable fixed vertex box",
      intent: "Create fixed corner for vertex alignment", revision: state.revision,
    });
    const fixedVertexBoxId = bodyIdNamed(state, "Disposable fixed vertex box");
    const fixedVertexBounds = bodyById(state, fixedVertexBoxId).boundsMm;
    const sourceVertex = vertexAt(state, movingVertexBoxId, [100, 0, 0]);
    const targetVertex = vertexAt(state, fixedVertexBoxId, [130, 20, 5]);

    priorDepth = state.undoDepth;
    state = await call(live.client, "plasticity_align_vertices", {
      ids: [movingVertexBoxId],
      sourceVertex: { bodyId: movingVertexBoxId, vertexId: sourceVertex.id },
      targetVertex: { bodyId: fixedVertexBoxId, vertexId: targetVertex.id },
      offsetMm: [0, 0, 2],
      intent: "Verify exact native corner placement with an explicit offset", revision: state.revision,
    });
    requireHistoryStep(state, priorDepth, "Align vertices");
    vectorNear(vertexById(state, movingVertexBoxId, sourceVertex.id).positionMm, [130, 20, 7], 0.01, "aligned source vertex");
    vectorNear(bodyById(state, fixedVertexBoxId).boundsMm.min, fixedVertexBounds.min, 0.01, "fixed vertex box minimum after alignment");
    vectorNear(bodyById(state, fixedVertexBoxId).boundsMm.max, fixedVertexBounds.max, 0.01, "fixed vertex box maximum after alignment");
    state = await call(live.client, "plasticity_undo", { intent: "Verify vertex alignment Undo", revision: state.revision });
    vectorNear(bodyById(state, movingVertexBoxId).boundsMm.min, movingVertexBounds.min, 0.01, "vertex alignment Undo minimum");
    state = await call(live.client, "plasticity_redo", { intent: "Verify vertex alignment Redo", revision: state.revision });
    vectorNear(vertexById(state, movingVertexBoxId, sourceVertex.id).positionMm, [130, 20, 7], 0.01, "vertex alignment Redo position");

    state = await call(live.client, "plasticity_create_box", {
      originMm: [170, 0, 0], sizeMm: [20, 10, 5], name: "Disposable moving edge box",
      intent: "Create source Line edge for rigid alignment", revision: state.revision,
    });
    const movingEdgeBoxId = bodyIdNamed(state, "Disposable moving edge box");
    const movingEdgeBounds = bodyById(state, movingEdgeBoxId).boundsMm;
    state = await call(live.client, "plasticity_create_box", {
      originMm: [220, 30, 10], sizeMm: [10, 30, 5], name: "Disposable fixed edge box",
      intent: "Create fixed Line edge for rigid alignment", revision: state.revision,
    });
    const fixedEdgeBoxId = bodyIdNamed(state, "Disposable fixed edge box");
    const fixedEdgeBounds = bodyById(state, fixedEdgeBoxId).boundsMm;
    const sourceEdge = linearEdgeAt(state, movingEdgeBoxId, [180, 0, 0], 20);
    const targetEdge = linearEdgeAt(state, fixedEdgeBoxId, [220, 45, 10], 30);
    const fixedEdgeDirection = normalizeVector(targetEdge.tangent, "fixed target edge direction");
    const expectedEdgeCenter = targetEdge.centerMm.map((value: number, index: number) => value + fixedEdgeDirection[index]! * 3);

    priorDepth = state.undoDepth;
    state = await call(live.client, "plasticity_align_linear_edges", {
      ids: [movingEdgeBoxId],
      sourceEdge: { bodyId: movingEdgeBoxId, edgeId: sourceEdge.id },
      targetEdge: { bodyId: fixedEdgeBoxId, edgeId: targetEdge.id },
      relation: "same", axialOffsetMm: 3, rotationAroundAxisDeg: 30,
      intent: "Verify straight-edge midpoint, tangent, offset, and roll placement", revision: state.revision,
    });
    requireHistoryStep(state, priorDepth, "Align linear edges");
    let alignedEdge = linearEdgeAt(state, movingEdgeBoxId, expectedEdgeCenter, 20);
    vectorNear(alignedEdge.centerMm, expectedEdgeCenter, 0.01, "aligned source edge center");
    requireCondition(dotProduct(normalizeVector(alignedEdge.tangent, "aligned source edge direction"), fixedEdgeDirection) >= 1 - 1e-8, "Aligned source edge tangent does not match the fixed target tangent");
    vectorNear(bodyById(state, fixedEdgeBoxId).boundsMm.min, fixedEdgeBounds.min, 0.01, "fixed edge box minimum after alignment");
    vectorNear(bodyById(state, fixedEdgeBoxId).boundsMm.max, fixedEdgeBounds.max, 0.01, "fixed edge box maximum after alignment");
    state = await call(live.client, "plasticity_undo", { intent: "Verify linear-edge alignment Undo", revision: state.revision });
    vectorNear(bodyById(state, movingEdgeBoxId).boundsMm.min, movingEdgeBounds.min, 0.01, "linear-edge alignment Undo minimum");
    state = await call(live.client, "plasticity_redo", { intent: "Verify linear-edge alignment Redo", revision: state.revision });
    alignedEdge = linearEdgeAt(state, movingEdgeBoxId, expectedEdgeCenter, 20);
    vectorNear(alignedEdge.centerMm, expectedEdgeCenter, 0.01, "linear-edge alignment Redo center");
    requireCondition(dotProduct(normalizeVector(alignedEdge.tangent, "linear-edge Redo direction"), fixedEdgeDirection) >= 1 - 1e-8, "Linear-edge Redo did not restore the requested tangent direction");

    const listed = await call(live.client, "plasticity_list_groups", {});
    requireCondition(JSON.stringify(listed.groups) === JSON.stringify(state.groups), "Read-only group listing disagrees with document state");

    evidence.groups = {
      bracketGroupId: bracketGroup.id,
      housingGroupId: housingGroup.id,
      activeChildBodyId,
      finalHierarchy: listed.groups,
      promotedBodyIds: groupById(state, housingGroup.id).bodyIds,
      promotedInstanceIds: groupById(state, housingGroup.id).instanceIds,
    };
    evidence.nodeState = { hiddenBodyId: housingBodyId, hidden: true, lockedInstanceId: instanceId, locked: true };
    evidence.selection = { bodyIds: selected.bodyIds, instanceIds: selected.instanceIds, groupIds: selected.groupIds, face: faceSelection.faces[0], edge: edgeSelection.edges[0], revision: selected.revision };
    evidence.alignment = { relation: "opposed", gapMm: 2, sourceBodyId: bracketId, companionBodyId: activeChildBodyId, targetBodyId: housingBodyId, sourceCenterMm: alignedSource.centerMm, sourceNormal: alignedSource.normal, oneHistoryStep: true, undoRedo: true };
    evidence.cylindricalAlignment = { sourceBodyId: movingCylinderId, targetBodyId: fixedCylinderId, preserve: { axialPositionKept: true, rotationAroundAxisDeg: 30, rigidCompanionBodyId: activeChildBodyId }, anchor: { axialOffsetMm: 2, sourceAxisOriginMm: cylindricalFace(state, movingCylinderId).axisOriginMm }, eachOneHistoryStep: true, undoRedo: true };
    evidence.vertexAlignment = { sourceBodyId: movingVertexBoxId, targetBodyId: fixedVertexBoxId, sourceVertexId: sourceVertex.id, targetVertexId: targetVertex.id, offsetMm: [0, 0, 2], sourcePositionMm: vertexById(state, movingVertexBoxId, sourceVertex.id).positionMm, oneHistoryStep: true, undoRedo: true };
    evidence.linearEdgeAlignment = { sourceBodyId: movingEdgeBoxId, targetBodyId: fixedEdgeBoxId, sourceEdgeIdBefore: sourceEdge.id, sourceEdgeIdAfter: alignedEdge.id, topologyReferenceRefreshed: sourceEdge.id !== alignedEdge.id, targetEdgeId: targetEdge.id, relation: "same", axialOffsetMm: 3, rotationAroundAxisDeg: 30, sourceCenterMm: alignedEdge.centerMm, sourceTangent: alignedEdge.tangent, targetTangent: targetEdge.tangent, oneHistoryStep: true, undoRedo: true };
    evidence.geometry = {
      measurementSource: "native-brep",
      bracketBoundsMm: bodyById(state, bracketId).boundsMm,
      housingBoundsMm: bodyById(state, housingBodyId).boundsMm,
    };
    evidence.history = { steps: { createGroup: 1, activate: 1, nest: 1, rename: 1, align: 1, cylindricalAlignPreserve: 1, cylindricalAlignAnchor: 1, vertexAlign: 1, linearEdgeAlign: 1, visibility: 1, lock: 1, dissolve: 1 }, undoRedo: { activate: true, nest: true, rename: true, align: true, cylindricalAlignPreserve: true, cylindricalAlignAnchor: true, vertexAlign: true, linearEdgeAlign: true, visibility: true, lock: true, dissolve: true } };

    const journal = await call(live.client, "plasticity_construction_journal", {});
    requireCleanJournal(journal);
    while (state.undoDepth > initialState.undoDepth) state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable native-group acceptance", revision: state.revision });
    requireCondition(state.bodies.length === 0 && state.regions.length === 0 && state.instances.length === 0, "Cleanup did not restore the empty document");
    requireCondition(nonRootGroups(state).length === 0, "Cleanup left native groups in the document");
    const changes = await call(live.client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(changes.diff), "Scene content differs from the initial empty snapshot after cleanup");
    evidence.cleanup = { restoredEmptyDocument: true, sceneContentsRestored: true, nonRootGroupCount: 0 };
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

async function startMcp(storeRoot: string): Promise<LiveMcp> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" }, stderr: "pipe" });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); });
  const client = new Client({ name: "plasticity-native-groups-live", version: "1.0.0" });
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
    if (status.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: status.bodies.length === 0 && status.instances.length === 0 && nonRootGroups(status).length === 0 };
    await call(client, "plasticity_undo", { intent: "Recover disposable native-group acceptance", revision: status.revision });
  }
  return { restoredEmptyDocument: false, reason: "undo-limit" };
}

function bodyIdNamed(state: any, name: string): number {
  const id = state.bodies.find((body: { name: string | null }) => body.name === name)?.id;
  requireCondition(Number.isInteger(id), `Body named ${name} was not found`);
  return id;
}

function bodyById(state: any, id: number): any {
  const body = state.bodies.find((candidate: { id: number }) => candidate.id === id);
  requireCondition(body, `Body ${id} was not found`);
  return body;
}

function instanceById(state: any, id: number): any {
  const instance = state.instances.find((candidate: { id: number }) => candidate.id === id);
  requireCondition(instance, `Instance ${id} was not found`);
  return instance;
}

function groupNamed(state: any, name: string): any {
  const group = state.groups.find((candidate: { name: string | null }) => candidate.name === name);
  requireCondition(group, `Group named ${name} was not found`);
  return group;
}

function groupById(state: any, id: number): any {
  const group = state.groups.find((candidate: { id: number }) => candidate.id === id);
  requireCondition(group, `Group ${id} was not found`);
  return group;
}

function nonRootGroups(state: any): any[] { return (state.groups ?? []).filter((group: { id: number }) => group.id !== 0); }
function requireNested(state: any, childId: number, parentId: number): void {
  const child = groupById(state, childId);
  const parent = groupById(state, parentId);
  requireCondition(child.parentId === parentId && parent.childGroupIds.includes(childId), `Group ${childId} is not nested under ${parentId}`);
}
function requirePromotedContents(state: any, groupId: number, bodyId: number, instanceId: number): void {
  const group = groupById(state, groupId);
  requireCondition(group.bodyIds.includes(bodyId), `Group ${groupId} does not contain promoted body ${bodyId}`);
  requireCondition(group.instanceIds.includes(instanceId), `Group ${groupId} does not contain promoted instance ${instanceId}`);
}
function requireExactIds(actual: number[], expected: number[], label: string): void {
  requireCondition(Array.isArray(actual), `${label}: expected an ID array`);
  requireCondition(JSON.stringify([...actual].sort((left, right) => left - right)) === JSON.stringify([...expected].sort((left, right) => left - right)), `${label}: expected ${expected.join(",")}, got ${actual.join(",")}`);
}
function planarFaceWithNormal(state: any, bodyId: number, normal: number[]): any {
  const matches = bodyById(state, bodyId).faces.filter((face: { planar: boolean; normal: number[] }) => face.planar && distanceBetween(face.normal, normal) <= 1e-8);
  requireCondition(matches.length === 1, `Body ${bodyId} does not have exactly one planar face with normal ${normal.join(",")}`);
  return matches[0];
}
function cylindricalFace(state: any, bodyId: number): any {
  const matches = bodyById(state, bodyId).faces.filter((face: { surfaceType: string; axisOriginMm: number[] | null; axisDirection: number[] | null }) => face.surfaceType === "Cylinder" && face.axisOriginMm && face.axisDirection);
  requireCondition(matches.length === 1, `Body ${bodyId} does not have exactly one cylindrical face with a native axis`);
  return matches[0];
}
function vertexAt(state: any, bodyId: number, positionMm: number[]): any {
  const matches = bodyById(state, bodyId).vertices.filter((vertex: { positionMm: number[] }) => distanceBetween(vertex.positionMm, positionMm) <= 1e-8);
  requireCondition(matches.length === 1, `Body ${bodyId} does not have exactly one vertex at ${positionMm.join(",")}`);
  return matches[0];
}
function vertexById(state: any, bodyId: number, vertexId: number): any {
  const vertex = bodyById(state, bodyId).vertices.find((candidate: { id: number }) => candidate.id === vertexId);
  requireCondition(vertex, `Body ${bodyId} does not have current vertex ${vertexId}`);
  return vertex;
}
function linearEdgeAt(state: any, bodyId: number, centerMm: number[], lengthMm: number): any {
  const matches = bodyById(state, bodyId).edges.filter((edge: { line: boolean; centerMm: number[]; lengthMm: number }) => edge.line && distanceBetween(edge.centerMm, centerMm) <= 1e-8 && Math.abs(edge.lengthMm - lengthMm) <= 1e-8);
  requireCondition(matches.length === 1, `Body ${bodyId} does not have exactly one Line edge of length ${lengthMm} mm at ${centerMm.join(",")}`);
  return matches[0];
}
function normalizeVector(value: number[], label: string): number[] {
  const length = Math.hypot(...value);
  requireCondition(Number.isFinite(length) && length > 1e-12, `${label} is degenerate`);
  return value.map((component) => component / length);
}
function dotProduct(left: number[], right: number[]): number {
  requireCondition(left.length === right.length, "Dot-product vector length mismatch");
  return left.reduce((sum, value, index) => sum + value * right[index]!, 0);
}
function bodyCenter(bounds: { min: number[]; max: number[] }): number[] { return bounds.min.map((value, index) => (value + bounds.max[index]!) / 2); }
function distanceBetween(left: number[], right: number[]): number { return Math.hypot(...left.map((value, index) => value - right[index]!)); }
function requireCleanJournal(journal: any): void {
  requireCondition(journal.syncStatus === "in-sync", `Construction journal is ${String(journal.syncStatus)}`);
  requireCondition(!journal.entries.some((entry: { status: string }) => entry.status === "unknown"), "Construction journal contains an uncertain mutation");
}
function stateSummary(state: any): Record<string, unknown> {
  return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, instanceCount: state.instances.length, nonRootGroupCount: nonRootGroups(state).length };
}
function requireHistoryStep(state: any, priorDepth: number, label: string): void { requireCondition(state.undoDepth === priorDepth + 1, `${label} did not occupy exactly one history step`); }
function vectorNear(actual: number[], expected: number[], tolerance: number, label: string): void { requireCondition(actual.length === expected.length, `${label}: vector length mismatch`); actual.forEach((value, index) => requireCondition(Number.isFinite(value) && Math.abs(value - expected[index]!) <= tolerance, `${label}[${index}]: expected ${expected[index]} ± ${tolerance}, got ${value}`)); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
