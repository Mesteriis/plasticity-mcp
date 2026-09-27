import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ConstructionHistoryStore, type ConstructionHistoryEntry } from "./construction-history.ts";

test("construction history survives a new MCP store instance and pages newest first", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-construction-history-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const store = new ConstructionHistoryStore(root);
  const first = historyEntry("2026-09-24T10:00:00.000Z", "completed");
  const second = historyEntry("2026-09-24T10:00:01.000Z", "unknown");
  await store.append(first);
  await store.append(second);

  const restarted = new ConstructionHistoryStore(root);
  const page = await restarted.list(0, 1);
  assert.equal(page.total, 2);
  assert.deepEqual(page.entries, [second]);
  assert.equal(page.entries[0]?.change.added[0]?.boundsMm?.max[0], 40);
  const remainder = await restarted.list(1, 1);
  assert.deepEqual(remainder.entries, [first]);
  const filename = (await readdir(root)).find((name) => name.endsWith(`${first.id}.json`))!;
  assert.equal((await stat(join(root, filename))).mode & 0o777, 0o600);
});

test("construction history rejects invalid pagination and symbolic-link records", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-construction-history-links-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const store = new ConstructionHistoryStore();
  await assert.rejects(() => store.list(-1), /non-negative integer/);
  await assert.rejects(() => store.list(0, 101), /1 to 100/);
  const source = join(root, "source.json");
  await writeFile(source, "{}");
  await symlink(source, join(root, "20260924120000000-33333333-3333-4333-8333-333333333333.json"));
  await assert.rejects(() => new ConstructionHistoryStore(root).list(), /symbolic link/);
});

function historyEntry(occurredAt: string, status: ConstructionHistoryEntry["status"]): ConstructionHistoryEntry {
  return {
    id: occurredAt.endsWith("000Z") ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222",
    occurredAt,
    operation: "create-box",
    intent: "Test durable journal entry",
    input: { sizeMm: [40, 20, 5] },
    documentToken: "document-1",
    beforeRevision: "revision-1",
    afterDocumentToken: "document-1",
    afterRevision: status === "completed" ? "revision-2" : null,
    status,
    error: status === "unknown" ? "connection closed" : null,
    change: {
      changed: true,
      documentChanged: false,
      added: [{ id: 4, type: "Solid", name: "Plate", boundsMm: { min: [0, 0, 0], max: [40, 20, 5] }, faceCount: 6, edgeCount: 12 }],
      removed: [],
      modified: [],
      addedConstructionPlaneIds: [],
      removedConstructionPlaneIds: [],
      modifiedConstructionPlaneIds: [],
      activeWorkplaneChanged: false,
      materialsChanged: false,
      measurementsChanged: false,
      sectionAnalysesChanged: false,
      instancesChanged: false,
      referenceMeshesChanged: false,
      groupsChanged: false,
      staleDatumCount: 0,
    },
  };
}
