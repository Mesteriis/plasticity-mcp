#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isolatedAcceptanceEnvironment } from "./verify-native-measure-datum-files-live.ts";

import { hydrateNativeState } from "./native-live-state.ts";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const LIFECYCLE_CASES = ["appearance", "section-oblique", "delete-distance", "delete-radius", "split-parallel", "split-grid", "surface-bridge"] as const;
type LifecycleCase = typeof LIFECYCLE_CASES[number];

interface Options { case: LifecycleCase; help: boolean; target?: string; output?: string; allowDisposableMutations: boolean }

export function parseNativeLifecycleAcceptanceArgs(argv: string[]): Options {
  const options: Options = { help: argv.length === 0, allowDisposableMutations: false, case: "appearance" };
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
        if (!(LIFECYCLE_CASES as readonly string[]).includes(value)) throw new Error(`Unknown catalog case: ${value}`);
        options.case = value as LifecycleCase;
      }
    } else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Live native-lifecycle acceptance requires --target with an explicit Plasticity window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native-lifecycle acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native-lifecycle acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-lifecycle-live.ts --help
  node scripts/verify-native-lifecycle-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

Cases: ${LIFECYCLE_CASES.join(", ")} (select with --case).

No-argument and --help modes do not connect to Plasticity. Live mode requires
an explicit empty disposable document, verifies native appearance, annotations, sections, splits and Surface Bridge and
mass properties through stdio MCP, checks Undo/Redo, restores the scene, and
writes sanitized evidence.`;

async function main(): Promise<void> {
  const options = parseNativeLifecycleAcceptanceArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  await mkdir(output, { recursive: false, mode: 0o700 });
  const evidence: Record<string, unknown> = { schemaVersion: 1, startedAt: new Date().toISOString(), targetId: options.target, workbenchUsed: false };
  let client: Client | undefined;
  let initial: any;
  let state: any;
  let ownedSectionId: number | undefined;
  try {
    client = await startMcp(join(output, "strength-store"));
    const windows = await call(client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    initial = await call(client, "plasticity_connect", { targetId: options.target });
    requireEmpty(initial);
    evidence.initial = summary(initial);
    const snapshot = await call(client, "plasticity_capture_snapshot", { label: "native-lifecycle-acceptance-initial-empty" });

    evidence.case = options.case;
    state = initial;
    const mutate = async (name: string, args: Record<string, unknown>): Promise<any> => {
      const result = await call(client!, name, { ...args, revision: state.revision });
      if (result.status === "completed" && result.afterRevision) {
        state = await call(client!, "plasticity_status", {});
        requireCondition(result.documentToken === state.documentToken && result.afterRevision === state.revision, "Recipe report/current native state mismatch");
      } else state = result;
      return result;
    };
    const expectRejection = async (name: string, args: Record<string, unknown>, pattern: RegExp): Promise<void> => {
      const before = state; let message = "";
      try { await call(client!, name, args); } catch (error) { message = error instanceof Error ? error.message : String(error); }
      requireCondition(pattern.test(message), `Expected safe rejection from ${name}: ${message}`);
      state = await call(client!, "plasticity_status", {});
      requireCondition(state.revision === before.revision && state.undoDepth === before.undoDepth && state.redoDepth === before.redoDepth, "Rejected input changed native state/history");
    };
    let controlId: number | undefined;
    if (options.case === "surface-bridge") {
      await mutate("plasticity_create_box", { originMm: [0, 0, -1], sizeMm: [10, 10, 1] });
      const firstBox = state.bodies[0];
      await mutate("plasticity_extract_faces", { faces: [{ bodyId: firstBox.id, faceId: firstBox.faces.find((face: any) => face.normal[2] > 0.99).id }] });
      await mutate("plasticity_create_box", { originMm: [20, 0, 5], sizeMm: [1, 10, 10] });
      const secondBox = state.bodies.find((body: any) => body.type === "Solid" && body.id !== firstBox.id);
      await mutate("plasticity_extract_faces", { faces: [{ bodyId: secondBox.id, faceId: secondBox.faces.find((face: any) => face.normal[0] < -0.99).id }] });
      await mutate("plasticity_delete", { ids: [firstBox.id, secondBox.id] });
    } else if (options.case === "delete-radius") {
      await mutate("plasticity_create_cylinder", { centerMm: [0, 0, 0], radiusMm: 3, heightMm: 10, axis: [0, 0, 1] });
    } else {
      await mutate("plasticity_create_box", { originMm: [0, 0, 0], sizeMm: [10, 20, 30] });
      if (options.case.startsWith("split-") || options.case === "appearance") {
        const id = state.bodies[0].id;
        await mutate("plasticity_create_box", { originMm: [40, 0, 0], sizeMm: [2, 3, 4] });
        controlId = state.bodies.find((body: any) => body.id !== id).id;
      }
    }
    const source = state;
    const sourceSnapshot = await call(client, "plasticity_capture_snapshot", { label: "native-lifecycle-source" });
    const primary = source.bodies.find((body: any) => body.id !== controlId);
    let steps = 0;
    let materialId: number | undefined;
    let savedMeasurement: any;
    let report: any;
    const verifyRestoredMeasurement = (): void => {
      requireCondition(state.measurements.length === 1, "Undo/Redo did not restore one annotation");
      const measurement = state.measurements[0];
      requireCondition(measurement.id === savedMeasurement.id && measurement.name === savedMeasurement.name && measurement.type === savedMeasurement.type && measurement.first?.bodyId === primary.id, "Restored annotation identity/type/owner changed");
      if (options.case === "delete-radius") {
        near(measurement.radiusMm, 3, 0.000001, "restored radius"); near(measurement.diameterMm, 6, 0.000002, "restored diameter");
        requireCondition(measurement.first.topologyRefId === savedMeasurement.first.topologyRefId, "Radius annotation lost its edge reference");
      } else {
        near(measurement.distanceMm, Math.sqrt(1400), 0.000001, "restored vertex distance");
        requireCondition(measurement.first.topologyRefId === savedMeasurement.first.topologyRefId && measurement.second?.topologyRefId === savedMeasurement.second?.topologyRefId, "Distance annotation lost vertex references");
      }
    };
    if (options.case === "appearance") {
      steps = 3;
      await expectRejection("plasticity_set_appearance_material", { ids: [primary.id], materialId: 2147483647, revision: state.revision }, /Unknown current appearance material/i);
      await mutate("plasticity_set_appearance_material", { ids: [primary.id], name: "Synthetic lifecycle appearance", colorHex: "#336699", roughness: 0.25, metalness: 0.4, opacity: 0.8 });
      const listed = await call(client, "plasticity_list_appearance_materials", {});
      materialId = listed.assignments.find((item: any) => item.bodyId === primary.id)?.materialId;
      requireCondition(materialId && listed.materials.length === (source.materials ?? []).length + 1, "New appearance was not created/assigned uniquely");
      await mutate("plasticity_set_appearance_material", { ids: [controlId], materialId });
      await mutate("plasticity_set_appearance_material", { ids: [primary.id], materialId: 0 });
    } else if (options.case === "section-oblique") {
      await mutate("plasticity_create_section_analysis", { originMm: [5, 10, 15], normal: [1, 0, 1], xDirection: [0, 1, 0], name: "Synthetic oblique section" });
      ownedSectionId = state.sectionAnalyses[0]?.id;
      requireCondition(ownedSectionId, "Native section ID missing");
      await expectRejection("plasticity_create_section_analysis", { originMm: [0, 0, 0], normal: [0, 0, 1], revision: state.revision }, /already has an active section/i);
      const listed = await call(client, "plasticity_list_section_analyses", {});
      requireCondition(listed.sectionAnalyses.length === 1 && listed.sectionAnalyses[0].id === ownedSectionId, "Section read-back identity mismatch");
      const section = listed.sectionAnalyses[0];
      vectorNear(section.originMm, [5, 10, 15], 0.000001, "section origin"); vectorNear(section.normal, [Math.SQRT1_2, 0, Math.SQRT1_2], 0.000001, "clipped half-space normal");
      requireCondition(section.visible && section.registeredViewportCount > 0 && state.undoDepth === source.undoDepth && state.revision !== source.revision, "Section viewport/history contract failed");
      const changes = await call(client, "plasticity_changes_since", { snapshotId: sourceSnapshot.snapshotId });
      requireCondition(changes.diff.sectionAnalysesChanged && changes.diff.added.length === 0 && changes.diff.modified.length === 0, "Section incorrectly changed B-Rep geometry");
      evidence.section = { section, renderedPixelsVerified: false };
      await mutate("plasticity_delete_section_analysis", { id: ownedSectionId }); ownedSectionId = undefined;
      requireCondition(state.sectionAnalyses.length === 0 && state.revision === source.revision && state.undoDepth === source.undoDepth, "Section deletion did not restore native source state");
      await expectRejection("plasticity_delete_section_analysis", { id: section.id, revision: state.revision }, /Unknown current section analysis/i);
    } else if (options.case.startsWith("delete-")) {
      steps = 2;
      if (options.case === "delete-radius") {
        await mutate("plasticity_create_radius_measurement", { edge: { bodyId: primary.id, edgeId: primary.edges.find((edge: any) => edge.circle).id }, name: "Lifecycle radius" });
      } else {
        const at = (point: number[]) => primary.vertices.find((vertex: any) => vertex.positionMm.every((value: number, axis: number) => Math.abs(value - point[axis]!) < 0.00001));
        await mutate("plasticity_create_vertex_distance_measurement", { first: { bodyId: primary.id, vertexId: at([0, 0, 0]).id }, second: { bodyId: primary.id, vertexId: at([10, 20, 30]).id }, name: "Lifecycle distance" });
      }
      savedMeasurement = state.measurements[0]; verifyRestoredMeasurement();
      await mutate("plasticity_delete_measurement", { id: savedMeasurement.id });
      await expectRejection("plasticity_delete_measurement", { id: savedMeasurement.id, revision: state.revision }, /Unknown current measurement ID/i);
    } else if (options.case.startsWith("split-")) {
      steps = options.case === "split-parallel" ? 8 : 12;
      const planes = options.case === "split-parallel" ? [3, 7].map(x => ({ originMm: [x, 0, 0], normal: [1, 0, 0], xDirection: [0, 1, 0] })) : [{ originMm: [5, 0, 0], normal: [1, 0, 0], xDirection: [0, 1, 0] }, { originMm: [0, 10, 0], normal: [0, 1, 0], xDirection: [1, 0, 0] }];
      report = await mutate("plasticity_split_solid_by_planes", { targetId: primary.id, planes });
      requireCondition(report.status === "completed" && report.undoSteps === steps && report.cutCount === steps / 4 && report.resultBodyIds.length === steps / 4 + 1, "Multi-plane recipe history/count contract failed");
      near(report.inputVolumeMm3, 6000, 0.0001, "split input volume"); near(report.resultVolumeMm3, 6000, 0.0001, "split conserved volume"); evidence.recipe = report;
    } else {
      steps = 1;
      const first = source.bodies.find((body: any) => body.faces.some((face: any) => face.normal[2] > 0.99));
      const second = source.bodies.find((body: any) => body.id !== first.id);
      await mutate("plasticity_bridge_surface", { first: { bodyId: first.id, faceId: first.faces[0].id, pickPointMm: [10, 5, 0] }, second: { bodyId: second.id, faceId: second.faces[0].id, pickPointMm: [20, 5, 5] }, widthMm: 20, softness: 1 });
    }
    requireCondition(state.undoDepth === source.undoDepth + steps, "Native lifecycle history step mismatch");
    const check = async (): Promise<void> => {
      if (options.case === "surface-bridge") {
        requireCondition(state.bodies.length === 1 && state.bodies[0].type === "Sheet" && state.bodies[0].faces.length === 3 && state.bodies[0].edges.length === 10, "Surface Bridge did not produce one three-face/ten-edge Sheet");
        const body = state.bodies[0];
        requireCondition(body.faces.filter((face: any) => face.planar).length === 2 && body.faces.some((face: any) => face.surfaceType === "BSurf" && !face.planar), "Native transition surface missing");
        // BridgeSurface trims the source walls, so their centroids may move.
        for (const [axis, position] of [[2, 0], [0, 20]]) requireCondition(body.faces.some((face: any) => face.planar && Math.abs(face.centerMm[axis!] - position!) < 0.00001 && Math.abs(face.normal[axis!]) > 0.999999), "Trimmed source support plane missing from bridge");
        evidence.bridgeFaces = body.faces;
        const validation = await call(client!, "plasticity_validate_bodies", { ids: [body.id], revision: state.revision });
        requireCondition(validation.bodies.length === 1 && validation.bodies[0].id === body.id && validation.bodies[0].nativeValid && !validation.bodies[0].printableSolid, "Bridge Sheet failed native validation");
        evidence.geometry = { validation }; return;
      }
      const solids = state.bodies;
      requireCondition(solids.every((body: any) => body.type === "Solid"), "Unexpected non-Solid or leftover temporary geometry");
      const ids = solids.map((body: any) => body.id);
      const validation = await call(client!, "plasticity_validate_bodies", { ids, revision: state.revision });
      requireCondition(validation.bodies.length === ids.length && ids.every((id: number) => validation.bodies.some((body: any) => body.id === id && body.nativeValid && body.printableSolid)), "Incomplete or invalid native Solid results");
      const mass = await call(client!, "plasticity_measure_solid_properties", { ids, revision: state.revision });
      requireCondition(mass.bodies.length === ids.length && ids.every((id: number) => mass.bodies.some((body: any) => body.id === id)), "Incomplete native mass identities");
      if (options.case.startsWith("split-")) {
        requireCondition(JSON.stringify(state.bodies.find((body: any) => body.id === controlId)) === JSON.stringify(source.bodies.find((body: any) => body.id === controlId)), "Unrelated control body changed during split");
        const parts = solids.filter((body: any) => body.id !== controlId).sort((a: any, b: any) => a.boundsMm.min[0] - b.boundsMm.min[0] || a.boundsMm.min[1] - b.boundsMm.min[1]);
        requireCondition(parts.length === (options.case === "split-parallel" ? 3 : 4) && report.resultBodyIds.every((id: number) => parts.some((body: any) => body.id === id)), "Split output IDs/count mismatch");
        parts.forEach((body: any, index: number) => {
          const minimum = options.case === "split-parallel" ? [[0, 0, 0], [3, 0, 0], [7, 0, 0]][index]! : [Math.floor(index / 2) * 5, index % 2 * 10, 0];
          const maximum = options.case === "split-parallel" ? [[3, 20, 30], [7, 20, 30], [10, 20, 30]][index]! : [minimum[0]! + 5, minimum[1]! + 10, 30];
          vectorNear(body.boundsMm.min, minimum, 0.00001, "split minimum"); vectorNear(body.boundsMm.max, maximum, 0.00001, "split maximum");
          near(mass.bodies.find((item: any) => item.id === body.id).volumeMm3, options.case === "split-parallel" ? [1800, 2400, 1800][index]! : 1500, 0.0001, "split part volume");
        });
      } else {
        requireCondition(solids.length === source.bodies.length, "Lifecycle changed body count");
        for (const body of solids) {
          const before = source.bodies.find((item: any) => item.id === body.id); requireCondition(before, "Lifecycle changed source identity");
          vectorNear(body.boundsMm.min, before.boundsMm.min, 0.00001, "preserved minimum"); vectorNear(body.boundsMm.max, before.boundsMm.max, 0.00001, "preserved maximum");
          near(mass.bodies.find((item: any) => item.id === body.id).volumeMm3, body.id === controlId ? 24 : options.case === "delete-radius" ? 90 * Math.PI : 6000, 0.0001, "preserved volume");
        }
      }
      if (options.case === "appearance") {
        const listed = await call(client!, "plasticity_list_appearance_materials", {});
        const material = listed.materials.find((item: any) => item.id === materialId);
        requireCondition(material?.name === "Synthetic lifecycle appearance" && material.colorHex.toLowerCase() === "#336699", "Appearance color/name read-back mismatch");
        near(material.roughness, 0.25, 1e-9, "roughness"); near(material.metalness, 0.4, 1e-9, "metalness"); near(material.opacity, 0.8, 1e-9, "opacity");
        requireCondition(listed.assignments.find((item: any) => item.bodyId === primary.id)?.materialId === 0 && listed.assignments.find((item: any) => item.bodyId === controlId)?.materialId === materialId, "Appearance assign/reuse/clear failed"); evidence.appearance = { material, renderedPixelsVerified: false };
      }
      requireCondition(state.measurements.length === 0 && state.sectionAnalyses.length === 0, "Lifecycle left document annotations or sections");
      evidence.geometry = { validation, massProperties: mass.bodies };
    };
    await check();
    const resultIds = state.bodies.map((body: any) => body.id).sort((a: number, b: number) => a - b);
    for (let index = 0; index < steps; index += 1) { await mutate("plasticity_undo", {}); if (index === 0 && savedMeasurement) verifyRestoredMeasurement(); }
    const undone = await call(client, "plasticity_changes_since", { snapshotId: sourceSnapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(undone.diff), "Undo did not restore lifecycle source snapshot");
    for (let index = 0; index < steps; index += 1) { await mutate("plasticity_redo", {}); if (index === 0 && savedMeasurement) verifyRestoredMeasurement(); }
    requireCondition(JSON.stringify(state.bodies.map((body: any) => body.id).sort((a: number, b: number) => a - b)) === JSON.stringify(resultIds), "Redo changed output IDs");
    await check();
    for (let index = 0; index < steps + source.undoDepth - initial.undoDepth; index += 1) await mutate("plasticity_undo", {});
    requireEmpty(state);
    const changes = await call(client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(changes.diff), "Initial empty lifecycle snapshot not restored");
    evidence.history = { nativeOperationSteps: steps, undoRedoVerified: steps > 0, viewportOnly: options.case === "section-oblique" };
    evidence.cleanup = { restoredEmptyDocument: true, sceneContentsRestored: true };
    evidence.completedAt = new Date().toISOString();
    await writeExclusive(join(output, "evidence.json"), sanitizeEvidence(evidence));
    console.log(JSON.stringify({ ok: true, output }));
  } catch (error) {
    evidence.error = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
    if (!/timed out|timeout|uncertain|partial geometry|completed cuts/i.test(String(evidence.error)) && client && initial && state && state.documentToken === initial.documentToken) {
      try {
        const current = await call(client, "plasticity_status", {});
        if (ownedSectionId !== undefined && current.documentToken === initial.documentToken && current.revision === state.revision && current.sectionAnalyses.some((section: any) => section.id === ownedSectionId)) {
          state = await call(client, "plasticity_delete_section_analysis", { id: ownedSectionId, revision: current.revision });
        }
        const reconciled = await call(client, "plasticity_status", {});
        if (reconciled.documentToken === initial.documentToken && reconciled.revision === state.revision && reconciled.undoDepth > initial.undoDepth) {
          let status = reconciled;
          for (let attempt = 0; attempt < 24 && status.undoDepth > initial.undoDepth; attempt += 1) {
            status = await call(client, "plasticity_undo", { intent: "Recover disposable lifecycle acceptance", revision: status.revision });
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
  const client = new Client({ name: "plasticity-native-lifecycle-live", version: "1.0.0" });
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
  requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0 && (state.referenceMeshes ?? []).length === 0, "Refusing lifecycle acceptance in a nonempty Plasticity document");
  requireCondition((state.measurements ?? []).length === 0 && (state.sectionAnalyses ?? []).length === 0, "Refusing lifecycle acceptance while document annotations or section analyses exist");
  requireCondition((state.groups ?? []).every((group: { id: number }) => group.id === 0), "Refusing lifecycle acceptance while non-root groups exist");
}
function summary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length }; }
function near(actual: number, expected: number, tolerance: number, label: string): void { requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`); }
function vectorNear(actual: unknown, expected: number[], tolerance: number, label: string): void { requireCondition(Array.isArray(actual) && actual.length === expected.length, `${label}: vector length mismatch`); actual.forEach((value, index) => near(value, expected[index]!, tolerance, `${label}[${index}]`)); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
