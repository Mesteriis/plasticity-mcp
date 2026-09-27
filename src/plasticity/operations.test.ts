import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { PlasticityOperations } from "./operations.ts";
import { frameFromOriginNormalX } from "./construction.ts";
import { evaluateSvgCubicBezier, type SvgCubicBezier } from "./svg-cubic.ts";
import { countActiveCurveSpans } from "./curve-span-count.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";

const emptyConstruction: RuntimeState["construction"] = {
  planes: [],
  activePlaneId: "standard:top",
  planeStateToken: "planes:empty",
  viewStateToken: "workplane:standard:top",
};

test("screenshot refuses a stale renderer surface while Plasticity is hidden", async () => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-screenshot-hidden-test-"));
  const calls: string[] = [];
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png, 0);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(1, 16);
  png.writeUInt32BE(1, 20);
  const runtime = {
    async cdp(method: string) { calls.push(method); },
    async read() { return true; },
    async captureScreenshot() { calls.push("captureScreenshot"); return png.toString("base64"); },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime, "session-1");
  const output = join(root, "view.png");
  try {
    await assert.rejects(operations.screenshot(output), /renderer is hidden.*activate Plasticity/i);
    assert.deepEqual(calls, ["Page.bringToFront"]);
    await assert.rejects(readFile(output), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("screenshot saves the validated PNG frame when Plasticity is visible", async () => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-screenshot-visible-test-"));
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png, 0);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(1, 16);
  png.writeUInt32BE(1, 20);
  const runtime = {
    async cdp() {},
    async read() { return false; },
    async captureScreenshot() { return png.toString("base64"); },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime, "session-1");
  const output = join(root, "view.png");
  try {
    const result = await operations.screenshot(output);
    assert.equal(result.bytes, png.length);
    assert.deepEqual(await readFile(output), png);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exports selected native bodies as a validated, millimeter-scaled 3MF package", async () => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-3mf-test-"));
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const body = { id: 7, versionId: 17, type: "Solid", name: "Box", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body] };
  const archive = testThreeMfArchive();
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) {
      call = { source, bindings, values };
      const args = values[0] as { path: string };
      await writeFile(args.path, archive);
      return {};
    },
    isUncertain() { return false; },
  } as unknown as PlasticityRuntime;
  try {
    const output = join(root, "box.3mf");
    const operations = new PlasticityOperations(runtime);

    const result = await operations.export3mf([7], output, state.revision, 0.05, 15);

    assert.deepEqual(call?.bindings, ["ThreeMfExportFactory"]);
    const exportArgs = call?.values[0] as { ids: number[]; path: string; scale: number; chordTolerance: number; angleToleranceDegrees: number };
    assert.deepEqual({ ...exportArgs, path: "<staging>" }, { ids: [7], path: "<staging>", scale: 0.001, chordTolerance: 0.00005, angleToleranceDegrees: 15 });
    assert.match(exportArgs.path, /\.plasticity-3mf-[^/]+\/geometry\.3mf$/u);
    assert.match(call?.source ?? "", /factory\.shells = args\.ids\.map\(find\)/u);
    assert.match(call?.source ?? "", /factory\.scale = args\.scale/u);
    assert.deepEqual(result, {
      path: output,
      bytes: archive.length,
      modelUnit: "meter",
      sourceUnits: "millimeter",
      objects: 1,
      buildItems: 1,
      vertices: 3,
      triangles: 1,
      boundsMm: { min: [0, 0, 0], max: [20, 10, 0], size: [20, 10, 0] },
      chordToleranceMm: 0.05,
      angleToleranceDegrees: 15,
    });
    assert.deepEqual(await readFile(output), archive);
    await assert.rejects(operations.export3mf([7], output, state.revision, 0.05, 15), /overwrite/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects stale, duplicate, missing, and non-B-Rep 3MF body selections before export", async () => {
  let mutations = 0;
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1,
    undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [],
    bodies: [
      { id: 7, versionId: 17, type: "Solid", name: "Box", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [] },
      { id: 8, versionId: 18, type: "Wire", name: "Path", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [] },
    ],
  };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; }, isUncertain() { return false; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.export3mf([7], "/tmp/stale.3mf", "old", 0.05, 15), /stale reference/iu);
  await assert.rejects(operations.export3mf([], "/tmp/empty.3mf", state.revision, 0.05, 15), /nonempty unique/u);
  await assert.rejects(operations.export3mf([7, 7], "/tmp/duplicate.3mf", state.revision, 0.05, 15), /nonempty unique/u);
  await assert.rejects(operations.export3mf([99], "/tmp/missing.3mf", state.revision, 0.05, 15), /unknown current body/iu);
  await assert.rejects(operations.export3mf([8], "/tmp/wire.3mf", state.revision, 0.05, 15), /Solid or Sheet/u);
  await assert.rejects(operations.export3mf([7], "/tmp/bad.obj", state.revision, 0.05, 15), /end in \.3mf/u);
  assert.equal(mutations, 0);
});

test("exports selected native bodies as a validated millimeter OBJ mesh", async () => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-obj-test-"));
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const body = { id: 7, versionId: 17, type: "Solid", name: "Box", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body] };
  const payload = Buffer.from("o Box\nv 0 0 0\nv 20 0 0\nv 0 10 5\nvt 0 0\nvt 1 0\nvt 0 1\nvn 0 0 1\nf 1/1/1 2/2/1 3/3/1\n");
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) {
      call = { source, bindings, values };
      await writeFile((values[0] as { path: string }).path, payload);
      return {};
    },
    isUncertain() { return false; },
  } as unknown as PlasticityRuntime;
  try {
    const output = join(root, "box.obj");
    const operations = new PlasticityOperations(runtime);

    const result = await operations.exportObj([7], output, state.revision, 0.08, 12);

    assert.deepEqual(call?.bindings, ["OBJExportFactory"]);
    const exportArgs = call?.values[0] as { ids: number[]; path: string; chordTolerance: number; angleToleranceDegrees: number };
    assert.deepEqual({ ...exportArgs, path: "<staging>" }, { ids: [7], path: "<staging>", chordTolerance: 0.00008, angleToleranceDegrees: 12 });
    assert.match(exportArgs.path, /\.plasticity-obj-[^/]+\/geometry\.obj$/u);
    assert.match(call?.source ?? "", /factory\.unit = 'millimeter'/u);
    assert.match(call?.source ?? "", /factory\.upAxis = 'z'/u);
    assert.match(call?.source ?? "", /factory\.showWireframe = false/u);
    assert.deepEqual(result, {
      path: output,
      bytes: payload.length,
      sourceUnits: "millimeter",
      upAxis: "z",
      objects: 1,
      vertices: 3,
      textureCoordinates: 3,
      normals: 1,
      faces: 1,
      triangles: 1,
      boundsMm: { min: [0, 0, 0], max: [20, 10, 5], size: [20, 10, 5] },
      chordToleranceMm: 0.08,
      angleToleranceDegrees: 12,
    });
    assert.deepEqual(await readFile(output), payload);
    await assert.rejects(operations.exportObj([7], output, state.revision, 0.08, 12), /overwrite/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exports exact planar native line Wires as an SVG with millimeter dimensions", async () => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-svg-export-test-"));
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1,
    undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [],
    bodies: [{ id: 7, versionId: 17, type: "Wire", name: "Rectangle", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [] }],
  };
  const wireGeometry = [{
    id: 7,
    plane: { originMm: [0, 0, 0], normal: [0, 0, 1] },
    segments: [
      { curveType: "Line", startMm: [0, 0, 0], endMm: [20, 0, 0] },
      { curveType: "Line", startMm: [20, 0, 0], endMm: [20, 10, 0] },
      { curveType: "Line", startMm: [20, 10, 0], endMm: [0, 10, 0] },
      { curveType: "Line", startMm: [0, 10, 0], endMm: [0, 0, 0] },
    ],
  }];
  const runtime = {
    async getState() { return state; },
    async readNative() { return wireGeometry; },
  } as unknown as PlasticityRuntime;
  try {
    const output = join(root, "rectangle.svg");
    const result = await new PlasticityOperations(runtime).exportSvg([7], output, state.revision);
    const svg = await readFile(output, "utf8");
    assert.deepEqual(result, {
      path: output,
      bytes: Buffer.byteLength(svg),
      bodies: 1,
      lineSegments: 4,
      circularSegments: 0,
      fullCircles: 0,
      fullEllipses: 0,
      ellipticalArcs: 0,
      cubicBezierSegments: 0,
      approximatedSegments: 0,
      maxChordDeviationMm: 0,
      curveChordToleranceMm: 0.05,
      curveChordAngleDegrees: 5,
      sourceUnits: "millimeter",
      boundsMm: { min: [0, -10], max: [20, 0], size: [20, 10] },
      pageSizeMm: [20.2, 10.2],
    });
    assert.match(svg, /width="20\.2mm" height="10\.2mm" viewBox="-0\.1 -10\.1 20\.2 10\.2"/u);
    assert.equal((svg.match(/<path /gu) ?? []).length, 4);
    assert.match(svg, /stroke-width="0\.2"/u);
    assert.match(svg, /M 0 0 L 20 0/u);
    assert.match(svg, /M 20 -10 L 0 -10/u);
    await assert.rejects(new PlasticityOperations(runtime).exportSvg([7], output, state.revision), /overwrite/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exports a validated polynomial cubic BCurve as an exact SVG cubic with analytic bounds", async () => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-svg-cubic-test-"));
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1,
    undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [],
    bodies: [{ id: 9, versionId: 19, type: "Wire", name: "Cubic", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [] }],
  };
  const controls: [[number, number], [number, number], [number, number], [number, number]] = [[0, 0], [0, 3], [3, 3], [3, 0]];
  const samplesMm = [0, 1 / 3, 2 / 3, 1].map((parameter) => {
    const point = evaluateSvgCubicBezier(controls, parameter);
    return [point[0], point[1], 0] as [number, number, number];
  });
  const validationSamples = [1 / 8, 1 / 4, 1 / 2, 3 / 4, 7 / 8].map((parameter) => {
    const point = evaluateSvgCubicBezier(controls, parameter);
    return { parameter, positionMm: [point[0], point[1], 0] as [number, number, number] };
  });
  const runtime = {
    async getState() { return state; },
    async readNative() { return [{
      id: 9,
      plane: { originMm: [0, 0, 0], normal: [0, 0, 1] },
      segments: [{ curveType: "BCurve", startMm: [0, 0, 0], endMm: [3, 0, 0], cubicBezierSpans: [{ samplesMm, validationSamples }], approximation: null }],
    }]; },
  } as unknown as PlasticityRuntime;
  try {
    const output = join(root, "cubic.svg");
    const result = await new PlasticityOperations(runtime).exportSvg([9], output, state.revision);
    const svg = await readFile(output, "utf8");
    assert.equal(result.cubicBezierSegments, 1);
    assert.equal(result.approximatedSegments, 0);
    result.boundsMm.min.forEach((value, index) => assert.ok(Math.abs(value - [0, -2.25][index]!) < 1e-12));
    result.boundsMm.max.forEach((value, index) => assert.ok(Math.abs(value - [3, 0][index]!) < 1e-12));
    result.boundsMm.size.forEach((value, index) => assert.ok(Math.abs(value - [3, 2.25][index]!) < 1e-12));
    assert.match(svg, /<path d="M 0 0 C 0 -3 3 -3 3 0" data-curve-type="BCurve"\/>/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exports a validated polynomial quadratic BCurve as an exact SVG cubic without approximation", async () => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-svg-quadratic-test-"));
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1,
    undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [],
    bodies: [{ id: 10, versionId: 20, type: "Wire", name: "Quadratic", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [] }],
  };
  const evaluateQuadratic = (parameter: number): [number, number] => [10 * parameter, 8 * parameter * (1 - parameter)];
  const samplesMm = [0, 1 / 3, 2 / 3, 1].map((parameter) => {
    const point = evaluateQuadratic(parameter);
    return [point[0], point[1], 0] as [number, number, number];
  });
  const validationSamples = [1 / 8, 1 / 4, 1 / 2, 3 / 4, 7 / 8].map((parameter) => {
    const point = evaluateQuadratic(parameter);
    return { parameter, positionMm: [point[0], point[1], 0] as [number, number, number] };
  });
  const runtime = {
    async getState() { return state; },
    async readNative() { return [{
      id: 10,
      plane: { originMm: [0, 0, 0], normal: [0, 0, 1] },
      segments: [{ curveType: "BCurve", startMm: [0, 0, 0], endMm: [10, 0, 0], lengthMm: 12, cubicBezierSpans: [{ samplesMm, validationSamples }], approximation: null }],
    }]; },
  } as unknown as PlasticityRuntime;
  try {
    const output = join(root, "quadratic.svg");
    const result = await new PlasticityOperations(runtime).exportSvg([10], output, state.revision);
    const svg = await readFile(output, "utf8");
    assert.equal(result.cubicBezierSegments, 1);
    assert.equal(result.approximatedSegments, 0);
    assert.match(svg, /<path d="M 0 0 C 3\.333333333333 -2\.666666666667 6\.666666666667 -2\.666666666667 10 0" data-curve-type="BCurve"\/>/u);
    assert.doesNotMatch(svg, /data-approximation=/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extracts a native non-rational quadratic BCurve through the CDP bridge and exports it exactly", async () => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-svg-native-quadratic-test-"));
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1,
    undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [],
    bodies: [{ id: 11, versionId: 21, type: "Wire", name: "Native quadratic", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [] }],
  };
  const evaluateQuadratic = (parameter: number) => ({
    x: 0.01 * parameter,
    y: 0.008 * parameter * (1 - parameter),
    z: 0,
  });
  class BCurve {
    GetInfo() { return { degree: 2, isRational: false, numDistinctKnots: 2, knotVals: [0, 1] }; }
  }
  class Wire {}
  const edge = {
    GetCurve() { return { curve: new BCurve() }; },
    Normalize(parameter: number) { return parameter; },
    GetPointAndTangent(parameter: number) {
      return { position: evaluateQuadratic(parameter), tangent: { x: 1, y: 1, z: 0 } };
    },
    FindLength() { return { length: 0.012 }; },
  };
  const item = {
    view: Object.assign(new Wire(), { vertices: [] }),
    model: {
      FindPlanarBasis() { return { Location: { x: 0, y: 0, z: 0 }, Axis: { x: 0, y: 0, z: 1 } }; },
      GetEdges() { return { Size: () => 1, Get: () => edge }; },
    },
  };
  const nativeApp = {
    geo: { geometryModel: new Map([[21, item]]) },
    db: {
      lookupStableId(versionId: number) { return versionId === 21 ? 11 : null; },
      lookupTopologyItem() { return { IsSpur: () => false }; },
    },
  };
  const runtime = {
    async getState() { return state; },
    async readNative(source: string, _bindings: string[], values: unknown[]) {
      const execute = new Function(`return (${source})`)() as (this: typeof nativeApp, args: unknown) => unknown;
      return execute.call(nativeApp, values[0]);
    },
  } as unknown as PlasticityRuntime;
  try {
    const output = join(root, "native-quadratic.svg");
    const result = await new PlasticityOperations(runtime).exportSvg([11], output, state.revision);
    const svg = await readFile(output, "utf8");
    assert.equal(result.cubicBezierSegments, 1);
    assert.equal(result.approximatedSegments, 0);
    assert.match(svg, /<path d="M 0 0 C 3\.333333333333 -2\.666666666667 6\.666666666667 -2\.666666666667 10 0" data-curve-type="BCurve"\/>/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exports a closed periodic polynomial cubic BCurve as validated exact SVG cubic spans", async () => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-svg-periodic-cubic-test-"));
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1,
    undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [],
    bodies: [{ id: 9, versionId: 19, type: "Wire", name: "Periodic cubic", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [] }],
  };
  const controls: SvgCubicBezier[] = [
    [[0, 0], [0, -1], [1, -1], [1, 0]],
    [[1, 0], [1, 1], [0, 1], [0, 0]],
  ];
  const spans = controls.map((spanControls) => ({
    samplesMm: [0, 1 / 3, 2 / 3, 1].map((parameter) => {
      const point = evaluateSvgCubicBezier(spanControls, parameter);
      return [point[0], point[1], 0] as [number, number, number];
    }),
    validationSamples: [1 / 8, 1 / 4, 1 / 2, 3 / 4, 7 / 8].map((parameter) => {
      const point = evaluateSvgCubicBezier(spanControls, parameter);
      return { parameter, positionMm: [point[0], point[1], 0] as [number, number, number] };
    }),
  }));
  const runtime = {
    async getState() { return state; },
    async readNative() { return [{
      id: 9,
      closed: true,
      plane: { originMm: [0, 0, 0], normal: [0, 0, 1] },
      segments: [{ curveType: "BCurve", startMm: [0, 0, 0], endMm: [0, 0, 0], lengthMm: 6, cubicBezierSpans: spans, approximation: null }],
    }]; },
  } as unknown as PlasticityRuntime;
  try {
    const output = join(root, "periodic.svg");
    const result = await new PlasticityOperations(runtime).exportSvg([9], output, state.revision);
    const svg = await readFile(output, "utf8");
    assert.equal(result.cubicBezierSegments, 1);
    assert.equal(result.approximatedSegments, 0);
    assert.match(svg, /<path d="M 0 0 C [^"]+ C [^"]+" data-curve-type="BCurve"\/>/u);
    assert.doesNotMatch(svg, /data-approximation=/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exports native full circles and trimmed circular arcs as exact SVG primitives", async () => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-svg-circular-export-test-"));
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1,
    undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [],
    bodies: [7, 8].map((id) => ({ id, versionId: id + 10, type: "Wire", name: "Circle", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [] })),
  };
  const circleSamples = [
    [105, 100, 0], [100, 105, 0], [95, 100, 0], [100, 95, 0], [105, 100, 0],
  ] as [number, number, number][];
  const arcSamples = [30, 85, 140, 195, 250].map((angle) => [
    130 + 5 * Math.cos(angle * Math.PI / 180),
    100 + 5 * Math.sin(angle * Math.PI / 180),
    0,
  ] as [number, number, number]);
  const wireGeometry = [
    { id: 7, closed: true, plane: { originMm: [0, 0, 0], normal: [0, 0, 1] }, segments: [{ curveType: "Circle", startMm: circleSamples[0]!, endMm: circleSamples[4]!, lengthMm: 2 * Math.PI * 5, circle: { centerMm: [100, 100, 0], radiusMm: 5, normal: [0, 0, 1], samplesMm: circleSamples } }] },
    { id: 8, closed: false, plane: { originMm: [0, 0, 0], normal: [0, 0, 1] }, segments: [{ curveType: "Circle", startMm: arcSamples[0]!, endMm: arcSamples[4]!, lengthMm: 5 * 220 * Math.PI / 180, circle: { centerMm: [130, 100, 0], radiusMm: 5, normal: [0, 0, 1], samplesMm: arcSamples } }] },
  ];
  const runtime = {
    async getState() { return state; },
    async readNative() { return wireGeometry; },
  } as unknown as PlasticityRuntime;
  try {
    const output = join(root, "circles.svg");
    const result = await new PlasticityOperations(runtime).exportSvg([7, 8], output, state.revision);
    const svg = await readFile(output, "utf8");
    assert.equal(result.bodies, 2);
    assert.equal(result.lineSegments, 0);
    assert.equal(result.circularSegments, 2);
    assert.equal(result.fullCircles, 1);
    assert.equal(result.approximatedSegments, 0);
    assert.deepEqual(result.sourceUnits, "millimeter");
    assert.ok(Math.abs(result.boundsMm.min[0] - 95) < 1e-9);
    assert.ok(Math.abs(result.boundsMm.min[1] + 105) < 1e-9);
    assert.ok(Math.abs(result.boundsMm.max[0] - arcSamples[0]![0]) < 1e-9);
    assert.ok(Math.abs(result.boundsMm.max[1] + 95) < 1e-9);
    assert.match(svg, /<circle cx="100" cy="-100" r="5"\/>/u);
    assert.match(svg, /A 5 5 0 1 0 128\.289899283372 -95\.30153689607/u);
    assert.equal((svg.match(/<circle /gu) ?? []).length, 1);
    assert.equal((svg.match(/ A /gu) ?? []).length, 1);
    assert.equal(result.bytes, Buffer.byteLength(svg));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exports a closed native Ellipse as an exact SVG ellipse instead of a polyline", async () => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-svg-ellipse-export-test-"));
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1,
    undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [],
    bodies: [{ id: 7, versionId: 17, type: "Wire", name: "Ellipse", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [] }],
  };
  const radians = 35 * Math.PI / 180;
  const sample = (angleDegrees: number): [number, number, number] => {
    const angle = angleDegrees * Math.PI / 180;
    return [
      100 + 12 * Math.cos(angle) * Math.cos(radians) - 5 * Math.sin(angle) * Math.sin(radians),
      100 + 12 * Math.cos(angle) * Math.sin(radians) + 5 * Math.sin(angle) * Math.cos(radians),
      0,
    ];
  };
  const samplesMm = [0, 90, 180, 270, 360].map(sample);
  const runtime = {
    async getState() { return state; },
    async readNative() { return [{
      id: 7,
      closed: true,
      plane: { originMm: [0, 0, 0], normal: [0, 0, 1] },
      segments: [{
        curveType: "Ellipse", startMm: samplesMm[0], endMm: samplesMm[4], lengthMm: 55.69594968881921,
        ellipse: { carrierSamplesMm: samplesMm, parameterStart: 0, parameterEnd: 2 * Math.PI, parameterPeriod: 2 * Math.PI, startTangent: [0, 0, 0] },
      }],
    }]; },
  } as unknown as PlasticityRuntime;
  try {
    const output = join(root, "ellipse.svg");
    const result = await new PlasticityOperations(runtime).exportSvg([7], output, state.revision);
    const svg = await readFile(output, "utf8");

    assert.equal(result.approximatedSegments, 0);
    assert.equal(result.maxChordDeviationMm, 0);
    assert.match(svg, /<ellipse cx="100" cy="-100" rx="12" ry="5" transform="rotate\(-35 100 -100\)"\/>/u);
    assert.doesNotMatch(svg, /data-approximation="adaptive-chord"/u);
    assert.ok(Math.abs(result.boundsMm.min[0] - 89.76) < 0.002);
    assert.ok(Math.abs(result.boundsMm.max[0] - 110.24) < 0.002);
    assert.ok(Math.abs(result.boundsMm.min[1] + 108.009) < 0.002);
    assert.ok(Math.abs(result.boundsMm.max[1] + 91.991) < 0.002);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exports a trimmed native Ellipse as an exact SVG elliptical arc instead of a polyline", async () => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-svg-ellipse-arc-test-"));
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1,
    undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [],
    bodies: [{ id: 7, versionId: 17, type: "Wire", name: "Ellipse arc", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [] }],
  };
  const phi = 35 * Math.PI / 180;
  const pointAt = (angleDegrees: number): [number, number, number] => {
    const angle = angleDegrees * Math.PI / 180;
    return [
      12 * Math.cos(angle) * Math.cos(phi) - 5 * Math.sin(angle) * Math.sin(phi),
      12 * Math.cos(angle) * Math.sin(phi) + 5 * Math.sin(angle) * Math.cos(phi),
      0,
    ];
  };
  const start = pointAt(30);
  const end = pointAt(250);
  const tangent = [
    -12 * Math.sin(30 * Math.PI / 180) * Math.cos(phi) - 5 * Math.cos(30 * Math.PI / 180) * Math.sin(phi),
    -12 * Math.sin(30 * Math.PI / 180) * Math.sin(phi) + 5 * Math.cos(30 * Math.PI / 180) * Math.cos(phi),
    0,
  ] as [number, number, number];
  const runtime = {
    async getState() { return state; },
    async readNative() { return [{
      id: 7,
      closed: false,
      plane: { originMm: [0, 0, 0], normal: [0, 0, 1] },
      segments: [{
        curveType: "Ellipse", startMm: start, endMm: end, lengthMm: 40,
        ellipse: {
          carrierSamplesMm: [0, 90, 180, 270, 360].map(pointAt),
          parameterStart: 30 * Math.PI / 180,
          parameterEnd: 250 * Math.PI / 180,
          parameterPeriod: 2 * Math.PI,
          startTangent: tangent,
        },
      }],
    }]; },
  } as unknown as PlasticityRuntime;
  try {
    const output = join(root, "ellipse-arc.svg");
    const result = await new PlasticityOperations(runtime).exportSvg([7], output, state.revision);
    const svg = await readFile(output, "utf8");
    const path = svg.match(/<path d="([^"]+)" data-curve-type="Ellipse"\/>/u)?.[1];

    assert.equal(result.approximatedSegments, 0);
    assert.equal(result.ellipticalArcs, 1);
    assert.ok(path);
    assert.match(path, / A 12 5 -35 1 0 /u);
    assert.match(svg, /M 7\.078936668117 -8\.008661289428/u);
    assert.match(svg, /-0\.66707027164 6\.202851996228"/u);
    assert.ok(Math.abs(result.boundsMm.min[0] + 10.239638593616) < 1e-9);
    assert.ok(Math.abs(result.boundsMm.max[0] - 7.078936668117) < 1e-9);
    assert.ok(Math.abs(result.boundsMm.min[1] + 8.009357119777) < 1e-9);
    assert.ok(Math.abs(result.boundsMm.max[1] - 8.009357119777) < 1e-9);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exports a validated rational conic BCurve as an exact SVG elliptical arc", async () => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-svg-rational-conic-test-"));
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1,
    undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [],
    bodies: [{ id: 7, versionId: 17, type: "Wire", name: "Rational conic", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [] }],
  };
  const pointAt = (parameter: number): [number, number, number] => {
    const angle = parameter * 220 * Math.PI / 180;
    return [30 + 12 * Math.cos(angle), 15 + 5 * Math.sin(angle), 0];
  };
  const tangent: [number, number, number] = [0, 5, 0];
  const runtime = {
    async getState() { return state; },
    async readNative() { return [{
      id: 7,
      closed: false,
      plane: { originMm: [0, 0, 0], normal: [0, 0, 1] },
      segments: [{
        curveType: "BCurve",
        startMm: pointAt(0),
        endMm: pointAt(1),
        lengthMm: 30,
        rationalConic: {
          fitSamplesMm: [0.1, 0.3, 0.5, 0.7, 0.9].map(pointAt),
          validationSamplesMm: Array.from({ length: 65 }, (_, index) => pointAt(index / 64)),
          startTangent: tangent,
        },
        approximation: { pointsMm: Array.from({ length: 65 }, (_, index) => pointAt(index / 64)), maxChordDeviationMm: 0.01 },
      }],
    }]; },
  } as unknown as PlasticityRuntime;
  try {
    const output = join(root, "rational-conic.svg");
    const result = await new PlasticityOperations(runtime).exportSvg([7], output, state.revision);
    const svg = await readFile(output, "utf8");
    assert.equal(result.ellipticalArcs, 1);
    assert.equal(result.approximatedSegments, 0);
    assert.match(svg, /data-representation="ellipse-fit" data-validation="65-native-brep-samples"/u);
    assert.match(svg, / A 12 5 0 1 0 /u);
    assert.doesNotMatch(svg, /data-approximation="adaptive-chord"/u);

    const invalidRuntime = {
      async getState() { return state; },
      async readNative() { return [{
        id: 7,
        closed: false,
        plane: { originMm: [0, 0, 0], normal: [0, 0, 1] },
        segments: [{
          curveType: "BCurve",
          startMm: pointAt(0),
          endMm: pointAt(1),
          lengthMm: 30,
          rationalConic: {
            fitSamplesMm: [0.1, 0.3, 0.5, 0.7, 0.9].map(pointAt),
            validationSamplesMm: Array.from({ length: 65 }, (_, index) => pointAt(index / 64)).map((point, index) => index === 31 ? [point[0], point[1] + 0.1, point[2]] as [number, number, number] : point),
            startTangent: tangent,
          },
          approximation: { pointsMm: Array.from({ length: 65 }, (_, index) => pointAt(index / 64)), maxChordDeviationMm: 0.01 },
        }],
      }]; },
    } as unknown as PlasticityRuntime;
    const fallback = await new PlasticityOperations(invalidRuntime).exportSvg([7], join(root, "rational-fallback.svg"), state.revision);
    const fallbackSvg = await readFile(join(root, "rational-fallback.svg"), "utf8");
    assert.equal(fallback.approximatedSegments, 1);
    assert.match(fallbackSvg, /data-approximation="adaptive-chord"/u);
    assert.doesNotMatch(fallbackSvg, /data-representation="ellipse-fit"/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects stale, unsupported, nonplanar, and non-line SVG Wire exports before writing", async () => {
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1,
    undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [],
    bodies: [
      { id: 7, versionId: 17, type: "Wire", name: "Path", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [] },
      { id: 8, versionId: 18, type: "Solid", name: "Box", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [] },
    ],
  };
  let readCount = 0;
  const runtime = {
    async getState() { return state; },
    async readNative() { readCount += 1; return []; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  await assert.rejects(operations.exportSvg([7], "/tmp/stale.svg", "old"), /stale reference/iu);
  await assert.rejects(operations.exportSvg([7], "/tmp/bad-tolerance.svg", state.revision, 0, 5), /chord tolerance/u);
  await assert.rejects(operations.exportSvg([7], "/tmp/bad-angle.svg", state.revision, 0.05, 31), /angle tolerance/u);
  await assert.rejects(operations.exportSvg([], "/tmp/empty.svg", state.revision), /nonempty unique/u);
  await assert.rejects(operations.exportSvg([7, 7], "/tmp/duplicate.svg", state.revision), /nonempty unique/u);
  await assert.rejects(operations.exportSvg([99], "/tmp/missing.svg", state.revision), /unknown current Wire ID/iu);
  await assert.rejects(operations.exportSvg([8], "/tmp/solid.svg", state.revision), /Wire/u);
  await assert.rejects(operations.exportSvg([7], "/tmp/wrong.step", state.revision), /end in \.svg/u);
  assert.equal(readCount, 0);
});

test("exports other planar native B-Rep curves as explicitly tolerance-bounded SVG polylines", async () => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-svg-reject-test-"));
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1,
    undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [],
    bodies: [7, 8].map((id) => ({ id, versionId: id + 10, type: "Wire", name: "Path", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [] })),
  };
  const first = { id: 7, plane: { originMm: [0, 0, 0], normal: [0, 0, 1] }, segments: [{ curveType: "Line", startMm: [0, 0, 0], endMm: [10, 0, 0] }] };
  let capturedSvgReadSource = "";
  const curvedRuntime = {
    async getState() { return state; },
    async readNative(source: string) { capturedSvgReadSource = source; return [{
      ...first,
      closed: false,
      segments: [{ ...first.segments[0], curveType: "NurbsCurve", lengthMm: 10.4, approximation: {
        pointsMm: [[0, 0, 0], [5, 1, 0], [10, 0, 0]], maxChordDeviationMm: 0.04,
      } }],
    }]; },
  } as unknown as PlasticityRuntime;
  const noncoplanarRuntime = {
    async getState() { return state; },
    async readNative() { return [first, { id: 8, plane: { originMm: [0, 0, 1], normal: [0, 0, 1] }, segments: [{ curveType: "Line", startMm: [0, 0, 1], endMm: [0, 10, 1] }] }]; },
  } as unknown as PlasticityRuntime;
  const curvedOutput = join(root, "curved.svg");
  const noncoplanarOutput = join(root, "noncoplanar.svg");
  try {
    const approximation = await new PlasticityOperations(curvedRuntime).exportSvg([7], curvedOutput, state.revision);
    const svg = await readFile(curvedOutput, "utf8");
    assert.equal(approximation.approximatedSegments, 1);
    assert.equal(approximation.maxChordDeviationMm, 0.04);
    assert.match(capturedSvgReadSource, /let totalApproximationPoints = 0/u);
    assert.match(svg, /data-curve-type="NurbsCurve" data-approximation="adaptive-chord"/u);
    assert.match(svg, /M 0 0 L 5 -1 L 10 0/u);
    assert.equal(approximation.curveChordToleranceMm, 0.05);
    const unsupportedRuntime = {
      async getState() { return state; },
      async readNative() { return [{ ...first, closed: false, segments: [{ ...first.segments[0], curveType: "NurbsCurve" }] }]; },
    } as unknown as PlasticityRuntime;
    await assert.rejects(new PlasticityOperations(unsupportedRuntime).exportSvg([7], join(root, "unsupported.svg"), state.revision), /unsupported native curve/u);
    await assert.rejects(new PlasticityOperations(noncoplanarRuntime).exportSvg([7, 8], noncoplanarOutput, state.revision), /coplanar/u);
    await assert.rejects(readFile(noncoplanarOutput), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects invalid OBJ export selections and tessellation settings before mutation", async () => {
  let mutations = 0;
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1,
    undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [],
    bodies: [
      { id: 7, versionId: 17, type: "Solid", name: "Box", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [] },
      { id: 8, versionId: 18, type: "Wire", name: "Path", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [] },
    ],
  };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; }, isUncertain() { return false; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.exportObj([7], "/tmp/stale.obj", "old", 0.05, 15), /stale reference/iu);
  await assert.rejects(operations.exportObj([], "/tmp/empty.obj", state.revision, 0.05, 15), /nonempty unique/u);
  await assert.rejects(operations.exportObj([7, 7], "/tmp/duplicate.obj", state.revision, 0.05, 15), /nonempty unique/u);
  await assert.rejects(operations.exportObj([99], "/tmp/missing.obj", state.revision, 0.05, 15), /unknown current body/iu);
  await assert.rejects(operations.exportObj([8], "/tmp/wire.obj", state.revision, 0.05, 15), /Solid or Sheet/u);
  await assert.rejects(operations.exportObj([7], "/tmp/bad.stl", state.revision, 0.05, 15), /end in \.obj/u);
  await assert.rejects(operations.exportObj([7], "/tmp/bad-chord.obj", state.revision, 0, 15), /chord tolerance/u);
  await assert.rejects(operations.exportObj([7], "/tmp/bad-angle.obj", state.revision, 0.05, 91), /angle tolerance/u);
  assert.equal(mutations, 0);
});

test("exports selected native bodies as a validated Parasolid file without overwriting", async () => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-parasolid-export-test-"));
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const body = { id: 7, versionId: 17, type: "Solid", name: "Box", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body] };
  const payload = Buffer.from("**ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz**************************\n**PARASOLID test fixture\n");
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) {
      call = { source, bindings, values };
      const args = values[0] as { path: string };
      await writeFile(args.path, payload);
      return {};
    },
    isUncertain() { return false; },
  } as unknown as PlasticityRuntime;
  try {
    const output = join(root, "box.x_t");
    const operations = new PlasticityOperations(runtime);

    const result = await operations.exportParasolid([7], output, state.revision);

    assert.deepEqual(call?.bindings, ["ExportCadFactory"]);
    assert.match(call?.source ?? "", /factory\.items = args\.ids\.map\(find\)/u);
    assert.match((call?.values[0] as { path: string }).path, /\.plasticity-parasolid-[^/]+\/geometry\.x_t$/u);
    assert.deepEqual(result, { path: output, bytes: payload.length, format: "parasolid-text" });
    assert.deepEqual(await readFile(output), payload);
    await assert.rejects(operations.exportParasolid([7], output, state.revision), /overwrite/u);
    await assert.rejects(operations.exportParasolid([7], join(root, "box.step"), state.revision), /\.x_t or \.x_b/u);
    await assert.rejects(operations.exportParasolid([], join(root, "empty.x_t"), state.revision), /nonempty unique/u);
    await assert.rejects(operations.exportParasolid([7, 7], join(root, "duplicate.x_t"), state.revision), /nonempty unique/u);
    await assert.rejects(operations.exportParasolid([99], join(root, "missing.x_t"), state.revision), /unknown current body/iu);
    await assert.rejects(operations.exportParasolid([7], join(root, "stale.x_t"), "stale-revision"), /stale reference/iu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("imports a validated Parasolid file through the native Parasolid importer", async () => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-parasolid-import-test-"));
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [] };
  const input = join(root, "box.x_b");
  await writeFile(input, Buffer.from("**ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz**************************\n**PARASOLID test fixture\n"));
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) {
      call = { source, bindings, values };
      return {};
    },
    isUncertain() { return false; },
  } as unknown as PlasticityRuntime;
  try {
    const operations = new PlasticityOperations(runtime);

    assert.equal(await operations.importParasolid(input, state.revision), state);

    assert.deepEqual(call?.bindings, ["ParasolidImportFactory", "ImportCommand"]);
    assert.match(call?.source ?? "", /new Factory\(editor\)\.resource\(this\)/u);
    assert.deepEqual(call?.values, [{ path: await realpath(input) }]);
    await assert.rejects(operations.importParasolid(join(root, "missing.x_t"), state.revision), /ENOENT/u);
    const invalid = join(root, "invalid.x_t");
    await writeFile(invalid, "not Parasolid");
    await assert.rejects(operations.importParasolid(invalid, state.revision), /invalid Parasolid/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("imports a local STL or OBJ as an explicitly scaled approximate reference mesh", async () => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-reference-mesh-import-test-"));
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1,
    undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [], referenceMeshes: [],
  };
  const input = join(root, "phone-reference.stl");
  await writeFile(input, "solid reference\nendsolid reference\n");
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; },
  } as unknown as PlasticityRuntime;
  try {
    const operations = new PlasticityOperations(runtime);

    assert.equal(await operations.importReferenceMesh(input, "millimeter", state.revision), state);

    assert.deepEqual(call?.bindings, ["MeshImportFactory", "ImportCommand"]);
    assert.match(call?.source ?? "", /factory\.unit = args\.sourceUnit/u);
    assert.match(call?.source ?? "", /Empties_ObjectEmpty/u);
    assert.deepEqual(call?.values, [{ path: await realpath(input), sourceUnit: "millimeter" }]);
    const invalid = join(root, "phone-reference.step");
    await writeFile(invalid, "not a mesh");
    await assert.rejects(operations.importReferenceMesh(invalid, "millimeter", state.revision), /\.stl or \.obj/u);
    const empty = join(root, "empty.obj");
    await writeFile(empty, "");
    await assert.rejects(operations.importReferenceMesh(empty, "millimeter", state.revision), /must not be empty/u);
    await assert.rejects(operations.importReferenceMesh(input, "millimeter", "stale"), /stale reference/iu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("imports a validated unit-aware 3MF as a native approximate reference mesh", async () => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-reference-3mf-import-test-"));
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1,
    undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [], referenceMeshes: [],
  };
  const input = join(root, "reference.3mf");
  await writeFile(input, testThreeMfArchive());
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; },
  } as unknown as PlasticityRuntime;
  try {
    const operations = new PlasticityOperations(runtime);

    assert.equal(await operations.importReference3mf(input, state.revision), state);
    assert.deepEqual(call?.bindings, ["ImporterExporter", "ImportCommand"]);
    assert.match(call?.source ?? "", /\.import3mf\(args\.path\)/u);
    assert.deepEqual(call?.values, [{ path: await realpath(input) }]);

    const wrongExtension = join(root, "reference.step");
    await writeFile(wrongExtension, await readFile(input));
    await assert.rejects(operations.importReference3mf(wrongExtension, state.revision), /\.3mf/u);
    const oversized = join(root, "oversized.3mf");
    await writeFile(oversized, Buffer.from([0]));
    await truncate(oversized, 64 * 1024 * 1024 + 1);
    await assert.rejects(operations.importReference3mf(oversized, state.revision), /exceeds 67108864 bytes/u);
    await assert.rejects(operations.importReference3mf(input, "stale"), /stale reference/iu);
    const corrupt = Buffer.from(await readFile(input));
    const firstPayloadOffset = 30 + Buffer.byteLength("[Content_Types].xml");
    corrupt[firstPayloadOffset] = (corrupt[firstPayloadOffset]! + 1) % 256;
    await writeFile(input, corrupt);
    const previousCall = call;
    await assert.rejects(operations.importReference3mf(input, state.revision), /CRC-32/u);
    assert.equal(call, previousCall, "invalid package must be rejected before native mutation");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("imports a local SVG as explicitly scaled editable native Wires", async () => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-svg-import-test-"));
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1,
    undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [],
  };
  const input = join(root, "bracket-profile.svg");
  await writeFile(input, '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0H20V10H0Z"/></svg>');
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; },
  } as unknown as PlasticityRuntime;
  try {
    const operations = new PlasticityOperations(runtime);

    assert.equal(await operations.importSvg(input, "inch", state.revision), state);

    assert.deepEqual(call?.bindings, ["VectorImportFactory", "ImportCommand"]);
    assert.match(call?.source ?? "", /factory\.unit = args\.sourceUnit/u);
    assert.match(call?.source ?? "", /constructor\?\.name === 'Wire'/u);
    assert.deepEqual(call?.values, [{ path: await realpath(input), sourceUnit: "inch" }]);
    const wrongExtension = join(root, "profile.txt");
    await writeFile(wrongExtension, "<svg/>");
    await assert.rejects(operations.importSvg(wrongExtension, "millimeter", state.revision), /end in \.svg/u);
    const empty = join(root, "empty.svg");
    await writeFile(empty, "");
    await assert.rejects(operations.importSvg(empty, "millimeter", state.revision), /must not be empty/u);
    await assert.rejects(operations.importSvg(input, "millimeter", "stale"), /stale reference/iu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("creates native constant-width slot profiles around current Wire spines", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1,
    undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [],
    bodies: [
      { id: 7, versionId: 17, type: "Wire", name: "Spine A", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [] },
      { id: 8, versionId: 18, type: "Wire", name: "Spine B", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [] },
    ],
  };
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  assert.equal(await operations.createSlotProfiles([7, 8], 6, state.revision), state);

  assert.deepEqual(call?.bindings, ["SlotFactory", "SlotCommand"]);
  assert.deepEqual(call?.values, [{ ids: [7, 8], width: 0.006 }]);
  assert.match(call?.source ?? "", /factory\.curves = wires/u);
  assert.match(call?.source ?? "", /factory\.width = args\.width/u);
  assert.match(call?.source ?? "", /new Command\(this\)/u);
});

test("rejects invalid slot-profile sources before native mutation", async () => {
  let mutations = 0;
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1,
    undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [],
    bodies: [
      { id: 7, versionId: 17, type: "Wire", name: "Spine", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [] },
      { id: 8, versionId: 18, type: "Solid", name: "Block", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [] },
    ],
  };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.createSlotProfiles([], 6, state.revision), /at least one Wire/i);
  await assert.rejects(operations.createSlotProfiles([7, 7], 6, state.revision), /unique/i);
  await assert.rejects(operations.createSlotProfiles([8], 6, state.revision), /current Wire/i);
  await assert.rejects(operations.createSlotProfiles([99], 6, state.revision), /current Wire/i);
  await assert.rejects(operations.createSlotProfiles([7], 0, state.revision), /width must be positive/i);
  await assert.rejects(operations.createSlotProfiles([7], 6, "stale"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("lists, renames, transforms, and deletes revision-bound reference meshes through native empty commands", async () => {
  const mesh = {
    id: 0, type: "ReferenceMesh" as const, name: "phone.stl", sourcePath: "/tmp/phone.stl", sourceFormat: "stl" as const,
    measurementSource: "reference-mesh" as const,
    boundsMm: { min: [0, 0, 0] as [number, number, number], max: [72, 9, 158] as [number, number, number] },
    translationMm: [0, 0, 0] as [number, number, number], rotationQuaternion: [0, 0, 0, 1] as [number, number, number, number],
    sceneScaleToMeters: [0.001, 0.001, 0.001] as [number, number, number], vertexEntries: 36, triangles: 12,
    visible: true, hidden: false, locked: false,
  };
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1,
    undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [], referenceMeshes: [mesh],
  };
  const calls: Array<{ source: string; bindings: string[]; values: unknown[] }> = [];
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) { calls.push({ source, bindings, values }); return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  assert.deepEqual(await operations.listReferenceMeshes(), {
    documentToken: state.documentToken,
    revision: state.revision,
    referenceMeshes: [mesh],
  });
  await operations.moveReferenceMeshes([0], [10, 20, 30], state.revision);
  await operations.rotateReferenceMeshes([0], [10, 20, 30], [0, 0, 2], 90, state.revision);
  await operations.scaleReferenceMeshes([0], [10, 20, 30], [2, 0.5, 1], state.revision);
  await operations.renameReferenceMesh(0, "Phone envelope", state.revision);
  await operations.deleteReferenceMeshes([0], state.revision);

  assert.deepEqual(calls[0]?.bindings, ["MoveItemAndEmptyFactory"]);
  assert.deepEqual(calls[0]?.values, [{ ids: [0], delta: [0.01, 0.02, 0.03] }]);
  assert.match(calls[0]?.source ?? "", /Empties_ObjectEmpty/u);
  assert.deepEqual(calls[1]?.bindings, ["RotateItemAndEmptyFactory", "Vector3", "Quaternion"]);
  assert.deepEqual(calls[1]?.values, [{ ids: [0], pivot: [0.01, 0.02, 0.03], axis: [0, 0, 1], radians: Math.PI / 2 }]);
  assert.deepEqual(calls[2]?.bindings, ["ProjectingScaleItemAndEmptyFactory"]);
  assert.deepEqual(calls[2]?.values, [{ ids: [0], pivot: [0.01, 0.02, 0.03], factors: [2, 0.5, 1] }]);
  assert.deepEqual(calls[3]?.bindings, []);
  assert.deepEqual(calls[3]?.values, [{ id: 0, name: "Phone envelope" }]);
  assert.match(calls[3]?.source ?? "", /db\.nodes\.setName/u);
  assert.deepEqual(calls[4]?.bindings, []);
  assert.match(calls[4]?.source ?? "", /addEmpty/u);

  const beforeInvalid = calls.length;
  await assert.rejects(operations.moveReferenceMeshes([], [1, 0, 0], state.revision), /nonempty unique/u);
  await assert.rejects(operations.moveReferenceMeshes([1], [1, 0, 0], state.revision), /unknown current reference mesh/iu);
  await assert.rejects(operations.rotateReferenceMeshes([0], [0, 0, 0], [0, 0, 0], 90, state.revision), /axis.*zero|zero.*axis/iu);
  await assert.rejects(operations.scaleReferenceMeshes([0], [0, 0, 0], [1, 0, 1], state.revision), /positive finite/u);
  await assert.rejects(operations.deleteReferenceMeshes([0], "stale"), /stale reference/iu);
  assert.equal(calls.length, beforeInvalid);
});

function testThreeMfArchive(): Buffer {
  const model = '<model unit="meter"><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="0.02" y="0" z="0"/><vertex x="0" y="0.01" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>';
  return storedTestZip([
    ["[Content_Types].xml", Buffer.from('<Types><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>')],
    ["_rels/.rels", Buffer.from('<Relationships><Relationship Target="/3D/3dmodel.model"/></Relationships>')],
    ["3D/3dmodel.model", Buffer.from(model)],
  ]);
}

function storedTestZip(entries: Array<readonly [string, Buffer]>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const [name, data] of entries) {
    const filename = Buffer.from(name);
    const crc = testCrc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    localParts.push(local, filename, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, filename);
    localOffset += local.length + filename.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(centralDirectory.length, 12); eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

function testCrc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

test("rejects stale body references before a mutation", async () => {
  let mutated = false;
  const state: RuntimeState = {
    targetId: "window-1",
    title: "Untitled - Plasticity",
    documentToken: "document-1",
    revision: "current-revision",
    dbVersion: 1,
    undoDepth: 0,
    redoDepth: 0,
    regions: [],
    construction: emptyConstruction,
    bodies: [],
  };
  const runtime = {
    async getState() { return state; },
    async mutate() { mutated = true; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(
    operations.move([1], [1, 0, 0], "old-revision"),
    /stale reference/i,
  );
  assert.equal(mutated, false);
});

test("creates and removes a native viewport section through Plasticity shading state", async () => {
  const calls: Array<{ source: string; bindings: string[]; values: unknown[] }> = [];
  const initial = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [], sectionAnalyses: [] } as unknown as RuntimeState;
  const created = { ...initial, sectionAnalyses: [{ id: 3, name: "Mid section", originMm: [0, 0, 5], normal: [0, 0, 1], visible: true, registeredViewportCount: 1 }] } as unknown as RuntimeState;
  let state = initial;
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) { calls.push({ source, bindings, values }); state = calls.length === 1 ? created : initial; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  const afterCreate = await operations.createSectionAnalysis([0, 0, 5], [0, 0, 2], undefined, "Mid section", initial.revision);
  const afterDelete = await operations.deleteSectionAnalysis(3, created.revision);

  assert.deepEqual(afterCreate.sectionAnalyses, created.sectionAnalyses);
  assert.deepEqual(afterDelete.sectionAnalyses, []);
  assert.deepEqual(calls[0]?.bindings, ["SectionAnalysisFactory", "Vector3", "Matrix4"]);
  assert.deepEqual(calls[0]?.values, [{ point: [0, 0, 0.005], normal: [0, 0, 1], xDirection: [1, 0, 0], name: "Mid section" }]);
  assert.match(calls[0]?.source ?? "", /section\.plane\.setFromNormalAndCoplanarPoint\(normal, point\)/);
  assert.match(calls[0]?.source ?? "", /this\.shading\.section = section/);
  assert.doesNotMatch(calls[0]?.source ?? "", /clippingPass|SectionDatabase/);
  assert.match(calls[0]?.source ?? "", /viewport\.setNeedsRender/);
  assert.deepEqual(calls[1]?.bindings, []);
  assert.deepEqual(calls[1]?.values, [{ id: 3 }]);
  assert.match(calls[1]?.source ?? "", /this\.shading\.section = null/);
  assert.doesNotMatch(calls[1]?.source ?? "", /clippingPass|SectionDatabase/);
});

test("rejects creating a second active section analysis", async () => {
  let mutations = 0;
  const state = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [], sectionAnalyses: [{ id: 3, name: null, originMm: [0, 0, 5], normal: [0, 0, 1], visible: true, registeredViewportCount: 1 }] } as unknown as RuntimeState;
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.createSectionAnalysis([0, 0, 0], [0, 0, 1], undefined, undefined, state.revision), /already has an active section/i);
  assert.equal(mutations, 0);
});

test("rejects stale, degenerate, and unknown section analysis operations before mutation", async () => {
  let mutations = 0;
  const state = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [], sectionAnalyses: [{ id: 3, name: null, originMm: [0, 0, 5], normal: [0, 0, 1], visible: true, registeredViewportCount: 1 }] } as unknown as RuntimeState;
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.createSectionAnalysis([0, 0, 0], [0, 0, 1], undefined, undefined, "old"), /stale reference/i);
  await assert.rejects(operations.createSectionAnalysis([0, 0, 0], [0, 0, 0], undefined, undefined, state.revision), /normal/i);
  await assert.rejects(operations.createSectionAnalysis([0, 0, 0], [0, 0, 1], [0, 0, 2], undefined, state.revision), /x direction/i);
  await assert.rejects(operations.deleteSectionAnalysis(99, state.revision), /unknown current section analysis/i);
  assert.equal(mutations, 0);
});

test("creates a native persistent distance measurement between exact vertices", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const body = {
    id: 7, versionId: 17, type: "Solid", name: "Measured", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [],
    vertices: [
      { id: 101, positionMm: [0, 0, 0] as [number, number, number], edgeIds: [], faceIds: [] },
      { id: 102, positionMm: [20, 0, 0] as [number, number, number], edgeIds: [], faceIds: [] },
    ],
  };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body], measurements: [] };
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.createVertexDistanceMeasurement(
    { bodyId: 7, vertexId: 101 },
    { bodyId: 7, vertexId: 102 },
    "Overall width",
    state.revision,
  );

  assert.deepEqual(call?.bindings, ["PointToPointMeasurementFactory"]);
  assert.deepEqual(call?.values, [{ vertices: [{ bodyId: 7, vertexId: 101 }, { bodyId: 7, vertexId: 102 }], name: "Overall width" }]);
  assert.match(call?.source ?? "", /Snaps_ShellVertexSnap/);
  assert.match(call?.source ?? "", /new this\.commands\.MeasureDistanceCommand\(this\)/);
  assert.match(call?.source ?? "", /measurements\.update\(\[measurement\], \[\], \[\]\)/);
  assert.match(call?.source ?? "", /viewport\.setNeedsRender\(\)/);
});

test("synchronizes visible native distance-measurement overlays with exact B-Rep state", async () => {
  const measurement = {
    id: 3, versionId: 13, type: "DistanceMeasurement", name: "Width", measurementSource: "native-brep" as const,
    first: { bodyId: 7, topologyId: 101, landmark: 0, positionMm: [0, 0, 0] as [number, number, number] },
    second: { bodyId: 7, topologyId: 102, landmark: 0, positionMm: [20, 0, 0] as [number, number, number] },
    distanceMm: 20, direction: [1, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number], offsetMm: [0, 0],
  };
  let state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [], measurements: [measurement] };
  const calls: Array<{ source: string; bindings: string[]; values: unknown[] }> = [];
  let uncertain = false;
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) { calls.push({ source, bindings, values }); return {}; },
    isUncertain() { return uncertain; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.state();

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.bindings, ["LineSegmentHelper", "Vector3", "Vector2", "makeAxisAlignedMeasurementPath"]);
  assert.deepEqual(calls[0]?.values, [{
    documentToken: "document-1",
    measurements: [{
      versionId: 13,
      firstMm: [0, 0, 0],
      secondMm: [20, 0, 0],
      firstBodyId: 7,
      secondBodyId: 7,
      direction: [1, 0, 0],
      normal: [0, 0, 1],
      offsetMm: [0, 0],
      distanceMm: 20,
    }],
    bodyBoundsMm: [],
  }]);
  assert.match(calls[0]?.source ?? "", /this\.helpers\.add\(lineHelper\)/);
  assert.match(calls[0]?.source ?? "", /Math\.max\(measurement\.distanceMm \* 0\.08, 2\)/);
  assert.match(calls[0]?.source ?? "", /const outsideDistance = point => bounds/);
  assert.match(calls[0]?.source ?? "", /clearance > 0\.01/);
  assert.match(calls[0]?.source ?? "", /new Vector2\(0, step \/ 1000\)/);
  assert.match(calls[0]?.source ?? "", /const linePairs = \[\[path\[0\], path\[1\]\], \[path\[1\], path\[3\]\], \[path\[3\], path\[4\]\]\]/);
  assert.match(calls[0]?.source ?? "", /lineHelper\.line\.material\.color\.setHex\(0xb7f397\)/);
  assert.match(calls[0]?.source ?? "", /lineHelper\.line\.material\.depthTest = false/);
  assert.match(calls[0]?.source ?? "", /lineHelper\.line\.material\.linewidth = 2/);
  assert.match(calls[0]?.source ?? "", /for \(const helper of tag\.helpers/);
  assert.match(calls[0]?.source ?? "", /nativeLabels\.group\.remove\(label\)/);
  assert.match(calls[0]?.source ?? "", /nativeLabels\.segments\.clear\(\)/);
  assert.match(calls[0]?.source ?? "", /this\.measurements\.distanceSegments\.clear\(\)/);
  assert.match(calls[0]?.source ?? "", /document\.querySelectorAll\('\[data-plasticity-mcp-distance\]'\)/);
  assert.match(calls[0]?.source ?? "", /document\.createElement\('div'\)/);
  assert.match(calls[0]?.source ?? "", /measurement\.distanceMm\.toFixed\(2\) \+ ' mm'/);
  assert.match(calls[0]?.source ?? "", /labelPoint\.clone\(\)\.project\(camera\)/);
  assert.match(calls[0]?.source ?? "", /requestAnimationFrame\(updateLabels\)/);
  assert.match(calls[0]?.source ?? "", /cancelAnimationFrame\(tag\.frameId\)/);
  assert.match(calls[0]?.source ?? "", /label\.remove\(\)/);
  assert.match(calls[0]?.source ?? "", /manager\.set\(key, tag\)/);
  assert.match(calls[0]?.source ?? "", /manager\.get\(key\) !== tag/);

  await operations.state();
  assert.equal(calls.length, 1, "an unchanged measurement revision should not rebuild its overlay");

  state = { ...state, revision: "while-uncertain", documentToken: "document-2" };
  uncertain = true;
  await operations.state();
  assert.equal(calls.length, 1, "an uncertain CDP session must not attempt an overlay mutation");
  uncertain = false;
  await operations.state();
  assert.equal(calls.length, 2, "the changed document overlay should sync after uncertainty is resolved");

  state = { ...state, revision: "after-delete", measurements: [] };
  await operations.state();
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2]?.values, [{ documentToken: "document-2", measurements: [], bodyBoundsMm: [] }]);
});

test("creates a native persistent distance measurement between topology points", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const body = {
    id: 7, versionId: 17, type: "Solid", name: "Measured", boundsMm: null,
    faceIds: ["17f1"], edgeIds: ["17e1"],
    faces: [{ id: "17f1", centerMm: [10, 5, 5], normal: [0, 0, 1], planar: true }],
    edges: [{ id: "17e1", centerMm: [10, 0, 5], tangent: [1, 0, 0], line: true }],
    vertices: [],
  };
  const state = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body], measurements: [] } as unknown as RuntimeState;
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; },
  } as unknown as PlasticityRuntime;

  await new PlasticityOperations(runtime).createTopologyDistanceMeasurement(
    { type: "face-center", bodyId: 7, faceId: "17f1" },
    { type: "edge-midpoint", bodyId: 7, edgeId: "17e1" },
    "Face to edge",
    state.revision,
  );

  assert.deepEqual(call?.bindings, ["PointToPointMeasurementFactory"]);
  assert.deepEqual(call?.values, [{
    points: [
      { type: "face-center", bodyId: 7, faceId: "17f1" },
      { type: "edge-midpoint", bodyId: 7, edgeId: "17e1" },
    ],
    name: "Face to edge",
  }]);
  assert.match(call?.source ?? "", /Snaps_FaceCenterPointSnap/);
  assert.match(call?.source ?? "", /candidate\.faceSnap\?\.model\?\.Id/);
  assert.match(call?.source ?? "", /EdgePointSnap/);
  assert.match(call?.source ?? "", /factory\.p1\(snaps\[0\]\.position, snaps\[0\]\)/);
  assert.match(call?.source ?? "", /factory\.p2\(snaps\[1\]\.position, snaps\[1\]\)/);
  assert.match(call?.source ?? "", /viewport\.setNeedsRender\(\)/);
});

test("rejects stale and missing persistent topology-distance references before mutation", async () => {
  let mutations = 0;
  const body = {
    id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null,
    faceIds: ["17f1"], edgeIds: ["17e1"],
    faces: [{ id: "17f1", centerMm: [0, 0, 0], normal: [0, 0, 1], planar: true }],
    edges: [{ id: "17e1", centerMm: [1, 0, 0], tangent: [1, 0, 0], line: true }],
    vertices: [{ id: 101, positionMm: [0, 1, 0], edgeIds: [], faceIds: [] }],
  };
  const wire = {
    id: 8, versionId: 18, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [],
    vertices: [{ id: 201, positionMm: [0, 0, 0], edgeIds: [], faceIds: [] }],
  };
  const state = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body, wire], measurements: [] } as unknown as RuntimeState;
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.createTopologyDistanceMeasurement(
    { type: "face-center", bodyId: 7, faceId: "17f1" },
    { type: "edge-midpoint", bodyId: 7, edgeId: "17e1" },
    undefined,
    "old-revision",
  ), /stale reference/i);
  await assert.rejects(operations.createTopologyDistanceMeasurement(
    { type: "face-center", bodyId: 7, faceId: "missing" },
    { type: "vertex", bodyId: 7, vertexId: 101 },
    undefined,
    state.revision,
  ), /unknown current face/i);
  await assert.rejects(operations.createTopologyDistanceMeasurement(
    { type: "edge-midpoint", bodyId: 7, edgeId: "missing" },
    { type: "vertex", bodyId: 7, vertexId: 101 },
    undefined,
    state.revision,
  ), /unknown current edge/i);
  await assert.rejects(operations.createTopologyDistanceMeasurement(
    { type: "vertex", bodyId: 8, vertexId: 201 },
    { type: "vertex", bodyId: 7, vertexId: 101 },
    undefined,
    state.revision,
  ), /Solid or Sheet/i);
  assert.equal(mutations, 0);
});

test("creates a native persistent radius measurement on an exact circular edge", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const circularEdge = { id: "17e1", curveType: "Circle", circle: true, line: false, faceIds: ["17f1"] };
  const body = {
    id: 7, versionId: 17, type: "Solid", name: "Measured", boundsMm: null, faceIds: ["17f1"], edgeIds: [circularEdge.id],
    faces: [], edges: [circularEdge], vertices: [],
  };
  const state = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body], measurements: [] } as unknown as RuntimeState;
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; },
  } as unknown as PlasticityRuntime;

  await new PlasticityOperations(runtime).createRadiusMeasurement({ bodyId: 7, edgeId: circularEdge.id }, "Outer radius", state.revision);

  assert.deepEqual(call?.bindings, ["RadialMeasurementFactory"]);
  assert.deepEqual(call?.values, [{ edge: { bodyId: 7, edgeId: circularEdge.id }, name: "Outer radius" }]);
  assert.match(call?.source ?? "", /EdgePointSnap/);
  assert.match(call?.source ?? "", /new this\.commands\.MeasureRadiusCommand\(this\)/);
  assert.match(call?.source ?? "", /factory\.snap = snap/);
  assert.match(call?.source ?? "", /measurements\.update\(\[measurement\], \[\], \[\]\)/);
  assert.match(call?.source ?? "", /viewport\.setNeedsRender\(\)/);
});

test("rejects stale, missing, and noncircular persistent radius references before mutation", async () => {
  let mutations = 0;
  const lineEdge = { id: "17e1", curveType: "Line", circle: false, line: true, faceIds: ["17f1"] };
  const body = { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: ["17f1"], edgeIds: [lineEdge.id], faces: [], edges: [lineEdge], vertices: [] };
  const wire = { id: 8, versionId: 18, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [] };
  const state = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body, wire], measurements: [] } as unknown as RuntimeState;
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.createRadiusMeasurement({ bodyId: 7, edgeId: lineEdge.id }, undefined, state.revision), /circular edge/i);
  await assert.rejects(operations.createRadiusMeasurement({ bodyId: 7, edgeId: "missing" }, undefined, state.revision), /unknown current edge/i);
  await assert.rejects(operations.createRadiusMeasurement({ bodyId: 8, edgeId: "missing" }, undefined, state.revision), /segmentEntityId/i);
  await assert.rejects(operations.createRadiusMeasurement({ bodyId: 8, segmentEntityId: 801 }, undefined, "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("lists and removes current native measurements through Plasticity history", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const measurement = {
    id: 3, versionId: 13, type: "DistanceMeasurement", name: "Width", measurementSource: "native-brep" as const,
    first: { bodyId: 7, topologyId: 101, landmark: 0, positionMm: [0, 0, 0] as [number, number, number] },
    second: { bodyId: 7, topologyId: 102, landmark: 0, positionMm: [20, 0, 0] as [number, number, number] },
    distanceMm: 20, direction: [1, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number], offsetMm: [-20, 0],
  };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [], measurements: [measurement] };
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  assert.deepEqual(await operations.listMeasurements(), { documentToken: state.documentToken, revision: state.revision, measurements: [measurement] });
  await operations.deleteMeasurement(3, state.revision);

  assert.deepEqual(call?.bindings, ["RemoveMeasurementCommand"]);
  assert.deepEqual(call?.values, [{ id: 3 }]);
  assert.match(call?.source ?? "", /lookupByStableId\(args\.id\)/);
  assert.match(call?.source ?? "", /selected\.addMeasurement\(measurement\)/);
  assert.match(call?.source ?? "", /command\.execute\.bind\(command\)/);
  assert.match(call?.source ?? "", /viewport\.setNeedsRender\(\)/);
});

test("classifies sampled native face draft relative to a normalized pull direction", async () => {
  let readCall: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const face = { id: "17f1", centerMm: [10, 5, 5], normal: [0, 0, 1], planar: true };
  const body = {
    id: 7, versionId: 17, type: "Solid", name: "Drafted", boundsMm: null,
    faceIds: [face.id], edgeIds: [], faces: [face], edges: [], vertices: [],
  };
  const state = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body],
  } as unknown as RuntimeState;
  const runtime = {
    async getState() { return state; },
    async readNative(source: string, bindings: string[], values: unknown[]) {
      readCall = { source, bindings, values };
      return [{
        face: { bodyId: 7, faceId: "17f1" }, bodyVersionId: 17, surfaceType: "BSurf",
        samples: [
          { positionMm: [0, 0, 0], normal: [0, 0, -2] },
          { positionMm: [10, 0, 5], normal: [4, 0, 0] },
          { positionMm: [20, 10, 10], normal: [0, 0, 3] },
        ],
      }];
    },
  } as unknown as PlasticityRuntime;

  const result = await new PlasticityOperations(runtime).analyzeFaceDraft(
    [{ bodyId: 7, faceId: "17f1" }],
    [0, 0, 2],
    2,
    8,
    state.revision,
  );

  assert.deepEqual(result.pullDirection, [0, 0, 1]);
  assert.equal(result.minimumDraftDeg, 2);
  assert.equal(result.samplesPerDirection, 8);
  assert.equal(result.analyses[0]?.classification, "mixed");
  assert.deepEqual(result.analyses[0]?.sampleCounts, { positive: 1, negative: 1, neutral: 1 });
  assert.equal(result.analyses[0]?.minimumSignedDraft.valueDeg, -90);
  assert.equal(result.analyses[0]?.maximumSignedDraft.valueDeg, 90);
  assert.equal(result.analyses[0]?.minimumAbsoluteDraftDeg, 0);
  assert.equal(result.analyses[0]?.maximumAbsoluteDraftDeg, 90);
  assert.deepEqual(readCall?.bindings, []);
  assert.deepEqual(readCall?.values, [{ faces: [{ bodyId: 7, faceId: "17f1" }], samplesPerDirection: 8 }]);
  assert.match(readCall?.source ?? "", /face\.EvalGrid\(args\.samplesPerDirection, args\.samplesPerDirection\)/u);
  assert.match(readCall?.source ?? "", /face\.FindPointNear\(requested\)/u);
  assert.match(readCall?.source ?? "", /face\.EvalNormal\(uv\.u, uv\.v\)/u);
  assert.match(result.limitation, /finite grid/iu);
});

test("rejects invalid face draft requests before native sampling", async () => {
  let reads = 0;
  const solid = { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: ["17f1"], edgeIds: [], faces: [], edges: [], vertices: [] };
  const wire = { id: 8, versionId: 18, type: "Wire", name: null, boundsMm: null, faceIds: ["18f1"], edgeIds: [], faces: [], edges: [], vertices: [] };
  const state = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [solid, wire] } as unknown as RuntimeState;
  const runtime = { async getState() { return state; }, async readNative() { reads += 1; return []; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const face = [{ bodyId: 7, faceId: "17f1" }];

  await assert.rejects(operations.analyzeFaceDraft(face, [0, 0, 1], 2, 8, "old"), /stale reference/i);
  await assert.rejects(operations.analyzeFaceDraft([{ bodyId: 7, faceId: "missing" }], [0, 0, 1], 2, 8, state.revision), /unknown current face/i);
  await assert.rejects(operations.analyzeFaceDraft([{ bodyId: 8, faceId: "18f1" }], [0, 0, 1], 2, 8, state.revision), /Solid or Sheet/i);
  await assert.rejects(operations.analyzeFaceDraft(face, [0, 0, 0], 2, 8, state.revision), /pull direction/i);
  await assert.rejects(operations.analyzeFaceDraft(face, [0, 0, 1], 0, 8, state.revision), /minimum draft angle/i);
  await assert.rejects(operations.analyzeFaceDraft(face, [0, 0, 1], 90, 8, state.revision), /minimum draft angle/i);
  await assert.rejects(operations.analyzeFaceDraft(face, [0, 0, 1], 2, 2, state.revision), /samples per direction/i);
  await assert.rejects(operations.analyzeFaceDraft(face, [0, 0, 1], 2, 33, state.revision), /samples per direction/i);
  assert.equal(reads, 0);
});

test("analyzes sampled native surface continuity across current shell edges", async () => {
  let readCall: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const edge = {
    id: "17e1", curveType: "Line", line: true, circle: false, lengthMm: 20,
    centerMm: [10, 0, 0] as [number, number, number], tangent: [1, 0, 0] as [number, number, number],
    boundsMm: { min: [0, 0, 0] as [number, number, number], max: [20, 0, 0] as [number, number, number] },
    faceIds: ["17f1", "17f2"], vertexIds: [101, 102],
  };
  const body = {
    id: 7, versionId: 17, type: "Solid", name: "Corner", boundsMm: edge.boundsMm,
    faceIds: edge.faceIds, edgeIds: [edge.id], faces: [], edges: [edge], vertices: [],
  };
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body],
  };
  const analyses = [{
    edge: { bodyId: 7, edgeId: "17e1" },
    adjacentFaces: [{ bodyId: 7, faceId: "17f1" }, { bodyId: 7, faceId: "17f2" }],
    bodyVersionId: 17,
    measurementSource: "native-brep-100-samples" as const,
    sampleCount: 100,
    maximumPositionDeviationMm: 0,
    maximumPositionDeviationAtMm: [20, 0, 0],
    maximumNormalAngleDeviationDeg: 90,
    maximumNormalAngleDeviationAtMm: [20, 0, 0],
    maximumRelativeCurvatureDeviation: 0,
    maximumRelativeCurvatureDeviationAtMm: [20, 0, 0],
    tolerances: { positionMm: 0.01, normalAngleDeg: 0.1, relativeCurvature: 0.05 },
    passes: { G0: true, G1: false, G2: false },
    achievedContinuity: "G0" as const,
  }];
  const runtime = {
    async getState() { return state; },
    async readNative(source: string, bindings: string[], values: unknown[]) { readCall = { source, bindings, values }; return analyses; },
  } as unknown as PlasticityRuntime;

  const result = await new PlasticityOperations(runtime).analyzeSurfaceContinuity(
    [{ bodyId: 7, edgeId: "17e1" }],
    state.revision,
    0.01,
    0.1,
    0.05,
  );

  assert.deepEqual(result, { documentToken: state.documentToken, revision: state.revision, analyses });
  assert.deepEqual(readCall?.bindings, ["MeasureContinuityFactory", "ContinuityType", "evalSurfaceContinuityMeasurements", "EvalSurfaceContinuityMeasurements_refresh"]);
  assert.deepEqual(readCall?.values, [{
    edges: [{ bodyId: 7, edgeId: "17e1" }],
    tolerances: { positionMm: 0.01, normalAngleDeg: 0.1, relativeCurvature: 0.05 },
    bodyVersions: [{ bodyId: 7, versionId: 17 }],
  }]);
  assert.match(readCall?.source ?? "", /factory\.g1ToleranceDegrees = args\.tolerances\.normalAngleDeg/);
  assert.match(readCall?.source ?? "", /evalSurfaceContinuityMeasurements/);
  assert.match(readCall?.source ?? "", /maximumNormalAngleDeviationDeg/);
  assert.match(readCall?.source ?? "", /achievedContinuity/);
});

test("analyzes sampled native curvature across current B-Rep edges", async () => {
  let readCall: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const edge = {
    id: "18e1", curveType: "Circle", line: false, circle: true, lengthMm: 62.8318530718,
    centerMm: [0, 0, 0] as [number, number, number], tangent: [0, 1, 0] as [number, number, number],
    boundsMm: { min: [-10, -10, 0] as [number, number, number], max: [10, 10, 0] as [number, number, number] },
    faceIds: [], vertexIds: [],
  };
  const body = {
    id: 8, versionId: 18, type: "Wire", name: "R10", boundsMm: edge.boundsMm,
    faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [],
  };
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body],
  };
  const analyses = [{
    edge: { bodyId: 8, segmentEntityId: 801 }, bodyVersionId: 18,
    measurementSource: "native-brep-100-samples" as const, sampleCount: 100,
    minimumCurvaturePerMm: 0.1, maximumCurvaturePerMm: 0.1, meanCurvaturePerMm: 0.1,
    minimumCurvatureAtMm: [10, 0, 0], maximumCurvatureAtMm: [10, 0, 0],
    maximumCurvatureVectorPerMm: [0.1, 0, 0],
    minimumRadiusOfCurvatureMm: 10, maximumFiniteRadiusOfCurvatureMm: 10,
    containsZeroCurvature: false,
  }];
  const runtime = {
    async getState() { return state; },
    async readNative(source: string, bindings: string[], values: unknown[]) { readCall = { source, bindings, values }; return analyses; },
  } as unknown as PlasticityRuntime;

  const result = await new PlasticityOperations(runtime).analyzeEdgeCurvature([{ bodyId: 8, segmentEntityId: 801 }], state.revision);

  assert.deepEqual(result, { documentToken: state.documentToken, revision: state.revision, analyses });
  assert.deepEqual(readCall?.bindings, ["evalCurvatureMeasurements", "CurvatureMeasurement", "Target", "TopologyLandmark"]);
  assert.deepEqual(readCall?.values, [{
    edges: [{ bodyId: 8, segmentEntityId: 801 }],
    bodyVersions: [{ bodyId: 8, versionId: 18 }],
  }]);
  assert.match(readCall?.source ?? "", /evalCurvatureMeasurements/);
  assert.match(readCall?.source ?? "", /analysis\.spikes/);
  assert.match(readCall?.source ?? "", /minimumRadiusOfCurvatureMm/);
  assert.match(readCall?.source ?? "", /maximumCurvatureVectorPerMm/);
});

test("rejects stale, duplicate, and missing edges before curvature analysis", async () => {
  let reads = 0;
  const edge = { id: "18e1", faceIds: [] };
  const wire = { id: 8, versionId: 18, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [] };
  const solid = { id: 9, versionId: 19, type: "Solid", name: null, boundsMm: null, faceIds: [], edgeIds: [edge.id], faces: [], edges: [edge], vertices: [] };
  const state = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [wire, solid] } as unknown as RuntimeState;
  const runtime = { async getState() { return state; }, async readNative() { reads += 1; return []; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.analyzeEdgeCurvature([], state.revision), /at least one edge/i);
  await assert.rejects(operations.analyzeEdgeCurvature([{ bodyId: 8, segmentEntityId: 801 }, { bodyId: 8, segmentEntityId: 801 }], state.revision), /edge references must be unique/i);
  await assert.rejects(operations.analyzeEdgeCurvature([{ bodyId: 9, edgeId: "missing" }], state.revision), /unknown current edge/i);
  await assert.rejects(operations.analyzeEdgeCurvature([{ bodyId: 8, segmentEntityId: 801 }], "old-revision"), /stale reference/i);
  assert.equal(reads, 0);
});

test("rejects stale, duplicate, boundary, and missing edges before continuity analysis", async () => {
  let reads = 0;
  const shared = { id: "17e1", faceIds: ["17f1", "17f2"] };
  const boundary = { id: "17e2", faceIds: ["17f1"] };
  const body = { id: 7, versionId: 17, type: "Sheet", name: null, boundsMm: null, faceIds: ["17f1", "17f2"], edgeIds: [shared.id, boundary.id], faces: [], edges: [shared, boundary], vertices: [] };
  const state = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body] } as unknown as RuntimeState;
  const runtime = { async getState() { return state; }, async readNative() { reads += 1; return []; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const edge = { bodyId: 7, edgeId: shared.id };

  await assert.rejects(operations.analyzeSurfaceContinuity([], state.revision), /at least one edge/i);
  await assert.rejects(operations.analyzeSurfaceContinuity([edge, edge], state.revision), /edge references must be unique/i);
  await assert.rejects(operations.analyzeSurfaceContinuity([{ bodyId: 7, edgeId: "missing" }], state.revision), /unknown current edge/i);
  await assert.rejects(operations.analyzeSurfaceContinuity([{ bodyId: 7, edgeId: boundary.id }], state.revision), /exactly two adjacent faces/i);
  await assert.rejects(operations.analyzeSurfaceContinuity([edge], "old-revision"), /stale reference/i);
  await assert.rejects(operations.analyzeSurfaceContinuity([edge], state.revision, 0, 0.1, 0.05), /position tolerance/i);
  await assert.rejects(operations.analyzeSurfaceContinuity([edge], state.revision, 0.01, Number.NaN, 0.05), /normal angle tolerance/i);
  await assert.rejects(operations.analyzeSurfaceContinuity([edge], state.revision, 0.01, 0.1, -1), /curvature tolerance/i);
  assert.equal(reads, 0);
});

test("rejects stale, missing, and coincident persistent measurement references", async () => {
  let mutations = 0;
  const body = {
    id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [],
    vertices: [{ id: 101, positionMm: [0, 0, 0] as [number, number, number], edgeIds: [], faceIds: [] }],
  };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body], measurements: [] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.createVertexDistanceMeasurement({ bodyId: 7, vertexId: 101 }, { bodyId: 7, vertexId: 999 }, undefined, state.revision), /second.*current native/i);
  await assert.rejects(operations.createVertexDistanceMeasurement({ bodyId: 7, vertexId: 101 }, { bodyId: 7, vertexId: 101 }, undefined, state.revision), /must be different/i);
  await assert.rejects(operations.createVertexDistanceMeasurement({ bodyId: 7, vertexId: 101 }, { bodyId: 7, vertexId: 101 }, undefined, "old-revision"), /stale reference/i);
  await assert.rejects(operations.deleteMeasurement(99, state.revision), /unknown current measurement/i);
  assert.equal(mutations, 0);
});

test("creates and transforms native instances through their empty transforms", async () => {
  const calls: Array<{ source: string; bindings: string[]; values: unknown[] }> = [];
  const body = { id: 7, versionId: 17, type: "Solid", name: "Source", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const instance = {
    id: 0, type: "Instance" as const, targetKey: 10, targetName: "Source", sourceBodyIds: [7],
    translationMm: [30, 0, 0] as [number, number, number], rotationQuaternion: [0, 0, 0, 1] as [number, number, number, number],
    scale: [1, 1, 1] as [number, number, number], matrixWorldMm: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 30, 0, 0, 1], visible: true, hidden: false, locked: false,
  };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body], instances: [instance] };
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) { calls.push({ source, bindings, values }); return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  assert.deepEqual(await operations.listInstances(), { documentToken: state.documentToken, revision: state.revision, instances: [instance] });
  await operations.createInstance(7, [30, 0, 0], state.revision);
  await operations.moveInstances([0], [5, 0, 0], state.revision);
  await operations.rotateInstances([0], [0, 0, 0], [0, 0, 1], 90, state.revision);
  await operations.scaleInstances([0], [0, 0, 0], [2, 1, 1], state.revision);

  assert.deepEqual(calls[0]?.bindings, ["CreateInstanceFactory", "MoveItemAndEmptyFactory"]);
  assert.deepEqual(calls[0]?.values, [{ bodyId: 7, translation: [0.03, 0, 0] }]);
  assert.match(calls[0]?.source ?? "", /create\.items = \[find\(args\.bodyId\)\]/);
  assert.match(calls[0]?.source ?? "", /move\.empties = created/);
  assert.deepEqual(calls[1]?.bindings, ["MoveItemAndEmptyFactory"]);
  assert.deepEqual(calls[1]?.values, [{ ids: [0], delta: [0.005, 0, 0] }]);
  assert.match(calls[1]?.source ?? "", /const store = this\.db\.empties\.write/);
  assert.match(calls[1]?.source ?? "", /const copy = original\.clone\(false\)/);
  assert.match(calls[1]?.source ?? "", /store\.id2empty\.set\(id, copy\)/);
  assert.match(calls[1]?.source ?? "", /factory\.empties = args\.ids\.map\(find\)/);
  assert.deepEqual(calls[2]?.bindings, ["RotateItemAndEmptyFactory", "Vector3", "Quaternion"]);
  assert.deepEqual(calls[3]?.bindings, ["ProjectingScaleItemAndEmptyFactory"]);
});

test("duplicates independent native Solid and Sheet bodies in one grouped operation", async () => {
  const calls: Array<{ source: string; bindings: string[]; values: unknown[] }> = [];
  const solid = { id: 7, versionId: 17, type: "Solid", name: "Solid source", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const sheet = { id: 8, versionId: 18, type: "Sheet", name: "Sheet source", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const wire = { id: 9, versionId: 19, type: "Wire", name: "Wire source", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [solid, sheet, wire],
  };
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) { calls.push({ source, bindings, values }); return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.duplicateBodies([7, 8], [30, 0, 0], state.revision);

  assert.deepEqual(calls[0]?.bindings, ["CreateInstanceFactory", "MoveItemAndEmptyFactory", "RealizeInstanceFactory"]);
  assert.deepEqual(calls[0]?.values, [{ ids: [7, 8], translation: [0.03, 0, 0] }]);
  assert.match(calls[0]?.source ?? "", /new this\.commands\.GroupSelectedCommand/);
  assert.match(calls[0]?.source ?? "", /create\.items = args\.ids\.map\(find\)/);
  assert.match(calls[0]?.source ?? "", /created\.every\(item => item\?\.constructor\?\.name === 'InstanceEmpty'\)/);
  assert.match(calls[0]?.source ?? "", /move\.empties = created/);
  assert.match(calls[0]?.source ?? "", /realize\.empties = created/);

  const mutationCount = calls.length;
  await assert.rejects(operations.duplicateBodies([], [0, 0, 0], state.revision), /nonempty unique list/i);
  await assert.rejects(operations.duplicateBodies([7, 7], [0, 0, 0], state.revision), /nonempty unique list/i);
  await assert.rejects(operations.duplicateBodies([99], [0, 0, 0], state.revision), /unknown current body/i);
  await assert.rejects(operations.duplicateBodies([9], [0, 0, 0], state.revision), /Solid or Sheet/i);
  await assert.rejects(operations.duplicateBodies([7], [Number.NaN, 0, 0], state.revision), /finite/i);
  await assert.rejects(operations.duplicateBodies([7], [0, 0, 0], "old-revision"), /stale reference/i);
  assert.equal(calls.length, mutationCount);
});

test("realizes and deletes current native instances while rejecting stale identities", async () => {
  const calls: Array<{ source: string; bindings: string[]; values: unknown[] }> = [];
  const instance = {
    id: 0, type: "Instance" as const, targetKey: 10, targetName: "Source", sourceBodyIds: [7],
    translationMm: [30, 0, 0] as [number, number, number], rotationQuaternion: [0, 0, 0, 1] as [number, number, number, number],
    scale: [1, 1, 1] as [number, number, number], matrixWorldMm: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 30, 0, 0, 1], visible: true, hidden: false, locked: false,
  };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [], instances: [instance] };
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) { calls.push({ source, bindings, values }); return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.realizeInstances([0], state.revision);
  await operations.deleteInstances([0], state.revision);

  assert.deepEqual(calls[0]?.bindings, ["RealizeInstanceFactory"]);
  assert.match(calls[0]?.source ?? "", /factory\.empties = args\.ids\.map\(find\)/);
  assert.deepEqual(calls[1]?.bindings, []);
  assert.match(calls[1]?.source ?? "", /selection\.selected\.addEmpty\(empty\)/);
  assert.match(calls[1]?.source ?? "", /new this\.commands\.DeleteCommand/);

  const mutationCount = calls.length;
  await assert.rejects(operations.moveInstances([1], [1, 0, 0], state.revision), /unknown current native instance/i);
  await assert.rejects(operations.realizeInstances([0, 0], state.revision), /nonempty unique list/i);
  await assert.rejects(operations.deleteInstances([0], "old-revision"), /stale reference/i);
  await assert.rejects(operations.createInstance(99, [0, 0, 0], state.revision), /unknown current body/i);
  assert.equal(calls.length, mutationCount);
});

test("manages native groups, hierarchy, visibility, and locks through document history", async () => {
  const calls: Array<{ source: string; bindings: string[]; values: unknown[] }> = [];
  const body = { id: 7, versionId: 17, type: "Solid", name: "Body", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const instance = {
    id: 0, type: "Instance" as const, targetKey: 10, targetName: "Body", sourceBodyIds: [7],
    translationMm: [30, 0, 0] as [number, number, number], rotationQuaternion: [0, 0, 0, 1] as [number, number, number, number],
    scale: [1, 1, 1] as [number, number, number], matrixWorldMm: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 30, 0, 0, 1],
    visible: true, hidden: false, locked: false,
  };
  const referenceMesh = {
    id: 3, type: "ReferenceMesh" as const, name: "Phone", sourcePath: "/tmp/phone.stl", sourceFormat: "stl" as const,
    measurementSource: "reference-mesh" as const, boundsMm: null, translationMm: [0, 0, 0] as [number, number, number],
    rotationQuaternion: [0, 0, 0, 1] as [number, number, number, number], sceneScaleToMeters: [0.001, 0.001, 0.001] as [number, number, number],
    vertexEntries: 3, triangles: 1, visible: true, hidden: false, locked: false,
  };
  const root = { id: 0, name: "Scene", parentId: null, childGroupIds: [1, 2], bodyIds: [7], instanceIds: [0], referenceMeshIds: [3], otherNodeKeys: [4], visible: true, hidden: false, locked: false };
  const group1 = { id: 1, name: "Parts", parentId: 0, childGroupIds: [], bodyIds: [], instanceIds: [], referenceMeshIds: [], otherNodeKeys: [], visible: true, hidden: false, locked: false };
  const group2 = { id: 2, name: "Housing", parentId: 0, childGroupIds: [], bodyIds: [], instanceIds: [], referenceMeshIds: [], otherNodeKeys: [], visible: true, hidden: false, locked: false };
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body], instances: [instance], referenceMeshes: [referenceMesh],
    activeGroupId: 0, groups: [root, group1, group2],
  };
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) { calls.push({ source, bindings, values }); return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  assert.deepEqual(await operations.listGroups(), {
    documentToken: state.documentToken, revision: state.revision, activeGroupId: 0, groups: state.groups,
  });
  await operations.createGroup([7], [0], [3], [1], "Bracket assembly", state.revision);
  await operations.moveToGroup([7], [0], [3], [1], 2, state.revision);
  await operations.renameGroup(1, "Bracket", state.revision);
  await operations.activateGroup(2, state.revision);
  await operations.activateGroup(0, state.revision);
  await operations.dissolveGroups([1], state.revision);
  await operations.setNodeVisibility([7], [0], [3], [1], false, state.revision);
  await operations.setNodeLocked([7], [0], [3], [1], true, state.revision);

  assert.deepEqual(calls[0]?.bindings, []);
  assert.deepEqual(calls[0]?.values, [{ bodyIds: [7], instanceIds: [0], referenceMeshIds: [3], groupIds: [1], name: "Bracket assembly" }]);
  assert.match(calls[0]?.source ?? "", /findReferenceMesh/u);
  assert.match(calls[0]?.source ?? "", /selected\.addGroup\(group\)/);
  assert.match(calls[0]?.source ?? "", /command\.execute = async function/);
  assert.match(calls[0]?.source ?? "", /db\.nodes\.setName/);
  assert.deepEqual(calls[1]?.bindings, ["MoveSelectionToGroupCommand"]);
  assert.deepEqual(calls[1]?.values, [{ bodyIds: [7], instanceIds: [0], referenceMeshIds: [3], groupIds: [1], destinationGroupId: 2 }]);
  assert.match(calls[1]?.source ?? "", /new Command\(this, findGroup\(args\.destinationGroupId\)\)/);
  assert.match(calls[2]?.source ?? "", /db\.nodes\.setName/);
  assert.match(calls[2]?.source ?? "", /selection\.selected\.removeAll\(\)/);
  assert.deepEqual(calls[3]?.bindings, ["ActivateGroupCommand"]);
  assert.deepEqual(calls[3]?.values, [{ id: 2 }]);
  assert.match(calls[3]?.source ?? "", /new Command\(this, group\)/);
  assert.deepEqual(calls[4]?.values, [{ id: 0 }]);
  assert.deepEqual(calls[5]?.bindings, ["DissolveGroupCommand"]);
  assert.match(calls[5]?.source ?? "", /selected\.addGroup\(group\)/);
  assert.deepEqual(calls[6]?.values, [{ flag: "visibility", bodyIds: [7], instanceIds: [0], referenceMeshIds: [3], groupIds: [1], value: false }]);
  assert.match(calls[6]?.source ?? "", /db\.nodes\.setVisible/);
  assert.match(calls[6]?.source ?? "", /selection\.selected\.removeAll\(\)/);
  assert.deepEqual(calls[7]?.values, [{ flag: "locked", bodyIds: [7], instanceIds: [0], referenceMeshIds: [3], groupIds: [1], value: true }]);
  assert.match(calls[7]?.source ?? "", /db\.nodes\.setLocked/);
  assert.match(calls[7]?.source ?? "", /selection\.selected\.removeAll\(\)/);
});

test("rejects stale, missing, duplicate, root, empty, and cyclic group operations before mutation", async () => {
  let mutations = 0;
  const body = { id: 7, versionId: 17, type: "Solid", name: "Body", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const root = { id: 0, name: "Scene", parentId: null, childGroupIds: [1], bodyIds: [7], instanceIds: [], referenceMeshIds: [], otherNodeKeys: [4], visible: true, hidden: false, locked: false };
  const group1 = { id: 1, name: "Parent", parentId: 0, childGroupIds: [2], bodyIds: [], instanceIds: [], referenceMeshIds: [], otherNodeKeys: [], visible: true, hidden: false, locked: false };
  const group2 = { id: 2, name: "Child", parentId: 1, childGroupIds: [], bodyIds: [], instanceIds: [], referenceMeshIds: [], otherNodeKeys: [], visible: true, hidden: false, locked: false };
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body], instances: [],
    activeGroupId: 0, groups: [root, group1, group2],
  };
  const runtime = {
    async getState() { return state; }, async mutate() { mutations += 1; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.createGroup([], [], [], [], undefined, state.revision), /at least one body, instance, reference mesh, or group/i);
  await assert.rejects(operations.createGroup([7, 7], [], [], [], undefined, state.revision), /body IDs must be unique/i);
  await assert.rejects(operations.createGroup([99], [], [], [], undefined, state.revision), /unknown current body/i);
  await assert.rejects(operations.createGroup([], [99], [], [], undefined, state.revision), /unknown current native instance/i);
  await assert.rejects(operations.createGroup([], [], [], [0], undefined, state.revision), /root Scene group is protected/i);
  await assert.rejects(operations.renameGroup(0, "No", state.revision), /root Scene group is protected/i);
  await assert.rejects(operations.activateGroup(99, state.revision), /unknown current group/i);
  await assert.rejects(operations.dissolveGroups([99], state.revision), /unknown current group/i);
  await assert.rejects(operations.moveToGroup([], [], [], [1], 2, state.revision), /would create a group cycle/i);
  await assert.rejects(operations.moveToGroup([], [], [], [1], 1, state.revision), /would create a group cycle/i);
  await assert.rejects(operations.setNodeVisibility([], [], [], [], false, state.revision), /at least one body, instance, reference mesh, or group/i);
  await assert.rejects(operations.setNodeLocked([7], [], [], [], true, "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("reads and replaces mixed native body, instance, and group selections", async () => {
  const reads: Array<{ source: string; values: unknown[] }> = [];
  const body = { id: 7, versionId: 17, type: "Solid", name: "Body", boundsMm: null, faceIds: ["17f1"], edgeIds: ["17e1"], faces: [], edges: [] };
  const instance = {
    id: 0, type: "Instance" as const, targetKey: 10, targetName: "Body", sourceBodyIds: [7],
    translationMm: [0, 0, 0] as [number, number, number], rotationQuaternion: [0, 0, 0, 1] as [number, number, number, number],
    scale: [1, 1, 1] as [number, number, number], matrixWorldMm: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    visible: true, hidden: false, locked: false,
  };
  const root = { id: 0, name: "Scene", parentId: null, childGroupIds: [1], bodyIds: [7], instanceIds: [0], referenceMeshIds: [], otherNodeKeys: [4], visible: true, hidden: false, locked: false };
  const group = { id: 1, name: "Assembly", parentId: 0, childGroupIds: [], bodyIds: [], instanceIds: [], referenceMeshIds: [], otherNodeKeys: [], visible: true, hidden: false, locked: false };
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body], instances: [instance], activeGroupId: 0, groups: [root, group],
  };
  const selected = { bodyIds: [7], curveIds: [], instanceIds: [0], referenceMeshIds: [], groupIds: [1], faces: [], edges: [], regionIds: [], curveControlPoints: [] };
  const runtime = {
    async getState() { return state; },
    async read(source: string, values: unknown[]) {
      reads.push({ source, values });
      return source.includes("const selection = this.selection.selected;") ? selected : undefined;
    },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  const result = await operations.selectNodes([7], [0], [], [1], state.revision);

  assert.deepEqual(result, { documentToken: state.documentToken, revision: state.revision, ...selected });
  assert.deepEqual(reads[0]?.values, [{ bodyIds: [7], instanceIds: [0], referenceMeshIds: [], groupIds: [1] }]);
  assert.match(reads[0]?.source ?? "", /selected\.addEmpty\(empty\)/);
  assert.match(reads[0]?.source ?? "", /selected\.addGroup\(group\)/);
  assert.match(reads[1]?.source ?? "", /selection\.empties/);
  assert.match(reads[1]?.source ?? "", /selection\.groups/);

  await operations.selectFaces([{ bodyId: 7, faceId: "17f1" }], state.revision);
  await operations.selectEdges([{ bodyId: 7, edgeId: "17e1" }], state.revision);
  assert.deepEqual(reads[2]?.values, [{ references: [{ bodyId: 7, faceId: "17f1" }] }]);
  assert.match(reads[2]?.source ?? "", /selected\.addFace/);
  assert.deepEqual(reads[4]?.values, [{ references: [{ bodyId: 7, edgeId: "17e1" }] }]);
  assert.match(reads[4]?.source ?? "", /selected\.addEdge/);

  const readCount = reads.length;
  await assert.rejects(operations.selectNodes([], [], [], [], state.revision), /at least one body, instance, reference mesh, or group/i);
  await assert.rejects(operations.selectNodes([99], [], [], [], state.revision), /unknown current body/i);
  await assert.rejects(operations.selectNodes([7], [], [], [], "old-revision"), /stale reference/i);
  await assert.rejects(operations.selectFaces([{ bodyId: 7, faceId: "missing" }], state.revision), /unknown current face/i);
  await assert.rejects(operations.selectFaces([{ bodyId: 7, faceId: "17f1" }, { bodyId: 7, faceId: "17f1" }], state.revision), /face references must be unique/i);
  await assert.rejects(operations.selectEdges([], state.revision), /at least one edge reference/i);
  await assert.rejects(operations.selectEdges([{ bodyId: 7, edgeId: "missing" }], state.revision), /unknown current edge/i);
  assert.equal(reads.length, readCount);
});

test("selects whole native Wire curves by current revision-bound body ID", async () => {
  const reads: Array<{ source: string; values: unknown[] }> = [];
  const wire = { id: 7, versionId: 17, type: "Wire", name: "Profile", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const solid = { id: 8, versionId: 18, type: "Solid", name: "Body", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [wire, solid] };
  const selected = { bodyIds: [7], curveIds: [7], instanceIds: [], referenceMeshIds: [], groupIds: [], faces: [], edges: [], regionIds: [], curveControlPoints: [] };
  const runtime = {
    async getState() { return state; },
    async read(source: string, values: unknown[]) {
      reads.push({ source, values });
      return source.includes("const selection = this.selection.selected;") ? selected : undefined;
    },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  const result = await operations.selectCurves([7], state.revision);

  assert.deepEqual(result, { documentToken: state.documentToken, revision: state.revision, ...selected });
  assert.deepEqual(reads[0]?.values, [{ ids: [7] }]);
  assert.match(reads[0]?.source ?? "", /selected\.addCurve\(find\(id\)\)/u);
  assert.match(reads[1]?.source ?? "", /selection\.curveIds/u);

  const readCount = reads.length;
  await assert.rejects(operations.selectCurves([], state.revision), /Wire IDs must be a nonempty unique list/u);
  await assert.rejects(operations.selectCurves([7, 7], state.revision), /Wire IDs must be a nonempty unique list/u);
  await assert.rejects(operations.selectCurves([99], state.revision), /Unknown current Wire ID/u);
  await assert.rejects(operations.selectCurves([8], state.revision), /current Wire IDs only/u);
  await assert.rejects(operations.selectCurves([7], "old-revision"), /Stale reference/u);
  assert.equal(reads.length, readCount);
});

test("reads and replaces revision-bound native curve control-point selections", async () => {
  const reads: Array<{ source: string; values: unknown[] }> = [];
  const wire = { id: 7, versionId: 17, type: "Wire", name: "Guide", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [wire] };
  const points = [{ bodyId: 7, kind: "vertex" as const, pointId: 101 }, { bodyId: 7, kind: "control-point" as const, pointId: 2 }];
  const inventory = [{
    id: 7, versionId: 17, positionSource: "native-control-handle" as const,
    boundaryVertices: [{ reference: points[0], versionId: "17v101", positionMm: [0, 0, 0] as [number, number, number] }],
    interiorControlPoints: [{ reference: points[1], versionId: "17c2", positionMm: [10, 20, 0] as [number, number, number] }],
  }];
  const selected = { bodyIds: [], instanceIds: [], groupIds: [], faces: [], edges: [], regionIds: [], curveControlPoints: points };
  const runtime = {
    async getState() { return state; },
    async readNative() { return inventory; },
    async read(source: string, values: unknown[]) { reads.push({ source, values }); return source.includes("const selection = this.selection.selected;") ? selected : undefined; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  assert.deepEqual(await operations.selectCurveControlPoints(points, state.revision), { documentToken: state.documentToken, revision: state.revision, ...selected });
  assert.deepEqual(reads[0]?.values, [{ points }]);
  assert.match(reads[0]?.source ?? "", /selected\.addVertex/);
  assert.match(reads[0]?.source ?? "", /selected\.addCurveCV/);
  assert.match(reads[1]?.source ?? "", /selection\.curveVertices/);
  assert.match(reads[1]?.source ?? "", /selection\.curveCVs/);
});

test("moves, rotates, and scales exact native faces in one history command each", async () => {
  const calls: Array<{ source: string; bindings: string[]; values: unknown[] }> = [];
  const face = {
    id: "17f1", surfaceType: "Cylinder", planar: false,
    centerMm: [0, 0, 5] as [number, number, number], normal: [1, 0, 0] as [number, number, number],
    radiusMm: 5, blendRadiusMm: null, axisOriginMm: [0, 0, 0] as [number, number, number],
    axisDirection: [0, 0, 1] as [number, number, number],
    boundsMm: { min: [-5, -5, 0] as [number, number, number], max: [5, 5, 10] as [number, number, number] }, edgeIds: [],
  };
  const body = { id: 7, versionId: 17, type: "Solid", name: "Cylinder", boundsMm: null, faceIds: [face.id], edgeIds: [], faces: [face], edges: [] };
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body],
  };
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) { calls.push({ source, bindings, values }); return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const faces = [{ bodyId: 7, faceId: "17f1" }];

  await operations.moveFaces(faces, [0, 0, 5], state.revision);
  await operations.rotateFaces(faces, [10, 20, 30], [0, 2, 0], -10, state.revision);
  await operations.scaleFaces(faces, [0, 0, 0], [2, 2, 1], state.revision);

  assert.deepEqual(calls.map((call) => call.bindings), [
    ["MultiMoveFaceFactory"],
    ["MultiRotateFaceFactory", "Vector3", "Quaternion"],
    ["MultiPlanarizingBasicScaleFaceFactory"],
  ]);
  assert.deepEqual(calls.map((call) => call.values), [
    [{ faces, delta: [0, 0, 0.005] }],
    [{ faces, pivot: [0.01, 0.02, 0.03], axis: [0, 1, 0], radians: -Math.PI / 18 }],
    [{ faces, pivot: [0, 0, 0], factors: [2, 2, 1] }],
  ]);
  assert.match(calls[0]?.source ?? "", /new this\.commands\.MoveFaceCommand/);
  assert.match(calls[1]?.source ?? "", /new this\.commands\.RotateFaceCommand/);
  assert.match(calls[1]?.source ?? "", /setFromAxisAngle/);
  assert.match(calls[2]?.source ?? "", /new this\.commands\.ScaleFaceCommand/);
  assert.match(calls[2]?.source ?? "", /factory\.scale\.fromArray/);
  assert(calls.every((call) => call.source.includes("view.high.faces.versionIds.indexOf")));
});

test("rejects stale and invalid native face transforms before mutation", async () => {
  let mutations = 0;
  const face = {
    id: "17f1", surfaceType: "Plane", planar: true,
    centerMm: [0, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number],
    radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null,
    boundsMm: { min: [0, 0, 0] as [number, number, number], max: [10, 10, 0] as [number, number, number] }, edgeIds: [],
  };
  const body = { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: [face.id], edgeIds: [], faces: [face], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const faceRef = { bodyId: 7, faceId: "17f1" };

  await assert.rejects(operations.moveFaces([], [0, 0, 1], state.revision), /at least one face/i);
  await assert.rejects(operations.moveFaces([faceRef, faceRef], [0, 0, 1], state.revision), /face references must be unique/i);
  await assert.rejects(operations.moveFaces([{ bodyId: 7, faceId: "missing" }], [0, 0, 1], state.revision), /unknown current face/i);
  await assert.rejects(operations.moveFaces([faceRef], [0, 0, 0], state.revision), /finite nonzero/i);
  await assert.rejects(operations.rotateFaces([faceRef], [0, 0, Number.NaN], [0, 0, 1], 10, state.revision), /pivot must be finite/i);
  await assert.rejects(operations.rotateFaces([faceRef], [0, 0, 0], [0, 0, 0], 10, state.revision), /axis.*zero/i);
  await assert.rejects(operations.rotateFaces([faceRef], [0, 0, 0], [0, 0, 1], 0, state.revision), /angle must be finite and nonzero/i);
  await assert.rejects(operations.scaleFaces([faceRef], [0, 0, 0], [1, 0, 1], state.revision), /factors must be finite and positive/i);
  await assert.rejects(operations.scaleFaces([faceRef], [0, 0, 0], [1, 1, 1], state.revision), /must change at least one factor/i);
  await assert.rejects(operations.scaleFaces([faceRef], [0, 0, 0], [2, 2, 1], "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("thickens faces, offsets face loops, and patches Solid edge loops natively", async () => {
  const calls: Array<{ source: string; bindings: string[]; values: unknown[] }> = [];
  const face = { id: "17f1", surfaceType: "Plane", planar: true, centerMm: [10, 5, 5] as [number, number, number], normal: [0, 0, 1] as [number, number, number], radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: [0, 0, 5] as [number, number, number], max: [20, 10, 5] as [number, number, number] }, edgeIds: ["17e1"] };
  const edge = { id: "17e1", curveType: "Circle", line: false, circle: true, lengthMm: 18.8495559215, centerMm: [7, 5, 5] as [number, number, number], tangent: [0, -1, 0] as [number, number, number], boundsMm: { min: [7, 2, 5] as [number, number, number], max: [13, 8, 5] as [number, number, number] }, faceIds: [face.id], vertexIds: [] };
  const body = { id: 7, versionId: 17, type: "Solid", name: "Block", boundsMm: null, faceIds: [face.id], edgeIds: [edge.id], faces: [face], edges: [edge] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body] };
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) { calls.push({ source, bindings, values }); return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const faces = [{ bodyId: 7, faceId: face.id }];
  const edges = [{ bodyId: 7, edgeId: edge.id }];

  await operations.thickenFaces(faces, 2, 1, state.revision);
  await operations.offsetFaceLoops(faces, -2, false, state.revision);
  await operations.patchSolidEdgeLoops(edges, state.revision);

  assert.deepEqual(calls.map((call) => call.bindings), [
    ["ThickenFaceFactory", "ThickenFaceCommand"],
    ["OffsetFaceLoopFactory", "OffsetFaceLoopCommand"],
    ["PatchHoleInSolidFactory", "PatchHoleInSolidCommand"],
  ]);
  assert.deepEqual(calls.map((call) => call.values), [
    [{ faces, front: 0.002, back: 0.001 }],
    [{ faces, distance: -0.002, individual: false }],
    [{ edges }],
  ]);
  assert.match(calls[0]?.source ?? "", /factory\.faces = selectedFaces/);
  assert.match(calls[0]?.source ?? "", /factory\.front = args\.front/);
  assert.match(calls[1]?.source ?? "", /factory\.isIndividual = args\.individual/);
  assert.match(calls[2]?.source ?? "", /factory\.edges = selectedEdges/);
  assert(calls.every((call) => call.source.includes("new Command(editor)")));
});

test("rejects invalid face thickening, face-loop offsets, and Solid loop patches before mutation", async () => {
  let mutations = 0;
  const face = { id: "17f1", surfaceType: "Plane", planar: true, centerMm: [0, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number], radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: [0, 0, 0] as [number, number, number], max: [1, 1, 0] as [number, number, number] }, edgeIds: ["17e1"] };
  const edge = { id: "17e1", curveType: "Line", line: true, circle: false, lengthMm: 1, centerMm: [0.5, 0, 0] as [number, number, number], tangent: [1, 0, 0] as [number, number, number], boundsMm: { min: [0, 0, 0] as [number, number, number], max: [1, 0, 0] as [number, number, number] }, faceIds: [face.id], vertexIds: [1, 2] };
  const body = { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: [face.id], edgeIds: [edge.id], faces: [face], edges: [edge] };
  const other = { ...body, id: 8, versionId: 18, faceIds: ["18f1"], edgeIds: ["18e1"], faces: [{ ...face, id: "18f1" }], edges: [{ ...edge, id: "18e1" }] };
  const wire = { ...body, id: 9, versionId: 19, type: "Wire", faceIds: ["19f1"], edgeIds: ["19e1"], faces: [{ ...face, id: "19f1" }], edges: [{ ...edge, id: "19e1" }] };
  const sheet = { ...body, id: 10, versionId: 20, type: "Sheet", faceIds: ["20f1"], edgeIds: ["20e1"], faces: [{ ...face, id: "20f1" }], edges: [{ ...edge, id: "20e1" }] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body, other, wire, sheet] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const faces = [{ bodyId: 7, faceId: "17f1" }];
  const edges = [{ bodyId: 7, edgeId: "17e1" }];

  await assert.rejects(operations.thickenFaces([], 2, 1, state.revision), /at least one face/i);
  await assert.rejects(operations.thickenFaces([faces[0]!, faces[0]!], 2, 1, state.revision), /references must be unique/i);
  await assert.rejects(operations.thickenFaces([faces[0]!, { bodyId: 8, faceId: "18f1" }], 2, 1, state.revision), /one body/i);
  await assert.rejects(operations.thickenFaces([{ bodyId: 9, faceId: "19f1" }], 2, 1, state.revision), /Solid or Sheet/i);
  await assert.rejects(operations.thickenFaces(faces, -1, 1, state.revision), /nonnegative/i);
  await assert.rejects(operations.thickenFaces(faces, 0, 0, state.revision), /positive front or back/i);
  await assert.rejects(operations.offsetFaceLoops(faces, 0, true, state.revision), /nonzero/i);
  await assert.rejects(operations.offsetFaceLoops([{ bodyId: 9, faceId: "19f1" }], 2, true, state.revision), /Solid or Sheet/i);
  await assert.rejects(operations.patchSolidEdgeLoops([], state.revision), /at least one edge/i);
  await assert.rejects(operations.patchSolidEdgeLoops([edges[0]!, edges[0]!], state.revision), /references must be unique/i);
  await assert.rejects(operations.patchSolidEdgeLoops([{ bodyId: 10, edgeId: "20e1" }], state.revision), /requires a Solid/i);
  await assert.rejects(operations.patchSolidEdgeLoops(edges, "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("moves and offsets exact native edges from one body", async () => {
  const calls: Array<{ source: string; bindings: string[]; values: unknown[] }> = [];
  const edge = {
    id: "17e1", curveType: "Line", line: true, circle: false, lengthMm: 20,
    centerMm: [10, 0, 10] as [number, number, number], tangent: [1, 0, 0] as [number, number, number],
    boundsMm: { min: [0, 0, 10] as [number, number, number], max: [20, 0, 10] as [number, number, number] },
    faceIds: ["17f1", "17f2"], vertexIds: [101, 102],
  };
  const body = { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: edge.faceIds, edgeIds: [edge.id], faces: [], edges: [edge] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body] };
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) { calls.push({ source, bindings, values }); return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const edges = [{ bodyId: 7, edgeId: "17e1" }];

  await operations.moveEdges(edges, [0, 0, 5], state.revision);
  await operations.offsetEdges(edges, -2, state.revision);

  assert.deepEqual(calls.map((call) => call.bindings), [
    ["MoveEdgeFactory", "MoveEdgeCommand"],
    ["OffsetEdgeFactory", "OffsetEdgeCommand"],
  ]);
  assert.deepEqual(calls.map((call) => call.values), [
    [{ edges, delta: [0, 0, 0.005] }],
    [{ edges, distance: -0.002 }],
  ]);
  assert(calls.every((call) => call.source.includes("factory.shell = view")));
  assert(calls.every((call) => call.source.includes("factory.edges = selectedEdges")));
  assert.match(calls[0]?.source ?? "", /factory\.move\.fromArray/);
  assert.match(calls[1]?.source ?? "", /factory\.distance = args\.distance/);
});

test("deletes exact native edges from one body", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const edge = { id: "17e1", curveType: "BCurve", line: false, circle: false, lengthMm: 20, centerMm: [10, 0, 8] as [number, number, number], tangent: [1, 0, 0] as [number, number, number], boundsMm: { min: [0, 0, 8] as [number, number, number], max: [20, 0, 8] as [number, number, number] }, faceIds: ["17f1", "17f2"], vertexIds: [101, 102] };
  const body = { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: edge.faceIds, edgeIds: [edge.id], faces: [], edges: [edge] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body] };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const edges = [{ bodyId: 7, edgeId: "17e1" }];

  await operations.deleteEdges(edges, state.revision);

  assert.deepEqual(call?.bindings, ["DeleteEdgeFactory", "DeleteEdgeCommand"]);
  assert.deepEqual(call?.values, [{ edges }]);
  assert.match(call?.source ?? "", /factory\.shell = view/);
  assert.match(call?.source ?? "", /factory\.edges = selectedEdges/);
  assert.match(call?.source ?? "", /new Command\(editor\)/);
});

test("rejects invalid and cross-body native edge edits before mutation", async () => {
  let mutations = 0;
  const edge = { id: "17e1", curveType: "Line", line: true, circle: false, lengthMm: 20, centerMm: [10, 0, 10] as [number, number, number], tangent: [1, 0, 0] as [number, number, number], boundsMm: { min: [0, 0, 10] as [number, number, number], max: [20, 0, 10] as [number, number, number] }, faceIds: [], vertexIds: [] };
  const body = { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: [], edgeIds: [edge.id], faces: [], edges: [edge] };
  const other = { ...body, id: 8, versionId: 18, edgeIds: ["18e1"], edges: [{ ...edge, id: "18e1" }] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body, other] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const edgeRef = { bodyId: 7, edgeId: "17e1" };

  await assert.rejects(operations.moveEdges([], [0, 0, 1], state.revision), /at least one edge/i);
  await assert.rejects(operations.moveEdges([edgeRef, edgeRef], [0, 0, 1], state.revision), /edge references must be unique/i);
  await assert.rejects(operations.moveEdges([edgeRef, { bodyId: 8, edgeId: "18e1" }], [0, 0, 1], state.revision), /one body/i);
  await assert.rejects(operations.moveEdges([{ bodyId: 7, edgeId: "missing" }], [0, 0, 1], state.revision), /unknown current edge/i);
  await assert.rejects(operations.moveEdges([edgeRef], [0, 0, 0], state.revision), /finite nonzero/i);
  await assert.rejects(operations.offsetEdges([edgeRef], 0, state.revision), /finite and nonzero/i);
  await assert.rejects(operations.offsetEdges([edgeRef], 2, "old-revision"), /stale reference/i);
  await assert.rejects(operations.deleteEdges([], state.revision), /at least one edge/i);
  await assert.rejects(operations.deleteEdges([edgeRef, edgeRef], state.revision), /edge references must be unique/i);
  await assert.rejects(operations.deleteEdges([edgeRef, { bodyId: 8, edgeId: "18e1" }], state.revision), /one body/i);
  await assert.rejects(operations.deleteEdges([{ bodyId: 7, edgeId: "missing" }], state.revision), /unknown current edge/i);
  await assert.rejects(operations.deleteEdges([edgeRef], "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("inserts exact native split vertices along incident shell edges", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const vertices = [
    { id: 101, positionMm: [20, 10, 10] as [number, number, number], edgeIds: [], faceIds: ["17f1", "17f2", "17f3"] },
    { id: 102, positionMm: [0, 0, 0] as [number, number, number], edgeIds: [], faceIds: ["17f4", "17f5", "17f6"] },
  ];
  const body = { id: 7, versionId: 17, type: "Solid", name: "Block", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], vertices };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body] };
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const references = [{ bodyId: 7, vertexId: 101 }, { bodyId: 7, vertexId: 102 }];

  await operations.offsetVertices(references, 5, state.revision);

  assert.deepEqual(call?.bindings, ["OffsetVertexFactory", "OffsetVertexCommand"]);
  assert.deepEqual(call?.values, [{ vertices: references, distance: 0.005 }]);
  assert.match(call?.source ?? "", /Snaps_ShellVertexSnap/);
  assert.match(call?.source ?? "", /factory\.vertices = selectedSnaps\.map\(snap => snap\.model\)/);
  assert.match(call?.source ?? "", /factory\._vertices\.views = selectedSnaps\.map/);
  assert.match(call?.source ?? "", /parentItem: snap\.item/);
  assert.match(call?.source ?? "", /new Command\(editor\)/);
});

test("rejects invalid native shell-vertex offsets before mutation", async () => {
  let mutations = 0;
  const vertex = { id: 101, positionMm: [20, 10, 10] as [number, number, number], edgeIds: [], faceIds: [] };
  const body = { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [vertex] };
  const sheet = { ...body, id: 8, versionId: 18, type: "Sheet", vertices: [{ ...vertex, id: 201 }] };
  const wire = { ...body, id: 9, versionId: 19, type: "Wire", vertices: [{ ...vertex, id: 301 }] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body, sheet, wire] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const reference = { bodyId: 7, vertexId: 101 };

  await assert.rejects(operations.offsetVertices([], 5, state.revision), /at least one shell vertex/i);
  await assert.rejects(operations.offsetVertices([reference, reference], 5, state.revision), /references must be unique/i);
  await assert.rejects(operations.offsetVertices([reference, { bodyId: 8, vertexId: 201 }], 5, state.revision), /one body/i);
  await assert.rejects(operations.offsetVertices([{ bodyId: 7, vertexId: 999 }], 5, state.revision), /current native B-Rep vertex/i);
  await assert.rejects(operations.offsetVertices([{ bodyId: 9, vertexId: 301 }], 5, state.revision), /Solid or Sheet/i);
  await assert.rejects(operations.offsetVertices([reference], 0, state.revision), /positive/i);
  await assert.rejects(operations.offsetVertices([reference], Number.NaN, state.revision), /positive/i);
  await assert.rejects(operations.offsetVertices([reference], 5, "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("patterns exact native feature faces in rectangular and radial arrays", async () => {
  const calls: Array<{ source: string; bindings: string[]; values: unknown[] }> = [];
  const face = {
    id: "17f1", surfaceType: "Cylinder", planar: false,
    centerMm: [7, 15, 7.5] as [number, number, number], normal: [-1, 0, 0] as [number, number, number],
    radiusMm: 3, blendRadiusMm: null, axisOriginMm: [10, 15, 5] as [number, number, number], axisDirection: [0, 0, 1] as [number, number, number],
    boundsMm: { min: [7, 12, 5] as [number, number, number], max: [13, 18, 10] as [number, number, number] }, edgeIds: [],
  };
  const body = { id: 7, versionId: 17, type: "Solid", name: "Boss plate", boundsMm: null, faceIds: [face.id], edgeIds: [], faces: [face], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body] };
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) { calls.push({ source, bindings, values }); return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const faces = [{ bodyId: 7, faceId: "17f1" }];

  await operations.rectangularFacePattern(faces, [2, 0, 0], 3, 15, [0, 4, 0], 2, 10, state.revision);
  await operations.radialFacePattern(faces, [30, 30, 0], [0, 0, 2], 4, 360, state.revision);

  assert.deepEqual(calls.map((call) => call.bindings), [
    ["RectangularArrayFacesFactory", "RectangularArrayFacesCommand", "Vector3"],
    ["RadialArrayFacesFactory", "RadialArrayFacesCommand", "Vector3"],
  ]);
  assert.deepEqual(calls.map((call) => call.values), [
    [{ faces, direction1: [1, 0, 0], count1: 3, spacing1: 0.015, direction2: [0, 1, 0], count2: 2, spacing2: 0.01 }],
    [{ faces, center: [0.03, 0.03, 0], axis: [0, 0, 1], count: 4, radians: Math.PI * 2 }],
  ]);
  assert.match(calls[0]?.source ?? "", /factory\.shell = view/);
  assert.match(calls[0]?.source ?? "", /factory\.faces = selectedFaces/);
  assert.match(calls[0]?.source ?? "", /factory\.mode = 'spacing'/);
  assert.match(calls[1]?.source ?? "", /factory\.center = new Vector/);
  assert.match(calls[1]?.source ?? "", /factory\.mode = 'total'/);
  assert(calls.every((call) => call.source.includes("new Command(editor)")));
});

test("rejects invalid native face patterns before mutation", async () => {
  let mutations = 0;
  const face = { id: "17f1", surfaceType: "Plane", planar: true, centerMm: [0, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number], radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: [0, 0, 0] as [number, number, number], max: [1, 1, 0] as [number, number, number] }, edgeIds: [] };
  const body = { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: [face.id], edgeIds: [], faces: [face], edges: [] };
  const other = { ...body, id: 8, versionId: 18, faceIds: ["18f1"], faces: [{ ...face, id: "18f1" }] };
  const wire = { ...body, id: 9, versionId: 19, type: "Wire", faceIds: ["19f1"], faces: [{ ...face, id: "19f1" }] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body, other, wire] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const faces = [{ bodyId: 7, faceId: "17f1" }];

  await assert.rejects(operations.rectangularFacePattern([], [1, 0, 0], 3, 10, [0, 1, 0], 1, 0, state.revision), /at least one face/i);
  await assert.rejects(operations.rectangularFacePattern([faces[0]!, faces[0]!], [1, 0, 0], 3, 10, [0, 1, 0], 1, 0, state.revision), /references must be unique/i);
  await assert.rejects(operations.rectangularFacePattern([faces[0]!, { bodyId: 8, faceId: "18f1" }], [1, 0, 0], 3, 10, [0, 1, 0], 1, 0, state.revision), /one body/i);
  await assert.rejects(operations.rectangularFacePattern([{ bodyId: 9, faceId: "19f1" }], [1, 0, 0], 3, 10, [0, 1, 0], 1, 0, state.revision), /Solid or Sheet/i);
  await assert.rejects(operations.rectangularFacePattern(faces, [0, 0, 0], 3, 10, [0, 1, 0], 1, 0, state.revision), /direction.*zero/i);
  await assert.rejects(operations.rectangularFacePattern(faces, [1, 0, 0], 1, 10, [0, 1, 0], 1, 0, state.revision), /count1/i);
  await assert.rejects(operations.rectangularFacePattern(faces, [1, 0, 0], 3, 0, [0, 1, 0], 1, 0, state.revision), /spacing1/i);
  await assert.rejects(operations.rectangularFacePattern(faces, [1, 0, 0], 3, 10, [2, 0, 0], 2, 10, state.revision), /must not be parallel/i);
  await assert.rejects(operations.rectangularFacePattern(faces, [1, 0, 0], 3, 10, [0, 1, 0], 2, 0, state.revision), /spacing2/i);
  await assert.rejects(operations.radialFacePattern(faces, [0, Number.NaN, 0], [0, 0, 1], 4, 360, state.revision), /center must be finite/i);
  await assert.rejects(operations.radialFacePattern(faces, [0, 0, 0], [0, 0, 0], 4, 360, state.revision), /axis.*zero/i);
  await assert.rejects(operations.radialFacePattern(faces, [0, 0, 0], [0, 0, 1], 1, 360, state.revision), /count/i);
  await assert.rejects(operations.radialFacePattern(faces, [0, 0, 0], [0, 0, 1], 4, 0, state.revision), /sweep/i);
  await assert.rejects(operations.radialFacePattern(faces, [0, 0, 0], [0, 0, 1], 4, 361, state.revision), /sweep/i);
  await assert.rejects(operations.radialFacePattern(faces, [0, 0, 0], [0, 0, 1], 4, 360, "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("clears topology selection before renaming a body through document history", async () => {
  let call: { source: string; values: unknown[] } | undefined;
  const body = { id: 7, versionId: 17, type: "Solid", name: "Before", boundsMm: null, faceIds: ["17f1"], edgeIds: ["17e1"], faces: [], edges: [] };
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body],
  };
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, _bindings: string[], values: unknown[]) { call = { source, values }; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.rename(7, "After", state.revision);

  assert.deepEqual(call?.values, [{ id: 7, name: "After" }]);
  assert.match(call?.source ?? "", /selection\.selected\.removeAll\(\)/);
});

test("aligns a moving body set between exact planar face centers in one history step", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const faceBounds = { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] };
  const moving = {
    id: 7, versionId: 17, type: "Solid", name: "Moving", boundsMm: null,
    faceIds: ["17f1"], edgeIds: [],
    faces: [{ id: "17f1", surfaceType: "Plane", planar: true, centerMm: [30, 5, 22.5] as [number, number, number], normal: [-1, 0, 0] as [number, number, number], radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: faceBounds, edgeIds: [] }],
    edges: [],
  };
  const companion = { ...moving, id: 9, versionId: 19, name: "Companion", faceIds: [], faces: [] };
  const fixed = {
    id: 8, versionId: 18, type: "Solid", name: "Fixed", boundsMm: null,
    faceIds: ["18f1"], edgeIds: [],
    faces: [{ id: "18f1", surfaceType: "Plane", planar: true, centerMm: [10, 10, 5] as [number, number, number], normal: [0, 0, 1] as [number, number, number], radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: faceBounds, edgeIds: [] }],
    edges: [],
  };
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [moving, fixed, companion],
  };
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.alignPlanarFaces([7, 9], { bodyId: 7, faceId: "17f1" }, { bodyId: 8, faceId: "18f1" }, "opposed", 2, state.revision);

  assert.deepEqual(call?.bindings, ["RotateItemAndEmptyFactory", "MoveItemAndEmptyFactory", "Vector3", "Quaternion"]);
  assert.deepEqual(call?.values, [{ ids: [7, 9], pivot: [0.03, 0.005, 0.0225], sourceNormal: [-1, 0, 0], targetNormal: [0, 0, -1], delta: [-0.02, 0.005, -0.0155] }]);
  assert.match(call?.source ?? "", /new this\.commands\.GroupSelectedCommand/);
  assert.match(call?.source ?? "", /selection\.selected\.removeAll\(\)/);
  assert.match(call?.source ?? "", /new RotateFactory/);
  assert.match(call?.source ?? "", /new MoveFactory/);

  await operations.alignPlanarFaces([7], { bodyId: 7, faceId: "17f1" }, { bodyId: 8, faceId: "18f1" }, "same", -1, state.revision);
  assert.deepEqual(call?.values, [{ ids: [7], pivot: [0.03, 0.005, 0.0225], sourceNormal: [-1, 0, 0], targetNormal: [0, 0, 1], delta: [-0.02, 0.005, -0.0185] }]);
});

test("rejects invalid planar-face alignments before native mutation", async () => {
  let mutations = 0;
  const faceBounds = { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] };
  const planar = { id: "17f1", surfaceType: "Plane", planar: true, centerMm: [0, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number], radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: faceBounds, edgeIds: [] };
  const curved = { ...planar, id: "17f2", surfaceType: "Cylinder", planar: false };
  const target = { ...planar, id: "18f1", centerMm: [0, 0, 10] as [number, number, number], normal: [0, 0, -1] as [number, number, number] };
  const bodies = [
    { id: 7, versionId: 17, type: "Solid", name: "Moving", boundsMm: null, faceIds: ["17f1", "17f2"], edgeIds: [], faces: [planar, curved], edges: [] },
    { id: 8, versionId: 18, type: "Solid", name: "Fixed", boundsMm: null, faceIds: ["18f1"], edgeIds: [], faces: [target], edges: [] },
  ];
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.alignPlanarFaces([], { bodyId: 7, faceId: "17f1" }, { bodyId: 8, faceId: "18f1" }, "opposed", 0, state.revision), /at least one moving body/i);
  await assert.rejects(operations.alignPlanarFaces([7, 7], { bodyId: 7, faceId: "17f1" }, { bodyId: 8, faceId: "18f1" }, "opposed", 0, state.revision), /moving body IDs must be unique/i);
  await assert.rejects(operations.alignPlanarFaces([8], { bodyId: 7, faceId: "17f1" }, { bodyId: 8, faceId: "18f1" }, "opposed", 0, state.revision), /source face must belong/i);
  await assert.rejects(operations.alignPlanarFaces([7, 8], { bodyId: 7, faceId: "17f1" }, { bodyId: 8, faceId: "18f1" }, "opposed", 0, state.revision), /target face must remain fixed/i);
  await assert.rejects(operations.alignPlanarFaces([7], { bodyId: 7, faceId: "17f2" }, { bodyId: 8, faceId: "18f1" }, "opposed", 0, state.revision), /source face must be planar/i);
  await assert.rejects(operations.alignPlanarFaces([7], { bodyId: 7, faceId: "17f1" }, { bodyId: 8, faceId: "missing" }, "opposed", 0, state.revision), /unknown current target face/i);
  await assert.rejects(operations.alignPlanarFaces([7], { bodyId: 7, faceId: "17f1" }, { bodyId: 8, faceId: "18f1" }, "opposed", Number.NaN, state.revision), /gap must be finite/i);
  await assert.rejects(operations.alignPlanarFaces([7], { bodyId: 7, faceId: "17f1" }, { bodyId: 8, faceId: "18f1" }, "opposed", 0, "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("aligns exact cylindrical axes while preserving or anchoring axial position", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const faceBounds = { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] };
  const cylinder = (id: string, origin: [number, number, number], axis: [number, number, number]) => ({
    id, surfaceType: "Cylinder", planar: false, centerMm: origin, normal: [0, 1, 0] as [number, number, number],
    radiusMm: 5, blendRadiusMm: null, axisOriginMm: origin, axisDirection: axis, boundsMm: faceBounds, edgeIds: [],
  });
  const sourceFace = cylinder("17f1", [30, 5, 2.5], [1, 0, 0]);
  const targetFace = cylinder("18f1", [10, 10, 5], [0, 0, 1]);
  const moving = { id: 7, versionId: 17, type: "Solid", name: "Moving", boundsMm: null, faceIds: [sourceFace.id], edgeIds: [], faces: [sourceFace], edges: [] };
  const companion = { ...moving, id: 9, versionId: 19, name: "Companion", faceIds: [], faces: [] };
  const fixed = { id: 8, versionId: 18, type: "Solid", name: "Fixed", boundsMm: null, faceIds: [targetFace.id], edgeIds: [], faces: [targetFace], edges: [] };
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [moving, fixed, companion],
  };
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.alignCylindricalFaces([7, 9], { bodyId: 7, faceId: "17f1" }, { bodyId: 8, faceId: "18f1" }, "opposed", "preserve", 0, 90, state.revision);

  assert.deepEqual(call?.bindings, ["RotateItemAndEmptyFactory", "MoveItemAndEmptyFactory", "Vector3", "Quaternion"]);
  assert.deepEqual(call?.values, [{
    ids: [7, 9], pivot: [0.03, 0.005, 0.0025], sourceAxis: [1, 0, 0], targetAxis: [0, 0, -1],
    fixedAxis: [0, 0, 1], delta: [-0.02, 0.005, 0], targetOrigin: [0.01, 0.01, 0.005], rollRadians: Math.PI / 2,
  }]);
  assert.match(call?.source ?? "", /new this\.commands\.GroupSelectedCommand/);
  assert.match(call?.source ?? "", /setFromUnitVectors/);
  assert.match(call?.source ?? "", /setFromAxisAngle/);
  assert.match(call?.source ?? "", /selection\.selected\.removeAll\(\)/);

  await operations.alignCylindricalFaces([7], { bodyId: 7, faceId: "17f1" }, { bodyId: 8, faceId: "18f1" }, "same", "anchor", 2, 0, state.revision);
  assert.deepEqual(call?.values, [{
    ids: [7], pivot: [0.03, 0.005, 0.0025], sourceAxis: [1, 0, 0], targetAxis: [0, 0, 1],
    fixedAxis: [0, 0, 1], delta: [-0.02, 0.005, 0.0045], targetOrigin: [0.01, 0.01, 0.005], rollRadians: 0,
  }]);
});

test("rejects invalid cylindrical-face alignments before native mutation", async () => {
  let mutations = 0;
  const faceBounds = { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] };
  const cylinder = { id: "17f1", surfaceType: "Cylinder", planar: false, centerMm: [0, 0, 0] as [number, number, number], normal: [1, 0, 0] as [number, number, number], radiusMm: 5, blendRadiusMm: null, axisOriginMm: [0, 0, 0] as [number, number, number], axisDirection: [0, 0, 1] as [number, number, number], boundsMm: faceBounds, edgeIds: [] };
  const plane = { ...cylinder, id: "17f2", surfaceType: "Plane", planar: true, axisOriginMm: null, axisDirection: null };
  const target = { ...cylinder, id: "18f1", axisOriginMm: [10, 0, 0] as [number, number, number] };
  const bodies = [
    { id: 7, versionId: 17, type: "Solid", name: "Moving", boundsMm: null, faceIds: ["17f1", "17f2"], edgeIds: [], faces: [cylinder, plane], edges: [] },
    { id: 8, versionId: 18, type: "Solid", name: "Fixed", boundsMm: null, faceIds: ["18f1"], edgeIds: [], faces: [target], edges: [] },
  ];
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const source = { bodyId: 7, faceId: "17f1" };
  const fixed = { bodyId: 8, faceId: "18f1" };

  await assert.rejects(operations.alignCylindricalFaces([], source, fixed, "same", "preserve", 0, 0, state.revision), /at least one moving body/i);
  await assert.rejects(operations.alignCylindricalFaces([7, 7], source, fixed, "same", "preserve", 0, 0, state.revision), /moving body IDs must be unique/i);
  await assert.rejects(operations.alignCylindricalFaces([8], source, fixed, "same", "preserve", 0, 0, state.revision), /source face must belong/i);
  await assert.rejects(operations.alignCylindricalFaces([7, 8], source, fixed, "same", "preserve", 0, 0, state.revision), /target face must remain fixed/i);
  await assert.rejects(operations.alignCylindricalFaces([7], { bodyId: 7, faceId: "17f2" }, fixed, "same", "preserve", 0, 0, state.revision), /source face must be cylindrical/i);
  await assert.rejects(operations.alignCylindricalFaces([7], source, { bodyId: 8, faceId: "missing" }, "same", "preserve", 0, 0, state.revision), /unknown current target face/i);
  await assert.rejects(operations.alignCylindricalFaces([7], source, fixed, "same", "preserve", 2, 0, state.revision), /axial offset.*anchor/i);
  await assert.rejects(operations.alignCylindricalFaces([7], source, fixed, "same", "anchor", Number.NaN, 0, state.revision), /axial offset must be finite/i);
  await assert.rejects(operations.alignCylindricalFaces([7], source, fixed, "same", "anchor", 0, Number.POSITIVE_INFINITY, state.revision), /rotation.*finite/i);
  await assert.rejects(operations.alignCylindricalFaces([7], source, fixed, "same", "anchor", 0, 0, "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("aligns an exact native vertex to a fixed vertex in one history step", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const moving = { id: 7, versionId: 17, type: "Solid", name: "Moving", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [{ id: 101, positionMm: [1, 2, 3] as [number, number, number], edgeIds: [], faceIds: [] }] };
  const fixed = { id: 8, versionId: 18, type: "Solid", name: "Fixed", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [{ id: 201, positionMm: [10, 20, 30] as [number, number, number], edgeIds: [], faceIds: [] }] };
  const companion = { ...moving, id: 9, versionId: 19, name: "Companion", vertices: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [moving, fixed, companion] };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.alignVertices([7, 9], { bodyId: 7, vertexId: 101 }, { bodyId: 8, vertexId: 201 }, [0, 0, 2], state.revision);

  assert.deepEqual(call?.bindings, ["MoveItemAndEmptyFactory"]);
  assert.deepEqual(call?.values, [{ ids: [7, 9], delta: [0.009, 0.018, 0.029] }]);
  assert.match(call?.source ?? "", /new this\.commands\.GroupSelectedCommand/);
  assert.match(call?.source ?? "", /new MoveFactory/);
  assert.match(call?.source ?? "", /selection\.selected\.removeAll\(\)/);
});

test("rejects invalid and no-op native vertex alignments before mutation", async () => {
  let mutations = 0;
  const moving = { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [{ id: 101, positionMm: [1, 2, 3] as [number, number, number], edgeIds: [], faceIds: [] }] };
  const fixed = { ...moving, id: 8, versionId: 18, vertices: [{ id: 201, positionMm: [10, 20, 30] as [number, number, number], edgeIds: [], faceIds: [] }] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [moving, fixed] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const source = { bodyId: 7, vertexId: 101 };
  const target = { bodyId: 8, vertexId: 201 };

  await assert.rejects(operations.alignVertices([], source, target, [0, 0, 0], state.revision), /at least one moving body/i);
  await assert.rejects(operations.alignVertices([7, 7], source, target, [0, 0, 0], state.revision), /moving body IDs must be unique/i);
  await assert.rejects(operations.alignVertices([8], source, target, [0, 0, 0], state.revision), /source vertex must belong/i);
  await assert.rejects(operations.alignVertices([7, 8], source, target, [0, 0, 0], state.revision), /target vertex must remain fixed/i);
  await assert.rejects(operations.alignVertices([7], { bodyId: 7, vertexId: 999 }, target, [0, 0, 0], state.revision), /source vertex.*current/i);
  await assert.rejects(operations.alignVertices([7], source, target, [0, Number.NaN, 0], state.revision), /offset must be finite/i);
  await assert.rejects(operations.alignVertices([7], source, target, [-9, -18, -27], state.revision), /would not move/i);
  await assert.rejects(operations.alignVertices([7], source, target, [0, 0, 0], "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("aligns exact native Line edges with an axial offset and roll in one history step", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const sourceEdge = { id: "17e1", curveType: "Line", line: true, circle: false, lengthMm: 20, centerMm: [10, 0, 0] as [number, number, number], tangent: [1, 0, 0] as [number, number, number], boundsMm: { min: [0, 0, 0] as [number, number, number], max: [20, 0, 0] as [number, number, number] }, faceIds: [], vertexIds: [101, 102] };
  const targetEdge = { ...sourceEdge, id: "18e1", lengthMm: 30, centerMm: [0, 20, 10] as [number, number, number], tangent: [0, 1, 0] as [number, number, number], boundsMm: { min: [0, 5, 10] as [number, number, number], max: [0, 35, 10] as [number, number, number] }, vertexIds: [201, 202] };
  const moving = { id: 7, versionId: 17, type: "Solid", name: "Moving", boundsMm: null, faceIds: [], edgeIds: [sourceEdge.id], faces: [], edges: [sourceEdge], vertices: [] };
  const fixed = { id: 8, versionId: 18, type: "Solid", name: "Fixed", boundsMm: null, faceIds: [], edgeIds: [targetEdge.id], faces: [], edges: [targetEdge], vertices: [] };
  const companion = { ...moving, id: 9, versionId: 19, name: "Companion", edgeIds: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [moving, fixed, companion] };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.alignLinearEdges([7, 9], { bodyId: 7, edgeId: sourceEdge.id }, { bodyId: 8, edgeId: targetEdge.id }, "opposed", 3, 90, state.revision);

  assert.deepEqual(call?.bindings, ["RotateItemAndEmptyFactory", "MoveItemAndEmptyFactory", "Vector3", "Quaternion"]);
  assert.deepEqual(call?.values, [{
    ids: [7, 9], sourcePivot: [0.01, 0, 0], targetPivot: [0, 0.023, 0.01],
    sourceDirection: [1, 0, 0], targetDirection: [0, -1, 0], fixedDirection: [0, 1, 0],
    delta: [-0.01, 0.023, 0.01], rollRadians: Math.PI / 2,
  }]);
  assert.match(call?.source ?? "", /new this\.commands\.GroupSelectedCommand/);
  assert.match(call?.source ?? "", /setFromUnitVectors/);
  assert.match(call?.source ?? "", /setFromAxisAngle/);
});

test("rejects invalid and no-op native linear-edge alignments before mutation", async () => {
  let mutations = 0;
  const line = { id: "17e1", curveType: "Line", line: true, circle: false, lengthMm: 20, centerMm: [0, 0, 0] as [number, number, number], tangent: [1, 0, 0] as [number, number, number], boundsMm: { min: [-10, 0, 0] as [number, number, number], max: [10, 0, 0] as [number, number, number] }, faceIds: [], vertexIds: [101, 102] };
  const curve = { ...line, id: "17e2", curveType: "Circle", line: false, circle: true };
  const target = { ...line, id: "18e1" };
  const bodies = [
    { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: [], edgeIds: [line.id, curve.id], faces: [], edges: [line, curve], vertices: [] },
    { id: 8, versionId: 18, type: "Solid", name: null, boundsMm: null, faceIds: [], edgeIds: [target.id], faces: [], edges: [target], vertices: [] },
  ];
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const source = { bodyId: 7, edgeId: line.id };
  const fixed = { bodyId: 8, edgeId: target.id };

  await assert.rejects(operations.alignLinearEdges([], source, fixed, "same", 0, 0, state.revision), /at least one moving body/i);
  await assert.rejects(operations.alignLinearEdges([7, 7], source, fixed, "same", 0, 0, state.revision), /moving body IDs must be unique/i);
  await assert.rejects(operations.alignLinearEdges([8], source, fixed, "same", 0, 0, state.revision), /source edge must belong/i);
  await assert.rejects(operations.alignLinearEdges([7, 8], source, fixed, "same", 0, 0, state.revision), /target edge must remain fixed/i);
  await assert.rejects(operations.alignLinearEdges([7], { bodyId: 7, edgeId: curve.id }, fixed, "same", 0, 0, state.revision), /source edge must be.*Line/i);
  await assert.rejects(operations.alignLinearEdges([7], source, { bodyId: 8, edgeId: "missing" }, "same", 0, 0, state.revision), /unknown current target edge/i);
  await assert.rejects(operations.alignLinearEdges([7], source, fixed, "same", Number.NaN, 0, state.revision), /axial offset must be finite/i);
  await assert.rejects(operations.alignLinearEdges([7], source, fixed, "same", 0, Number.POSITIVE_INFINITY, state.revision), /rotation.*finite/i);
  await assert.rejects(operations.alignLinearEdges([7], source, fixed, "same", 0, 0, state.revision), /would not transform/i);
  await assert.rejects(operations.alignLinearEdges([7], source, fixed, "same", 0, 0, "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("sets native block dimensions in one Plasticity history operation", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const solid = { id: 7, versionId: 17, type: "Solid", name: "Block", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [solid] };
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.setBlockDimensions(7, 15, 25, 35, state.revision);

  assert.deepEqual(call?.bindings, ["DimensionBlockCommand", "DimensionBlockFactory"]);
  assert.deepEqual(call?.values, [{ id: 7, width: 0.015, length: 0.025, height: 0.035 }]);
  assert.match(call?.source ?? "", /collection\?\.HasBlock/);
  assert.match(call?.source ?? "", /factory\.width = args\.width/);
  assert.match(call?.source ?? "", /new this\.commands\.GroupSelectedCommand\(this\)/);
});

test("rejects invalid block dimension targets and values before mutation", async () => {
  let mutations = 0;
  const wire = { id: 7, versionId: 17, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const solid = { ...wire, id: 8, versionId: 18, type: "Solid" };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [wire, solid] };
  const runtime = {
    async getState() { return state; },
    async mutate() { mutations += 1; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.setBlockDimensions(7, 10, 20, 30, state.revision), /current Solid/i);
  await assert.rejects(operations.setBlockDimensions(99, 10, 20, 30, state.revision), /current Solid/i);
  await assert.rejects(operations.setBlockDimensions(8, 0, 20, 30, state.revision), /widthMm/i);
  await assert.rejects(operations.setBlockDimensions(8, 10, Number.NaN, 30, state.revision), /lengthMm/i);
  await assert.rejects(operations.setBlockDimensions(8, 10, 20, -1, state.revision), /heightMm/i);
  await assert.rejects(operations.setBlockDimensions(8, 10, 20, 30, "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("sets an exact native radius dimension on one cylindrical face", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const cylinder = { id: "17f2", surfaceType: "Cylinder", planar: false, centerMm: [0, 0, 10] as [number, number, number], normal: [0, 0, 1] as [number, number, number], radiusMm: 5, blendRadiusMm: null, axisOriginMm: [0, 0, 0] as [number, number, number], axisDirection: [0, 0, 1] as [number, number, number], boundsMm: { min: [-5, -5, 0] as [number, number, number], max: [5, 5, 20] as [number, number, number] }, edgeIds: [] };
  const solid = { id: 7, versionId: 17, type: "Solid", name: "Cylinder", boundsMm: cylinder.boundsMm, faceIds: [cylinder.id], edgeIds: [], faces: [cylinder], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [solid] };
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.setRadiusDimension({ bodyId: 7, faceId: "17f2" }, 7, state.revision);

  assert.deepEqual(call?.bindings, ["DimensionRadiusCommand", "DimensionRadiusFactory"]);
  assert.deepEqual(call?.values, [{ face: { bodyId: 7, faceId: "17f2" }, radius: 0.007 }]);
  assert.match(call?.source ?? "", /selected\.addFace/);
  assert.match(call?.source ?? "", /collection\?\.HasRadius/);
  assert.match(call?.source ?? "", /factory\.radius = args\.radius/);
});

test("rejects stale, noncylindrical, and invalid radius dimension inputs", async () => {
  let mutations = 0;
  const plane = { id: "17f1", surfaceType: "Plane", planar: true, centerMm: [0, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number], radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: [0, 0, 0] as [number, number, number], max: [10, 10, 0] as [number, number, number] }, edgeIds: [] };
  const solid = { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: [plane.id], edgeIds: [], faces: [plane], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [solid] };
  const runtime = {
    async getState() { return state; },
    async mutate() { mutations += 1; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.setRadiusDimension({ bodyId: 7, faceId: plane.id }, 5, state.revision), /cylindrical face/i);
  await assert.rejects(operations.setRadiusDimension({ bodyId: 7, faceId: "missing" }, 5, state.revision), /cylindrical face/i);
  const cylindricalState = { ...state, bodies: [{ ...solid, faceIds: ["17f2"], faces: [{ ...plane, id: "17f2", surfaceType: "Cylinder", planar: false, radiusMm: 5 }] }] };
  const cylindricalRuntime = { async getState() { return cylindricalState; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const cylindricalOperations = new PlasticityOperations(cylindricalRuntime);
  await assert.rejects(cylindricalOperations.setRadiusDimension({ bodyId: 7, faceId: "17f2" }, 0, state.revision), /radiusMm/i);
  await assert.rejects(cylindricalOperations.setRadiusDimension({ bodyId: 7, faceId: "17f2" }, 7, "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("sets native dimensions on a recognized closed rectangular Wire", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const wire = { id: 7, versionId: 17, type: "Wire", name: "Rectangle", boundsMm: { min: [0, 0, 0] as [number, number, number], max: [20, 10, 0] as [number, number, number] }, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const region = { id: "17r21", entityId: 21, islandVersionId: 17, sketchId: 3, sketchWireIds: [7], measurementSource: "render-mesh" as const, displayBoundsMm: wire.boundsMm };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [region], bodies: [wire] };
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.setRectangleDimensions(7, 15, 25, state.revision);

  assert.deepEqual(call?.bindings, ["DimensionRectangleCommand", "DimensionRectangleFactory"]);
  assert.deepEqual(call?.values, [{ id: 7, width: 0.015, length: 0.025 }]);
  assert.match(call?.source ?? "", /collection\?\.HasRectangle/);
  assert.match(call?.source ?? "", /factory\.width = args\.width/);
  assert.match(call?.source ?? "", /factory\.length = args\.length/);
});

test("rejects open, non-Wire, stale, and invalid rectangle dimension inputs", async () => {
  let mutations = 0;
  const wire = { id: 7, versionId: 17, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const solid = { ...wire, id: 8, versionId: 18, type: "Solid" };
  const region = { id: "17r21", entityId: 21, islandVersionId: 17, sketchId: 3, sketchWireIds: [7], measurementSource: "render-mesh" as const, displayBoundsMm: { min: [0, 0, 0] as [number, number, number], max: [20, 10, 0] as [number, number, number] } };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [region], bodies: [wire, solid] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.setRectangleDimensions(8, 15, 25, state.revision), /closed planar Wire/i);
  const openState = { ...state, regions: [] };
  const openRuntime = { async getState() { return openState; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const openOperations = new PlasticityOperations(openRuntime);
  await assert.rejects(openOperations.setRectangleDimensions(7, 15, 25, state.revision), /closed planar Wire/i);
  await assert.rejects(operations.setRectangleDimensions(7, 0, 25, state.revision), /widthMm/i);
  await assert.rejects(operations.setRectangleDimensions(7, 15, Number.POSITIVE_INFINITY, state.revision), /lengthMm/i);
  await assert.rejects(operations.setRectangleDimensions(7, 15, 25, "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("rejects a cutter face that belongs to a cut target before a mutation", async () => {
  let mutated = false;
  const state: RuntimeState = {
    targetId: "window-1",
    title: "Untitled - Plasticity",
    documentToken: "document-1",
    revision: "current-revision",
    dbVersion: 1,
    undoDepth: 0,
    redoDepth: 0,
    regions: [],
    construction: emptyConstruction,
    bodies: [],
  };
  const runtime = {
    async getState() { return state; },
    async mutate() { mutated = true; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(
    operations.cutWithFaces([7], [{ bodyId: 7, faceId: "face-1" }], state.revision),
    /must not overlap/i,
  );
  assert.equal(mutated, false);
});

test("cuts current Solid or Sheet bodies with current planar cutter faces", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const target = { id: 7, versionId: 17, type: "Sheet", name: null, boundsMm: null, faceIds: ["target-face"], edgeIds: [], faces: [], edges: [] };
  const cutterFace = { id: "cutter-face", surfaceType: "Plane", planar: true, centerMm: [8, 0, 0] as [number, number, number], normal: [1, 0, 0] as [number, number, number], radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: [8, -5, -5] as [number, number, number], max: [8, 15, 5] as [number, number, number] }, edgeIds: [] };
  const cutter = { id: 9, versionId: 19, type: "Sheet", name: null, boundsMm: null, faceIds: [cutterFace.id], edgeIds: [], faces: [cutterFace], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [target, cutter] };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.cutWithFaces([7], [{ bodyId: 9, faceId: "cutter-face" }], state.revision);

  assert.deepEqual(call?.bindings, ["MultiCutFactory"]);
  assert.deepEqual(call?.values, [{ targetIds: [7], cutterFaces: [{ bodyId: 9, faceId: "cutter-face" }] }]);
  assert.match(call?.source ?? "", /factory\.shells = args\.targetIds\.map\(find\)/);
  assert.match(call?.source ?? "", /factory\.faces = args\.cutterFaces\.map/);
});

test("rejects invalid native cut references before mutation", async () => {
  let mutations = 0;
  const plane = { id: "plane", surfaceType: "Plane", planar: true, centerMm: [0, 0, 0] as [number, number, number], normal: [1, 0, 0] as [number, number, number], radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: [0, 0, 0] as [number, number, number], max: [0, 1, 1] as [number, number, number] }, edgeIds: [] };
  const curved = { ...plane, id: "curved", surfaceType: "Cylinder", planar: false };
  const solid = { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const wire = { ...solid, id: 8, versionId: 18, type: "Wire" };
  const cutter = { ...solid, id: 9, versionId: 19, type: "Sheet", faceIds: [plane.id, curved.id], faces: [plane, curved] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [solid, wire, cutter] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.cutWithFaces([], [{ bodyId: 9, faceId: "plane" }], state.revision), /at least one.*target/i);
  await assert.rejects(operations.cutWithFaces([7, 7], [{ bodyId: 9, faceId: "plane" }], state.revision), /target.*unique/i);
  await assert.rejects(operations.cutWithFaces([7], [], state.revision), /at least one.*cutter/i);
  await assert.rejects(operations.cutWithFaces([7], [{ bodyId: 9, faceId: "plane" }, { bodyId: 9, faceId: "plane" }], state.revision), /cutter.*unique/i);
  await assert.rejects(operations.cutWithFaces([8], [{ bodyId: 9, faceId: "plane" }], state.revision), /current Solid or Sheet/i);
  await assert.rejects(operations.cutWithFaces([99], [{ bodyId: 9, faceId: "plane" }], state.revision), /current Solid or Sheet/i);
  await assert.rejects(operations.cutWithFaces([7], [{ bodyId: 99, faceId: "plane" }], state.revision), /current planar cutter faces/i);
  await assert.rejects(operations.cutWithFaces([7], [{ bodyId: 9, faceId: "missing" }], state.revision), /current planar cutter faces/i);
  await assert.rejects(operations.cutWithFaces([7], [{ bodyId: 9, faceId: "curved" }], state.revision), /current planar cutter faces/i);
  await assert.rejects(operations.cutWithFaces([7], [{ bodyId: 9, faceId: "plane" }], "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("lists and assigns native Plasticity appearance materials", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const body = { id: 7, versionId: 17, type: "Solid", name: "Part", materialId: 0, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const materials = [{ id: 2, name: "Blue", colorHex: "#3366cc", roughness: 0.42, metalness: 0.1, opacity: 1 }];
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body], materials };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  assert.deepEqual(await operations.listAppearanceMaterials(), {
    documentToken: state.documentToken,
    revision: state.revision,
    materials,
    assignments: [{ bodyId: 7, materialId: 0 }],
  });
  await operations.setAppearanceMaterial([7], { materialId: 2 }, state.revision);

  assert.deepEqual(call?.bindings, []);
  assert.deepEqual(call?.values, [{ ids: [7], material: { materialId: 2 } }]);
  assert.match(call?.source ?? "", /selection\.selected\.removeAll\(\)/);
  assert.match(call?.source ?? "", /editor\.db\.nodes\.setMaterial\(editor\.db\.nodes\.item2key\(view\), materialId\)/);
});

test("creates bounded appearance materials through native document history", async () => {
  let call: { source: string; values: unknown[] } | undefined;
  const body = { id: 7, versionId: 17, type: "Sheet", name: null, materialId: 0, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body], materials: [] };
  const runtime = { async getState() { return state; }, async mutate(source: string, _bindings: string[], values: unknown[]) { call = { source, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const material = { name: "Signal orange", colorHex: "#ff6600", roughness: 0.6, metalness: 0, opacity: 0.8 };

  await operations.setAppearanceMaterial([7], material, state.revision);

  assert.deepEqual(call?.values, [{ ids: [7], material }]);
  assert.match(call?.source ?? "", /editor\.db\.materials\.default\.clone\(\)/);
  assert.match(call?.source ?? "", /editor\.db\.materials\.add\(args\.material\.name, appearance\)/);
  assert.match(call?.source ?? "", /new this\.commands\.GroupSelectedCommand\(this\)/);
});

test("rejects stale, missing, duplicate, and invalid appearance references before mutation", async () => {
  let mutations = 0;
  const body = { id: 7, versionId: 17, type: "Solid", name: null, materialId: 0, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body], materials: [] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.setAppearanceMaterial([], { materialId: 0 }, state.revision), /at least one body/i);
  await assert.rejects(operations.setAppearanceMaterial([7, 7], { materialId: 0 }, state.revision), /unique/i);
  await assert.rejects(operations.setAppearanceMaterial([99], { materialId: 0 }, state.revision), /current body/i);
  await assert.rejects(operations.setAppearanceMaterial([7], { materialId: 2 }, state.revision), /unknown current/i);
  await assert.rejects(operations.setAppearanceMaterial([7], { name: "Bad", colorHex: "orange", roughness: 0.5, metalness: 0, opacity: 1 }, state.revision), /#RRGGBB/i);
  await assert.rejects(operations.setAppearanceMaterial([7], { name: "Bad", colorHex: "#ff6600", roughness: 2, metalness: 0, opacity: 1 }, state.revision), /roughness/i);
  await assert.rejects(operations.setAppearanceMaterial([7], { materialId: 0 }, "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("converts a positive chamfer distance to the native negative fillet distance", async () => {
  let values: unknown[] | undefined;
  const state: RuntimeState = {
    targetId: "window-1",
    title: "Untitled - Plasticity",
    documentToken: "document-1",
    revision: "current-revision",
    dbVersion: 1,
    undoDepth: 0,
    redoDepth: 0,
    regions: [],
    construction: emptyConstruction,
    bodies: [],
  };
  const runtime = {
    async getState() { return state; },
    async mutate(_source: string, _bindings: string[], args: unknown[]) {
      values = args;
      return {};
    },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.chamfer(7, ["edge-1"], 2, state.revision);

  assert.deepEqual(values, [{ id: 7, edgeIds: ["edge-1"], distance: -0.002 }]);
});

test("removes recognized native fillets from current shell bodies", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const solid = { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: ["f1"], edgeIds: [], faces: [], edges: [] };
  const sheet = { ...solid, id: 8, versionId: 18, type: "Sheet" };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [solid, sheet] };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.removeFillets([7, 8], state.revision);

  assert.deepEqual(call?.bindings, ["RemoveFilletsFromShellFactory"]);
  assert.deepEqual(call?.values, [{ ids: [7, 8] }]);
  assert.match(call?.source ?? "", /RemoveFilletsFromShellCommand/);
  assert.match(call?.source ?? "", /factory\.shells = args\.ids\.map\(find\)/);
  assert.match(call?.source ?? "", /factory\.radius = 0/);
});

test("rejects invalid fillet-removal shell references before mutation", async () => {
  let mutations = 0;
  const wire = { id: 7, versionId: 17, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [wire] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.removeFillets([], state.revision), /at least one/i);
  await assert.rejects(operations.removeFillets([7, 7], state.revision), /unique/i);
  await assert.rejects(operations.removeFillets([7], state.revision), /current Solid or Sheet/i);
  await assert.rejects(operations.removeFillets([99], state.revision), /current Solid or Sheet/i);
  await assert.rejects(operations.removeFillets([7], "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("changes recognized native fillet radii by a signed delta", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const face = { id: "f1", surfaceType: "Cylinder", planar: false, centerMm: [0, 0, 0] as [number, number, number], normal: [1, 0, 0] as [number, number, number], radiusMm: 2, blendRadiusMm: 2, axisOriginMm: [0, 0, 0] as [number, number, number], axisDirection: [0, 0, 1] as [number, number, number], boundsMm: { min: [0, 0, 0] as [number, number, number], max: [2, 2, 10] as [number, number, number] }, edgeIds: [] };
  const solid = { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: [face.id], edgeIds: [], faces: [face], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [solid] };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.refilletFaces([{ bodyId: 7, faceId: "f1" }], 1, state.revision);

  assert.deepEqual(call?.bindings, ["RefilletFaceCommand", "RefilletFaceFactory"]);
  assert.deepEqual(call?.values, [{ faces: [{ bodyId: 7, faceId: "f1" }], distance: 0.001 }]);
  assert.match(call?.source ?? "", /factory\.shells = Array\.from\(shells\)/);
  assert.match(call?.source ?? "", /factory\.faces = args\.faces\.map/);
});

test("rejects invalid refillet inputs before mutation", async () => {
  let mutations = 0;
  const blend = { id: "blend", surfaceType: "Cylinder", planar: false, centerMm: [0, 0, 0] as [number, number, number], normal: [1, 0, 0] as [number, number, number], radiusMm: 2, blendRadiusMm: 2, axisOriginMm: [0, 0, 0] as [number, number, number], axisDirection: [0, 0, 1] as [number, number, number], boundsMm: { min: [0, 0, 0] as [number, number, number], max: [2, 2, 10] as [number, number, number] }, edgeIds: [] };
  const plane = { ...blend, id: "plane", surfaceType: "Plane", planar: true, blendRadiusMm: null, radiusMm: null };
  const solid = { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: [blend.id, plane.id], edgeIds: [], faces: [blend, plane], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [solid] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const reference = { bodyId: 7, faceId: blend.id };

  await assert.rejects(operations.refilletFaces([], 1, state.revision), /at least one/i);
  await assert.rejects(operations.refilletFaces([reference, reference], 1, state.revision), /unique/i);
  await assert.rejects(operations.refilletFaces([{ bodyId: 7, faceId: "missing" }], 1, state.revision), /stale or unknown/i);
  await assert.rejects(operations.refilletFaces([{ bodyId: 7, faceId: plane.id }], 1, state.revision), /recognized fillet/i);
  await assert.rejects(operations.refilletFaces([reference], 0, state.revision), /nonzero/i);
  await assert.rejects(operations.refilletFaces([reference], -2, state.revision), /positive radius/i);
  await assert.rejects(operations.refilletFaces([reference], 1, "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("converts a revolve axis origin to meters and keeps public degrees", async () => {
  let values: unknown[] | undefined;
  const state: RuntimeState = {
    targetId: "window-1",
    title: "Untitled - Plasticity",
    documentToken: "document-1",
    revision: "current-revision",
    dbVersion: 1,
    undoDepth: 0,
    redoDepth: 0,
    regions: [],
    construction: emptyConstruction,
    bodies: [],
  };
  const runtime = {
    async getState() { return state; },
    async mutate(_source: string, _bindings: string[], args: unknown[]) {
      values = args;
      return {};
    },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.revolveProfile(11, [1000, 2000, 3000], [0, 0, 5], 270, state.revision);

  assert.deepEqual(values, [{
    id: 11,
    axisOrigin: [1, 2, 3],
    axis: [0, 0, 5],
    angleDegrees: 270,
  }]);
});

test("converts both sheet-thickening distances to meters", async () => {
  let values: unknown[] | undefined;
  const state: RuntimeState = {
    targetId: "window-1",
    title: "Untitled - Plasticity",
    documentToken: "document-1",
    revision: "current-revision",
    dbVersion: 1,
    undoDepth: 0,
    redoDepth: 0,
    regions: [],
    construction: emptyConstruction,
    bodies: [],
  };
  const runtime = {
    async getState() { return state; },
    async mutate(_source: string, _bindings: string[], args: unknown[]) {
      values = args;
      return {};
    },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.thickenSheets([12, 13], 1.5, 0.5, state.revision);

  assert.deepEqual(values, [{ ids: [12, 13], front: 0.0015, back: 0.0005 }]);
});

test("hollows current native Solids as closed shells with a signed wall thickness", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const solids = [7, 8].map((id) => ({
    id, versionId: id + 10, type: "Solid", name: null, boundsMm: null,
    faceIds: [], edgeIds: [], faces: [], edges: [],
  }));
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [], construction: emptyConstruction, bodies: solids,
  };
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.hollowSolids([7, 8], 2, "inward", state.revision);

  assert.deepEqual(call?.bindings, ["HollowSolidsFactory"]);
  assert.deepEqual(call?.values, [{ ids: [7, 8], thickness: -0.002 }]);
  assert.match(call?.source ?? "", /HollowSolidsCommand/);
  assert.match(call?.source ?? "", /factory\.solids = solids/);
  assert.match(call?.source ?? "", /factory\.local = false/);
});

test("rejects invalid closed-solid hollowing before native mutation", async () => {
  let mutations = 0;
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [], construction: emptyConstruction,
    bodies: [{ id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] }],
  };
  const runtime = {
    async getState() { return state; }, async mutate() { mutations += 1; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.hollowSolids([], 2, "inward", state.revision), /at least one/i);
  await assert.rejects(operations.hollowSolids([7, 7], 2, "inward", state.revision), /unique/i);
  await assert.rejects(operations.hollowSolids([7], 0, "inward", state.revision), /positive/i);
  await assert.rejects(operations.hollowSolids([7], 2, "inward", "old-revision"), /stale reference/i);
  await assert.rejects(operations.hollowSolids([8], 2, "inward", state.revision), /current Solids/i);
  await assert.rejects(operations.hollowSolids([7], 2, "sideways" as "inward", state.revision), /direction/i);
  assert.equal(mutations, 0);
});

test("lists revision-bound native regions without mutation", async () => {
  let mutated = false;
  const state: RuntimeState = {
    targetId: "window-1",
    title: "Untitled - Plasticity",
    documentToken: "document-1",
    revision: "current-revision",
    dbVersion: 1,
    undoDepth: 0,
    redoDepth: 0,
    regions: [{
      id: "5r42",
      entityId: 42,
      islandVersionId: 5,
      sketchId: 3,
      sketchWireIds: [7],
      measurementSource: "render-mesh",
      displayBoundsMm: { min: [0, 0, 0], max: [20, 10, 0] },
    }],
    construction: emptyConstruction,
    bodies: [],
  };
  const runtime = {
    async getState() { return state; },
    async mutate() { mutated = true; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  assert.deepEqual(await operations.listRegions(), {
    documentToken: state.documentToken,
    revision: state.revision,
    regions: state.regions,
  });
  assert.equal(mutated, false);
});

test("extrudes closed profiles and explicit regions through native Region inputs", async () => {
  const calls: Array<{ source: string; bindings: string[]; values: unknown[] }> = [];
  const state: RuntimeState = {
    targetId: "window-1",
    title: "Untitled - Plasticity",
    documentToken: "document-1",
    revision: "current-revision",
    dbVersion: 1,
    undoDepth: 0,
    redoDepth: 0,
    regions: [],
    construction: emptyConstruction,
    bodies: [],
  };
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) {
      calls.push({ source, bindings, values });
      return {};
    },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.extrudeProfile(7, 12, state.revision);
  await operations.extrudeRegions(["5r42", "6r43"], -4, state.revision);

  assert.match(calls[0]!.source, /factory\.regions = regions/);
  assert.match(calls[0]!.source, /IsClosed/);
  assert.doesNotMatch(calls[0]!.source, /factory\.curves = \[view\]/);
  assert.deepEqual(calls[0]!.bindings, ["ExtrudeFactory"]);
  assert.deepEqual(calls[0]!.values, [{ id: 7, distance: 0.012 }]);
  assert.match(calls[1]!.source, /Stale or unknown regions/);
  assert.deepEqual(calls[1]!.values, [{ regionIds: ["5r42", "6r43"], distance: -0.004 }]);
});

test("rejects stale and duplicate explicit region references before mutation", async () => {
  let mutations = 0;
  const state: RuntimeState = {
    targetId: "window-1",
    title: "Untitled - Plasticity",
    documentToken: "document-1",
    revision: "current-revision",
    dbVersion: 1,
    undoDepth: 0,
    redoDepth: 0,
    regions: [],
    construction: emptyConstruction,
    bodies: [],
  };
  const runtime = {
    async getState() { return state; },
    async mutate() { mutations += 1; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.extrudeRegions(["5r42"], 10, "old-revision"), /stale reference/i);
  await assert.rejects(operations.extrudeRegions([], 10, state.revision), /at least one/i);
  await assert.rejects(operations.extrudeRegions(["5r42", "5r42"], 10, state.revision), /unique/i);
  assert.equal(mutations, 0);
});

test("offsets planar Wire bodies with a signed millimeter distance", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const state: RuntimeState = {
    targetId: "window-1",
    title: "Untitled - Plasticity",
    documentToken: "document-1",
    revision: "current-revision",
    dbVersion: 1,
    undoDepth: 0,
    redoDepth: 0,
    regions: [],
    construction: emptyConstruction,
    bodies: [],
  };
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) {
      call = { source, bindings, values };
      return {};
    },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.offsetPlanarCurves([7, 8], -2.5, state.revision);

  assert.deepEqual(call?.bindings, ["OffsetPlanarCurvesFactory"]);
  assert.deepEqual(call?.values, [{ ids: [7, 8], distance: -0.0025 }]);
  assert.match(call?.source ?? "", /OffsetPlanarCurveCommand/);
  assert.match(call?.source ?? "", /factory\.curves = args\.ids\.map\(findWire\)/);
  assert.match(call?.source ?? "", /factory\.distance1 = args\.distance/);
});

test("rejects zero and duplicate planar curve offsets before mutation", async () => {
  let mutations = 0;
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [], construction: emptyConstruction, bodies: [],
  };
  const runtime = {
    async getState() { return state; },
    async mutate() { mutations += 1; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.offsetPlanarCurves([7], 0, state.revision), /nonzero/i);
  await assert.rejects(operations.offsetPlanarCurves([7, 7], 2, state.revision), /unique/i);
  await assert.rejects(operations.offsetPlanarCurves([7], 2, "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("offsets explicit native Regions within one sketch", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, bodies: [],
    regions: [{
      id: "12r34", entityId: 34, islandVersionId: 12, sketchId: 3, sketchWireIds: [7],
      measurementSource: "render-mesh", displayBoundsMm: { min: [0, 0, 0], max: [20, 10, 0] },
    }],
  };
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.offsetRegions(["12r34"], [2, -1], false, state.revision);

  assert.deepEqual(call?.bindings, ["OffsetRegionFactory"]);
  assert.deepEqual(call?.values, [{ regionIds: ["12r34"], islandVersionId: 12, distance1: 0.002, distance2: -0.001, individual: false }]);
  assert.match(call?.source ?? "", /factory\.sketch = island\.view/);
  assert.match(call?.source ?? "", /factory\.regions = regions/);
});

test("rejects stale, missing, cross-sketch, zero, and duplicate Region offsets before mutation", async () => {
  let mutations = 0;
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, bodies: [],
    regions: [
      { id: "12r34", entityId: 34, islandVersionId: 12, sketchId: 3, sketchWireIds: [7], measurementSource: "render-mesh", displayBoundsMm: { min: [0, 0, 0], max: [20, 10, 0] } },
      { id: "13r35", entityId: 35, islandVersionId: 13, sketchId: 4, sketchWireIds: [8], measurementSource: "render-mesh", displayBoundsMm: { min: [30, 0, 0], max: [40, 10, 0] } },
    ],
  };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.offsetRegions([], [2], true, state.revision), /at least one/i);
  await assert.rejects(operations.offsetRegions(["missing"], [2], true, state.revision), /stale or unknown/i);
  await assert.rejects(operations.offsetRegions(["12r34", "13r35"], [2], true, state.revision), /same sketch/i);
  await assert.rejects(operations.offsetRegions(["12r34"], [0], true, state.revision), /nonzero/i);
  await assert.rejects(operations.offsetRegions(["12r34"], [2, 2], true, state.revision), /unique/i);
  await assert.rejects(operations.offsetRegions(["12r34"], [2], true, "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("lists revision-bound native curve fragments without mutation", async () => {
  let mutations = 0;
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [], construction: emptyConstruction, bodies: [],
  };
  const fragments = [{
    id: "12s34", bodyId: 7, ancestorVersionId: 10, fragmentViewId: 12, entityId: 34,
    measurementSource: "native-brep" as const,
    startMm: [-10, 0, 0] as [number, number, number],
    midpointMm: [-5, 0, 0] as [number, number, number],
    endMm: [0, 0, 0] as [number, number, number],
    lengthMm: 10,
  }];
  const runtime = {
    async getState() { return state; },
    async read() { return fragments; },
    async mutate() { mutations += 1; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  assert.deepEqual(await operations.listCurveFragments(), {
    documentToken: state.documentToken,
    revision: state.revision,
    fragments,
  });
  assert.equal(mutations, 0);
});

test("trims explicit native curve fragments", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [], construction: emptyConstruction, bodies: [],
  };
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.trimCurveFragments(["12s34", "13s35"], state.revision);

  assert.deepEqual(call?.bindings, ["TrimFactory"]);
  assert.deepEqual(call?.values, [{ fragmentIds: ["12s34", "13s35"] }]);
  assert.match(call?.source ?? "", /factory\.segments = selected/);
  assert.match(call?.source ?? "", /Stale or unknown curve fragments/);
});

test("rejects duplicate curve fragment references before mutation", async () => {
  let mutations = 0;
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [], construction: emptyConstruction, bodies: [],
  };
  const runtime = {
    async getState() { return state; },
    async mutate() { mutations += 1; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.trimCurveFragments([], state.revision), /at least one/i);
  await assert.rejects(operations.trimCurveFragments(["12s34", "12s34"], state.revision), /unique/i);
  await assert.rejects(operations.trimCurveFragments(["12s34"], "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("lists revision-bound native curve endpoints without mutation", async () => {
  let mutations = 0;
  let readSource = "";
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [], construction: emptyConstruction, bodies: [],
  };
  const endpoints = [{
    id: "10v42", bodyId: 7, bodyVersionId: 10, entityId: 42,
    measurementSource: "native-brep" as const,
    positionMm: [10, 0, 0] as [number, number, number],
  }];
  const runtime = {
    async getState() { return state; }, async read(source: string) { readSource = source; return endpoints; },
    async mutate() { mutations += 1; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  assert.deepEqual(await operations.listCurveEndpoints(), {
    documentToken: state.documentToken,
    revision: state.revision,
    endpoints,
  });
  assert.match(readSource, /model\.IsSpur\(\)/);
  assert.equal(mutations, 0);
});

test("lists every exact native Wire vertex with adjacent segment identities", async () => {
  let readCall: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [], construction: emptyConstruction, bodies: [],
  };
  const vertices = [{
    id: "7:42", bodyId: 7, bodyVersionId: 17, vertexId: 42, viewVersionId: "17v42",
    measurementSource: "native-brep" as const, positionMm: [10, 20, 0] as [number, number, number],
    endpoint: false, adjacentEdgeEntityIds: [98, 99],
  }];
  const runtime = {
    async getState() { return state; },
    async readNative(source: string, bindings: string[], values: unknown[]) { readCall = { source, bindings, values }; return vertices; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  assert.deepEqual(await operations.listCurveVertices(), {
    documentToken: state.documentToken,
    revision: state.revision,
    vertices,
  });
  assert.deepEqual(readCall?.bindings, []);
  assert.match(readCall?.source ?? "", /item\.model\?\.GetEdges/);
  assert.match(readCall?.source ?? "", /edge\.GetVertices/);
  assert.match(readCall?.source ?? "", /vertex\.GetPoint/);
});

test("lists exact native Wire segment directions without mutation", async () => {
  let readCall: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [] };
  const expected = [{ id: 7, versionId: 17, measurementSource: "native-brep", closed: false, segments: [{ entityId: 99, startMm: [0, 0, 0], endMm: [10, 0, 0], startTangent: [1, 0, 0], endTangent: [1, 0, 0], lengthMm: 10 }] }];
  const runtime = { async getState() { return state; }, async readNative(source: string, bindings: string[], values: unknown[]) { readCall = { source, bindings, values }; return expected; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  const result = await operations.listCurveDirections();

  assert.deepEqual(readCall?.bindings, []);
  assert.deepEqual(readCall?.values, []);
  assert.match(readCall?.source ?? "", /GetPointAndTangent\(0\)/);
  assert.match(readCall?.source ?? "", /GetPointAndTangent\(1\)/);
  assert.deepEqual(result, { documentToken: state.documentToken, revision: state.revision, curves: expected });
});

test("lists exact circle basis and trim samples for native circular Wire segments", async () => {
  let readSource = "";
  const circleGeometry = {
    centerMm: [1, 2, 3] as [number, number, number],
    radiusMm: 5,
    normal: [0, 0, 1] as [number, number, number],
    reference: [1, 0, 0] as [number, number, number],
    startMm: [6, 2, 3] as [number, number, number],
    midpointMm: [1, 7, 3] as [number, number, number],
    endMm: [-4, 2, 3] as [number, number, number],
  };
  const curves = [{
    id: 7, versionId: 17, measurementSource: "native-brep" as const, closed: false,
    segments: [{ entityId: 99, curveType: "Circle", startMm: circleGeometry.startMm, endMm: circleGeometry.endMm, startTangent: [0, 1, 0], endTangent: [0, -1, 0], lengthMm: 5 * Math.PI, circleGeometry }],
  }];
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [] };
  const runtime = { async getState() { return state; }, async readNative(source: string) { readSource = source; return curves; } } as unknown as PlasticityRuntime;
  const result = await new PlasticityOperations(runtime).listCurveDirections();

  assert.match(readSource, /edge\.IsCircle\(\)/);
  assert.match(readSource, /basis\.Ref/);
  assert.deepEqual(result.curves[0]?.segments[0]?.circleGeometry, circleGeometry);
});

test("measures a circular Wire segment using its exact current native segment identity", async () => {
  const body = { id: 7, versionId: 17, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body] };
  const circleGeometry = {
    centerMm: [0, 0, 0] as [number, number, number], radiusMm: 2,
    normal: [0, 0, 1] as [number, number, number], reference: [1, 0, 0] as [number, number, number],
    startMm: [2, 0, 0] as [number, number, number], midpointMm: [-2, 0, 0] as [number, number, number], endMm: [2, 0, 0] as [number, number, number],
  };
  const curves = [{ id: 7, versionId: 17, measurementSource: "native-brep" as const, closed: true, segments: [{ entityId: 99, curveType: "Circle", startMm: [2, 0, 0], endMm: [2, 0, 0], startTangent: [0, 1, 0], endTangent: [0, 1, 0], lengthMm: 4 * Math.PI, circleGeometry }] }];
  const runtime = { async getState() { return state; }, async readNative() { return curves; } } as unknown as PlasticityRuntime;
  const result = await new PlasticityOperations(runtime).measurePointToCircularEdge(
    { type: "coordinates", pointMm: [4, 0, 3] }, { bodyId: 7, segmentEntityId: 99 }, state.revision,
  );

  assert.deepEqual(result.edge, { bodyId: 7, segmentEntityId: 99, centerMm: [0, 0, 0], radiusMm: 2, normal: [0, 0, 1], reference: [1, 0, 0], startAngleRadians: 0, sweepRadians: 2 * Math.PI, lengthMm: 4 * Math.PI, fullCircle: true });
  assert.ok(Math.abs(result.finiteArcDistanceMm - Math.sqrt(13)) < 1e-12);
});

test("samples arbitrary curved B-Rep edges natively and reports only an approximate distance", async () => {
  const spline = {
    id: "spline-edge", curveType: "BSpline", line: false, circle: false, lengthMm: 10,
    centerMm: [5, 1.8, 0] as [number, number, number], tangent: [1, 0, 0] as [number, number, number],
    boundsMm: { min: [0, 0, 0] as [number, number, number], max: [10, 3, 0] as [number, number, number] }, faceIds: [], vertexIds: [],
  };
  const body = { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: [], edgeIds: [spline.id], faces: [], edges: [spline] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body] };
  let readSource = "";
  let readValues: unknown;
  const samples = [
    { normalizedParameter: 0, positionMm: [0, 0, 0] as [number, number, number] },
    { normalizedParameter: 0.5, positionMm: [5, 3, 0] as [number, number, number] },
    { normalizedParameter: 1, positionMm: [10, 0, 0] as [number, number, number] },
  ];
  const runtime = {
    async getState() { return state; },
    async readNative(source: string, _bindings: string[], values: unknown[]) {
      readSource = source;
      readValues = values[0];
      return { curveType: "BSpline", lengthMm: 10, isLine: false, isCircle: false, samples, maxObservedChordDeviationMm: 0.005 };
    },
  } as unknown as PlasticityRuntime;

  const result = await new PlasticityOperations(runtime).measurePointToSampledCurveEdge(
    { type: "coordinates", pointMm: [5, 4, 0] }, { bodyId: 7, edgeId: spline.id }, state.revision, 0.01, 128,
  );

  assert.equal(result.exact, false);
  assert.equal(result.estimatedDistanceMm, 1);
  assert.equal(result.toleranceObserved, true);
  assert.equal(result.sampleCount, 3);
  assert.match(readSource, /GetPointAndTangent\(index \/ segmentCount\)/);
  assert.match(readSource, /GetPointAndTangent\(\(index \+ 0\.5\) \/ segmentCount\)/);
  assert.match(readSource, /maxObservedChordDeviationMm <= args\.requestedToleranceMm/);
  assert.deepEqual(readValues, { reference: { kind: "brep-edge", bodyId: 7, edgeId: spline.id }, requestedToleranceMm: 0.01, maxSegments: 128 });
});

test("samples a current non-circular Wire spline by its native segment entity ID", async () => {
  const wire = { id: 9, versionId: 19, type: "Wire", name: "Spline guide", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [wire] };
  let readSource = "";
  let readValues: unknown;
  const samples = [
    { normalizedParameter: 0, positionMm: [0, 0, 0] as [number, number, number] },
    { normalizedParameter: 0.5, positionMm: [5, 3, 0] as [number, number, number] },
    { normalizedParameter: 1, positionMm: [10, 0, 0] as [number, number, number] },
  ];
  const runtime = {
    async getState() { return state; },
    async readNative(source: string, _bindings: string[], values: unknown[]) {
      readSource = source;
      readValues = values[0];
      return { curveType: "BCurve", lengthMm: 11.2, isLine: false, isCircle: false, samples, maxObservedChordDeviationMm: 0.005 };
    },
  } as unknown as PlasticityRuntime;
  const result = await new PlasticityOperations(runtime).measurePointToSampledCurveEdge(
    { type: "coordinates", pointMm: [5, 4, 0] }, { bodyId: 9, segmentEntityId: 501 }, state.revision, 0.01, 128,
  );

  assert.equal(result.exact, false);
  assert.equal(result.estimatedDistanceMm, 1);
  assert.deepEqual(result.edge, { bodyId: 9, segmentEntityId: 501, curveType: "BCurve", lengthMm: 11.2 });
  assert.match(readSource, /item\.view\.segments/);
  assert.match(readSource, /segmentEntityId/);
  assert.deepEqual(readValues, { reference: { kind: "wire-segment", bodyId: 9, segmentEntityId: 501 }, requestedToleranceMm: 0.01, maxSegments: 128 });
});

test("evaluates exact points and tangents at normalized Wire segment parameters", async () => {
  let readCall: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const wire = { id: 7, versionId: 17, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [wire] };
  const samples = [{ reference: { bodyId: 7, segmentEntityId: 99, normalizedParameter: 0.5 }, bodyVersionId: 17, curveType: "BCurve", measurementSource: "native-brep" as const, positionMm: [12, 8, 0], tangent: [1, 0, 0] }];
  const runtime = { async getState() { return state; }, async readNative(source: string, bindings: string[], values: unknown[]) { readCall = { source, bindings, values }; return samples; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  const result = await operations.evaluateCurveSegments([{ bodyId: 7, segmentEntityId: 99, normalizedParameter: 0.5 }], state.revision);

  assert.deepEqual(result, { documentToken: state.documentToken, revision: state.revision, samples });
  assert.deepEqual(readCall?.bindings, []);
  assert.deepEqual(readCall?.values, [{ samples: [{ bodyId: 7, segmentEntityId: 99, normalizedParameter: 0.5 }] }]);
  assert.match(readCall?.source ?? "", /GetPointAndTangent\(reference\.normalizedParameter\)/);
  assert.match(readCall?.source ?? "", /measurementSource: 'native-brep'/);
});

test("rejects invalid curve segment samples before native reads", async () => {
  let reads = 0;
  const solid = { id: 8, versionId: 18, type: "Solid", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [solid] };
  const runtime = { async getState() { return state; }, async readNative() { reads += 1; return []; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.evaluateCurveSegments([], state.revision), /at least one/i);
  await assert.rejects(operations.evaluateCurveSegments([{ bodyId: 8, segmentEntityId: 99, normalizedParameter: 0.5 }], state.revision), /current Wire/i);
  const wireState = { ...state, bodies: [{ ...solid, id: 7, type: "Wire" }] };
  const wireRuntime = { async getState() { return wireState; }, async readNative() { reads += 1; return []; } } as unknown as PlasticityRuntime;
  const wireOperations = new PlasticityOperations(wireRuntime);
  await assert.rejects(wireOperations.evaluateCurveSegments([{ bodyId: 7, segmentEntityId: 0, normalizedParameter: 0.5 }], wireState.revision), /positive integer/i);
  await assert.rejects(wireOperations.evaluateCurveSegments([{ bodyId: 7, segmentEntityId: 99, normalizedParameter: 1.1 }], wireState.revision), /0 to 1/i);
  await assert.rejects(wireOperations.evaluateCurveSegments([
    { bodyId: 7, segmentEntityId: 99, normalizedParameter: 0.5 },
    { bodyId: 7, segmentEntityId: 99, normalizedParameter: 0.5 },
  ], wireState.revision), /unique/i);
  assert.equal(reads, 0);
});

test("inspects compact exact native curve degree, spans, and control-point counts", async () => {
  let readCall: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const wire = { id: 7, versionId: 17, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [wire] };
  const curves = [{
    id: 7,
    versionId: 17,
    measurementSource: "native-brep" as const,
    segments: [
      { entityId: 99, curveType: "BCurve", lengthMm: 42, degree: 5, controlPointCount: 8, spanCount: 3, activeSpanCount: 3, distinctKnotCount: 4, knots: [
        { normalizedParameter: 0, multiplicity: 6, withinSegment: true },
        { normalizedParameter: 0.3, multiplicity: 1, withinSegment: true },
        { normalizedParameter: 0.65, multiplicity: 1, withinSegment: true },
        { normalizedParameter: 1, multiplicity: 6, withinSegment: true },
      ], rational: false, periodic: false, circle: null },
      { entityId: 100, curveType: "Circle", lengthMm: 31.4159265359, degree: null, controlPointCount: null, spanCount: null, activeSpanCount: null, distinctKnotCount: null, knots: null, rational: null, periodic: null, circle: { centerMm: [100, 100, 0], radiusMm: 5, normal: [0, 0, 1] } },
    ],
  }];
  const runtime = {
    async getState() { return state; },
    async readNative(source: string, bindings: string[], values: unknown[]) { readCall = { source, bindings, values }; return curves; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  const result = await operations.inspectCurveStructure([7], state.revision);

  assert.deepEqual(result, { documentToken: state.documentToken, revision: state.revision, curves });
  assert.deepEqual(readCall?.bindings, []);
  assert.deepEqual(readCall?.values, [{ ids: [7] }]);
  assert.match(readCall?.source ?? "", /GetCurve\(\)/);
  assert.match(readCall?.source ?? "", /GetInfo/);
  assert.match(readCall?.source ?? "", /edge\.Normalize\(nativeParameter\)/);
  assert.match(readCall?.source ?? "", /numSpans/);
  assert.match(readCall?.source ?? "", /activeSpanCount/);
  assert.match(readCall?.source ?? "", /info\.basis\.Location/);
  assert.match(readCall?.source ?? "", /mm\(info\.radius\)/);
});

test("counts active B-spline spans inside the normalized segment and ignores periodic extension knots", () => {
  assert.equal(countActiveCurveSpans([0.4634531444636595, 0.6668940159247746, 0.8430536255781333, 0, 0.03404017353322942, 0.2391400413826988, 0.46345314446365937, 0.6668940159247746, 0.8430536255781333, 0, 0.03404017353322941, 0.23914004138269873, 0.46345314446365937]), 6);
  assert.equal(countActiveCurveSpans([0, 0.25, 0.5, 0.75, 1]), 4);
  assert.equal(countActiveCurveSpans([-0.2, 0, 1, 1.2]), 1);
});

test("rejects stale, duplicate, and non-Wire curve structure references before native reads", async () => {
  let reads = 0;
  const solid = { id: 8, versionId: 18, type: "Solid", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [solid] };
  const runtime = { async getState() { return state; }, async readNative() { reads += 1; return []; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.inspectCurveStructure([], state.revision), /at least one/i);
  await assert.rejects(operations.inspectCurveStructure([7, 7], state.revision), /unique/i);
  await assert.rejects(operations.inspectCurveStructure([7], state.revision), /current Wire/i);
  await assert.rejects(operations.inspectCurveStructure([8], state.revision), /current Wire/i);
  await assert.rejects(operations.inspectCurveStructure([8], "old-revision"), /stale reference/i);
  await assert.rejects(operations.inspectCurvePlanarity([], state.revision), /at least one/i);
  await assert.rejects(operations.inspectCurvePlanarity([8, 8], state.revision), /unique/i);
  await assert.rejects(operations.inspectCurvePlanarity([8], state.revision), /current Wire/i);
  await assert.rejects(operations.inspectCurvePlanarity([8], "old-revision"), /stale reference/i);
  assert.equal(reads, 0);
});

test("asks the native kernel for exact Wire planarity", async () => {
  let readCall: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const wire = { id: 7, versionId: 17, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [wire] };
  const curves = [{ id: 7, versionId: 17, measurementSource: "native-brep" as const, planar: true, plane: { originMm: [0, 0, 5], normal: [0, 0, 1] } }];
  const runtime = { async getState() { return state; }, async readNative(source: string, bindings: string[], values: unknown[]) { readCall = { source, bindings, values }; return curves; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  assert.deepEqual(await operations.inspectCurvePlanarity([7], state.revision), { documentToken: state.documentToken, revision: state.revision, curves });
  assert.deepEqual(readCall?.bindings, []);
  assert.deepEqual(readCall?.values, [{ ids: [7] }]);
  assert.match(readCall?.source ?? "", /FindPlanarBasis/);
  assert.match(readCall?.source ?? "", /basis\.Location/);
});

test("lists native Wire boundary vertices and interior control points without mutation", async () => {
  let readCall: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const wire = { id: 7, versionId: 17, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [wire] };
  const curves = [{
    id: 7,
    versionId: 17,
    positionSource: "native-control-handle" as const,
    boundaryVertices: [{ reference: { bodyId: 7, kind: "vertex" as const, pointId: 101 }, versionId: "17v101", positionMm: [0, 0, 0] as [number, number, number], slideDirections: { positiveU: [1, 0, 0] as [number, number, number], negativeU: [-1, 0, 0] as [number, number, number] } }],
    interiorControlPoints: [{ reference: { bodyId: 7, kind: "control-point" as const, pointId: 1 }, versionId: "17c1", positionMm: [10, 20, 0] as [number, number, number], slideDirections: { positiveU: [0, 1, 0] as [number, number, number], negativeU: [0, -1, 0] as [number, number, number] } }],
  }];
  const runtime = {
    async getState() { return state; },
    async readNative(source: string, bindings: string[], values: unknown[]) { readCall = { source, bindings, values }; return curves; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  assert.deepEqual(await operations.listCurveControlPoints([7], state.revision), {
    documentToken: state.documentToken,
    revision: state.revision,
    curves,
  });
  assert.deepEqual(readCall?.bindings, ["MultiSlideControlPointFactory"]);
  assert.deepEqual(readCall?.values, [{ ids: [7] }]);
  assert.match(readCall?.source ?? "", /item\.view\.vertices/);
  assert.match(readCall?.source ?? "", /item\.view\.cvs/);
  assert.match(readCall?.source ?? "", /factory\.orientation\.posU/);
  assert.match(readCall?.source ?? "", /native-control-handle/);
});

test("lists exact revision-bound intersections between user Wire bodies", async () => {
  let mutations = 0;
  let readSource = "";
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [], construction: emptyConstruction, bodies: [],
  };
  const intersections = [{
    id: "10:42@0.01|11:43@0.02",
    bodyIds: [7, 8] as [number, number],
    bodyVersionIds: [10, 11] as [number, number],
    edgeEntityIds: [42, 43] as [number, number],
    measurementSource: "native-brep" as const,
    positionMm: [5, 6, 0] as [number, number, number],
  }];
  const runtime = {
    async getState() { return state; }, async read(source: string) { readSource = source; return intersections; },
    async mutate() { mutations += 1; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  assert.deepEqual(await operations.listCurveIntersections(), {
    documentToken: state.documentToken,
    revision: state.revision,
    intersections,
  });
  assert.match(readSource, /this\.crosses\.crosses/);
  assert.match(readSource, /lookupStableId/);
  assert.equal(mutations, 0);
});

test("extends explicit native curve endpoints by millimeters", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [], construction: emptyConstruction, bodies: [],
  };
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.extendCurveEndpoints(["10v42", "11v43"], 2.5, state.revision);

  assert.deepEqual(call?.bindings, ["MultiExtendVertexFactory"]);
  assert.deepEqual(call?.values, [{ endpointIds: ["10v42", "11v43"], distance: 0.0025 }]);
  assert.match(call?.source ?? "", /factory\.vertices = selected/);
  assert.match(call?.source ?? "", /factory\.distance = args\.distance/);
  assert.match(call?.source ?? "", /model\.IsSpur\(\)/);
});

test("rejects nonpositive and duplicate curve endpoint extensions before mutation", async () => {
  let mutations = 0;
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [], construction: emptyConstruction, bodies: [],
  };
  const runtime = {
    async getState() { return state; }, async mutate() { mutations += 1; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.extendCurveEndpoints(["10v42"], 0, state.revision), /positive/i);
  await assert.rejects(operations.extendCurveEndpoints(["10v42", "10v42"], 2, state.revision), /unique/i);
  await assert.rejects(operations.extendCurveEndpoints(["10v42"], 2, "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("converts exact interior Wire vertices into native control vertices", async () => {
  let mutation: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const wire = { id: 7, versionId: 17, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [], construction: emptyConstruction, bodies: [wire],
  };
  const listed = [
    { id: "7:42", bodyId: 7, bodyVersionId: 17, vertexId: 42, viewVersionId: "17v42", measurementSource: "native-brep" as const, positionMm: [10, 0, 0] as [number, number, number], endpoint: false, adjacentEdgeEntityIds: [98, 99] },
    { id: "7:43", bodyId: 7, bodyVersionId: 17, vertexId: 43, viewVersionId: "17v43", measurementSource: "native-brep" as const, positionMm: [10, 10, 0] as [number, number, number], endpoint: false, adjacentEdgeEntityIds: [99, 100] },
  ];
  const runtime = {
    async getState() { return state; },
    async readNative() { return listed; },
    async mutate(source: string, bindings: string[], values: unknown[]) { mutation = { source, bindings, values }; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const vertices = [{ bodyId: 7, vertexId: 42 }, { bodyId: 7, vertexId: 43 }];

  await operations.convertCurveVerticesToControlPoints(vertices, state.revision);

  assert.deepEqual(mutation?.bindings, ["ConvertVertexFactory", "ConvertCommand"]);
  assert.deepEqual(mutation?.values, [{ vertices }]);
  assert.match(mutation?.source ?? "", /factory\.vertices = selected/);
  assert.match(mutation?.source ?? "", /vertex\.IsSpur\(\)/);
});

test("rejects invalid curve vertices before native control-vertex conversion", async () => {
  let mutations = 0;
  const wire = { id: 7, versionId: 17, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const solid = { id: 8, versionId: 18, type: "Solid", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [], construction: emptyConstruction, bodies: [wire, solid],
  };
  let listed = [{ id: "7:42", bodyId: 7, bodyVersionId: 17, vertexId: 42, viewVersionId: "17v42", measurementSource: "native-brep" as const, positionMm: [0, 0, 0] as [number, number, number], endpoint: true, adjacentEdgeEntityIds: [98] }];
  const runtime = { async getState() { return state; }, async readNative() { return listed; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const reference = { bodyId: 7, vertexId: 42 };

  await assert.rejects(operations.convertCurveVerticesToControlPoints([], state.revision), /at least one/i);
  await assert.rejects(operations.convertCurveVerticesToControlPoints([reference, reference], state.revision), /unique/i);
  await assert.rejects(operations.convertCurveVerticesToControlPoints([{ bodyId: 8, vertexId: 42 }], state.revision), /Wire bodies/i);
  await assert.rejects(operations.convertCurveVerticesToControlPoints([{ bodyId: 7, vertexId: 99 }], state.revision), /stale or unknown/i);
  await assert.rejects(operations.convertCurveVerticesToControlPoints([reference], state.revision), /interior or closed/i);
  listed = [{ ...listed[0]!, endpoint: false, adjacentEdgeEntityIds: [98] }];
  await assert.rejects(operations.convertCurveVerticesToControlPoints([reference], state.revision), /exactly two adjacent/i);
  await assert.rejects(operations.convertCurveVerticesToControlPoints([reference], "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("fillets exact closed Wire vertices with a native radius in metres", async () => {
  let mutation: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [], construction: emptyConstruction, bodies: [],
  };
  const listed = [{
    id: "7:42", bodyId: 7, bodyVersionId: 17, vertexId: 42, viewVersionId: "17v42",
    measurementSource: "native-brep" as const, positionMm: [0, 0, 0] as [number, number, number],
    endpoint: false, adjacentEdgeEntityIds: [98, 99],
  }];
  const runtime = {
    async getState() { return state; },
    async readNative() { return listed; },
    async mutate(source: string, bindings: string[], values: unknown[]) { mutation = { source, bindings, values }; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.filletCurveVertices([{ bodyId: 7, vertexId: 42 }], 3, state.revision);

  assert.deepEqual(mutation?.bindings, ["FilletVertexFactory"]);
  assert.deepEqual(mutation?.values, [{ vertices: [{ bodyId: 7, vertexId: 42 }], radius: 0.003 }]);
  assert.match(mutation?.source ?? "", /FilletVertexCommand/);
  assert.match(mutation?.source ?? "", /factory\.vertices = selected/);
  assert.match(mutation?.source ?? "", /factory\.radius = args\.radius/);
});

test("rejects invalid curve fillet vertices before native mutation", async () => {
  let mutations = 0;
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [], construction: emptyConstruction, bodies: [],
  };
  let listed: Array<Record<string, unknown>> = [];
  const runtime = {
    async getState() { return state; }, async readNative() { return listed; },
    async mutate() { mutations += 1; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const reference = { bodyId: 7, vertexId: 42 };

  await assert.rejects(operations.filletCurveVertices([], 3, state.revision), /at least one/i);
  await assert.rejects(operations.filletCurveVertices([reference, reference], 3, state.revision), /unique/i);
  await assert.rejects(operations.filletCurveVertices([reference], 0, state.revision), /positive/i);
  await assert.rejects(operations.filletCurveVertices([reference], 3, "old-revision"), /stale reference/i);
  await assert.rejects(operations.filletCurveVertices([reference], 3, state.revision), /stale or unknown/i);
  listed = [{ id: "7:42", bodyId: 7, bodyVersionId: 17, vertexId: 42, viewVersionId: "17v42", measurementSource: "native-brep", positionMm: [0, 0, 0], endpoint: true, adjacentEdgeEntityIds: [99] }];
  await assert.rejects(operations.filletCurveVertices([reference], 3, state.revision), /interior or closed/i);
  listed = [{ ...listed[0]!, endpoint: false, adjacentEdgeEntityIds: [98, 99, 100] }];
  await assert.rejects(operations.filletCurveVertices([reference], 3, state.revision), /exactly two/i);
  assert.equal(mutations, 0);
});

test("unjoins compound native Wire bodies into separate curves", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const wire = { id: 7, versionId: 17, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [wire] };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.unjoinCurves([7], state.revision);

  assert.deepEqual(call?.bindings, ["UnjoinCurvesCommand", "UnjoinCurvesFactory"]);
  assert.deepEqual(call?.values, [{ ids: [7] }]);
  assert.match(call?.source ?? "", /factory\.curves = args\.ids\.map\(find\)/);
});

test("rejects invalid native curve unjoin inputs before mutation", async () => {
  let mutations = 0;
  const solid = { id: 8, versionId: 18, type: "Solid", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [solid] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.unjoinCurves([], state.revision), /at least one/i);
  await assert.rejects(operations.unjoinCurves([7, 7], state.revision), /unique/i);
  await assert.rejects(operations.unjoinCurves([7], state.revision), /current Wire/i);
  await assert.rejects(operations.unjoinCurves([8], state.revision), /current Wire/i);
  await assert.rejects(operations.unjoinCurves([7], "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("duplicates native Wire bodies as independent editable curves", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const wires = [7, 8].map((id) => ({ id, versionId: id + 10, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] }));
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: wires };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.duplicateCurves([7, 8], state.revision);

  assert.deepEqual(call?.bindings, ["CurveDuplicateFactory"]);
  assert.deepEqual(call?.values, [{ ids: [7, 8] }]);
  assert.match(call?.source ?? "", /this\.commands\.DuplicateCommand/);
  assert.match(call?.source ?? "", /factory\.curves = args\.ids\.map\(find\)/);
});

test("rejects invalid native curve duplication inputs before mutation", async () => {
  let mutations = 0;
  const solid = { id: 8, versionId: 18, type: "Solid", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [solid] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.duplicateCurves([], state.revision), /at least one/i);
  await assert.rejects(operations.duplicateCurves([7, 7], state.revision), /unique/i);
  await assert.rejects(operations.duplicateCurves([8], state.revision), /current Wire/i);
  await assert.rejects(operations.duplicateCurves([7], "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("creates independent native curves from exact current Regions", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const region = { id: "20r1", entityId: 41, islandVersionId: 20, sketchId: 3, sketchWireIds: [7], measurementSource: "render-mesh" as const, displayBoundsMm: { min: [0, 0, 0] as [number, number, number], max: [20, 10, 0] as [number, number, number] } };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [region], bodies: [] };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.createCurvesFromRegions([region.id], state.revision);

  assert.deepEqual(call?.bindings, ["CreateCurvesFromRegionsFactory"]);
  assert.deepEqual(call?.values, [{ regionIds: [region.id] }]);
  assert.match(call?.source ?? "", /this\.commands\.DuplicateCommand/);
  assert.match(call?.source ?? "", /factory\.regions = regions/);
});

test("rejects stale or ambiguous Region boundary duplication before mutation", async () => {
  let mutations = 0;
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.createCurvesFromRegions([], state.revision), /at least one/i);
  await assert.rejects(operations.createCurvesFromRegions(["20r1", "20r1"], state.revision), /unique/i);
  await assert.rejects(operations.createCurvesFromRegions(["20r1"], state.revision), /stale or unknown Region/i);
  await assert.rejects(operations.createCurvesFromRegions(["20r1"], "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("joins separate native Wire bodies into a compound curve", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const wires = [7, 8].map((id) => ({ id, versionId: id + 10, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] }));
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: wires };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.joinCurves([7, 8], state.revision);

  assert.deepEqual(call?.bindings, ["JoinCurvesCommand", "JoinCurvesFactory"]);
  assert.deepEqual(call?.values, [{ ids: [7, 8] }]);
  assert.match(call?.source ?? "", /factory\.curves = args\.ids\.map\(find\)/);
});

test("rejects invalid native curve join inputs before mutation", async () => {
  let mutations = 0;
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.joinCurves([7], state.revision), /at least two/i);
  await assert.rejects(operations.joinCurves([7, 7], state.revision), /unique/i);
  await assert.rejects(operations.joinCurves([7, 8], state.revision), /current Wire/i);
  await assert.rejects(operations.joinCurves([7, 8], "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("rebuilds native curves by tolerance, control-point count, or degree and spans", async () => {
  const calls: Array<{ source: string; bindings: string[]; values: unknown[] }> = [];
  const wire = { id: 7, versionId: 17, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [wire] };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { calls.push({ source, bindings, values }); return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.rebuildCurves([7], { method: "tolerance", toleranceMm: 0.1 }, state.revision);
  await operations.rebuildCurves([7], { method: "control-points", pointCount: 9, preserveChain: false }, state.revision);
  await operations.rebuildCurves([7], { method: "degree-spans", degree: 5, spans: 3, keepCorners: false }, state.revision);

  assert.deepEqual(calls.map((call) => call.bindings), [["RebuildCurveFactory"], ["RebuildCurveFactory"], ["RebuildCurveFactory"]]);
  assert.deepEqual(calls.map((call) => call.values[0]), [
    { ids: [7], method: 0, parameters: { tolerance: 0.0001 }, preserveParameterization: false, preserveChain: true, keepCorners: true },
    { ids: [7], method: 1, parameters: { pointCount: 9 }, preserveParameterization: false, preserveChain: false, keepCorners: true },
    { ids: [7], method: 2, parameters: { degree: 5, spans: 3 }, preserveParameterization: false, preserveChain: true, keepCorners: false },
  ]);
  assert.match(calls[0]?.source ?? "", /RebuildCurveCommand/);
  assert.match(calls[0]?.source ?? "", /factory\.method = args\.method/);
  assert.match(calls[0]?.source ?? "", /factory\.tolerance = args\.parameters\.tolerance/);
  assert.match(calls[0]?.source ?? "", /factory\.pointCount = args\.parameters\.pointCount/);
  assert.match(calls[0]?.source ?? "", /factory\.degree = args\.parameters\.degree/);
});

test("rejects invalid curve rebuild inputs before mutation", async () => {
  let mutations = 0;
  const solid = { id: 8, versionId: 18, type: "Solid", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [solid] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.rebuildCurves([], { method: "tolerance", toleranceMm: 0.1 }, state.revision), /at least one/i);
  await assert.rejects(operations.rebuildCurves([7, 7], { method: "tolerance", toleranceMm: 0.1 }, state.revision), /unique/i);
  await assert.rejects(operations.rebuildCurves([8], { method: "tolerance", toleranceMm: 0.1 }, state.revision), /current Wire/i);
  await assert.rejects(operations.rebuildCurves([8], { method: "tolerance", toleranceMm: 0.1 }, "old-revision"), /stale reference/i);
  const wireState = { ...state, bodies: [{ ...solid, id: 7, type: "Wire" }] };
  const wireRuntime = { async getState() { return wireState; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const wireOperations = new PlasticityOperations(wireRuntime);
  await assert.rejects(wireOperations.rebuildCurves([7], { method: "tolerance", toleranceMm: 0 }, wireState.revision), /tolerance/i);
  await assert.rejects(wireOperations.rebuildCurves([7], { method: "control-points", pointCount: 3 }, wireState.revision), /control-point count/i);
  await assert.rejects(wireOperations.rebuildCurves([7], { method: "degree-spans", degree: 16, spans: 1 }, wireState.revision), /degree/i);
  await assert.rejects(wireOperations.rebuildCurves([7], { method: "degree-spans", degree: 5, spans: 10_000 }, wireState.revision), /spans/i);
  assert.equal(mutations, 0);
});

test("raises native curve degree and subdivides native curves in one history step each", async () => {
  const calls: Array<{ source: string; bindings: string[]; values: unknown[] }> = [];
  const wire = { id: 7, versionId: 17, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [wire] };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { calls.push({ source, bindings, values }); return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.raiseCurveDegree([7], state.revision);
  await operations.subdivideCurves([7], state.revision);

  assert.deepEqual(calls.map((call) => call.bindings), [
    ["RaiseDegreeCurveFactory", "RaiseDegreeCurveCommand"],
    ["SubdivideCurveFactory", "SubdivideCurveCommand"],
  ]);
  assert.deepEqual(calls.map((call) => call.values), [[{ ids: [7] }], [{ ids: [7] }]]);
  assert.match(calls[0]?.source ?? "", /const command = new Command\(editor\)/);
  assert.match(calls[1]?.source ?? "", /factory\.curves = args\.ids\.map\(find\)/);
});

test("inserts one native B-Spline knot at a normalized segment parameter", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const wire = { id: 7, versionId: 17, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [wire] };
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; },
  } as unknown as PlasticityRuntime;

  await new PlasticityOperations(runtime).insertCurveKnot({ bodyId: 7, segmentEntityId: 99 }, 0.5, state.revision);

  assert.deepEqual(call?.bindings, ["InsertKnotFactory", "InsertKnotCommand"]);
  assert.deepEqual(call?.values, [{ reference: { bodyId: 7, segmentEntityId: 99 }, normalizedParameter: 0.5 }]);
  assert.match(call?.source ?? "", /edge\.Denormalize\(args\.normalizedParameter\)/);
  assert.match(call?.source ?? "", /factory\._segment\.model = new Proxy/);
  assert.match(call?.source ?? "", /target\.InsertKnot\(nativeParameter\)/);
  assert.match(call?.source ?? "", /return await factory\.commit\(\)/);
});

test("rejects invalid native knot insertion inputs before mutation", async () => {
  let mutations = 0;
  const solid = { id: 8, versionId: 18, type: "Solid", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [solid] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.insertCurveKnot({ bodyId: 8, segmentEntityId: 99 }, 0.5, state.revision), /current Wire/i);
  await assert.rejects(operations.insertCurveKnot({ bodyId: 8, segmentEntityId: 99 }, 0.5, "old-revision"), /stale reference/i);
  const wireState = { ...state, bodies: [{ ...solid, id: 7, type: "Wire" }] };
  const wireRuntime = { async getState() { return wireState; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const wireOperations = new PlasticityOperations(wireRuntime);
  for (const parameter of [0, 1, -0.1, 1.1, Number.NaN]) {
    await assert.rejects(wireOperations.insertCurveKnot({ bodyId: 7, segmentEntityId: 99 }, parameter, wireState.revision), /parameter/i);
  }
  await assert.rejects(wireOperations.insertCurveKnot({ bodyId: 7, segmentEntityId: 0 }, 0.5, wireState.revision), /segment entity ID/i);
  assert.equal(mutations, 0);
});

test("splits one nonperiodic native Wire segment at a normalized parameter", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const wire = { id: 7, versionId: 17, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [wire] };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;

  await new PlasticityOperations(runtime).splitCurveSegment({ bodyId: 7, segmentEntityId: 99 }, 0.5, state.revision);

  assert.deepEqual(call?.bindings, ["SplitSegmentFactory", "SplitSegmentCommand"]);
  assert.deepEqual(call?.values, [{ reference: { bodyId: 7, segmentEntityId: 99 }, normalizedParameter: 0.5 }]);
  assert.match(call?.source ?? "", /edge\.IsPeriodic\(\)/);
  assert.match(call?.source ?? "", /factory\._segment\.model = new Proxy/);
  assert.match(call?.source ?? "", /target\.SplitAt\(args\.normalizedParameter\)/);
  assert.doesNotMatch(call?.source ?? "", /Denormalize/);
});

test("rejects invalid native curve segment splits before mutation", async () => {
  let mutations = 0;
  const solid = { id: 8, versionId: 18, type: "Solid", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [solid] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  await assert.rejects(operations.splitCurveSegment({ bodyId: 8, segmentEntityId: 99 }, 0.5, state.revision), /current Wire/i);
  await assert.rejects(operations.splitCurveSegment({ bodyId: 8, segmentEntityId: 99 }, 0.5, "old-revision"), /stale reference/i);
  const wireState = { ...state, bodies: [{ ...solid, id: 7, type: "Wire" }] };
  const wireRuntime = { async getState() { return wireState; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const wireOperations = new PlasticityOperations(wireRuntime);
  await assert.rejects(wireOperations.splitCurveSegment({ bodyId: 7, segmentEntityId: 0 }, 0.5, wireState.revision), /segment entity ID/i);
  for (const parameter of [0, 1, -0.1, 1.1, Number.NaN]) {
    await assert.rejects(wireOperations.splitCurveSegment({ bodyId: 7, segmentEntityId: 99 }, parameter, wireState.revision), /parameter/i);
  }
  assert.equal(mutations, 0);
});

test("rejects invalid degree-elevation and subdivision references before mutation", async () => {
  let mutations = 0;
  const solid = { id: 8, versionId: 18, type: "Solid", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [solid] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  for (const run of [
    () => operations.raiseCurveDegree([], state.revision),
    () => operations.raiseCurveDegree([8], state.revision),
    () => operations.raiseCurveDegree([8], "old-revision"),
    () => operations.subdivideCurves([8, 8], state.revision),
    () => operations.subdivideCurves([8], state.revision),
    () => operations.planarizeCurves([], [0, 0, 0], [0, 0, 1], state.revision),
    () => operations.planarizeCurves([8], [0, 0, 0], [0, 0, 1], state.revision),
  ]) await assert.rejects(run(), /at least one|unique|current Wire|stale reference/i);
  const wireState = { ...state, bodies: [{ ...solid, id: 7, type: "Wire" }] };
  const wireRuntime = { async getState() { return wireState; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  await assert.rejects(new PlasticityOperations(wireRuntime).planarizeCurves([7], [0, 0, 0], [0, 0, 0], wireState.revision), /zero|normalize/i);
  assert.equal(mutations, 0);
});

test("planarizes native Wires onto an explicit normalized world plane", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const wire = { id: 7, versionId: 17, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [wire] };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.planarizeCurves([7], [0, 0, 5], [0, 0, 2], state.revision);

  assert.deepEqual(call?.bindings, ["PlanarizeCurveFactory", "DeformCurveCommand", "Vector3"]);
  assert.deepEqual(call?.values, [{ ids: [7], origin: [0, 0, 0.005], normal: [0, 0, 1] }]);
  assert.match(call?.source ?? "", /factory\.origin\.copy/);
  assert.match(call?.source ?? "", /factory\.normal\.copy/);
});

test("moves mixed native curve boundary vertices and interior control points in one history step", async () => {
  let mutation: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const wire = { id: 7, versionId: 17, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [wire] };
  const inventory = [{
    id: 7,
    versionId: 17,
    positionSource: "native-control-handle" as const,
    boundaryVertices: [{ reference: { bodyId: 7, kind: "vertex" as const, pointId: 101 }, versionId: "17v101", positionMm: [0, 0, 0] as [number, number, number] }],
    interiorControlPoints: [{ reference: { bodyId: 7, kind: "control-point" as const, pointId: 2 }, versionId: "17c2", positionMm: [10, 20, 0] as [number, number, number] }],
  }];
  const runtime = {
    async getState() { return state; },
    async readNative() { return inventory; },
    async mutate(source: string, bindings: string[], values: unknown[]) { mutation = { source, bindings, values }; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const points = [
    { bodyId: 7, kind: "vertex" as const, pointId: 101 },
    { bodyId: 7, kind: "control-point" as const, pointId: 2 },
  ];

  await operations.moveCurveControlPoints(points, [0, 10, 5], state.revision);

  assert.deepEqual(mutation?.bindings, ["MultiMoveControlPointFactory", "MoveControlPointCommand"]);
  assert.deepEqual(mutation?.values, [{ points, delta: [0, 0.01, 0.005] }]);
  assert.match(mutation?.source ?? "", /factory\.vertices = vertices/);
  assert.match(mutation?.source ?? "", /factory\.cvs = cvs/);
  assert.match(mutation?.source ?? "", /factory\.move\.fromArray/);
});

test("slides native curve control points along their local positive or negative U direction", async () => {
  const mutations: Array<{ source: string; bindings: string[]; values: unknown[] }> = [];
  const wire = { id: 7, versionId: 17, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [wire] };
  const inventory = [{ id: 7, versionId: 17, positionSource: "native-control-handle" as const, boundaryVertices: [], interiorControlPoints: [{ reference: { bodyId: 7, kind: "control-point" as const, pointId: 2 }, versionId: "17c2", positionMm: [10, 20, 0] as [number, number, number], slideDirections: { positiveU: [1, 0, 0] as [number, number, number], negativeU: [-1, 0, 0] as [number, number, number] } }] }];
  const runtime = {
    async getState() { return state; },
    async readNative() { return inventory; },
    async mutate(source: string, bindings: string[], values: unknown[]) { mutations.push({ source, bindings, values }); return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const points = [{ bodyId: 7, kind: "control-point" as const, pointId: 2 }];

  await operations.slideCurveControlPoints(points, "positive-u", 5, state.revision);
  await operations.slideCurveControlPoints(points, "negative-u", 2.5, state.revision);

  assert.deepEqual(mutations.map((mutation) => mutation.bindings), [
    ["MultiSlideControlPointFactory", "MoveControlPointCommand"],
    ["MultiSlideControlPointFactory", "MoveControlPointCommand"],
  ]);
  assert.deepEqual(mutations.map((mutation) => mutation.values), [
    [{ points, direction: "posU", distance: 0.005 }],
    [{ points, direction: "negU", distance: 0.0025 }],
  ]);
  assert.match(mutations[0]?.source ?? "", /factory\.direction = args\.direction/);
  assert.match(mutations[0]?.source ?? "", /factory\.distance = args\.distance/);
});

test("rotates and scales native curve control points around explicit world pivots", async () => {
  const mutations: Array<{ source: string; bindings: string[]; values: unknown[] }> = [];
  const wire = { id: 7, versionId: 17, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [wire] };
  const inventory = [{ id: 7, versionId: 17, positionSource: "native-control-handle" as const, boundaryVertices: [], interiorControlPoints: [{ reference: { bodyId: 7, kind: "control-point" as const, pointId: 2 }, versionId: "17c2", positionMm: [10, 20, 0] as [number, number, number] }] }];
  const runtime = {
    async getState() { return state; },
    async readNative() { return inventory; },
    async mutate(source: string, bindings: string[], values: unknown[]) { mutations.push({ source, bindings, values }); return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const points = [{ bodyId: 7, kind: "control-point" as const, pointId: 2 }];

  await operations.rotateCurveControlPoints(points, [10, 20, 0], [0, 0, 2], 90, state.revision);
  await operations.scaleCurveControlPoints(points, [10, 20, 0], [2, 0.5, 1], state.revision);

  assert.deepEqual(mutations[0]?.bindings, ["MultiRotateControlPointFactory", "RotateControlPointCommand", "Vector3", "Quaternion"]);
  assert.deepEqual(mutations[0]?.values, [{ points, pivot: [0.01, 0.02, 0], axis: [0, 0, 1], radians: Math.PI / 2 }]);
  assert.match(mutations[0]?.source ?? "", /factory\.rotation\.copy/);
  assert.deepEqual(mutations[1]?.bindings, ["MultiScaleControlPointFactory", "ScaleControlPointCommand"]);
  assert.deepEqual(mutations[1]?.values, [{ points, pivot: [0.01, 0.02, 0], factors: [2, 0.5, 1] }]);
  assert.match(mutations[1]?.source ?? "", /factory\.scale\.fromArray/);
});

test("deletes current interior B-Spline control points from one Wire", async () => {
  let mutation: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const wire = { id: 7, versionId: 17, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [wire] };
  const inventory = [{ id: 7, versionId: 17, positionSource: "native-control-handle" as const, boundaryVertices: [], interiorControlPoints: [{ reference: { bodyId: 7, kind: "control-point" as const, pointId: 2 }, versionId: "17c2", positionMm: [10, 20, 0] as [number, number, number] }] }];
  const runtime = { async getState() { return state; }, async readNative() { return inventory; }, async mutate(source: string, bindings: string[], values: unknown[]) { mutation = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const points = [{ bodyId: 7, kind: "control-point" as const, pointId: 2 }];

  await operations.deleteCurveControlPoints(points, state.revision);

  assert.deepEqual(mutation?.bindings, ["DeleteControlPointFactory", "DeleteControlPointCommand"]);
  assert.deepEqual(mutation?.values, [{ points }]);
  assert.match(mutation?.source ?? "", /factory\.curve = view/);
  assert.match(mutation?.source ?? "", /factory\.cvs = cvs/);
});

test("rejects stale, duplicate, missing, and zero-delta curve control-point moves before mutation", async () => {
  let mutations = 0;
  const wire = { id: 7, versionId: 17, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [wire] };
  const inventory = [{ id: 7, versionId: 17, positionSource: "native-control-handle" as const, boundaryVertices: [], interiorControlPoints: [{ reference: { bodyId: 7, kind: "control-point" as const, pointId: 2 }, versionId: "17c2", positionMm: [10, 20, 0] as [number, number, number] }] }];
  const runtime = { async getState() { return state; }, async readNative() { return inventory; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const point = { bodyId: 7, kind: "control-point" as const, pointId: 2 };

  await assert.rejects(operations.moveCurveControlPoints([], [1, 0, 0], state.revision), /at least one/i);
  await assert.rejects(operations.moveCurveControlPoints([point, point], [1, 0, 0], state.revision), /unique/i);
  await assert.rejects(operations.moveCurveControlPoints([point], [0, 0, 0], state.revision), /nonzero/i);
  await assert.rejects(operations.moveCurveControlPoints([point], [1, 0, 0], "old-revision"), /stale reference/i);
  await assert.rejects(operations.moveCurveControlPoints([{ ...point, pointId: 99 }], [1, 0, 0], state.revision), /unknown current/i);
  await assert.rejects(operations.slideCurveControlPoints([point], "positive-u", 0, state.revision), /positive/i);
  await assert.rejects(operations.slideCurveControlPoints([point], "sideways" as "positive-u", 1, state.revision), /unsupported/i);
  await assert.rejects(operations.slideCurveControlPoints([point], "positive-u", 1, state.revision), /directions are unavailable/i);
  await assert.rejects(operations.rotateCurveControlPoints([point], [0, 0, 0], [0, 0, 0], 90, state.revision), /zero|normalize/i);
  await assert.rejects(operations.rotateCurveControlPoints([point], [0, 0, 0], [0, 0, 1], 0, state.revision), /nonzero/i);
  await assert.rejects(operations.scaleCurveControlPoints([point], [0, 0, 0], [1, 0, 1], state.revision), /positive/i);
  await assert.rejects(operations.scaleCurveControlPoints([point], [0, 0, 0], [1, 1, 1], state.revision), /change/i);
  await assert.rejects(operations.deleteCurveControlPoints([{ bodyId: 7, kind: "vertex", pointId: 3 }], state.revision), /unknown current|only interior/i);
  assert.equal(mutations, 0);
});

test("reverses native Wire directions in one history step", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const wire = { id: 7, versionId: 17, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [wire] };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.reverseCurves([7], state.revision);

  assert.deepEqual(call?.bindings, ["ReverseCurveCommand", "ReverseCurveFactory"]);
  assert.deepEqual(call?.values, [{ ids: [7] }]);
  assert.match(call?.source ?? "", /factory\.curves = args\.ids\.map\(find\)/);
});

test("reverses native Sheet normals in one history step", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const sheet = { id: 8, versionId: 18, type: "Sheet", name: null, boundsMm: null, faceIds: ["f1"], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [sheet] };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.reverseSheets([8], state.revision);

  assert.deepEqual(call?.bindings, ["ReverseSheetCommand", "ReverseSheetFactory"]);
  assert.deepEqual(call?.values, [{ ids: [8] }]);
  assert.match(call?.source ?? "", /factory\.sheets = args\.ids\.map\(find\)/);
});

test("rejects invalid curve and Sheet reversal references before mutation", async () => {
  let mutations = 0;
  const wire = { id: 7, versionId: 17, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const sheet = { id: 8, versionId: 18, type: "Sheet", name: null, boundsMm: null, faceIds: ["f1"], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [wire, sheet] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.reverseCurves([], state.revision), /at least one/i);
  await assert.rejects(operations.reverseCurves([7, 7], state.revision), /unique/i);
  await assert.rejects(operations.reverseCurves([8], state.revision), /current Wire/i);
  await assert.rejects(operations.reverseSheets([], state.revision), /at least one/i);
  await assert.rejects(operations.reverseSheets([8, 8], state.revision), /unique/i);
  await assert.rejects(operations.reverseSheets([7], state.revision), /current Sheet/i);
  await assert.rejects(operations.reverseSheets([8], "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("projects native Wire bodies onto a target body along an explicit vector", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [], construction: emptyConstruction, bodies: [],
  };
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.projectCurvesOntoBody(7, [11, 12], [0, 0, -5], {
    bidirectional: false,
    occlude: true,
    completion: "face-set",
  }, state.revision);

  assert.deepEqual(call?.bindings, ["ProjectCurveBodyFactory", "Vector3", "ProjectionMethod", "ProjectionCompletionType"]);
  assert.deepEqual(call?.values, [{
    targetId: 7,
    curveIds: [11, 12],
    direction: [0, 0, -1],
    bidirectional: false,
    occlude: true,
    completionName: "FaceSet",
  }]);
  assert.match(call?.source ?? "", /factory\.method = ProjectionMethod\.Vector/);
  assert.match(call?.source ?? "", /ProjectionCompletionType\[args\.completionName\]/);
});

test("rejects invalid native curve projection inputs before mutation", async () => {
  let mutations = 0;
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [], construction: emptyConstruction, bodies: [],
  };
  const runtime = {
    async getState() { return state; }, async mutate() { mutations += 1; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.projectCurvesOntoBody(7, [], [0, 0, -1], {}, state.revision), /at least one/i);
  await assert.rejects(operations.projectCurvesOntoBody(7, [11, 11], [0, 0, -1], {}, state.revision), /unique/i);
  await assert.rejects(operations.projectCurvesOntoBody(7, [7], [0, 0, -1], {}, state.revision), /must not include/i);
  await assert.rejects(operations.projectCurvesOntoBody(7, [11], [0, 0, 0], {}, state.revision), /nonzero/i);
  await assert.rejects(operations.projectCurvesOntoBody(7, [11], [0, 0, -1], {}, "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("creates independent native intersection curves while preserving source bodies", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const target = { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: ["f1"], edgeIds: [], faces: [], edges: [] };
  const tool = { ...target, id: 8, versionId: 18, type: "Sheet" };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [target, tool] };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.createBodyIntersectionCurves(7, [8], state.revision);

  assert.deepEqual(call?.bindings, ["ProjectBodyBodyCommand", "ProjectBodyBodyFactory"]);
  assert.deepEqual(call?.values, [{ targetId: 7, toolIds: [8] }]);
  assert.match(call?.source ?? "", /factory\.target = find\(args\.targetId\)/);
  assert.match(call?.source ?? "", /factory\.tools = args\.toolIds\.map\(find\)/);
});

test("rejects invalid body-intersection curve references before mutation", async () => {
  let mutations = 0;
  const solid = { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: ["f1"], edgeIds: [], faces: [], edges: [] };
  const wire = { ...solid, id: 8, versionId: 18, type: "Wire" };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [solid, wire] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.createBodyIntersectionCurves(7, [], state.revision), /at least one/i);
  await assert.rejects(operations.createBodyIntersectionCurves(7, [7], state.revision), /cannot also be a tool/i);
  await assert.rejects(operations.createBodyIntersectionCurves(7, [8], state.revision), /current Solid or Sheet/i);
  await assert.rejects(operations.createBodyIntersectionCurves(99, [7], state.revision), /target.*Solid or Sheet/i);
  await assert.rejects(operations.createBodyIntersectionCurves(7, [8, 8], state.revision), /unique/i);
  await assert.rejects(operations.createBodyIntersectionCurves(7, [8], "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("projects two native Wire bodies into one independent spatial curve", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const first = { id: 11, versionId: 21, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const second = { ...first, id: 12, versionId: 22 };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [first, second] };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.projectCurvePair(11, [0, 0, 5], 12, [0, -2, 0], 1000, state.revision);

  assert.deepEqual(call?.bindings, ["ProjectCurveCurveCommand", "ProjectCurveCurveFactory", "Vector3"]);
  assert.deepEqual(call?.values, [{ firstId: 11, firstDirection: [0, 0, 1], secondId: 12, secondDirection: [0, -1, 0], projectionDepth: 1 }]);
  assert.match(call?.source ?? "", /factory\.extrude1\.distance2 = -args\.projectionDepth/);
  assert.match(call?.source ?? "", /factory\.extrude2\.direction\.copy/);
});

test("rejects invalid native curve-pair projection inputs before mutation", async () => {
  let mutations = 0;
  const wire = { id: 11, versionId: 21, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const second = { ...wire, id: 12, versionId: 22 };
  const solid = { ...wire, id: 13, versionId: 23, type: "Solid", faceIds: ["f1"] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [wire, second, solid] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.projectCurvePair(11, [0, 0, 1], 11, [0, 1, 0], 10, state.revision), /distinct/i);
  await assert.rejects(operations.projectCurvePair(11, [0, 0, 1], 13, [0, 1, 0], 10, state.revision), /current Wire/i);
  await assert.rejects(operations.projectCurvePair(11, [0, 0, 0], 12, [0, 1, 0], 10, state.revision), /nonzero/i);
  await assert.rejects(operations.projectCurvePair(11, [0, 0, 1], 12, [0, 0, -1], 10, state.revision), /must not be parallel/i);
  await assert.rejects(operations.projectCurvePair(11, [0, 0, 1], 12, [0, 1, 0], 0, state.revision), /depth must be positive/i);
  await assert.rejects(operations.projectCurvePair(11, [0, 0, 1], 12, [0, 1, 0], 10, "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("inserts exact native isoparametric edges into one current surface face", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const face = { id: "f1", surfaceType: "Cylinder", planar: false, centerMm: [0, 0, 5] as [number, number, number], normal: [0, 0, 1] as [number, number, number], radiusMm: 5, blendRadiusMm: null, axisOriginMm: [0, 0, 0] as [number, number, number], axisDirection: [0, 0, 1] as [number, number, number], boundsMm: { min: [-5, -5, 0] as [number, number, number], max: [5, 5, 10] as [number, number, number] }, edgeIds: [] };
  const body = { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: face.boundsMm, faceIds: [face.id], edgeIds: [], faces: [face], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body] };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.insertIsoparamEdges({ bodyId: 7, faceId: "f1" }, "v", 3, state.revision);

  assert.deepEqual(call?.bindings, ["IsoparamFactory"]);
  assert.deepEqual(call?.values, [{ faces: [{ bodyId: 7, faceId: "f1" }], count: 3, uOrV: false }]);
  assert.match(call?.source ?? "", /new this\.commands\.IsoparamCommand/);
  assert.match(call?.source ?? "", /factory\.toggleUV\(\)/);
});

test("rejects stale or invalid isoparametric face inputs before mutation", async () => {
  let mutations = 0;
  const body = { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: ["f1"], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.insertIsoparamEdges({ bodyId: 7, faceId: "missing" }, "u", 1, state.revision), /current Solid or Sheet face/i);
  await assert.rejects(operations.insertIsoparamEdges({ bodyId: 7, faceId: "f1" }, "u", 0, state.revision), /between 1 and 1000/i);
  await assert.rejects(operations.insertIsoparamEdges({ bodyId: 7, faceId: "f1" }, "v", 2, "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("reads compact exact native surface structure for current faces", async () => {
  const face = { id: "f1", surfaceType: "BSurf", planar: false, centerMm: [10, 10, 5] as [number, number, number], normal: [0, 0, 1] as [number, number, number], radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: [0, 0, 0] as [number, number, number], max: [20, 20, 10] as [number, number, number] }, edgeIds: [] };
  const body = { id: 7, versionId: 17, type: "Sheet", name: null, boundsMm: face.boundsMm, faceIds: [face.id], edgeIds: [], faces: [face], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body] };
  const expected = [{
    bodyId: 7, faceId: "f1", bodyVersionId: 17, measurementSource: "native-brep" as const,
    surfaceType: "BSurf", trimmed: true,
    faceParameterBounds: { uMin: -0.01, uMax: 0.01, vMin: -0.005, vMax: 0 },
    naturalParameterBounds: { uMin: -0.01, uMax: 0.01, vMin: -0.005, vMax: 0.012 },
    bSpline: { uDegree: 3, vDegree: 3, uSpanCount: 3, vSpanCount: 2, uControlPointCount: 6, vControlPointCount: 5, rational: false },
  }];
  let readCall: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const runtime = {
    async getState() { return state; },
    async readNative(source: string, bindings: string[], values: unknown[]) { readCall = { source, bindings, values }; return expected; },
  } as unknown as PlasticityRuntime;

  const result = await new PlasticityOperations(runtime).inspectSurfaceStructure([{ bodyId: 7, faceId: "f1" }], state.revision);

  assert.deepEqual(result, { documentToken: state.documentToken, revision: state.revision, surfaces: expected });
  assert.deepEqual(readCall?.bindings, []);
  assert.deepEqual(readCall?.values, [{ faces: [{ bodyId: 7, faceId: "f1" }] }]);
  assert.match(readCall?.source ?? "", /surface\.GetUVBox/);
  assert.match(readCall?.source ?? "", /surface\.GetInfo/);
  assert.match(readCall?.source ?? "", /face\.IsUntrimmed/);
});

test("rejects stale, duplicate, and non-surface references before native surface inspection", async () => {
  let reads = 0;
  const wire = { id: 7, versionId: 17, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const sheet = { ...wire, id: 8, versionId: 18, type: "Sheet", faceIds: ["f1"], faces: [{ id: "f1", surfaceType: "BSurf" }] };
  const state = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [wire, sheet] } as unknown as RuntimeState;
  const runtime = { async getState() { return state; }, async readNative() { reads += 1; return []; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const face = { bodyId: 8, faceId: "f1" };

  await assert.rejects(operations.inspectSurfaceStructure([], state.revision), /at least one face/i);
  await assert.rejects(operations.inspectSurfaceStructure([face, face], state.revision), /face references must be unique/i);
  await assert.rejects(operations.inspectSurfaceStructure([{ bodyId: 7, faceId: "f1" }], state.revision), /unknown current face/i);
  await assert.rejects(operations.inspectSurfaceStructure([{ bodyId: 8, faceId: "missing" }], state.revision), /unknown current face/i);
  await assert.rejects(operations.inspectSurfaceStructure([face], "old-revision"), /stale reference/i);
  assert.equal(reads, 0);
});

test("raises current native B-Surface face degrees in one Plasticity command", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const face = { id: "f1", surfaceType: "BSurf", planar: false, centerMm: [0, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number], radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: [0, 0, 0] as [number, number, number], max: [20, 20, 10] as [number, number, number] }, edgeIds: [] };
  const body = { id: 7, versionId: 17, type: "Sheet", name: null, boundsMm: face.boundsMm, faceIds: [face.id], edgeIds: [], faces: [face], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body] };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const faces = [{ bodyId: 7, faceId: "f1" }];

  await new PlasticityOperations(runtime).raiseSurfaceDegree(faces, state.revision);

  assert.deepEqual(call?.bindings, ["RaiseDegreeFaceFactory", "RaiseDegreeFaceCommand"]);
  assert.deepEqual(call?.values, [{ faces }]);
  assert.match(call?.source ?? "", /factory\.faces = selectedFaces/);
  assert.match(call?.source ?? "", /new Command\(editor\)/);
});

test("untrims current native faces to their natural surface bounds", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const face = { id: "f1", surfaceType: "BSurf", planar: false, centerMm: [0, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number], radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: [0, 0, 0] as [number, number, number], max: [10, 20, 10] as [number, number, number] }, edgeIds: [] };
  const body = { id: 7, versionId: 17, type: "Sheet", name: null, boundsMm: face.boundsMm, faceIds: [face.id], edgeIds: [], faces: [face], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body] };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const faces = [{ bodyId: 7, faceId: "f1" }];

  await new PlasticityOperations(runtime).untrimFaces(faces, state.revision);

  assert.deepEqual(call?.bindings, ["UntrimFactory"]);
  assert.deepEqual(call?.values, [{ faces }]);
  assert.match(call?.source ?? "", /factory\.faces = selectedFaces/);
  assert.match(call?.source ?? "", /factory\.keepEdges = false/);
  assert.match(call?.source ?? "", /new this\.commands\.UntrimCommand/);
});

test("refits one exact native face as a projected-edge B-Surface", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const face = { id: "f1", surfaceType: "Plane", planar: true, centerMm: [10, 5, 5] as [number, number, number], normal: [0, 0, 1] as [number, number, number], radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: [0, 0, 5] as [number, number, number], max: [20, 10, 5] as [number, number, number] }, edgeIds: [] };
  const body = { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: [face.id], edgeIds: [], faces: [face], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body] };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;

  await new PlasticityOperations(runtime).rebuildFace({ bodyId: 7, faceId: "f1" }, 0.01, state.revision);

  assert.deepEqual(call?.bindings, ["RebuildFaceFactory", "RebuildFaceCommand", "RebuildFaceMethod", "ChangeEdgeMethod"]);
  assert.deepEqual(call?.values, [{ face: { bodyId: 7, faceId: "f1" }, tolerance: 0.00001 }]);
  assert.match(call?.source ?? "", /factory\.shell = view/u);
  assert.match(call?.source ?? "", /factory\.face = selectedFace/u);
  assert.match(call?.source ?? "", /factory\.method = RebuildFaceMethod\.Refit/u);
  assert.match(call?.source ?? "", /factory\.changeEdgeMethod = ChangeEdgeMethod\.Project/u);
});

test("rejects invalid native face refits before mutation", async () => {
  let mutations = 0;
  const face = { id: "f1", surfaceType: "Plane", planar: true, centerMm: [10, 5, 5] as [number, number, number], normal: [0, 0, 1] as [number, number, number], radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: [0, 0, 5] as [number, number, number], max: [20, 10, 5] as [number, number, number] }, edgeIds: [] };
  const body = { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: [face.id], edgeIds: [], faces: [face], edges: [] };
  const wire = { ...body, id: 8, type: "Wire", faceIds: ["wf1"], faces: [{ ...face, id: "wf1" }] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body, wire] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.rebuildFace({ bodyId: 7, faceId: "missing" }, 0.01, state.revision), /unknown current face/i);
  await assert.rejects(operations.rebuildFace({ bodyId: 8, faceId: "wf1" }, 0.01, state.revision), /Solid or Sheet/i);
  await assert.rejects(operations.rebuildFace({ bodyId: 7, faceId: "f1" }, 0, state.revision), /tolerance/i);
  await assert.rejects(operations.rebuildFace({ bodyId: 7, faceId: "f1" }, 10.1, state.revision), /tolerance/i);
  await assert.rejects(operations.rebuildFace({ bodyId: 7, faceId: "f1" }, 0.01, "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("matches current native faces to an exact replacement surface", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const plane = { id: "plane", surfaceType: "Plane", planar: true, centerMm: [18, 0, 5] as [number, number, number], normal: [1, 0, 0] as [number, number, number], radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: [18, -5, 0] as [number, number, number], max: [18, 5, 10] as [number, number, number] }, edgeIds: [] };
  const cylinder = { ...plane, id: "cylinder", surfaceType: "Cylinder", planar: false, centerMm: [20, 0, 5] as [number, number, number], radiusMm: 20, axisOriginMm: [0, 0, 0] as [number, number, number], axisDirection: [0, 0, 1] as [number, number, number] };
  const source = { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: [plane.id], edgeIds: [], faces: [plane], edges: [] };
  const target = { id: 8, versionId: 18, type: "Solid", name: null, boundsMm: null, faceIds: [cylinder.id], edgeIds: [], faces: [cylinder], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [source, target] };
  const runtime = { async getState() { return state; }, async mutate(sourceCode: string, bindings: string[], values: unknown[]) { call = { source: sourceCode, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const faces = [{ bodyId: 7, faceId: "plane" }];
  const replacement = { bodyId: 8, faceId: "cylinder" };

  await new PlasticityOperations(runtime).matchFaces(faces, replacement, state.revision);

  assert.deepEqual(call?.bindings, ["MatchFaceFactory", "MatchFaceCommand"]);
  assert.deepEqual(call?.values, [{ faces, replacement }]);
  assert.match(call?.source ?? "", /factory\.shells = sourceShells/u);
  assert.match(call?.source ?? "", /factory\.faces = sourceFaces/u);
  assert.match(call?.source ?? "", /factory\.replacement = replacementFace/u);
});

test("rejects invalid native face matches before mutation", async () => {
  let mutations = 0;
  const face = { id: "f1", surfaceType: "Plane", planar: true, centerMm: [0, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number], radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: [0, 0, 0] as [number, number, number], max: [1, 1, 0] as [number, number, number] }, edgeIds: [] };
  const replacement = { ...face, id: "f2" };
  const source = { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: [face.id], edgeIds: [], faces: [face], edges: [] };
  const target = { id: 8, versionId: 18, type: "Sheet", name: null, boundsMm: null, faceIds: [replacement.id], edgeIds: [], faces: [replacement], edges: [] };
  const wire = { id: 9, versionId: 19, type: "Wire", name: null, boundsMm: null, faceIds: ["wf"], edgeIds: [], faces: [{ ...face, id: "wf" }], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [source, target, wire] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const sourceRef = { bodyId: 7, faceId: "f1" };
  const replacementRef = { bodyId: 8, faceId: "f2" };

  await assert.rejects(operations.matchFaces([], replacementRef, state.revision), /source face/i);
  await assert.rejects(operations.matchFaces([sourceRef, sourceRef], replacementRef, state.revision), /unique/i);
  await assert.rejects(operations.matchFaces([sourceRef], sourceRef, state.revision), /unique/i);
  await assert.rejects(operations.matchFaces([{ bodyId: 7, faceId: "missing" }], replacementRef, state.revision), /unknown current face/i);
  await assert.rejects(operations.matchFaces([{ bodyId: 9, faceId: "wf" }], replacementRef, state.revision), /Solid or Sheet/i);
  await assert.rejects(operations.matchFaces([sourceRef], replacementRef, "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("rejects invalid native surface degree and untrim inputs before mutation", async () => {
  let mutations = 0;
  const plane = { id: "plane", surfaceType: "Plane", planar: true, centerMm: [0, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number], radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: [0, 0, 0] as [number, number, number], max: [10, 10, 0] as [number, number, number] }, edgeIds: [] };
  const spline = { ...plane, id: "spline", surfaceType: "BSurf", planar: false };
  const body = { id: 7, versionId: 17, type: "Sheet", name: null, boundsMm: null, faceIds: [plane.id, spline.id], edgeIds: [], faces: [plane, spline], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const splineRef = { bodyId: 7, faceId: "spline" };

  await assert.rejects(operations.raiseSurfaceDegree([], state.revision), /at least one face/i);
  await assert.rejects(operations.raiseSurfaceDegree([{ bodyId: 7, faceId: "plane" }], state.revision), /B-Surface/i);
  await assert.rejects(operations.raiseSurfaceDegree([splineRef, splineRef], state.revision), /face references must be unique/i);
  await assert.rejects(operations.raiseSurfaceDegree([splineRef], "old-revision"), /stale reference/i);
  await assert.rejects(operations.untrimFaces([], state.revision), /at least one face/i);
  await assert.rejects(operations.untrimFaces([{ bodyId: 7, faceId: "missing" }], state.revision), /unknown current face/i);
  await assert.rejects(operations.untrimFaces([splineRef], "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("creates native body outlines at the source silhouette or explicit workplane", async () => {
  const calls: Array<{ source: string; bindings: string[]; values: unknown[] }> = [];
  const plane = {
    id: "standard:top", nativeId: "Top", name: "Top", source: "standard" as const,
    originMm: [0, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number],
    xDirection: [1, 0, 0] as [number, number, number], yDirection: [0, 1, 0] as [number, number, number],
  };
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [],
    construction: { ...emptyConstruction, planes: [plane], activePlaneId: "standard:front" },
    bodies: [
      { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] },
      { id: 8, versionId: 18, type: "Sheet", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] },
    ],
  };
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) { calls.push({ source, bindings, values }); return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime, "session-a");
  const identity = { id: plane.id, sessionId: "session-a", documentToken: state.documentToken, revision: state.revision };

  await operations.createBodyOutlines([7, 8], identity, "source", state.revision);
  await operations.createBodyOutlines([7], identity, "workplane", state.revision);

  assert.deepEqual(calls.map((call) => call.bindings), [
    ["CreateOutlineFromShellsFactory", "ConstructionPlaneDatabase"],
    ["ProjectOutlineFromShellsFactory", "ConstructionPlaneDatabase"],
  ]);
  assert.deepEqual(calls[0]?.values, [{ ids: [7, 8], plane: { id: plane.id, nativeId: "Top", source: "standard" } }]);
  assert.match(calls[0]?.source ?? "", /viewport\.constructionPlane = selected/);
  assert.match(calls[0]?.source ?? "", /factory\.shells = shells/);
  assert.match(calls[0]?.source ?? "", /GroupSelectedCommand/);
});

test("rejects invalid native body outline inputs before mutation", async () => {
  let mutations = 0;
  const plane = {
    id: "standard:top", nativeId: "Top", name: "Top", source: "standard" as const,
    originMm: [0, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number],
    xDirection: [1, 0, 0] as [number, number, number], yDirection: [0, 1, 0] as [number, number, number],
  };
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [], construction: { ...emptyConstruction, planes: [plane] },
    bodies: [{ id: 7, versionId: 17, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] }],
  };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime, "session-a");
  const identity = { id: plane.id, sessionId: "session-a", documentToken: state.documentToken, revision: state.revision };

  await assert.rejects(operations.createBodyOutlines([], identity, "source", state.revision), /at least one/i);
  await assert.rejects(operations.createBodyOutlines([7, 7], identity, "source", state.revision), /unique/i);
  await assert.rejects(operations.createBodyOutlines([7], identity, "source", state.revision), /Solid or Sheet/i);
  await assert.rejects(operations.createBodyOutlines([99], identity, "source", state.revision), /Solid or Sheet/i);
  await assert.rejects(operations.createBodyOutlines([7], identity, "invalid" as "source", state.revision), /placement/i);
  await assert.rejects(operations.createBodyOutlines([7], identity, "source", "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("patterns native Solid and Sheet bodies along a Wire spine", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [], construction: emptyConstruction,
    bodies: [
      { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] },
      { id: 8, versionId: 18, type: "Sheet", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] },
      { id: 9, versionId: 19, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] },
    ],
  };
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.curvePattern([7, 8], 9, 5, state.revision);

  assert.deepEqual(call?.bindings, ["CurveArrayFactory"]);
  assert.deepEqual(call?.values, [{ ids: [7, 8], spineId: 9, count: 5 }]);
  assert.match(call?.source ?? "", /factory\.items = args\.ids\.map\(find\)/);
  assert.match(call?.source ?? "", /factory\.curve = spine/);
  assert.match(call?.source ?? "", /factory\.num = args\.count/);
  assert.match(call?.source ?? "", /factory\.shouldMakeInstances = false/);
});

test("rejects invalid native curve-pattern inputs before mutation", async () => {
  let mutations = 0;
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [], construction: emptyConstruction,
    bodies: [
      { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] },
      { id: 8, versionId: 18, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] },
    ],
  };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.curvePattern([], 8, 3, state.revision), /at least one/i);
  await assert.rejects(operations.curvePattern([7, 7], 8, 3, state.revision), /unique/i);
  await assert.rejects(operations.curvePattern([8], 8, 3, state.revision), /Solid or Sheet/i);
  await assert.rejects(operations.curvePattern([99], 8, 3, state.revision), /Solid or Sheet/i);
  await assert.rejects(operations.curvePattern([7], 7, 3, state.revision), /Wire spine/i);
  await assert.rejects(operations.curvePattern([7], 99, 3, state.revision), /Wire spine/i);
  await assert.rejects(operations.curvePattern([7], 8, 1, state.revision), /between 2 and 1000/i);
  await assert.rejects(operations.curvePattern([7], 8, 3.5, state.revision), /between 2 and 1000/i);
  await assert.rejects(operations.curvePattern([7], 8, 3, "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("imprints native Wire bodies onto a target body along an explicit vector", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [], construction: emptyConstruction, bodies: [],
  };
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.imprintCurvesOnBody(7, [11], [0, 0, -5], {
    bidirectional: false,
    occlude: true,
    completion: "none",
  }, state.revision);

  assert.deepEqual(call?.bindings, ["ImprintCurveBodyFactory", "Vector3", "ProjectionMethod", "ProjectionCompletionType"]);
  assert.deepEqual(call?.values, [{
    targetId: 7,
    curveIds: [11],
    direction: [0, 0, -1],
    bidirectional: false,
    occlude: true,
    completionName: "None",
  }]);
  assert.match(call?.source ?? "", /ImprintCurveBodyCommand/);
  assert.match(call?.source ?? "", /factory\.method = ProjectionMethod\.Vector/);
});

test("rejects invalid native curve imprint inputs before mutation", async () => {
  let mutations = 0;
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [], construction: emptyConstruction, bodies: [],
  };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.imprintCurvesOnBody(7, [], [0, 0, -1], {}, state.revision), /at least one/i);
  await assert.rejects(operations.imprintCurvesOnBody(7, [11, 11], [0, 0, -1], {}, state.revision), /unique/i);
  await assert.rejects(operations.imprintCurvesOnBody(7, [7], [0, 0, -1], {}, state.revision), /must not include/i);
  await assert.rejects(operations.imprintCurvesOnBody(7, [11], [0, 0, 0], {}, state.revision), /nonzero/i);
  await assert.rejects(operations.imprintCurvesOnBody(7, [11], [0, 0, -1], {}, "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("imprints native body intersections onto a target shell", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const target = { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: ["f1"], edgeIds: [], faces: [], edges: [] };
  const tool = { ...target, id: 8, versionId: 18 };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [target, tool] };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.imprintBodies(7, [8], state.revision);

  assert.deepEqual(call?.bindings, ["ImprintBodyBodyCommand", "ImprintBodyBodyFactory"]);
  assert.deepEqual(call?.values, [{ targetId: 7, toolIds: [8] }]);
  assert.match(call?.source ?? "", /factory\.target = find\(args\.targetId\)/);
  assert.match(call?.source ?? "", /factory\.tools = args\.toolIds\.map\(find\)/);
  assert.match(call?.source ?? "", /factory\.imprintTool = false/);
});

test("rejects invalid native body imprint references before mutation", async () => {
  let mutations = 0;
  const solid = { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: ["f1"], edgeIds: [], faces: [], edges: [] };
  const wire = { ...solid, id: 8, versionId: 18, type: "Wire" };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [solid, wire] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.imprintBodies(7, [], state.revision), /at least one/i);
  await assert.rejects(operations.imprintBodies(7, [7], state.revision), /cannot also be a tool/i);
  await assert.rejects(operations.imprintBodies(7, [8], state.revision), /current Solid or Sheet/i);
  await assert.rejects(operations.imprintBodies(99, [7], state.revision), /target.*Solid or Sheet/i);
  await assert.rejects(operations.imprintBodies(7, [99], state.revision), /current Solid or Sheet/i);
  await assert.rejects(operations.imprintBodies(7, [8, 8], state.revision), /unique/i);
  await assert.rejects(operations.imprintBodies(7, [8], "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("sweeps explicit native Regions along a Wire spine", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction,
    regions: [{ id: "12r34", entityId: 34, islandVersionId: 12, sketchId: 3, sketchWireIds: [7], measurementSource: "render-mesh", displayBoundsMm: { min: [-2, -2, 0], max: [2, 2, 0] } }],
    bodies: [
      { id: 7, versionId: 11, type: "Wire", name: "Profile", boundsMm: { min: [-2, -2, 0], max: [2, 2, 0] }, faceIds: [], edgeIds: [], faces: [], edges: [] },
      { id: 8, versionId: 13, type: "Wire", name: "Spine", boundsMm: { min: [0, 0, 0], max: [0, 0, 20] }, faceIds: [], edgeIds: [], faces: [], edges: [] },
    ],
  };
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.sweepRegions(["12r34"], 8, {
    alignment: "transport", corner: "round", twistDegrees: 45, scale: 1.5, simplify: true,
  }, state.revision);

  assert.deepEqual(call?.bindings, ["SweepFactory", "SweepAlignmentType", "SweepCornerType"]);
  assert.deepEqual(call?.values, [{
    regionIds: ["12r34"], spineId: 8, alignmentName: "Transport", cornerName: "Round",
    twistDegrees: 45, scale: 1.5, simplify: true,
  }]);
  assert.match(call?.source ?? "", /factory\.regions = regions/);
  assert.match(call?.source ?? "", /factory\.spine = spine/);
});

test("rejects invalid or stale Region sweep inputs before mutation", async () => {
  let mutations = 0;
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction,
    regions: [{ id: "12r34", entityId: 34, islandVersionId: 12, sketchId: 3, sketchWireIds: [7], measurementSource: "render-mesh", displayBoundsMm: { min: [-2, -2, 0], max: [2, 2, 0] } }],
    bodies: [
      { id: 7, versionId: 11, type: "Wire", name: "Profile", boundsMm: { min: [-2, -2, 0], max: [2, 2, 0] }, faceIds: [], edgeIds: [], faces: [], edges: [] },
      { id: 8, versionId: 13, type: "Wire", name: "Spine", boundsMm: { min: [0, 0, 0], max: [0, 0, 20] }, faceIds: [], edgeIds: [], faces: [], edges: [] },
    ],
  };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.sweepRegions([], 8, {}, state.revision), /at least one/i);
  await assert.rejects(operations.sweepRegions(["missing"], 8, {}, state.revision), /stale or unknown/i);
  await assert.rejects(operations.sweepRegions(["12r34"], 99, {}, state.revision), /Wire spine/i);
  await assert.rejects(operations.sweepRegions(["12r34"], 7, {}, state.revision), /profile curves/i);
  await assert.rejects(operations.sweepRegions(["12r34"], 8, { scale: 0 }, state.revision), /scale/i);
  await assert.rejects(operations.sweepRegions(["12r34"], 8, {}, "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("lofts ordered native Regions into capped geometry", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction,
    bodies: [{ id: 9, versionId: 14, type: "Wire", name: "Guide", boundsMm: { min: [2, 0, 0], max: [12, 0, 20] }, faceIds: [], edgeIds: [], faces: [], edges: [] }],
    regions: [
      { id: "12r34", entityId: 34, islandVersionId: 12, sketchId: 3, sketchWireIds: [7], measurementSource: "render-mesh", displayBoundsMm: { min: [-5, -5, 0], max: [5, 5, 0] } },
      { id: "13r35", entityId: 35, islandVersionId: 13, sketchId: 4, sketchWireIds: [8], measurementSource: "render-mesh", displayBoundsMm: { min: [-2, -2, 20], max: [2, 2, 20] } },
    ],
  };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.loftRegions(["12r34", "13r35"], { simplify: false, guideIds: [9], trimGuides: false }, state.revision);

  assert.deepEqual(call?.bindings, ["RegionLoftFactory"]);
  assert.deepEqual(call?.values, [{ regionIds: ["12r34", "13r35"], guideIds: [9], trimGuides: false, closed: false, simplify: false }]);
  assert.match(call?.source ?? "", /factory\.regions = args\.regionIds\.map/);
  assert.match(call?.source ?? "", /factory\.guides = args\.guideIds\.map/);
});

test("lofts ordered Wire profiles into an independent native surface", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const wire = (id: number) => ({ id, versionId: id + 10, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] });
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [],
    bodies: [wire(7), wire(8), wire(9)],
  };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.loftCurves([7, 8], {
    guideIds: [9], trimGuides: false, trimProfiles: false, closed: false, simplify: false,
    curvature: "clamped", startMagnitude: 1.5, endMagnitude: 0.75,
  }, state.revision);

  assert.deepEqual(call?.bindings, ["CurveLoftFactory", "LoftEdgeCommand", "LoftCurvatureType"]);
  assert.deepEqual(call?.values, [{
    profileIds: [7, 8], guideIds: [9], trimGuides: false, trimProfiles: false,
    closed: false, simplify: false, curvature: "Clamped", startMagnitude: 1.5, endMagnitude: 0.75,
  }]);
  assert.match(call?.source ?? "", /factory\.profiles = args\.profileIds\.map\(find\)/);
  assert.match(call?.source ?? "", /factory\.guides = args\.guideIds\.map\(find\)/);
  assert.match(call?.source ?? "", /factory\.curvature = Curvature\[args\.curvature\]/);
  assert.match(call?.source ?? "", /factory\.join = false/);
});

test("rejects invalid or stale Wire loft inputs before mutation", async () => {
  let mutations = 0;
  const wire = (id: number) => ({ id, versionId: id + 10, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] });
  const solid = { ...wire(10), type: "Solid" };
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [],
    bodies: [wire(7), wire(8), wire(9), solid],
  };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.loftCurves([7], {}, state.revision), /at least two/i);
  await assert.rejects(operations.loftCurves([7, 7], {}, state.revision), /unique/i);
  await assert.rejects(operations.loftCurves([7, 99], {}, state.revision), /current Wire/i);
  await assert.rejects(operations.loftCurves([7, 10], {}, state.revision), /current Wire/i);
  await assert.rejects(operations.loftCurves([7, 8], { closed: true }, state.revision), /at least three/i);
  await assert.rejects(operations.loftCurves([7, 8], { guideIds: [99] }, state.revision), /current Wire/i);
  await assert.rejects(operations.loftCurves([7, 8], { guideIds: [9, 9] }, state.revision), /unique/i);
  await assert.rejects(operations.loftCurves([7, 8], { guideIds: [8] }, state.revision), /profile Wire/i);
  await assert.rejects(operations.loftCurves([7, 8], { startMagnitude: 0 }, state.revision), /magnitudes/i);
  await assert.rejects(operations.loftCurves([7, 8], {}, "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("rejects invalid or stale Region loft inputs before mutation", async () => {
  let mutations = 0;
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction,
    bodies: [{ id: 7, versionId: 11, type: "Wire", name: "Profile", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] }],
    regions: [
      { id: "12r34", entityId: 34, islandVersionId: 12, sketchId: 3, sketchWireIds: [7], measurementSource: "render-mesh", displayBoundsMm: { min: [-5, -5, 0], max: [5, 5, 0] } },
      { id: "13r35", entityId: 35, islandVersionId: 13, sketchId: 4, sketchWireIds: [8], measurementSource: "render-mesh", displayBoundsMm: { min: [-2, -2, 20], max: [2, 2, 20] } },
      { id: "12r36", entityId: 36, islandVersionId: 12, sketchId: 3, sketchWireIds: [10], measurementSource: "render-mesh", displayBoundsMm: { min: [-1, -1, 0], max: [1, 1, 0] } },
    ],
  };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.loftRegions(["12r34"], {}, state.revision), /at least two/i);
  await assert.rejects(operations.loftRegions(["12r34", "missing"], {}, state.revision), /stale or unknown/i);
  await assert.rejects(operations.loftRegions(["12r34", "12r36"], {}, state.revision), /different sketch/i);
  await assert.rejects(operations.loftRegions(["12r34", "13r35"], { closed: true }, state.revision), /at least three/i);
  await assert.rejects(operations.loftRegions(["12r34", "13r35"], { guideIds: [99] }, state.revision), /current Wire/i);
  await assert.rejects(operations.loftRegions(["12r34", "13r35"], { guideIds: [7, 7] }, state.revision), /unique/i);
  await assert.rejects(operations.loftRegions(["12r34", "13r35"], { guideIds: [7] }, state.revision), /profile Wire/i);
  await assert.rejects(operations.loftRegions(["12r34", "13r35"], {}, "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("lofts ordered planar Solid or Sheet faces into independent native geometry", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const profile = (id: string, z: number) => ({ id, surfaceType: "Plane", planar: true, centerMm: [0, 0, z] as [number, number, number], normal: [0, 0, 1] as [number, number, number], radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: [-5, -5, z] as [number, number, number], max: [5, 5, z] as [number, number, number] }, edgeIds: [] });
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [],
    bodies: [
      { id: 7, versionId: 17, type: "Solid", name: "First", boundsMm: null, faceIds: ["f1"], edgeIds: [], faces: [profile("f1", 0)], edges: [], vertices: [] },
      { id: 8, versionId: 18, type: "Sheet", name: "Second", boundsMm: null, faceIds: ["f2"], edgeIds: [], faces: [profile("f2", 20)], edges: [], vertices: [] },
      { id: 9, versionId: 19, type: "Wire", name: "Guide", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [] },
    ],
  };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const faces = [{ bodyId: 7, faceId: "f1" }, { bodyId: 8, faceId: "f2" }];

  await operations.loftFaces(faces, {
    guideIds: [9], trimGuides: false, simplify: false,
    startCondition: "clamped", endCondition: "natural", startMagnitude: 1.5, endMagnitude: 0.75,
  }, state.revision);

  assert.deepEqual(call?.bindings, ["FaceLoftFactory", "LoftSurfaceCommand", "LoftCurvatureType"]);
  assert.deepEqual(call?.values, [{ faces, guideIds: [9], trimGuides: false, simplify: false, startCondition: "Clamped", endCondition: "Natural", startMagnitude: 1.5, endMagnitude: 0.75 }]);
  assert.match(call?.source ?? "", /factory\.faces = args\.faces\.map\(face\)/);
  assert.match(call?.source ?? "", /factory\.guides = args\.guideIds\.map/);
  assert.match(call?.source ?? "", /factory\.startCurvature = Curvature\[args\.startCondition\]/);
  assert.match(call?.source ?? "", /factory\.startMagnitude = args\.startMagnitude/);
  assert.match(call?.source ?? "", /selection\.selected\.removeAll\(\)/);
});

test("rejects invalid face loft profiles and options before native mutation", async () => {
  let mutations = 0;
  const planar = { id: "f1", surfaceType: "Plane", planar: true, centerMm: [0, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number], radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: [0, 0, 0] as [number, number, number], max: [10, 10, 0] as [number, number, number] }, edgeIds: [] };
  const spline = { ...planar, id: "f2", surfaceType: "BSurface", planar: false };
  const solid = { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: ["f1", "f2"], edgeIds: [], faces: [planar, spline], edges: [], vertices: [] };
  const sheet = { ...solid, id: 8, versionId: 18, type: "Sheet", faceIds: ["f1"], faces: [planar] };
  const wire = { ...solid, id: 9, versionId: 19, type: "Wire", faceIds: ["f1"], faces: [planar] };
  const guide = { ...wire, id: 10, versionId: 20, faceIds: [], faces: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "r1", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [solid, sheet, wire, guide] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const valid = [{ bodyId: 7, faceId: "f1" }, { bodyId: 8, faceId: "f1" }];

  await assert.rejects(operations.loftFaces(valid, {}, "old"), /stale reference/i);
  await assert.rejects(operations.loftFaces([valid[0]!], {}, "r1"), /at least two/i);
  await assert.rejects(operations.loftFaces([valid[0]!, valid[0]!], {}, "r1"), /unique/i);
  await assert.rejects(operations.loftFaces([{ bodyId: 7, faceId: "f1" }, { bodyId: 7, faceId: "f2" }], {}, "r1"), /different source bodies/i);
  await assert.rejects(operations.loftFaces([{ bodyId: 7, faceId: "missing" }, valid[1]!], {}, "r1"), /unknown current face/i);
  await assert.rejects(operations.loftFaces([{ bodyId: 9, faceId: "f1" }, valid[1]!], {}, "r1"), /Solid or Sheet/i);
  await assert.rejects(operations.loftFaces([{ bodyId: 7, faceId: "f2" }, valid[1]!], {}, "r1"), /requires planar/i);
  await assert.rejects(operations.loftFaces(valid, { guideIds: [99] }, "r1"), /current Wire/i);
  await assert.rejects(operations.loftFaces(valid, { guideIds: [10, 10] }, "r1"), /unique/i);
  await assert.rejects(operations.loftFaces(valid, { startMagnitude: 0 }, "r1"), /magnitudes/i);
  assert.equal(mutations, 0);
});

test("patches explicit native Regions into Sheet bodies", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, bodies: [],
    regions: [
      { id: "12r34", entityId: 34, islandVersionId: 12, sketchId: 3, sketchWireIds: [7], measurementSource: "render-mesh", displayBoundsMm: { min: [-5, -5, 0], max: [5, 5, 0] } },
    ],
  };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.patchRegions(["12r34"], state.revision);

  assert.deepEqual(call?.bindings, ["PatchRegionFactory"]);
  assert.deepEqual(call?.values, [{ regionIds: ["12r34"] }]);
  assert.match(call?.source ?? "", /factory\.regions = regions/);
  assert.match(call?.source ?? "", /PatchCommand/);
});

test("bridges two native Sheet faces with a G2 surface", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const sheet = (id: number, versionId: number, faceId: string) => ({
    id,
    versionId,
    type: "Sheet",
    name: null,
    boundsMm: { min: [0, 0, 0] as [number, number, number], max: [10, 10, 0] as [number, number, number] },
    faceIds: [faceId],
    edgeIds: [],
    faces: [{
      id: faceId,
      surfaceType: "Plane",
      planar: true,
      centerMm: [5, 5, 0] as [number, number, number],
      normal: [0, 0, 1] as [number, number, number],
      radiusMm: null,
      blendRadiusMm: null,
      axisOriginMm: null,
      axisDirection: null,
      boundsMm: { min: [0, 0, 0] as [number, number, number], max: [10, 10, 0] as [number, number, number] },
      edgeIds: [],
    }],
    edges: [],
  });
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [],
    bodies: [sheet(12, 20, "20f1"), sheet(13, 21, "21f1")],
  };
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) {
      call = { source, bindings, values };
      return {};
    },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.bridgeSurface(
    { bodyId: 12, faceId: "20f1", pickPointMm: [10, 5, 0] },
    { bodyId: 13, faceId: "21f1", pickPointMm: [20, 5, 5] },
    20,
    1,
    state.revision,
  );

  assert.deepEqual(call?.bindings, ["BridgeSurfaceWithPreviewFactory", "Vector3", "BlendShape", "BlendTrim"]);
  assert.deepEqual(call?.values, [{
    faces: [
      { bodyId: 12, faceId: "20f1" },
      { bodyId: 13, faceId: "21f1" },
    ],
    pickPoints: [[0.01, 0.005, 0], [0.02, 0.005, 0.005]],
    width: 0.02,
    softness: 1,
  }]);
  assert.match(call?.source ?? "", /factory\.shape = BlendShape\.G2/);
  assert.match(call?.source ?? "", /factory\.trimBlend = BlendTrim\.Both/);
  assert.match(call?.source ?? "", /factory\.push\(face\(args\.faces\[0\]\), false/);
});

test("rejects invalid or stale Surface Bridge inputs before mutation", async () => {
  let mutations = 0;
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [],
    bodies: [
      { id: 12, versionId: 20, type: "Sheet", name: null, boundsMm: null, faceIds: ["20f1", "20f2"], edgeIds: [], faces: [], edges: [] },
      { id: 13, versionId: 21, type: "Solid", name: null, boundsMm: null, faceIds: ["21f1"], edgeIds: [], faces: [], edges: [] },
    ],
  };
  const runtime = {
    async getState() { return state; },
    async mutate() { mutations += 1; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const first = { bodyId: 12, faceId: "20f1", pickPointMm: [10, 5, 0] as [number, number, number] };

  await assert.rejects(operations.bridgeSurface(first, { bodyId: 13, faceId: "21f1", pickPointMm: [20, 5, 5] }, 20, 1, state.revision), /Sheet faces/i);
  await assert.rejects(operations.bridgeSurface(first, { bodyId: 12, faceId: "20f2", pickPointMm: [0, 5, 0] }, 20, 1, state.revision), /different Sheet bodies/i);
  await assert.rejects(operations.bridgeSurface(first, { bodyId: 14, faceId: "missing", pickPointMm: [20, 5, 5] }, 20, 1, state.revision), /stale or unknown/i);
  await assert.rejects(operations.bridgeSurface(first, { bodyId: 12, faceId: "20f2", pickPointMm: [0, 5, 0] }, 0, 1, state.revision), /width/i);
  await assert.rejects(operations.bridgeSurface(first, { bodyId: 12, faceId: "20f2", pickPointMm: [0, 5, 0] }, 20, 0, state.revision), /softness/i);
  await assert.rejects(operations.bridgeSurface(first, { bodyId: 12, faceId: "20f2", pickPointMm: [0, 5, 0] }, 20, 1, "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("rejects invalid or stale Region patch inputs before mutation", async () => {
  let mutations = 0;
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, bodies: [],
    regions: [{ id: "12r34", entityId: 34, islandVersionId: 12, sketchId: 3, sketchWireIds: [7], measurementSource: "render-mesh", displayBoundsMm: { min: [-5, -5, 0], max: [5, 5, 0] } }],
  };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.patchRegions([], state.revision), /at least one/i);
  await assert.rejects(operations.patchRegions(["12r34", "12r34"], state.revision), /unique/i);
  await assert.rejects(operations.patchRegions(["missing"], state.revision), /stale or unknown/i);
  await assert.rejects(operations.patchRegions(["12r34"], "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("patches closed spatial Wire bodies into independent native Sheets", async () => {
  let readCall: { source: string; values: unknown[] } | undefined;
  let mutation: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const wires = [7, 8].map((id) => ({ id, versionId: id + 10, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] }));
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: wires };
  const runtime = {
    async getState() { return state; },
    async read(source: string, values: unknown[]) { readCall = { source, values }; return [{ id: 7, closed: true }, { id: 8, closed: true }]; },
    async mutate(source: string, bindings: string[], values: unknown[]) { mutation = { source, bindings, values }; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.patchClosedWires([7, 8], state.revision);

  assert.deepEqual(readCall?.values, [[7, 8]]);
  assert.match(readCall?.source ?? "", /item\.model\?\.IsClosed/);
  assert.deepEqual(mutation?.bindings, ["PatchHoleInWireFactory", "PatchHoleInCurveCommand"]);
  assert.deepEqual(mutation?.values, [{ ids: [7, 8] }]);
  assert.match(mutation?.source ?? "", /factory\.curves = curves/);
  assert.match(mutation?.source ?? "", /!item\.model\?\.IsClosed/);
});

test("rejects stale, open, duplicate, missing, and non-Wire patch boundaries before mutation", async () => {
  let mutations = 0;
  const wire = { id: 7, versionId: 17, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const solid = { ...wire, id: 8, versionId: 18, type: "Solid" };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [wire, solid] };
  const runtime = {
    async getState() { return state; },
    async read() { return [{ id: 7, closed: false }]; },
    async mutate() { mutations += 1; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.patchClosedWires([], state.revision), /nonempty unique/i);
  await assert.rejects(operations.patchClosedWires([7, 7], state.revision), /nonempty unique/i);
  await assert.rejects(operations.patchClosedWires([99], state.revision), /unknown current/i);
  await assert.rejects(operations.patchClosedWires([8], state.revision), /Wire bodies/i);
  await assert.rejects(operations.patchClosedWires([7], state.revision), /requires closed Wire/i);
  await assert.rejects(operations.patchClosedWires([7], "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("joins native Sheet bodies through their coincident edges", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const sheets = [7, 8].map((id) => ({ id, versionId: id + 10, type: "Sheet", name: null, boundsMm: { min: [0, 0, 0] as [number, number, number], max: [10, 10, 0] as [number, number, number] }, faceIds: [], edgeIds: [], faces: [], edges: [] }));
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: sheets };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.joinSheets([7, 8], state.revision);

  assert.deepEqual(call?.bindings, ["JoinSheetsFactory"]);
  assert.deepEqual(call?.values, [{ ids: [7, 8] }]);
  assert.match(call?.source ?? "", /factory\.sheets = args\.ids\.map/);
  assert.match(call?.source ?? "", /JoinSheetsCommand/);
});

test("rejects invalid Sheet joins before mutation", async () => {
  let mutations = 0;
  const sheet = { id: 7, versionId: 17, type: "Sheet", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const solid = { ...sheet, id: 8, versionId: 18, type: "Solid" };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [sheet, solid] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.joinSheets([7], state.revision), /at least two/i);
  await assert.rejects(operations.joinSheets([7, 7], state.revision), /unique/i);
  await assert.rejects(operations.joinSheets([7, 8], state.revision), /current Sheet/i);
  await assert.rejects(operations.joinSheets([7, 99], state.revision), /current Sheet/i);
  await assert.rejects(operations.joinSheets([7, 8], "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("creates a native constrained B-Surface from points and normals", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [] };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.createConstrainedSurface(
    [[0, 0, 0], [10, 0, 0], [10, 10, 2], [0, 10, 0]],
    [[0, 0, 2], [0, 0, 2], [0, 0, 2], [0, 0, 2]],
    { toleranceMm: 0.02, angularToleranceDegrees: 3, optimization: "smoothness" },
    state.revision,
  );

  assert.deepEqual(call?.bindings, ["ConstrainedSurfaceFactory", "Vector3", "ConstrainedSurfaceOptimizationType"]);
  assert.deepEqual(call?.values, [{
    points: [[0, 0, 0], [0.01, 0, 0], [0.01, 0.01, 0.002], [0, 0.01, 0]],
    normals: [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1]],
    tolerance: 0.00002,
    angularToleranceDegrees: 3,
    optimizationName: "Smoothness",
  }]);
  assert.match(call?.source ?? "", /factory\.points = args\.points\.map/);
  assert.match(call?.source ?? "", /factory\.optimize = ConstrainedSurfaceOptimizationType/);
});

test("rejects invalid constrained-surface inputs before mutation", async () => {
  let mutations = 0;
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const points: [number, number, number][] = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]];
  const normals: [number, number, number][] = points.map(() => [0, 0, 1]);

  await assert.rejects(operations.createConstrainedSurface(points.slice(0, 3), normals.slice(0, 3), {}, state.revision), /at least four/i);
  await assert.rejects(operations.createConstrainedSurface(points, normals.slice(0, 3), {}, state.revision), /one normal/i);
  await assert.rejects(operations.createConstrainedSurface(points, [[0, 0, 0], ...normals.slice(1)], {}, state.revision), /normal.*nonzero/i);
  await assert.rejects(operations.createConstrainedSurface(points, normals, { toleranceMm: 0 }, state.revision), /tolerance/i);
  await assert.rejects(operations.createConstrainedSurface(points, normals, {}, "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("extracts exact faces into separate native Sheet bodies", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const face = { id: "17f23", surfaceType: "Plane", planar: true, centerMm: [5, 5, 5] as [number, number, number], normal: [0, 0, 1] as [number, number, number], radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: [0, 0, 5] as [number, number, number], max: [10, 10, 5] as [number, number, number] }, edgeIds: [] };
  const body = { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: [face.id], edgeIds: [], faces: [face], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body] };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.extractFaces([{ bodyId: 7, faceId: face.id }], state.revision);

  assert.deepEqual(call?.bindings, ["CreateSheetFromFacesFactory"]);
  assert.deepEqual(call?.values, [{ faces: [{ bodyId: 7, faceId: face.id }] }]);
  assert.match(call?.source ?? "", /factory\.faces = args\.faces\.map/);
  assert.match(call?.source ?? "", /CreateSolidFromFacesCommand/);
});

test("rejects stale and duplicate face extraction references before mutation", async () => {
  let mutations = 0;
  const face = { id: "17f23", surfaceType: "Plane", planar: true, centerMm: [5, 5, 5] as [number, number, number], normal: [0, 0, 1] as [number, number, number], radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: [0, 0, 5] as [number, number, number], max: [10, 10, 5] as [number, number, number] }, edgeIds: [] };
  const body = { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: [face.id], edgeIds: [], faces: [face], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const ref = { bodyId: 7, faceId: face.id };

  await assert.rejects(operations.extractFaces([], state.revision), /at least one/i);
  await assert.rejects(operations.extractFaces([ref, ref], state.revision), /unique/i);
  await assert.rejects(operations.extractFaces([{ bodyId: 7, faceId: "missing" }], state.revision), /stale or unknown/i);
  await assert.rejects(operations.extractFaces([ref], "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("unwraps one exact analytic developable face into a planar native Sheet", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const face = { id: "cylindrical", surfaceType: "Cylinder", planar: false, centerMm: [0, 0, 15] as [number, number, number], normal: [1, 0, 0] as [number, number, number], radiusMm: 10, blendRadiusMm: null, axisOriginMm: [0, 0, 0] as [number, number, number], axisDirection: [0, 0, 1] as [number, number, number], boundsMm: { min: [-10, -10, 0] as [number, number, number], max: [10, 10, 30] as [number, number, number] }, edgeIds: ["e1", "e2"] };
  const body = { id: 7, versionId: 17, type: "Solid", name: "Cylinder", boundsMm: face.boundsMm, faceIds: [face.id], edgeIds: face.edgeIds, faces: [face], edges: [], vertices: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body] };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.unwrapFace({ bodyId: 7, faceId: face.id }, state.revision);

  assert.deepEqual(call?.bindings, ["UnwrapFactory"]);
  assert.deepEqual(call?.values, [{ face: { bodyId: 7, faceId: face.id } }]);
  assert.match(call?.source ?? "", /new this\.commands\.GroupSelectedCommand/);
  assert.match(call?.source ?? "", /factory\.faces = selectedFaces/);
});

test("derives a conical annular-sector profile from exact full B-Rep circles", async () => {
  const face = {
    id: "cone-face", surfaceType: "Cone", planar: false,
    centerMm: [49, 0, 9] as [number, number, number], normal: [0.9486832980505138, 0, 0.31622776601683794] as [number, number, number],
    radiusMm: null, blendRadiusMm: null, axisOriginMm: [40, 0, 0] as [number, number, number], axisDirection: [0, 0, -1] as [number, number, number],
    coneBasisRadiusMm: 12, coneSemiAngleRad: Math.atan(1 / 3),
    boundsMm: { min: [28, -12, 0] as [number, number, number], max: [52, 12, 18] as [number, number, number] }, edgeIds: ["bottom", "top", "seam"],
  };
  const body: RuntimeState["bodies"][number] = {
    id: 8, versionId: 16, type: "Solid", name: "Frustum", boundsMm: face.boundsMm, faceIds: [face.id], edgeIds: face.edgeIds, faces: [face],
    edges: [
      { id: "bottom", curveType: "Circle", line: false, circle: true, lengthMm: 75.39822368615503, centerMm: [52, 0, 0], tangent: [0, 1, 0], boundsMm: { min: [28, -12, 0], max: [52, 12, 0] }, faceIds: [face.id], vertexIds: [11] },
      { id: "top", curveType: "Circle", line: false, circle: true, lengthMm: 37.69911184307752, centerMm: [46, 0, 18], tangent: [0, 1, 0], boundsMm: { min: [34, -6, 18], max: [46, 6, 18] }, faceIds: [face.id], vertexIds: [12] },
      { id: "seam", curveType: "Line", line: true, circle: false, lengthMm: 18.973665961010276, centerMm: [46, 0, 9], tangent: [0, 0, 1], boundsMm: { min: [46, 0, 0], max: [52, 0, 18] }, faceIds: [face.id], vertexIds: [11, 12] },
    ], vertices: [],
  };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body] };
  const runtime = { async getState() { return state; } } as unknown as PlasticityRuntime;

  const result = await new PlasticityOperations(runtime).analyzeConeDevelopment({ bodyId: body.id, faceId: face.id }, state.revision);

  assert.equal(result.measurementSource, "native-brep");
  assert.deepEqual(result.boundaryRadiusMm, [6, 12]);
  assert.equal(result.development.axialHeightMm, 18);
  assert.ok(Math.abs(result.development.innerRadiusMm - 18.973665961010276) < 1e-9);
  assert.ok(Math.abs(result.development.outerRadiusMm - 37.94733192202055) < 1e-9);
  assert.ok(Math.abs(result.development.includedAngleRad - 1.98691765315922) < 1e-9);
});

test("rejects stale, missing, and nondevelopable face unwraps before mutation", async () => {
  let mutations = 0;
  const plane = { id: "plane", surfaceType: "Plane", planar: true, centerMm: [0, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number], radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: [0, 0, 0] as [number, number, number], max: [1, 1, 0] as [number, number, number] }, edgeIds: [] };
  const spline = { ...plane, id: "spline", surfaceType: "BSurf", planar: false };
  const cone = { ...plane, id: "cone", surfaceType: "Cone", planar: false };
  const body = { id: 7, versionId: 17, type: "Sheet", name: null, boundsMm: null, faceIds: [plane.id, spline.id, cone.id], edgeIds: [], faces: [plane, spline, cone], edges: [], vertices: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.unwrapFace({ bodyId: 7, faceId: "missing" }, state.revision), /unknown current face/i);
  await assert.rejects(operations.unwrapFace({ bodyId: 7, faceId: plane.id }, state.revision), /Cylinder face/i);
  await assert.rejects(operations.unwrapFace({ bodyId: 7, faceId: spline.id }, state.revision), /Cylinder face/i);
  await assert.rejects(operations.unwrapFace({ bodyId: 7, faceId: cone.id }, state.revision), /Cylinder face/i);
  await assert.rejects(operations.unwrapFace({ bodyId: 7, faceId: plane.id }, "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("creates preserved native body copies deformed between exact faces", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const plane = (id: string, z: number) => ({
    id, surfaceType: "Plane", planar: true,
    centerMm: [0, 0, z] as [number, number, number], normal: [0, 0, 1] as [number, number, number],
    radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null,
    boundsMm: { min: [-10, -10, z] as [number, number, number], max: [10, 10, z] as [number, number, number] },
    edgeIds: [],
  });
  const cylinder = {
    ...plane("target-face", 15), surfaceType: "Cylinder", planar: false, radiusMm: 10,
    axisOriginMm: [0, 0, 0] as [number, number, number], axisDirection: [0, 0, 1] as [number, number, number],
  };
  const deformFace = plane("deform-face", 0);
  const sourceFace = plane("source-face", 0);
  const body = { id: 7, versionId: 17, type: "Solid", name: "mark", boundsMm: null, faceIds: [deformFace.id], edgeIds: [], faces: [deformFace], edges: [] };
  const source = { id: 8, versionId: 18, type: "Sheet", name: "development", boundsMm: null, faceIds: [sourceFace.id], edgeIds: [], faces: [sourceFace], edges: [] };
  const target = { id: 9, versionId: 19, type: "Solid", name: "cylinder", boundsMm: null, faceIds: [cylinder.id], edgeIds: [], faces: [cylinder], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body, source, target] };
  const runtime = { async getState() { return state; }, async mutate(sourceCode: string, bindings: string[], values: unknown[]) { call = { source: sourceCode, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const options = { scaleU: 1.5, scaleV: 0.75, scaleNormal: 2, flipUV: true, flipNormal: false, mirror: true };

  await operations.deformBodiesBetweenFaces(
    [7],
    { bodyId: 8, faceId: sourceFace.id },
    { bodyId: 9, faceId: cylinder.id },
    options,
    state.revision,
  );

  assert.deepEqual(call?.bindings, ["DeformFaceFactory", "DeformFaceCommand"]);
  assert.deepEqual(call?.values, [{
    ids: [7], sourceFace: { bodyId: 8, faceId: sourceFace.id }, targetFace: { bodyId: 9, faceId: cylinder.id }, options,
  }]);
  assert.match(call?.source ?? "", /factory\.faces = args\.ids\.flatMap/);
  assert.match(call?.source ?? "", /factory\.keepTools = true/);
  assert.match(call?.source ?? "", /factory\.offsetU = 0/);
  assert.match(call?.source ?? "", /factory\.flipNormal = args\.options\.flipNormal/);
});

test("rejects unsafe or stale native face-deformation inputs before mutation", async () => {
  let mutations = 0;
  const face = (id: string) => ({ id, surfaceType: "Plane", planar: true, centerMm: [0, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number], radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: [0, 0, 0] as [number, number, number], max: [1, 1, 0] as [number, number, number] }, edgeIds: [] });
  const deformFace = face("deform");
  const sourceFace = face("source");
  const targetFace = face("target");
  const body = { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: [deformFace.id], edgeIds: [], faces: [deformFace], edges: [] };
  const source = { id: 8, versionId: 18, type: "Sheet", name: null, boundsMm: null, faceIds: [sourceFace.id], edgeIds: [], faces: [sourceFace], edges: [] };
  const target = { id: 9, versionId: 19, type: "Solid", name: null, boundsMm: null, faceIds: [targetFace.id], edgeIds: [], faces: [targetFace], edges: [] };
  const wire = { id: 10, versionId: 20, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body, source, target, wire] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const sourceRef = { bodyId: 8, faceId: sourceFace.id };
  const targetRef = { bodyId: 9, faceId: targetFace.id };
  const valid = { scaleU: 1, scaleV: 1, scaleNormal: 1, flipUV: false, flipNormal: false, mirror: false };

  await assert.rejects(operations.deformBodiesBetweenFaces([], sourceRef, targetRef, valid, state.revision), /nonempty unique/i);
  await assert.rejects(operations.deformBodiesBetweenFaces([7, 7], sourceRef, targetRef, valid, state.revision), /nonempty unique/i);
  await assert.rejects(operations.deformBodiesBetweenFaces([99], sourceRef, targetRef, valid, state.revision), /unknown current/i);
  await assert.rejects(operations.deformBodiesBetweenFaces([10], sourceRef, targetRef, valid, state.revision), /Solid or Sheet/i);
  await assert.rejects(operations.deformBodiesBetweenFaces([7], { bodyId: 8, faceId: "missing" }, targetRef, valid, state.revision), /unknown current face/i);
  await assert.rejects(operations.deformBodiesBetweenFaces([7], sourceRef, sourceRef, valid, state.revision), /must be different/i);
  await assert.rejects(operations.deformBodiesBetweenFaces([8], sourceRef, targetRef, valid, state.revision), /must be separate/i);
  await assert.rejects(operations.deformBodiesBetweenFaces([7], sourceRef, targetRef, { ...valid, scaleU: 0 }, state.revision), /scaleU must be positive/i);
  await assert.rejects(operations.deformBodiesBetweenFaces([7], sourceRef, targetRef, { ...valid, scaleNormal: 1001 }, state.revision), /scaleNormal must be positive/i);
  await assert.rejects(operations.deformBodiesBetweenFaces([7], sourceRef, targetRef, valid, "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("creates preserved native curve copies deformed between exact faces", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const face = (id: string, type: "Plane" | "Cylinder") => ({
    id, surfaceType: type, planar: type === "Plane",
    centerMm: [0, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number],
    radiusMm: type === "Cylinder" ? 10 : null, blendRadiusMm: null,
    axisOriginMm: type === "Cylinder" ? [0, 0, 0] as [number, number, number] : null,
    axisDirection: type === "Cylinder" ? [0, 0, 1] as [number, number, number] : null,
    boundsMm: { min: [-10, -10, 0] as [number, number, number], max: [10, 10, 20] as [number, number, number] },
    edgeIds: [],
  });
  const sourceFace = face("source-face", "Plane");
  const targetFace = face("target-face", "Cylinder");
  const wire = { id: 7, versionId: 17, type: "Wire", name: "mark", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const source = { id: 8, versionId: 18, type: "Sheet", name: "development", boundsMm: null, faceIds: [sourceFace.id], edgeIds: [], faces: [sourceFace], edges: [] };
  const target = { id: 9, versionId: 19, type: "Solid", name: "cylinder", boundsMm: null, faceIds: [targetFace.id], edgeIds: [], faces: [targetFace], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [wire, source, target] };
  const runtime = { async getState() { return state; }, async mutate(sourceCode: string, bindings: string[], values: unknown[]) { call = { source: sourceCode, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const options = { scaleU: 1.5, scaleV: 0.75, scaleNormal: 2, flipUV: true, flipNormal: false, mirror: true };

  await operations.deformCurvesBetweenFaces(
    [7],
    { bodyId: 8, faceId: sourceFace.id },
    { bodyId: 9, faceId: targetFace.id },
    options,
    state.revision,
  );

  assert.deepEqual(call?.bindings, ["DeformCurveFactory", "DeformCurveCommand"]);
  assert.deepEqual(call?.values, [{
    ids: [7], sourceFace: { bodyId: 8, faceId: sourceFace.id }, targetFace: { bodyId: 9, faceId: targetFace.id }, options,
  }]);
  assert.match(call?.source ?? "", /factory\.curves = args\.ids\.map/);
  assert.match(call?.source ?? "", /factory\.keepTools = true/);
  assert.match(call?.source ?? "", /factory\.offsetU = 0/);
  assert.match(call?.source ?? "", /factory\.mirror = args\.options\.mirror/);
});

test("rejects unsafe or stale native curve-deformation inputs before mutation", async () => {
  let mutations = 0;
  const face = (id: string) => ({ id, surfaceType: "Plane", planar: true, centerMm: [0, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number], radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: [0, 0, 0] as [number, number, number], max: [1, 1, 0] as [number, number, number] }, edgeIds: [] });
  const sourceFace = face("source");
  const targetFace = face("target");
  const wire = { id: 7, versionId: 17, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const source = { id: 8, versionId: 18, type: "Sheet", name: null, boundsMm: null, faceIds: [sourceFace.id], edgeIds: [], faces: [sourceFace], edges: [] };
  const target = { id: 9, versionId: 19, type: "Solid", name: null, boundsMm: null, faceIds: [targetFace.id], edgeIds: [], faces: [targetFace], edges: [] };
  const solid = { id: 10, versionId: 20, type: "Solid", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [wire, source, target, solid] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const sourceRef = { bodyId: 8, faceId: sourceFace.id };
  const targetRef = { bodyId: 9, faceId: targetFace.id };
  const valid = { scaleU: 1, scaleV: 1, scaleNormal: 1, flipUV: false, flipNormal: false, mirror: false };

  await assert.rejects(operations.deformCurvesBetweenFaces([], sourceRef, targetRef, valid, state.revision), /nonempty unique/i);
  await assert.rejects(operations.deformCurvesBetweenFaces([7, 7], sourceRef, targetRef, valid, state.revision), /nonempty unique/i);
  await assert.rejects(operations.deformCurvesBetweenFaces([99], sourceRef, targetRef, valid, state.revision), /unknown current/i);
  await assert.rejects(operations.deformCurvesBetweenFaces([10], sourceRef, targetRef, valid, state.revision), /Wire bodies/i);
  await assert.rejects(operations.deformCurvesBetweenFaces([7], { bodyId: 8, faceId: "missing" }, targetRef, valid, state.revision), /unknown current face/i);
  await assert.rejects(operations.deformCurvesBetweenFaces([7], sourceRef, sourceRef, valid, state.revision), /must be different/i);
  await assert.rejects(operations.deformCurvesBetweenFaces([8], sourceRef, targetRef, valid, state.revision), /must be separate|Wire bodies/i);
  await assert.rejects(operations.deformCurvesBetweenFaces([7], sourceRef, targetRef, { ...valid, scaleV: 0 }, state.revision), /scaleV must be positive/i);
  await assert.rejects(operations.deformCurvesBetweenFaces([7], sourceRef, targetRef, { ...valid, scaleNormal: 1001 }, state.revision), /scaleNormal must be positive/i);
  await assert.rejects(operations.deformCurvesBetweenFaces([7], sourceRef, targetRef, valid, "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("extracts exact native body edges into Wire curves", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const edges = ["e1", "e2"].map((id) => ({ id, curveType: "Line", line: true, circle: false, lengthMm: 10, centerMm: [0, 0, 0] as [number, number, number], tangent: [1, 0, 0] as [number, number, number], boundsMm: { min: [0, 0, 0] as [number, number, number], max: [10, 0, 0] as [number, number, number] }, faceIds: ["f1"], vertexIds: [] }));
  const body = { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: ["f1"], edgeIds: edges.map((edge) => edge.id), faces: [], edges };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body] };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.extractEdges([{ bodyId: 7, edgeId: "e1" }, { bodyId: 7, edgeId: "e2" }], state.revision);

  assert.deepEqual(call?.bindings, ["CreateCurveFromEdgesFactory"]);
  assert.deepEqual(call?.values, [{ edges: [{ bodyId: 7, edgeId: "e1" }, { bodyId: 7, edgeId: "e2" }] }]);
  assert.match(call?.source ?? "", /DuplicateEdgeAndProjectCommand/);
  assert.match(call?.source ?? "", /factory\.edges = args\.edges\.map/);
});

test("rejects stale, duplicate, and missing edge extraction references before mutation", async () => {
  let mutations = 0;
  const edge = { id: "e1", curveType: "Line", line: true, circle: false, lengthMm: 10, centerMm: [0, 0, 0] as [number, number, number], tangent: [1, 0, 0] as [number, number, number], boundsMm: { min: [0, 0, 0] as [number, number, number], max: [10, 0, 0] as [number, number, number] }, faceIds: ["f1"], vertexIds: [] };
  const body = { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: ["f1"], edgeIds: [edge.id], faces: [], edges: [edge] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const reference = { bodyId: 7, edgeId: edge.id };

  await assert.rejects(operations.extractEdges([], state.revision), /at least one/i);
  await assert.rejects(operations.extractEdges([reference, reference], state.revision), /unique/i);
  await assert.rejects(operations.extractEdges([{ bodyId: 7, edgeId: "missing" }], state.revision), /stale or unknown/i);
  await assert.rejects(operations.extractEdges([reference], "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("unjoins exact faces from native Sheet shells", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const face = { id: "f1", surfaceType: "Plane", planar: true, centerMm: [5, 5, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number], radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: [0, 0, 0] as [number, number, number], max: [10, 10, 0] as [number, number, number] }, edgeIds: [] };
  const sheet = { id: 7, versionId: 17, type: "Sheet", name: null, boundsMm: null, faceIds: [face.id], edgeIds: [], faces: [face], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [sheet] };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.unjoinFaces([{ bodyId: 7, faceId: "f1" }], state.revision);

  assert.deepEqual(call?.bindings, ["UnjoinFacesFactory"]);
  assert.deepEqual(call?.values, [{ faces: [{ bodyId: 7, faceId: "f1" }] }]);
  assert.match(call?.source ?? "", /UnjoinFacesCommand/);
  assert.match(call?.source ?? "", /factory\.faces = args\.faces\.map/);
});

test("rejects stale and duplicate face unjoin references before mutation", async () => {
  let mutations = 0;
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const ref = { bodyId: 7, faceId: "f1" };

  await assert.rejects(operations.unjoinFaces([], state.revision), /at least one/i);
  await assert.rejects(operations.unjoinFaces([ref, ref], state.revision), /unique/i);
  await assert.rejects(operations.unjoinFaces([ref], state.revision), /stale or unknown/i);
  await assert.rejects(operations.unjoinFaces([ref], "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("unjoins complete native Solid and Sheet shells into independent faces", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const solid = { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: ["f1", "f2"], edgeIds: [], faces: [], edges: [] };
  const sheet = { id: 8, versionId: 18, type: "Sheet", name: null, boundsMm: null, faceIds: ["f3", "f4"], edgeIds: [], faces: [], edges: [] };
  const wire = { id: 9, versionId: 19, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [solid, sheet, wire] };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.unjoinShells([7, 8], state.revision);

  assert.deepEqual(call?.bindings, ["UnjoinShellsFactory"]);
  assert.deepEqual(call?.values, [{ ids: [7, 8] }]);
  assert.match(call?.source ?? "", /UnjoinShellsCommand/);
  assert.match(call?.source ?? "", /factory\.shells = args\.ids\.map\(find\)/);
});

test("rejects stale, duplicate, missing, and Wire shell-unjoin inputs before mutation", async () => {
  let mutations = 0;
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [],
    bodies: [
      { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] },
      { id: 8, versionId: 18, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] },
      { id: 9, versionId: 19, type: "Sheet", name: null, boundsMm: null, faceIds: ["f1"], edgeIds: [], faces: [], edges: [] },
    ],
  };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.unjoinShells([], state.revision), /nonempty unique list/i);
  await assert.rejects(operations.unjoinShells([7, 7], state.revision), /nonempty unique list/i);
  await assert.rejects(operations.unjoinShells([99], state.revision), /unknown current body/i);
  await assert.rejects(operations.unjoinShells([8], state.revision), /Solid or Sheet/i);
  await assert.rejects(operations.unjoinShells([9], state.revision), /at least two faces/i);
  await assert.rejects(operations.unjoinShells([7], "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("creates a native Solid from a closed Sheet shell", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const sheet = { id: 7, versionId: 17, type: "Sheet", name: null, boundsMm: null, faceIds: ["f1", "f2"], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [sheet] };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.createSolidFromSheet(7, state.revision);

  assert.deepEqual(call?.bindings, ["CreateSolidFromFacesFactory"]);
  assert.deepEqual(call?.values, [{ id: 7 }]);
  assert.match(call?.source ?? "", /factory\.shell = view/);
  assert.match(call?.source ?? "", /factory\.faces = Array\.from/);
});

test("rejects non-Sheet solidification inputs before mutation", async () => {
  let mutations = 0;
  const solid = { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [solid] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.createSolidFromSheet(7, state.revision), /current Sheet/i);
  await assert.rejects(operations.createSolidFromSheet(99, state.revision), /current Sheet/i);
  await assert.rejects(operations.createSolidFromSheet(7, "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("deletes exact faces through Plasticity's native face command", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const face = { id: "17f23", surfaceType: "Plane", planar: true, centerMm: [5, 5, 5] as [number, number, number], normal: [0, 0, 1] as [number, number, number], radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: [0, 0, 5] as [number, number, number], max: [10, 10, 5] as [number, number, number] }, edgeIds: [] };
  const body = { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: [face.id], edgeIds: [], faces: [face], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body] };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.deleteFaces([{ bodyId: 7, faceId: face.id }], state.revision);

  assert.deepEqual(call?.bindings, ["DeleteFaceCommand", "DeleteFaceFactory"]);
  assert.deepEqual(call?.values, [{ faces: [{ bodyId: 7, faceId: face.id }] }]);
  assert.match(call?.source ?? "", /new Command\(this\)/);
  assert.match(call?.source ?? "", /factory\.faces = args\.faces\.map/);
});

test("rejects stale and duplicate face deletion references before mutation", async () => {
  let mutations = 0;
  const face = { id: "17f23", surfaceType: "Plane", planar: true, centerMm: [5, 5, 5] as [number, number, number], normal: [0, 0, 1] as [number, number, number], radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: [0, 0, 5] as [number, number, number], max: [10, 10, 5] as [number, number, number] }, edgeIds: [] };
  const body = { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: [face.id], edgeIds: [], faces: [face], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [body] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const ref = { bodyId: 7, faceId: face.id };

  await assert.rejects(operations.deleteFaces([], state.revision), /at least one/i);
  await assert.rejects(operations.deleteFaces([ref, ref], state.revision), /unique/i);
  await assert.rejects(operations.deleteFaces([{ bodyId: 7, faceId: "missing" }], state.revision), /stale or unknown/i);
  await assert.rejects(operations.deleteFaces([ref], "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("inserts one native fill Sheet into target boundary edges", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const boundaryEdges = ["e1", "e2", "e3", "e4"].map((id) => ({
    id, curveType: "Line", line: true, circle: false, lengthMm: 10,
    centerMm: [0, 0, 5] as [number, number, number], tangent: [1, 0, 0] as [number, number, number],
    boundsMm: { min: [0, 0, 5] as [number, number, number], max: [10, 0, 5] as [number, number, number] },
    faceIds: ["f1"], vertexIds: [],
  }));
  const target = { id: 7, versionId: 17, type: "Sheet", name: "open shell", boundsMm: null, faceIds: ["f1"], edgeIds: boundaryEdges.map((edge) => edge.id), faces: [], edges: boundaryEdges };
  const fill = { id: 8, versionId: 18, type: "Sheet", name: "fill", boundsMm: null, faceIds: ["f2"], edgeIds: ["e5", "e6", "e7", "e8"], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [target, fill] };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.insertSheet(7, boundaryEdges.map((edge) => edge.id), 8, state.revision);

  assert.deepEqual(call?.bindings, ["InsertSheetFactory", "InsertSheetCommand"]);
  assert.deepEqual(call?.values, [{ targetSheetId: 7, edgeIds: ["e1", "e2", "e3", "e4"], fillSheetId: 8 }]);
  assert.match(call?.source ?? "", /factory\.sheet = target/);
  assert.match(call?.source ?? "", /factory\.edges = args\.edgeIds\.map/);
  assert.match(call?.source ?? "", /factory\.fillSheet = fill/);
});

test("rejects invalid native Sheet insertion inputs before mutation", async () => {
  let mutations = 0;
  const boundary = { id: "e1", curveType: "Line", line: true, circle: false, lengthMm: 10, centerMm: [0, 0, 0] as [number, number, number], tangent: [1, 0, 0] as [number, number, number], boundsMm: { min: [0, 0, 0] as [number, number, number], max: [10, 0, 0] as [number, number, number] }, faceIds: ["f1"], vertexIds: [] };
  const internal = { ...boundary, id: "e2", faceIds: ["f1", "f2"] };
  const target = { id: 7, versionId: 17, type: "Sheet", name: null, boundsMm: null, faceIds: ["f1", "f2"], edgeIds: ["e1", "e2"], faces: [], edges: [boundary, internal] };
  const fill = { ...target, id: 8, versionId: 18, edgeIds: [], edges: [] };
  const solid = { ...target, id: 9, versionId: 19, type: "Solid" };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [target, fill, solid] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.insertSheet(7, ["e1"], 7, state.revision), /two different/i);
  await assert.rejects(operations.insertSheet(9, ["e1"], 8, state.revision), /target Sheet/i);
  await assert.rejects(operations.insertSheet(7, ["e1"], 9, state.revision), /fill Sheet/i);
  await assert.rejects(operations.insertSheet(7, [], 8, state.revision), /at least one/i);
  await assert.rejects(operations.insertSheet(7, ["e1", "e1"], 8, state.revision), /unique/i);
  await assert.rejects(operations.insertSheet(7, ["missing"], 8, state.revision), /stale or unknown/i);
  await assert.rejects(operations.insertSheet(7, ["e2"], 8, state.revision), /boundary/i);
  await assert.rejects(operations.insertSheet(7, ["e1"], 8, "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("dissolves exact faces into adjacent native surfaces", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const face = { id: "f1", surfaceType: "Plane", planar: true, centerMm: [0, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number], radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: [0, 0, 0] as [number, number, number], max: [10, 10, 0] as [number, number, number] }, edgeIds: [] };
  const solid = { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: [face.id], edgeIds: [], faces: [face], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [solid] };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.dissolveFaces([{ bodyId: 7, faceId: "f1" }], state.revision);

  assert.deepEqual(call?.bindings, ["DissolveFaceCommand", "DissolveFaceFactory"]);
  assert.deepEqual(call?.values, [{ faces: [{ bodyId: 7, faceId: "f1" }] }]);
  assert.match(call?.source ?? "", /new Command\(this\)/);
  assert.match(call?.source ?? "", /factory\.faces = args\.faces\.map/);
});

test("rejects stale and duplicate face dissolve references before mutation", async () => {
  let mutations = 0;
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const ref = { bodyId: 7, faceId: "f1" };

  await assert.rejects(operations.dissolveFaces([], state.revision), /at least one/i);
  await assert.rejects(operations.dissolveFaces([ref, ref], state.revision), /unique/i);
  await assert.rejects(operations.dissolveFaces([ref], state.revision), /stale or unknown/i);
  await assert.rejects(operations.dissolveFaces([ref], "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("patches a native Sheet boundary loop", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const edges = ["e1", "e2", "e3", "e4"].map((id) => ({ id, curveType: "Line", line: true, circle: false, lengthMm: 10, centerMm: [0, 0, 0] as [number, number, number], tangent: [1, 0, 0] as [number, number, number], boundsMm: { min: [0, 0, 0] as [number, number, number], max: [10, 0, 0] as [number, number, number] }, faceIds: ["f1"], vertexIds: [] }));
  const sheet = { id: 7, versionId: 17, type: "Sheet", name: null, boundsMm: null, faceIds: ["f1"], edgeIds: edges.map((edge) => edge.id), faces: [], edges };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [sheet] };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.patchSheetHole(7, edges.map((edge) => edge.id), state.revision);

  assert.deepEqual(call?.bindings, ["PatchHoleInSheetFactory"]);
  assert.deepEqual(call?.values, [{ id: 7, edgeIds: ["e1", "e2", "e3", "e4"] }]);
  assert.match(call?.source ?? "", /factory\.sheet = view/);
  assert.match(call?.source ?? "", /factory\.edges = args\.edgeIds\.map/);
});

test("caps every open boundary of current native Sheets", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const sheet = { id: 7, versionId: 17, type: "Sheet", name: null, boundsMm: null, faceIds: ["f1"], edgeIds: ["e1"], faces: [], edges: [] };
  const other = { ...sheet, id: 8, versionId: 18 };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [sheet, other] };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.capSheetHoles([7, 8], state.revision);

  assert.deepEqual(call?.bindings, ["PatchHolesInSheetCommand", "CapHolesInSheetFactory"]);
  assert.deepEqual(call?.values, [{ ids: [7, 8] }]);
  assert.match(call?.source ?? "", /new Command\(this\)/);
  assert.match(call?.source ?? "", /factory\.sheets = args\.ids\.map\(find\)/);
});

test("rejects invalid Sheet cap references before mutation", async () => {
  let mutations = 0;
  const sheet = { id: 7, versionId: 17, type: "Sheet", name: null, boundsMm: null, faceIds: ["f1"], edgeIds: ["e1"], faces: [], edges: [] };
  const solid = { ...sheet, id: 8, versionId: 18, type: "Solid" };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [sheet, solid] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.capSheetHoles([], state.revision), /at least one/i);
  await assert.rejects(operations.capSheetHoles([7, 7], state.revision), /unique/i);
  await assert.rejects(operations.capSheetHoles([8], state.revision), /current Sheet/i);
  await assert.rejects(operations.capSheetHoles([99], state.revision), /current Sheet/i);
  await assert.rejects(operations.capSheetHoles([7], "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("rejects invalid Sheet-hole patch inputs before mutation", async () => {
  let mutations = 0;
  const edges = ["e1", "e2", "e3"].map((id, index) => ({ id, curveType: "Line", line: true, circle: false, lengthMm: 10, centerMm: [0, 0, 0] as [number, number, number], tangent: [1, 0, 0] as [number, number, number], boundsMm: { min: [0, 0, 0] as [number, number, number], max: [10, 0, 0] as [number, number, number] }, faceIds: index === 2 ? ["f1", "f2"] : ["f1"], vertexIds: [] }));
  const sheet = { id: 7, versionId: 17, type: "Sheet", name: null, boundsMm: null, faceIds: ["f1", "f2"], edgeIds: edges.map((edge) => edge.id), faces: [], edges };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [sheet] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.patchSheetHole(7, ["e1", "e2"], state.revision), /at least three/i);
  await assert.rejects(operations.patchSheetHole(7, ["e1", "e1", "e2"], state.revision), /unique/i);
  await assert.rejects(operations.patchSheetHole(7, ["e1", "e2", "missing"], state.revision), /stale or unknown/i);
  await assert.rejects(operations.patchSheetHole(7, ["e1", "e2", "e3"], state.revision), /boundary/i);
  await assert.rejects(operations.patchSheetHole(7, ["e1", "e2", "e3"], "old-revision"), /stale reference/i);
  await assert.rejects(operations.patchSheetHole(99, ["e1", "e2", "e3"], state.revision), /current Sheet/i);
  assert.equal(mutations, 0);
});

test("extends exact boundary edges of a native Sheet", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const edges = ["e1", "e2"].map((id) => ({ id, curveType: "Line", line: true, circle: false, lengthMm: 10, centerMm: [10, 5, 0] as [number, number, number], tangent: [0, 1, 0] as [number, number, number], boundsMm: { min: [10, 0, 0] as [number, number, number], max: [10, 10, 0] as [number, number, number] }, faceIds: ["f1"], vertexIds: [] }));
  const sheet = { id: 7, versionId: 17, type: "Sheet", name: null, boundsMm: null, faceIds: ["f1"], edgeIds: edges.map((edge) => edge.id), faces: [], edges };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [sheet] };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.extendSheetEdges(7, ["e1", "e2"], 5, state.revision);

  assert.deepEqual(call?.bindings, ["ExtendSheetFactory", "ExtensionShape", "BodyExtensionType", "ExtensionLimit"]);
  assert.deepEqual(call?.values, [{ id: 7, edgeIds: ["e1", "e2"], distance: 0.005 }]);
  assert.match(call?.source ?? "", /factory\.shape = ExtensionShape\.Linear/);
  assert.match(call?.source ?? "", /factory\.type = BodyExtensionType\.Distance/);
  assert.match(call?.source ?? "", /factory\.limit = ExtensionLimit\.Minimal/);
});

test("rejects invalid Sheet edge extensions before mutation", async () => {
  let mutations = 0;
  const boundary = { id: "e1", curveType: "Line", line: true, circle: false, lengthMm: 10, centerMm: [10, 5, 0] as [number, number, number], tangent: [0, 1, 0] as [number, number, number], boundsMm: { min: [10, 0, 0] as [number, number, number], max: [10, 10, 0] as [number, number, number] }, faceIds: ["f1"], vertexIds: [] };
  const joined = { ...boundary, id: "e2", faceIds: ["f1", "f2"] };
  const sheet = { id: 7, versionId: 17, type: "Sheet", name: null, boundsMm: null, faceIds: ["f1", "f2"], edgeIds: ["e1", "e2"], faces: [], edges: [boundary, joined] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [sheet] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.extendSheetEdges(7, [], 5, state.revision), /at least one/i);
  await assert.rejects(operations.extendSheetEdges(7, ["e1", "e1"], 5, state.revision), /unique/i);
  await assert.rejects(operations.extendSheetEdges(7, ["missing"], 5, state.revision), /stale or unknown/i);
  await assert.rejects(operations.extendSheetEdges(7, ["e2"], 5, state.revision), /boundary/i);
  await assert.rejects(operations.extendSheetEdges(7, ["e1"], 0, state.revision), /positive/i);
  await assert.rejects(operations.extendSheetEdges(7, ["e1"], 5, "old-revision"), /stale reference/i);
  await assert.rejects(operations.extendSheetEdges(99, ["e1"], 5, state.revision), /current Sheet/i);
  assert.equal(mutations, 0);
});

test("validates current bodies with native Check codes and exact topology", async () => {
  let readCall: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const boundaryEdge = { id: "e1", curveType: "Line", line: true, circle: false, lengthMm: 10, centerMm: [0, 0, 0] as [number, number, number], tangent: [1, 0, 0] as [number, number, number], boundsMm: { min: [0, 0, 0] as [number, number, number], max: [10, 0, 0] as [number, number, number] }, faceIds: ["f1"], vertexIds: [] };
  const solid = { id: 7, versionId: 17, type: "Solid", name: "Good", boundsMm: null, faceIds: ["f1"], edgeIds: ["e1"], faces: [], edges: [{ ...boundaryEdge, faceIds: ["f1"] }] };
  const sheet = { id: 8, versionId: 18, type: "Sheet", name: "Open", boundsMm: null, faceIds: ["f1"], edgeIds: ["e1"], faces: [], edges: [boundaryEdge] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [solid, sheet] };
  const runtime = {
    async getState() { return state; },
    async readNative(source: string, bindings: string[], values: unknown[]) {
      readCall = { source, bindings, values };
      return [{ id: 7, nativeCheckCodes: [] }, { id: 8, nativeCheckCodes: [42] }];
    },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  const result = await operations.validateBodies([7, 8], state.revision);

  assert.deepEqual(readCall?.bindings, []);
  assert.deepEqual(readCall?.values, [{ ids: [7, 8] }]);
  assert.match(readCall?.source ?? "", /model\.Check\(\)/);
  assert.deepEqual(result.bodies.map((body) => ({ id: body.id, nativeValid: body.nativeValid, closed: body.closed, printableSolid: body.printableSolid, boundaryEdgeIds: body.boundaryEdgeIds })), [
    { id: 7, nativeValid: true, closed: true, printableSolid: true, boundaryEdgeIds: [] },
    { id: 8, nativeValid: false, closed: false, printableSolid: false, boundaryEdgeIds: ["e1"] },
  ]);
});

test("rejects stale, duplicate, and missing body validation references", async () => {
  let reads = 0;
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [] };
  const runtime = { async getState() { return state; }, async readNative() { reads += 1; return []; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.validateBodies([], state.revision), /at least one/i);
  await assert.rejects(operations.validateBodies([7, 7], state.revision), /unique/i);
  await assert.rejects(operations.validateBodies([7], state.revision), /unknown body/i);
  await assert.rejects(operations.validateBodies([7], "old-revision"), /stale reference/i);
  assert.equal(reads, 0);
});

test("creates native circular pipes along Wire spines", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const wire = { id: 8, versionId: 13, type: "Wire", name: "Spine", boundsMm: { min: [0, 0, 0] as [number, number, number], max: [0, 0, 20] as [number, number, number] }, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [wire] };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.createPipes([8], 4, 1, state.revision);

  assert.deepEqual(call?.bindings, ["PipeFactory"]);
  assert.deepEqual(call?.values, [{ spineIds: [8], diameter: 0.004, thickness: 0.001 }]);
  assert.match(call?.source ?? "", /factory\.spines = spines/);
});

test("creates an interpolating native NURBS curve from millimeter points", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [] };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.createNurbsCurve([[0, 0, 0], [10, 10, 0], [20, -10, 0], [30, 0, 0]], false, state.revision);

  assert.deepEqual(call?.bindings, ["CurveFactory", "Vector3", "CurveType"]);
  assert.deepEqual(call?.values, [{ points: [[0, 0, 0], [0.01, 0.01, 0], [0.02, -0.01, 0], [0.03, 0, 0]], closed: false }]);
  assert.match(call?.source ?? "", /factory\.type = CurveType\.NURBS/);
});

test("creates a constant-radius native helix from a millimeter axis", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [] };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.createHelix([0, 0, 0], [0, 0, 20], 5, 4, [1, 0, 0], "right", state.revision);

  assert.deepEqual(call?.bindings, ["SpiralFactory", "Vector3"]);
  assert.deepEqual(call?.values, [{ axisStart: [0, 0, 0], axisEnd: [0, 0, 0.02], radiusPoint: [0.005, 0, 0.02], radius: 0.005, turns: 4, handedness: true }]);
  assert.match(call?.source ?? "", /SpiralCommand/);
  assert.match(call?.source ?? "", /factory\.spiralPitch = 0/);
});

test("creates an exact ring torus and its editable circular profile in one history command", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [] };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.createTorus([10, 20, 30], 30, 5, [0, 0, 2], [2, 0, 1], "Seal ring", state.revision);

  assert.deepEqual(call?.bindings, ["CenterCircleFactory", "RevolveFactory", "Vector3", "Quaternion"]);
  assert.deepEqual(call?.values, [{
    center: [0.01, 0.02, 0.03], profileCenter: [0.04, 0.02, 0.03], profileNormal: [0, 1, 0],
    axis: [0, 0, 1], minorRadius: 0.005, name: "Seal ring",
  }]);
  assert.match(call?.source ?? "", /new this\.commands\.RevolveCommand\(this\)/u);
  assert.match(call?.source ?? "", /const profile = new CircleFactory\(editor\)\.resource\(this\)/u);
  assert.match(call?.source ?? "", /const revolve = new RevolveFactory\(editor\)\.resource\(this\)/u);
  assert.match(call?.source ?? "", /revolve\.degrees = 360/u);
});

test("creates an exact cone or frustum and its editable meridional profile in one history command", async () => {
  const calls: Array<{ source: string; bindings: string[]; values: unknown[] }> = [];
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [] };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { calls.push({ source, bindings, values }); return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.createCone([10, 20, 30], 20, 10, 40, [0, 0, 2], [2, 0, 1], "Reducer", state.revision);
  await operations.createCone([10, 20, 30], 20, 0, 40, [0, 0, 2], [2, 0, 1], "Pointed cone", state.revision);

  assert.deepEqual(calls.map((call) => call.bindings), [
    ["CurveFactory", "RevolveFactory", "Vector3", "CurveType"],
    ["CurveFactory", "RevolveFactory", "Vector3", "CurveType"],
  ]);
  assert.deepEqual(calls[0]?.values, [{
    points: [[0.01, 0.02, 0.03], [0.03, 0.02, 0.03], [0.02, 0.02, 0.07], [0.01, 0.02, 0.07]],
    center: [0.01, 0.02, 0.03], axis: [0, 0, 1], name: "Reducer",
  }]);
  assert.deepEqual(calls[1]?.values, [{
    points: [[0.01, 0.02, 0.03], [0.03, 0.02, 0.03], [0.01, 0.02, 0.07]],
    center: [0.01, 0.02, 0.03], axis: [0, 0, 1], name: "Pointed cone",
  }]);
  assert.match(calls[0]?.source ?? "", /new this\.commands\.RevolveCommand\(this\)/u);
  assert.match(calls[0]?.source ?? "", /profile\.type = CurveType\.Polyline/u);
  assert.match(calls[0]?.source ?? "", /profile\.closed = true/u);
  assert.match(calls[0]?.source ?? "", /const revolve = new RevolveFactory\(editor\)\.resource\(this\)/u);
  assert.match(calls[0]?.source ?? "", /existingRegionIds/u);
  assert.match(calls[0]?.source ?? "", /regions\.length !== 1/u);
  assert.match(calls[0]?.source ?? "", /revolve\.regions = regions/u);
  assert.match(calls[0]?.source ?? "", /revolve\.degrees = 360/u);
});

test("rejects invalid cone and frustum dimensions and frames before mutation", async () => {
  let mutations = 0;
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.createCone([0, 0, 0], 0, 2, 10, [0, 0, 1], [1, 0, 0], undefined, state.revision), /bottom radius/i);
  await assert.rejects(operations.createCone([0, 0, 0], 5, -1, 10, [0, 0, 1], [1, 0, 0], undefined, state.revision), /top radius/i);
  await assert.rejects(operations.createCone([0, 0, 0], 5, 2, 0, [0, 0, 1], [1, 0, 0], undefined, state.revision), /height/i);
  await assert.rejects(operations.createCone([0, 0, 0], 5, 5, 10, [0, 0, 1], [1, 0, 0], undefined, state.revision), /equal radii.*cylinder/i);
  await assert.rejects(operations.createCone([0, 0, 0], 5, 2, 10, [0, 0, 0], [1, 0, 0], undefined, state.revision), /plane normal/i);
  await assert.rejects(operations.createCone([0, 0, 0], 5, 2, 10, [0, 0, 1], [0, 0, 2], undefined, state.revision), /parallel/i);
  await assert.rejects(operations.createCone([0, 0, 0], 5, 2, 10, [0, 0, 1], [1, 0, 0], undefined, "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("rejects invalid ring-torus dimensions and frames before mutation", async () => {
  let mutations = 0;
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.createTorus([0, 0, 0], 10, 0, [0, 0, 1], [1, 0, 0], undefined, state.revision), /minor radius/i);
  await assert.rejects(operations.createTorus([0, 0, 0], 5, 5, [0, 0, 1], [1, 0, 0], undefined, state.revision), /major radius.*greater/i);
  await assert.rejects(operations.createTorus([0, 0, 0], 10, 2, [0, 0, 0], [1, 0, 0], undefined, state.revision), /plane normal/i);
  await assert.rejects(operations.createTorus([0, 0, 0], 10, 2, [0, 0, 1], [0, 0, 2], undefined, state.revision), /parallel/i);
  await assert.rejects(operations.createTorus([0, 0, 0], 10, 2, [0, 0, 1], [1, 0, 0], undefined, "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("rejects invalid native helix geometry before mutation", async () => {
  let mutations = 0;
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.createHelix([0, 0, 0], [0, 0, 0], 5, 4, [1, 0, 0], "right", state.revision), /axis/i);
  await assert.rejects(operations.createHelix([0, 0, 0], [0, 0, 20], 0, 4, [1, 0, 0], "right", state.revision), /radius/i);
  await assert.rejects(operations.createHelix([0, 0, 0], [0, 0, 20], 5, 0, [1, 0, 0], "right", state.revision), /turns/i);
  await assert.rejects(operations.createHelix([0, 0, 0], [0, 0, 20], 5, 4, [0, 0, 1], "right", state.revision), /radial direction/i);
  await assert.rejects(operations.createHelix([0, 0, 0], [0, 0, 20], 5, 4, [1, 0, 0], "right", "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("rejects invalid native pipe inputs before mutation", async () => {
  let mutations = 0;
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "current-revision", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(operations.createPipes([], 4, 0, state.revision), /at least one/i);
  await assert.rejects(operations.createPipes([8], 0, 0, state.revision), /diameter/i);
  await assert.rejects(operations.createPipes([8], 4, -1, state.revision), /thickness/i);
  await assert.rejects(operations.createPipes([8], 4, 0, "old-revision"), /stale reference/i);
  assert.equal(mutations, 0);
});

test("passes a signed draft angle and separate neutral face reference", async () => {
  let values: unknown[] | undefined;
  const state: RuntimeState = {
    targetId: "window-1",
    title: "Untitled - Plasticity",
    documentToken: "document-1",
    revision: "current-revision",
    dbVersion: 1,
    undoDepth: 0,
    redoDepth: 0,
    regions: [],
    construction: emptyConstruction,
    bodies: [],
  };
  const runtime = {
    async getState() { return state; },
    async mutate(_source: string, _bindings: string[], args: unknown[]) {
      values = args;
      return {};
    },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await operations.draftFaces(21, ["side-1", "side-2"], { bodyId: 21, faceId: "bottom" }, -3, state.revision);

  assert.deepEqual(values, [{
    id: 21,
    faceIds: ["side-1", "side-2"],
    referenceFace: { bodyId: 21, faceId: "bottom" },
    angleDegrees: -3,
  }]);
});

test("rejects drafting the neutral reference face before mutation", async () => {
  let mutated = false;
  const state: RuntimeState = {
    targetId: "window-1",
    title: "Untitled - Plasticity",
    documentToken: "document-1",
    revision: "current-revision",
    dbVersion: 1,
    undoDepth: 0,
    redoDepth: 0,
    regions: [],
    construction: emptyConstruction,
    bodies: [],
  };
  const runtime = {
    async getState() { return state; },
    async mutate() { mutated = true; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);

  await assert.rejects(
    operations.draftFaces(21, ["bottom"], { bodyId: 21, faceId: "bottom" }, 3, state.revision),
    /neutral reference face/i,
  );
  assert.equal(mutated, false);
});

test("defines exact coordinate datums without entering a native mutation", async () => {
  const { operations, wasMutated } = constructionOperations();
  const point = await operations.defineDatumPoint({ type: "coordinates", pointMm: [1, 2, 3] }, "r1");
  const axis = await operations.defineDatumAxis({ type: "origin-direction", originMm: [1, 2, 3], direction: [0, 0, 5] }, "r1");
  assert.deepEqual(point.pointMm, [1, 2, 3]);
  assert.deepEqual(axis.direction, [0, 0, 1]);
  assert.equal(wasMutated(), false);
});

test("rejects coincident and collinear datum definitions before CDP mutation", async () => {
  const { operations, wasMutated } = constructionOperations();
  const a = await operations.defineDatumPoint({ type: "coordinates", pointMm: [0, 0, 0] }, "r1");
  const b = await operations.defineDatumPoint({ type: "coordinates", pointMm: [1, 0, 0] }, "r1");
  const c = await operations.defineDatumPoint({ type: "coordinates", pointMm: [2, 0, 0] }, "r1");
  await assert.rejects(operations.defineDatumAxis({ type: "two-points", firstId: a.id, secondId: a.id }, "r1"), /zero|short/i);
  await assert.rejects(operations.createConstructionPlane({ type: "three-points", firstId: a.id, secondId: b.id, thirdId: c.id }, "Bad", "r1"), /collinear/i);
  assert.equal(wasMutated(), false);
});

test("rejects stale identities, standard-plane removal, and off-plane rotation before mutation", async () => {
  const { operations, wasMutated } = constructionOperations();
  const listed = await operations.listConstructionGeometry();
  const top = listed.planes.find((plane) => plane.id === "standard:top")!;
  const axis = await operations.defineDatumAxis({ type: "origin-direction", originMm: [0, 0, 1], direction: [1, 0, 0] }, "r1");

  await assert.rejects(operations.setConstructionWorkplane({ ...top.identity, sessionId: "other" }), /session/i);
  await assert.rejects(operations.removeConstructionPlane(top.identity), /standard/i);
  await assert.rejects(operations.createConstructionPlane({ type: "rotated", planeId: top.id, axisId: axis.id, angleDegrees: 30 }, "Bad", "r1"), /coplanar/i);
  assert.equal(wasMutated(), false);
});

test("transforms plane-local polyline points before the single native unit conversion", async () => {
  const { operations, argumentsSeen } = planeLocalOperations();
  const listed = await operations.listConstructionGeometry();
  const plane = listed.planes.find((candidate) => candidate.id === "plane:7")!;
  assert.equal(listed.activePlaneId, "plane:7");
  assert.equal(listed.activePlane?.nativeId, "7");
  await operations.createPolyline([[5, 7], [6, 8]], false, "r1", plane.identity);
  assert.deepEqual(argumentsSeen(), [{ points: [[0.01, 0.025, 0.037], [0.01, 0.026, 0.038]], closed: false }]);
});

test("refreshes a two-point axis by re-resolving its point definitions", async () => {
  let state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision: "r1",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [], construction: emptyConstruction, bodies: [],
  };
  const runtime = { getCapabilities() { return []; }, async getState() { return state; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime, "session-1");
  const first = await operations.defineDatumPoint({ type: "coordinates", pointMm: [0, 0, 0] }, "r1");
  const second = await operations.defineDatumPoint({ type: "coordinates", pointMm: [0, 5, 0] }, "r1");
  const axis = await operations.defineDatumAxis({ type: "two-points", firstId: first.id, secondId: second.id }, "r1");
  state = { ...state, revision: "r2", dbVersion: 2 };

  await assert.rejects(
    operations.defineDatumAxis({ type: "two-points", firstId: first.id, secondId: second.id }, "r2"),
    /stale/i,
  );
  const refreshed = await operations.refreshDatum(axis.identity);
  assert.equal(refreshed.kind, "datum-axis");
  if (refreshed.kind !== "datum-axis") throw new Error("Expected refreshed datum axis");
  assert.equal(refreshed.refreshedFromId, axis.id);
  assert.deepEqual(refreshed.direction, [0, 1, 0]);
  assert.equal(refreshed.revision, "r2");
});

test("keeps existing world-space curve arguments unchanged and orients local circles from the plane", async () => {
  const local = planeLocalOperations();
  const plane = (await local.operations.listConstructionGeometry()).planes.find((candidate) => candidate.id === "plane:7")!;
  await local.operations.createCircle([5, 7], 2, "r1", undefined, plane.identity);
  assert.deepEqual(local.argumentsSeen(), [{ center: [0.01, 0.025, 0.037], radius: 0.002, normal: [1, 0, 0] }]);
  assert.match(local.sourceSeen() ?? "", /factory\.point\.copy\(factory\.center\)/);

  const world = planeLocalOperations();
  await world.operations.createPolyline([[10, 25, 37], [10, 26, 38]], false, "r1");
  assert.deepEqual(world.argumentsSeen(), [{ points: [[0.01, 0.025, 0.037], [0.01, 0.026, 0.038]], closed: false }]);
});

test("creates exact native two-point diameter circles in world and construction-plane coordinates", async () => {
  const world = planeLocalOperations();
  await world.operations.createTwoPointCircle([0, 0, 0], [20, 0, 0], "r1", [0, 0, 2]);
  assert.deepEqual(world.argumentsSeen(), [{ diameterStart: [0, 0, 0], diameterEnd: [0.02, 0, 0], normal: [0, 0, 1] }]);
  assert.match(world.sourceSeen() ?? "", /TwoPointCircleCommand/);
  assert.match(world.sourceSeen() ?? "", /factory\.p1\.fromArray\(args\.diameterStart\)/);
  assert.match(world.sourceSeen() ?? "", /factory\.p2\.fromArray\(args\.diameterEnd\)/);

  const local = planeLocalOperations();
  const plane = (await local.operations.listConstructionGeometry()).planes.find((candidate) => candidate.id === "plane:7")!;
  await local.operations.createTwoPointCircle([0, 0], [0, 8], "r1", undefined, plane.identity);
  assert.deepEqual(local.argumentsSeen(), [{
    diameterStart: [0.01, 0.02, 0.03],
    diameterEnd: [0.01, 0.02, 0.038],
    normal: [1, 0, 0],
  }]);
});

test("creates exact native three-point circles in world and construction-plane coordinates", async () => {
  const world = planeLocalOperations();
  await world.operations.createThreePointCircle([10, 0, 0], [0, 10, 0], [-10, 0, 0], "r1");
  assert.deepEqual(world.argumentsSeen(), [{ first: [0.01, 0, 0], second: [0, 0.01, 0], third: [-0.01, 0, 0] }]);
  assert.match(world.sourceSeen() ?? "", /ThreePointCircleCommand/);
  assert.match(world.sourceSeen() ?? "", /factory\.p3\.fromArray\(args\.third\)/);

  const local = planeLocalOperations();
  const plane = (await local.operations.listConstructionGeometry()).planes.find((candidate) => candidate.id === "plane:7")!;
  await local.operations.createThreePointCircle([4, 0], [0, 4], [-4, 0], "r1", plane.identity);
  assert.deepEqual(local.argumentsSeen(), [{
    first: [0.01, 0.024, 0.03],
    second: [0.01, 0.02, 0.034],
    third: [0.01, 0.016, 0.03],
  }]);
});

test("rejects invalid point-defined circles before mutation", async () => {
  const invalid = planeLocalOperations();
  await assert.rejects(invalid.operations.createTwoPointCircle([0, 0, 0], [0, 0, 0], "r1"), /distinct/i);
  await assert.rejects(invalid.operations.createTwoPointCircle([0, 0, 0], [20, 0, 0], "r1", [1, 0, 0]), /normal.*perpendicular/i);
  await assert.rejects(invalid.operations.createThreePointCircle([0, 0, 0], [1, 0, 0], [2, 0, 0], "r1"), /collinear/i);
  assert.equal(invalid.argumentsSeen(), undefined);
});

test("creates exact native arcs, ellipses, and regular polygons in planar frames", async () => {
  const arc = planeLocalOperations();
  await arc.operations.createCenterArc([10, 20, 30], 10, 0, 90, "r1");
  assert.deepEqual(arc.argumentsSeen(), [{
    center: [0.01, 0.02, 0.03],
    start: [0.02, 0.02, 0.03],
    end: [0.01, 0.03, 0.03],
    normal: [0, 0, 1],
  }]);
  assert.match(arc.sourceSeen() ?? "", /CenterPointArcCommand/);
  assert.match(arc.sourceSeen() ?? "", /factory\.lastSense = true/);

  const clockwiseArc = planeLocalOperations();
  await clockwiseArc.operations.createCenterArc([10, 20, 30], 10, 0, -90, "r1");
  assert.deepEqual(clockwiseArc.argumentsSeen(), [{
    center: [0.01, 0.02, 0.03],
    start: [0.02, 0.02, 0.03],
    end: [0.01, 0.01, 0.03],
    normal: [0, 0, -1],
  }]);

  const ellipse = planeLocalOperations();
  const plane = (await ellipse.operations.listConstructionGeometry()).planes.find((candidate) => candidate.id === "plane:7")!;
  await ellipse.operations.createEllipse([5, 7], 4, 2, "r1", undefined, undefined, plane.identity);
  assert.deepEqual(ellipse.argumentsSeen(), [{
    center: [0.01, 0.025, 0.037],
    majorPoint: [0.01, 0.029, 0.037],
    minorPoint: [0.01, 0.025, 0.039],
    normal: [1, 0, 0],
  }]);
  assert.match(ellipse.sourceSeen() ?? "", /EllipseCommand/);

  const polygon = planeLocalOperations();
  const polygonPlane = (await polygon.operations.listConstructionGeometry()).planes.find((candidate) => candidate.id === "plane:7")!;
  await polygon.operations.createRegularPolygon([5, 7], 4, "inradius", 6, "r1", undefined, undefined, polygonPlane.identity);
  assert.deepEqual(polygon.argumentsSeen(), [{
    center: [0.01, 0.025, 0.037],
    point: [0.01, 0.029, 0.037],
    normal: [1, 0, 0],
    radiusMode: "inradius",
    vertexCount: 6,
  }]);
  assert.match(polygon.sourceSeen() ?? "", /PolygonCommand/);
  assert.match(polygon.sourceSeen() ?? "", /'circumscribed'/);
});

test("creates exact native three-point arcs and preserves the ordered major arc", async () => {
  const world = planeLocalOperations();
  await world.operations.createThreePointArc([10, 0, 0], [0, -10, 0], [0, 10, 0], "r1");
  assert.deepEqual(world.argumentsSeen(), [{
    center: [0, 0, 0],
    start: [0.01, 0, 0],
    end: [0, 0.01, 0],
    normal: [0, 0, -1],
  }]);
  assert.match(world.sourceSeen() ?? "", /ThreePointArcCommand/);
  assert.match(world.sourceSeen() ?? "", /factory\.lastSense = true/);

  const local = planeLocalOperations();
  const plane = (await local.operations.listConstructionGeometry()).planes.find((candidate) => candidate.id === "plane:7")!;
  await local.operations.createThreePointArc([4, 0], [0, 4], [-4, 0], "r1", plane.identity);
  assert.deepEqual(local.argumentsSeen(), [{
    center: [0.01, 0.02, 0.03],
    start: [0.01, 0.024, 0.03],
    end: [0.01, 0.016, 0.03],
    normal: [1, 0, 0],
  }]);
});

test("rejects invalid native arc, ellipse, and polygon parameters before mutation", async () => {
  const invalid = planeLocalOperations();
  await assert.rejects(invalid.operations.createCenterArc([0, 0, 0], 0, 0, 90, "r1"), /arc radius/i);
  await assert.rejects(invalid.operations.createCenterArc([0, 0, 0], 10, 0, 0, "r1"), /sweep angle/i);
  await assert.rejects(invalid.operations.createCenterArc([0, 0, 0], 10, 0, 360, "r1"), /less than 360/i);
  await assert.rejects(invalid.operations.createEllipse([0, 0, 0], 5, 6, "r1"), /minor radius.*exceed/i);
  await assert.rejects(invalid.operations.createRegularPolygon([0, 0, 0], 5, "circumradius", 2, "r1"), /vertex count/i);
  await assert.rejects(invalid.operations.createRegularPolygon([0, 0, 0], 5, "circumradius", 6, "r1", [0, 0, 1], [0, 0, 2]), /parallel/i);
  assert.equal(invalid.argumentsSeen(), undefined);
});

test("rejects duplicate and collinear three-point arcs before mutation", async () => {
  const duplicate = planeLocalOperations();
  await assert.rejects(duplicate.operations.createThreePointArc([0, 0, 0], [0, 0, 0], [1, 0, 0], "r1"), /distinct/i);
  assert.equal(duplicate.argumentsSeen(), undefined);

  const collinear = planeLocalOperations();
  await assert.rejects(collinear.operations.createThreePointArc([0, 0, 0], [1, 0, 0], [2, 0, 0], "r1"), /collinear/i);
  assert.equal(collinear.argumentsSeen(), undefined);
});

test("creates native minor and major tangent arcs from exact Wire segments", async () => {
  const calls: Array<{ source: string; bindings: string[]; values: unknown[] }> = [];
  const wire = { id: 7, versionId: 17, type: "Wire", name: "Guide", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision: "r1",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [wire],
  };
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) { calls.push({ source, bindings, values }); return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime, "session-1");

  await operations.createTangentArc(7, 99, "end", [30, 10, 0], false, "r1");
  await operations.createTangentArc(7, 99, "end", [30, 10, 0], true, "r1");

  assert.deepEqual(calls.map((call) => call.values), [
    [{ bodyId: 7, segmentEntityId: 99, startAt: "end", end: [0.03, 0.01, 0], flipTangent: false }],
    [{ bodyId: 7, segmentEntityId: 99, startAt: "end", end: [0.03, 0.01, 0], flipTangent: true }],
  ]);
  assert.deepEqual(calls[0]?.bindings, ["TangentArcFactory", "Vector3"]);
  assert.match(calls[0]?.source ?? "", /TangentArcCommand/);
  assert.match(calls[0]?.source ?? "", /factory\.segment = segment/);
  assert.match(calls[0]?.source ?? "", /GetPointAndTangent\(parameter\)/);
  assert.match(calls[0]?.source ?? "", /source tangent line/);
});

test("transforms plane-local tangent-arc endpoints and rejects non-Wire sources", async () => {
  const local = planeLocalOperations([{ id: 7, versionId: 17, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] }]);
  const plane = (await local.operations.listConstructionGeometry()).planes.find((candidate) => candidate.id === "plane:7")!;
  await local.operations.createTangentArc(7, 99, "start", [5, 7], false, "r1", plane.identity);
  assert.deepEqual(local.argumentsSeen(), [{ bodyId: 7, segmentEntityId: 99, startAt: "start", end: [0.01, 0.025, 0.037], flipTangent: false }]);

  const invalid = planeLocalOperations([{ id: 8, versionId: 18, type: "Solid", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] }]);
  await assert.rejects(invalid.operations.createTangentArc(8, 99, "end", [30, 10, 0], false, "r1"), /current Wire/i);
  assert.equal(invalid.argumentsSeen(), undefined);
});

test("creates a native fixed-radius circle tangent to two exact Wire segments", async () => {
  const calls: Array<{ source: string; bindings: string[]; values: unknown[] }> = [];
  const wires = [
    { id: 7, versionId: 17, type: "Wire", name: "Horizontal", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] },
    { id: 8, versionId: 18, type: "Wire", name: "Vertical", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] },
  ];
  const plane = {
    id: "plane:7", nativeId: "7", name: "Local", source: "saved" as const,
    ...frameFromOriginNormalX([10, 20, 30], [1, 0, 0], [0, 1, 0]),
  };
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision: "r1",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [],
    construction: { planes: [plane], activePlaneId: plane.id, planeStateToken: "p1", viewStateToken: "v1" }, bodies: wires,
  };
  const directions = [
    { id: 7, versionId: 17, measurementSource: "native-brep" as const, closed: false, segments: [{ entityId: 91, startMm: [-20, 0, 0], endMm: [20, 0, 0], startTangent: [1, 0, 0], endTangent: [1, 0, 0], lengthMm: 40 }] },
    { id: 8, versionId: 18, measurementSource: "native-brep" as const, closed: false, segments: [{ entityId: 92, startMm: [0, -20, 0], endMm: [0, 20, 0], startTangent: [0, 1, 0], endTangent: [0, 1, 0], lengthMm: 40 }] },
  ];
  const runtime = {
    async getState() { return state; },
    async readNative() { return directions; },
    async mutate(source: string, bindings: string[], values: unknown[]) { calls.push({ source, bindings, values }); return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime, "session-1");
  const first = { bodyId: 7, segmentEntityId: 91 };
  const second = { bodyId: 8, segmentEntityId: 92 };
  const planeRef = (await operations.listConstructionGeometry()).planes.find((candidate) => candidate.id === plane.id)!.identity;

  await operations.createTangentCircle(first, second, [5, 5, 0], 5, "r1", [0, 0, 1]);
  await operations.createTangentCircle(first, second, [5, 7], 2, "r1", undefined, planeRef);

  assert.deepEqual(calls.map((call) => call.bindings), [
    ["TangentCircleFactory", "TangentCircleCommand", "Vector3"],
    ["TangentCircleFactory", "TangentCircleCommand", "Vector3"],
  ]);
  assert.deepEqual(calls.map((call) => call.values), [[{
    first, second, solutionPoint: [0.005, 0.005, 0], normal: [0, 0, 1], radius: 0.005,
  }], [{
    first, second, solutionPoint: [0.01, 0.025, 0.037], normal: [1, 0, 0], radius: 0.002,
  }]]);
  assert.match(calls[0]?.source ?? "", /factory\.segment1 = segment\(args\.first\)/);
  assert.match(calls[0]?.source ?? "", /factory\.segment2 = segment\(args\.second\)/);
  assert.match(calls[0]?.source ?? "", /factory\.radius = args\.radius/);
  assert.match(calls[0]?.source ?? "", /selection\.selected\.removeAll\(\)/);
});

test("rejects invalid tangent-circle geometry before native mutation", async () => {
  const wires = [
    { id: 7, versionId: 17, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] },
    { id: 8, versionId: 18, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] },
    { id: 9, versionId: 19, type: "Solid", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] },
  ];
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision: "r1",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: wires,
  };
  const directions = [
    { id: 7, versionId: 17, measurementSource: "native-brep" as const, closed: false, segments: [{ entityId: 91, startMm: [0, 0, 0], endMm: [10, 0, 0], startTangent: [1, 0, 0], endTangent: [1, 0, 0], lengthMm: 10 }] },
    { id: 8, versionId: 18, measurementSource: "native-brep" as const, closed: false, segments: [{ entityId: 92, startMm: [0, 0, 0], endMm: [0, 10, 0], startTangent: [0, 1, 0], endTangent: [0, 1, 0], lengthMm: 10 }] },
  ];
  let mutated = false;
  const runtime = { async getState() { return state; }, async readNative() { return directions; }, async mutate() { mutated = true; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime, "session-1");
  const first = { bodyId: 7, segmentEntityId: 91 };
  const second = { bodyId: 8, segmentEntityId: 92 };

  await assert.rejects(operations.createTangentCircle(first, first, [5, 5, 0], 5, "r1"), /must be different/i);
  await assert.rejects(operations.createTangentCircle(first, { bodyId: 9, segmentEntityId: 92 }, [5, 5, 0], 5, "r1"), /current Wire/i);
  await assert.rejects(operations.createTangentCircle(first, { bodyId: 8, segmentEntityId: 999 }, [5, 5, 0], 5, "r1"), /stale or unknown/i);
  await assert.rejects(operations.createTangentCircle(first, second, [5, 5, 0], 0, "r1"), /radius must be positive/i);
  await assert.rejects(operations.createTangentCircle(first, second, [5, 5] as [number, number], 5, "r1"), /world-space.*three coordinates/i);
  await assert.rejects(operations.createTangentCircle(first, second, [5, 5, 0], 5, "old"), /stale reference/i);
  assert.equal(mutated, false);
});

test("bridges exact Wire endpoints with independent native continuity modes", async () => {
  const calls: Array<{ source: string; bindings: string[]; values: unknown[] }> = [];
  const wires = [
    { id: 7, versionId: 17, type: "Wire", name: "First", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] },
    { id: 8, versionId: 18, type: "Wire", name: "Second", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] },
  ];
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision: "r1",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: wires,
  };
  const directions = [
    { id: 7, versionId: 17, measurementSource: "native-brep" as const, closed: false, segments: [{ entityId: 91, startMm: [0, 0, 0], endMm: [10, 0, 0], startTangent: [1, 0, 0], endTangent: [1, 0, 0], lengthMm: 10 }] },
    { id: 8, versionId: 18, measurementSource: "native-brep" as const, closed: false, segments: [{ entityId: 92, startMm: [20, 10, 0], endMm: [30, 10, 0], startTangent: [1, 0, 0], endTangent: [1, 0, 0], lengthMm: 10 }] },
  ];
  const runtime = {
    async getState() { return state; },
    async readNative() { return directions; },
    async mutate(source: string, bindings: string[], values: unknown[]) { calls.push({ source, bindings, values }); return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime, "session-1");
  const first = { bodyId: 7, segmentEntityId: 91, at: "end" as const };
  const second = { bodyId: 8, segmentEntityId: 92, at: "start" as const };

  await operations.bridgeCurves(first, second, "G1", "G3", "r1");

  assert.deepEqual(calls[0]?.bindings, ["BridgeCurveFactory", "ContinuityType"]);
  assert.deepEqual(calls[0]?.values, [{ first, second, startContinuity: "G1", endContinuity: "G3" }]);
  assert.match(calls[0]?.source ?? "", /BridgeCurveCommand/);
  assert.match(calls[0]?.source ?? "", /factory\.t1 = args\.first\.at === 'start' \? 0 : 1/);
  assert.match(calls[0]?.source ?? "", /factory\.trim = false/);
  assert.match(calls[0]?.source ?? "", /factory\.pickClosestSenses\(\)/);
});

test("rejects stale, missing, coincident, and non-Wire Curve Bridge references before mutation", async () => {
  const wire = { id: 7, versionId: 17, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const solid = { id: 8, versionId: 18, type: "Solid", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision: "r1", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [wire, solid] };
  let mutated = false;
  let directions = [{ id: 7, versionId: 17, measurementSource: "native-brep" as const, closed: false, segments: [{ entityId: 91, startMm: [0, 0, 0], endMm: [10, 0, 0], startTangent: [1, 0, 0], endTangent: [1, 0, 0], lengthMm: 10 }] }];
  const runtime = { async getState() { return state; }, async readNative() { return directions; }, async mutate() { mutated = true; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime, "session-1");
  const start = { bodyId: 7, segmentEntityId: 91, at: "start" as const };
  const end = { bodyId: 7, segmentEntityId: 91, at: "end" as const };

  await assert.rejects(operations.bridgeCurves(start, { bodyId: 8, segmentEntityId: 92, at: "start" }, "G1", "G1", "r1"), /current Wire/i);
  await assert.rejects(operations.bridgeCurves(start, { bodyId: 7, segmentEntityId: 999, at: "end" }, "G1", "G1", "r1"), /stale or unknown/i);
  await assert.rejects(operations.bridgeCurves(start, start, "G1", "G1", "r1"), /must be different/i);
  directions = [{ ...directions[0]!, segments: [{ ...directions[0]!.segments[0]!, endMm: [0, 0, 0] }] }];
  await assert.rejects(operations.bridgeCurves(start, end, "G1", "G1", "r1"), /must be distinct/i);
  await assert.rejects(operations.bridgeCurves(start, end, "G1", "G1", "old"), /stale reference/i);
  assert.equal(mutated, false);
});

test("bridges exact Solid or Sheet edge endpoints with native continuity", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const firstEdge = { id: "17e1", curveType: "Line", line: true, circle: false, lengthMm: 10, centerMm: [0, 0, 5] as [number, number, number], tangent: [0, 0, 1] as [number, number, number], boundsMm: { min: [0, 0, 0] as [number, number, number], max: [0, 0, 10] as [number, number, number] }, faceIds: ["17f1", "17f2"], vertexIds: [101, 102] };
  const secondEdge = { ...firstEdge, id: "18e1", centerMm: [20, 10, 25] as [number, number, number], boundsMm: { min: [20, 10, 20] as [number, number, number], max: [20, 10, 30] as [number, number, number] }, faceIds: ["18f1"], vertexIds: [201, 202] };
  const firstBody = { id: 7, versionId: 17, type: "Solid", name: "First", boundsMm: null, faceIds: ["17f1", "17f2"], edgeIds: [firstEdge.id], faces: [], edges: [firstEdge], vertices: [
    { id: 101, positionMm: [0, 0, 0] as [number, number, number], edgeIds: [firstEdge.id], faceIds: firstEdge.faceIds },
    { id: 102, positionMm: [0, 0, 10] as [number, number, number], edgeIds: [firstEdge.id], faceIds: firstEdge.faceIds },
  ] };
  const secondBody = { id: 8, versionId: 18, type: "Sheet", name: "Second", boundsMm: null, faceIds: ["18f1"], edgeIds: [secondEdge.id], faces: [], edges: [secondEdge], vertices: [
    { id: 201, positionMm: [20, 10, 20] as [number, number, number], edgeIds: [secondEdge.id], faceIds: secondEdge.faceIds },
    { id: 202, positionMm: [20, 10, 30] as [number, number, number], edgeIds: [secondEdge.id], faceIds: secondEdge.faceIds },
  ] };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision: "r1", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [firstBody, secondBody] };
  const runtime = { async getState() { return state; }, async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const first = { bodyId: 7, edgeId: "17e1", vertexId: 102 };
  const second = { bodyId: 8, edgeId: "18e1", vertexId: 201 };

  await operations.bridgeShellEdges(first, second, "G1", "G3", state.revision);

  assert.deepEqual(call?.bindings, ["BridgeEdgeFactory", "BridgeEdgeCommand", "ContinuityType"]);
  assert.deepEqual(call?.values, [{ first, second, firstPosition: [0, 0, 0.01], secondPosition: [0.02, 0.01, 0.02], startContinuity: "G1", endContinuity: "G3" }]);
  assert.match(call?.source ?? "", /factory\.edge1 = edge\(args\.first\)/);
  assert.match(call?.source ?? "", /factory\.pickClosestVertices\(\)/);
  assert.match(call?.source ?? "", /matches\(factory\.startPosition, args\.firstPosition\)/);
  assert.match(call?.source ?? "", /factory\.side1 = !factory\.side1/);
  assert.match(call?.source ?? "", /factory\.startCurvature = Continuity\[args\.startContinuity\]/);
  assert.match(call?.source ?? "", /factory\.lockDistances = true/);
  assert.match(call?.source ?? "", /selection\.selected\.removeAll\(\)/);
});

test("rejects invalid Shell Edge Bridge endpoints before native mutation", async () => {
  let mutations = 0;
  const edge = { id: "17e1", curveType: "Line", line: true, circle: false, lengthMm: 10, centerMm: [0, 0, 5] as [number, number, number], tangent: [0, 0, 1] as [number, number, number], boundsMm: { min: [0, 0, 0] as [number, number, number], max: [0, 0, 10] as [number, number, number] }, faceIds: ["17f1"], vertexIds: [101, 102] };
  const solid = { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: null, faceIds: ["17f1"], edgeIds: [edge.id], faces: [], edges: [edge], vertices: [
    { id: 101, positionMm: [0, 0, 0] as [number, number, number], edgeIds: [edge.id], faceIds: edge.faceIds },
    { id: 102, positionMm: [0, 0, 10] as [number, number, number], edgeIds: [edge.id], faceIds: edge.faceIds },
  ] };
  const secondEdge = { ...edge, id: "18e1", vertexIds: [201, 202] };
  const second = { ...solid, id: 8, versionId: 18, edgeIds: [secondEdge.id], edges: [secondEdge], vertices: [
    { id: 201, positionMm: [20, 0, 0] as [number, number, number], edgeIds: [secondEdge.id], faceIds: secondEdge.faceIds },
    { id: 202, positionMm: [20, 0, 10] as [number, number, number], edgeIds: [secondEdge.id], faceIds: secondEdge.faceIds },
  ] };
  const wire = { ...second, id: 9, versionId: 19, type: "Wire" };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision: "r1", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [solid, second, wire] };
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const first = { bodyId: 7, edgeId: "17e1", vertexId: 101 };
  const validSecond = { bodyId: 8, edgeId: "18e1", vertexId: 201 };

  await assert.rejects(operations.bridgeShellEdges(first, validSecond, "G2", "G2", "old"), /stale reference/i);
  await assert.rejects(operations.bridgeShellEdges(first, { bodyId: 8, edgeId: "missing", vertexId: 201 }, "G2", "G2", "r1"), /unknown current edge/i);
  await assert.rejects(operations.bridgeShellEdges(first, first, "G2", "G2", "r1"), /different source edges/i);
  await assert.rejects(operations.bridgeShellEdges(first, { ...validSecond, vertexId: 999 }, "G2", "G2", "r1"), /not an endpoint/i);
  await assert.rejects(operations.bridgeShellEdges(first, { bodyId: 9, edgeId: "18e1", vertexId: 201 }, "G2", "G2", "r1"), /Solid or Sheet/i);
  const coincident = state.bodies[1]!.vertices![0]!;
  coincident.positionMm = [0, 0, 0];
  await assert.rejects(operations.bridgeShellEdges(first, validSecond, "G2", "G2", "r1"), /endpoints must be distinct/i);
  assert.equal(mutations, 0);
});

test("bridges exact open Wire vertices with native continuity", async () => {
  let call: { source: string; bindings: string[]; values: unknown[] } | undefined;
  const bodies = [
    { id: 7, versionId: 17, type: "Wire", name: "First", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [] },
    { id: 8, versionId: 18, type: "Wire", name: "Second", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [] },
  ];
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision: "r1", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies };
  const vertices = [
    { id: "7:101", bodyId: 7, bodyVersionId: 17, vertexId: 101, viewVersionId: "17v101", measurementSource: "native-brep", positionMm: [10, 0, 0] as [number, number, number], endpoint: true, adjacentEdgeEntityIds: [1001] },
    { id: "8:201", bodyId: 8, bodyVersionId: 18, vertexId: 201, viewVersionId: "18v201", measurementSource: "native-brep", positionMm: [20, 10, 0] as [number, number, number], endpoint: true, adjacentEdgeEntityIds: [2001] },
  ];
  const runtime = {
    async getState() { return state; },
    async readNative() { return vertices; },
    async mutate(source: string, bindings: string[], values: unknown[]) { call = { source, bindings, values }; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const first = { bodyId: 7, vertexId: 101 };
  const second = { bodyId: 8, vertexId: 201 };

  await operations.bridgeCurveVertices(first, second, "G1", "G3", state.revision);

  assert.deepEqual(call?.bindings, ["BridgeVertexFactory", "BridgeVertexCommand", "ContinuityType"]);
  assert.deepEqual(call?.values, [{ first, second, firstPosition: [0.01, 0, 0], secondPosition: [0.02, 0.01, 0], startContinuity: "G1", endContinuity: "G3" }]);
  assert.match(call?.source ?? "", /factory\.vertex1 = vertex\(args\.first\)/);
  assert.match(call?.source ?? "", /matches\(factory\.startPosition, args\.firstPosition\)/);
  assert.match(call?.source ?? "", /factory\.startCurvature = Continuity\[args\.startContinuity\]/);
  assert.match(call?.source ?? "", /factory\.lockDistances = true/);
  assert.match(call?.source ?? "", /selection\.selected\.removeAll\(\)/);
});

test("rejects invalid Curve Vertex Bridge endpoints before native mutation", async () => {
  let mutations = 0;
  let vertices = [
    { id: "7:101", bodyId: 7, bodyVersionId: 17, vertexId: 101, viewVersionId: "17v101", measurementSource: "native-brep", positionMm: [0, 0, 0] as [number, number, number], endpoint: true, adjacentEdgeEntityIds: [1001] },
    { id: "8:201", bodyId: 8, bodyVersionId: 18, vertexId: 201, viewVersionId: "18v201", measurementSource: "native-brep", positionMm: [20, 0, 0] as [number, number, number], endpoint: true, adjacentEdgeEntityIds: [2001] },
  ];
  const wire = { id: 7, versionId: 17, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [] };
  const second = { ...wire, id: 8, versionId: 18 };
  const solid = { ...wire, id: 9, versionId: 19, type: "Solid" };
  const state: RuntimeState = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision: "r1", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: emptyConstruction, regions: [], bodies: [wire, second, solid] };
  const runtime = { async getState() { return state; }, async readNative() { return vertices; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const first = { bodyId: 7, vertexId: 101 };
  const validSecond = { bodyId: 8, vertexId: 201 };

  await assert.rejects(operations.bridgeCurveVertices(first, validSecond, "G2", "G2", "old"), /stale reference/i);
  await assert.rejects(operations.bridgeCurveVertices(first, first, "G2", "G2", "r1"), /references must be different/i);
  await assert.rejects(operations.bridgeCurveVertices(first, { bodyId: 10, vertexId: 201 }, "G2", "G2", "r1"), /unknown current/i);
  await assert.rejects(operations.bridgeCurveVertices(first, { bodyId: 9, vertexId: 201 }, "G2", "G2", "r1"), /current Wire/i);
  await assert.rejects(operations.bridgeCurveVertices(first, { ...validSecond, vertexId: 999 }, "G2", "G2", "r1"), /unknown Curve Vertex Bridge vertex/i);
  vertices = [{ ...vertices[0]!, endpoint: false }, vertices[1]!];
  await assert.rejects(operations.bridgeCurveVertices(first, validSecond, "G2", "G2", "r1"), /open Wire endpoint/i);
  vertices = [{ ...vertices[0]!, endpoint: true }, { ...vertices[1]!, positionMm: [0, 0, 0] }];
  await assert.rejects(operations.bridgeCurveVertices(first, validSecond, "G2", "G2", "r1"), /endpoints must be distinct/i);
  assert.equal(mutations, 0);
});

test("creates exact three-point rectangles in world and plane-local coordinates", async () => {
  const world = planeLocalOperations();
  await world.operations.createRectangle(
    [10, 20, 30],
    40,
    20,
    "r1",
    [0, 0, 1],
    [1, 0, 0],
    undefined,
    90,
  );
  const worldArguments = world.argumentsSeen() as Array<{ p1: number[]; p2: number[]; p3: number[] }>;
  assert.deepEqual(worldArguments.map(({ p1, p2, p3 }) => ({
    p1: p1.map((value) => Math.abs(value) < 1e-12 ? 0 : value),
    p2: p2.map((value) => Math.abs(value) < 1e-12 ? 0 : value),
    p3: p3.map((value) => Math.abs(value) < 1e-12 ? 0 : value),
  })), [{
    p1: [0.02, 0, 0.03],
    p2: [0.02, 0.04, 0.03],
    p3: [0, 0.04, 0.03],
  }]);
  assert.match(world.sourceSeen() ?? "", /ThreePointRectangleCommand/);

  const local = planeLocalOperations();
  const plane = (await local.operations.listConstructionGeometry()).planes.find((candidate) => candidate.id === "plane:7")!;
  await local.operations.createRectangle([5, 7], 4, 2, "r1", undefined, undefined, plane.identity);
  assert.deepEqual(local.argumentsSeen(), [{
    p1: [0.01, 0.023, 0.036],
    p2: [0.01, 0.027, 0.036],
    p3: [0.01, 0.027, 0.038],
  }]);
});

test("rejects invalid rectangle dimensions and parallel world axes before mutation", async () => {
  const invalidSize = planeLocalOperations();
  await assert.rejects(
    invalidSize.operations.createRectangle([0, 0, 0], 0, 10, "r1"),
    /width.*positive/i,
  );
  assert.equal(invalidSize.argumentsSeen(), undefined);

  const parallel = planeLocalOperations();
  await assert.rejects(
    parallel.operations.createRectangle([0, 0, 0], 10, 10, "r1", [0, 0, 1], [0, 0, 2]),
    /parallel/i,
  );
  assert.equal(parallel.argumentsSeen(), undefined);
});

test("creates native text outlines with one unit conversion and an explicit planar frame", async () => {
  const world = planeLocalOperations();
  await world.operations.createText({
    text: "M5",
    fontSizeMm: 10,
    originMm: [20, 30, 40],
    font: "inter",
    name: "Fastener label",
    revision: "r1",
    normal: [1, 0, 0],
    xDirection: [0, 1, 0],
  });
  assert.deepEqual(world.argumentsSeen(), [{
    text: "M5",
    font: "inter",
    size: 0.01,
    origin: [0.02, 0.03, 0.04],
    x: [0, 1, 0],
    y: [0, 0, 1],
    z: [1, 0, 0],
    rotate: true,
    move: true,
    name: "Fastener label",
  }]);
  assert.match(world.sourceSeen() ?? "", /new TextFactory\(editor\)/);
  assert.match(world.sourceSeen() ?? "", /new RotateFactory\(editor\)/);
  assert.match(world.sourceSeen() ?? "", /new MoveFactory\(editor\)/);

  const local = planeLocalOperations();
  const plane = (await local.operations.listConstructionGeometry()).planes.find((candidate) => candidate.id === "plane:7")!;
  await local.operations.createText({ text: "A", fontSizeMm: 5, originMm: [5, 7], revision: "r1", plane: plane.identity });
  assert.deepEqual(local.argumentsSeen(), [{
    text: "A",
    font: "inter",
    size: 0.005,
    origin: [0.01, 0.025, 0.037],
    x: [0, 1, 0],
    y: [0, 0, 1],
    z: [1, 0, 0],
    rotate: true,
    move: true,
    name: null,
  }]);
});

test("rejects empty text, invalid font size, and parallel text axes before mutation", async () => {
  const empty = planeLocalOperations();
  await assert.rejects(empty.operations.createText({ text: " ", fontSizeMm: 5, originMm: [0, 0, 0], revision: "r1" }), /text.*nonempty/i);
  assert.equal(empty.argumentsSeen(), undefined);

  const invalidSize = planeLocalOperations();
  await assert.rejects(invalidSize.operations.createText({ text: "A", fontSizeMm: 0, originMm: [0, 0, 0], revision: "r1" }), /font size.*positive/i);
  assert.equal(invalidSize.argumentsSeen(), undefined);

  const parallel = planeLocalOperations();
  await assert.rejects(parallel.operations.createText({
    text: "A", fontSizeMm: 5, originMm: [0, 0, 0], revision: "r1", normal: [0, 0, 1], xDirection: [0, 0, 1],
  }), /parallel/i);
  assert.equal(parallel.argumentsSeen(), undefined);
});

function constructionOperations(): { operations: PlasticityOperations; wasMutated: () => boolean } {
  let mutated = false;
  const top = {
    id: "standard:top",
    nativeId: "top",
    name: "Top",
    source: "standard" as const,
    ...frameFromOriginNormalX([0, 0, 0], [0, 0, 1], [1, 0, 0]),
  };
  const state: RuntimeState = {
    targetId: "window-1",
    title: "Untitled - Plasticity",
    documentToken: "doc-1",
    revision: "r1",
    dbVersion: 1,
    undoDepth: 0,
    redoDepth: 0,
    regions: [],
    construction: { planes: [top], activePlaneId: top.id, planeStateToken: "p1", viewStateToken: "v1" },
    bodies: [],
  };
  const runtime = {
    getCapabilities() { return []; },
    async getState() { return state; },
    async mutate() { mutated = true; return {}; },
  } as unknown as PlasticityRuntime;
  return { operations: new PlasticityOperations(runtime, "session-1"), wasMutated: () => mutated };
}

function planeLocalOperations(bodies: RuntimeState["bodies"] = []): { operations: PlasticityOperations; argumentsSeen: () => unknown[] | undefined; sourceSeen: () => string | undefined } {
  let seen: unknown[] | undefined;
  let source: string | undefined;
  const plane = {
    id: "plane:7", nativeId: "7", name: "Local", source: "saved" as const,
    ...frameFromOriginNormalX([10, 20, 30], [1, 0, 0], [0, 1, 0]),
  };
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision: "r1",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [],
    construction: { planes: [plane], activePlaneId: plane.id, planeStateToken: "p1", viewStateToken: "v1" }, bodies,
  };
  const runtime = {
    getCapabilities() { return []; }, async getState() { return state; },
    async mutate(nativeSource: string, _bindings: string[], values: unknown[]) { source = nativeSource; seen = values; return {}; },
  } as unknown as PlasticityRuntime;
  return { operations: new PlasticityOperations(runtime, "session-1"), argumentsSeen: () => seen, sourceSeen: () => source };
}
