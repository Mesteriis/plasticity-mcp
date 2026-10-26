#!/usr/bin/env node
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { hydrateNativeState } from "./native-live-state.ts";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const MEASURE_FILE_CASES = ["bounds", "point-distance", "point-edge-interior", "point-edge-clamped", "linear-edges", "datum-refresh", "construction-plane", "saved-plane-frames", "step-provenance", "save-open"] as const;
type MeasureFileCase = typeof MEASURE_FILE_CASES[number];

interface Options { case: MeasureFileCase; help: boolean; target?: string; output?: string; allowDisposableMutations: boolean }

export function parseNativeMeasureDatumFilesAcceptanceArgs(argv: string[]): Options {
  const options: Options = { help: argv.length === 0, allowDisposableMutations: false, case: "bounds" };
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
        if (!(MEASURE_FILE_CASES as readonly string[]).includes(value)) throw new Error(`Unknown catalog case: ${value}`);
        options.case = value as MeasureFileCase;
      }
    } else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Live native-measure-datum-files acceptance requires --target with an explicit Plasticity window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native-measure-datum-files acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native-measure-datum-files acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-measure-datum-files-live.ts --help
  node scripts/verify-native-measure-datum-files-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

Cases: ${MEASURE_FILE_CASES.join(", ")} (select with --case).

