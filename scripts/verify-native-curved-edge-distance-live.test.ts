import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCurvedEdgeDistanceArgs } from "./verify-native-curved-edge-distance-live.ts";

test("curved-edge distance live acceptance is inert by default and requires explicit mutation guards", () => {
  assert.deepEqual(parseCurvedEdgeDistanceArgs([]), { help: true, allowDisposableMutations: false });
  assert.deepEqual(parseCurvedEdgeDistanceArgs(["--help"]), { help: true, allowDisposableMutations: false });
  assert.throws(() => parseCurvedEdgeDistanceArgs(["--allow-disposable-mutations", "--output", "/tmp/out"]), /explicit --target/);
  assert.throws(() => parseCurvedEdgeDistanceArgs(["--target", "window-1", "--output", "/tmp/out"]), /--allow-disposable-mutations/);
  assert.throws(() => parseCurvedEdgeDistanceArgs(["--target", "window-1", "--allow-disposable-mutations"]), /--output/);
  assert.deepEqual(parseCurvedEdgeDistanceArgs(["--target", "window-1", "--allow-disposable-mutations", "--output", "/tmp/out"]), {
    help: false, target: "window-1", allowDisposableMutations: true, output: "/tmp/out",
  });
});
