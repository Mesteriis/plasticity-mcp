import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { StepImportReferenceStore } from "./import-reference-store.ts";

test("STEP import provenance survives store recreation and remains immutable", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-step-import-store-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const store = new StepImportReferenceStore(root);
  const record = await store.create({
    artifactHash: "a".repeat(64),
    sourcePath: "/tmp/part.step",
    sourceArchive: { sha256: "b".repeat(64), bytes: 3_284, memberPath: "Cad/part.step" },
    documentToken: "document-token",
    revision: "revision-7",
    documentTitle: "Bracket.plasticity",
    bodies: [{ id: 17, type: "Solid", name: "Imported bracket", boundsMm: { min: [0, 0, 0], max: [40, 20, 5] }, faceCount: 6, edgeCount: 12 }],
  });

  const restarted = new StepImportReferenceStore(root);
  assert.deepEqual(await restarted.get(record.id), record);
  assert.deepEqual((await restarted.list()).records[0]?.sourceArchive, record.sourceArchive);
  assert.deepEqual(await restarted.list(), { total: 1, offset: 0, limit: 20, records: [record] });
  assert.equal((await stat(join(root, `${record.id}.json`))).mode & 0o777, 0o600);
  await assert.rejects(() => restarted.create({ ...record, artifactHash: "b".repeat(64) }), /EEXIST/);
  assert.deepEqual(await restarted.get(record.id), record);
});

test("STEP import provenance rejects invalid hashes, bounds, IDs, and page limits", async () => {
  const store = new StepImportReferenceStore();
  await assert.rejects(() => store.create({
    artifactHash: "not-a-hash",
    sourcePath: "/tmp/part.step",
    documentToken: "document-token",
    revision: "revision-7",
    documentTitle: "Bracket.plasticity",
    bodies: [],
  }), /artifactHash/);
  await assert.rejects(() => store.get("../part"), /UUID/);
  await assert.rejects(() => store.list(0, 101), /1 to 100/);
});

test("3MF reference import provenance survives store recreation with every imported mesh", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-3mf-import-store-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const store = new StepImportReferenceStore(root);
  const record = await store.create({
    artifactHash: "c".repeat(64),
    format: "3mf",
    sourcePath: "/private/reference-artifacts/c.3mf",
    acquisition: { bytes: 8_192, finalUrl: "https://cad.example/assets/assembly.3mf" },
    sourceReference: {
      sourceKind: "verified-community-cad",
      sourceUrl: "https://cad.example/assets/assembly.3mf",
      sourcePageUrl: "https://cad.example/assembly",
      license: "CC0-1.0",
      confidence: "verified",
      artifactHash: "c".repeat(64),
      format: "3mf",
      geometryKind: "approximate-reference-mesh",
      unitSource: "embedded-3mf-model-metadata",
      exactGeometry: false,
    },
    documentToken: "document-token",
    revision: "revision-7",
    documentTitle: "Assembly review.plasticity",
    bodies: [],
    referenceMeshes: [
      { id: 4, name: "Bracket half A", sourcePath: "/private/reference-artifacts/c.3mf", boundsMm: { min: [0, 0, 0], max: [20, 10, 10] }, vertexEntries: 12, triangles: 4 },
      { id: 5, name: "Bracket half B", sourcePath: "/private/reference-artifacts/c.3mf", boundsMm: { min: [20, 0, 0], max: [40, 10, 10] }, vertexEntries: 24, triangles: 8 },
    ],
  });

  const restarted = new StepImportReferenceStore(root);
  assert.deepEqual(await restarted.get(record.id), record);
  assert.deepEqual((await restarted.list()).records[0]?.referenceMeshes, record.referenceMeshes);
  assert.equal((await stat(join(root, `${record.id}.json`))).mode & 0o777, 0o600);
  await assert.rejects(() => restarted.create({
    ...record,
    artifactHash: "d".repeat(64),
    sourceReference: record.sourceReference ? { ...record.sourceReference, artifactHash: "d".repeat(64) } : undefined,
  }), /EEXIST/);
  assert.deepEqual(await restarted.get(record.id), record);
});
