#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { hydrateNativeState } from "./native-live-state.ts";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const CORE_CATALOG_CASES = ["block-dimensions", "radius-dimension", "offset-face", "extrude-face", "chamfer", "pipe", "helix"] as const;
type CatalogCase = typeof CORE_CATALOG_CASES[number];

interface Options { case: CatalogCase; help: boolean; target?: string; output?: string; allowDisposableMutations: boolean }

export function parseNativeCoreCatalogAcceptanceArgs(argv: string[]): Options {
  const options: Options = { help: argv.length === 0, allowDisposableMutations: false, case: "offset-face" };
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
        if (!(CORE_CATALOG_CASES as readonly string[]).includes(value)) throw new Error(`Unknown catalog case: ${value}`);
        options.case = value as CatalogCase;
      }
    } else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Live native-core-catalog acceptance requires --target with an explicit Plasticity window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native-core-catalog acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native-core-catalog acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-core-catalog-live.ts --help
  node scripts/verify-native-core-catalog-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

Cases: ${CORE_CATALOG_CASES.join(", ")} (select with --case).

No-argument and --help modes do not connect to Plasticity. Live mode requires
an explicit empty disposable document, verifies native core operations and
mass properties through stdio MCP, checks Undo/Redo, restores the scene, and
writes sanitized evidence.`;

async function main(): Promise<void> {
  const options = parseNativeCoreCatalogAcceptanceArgs(process.argv.slice(2));
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
    const snapshot = await call(client, "plasticity_capture_snapshot", { label: "native-core-catalog-acceptance-initial-empty" });

    evidence.case = options.case;
    const mutate = async (name: string, args: Record<string, unknown>): Promise<any> => {
      state = await call(client!, name, { ...args, revision: state?.revision ?? initial.revision });
      return state;
    };
    let sourceId: number | undefined;
    const check = async (current: any): Promise<void> => {
      evidence.observedBodies = current.bodies.map((body: any) => ({ id: body.id, type: body.type, boundsMm: body.boundsMm }));
      const retainsSource = options.case === "extrude-face" || options.case === "pipe";
      requireCondition(current.bodies.length === (retainsSource ? 2 : 1), "Unexpected output/source body count");
      const body = retainsSource ? current.bodies.find((body: any) => body.id !== sourceId) : current.bodies[0];
      requireCondition(body?.type === (options.case === "helix" ? "Wire" : "Solid"), "Output body type mismatch");
      if (retainsSource) {
        const source = current.bodies.find((body: any) => body.id === sourceId);
        requireCondition(source?.type === (options.case === "pipe" ? "Wire" : "Solid"), "Source body was not retained");
        vectorNear(source.boundsMm.min, [0, 0, 0], 0.00001, "retained source minimum");
        vectorNear(source.boundsMm.max, options.case === "pipe" ? [0, 0, 20] : [10, 10, 10], 0.00001, "retained source maximum");
        if (options.case === "extrude-face") {
          const original = await call(client!, "plasticity_measure_solid_properties", { ids: [sourceId], revision: current.revision });
          near(original.bodies[0].volumeMm3, 1000, 0.0001, "retained source volume");
        }
      }
      if (options.case === "helix") {
        const directions = await call(client!, "plasticity_list_curve_directions", {});
        requireCondition(directions.documentToken === current.documentToken && directions.revision === current.revision, "Helix curve read is stale");
        const curve = directions.curves.find((curve: any) => curve.id === body.id);
        requireCondition(curve?.measurementSource === "native-brep" && curve.segments.length > 0, "Helix native segments unavailable");
        const length = curve.segments.reduce((sum: number, segment: any) => sum + segment.lengthMm, 0);
        near(length, Math.hypot(20 * Math.PI, 10), 0.001, "helix length");
        vectorNear(body.boundsMm.min, [-5, -5, 0], 0.001, "helix minimum");
        vectorNear(body.boundsMm.max, [5, 5, 10], 0.001, "helix maximum");
        evidence.geometry = { lengthMm: length, boundsMm: body.boundsMm };
        return;
      }
      const expectedVolume = { "block-dimensions": 20 * 15 * 12, "radius-dimension": 90 * Math.PI,
        "offset-face": 1200, "extrude-face": 200, chamfer: 980, pipe: 80 * Math.PI }[options.case];
      const validation = await call(client!, "plasticity_validate_bodies", { ids: [body.id], revision: current.revision });
      requireCondition(validation.bodies.length === 1 && validation.bodies[0].nativeValid && validation.bodies[0].printableSolid, "Output failed native Solid validation");
      const properties = await call(client!, "plasticity_measure_solid_properties", { ids: [body.id], revision: current.revision });
      // Native PipeFactory sweeps a B-Spline surface, even on a straight spine.
      // Check its exact circular ends separately; do not label it an analytic cylinder.
      const volumeToleranceMm3 = options.case === "pipe" ? 0.01 : 0.0001;
      near(properties.bodies[0].volumeMm3, expectedVolume!, volumeToleranceMm3, "output volume");
      if (options.case === "pipe") {
        requireCondition(body.faces.length === 3 && body.edges.length === 2 && body.edges.every((edge: any) => edge.circleGeometry), "Pipe must have two exact circular ends and three faces");
        const ends = body.edges.map((edge: any) => edge.circleGeometry).sort((a: any, b: any) => a.centerMm[2] - b.centerMm[2]);
        for (const [index, circle] of ends.entries()) {
          near(circle.radiusMm, 2, 0.00001, "pipe end radius");
          vectorNear(circle.centerMm, [0, 0, index * 20], 0.00001, "pipe end center");
        }
        evidence.pipeContract = { analyticCylinderRequired: false, volumeToleranceMm3, surfaceTypes: body.faces.map((face: any) => face.surfaceType) };
      }
      const expectedSize = options.case === "block-dimensions" ? [20, 15, 12]
        : options.case === "radius-dimension" ? [6, 6, 10]
        : options.case === "pipe" ? [4, 4, 20]
        : options.case === "chamfer" ? [10, 10, 10] : options.case === "extrude-face" ? [10, 10, 2] : [10, 10, 12];
      vectorNear(body.boundsMm.max.map((value: number, index: number) => value - body.boundsMm.min[index]), expectedSize, 0.00001, "output dimensions");
      evidence.geometry = { bodyId: body.id, boundsMm: body.boundsMm, validation: validation.bodies[0], massProperties: properties.bodies[0] };
    };
    if (options.case === "helix") {
      await mutate("plasticity_create_helix", { axisStartMm: [0, 0, 0], axisEndMm: [0, 0, 10], radiusMm: 5, turns: 2 });
    } else {
      if (options.case === "radius-dimension") {
        await mutate("plasticity_create_cylinder", { centerMm: [0, 0, 0], radiusMm: 5, heightMm: 10, axis: [0, 0, 1] });
      } else if (options.case === "pipe") {
        await mutate("plasticity_create_polyline", { pointsMm: [[0, 0, 0], [0, 0, 20]], closed: false });
      } else {
        await mutate("plasticity_create_box", { originMm: [0, 0, 0], sizeMm: [10, 10, 10] });
      }
      const source = state;
      const body = source.bodies[0];
      sourceId = body.id;
      if (options.case === "block-dimensions") await mutate("plasticity_set_block_dimensions", { id: body.id, widthMm: 20, lengthMm: 15, heightMm: 12 });
      else if (options.case === "radius-dimension") {
        const face = body.faces.find((face: any) => face.surfaceType === "Cylinder");
        requireCondition(face, "Cylinder face unavailable");
        await mutate("plasticity_set_radius_dimension", { face: { bodyId: body.id, faceId: face.id }, radiusMm: 3 });
      } else if (options.case === "pipe") await mutate("plasticity_create_pipes", { spineIds: [body.id], diameterMm: 4, wallThicknessMm: 0 });
      else if (options.case === "chamfer") {
        const edge = body.edges.find((edge: any) => Math.abs(edge.lengthMm - 10) < 0.00001);
        requireCondition(edge, "Box edge unavailable");
        await mutate("plasticity_chamfer", { id: body.id, edgeIds: [edge.id], distanceMm: 2 });
      } else {
        const face = body.faces.find((face: any) => face.normal?.[2] > 0.999 && Math.abs(face.centerMm[2] - 10) < 0.00001);
        requireCondition(face, "Top planar face unavailable");
        await mutate(options.case === "offset-face" ? "plasticity_offset_faces" : "plasticity_extrude_faces", { id: body.id, faceIds: [face.id], distanceMm: 2 });
      }
      requireCondition(state.undoDepth === source.undoDepth + 1, "Operation must create exactly one history step");
      await check(state);
      const resultIds = state.bodies.map((body: any) => body.id).sort((a: number, b: number) => a - b);
      await mutate("plasticity_undo", {});
      requireCondition(state.bodies.length === source.bodies.length && state.bodies[0].id === body.id, "Undo did not restore source identity");
      vectorNear(state.bodies[0].boundsMm.min, body.boundsMm.min, 0.00001, "undone source minimum");
      vectorNear(state.bodies[0].boundsMm.max, body.boundsMm.max, 0.00001, "undone source maximum");
      await mutate("plasticity_redo", {});
      requireCondition(JSON.stringify(state.bodies.map((body: any) => body.id).sort((a: number, b: number) => a - b)) === JSON.stringify(resultIds), "Redo changed body identities");
    }
    if (options.case === "helix") {
      requireCondition(state.undoDepth === initial.undoDepth + 1, "Helix must create exactly one history step");
      await check(state);
      const helixId = state.bodies[0].id;
      await mutate("plasticity_undo", {});
      requireEmpty(state);
      await mutate("plasticity_redo", {});
      requireCondition(state.bodies.length === 1 && state.bodies[0].id === helixId, "Redo changed helix identity");
    }
    await check(state);
    await mutate("plasticity_undo", {});
    if (options.case !== "helix") await mutate("plasticity_undo", {});
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
          for (let attempt = 0; attempt < 8 && status.undoDepth > initial.undoDepth; attempt += 1) {
            status = await call(client, "plasticity_undo", { intent: "Recover disposable core-catalog acceptance", revision: status.revision });
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
  const client = new Client({ name: "plasticity-native-core-catalog-live", version: "1.0.0" });
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
  requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0 && (state.referenceMeshes ?? []).length === 0, "Refusing core-catalog acceptance in a nonempty Plasticity document");
  requireCondition((state.measurements ?? []).length === 0 && (state.sectionAnalyses ?? []).length === 0, "Refusing core-catalog acceptance while document annotations or section analyses exist");
  requireCondition((state.groups ?? []).every((group: { id: number }) => group.id === 0), "Refusing core-catalog acceptance while non-root groups exist");
}
function summary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length }; }
function near(actual: number, expected: number, tolerance: number, label: string): void { requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`); }
function vectorNear(actual: unknown, expected: number[], tolerance: number, label: string): void { requireCondition(Array.isArray(actual) && actual.length === expected.length, `${label}: vector length mismatch`); actual.forEach((value, index) => near(value, expected[index]!, tolerance, `${label}[${index}]`)); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
