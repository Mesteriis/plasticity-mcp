import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { ConstructionHistoryStore } from "../src/plasticity/construction-history.ts";
import { StepImportReferenceStore } from "../src/plasticity/import-reference-store.ts";
import { createServer, PlasticitySession } from "../src/server.ts";

const targetId = process.argv[2];
if (!targetId) throw new Error("Usage: npm run accept:step-reference-store -- <explicit-Plasticity-target-id>");

const workspace = await mkdtemp(join(tmpdir(), "plasticity-step-reference-live-"));
const stepPath = join(workspace, "reference.step");
const storeRoot = join(workspace, "references");
const store = new StepImportReferenceStore(storeRoot);
const historyStore = new ConstructionHistoryStore(join(workspace, "history"));

function readResult<T>(value: unknown): T {
  if (typeof value !== "object" || value === null || !("content" in value) || !Array.isArray(value.content)) {
    throw new Error("MCP tool returned no content");
  }
  const error = "isError" in value && value.isError === true;
  const text = value.content.find((item) => typeof item === "object" && item !== null && "text" in item && typeof item.text === "string");
  if (!text || typeof text !== "object" || !("text" in text) || typeof text.text !== "string") throw new Error("MCP tool returned no text result");
  const parsed = JSON.parse(text.text) as T;
  if (error) throw new Error(`MCP tool failed: ${text.text}`);
  return parsed;
}

async function startMcp() {
  const session = new PlasticitySession();
  const server = createServer(session, undefined, undefined, store, historyStore);
  const client = new Client({ name: "plasticity-step-reference-live-acceptance", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { server, client, call: async <T>(name: string, args: Record<string, unknown> = {}) => readResult<T>(await client.callTool({ name, arguments: args })) };
}

let active: Awaited<ReturnType<typeof startMcp>> | undefined;
try {
  active = await startMcp();
  await active.call("plasticity_connect", { targetId });
  const before = await active.call<{ bodies: unknown[]; revision: string }>("plasticity_status");
  assert.equal(before.bodies.length, 0, "The selected Plasticity document must be empty before the disposable test");

  await active.call("plasticity_create_box", {
    originMm: [0, 0, 0], sizeMm: [10, 20, 30], name: "STEP provenance acceptance box", revision: before.revision,
  });
  const created = await active.call<{ bodies: Array<{ id: number; boundsMm: { min: number[]; max: number[] } | null }>; revision: string }>("plasticity_status");
  assert.equal(created.bodies.length, 1);
  const sourceBody = created.bodies[0]!;
  assert.ok(sourceBody.boundsMm);
  await active.call("plasticity_export_step", { ids: [sourceBody.id], path: stepPath, revision: created.revision });
  await active.call("plasticity_undo", { revision: (await active.call<{ revision: string }>("plasticity_status")).revision });
  assert.equal((await active.call<{ bodies: unknown[] }>("plasticity_status")).bodies.length, 0, "Undo should restore the original empty scene");

  const empty = await active.call<{ revision: string }>("plasticity_status");
  const imported = await active.call<{ importedArtifactHash: string; referenceRecordId: string; provenancePersisted: boolean }>("plasticity_import_step", {
    path: stepPath, intent: "Verify durable STEP provenance with a disposable exact B-Rep", revision: empty.revision,
  });
  assert.equal(imported.provenancePersisted, true);
  const importedState = await active.call<{ bodies: Array<{ id: number; type: string; boundsMm: { min: number[]; max: number[] } | null }>; revision: string }>("plasticity_status");
  assert.equal(importedState.bodies.length, 1);
  const bounds = importedState.bodies[0]!.boundsMm;
  assert.ok(bounds);
  for (const [index, dimension] of [10, 20, 30].entries()) {
    assert.ok(Math.abs(bounds.max[index]! - bounds.min[index]! - dimension) <= 0.01, `Imported dimension ${index} differs from ${dimension} mm`);
  }

  await active.client.close();
  await active.server.close();
  active = await startMcp();
  await active.call("plasticity_connect", { targetId });
  const list = await active.call<{ total: number; records: Array<{ id: string; artifactHash: string; historical: boolean }> }>("plasticity_list_step_imports");
  assert.equal(list.total, 1);
  assert.equal(list.records[0]?.id, imported.referenceRecordId);
  assert.equal(list.records[0]?.artifactHash, imported.importedArtifactHash);
  assert.equal(list.records[0]?.historical, true);
  const record = await active.call<{ bodies: Array<{ boundsMm: { min: number[]; max: number[] } | null }>; historical: boolean }>("plasticity_get_step_import", { id: imported.referenceRecordId });
  assert.equal(record.historical, true);
  assert.deepEqual(record.bodies[0]?.boundsMm, bounds);

  await active.call("plasticity_undo", { revision: (await active.call<{ revision: string }>("plasticity_status")).revision });
  assert.equal((await active.call<{ bodies: unknown[] }>("plasticity_status")).bodies.length, 0, "Final Undo should restore the selected document");
  const history = await active.call<{ total: number; entries: Array<{ operation: string; status: string }> }>("plasticity_construction_history", { limit: 10 });
  assert.equal(history.total, 4, "Create, Undo, STEP import, and final Undo should be durable history events");
  assert.deepEqual(history.entries.map((entry) => entry.operation), ["undo", "import-step", "undo", "create-box"]);
  assert.ok(history.entries.every((entry) => entry.status === "completed"));
  const liveJournal = await active.call<{ durableSyncStatus: string }>("plasticity_construction_journal");
  assert.equal(liveJournal.durableSyncStatus, "in-sync");
  console.log(JSON.stringify({ targetId, dimensionsMm: [10, 20, 30], artifactHash: imported.importedArtifactHash, referenceRecordId: imported.referenceRecordId, survivedMcpRestart: true, durableHistoryEvents: history.total, durableSyncStatus: liveJournal.durableSyncStatus, finalBodyCount: 0 }, null, 2));
} finally {
  if (active) {
    await active.client.close().catch(() => undefined);
    await active.server.close().catch(() => undefined);
  }
  await rm(workspace, { recursive: true, force: true });
}
