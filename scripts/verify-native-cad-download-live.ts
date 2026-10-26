#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { diffScenes } from "../src/plasticity/change-tracker.ts";
import { hydrateNativeState } from "./native-live-state.ts";
import { verifyNativeBoxGeometry } from "./native-box-geometry.ts";
import { isolatedAcceptanceEnvironment } from "./verify-native-measure-datum-files-live.ts";
import { requireSceneEmpty, reference3mfFailureNeedsReconcile } from "./verify-reference-3mf-import-live.ts";
import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = {
  "sample-step": {
    format: "step", extension: "step", bytes: 19072,
    url: "https://raw.githubusercontent.com/cemrehancavdar/marimo-cad/6f6099b2186228cd8267045b364715c895169b5a/notebooks/sample_part.step",
    page: "https://github.com/cemrehancavdar/marimo-cad/blob/6f6099b2186228cd8267045b364715c895169b5a/notebooks/sample_part.step",
    sha256: "51bb4cdaa64a1d3cfb9db093eaa0756921c73c501b14aa7e5ce1595164a35b49",
    terms: "Repository MIT; no separate embedded CAD-file license statement",
  },
  "cube-parasolid": {
    format: "parasolid", extension: "x_t", bytes: 6531,
    url: "https://gist.githubusercontent.com/MattFerraro/57e5dc45fa10d71c28eb5078ad65626a/raw/0c387fe97ccb5a86cda6c860c78fa486b1a1ea8d/1%20cm%20cube.x_t",
    page: "https://gist.github.com/MattFerraro/57e5dc45fa10d71c28eb5078ad65626a",
    sha256: "bb9c15ee54e6ee8e5cd2e9159c00b72d80fe8d0b4165384301354b3e00f4bd70",
    terms: "No explicit Gist license stated; temporary qualification artifact only",
  },
} as const;
type Fixture = keyof typeof FIXTURES;
interface Options { help: boolean; target?: string; output?: string; fixture?: Fixture; allowDisposableMutations: boolean }
export function parseNativeCadDownloadArgs(argv: string[]): Options {
  const options: Options = { help: argv.length === 0, allowDisposableMutations: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--help") options.help = true;
    else if (flag === "--allow-disposable-mutations") options.allowDisposableMutations = true;
    else if (["--target", "--output", "--fixture"].includes(flag ?? "")) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw Error(`${flag} requires a value`);
      if (flag === "--target") options.target = value;
      else if (flag === "--output") options.output = value;
      else { if (!Object.hasOwn(FIXTURES, value)) throw Error("--fixture must be sample-step or cube-parasolid"); options.fixture = value as Fixture; }
    } else throw Error(`Unknown argument: ${flag}`);
  }
  if (!options.help) {
    if (!options.target) throw Error("--target is required");
    if (!options.allowDisposableMutations) throw Error("--allow-disposable-mutations is required");
    if (!options.output) throw Error("--output must name a new directory");
    if (!options.fixture) throw Error("--fixture is required");
  }
  return options;
}
export function assertImportedCadReadback(report: { documentToken: string; revision: string; importedBodyCount: number; importedBodyIds: number[] }, state: { documentToken: string; revision: string; bodies: Array<{ id: number }> }) {
  assert.equal(state.documentToken, report.documentToken, "CAD import readback switched documents");
  assert.equal(state.revision, report.revision, "CAD import readback changed revisions");
  assert.equal(state.bodies.length, report.importedBodyCount, "CAD import body count differs from report");
  assert.deepEqual(state.bodies.map(body => body.id).sort((a, b) => a - b), [...report.importedBodyIds].sort((a, b) => a - b), "CAD import body IDs differ from report");
}
export function assertCadGeometryUnchanged(before: any, after: any): void {
  for (const key of ["id", "faces", "edges", "vertices", "boundsMethod", "boxProof"]) assert.deepEqual(after[key], before[key], "Native geometry identity/topology changed: " + key);
  const near = (a: number, b: number, tolerance: number, label: string) => assert(Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance, "Native geometry changed: " + label);
  for (const key of ["min", "max"]) for (let axis = 0; axis < 3; axis++) near(before.boundsMm[key][axis], after.boundsMm[key][axis], 1e-8, "bounds");
  near(before.volumeMm3, after.volumeMm3, 1e-7, "volume");
  near(before.surfaceAreaMm2, after.surfaceAreaMm2, 1e-7, "area");
  assert.equal(after.centroidMm.length, 3);
  for (let axis = 0; axis < 3; axis++) near(before.centroidMm[axis], after.centroidMm[axis], 1e-8, "centroid");
}
const HELP = `Usage: npm run accept:native-cad-download -- --target ID --allow-disposable-mutations --fixture sample-step|cube-parasolid --output NEW_DIRECTORY
No args/--help are inert. Uses pinned reviewed public HTTPS files and isolated
stores in an empty disposable document. Verifies native B-Rep, provenance,
Undo/Redo, MCP restart and exact source restoration. Parasolid cube topology/mass
are checked independently; STEP properties are observations, not nominal proof.
Downloaded CAD bytes are removed after successful cleanup; hashes/history remain.`;

