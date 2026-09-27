import assert from "node:assert/strict";
import test from "node:test";

import { classifyRefinementTrend, maximumStressLocationShiftMm } from "./refinement-diagnostics.ts";

test("classifies only the sampled direction of mesh refinement metrics", () => {
  assert.equal(classifyRefinementTrend([1, 1.5, 2]), "increasing");
  assert.equal(classifyRefinementTrend([2, 1.5, 1]), "decreasing");
  assert.equal(classifyRefinementTrend([1, 1.5, 1.25]), "non-monotonic");
  assert.equal(classifyRefinementTrend([1, 1 + 1e-14, 1 - 1e-14]), "unchanged");
  assert.equal(classifyRefinementTrend([1]), "insufficient-levels");
  assert.equal(classifyRefinementTrend([]), "insufficient-levels");
  assert.throws(() => classifyRefinementTrend([1, Number.NaN]), /finite/);
});

test("measures movement of the raw peak-stress element centroid across meshes", () => {
  assert.ok(Math.abs(maximumStressLocationShiftMm(
    { elementId: 2, integrationPoint: 1, centroidMm: [10, 20, 30] },
    { elementId: 91, integrationPoint: 1, centroidMm: [10.3, 20.4, 30] },
  )! - 0.5) < 1e-12);
  assert.equal(maximumStressLocationShiftMm(undefined, { elementId: 1, integrationPoint: 1, centroidMm: [0, 0, 0] }), null);
});
