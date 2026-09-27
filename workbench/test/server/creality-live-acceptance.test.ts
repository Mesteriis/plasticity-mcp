import assert from "node:assert/strict";
import test from "node:test";

import { parseCrealityPrintLiveArgs } from "../../scripts/verify-creality-print-live.ts";

test("Creality live acceptance defaults to non-mutating help and supports explicit app paths", () => {
  assert.deepEqual(parseCrealityPrintLiveArgs([]), { help: true });
  assert.deepEqual(parseCrealityPrintLiveArgs([
    "--input", "/tmp/box.stl",
    "--output", "/tmp/new-result",
    "--executable", "/Applications/Creality Print.app/Contents/MacOS/CrealityPrint",
    "--resources-root", "/Applications/Creality Print.app/Contents/Resources",
  ]), {
    help: false,
    input: "/tmp/box.stl",
    output: "/tmp/new-result",
    executable: "/Applications/Creality Print.app/Contents/MacOS/CrealityPrint",
    resourcesRoot: "/Applications/Creality Print.app/Contents/Resources",
  });
});

test("Creality live acceptance validates all required paths and rejects unknown options", () => {
  assert.throws(() => parseCrealityPrintLiveArgs(["--input", "/tmp/box.stl"]), /requires --input, --output, --executable, and --resources-root/u);
  assert.throws(() => parseCrealityPrintLiveArgs(["--unknown"]), /Unknown argument/u);
  assert.throws(() => parseCrealityPrintLiveArgs(["--input"]), /requires a path/u);
});

test("Creality live acceptance can take app paths from environment", () => {
  assert.deepEqual(parseCrealityPrintLiveArgs([
    "--input", "/tmp/box.stl",
    "--output", "/tmp/new-result",
  ], {
    CREALITY_PRINT_EXECUTABLE: "/app/CrealityPrint",
    CREALITY_PRINT_RESOURCES_ROOT: "/app/Contents/Resources",
  }), {
    help: false,
    input: "/tmp/box.stl",
    output: "/tmp/new-result",
    executable: "/app/CrealityPrint",
    resourcesRoot: "/app/Contents/Resources",
  });
});
