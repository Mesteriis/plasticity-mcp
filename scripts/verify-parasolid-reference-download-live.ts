import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { ConstructionHistoryStore } from "../src/plasticity/construction-history.ts";
import { StepImportReferenceStore } from "../src/plasticity/import-reference-store.ts";
import { StepReferenceDownloader } from "../src/plasticity/step-reference-downloader.ts";
import { createServer, PlasticitySession } from "../src/server.ts";

const targetId = process.argv[2];
const sourceUrl = process.argv[3];
const sourcePageUrl = process.argv[4];
if (!targetId || !sourceUrl) {
  throw new Error("Usage: npm run accept:parasolid-reference-download -- <explicit-Plasticity-target-id> <public-https-parasolid-or-zip-url> [source-page-url]");
}

const workspace = await mkdtemp(join(tmpdir(), "plasticity-parasolid-reference-download-live-"));
const referencesRoot = join(workspace, "references");
const historyRoot = join(workspace, "history");
const artifactsRoot = join(workspace, "artifacts");

function readResult<T>(value: unknown): T {
  if (typeof value !== "object" || value === null || !("content" in value) || !Array.isArray(value.content)) throw new Error("MCP tool returned no content");
  const text = value.content.find((item) => typeof item === "object" && item !== null && "text" in item && typeof item.text === "string");
  if (!text || typeof text !== "object" || !("text" in text) || typeof text.text !== "string") throw new Error("MCP tool returned no text result");
  const parsed = JSON.parse(text.text) as T;
  if ("isError" in value && value.isError === true) throw new Error(`MCP tool failed: ${text.text}`);
  return parsed;
}

function sceneSignature(state: any): string {
  return JSON.stringify({
    documentToken: state.documentToken,
    title: state.title,
    bodies: state.bodies,
    regions: state.regions,
    construction: state.construction,
    materials: state.materials ?? [],
    measurements: state.measurements ?? [],
    sectionAnalyses: state.sectionAnalyses ?? [],
    instances: state.instances ?? [],
    referenceMeshes: state.referenceMeshes ?? [],
    activeGroupId: state.activeGroupId ?? null,
    groups: state.groups ?? [],
    undoDepth: state.undoDepth,
  });
}

