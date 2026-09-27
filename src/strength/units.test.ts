import assert from "node:assert/strict";
import test from "node:test";

import { forceAtPointMomentNmm, massToForceEvidence, massToForceN } from "./units.ts";

test("mass conversion requires explicit gravity", () => {
  assert.equal(massToForceN(2, 9.80665), 19.6133);
  assert.throws(() => massToForceN(-1, 9.80665), /mass/i);
  assert.throws(() => massToForceN(1, 0), /gravity/i);
});

test("mass conversion evidence retains both inputs and the derivation", () => {
  const converted = massToForceEvidence("load", "mass", "gravity", 2, 9.80665);
  assert.equal(converted.value, 19.6133);
  assert.equal(converted.unit, "N");
  assert.deepEqual(converted.dependsOn, ["mass", "gravity"]);
  assert.match(converted.derivation!, /mass.*gravity/i);
});

test("force at a millimetre offset produces an Nmm moment vector", () => {
  assert.deepEqual(forceAtPointMomentNmm([2, 0, 0], [0, 10, 0]), [0, 0, 20]);
  assert.throws(() => forceAtPointMomentNmm([Number.MAX_VALUE, 0, 0], [0, Number.MAX_VALUE, 0]), /finite|overflow/i);
});
