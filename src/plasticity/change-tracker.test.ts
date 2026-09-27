import assert from "node:assert/strict";
import { test } from "node:test";

import { diffScenes } from "./change-tracker.ts";
import { frameFromOriginNormalX, type ConstructionPlaneDescriptor } from "./construction.ts";
import type { RuntimeState } from "./runtime.ts";

function state(
  revision: string,
  bodies: RuntimeState["bodies"],
  documentToken = "doc-1",
  planes: ConstructionPlaneDescriptor[] = [],
  activePlaneId: string | null = "standard:top",
): RuntimeState {
  return {
    targetId: "window-1",
    title: "Part - Plasticity",
    documentToken,
    revision,
    dbVersion: 1,
    undoDepth: 0,
    redoDepth: 0,
    regions: [],
    bodies,
    construction: {
      planes,
      activePlaneId,
      planeStateToken: JSON.stringify(planes),
      viewStateToken: `workplane:${activePlaneId ?? "none"}`,
    },
  };
}

function body(id: number, versionId: number, name: string): RuntimeState["bodies"][number] {
  return {
    id,
    versionId,
    type: "Solid",
    name,
    boundsMm: { min: [0, 0, 0], max: [10, 10, 10] },
    faceIds: [`${versionId}f1`],
    edgeIds: [`${versionId}e1`],
    faces: [],
    edges: [],
  };
}

function face(id: string, centerMm: [number, number, number]): RuntimeState["bodies"][number]["faces"][number] {
  return {
    id, surfaceType: "Plane", planar: true, centerMm, normal: [0, 0, 1], radiusMm: null,
    blendRadiusMm: null, axisOriginMm: null, axisDirection: null,
    boundsMm: { min: [0, 0, 0], max: [10, 10, 0] }, edgeIds: ["e1"],
  };
}

function region(id: string, sketchWireIds: number[], maxX: number): RuntimeState["regions"][number] {
  return {
    id, entityId: Number(id), islandVersionId: Number(id), sketchId: 1, sketchWireIds,
    measurementSource: "render-mesh",
    displayBoundsMm: { min: [0, 0, 0], max: [maxX, 10, 0] },
  };
}

test("classifies bodies added, removed, renamed, and geometrically modified", () => {
  const previous = state("r1", [body(1, 1, "Base"), body(2, 2, "Remove")]);
  const renamedAndChanged = body(1, 3, "Edited base");
  renamedAndChanged.boundsMm = { min: [0, 0, 0], max: [20, 10, 10] };
  const current = state("r2", [renamedAndChanged, body(3, 4, "Added")]);

  const diff = diffScenes(previous, current);

  assert.deepEqual(diff.added.map((item) => item.id), [3]);
  assert.deepEqual(diff.removed.map((item) => item.id), [2]);
  assert.equal(diff.modified[0]?.id, 1);
  assert.equal(diff.modified[0]?.renamed, true);
  assert.equal(diff.modified[0]?.geometryChanged, true);
  assert.equal(diff.modified[0]?.appearanceChanged, false);
  assert.equal(diff.documentChanged, false);
});

test("detects in-place B-rep detail changes when version, bounds, and topology IDs match", () => {
  const before = body(1, 1, "Part");
  const after = body(1, 1, "Part");
  before.faces = [face("f1", [5, 5, 0])];
  after.faces = [face("f1", [5, 5, 0.25])];

  const diff = diffScenes(state("same-revision", [before]), state("same-revision", [after]));

  assert.equal(diff.changed, true);
  assert.equal(diff.modified[0]?.geometryChanged, true);
});

