import assert from "node:assert/strict";
import test from "node:test";

import { circleLoop } from "./section-fixtures.test.ts";
import { integrateSection } from "./section-geometry.ts";
import { classifyDirectShearFamily } from "./section-shear.ts";

test("annular shear factor approaches the solid-circle and thin-wall limits", () => {
  const nearlySolid = [circleLoop([0, 0], 10), circleLoop([0, 0], 1e-4)];
  const nearlySolidFamily = classifyDirectShearFamily(nearlySolid, integrateSection(nearlySolid));
  assert.equal(nearlySolidFamily?.model, "concentric-circular-annulus");
  near(nearlySolidFamily!.maximumToAverageFactor, 4 / 3, 2e-5);

  const thinWall = [circleLoop([0, 0], 10), circleLoop([0, 0], 9.999)];
  const thinWallFamily = classifyDirectShearFamily(thinWall, integrateSection(thinWall));
  assert.equal(thinWallFamily?.model, "concentric-circular-annulus");
  near(thinWallFamily!.maximumToAverageFactor, 2, 1e-4);
});

function near(actual: number, expected: number, tolerance: number): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected} within ${tolerance}`);
}
