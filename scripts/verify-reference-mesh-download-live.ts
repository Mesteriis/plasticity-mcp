#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { isolatedAcceptanceEnvironment } from "./verify-native-measure-datum-files-live.ts";
import { requireSceneEmpty, reference3mfFailureNeedsReconcile } from "./verify-reference-3mf-import-live.ts";
import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";
import { validateStl } from "../src/plasticity/stl.ts";
import { validateObj } from "../src/plasticity/obj.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const formats = ["stl", "obj"] as const;
const units = ["millimeter", "centimeter", "meter", "inch", "foot"] as const;

export interface Options {
  help: boolean;
  allowDisposableMutations: boolean;
  expectedSha256?: string;
  target?: string;
  sourceUrl?: string;
  sourcePageUrl?: string;
  license?: string;
  format?: (typeof formats)[number];
  sourceUnit?: (typeof units)[number];
  confidence: "verified" | "probable" | "approximate" | "assumed" | "measurement-required";
  output?: string;
}

export function parseReferenceMeshDownloadArgs(argv: string[]): Options {
  const options: Options = { help: argv.length === 0, allowDisposableMutations: false, confidence: "approximate" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--allow-disposable-mutations") options.allowDisposableMutations = true;
    else if (argument === "--expected-sha256") {
      const hash = value(argv, ++index, argument);
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("--expected-sha256 must be 64 lowercase hex characters");
      options.expectedSha256 = hash;
    }
    else if (argument === "--target") options.target = value(argv, ++index, argument);
    else if (argument === "--source-url") options.sourceUrl = value(argv, ++index, argument);
    else if (argument === "--source-page-url") options.sourcePageUrl = value(argv, ++index, argument);
    else if (argument === "--license") options.license = value(argv, ++index, argument);
    else if (argument === "--format") {
      const format = value(argv, ++index, argument);
      if (!formats.includes(format as (typeof formats)[number])) throw new Error("--format must be stl or obj");
      options.format = format as (typeof formats)[number];
    } else if (argument === "--source-unit") {
      const unit = value(argv, ++index, argument);
      if (!units.includes(unit as (typeof units)[number])) throw new Error(`Unsupported --source-unit: ${unit}`);
      options.sourceUnit = unit as (typeof units)[number];
    } else if (argument === "--confidence") {
      const confidence = value(argv, ++index, argument);
      if (!["verified", "probable", "approximate", "assumed", "measurement-required"].includes(confidence)) {
        throw new Error("--confidence must be verified, probable, approximate, assumed, or measurement-required");
      }
      options.confidence = confidence as Options["confidence"];
    } else if (argument === "--output") options.output = value(argv, ++index, argument);
    else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (options.help) return options;
  for (const key of ["target", "sourceUrl", "format", "sourceUnit", "output"] as const) {
    if (!options[key]) throw new Error(`Live remote-mesh acceptance requires --${key === "sourceUrl" ? "source-url" : key === "sourceUnit" ? "source-unit" : key}`);
  }
  if (!options.allowDisposableMutations) throw new Error("Live remote-mesh acceptance requires --allow-disposable-mutations");
  const directUrl = new URL(options.sourceUrl!);
  if (directUrl.protocol !== "https:") throw new Error("--source-url must use HTTPS");
  if (directUrl.username || directUrl.password) throw new Error("--source-url must not contain credentials");
  if (options.sourcePageUrl && (new URL(options.sourcePageUrl).username || new URL(options.sourcePageUrl).password)) throw new Error("--source-page-url must not contain credentials");
  if (options.sourcePageUrl && new URL(options.sourcePageUrl).protocol !== "https:") throw new Error("--source-page-url must use HTTPS");
  return options;
}

const HELP = `Usage:
  node scripts/verify-reference-mesh-download-live.ts --help
  node scripts/verify-reference-mesh-download-live.ts --target ID --allow-disposable-mutations --source-url HTTPS_URL --format stl|obj --source-unit millimeter|centimeter|meter|inch|foot --output NEW_DIRECTORY [--source-page-url HTTPS_URL] [--license TEXT] [--confidence VALUE] [--expected-sha256 HASH]

The acceptance imports one explicitly selected public STL/OBJ through the
production stdio MCP into the selected Plasticity window, verifies that the
result is a tessellated reference rather than B-rep, records its artifact hash,
checks source geometry, Undo/Redo and restart durability, then restores the
initial empty disposable scene. No arguments/--help are inert. All stores are
isolated; --allow-disposable-mutations and a new output directory are required.`;

async function main(): Promise<void> {
  const options = parseReferenceMeshDownloadArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  await mkdir(output, { recursive: false, mode: 0o700 });
  const roots = {
    strength: join(output, "private", "strength"),
    references: join(output, "private", "references"),
    artifacts: join(output, "private", "reference-artifacts"),
    history: join(output, "private", "history"),
  };
  await Promise.all(Object.values(roots).map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
  const evidence: Record<string, unknown> = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    targetId: options.target,
    request: {
      sourceUrl: safeUrl(options.sourceUrl!),
      ...(options.sourcePageUrl ? { sourcePageUrl: safeUrl(options.sourcePageUrl) } : {}),
      ...(options.license ? { license: options.license } : {}),
      format: options.format,
      sourceUnit: options.sourceUnit,
      confidence: options.confidence,
    },
  };
  let client: Client | undefined;
  let initial: any;
  let importRevision: string | undefined;
  let imported = false;
  try {
    client = await startMcp(join(output, "private"));
    const tools = await client.listTools();
    requireCondition(tools.tools.some((tool) => tool.name === "plasticity_download_and_import_reference_mesh"), "Production MCP does not expose the remote reference-mesh tool");
    const windows = await call(client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    initial = await call(client, "plasticity_connect", { targetId: options.target });
    requireCondition(requireSceneEmpty(initial), "Refusing remote mesh acceptance in a nonempty disposable scene");
    const snapshot = await call(client, "plasticity_capture_snapshot", { label: "remote-mesh-initial-empty" });
    const before = await call(client, "plasticity_status", {});
    requireCondition(before.documentToken === initial.documentToken && before.revision === initial.revision, "Plasticity changed during the read-only preflight");
    const originalScene = sceneIdentity(initial);
    evidence.before = summarize(initial);

    const result = await call(client, "plasticity_download_and_import_reference_mesh", {
      source: {
        sourceKind: "verified-community-cad",
        sourceUrl: options.sourceUrl,
        ...(options.sourcePageUrl ? { sourcePageUrl: options.sourcePageUrl } : {}),
        ...(options.license ? { license: options.license } : {}),
        confidence: options.confidence,
      },
      format: options.format,
      sourceUnit: options.sourceUnit,
      intent: "Verify remote reference-mesh download, validation, and native Plasticity import",
      revision: initial.revision,
    });
    imported = true;
    importRevision = result.revision;
    const addedMeshes = result.importedMeshes as any[];
    requireCondition(Array.isArray(addedMeshes) && addedMeshes.length > 0, "Remote import did not add reference meshes");
    const mesh = addedMeshes[0];
    requireCondition(addedMeshes.every(mesh => mesh.sourceFormat === options.format && mesh.measurementSource === "reference-mesh"), "Unexpected imported mesh type");
    requireCondition(mesh.sourceFormat === options.format, "Imported mesh format does not match the selected file format");
    requireCondition(mesh.measurementSource === "reference-mesh", "Imported mesh was not labelled as approximate reference evidence");
    requireCondition(result.approximateReference === true && result.sourceReference.exactGeometry === false, "Remote mesh was incorrectly treated as exact CAD geometry");
    requireCondition(/^[a-f0-9]{64}$/u.test(result.referenceArtifactHash), "The imported source did not return a SHA-256 artifact identity");
    if (options.expectedSha256) requireCondition(result.referenceArtifactHash === options.expectedSha256, "Acquired mesh differs from independently reviewed SHA-256");
    const artifactBytes = await readFile(join(roots.artifacts, result.referenceArtifactHash + "." + options.format));
    requireCondition(createHash("sha256").update(artifactBytes).digest("hex") === result.referenceArtifactHash && artifactBytes.length === result.acquisition.bytes, "Private downloaded artifact identity does not match acquisition");
    verifyDownloadedMeshGeometry(artifactBytes, options.format!, options.sourceUnit!, addedMeshes);
    const current = await call(client, "plasticity_status", {});
    requireCondition(current.documentToken === initial.documentToken, "Plasticity document changed during the remote import");
    requireCondition(sceneIdentity(current, false).bodies === originalScene.bodies, "Remote mesh import unexpectedly changed native B-rep bodies");
    requireCondition(current.referenceMeshes.length === initial.referenceMeshes.length + addedMeshes.length, "Remote mesh was not added to the reference-mesh collection");
    requireCondition(current.revision === importRevision, "Plasticity changed after import; automatic Undo is unsafe");
    const history = await call(client, "plasticity_construction_history", { limit: 5 });
    const event = history.entries?.[0];
    requireCondition(event?.operation === "download-and-import-reference-mesh", "Remote import was not persisted in construction history");
    requireCondition(event.input?.sourceArtifactHash === result.referenceArtifactHash, "Construction history does not bind the downloaded artifact hash");
    evidence.import = {
      artifactHash: result.referenceArtifactHash,
      format: mesh.sourceFormat,
      bytes: result.acquisition.bytes,
      boundsMm: mesh.boundsMm,
      triangles: addedMeshes.reduce((sum, mesh) => sum + mesh.triangles, 0),
      meshes: addedMeshes.map(({ id, boundsMm, triangles }: any) => ({ id, boundsMm, triangles })),
      expectedSha256: options.expectedSha256,
      sourceReference: result.sourceReference,
      approximateReference: result.approximateReference,
      durableHistoryOperation: event.operation,
    };

    let undone = await call(client, "plasticity_undo", {
      intent: "Restore the exact pre-acceptance Plasticity scene",
      revision: current.revision,
    });
    imported = false;
    requireCondition(undone.documentToken === initial.documentToken, "Undo switched the Plasticity document");
    requireCondition(sceneIdentity(undone).all === originalScene.all, "Undo did not restore the exact pre-acceptance scene");
    const redone = await call(client, "plasticity_redo", { revision: undone.revision });
    imported = true; importRevision = redone.revision;
    verifyDownloadedMeshGeometry(artifactBytes, options.format!, options.sourceUnit!, redone.referenceMeshes);
    requireCondition(JSON.stringify(redone.referenceMeshes.map((mesh: any) => mesh.id).sort()) === JSON.stringify(addedMeshes.map(mesh => mesh.id).sort()), "Redo changed mesh stable IDs");
    undone = await call(client, "plasticity_undo", { revision: redone.revision }); imported = false;
    requireCondition(requireSceneEmpty(undone), "Final Undo did not restore empty scene");
    const changes = await call(client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(changes.diff), "Full source snapshot was not restored");
    const journal = await call(client, "plasticity_construction_journal", {});
    requireCondition(journal.syncStatus === "in-sync" && journal.durableSyncStatus === "in-sync" && journal.journalPersistenceWarnings.length === 0, "Construction journal is not synchronized after Undo");
    evidence.cleanup = { restoredExactPreTestScene: true, journalSyncStatus: journal.syncStatus };
    await client.close(); client = await startMcp(join(output, "private"));
    const restarted = await call(client, "plasticity_connect", { targetId: options.target });
    requireCondition(requireSceneEmpty(restarted) && restarted.documentToken === undone.documentToken && restarted.revision === undone.revision, "MCP restart changed the restored document");
    const durable = await call(client, "plasticity_construction_history", { offset: 0, limit: 100 });
    requireCondition(durable.total === 4 && durable.entries.length === 4 && durable.entries.every((e: any) => e.status === "completed"), "Expected four completed durable import/history events");
    const recoveredImport = durable.entries.find((e: any) => e.operation === "download-and-import-reference-mesh");
    requireCondition(recoveredImport?.input.sourceArtifactHash === result.referenceArtifactHash, "Restart lost source artifact binding");
    const restartedJournal = await call(client, "plasticity_construction_journal", {});
    requireCondition(restartedJournal.durableSyncStatus === "in-sync", "Durable journal lost sync after restart");
    evidence.durableHistory = { completedEvents: durable.total, syncAfterRestart: restartedJournal.durableSyncStatus };
    evidence.completedAt = new Date().toISOString();
    await writeExclusive(join(output, "evidence.json"), evidence);
    console.log(JSON.stringify({ accepted: true, output, evidence: join(output, "evidence.json"), artifactHash: evidence.import && (evidence.import as Record<string, unknown>).artifactHash }, null, 2));
  } catch (error) {
    evidence.failure = boundedError(error);
    if (!reference3mfFailureNeedsReconcile(error) && imported && client && initial && importRevision) {
      const status = await call(client, "plasticity_status", {}).catch(() => undefined);
      if (status?.documentToken === initial.documentToken && status.revision === importRevision) {
        await call(client, "plasticity_undo", { intent: "Recover the remote-mesh acceptance import", revision: status.revision })
          .then(() => { evidence.recovery = "undone-exact-import-revision"; })
          .catch(() => { evidence.recovery = "undo-failed"; });
      } else evidence.recovery = "automatic-undo-skipped-scene-changed";
    }
    await writeExclusive(join(output, "failure.json"), evidence).catch(() => {});
    throw error;
  } finally {
    await client?.close().catch(() => {});
  }
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await client.callTool({ name, arguments: args });
  const content = (response as { content?: Array<{ type: string; text?: string }> }).content;
  const item = content?.find((entry) => entry.type === "text");
  if (response.isError || !item || !("text" in item)) throw new Error(`${name}: ${item && "text" in item ? item.text : "MCP returned no text"}`);
  return JSON.parse(item.text);
}

function sceneIdentity(state: any, includeAll = true): { bodies: string; all: string } {
  const identity = {
    bodies: state.bodies.map(({ id, type, name, boundsMm, faceCount, edgeCount }: any) => ({ id, type, name, boundsMm, faceCount, edgeCount })),
    regions: state.regions.map(({ id, type, name, boundsMm }: any) => ({ id, type, name, boundsMm })),
    instances: (state.instances ?? []).map(({ id, name, sourceBodyId, transform }: any) => ({ id, name, sourceBodyId, transform })),
    referenceMeshes: (state.referenceMeshes ?? []).map(({ id, name, sourceFormat, boundsMm, triangles, translationMm, rotationQuaternion, scale }: any) => ({ id, name, sourceFormat, boundsMm, triangles, translationMm, rotationQuaternion, scale })),
    groups: (state.groups ?? []).map(({ id, name, bodyIds, referenceMeshIds, children }: any) => ({ id, name, bodyIds, referenceMeshIds, children })),
  };
  return { bodies: JSON.stringify(identity.bodies), all: includeAll ? JSON.stringify(identity) : "" };
}

function summarize(state: any): Record<string, unknown> {
  return {
    documentToken: state.documentToken,
    revision: state.revision,
    bodies: state.bodies.map(({ id, type, name, boundsMm, faceCount, edgeCount }: any) => ({ id, type, name, boundsMm, faceCount, edgeCount })),
    regions: state.regions.map(({ id, type, name, boundsMm }: any) => ({ id, type, name, boundsMm })),
    referenceMeshes: (state.referenceMeshes ?? []).map(({ id, name, sourceFormat, boundsMm, triangles, translationMm, rotationQuaternion, sceneScaleToMeters }: any) => ({ id, name, sourceFormat, boundsMm, triangles, translationMm, rotationQuaternion, sceneScaleToMeters })),
    undoDepth: state.undoDepth,
    redoDepth: state.redoDepth,
  };
}

function safeUrl(value: string): string {
  const url = new URL(value);
  if (url.search) url.search = `?${[...url.searchParams.keys()].map((key) => `${encodeURIComponent(key)}=%5Bredacted%5D`).join("&")}`;
  if (url.hash) url.hash = "#[redacted]";
  return url.toString();
}

async function startMcp(root: string): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot,
    env: isolatedAcceptanceEnvironment(root, process.env), stderr: "pipe" });
  const client = new Client({ name: "plasticity-reference-mesh-download-live", version: "1.0.0" });
  await client.connect(transport); return client;
}

