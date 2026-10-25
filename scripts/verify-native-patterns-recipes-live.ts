#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { hydrateNativeState } from "./native-live-state.ts";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const PATTERN_RECIPE_CASES = ["mirror-copy", "mirror-move", "mirror-crossing-copy", "mirror-crossing-move", "rectangular-pattern", "radial-pattern", "rename", "rectangle-dimensions", "reverse-curves", "unjoin-curves", "counterbore", "connector-opening"] as const;
type PatternRecipeCase = typeof PATTERN_RECIPE_CASES[number];

interface Options { case: PatternRecipeCase; help: boolean; target?: string; output?: string; allowDisposableMutations: boolean }

export function parseNativePatternsRecipesAcceptanceArgs(argv: string[]): Options {
  const options: Options = { help: argv.length === 0, allowDisposableMutations: false, case: "mirror-copy" };
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
        if (!(PATTERN_RECIPE_CASES as readonly string[]).includes(value)) throw new Error(`Unknown catalog case: ${value}`);
        options.case = value as PatternRecipeCase;
      }
    } else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Live native-patterns-recipes acceptance requires --target with an explicit Plasticity window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native-patterns-recipes acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native-patterns-recipes acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-patterns-recipes-live.ts --help
  node scripts/verify-native-patterns-recipes-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

Cases: ${PATTERN_RECIPE_CASES.join(", ")} (select with --case).