test("reports appearance assignments and material catalog changes separately from geometry", () => {
  const previousBody = { ...body(1, 1, "Part"), materialId: 0 };
  const currentBody = { ...previousBody, materialId: 4 };
  const previous = { ...state("r1", [previousBody]), materials: [] };
  const current = { ...state("r2", [currentBody]), materials: [{ id: 4, name: "Orange", colorHex: "#ff6600", roughness: 0.6, metalness: 0, opacity: 1 }] };

  const diff = diffScenes(previous, current);

  assert.equal(diff.materialsChanged, true);
  assert.equal(diff.modified[0]?.appearanceChanged, true);
  assert.equal(diff.modified[0]?.geometryChanged, false);
  assert.equal(diff.modified[0]?.renamed, false);
});

test("treats a material-only catalog update as a scene change even when revisions match", () => {
  const previous = { ...state("same-revision", []), materials: [] };
  const current = {
    ...state("same-revision", []),
    materials: [{ id: 4, name: "Orange", colorHex: "#ff6600", roughness: 0.6, metalness: 0, opacity: 1 }],
  };

  const diff = diffScenes(previous, current);

  assert.equal(diff.changed, true);
  assert.equal(diff.materialsChanged, true);
});

test("reports native measurement changes even when no body geometry changes", () => {
  const previous = { ...state("same-revision", [body(1, 1, "Part")]), measurements: [] };
  const measurement = {
    id: 1, versionId: 1, type: "DistanceMeasurement", name: "Width", measurementSource: "native-brep" as const,
    first: { bodyId: 1, topologyId: 101, landmark: 0, positionMm: [0, 0, 0] as [number, number, number] },
    second: { bodyId: 1, topologyId: 102, landmark: 0, positionMm: [10, 0, 0] as [number, number, number] },
    distanceMm: 10, direction: [1, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number], offsetMm: [-10, 0],
  };
  const current = { ...previous, measurements: [measurement] };

  const diff = diffScenes(previous, current);

  assert.equal(diff.changed, true);
  assert.equal(diff.measurementsChanged, true);
  assert.deepEqual(diff.modified, []);
});

test("reports native section-analysis changes without a B-Rep revision change", () => {
  const previous = { ...state("same-revision", [body(1, 1, "Part")]), sectionAnalyses: [] };
  const current = {
    ...previous,
    sectionAnalyses: [{ id: 1, versionId: 1, name: "Mid section", originMm: [0, 0, 5] as [number, number, number], normal: [0, 0, 1] as [number, number, number], visible: true, registeredViewportCount: 1 }],
  };

  const diff = diffScenes(previous, current);

  assert.equal(diff.changed, true);
  assert.equal(diff.sectionAnalysesChanged, true);
  assert.deepEqual(diff.modified, []);
});

test("reports native instance transform changes independently from source geometry", () => {
  const instance = {
    id: 0, type: "Instance" as const, targetKey: 10, targetName: "Part", sourceBodyIds: [1],
    translationMm: [0, 0, 0] as [number, number, number], rotationQuaternion: [0, 0, 0, 1] as [number, number, number, number],
    scale: [1, 1, 1] as [number, number, number], matrixWorldMm: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], visible: true, hidden: false, locked: false,
  };
  const previous = { ...state("same-revision", [body(1, 1, "Part")]), instances: [instance] };
  const current = { ...previous, instances: [{ ...instance, translationMm: [20, 0, 0] as [number, number, number] }] };

  const diff = diffScenes(previous, current);

  assert.equal(diff.changed, true);
  assert.equal(diff.instancesChanged, true);
  assert.deepEqual(diff.modified, []);
});

test("reports approximate reference-mesh changes independently from B-Rep geometry", () => {
  const mesh = {
    id: 0, type: "ReferenceMesh" as const, name: "phone.stl", sourcePath: "/tmp/phone.stl", sourceFormat: "stl" as const,
    measurementSource: "reference-mesh" as const,
    boundsMm: { min: [0, 0, 0] as [number, number, number], max: [72, 9, 158] as [number, number, number] },
    translationMm: [0, 0, 0] as [number, number, number], rotationQuaternion: [0, 0, 0, 1] as [number, number, number, number],
    sceneScaleToMeters: [0.001, 0.001, 0.001] as [number, number, number], vertexEntries: 36, triangles: 12,
    visible: true, hidden: false, locked: false,
  };
  const previous = { ...state("same-revision", []), referenceMeshes: [mesh] };
  const current = {
    ...previous,
    referenceMeshes: [{ ...mesh, translationMm: [10, 0, 0] as [number, number, number] }],
  };

  const diff = diffScenes(previous, current);

  assert.equal(diff.changed, true);
  assert.equal(diff.referenceMeshesChanged, true);
  assert.deepEqual(diff.modified, []);
});

