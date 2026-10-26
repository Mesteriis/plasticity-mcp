#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertPointSetNear } from "./verify-native-patterns-recipes-live.ts";

import { isolatedAcceptanceEnvironment } from "./verify-native-measure-datum-files-live.ts";

import { hydrateNativeState } from "./native-live-state.ts";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const ALIGN_PROJECT_CASES = ["align-vertices", "align-edges", "align-cylinders", "project-curve", "imprint-curve", "imprint-curve-normal", "imprint-curve-normal-oblique", "dissolve-face", "patch-hole", "extend-sheet", "draft-faces", "named-selection"] as const;
type AlignProjectCase = typeof ALIGN_PROJECT_CASES[number];

interface Options { case: AlignProjectCase; help: boolean; target?: string; output?: string; allowDisposableMutations: boolean }

export function parseNativeAlignProjectAcceptanceArgs(argv: string[]): Options {
  const options: Options = { help: argv.length === 0, allowDisposableMutations: false, case: "align-vertices" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--allow-disposable-mutations") options.allowDisposableMutations = true;
    else if (argument === "--target" || argument === "--output" || argument === "--case") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      if (argument === "--target") options.target = value;
      else if (argument === "--output") options.output = value;
      else {
        if (!(ALIGN_PROJECT_CASES as readonly string[]).includes(value)) throw new Error(`Unknown catalog case: ${value}`);
        options.case = value as AlignProjectCase;
      }
    } else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Live native-align-project acceptance requires --target with an explicit Plasticity window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native-align-project acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native-align-project acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-align-project-live.ts --help
  node scripts/verify-native-align-project-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

Cases: ${ALIGN_PROJECT_CASES.join(", ")} (select with --case).
The vector circular-imprint case remains a strict diagnostic. The explicit normal
projection cases check analytic circles on aligned and rotated planar targets.

No-argument and --help modes do not connect to Plasticity. Live mode requires
an explicit empty disposable document, verifies native alignment, projection and topology edits and
mass properties through stdio MCP, checks Undo/Redo, restores the scene, and
writes sanitized evidence.`;

async function main(): Promise<void> {
  const options = parseNativeAlignProjectAcceptanceArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  await mkdir(output, { recursive: false, mode: 0o700 });
  const evidence: Record<string, unknown> = { schemaVersion: 1, startedAt: new Date().toISOString(), targetId: options.target, workbenchUsed: false };
  let client: Client | undefined;
  let initial: any;
  let state: any;
  try {
    client = await startMcp(join(output, "strength-store"));
    const windows = await call(client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    initial = await call(client, "plasticity_connect", { targetId: options.target });
    requireEmpty(initial);
    evidence.initial = summary(initial);
    const snapshot = await call(client, "plasticity_capture_snapshot", { label: "native-align-project-acceptance-initial-empty" });

    evidence.case = options.case;
    const mutate = async (name: string, args: Record<string, unknown>): Promise<any> => {
      state = await call(client!, name, { ...args, revision: state?.revision ?? initial.revision });
      return state;
    };
    let fixtureSolidId: number | undefined;
    const imprintArgs = (current: any) => ({ targetId: current.bodies.find((body: any) => body.type === "Solid").id, curveIds: current.bodies.filter((body: any) => body.type === "Wire").map((body: any) => body.id), direction: [0, 0, -1], bidirectional: false, occlude: true, completion: "none" });
    if (options.case === "align-cylinders") {
      await mutate("plasticity_create_cylinder", { centerMm: [0, 0, 0], radiusMm: 2, heightMm: 6, axis: [0, 0, 1] });
      await mutate("plasticity_create_cylinder", { centerMm: [20, 10, 4], radiusMm: 3, heightMm: 8, axis: [0, 0, 1] });
    } else if (options.case === "align-vertices" || options.case === "align-edges") {
      await mutate("plasticity_create_box", { originMm: [0, 0, 0], sizeMm: [2, 4, 6] });
      await mutate("plasticity_create_box", { originMm: [20, 10, 0], sizeMm: [2, 4, 6] });
    } else if (options.case === "extend-sheet") {
      await mutate("plasticity_create_rectangle", { centerMm: [10, 5, 0], widthMm: 20, heightMm: 10, normal: [0, 0, 1], xDirection: [1, 0, 0] });
      await mutate("plasticity_patch_regions", { regionIds: [state.regions[0].id] });
    } else {
      await mutate("plasticity_create_box", { originMm: [0, 0, 0], sizeMm: [10, 10, 10] });
      fixtureSolidId = state.bodies[0].id;
      if (options.case === "project-curve") await mutate("plasticity_create_polyline", { pointsMm: [[2, 5, 15], [8, 5, 15]], closed: false });
      if (options.case === "imprint-curve-normal-oblique") await mutate("plasticity_rotate", { ids: [fixtureSolidId], pivotMm: [5,5,5], axis: [0,1,0], degrees: 30 });
      if (options.case.startsWith("imprint-curve")) await mutate("plasticity_create_circle", { centerMm: options.case === "imprint-curve-normal-oblique" ? [10,5,5+5*Math.sqrt(3)] : [5,5,15], radiusMm: 2, normal: options.case === "imprint-curve-normal-oblique" ? [0.5,0,Math.sqrt(3)/2] : [0,0,1] });
      if (options.case === "dissolve-face") {
        await mutate("plasticity_create_cylinder", { centerMm: [5, 5, 8], radiusMm: 2, heightMm: 5, axis: [0, 0, 1] });
        const cylinder = state.bodies.find((body: any) => body.type === "Solid" && body.id !== fixtureSolidId);
        requireCondition(cylinder, "Analytic imprint cutter missing");
        await mutate("plasticity_imprint_bodies", { targetId: fixtureSolidId, toolIds: [cylinder.id] });
      }
      if (options.case === "patch-hole") {
        const box = state.bodies[0];
        const face = box.faces.find((face: any) => face.normal[2] > 0.999);
        requireCondition(face, "Top face missing");
        await mutate("plasticity_delete_faces", { faces: [{ bodyId: box.id, faceId: face.id }] });
      }
    }
    const source = state;
    const sourceSnapshot = await call(client, "plasticity_capture_snapshot", { label: "align-project-source" });
    const moving = source.bodies[0];
    const fixed = source.bodies[1];
    const sheet = source.bodies.find((body: any) => body.type === "Sheet");
    const solid = source.bodies.find((body: any) => body.type === "Solid" && (fixtureSolidId === undefined || body.id === fixtureSolidId));
    let selectionId: string | undefined;
    const edgeQuery = { bodyIds: [moving.id], line: true, direction: { vector: [0, 0, 1], toleranceDeg: 0.00001, oriented: false }, lengthMm: { value: 10, tolerance: 0.00001 } };
    const checkMatches = (matches: any[], z: number): void => {
      requireCondition(matches.length === 4 && matches.every((edge: any) => edge.bodyId === moving.id && edge.line), "Semantic query did not return four current Line edges");
      matches.forEach((edge: any) => near(edge.lengthMm, 10, 0.00001, "semantic edge length"));
      assertPointSetNear(matches.map((edge: any) => edge.centerMm), [[0, 0, z], [10, 0, z], [10, 10, z], [0, 10, z]], 0.00001, "semantic edge centers");
      const current = state.bodies.find((body: any) => body.id === moving.id);
      requireCondition(matches.every((edge: any) => current.edges.some((candidate: any) => candidate.id === edge.id)), "Query returned stale topology IDs");
    };
    switch (options.case) {
      case "align-vertices": {
        const from = moving.vertices.find((vertex: any) => vertex.positionMm.every((value: number) => Math.abs(value) < 0.00001));
        const to = fixed.vertices.find((vertex: any) => Math.abs(vertex.positionMm[0] - 20) < 0.00001 && Math.abs(vertex.positionMm[1] - 10) < 0.00001 && Math.abs(vertex.positionMm[2]) < 0.00001);
        requireCondition(from && to, "Corner vertex references missing");
        await mutate("plasticity_align_vertices", { ids: [moving.id], sourceVertex: { bodyId: moving.id, vertexId: from.id }, targetVertex: { bodyId: fixed.id, vertexId: to.id }, offsetMm: [1, 2, 3] }); break;
      }
      case "align-edges": {
        const pick = (body: any, point: number[]) => body.edges.find((edge: any) => edge.line && edge.centerMm.every((value: number, index: number) => Math.abs(value - point[index]!) < 0.00001));
        const from = pick(moving, [1, 0, 0]); const to = pick(fixed, [21, 10, 0]);
        requireCondition(from && to, "Bottom Line edge references missing");
        await mutate("plasticity_align_linear_edges", { ids: [moving.id], sourceEdge: { bodyId: moving.id, edgeId: from.id }, targetEdge: { bodyId: fixed.id, edgeId: to.id }, relation: "same", axialOffsetMm: 0, rotationAroundAxisDeg: 0 }); break;
      }
      case "align-cylinders": {
        const from = moving.faces.find((face: any) => face.surfaceType === "Cylinder"); const to = fixed.faces.find((face: any) => face.surfaceType === "Cylinder");
        requireCondition(from && to, "Cylinder faces missing");
        await mutate("plasticity_align_cylindrical_faces", { ids: [moving.id], sourceFace: { bodyId: moving.id, faceId: from.id }, targetFace: { bodyId: fixed.id, faceId: to.id }, relation: "same", axialMode: "preserve", axialOffsetMm: 0, rotationAroundAxisDeg: 0 }); break;
      }
      case "project-curve": await mutate("plasticity_project_curves_onto_body", imprintArgs(source)); break;
      case "imprint-curve": await mutate("plasticity_imprint_curves_on_body", imprintArgs(source)); break;
      case "imprint-curve-normal":
      case "imprint-curve-normal-oblique": {
        const { direction: _unusedDirection, ...args } = imprintArgs(source);
        await mutate("plasticity_imprint_curves_on_body", { ...args, projectionMethod: "normal" });
        evidence.projectionMethod = "normal"; break;
      }
      case "dissolve-face": {
        const disk = solid.faces.find((face: any) => face.planar && face.edgeIds.length === 1 && solid.edges.find((edge: any) => edge.id === face.edgeIds[0])?.circle);
        requireCondition(disk, "Imprinted planar disk missing");
        await mutate("plasticity_dissolve_faces", { faces: [{ bodyId: solid.id, faceId: disk.id }] }); break;
      }
      case "patch-hole": {
        const edges = sheet.edges.filter((edge: any) => edge.faceIds.length === 1);
        requireCondition(edges.length === 4, "Open box must have four boundary edges");
        await mutate("plasticity_patch_sheet_hole", { id: sheet.id, edgeIds: edges.map((edge: any) => edge.id) }); break;
      }
      case "extend-sheet": {
        const edge = sheet.edges.find((edge: any) => edge.line && Math.abs(edge.centerMm[0] - 20) < 0.00001);
        requireCondition(edge, "Right Sheet boundary missing");
        await mutate("plasticity_extend_sheet_edges", { id: sheet.id, edgeIds: [edge.id], distanceMm: 5 }); break;
      }
      case "draft-faces": {
        const bottom = solid.faces.find((face: any) => face.normal[2] < -0.999);
        const sides = solid.faces.filter((face: any) => Math.abs(face.normal[2]) < 0.00001);
        requireCondition(bottom && sides.length === 4, "Draft faces/neutral reference missing");
        await mutate("plasticity_draft_faces", { id: solid.id, faceIds: sides.map((face: any) => face.id), referenceFace: { bodyId: solid.id, faceId: bottom.id }, angleDegrees: 5 }); break;
      }
      case "named-selection": {
        const initialSelections = await call(client, "plasticity_list_named_selections", {});
        requireCondition(initialSelections.selections.length === 0, "Refusing to overwrite existing semantic selections");
        const found = await call(client, "plasticity_find_edges", { revision: state.revision, query: edgeQuery });
        requireCondition(found.documentToken === state.documentToken && found.revision === state.revision && found.count === 4, "Semantic result revision/count mismatch");
        checkMatches(found.matches, 5);
        const saved = await call(client, "plasticity_save_named_selection", { kind: "edges", name: "Acceptance vertical edges", query: edgeQuery, expectedCount: 4, revision: state.revision });
        requireCondition(saved.status === "resolved" && saved.currentRevision === state.revision, "Saved semantic selection did not resolve");
        checkMatches(saved.matches, 5); selectionId = saved.id;
        await mutate("plasticity_move", { ids: [moving.id], deltaMm: [0, 0, 5] }); break;
      }
    }
    requireCondition(state.undoDepth === source.undoDepth + 1, "Operation must create exactly one native history step");
    const check = async (): Promise<void> => {
      evidence.observedBodies = state.bodies.map((body: any) => ({ id: body.id, type: body.type, boundsMm: body.boundsMm,
        ...(options.case.startsWith("imprint-curve") ? { faces: body.faces.map((face: any) => ({ surfaceType: face.surfaceType, planar: face.planar, centerMm: face.centerMm })), edges: body.edges.map((edge: any) => ({ curveType: edge.curveType, lengthMm: edge.lengthMm })) } : {}) }));
      for (const wire of source.bodies.filter((body: any) => body.type === "Wire")) {
        const retained = state.bodies.find((body: any) => body.id === wire.id && body.type === "Wire");
        requireCondition(retained, "Operation consumed a source Wire");
        vectorNear(retained.boundsMm.min, wire.boundsMm.min, 0.00001, "retained Wire minimum");
        vectorNear(retained.boundsMm.max, wire.boundsMm.max, 0.00001, "retained Wire maximum");
      }
      const solids = state.bodies.filter((body: any) => body.type === "Solid");
      const expectedSolids = options.case.startsWith("align-") || options.case === "dissolve-face" ? 2 : options.case === "extend-sheet" ? 0 : 1;
      requireCondition(solids.length === expectedSolids, "Unexpected Solid count");
      if (expectedSolids) {
        const ids = solids.map((body: any) => body.id);
        const validation = await call(client!, "plasticity_validate_bodies", { ids, revision: state.revision });
        requireCondition(validation.bodies.length === expectedSolids && validation.bodies.every((body: any) => body.nativeValid && body.printableSolid), "Native Solid validation failed");
        const mass = await call(client!, "plasticity_measure_solid_properties", { ids, revision: state.revision });
        requireCondition(mass.bodies.length === expectedSolids, "Solid mass-property count mismatch");
        evidence.validation = validation.bodies;
        evidence.massProperties = mass.bodies;
        for (const body of mass.bodies) {
          const t = Math.tan(5 * Math.PI / 180);
          const expected = options.case === "align-cylinders" ? (body.id === moving.id ? 24 : 72) * Math.PI : options.case.startsWith("align-") ? 48 : options.case === "dissolve-face" && body.id !== fixtureSolidId ? 20 * Math.PI : options.case === "draft-faces" ? 1000 * (1 + 2 * t + 4 * t * t / 3) : 1000;
          near(body.volumeMm3, expected, 0.0001, "output volume");
        }
        evidence.massProperties = mass.bodies;
      }
      if (options.case.startsWith("align-")) {
        requireCondition(state.bodies.length === 2, "Alignment changed body count");
        const moved = state.bodies.find((body: any) => body.id === moving.id); const target = state.bodies.find((body: any) => body.id === fixed.id);
        requireCondition(moved && target, "Alignment did not preserve body IDs");
        vectorNear(target.boundsMm.min, fixed.boundsMm.min, 0.00001, "fixed target minimum");
        vectorNear(target.boundsMm.max, fixed.boundsMm.max, 0.00001, "fixed target maximum");
        const minimum = options.case === "align-vertices" ? [21, 12, 3] : options.case === "align-cylinders" ? [18, 8, 0] : [20, 10, 0];
        const maximum = options.case === "align-vertices" ? [23, 16, 9] : options.case === "align-cylinders" ? [22, 12, 6] : [22, 14, 6];
        vectorNear(moved.boundsMm.min, minimum, 0.00001, "aligned minimum"); vectorNear(moved.boundsMm.max, maximum, 0.00001, "aligned maximum");
        return;
      }
      if (options.case === "extend-sheet") {
        requireCondition(state.bodies.length === 2 && state.bodies.filter((body: any) => body.type === "Wire").length === 1, "Sheet extension consumed the profile or changed output count");
        const result = state.bodies.find((body: any) => body.id === sheet.id);
        requireCondition(result?.type === "Sheet" && result.faces.length === 1 && result.edges.length === 4, "Extended Sheet topology mismatch");
        vectorNear(result.boundsMm.min, [0, 0, 0], 0.00001, "extended minimum"); vectorNear(result.boundsMm.max, [25, 10, 0], 0.00001, "extended maximum");
        const properties = await call(client!, "plasticity_measure_face_properties", { faces: [{ bodyId: result.id, faceId: result.faces[0].id }], revision: state.revision });
        near(properties.faces[0].areaMm2, 250, 0.0001, "extended area"); near(properties.faces[0].boundaryLengthMm, 70, 0.0001, "extended boundary");
        const validation = await call(client!, "plasticity_validate_bodies", { ids: [result.id], revision: state.revision });
        requireCondition(validation.bodies[0]?.nativeValid && !validation.bodies[0].printableSolid, "Extended Sheet failed validation");
        evidence.geometry = properties; return;
      }
      const result = solids.find((body: any) => fixtureSolidId === undefined || body.id === fixtureSolidId);
      requireCondition(result, "Target Solid missing");
      const t = Math.tan(5 * Math.PI / 180);
      vectorNear(result.boundsMm.min, options.case === "draft-faces" ? [-10 * t, -10 * t, 0] : options.case === "named-selection" ? [0, 0, 5] : options.case === "imprint-curve-normal-oblique" ? [2.5-2.5*Math.sqrt(3),0,2.5-2.5*Math.sqrt(3)] : [0, 0, 0], 0.00001, "result minimum");
      vectorNear(result.boundsMm.max, options.case === "draft-faces" ? [10 + 10 * t, 10 + 10 * t, 10] : options.case === "named-selection" ? [10, 10, 15] : options.case === "imprint-curve-normal-oblique" ? [7.5+2.5*Math.sqrt(3),10,7.5+2.5*Math.sqrt(3)] : [10, 10, 10], 0.00001, "result maximum");
      if (options.case === "project-curve") {
        requireCondition(state.bodies.length === 3 && result.faces.length === 6 && result.edges.length === 12, "Projection changed target topology or output count");
        const directions = await call(client!, "plasticity_list_curve_directions", {});
        requireCondition(directions.documentToken === state.documentToken && directions.revision === state.revision && directions.curves.length === 2, "Stale/incomplete projected curves");
        const projected = directions.curves.find((curve: any) => !source.bodies.some((body: any) => body.id === curve.id));
        requireCondition(projected?.segments.length === 1 && projected.segments[0].curveType === "Line", "Expected one projected Line");
        assertPointSetNear([projected.segments[0].startMm, projected.segments[0].endMm], [[2, 5, 10], [8, 5, 10]], 0.00001, "projected endpoints");
        near(projected.segments[0].lengthMm, 6, 0.00001, "projected length"); evidence.geometry = projected;
      } else if (options.case.startsWith("imprint-curve") || options.case === "dissolve-face") {
        requireCondition(state.bodies.length === 2, "Imprint/dissolve output count mismatch");
        if (options.case === "dissolve-face") {
          const cutter = source.bodies.find((body: any) => body.type === "Solid" && body.id !== solid.id);
          const retained = state.bodies.find((body: any) => body.id === cutter.id && body.type === "Solid");
          requireCondition(retained?.faces.length === cutter.faces.length, "Dissolve changed the analytic imprint cutter");
          vectorNear(retained.boundsMm.min, cutter.boundsMm.min, 0.00001, "retained cutter minimum");
          vectorNear(retained.boundsMm.max, cutter.boundsMm.max, 0.00001, "retained cutter maximum");
        } else requireCondition(state.bodies.some((body: any) => body.type === "Wire"), "Imprint consumed its curve");
        requireCondition(result.faces.length === (options.case.startsWith("imprint-curve") ? 7 : 6) && result.edges.length === (options.case.startsWith("imprint-curve") ? 13 : 12), "Imprint/dissolve topology mismatch");
        if (options.case.startsWith("imprint-curve")) {
          const edge = result.edges.find((edge: any) => edge.circleGeometry);
          requireCondition(edge, "Exact imprinted circle missing");
          near(edge.circleGeometry.radiusMm, 2, 0.00001, "imprint radius"); vectorNear(edge.circleGeometry.centerMm, options.case === "imprint-curve-normal-oblique" ? [7.5,5,5+2.5*Math.sqrt(3)] : [5,5,10], 0.00001, "imprint center");
          near(edge.lengthMm, 4*Math.PI, 0.00001, "analytic imprint circumference");
          const normal = options.case === "imprint-curve-normal-oblique" ? [0.5,0,Math.sqrt(3)/2] : [0,0,1];
          near(Math.abs(edge.circleGeometry.normal.reduce((sum: number, value: number, index: number) => sum + value * normal[index]!, 0)), 1, 1e-8, "imprint normal alignment");
        }
      } else {
        requireCondition(state.bodies.length === 1 && result.faces.length === 6 && result.edges.length === 12, "Box/frustum topology mismatch");
      }
      if (options.case === "named-selection") {
        const listed = await call(client!, "plasticity_list_named_selections", {});
        requireCondition(listed.documentToken === state.documentToken && listed.revision === state.revision && listed.selections.length === 1, "Named-selection list mismatch");
        const selection = listed.selections[0];
        requireCondition(selection.id === selectionId && selection.status === "resolved" && selection.currentRevision === state.revision, "Named selection did not rebind after the native edit");
        checkMatches(selection.matches, 10); evidence.namedSelectionRebound = true;
      }
    };
    await check();
    const resultIds = state.bodies.map((body: any) => body.id).sort((a: number, b: number) => a - b);
    await mutate("plasticity_undo", {});
    const sourceChanges = await call(client, "plasticity_changes_since", { snapshotId: sourceSnapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(sourceChanges.diff), "Undo did not restore the complete source snapshot");
    if (selectionId) {
      const listed = await call(client, "plasticity_list_named_selections", {});
      requireCondition(listed.selections[0]?.status === "resolved" && listed.selections[0].currentRevision === state.revision, "Named selection did not resolve after Undo");
      checkMatches(listed.selections[0].matches, 5);
    }
    await mutate("plasticity_redo", {});
    requireCondition(JSON.stringify(state.bodies.map((body: any) => body.id).sort((a: number, b: number) => a - b)) === JSON.stringify(resultIds), "Redo changed result identities");
    await check();
    if (selectionId) {
      const beforeDelete = state.revision;
      const deleted = await call(client, "plasticity_delete_named_selection", { selectionId });
      requireCondition(deleted.deleted === selectionId && (await call(client, "plasticity_list_named_selections", {})).selections.length === 0, "Named selection was not removed");
      state = await call(client, "plasticity_status", {});
      requireCondition(state.revision === beforeDelete, "Deleting named selection changed the CAD revision");
      evidence.namedSelectionDeleted = true;
    }
    for (let i = 0; state.undoDepth > initial.undoDepth && i < 12; i += 1) await mutate("plasticity_undo", {});
    requireEmpty(state);
    const changes = await call(client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(changes.diff), "Scene content differs from the initial empty snapshot after cleanup");
    if (options.case.startsWith("imprint-curve-normal")) {
      const history = await call(client, "plasticity_construction_history", { limit: 100 });
      const expected = 2 * (source.undoDepth - initial.undoDepth) + 4;
      const imprints = history.entries.filter((entry: any) => entry.operation === "imprint-curves-on-body");
      requireCondition(history.total === expected && history.entries.length === expected && history.entries.every((entry: any) => entry.status === "completed"), "Durable imprint history is incomplete");
      requireCondition(imprints.length === 1 && imprints[0].input.projectionMethod === "normal" && imprints[0].input.direction == null, "Durable imprint projection method mismatch");
      const journal = await call(client, "plasticity_construction_journal", {});
      requireCondition(journal.durableSyncStatus === "in-sync", "Durable imprint history is out of sync");
      evidence.durableHistory = { events: history.total, projectionMethod: "normal", syncStatus: journal.durableSyncStatus };
    }
    evidence.undoRedo = true;
    evidence.cleanup = { restoredEmptyDocument: true, sceneContentsRestored: true };
    evidence.completedAt = new Date().toISOString();
    await writeExclusive(join(output, "evidence.json"), sanitizeEvidence(evidence));
    console.log(JSON.stringify({ ok: true, output, evidence: join(output, "evidence.json"), geometry: evidence.geometry }));
  } catch (error) {
    evidence.error = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
    if (!/timed out|timeout|uncertain/i.test(String(evidence.error)) && client && initial && state && state.documentToken === initial.documentToken) {
      try {
        const current = await call(client, "plasticity_status", {});
        if (current.documentToken === initial.documentToken && current.revision === state.revision && current.undoDepth > initial.undoDepth) {
          let status = current;
          for (let attempt = 0; attempt < 12 && status.undoDepth > initial.undoDepth; attempt += 1) {
            status = await call(client, "plasticity_undo", { intent: "Recover disposable align-project acceptance", revision: status.revision });
          }
          evidence.recovery = { restoredEmptyDocument: status.bodies.length === 0 && status.regions.length === 0 };
        }
      } catch { /* Preserve the primary failure; inspect the disposable scene manually if recovery reads fail. */ }
    }
    await writeExclusive(join(output, "failure.json"), sanitizeEvidence(evidence)).catch(() => {});
    throw error;
  } finally { await client?.close().catch(() => {}); }
}

async function startMcp(storeRoot: string): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: isolatedAcceptanceEnvironment(storeRoot, process.env), stderr: "pipe" });
  const client = new Client({ name: "plasticity-native-align-project-live", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await client.callTool({ name, arguments: args });
  const text = toolText(response);
  if ("isError" in response && response.isError) throw new Error(text);
  return await hydrateNativeState(JSON.parse(text), id => call(client, "plasticity_body_info", { id }), (offset, revision) => call(client, "plasticity_list_bodies", { bodyOffset: offset, bodyLimit: 100, expectedRevision: revision }));
}
function toolText(response: unknown): string {
  if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content");
  const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string");
  if (!item) throw new Error("MCP tool returned no text result");
  return item.text;
}
function requireEmpty(state: any): void {
  requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0 && (state.referenceMeshes ?? []).length === 0, "Refusing align-project acceptance in a nonempty Plasticity document");
  requireCondition((state.measurements ?? []).length === 0 && (state.sectionAnalyses ?? []).length === 0, "Refusing align-project acceptance while document annotations or section analyses exist");
  requireCondition((state.groups ?? []).every((group: { id: number }) => group.id === 0), "Refusing align-project acceptance while non-root groups exist");
}
function summary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length }; }
function near(actual: number, expected: number, tolerance: number, label: string): void { requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`); }
function vectorNear(actual: unknown, expected: number[], tolerance: number, label: string): void { requireCondition(Array.isArray(actual) && actual.length === expected.length, `${label}: vector length mismatch`); actual.forEach((value, index) => near(value, expected[index]!, tolerance, `${label}[${index}]`)); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
