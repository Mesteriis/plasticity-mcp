import assert from "node:assert/strict";
import test from "node:test";

import { parsePrintedThreadAcceptanceArgs } from "./verify-printed-threads-live.ts";

test("printed-thread acceptance is inert by default and requires explicit mutation inputs", () => {
  assert.deepEqual(parsePrintedThreadAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
  assert.throws(() => parsePrintedThreadAcceptanceArgs(["--target", "window"]), /allow-disposable-mutations/);
  assert.throws(() => parsePrintedThreadAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /output/);
  assert.deepEqual(parsePrintedThreadAcceptanceArgs([
    "--target", "window", "--allow-disposable-mutations", "--output", "/tmp/new",
  ]), { help: false, target: "window", allowDisposableMutations: true, output: "/tmp/new" });
});
