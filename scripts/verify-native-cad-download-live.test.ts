import assert from "node:assert/strict";
import test from "node:test";
import { assertCadGeometryUnchanged, assertImportedCadReadback, parseNativeCadDownloadArgs } from "./verify-native-cad-download-live.ts";
const args = ["--target", "disposable", "--allow-disposable-mutations", "--output", "/tmp/evidence", "--fixture", "sample-step"];

test("CAD network qualification is inert by default and requires every live guard", () => {
  assert.deepEqual(parseNativeCadDownloadArgs([]), { help: true, allowDisposableMutations: false });
  assert.equal(parseNativeCadDownloadArgs(["--help"]).help, true);
  assert.equal(parseNativeCadDownloadArgs(args).fixture, "sample-step");
  assert.throws(() => parseNativeCadDownloadArgs(args.slice(2)), /--target/);
  assert.throws(() => parseNativeCadDownloadArgs(args.filter(x => x !== "--allow-disposable-mutations")), /--allow-disposable-mutations/);
  assert.throws(() => parseNativeCadDownloadArgs(args.slice(0, 3)), /--output/);
  assert.throws(() => parseNativeCadDownloadArgs(args.slice(0, 5)), /--fixture/);
});

test("CAD network qualification accepts only explicitly reviewed fixtures", () => {
  assert.equal(parseNativeCadDownloadArgs(args.map(x => x === "sample-step" ? "cube-parasolid" : x)).fixture, "cube-parasolid");
  assert.throws(() => parseNativeCadDownloadArgs(args.map(x => x === "sample-step" ? "unknown" : x)), /--fixture must/);
  assert.throws(() => parseNativeCadDownloadArgs([...args, "--source-url", "https://example.test/model.step"]), /Unknown argument/);
  assert.throws(() => parseNativeCadDownloadArgs(["--fixture"]), /requires a value/);
});

test("CAD download reports are metadata; exact body readback must match document, revision and IDs", () => {
  const report = { documentToken: "doc", revision: "r2", importedBodyCount: 2, importedBodyIds: [7, 8] };
  const state = { documentToken: "doc", revision: "r2", bodies: [{ id: 8 }, { id: 7 }] };
  assert.doesNotThrow(() => assertImportedCadReadback(report, state));
  assert.throws(() => assertImportedCadReadback(report, { ...state, documentToken: "other" }), /switched documents/);
  assert.throws(() => assertImportedCadReadback(report, { ...state, revision: "r3" }), /changed revisions/);
  assert.throws(() => assertImportedCadReadback(report, { ...state, bodies: [{ id: 7 }] }), /body count/);
  assert.throws(() => assertImportedCadReadback(report, { ...state, bodies: [{ id: 7 }, { id: 9 }] }), /body IDs/);
});


test("CAD history comparison tolerates numeric roundoff while rejecting geometric or identity drift", () => {
  const before = { id: 1, faces: 6, edges: 12, vertices: 8, boundsMethod: "native-box", boundsMm: { min: [-10, -20, -10], max: [10, 0, 10] }, volumeMm3: 8000, surfaceAreaMm2: 2400, centroidMm: [0, -10, 0] };
  assert.doesNotThrow(() => assertCadGeometryUnchanged(before, { ...before, volumeMm3: 8000 + 1e-12, centroidMm: [1e-16, -10, 0] }));
  for (const changed of [{ ...before, id: 2 }, { ...before, faces: 7 }, { ...before, boundsMethod: "native-extrema" }, { ...before, volumeMm3: 8000.001 }, { ...before, surfaceAreaMm2: 2400.001 }, { ...before, centroidMm: [0.001, -10, 0] }, { ...before, volumeMm3: NaN }, { ...before, boundsMm: { min: [-10.001, -20, -10], max: [10, 0, 10] } }]) {
    assert.throws(() => assertCadGeometryUnchanged(before, changed));
  }
});
