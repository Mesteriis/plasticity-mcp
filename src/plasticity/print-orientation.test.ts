import assert from "node:assert/strict";
import test from "node:test";

import { boundsCenter, quaternionFromXyzDegrees, rotateBoundsAroundPivot, unionBounds } from "./print-orientation.ts";

test("print orientation Euler angles reproduce Workbench's six axis permutations and bed yaw", () => {
  const bounds = { min: [0, 0, 0] as [number, number, number], max: [20, 10, 5] as [number, number, number] };
  const pivot: [number, number, number] = [10, 5, 2.5];
  const cases: Array<{ rotationDeg: [number, number, number]; sizeMm: [number, number, number] }> = [
    { rotationDeg: [0, 0, 0], sizeMm: [20, 10, 5] },
    { rotationDeg: [90, 0, 0], sizeMm: [20, 5, 10] },
    { rotationDeg: [0, 90, 0], sizeMm: [5, 10, 20] },
    { rotationDeg: [0, 0, 90], sizeMm: [10, 20, 5] },
    { rotationDeg: [90, 0, 90], sizeMm: [5, 20, 10] },
    { rotationDeg: [0, 90, 90], sizeMm: [10, 5, 20] },
    { rotationDeg: [0, 0, 45], sizeMm: [20 / Math.sqrt(2) + 10 / Math.sqrt(2), 20 / Math.sqrt(2) + 10 / Math.sqrt(2), 5] },
  ];

  for (const item of cases) {
    const rotated = rotateBoundsAroundPivot(bounds, pivot, quaternionFromXyzDegrees(item.rotationDeg));
    const actual = rotated.max.map((value, axis) => value - rotated.min[axis]!) as [number, number, number];
    actual.forEach((value, axis) => assert.ok(Math.abs(value - item.sizeMm[axis]!) < 1e-9, `${item.rotationDeg.join(",")} axis ${axis}: ${value} != ${item.sizeMm[axis]}`));
  }
});

test("print orientation preserves the exact assembly pivot and does not scale bounds", () => {
  const bounds = { min: [10, 20, 30] as [number, number, number], max: [50, 40, 35] as [number, number, number] };
  const pivot: [number, number, number] = [30, 30, 32.5];
  const rotated = rotateBoundsAroundPivot(bounds, pivot, quaternionFromXyzDegrees([90, 0, 90]));
  assert.deepEqual(rotated.min.map((value, axis) => (value + rotated.max[axis]!) / 2), pivot);
  assert.ok(Math.abs(rotated.max[0]! - rotated.min[0]! - 5) < 1e-9);
  assert.ok(Math.abs(rotated.max[1]! - rotated.min[1]! - 40) < 1e-9);
  assert.ok(Math.abs(rotated.max[2]! - rotated.min[2]! - 20) < 1e-9);
});

test("rigid multi-body print orientation uses the union bounds and shared center pivot", () => {
  const bounds = unionBounds([
    { min: [0, 0, 0], max: [20, 10, 5] },
    { min: [30, 0, 0], max: [40, 10, 5] },
  ]);
  const pivot = boundsCenter(bounds);
  assert.deepEqual(bounds, { min: [0, 0, 0], max: [40, 10, 5] });
  assert.deepEqual(pivot, [20, 5, 2.5]);
  const rotated = rotateBoundsAroundPivot(bounds, pivot, quaternionFromXyzDegrees([90, 0, 90]));
  assert.ok(Math.abs(rotated.max[0]! - rotated.min[0]! - 5) < 1e-9);
  assert.ok(Math.abs(rotated.max[1]! - rotated.min[1]! - 40) < 1e-9);
  assert.ok(Math.abs(rotated.max[2]! - rotated.min[2]! - 10) < 1e-9);
});