No-argument and --help modes do not connect to Plasticity. Live mode requires
an explicit empty disposable document, verifies native measurements, datums and isolated file workflows and
mass properties through stdio MCP, checks Undo/Redo, restores the scene, and
writes sanitized evidence.`;

async function main(): Promise<void> {
  const options = parseNativeMeasureDatumFilesAcceptanceArgs(process.argv.slice(2));
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
    const snapshot = await call(client, "plasticity_capture_snapshot", { label: "native-measure-datum-files-acceptance-initial-empty" });

    evidence.case = options.case;
    state = initial;
    let compareInitialSnapshot = true;
    const mutate = async (name: string, args: Record<string, unknown>): Promise<any> => {
      state = await call(client!, name, { ...args, revision: state.revision }); return state;
    };
    const fresh = async (): Promise<any> => { state = await call(client!, "plasticity_status", {}); return state; };
    const ref = (value: any) => ({ id: value.id, sessionId: value.sessionId, documentToken: value.documentToken, revision: value.revision });
    const expectRejection = async (name: string, args: Record<string, unknown>, pattern: RegExp): Promise<void> => {
      let message = "";
      try { await call(client!, name, args); } catch (error) { message = error instanceof Error ? error.message : String(error); }
      requireCondition(message.length > 0 && pattern.test(message), `${name} did not produce the expected safe rejection: ${message}`);
    };
    const verifyBox = async (minimum: number[], maximum: number[]): Promise<void> => {
      requireCondition(state.bodies.length === 1 && state.bodies[0].type === "Solid" && state.bodies[0].faces.length === 6 && state.bodies[0].edges.length === 12, "Expected one six-face/twelve-edge Solid");
      const body = state.bodies[0]; vectorNear(body.boundsMm.min, minimum, 0.00001, "box minimum"); vectorNear(body.boundsMm.max, maximum, 0.00001, "box maximum");
      const validation = await call(client!, "plasticity_validate_bodies", { ids: [body.id], revision: state.revision });
      requireCondition(validation.bodies[0]?.nativeValid && validation.bodies[0].printableSolid, "Box failed native validation");
      const mass = await call(client!, "plasticity_measure_solid_properties", { ids: [body.id], revision: state.revision });
      near(mass.bodies[0].volumeMm3, 6000, 0.0001, "box volume");
    };
    if (["bounds", "point-distance", "point-edge-interior", "point-edge-clamped", "linear-edges"].includes(options.case)) {
      await mutate("plasticity_create_box", { originMm: [0, 0, 0], sizeMm: [10, 20, 30] });
      const sourceId = state.bodies[0].id;
      const readMeasurements = async (): Promise<void> => {
        const before = state;
        const body = before.bodies[0];
        const edgeAt = (point: number[]) => {
          const edge = body.edges.find((edge: any) => edge.line && edge.centerMm.every((value: number, index: number) => Math.abs(value - point[index]!) < 0.00001));
          requireCondition(edge, "Measurement Line reference missing"); return { bodyId: body.id, edgeId: edge.id };
        };
        let result: any;
        if (options.case === "bounds") {
          result = await call(client!, "plasticity_measure", { id: body.id });
          requireCondition(result.source === "native-brep" && result.revision === before.revision, "Bounds read is stale or approximate");
          vectorNear(result.sizeMm, [10, 20, 30], 0.00001, "measured dimensions");
          vectorNear(result.boundsMm.min, [0, 0, 0], 0.00001, "measured minimum");
          vectorNear(result.boundsMm.max, [10, 20, 30], 0.00001, "measured maximum");
        } else if (options.case === "point-distance") {
          const vertexAt = (point: number[]) => {
            const vertex = body.vertices.find((vertex: any) => vertex.positionMm.every((value: number, index: number) => Math.abs(value - point[index]!) < 0.00001));
            requireCondition(vertex, "Measurement vertex missing"); return { type: "vertex", bodyId: body.id, vertexId: vertex.id };
          };
          result = await call(client!, "plasticity_measure_point_distance", { first: vertexAt([0, 0, 0]), second: vertexAt([10, 20, 30]), revision: before.revision });
          near(result.distanceMm, Math.sqrt(1400), 0.00001, "vertex distance"); vectorNear(result.deltaMm, [10, 20, 30], 0.00001, "vertex delta");
          requireCondition(result.measurementSource === "native-brep", "Vertex measurement is not native");
        } else if (options.case.startsWith("point-edge")) {
          const clamped = options.case === "point-edge-clamped";
          result = await call(client!, "plasticity_measure_point_to_linear_edge", { point: { type: "coordinates", pointMm: [clamped ? 15 : 5, 3, 4] }, edge: edgeAt([5, 0, 0]), revision: before.revision });
          near(result.supportingLineDistanceMm, 5, 0.00001, "supporting-line distance");
          near(result.finiteSegmentDistanceMm, clamped ? Math.sqrt(50) : 5, 0.00001, "finite-edge distance");
          vectorNear(result.closestPointMm, [clamped ? 10 : 5, 0, 0], 0.00001, "clamped point");
          vectorNear(result.infiniteLineProjectionMm, [clamped ? 15 : 5, 0, 0], 0.00001, "line projection");
          requireCondition(result.clampedToEndpoint === clamped, "Endpoint clamp flag mismatch");
        } else {
          result = await call(client!, "plasticity_measure_linear_edges", { first: edgeAt([5, 0, 0]), second: edgeAt([10, 10, 30]), revision: before.revision });
          near(result.lineAngleDeg, 90, 0.00001, "perpendicular angle"); near(result.supportingLineDistanceMm, 30, 0.00001, "skew line distance"); near(result.finiteSegmentDistanceMm, 30, 0.00001, "finite skew distance");
          requireCondition(result.perpendicular && !result.parallel, "Perpendicular edge flags mismatch");
          const parallel = await call(client!, "plasticity_measure_linear_edges", { first: edgeAt([5, 0, 0]), second: edgeAt([5, 20, 30]), revision: before.revision });
          near(parallel.lineAngleDeg, 0, 0.00001, "parallel angle"); near(parallel.supportingLineDistanceMm, Math.sqrt(1300), 0.00001, "parallel clearance"); near(parallel.finiteSegmentDistanceMm, Math.sqrt(1300), 0.00001, "finite parallel distance");
          requireCondition(parallel.parallel && !parallel.perpendicular, "Parallel edge flags mismatch");
          evidence.parallelEdges = parallel;
        }
        if (result.documentToken) requireCondition(result.documentToken === before.documentToken && result.revision === before.revision, "Measurement identity mismatch");
        await fresh();
        requireCondition(state.revision === before.revision && state.undoDepth === before.undoDepth && state.redoDepth === before.redoDepth, "Read-only measurement changed native state");
        evidence.measurement = result;
      };
      await readMeasurements(); await verifyBox([0, 0, 0], [10, 20, 30]);
      await mutate("plasticity_undo", {}); requireEmpty(state);
      await mutate("plasticity_redo", {}); requireCondition(state.bodies[0]?.id === sourceId, "Redo changed measurement source ID");
      await readMeasurements(); await mutate("plasticity_undo", {});
    } else if (options.case === "datum-refresh") {
      await mutate("plasticity_create_box", { originMm: [0, 0, 0], sizeMm: [10, 20, 30] });
      const box = state.bodies[0]; const face = box.faces.find((face: any) => face.normal[2] > 0.999);
      const edge = box.edges.find((edge: any) => edge.line && edge.centerMm.every((value: number, axis: number) => Math.abs(value - [5, 0, 0][axis]!) < 0.00001));
      requireCondition(face && edge, "Datum topology missing");
      const point = await call(client, "plasticity_define_datum_point", { definition: { type: "face-center", bodyId: box.id, faceId: face.id }, revision: state.revision });
      const axis = await call(client, "plasticity_define_datum_axis", { definition: { type: "linear-edge", bodyId: box.id, edgeId: edge.id }, revision: state.revision });
      vectorNear(point.pointMm, [5, 10, 30], 0.00001, "datum point"); vectorNear(axis.originMm, [5, 0, 0], 0.00001, "datum axis origin");
      near(Math.abs(axis.direction[0]), 1, 0.00001, "datum axis direction");
      const source = await call(client, "plasticity_capture_snapshot", { label: "datum-source" });
      const sourceDepth = state.undoDepth;
      await mutate("plasticity_move", { ids: [box.id], deltaMm: [7, -2, 4] });
      requireCondition(state.undoDepth === sourceDepth + 1, "Datum fixture move history mismatch");
      await verifyBox([7, -2, 4], [17, 18, 34]);
      const waited = await call(client, "plasticity_wait_for_change", { snapshotId: source.snapshotId, timeoutMs: 0 });
      requireCondition(waited.current.revision === state.revision && waited.diff.modified.length === 1 && hasSceneContentChanges(waited.diff), "Native scene change was not detected");
      const survives = state.bodies[0].faces.some((current: any) => current.id === face.id);
      if (survives) {
        const refreshed = await call(client, "plasticity_refresh_datum", { reference: ref(point) });
        vectorNear(refreshed.pointMm, [12, 8, 34], 0.00001, "moved datum point");
        requireCondition(refreshed.refreshedFromId === point.id && refreshed.revision === state.revision, "Datum refresh identity mismatch");
      } else await expectRejection("plasticity_refresh_datum", { reference: ref(point) }, /not found|unknown|unresolved|stale/i);
      evidence.sourceFaceReferenceSurvivedMove = survives;
      await mutate("plasticity_undo", {});
      const restored = await call(client, "plasticity_changes_since", { snapshotId: source.snapshotId });
      requireCondition(!hasSceneContentChanges(restored.diff), "Datum move Undo did not restore source");
      const refreshedPoint = await call(client, "plasticity_refresh_datum", { reference: ref(point) });
      const refreshedAxis = await call(client, "plasticity_refresh_datum", { reference: ref(axis) });
      vectorNear(refreshedPoint.pointMm, [5, 10, 30], 0.00001, "restored datum point"); vectorNear(refreshedAxis.originMm, [5, 0, 0], 0.00001, "restored datum axis");
      requireCondition(refreshedPoint.id !== point.id && refreshedAxis.id !== axis.id && refreshedPoint.revision === state.revision && refreshedAxis.revision === state.revision, "Datums were not rebound to the restored revision");
      await mutate("plasticity_redo", {}); await verifyBox([7, -2, 4], [17, 18, 34]);
      await mutate("plasticity_undo", {}); await mutate("plasticity_undo", {});
      evidence.datumRefreshedAfterUndo = true;
    } else if (options.case === "construction-plane") {
      const before = await call(client, "plasticity_list_construction_geometry", {});
      requireCondition(before.activePlaneId, "No explicit initial active plane");
      const created = await call(client, "plasticity_create_construction_plane", { definition: { type: "explicit", originMm: [10, 20, 30], normal: [0, 0, 1], xDirection: [1, 0, 0] }, name: "Acceptance construction plane", revision: state.revision });
      await fresh();
      const currentPlane = async (id: string): Promise<any> => { const listed = await call(client!, "plasticity_list_construction_geometry", {}); const plane = listed.planes.find((plane: any) => plane.id === id); requireCondition(plane, "Current plane reference missing"); return plane; };
      const plane = await currentPlane(created.id);
      vectorNear(plane.originMm, [10, 20, 30], 0.00001, "saved plane origin"); vectorNear(plane.normal, [0, 0, 1], 0.00001, "saved plane normal"); vectorNear(plane.xDirection, [1, 0, 0], 0.00001, "saved plane X axis");
      state = await call(client, "plasticity_set_workplane", { plane: ref(plane) });
      requireCondition(state.construction.activePlaneId === created.id, "Saved plane was not activated");
      const localPlane = await currentPlane(created.id); const depth = state.undoDepth;
      await mutate("plasticity_create_polyline", { pointsMm: [[0, 0], [4, 0], [4, 6], [0, 6]], closed: true, plane: ref(localPlane) });
      requireCondition(state.undoDepth === depth + 1 && state.bodies.length === 1 && state.bodies[0].type === "Wire" && state.regions.length === 1, "Plane-local profile did not create one Wire/Region and history step");
      vectorNear(state.bodies[0].boundsMm.min, [10, 20, 30], 0.00001, "plane-local minimum"); vectorNear(state.bodies[0].boundsMm.max, [14, 26, 30], 0.00001, "plane-local maximum");
      await mutate("plasticity_undo", {}); requireEmpty(state);
      state = await call(client, "plasticity_set_workplane", { plane: ref(await currentPlane(before.activePlaneId)) });
      state = await call(client, "plasticity_remove_construction_plane", { plane: ref(await currentPlane(created.id)) });
      const after = await call(client, "plasticity_list_construction_geometry", {});
      requireCondition(after.activePlaneId === before.activePlaneId && JSON.stringify(after.planes.map((plane: any) => plane.id).sort()) === JSON.stringify(before.planes.map((plane: any) => plane.id).sort()), "Construction state was not restored");
      evidence.planeLifecycle = { nativeReadback: true, activePlaneVerified: true, localCoordinatesVerified: true, restoredInitialPlanes: true };
    } else if (options.case === "saved-plane-frames") {
      const before = await call(client, "plasticity_list_construction_geometry", {});
      requireCondition(before.activePlaneId && before.planes.every((plane: any) => plane.source === "standard"), "Saved-plane acceptance requires only standard planes and a registered initial workplane");
      const currentPlane = async (id: string): Promise<any> => {
        const listed = await call(client!, "plasticity_list_construction_geometry", {});
        const plane = listed.planes.find((value: any) => value.id === id);
        requireCondition(plane, "Current plane reference missing"); return plane;
      };
      const diagnosis = await call(client, "plasticity_diagnose", {});
      requireCondition(diagnosis.windows.some((window: any) => window.id === options.target), "Diagnosis omitted the selected window");
      const bindings: string[] = []; let offset = 0; let matching = 0;
      do {
        const page = await call(client, "plasticity_capabilities", { query: "ConstructionPlane", offset, limit: 2 });
        requireCondition(page.offset === offset && page.bindings.every((name: string) => name.toLowerCase().includes("constructionplane")), "Native capability page/filter mismatch");
        matching = page.matchingBindings; bindings.push(...page.bindings);
        if (page.nextOffset === null) break;
        requireCondition(page.nextOffset === offset + page.bindings.length && page.nextOffset > offset, "Capability pagination did not advance"); offset = page.nextOffset;
      } while (offset <= 10000);
      requireCondition(bindings.length === matching && new Set(bindings).size === matching && bindings.includes("ConstructionPlaneSnap"), "Native construction binding pagination is incomplete");
      evidence.discovery = { selectedWindowPresent: true, matchingBindings: matching, completeFilteredPagination: true };
      await mutate("plasticity_create_box", { originMm: [0,0,0], sizeMm: [10,20,30] });
      const control = state.bodies[0];
      const top = control.faces.find((face: any) => face.normal?.[2] > 0.99);
      requireCondition(top, "Source top face missing");
      const normal = [0, -Math.SQRT1_2, Math.SQRT1_2];
      const definitions: Array<{ label: string; definition: any; origin: number[]; normal: number[]; x?: number[] }> = [
        { label: "explicit", definition: { type: "explicit", originMm: [2,3,4], normal, xDirection: [1,0,0] }, origin: [2,3,4], normal, x: [1,0,0] },
        { label: "face-offset", definition: { type: "planar-face", bodyId: control.id, faceId: top.id, offsetMm: 2 }, origin: [5,10,32], normal: [0,0,1] },
      ];
      definitions.push({ label: "three-points", definition: { type: "three-points" }, origin: [2,3,4], normal, x: [1,0,0] });
      definitions.push({ label: "offset", definition: { type: "offset", planeId: "standard:top", offsetMm: 7 }, origin: [0,0,7], normal: [0,0,1] });
      definitions.push({ label: "rotated", definition: { type: "rotated", planeId: "standard:top", angleDegrees: 90 }, origin: [0,0,0], normal: [0,-1,0] });
      const results = [];
      for (const item of definitions) {
        if (item.label === "three-points") {
          const points = [];
          for (const pointMm of [[2,3,4],[12,3,4],[2,13,14]]) points.push(await call(client, "plasticity_define_datum_point", { definition: { type: "coordinates", pointMm }, revision: state.revision }));
          item.definition = { type: "three-points", firstId: points[0].id, secondId: points[1].id, thirdId: points[2].id };
        } else if (item.label === "rotated") {
          const axis = await call(client, "plasticity_define_datum_axis", { definition: { type: "origin-direction", originMm: [0,0,0], direction: [1,0,0] }, revision: state.revision });
          item.definition.axisId = axis.id;
        }
        const depth = state.undoDepth;
        const created = await call(client, "plasticity_create_construction_plane", { definition: item.definition, name: "Acceptance " + item.label, revision: state.revision }); await fresh();
        requireCondition(state.undoDepth === depth + 1, "Plane creation did not add one history step");
        const verify = async () => {
          const plane = await currentPlane(created.id);
          vectorNear(plane.originMm, item.origin, 0.00001, "saved origin"); vectorNear(plane.normal, item.normal, 1e-8, "saved normal");
          if (item.x) vectorNear(plane.xDirection, item.x, 1e-8, "saved X direction");
          return plane;
        };
        await verify(); await mutate("plasticity_undo", {});
        requireCondition(!state.construction.planes.some((plane: any) => plane.id === created.id), "Plane creation Undo retained its plane");
        await mutate("plasticity_redo", {}); const plane = await verify();
        state = await call(client, "plasticity_set_workplane", { plane: ref(plane) });
        requireCondition(state.construction.activePlaneId === created.id && state.undoDepth === depth + 1, "Workplane activation/history mismatch");
        const active = await currentPlane(created.id);
        await mutate("plasticity_create_polyline", { pointsMm: [[0,0],[4,0],[4,6],[0,6]], closed: true, plane: ref(active) });
        const wire = state.bodies.find((body: any) => body.type === "Wire");
        requireCondition(wire && state.bodies.length === 2 && state.regions.length === 1, "Plane-local Wire/Region missing");
        const corners = [[0,0],[4,0],[4,6],[0,6]].map(([u,v]) => item.origin.map((value, i) => value + u! * active.xDirection[i] + v! * active.yDirection[i]));
        vectorNear(wire.boundsMm.min, [0,1,2].map(i => Math.min(...corners.map(corner => corner[i]!))), 0.00001, "plane-local minimum");
        vectorNear(wire.boundsMm.max, [0,1,2].map(i => Math.max(...corners.map(corner => corner[i]!))), 0.00001, "plane-local maximum");
        await mutate("plasticity_undo", {}); requireCondition(state.bodies.length === 1 && state.regions.length === 0, "Local profile Undo failed");
        await mutate("plasticity_redo", {}); requireCondition(state.bodies.some((body: any) => body.id === wire.id), "Local profile Redo changed ID");
        await mutate("plasticity_undo", {});
        state = await call(client, "plasticity_set_workplane", { plane: ref(await currentPlane(before.activePlaneId)) });
        const removalDepth = state.undoDepth;
        state = await call(client, "plasticity_remove_construction_plane", { plane: ref(await currentPlane(created.id)) });
        requireCondition(state.undoDepth === removalDepth + 1 && !state.construction.planes.some((plane: any) => plane.id === created.id), "Saved plane removal/history mismatch");
        await mutate("plasticity_undo", {}); await verify(); await mutate("plasticity_redo", {});
        requireCondition(!state.construction.planes.some((plane: any) => plane.id === created.id), "Plane removal Redo failed");
        requireCondition(JSON.stringify(state.bodies[0]) === JSON.stringify(control), "Plane workflow changed the control body");
        results.push({ definition: item.label, originMm: item.origin, normal: item.normal, createRemoveUndoRedo: true, activePlaneVerified: true, localProfileUndoRedo: true });
      }
      const rejectedBefore = state;
      await expectRejection("plasticity_remove_construction_plane", { plane: ref(await currentPlane("standard:top")) }, /[Ss]tandard.*cannot be removed/);
      await fresh(); requireCondition(state.revision === rejectedBefore.revision && state.undoDepth === rejectedBefore.undoDepth, "Standard-plane rejection changed state");
      while (state.undoDepth > initial.undoDepth) await mutate("plasticity_undo", {});
      const after = await call(client, "plasticity_list_construction_geometry", {});
      requireCondition(after.activePlaneId === before.activePlaneId && JSON.stringify(state.construction.planes) === JSON.stringify(initial.construction.planes), "Saved-plane cleanup changed initial planes/workplane");
      evidence.planeFrames = results;
    } else if (options.case === "step-provenance") {
      const path = join(output, "source.step");
      await mutate("plasticity_create_box", { originMm: [1, 2, 3], sizeMm: [10, 20, 30] });
      const beforeExport = state;
      await call(client, "plasticity_export_step", { ids: [state.bodies[0].id], path, revision: state.revision });
      const bytes = await readFile(path); requireCondition(bytes.toString("utf8", 0, 100).includes("ISO-10303-21"), "STEP export header missing");
      const hash = createHash("sha256").update(bytes).digest("hex");
      await fresh(); requireCondition(state.revision === beforeExport.revision, "STEP export changed CAD revision");
      await expectRejection("plasticity_export_step", { ids: [state.bodies[0].id], path, revision: state.revision }, /overwrite|exists/i);
      await mutate("plasticity_undo", {}); requireEmpty(state);
      const imported = await call(client, "plasticity_import_step", { path, revision: state.revision }); await fresh();
      requireCondition(imported.provenancePersisted && imported.importedArtifactHash === hash && imported.documentToken === state.documentToken && imported.revision === state.revision, "STEP import provenance/identity mismatch");
      await verifyBox([1, 2, 3], [11, 22, 33]); const importedId = state.bodies[0].id;
      await mutate("plasticity_undo", {}); requireEmpty(state); await mutate("plasticity_redo", {}); await verifyBox([1, 2, 3], [11, 22, 33]);
      requireCondition(state.bodies[0].id === importedId, "STEP Redo changed body ID");
      const history = await call(client, "plasticity_construction_history", { limit: 20 });
      requireCondition(history.total === 5 && history.entries.every((entry: any) => entry.status === "completed"), "Isolated durable history did not contain five confirmed geometry events");
      await client.close(); client = undefined;
      client = await startMcp(join(output, "strength-store")); state = await call(client, "plasticity_connect", { targetId: options.target });
      compareInitialSnapshot = false;
      await verifyBox([1, 2, 3], [11, 22, 33]);
      const list = await call(client, "plasticity_list_step_imports", {}); const record = await call(client, "plasticity_get_step_import", { id: imported.referenceRecordId });
      requireCondition(list.total === 1 && list.records[0].id === imported.referenceRecordId && list.records[0].artifactHash === hash && list.records[0].historical && record.historical, "STEP provenance did not survive MCP restart");
      vectorNear(record.bodies[0].boundsMm.min, [1, 2, 3], 0.00001, "historical STEP minimum"); vectorNear(record.bodies[0].boundsMm.max, [11, 22, 33], 0.00001, "historical STEP maximum");
      const restoredHistory = await call(client, "plasticity_construction_history", { limit: 20 }); requireCondition(restoredHistory.total === history.total, "Durable history did not survive MCP restart");
      state = await call(client, "plasticity_reconcile", {}); await verifyBox([1, 2, 3], [11, 22, 33]);
      await mutate("plasticity_undo", {}); requireEmpty(state);
      requireCondition(createHash("sha256").update(await readFile(path)).digest("hex") === hash, "STEP artifact changed");
      evidence.step = { artifactHash: hash, provenanceSurvivedRestart: true, historySurvivedRestart: true, undoRedo: true };
    } else {
      const emptyPath = join(output, "initial-empty.plasticity"); const savedPath = join(output, "saved-box.plasticity"); const dirtyBackup = join(output, "dirty-backup.plasticity");
      await call(client, "plasticity_save_copy", { path: emptyPath });
      await mutate("plasticity_create_box", { originMm: [1, 2, 3], sizeMm: [10, 20, 30] });
      const beforeSave = state;
      await call(client, "plasticity_save_copy", { path: savedPath });
      requireCondition((await stat(savedPath)).size > 24 && (await readFile(savedPath)).toString("utf8", 0, 10).startsWith("plasticity"), "Saved document header missing");
      const hash = createHash("sha256").update(await readFile(savedPath)).digest("hex");
      await fresh(); requireCondition(state.revision === beforeSave.revision && state.undoDepth === beforeSave.undoDepth, "Save-copy changed CAD history");
      await expectRejection("plasticity_save_copy", { path: savedPath }, /overwrite|exists/i);
      await mutate("plasticity_move", { ids: [state.bodies[0].id], deltaMm: [50, 0, 0] }); await verifyBox([51, 2, 3], [61, 22, 33]);
      await mutate("plasticity_undo", {}); await verifyBox([1, 2, 3], [11, 22, 33]); await mutate("plasticity_redo", {}); await verifyBox([51, 2, 3], [61, 22, 33]);
      state = await call(client, "plasticity_open_document", { path: savedPath, backupPath: dirtyBackup, revision: state.revision }); compareInitialSnapshot = false;
      await verifyBox([1, 2, 3], [11, 22, 33]); requireCondition(state.undoDepth === 0 && state.redoDepth === 0, "Native reopen did not reset history");
      state = await call(client, "plasticity_open_document", { path: dirtyBackup, backupPath: join(output, "before-backup-reopen.plasticity"), revision: state.revision });
      await verifyBox([51, 2, 3], [61, 22, 33]);
      requireCondition(createHash("sha256").update(await readFile(savedPath)).digest("hex") === hash, "Opening a saved document overwrote its original file");
      state = await call(client, "plasticity_open_document", { path: emptyPath, backupPath: join(output, "final-owned-box.plasticity"), revision: state.revision });
      requireEmpty(state); requireCondition(state.undoDepth === 0 && state.redoDepth === 0, "Empty baseline reopen retained history");
      evidence.saveOpen = { savedDocumentUnchanged: true, dirtyBackupReadback: true, restoredEmptyBaseline: true, nativeHistoryReset: true };
    }
    requireEmpty(state);
    if (compareInitialSnapshot) {
      const changes = await call(client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
      requireCondition(!hasSceneContentChanges(changes.diff), "Scene content differs from the initial empty snapshot after cleanup");
    }
    evidence.snapshotCompared = compareInitialSnapshot;
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
            status = await call(client, "plasticity_undo", { intent: "Recover disposable measure-datum-files acceptance", revision: status.revision });
          }
          evidence.recovery = { restoredEmptyDocument: status.bodies.length === 0 && status.regions.length === 0 };
        }
      } catch { /* Preserve the primary failure; inspect the disposable scene manually if recovery reads fail. */ }
    }
    await writeExclusive(join(output, "failure.json"), sanitizeEvidence(evidence)).catch(() => {});
    throw error;
  } finally { await client?.close().catch(() => {}); }
}

export function isolatedAcceptanceEnvironment(root: string, source: NodeJS.ProcessEnv): Record<string, string> {
  const inherited = Object.fromEntries(["PATH", "HOME", "TMPDIR"].flatMap(key => typeof source[key] === "string" ? [[key, source[key]!]] : []));
  return { ...inherited, PLASTICITY_CDP_URL: source.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223", PLASTICITY_STRENGTH_ROOT: root,
    PLASTICITY_REFERENCE_ROOT: join(root, "references"), PLASTICITY_REFERENCE_ARTIFACT_ROOT: join(root, "reference-artifacts"),
    PLASTICITY_CONSTRUCTION_HISTORY_ROOT: join(root, "history"), PLASTICITY_THREAD_QUALIFICATION_ROOT: join(root, "thread-qualifications") };
}

async function startMcp(storeRoot: string): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: isolatedAcceptanceEnvironment(storeRoot, process.env), stderr: "pipe" });
  const client = new Client({ name: "plasticity-native-measure-datum-files-live", version: "1.0.0" });
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
  requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0 && (state.referenceMeshes ?? []).length === 0, "Refusing measure-datum-files acceptance in a nonempty Plasticity document");
  requireCondition((state.measurements ?? []).length === 0 && (state.sectionAnalyses ?? []).length === 0, "Refusing measure-datum-files acceptance while document annotations or section analyses exist");
  requireCondition((state.groups ?? []).every((group: { id: number }) => group.id === 0), "Refusing measure-datum-files acceptance while non-root groups exist");
}
function summary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length }; }
function near(actual: number, expected: number, tolerance: number, label: string): void { requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`); }
function vectorNear(actual: unknown, expected: number[], tolerance: number, label: string): void { requireCondition(Array.isArray(actual) && actual.length === expected.length, `${label}: vector length mismatch`); actual.forEach((value, index) => near(value, expected[index]!, tolerance, `${label}[${index}]`)); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
