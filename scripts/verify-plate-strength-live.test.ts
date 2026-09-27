import assert from "node:assert/strict";
import test from "node:test";

import { parsePlateAcceptanceArgs } from "./verify-plate-strength-live.ts";

test("help and default modes cannot enable live plate work", () => {
  assert.deepEqual(parsePlateAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
  assert.equal(parsePlateAcceptanceArgs(["--help"]).help, true);
});

test("live plate acceptance requires an explicit target, mutation acknowledgement and output", () => {
  assert.throws(() => parsePlateAcceptanceArgs(["--target", "window", "--output", "/tmp/new"]), /allow-disposable-mutations/i);
  assert.throws(() => parsePlateAcceptanceArgs(["--allow-disposable-mutations", "--output", "/tmp/new"]), /target/i);
  assert.throws(() => parsePlateAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /output/i);
  assert.deepEqual(parsePlateAcceptanceArgs([
    "--target", "window-1",
    "--allow-disposable-mutations",
    "--output", "/tmp/new-output",
  ]), {
    help: false,
    target: "window-1",
    allowDisposableMutations: true,
    output: "/tmp/new-output",
  });
});

test("unknown and incomplete plate acceptance arguments are rejected", () => {
  assert.throws(() => parsePlateAcceptanceArgs(["--target"]), /requires/i);
  assert.throws(() => parsePlateAcceptanceArgs(["--unknown"]), /unknown/i);
});
