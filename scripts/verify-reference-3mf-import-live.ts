#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Options {
  help: boolean;
  target?: string;
  output?: string;
  allowDisposableMutations: boolean;
  sourceFixture?: Reference3mfFixture;
  sourceUrl?: string;
  sourcePageUrl?: string;
  license?: string;
}

export type Reference3mfFixture = "unit-meters" | "multi-mesh";

interface ExpectedReferenceMesh {
  boundsMinMm: [number, number, number];
  boundsMaxMm: [number, number, number];
  vertexEntries: number;
  triangles: number;
}

const REFERENCE_3MF_FIXTURES: Record<Reference3mfFixture, { file: string; meshes: ExpectedReferenceMesh[] }> = {
  "unit-meters": {
    file: "unit_meters.3mf",
    meshes: [{ boundsMinMm: [0, 0, 0], boundsMaxMm: [10, 20, 30], vertexEntries: 8, triangles: 12 }],
  },
  "multi-mesh": {
    file: "everything.3mf",
    meshes: [
      { boundsMinMm: [0, 0, 0], boundsMaxMm: [20, 10, 10], vertexEntries: 12, triangles: 4 },
      { boundsMinMm: [0, 0, 0], boundsMaxMm: [20, 10, 10], vertexEntries: 24, triangles: 8 },
    ],
  },
};

export function getReference3mfFixtureExpectation(fixture: Reference3mfFixture): ExpectedReferenceMesh[] {
  return structuredClone(REFERENCE_3MF_FIXTURES[fixture].meshes);
}

export function validateReference3mfFixtureSource(fixture: Reference3mfFixture, sourceUrlValue: string, sourcePageUrl: string): void {
  const sourceUrl = new URL(sourceUrlValue);
  requireCondition(sourceUrl.hostname === "raw.githubusercontent.com" && sourceUrl.pathname === `/Ghostkeeper/SlicerTestModels/master/3mf/${REFERENCE_3MF_FIXTURES[fixture].file}`, `Remote source URL must identify the selected ${fixture} acceptance fixture`);
  requireCondition(sourcePageUrl === "https://github.com/Ghostkeeper/SlicerTestModels/tree/master/3mf", "Remote source page must identify the reviewed SlicerTestModels 3MF directory");
}

export function parseReference3mfAcceptanceArgs(argv: string[]): Options {
  const options: Options = { help: argv.length === 0, allowDisposableMutations: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--allow-disposable-mutations") options.allowDisposableMutations = true;
    else if (["--target", "--output", "--source-fixture", "--source-url", "--source-page-url", "--license"].includes(argument ?? "")) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      if (argument === "--target") options.target = value;
      else if (argument === "--output") options.output = value;
      else if (argument === "--source-fixture") {
        if (!Object.hasOwn(REFERENCE_3MF_FIXTURES, value)) throw new Error("--source-fixture must be one of: unit-meters, multi-mesh");
        options.sourceFixture = value as Reference3mfFixture;
      }
      else if (argument === "--source-url") options.sourceUrl = requireHttpsUrl(value, argument);
      else if (argument === "--source-page-url") options.sourcePageUrl = requireHttpsUrl(value, argument);
      else options.license = value;
    } else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Live 3MF acceptance requires --target with an explicit Plasticity window ID");
  if (!options.allowDisposableMutations) throw new Error("Live 3MF acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live 3MF acceptance requires --output with a new directory");
  if (Boolean(options.sourceUrl) !== Boolean(options.sourcePageUrl)) throw new Error("Remote 3MF acceptance requires both --source-url and --source-page-url");
  if (options.sourceFixture && !options.sourceUrl) throw new Error("--source-fixture requires --source-url and --source-page-url");
  if (options.sourceUrl && !options.license) throw new Error("Remote 3MF acceptance requires --license with the reviewed asset terms");
  return options;
}

