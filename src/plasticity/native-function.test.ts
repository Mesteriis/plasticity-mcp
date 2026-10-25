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

test("shell unjoin extracts each face once and replaces all modern inputs in one factory", async () => {
  const faces = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const shells = [
    { high: { faces: { length: 2, get: (index: number) => faces[index] } } },
    { high: { faces: { length: 1, get: () => faces[2] } } },
  ];
  const editor = { db: { commit() {} }, geo: { read: { geometryModel: new Map() } } };
  const seen: unknown[] = [];
  class Sheets {
    faces: unknown[] = [];
    constructor(value: unknown) { assert.equal(value, editor); }
    async calculate(partition: unknown) {
      assert.equal(partition, "native-partition");
      assert.equal(this.faces.length, 1);
      seen.push(this.faces[0]);
      return [{ GetFaces: () => ({ Size: () => 1 }) }];
    }
  }
  const originalCalculate = Sheets.prototype.calculate;
  const call = Function(`return (${nativeFunction`function (Sheets, shells) { return nativeApi.createUnjoinFactory(null, Sheets, shells); }`})`)();
  const factory = call.call(editor, Sheets, shells);
  assert.equal(factory.originalItems, shells);
  assert.equal((await factory.calculate("native-partition")).length, 3);
  assert.deepEqual(seen, faces);
  assert.equal(Sheets.prototype.calculate, originalCalculate, "the native prototype must remain unchanged");
  class InvalidSheets extends Sheets { async calculate() { return [{ GetFaces: () => ({ Size: () => 2 }) }]; } }
  await assert.rejects(call.call(editor, InvalidSheets, shells).calculate("native-partition"), /one Sheet per face/);
});

test("legacy shell unjoin retains the native shell factory", () => {
  const editor = { db: {}, geo: { geometryModel: new Map() } };
  class Shells { shells: unknown[] = []; constructor(value: unknown) { assert.equal(value, editor); } }
  const shells = [{}];
  const call = Function(`return (${nativeFunction`function (Shells, shells) { return nativeApi.createUnjoinFactory(Shells, null, shells); }`})`)();
  const factory = call.call(editor, Shells, shells);
  assert.ok(factory instanceof Shells);
  assert.equal(factory.shells, shells);
});

test("modern shell offset uses native arc lengths for both ends of a curved shared edge", async () => {
  const point = (x: number) => ({ x, y: 0, z: 0 });
  const edge = {
    Id: () => 7, FindLength: () => ({ length: 0.01 }), Denormalize: (t: number) => t,
    GetCurve: () => ({ curve: { GetLength: (a: number, b: number) => 0.01 * (b * b - a * a) } }),
    GetPointAndTangent: (t: number) => ({ position: point(0.01 * t * t) }),
  };
  const collection = { Size: () => 1, Get: () => edge };
  const vertices = [0, 0.01].map(x => ({ GetPoint: () => point(x), GetEdges: () => ({ in: collection, out: collection }) }));
  const snaps = vertices.map(model => ({ model, item: {}, position: {} }));
  const report = {}, calls: Array<{ edges: number[]; parameters: number[] }> = [];
  class Operation {
    constructor(context: unknown) { assert.equal(context, 'native-context'); }
    async SplitEdges_async(edges: Int32Array, parameters: Float64Array) {
      calls.push({ edges: [...edges], parameters: [...parameters] });
      return { vertices: Int32Array.from(parameters, (_, index) => 100 + index), report };
    }
  }
  const kernel = { Operation, Context: { Get: () => 'native-context' } };
  const editor = { db: { commit() {} }, geo: { read: { geometryModel: new Map() } } };
  const constraints = () => {};
  const factory = { distance: 0.002, _vertices: { models: vertices, views: [] }, prepareConstraints: constraints, resultFromCommit: constraints };
  const call = Function(`return (${nativeFunction`function (factory, snaps, kernel) { nativeApi.configureOffsetVertices(factory, snaps, kernel); }`})`)();
  call.call(editor, factory, snaps, kernel);
  assert.equal(await (factory as any).calculate(), report);
  assert.deepEqual(calls[0]!.edges, [7, 7]);
  for (const [index, expected] of [Math.sqrt(0.2), Math.sqrt(0.8)].entries()) assert.ok(Math.abs(calls[0]!.parameters[index]! - expected) < 1e-9);
  assert.equal(factory.prepareConstraints, constraints);
  assert.equal(factory.resultFromCommit, constraints);
  factory.distance = 0.005;
  await (factory as any).calculate();
  assert.equal(calls[1]!.parameters.length, 1, "coincident stations must be split only once");
  factory.distance = 0.01;
  await assert.rejects((factory as any).calculate(), /shorter than every incident edge/);
  assert.equal(calls.length, 2, "invalid distances must not invoke the native operation");
});

test("legacy shell offset keeps the original calculate path and ownership bridge", () => {
  const editor = { db: {}, geo: { geometryModel: new Map() } };
  const calculate = () => {}, model = {}, item = {}, position = {};
  const factory = { calculate, _vertices: { views: [] } };
  const call = Function(`return (${nativeFunction`function (factory, snaps) { nativeApi.configureOffsetVertices(factory, snaps); }`})`)();
  call.call(editor, factory, [{ model, item, position }]);
  assert.equal(factory.calculate, calculate);
  assert.deepEqual(factory._vertices.views, [{ parentItem: item, position }]);
});
