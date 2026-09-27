import assert from "node:assert/strict";
import test from "node:test";

import { calculateSingleFastener } from "./fastener-calculate.ts";
import { fastenerScenarioFixture as fixture } from "./fastener-fixtures.test.ts";

test("single-fastener calculation checks bearing, shear-out and net tension", () => {
  const result = calculateSingleFastener(fixture());
  assert.equal(result.status, "pass");
  assert.deepEqual(result.stressMPa, {
    bearing: 10,
    shearOut: 100 / 30,
    netTension: 2.5,
  });
  assert.deepEqual(result.utilization, {
    bearing: 0.1,
    shearOut: 1 / 15,
    netTension: 0.05,
  });
  assert.deepEqual(result.geometryRatios, { edgeDistanceToDiameter: 2, widthToDiameter: 5 });
});

test("single-fastener method treats short edge distance deliberately", () => {
  const conditional = calculateSingleFastener(fixture({ loadedEdgeDistanceMm: 8 }));
  assert.equal(conditional.status, "conditional");
  assert.ok(conditional.issues.some((issue) => issue.code === "EDGE_DISTANCE_BELOW_NOMINAL"));

  const unsupported = calculateSingleFastener(fixture({ loadedEdgeDistanceMm: 7 }));
  assert.equal(unsupported.status, "unsupported");
  assert.ok(unsupported.issues.some((issue) => issue.code === "EDGE_DISTANCE_OUTSIDE_METHOD_LIMIT"));
});

test("single-fastener method reports each failed limit", () => {
  const input = fixture();
  input.material = {
    ...input.material,
    bearingLimitMPa: 8,
    shearLimitMPa: 4,
    tensileLimitMPa: 4,
  };
  for (const [path, value] of [
    ["material.bearingLimitMPa", 8],
    ["material.shearLimitMPa", 4],
    ["material.tensileLimitMPa", 4],
  ] as const) {
    const item = input.evidence.find((candidate) => candidate.id === input.assignments[path]);
    assert.ok(item);
    item.value = value;
  }
  const result = calculateSingleFastener(input);
  assert.equal(result.status, "fail");
  assert.deepEqual(
    result.issues.filter((issue) => issue.code.endsWith("LIMIT_EXCEEDED")).map((issue) => issue.code).sort(),
    ["BEARING_LIMIT_EXCEEDED", "NET_TENSION_LIMIT_EXCEEDED", "SHEAR_OUT_LIMIT_EXCEEDED"],
  );
});

test("single-fastener method requires assigned sourced or measured material limits", () => {
  const input = fixture();
  const bearing = input.evidence.find((item) => item.id === input.assignments["material.bearingLimitMPa"]);
  assert.ok(bearing);
  bearing.status = "assumed";
  const result = calculateSingleFastener(input);
  assert.equal(result.status, "needs-input");
  assert.ok(result.issues.some((issue) => issue.code === "MATERIAL_LIMIT_EVIDENCE_REQUIRED"));
});
