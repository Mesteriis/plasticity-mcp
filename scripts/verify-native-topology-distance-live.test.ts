import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeTopologyDistanceAcceptanceArgs } from "./verify-native-topology-distance-live.ts";

test("topology-distance acceptance defaults to help and requires explicit live guards", () => {
  assert.deepEqual(parseNativeTopologyDistanceAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
  assert.deepEqual(parseNativeTopologyDistanceAcceptanceArgs(["--help"]), { help: true, allowDisposableMutations: false });
  assert.throws(() => parseNativeTopologyDistanceAcceptanceArgs(["--allow-disposable-mutations", "--output", "/tmp/out"]), /--target/);
  assert.throws(() => parseNativeTopologyDistanceAcceptanceArgs(["--target", "window-1", "--output", "/tmp/out"]), /--allow-disposable-mutations/);
  assert.throws(() => parseNativeTopologyDistanceAcceptanceArgs(["--target", "window-1", "--allow-disposable-mutations"]), /--output/);
  assert.deepEqual(parseNativeTopologyDistanceAcceptanceArgs(["--target", "window-1", "--allow-disposable-mutations", "--output", "/tmp/out"]), {
    help: false, target: "window-1", allowDisposableMutations: true, output: "/tmp/out",
  });
});