test("reports native body visibility and lock changes separately from geometry", () => {
  const previousBody = { ...body(1, 1, "Part"), visible: true, hidden: false, locked: false };
  const currentBody = { ...previousBody, visible: false, hidden: true, locked: true };
  const diff = diffScenes(
    state("same-revision", [previousBody]),
    state("same-revision", [currentBody]),
  );

  assert.equal(diff.changed, true);
  assert.equal(diff.modified[0]?.visibilityChanged, true);
  assert.equal(diff.modified[0]?.geometryChanged, false);
  assert.equal(diff.modified[0]?.appearanceChanged, false);
  assert.equal(diff.modified[0]?.renamed, false);
});

test("reports native group hierarchy changes even when body geometry is unchanged", () => {
  const root = {
    id: 0, name: "Scene", parentId: null, childGroupIds: [] as number[], bodyIds: [1], instanceIds: [] as number[], referenceMeshIds: [] as number[],
    otherNodeKeys: [4], visible: true, hidden: false, locked: false,
  };
  const child = {
    id: 1, name: "Assembly", parentId: 0, childGroupIds: [] as number[], bodyIds: [1], instanceIds: [] as number[], referenceMeshIds: [] as number[],
    otherNodeKeys: [] as number[], visible: true, hidden: false, locked: false,
  };
  const previous = { ...state("same-revision", [body(1, 1, "Part")]), activeGroupId: 0, groups: [root] };
  const current = {
    ...previous,
    groups: [{ ...root, childGroupIds: [1], bodyIds: [] }, child],
  };

  const diff = diffScenes(previous, current);

  assert.equal(diff.changed, true);
  assert.equal(diff.groupsChanged, true);
  assert.deepEqual(diff.modified, []);
});

test("reports document replacement separately", () => {
  const previousBody = body(1, 1, "Old document body");
  const currentBody = body(1, 1, "New document body");
  const diff = diffScenes(state("r1", [previousBody]), state("r2", [currentBody], "doc-2"));

  assert.equal(diff.documentChanged, true);
  assert.deepEqual(diff.added, [currentBody]);
  assert.deepEqual(diff.removed, [previousBody]);
  assert.deepEqual(diff.modified, []);
});

test("reports saved construction planes added, removed, and modified", () => {
  const unchanged = plane("plane:1", "1", "Reference", 0);
  const removed = plane("plane:2", "2", "Remove", 2);
  const modifiedBefore = plane("plane:3", "3", "Before", 3);
  const modifiedAfter = plane("plane:3", "3", "After", 8);
  const added = plane("plane:4", "4", "Added", 4);

  const diff = diffScenes(
    state("r1", [], "doc-1", [unchanged, removed, modifiedBefore]),
    state("r2", [], "doc-1", [unchanged, modifiedAfter, added]),
  );

  assert.equal(diff.changed, true);
  assert.deepEqual(diff.constructionPlanesAdded.map((item) => item.nativeId), ["4"]);
  assert.deepEqual(diff.constructionPlanesRemoved.map((item) => item.nativeId), ["2"]);
  assert.deepEqual(diff.constructionPlanesModified.map((item) => item.nativeId), ["3"]);
  assert.equal(diff.activeWorkplaneChanged, null);
});

