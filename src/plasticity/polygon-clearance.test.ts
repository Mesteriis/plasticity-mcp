import assert from "node:assert/strict";
import { test } from "node:test";

import { measureNonparallelPolygonClearance, type Vector3 } from "./polygon-clearance.ts";

test("measures zero clearance where nonparallel simple polygon faces intersect", () => {
  const horizontal: Vector3[] = [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]];
  const vertical: Vector3[] = [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]];

  const result = measureNonparallelPolygonClearance([horizontal], [vertical]);

  assert.equal(result.distanceMm, 0);
  assert.ok(result.first.every((value, index) => Math.abs(value - result.second[index]!) < 1e-9));
  assert.ok(Math.abs(result.first[0] - 1) < 1e-9);
  assert.ok(Math.abs(result.first[2]) < 1e-9);
});

test("finds a boundary-to-face-interior clearance between nonparallel polygons", () => {
  const horizontal: Vector3[] = [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]];
  const vertical: Vector3[] = [[3, 0, 0], [3, 2, 0], [3, 2, 2], [3, 0, 2]];

  const result = measureNonparallelPolygonClearance([horizontal], [vertical]);

  assert.equal(result.distanceMm, 1);
  assert.deepEqual(result.first, [2, 0, 0]);
  assert.deepEqual(result.second, [3, 0, 0]);
});

test("measures an oblique skew clearance between nonparallel polygons", () => {
  const horizontal: Vector3[] = [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]];
  const oblique: Vector3[] = [[2, 0, 3], [4, 0, 3], [4, 2, 5], [2, 2, 5]];

  const result = measureNonparallelPolygonClearance([horizontal], [oblique]);

  assert.ok(Math.abs(result.distanceMm - 3) < 1e-9);
  assert.ok(Math.abs(result.first[2]) < 1e-9);
  assert.ok(Math.abs(result.second[2] - 3) < 1e-9);
});

test("respects the notch in a concave planar face", () => {
  const lShape: Vector3[] = [[0, 0, 0], [1.5, 0, 0], [3, 0, 0], [3, 1, 0], [1, 1, 0], [1, 3, 0], [0, 3, 0]];
  const vertical: Vector3[] = [[2, 1.5, -1], [2, 2.5, -1], [2, 2.5, 1], [2, 1.5, 1]];

  const result = measureNonparallelPolygonClearance([[...lShape].reverse()], [vertical]);

  assert.equal(result.distanceMm, 0.5);
  assert.deepEqual(result.first, [2, 1, 0]);
  assert.deepEqual(result.second, [2, 1.5, 0]);
});

test("keeps gaps between multiple disjoint face loops", () => {
  const islands: Vector3[][] = [
    [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]],
    [[4, 0, 0], [6, 0, 0], [6, 2, 0], [4, 2, 0]],
  ];
  const probe: Vector3[] = [[3, 0.5, -1], [3, 1.5, -1], [3, 1.5, 1], [3, 0.5, 1]];

  const result = measureNonparallelPolygonClearance(islands, [probe]);

  assert.equal(result.distanceMm, 1);
  assert.equal(Math.abs(result.first[0] - result.second[0]), 1);
});

test("rejects touching boundary loops instead of guessing their fill", () => {
  const outer: Vector3[] = [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]];
  const touching: Vector3[] = [[2, 0.5, 0], [3, 0.5, 0], [3, 1.5, 0], [2, 1.5, 0]];
  const probe: Vector3[] = [[4, 0, -1], [4, 2, -1], [4, 2, 1], [4, 0, 1]];

  assert.throws(() => measureNonparallelPolygonClearance([outer, touching], [probe]), /disjoint and non-touching/u);
});

test("bounds exact decomposition work for deeply nested loops", () => {
  const nested = Array.from({ length: 128 }, (_, index) => {
    const inset = index * 2;
    const far = 1000 - inset;
    return [[inset, inset, 0], [far, inset, 0], [far, far, 0], [inset, far, 0]] as Vector3[];
  });
  const probe: Vector3[] = [[500, 0, -1], [500, 1000, -1], [500, 1000, 1], [500, 0, 1]];

  assert.throws(() => measureNonparallelPolygonClearance(nested, [probe]), /4096-triangle decomposition limit/u);
});

test("rejects degenerate, self-intersecting, and parallel polygon inputs", () => {
  const square: Vector3[] = [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]];
  assert.throws(() => measureNonparallelPolygonClearance([[[0, 0, 0], [1, 0, 0]]], [[square[0]!, square[1]!, square[2]!, square[3]!]]), /at least three/u);
  assert.throws(() => measureNonparallelPolygonClearance([[[0, 0, 0], [2, 2, 0], [0, 2, 0], [2, 0, 0]]], [[[0, 0, 1], [2, 0, 1], [2, 2, 3], [0, 2, 3]]]), /simple polygon/u);
  assert.throws(() => measureNonparallelPolygonClearance([[square[0]!, square[1]!, square[2]!, square[3]!]], [[[0, 0, 1], [2, 0, 1], [2, 2, 1], [0, 2, 1]]]), /nonparallel/u);
});
