import assert from "node:assert/strict";
import test from "node:test";

import { parseFastenerPocketAcceptanceArgs } from "./verify-fastener-pockets-live.ts";

test("fastener-pocket acceptance is read-only unless all live mutation flags are explicit", () => {
  assert.deepEqual(parseFastenerPocketAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
  assert.throws(() => parseFastenerPocketAcceptanceArgs(["--target", "window"]), /allow-disposable-mutations/u);
  assert.throws(() => parseFastenerPocketAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/u);
  assert.deepEqual(parseFastenerPocketAcceptanceArgs([
    "--target", "window", "--allow-disposable-mutations", "--output", "/tmp/new-output",
  ]), {
    help: false,
    target: "window",
    allowDisposableMutations: true,
    output: "/tmp/new-output",
  });
});
