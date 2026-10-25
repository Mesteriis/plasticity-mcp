#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { hydrateNativeState } from "./native-live-state.ts";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const SHEET_FEATURE_CASES = ["patch-region", "thicken-sheet", "reverse-sheet", "revolve-profile", "remove-fillets", "refillet-faces", "screw-boss", "rib", "hinge-barrel"] as const;
type SheetFeatureCase = typeof SHEET_FEATURE_CASES[number];

interface Options { case: SheetFeatureCase; help: boolean; target?: string; output?: string; allowDisposableMutations: boolean }

export function parseNativeSheetsFeaturesAcceptanceArgs(argv: string[]): Options {
  const options: Options = { help: argv.length === 0, allowDisposableMutations: false, case: "patch-region" };
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
        if (!(SHEET_FEATURE_CASES as readonly string[]).includes(value)) throw new Error(`Unknown catalog case: ${value}`);
        options.case = value as SheetFeatureCase;
      }
    } else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Live native-sheets-features acceptance requires --target with an explicit Plasticity window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native-sheets-features acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native-sheets-features acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-sheets-features-live.ts --help
  node scripts/verify-native-sheets-features-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

Cases: ${SHEET_FEATURE_CASES.join(", ")} (select with --case).

No-argument and --help modes do not connect to Plasticity. Live mode requires
an explicit empty disposable document, verifies native sheets, blends and feature recipes and
mass properties through stdio MCP, checks Undo/Redo, restores the scene, and
writes sanitized evidence.`;

async function main(): Promise<void> {
  const options = parseNativeSheetsFeaturesAcceptanceArgs(process.argv.slice(2));
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
    const snapshot = await call(client, "plasticity_capture_snapshot", { label: "native-sheets-features-acceptance-initial-empty" });

    evidence.case = options.case;
    const mutate = async (name: string, args: Record<string, unknown>): Promise<any> => {
      const result = await call(client!, name, { ...args, revision: state?.revision ?? initial.revision });
      if (result.status === "completed" && result.afterRevision) {
        state = await call(client!, "plasticity_status", {});
        requireCondition(result.documentToken === state.documentToken && result.afterRevision === state.revision, "Recipe report is stale");
        evidence.recipe = result;
      } else state = result;
      return result;
    };
    const sheetCase = ["patch-region", "thicken-sheet", "reverse-sheet"].includes(options.case);
    if (sheetCase) {
      await mutate("plasticity_create_circle", { centerMm: [0, 0, 0], radiusMm: 5, normal: [0, 0, 1] });
      requireCondition(state.bodies.length === 1 && state.regions.length === 1, "Circle must produce one Wire and Region");
      if (options.case === "patch-region") {
        const beforeSelection = state.revision;
        await call(client, "plasticity_select_curves", { ids: [state.bodies[0].id], revision: state.revision });
        const selection = await call(client, "plasticity_current_selection", {});
        requireCondition(selection.curveIds?.length === 1 && selection.curveIds[0] === state.bodies[0].id, "Native curve selection did not match the requested Wire");
        state = await call(client, "plasticity_status", {});
        requireCondition(state.revision === beforeSelection, "Curve selection changed the scene revision");
        evidence.curveSelectionVerified = true;
      } else await mutate("plasticity_patch_regions", { regionIds: [state.regions[0].id] });
    } else if (options.case === "revolve-profile") {
      await mutate("plasticity_create_polyline", { pointsMm: [[2, 0, 0], [5, 0, 0], [5, 0, 10], [2, 0, 10]], closed: true });
    } else {
      await mutate("plasticity_create_box", { originMm: options.case === "hinge-barrel" ? [-10, -10, 0] : [0, 0, 0], sizeMm: options.case === "screw-boss" ? [20, 20, 4] : options.case === "rib" ? [20, 20, 2] : options.case === "hinge-barrel" ? [10, 20, 20] : [20, 20, 10] });
      if (options.case === "remove-fillets" || options.case === "refillet-faces") {
        const body = state.bodies[0];
        const edges = body.edges.filter((edge: any) => edge.line && Math.abs(edge.tangent[2]) > 0.999);
        requireCondition(edges.length === 4, "Box must have four vertical edges");
        await mutate("plasticity_fillet", { id: body.id, edgeIds: edges.map((edge: any) => edge.id), radiusMm: 2 });
      }
    }
    const source = state;
    const sourceSnapshot = await call(client, "plasticity_capture_snapshot", { label: "sheets-features-source" });
    const sourceSolids = source.bodies.filter((body: any) => body.type === "Solid");
    const sourceMass = sourceSolids.length ? await call(client, "plasticity_measure_solid_properties", { ids: sourceSolids.map((body: any) => body.id), revision: source.revision }) : undefined;
    const sheet = source.bodies.find((body: any) => body.type === "Sheet");
    const id = sourceSolids[0]?.id ?? sheet?.id ?? source.bodies[0]?.id;
    let steps = 1;
    switch (options.case) {
      case "patch-region": await mutate("plasticity_patch_regions", { regionIds: [source.regions[0].id] }); break;
      case "thicken-sheet": await mutate("plasticity_thicken_sheets", { ids: [id], frontMm: 2, backMm: 0 }); break;
      case "reverse-sheet": await mutate("plasticity_reverse_sheets", { ids: [id] }); break;
      case "revolve-profile": await mutate("plasticity_revolve_profile", { id, axisOriginMm: [0, 0, 0], axis: [0, 0, 1], angleDegrees: 360 }); break;
      case "remove-fillets": await mutate("plasticity_remove_fillets", { ids: [id] }); break;
      case "refillet-faces": {
        const faces = sourceSolids[0].faces.filter((face: any) => Math.abs(face.blendRadiusMm - 2) < 0.00001);
        requireCondition(faces.length === 4, "Expected four recognized R2 fillets");
        await mutate("plasticity_refillet_faces", { faces: faces.map((face: any) => ({ bodyId: id, faceId: face.id })), deltaMm: 1 }); break;
      }
      case "screw-boss": steps = 4; await mutate("plasticity_create_screw_boss", { targetId: id, baseCenterMm: [10, 10, 4], axis: [0, 0, 1], outerDiameterMm: 8, heightMm: 8, holeDiameterMm: 3, holeDepthMm: 6, baseOverlapMm: 0.5, cutterOvershootMm: 0.5 }); break;
      case "rib": steps = 3; await mutate("plasticity_create_rib", { targetId: id, profilePointsMm: [[5, 5, 1], [15, 5, 1], [5, 5, 11]], thicknessMm: 2 }); break;
      case "hinge-barrel": steps = 4; await mutate("plasticity_create_hinge_barrel", { targetId: id, axisStartMm: [3, 0, 5], axis: [0, 0, 1], lengthMm: 10, outerDiameterMm: 8, pinBoreDiameterMm: 2, cutterOvershootMm: 0.5 }); break;
    }
    requireCondition(state.undoDepth === source.undoDepth + steps, "Operation history count mismatch");
    if (evidence.recipe) {
      const report = evidence.recipe as any;
      requireCondition(report.undoSteps === steps && report.steps.length === steps && report.beforeRevision === source.revision, "Recipe history report mismatch");
    }
    const check = async (): Promise<void> => {
      evidence.observedBodies = state.bodies.map((body: any) => ({ id: body.id, type: body.type, boundsMm: body.boundsMm }));
      const wireCount = sheetCase || options.case === "revolve-profile" || options.case === "rib" ? 1 : 0;
      requireCondition(state.bodies.filter((body: any) => body.type === "Wire").length === wireCount && state.bodies.length === wireCount + 1, "Unexpected output or profile count");
      const body = state.bodies.find((body: any) => body.type !== "Wire");
      const validation = await call(client!, "plasticity_validate_bodies", { ids: [body.id], revision: state.revision });
      requireCondition(validation.bodies.length === 1 && validation.bodies[0].nativeValid, "Output failed native validation");
      if (options.case === "patch-region" || options.case === "reverse-sheet") {
        requireCondition(body.type === "Sheet" && body.faces.length === 1 && body.faces[0].planar, "Expected a one-face planar Sheet");
        vectorNear(body.boundsMm.min, [-5, -5, 0], 0.00001, "disk minimum");
        vectorNear(body.boundsMm.max, [5, 5, 0], 0.00001, "disk maximum");
        const properties = await call(client!, "plasticity_measure_face_properties", { faces: [{ bodyId: body.id, faceId: body.faces[0].id }], revision: state.revision });
        near(properties.faces[0].areaMm2, 25 * Math.PI, 0.0001, "disk area");
        near(properties.faces[0].boundaryLengthMm, 10 * Math.PI, 0.0001, "disk boundary length");
        if (options.case === "reverse-sheet") vectorNear(body.faces[0].normal, sheet.faces[0].normal.map((value: number) => -value), 0.00001, "reversed Sheet normal");
        evidence.geometry = { validation: validation.bodies[0], faceProperties: properties.faces[0], normal: body.faces[0].normal }; return;
      }
      requireCondition(body.type === "Solid" && validation.bodies[0].printableSolid, "Expected a closed printable Solid");
      const properties = await call(client!, "plasticity_measure_solid_properties", { ids: [body.id], revision: state.revision });
      const volumes = { "thicken-sheet": 50 * Math.PI, "revolve-profile": 210 * Math.PI, "remove-fillets": 4000, "refillet-faces": 3640 + 90 * Math.PI, "screw-boss": 1600 + 114.5 * Math.PI, rib: 881, "hinge-barrel": 4000 + 150 * Math.PI - 10 * (16 * Math.acos(0.75) - 3 * Math.sqrt(7)) };
      near(properties.bodies[0].volumeMm3, volumes[options.case], 0.0001, "output volume");
      const minimum = options.case === "thicken-sheet" ? [-5, -5, Math.min(0, 2 * sheet.faces[0].normal[2])] : options.case === "revolve-profile" ? [-5, -5, 0] : options.case === "hinge-barrel" ? [-10, -10, 0] : [0, 0, 0];
      const maximum = options.case === "thicken-sheet" ? [5, 5, Math.max(0, 2 * sheet.faces[0].normal[2])] : options.case === "revolve-profile" ? [5, 5, 10] : options.case === "screw-boss" ? [20, 20, 12] : options.case === "rib" ? [20, 20, 11] : options.case === "hinge-barrel" ? [7, 10, 20] : [20, 20, 10];
      vectorNear(body.boundsMm.min, minimum, 0.00001, "output minimum");
      vectorNear(body.boundsMm.max, maximum, 0.00001, "output maximum");
      if (options.case === "remove-fillets") requireCondition(body.faces.length === 6 && body.edges.length === 12 && body.faces.every((face: any) => face.planar), "Fillet removal did not restore the block topology");
      if (options.case === "refillet-faces") {
        const blends = body.faces.filter((face: any) => face.blendRadiusMm !== null);
        requireCondition(blends.length === 4, "Expected four recognized blends");
        blends.forEach((face: any) => near(face.blendRadiusMm, 3, 0.00001, "updated blend radius"));
      }
      if (options.case === "screw-boss" || options.case === "hinge-barrel") {
        const radii = options.case === "screw-boss" ? [1.5, 4] : [1, 4];
        const cylinders = body.faces.filter((face: any) => face.surfaceType === "Cylinder");
        vectorNear(cylinders.map((face: any) => face.radiusMm).sort((a: number, b: number) => a - b), radii, 0.00001, "feature radii");
        const bore = cylinders.find((face: any) => Math.abs(face.radiusMm - radii[0]!) < 0.00001);
        const area = await call(client!, "plasticity_measure_face_properties", { faces: [{ bodyId: body.id, faceId: bore.id }], revision: state.revision });
        near(area.faces[0].areaMm2, options.case === "screw-boss" ? 18 * Math.PI : 20 * Math.PI, 0.0001, "complete bore surface area");
        if (options.case === "screw-boss") requireCondition(body.faces.some((face: any) => face.planar && Math.abs(face.centerMm[2] - 6) < 0.00001), "Pilot hole floor depth mismatch");
        evidence.bore = area.faces[0];
      }
      evidence.geometry = { validation: validation.bodies[0], massProperties: properties.bodies[0] };
    };
    await check();
    const resultIds = state.bodies.map((body: any) => body.id).sort((a: number, b: number) => a - b);
    for (let i = 0; i < steps; i += 1) await mutate("plasticity_undo", {});
    const sourceChanges = await call(client, "plasticity_changes_since", { snapshotId: sourceSnapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(sourceChanges.diff), "Undo did not restore source geometry");
    if (sourceMass) {
      const undone = await call(client, "plasticity_measure_solid_properties", { ids: sourceSolids.map((body: any) => body.id), revision: state.revision });
      undone.bodies.forEach((body: any) => near(body.volumeMm3, sourceMass.bodies.find((source: any) => source.id === body.id).volumeMm3, 0.0001, "undone source volume"));
    }
    for (let i = 0; i < steps; i += 1) await mutate("plasticity_redo", {});
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
            status = await call(client, "plasticity_undo", { intent: "Recover disposable sheets-features acceptance", revision: status.revision });
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
  const client = new Client({ name: "plasticity-native-sheets-features-live", version: "1.0.0" });
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
  requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0 && (state.referenceMeshes ?? []).length === 0, "Refusing sheets-features acceptance in a nonempty Plasticity document");
  requireCondition((state.measurements ?? []).length === 0 && (state.sectionAnalyses ?? []).length === 0, "Refusing sheets-features acceptance while document annotations or section analyses exist");
  requireCondition((state.groups ?? []).every((group: { id: number }) => group.id === 0), "Refusing sheets-features acceptance while non-root groups exist");
}
function summary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length }; }
function near(actual: number, expected: number, tolerance: number, label: string): void { requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`); }
function vectorNear(actual: unknown, expected: number[], tolerance: number, label: string): void { requireCondition(Array.isArray(actual) && actual.length === expected.length, `${label}: vector length mismatch`); actual.forEach((value, index) => near(value, expected[index]!, tolerance, `${label}[${index}]`)); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
