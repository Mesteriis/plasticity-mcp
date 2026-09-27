import assert from "node:assert/strict";
import test from "node:test";

import { SplitSolidToVolumeRecipe } from "./split-solid-to-volume.ts";
import type { PlasticityOperations } from "./operations.ts";
import type { SplitSolidByPlanesRecipe, SplitSolidByPlanesResult } from "./split-solid-by-planes.ts";
import type { RuntimeState } from "./runtime.ts";

test("maps exact current Solid bounds to even world-space grid planes and verifies every resulting part", async () => {
  let current = state("r1", [body(1, [-20, 3, 5], [20, 23, 25])]);
  let observed: Parameters<SplitSolidByPlanesRecipe["split"]>[0] | undefined;
  const operations = fakeOperations(() => current);
  const splitGrid: Pick<SplitSolidByPlanesRecipe, "split"> = {
    async split(input): Promise<SplitSolidByPlanesResult> {
      observed = input;
      assert.equal(input.revision, "r1");
      const parts = [
        body(2, [-20, 3, 5], [0, 13, 25]), body(3, [-20, 13, 5], [0, 23, 25]),
        body(4, [0, 3, 5], [20, 13, 25]), body(5, [0, 13, 5], [20, 23, 25]),
      ];
      current = state("r2", parts);
      return {
        recipe: "split-solid-by-planes", status: "completed", documentToken: "doc-1", beforeRevision: "r1", afterRevision: "r2",
        sourceBodyId: 1, resultBodyIds: [2, 3, 4, 5], cutCount: 3, undoSteps: 12,
        inputVolumeMm3: 16_000, resultVolumeMm3: 16_000, volumeDifferenceMm3: 0,
        cuts: [
          { targetBodyId: 1, planeIndex: 0, resultBodyIds: [1, 6], volumeDifferenceMm3: 0 },
          { targetBodyId: 1, planeIndex: 1, resultBodyIds: [2, 3], volumeDifferenceMm3: 0 },
          { targetBodyId: 6, planeIndex: 1, resultBodyIds: [4, 5], volumeDifferenceMm3: 0 },
        ],
      };
    },
  };

  const result = await new SplitSolidToVolumeRecipe(operations, splitGrid).split({ targetId: 1, usableBuildVolumeMm: [20, 10, 20], revision: "r1" });

  assert.deepEqual(observed?.planes, [
    { originMm: [0, 3, 5], normal: [1, 0, 0], xDirection: [0, 1, 0] },
    { originMm: [-20, 13, 5], normal: [0, 1, 0], xDirection: [1, 0, 0] },
  ]);
  assert.deepEqual(result.segmentCounts, [2, 2, 1]);
  assert.equal(result.expectedGridCellCount, 4);
  assert.deepEqual(result.resultBodyIds, [2, 3, 4, 5]);
  assert.equal(result.partBoundsMm.length, 4);
  assert.equal(result.afterRevision, "r2");
});

test("refuses a no-op fit and excessive grids before invoking native cuts", async () => {
  const current = state("r1", [body(1, [0, 0, 0], [20, 20, 20])]);
  let calls = 0;
  const splitGrid: Pick<SplitSolidByPlanesRecipe, "split"> = { async split() { calls += 1; throw new Error("should not split"); } };
  const recipe = new SplitSolidToVolumeRecipe(fakeOperations(() => current), splitGrid);

  await assert.rejects(() => recipe.split({ targetId: 1, usableBuildVolumeMm: [20, 20, 20], revision: "r1" }), /already fits/i);
  await assert.rejects(() => recipe.split({ targetId: 1, usableBuildVolumeMm: [1, 1, 1], revision: "r1" }), /maximum supported/i);
  assert.equal(calls, 0);

  const manyPlanes = state("r1", [body(1, [0, 0, 0], [66, 20, 20])]);
  await assert.rejects(() => new SplitSolidToVolumeRecipe(fakeOperations(() => manyPlanes), splitGrid).split({
    targetId: 1, usableBuildVolumeMm: [1, 20, 20], revision: "r1",
  }), /maximum supported is 64/i);
  assert.equal(calls, 0);
});

function fakeOperations(readState: () => RuntimeState): Pick<PlasticityOperations, "state" | "measureSolidProperties" | "validateBodies" | "createRectangle" | "patchClosedWires" | "cutWithFaces" | "remove"> {
  return {
    async state() { return readState(); },
    async measureSolidProperties() { throw new Error("not used by even-grid planning"); },
    async validateBodies() { throw new Error("not used by even-grid planning"); },
    async createRectangle() { throw new Error("not used by even-grid planning"); },
    async patchClosedWires() { throw new Error("not used by even-grid planning"); },
    async cutWithFaces() { throw new Error("not used by even-grid planning"); },
    async remove() { throw new Error("not used by even-grid planning"); },
  };
}

function body(id: number, min: [number, number, number], max: [number, number, number]): RuntimeState["bodies"][number] {
  return { id, versionId: id, type: "Solid", name: null, boundsMm: { min, max }, faceIds: [], edgeIds: [], faces: [], edges: [] };
}

function state(revision: string, bodies: RuntimeState["bodies"]): RuntimeState {
  return { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision, dbVersion: 1, undoDepth: 1, redoDepth: 0, construction: { planes: [], activePlaneId: null, planeStateToken: "p0", viewStateToken: "v0" }, regions: [], bodies };
}
