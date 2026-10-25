#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertPointSetNear } from "./verify-native-patterns-recipes-live.ts";

import { hydrateNativeState } from "./native-live-state.ts";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const PROFILE_LOFT_CASES = ["offset-outward", "offset-inward", "region-offsets", "extend-endpoints", "extract-edges", "loft-regions", "sweep-regions", "join-sheets", "cap-sheet", "solid-from-sheet"] as const;
type ProfileLoftCase = typeof PROFILE_LOFT_CASES[number];

interface Options { case: ProfileLoftCase; help: boolean; target?: string; output?: string; allowDisposableMutations: boolean }

export function parseNativeProfilesLoftsAcceptanceArgs(argv: string[]): Options {
  const options: Options = { help: argv.length === 0, allowDisposableMutations: false, case: "offset-outward" };
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
        if (!(PROFILE_LOFT_CASES as readonly string[]).includes(value)) throw new Error(`Unknown catalog case: ${value}`);
        options.case = value as ProfileLoftCase;
      }
    } else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Live native-profiles-lofts acceptance requires --target with an explicit Plasticity window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native-profiles-lofts acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native-profiles-lofts acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-profiles-lofts-live.ts --help
  node scripts/verify-native-profiles-lofts-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

Cases: ${PROFILE_LOFT_CASES.join(", ")} (select with --case).

