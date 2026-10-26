import assert from "node:assert/strict";
import test from "node:test";
import { requireWholeHelixTurns } from "./helix-turns.ts";

test("whole-turn Helices normalize arithmetic noise before native creation", () => {
  assert.equal(requireWholeHelixTurns(4), 4);
  assert.equal(requireWholeHelixTurns(0.3 / 0.1), 3);
});

test("fractional, zero and nonfinite native turns fail explicitly", () => {
  for (const turns of [2.5, 0.5, 0, -1, NaN, Infinity, 3.00001]) assert.throws(() => requireWholeHelixTurns(turns), /Fractional Helix turns are unsupported/);
});
