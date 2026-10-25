import assert from "node:assert/strict";
import { test } from "node:test";
import { PlasticityOperations } from "./operations.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";

function fixture(failCommit = false, nativeMissing = false) {
  const region = { versionId: "region-1" };
  const state = {
    targetId: "window", title: "Patch fixture", documentToken: "doc", revision: "r1", dbVersion: 1,
    undoDepth: 0, redoDepth: 0, bodies: [], regions: [{ id: region.versionId }],
    construction: { planes: [], activePlaneId: "standard:top", planeStateToken: "planes", viewStateToken: "view" },
  } as unknown as RuntimeState;
  let insideCommand = false;
  let selected = true;
  let mutations = 0;
  class SketchIsland {
    regions = { length: 1, get: () => region };
  }
  class Factory {
    regions: unknown[] = [];
    resource() { return this; }
    async commit() {
      assert.equal(insideCommand, true);
      assert.equal(selected, false, "selected source must not trigger a follow-up MoveItemCommand");
      assert.deepEqual(this.regions, [region]);
      if (failCommit) throw new Error("native patch failed");
    }
  }
  const editor = {
    geo: { geometryModel: new Map(nativeMissing ? [] : [[17, { view: new SketchIsland() }]]), automatics: new Set([17]) },
    db: {}, executor: { isBusy: false }, commands: { PatchCommand: class {} },
    selection: { selected: { removeAll() { assert.equal(insideCommand, true); selected = false; } } },
    async exec(command: { execute(): Promise<unknown> }) {
      insideCommand = true;
      try { await command.execute(); } finally { insideCommand = false; }
    },
  };
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) {
      mutations += 1;
      assert.deepEqual(bindings, ["PatchRegionFactory"]);
      await Function(`return (${source})`)().call(editor, Factory, ...values);
    },
  } as unknown as PlasticityRuntime;
  return { operations: new PlasticityOperations(runtime), selected: () => selected, mutations: () => mutations };
}

test("patch clears source selection inside its owned native command before committing explicit regions", async () => {
  const f = fixture();
  await f.operations.patchRegions(["region-1"], "r1");
  assert.equal(f.mutations(), 1);
  assert.equal(f.selected(), false);
});

test("patch rejects stale, unknown and duplicate regions before changing selection", async () => {
  const f = fixture();
  await assert.rejects(f.operations.patchRegions(["region-1"], "stale"), /Stale reference/u);
  await assert.rejects(f.operations.patchRegions(["missing"], "r1"), /unknown regions/u);
  await assert.rejects(f.operations.patchRegions(["region-1", "region-1"], "r1"), /must be unique/u);
  assert.equal(f.mutations(), 0);
  assert.equal(f.selected(), true);
});

test("native patch failure is propagated", async () => {
  const f = fixture(true);
  await assert.rejects(f.operations.patchRegions(["region-1"], "r1"), /native patch failed/u);
});

test("patch preserves selection when a region disappears before native lookup", async () => {
  const f = fixture(false, true);
  await assert.rejects(f.operations.patchRegions(["region-1"], "r1"), /unknown regions/u);
  assert.equal(f.selected(), true);
});
