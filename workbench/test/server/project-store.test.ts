import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import type { StructuredBlockInput } from "../../src/shared/contracts.ts";
import { ArtifactStore } from "../../src/server/artifact-store.ts";
import { openDatabase } from "../../src/server/database.ts";
import { ProjectRevisionConflict, SqliteProjectStore } from "../../src/server/project-store.ts";

const dimensionsBlock: StructuredBlockInput = {
  type: "dimensions",
  title: "Critical dimensions",
  rows: [
    {
      key: "width",
      label: "Width",
      value: 80,
      unit: "mm",
      source: "native-brep",
      confidence: "verified",
      status: "verified",
    },
  ],
};

test("persists a project and monotonically increments its revision", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-workbench-projects-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const databasePath = join(root, "project.sqlite");
  let database = openDatabase(databasePath);
  let projects = new SqliteProjectStore(database);

  const first = projects.create("Fold stand", root);
  const changed = projects.addStructuredBlock(first.id, 0, dimensionsBlock);
  assert.equal(changed.project.revision, 1);
  assert.equal(changed.value.type, "dimensions");
  database.close();

  database = openDatabase(databasePath);
  projects = new SqliteProjectStore(database);
  assert.equal(projects.get(first.id)?.revision, 1);
  assert.equal(projects.eventsAfter(first.id, 0).length, 2);
  database.close();
});

test("rejects a stale project mutation without writing an event", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-workbench-stale-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const database = openDatabase(join(root, "project.sqlite"));
  context.after(() => database.close());
  const projects = new SqliteProjectStore(database);
  const project = projects.create("Bracket", root);

  projects.addStructuredBlock(project.id, 0, dimensionsBlock);
  assert.throws(
    () => projects.addStructuredBlock(project.id, 0, dimensionsBlock),
    (error: unknown) => error instanceof ProjectRevisionConflict && error.currentRevision === 1,
  );
  assert.equal(projects.eventsAfter(project.id, 0).length, 2);
});

test("lists projects newest first", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-workbench-list-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const database = openDatabase(join(root, "project.sqlite"));
  context.after(() => database.close());
  const projects = new SqliteProjectStore(database);

  const first = projects.create("First", root);
  const second = projects.create("Second", root);

  assert.deepEqual(projects.list().map((project) => project.id), [second.id, first.id]);
});

test("keeps stale feedback attached to its captured model version", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-workbench-versioned-feedback-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const database = openDatabase(join(root, "project.sqlite"));
  context.after(() => database.close());
  const projects = new SqliteProjectStore(database);
  const artifacts = new ArtifactStore(join(root, "artifacts"), database);
  const project = projects.create("Versioned bracket", root);
  const artifact = await artifacts.put(Readable.from("ISO-10303-21"), { originalName: "bracket.step", mediaType: "model/step" });
  artifacts.attachToProject(project.id, artifact.hash);
  const input = { plasticityDocumentToken: "document", plasticityRevision: "revision-1", stepArtifactHash: artifact.hash, measurements: [] };
  const first = projects.addModelVersion(project.id, 0, input);
  projects.addModelVersion(project.id, 1, { ...input, plasticityRevision: "revision-2" });
  const feedback = projects.addAnnotationBatch(project.id, {
    expectedRevision: 2,
    modelVersionId: first.value.id,
    annotations: [{ kind: "note", text: "Увеличить радиус", anchor: { kind: "world", pointMm: [0, 0, 0] } }],
  });
  assert.equal(feedback.value[0]?.modelVersionId, first.value.id);
  assert.equal(feedback.value[0]?.remapStatus, "required");
});

test("accepts only validated keys and values from a published dimension form", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-workbench-dimensions-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const database = openDatabase(join(root, "project.sqlite"));
  context.after(() => database.close());
  const projects = new SqliteProjectStore(database);
  const project = projects.create("Validated enclosure", root);
  const published = projects.addStructuredBlock(project.id, 0, {
    type: "dimensions",
    title: "Корпус",
    rows: [{ key: "wall", label: "Стенка", value: 2, unit: "mm", source: "user", confidence: "verified", status: "verified", input: { min: 1.2, max: 5, step: 0.1 } }],
  });
  const changed = projects.addDimensionChanges(project.id, { expectedRevision: 1, blockId: published.value.id, changes: [{ key: "wall", value: 2.4 }] });
  assert.equal(changed.value.changes[0]?.value, 2.4);
  assert.equal(changed.project.revision, 2);
  assert.throws(() => projects.addDimensionChanges(project.id, { expectedRevision: 2, blockId: published.value.id, changes: [{ key: "wall", value: 0.8 }] }), /at least 1.2/);
  assert.throws(() => projects.addDimensionChanges(project.id, { expectedRevision: 2, blockId: published.value.id, changes: [{ key: "wall", value: 2.45 }] }), /step 0.1/);
  assert.equal(projects.get(project.id)?.revision, 2);
});

test("persists reference provenance and rejects unattached artifacts", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-workbench-references-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const database = openDatabase(join(root, "project.sqlite"));
  context.after(() => database.close());
  const projects = new SqliteProjectStore(database);
  const artifacts = new ArtifactStore(join(root, "artifacts"), database);
  const project = projects.create("Phone stand", root);
  const artifact = await artifacts.put(Readable.from("ISO-10303-21"), { originalName: "phone.step", mediaType: "model/step" });

  const reference = {
    label: "Official phone CAD",
    sourceKind: "official-manufacturer-cad" as const,
    format: "step" as const,
    sourceUrl: "https://example.com/phone.step",
    artifactHash: artifact.hash,
    license: "Manufacturer download terms",
    overallConfidence: "verified" as const,
    dimensions: [
      { key: "width", label: "Width", value: 72.8, unit: "mm" as const, confidence: "verified" as const, critical: true, sourceLocator: "native B-Rep" },
      { key: "hinge-clearance", label: "Hinge clearance", unit: "mm" as const, confidence: "measurement-required" as const, critical: true },
    ],
    sceneRole: "locked-reference" as const,
  };
  assert.throws(() => projects.addReference(project.id, 0, reference), /not attached/i);
  artifacts.attachToProject(project.id, artifact.hash);
  const added = projects.addReference(project.id, 0, reference);

  assert.equal(added.project.revision, 1);
  assert.equal(added.value.artifactHash, artifact.hash);
  assert.equal(projects.listReferences(project.id)[0]?.dimensions[1]?.confidence, "measurement-required");
});

test("persists exact construction journal checkpoints with project revisions", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-workbench-journal-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const database = openDatabase(join(root, "project.sqlite"));
  context.after(() => database.close());
  const projects = new SqliteProjectStore(database);
  const project = projects.create("Journaled bracket", root);
  const added = projects.addConstructionJournal(project.id, 0, {
    documentToken: "document-1",
    revision: "revision-2",
    syncStatus: "in-sync",
    entries: [{
      id: "3d5338f4-ff2a-47ce-a7bd-2309ae339889",
      operation: "create-box",
      intent: "Base plate",
      input: { sizeMm: [80, 40, 8] },
      documentToken: "document-1",
      beforeRevision: "revision-1",
      afterDocumentToken: "document-1",
      afterRevision: "revision-2",
      status: "completed",
      diff: { changed: true },
      error: null,
      occurredAt: "2026-09-20T10:00:00.000Z",
    }],
  });

  assert.equal(added.project.revision, 1);
  assert.equal(projects.listConstructionJournals(project.id)[0]?.entries[0]?.operation, "create-box");
});
