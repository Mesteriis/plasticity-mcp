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

test("factory parameter adapters keep legacy kernel bridges and use 26.2 public inputs", () => {
  for (const stores of [false, true]) {
    const editor = { db: { commit() {} }, geo: stores ? { read: { geometryModel: new Map() } } : { geometryModel: new Map() } };
    const calls: number[] = [];
    const model = { InsertKnot(value: number) { calls.push(value); }, SplitAt(value: number) { calls.push(value); } };
    const factory: any = { _segment: { model } };
    const segment = {}, source = {}, target = {};
    const call = Function(`return (${nativeFunction`function (factory, segment, source, target) {
      nativeApi.configureCurveKnot(factory, 0.4);
      if (factory._segment) factory._segment.model.InsertKnot(999);
      nativeApi.configureCurveSplit(factory, segment, 0.25);
      if (factory._segment) factory._segment.model.SplitAt(999);
      nativeApi.setDeformationFaces(factory, source, target);
    }`})`)();
    call.call(editor, factory, segment, source, target);
    if (stores) {
      assert.equal(factory.param, 0.4);
      assert.deepEqual(factory.segments, [segment]);
      assert.deepEqual(factory.parameters, [0.25]);
      assert.equal(factory.source, source);
      assert.equal(factory.target, target);
      assert.equal(factory._segment.model, model, "new factories must not wrap kernel models");
    } else {
      assert.deepEqual(calls, [0.4, 0.25]);
      assert.equal(factory.segment, segment);
      assert.equal(factory.sourceFace, source);
      assert.equal(factory.targetFace, target);
    }
  }
});

test("temporary geometry and reference-mesh adapters preserve each native contract", async () => {
  class ObjectEmpty {}
  class Empties_ObjectEmpty {}
  for (const stores of [false, true]) {
    const cvs = {};
    const model = { GetCVs() { return cvs; } };
    const editor = { db: { commit() {} }, geo: stores ? { read: { geometryModel: new Map() } } : { geometryModel: new Map() } };
    const calls: unknown[][] = [];
    const geometry = { addItem(...args: unknown[]) { assert.equal(this, geometry); calls.push(args); } };
    const view = {};
    const call = Function(`return (${nativeFunction`function (model, geometry, view, object) {
      const job = nativeApi.temporaryModelData(model, 101, 201);
      nativeApi.addTemporaryItem(geometry, job, view);
      return nativeApi.isReferenceMesh(object);
    }`})`)();
    assert.equal(call.call(editor, model, geometry, view, stores ? new ObjectEmpty() : new Empties_ObjectEmpty()), true);
    assert.deepEqual(calls, [stores ? [model, view, 201, 'user'] : [model, cvs, view, 201, 'user']]);
    assert.equal(call.call(editor, model, geometry, view, {}), false);
  }
});

test("temporary intersection reads native report bodies and distinguishes an empty result", async () => {
  const editor = { db: { commit() {} }, geo: { read: { geometryModel: new Map() } } };
  const body = {};
  const Solid = { Exists(id: number) { return id === 42; }, View(id: number) { assert.equal(id, 42); return body; } };
  const call = Function(`return (${nativeFunction`async function (factory, Solid) { return await nativeApi.calculateBoolean(factory, Solid); }`})`)();
  assert.deepEqual(await call.call(editor, { async calculateBoolean() { return { results: new Int32Array([42]) }; } }, Solid), { bodies: [body], noEffect: false });
  assert.deepEqual(await call.call(editor, { async calculateBoolean() { return { results: new Int32Array() }; } }, Solid), { bodies: [], noEffect: true });
  await assert.rejects(call.call(editor, { async calculateBoolean() { return { results: new Int32Array([999]) }; } }, Solid), /unavailable/);
  await assert.rejects(call.call(editor, { async calculateBoolean() { return {}; } }, Solid), /no result body IDs/);
});

test("radius measurements resolve one exact 26.2 topology view without the old point cache", () => {
  class Solid {}
  class Wire {}
  const edge = { entityId: 42, versionId: '7e42' }, snap = {};
  const editor = {
    db: { commit() {} }, geo: { read: { geometryModel: new Map() } },
    snaps: { lookupById(id: string) { assert.equal(this, editor.snaps); assert.equal(id, edge.versionId); return snap; } },
  };
  const call = Function(`return (${nativeFunction`function (item) { return nativeApi.findRadiusSnap(item, 7, 42); }`})`)();
  const solid = Object.assign(new Solid(), { high: { edges: { length: 1, get: () => edge } } });
  const wire = Object.assign(new Wire(), { segments: [edge] });
  assert.equal(call.call(editor, { view: solid }), snap);
  assert.equal(call.call(editor, { view: wire }), snap);
  wire.segments.push(edge);
  assert.throws(() => call.call(editor, { view: wire }), /missing or ambiguous/);
  wire.segments.length = 0;
  assert.throws(() => call.call(editor, { view: wire }), /missing or ambiguous/);
});

test("section cuts select the native input contract for both versions", () => {
  const target = {}, face = {};
  for (const stores of [false, true]) {
    const editor = { db: { commit() {} }, geo: stores ? { read: { geometryModel: new Map() } } : { geometryModel: new Map() } };
    const factory = {};
    const call = Function(`return (${nativeFunction`function (factory, target, face) { nativeApi.configureSectionCut(factory, target, face); }`})`)();
    call.call(editor, factory, target, face);
    assert.deepEqual(factory, stores ? { shells: [target], faces: [face] } : { target, face });
  }
});

test("point measurements read each version's actual native point-snap batch", () => {
  const snap = {}, positions = new Float32Array([0, 0, 1]), lookup = () => snap;
  const call = Function(`return (${nativeFunction`function () { return nativeApi.pointSnapEntries(); }`})`)();
  const legacyEntries = [{ positions, lookup }];
  assert.equal(call.call({ db: {}, geo: { geometryModel: new Map() }, snaps: { cache: { entries: legacyEntries } } }), legacyEntries);
  const batch = { positionss: [positions], lookups: [lookup] };
  const modern = { db: { commit() {} }, geo: { read: { geometryModel: new Map() } }, snapScene: { _pointBatch: batch } };
  const entries = call.call(modern);
  assert.equal(entries[0].positions, positions);
  assert.equal(entries[0].lookup(0), snap);
  batch.lookups.length = 0;
  assert.throws(() => call.call(modern), /inconsistent/);
});
