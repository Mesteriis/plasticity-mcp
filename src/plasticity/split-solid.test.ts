import assert from "node:assert/strict";
import test from "node:test";

import { SplitSolidByPlaneRecipe } from "./split-solid.ts";
import type { PlasticityOperations } from "./operations.ts";
import type { RuntimeState } from "./runtime.ts";

test("splits a Solid with a native planar cutter and preserves exact total volume", async () => {
  const source = body(1, "Solid", { min: [0, 0, 0], max: [20, 20, 20] });
  let current = scene("r1", [source]);
  const calls: Array<{ name: string; args?: unknown[] }> = [];
  const operations: Pick<PlasticityOperations, "state" | "measureSolidProperties" | "validateBodies" | "createRectangle" | "patchClosedWires" | "cutWithFaces" | "remove"> = {
    async state() { return current; },
    async measureSolidProperties(ids, revision) {
      assert.equal(revision, current.revision);
      const volumes = ids.length === 1 ? new Map([[1, 8_000]]) : new Map([[1, 4_000], [4, 4_000]]);
      const bodies = ids.map((id) => ({
        id, versionId: current.bodies.find((candidate) => candidate.id === id)!.versionId,
        name: null, volumeMm3: volumes.get(id)!, surfaceAreaMm2: 1, volumeCentroidMm: [0, 0, 0] as [number, number, number], nativeCheckCodes: [],
      }));
      return {
        sessionId: "session-1", documentToken: current.documentToken, revision, source: "native-brep-mass-properties" as const,
        bodies, totals: { volumeMm3: bodies.reduce((sum, item) => sum + item.volumeMm3, 0), surfaceAreaMm2: bodies.length, volumeWeightedCentroidMm: [0, 0, 0] as [number, number, number] },
      };
    },
    async validateBodies(ids, revision) {
      assert.equal(revision, current.revision);
      return { documentToken: current.documentToken, revision, measurementSource: "native-brep", bodies: ids.map((id) => ({
        id, versionId: current.bodies.find((candidate) => candidate.id === id)!.versionId, type: "Solid", name: null,
        measurementSource: "native-brep", faceCount: 6, edgeCount: 12, boundaryEdgeIds: [], closed: true,
        nativeCheckCodes: [], nativeValid: true, printableSolid: true,
      })) };
    },
    async createRectangle(centerMm, widthMm, heightMm, revision, normal, xDirection) {
      calls.push({ name: "createRectangle", args: [centerMm, widthMm, heightMm, revision, normal, xDirection] });
      current = scene("r2", [source, body(2, "Wire")], [region(2)]);
      return current;
    },
    async patchClosedWires(ids, revision) {
      calls.push({ name: "patchClosedWires", args: [ids, revision] });
      const sheet = body(3, "Sheet", { min: [10, -2, -2], max: [10, 22, 22] });
      sheet.faces = [{ id: "split-face", surfaceType: "Plane", planar: true, centerMm: [10, 10, 10], normal: [1, 0, 0], radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: sheet.boundsMm!, edgeIds: [] }];
      current = scene("r3", [source, body(2, "Wire"), sheet], [region(2)]);
      return current;
    },
    async cutWithFaces(targetIds, cutterFaces, revision) {
      calls.push({ name: "cutWithFaces", args: [targetIds, cutterFaces, revision] });
      const first = body(1, "Solid", { min: [0, 0, 0], max: [10, 20, 20] });
      const second = body(4, "Solid", { min: [10, 0, 0], max: [20, 20, 20] });
      current = scene("r4", [first, second, body(2, "Wire"), current.bodies.find((candidate) => candidate.id === 3)!], [region(2)]);
      return current;
    },
    async remove(ids, revision) {
      calls.push({ name: "remove", args: [ids, revision] });
      current = scene("r5", current.bodies.filter((candidate) => !ids.includes(candidate.id)), []);
      return current;
    },
  };
  const recipe = new SplitSolidByPlaneRecipe(operations);

  const result = await recipe.split({ targetId: 1, originMm: [10, 0, 0], normal: [2, 0, 0], xDirection: [0, 3, 0], revision: "r1" });

  assert.deepEqual(result.resultBodyIds, [1, 4]);
  assert.deepEqual(result.cutPlane, { originMm: [10, 0, 0], normal: [1, 0, 0], xDirection: [0, 1, 0], yDirection: [0, 0, 1] });
  assert.equal(result.inputVolumeMm3, 8_000);
  assert.equal(result.resultVolumeMm3, 8_000);
  assert.equal(result.volumeDifferenceMm3, 0);
  assert.equal(result.undoSteps, 4);
  assert.deepEqual(current.bodies.map((candidate) => candidate.id), [1, 4]);
  assert.deepEqual(calls.map((call) => call.name), ["createRectangle", "patchClosedWires", "cutWithFaces", "remove"]);
  assert.equal((calls[0]!.args![1] as number) > 20, true);
  assert.equal((calls[0]!.args![2] as number) > 20, true);
});

test("rejects tangent or exterior split planes before changing Plasticity", async () => {
  const target = body(1, "Solid", { min: [0, 0, 0], max: [20, 20, 20] });
  let mutations = 0;
  const state = scene("r1", [target]);
  const operations: Pick<PlasticityOperations, "state" | "measureSolidProperties" | "validateBodies" | "createRectangle" | "patchClosedWires" | "cutWithFaces" | "remove"> = {
    async state() { return state; },
    async measureSolidProperties() { throw new Error("must not measure an invalid split"); },
    async validateBodies() { throw new Error("must not validate an invalid split"); },
    async createRectangle() { mutations += 1; return state; },
    async patchClosedWires() { mutations += 1; return state; },
    async cutWithFaces() { mutations += 1; return state; },
    async remove() { mutations += 1; return state; },
  };
  const recipe = new SplitSolidByPlaneRecipe(operations);

  await assert.rejects(() => recipe.split({ targetId: 1, originMm: [20, 0, 0], normal: [1, 0, 0], xDirection: [0, 1, 0], revision: "r1" }), /cross the interior/);
  await assert.rejects(() => recipe.split({ targetId: 1, originMm: [10, 0, 0], normal: [1, 0, 0], xDirection: [2, 0, 0], revision: "r1" }), /x direction/);
  assert.equal(mutations, 0);
});

function scene(revision: string, bodies: RuntimeState["bodies"], regions: RuntimeState["regions"] = []): RuntimeState {
  return {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision,
    dbVersion: Number(revision.slice(1)), undoDepth: Number(revision.slice(1)) - 1, redoDepth: 0,
    construction: { planes: [], activePlaneId: null, planeStateToken: "p0", viewStateToken: "v0" }, regions, bodies,
  };
}

function body(id: number, type: string, boundsMm: RuntimeState["bodies"][number]["boundsMm"] = null): RuntimeState["bodies"][number] {
  return { id, versionId: id, type, name: null, boundsMm, faceIds: [], edgeIds: [], faces: [], edges: [] };
}

function region(wireId: number): RuntimeState["regions"][number] {
  return { id: `region-${wireId}`, entityId: wireId, islandVersionId: wireId, sketchId: wireId, sketchWireIds: [wireId], measurementSource: "render-mesh", displayBoundsMm: { min: [0, 0, 0], max: [20, 20, 0] } };
}