export function verifyDownloadedMeshGeometry(bytes: Buffer, format: "stl" | "obj", unit: (typeof units)[number], meshes: any[]): void {
  const parsed = format === "stl" ? validateStl(bytes) : validateObj(bytes);
  const bounds = "bounds" in parsed ? parsed.bounds : parsed.boundsMm;
  const scale = { millimeter: 1, centimeter: 10, meter: 1000, inch: 25.4, foot: 304.8 }[unit];
  requireCondition(meshes.length > 0 && meshes.reduce((sum, mesh) => sum + mesh.triangles, 0) === parsed.triangles, "Native mesh triangle total differs from source");
  for (const [key, operation] of [["min", Math.min], ["max", Math.max]] as const) for (let axis = 0; axis < 3; axis++) {
    const expected = bounds[key][axis]! * scale;
    const actual = operation(...meshes.map(mesh => mesh.boundsMm?.[key]?.[axis]));
    // Allow binary32 storage plus unit conversion; this is mesh metadata, not B-Rep.
    const tolerance = Math.max(1e-6, Math.abs(expected) * 2 ** -22);
    requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, "Native mesh bounds differ from source units");
  }
}

function value(argv: string[], index: number, option: string): string {
  const found = argv[index];
  if (!found || found.startsWith("--")) throw new Error(`${option} requires a value`);
  return found;
}

function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4_000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(sanitizeEvidence(value), null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
