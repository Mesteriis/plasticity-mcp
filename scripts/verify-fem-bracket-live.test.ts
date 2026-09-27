import assert from "node:assert/strict";
import test from "node:test";

import { parseBracketAcceptanceArgs } from "./verify-fem-bracket-live.ts";

test("bracket FEA live acceptance defaults to inert help", () => {
  assert.deepEqual(parseBracketAcceptanceArgs([]), { help: true, allowMutations: false });
  assert.equal(parseBracketAcceptanceArgs(["--help"]).help, true);
});

test("bracket FEA live acceptance requires an explicit window, mutation guard, and new output directory", () => {
  assert.throws(() => parseBracketAcceptanceArgs(["--target", "window", "--output", "/tmp/new"]), /allow-disposable-mutations/i);
  assert.throws(() => parseBracketAcceptanceArgs(["--allow-disposable-mutations", "--output", "/tmp/new"]), /target/i);
  assert.throws(() => parseBracketAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /output/i);
  assert.deepEqual(parseBracketAcceptanceArgs([
    "--target", "window-1", "--allow-disposable-mutations", "--output", "/tmp/new-output",
  ]), {
    help: false,
    target: "window-1",
    allowMutations: true,
    output: "/tmp/new-output",
  });
});

test("bracket FEA live acceptance rejects unknown and incomplete arguments", () => {
  assert.throws(() => parseBracketAcceptanceArgs(["--target"]), /requires/i);
  assert.throws(() => parseBracketAcceptanceArgs(["--unknown"]), /unknown/i);
});
