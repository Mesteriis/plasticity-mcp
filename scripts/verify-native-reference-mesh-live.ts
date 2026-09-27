#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const toleranceMm = 1e-6;

interface Options { help: boolean; target?: string; allowDisposableMutations: boolean; output?: string }
interface LiveMcp { client: Client; stderr: string[] }

export function parseNativeReferenceMeshAcceptanceArgs(argv: string[]): Options {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: Options = { help: false, allowDisposableMutations: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--allow-disposable-mutations") options.allowDisposableMutations = true;
    else if (argument === "--target") options.target = requireValue(argv, ++index, "--target");
    else if (argument === "--output") options.output = requireValue(argv, ++index, "--output");
    else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Live reference-mesh acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Live reference-mesh acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live reference-mesh acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-reference-mesh-live.ts --help
  node scripts/verify-native-reference-mesh-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

Live mode refuses a nonempty Plasticity document, imports disposable STL and OBJ
references through the public MCP, verifies approximate mesh bounds, selection,
rename, native grouping, visibility, locking, Move/Rotate/Scale/Delete,
Undo/Redo, and restores the empty document.`;

async function main(): Promise<void> {
  const options = parseNativeReferenceMeshAcceptanceArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const stlPath = join(output, "reference-box-20x10x5.stl");
  const objPath = join(output, "reference-triangle-20x10.obj");
  await writeFile(stlPath, asciiBoxStl(), { flag: "wx", mode: 0o600 });
  await writeFile(objPath, "o reference_triangle\nv 0 0 0\nv 20 0 0\nv 0 10 0\nf 1 2 3\n", { flag: "wx", mode: 0o600 });
  const evidence: Record<string, unknown> = { schemaVersion: 1, startedAt: new Date().toISOString(), targetId: options.target!, workbenchUsed: false };
  let live: LiveMcp | undefined;
  let initial: any;
  try {
    live = await startMcp(join(output, "strength-store"));
    const tools = await live.client.listTools();
    for (const name of ["plasticity_import_reference_mesh", "plasticity_list_reference_meshes", "plasticity_select_reference_meshes", "plasticity_rename_reference_mesh", "plasticity_create_group", "plasticity_move_to_group", "plasticity_list_groups", "plasticity_set_visibility", "plasticity_set_locked", "plasticity_dissolve_groups", "plasticity_move_reference_meshes", "plasticity_rotate_reference_meshes", "plasticity_scale_reference_meshes", "plasticity_delete_reference_meshes"]) {
      requireCondition(tools.tools.some((tool) => tool.name === name), `MCP did not expose ${name}`);
    }
    const windows = await call(live.client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    initial = await call(live.client, "plasticity_connect", { targetId: options.target });
    requireEmpty(initial, "initial scene");
    evidence.initial = summary(initial);
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-reference-mesh-live-initial-empty" });

    let state = await call(live.client, "plasticity_import_reference_mesh", {
      path: stlPath, sourceUnit: "millimeter", intent: "Import disposable STL reference in explicit millimeters", revision: initial.revision,
    });
    const mesh = onlyMesh(state, "STL import");
    requireCondition(state.bodies.length === 0, "STL reference was incorrectly reported as native B-Rep");
    requireCondition(mesh.sourceFormat === "stl" && mesh.measurementSource === "reference-mesh", "STL reference provenance is incorrect");
    requireCondition(mesh.vertexEntries === 36 && mesh.triangles === 12, "STL buffer counts are incorrect");
    boundsNear(mesh.boundsMm, [0, 0, 0], [20, 10, 5], "STL import bounds");
    const selected = await call(live.client, "plasticity_select_reference_meshes", { ids: [mesh.id], revision: state.revision });
    requireCondition(selected.referenceMeshIds.length === 1 && selected.referenceMeshIds[0] === mesh.id, "Reference mesh selection did not round-trip");

    state = await call(live.client, "plasticity_rename_reference_mesh", { id: mesh.id, name: "Device reference", intent: "Give the disposable reference a descriptive scene name", revision: state.revision });
    requireCondition(onlyMesh(state, "renamed STL").name === "Device reference", "Reference mesh rename did not round-trip");
    state = await call(live.client, "plasticity_create_group", { referenceMeshIds: [mesh.id], name: "Reference geometry", intent: "Place the disposable mesh in a native reference group", revision: state.revision });
    const referenceGroup = onlyNonRootGroup(state, "reference group creation");
    requireCondition(referenceGroup.name === "Reference geometry", "Reference group name did not round-trip");
    requireCondition(referenceGroup.referenceMeshIds.length === 1 && referenceGroup.referenceMeshIds[0] === mesh.id, "Reference group did not expose its stable reference-mesh member");
    state = await call(live.client, "plasticity_set_locked", { referenceMeshIds: [mesh.id], locked: true, intent: "Protect the registered reference from manual edits", revision: state.revision });
    requireCondition(onlyMesh(state, "locked STL").locked === true, "Reference mesh lock state did not round-trip");
    state = await call(live.client, "plasticity_set_locked", { referenceMeshIds: [mesh.id], locked: false, intent: "Unlock the disposable reference for acceptance transforms", revision: state.revision });
    requireCondition(onlyMesh(state, "unlocked STL").locked === false, "Reference mesh unlock state did not round-trip");
    state = await call(live.client, "plasticity_set_visibility", { referenceMeshIds: [mesh.id], visible: false, intent: "Hide the reference without deleting it", revision: state.revision });
    requireCondition(onlyMesh(state, "hidden STL").visible === false, "Reference mesh hidden state did not round-trip");
    state = await call(live.client, "plasticity_set_visibility", { referenceMeshIds: [mesh.id], visible: true, intent: "Restore the reference for acceptance transforms", revision: state.revision });
    requireCondition(onlyMesh(state, "visible STL").visible === true, "Reference mesh visible state did not round-trip");
    state = await call(live.client, "plasticity_dissolve_groups", { ids: [referenceGroup.id], intent: "Dissolve the disposable reference group before deletion", revision: state.revision });
    requireCondition(nonRootGroups(state).length === 0, "Disposable reference group was not dissolved");

    state = await call(live.client, "plasticity_move_reference_meshes", { ids: [mesh.id], deltaMm: [10, 20, 30], intent: "Verify native reference move", revision: state.revision });
    boundsNear(onlyMesh(state, "moved STL").boundsMm, [10, 20, 30], [30, 30, 35], "moved STL bounds");
    state = await call(live.client, "plasticity_rotate_reference_meshes", { ids: [mesh.id], pivotMm: [10, 20, 30], axis: [0, 0, 1], degrees: 90, intent: "Verify native reference rotation", revision: state.revision });
    boundsNear(onlyMesh(state, "rotated STL").boundsMm, [0, 20, 30], [10, 40, 35], "rotated STL bounds");
    state = await call(live.client, "plasticity_scale_reference_meshes", { ids: [mesh.id], pivotMm: [10, 20, 30], factors: [2, 0.5, 1], intent: "Verify native reference scale", revision: state.revision });
    const scaled = onlyMesh(state, "scaled STL");
    boundsNear(scaled.boundsMm, [-10, 20, 30], [10, 30, 35], "scaled STL bounds");
    const scaledState = summary(state);

    state = await call(live.client, "plasticity_delete_reference_meshes", { ids: [mesh.id], intent: "Verify native reference deletion", revision: state.revision });
    requireEmpty(state, "deleted STL state");
    state = await call(live.client, "plasticity_undo", { intent: "Verify reference delete Undo", revision: state.revision });
    boundsNear(onlyMesh(state, "delete Undo").boundsMm, [-10, 20, 30], [10, 30, 35], "delete Undo bounds");
    state = await call(live.client, "plasticity_redo", { intent: "Verify reference delete Redo", revision: state.revision });
    requireEmpty(state, "delete Redo state");
    state = await call(live.client, "plasticity_undo", { intent: "Restore reference before full cleanup", revision: state.revision });
    state = await undoToDepth(live.client, state, initial.undoDepth, "Clean up disposable STL reference");
    requireEmpty(state, "post-STL cleanup");
    evidence.stl = { id: mesh.id, importedBoundsMm: mesh.boundsMm, vertexEntries: mesh.vertexEntries, triangles: mesh.triangles, selected: true, renamed: true, grouped: true, visibilityControlled: true, lockingControlled: true, scaled: scaledState, undoRedoDelete: true };

    state = await call(live.client, "plasticity_import_reference_mesh", {
      path: objPath, sourceUnit: "inch", intent: "Import disposable OBJ reference in explicit inches", revision: state.revision,
    });
    const obj = onlyMesh(state, "OBJ import");
    requireCondition(obj.sourceFormat === "obj" && obj.vertexEntries === 3 && obj.triangles === 1, "OBJ reference metadata is incorrect");
    boundsNear(obj.boundsMm, [0, 0, 0], [508, 254, 0], "OBJ import bounds");
    state = await call(live.client, "plasticity_create_group", { referenceMeshIds: [obj.id], name: "OBJ reference", intent: "Create a native destination group for move acceptance", revision: state.revision });
    const objGroup = onlyNonRootGroup(state, "OBJ reference group creation");
    state = await call(live.client, "plasticity_import_reference_mesh", {
      path: stlPath, sourceUnit: "millimeter", intent: "Import a second disposable reference for native group movement", revision: state.revision,
    });
    const second = (state.referenceMeshes ?? []).find((candidate: { id: number }) => candidate.id !== obj.id);
    requireCondition(second, "Second reference mesh was not imported for move acceptance");
    state = await call(live.client, "plasticity_move_to_group", { referenceMeshIds: [second.id], destinationGroupId: objGroup.id, intent: "Move a reference mesh into an existing native group", revision: state.revision });
    const movedGroup = onlyNonRootGroup(state, "reference move-to-group");
    requireCondition(movedGroup.referenceMeshIds.length === 2 && movedGroup.referenceMeshIds.includes(obj.id) && movedGroup.referenceMeshIds.includes(second.id), "Native group did not expose both reference-mesh members after movement");
    evidence.obj = { id: obj.id, sourceUnit: "inch", boundsMm: obj.boundsMm, vertexEntries: obj.vertexEntries, triangles: obj.triangles, movedSecondReferenceIntoGroup: true };
    state = await undoToDepth(live.client, state, initial.undoDepth, "Clean up disposable OBJ grouping acceptance");
    requireEmpty(state, "final cleanup");

    const changes = await call(live.client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(changes.diff.referenceMeshesChanged === false, "Reference meshes differ from the initial snapshot after cleanup");
    requireCondition(changes.diff.added.length === 0 && changes.diff.removed.length === 0 && changes.diff.modified.length === 0, "Native B-Rep differs from the initial snapshot");
    const journal = await call(live.client, "plasticity_construction_journal", {});
    requireCondition(journal.syncStatus === "in-sync", "Construction journal is not synchronized after reference-mesh cleanup");
    evidence.cleanup = { restoredEmptyDocument: true, referenceMeshesRestored: true, journal: journal.syncStatus };
    evidence.completedAt = new Date().toISOString();
    await writeExclusive(join(output, "evidence.json"), sanitizeEvidence(evidence));
    console.log(JSON.stringify({ ok: true, output, evidence: join(output, "evidence.json") }, null, 2));
  } catch (error) {
    evidence.failure = boundedError(error);
    if (live && initial) evidence.cleanup = await recover(live.client, initial).catch((cleanupError) => ({ restoredEmptyDocument: false, reason: boundedError(cleanupError) }));
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
  const client = new Client({ name: "plasticity-native-reference-mesh-live", version: "1.0.0" });
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

function requireEmpty(state: any, label: string): void {
  requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0 && (state.referenceMeshes ?? []).length === 0, `${label} is not empty`);
  requireCondition((state.groups ?? []).filter((group: { id: number }) => group.id !== 0).length === 0, `${label} contains non-root groups`);
}
function onlyMesh(state: any, label: string): any { requireCondition((state.referenceMeshes ?? []).length === 1, `${label} did not contain exactly one reference mesh`); return state.referenceMeshes[0]; }
function nonRootGroups(state: any): any[] { return (state.groups ?? []).filter((group: { id: number }) => group.id !== 0); }
function onlyNonRootGroup(state: any, label: string): any { const groups = nonRootGroups(state); requireCondition(groups.length === 1, `${label} did not contain exactly one non-root group`); return groups[0]; }
function boundsNear(bounds: any, min: number[], max: number[], label: string): void { vectorNear(bounds?.min, min, label + " min"); vectorNear(bounds?.max, max, label + " max"); }
function vectorNear(actual: unknown, expected: number[], label: string): void { requireCondition(Array.isArray(actual) && actual.length === expected.length, `${label} vector length mismatch`); actual.forEach((value, index) => requireCondition(Number.isFinite(value) && Math.abs(value - expected[index]!) <= toleranceMm, `${label}[${index}] expected ${expected[index]}, got ${value}`)); }
function summary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, referenceMeshCount: (state.referenceMeshes ?? []).length }; }
async function recover(client: Client, initial: any): Promise<Record<string, unknown>> { for (let count = 0; count < 16; count += 1) { const status = await call(client, "plasticity_status", {}); if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" }; if (status.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: status.bodies.length === 0 && (status.referenceMeshes ?? []).length === 0 }; await call(client, "plasticity_undo", { intent: "Recover disposable reference-mesh acceptance", revision: status.revision }); } return { restoredEmptyDocument: false, reason: "undo-limit" }; }
async function undoToDepth(client: Client, state: any, depth: number, intent: string): Promise<any> { for (let count = 0; state.undoDepth > depth && count < 32; count += 1) state = await call(client, "plasticity_undo", { intent, revision: state.revision }); requireCondition(state.undoDepth === depth, `Undo cleanup did not reach depth ${depth}`); return state; }
function asciiBoxStl(): string { const vertices = [[0,0,0],[20,0,0],[20,10,0],[0,10,0],[0,0,5],[20,0,5],[20,10,5],[0,10,5]]; const triangles = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]]; return ["solid reference_box", ...triangles.flatMap((triangle) => ["  facet normal 0 0 0", "    outer loop", ...triangle.map((index) => `      vertex ${vertices[index]!.join(" ")}`), "    endloop", "  endfacet"]), "endsolid reference_box", ""].join("\n"); }
function requireValue(argv: string[], index: number, option: string): string { const value = argv[index]; if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`); return value; }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
