import assert from "node:assert/strict";
import test from "node:test";

import { calculateFastenerGroupEdgeShearOut } from "./fastener-group-edge-shear-out.ts";

test("screens every aligned fastener to its exact loaded rectangular edge", () => {
  const result = calculateFastenerGroupEdgeShearOut({
    thicknessMm: 8,
    designAllowableMPa: 1,
    qualified: true,
    fasteners: [
      { id: "left", holeDiameterMm: 6, centerToEdgesMm: { minX: 10, maxX: 50, minY: 10, maxY: 30 } },
      { id: "right", holeDiameterMm: 6, centerToEdgesMm: { minX: 50, maxX: 10, minY: 10, maxY: 30 } },
    ],
    demands: [
      { id: "left", resultantN: { x: 25, y: 0 }, magnitudeN: 25 },
      { id: "right", resultantN: { x: 25, y: 0 }, magnitudeN: 25 },
    ],
  });

  assert.equal(result.status, "conditional");
  assert.equal(result.fasteners[0]?.loadedEdge, "+X");
  assert.equal(result.fasteners[0]?.centerToLoadedEdgeMm, 50);
  assert.equal(result.fasteners[0]?.netLigamentMm, 47);
  assert.equal(result.fasteners[0]?.shearAreaMm2, 752);
  assert.equal(result.fasteners[1]?.centerToLoadedEdgeMm, 10);
  assert.equal(result.fasteners[1]?.netLigamentMm, 7);
  assert.equal(result.fasteners[1]?.shearAreaMm2, 112);
  assert.equal(result.fasteners[0]?.checkStatus, "within-allowable");
  assert.equal(result.fasteners[1]?.checkStatus, "conditional");
  assert.equal(result.governing?.fastenerId, "right");
});

test("reports a qualified exceedance instead of suppressing a failed shear-out mode", () => {
  const result = calculateFastenerGroupEdgeShearOut({
    thicknessMm: 8,
    designAllowableMPa: 0.01,
    qualified: true,
    fasteners: [{ id: "loaded", holeDiameterMm: 6, centerToEdgesMm: { minX: 10, maxX: 20, minY: 10, maxY: 30 } }],
    demands: [{ id: "loaded", resultantN: { x: 25, y: 0 }, magnitudeN: 25 }],
  });
  assert.equal(result.status, "exceeds-allowable");
  assert.equal(result.fasteners[0]?.checkStatus, "exceeds-allowable");
});

test("keeps non-axis-aligned demands unsupported and unqualified screens conditional", () => {
  const unsupported = calculateFastenerGroupEdgeShearOut({
    thicknessMm: 8,
    designAllowableMPa: 10,
    qualified: true,
    fasteners: [{ id: "diagonal", holeDiameterMm: 6, centerToEdgesMm: { minX: 10, maxX: 10, minY: 10, maxY: 10 } }],
    demands: [{ id: "diagonal", resultantN: { x: 10, y: 10 }, magnitudeN: Math.sqrt(200) }],
  });
  assert.equal(unsupported.status, "unsupported");
  assert.equal(unsupported.fasteners[0]?.checkStatus, "unsupported");

  const conditional = calculateFastenerGroupEdgeShearOut({
    thicknessMm: 8,
    designAllowableMPa: 10,
    qualified: false,
    fasteners: [{ id: "conditional", holeDiameterMm: 6, centerToEdgesMm: { minX: 10, maxX: 50, minY: 10, maxY: 30 } }],
    demands: [{ id: "conditional", resultantN: { x: 25, y: 0 }, magnitudeN: 25 }],
  });
  assert.equal(conditional.fasteners[0]?.checkStatus, "conditional");
  assert.equal(conditional.fasteners[0]?.nominalShearOutStressMPa, 25 / 752);
});

test("does not apply the simplified two-plane formula below e/d 1.5", () => {
  const result = calculateFastenerGroupEdgeShearOut({
    thicknessMm: 8,
    designAllowableMPa: 10,
    qualified: true,
    fasteners: [{ id: "short", holeDiameterMm: 6, centerToEdgesMm: { minX: 4, maxX: 4, minY: 10, maxY: 30 } }],
    demands: [{ id: "short", resultantN: { x: 10, y: 0 }, magnitudeN: 10 }],
  });
  assert.equal(result.status, "unsupported");
  assert.equal(result.fasteners[0]?.checkStatus, "unsupported");
  assert.ok(result.fasteners[0]?.issue?.includes("e/d"));
});
