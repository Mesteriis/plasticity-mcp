import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { ConstructionHistoryStore } from "../src/plasticity/construction-history.ts";
import { StepImportReferenceStore } from "../src/plasticity/import-reference-store.ts";
import { StepReferenceDownloader } from "../src/plasticity/step-reference-downloader.ts";
import { createServer, PlasticitySession } from "../src/server.ts";

const targetId = process.argv[2];
const sourceUrl = process.argv[3];
const sourceKind = process.argv[4] ?? "verified-community-cad";
const sourcePageUrl = process.argv[5];
if (!targetId || !sourceUrl) throw new Error("Usage: npm run accept:step-reference-download -- <explicit-empty-Plasticity-target-id> <public-https-step-or-zip-url> [source-kind] [source-page-url]");
if (!(["official-manufacturer-cad", "official-documentation", "official-distributor-cad", "established-cad-library", "verified-community-cad"] as const).includes(sourceKind as never)) {
  throw new Error("Unsupported source-kind");
}

const workspace = await mkdtemp(join(tmpdir(), "plasticity-step-reference-download-live-"));
const references = new StepImportReferenceStore(join(workspace, "references"));
const history = new ConstructionHistoryStore(join(workspace, "history"));
const downloader = new StepReferenceDownloader({ root: join(workspace, "artifacts") });

function readResult<T>(value: unknown): T {
  if (typeof value !== "object" || value === null || !("content" in value) || !Array.isArray(value.content)) throw new Error("MCP tool returned no content");
  const text = value.content.find((item) => typeof item === "object" && item !== null && "text" in item && typeof item.text === "string");
  if (!text || typeof text !== "object" || !("text" in text) || typeof text.text !== "string") throw new Error("MCP tool returned no text result");
  const parsed = JSON.parse(text.text) as T;
  if ("isError" in value && value.isError === true) throw new Error(`MCP tool failed: ${text.text}`);
  return parsed;
}

const session = new PlasticitySession();
const server = createServer(session, undefined, undefined, references, history, downloader);
const client = new Client({ name: "plasticity-step-reference-download-live", version: "1.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);
const call = async <T>(name: string, args: Record<string, unknown> = {}) => readResult<T>(await client.callTool(
  { name, arguments: args },
  undefined,
  { timeout: 300_000, onprogress: ({ progress, message }) => console.error(`${progress} ms: ${message ?? `${name} is still running`}`) },
));
let importedRevision: string | undefined;
let importCompleted = false;

try {
  await call("plasticity_connect", { targetId });
  const before = await call<{ bodies: unknown[]; revision: string }>("plasticity_status");
  assert.equal(before.bodies.length, 0, "The selected Plasticity document must be empty before the disposable download/import test");
  const imported = await call<{
    importedArtifactHash: string;
    referenceRecordId: string;
    provenancePersisted: boolean;
    acquisition: { bytes: number; finalUrl: string; sourceArchive?: { sha256: string; bytes: number; memberPath: string } };
    sourceReference: { confidence: string; artifactHash: string; sourceUrl: string };
    revision: string;
  }>("plasticity_download_and_import_step", {
      source: {
        sourceKind,
        sourceUrl,
        confidence: "approximate",
        ...(sourcePageUrl ? { sourcePageUrl } : {}),
      },
      intent: "Verify public STEP acquisition, native import and reversible recovery",
      revision: before.revision,
    });
  importCompleted = true;
  importedRevision = imported.revision;
  assert.ok(imported.revision.length <= 512, "Scene revisions must remain persistable for imported assemblies");
  assert.equal(imported.provenancePersisted, true);
  assert.equal(imported.sourceReference.artifactHash, imported.importedArtifactHash);
  assert.ok(imported.acquisition.bytes > 0);
  if (sourceUrl.toLowerCase().endsWith(".zip")) assert.ok(imported.acquisition.sourceArchive, "ZIP imports must retain archive provenance");
  const state = await call<{ bodies: Array<{ boundsMm: { min: number[]; max: number[] } | null }>; revision: string }>("plasticity_status");
  assert.ok(state.bodies.length > 0, "STEP import should create native CAD bodies");
  for (const body of state.bodies) {
    assert.ok(body.boundsMm, "Imported body should expose native B-Rep bounds");
    for (const dimension of [0, 1, 2]) assert.ok(body.boundsMm.max[dimension]! > body.boundsMm.min[dimension]!);
  }
  const record = await call<{ artifactHash: string; historical: boolean; sourceReference?: { sourceUrl: string } }>("plasticity_get_step_import", { id: imported.referenceRecordId });
  assert.equal(record.artifactHash, imported.importedArtifactHash);
  assert.equal(record.historical, true, "Reference body IDs are always historical provenance, never current references");
  assert.equal(record.sourceReference?.sourceUrl, imported.sourceReference.sourceUrl);

  await call("plasticity_undo", { revision: state.revision });
  importCompleted = false;
  const recovered = await call<{ bodies: unknown[]; revision: string }>("plasticity_status");
  assert.equal(recovered.bodies.length, 0, "Undo should restore the original empty scene");
  const events = await call<{ total: number; entries: Array<{ operation: string; status: string }> }>("plasticity_construction_history", { limit: 10 });
  assert.equal(events.total, 2);
  assert.deepEqual(events.entries.map((entry) => entry.operation), ["undo", "import-step"]);
  assert.ok(events.entries.every((entry) => entry.status === "completed"));
  const liveJournal = await call<{ durableSyncStatus: string }>("plasticity_construction_journal");
  assert.equal(liveJournal.durableSyncStatus, "in-sync");
  const importedBounds = state.bodies.flatMap((body) => body.boundsMm ? [body.boundsMm] : []);
  const assemblyBoundsMm = {
    min: [0, 1, 2].map((axis) => Math.min(...importedBounds.map((bounds) => bounds.min[axis]!))),
    max: [0, 1, 2].map((axis) => Math.max(...importedBounds.map((bounds) => bounds.max[axis]!))),
  };
  console.log(JSON.stringify({
    targetId,
    extractedCadBytes: imported.acquisition.bytes,
    artifactHash: imported.importedArtifactHash,
    sourceArchive: imported.acquisition.sourceArchive,
    nativeBodyCount: state.bodies.length,
    assemblyBoundsMm,
    referenceRecordId: imported.referenceRecordId,
    durableHistoryEvents: events.total,
    undoRestoredEmptyScene: recovered.bodies.length === 0,
    durableSyncStatus: liveJournal.durableSyncStatus,
  }, null, 2));
} finally {
  if (importCompleted && importedRevision) {
    // Recover only the known, successfully returned import. Unknown MCP outcomes
    // are intentionally left untouched for explicit inspection.
    const state = await session.get().state(300_000).catch(() => undefined);
    if (state && state.revision === importedRevision) {
      await call("plasticity_undo", { revision: state.revision }).catch(() => undefined);
    }
  }
  await client.close().catch(() => undefined);
  await server.close().catch(() => undefined);
  await rm(workspace, { recursive: true, force: true });
}