async function main() {
  const options = parseNativeCadDownloadArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!); await mkdir(output, { mode: 0o700 });
  const fixture = FIXTURES[options.fixture!];
  const stores = join(output, "stores");
  const artifact = join(stores, "reference-artifacts", fixture.sha256 + "." + fixture.extension);
  const evidence: any = { schemaVersion: 1, startedAt: new Date().toISOString(), fixture: options.fixture, source: fixture, scope: "real-https-native-brep-history" };
  let client: Client | undefined; let initial: any; let state: any;
  try {
    client = await startMcp(stores);
    const windows = await call(client, "plasticity_list_windows", {});
    assert(windows.some((w: any) => w.targetId === options.target), "Explicit target not found");
    initial = state = await call(client, "plasticity_connect", { targetId: options.target });
    assert(requireSceneEmpty(state), "Refusing a nonempty disposable scene");
    const snapshot = await call(client, "plasticity_capture_snapshot", { label: "network-cad-initial-empty" });
    const mutate = async (name: string, args: Record<string, unknown>) => state = await call(client!, name, { ...args, revision: state.revision });
    await mutate(fixture.format === "step" ? "plasticity_download_and_import_step" : "plasticity_download_and_import_parasolid", {
      source: { sourceKind: "verified-community-cad", sourceUrl: fixture.url, sourcePageUrl: fixture.page, confidence: "approximate" },
      ...(fixture.format === "parasolid" ? { representation: "x_t" } : {}),
      intent: "Qualify explicitly approved disposable pinned HTTPS CAD import",
    });
    const imported = state;
    state = await call(client, "plasticity_status", {});
    assertImportedCadReadback(imported, state);
    assert.equal(imported.importedArtifactHash, fixture.sha256);
    assert.equal(imported.provenancePersisted, true);
    assert.equal(imported.acquisition?.bytes, fixture.bytes);
    assert.equal(imported.acquisition?.finalUrl, fixture.url);
    const bytes = await readFile(artifact);
    assert.equal(bytes.length, fixture.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), fixture.sha256);
    const recordId = imported.referenceRecordId;
    const record = await call(client, "plasticity_get_cad_reference_import", { id: recordId });
    assert.equal(record.artifactHash, fixture.sha256); assert.equal(record.format, fixture.format); assert.equal(record.historical, true);
    assert.equal(record.sourceReference.sourceUrl, fixture.url);
    assert.equal(record.bodies.length, 1); assert.deepEqual(record.bodies[0].boundsMm, state.bodies[0].boundsMm);
    const listed = await call(client, "plasticity_list_cad_reference_imports", { offset: 0, limit: 10 });
    assert.equal(listed.total, 1); assert.equal(listed.records[0].id, recordId);
    const bodyId = state.bodies[0].id;
    const geometry = await checkGeometry(client, state, options.fixture!);
    evidence.imported = geometry;
    await mutate("plasticity_undo", {}); assert(requireSceneEmpty(state), "Import Undo left scene content");
    const beforeRestartDiff = await call(client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    assert(!hasSceneContentChanges(beforeRestartDiff.diff), "Source snapshot was not restored before restart");
    await mutate("plasticity_redo", {}); assert.equal(state.bodies[0]?.id, bodyId, "Redo changed stable body identity");
    evidence.redo = await checkGeometry(client, state, options.fixture!);
    assertCadGeometryUnchanged(geometry, evidence.redo);
    const importedState = { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth };
    await client.close(); client = await startMcp(stores);
    state = await call(client, "plasticity_connect", { targetId: options.target });
    assert.deepEqual({ documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth }, importedState);
    evidence.afterRestart = await checkGeometry(client, state, options.fixture!);
    assertCadGeometryUnchanged(geometry, evidence.afterRestart);
    const recovered = await call(client, "plasticity_get_cad_reference_import", { id: recordId });
    assert.deepEqual(recovered, record, "Restart changed immutable provenance");
    await mutate("plasticity_undo", {}); assert(requireSceneEmpty(state), "Cleanup Undo left scene content");
    assert(!hasSceneContentChanges(diffScenes(initial, state)), "Full source baseline was not restored after restart");
    const history = await call(client, "plasticity_construction_history", { offset: 0, limit: 100 });
    assert.equal(history.total, 4); assert.equal(history.entries.length, 4);
    assert(history.entries.every((event: any) => event.status === "completed"));
    const importedEvent = history.entries.find((event: any) => event.operation === "import-" + fixture.format);
    assert.equal(importedEvent?.input.importedArtifactHash, fixture.sha256);
    const journal = await call(client, "plasticity_construction_journal", {});
    assert.equal(journal.durableSyncStatus, "in-sync"); assert.equal(journal.journalPersistenceWarnings.length, 0);
    // Only remove the known private downloaded artifact after successful restoration.
    assert.equal(createHash("sha256").update(await readFile(artifact)).digest("hex"), fixture.sha256);
    await unlink(artifact);
    evidence.cleanup = { restoredEmpty: true, sourceSnapshotRestored: true, downloadedArtifactRemoved: true };
    evidence.provenanceSurvivedRestart = true;
    evidence.history = { completedEvents: history.total, syncStatus: journal.durableSyncStatus };
    evidence.completedAt = new Date().toISOString(); await writeEvidence(join(output, "evidence.json"), evidence);
    console.log(JSON.stringify({ ok: true, output }));
  } catch (error) {
    evidence.error = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
    if (client && initial && state && !reference3mfFailureNeedsReconcile(error)) try {
      let current = await call(client, "plasticity_status", {});
      if (current.documentToken === initial.documentToken && current.revision === state.revision) {
        for (let i = 0; i < 8 && current.undoDepth > initial.undoDepth; i++) current = await call(client, "plasticity_undo", { revision: current.revision });
        evidence.recovery = { restoredEmpty: requireSceneEmpty(current) };
      }
    } catch { /* Preserve the original failure; uncertain outcomes require inspection. */ }
    await writeEvidence(join(output, "failure.json"), evidence).catch(() => {}); throw error;
  } finally { await client?.close().catch(() => {}); }
}
async function checkGeometry(client: Client, state: any, fixture: Fixture) {
  assert.equal(state.bodies.length, 1); assert.equal(state.bodies[0].type, "Solid");
  assert.equal(state.regions.length, 0); assert.equal(state.referenceMeshes.length, 0);
  const body = state.bodies[0];
  assert(body.faces.length > 0 && body.edges.length > 0);
  assert(["native-box", "native-extrema"].includes(body.boundsMethod));
  assert(body.boundsMm && [...body.boundsMm.min, ...body.boundsMm.max].every(Number.isFinite));
  assert(body.boundsMm.min.every((v: number, i: number) => body.boundsMm.max[i] > v));
  const validity = await call(client, "plasticity_validate_bodies", { ids: [body.id], revision: state.revision });
  assert.equal(validity.bodies[0].nativeValid, true); assert.equal(validity.bodies[0].printableSolid, true);
  const properties = await call(client, "plasticity_measure_solid_properties", { ids: [body.id], revision: state.revision });
  const mass = properties.bodies[0];
  assert(Number.isFinite(mass.volumeMm3) && mass.volumeMm3 > 0 && Number.isFinite(mass.surfaceAreaMm2) && mass.surfaceAreaMm2 > 0);
  assert.equal(mass.volumeCentroidMm.length, 3); assert(mass.volumeCentroidMm.every(Number.isFinite));
  let boxProof;
  if (fixture === "cube-parasolid") {
    boxProof = verifyNativeBoxGeometry(body, [-10, -20, -10], [10, 0, 10]);
    assert(Math.abs(mass.volumeMm3 - 8000) <= 1e-4); assert(Math.abs(mass.surfaceAreaMm2 - 2400) <= 1e-4);
    assert(mass.volumeCentroidMm.every((v: number, i: number) => Math.abs(v - [0, -10, 0][i]!) <= 1e-5));
  }
  return { id: body.id, faces: body.faces.length, edges: body.edges.length, vertices: body.vertices.length,
    boundsMm: body.boundsMm, boundsMethod: body.boundsMethod, volumeMm3: mass.volumeMm3,
    surfaceAreaMm2: mass.surfaceAreaMm2, centroidMm: mass.volumeCentroidMm, boxProof };
}
async function startMcp(root: string) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts/run-server.ts")], cwd: projectRoot,
    env: isolatedAcceptanceEnvironment(root, process.env), stderr: "pipe" });
  const client = new Client({ name: "plasticity-native-cad-download-live", version: "1.0.0" }); await client.connect(transport); return client;
}
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
  const text = (result.content as any[]).find(item => item.type === "text")?.text;
  assert.equal(typeof text, "string"); if (result.isError) throw Error(text);
  return await hydrateNativeState(JSON.parse(text), id => call(client, "plasticity_body_info", { id }), (offset, revision) => call(client, "plasticity_list_bodies", { bodyOffset: offset, bodyLimit: 100, expectedRevision: revision }));
}
async function writeEvidence(path: string, data: unknown) { await writeFile(path, JSON.stringify(sanitizeEvidence(data), null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
