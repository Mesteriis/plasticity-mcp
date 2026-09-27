import assert from "node:assert/strict";
import test from "node:test";

import { parseCodeAsterTuronDamageSummary } from "./code-aster-turon-runner.ts";

const valid = {
  instant: 1,
  maxDamageV3: 0.998,
  maxStateV5: 1,
  damageHistory: [
    { order: 0, time: 0, maxDamageV3: 0, maxStateV5: 0 },
    { order: 1, time: 0.5, maxDamageV3: 0.4, maxStateV5: 1 },
    { order: 2, time: 1, maxDamageV3: 0.998, maxStateV5: 1 },
  ],
};

test("validates and returns ordered MED-derived mixed-mode damage history", () => {
  const result = parseCodeAsterTuronDamageSummary(valid);
  assert.equal(result.finalTime, 1);
  assert.equal(result.maxDamageV3, 0.998);
  assert.equal(result.maxStateV5, 1);
  assert.equal(result.damageHistory.length, 3);
});

test("rejects an elastic-only or malformed MED result", () => {
  assert.throws(() => parseCodeAsterTuronDamageSummary({
    ...valid,
    maxDamageV3: 0,
    maxStateV5: 0,
    damageHistory: [
      { order: 0, time: 0, maxDamageV3: 0, maxStateV5: 0 },
      { order: 1, time: 1, maxDamageV3: 0, maxStateV5: 0 },
    ],
  }), /did not reach the requested final time with interface damage/);
  assert.throws(() => parseCodeAsterTuronDamageSummary({
    ...valid,
    damageHistory: [valid.damageHistory[0], valid.damageHistory[0]],
  }), /orders must increase strictly/);
  assert.throws(() => parseCodeAsterTuronDamageSummary({
    ...valid,
    damageHistory: [{ order: 0, time: 0, maxDamageV3: Number.NaN, maxStateV5: 0 }],
  }), /invalid shape or step count/);
});