const HELP = `Usage:
  node scripts/verify-reference-3mf-import-live.ts --help
  node scripts/verify-reference-3mf-import-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY
  node scripts/verify-reference-3mf-import-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY --source-fixture unit-meters|multi-mesh --source-url HTTPS_3MF_URL --source-page-url HTTPS_SOURCE_PAGE --license REVIEWED_LICENSE

No-argument and --help modes do not connect to Plasticity. Live mode requires
an explicit empty disposable document. By default, it creates a 4 mm unit-aware
3MF cube and imports it through the public stdio MCP. When direct source inputs
are supplied, it downloads the selected remote 3MF through the public MCP
instead. Remote fixtures exercise embedded-unit conversion (one mesh) or a
multi-mesh model (two meshes). Each expected mesh is matched by topology and
measured bounds independent of list ordering. Both modes test Undo/Redo,
restore the initial scene, and write sanitized evidence.`;

async function main(): Promise<void> {
  const options = parseReference3mfAcceptanceArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  await mkdir(output, { recursive: false, mode: 0o700 });
  const sourcePath = join(output, "reference-cube-4mm.3mf");
  if (!options.sourceUrl) await writeFile(sourcePath, referenceCube3mf(), { flag: "wx", mode: 0o600 });
  const evidence: Record<string, unknown> = {
    schemaVersion: 1, startedAt: new Date().toISOString(), targetId: options.target!, workbenchUsed: false,
  };
  let client: Client | undefined;
  let initial: any;
  let state: any;
  let importedRecordId: string | undefined;
  let importedArtifactHash: string | undefined;
  try {
    client = await startMcp(join(output, "strength-store"));
    const tools = await client.listTools();
    for (const name of ["plasticity_import_reference_3mf", "plasticity_download_and_import_reference_3mf", "plasticity_list_reference_meshes", "plasticity_list_cad_reference_imports", "plasticity_get_cad_reference_import", "plasticity_undo", "plasticity_redo", "plasticity_changes_since", "plasticity_construction_journal"]) {
      requireCondition(tools.tools.some((tool) => tool.name === name), `MCP did not expose ${name}`);
    }
    const windows = await call(client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    initial = await call(client, "plasticity_connect", { targetId: options.target });
    requireEmpty(initial, "initial scene");
    evidence.initial = stateSummary(initial);
    const snapshot = await call(client, "plasticity_capture_snapshot", { label: "reference-3mf-live-initial-empty" });

    let expectedMeshes: ExpectedReferenceMesh[];
    if (options.sourceUrl) {
      const fixtureName = options.sourceFixture ?? "unit-meters";
      const fixture = REFERENCE_3MF_FIXTURES[fixtureName];
      validateReference3mfFixtureSource(fixtureName, options.sourceUrl, options.sourcePageUrl!);
      expectedMeshes = fixture.meshes;
      const sourceReference = {
        sourceKind: "verified-community-cad",
        sourceUrl: options.sourceUrl,
        sourcePageUrl: options.sourcePageUrl!,
        license: options.license!,
        confidence: "verified",
      };
      state = await call(client, "plasticity_download_and_import_reference_3mf", {
        source: sourceReference,
        intent: "Verify bounded remote 3MF download and native approximate-reference import",
        revision: initial.revision,
      });
      evidence.source = {
        sourceUrl: withoutQuery(options.sourceUrl),
        sourcePageUrl: withoutQuery(options.sourcePageUrl!),
        license: options.license,
      };
    } else {
      expectedMeshes = [{ boundsMinMm: [0, 0, 0], boundsMaxMm: [4, 4, 4], vertexEntries: 8, triangles: 12 }];
      state = await call(client, "plasticity_import_reference_3mf", {
        path: sourcePath,
        source: {
          sourceKind: "official-manufacturer-cad", sourceUrl: "https://fixture.invalid/reference-cube.3mf",
          license: "synthetic acceptance fixture", confidence: "verified",
        },
        intent: "Verify native 3MF approximate-reference import and embedded millimeter units",
        revision: initial.revision,
      });
    }
    requireCondition(state.bodies.length === 0, "3MF reference was incorrectly reported as editable native B-Rep");
    const meshes = state.referenceMeshes ?? [];
    verifyImportedMeshes(meshes, expectedMeshes, "3MF import");
    requireCondition(state.sourceReference?.unitSource === "embedded-3mf-model-metadata", "3MF unit provenance was not retained");
    requireCondition(state.provenancePersisted === true && typeof state.referenceRecordId === "string", "3MF import provenance was not persisted");
    importedRecordId = state.referenceRecordId;
    importedArtifactHash = state.referenceArtifactHash;
    const record = await call(client, "plasticity_get_cad_reference_import", { id: state.referenceRecordId });
    requireCondition(record.format === "3mf" && record.artifactHash === state.referenceArtifactHash, "Persistent 3MF import record does not match the imported artifact");
    requireCondition(record.referenceMeshes?.length === meshes.length, "Persistent 3MF import record omitted an imported mesh");
    for (const mesh of meshes) {
      const saved = record.referenceMeshes.find((candidate: any) => candidate.id === mesh.id);
      requireCondition(Boolean(saved), `Persistent 3MF import record omitted mesh ID ${mesh.id}`);
      requireCondition(JSON.stringify(saved.boundsMm) === JSON.stringify(mesh.boundsMm), `Persistent 3MF import record changed bounds for mesh ID ${mesh.id}`);
    }
    requireCondition(record.sourceReference?.unitSource === "embedded-3mf-model-metadata", "Persistent 3MF import record omitted unit provenance");
    evidence.imported = { meshes: meshes.map(summarizeReferenceMesh), unitSource: state.sourceReference.unitSource, referenceRecordId: state.referenceRecordId, provenancePersisted: true };

    state = await call(client, "plasticity_undo", { intent: "Verify native Undo of disposable 3MF reference import", revision: state.revision });
    requireEmpty(state, "3MF import Undo");
    state = await call(client, "plasticity_redo", { intent: "Verify native Redo of disposable 3MF reference import", revision: state.revision });
    const redoneMeshes = state.referenceMeshes ?? [];
    verifyImportedMeshes(redoneMeshes, expectedMeshes, "3MF Redo");
    requireCondition(JSON.stringify(redoneMeshes.map((mesh: any) => mesh.id).sort((a: number, b: number) => a - b)) === JSON.stringify(meshes.map((mesh: any) => mesh.id).sort((a: number, b: number) => a - b)), "Redo did not restore the same 3MF reference mesh identities");
    state = await call(client, "plasticity_undo", { intent: "Restore the initial empty scene after 3MF acceptance", revision: state.revision });
    requireEmpty(state, "final scene");
    const changes = await call(client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(changes.diff.referenceMeshesChanged === false && changes.diff.added.length === 0 && changes.diff.removed.length === 0 && changes.diff.modified.length === 0, "Scene did not return to the initial snapshot after cleanup");
    const journal = await call(client, "plasticity_construction_journal", {});
    requireCondition(journal.syncStatus === "in-sync", "Construction journal is not synchronized after Undo cleanup");
    await client.close();
    client = await startMcp(join(output, "strength-store"));
    const recovered = await call(client, "plasticity_get_cad_reference_import", { id: importedRecordId });
    requireCondition(recovered.artifactHash === importedArtifactHash && recovered.referenceMeshes?.length === expectedMeshes.length, "3MF provenance did not survive production MCP restart");
    evidence.provenanceAfterMcpRestart = { recovered: true, format: recovered.format, referenceMeshCount: recovered.referenceMeshes.length };
    evidence.undoRedo = true;
    evidence.cleanup = { restoredEmptyDocument: true, journal: journal.syncStatus };
    evidence.completedAt = new Date().toISOString();
    await writeExclusive(join(output, "evidence.json"), sanitizeEvidence(evidence));
    console.log(JSON.stringify({ ok: true, output, evidence: join(output, "evidence.json"), mesh: evidence.imported }));
  } catch (error) {
    if (client && initial && state && state.documentToken === initial.documentToken) {
      try {
        const current = await call(client, "plasticity_status", {});
        if (current.documentToken === initial.documentToken && current.revision === state.revision && current.undoDepth > initial.undoDepth) {
          state = await call(client, "plasticity_undo", { intent: "Safely recover interrupted disposable 3MF acceptance", revision: current.revision });
          evidence.recovery = { restoredEmptyDocument: requireSceneEmpty(state) };
        }
      } catch { /* Preserve the primary failure; reconcile manually if live state cannot be read. */ }
    }
    evidence.error = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
    evidence.completedAt = new Date().toISOString();
    await writeExclusive(join(output, "evidence.json"), sanitizeEvidence(evidence)).catch(() => {});
    throw error;
  } finally {
    await client?.close().catch(() => {});
  }
}

async function startMcp(storeRoot: string): Promise<Client> {
  const environment = Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof process.env[key] === "string" ? [[key, process.env[key]!]] : []));
  const transport = new StdioClientTransport({
    command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot,
    env: { ...environment, PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_REFERENCE_ROOT: join(storeRoot, "references"), PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" }, stderr: "pipe",
  });
  const client = new Client({ name: "plasticity-reference-3mf-live", version: "1.0.0" });
  await client.connect(transport);
  return client;
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

function requireEmpty(state: any, label: string): void { requireCondition(requireSceneEmpty(state), `${label} is not empty`); }
function requireSceneEmpty(state: any): boolean { return state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0 && (state.referenceMeshes ?? []).length === 0; }
function verifyImportedMeshes(meshes: any[], expectedMeshes: ExpectedReferenceMesh[], label: string): void {
  requireCondition(meshes.length === expectedMeshes.length, `${label} expected ${expectedMeshes.length} reference meshes, received ${meshes.length}`);
  const remaining = [...meshes];
  for (const [expectedIndex, expected] of expectedMeshes.entries()) {
    const match = remaining.findIndex((mesh) => mesh.sourceFormat === "3mf"
      && mesh.measurementSource === "reference-mesh"
      && mesh.vertexEntries === expected.vertexEntries
      && mesh.triangles === expected.triangles
      && boundsMatch(mesh.boundsMm, expected.boundsMinMm, expected.boundsMaxMm));
    requireCondition(match >= 0, `${label} did not return expected mesh ${expectedIndex + 1} (${expected.vertexEntries} vertices, ${expected.triangles} triangles)`);
    remaining.splice(match, 1);
  }
}
function boundsMatch(bounds: any, minimum: number[], maximum: number[]): boolean {
  return [...minimum.entries()].every(([index, expected]) => Number.isFinite(bounds?.min?.[index]) && Math.abs(bounds.min[index] - expected) <= 1e-6)
    && [...maximum.entries()].every(([index, expected]) => Number.isFinite(bounds?.max?.[index]) && Math.abs(bounds.max[index] - expected) <= 1e-6);
}
function summarizeReferenceMesh(mesh: any): Record<string, unknown> {
  return { meshId: mesh.id, sourceFormat: mesh.sourceFormat, measurementSource: mesh.measurementSource, boundsMm: mesh.boundsMm, vertexEntries: mesh.vertexEntries, triangles: mesh.triangles };
}
function stateSummary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodies: state.bodies.length, referenceMeshes: (state.referenceMeshes ?? []).length }; }
function requireCondition(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function requireHttpsUrl(value: string, option: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${option} must be a valid HTTPS URL`); }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error(`${option} must use HTTPS without embedded credentials`);
  return value;
}
function withoutQuery(value: string): string { const url = new URL(value); return `${url.origin}${url.pathname}`; }
function writeExclusive(path: string, value: unknown): Promise<void> { return writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }
function referenceCube3mf(): Buffer {
  const vertices = [[0,0,0],[4,0,0],[4,4,0],[0,4,0],[0,0,4],[4,0,4],[4,4,4],[0,4,4]];
  const triangles = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
  const model = `<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices>${vertices.map(([x,y,z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join("")}</vertices><triangles>${triangles.map(([v1,v2,v3]) => `<triangle v1="${v1}" v2="${v2}" v3="${v3}"/>`).join("")}</triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;
  return storedZip([
    ["[Content_Types].xml", Buffer.from('<Types><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>')],
    ["_rels/.rels", Buffer.from('<Relationships><Relationship Target="/3D/3dmodel.model"/></Relationships>')],
    ["3D/3dmodel.model", Buffer.from(model)],
  ]);
}
function storedZip(entries: Array<readonly [string, Buffer]>): Buffer {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const [name, contents] of entries) {
    const filename = Buffer.from(name); const crc = crc32(contents); const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(contents.length, 18); local.writeUInt32LE(contents.length, 22); local.writeUInt16LE(filename.length, 26);
    locals.push(local, filename, contents);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(contents.length, 20); central.writeUInt32LE(contents.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(central, filename); offset += local.length + filename.length + contents.length;
  }
  const centralDirectory = Buffer.concat(centrals); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralDirectory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}
function crc32(data: Buffer): number { let crc = 0xffffffff; for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
