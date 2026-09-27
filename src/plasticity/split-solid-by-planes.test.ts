import assert from "node:assert/strict";
import test from "node:test";

import { SplitSolidByPlanesRecipe, SplitSolidByPlanesRecipeError } from "./split-solid-by-planes.ts";
import type { PlasticityOperations } from "./operations.ts";
import type { SplitSolidByPlaneRecipe, SplitSolidByPlaneResult } from "./split-solid.ts";
import type { RuntimeState } from "./runtime.ts";

test("applies ordered planes to only intersected Solid pieces and verifies the final grid volume", async () => {
  const bodies = new Map<number, RuntimeState["bodies"][number]>([[1, body(1, [0, 0, 0], [40, 20, 20])]]);
  const volumes = new Map([[1, 16_000]]);
  let current = state("r1", [...bodies.values()], 0);
  let nextId = 2;
  let cutCount = 0;
  const operations: Pick<PlasticityOperations, "state" | "measureSolidProperties" | "validateBodies" | "createRectangle" | "patchClosedWires" | "cutWithFaces" | "remove"> = {
    async state() { return current; },
    async measureSolidProperties(ids, revision) {
      assert.equal(revision, current.revision);
      const measured = ids.map((id) => ({ id, versionId: id, name: null, volumeMm3: volumes.get(id)!, surfaceAreaMm2: 1, volumeCentroidMm: [0, 0, 0] as [number, number, number], nativeCheckCodes: [] }));
      return { sessionId: "session-1", documentToken: current.documentToken, revision, source: "native-brep-mass-properties", bodies: measured, totals: { volumeMm3: measured.reduce((sum, item) => sum + item.volumeMm3, 0), surfaceAreaMm2: measured.length, volumeWeightedCentroidMm: [0, 0, 0] } };
    },
    async validateBodies() { throw new Error("single split mock should be used"); },
    async createRectangle() { throw new Error("single split mock should be used"); },
    async patchClosedWires() { throw new Error("single split mock should be used"); },
    async cutWithFaces() { throw new Error("single split mock should be used"); },
    async remove() { throw new Error("single split mock should be used"); },
  };
  const singleSplit: Pick<SplitSolidByPlaneRecipe, "split"> = {
    async split(input): Promise<SplitSolidByPlaneResult> {
      assert.equal(input.revision, current.revision);
      const target = bodies.get(input.targetId)!;
      const axis = input.normal.findIndex((value) => Math.abs(value) > 0.5);
      assert.ok(axis >= 0);
      const cut = input.originMm[axis]!;
      const low = [...target.boundsMm!.min] as [number, number, number];
      const high = [...target.boundsMm!.max] as [number, number, number];
      assert.ok(cut > low[axis]! && cut < high[axis]!);
      const lowMax = [...high] as [number, number, number];
      const highMin = [...low] as [number, number, number];
      lowMax[axis] = cut;
      highMin[axis] = cut;
      const leftId = input.targetId;
      const rightId = nextId++;
      const halfVolume = volumes.get(input.targetId)! / 2;
      bodies.delete(input.targetId);
      volumes.delete(input.targetId);
      bodies.set(leftId, body(leftId, low, lowMax));
      bodies.set(rightId, body(rightId, highMin, high));
      volumes.set(leftId, halfVolume);
      volumes.set(rightId, halfVolume);
      cutCount += 1;
      const previous = current.revision;
      const nextRevision = `r${cutCount + 1}`;
      current = state(nextRevision, [...bodies.values()], cutCount * 4);
      return {
        recipe: "split-solid-by-plane", status: "completed", documentToken: current.documentToken,
        beforeRevision: previous, afterRevision: current.revision, sourceBodyId: input.targetId,
        resultBodyIds: [leftId, rightId], cutPlane: { ...input, yDirection: [0, 0, 1] },
        cutterSizeMm: [50, 50], cutterMarginMm: 1, inputVolumeMm3: halfVolume * 2,
        resultVolumeMm3: halfVolume * 2, volumeDifferenceMm3: 0, temporaryBodyIds: [99, 100], undoSteps: 4,
      };
    },
  };

  const result = await new SplitSolidByPlanesRecipe(operations, singleSplit).split({
    targetId: 1,
    planes: [
      { originMm: [20, 0, 0], normal: [1, 0, 0], xDirection: [0, 1, 0] },
      { originMm: [0, 10, 0], normal: [0, 1, 0], xDirection: [1, 0, 0] },
    ],
    revision: "r1",
  });

  assert.equal(result.cutCount, 3);
  assert.equal(result.undoSteps, 12);
  assert.equal(result.resultBodyIds.length, 4);
  assert.equal(result.volumeDifferenceMm3, 0);
  assert.equal(result.resultVolumeMm3, 16_000);
  assert.deepEqual(result.cuts.map((cut) => cut.planeIndex), [0, 1, 1]);
  assert.deepEqual(result.resultBodyIds.map((id) => bodies.get(id)!.boundsMm), [
    { min: [0, 0, 0], max: [20, 10, 20] },
    { min: [0, 10, 0], max: [20, 20, 20] },
    { min: [20, 0, 0], max: [40, 10, 20] },
    { min: [20, 10, 0], max: [40, 20, 20] },
  ]);
});

