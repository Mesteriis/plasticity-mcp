import assert from "node:assert/strict";
import { test } from "node:test";

import { boundsMatch, parseScreenshotAcceptanceArgs } from "./verify-screenshot-live.ts";

test("screenshot acceptance help is read-only", () => {
  assert.deepEqual(parseScreenshotAcceptanceArgs([]), { help: true, testSolid: false });
  assert.deepEqual(parseScreenshotAcceptanceArgs(["--help"]), { help: true, testSolid: false });
});

test("live screenshot acceptance requires an explicit target and new output directory", () => {
  assert.throws(() => parseScreenshotAcceptanceArgs(["--target", "window-1"]), /--output/);
  assert.throws(() => parseScreenshotAcceptanceArgs(["--output", "/tmp/new"]), /--target/);
  assert.deepEqual(parseScreenshotAcceptanceArgs(["--target", "window-1", "--output", "/tmp/new"]), {
    help: false,
    target: "window-1",
    output: "/tmp/new",
    testSolid: false,
  });
  assert.equal(parseScreenshotAcceptanceArgs(["--target", "window-1", "--output", "/tmp/new", "--test-solid"]).testSolid, true);
  assert.throws(() => parseScreenshotAcceptanceArgs(["--unknown"]), /Unknown argument/);
});

test("screenshot acceptance verifies the native Solid bounds before capture", () => {
  assert.equal(boundsMatch({ min: [0, 0, 0], max: [20.005, 10, 5] }, [20, 10, 5]), true);
  assert.equal(boundsMatch({ min: [0, 0, 0], max: [20.02, 10, 5] }, [20, 10, 5]), false);
});
