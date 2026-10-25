import assert from "node:assert/strict";
import { test } from "node:test";

import { nativeFunction } from "./native-function.ts";

test("native calls retain the 26.1 database and geometry objects", () => {
  const editor = { db: {}, geo: { geometryModel: new Map() } };
  const call = Function(`return (${nativeFunction`function () { return [nativeApi.db === this.db, nativeApi.geo === this.geo]; }`})`)();
  assert.deepEqual(call.call(editor), [true, true]);
  assert.equal(Object.hasOwn(editor, "nativeApi"), false);
});

test("26.2 calls read current stores and forward transactions with the native receiver", async () => {
  const models = new Map([[1, { view: {}, model: {} }]]);
  const editor = {
    geo: {
      read: { geometryModel: models, automatics: new Set() },
      lookupStableId(id: number) { assert.equal(this, editor.geo); return id + 100; },
    },
    nodes: {}, groups: {}, empties: {}, materials: {},
    db: {
      version: 1,
      makeTransaction() { assert.equal(this, editor.db); return {}; },
      async commit() { assert.equal(this, editor.db); editor.geo.read = { geometryModel: new Map([[2, { view: {}, model: {} }]]), automatics: new Set() }; },
    },
  };
  const call = Function(`return (${nativeFunction`async function () {
    const before = [...nativeApi.geo.geometryModel.keys()];
    await nativeApi.db.commit(nativeApi.db.makeTransaction());
    return { before, after: [...nativeApi.geo.geometryModel.keys()], stable: nativeApi.db.lookupStableId(2), nativeNodes: nativeApi.db.nodes === this.nodes };
  }`})`)();
  assert.deepEqual(await call.call(editor), { before: [1], after: [2], stable: 102, nativeNodes: true });
  assert.equal(Object.hasOwn(editor.db, "nodes"), false, "compatibility must not patch the native database");
});

test("native factories receive the real editor and retain interpolated arguments", async () => {
  const editor = { db: {}, geo: { geometryModel: new Map() } };
  class Factory { constructor(value: unknown) { assert.equal(value, editor); } }
  const fragment = "return [new Factory(this).constructor.name, args.value];";
  const source = nativeFunction`async function (Factory, args) { ${fragment} }`;
  const call = Function(`return (${source})`)();
  assert.deepEqual(await call.call(editor, Factory, { value: 42 }), ["Factory", 42]);
});

test("26.2 selection and control-point adapters preserve native objects and direction kinds", () => {
  const added: unknown[] = [];
  const editor = {
    geo: { read: { geometryModel: new Map() } }, db: { commit() {} },
    selection: { selected: { add(item: unknown) { assert.equal(this, editor.selection.selected); added.push(item); } } },
  };
  const vertex = {}, cv = {}, positive = {}, negative = {};
  const factory = { controlPoints: [] as unknown[], orientation: { directionKinds: [1, 4, 0], directions: [negative, {}, positive] } };
  const call = Function(`return (${nativeFunction`function (factory, vertex, cv) {
    nativeApi.selection.addVertex(vertex);
    nativeApi.selection.addCurveCV(cv);
    nativeApi.setCurveControlPoints(factory, [vertex], [cv]);
    return { directions: nativeApi.slideDirections(factory), positive: nativeApi.slideDirection('posU'), negative: nativeApi.slideDirection('negU') };
  }`})`)();
  assert.deepEqual(call.call(editor, factory, vertex, cv), { directions: { posU: positive, negU: negative }, positive: 0, negative: 1 });
  assert.deepEqual(added, [vertex, cv]);
  assert.deepEqual(factory.controlPoints, [vertex, cv]);
  assert.equal(Object.hasOwn(editor.selection.selected, "addVertex"), false);
});

test("26.2 vertex bridges use the unique native adjacent segment and normalized endpoint", () => {
  const vertex = {}, segment = {}, expected = { x: 0.01, y: 0.12, z: 0 };
  const edge = { GetPointAndTangent(t: number) { return { position: { ...expected, x: t === 1 ? expected.x : 0 } }; } };
  const editor = {
    db: { commit() {} },
    geo: { read: { geometryModel: new Map() }, lookupTopologyItem(item: unknown) { return item === vertex ? { GetPoint: () => expected } : edge; } },
  };
  const call = Function(`return (${nativeFunction`function (wire, vertex, factory) {
    const endpoint = nativeApi.bridgeVertex(wire, vertex);
    nativeApi.initializeBridge(factory, endpoint, endpoint, 'vertex');
    nativeApi.flipBridgeEnd(factory, 2);
    return endpoint;
  }`})`)();
  let senseCalls = 0;
  const factory = { start: null, end: null, t1: 0, t2: 0, trim: true, pickClosestSenses() { senseCalls += 1; } };
  assert.deepEqual(call.call(editor, { segments: [segment] }, vertex, factory), { segment, t: 1 });
  assert.equal(factory.start, segment);
  assert.equal(factory.t1, 1);
  assert.equal(factory.t2, 0);
  assert.equal(factory.trim, false);
  assert.equal(senseCalls, 1);
  assert.throws(() => call.call(editor, { segments: [segment, segment] }, vertex, factory), /unique adjacent segment/);
});
