import assert from "node:assert/strict";
import { test } from "node:test";
import { parseIsolatedLaunchArgs } from "./start-plasticity-isolated.ts";

test("isolated launcher requires an explicit absolute bundle path for a selected copy", () => {
  assert.deepEqual(parseIsolatedLaunchArgs([]), { help: false });
  assert.deepEqual(parseIsolatedLaunchArgs(["--help"]), { help: true });
  assert.deepEqual(parseIsolatedLaunchArgs(["--application", "/tmp/Experimental/Plasticity.app"]), { help: false, applicationPath: "/tmp/Experimental/Plasticity.app" });
  for (const args of [["--application"], ["--application", "Plasticity.app"], ["--application", "/tmp/program"], ["--application", "/tmp/First.app", "--application", "/tmp/Second.app"], ["--patch-fuses"]]) {
    assert.throws(() => parseIsolatedLaunchArgs(args));
  }
});
