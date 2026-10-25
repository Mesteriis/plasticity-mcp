import assert from "node:assert/strict";
import { test } from "node:test";
import { PlasticityOperations } from "./operations.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";

function fixture(failMirror = false, emptyMirror = false) {
  const state: RuntimeState = {
    targetId: "window", title: "Mirror fixture", documentToken: "document", revision: "r1", dbVersion: 1,
    undoDepth: 0, redoDepth: 0, regions: [], bodies: [],
    construction: { planes: [], activePlaneId: "standard:top", planeStateToken: "planes", viewStateToken: "view" },
  };
  const view = {};
  const deleted: unknown[] = [];
  let deleteCommits = 0;
  const committed: Record<string, unknown>[] = [];
  class Factory {
    // Active settings ensure every explicit override is exercised.
    shouldCut = true;
    shouldUnion = true;
    move = 0.125;
    shells: unknown[] = [];
    origin = { value: [] as number[], fromArray(value: number[]) { this.value = value; } };
    normal = { value: [] as number[], fromArray(value: number[]) { this.value = value; } };
    resource() { return this; }
    async commit() {
      if (failMirror) throw new Error("native mirror failed");
      if (!emptyMirror) editor.geo.geometryModel.set(18, { view: {} });
      committed.push({
        cut: this.shouldCut, union: this.shouldUnion, move: this.move,
        shells: this.shells, origin: this.origin.value, normal: this.normal.value,
      });
    }
  }
  const editor = {
    geo: { geometryModel: new Map([[17, { view }]]) },
    db: {
      lookupStableId(version: number) { assert.ok(version === 17 || version === 18); return version === 17 ? 7 : 8; },
      makeTransaction() { return { delete(view: unknown) { deleted.push(view); } }; },
      async commit() { deleteCommits += 1; },
    },
    executor: { isBusy: false }, commands: { MirrorCommand: class {} },
    async exec(command: { execute(): Promise<unknown> }) { await command.execute(); },
  };
  let mutations = 0;
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) {
      mutations += 1;
      assert.deepEqual(bindings, ["MirrorFactory"]);
      const native = Function(`return (${source})`)();
      await native.call(editor, Factory, ...values);
    },
  } as unknown as PlasticityRuntime;
  return { operations: new PlasticityOperations(runtime), committed, deleted, view, deleteCommits: () => deleteCommits, mutations: () => mutations };
}

for (const keepOriginal of [true, false]) {
  test(`whole-body mirror disables native cutting and union, keepOriginal=${keepOriginal}`, async () => {
    const f = fixture();
    await f.operations.mirror([7], [12, 0, 0], [1, 0, 0], keepOriginal, "r1");
    assert.deepEqual(f.committed, [{ cut: false, union: false, move: 0, shells: [f.view], origin: [0.012, 0, 0], normal: [1, 0, 0] }]);
    assert.deepEqual(f.deleted, keepOriginal ? [] : [f.view]);
    assert.equal(f.deleteCommits(), keepOriginal ? 0 : 1);
    assert.equal(f.mutations(), 1);
  });
}

test("mirror rejects stale revision before starting a native command", async () => {
  const f = fixture();
  await assert.rejects(f.operations.mirror([7], [0, 0, 0], [1, 0, 0], false, "stale"), /Stale reference/u);
  assert.equal(f.mutations(), 0);
  assert.equal(f.committed.length, 0);
});

test("failed native mirror never deletes originals", async () => {
  const f = fixture(true);
  await assert.rejects(f.operations.mirror([7], [0, 0, 0], [1, 0, 0], false, "r1"), /native mirror failed/u);
  assert.deepEqual(f.deleted, []);
  assert.equal(f.deleteCommits(), 0);
});

test("mirror replacement preserves originals when native commit creates no reflected body", async () => {
  const f = fixture(false, true);
  await assert.rejects(f.operations.mirror([7], [0, 0, 0], [1, 0, 0], false, "r1"), /originals were not deleted/u);
  assert.deepEqual(f.deleted, []);
  assert.equal(f.deleteCommits(), 0);
});

test("mirror rejects duplicate sources before mutation", async () => {
  const f = fixture();
  await assert.rejects(f.operations.mirror([7, 7], [0, 0, 0], [1, 0, 0], false, "r1"), /IDs must be unique/u);
  assert.equal(f.mutations(), 0);
});