No-argument and --help modes do not connect to Plasticity. Live mode requires
an explicit empty disposable document, verifies native profiles, lofts and Sheet closure and
mass properties through stdio MCP, checks Undo/Redo, restores the scene, and
writes sanitized evidence.`;

async function main(): Promise<void> {
  const options = parseNativeProfilesLoftsAcceptanceArgs(process.argv.slice(2));
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
    const snapshot = await call(client, "plasticity_capture_snapshot", { label: "native-profiles-lofts-acceptance-initial-empty" });

    evidence.case = options.case;
    const mutate = async (name: string, args: Record<string, unknown>): Promise<any> => {
      state = await call(client!, name, { ...args, revision: state?.revision ?? initial.revision });
      return state;
    };
    const circleCase = ["offset-outward", "offset-inward", "region-offsets", "loft-regions"].includes(options.case);
    if (circleCase) {
      await mutate("plasticity_create_circle", { centerMm: [0, 0, 0], radiusMm: 5, normal: [0, 0, 1] });
      if (options.case === "loft-regions") await mutate("plasticity_create_circle", { centerMm: [0, 0, 10], radiusMm: 5, normal: [0, 0, 1] });
    } else if (options.case === "extend-endpoints") {
      await mutate("plasticity_create_polyline", { pointsMm: [[0, 0, 0], [10, 0, 0]], closed: false });
    } else if (options.case === "sweep-regions") {
      await mutate("plasticity_create_rectangle", { centerMm: [0, 0, 0], widthMm: 4, heightMm: 3, normal: [0, 0, 1], xDirection: [1, 0, 0] });
      await mutate("plasticity_create_polyline", { pointsMm: [[0, 0, 0], [0, 0, 20]], closed: false });
    } else if (options.case === "join-sheets") {
      for (const pointsMm of [ [[0, 0, 0], [20, 0, 0], [20, 10, 0], [0, 10, 0]], [[0, 0, 0], [0, 0, 5], [20, 0, 5], [20, 0, 0]] ]) {
        const previousBodies = new Set((state?.bodies ?? []).map((body: any) => body.id));
        await mutate("plasticity_create_polyline", { pointsMm, closed: true });
        const wire = state.bodies.find((body: any) => body.type === "Wire" && !previousBodies.has(body.id));
        requireCondition(wire, "New profile Wire missing");
        const region = state.regions.find((region: any) => region.sketchWireIds.includes(wire.id));
        requireCondition(region, "Planar profile Region missing");
        await mutate("plasticity_patch_regions", { regionIds: [region.id] });
      }
    } else {
      await mutate("plasticity_create_box", { originMm: [0, 0, 0], sizeMm: [10, 10, 10] });
      const box = state.bodies[0];
      if (options.case === "cap-sheet") {
        const top = box.faces.find((face: any) => face.normal[2] > 0.999);
        requireCondition(top, "Box top face missing");
        await mutate("plasticity_delete_faces", { faces: [{ bodyId: box.id, faceId: top.id }] });
        requireCondition(state.bodies.length === 1 && state.bodies[0].type === "Sheet" && state.bodies[0].faces.length === 5, "Face deletion did not produce an open five-face Sheet");
      } else if (options.case === "solid-from-sheet") {
        await mutate("plasticity_extract_faces", { faces: box.faces.map((face: any) => ({ bodyId: box.id, faceId: face.id })) });
        const sheet = state.bodies.find((body: any) => body.type === "Sheet");
        requireCondition(sheet?.faces.length === 6, "Expected a closed six-face source Sheet");
      }
    }
    const source = state;
    const sourceSnapshot = await call(client, "plasticity_capture_snapshot", { label: "profiles-lofts-source" });
    const sourceIds = new Set(source.bodies.map((body: any) => body.id));
    const sourceWires = source.bodies.filter((body: any) => body.type === "Wire");
    const sheets = source.bodies.filter((body: any) => body.type === "Sheet");
    switch (options.case) {
      case "offset-outward": case "offset-inward": await mutate("plasticity_offset_planar_curves", { ids: [sourceWires[0].id], distanceMm: options.case === "offset-outward" ? 2 : -2 }); break;
      case "region-offsets": await mutate("plasticity_offset_regions", { regionIds: [source.regions[0].id], offsetsMm: [2, -1], individual: true }); break;
      case "extend-endpoints": {
        const endpoints = await call(client, "plasticity_list_curve_endpoints", {});
        requireCondition(endpoints.documentToken === source.documentToken && endpoints.revision === source.revision && endpoints.endpoints.length === 2, "Stale or missing open Wire endpoints");
        await mutate("plasticity_extend_curve_endpoints", { endpointIds: endpoints.endpoints.map((point: any) => point.id), distanceMm: 2 }); break;
      }
      case "extract-edges": {
        const box = source.bodies[0];
        const top = box.faces.find((face: any) => face.normal[2] > 0.999);
        requireCondition(top?.edgeIds.length === 4, "Expected four top box edges");
        await mutate("plasticity_extract_edges", { edges: top.edgeIds.map((edgeId: string) => ({ bodyId: box.id, edgeId })) }); break;
      }
      case "loft-regions": {
        const profiles = [...sourceWires].sort((a: any, b: any) => a.boundsMm.min[2] - b.boundsMm.min[2]);
        const regions = profiles.map((wire: any) => source.regions.find((region: any) => region.sketchWireIds.includes(wire.id)));
        requireCondition(regions.length === 2 && regions.every(Boolean) && regions[0].id !== regions[1].id, "Expected two separate loft Regions");
        await mutate("plasticity_loft_regions", { regionIds: regions.map((region: any) => region.id), closed: false, simplify: true }); break;
      }
      case "sweep-regions": {
        const spine = sourceWires.find((body: any) => body.boundsMm.max[2] > 19);
        requireCondition(spine && source.regions.length === 1, "Sweep profile or spine missing");
        await mutate("plasticity_sweep_regions", { regionIds: [source.regions[0].id], spineId: spine.id, alignment: "normal", corner: "miter", twistDegrees: 0, scale: 1, simplify: true }); break;
      }
      case "join-sheets": await mutate("plasticity_join_sheets", { ids: sheets.map((body: any) => body.id) }); break;
      case "cap-sheet": await mutate("plasticity_cap_sheet_holes", { ids: [sheets[0].id] }); break;
      case "solid-from-sheet": await mutate("plasticity_create_solid_from_sheet", { id: sheets[0].id }); break;
    }
    requireCondition(state.undoDepth === source.undoDepth + 1, "Operation must create exactly one native history step");
    const check = async (): Promise<void> => {
      evidence.observedBodies = state.bodies.map((body: any) => ({ id: body.id, type: body.type, boundsMm: body.boundsMm }));
      if (["offset-outward", "offset-inward", "region-offsets"].includes(options.case)) {
        const radii = options.case === "offset-outward" ? [5, 7] : options.case === "offset-inward" ? [3, 5] : [4, 5, 7];
        requireCondition(state.bodies.length === radii.length && state.bodies.every((body: any) => body.type === "Wire"), "Unexpected offset Wire count");
        const directions = await call(client!, "plasticity_list_curve_directions", {});
        requireCondition(directions.documentToken === state.documentToken && directions.revision === state.revision && directions.curves.length === radii.length, "Stale/incomplete offset curves");
        const circles = directions.curves.map((curve: any) => {
          requireCondition(curve.measurementSource === "native-brep" && curve.closed && curve.segments.length === 1 && curve.segments[0].circleGeometry, "Offset result is not one exact circular Wire");
          const segment = curve.segments[0];
          const circle = segment.circleGeometry;
          vectorNear(circle.centerMm, [0, 0, 0], 0.00001, "offset center");
          near(segment.lengthMm, 2 * Math.PI * circle.radiusMm, 0.00001, "offset circumference");
          return circle;
        }).sort((a: any, b: any) => a.radiusMm - b.radiusMm);
        vectorNear(circles.map((circle: any) => circle.radiusMm), radii, 0.00001, "offset radii");
        const original = state.bodies.find((body: any) => body.id === sourceWires[0].id);
        requireCondition(original, "Offset consumed the source Wire");
        vectorNear(original.boundsMm.min, [-5, -5, 0], 0.00001, "source offset minimum");
        vectorNear(original.boundsMm.max, [5, 5, 0], 0.00001, "source offset maximum");
        evidence.geometry = { circles }; return;
      }
      if (options.case === "extend-endpoints" || options.case === "extract-edges") {
        const directions = await call(client!, "plasticity_list_curve_directions", {});
        requireCondition(directions.documentToken === state.documentToken && directions.revision === state.revision && directions.curves.length === 1, "Curve read is stale/incomplete");
        const curve = directions.curves[0];
        requireCondition(curve.measurementSource === "native-brep" && curve.segments.every((segment: any) => segment.curveType === "Line"), "Expected exact linear curve segments");
        if (options.case === "extend-endpoints") {
          requireCondition(state.bodies.length === 1 && state.bodies[0].type === "Wire" && !curve.closed, "Expected one extended open Wire");
          near(curve.segments.reduce((sum: number, segment: any) => sum + segment.lengthMm, 0), 14, 0.00001, "extended Wire length");
          assertPointSetNear([curve.segments[0].startMm, curve.segments.at(-1).endMm], [[-2, 0, 0], [12, 0, 0]], 0.00001, "extended endpoints");
        } else {
          requireCondition(state.bodies.length === 2 && curve.closed && curve.segments.length === 4, "Expected a separate closed top-edge Wire");
          curve.segments.forEach((segment: any) => near(segment.lengthMm, 10, 0.00001, "extracted edge length"));
          assertPointSetNear(curve.segments.map((segment: any) => segment.startMm), [[0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]], 0.00001, "extracted corners");
          const original = state.bodies.find((body: any) => body.id === source.bodies[0].id);
          requireCondition(original?.type === "Solid" && original.faces.length === 6 && original.edges.length === 12, "Extraction changed source topology");
          const mass = await call(client!, "plasticity_measure_solid_properties", { ids: [original.id], revision: state.revision });
          near(mass.bodies[0].volumeMm3, 1000, 0.0001, "preserved source volume");
        }
        evidence.geometry = { curves: directions.curves }; return;
      }
      if (options.case === "join-sheets") {
        requireCondition(state.bodies.length === 3 && state.bodies.filter((body: any) => body.type === "Wire").length === 2, "Join did not preserve profiles and replace its two Sheets");
        const sheet = state.bodies.find((body: any) => body.type === "Sheet");
        requireCondition(sheet?.faces.length === 2 && sheet.edges.length === 7 && sheet.faces.every((face: any) => face.planar), "Joined Sheet topology mismatch");
        vectorNear(sheet.boundsMm.min, [0, 0, 0], 0.00001, "joined minimum");
        vectorNear(sheet.boundsMm.max, [20, 10, 5], 0.00001, "joined maximum");
        const validation = await call(client!, "plasticity_validate_bodies", { ids: [sheet.id], revision: state.revision });
        requireCondition(validation.bodies[0]?.nativeValid && !validation.bodies[0].printableSolid, "Joined Sheet failed native open-Sheet validation");
        const properties = await call(client!, "plasticity_measure_face_properties", { faces: sheet.faces.map((face: any) => ({ bodyId: sheet.id, faceId: face.id })), revision: state.revision });
        near(properties.totals.areaMm2, 300, 0.0001, "joined area");
        near(properties.totals.summedBoundaryLengthMm, 110, 0.0001, "joined summed face boundaries");
        evidence.geometry = { validation: validation.bodies[0], properties }; return;
      }
      const solids = state.bodies.filter((body: any) => body.type === "Solid");
      const expectedCount = options.case === "solid-from-sheet" ? 2 : 1;
      const expectedWires = options.case === "loft-regions" || options.case === "sweep-regions" ? 2 : 0;
      requireCondition(solids.length === expectedCount && state.bodies.length === expectedCount + expectedWires + (options.case === "solid-from-sheet" ? 1 : 0), "Unexpected Solid/profile output count");
      const result = options.case === "solid-from-sheet" ? solids.find((body: any) => !sourceIds.has(body.id)) : solids[0];
      requireCondition(result, "New Solid result is missing");
      const ids = solids.map((body: any) => body.id);
      const validation = await call(client!, "plasticity_validate_bodies", { ids, revision: state.revision });
      requireCondition(validation.bodies.length === expectedCount && validation.bodies.every((body: any) => body.nativeValid && body.printableSolid), "Native Solid validation failed");
      const mass = await call(client!, "plasticity_measure_solid_properties", { ids, revision: state.revision });
      const volume = options.case === "loft-regions" ? 250 * Math.PI : options.case === "sweep-regions" ? 240 : 1000;
      requireCondition(mass.bodies.length === expectedCount, "Solid mass-property result count mismatch");
      mass.bodies.forEach((body: any) => near(body.volumeMm3, volume, 0.0001, "output volume"));
      vectorNear(result.boundsMm.min, options.case === "loft-regions" ? [-5, -5, 0] : options.case === "sweep-regions" ? [-2, -1.5, 0] : [0, 0, 0], 0.00001, "Solid minimum");
      vectorNear(result.boundsMm.max, options.case === "loft-regions" ? [5, 5, 10] : options.case === "sweep-regions" ? [2, 1.5, 20] : [10, 10, 10], 0.00001, "Solid maximum");
      if (options.case === "cap-sheet" || options.case === "solid-from-sheet") requireCondition(result.faces.length === 6 && result.edges.length === 12, "Closed box topology mismatch");
      if (options.case === "solid-from-sheet") requireCondition(state.bodies.some((body: any) => body.id === sheets[0].id && body.type === "Sheet" && body.faces.length === 6), "Solid creation consumed its source Sheet");
      if (options.case === "solid-from-sheet") {
        for (const original of source.bodies) {
          const retained = state.bodies.find((body: any) => body.id === original.id && body.type === original.type);
          requireCondition(retained && retained.faces.length === original.faces.length && retained.edges.length === original.edges.length, "Solid creation changed source topology");
          vectorNear(retained.boundsMm.min, original.boundsMm.min, 0.00001, "retained source minimum");
          vectorNear(retained.boundsMm.max, original.boundsMm.max, 0.00001, "retained source maximum");
        }
      }
      for (const wire of sourceWires) {
        const retained = state.bodies.find((body: any) => body.id === wire.id && body.type === "Wire");
        requireCondition(retained, "Sweep/loft consumed a source Wire");
        vectorNear(retained.boundsMm.min, wire.boundsMm.min, 0.00001, "preserved profile minimum");
        vectorNear(retained.boundsMm.max, wire.boundsMm.max, 0.00001, "preserved profile maximum");
      }
      evidence.geometry = { validation: validation.bodies, massProperties: mass.bodies };
    };
    await check();
    const resultIds = state.bodies.map((body: any) => body.id).sort((a: number, b: number) => a - b);
    await mutate("plasticity_undo", {});
    const sourceChanges = await call(client, "plasticity_changes_since", { snapshotId: sourceSnapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(sourceChanges.diff), "Undo did not restore the complete source snapshot");
    await mutate("plasticity_redo", {});
    requireCondition(JSON.stringify(state.bodies.map((body: any) => body.id).sort((a: number, b: number) => a - b)) === JSON.stringify(resultIds), "Redo changed result identities");
    await check();
    for (let i = 0; state.undoDepth > initial.undoDepth && i < 12; i += 1) await mutate("plasticity_undo", {});
    requireEmpty(state);
    const changes = await call(client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(changes.diff), "Scene content differs from the initial empty snapshot after cleanup");
    evidence.undoRedo = true;
    evidence.cleanup = { restoredEmptyDocument: true, sceneContentsRestored: true };
    evidence.completedAt = new Date().toISOString();
    await writeExclusive(join(output, "evidence.json"), sanitizeEvidence(evidence));
    console.log(JSON.stringify({ ok: true, output, evidence: join(output, "evidence.json"), geometry: evidence.geometry }));
  } catch (error) {
    evidence.error = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
    if (client && initial && state && state.documentToken === initial.documentToken) {
      try {
        const current = await call(client, "plasticity_status", {});
        if (current.documentToken === initial.documentToken && current.revision === state.revision && current.undoDepth > initial.undoDepth) {
          let status = current;
          for (let attempt = 0; attempt < 12 && status.undoDepth > initial.undoDepth; attempt += 1) {
            status = await call(client, "plasticity_undo", { intent: "Recover disposable profiles-lofts acceptance", revision: status.revision });
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
  const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof process.env[key] === "string" ? [[key, process.env[key]!]] : []));
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: { ...env, PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" }, stderr: "pipe" });
  const client = new Client({ name: "plasticity-native-profiles-lofts-live", version: "1.0.0" });
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
  requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0 && (state.referenceMeshes ?? []).length === 0, "Refusing profiles-lofts acceptance in a nonempty Plasticity document");
  requireCondition((state.measurements ?? []).length === 0 && (state.sectionAnalyses ?? []).length === 0, "Refusing profiles-lofts acceptance while document annotations or section analyses exist");
  requireCondition((state.groups ?? []).every((group: { id: number }) => group.id === 0), "Refusing profiles-lofts acceptance while non-root groups exist");
}
function summary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length }; }
function near(actual: number, expected: number, tolerance: number, label: string): void { requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`); }
function vectorNear(actual: unknown, expected: number[], tolerance: number, label: string): void { requireCondition(Array.isArray(actual) && actual.length === expected.length, `${label}: vector length mismatch`); actual.forEach((value, index) => near(value, expected[index]!, tolerance, `${label}[${index}]`)); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
