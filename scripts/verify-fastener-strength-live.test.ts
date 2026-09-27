import assert from "node:assert/strict";
import test from "node:test";

import { parseFastenerAcceptanceArgs } from "./verify-fastener-strength-live.ts";

test("fastener acceptance is inert by default and requires explicit mutation inputs", () => {
  assert.deepEqual(parseFastenerAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
  assert.throws(() => parseFastenerAcceptanceArgs(["--target", "window"]), /allow-disposable-mutations/);
  assert.throws(() => parseFastenerAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /output/);
  assert.deepEqual(parseFastenerAcceptanceArgs([
    "--target", "window", "--allow-disposable-mutations", "--output", "/tmp/new-fastener-run",
  ]), { help: false, target: "window", allowDisposableMutations: true, output: "/tmp/new-fastener-run" });
});
