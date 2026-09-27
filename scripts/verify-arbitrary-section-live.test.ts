import assert from "node:assert/strict";
import test from "node:test";

import { parseArbitrarySectionAcceptanceArgs } from "./verify-arbitrary-section-live.ts";

test("arbitrary-section live acceptance defaults to non-mutating help", () => {
  assert.deepEqual(parseArbitrarySectionAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
  assert.equal(parseArbitrarySectionAcceptanceArgs(["--help"]).help, true);
});

test("arbitrary-section live acceptance requires an explicit target, acknowledgement and output", () => {
  assert.throws(() => parseArbitrarySectionAcceptanceArgs(["--target", "window", "--output", "/tmp/new"]), /allow-disposable/i);
  assert.throws(() => parseArbitrarySectionAcceptanceArgs(["--allow-disposable-mutations", "--output", "/tmp/new"]), /target/i);
  assert.throws(() => parseArbitrarySectionAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /output/i);
  assert.deepEqual(parseArbitrarySectionAcceptanceArgs([
    "--target", "window-1",
    "--allow-disposable-mutations",
    "--output", "/tmp/new",
  ]), {
    help: false,
    target: "window-1",
    allowDisposableMutations: true,
    output: "/tmp/new",
  });
});

test("arbitrary-section live acceptance rejects unknown and incomplete arguments", () => {
  assert.throws(() => parseArbitrarySectionAcceptanceArgs(["--target"]), /requires/i);
  assert.throws(() => parseArbitrarySectionAcceptanceArgs(["--unknown"]), /unknown/i);
});
