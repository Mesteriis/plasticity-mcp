import assert from "node:assert/strict";
import test from "node:test";

import { parseFastenerGroupAcceptanceArgs } from "./verify-fastener-group-live.ts";

test("fastener-group acceptance is read-only unless all live mutation flags are explicit", () => {
  assert.deepEqual(parseFastenerGroupAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
  assert.throws(() => parseFastenerGroupAcceptanceArgs(["--target", "window"]), /allow-disposable-mutations/u);
  assert.throws(() => parseFastenerGroupAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/u);
  assert.deepEqual(parseFastenerGroupAcceptanceArgs([
    "--target", "window", "--allow-disposable-mutations", "--output", "/tmp/new-output",
  ]), {
    help: false,
    target: "window",
    allowDisposableMutations: true,
    output: "/tmp/new-output",
  });
});