let active: { session: PlasticitySession; server: ReturnType<typeof createServer>; client: Client } | undefined;
const startMcp = async () => {
  const session = new PlasticitySession();
  const server = createServer(
    session,
    undefined,
    undefined,
    new StepImportReferenceStore(referencesRoot),
    new ConstructionHistoryStore(historyRoot),
    new StepReferenceDownloader({ root: artifactsRoot }),
  );
  const client = new Client({ name: "plasticity-parasolid-reference-download-live", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  active = { session, server, client };
};
const stopMcp = async () => {
  const current = active;
  active = undefined;
  if (!current) return;
  await current.client.close().catch(() => undefined);
  await current.server.close().catch(() => undefined);
};
const call = async <T>(name: string, args: Record<string, unknown> = {}) => {
  if (!active) throw new Error("Acceptance MCP client is not connected");
  return readResult<T>(await active.client.callTool(
    { name, arguments: args },
    undefined,
    { timeout: 300_000, onprogress: ({ progress, message }) => console.error(`${progress} ms: ${message ?? `${name} is still running`}`) },
  ));
};
let importedRevision: string | undefined;
let importCompleted = false;

try {
  await startMcp();
  await call("plasticity_connect", { targetId });
  const before = await call<any>("plasticity_status");
  const beforeSignature = sceneSignature(before);
  const beforeBodyIds = new Set<number>(before.bodies.map((body: { id: number }) => body.id));
  const imported = await call<{
    importedArtifactHash: string;
    referenceRecordId: string;
    provenancePersisted: boolean;
    acquisition: { bytes: number; finalUrl: string; sourceArchive?: { sha256: string; bytes: number; memberPath: string } };
    sourceReference: { artifactHash: string; sourceUrl: string };
    revision: string;
  }>("plasticity_download_and_import_parasolid", {
    source: {
      sourceKind: "verified-community-cad",
      sourceUrl,
      confidence: "approximate",
      ...(sourcePageUrl ? { sourcePageUrl } : {}),
    },
    representation: "x_t",
    intent: "Verify official Parasolid ZIP acquisition, native import and reversible recovery",
    revision: before.revision,
  });
  importCompleted = true;
  importedRevision = imported.revision;
  assert.ok(imported.revision.length <= 512, "Scene revisions must remain persistable for imported assemblies");
  assert.equal(imported.provenancePersisted, true);
  assert.equal(imported.sourceReference.artifactHash, imported.importedArtifactHash);
  assert.ok(imported.acquisition.bytes > 0);
  if (sourceUrl.toLowerCase().endsWith(".zip")) assert.ok(imported.acquisition.sourceArchive, "ZIP imports must retain archive provenance");
  const state = await call<any>("plasticity_status");
  const importedBodies = state.bodies.filter((body: { id: number }) => !beforeBodyIds.has(body.id));
  assert.ok(importedBodies.length > 0, "Parasolid import should create native CAD bodies");
  for (const body of importedBodies) {
    assert.ok(body.boundsMm, "Imported body should expose native B-Rep bounds");
    for (const dimension of [0, 1, 2]) assert.ok(body.boundsMm.max[dimension]! > body.boundsMm.min[dimension]!);
  }

  await stopMcp();
  await startMcp();
  await call("plasticity_connect", { targetId });
  const restartedState = await call<{ bodies: unknown[]; documentToken: string; revision: string }>("plasticity_status");
  assert.equal(restartedState.documentToken, state.documentToken, "MCP restart should reconnect to the same Plasticity document");
  assert.equal(restartedState.revision, state.revision, "MCP restart should leave native CAD unchanged");
  assert.equal(sceneSignature(restartedState), sceneSignature(state), "MCP restart should preserve the entire native scene");
  const record = await call<{ artifactHash: string; format?: string; historical: boolean; sourceArchive?: { memberPath: string }; sourceReference?: { sourceUrl: string } }>("plasticity_get_cad_reference_import", { id: imported.referenceRecordId });
  assert.equal(record.artifactHash, imported.importedArtifactHash);
  assert.equal(record.format, "parasolid");
  assert.equal(record.historical, true, "Reference body IDs are always historical provenance, never current references");
  assert.equal(record.sourceReference?.sourceUrl, imported.sourceReference.sourceUrl);
  assert.equal(record.sourceArchive?.memberPath, imported.acquisition.sourceArchive?.memberPath);
  const historyAfterRestart = await call<{ total: number; entries: Array<{ operation: string; status: string }> }>("plasticity_construction_history", { limit: 10 });
  assert.equal(historyAfterRestart.total, 1, "Durable construction history should survive MCP restart");
  assert.deepEqual(historyAfterRestart.entries.map((entry) => [entry.operation, entry.status]), [["import-parasolid", "completed"]]);

  await call("plasticity_undo", { revision: restartedState.revision });
  importCompleted = false;
  const recovered = await call<{ bodies: unknown[]; revision: string }>("plasticity_status");
  assert.equal(sceneSignature(recovered), beforeSignature, "Undo should restore the original scene exactly");
  const events = await call<{ total: number; entries: Array<{ operation: string; status: string }> }>("plasticity_construction_history", { limit: 10 });
  assert.equal(events.total, 2);
  assert.deepEqual(events.entries.map((entry) => entry.operation), ["undo", "import-parasolid"]);
  assert.ok(events.entries.every((entry) => entry.status === "completed"));
  const liveJournal = await call<{ durableSyncStatus: string }>("plasticity_construction_journal");
  assert.equal(liveJournal.durableSyncStatus, "in-sync");
  const importedBounds: Array<{ min: number[]; max: number[] }> = importedBodies.flatMap((body: { boundsMm: { min: number[]; max: number[] } | null }) => body.boundsMm ? [body.boundsMm] : []);
  const assemblyBoundsMm = {
    min: [0, 1, 2].map((axis) => Math.min(...importedBounds.map((bounds) => bounds.min[axis]!))),
    max: [0, 1, 2].map((axis) => Math.max(...importedBounds.map((bounds) => bounds.max[axis]!))),
  };
  console.log(JSON.stringify({
    targetId,
    extractedCadBytes: imported.acquisition.bytes,
    artifactHash: imported.importedArtifactHash,
    sourceArchive: imported.acquisition.sourceArchive,
    nativeBodyCount: importedBodies.length,
    assemblyBoundsMm,
    referenceRecordId: imported.referenceRecordId,
    mcpRestartPreservedScene: true,
    referenceRecordRecoveredAfterRestart: record.artifactHash === imported.importedArtifactHash,
    constructionHistoryRecoveredAfterRestart: historyAfterRestart.total === 1,
    durableHistoryEvents: events.total,
    undoRestoredOriginalScene: true,
    durableSyncStatus: liveJournal.durableSyncStatus,
  }, null, 2));
} finally {
  if (importCompleted && importedRevision) {
    // Recover only the known, successfully returned import. Unknown MCP outcomes
    // are intentionally left untouched for explicit inspection.
    const state = await active?.session.get().state(300_000).catch(() => undefined);
    if (state && state.revision === importedRevision) {
      await call("plasticity_undo", { revision: state.revision }).catch(() => undefined);
    }
  }
  await stopMcp();
  await rm(workspace, { recursive: true, force: true });
}
