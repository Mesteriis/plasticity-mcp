import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "./verify-interface-tensile-csv-live.ts";

test("interface CSV stdio acceptance is inert by default", () => {
  assert.deepEqual(parseArgs([]), { help: true, allowLive: false });
  assert.equal(parseArgs(["--help"]).help, true);
});

test("interface CSV stdio acceptance requires an explicit process guard and new output directory", () => {
  assert.throws(() => parseArgs(["--output", "/tmp/run"]), /--allow-live/u);
  assert.throws(() => parseArgs(["--allow-live"]), /--output/u);
  assert.throws(() => parseArgs(["--allow-live", "--output", "relative/run"]), /absolute/u);
  assert.deepEqual(parseArgs(["--allow-live", "--output", "/tmp/run"]), {
    help: false,
    allowLive: true,
    output: "/tmp/run",
  });
});

test("interface CSV stdio acceptance rejects unknown and incomplete arguments", () => {
  assert.throws(() => parseArgs(["--mystery"]), /Unknown argument/u);
  assert.throws(() => parseArgs(["--allow-live", "--output"]), /requires a value/u);
});
