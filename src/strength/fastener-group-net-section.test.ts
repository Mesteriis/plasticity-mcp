import assert from "node:assert/strict";
import test from "node:test";

import { calculateMinimumStraightNetWidth } from "./fastener-group-net-section.ts";

test("finds the minimum straight net width through a row of exact circular holes", () => {
  const result = calculateMinimumStraightNetWidth({
    grossWidthMm: 40,
    holes: [
      { id: "a", centerOffsetMm: 18, diameterMm: 6 },
      { id: "b", centerOffsetMm: 18, diameterMm: 6 },
      { id: "c", centerOffsetMm: 18, diameterMm: 6 },
    ],
  });

  assert.equal(result.minimumNetWidthMm, 22);
  assert.equal(result.criticalOffsetMm, 18);
  assert.deepEqual(result.intersectedHoles, [
    { id: "a", chordWidthMm: 6 },
    { id: "b", chordWidthMm: 6 },
    { id: "c", chordWidthMm: 6 },
  ]);
});

test("maximizes staggered hole chords between their centers", () => {
  const result = calculateMinimumStraightNetWidth({
    grossWidthMm: 30,
    holes: [
      { id: "lower", centerOffsetMm: 10, diameterMm: 6 },
      { id: "upper", centerOffsetMm: 14, diameterMm: 6 },
    ],
  });

  const expectedRemovedWidth = 4 * Math.sqrt(5);
  assert.ok(Math.abs(result.criticalOffsetMm - 12) < 1e-9);
  assert.ok(Math.abs(result.minimumNetWidthMm - (30 - expectedRemovedWidth)) < 1e-9);
});

test("compares separate chord-overlap bands instead of assuming one critical row", () => {
  const result = calculateMinimumStraightNetWidth({
    grossWidthMm: 32,
    holes: [
      { id: "cluster-a", centerOffsetMm: 5, diameterMm: 6 },
      { id: "cluster-b", centerOffsetMm: 7, diameterMm: 6 },
      { id: "single", centerOffsetMm: 25, diameterMm: 6 },
    ],
  });

  const removedWidth = 4 * Math.sqrt(8);
  assert.ok(Math.abs(result.criticalOffsetMm - 6) < 1e-9);
  assert.ok(Math.abs(result.minimumNetWidthMm - (32 - removedWidth)) < 1e-9);
  assert.deepEqual(result.intersectedHoles.map((hole) => hole.id), ["cluster-a", "cluster-b"]);
});

test("uses the gross width when the cut misses every hole and rejects invalid geometry", () => {
  const result = calculateMinimumStraightNetWidth({
    grossWidthMm: 30,
    holes: [{ id: "center", centerOffsetMm: 15, diameterMm: 4 }],
  });
  assert.equal(result.minimumNetWidthMm, 26);

  assert.throws(() => calculateMinimumStraightNetWidth({ grossWidthMm: 0, holes: [] }), /gross width/i);
  assert.throws(() => calculateMinimumStraightNetWidth({
    grossWidthMm: 10,
    holes: [{ id: "outside", centerOffsetMm: 0.5, diameterMm: 4 }],
  }), /outside the plate boundary/i);
  assert.throws(() => calculateMinimumStraightNetWidth({
    grossWidthMm: 10,
    holes: [{ id: "duplicate", centerOffsetMm: 4, diameterMm: 2 }, { id: "duplicate", centerOffsetMm: 6, diameterMm: 2 }],
  }), /IDs must be unique/i);
});
