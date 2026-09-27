import assert from "node:assert/strict";
import test from "node:test";

import { assessCohesiveMeshResolution } from "./cohesive-mesh-resolution.ts";

const materials = {
  materialA: { youngsModulusMPa: 2_000, poissonRatio: 0.3 },
  materialB: { youngsModulusMPa: 1_000, poissonRatio: 0.28 },
};

function meshWithTriangleEdge(edgeMm: number): string {
  return [
    "$MeshFormat", "2.2 0 8", "$EndMeshFormat",
    "$Nodes", "6",
    `1 0 0 0`, `2 ${edgeMm} 0 0`, `3 0 ${edgeMm} 0`,
    "4 0 0 0", `5 ${edgeMm} 0 0`, `6 0 ${edgeMm} 0`,
    "$EndNodes", "$Elements", "1", "10 6 2 6 6 1 2 3 4 5 6", "$EndElements", "",
  ].join("\n");
}

test("estimates interface mesh resolution against each material's indicative process-zone length", () => {
  const assessment = assessCohesiveMeshResolution(meshWithTriangleEdge(0.5), materials, {
    peakTractionMPa: 2.4,
    fractureEnergyNPerMm: 0.02,
  });

  assert.equal(assessment.maximumCohesiveEdgeMm, Math.sqrt(0.5));
  assert.equal(assessment.recommendedElementsAcrossZone, 5);
  assert.equal(assessment.status, "meets-indicative-five-element-screen");
  assert.equal(assessment.materialEstimates.length, 2);
  assert.ok(assessment.materialEstimates.every((item) => item.estimatedElementsAcrossZone >= 5));
  assert.match(assessment.interpretation, /Indicative screening estimate/);
});

test("flags a coarse interface mesh when either adjoining material has fewer than five estimated elements", () => {
  const assessment = assessCohesiveMeshResolution(meshWithTriangleEdge(2), materials, {
    peakTractionMPa: 2.4,
    fractureEnergyNPerMm: 0.02,
  });

  assert.equal(assessment.status, "below-indicative-five-element-screen");
  assert.ok(assessment.materialEstimates.some((item) => item.estimatedElementsAcrossZone < 5));
});

test("rejects malformed, incomplete, degenerate, or non-coincident PENTA6 interfaces", () => {
  const valid = meshWithTriangleEdge(1);
  assert.throws(() => assessCohesiveMeshResolution(valid.replace("2.2 0 8", "4.1 0 8"), materials, { peakTractionMPa: 2.4, fractureEnergyNPerMm: 0.02 }), /MSH 2.2/);
  assert.throws(() => assessCohesiveMeshResolution(valid.replace("6 6 1 2 3 4 5 6", "6 6 1 2 3 4 5 99"), materials, { peakTractionMPa: 2.4, fractureEnergyNPerMm: 0.02 }), /unknown node/);
  assert.throws(() => assessCohesiveMeshResolution(valid.replace("4 0 0 0", "4 0 0 0.1"), materials, { peakTractionMPa: 2.4, fractureEnergyNPerMm: 0.02 }), /coincident/);
  assert.throws(() => assessCohesiveMeshResolution(valid.replace("3 0 1 0", "3 2 0 0").replace("6 0 1 0", "6 2 0 0"), materials, { peakTractionMPa: 2.4, fractureEnergyNPerMm: 0.02 }), /degenerate/);
  assert.throws(() => assessCohesiveMeshResolution(valid.replace("2 1 0 0", "2 0 0 0"), materials, { peakTractionMPa: 2.4, fractureEnergyNPerMm: 0.02 }), /coincident/);
});

test("rejects invalid material and cohesive inputs", () => {
  assert.throws(() => assessCohesiveMeshResolution(meshWithTriangleEdge(1), { ...materials, materialA: { youngsModulusMPa: 0, poissonRatio: 0.3 } }, { peakTractionMPa: 2.4, fractureEnergyNPerMm: 0.02 }), /material/);
  assert.throws(() => assessCohesiveMeshResolution(meshWithTriangleEdge(1), materials, { peakTractionMPa: 2.4, fractureEnergyNPerMm: 0 }), /fracture energy/);
});