test("reports sketch regions added, removed, and modified", () => {
  const unchanged = region("1", [10], 10);
  const removed = region("2", [20], 20);
  const modifiedBefore = region("3", [30], 30);
  const modifiedAfter = region("3", [30, 31], 32);
  const added = region("4", [40], 40);
  const previous = { ...state("same-revision", []), regions: [unchanged, removed, modifiedBefore] };
  const current = { ...state("same-revision", []), regions: [unchanged, modifiedAfter, added] };

  const diff = diffScenes(previous, current);

  assert.equal(diff.changed, true);
  assert.deepEqual(diff.regionsAdded.map((item) => item.id), ["4"]);
  assert.deepEqual(diff.regionsRemoved.map((item) => item.id), ["2"]);
  assert.deepEqual(diff.regionsModified.map((item) => item.id), ["3"]);
});

test("counts construction-plane diffs as changes even if Plasticity revision is unchanged", () => {
  const before = state("same-revision", [], "doc-1", [plane("plane:1", "1", "Before", 2)]);
  const after = state("same-revision", [], "doc-1", [plane("plane:1", "1", "After", 5)]);

  const diff = diffScenes(before, after);

  assert.equal(diff.changed, true);
  assert.deepEqual(diff.constructionPlanesModified.map((item) => item.nativeId), ["1"]);
});

test("reports active workplane changes without requiring a revision change", () => {
  const previous = state("same-revision", [], "doc-1", [], "standard:top");
  const current = state("same-revision", [], "doc-1", [], "standard:front");

  const diff = diffScenes(previous, current);

  assert.equal(diff.changed, true);
  assert.equal(diff.fromRevision, diff.toRevision);
  assert.deepEqual(diff.activeWorkplaneChanged, {
    before: "standard:top",
    after: "standard:front",
  });
});

test("does not match reused saved-plane IDs across replacement documents", () => {
  const before = plane("plane:7", "7", "Old document", 1);
  const after = plane("plane:7", "7", "New document", 1);

  const diff = diffScenes(
    state("r1", [], "doc-1", [before]),
    state("r2", [], "doc-2", [after]),
  );

  assert.deepEqual(diff.constructionPlanesRemoved.map((item) => item.name), ["Old document"]);
  assert.deepEqual(diff.constructionPlanesAdded.map((item) => item.name), ["New document"]);
  assert.deepEqual(diff.constructionPlanesModified, []);
});

test("reports tracked datum identities made stale by revision and document changes", () => {
  const datum = { id: "point-1", sessionId: "session-1", documentToken: "doc-1", revision: "r1", kind: "datum-point" as const };
  const revised = diffScenes(state("r1", []), state("r2", []), [datum]);
  assert.equal(revised.revisionChanged, true);
  assert.equal(revised.sceneChanged, false);
  assert.equal(revised.changed, true);
  assert.deepEqual(revised.staleDatums, [{ ...datum, reason: "revision-changed" }]);

  const replaced = diffScenes(state("r1", []), state("r2", [], "doc-2"), [datum]);
  assert.deepEqual(replaced.staleDatums, [{ ...datum, reason: "document-changed" }]);
});

test("ignores a datum that was already stale when the snapshot was captured", () => {
  const stale = { id: "point-1", sessionId: "session-1", documentToken: "doc-1", revision: "older", kind: "datum-point" as const };
  const unchanged = state("r2", []);
  const diff = diffScenes(unchanged, unchanged, [stale]);
  assert.equal(diff.changed, false);
  assert.deepEqual(diff.staleDatums, []);
});

test("distinguishes a Plasticity revision advance from a reportable scene edit", () => {
  const diff = diffScenes(state("r1", [body(1, 1, "Part")]), state("r2", [body(1, 1, "Part")]));

  assert.equal(diff.revisionChanged, true);
  assert.equal(diff.sceneChanged, false);
  assert.equal(diff.changed, true);
});

function plane(id: string, nativeId: string, name: string, zMm: number): ConstructionPlaneDescriptor {
  return {
    id,
    nativeId,
    name,
    source: "saved",
    ...frameFromOriginNormalX([0, 0, zMm], [0, 0, 1], [1, 0, 0]),
  };
}
