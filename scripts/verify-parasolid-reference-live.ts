#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { StepImportReferenceStore } from "../src/plasticity/import-reference-store.ts";
import { ConstructionHistoryStore } from "../src/plasticity/construction-history.ts";
import { StepReferenceDownloader } from "../src/plasticity/step-reference-downloader.ts";
import { createServer, PlasticitySession } from "../src/server.ts";
import type { RuntimeState } from "../src/plasticity/runtime.ts";

const [targetId, requestedOutput] = process.argv.slice(2);
if (!targetId || !requestedOutput) throw new Error("Usage: node scripts/verify-parasolid-reference-live.ts <explicit-target-id> <new-output-directory>");

const output = resolve(requestedOutput);
await mkdir(output, { mode: 0o700 });
const scratch = await mkdtemp(join(tmpdir(), "plasticity-parasolid-reference-live-"));
const exportPath = join(scratch, "disposable-source.x_t");
const archivePath = join(scratch, "disposable-source.zip");
const artifactRoot = join(output, "private-artifacts");
const references = new StepImportReferenceStore(join(output, "references"));
const history = new ConstructionHistoryStore(join(output, "history"));

interface McpResponse { isError?: boolean; content?: Array<{ type: string; text?: string }> }
function readResult<T>(response: unknown): T {
  const value = response as McpResponse;
  const text = value.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("MCP tool returned no text result");
  if (value.isError) throw new Error(`MCP tool failed: ${text}`);
  return JSON.parse(text) as T;
}
async function writeExclusive(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}
function createStoredZip(memberPath: string, content: Buffer): Buffer {
  const name = Buffer.from(memberPath, "utf8");
  const crc = crc32(content);
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  name.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length + content.length, 16);
  return Buffer.concat([local, content, central, end]);
}
function crc32(data: Buffer): number {
  let value = 0xffffffff;
  for (const byte of data) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

const session = new PlasticitySession();
let archiveBytes: Buffer | undefined;
const downloader = new StepReferenceDownloader({
  root: artifactRoot,
  lookup: async () => [{ address: "93.184.216.34", family: 4 }],
  async request(url) {
    assert.equal(url.hostname, "cad.example");
    assert.equal(url.pathname, "/model.x_t.zip");
    assert.ok(archiveBytes, "The disposable Parasolid ZIP must exist before download");
    const data = await readFile(archivePath);
    return { statusCode: 200, headers: { "content-length": String(data.length) }, body: Readable.from([data]) };
  },
});
const server = createServer(session, undefined, undefined, references, history, downloader);
const client = new Client({ name: "plasticity-parasolid-reference-live", version: "1.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);
let initial: RuntimeState | undefined;
let completed = false;
const evidence: Record<string, unknown> = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  targetId,
  networkTransport: "production downloader with deterministic public-DNS/request fixtures",
  plasticityConnected: false,
  cadMutated: false,
};
try {
  const windows = readResult<Array<{ targetId: string }>>(await client.callTool({ name: "plasticity_list_windows", arguments: {} }));
  assert(windows.some((window) => window.targetId === targetId), "Explicit Plasticity target was not found");
  const connected = readResult<RuntimeState>(await client.callTool({ name: "plasticity_connect", arguments: { targetId } }));
  initial = connected;
  assert.equal(connected.bodies.length, 0, "Selected document must be empty before disposable acceptance");
  assert.equal(connected.regions.length, 0, "Selected document must contain no regions before disposable acceptance");
  evidence.plasticityConnected = true;
  evidence.initial = { documentToken: connected.documentToken, revision: connected.revision, bodyCount: 0 };

  let state = readResult<RuntimeState>(await client.callTool({
    name: "plasticity_create_box",
    arguments: { originMm: [0, 0, 0], sizeMm: [30, 20, 8], name: "Disposable Parasolid source", intent: "Verify Parasolid source acquisition", revision: connected.revision },
  }));
  assert.equal(state.bodies.length, 1);
  const sourceBody = state.bodies[0]!;
  assert.ok(sourceBody.boundsMm);
  const exported = readResult<{ format: string; bytes: number }>(await client.callTool({ name: "plasticity_export_parasolid", arguments: {
    ids: [sourceBody.id], path: exportPath, revision: state.revision,
  } }));
  const exportedBytes = await readFile(exportPath);
  assert.equal(exported.format, "parasolid-text");
  assert.equal(exported.bytes, exportedBytes.length);
  const expectedHash = createHash("sha256").update(exportedBytes).digest("hex");
  archiveBytes = createStoredZip("model.x_t", exportedBytes);
  await writeFile(archivePath, archiveBytes, { flag: "wx", mode: 0o600 });
  state = readResult(await client.callTool({ name: "plasticity_undo", arguments: {
    intent: "Restore empty document before direct Parasolid import", revision: state.revision,
  } }));
  assert.equal(state.bodies.length, 0);

  const source = {
    sourceKind: "verified-community-cad",
    sourceUrl: "https://cad.example/model.x_t.zip?token=redact-me",
    sourcePageUrl: "https://cad.example/products/model?session=redact-page",
    license: "Acceptance-only local round-trip fixture",
    confidence: "approximate",
  };
  const imported = readResult<RuntimeState & {
    importedFormat: string;
    importedArtifactHash: string;
    sourceReference: { sourceUrl: string; sourcePageUrl?: string };
    acquisition: { sourceArchive?: { sha256: string; bytes: number; memberPath: string } };
    provenancePersisted: boolean;
    referenceRecordId: string;
  }>(await client.callTool({ name: "plasticity_download_and_import_parasolid", arguments: {
    source, representation: "x_t", intent: "Import the explicitly selected Parasolid reference", revision: state.revision,
  } }));
  state = imported;
  evidence.cadMutated = true;
  assert.equal(imported.importedFormat, "parasolid");
  assert.equal(imported.importedArtifactHash, expectedHash);
  assert.equal(imported.sourceReference.sourceUrl, "https://cad.example/model.x_t.zip?token=%5Bredacted%5D");
  assert.equal(imported.sourceReference.sourcePageUrl, "https://cad.example/products/model?session=%5Bredacted%5D");
  assert.equal(imported.acquisition.sourceArchive?.sha256, createHash("sha256").update(archiveBytes).digest("hex"));
  assert.equal(imported.acquisition.sourceArchive?.bytes, archiveBytes.length);
  assert.equal(imported.acquisition.sourceArchive?.memberPath, "model.x_t");
  assert.equal(imported.provenancePersisted, true);
  assert.equal(state.bodies.length, 1);
  const body = state.bodies[0]!;
  assert.ok(body.boundsMm);
  for (const [index, dimension] of [30, 20, 8].entries()) {
    assert.ok(Math.abs(body.boundsMm.max[index]! - body.boundsMm.min[index]! - dimension) <= 0.01, `Imported dimension ${index} differs from ${dimension} mm`);
  }
  const validation = readResult<{ bodies: Array<{ nativeValid: boolean; closed: boolean; printableSolid: boolean }> }>(await client.callTool({
    name: "plasticity_validate_bodies", arguments: { ids: [body.id], revision: state.revision },
  }));
  assert.equal(validation.bodies[0]?.nativeValid, true);
  assert.equal(validation.bodies[0]?.closed, true);
  assert.equal(validation.bodies[0]?.printableSolid, true);
  const stored = await references.get(imported.referenceRecordId);
  assert.equal(stored.format, "parasolid");
  assert.equal(stored.artifactHash, expectedHash);
  assert.deepEqual(stored.sourceArchive, imported.acquisition.sourceArchive);
  assert.deepEqual(stored.bodies[0]?.boundsMm, body.boundsMm);
  const artifactPath = join(artifactRoot, `${expectedHash}.x_t`);
  assert.equal(await realpath(artifactPath), await realpath(stored.sourcePath));
  const archiveHash = imported.acquisition.sourceArchive!.sha256;
  const storedArchivePath = join(artifactRoot, `${archiveHash}.zip`);
  assert.deepEqual(await readFile(storedArchivePath), archiveBytes);
  evidence.roundTrip = {
    exportBytes: exported.bytes,
    importedArtifactHash: expectedHash,
    importedBoundsMm: body.boundsMm,
    validation: validation.bodies[0],
    referenceRecordId: stored.id,
    sourceUrlQueriesRedacted: true,
    sourceArchive: imported.acquisition.sourceArchive,
    contentAddressedPrivateArtifact: true,
  };

  state = readResult(await client.callTool({ name: "plasticity_undo", arguments: {
    intent: "Restore the original empty test document", revision: state.revision,
  } }));
  assert.equal(state.bodies.length, 0);
  assert.equal(state.documentToken, initial.documentToken);
  evidence.cleanup = { restoredEmptyDocument: true, finalRevision: state.revision };
  evidence.plasticityConnected = false;
  evidence.completedAt = new Date().toISOString();
  await writeExclusive(join(output, "evidence.json"), evidence);
  completed = true;
  console.log(JSON.stringify({ ok: true, output, importedArtifactHash: expectedHash, importedBoundsMm: body.boundsMm, restoredEmptyDocument: true }, null, 2));
} catch (error) {
  evidence.failure = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
  throw error;
} finally {
  if (!completed && initial) {
    const statusResponse = await client.callTool({ name: "plasticity_status", arguments: {} }).catch(() => undefined);
    if (statusResponse) {
      const status = readResult<{ documentToken: string; revision: string; undoDepth: number; bodies: unknown[]; regions: unknown[] }>(statusResponse);
      if (status.documentToken === initial.documentToken) {
        while (status.undoDepth > initial.undoDepth) {
          const current = readResult<{ revision: string }>(await client.callTool({ name: "plasticity_undo", arguments: { intent: "Recover disposable Parasolid acceptance", revision: status.revision } }));
          status.revision = current.revision;
          status.undoDepth -= 1;
        }
      }
    }
    await writeExclusive(join(output, "failure.json"), evidence).catch(() => undefined);
  }
  await client.close().catch(() => undefined);
  await server.close().catch(() => undefined);
  await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
}
