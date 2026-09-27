import assert from "node:assert/strict";
import { test } from "node:test";

import { degreesToRadians, millimetersToMeters, metersToMillimeters } from "./units.ts";

test("converts public millimeters to Plasticity meters", () => {
  assert.equal(millimetersToMeters(80), 0.08);
  assert.equal(metersToMillimeters(0.008), 8);
});

test("converts degrees to radians", () => {
  assert.equal(degreesToRadians(180), Math.PI);
});

test("rejects non-finite dimensions", () => {
  assert.throws(() => millimetersToMeters(Number.NaN), /finite/i);
});
