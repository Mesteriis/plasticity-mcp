import assert from "node:assert/strict";
import { test } from "node:test";

import { getReference3mfFixtureExpectation, parseReference3mfAcceptanceArgs, validateReference3mfFixtureSource } from "./verify-reference-3mf-import-live.ts";

const localArgs = ["--target", "window-1", "--allow-disposable-mutations", "--output", "/tmp/evidence"];

test("reference 3MF acceptance is inert without arguments or with help", () => {
  assert.deepEqual(parseReference3mfAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
  assert.deepEqual(parseReference3mfAcceptanceArgs(["--help"]), { help: true, allowDisposableMutations: false });
});

test("reference 3MF acceptance requires an explicit disposable window and output directory", () => {
  assert.throws(() => parseReference3mfAcceptanceArgs(["--target", "window-1"]), /allow-disposable-mutations/);
  assert.throws(() => parseReference3mfAcceptanceArgs(["--allow-disposable-mutations", "--output", "/tmp/evidence"]), /target/);
  assert.throws(() => parseReference3mfAcceptanceArgs(["--target", "window-1", "--allow-disposable-mutations"]), /output/);
  assert.deepEqual(parseReference3mfAcceptanceArgs(localArgs), {
    help: false, target: "window-1", output: "/tmp/evidence", allowDisposableMutations: true,
  });
});

test("remote reference import requires a paired HTTPS asset, page and reviewed license", () => {
  const remoteArgs = [...localArgs, "--source-fixture", "unit-meters", "--source-url", "https://raw.githubusercontent.com/Ghostkeeper/SlicerTestModels/master/3mf/unit_meters.3mf", "--source-page-url", "https://github.com/Ghostkeeper/SlicerTestModels/tree/master/3mf", "--license", "CC0-1.0"];
  assert.deepEqual(parseReference3mfAcceptanceArgs(remoteArgs), {
    help: false, target: "window-1", output: "/tmp/evidence", allowDisposableMutations: true,
    sourceFixture: "unit-meters", sourceUrl: "https://raw.githubusercontent.com/Ghostkeeper/SlicerTestModels/master/3mf/unit_meters.3mf", sourcePageUrl: "https://github.com/Ghostkeeper/SlicerTestModels/tree/master/3mf", license: "CC0-1.0",
  });
  assert.throws(() => parseReference3mfAcceptanceArgs([...localArgs, "--source-url", "https://example.test/cube.3mf"]), /both --source-url and --source-page-url/);
  assert.throws(() => parseReference3mfAcceptanceArgs([...localArgs, "--source-url", "https://example.test/cube.3mf", "--source-page-url", "https://example.test/models/cube"]), /--license/);
  assert.throws(() => parseReference3mfAcceptanceArgs([...localArgs, "--source-url", "http://example.test/cube.3mf", "--source-page-url", "https://example.test/models/cube", "--license", "CC0-1.0"]), /must use HTTPS/);
  assert.throws(() => parseReference3mfAcceptanceArgs([...localArgs, "--source-url", "https://user:pass@example.test/cube.3mf", "--source-page-url", "https://example.test/models/cube", "--license", "CC0-1.0"]), /without embedded credentials/);
  assert.throws(() => parseReference3mfAcceptanceArgs([...localArgs, "--source-url", "https://[invalid/cube.3mf", "--source-page-url", "https://example.test/models/cube", "--license", "CC0-1.0"]), /valid HTTPS URL/);
  assert.throws(() => parseReference3mfAcceptanceArgs([...localArgs, "--source-fixture", "multi-mesh"]), /requires --source-url/);
  assert.throws(() => parseReference3mfAcceptanceArgs([...localArgs, "--source-fixture", "unknown"]), /must be one of/);
});

test("remote 3MF fixture expectations cover single-mesh unit conversion and multi-mesh files", () => {
  assert.deepEqual(getReference3mfFixtureExpectation("unit-meters"), [
    { boundsMinMm: [0, 0, 0], boundsMaxMm: [10, 20, 30], vertexEntries: 8, triangles: 12 },
  ]);
  assert.deepEqual(getReference3mfFixtureExpectation("multi-mesh"), [
    { boundsMinMm: [0, 0, 0], boundsMaxMm: [20, 10, 10], vertexEntries: 12, triangles: 4 },
    { boundsMinMm: [0, 0, 0], boundsMaxMm: [20, 10, 10], vertexEntries: 24, triangles: 8 },
  ]);
  assert.doesNotThrow(() => validateReference3mfFixtureSource("multi-mesh", "https://raw.githubusercontent.com/Ghostkeeper/SlicerTestModels/master/3mf/everything.3mf", "https://github.com/Ghostkeeper/SlicerTestModels/tree/master/3mf"));
  assert.throws(() => validateReference3mfFixtureSource("multi-mesh", "https://raw.githubusercontent.com/Ghostkeeper/SlicerTestModels/master/3mf/unit_meters.3mf", "https://github.com/Ghostkeeper/SlicerTestModels/tree/master/3mf"), /selected multi-mesh/);
  assert.throws(() => validateReference3mfFixtureSource("multi-mesh", "https://raw.githubusercontent.com/other/repo/master/3mf/everything.3mf", "https://github.com/Ghostkeeper/SlicerTestModels/tree/master/3mf"), /selected multi-mesh/);
  assert.throws(() => validateReference3mfFixtureSource("multi-mesh", "https://raw.githubusercontent.com/Ghostkeeper/SlicerTestModels/master/3mf/everything.3mf", "https://github.com/other/repo"), /source page/);
});

test("reference 3MF acceptance rejects unknown and incomplete options", () => {
  assert.throws(() => parseReference3mfAcceptanceArgs(["--bogus"]), /Unknown argument/);
  assert.throws(() => parseReference3mfAcceptanceArgs(["--target"]), /requires a value/);
  assert.throws(() => parseReference3mfAcceptanceArgs([...localArgs, "--license"]), /requires a value/);
});

test("3MF empty-scene guard includes annotations, section analyses and non-root groups", async () => {
  const { requireSceneEmpty } = await import("./verify-reference-3mf-import-live.ts");
  const empty = { bodies: [], regions: [], groups: [{ id: 0 }] };
  assert.equal(requireSceneEmpty(empty), true);
  for (const field of ["bodies", "regions", "instances", "referenceMeshes", "measurements", "sectionAnalyses"]) {
    assert.equal(requireSceneEmpty({ ...empty, [field]: [{ id: 1 }] }), false, field);
  }
  assert.equal(requireSceneEmpty({ ...empty, groups: [{ id: 0 }, { id: 1 }] }), false);
});

test("3MF verifier stops recovery mutations for unknown timeout and disconnect outcomes", async () => {
  const { reference3mfFailureNeedsReconcile } = await import("./verify-reference-3mf-import-live.ts");
  for (const message of ["CDP request timed out: Runtime.callFunctionOn", "MCP error: timeout", "Previous mutation outcome is uncertain", "CDP connection closed before the request completed"]) {
    assert.equal(reference3mfFailureNeedsReconcile(new Error(message)), true);
  }
  assert.equal(reference3mfFailureNeedsReconcile(new Error("3MF unit provenance was not retained")), false);
});

test("local 3MF fixtures encode embedded units and two independently placed meshes", async () => {
  const { referenceCube3mf } = await import("./verify-reference-3mf-import-live.ts");
  const { validateReferenceThreeMfArchive } = await import("../src/plasticity/three-mf.ts");
  for (const fixture of ["millimeter", "meter", "two-meshes"] as const) {
    const parsed = validateReferenceThreeMfArchive(referenceCube3mf(fixture));
    const count = fixture === "two-meshes" ? 2 : 1;
    assert.equal(parsed.modelUnit, fixture === "meter" ? "meter" : "millimeter");
    assert.equal(parsed.objects, count);
    assert.equal(parsed.buildItems, count);
    assert.equal(parsed.vertices, 8 * count);
    assert.equal(parsed.triangles, 12 * count);
    assert.deepEqual(parsed.boundsMm, { min: [0, 0, 0], max: [count === 2 ? 14 : 4, 4, 4], size: [count === 2 ? 14 : 4, 4, 4] });
  }
  assert.equal(parseReference3mfAcceptanceArgs([...localArgs, "--local-fixture", "meter"]).localFixture, "meter");
  assert.throws(() => parseReference3mfAcceptanceArgs([...localArgs, "--local-fixture", "unknown"]), /--local-fixture must/);
  assert.throws(() => parseReference3mfAcceptanceArgs([...localArgs, "--local-fixture", "meter", "--source-url", "https://example.test/model.3mf", "--source-page-url", "https://example.test/models", "--license", "synthetic"]), /cannot be combined/);
});
