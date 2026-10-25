import assert from "node:assert/strict";
import test from "node:test";

import { measureSolidProperties, type NativeSolidProperties } from "./solid-properties.ts";
import { PlasticityOperations } from "./operations.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";

test("returns exact native B-Rep volume, surface area, and volume centroid", async () => {
  const state = runtimeState();
  let source = "";
  let bindings: string[] = [];
  let arguments_: unknown;
  const runtime = {
    async getState() { return state; },
    async readNative(source_: string, bindings_: string[], values: unknown[]) {
      source = source_;
      bindings = bindings_;
      arguments_ = values[0];
      return [native(7, 17, 1e-6, 0.0007, [0.02, 0.025, 0.0325])];
    },
  } as unknown as PlasticityRuntime;

  const evidence = await measureSolidProperties(runtime, [7], "r1", "session-1");

  assert.equal(evidence.sessionId, "session-1");
  assert.equal(evidence.documentToken, "doc-1");
  assert.equal(evidence.revision, "r1");
  assert.equal(evidence.source, "native-brep-mass-properties");
  assert.deepEqual(evidence.bodies, [{
    id: 7,
    versionId: 17,
    name: "Body 7",
    volumeMm3: 1000,
    surfaceAreaMm2: 700,
    volumeCentroidMm: [20, 25, 32.5],
    nativeCheckCodes: [],
  }]);
  assert.deepEqual(evidence.totals, {
    volumeMm3: 1000,
    surfaceAreaMm2: 700,
    volumeWeightedCentroidMm: [20, 25, 32.5],
  });
  assert.deepEqual(bindings, ["pk_default"]);
  assert.deepEqual(arguments_, { ids: [7] });
  assert.match(source, /lookupBodyCollection\(\[versionId\]\)/);
  assert.match(source, /EvaluateMassProperties/);
  assert.match(source, /\.MassProperties\(/);
  assert.doesNotMatch(source, /GetCentroid/);
  assert.doesNotMatch(source.slice(source.lastIndexOf("return (function")), /mesh|boundingBox|this\.exec|commit\(/i);
});

test("takes the volume centroid from native mass properties, not the bounding-box centre", async () => {
  // An L-shaped 1000 mm³ Solid whose box is [0,0,0]-[0.02,0.02,0.005] m: the
  // collection's GetCentroid() answers the box centre, the kernel's mass
  // properties answer the real centre of volume.
  const massCalls: unknown[][] = [];
  class Solid {}
  class Eval {
    context: unknown;
    constructor(context: unknown) { this.context = context; }
    MassProperties(topologyIds: Int32Array, densities: Float64Array) {
      massCalls.push([this.context, Array.from(topologyIds), Array.from(densities)]);
      return { amountSum: 1e-6, massSum: 1e-6, peripherySum: 0.0007, centroids: Float64Array.of(0.0075, 0.0075, 0.0025), centroidAvg: Float64Array.of(0.0075, 0.0075, 0.0025), errors: Int32Array.of(0), ok: 1 };
    }
  }
  const pk_default = { a: { Eval, Context: { Get: () => "kernel-context" } } };
  const editor = {
    geo: { geometryModel: new Map([[17, { view: new Solid(), model: { Id: () => 4242, Check: () => [] } }]]) },
    db: {
      lookupStableId: (versionId: number) => (versionId === 17 ? 7 : undefined),
      lookupBodyCollection: () => ({
        Size: () => 1,
        EvaluateMassProperties: () => ({ amounts: Float64Array.of(1e-6), peripheries: Float64Array.of(0.0007) }),
        GetCentroid: () => ({ x: 0.01, y: 0.01, z: 0.0025 }),
      }),
    },
  };
  const runtime = {
    async getState() { return runtimeState(); },
    async readNative(source: string, bindings: string[], values: unknown[]) {
      const natives: Record<string, unknown> = { pk_default };
      const execute = new Function(`return (${source})`)() as (...args: unknown[]) => unknown;
      return execute.apply(editor, [...bindings.map((name) => natives[name]), ...values]);
    },
  } as unknown as PlasticityRuntime;

  const evidence = await measureSolidProperties(runtime, [7], "r1", "session-1");

  assert.deepEqual(evidence.bodies[0]?.volumeCentroidMm, [7.5, 7.5, 2.5]);
  assert.equal(evidence.bodies[0]?.volumeMm3, 1000);
  assert.deepEqual(massCalls, [["kernel-context", [4242], [1]]]);
});

test("rejects a failed native centroid evaluation", async () => {
  class Solid {}
  for (const result of [
    { centroids: Float64Array.of(0, 0, 0), errors: Int32Array.of(-1), ok: 0 },
    { centroids: Float64Array.of(0, 0), errors: Int32Array.of(0), ok: 1 },
  ]) {
    const pk_default = { a: { Eval: class { MassProperties() { return result; } }, Context: { Get: () => ({}) } } };
    const editor = {
      geo: { geometryModel: new Map([[17, { view: new Solid(), model: { Id: () => 1, Check: () => [] } }]]) },
      db: {
        lookupStableId: () => 7,
        lookupBodyCollection: () => ({ Size: () => 1, EvaluateMassProperties: () => ({ amounts: [1e-6], peripheries: [0.0007] }) }),
      },
    };
    const runtime = {
      async getState() { return runtimeState(); },
      async readNative(source: string, _bindings: string[], values: unknown[]) {
        const execute = new Function(`return (${source})`)() as (...args: unknown[]) => unknown;
        return execute.apply(editor, [pk_default, ...values]);
      },
    } as unknown as PlasticityRuntime;
    await assert.rejects(measureSolidProperties(runtime, [7], "r1", "session-1"), /centroid/i);
  }
});

test("aggregates multiple exact solids without losing requested order", async () => {
  const state = runtimeState();
  const runtime = {
    async getState() { return state; },
    async readNative() {
      return [
        native(8, 18, 3e-6, 0.001, [0.04, 0.02, 0.01]),
        native(7, 17, 1e-6, 0.0007, [0.02, 0.025, 0.0325]),
      ];
    },
  } as unknown as PlasticityRuntime;

  const evidence = await measureSolidProperties(runtime, [8, 7], "r1", "session-1");

  assert.deepEqual(evidence.bodies.map((body) => body.id), [8, 7]);
  assert.equal(evidence.totals.volumeMm3, 4000);
  assert.equal(evidence.totals.surfaceAreaMm2, 1700);
  assert.deepEqual(evidence.totals.volumeWeightedCentroidMm, [35, 21.25, 15.625]);
});

test("rejects stale, duplicate, unknown and non-Solid references before native work", async () => {
  const cases: Array<[number[], string, (state: RuntimeState) => void]> = [
    [[7], "old", () => {}],
    [[7, 7], "r1", () => {}],
    [[99], "r1", () => {}],
    [[7], "r1", (state) => { state.bodies[0]!.type = "Sheet"; }],
  ];
  for (const [ids, revision, mutate] of cases) {
    const state = runtimeState();
    mutate(state);
    let reads = 0;
    const runtime = {
      async getState() { return state; },
      async readNative() { reads += 1; return []; },
    } as unknown as PlasticityRuntime;
    await assert.rejects(measureSolidProperties(runtime, ids, revision, "session-1"));
    assert.equal(reads, 0);
  }
});

test("rejects invalid native measurements instead of substituting mesh estimates", async () => {
  const invalidResults: NativeSolidProperties[] = [
    native(7, 17, Number.NaN, 0.0007, [0.02, 0.025, 0.0325]),
    native(7, 17, 1e-6, 0, [0.02, 0.025, 0.0325]),
    native(7, 17, 1e-6, 0.0007, [Number.NaN, 0.025, 0.0325]),
    native(7, 17, 1e-6, 0.0007, [0.02, 0.025, 0.0325], [17]),
  ];
  for (const result of invalidResults) {
    const state = runtimeState();
    const runtime = {
      async getState() { return state; },
      async readNative() { return [result]; },
    } as unknown as PlasticityRuntime;
    await assert.rejects(measureSolidProperties(runtime, [7], "r1", "session-1"));
  }
});

test("discards results when the persistent document changes during measurement", async () => {
  for (const changed of [
    { documentToken: "doc-2" },
    { revision: "r2" },
    { undoDepth: 3 },
    { redoDepth: 1 },
    { bodies: [{ ...runtimeState().bodies[0]!, versionId: 99 }, runtimeState().bodies[1]!] },
  ]) {
    let stateReads = 0;
    const runtime = {
      async getState() { stateReads += 1; return stateReads === 1 ? runtimeState() : { ...runtimeState(), ...changed }; },
      async readNative() { return [native(7, 17, 1e-6, 0.0007, [0.02, 0.025, 0.0325])]; },
    } as unknown as PlasticityRuntime;
    await assert.rejects(measureSolidProperties(runtime, [7], "r1", "session-1"), /changed during/i);
  }
});

test("PlasticityOperations binds exact solid properties to its owned session", async () => {
  const state = runtimeState();
  const runtime = {
    async getState() { return state; },
    async readNative() { return [native(7, 17, 1e-6, 0.0007, [0.02, 0.025, 0.0325])]; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime, "owned-session");

  const evidence = await operations.measureSolidProperties([7], "r1");

  assert.equal(evidence.sessionId, "owned-session");
});

function native(
  id: number,
  versionId: number,
  volumeM3: number,
  surfaceAreaM2: number,
  centroidM: [number, number, number],
  nativeCheckCodes: number[] = [],
): NativeSolidProperties {
  return { id, versionId, volumeM3, surfaceAreaM2, centroidM, nativeCheckCodes };
}

function runtimeState(): RuntimeState {
  const body = (id: number, versionId: number): RuntimeState["bodies"][number] => ({
    id, versionId, type: "Solid", name: `Body ${id}`,
    boundsMm: { min: [0, 0, 0], max: [10, 10, 10] },
    faceIds: [], edgeIds: [], faces: [], edges: [],
  });
  return {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision: "r1",
    dbVersion: 1, undoDepth: 2, redoDepth: 0, regions: [],
    construction: { planes: [], activePlaneId: null, planeStateToken: "p0", viewStateToken: "v0" },
    bodies: [body(7, 17), body(8, 18)],
  };
}
