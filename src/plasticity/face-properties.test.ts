import assert from "node:assert/strict";
import test from "node:test";

import { measureFaceProperties, type NativeFaceProperties } from "./face-properties.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";

test("returns exact native B-Rep area, boundary length, loops, and area centroid", async () => {
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
      return [native({ bodyId: 7, faceId: "17f1" }, 17, 101, 2e-4, 0.06, [0.01, 0.005, 0])];
    },
  } as unknown as PlasticityRuntime;

  const evidence = await measureFaceProperties(runtime, [{ bodyId: 7, faceId: "17f1" }], "r1", "session-1");

  assert.equal(evidence.sessionId, "session-1");
  assert.equal(evidence.source, "native-brep-face-mass-properties");
  assert.deepEqual(evidence.faces, [{
    face: { bodyId: 7, faceId: "17f1" }, bodyVersionId: 17, bodyName: "Body 7",
    entityId: 101, surfaceType: "Plane", planar: true, areaMm2: 200,
    boundaryLengthMm: 60, areaCentroidMm: [10, 5, 0], loopCount: 1,
    innerLoopCount: 0, nativeCheckCodes: [],
  }]);
  assert.deepEqual(evidence.totals, {
    areaMm2: 200, summedBoundaryLengthMm: 60, areaWeightedCentroidMm: [10, 5, 0],
  });
  assert.deepEqual(bindings, ["pk_default"]);
  assert.deepEqual(arguments_, { faces: [{ bodyId: 7, faceId: "17f1" }] });
  assert.match(source, /lookupFaceCollection\(\[reference\.faceId\]\)/u);
  assert.match(source, /EvaluateMassProperties/u);
  assert.match(source, /\.MassProperties\(/u);
  assert.doesNotMatch(source, /GetCentroid/u);
  assert.match(source, /face\.GetLoops\(\)\.length/u);
  assert.match(source, /face\.GetInnerLoops\(\)\.length/u);
  assert.doesNotMatch(source.slice(source.lastIndexOf("return (function")), /mesh|boundingBox|this\.exec|commit\(/iu);
});

