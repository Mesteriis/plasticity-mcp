import assert from "node:assert/strict";
import { test } from "node:test";

import { frameFromOriginNormalX, type ConstructionPlaneDescriptor } from "./construction.ts";
import { DatumRegistry } from "./references.ts";

test("binds datum points to one session, document, and revision", () => {
  const registry = new DatumRegistry("session-a");
  registry.sync({ documentToken: "doc-a", revision: "r1" });
  const point = registry.addPoint({ type: "coordinates", pointMm: [1, 2, 3] }, [1, 2, 3]);

  assert.equal(registry.requireCurrentPoint(point.identity, "doc-a", "r1").id, point.id);
  assert.throws(() => registry.requireCurrentPoint(point.identity, "doc-a", "r2"), /stale/i);

  registry.sync({ documentToken: "doc-b", revision: "r1" });
  assert.throws(() => registry.get(point.id), /unknown/i);
});

test("rejects a reference issued by another registry session", () => {
  const first = new DatumRegistry("session-a");
  first.sync({ documentToken: "doc-a", revision: "r1" });
  const point = first.addPoint({ type: "coordinates", pointMm: [1, 2, 3] }, [1, 2, 3]);
  const second = new DatumRegistry("session-b");
  second.sync({ documentToken: "doc-a", revision: "r1" });

  assert.throws(() => second.requireCurrentPoint(point.identity, "doc-a", "r1"), /session/i);
});

test("refreshes geometry-backed datums into new immutable references", () => {
  const registry = new DatumRegistry("session-a");
  registry.sync({ documentToken: "doc-a", revision: "r1" });
  const original = registry.addPoint({ type: "face-center", bodyId: 7, faceId: "face-1" }, [0, 0, 0]);

  registry.sync({ documentToken: "doc-a", revision: "r2" });
  const refreshed = registry.refreshPoint(original.id, [4, 5, 6]);

  assert.notEqual(refreshed.id, original.id);
  assert.equal(refreshed.refreshedFromId, original.id);
  assert.deepEqual(refreshed.pointMm, [4, 5, 6]);
  assert.deepEqual(registry.get(original.id), original);
  assert.throws(() => registry.requireCurrentPoint(original.identity, "doc-a", "r2"), /stale/i);
  assert.equal(registry.requireCurrentPoint(refreshed.identity, "doc-a", "r2").id, refreshed.id);
});

test("normalizes resolved axes and refreshes them without changing the source", () => {
  const registry = new DatumRegistry("session-a");
  registry.sync({ documentToken: "doc-a", revision: "r1" });
  const axis = registry.addAxis(
    { type: "linear-edge", bodyId: 7, edgeId: "edge-1" },
    { originMm: [0, 0, 0], direction: [0, 0, 5] },
  );

  assert.deepEqual(axis.direction, [0, 0, 1]);
  registry.sync({ documentToken: "doc-a", revision: "r2" });
  const refreshed = registry.refreshAxis(axis.id, { originMm: [1, 0, 0], direction: [0, 3, 0] });
  assert.equal(refreshed.refreshedFromId, axis.id);
  assert.deepEqual(refreshed.direction, [0, 1, 0]);
  assert.deepEqual(axis.direction, [0, 0, 1]);
});

test("protects standard planes and binds saved planes to current state", () => {
  const registry = new DatumRegistry("session-a");
  registry.sync({ documentToken: "doc-a", revision: "r1" });
  const top = descriptor("standard:top", "Top", "standard", "top");
  const saved = descriptor("plane:7", "Fixture", "saved", "7");
  registry.syncPlanes([top, saved]);

  assert.equal(registry.requireCurrentPlane(registry.getPlane("standard:top").identity, "doc-a", "r1").nativeId, "top");
  assert.equal(registry.requireCurrentPlane(registry.getPlane("plane:7").identity, "doc-a", "r1").nativeId, "7");
  assert.throws(() => registry.deletePlane("standard:top"), /standard/i);
  assert.throws(() => registry.putPlane(
    descriptor("standard:top", "Replacement", "saved", "99"),
    { type: "explicit", originMm: [0, 0, 0], normal: [0, 0, 1], xDirection: [1, 0, 0] },
  ), /standard/i);

  registry.sync({ documentToken: "doc-a", revision: "r2" });
  assert.throws(() => registry.requireCurrentPlane(registry.getPlane("plane:7").identity, "doc-a", "r2"), /stale/i);
});

function descriptor(
  id: string,
  name: string,
  source: ConstructionPlaneDescriptor["source"],
  nativeId: string,
): ConstructionPlaneDescriptor {
  return { id, name, source, nativeId, ...frameFromOriginNormalX([0, 0, 0], [0, 0, 1], [1, 0, 0]) };
}