test("reports completed native cuts and last confirmed revision when a later plane fails", async () => {
  const bodies = new Map<number, RuntimeState["bodies"][number]>([[1, body(1, [0, 0, 0], [20, 20, 20])]]);
  let current = state("r1", [...bodies.values()], 0);
  let calls = 0;
  const operations = {
    async state() { return current; },
    async measureSolidProperties(ids: number[], revision: string) {
      const measured = ids.map((id) => ({ id, versionId: id, name: null, volumeMm3: 4_000, surfaceAreaMm2: 1, volumeCentroidMm: [0, 0, 0] as [number, number, number], nativeCheckCodes: [] }));
      return { sessionId: "session-1", documentToken: "doc-1", revision, source: "native-brep-mass-properties" as const, bodies: measured, totals: { volumeMm3: measured.reduce((sum, item) => sum + item.volumeMm3, 0), surfaceAreaMm2: measured.length, volumeWeightedCentroidMm: [0, 0, 0] as [number, number, number] } };
    },
    async validateBodies() { throw new Error("not used"); },
    async createRectangle() { throw new Error("not used"); }, async patchClosedWires() { throw new Error("not used"); }, async cutWithFaces() { throw new Error("not used"); }, async remove() { throw new Error("not used"); },
  } satisfies Pick<PlasticityOperations, "state" | "measureSolidProperties" | "validateBodies" | "createRectangle" | "patchClosedWires" | "cutWithFaces" | "remove">;
  const singleSplit: Pick<SplitSolidByPlaneRecipe, "split"> = {
    async split(input): Promise<SplitSolidByPlaneResult> {
      calls += 1;
      if (calls === 1) {
        const first = body(1, [0, 0, 0], [10, 20, 20]);
        const second = body(2, [10, 0, 0], [20, 20, 20]);
        bodies.clear(); bodies.set(1, first); bodies.set(2, second);
        current = state("r2", [...bodies.values()], 4);
        return {
          recipe: "split-solid-by-plane", status: "completed", documentToken: "doc-1", beforeRevision: input.revision,
          afterRevision: current.revision, sourceBodyId: 1, resultBodyIds: [1, 2],
          cutPlane: { ...input, yDirection: [0, 0, 1] }, cutterSizeMm: [22, 22], cutterMarginMm: 1,
          inputVolumeMm3: 8_000, resultVolumeMm3: 8_000, volumeDifferenceMm3: 0, temporaryBodyIds: [8, 9], undoSteps: 4,
        };
      }
      throw new Error("native split failed after an earlier cut");
    },
  };
  const recipe = new SplitSolidByPlanesRecipe(operations, singleSplit);

  await assert.rejects(() => recipe.split({
    targetId: 1,
    planes: [
      { originMm: [10, 0, 0], normal: [1, 0, 0], xDirection: [0, 1, 0] },
      { originMm: [0, 10, 0], normal: [0, 1, 0], xDirection: [1, 0, 0] },
    ],
    revision: "r1",
  }), (error: unknown) => {
    assert.ok(error instanceof SplitSolidByPlanesRecipeError);
    assert.equal(error.completedCuts.length, 1);
    assert.equal(error.lastConfirmedRevision, "r2");
    return true;
  });
});

function body(id: number, min: [number, number, number], max: [number, number, number]): RuntimeState["bodies"][number] {
  return { id, versionId: id, type: "Solid", name: null, boundsMm: { min, max }, faceIds: [], edgeIds: [], faces: [], edges: [] };
}

function state(revision: string, bodies: RuntimeState["bodies"], undoDepth: number): RuntimeState {
  return { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision, dbVersion: undoDepth, undoDepth, redoDepth: 0, construction: { planes: [], activePlaneId: null, planeStateToken: "p0", viewStateToken: "v0" }, regions: [], bodies };
}
