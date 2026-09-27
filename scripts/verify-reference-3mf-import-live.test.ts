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