test("takes the area centroid from native mass properties, not the bounding-box centre", async () => {
  // An L-shaped 300 mm² face whose box is [0,0,0]-[0.02,0.02,0] m: the
  // collection's GetCentroid() answers the box centre, the kernel's mass
  // properties answer the real centre of area.
  const massCalls: unknown[][] = [];
  class Solid {}
  class Eval {
    context: unknown;
    constructor(context: unknown) { this.context = context; }
    MassProperties(topologyIds: Int32Array, densities: Float64Array) {
      massCalls.push([this.context, Array.from(topologyIds), Array.from(densities)]);
      return { amountSum: 3e-4, massSum: 3e-4, peripherySum: 0.08, centroids: Float64Array.of(0.0075, 0.0075, 0), centroidAvg: Float64Array.of(0.0075, 0.0075, 0), errors: Int32Array.of(0), ok: 1 };
    }
  }
  const pk_default = { a: { Eval, Context: { Get: () => "kernel-context" } } };
  const body = { Id: () => 900 };
  const face = {
    Id: () => 101,
    GetBody: () => body,
    GetSurface: () => ({ surface: { constructor: { name: "Plane" } } }),
    IsPlanar: () => true,
    GetLoops: () => [{}],
    GetInnerLoops: () => [],
    Check: () => [],
  };
  const editor = {
    geo: { geometryModel: new Map([[17, { view: Object.assign(new Solid(), { high: { faces: { versionIds: ["17f1"], get: () => ({ entityId: 101 }) } } }), model: body }]]) },
    db: {
      lookupStableId: (versionId: number) => (versionId === 17 ? 7 : undefined),
      lookupFaceCollection: () => ({
        Size: () => 1,
        Get: () => face,
        EvaluateMassProperties: () => ({ amounts: Float64Array.of(3e-4), peripheries: Float64Array.of(0.08) }),
        GetCentroid: () => ({ x: 0.01, y: 0.01, z: 0 }),
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

  const evidence = await measureFaceProperties(runtime, [{ bodyId: 7, faceId: "17f1" }], "r1", "session-1");

  assert.deepEqual(evidence.faces[0]?.areaCentroidMm, [7.5, 7.5, 0]);
  assert.equal(evidence.faces[0]?.areaMm2, 300);
  assert.deepEqual(massCalls, [["kernel-context", [101], [1]]]);
});

test("rejects a failed native face centroid evaluation", async () => {
  class Solid {}
  for (const result of [
    { centroids: Float64Array.of(0, 0, 0), errors: Int32Array.of(-1), ok: 0 },
    { centroids: Float64Array.of(0, 0), errors: Int32Array.of(0), ok: 1 },
  ]) {
    const pk_default = { a: { Eval: class { MassProperties() { return result; } }, Context: { Get: () => ({}) } } };
    const body = { Id: () => 900 };
    const face = { Id: () => 101, GetBody: () => body };
    const editor = {
      geo: { geometryModel: new Map([[17, { view: Object.assign(new Solid(), { high: { faces: { versionIds: ["17f1"], get: () => ({ entityId: 101 }) } } }), model: body }]]) },
      db: {
        lookupStableId: () => 7,
        lookupFaceCollection: () => ({ Size: () => 1, Get: () => face, EvaluateMassProperties: () => ({ amounts: [3e-4], peripheries: [0.08] }) }),
      },
    };
    const runtime = {
      async getState() { return runtimeState(); },
      async readNative(source: string, _bindings: string[], values: unknown[]) {
        const execute = new Function(`return (${source})`)() as (...args: unknown[]) => unknown;
        return execute.apply(editor, [pk_default, ...values]);
      },
    } as unknown as PlasticityRuntime;
    await assert.rejects(measureFaceProperties(runtime, [{ bodyId: 7, faceId: "17f1" }], "r1", "session-1"), /centroid/i);
  }
});

test("aggregates multiple exact faces in requested order", async () => {
  const state = runtimeState();
  const runtime = {
    async getState() { return state; },
    async readNative() {
      return [
        native({ bodyId: 8, faceId: "18f2" }, 18, 202, 1e-4, 0.04, [0.04, 0.01, 0]),
        native({ bodyId: 7, faceId: "17f1" }, 17, 101, 3e-4, 0.08, [0, 0.02, 0]),
      ];
    },
  } as unknown as PlasticityRuntime;

  const evidence = await measureFaceProperties(runtime, [
    { bodyId: 8, faceId: "18f2" }, { bodyId: 7, faceId: "17f1" },
  ], "r1", "session-1");

  assert.deepEqual(evidence.faces.map((face) => face.face), [
    { bodyId: 8, faceId: "18f2" }, { bodyId: 7, faceId: "17f1" },
  ]);
  assert.deepEqual(evidence.totals, {
    areaMm2: 400,
    summedBoundaryLengthMm: 120,
    areaWeightedCentroidMm: [10, 17.5, 0],
  });
  assert.match(evidence.limitation, /shared edges/iu);
});

test("rejects stale, duplicate, unknown, and non-shell face references before native work", async () => {
  const cases: Array<[{ bodyId: number; faceId: string }[], string, (state: RuntimeState) => void]> = [
    [[{ bodyId: 7, faceId: "17f1" }], "old", () => {}],
    [[{ bodyId: 7, faceId: "17f1" }, { bodyId: 7, faceId: "17f1" }], "r1", () => {}],
    [[{ bodyId: 99, faceId: "x" }], "r1", () => {}],
    [[{ bodyId: 7, faceId: "missing" }], "r1", () => {}],
    [[{ bodyId: 7, faceId: "17f1" }], "r1", (state) => { state.bodies[0]!.type = "Wire"; }],
  ];
  for (const [faces, revision, mutate] of cases) {
    const state = runtimeState();
    mutate(state);
    let reads = 0;
    const runtime = {
      async getState() { return state; },
      async readNative() { reads += 1; return []; },
    } as unknown as PlasticityRuntime;
    await assert.rejects(measureFaceProperties(runtime, faces, revision, "session-1"));
    assert.equal(reads, 0);
  }
});

test("rejects invalid native face properties", async () => {
  const reference = { bodyId: 7, faceId: "17f1" };
  const invalid: NativeFaceProperties[] = [
    native(reference, 17, 101, Number.NaN, 0.06, [0.01, 0.005, 0]),
    native(reference, 17, 101, 2e-4, 0, [0.01, 0.005, 0]),
    native(reference, 17, 101, 2e-4, 0.06, [Number.NaN, 0.005, 0]),
    native(reference, 17, 101, 2e-4, 0.06, [0.01, 0.005, 0], { loopCount: 0 }),
    native(reference, 17, 101, 2e-4, 0.06, [0.01, 0.005, 0], { nativeCheckCodes: [17] }),
  ];
  for (const result of invalid) {
    const state = runtimeState();
    const runtime = {
      async getState() { return state; }, async readNative() { return [result]; },
    } as unknown as PlasticityRuntime;
    await assert.rejects(measureFaceProperties(runtime, [reference], "r1", "session-1"));
  }
});

test("discards face-property results when the persistent document changes", async () => {
  for (const changed of [
    { documentToken: "doc-2" }, { revision: "r2" }, { undoDepth: 3 }, { redoDepth: 1 },
    { bodies: [{ ...runtimeState().bodies[0]!, versionId: 99 }, runtimeState().bodies[1]!] },
  ]) {
    let stateReads = 0;
    const runtime = {
      async getState() { stateReads += 1; return stateReads === 1 ? runtimeState() : { ...runtimeState(), ...changed }; },
      async readNative() { return [native({ bodyId: 7, faceId: "17f1" }, 17, 101, 2e-4, 0.06, [0.01, 0.005, 0])]; },
    } as unknown as PlasticityRuntime;
    await assert.rejects(measureFaceProperties(runtime, [{ bodyId: 7, faceId: "17f1" }], "r1", "session-1"), /changed during/iu);
  }
});

function native(
  face: { bodyId: number; faceId: string },
  bodyVersionId: number,
  entityId: number,
  areaM2: number,
  boundaryLengthM: number,
  areaCentroidM: [number, number, number],
  overrides: Partial<NativeFaceProperties> = {},
): NativeFaceProperties {
  return {
    face, bodyVersionId, entityId, surfaceType: "Plane", planar: true,
    areaM2, boundaryLengthM, areaCentroidM, loopCount: 1, innerLoopCount: 0,
    nativeCheckCodes: [], ...overrides,
  };
}

function runtimeState(): RuntimeState {
  const body = (id: number, versionId: number, faceId: string): RuntimeState["bodies"][number] => ({
    id, versionId, type: "Solid", name: `Body ${id}`,
    boundsMm: { min: [0, 0, 0], max: [20, 10, 5] },
    faceIds: [faceId], edgeIds: [], faces: [], edges: [],
  });
  return {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision: "r1",
    dbVersion: 1, undoDepth: 2, redoDepth: 0, regions: [],
    construction: { planes: [], activePlaneId: null, planeStateToken: "p0", viewStateToken: "v0" },
    bodies: [body(7, 17, "17f1"), body(8, 18, "18f2")],
  };
}