No-argument and --help modes do not connect to Plasticity. Live mode requires
an explicit empty disposable document, verifies native patterns, curves and recipes and
mass properties through stdio MCP, checks Undo/Redo, restores the scene, and
writes sanitized evidence.`;

async function main(): Promise<void> {
  const options = parseNativePatternsRecipesAcceptanceArgs(process.argv.slice(2));
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
    const snapshot = await call(client, "plasticity_capture_snapshot", { label: "native-patterns-recipes-acceptance-initial-empty" });

    evidence.case = options.case;
    const mutate = async (name: string, args: Record<string, unknown>): Promise<any> => {
      const result = await call(client!, name, { ...args, revision: state?.revision ?? initial.revision });
      if (result.status === "completed" && result.afterRevision) {
        state = await call(client!, "plasticity_status", {});
        requireCondition(result.documentToken === state.documentToken && result.afterRevision === state.revision, "Recipe report does not match current document");
        evidence.recipe = result;
      } else state = result;
      return result;
    };
    const wireCase = ["rectangle-dimensions", "reverse-curves", "unjoin-curves"].includes(options.case);
    if (options.case === "reverse-curves") {
      await mutate("plasticity_create_polyline", { pointsMm: [[0, 0, 0], [10, 0, 0], [10, 5, 0]], closed: false });
    } else if (wireCase) {
      await mutate("plasticity_create_rectangle", { centerMm: [10, 20, 0], widthMm: 10, heightMm: 6, normal: [0, 0, 1], xDirection: [1, 0, 0] });
    } else {
      const recipe = options.case === "counterbore" || options.case === "connector-opening";
      await mutate("plasticity_create_box", { originMm: recipe ? [0, 0, 0] : options.case.includes("crossing") ? [-1, -2, 0] : [10, -2, 0], sizeMm: options.case === "counterbore" ? [20, 20, 10] : options.case === "connector-opening" ? [30, 20, 10] : options.case.includes("crossing") ? [3, 4, 3] : [2, 4, 3] });
    }
    const source = state;
    requireCondition(source.bodies.length === 1, "Expected one source body");
    const id = source.bodies[0].id;
    let steps = 1;
    switch (options.case) {
      case "mirror-copy": case "mirror-move": case "mirror-crossing-copy": case "mirror-crossing-move":
        await mutate("plasticity_mirror", { ids: [id], planeOriginMm: [0, 0, 0], planeNormal: [1, 0, 0], keepOriginal: options.case.endsWith("copy") }); break;
      case "rectangular-pattern":
        await mutate("plasticity_rectangular_pattern", { ids: [id], direction1: [1, 0, 0], count1: 3, spacing1Mm: 8, direction2: [0, 1, 0], count2: 2, spacing2Mm: 10 }); break;
      case "radial-pattern":
        await mutate("plasticity_radial_pattern", { ids: [id], centerMm: [0, 0, 0], axis: [0, 0, 1], count: 4, sweepDegrees: 360 }); break;
      case "rename": await mutate("plasticity_rename", { id, name: "Catalog renamed block" }); break;
      case "rectangle-dimensions": await mutate("plasticity_set_rectangle_dimensions", { id, widthMm: 20, lengthMm: 8 }); break;
      case "reverse-curves": await mutate("plasticity_reverse_curves", { ids: [id] }); break;
      case "unjoin-curves": await mutate("plasticity_unjoin_curves", { ids: [id] }); break;
      case "counterbore": {
        steps = 3;
        const report = await mutate("plasticity_create_counterbore", { targetId: id, entryCenterMm: [10, 10, 10], axis: [0, 0, -1], throughDiameterMm: 4, counterboreDiameterMm: 8, counterboreDepthMm: 3, throughDepthMm: 10, overshootMm: 0.5 });
        requireCondition(report.undoSteps === steps && report.steps.length === steps, "Counterbore history report mismatch"); break;
      }
      case "connector-opening": {
        steps = 4;
        const report = await mutate("plasticity_create_connector_opening", { targetId: id, entryCenterMm: [15, 10, 10], axis: [0, 0, -1], widthDirection: [1, 0, 0], widthMm: 10, heightMm: 4, cornerRadiusMm: 1, throughDepthMm: 10, overshootMm: 0.5 });
        requireCondition(report.undoSteps === steps && report.steps.length === steps, "Connector history report mismatch"); break;
      }
    }
    requireCondition(state.undoDepth === source.undoDepth + steps, "Native history step count mismatch");
    const check = async (): Promise<void> => {
      evidence.observedBodies = state.bodies.map((body: any) => ({ id: body.id, type: body.type, boundsMm: body.boundsMm, name: body.name }));
      if (wireCase) {
        const expectedCount = options.case === "unjoin-curves" ? 4 : 1;
        requireCondition(state.bodies.length === expectedCount && state.bodies.every((body: any) => body.type === "Wire"), "Unexpected Wire output count");
        const report = await call(client!, "plasticity_list_curve_directions", {});
        requireCondition(report.documentToken === state.documentToken && report.revision === state.revision && report.curves.length === expectedCount, "Curve report is stale or incomplete");
        const segments = report.curves.flatMap((curve: any) => curve.segments);
        requireCondition(report.curves.every((curve: any) => curve.measurementSource === "native-brep"), "Curve geometry is not native B-Rep");
        const lengths = segments.map((segment: any) => segment.lengthMm).sort((a: number, b: number) => a - b);
        const expectedLengths = options.case === "reverse-curves" ? [5, 10] : options.case === "rectangle-dimensions" ? [8, 8, 20, 20] : [6, 6, 10, 10];
        vectorNear(lengths, expectedLengths, 0.00001, "curve segment lengths");
        if (options.case === "reverse-curves") {
          requireCondition(report.curves[0].closed === false, "Reversal unexpectedly closed the Wire");
          vectorNear(segments[0].startMm, [10, 5, 0], 0.00001, "reversed start");
          vectorNear(segments.at(-1).endMm, [0, 0, 0], 0.00001, "reversed end");
        } else {
          assertPointSetNear(segments.map((segment: any) => segment.startMm), options.case === "rectangle-dimensions" ? [[6, 10, 0], [14, 10, 0], [14, 30, 0], [6, 30, 0]] : [[5, 17, 0], [15, 17, 0], [15, 23, 0], [5, 23, 0]], 0.00001, "rectangle corners");
          if (options.case === "rectangle-dimensions") requireCondition(report.curves[0].closed && state.regions.length === 1, "Resized rectangle lost its Region");
          else requireCondition(report.curves.every((curve: any) => !curve.closed && curve.segments.length === 1), "Unjoin did not create independent lines");
        }
        const endpoints = await call(client!, "plasticity_list_curve_endpoints", {});
        requireCondition(endpoints.revision === state.revision && endpoints.documentToken === state.documentToken, "Endpoint report is stale");
        requireCondition(endpoints.endpoints.length === (options.case === "reverse-curves" ? 2 : options.case === "unjoin-curves" ? 8 : 0), "Unexpected native endpoint count");
        requireCondition(endpoints.endpoints.every((endpoint: any) => endpoint.measurementSource === "native-brep" && state.bodies.some((body: any) => body.id === endpoint.bodyId)), "Endpoint ownership/source mismatch");
        if (options.case === "reverse-curves") assertPointSetNear(endpoints.endpoints.map((endpoint: any) => endpoint.positionMm), [[10, 5, 0], [0, 0, 0]], 0.00001, "open Wire endpoints");
        if (options.case === "unjoin-curves") {
          const corners = [[5, 17, 0], [15, 17, 0], [15, 23, 0], [5, 23, 0]];
          assertPointSetNear(endpoints.endpoints.map((endpoint: any) => endpoint.positionMm), [...corners, ...corners], 0.00001, "unjoined endpoints");
        }
        evidence.geometry = { curves: report.curves, endpoints: endpoints.endpoints }; return;
      }
      const expectedCount = options.case.startsWith("mirror") && options.case.endsWith("copy") ? 2 : options.case === "rectangular-pattern" ? 6 : options.case === "radial-pattern" ? 4 : 1;
      const solids = state.bodies.filter((body: any) => body.type === "Solid");
      requireCondition(solids.length === expectedCount && state.bodies.length === expectedCount + (options.case === "connector-opening" ? 1 : 0), "Unexpected Solid/profile count");
      const ids = solids.map((body: any) => body.id);
      const validation = await call(client!, "plasticity_validate_bodies", { ids, revision: state.revision });
      requireCondition(validation.bodies.length === expectedCount && validation.bodies.every((body: any) => body.nativeValid && body.printableSolid), "Output failed native Solid validation");
      const properties = await call(client!, "plasticity_measure_solid_properties", { ids, revision: state.revision });
      const expectedVolume = options.case === "counterbore" ? 4000 - 76 * Math.PI : options.case === "connector-opening" ? 6000 - 10 * (36 + Math.PI) : options.case.includes("crossing") ? 36 : 24;
      requireCondition(properties.bodies.length === expectedCount, "Mass properties incomplete");
      for (const body of properties.bodies) near(body.volumeMm3, expectedVolume, 0.0001, "Solid volume");
      if (options.case === "counterbore" || options.case === "connector-opening") {
        vectorNear(solids[0].boundsMm.min, [0, 0, 0], 0.00001, "cut body minimum");
        vectorNear(solids[0].boundsMm.max, options.case === "counterbore" ? [20, 20, 10] : [30, 20, 10], 0.00001, "cut body maximum");
        if (options.case === "counterbore") {
          const cylinders = solids[0].faces.filter((face: any) => face.surfaceType === "Cylinder");
          vectorNear(cylinders.map((face: any) => face.radiusMm).sort((a: number, b: number) => a - b), [2, 4], 0.00001, "counterbore radii");
          const shoulder = solids[0].faces.find((face: any) => face.planar && Math.abs(face.centerMm[2] - 7) < 0.00001);
          requireCondition(shoulder, "Counterbore shoulder is not at depth 3 mm");
        } else {
          const profile = state.bodies.find((body: any) => body.type === "Wire");
          requireCondition(profile, "Editable connector profile was not preserved");
          const cylinders = solids[0].faces.filter((face: any) => face.surfaceType === "Cylinder");
          requireCondition(cylinders.length === 4, "Rounded opening must have four cylindrical corners");
          for (const face of cylinders) near(face.radiusMm, 1, 0.00001, "opening corner radius");
        }
      } else {
        const centers = options.case === "mirror-crossing-copy" ? [[0.5, 0, 1.5], [-0.5, 0, 1.5]] : options.case === "mirror-crossing-move" ? [[-0.5, 0, 1.5]] : options.case === "mirror-copy" ? [[11, 0, 1.5], [-11, 0, 1.5]] : options.case === "mirror-move" ? [[-11, 0, 1.5]] : options.case === "rectangular-pattern" ? [11, 19, 27].flatMap(x => [0, 10].map(y => [x, y, 1.5])) : options.case === "radial-pattern" ? [[11, 0, 1.5], [0, 11, 1.5], [-11, 0, 1.5], [0, -11, 1.5]] : [[11, 0, 1.5]];
        assertPointSetNear(properties.bodies.map((body: any) => body.volumeCentroidMm), centers, 0.00001, "body centroids");
        if (options.case === "rename") requireCondition(solids[0].id === id && solids[0].name === "Catalog renamed block", "Rename did not preserve identity/name");
      }
      evidence.geometry = { validation: validation.bodies, massProperties: properties.bodies };
    };
    await check();
    const resultIds = state.bodies.map((body: any) => body.id).sort((a: number, b: number) => a - b);
    for (let i = 0; i < steps; i += 1) await mutate("plasticity_undo", {});
    requireCondition(state.bodies.length === 1 && state.bodies[0].id === id && state.bodies[0].name === source.bodies[0].name, "Undo did not restore the source");
    vectorNear(state.bodies[0].boundsMm.min, source.bodies[0].boundsMm.min, 0.00001, "undone source minimum");
    vectorNear(state.bodies[0].boundsMm.max, source.bodies[0].boundsMm.max, 0.00001, "undone source maximum");
    for (let i = 0; i < steps; i += 1) await mutate("plasticity_redo", {});
    requireCondition(JSON.stringify(state.bodies.map((body: any) => body.id).sort((a: number, b: number) => a - b)) === JSON.stringify(resultIds), "Redo changed result identities");
    await check();
    for (let i = 0; i < steps + 1; i += 1) await mutate("plasticity_undo", {});
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
            status = await call(client, "plasticity_undo", { intent: "Recover disposable patterns-recipes acceptance", revision: status.revision });
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
  const client = new Client({ name: "plasticity-native-patterns-recipes-live", version: "1.0.0" });
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
export function assertPointSetNear(actual: number[][], expected: number[][], tolerance: number, label: string): void {
  requireCondition(Number.isFinite(tolerance) && tolerance >= 0, "Point-set tolerance must be finite and nonnegative");
  requireCondition(actual.length === expected.length, `${label}: point count mismatch`);
  const remaining = [...actual];
  for (const point of expected) {
    const index = remaining.findIndex(candidate => candidate.length === 3 && point.length === 3 && candidate.every((value, axis) => Number.isFinite(value) && Number.isFinite(point[axis]) && Math.abs(value - point[axis]!) <= tolerance));
    requireCondition(index >= 0, `${label}: missing expected point ${JSON.stringify(point)}`);
    remaining.splice(index, 1);
  }
}
function requireEmpty(state: any): void {
  requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0 && (state.referenceMeshes ?? []).length === 0, "Refusing patterns-recipes acceptance in a nonempty Plasticity document");
  requireCondition((state.measurements ?? []).length === 0 && (state.sectionAnalyses ?? []).length === 0, "Refusing patterns-recipes acceptance while document annotations or section analyses exist");
  requireCondition((state.groups ?? []).every((group: { id: number }) => group.id === 0), "Refusing patterns-recipes acceptance while non-root groups exist");
}
function summary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length }; }
function near(actual: number, expected: number, tolerance: number, label: string): void { requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`); }
function vectorNear(actual: unknown, expected: number[], tolerance: number, label: string): void { requireCondition(Array.isArray(actual) && actual.length === expected.length, `${label}: vector length mismatch`); actual.forEach((value, index) => near(value, expected[index]!, tolerance, `${label}[${index}]`)); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
