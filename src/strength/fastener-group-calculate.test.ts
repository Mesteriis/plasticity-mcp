import assert from "node:assert/strict";
import test from "node:test";

import { calculateFastenerGroupLoad } from "./fastener-group-calculate.ts";
import { fastenerGroupFixture } from "./fastener-group-fixtures.test.ts";

test("distributes direct force and eccentric moment across an equal-stiffness group", () => {
  const result = calculateFastenerGroupLoad(fastenerGroupFixture());
  assert.equal(result.status, "calculated");
  assert.deepEqual(result.centroidMm, { x: 0, y: 0 });
  assert.equal(result.totalMomentAboutCentroidNmm, -3_000);
  assert.equal(result.polarSumMm2, 2_000);
  assert.deepEqual(result.directPerFastenerN, { x: 25, y: 0 });
  assert.deepEqual(result.fasteners?.map((item) => ({ id: item.id, x: item.resultantN.x, y: item.resultantN.y })), [
    { id: "A", x: 10, y: 30 },
    { id: "B", x: 10, y: -30 },
    { id: "C", x: 40, y: 30 },
    { id: "D", x: 40, y: -30 },
  ]);
  assert.ok(Math.abs(result.fasteners![0]!.magnitudeN - Math.sqrt(1_000)) < 1e-12);
  assert.ok(Math.abs(result.fasteners![1]!.magnitudeN - Math.sqrt(1_000)) < 1e-12);
  assert.equal(result.fasteners![2]!.magnitudeN, 50);
  assert.equal(result.fasteners![3]!.magnitudeN, 50);
  assert.deepEqual(result.governing, { fastenerId: "C", shearDemandN: 50 });
  assert.ok(result.equilibrium);
  assert.ok(result.equilibrium.forceResidualN < 1e-12);
  assert.ok(result.equilibrium.momentResidualNmm < 1e-12);
  assert.match(result.checkedScope, /load distribution/i);
});

test("checks each fastener shear demand against its own evidence-backed design allowable", () => {
  const input = fastenerGroupFixture();
  input.shearCapacities = input.fasteners.map((fastener, index) => ({
    fastenerId: fastener.id,
    configuration: "M5 class 8.8, unthreaded shank in single shear",
    allowableShearN: index < 2 ? 60 : 40,
  }));
  for (const [index, capacity] of input.shearCapacities.entries()) {
    const evidenceId = `shear-allowable-${capacity.fastenerId}`;
    input.evidence.push({
      id: evidenceId,
      label: `Qualified shear design allowable for ${capacity.fastenerId}`,
      status: "sourced",
      unit: "N",
      value: capacity.allowableShearN,
      sourceUrl: "https://example.test/fastener-data",
      sourceHash: "a".repeat(64),
      sourceLocator: `test-section:${capacity.fastenerId}`,
      dependsOn: [],
    });
    input.assignments[`fastenerShearCapacities.${index}.allowableShearN`] = evidenceId;
  }
  const result = calculateFastenerGroupLoad(input);
  assert.equal(result.status, "calculated");
  assert.equal(result.fastenerShearCheck?.status, "exceeds-allowable");
  assert.deepEqual(result.fastenerShearCheck?.governing, { fastenerId: "C", utilization: 1.25 });
  assert.deepEqual(result.fastenerShearCheck?.fasteners.map((item) => item.utilization), [
    Math.sqrt(1_000) / 60,
    Math.sqrt(1_000) / 60,
    1.25,
    1.25,
  ]);
  assert.match(result.fastenerShearCheck?.checkedScope ?? "", /individual fastener in-plane shear/i);
  assert.ok(result.fastenerShearCheck?.unchecked.includes("plate bearing, tear-out, insert pullout, thread failure and joint-level strength"));
});

test("does not turn a capacity comparison into a pass while the load model remains conditional", () => {
  const input = fastenerGroupFixture();
  input.shearCapacities = input.fasteners.map((fastener) => ({ fastenerId: fastener.id, configuration: "M5 class 8.8", allowableShearN: 100 }));
  for (const [index, capacity] of input.shearCapacities.entries()) {
    const evidenceId = `shear-allowable-${capacity.fastenerId}`;
    input.evidence.push({ id: evidenceId, label: evidenceId, status: "sourced", unit: "N", value: 100, sourceUrl: "https://example.test/fastener-data", sourceHash: "b".repeat(64), sourceLocator: `test:${capacity.fastenerId}`, dependsOn: [] });
    input.assignments[`fastenerShearCapacities.${index}.allowableShearN`] = evidenceId;
  }
  input.assumptions[0]!.confirmed = false;
  const result = calculateFastenerGroupLoad(input);
  assert.equal(result.status, "conditional");
  assert.equal(result.fastenerShearCheck?.status, "conditional");
});

test("keeps a shear comparison conditional when design allowable evidence is only assumed", () => {
  const input = fastenerGroupFixture();
  input.shearCapacities = input.fasteners.map((fastener) => ({ fastenerId: fastener.id, configuration: "M5 class 8.8", allowableShearN: 100 }));
  for (const [index, capacity] of input.shearCapacities.entries()) {
    const evidenceId = `shear-allowable-${capacity.fastenerId}`;
    input.evidence.push({ id: evidenceId, label: evidenceId, status: "assumed", unit: "N", value: 100, derivation: "Unqualified estimate for test only", dependsOn: [] });
    input.assignments[`fastenerShearCapacities.${index}.allowableShearN`] = evidenceId;
  }
  const result = calculateFastenerGroupLoad(input);
  assert.equal(result.status, "needs-input");
  assert.equal(result.fastenerShearCheck?.status, "conditional");
  assert.ok(result.issues.some((issue) => issue.code === "FASTENER_SHEAR_ALLOWABLE_EVIDENCE_REQUIRED"));
});

test("distributes a pure moment with zero direct force", () => {
  const input = fastenerGroupFixture();
  input.load = { forceXN: 0, forceYN: 0, applicationPointXmm: 0, applicationPointYmm: 0, freeMomentNmm: 2_000 };
  for (const [path, value] of Object.entries({
    "load.forceXN": 0,
    "load.applicationPointYmm": 0,
    "load.freeMomentNmm": 2_000,
  })) input.evidence.find((item) => item.id === path)!.value = value;
  const result = calculateFastenerGroupLoad(input);
  assert.equal(result.status, "calculated");
  assert.deepEqual(result.directPerFastenerN, { x: 0, y: 0 });
  assert.equal(result.totalMomentAboutCentroidNmm, 2_000);
  assert.ok(result.equilibrium!.momentResidualNmm < 1e-12);
});

test("does not calculate a group whose transfer points coincide", () => {
  const input = fastenerGroupFixture();
  for (let index = 0; index < input.fasteners.length; index += 1) {
    input.fasteners[index]!.xMm = 0;
    input.fasteners[index]!.yMm = 0;
    input.evidence.find((item) => item.id === `fasteners.${index}.xMm`)!.value = 0;
    input.evidence.find((item) => item.id === `fasteners.${index}.yMm`)!.value = 0;
  }
  const result = calculateFastenerGroupLoad(input);
  assert.equal(result.status, "unsupported");
  assert.equal(result.fasteners, undefined);
  assert.ok(result.issues.some((issue) => issue.code === "ZERO_GROUP_POLAR_SUM"));
});

test("unconfirmed load-model assumptions keep the distribution conditional", () => {
  const input = fastenerGroupFixture();
  input.assumptions = input.assumptions.map((item) => item.code === "rigid-attachment-member" ? { ...item, confirmed: false } : item);
  const result = calculateFastenerGroupLoad(input);
  assert.equal(result.status, "conditional");
  assert.ok(result.issues.some((issue) => issue.code === "ASSUMPTION_UNCONFIRMED"));
});

test("assumed loads stay visible as a conditional result", () => {
  const input = fastenerGroupFixture();
  const evidence = input.evidence.find((item) => item.id === "load.forceXN")!;
  evidence.status = "assumed";
  delete evidence.sourceUrl;
  delete evidence.sourceHash;
  const result = calculateFastenerGroupLoad(input);
  assert.equal(result.status, "conditional");
  assert.ok(result.issues.some((issue) => issue.code === "ASSUMED_LOAD"));
});

test("requires traceable fastener coordinates", () => {
  const input = fastenerGroupFixture();
  const evidence = input.evidence.find((item) => item.id === "fasteners.0.xMm")!;
  evidence.status = "assumed";
  delete evidence.sourceLocator;
  const result = calculateFastenerGroupLoad(input);
  assert.equal(result.status, "needs-input");
  assert.ok(result.issues.some((issue) => issue.code === "FASTENER_POSITION_EVIDENCE_REQUIRED"));
});

test("omits non-finite results after intermediate overflow", () => {
  const input = fastenerGroupFixture();
  input.load.forceXN = Number.MAX_VALUE;
  input.load.applicationPointYmm = Number.MAX_VALUE;
  input.evidence.find((item) => item.id === "load.forceXN")!.value = Number.MAX_VALUE;
  input.evidence.find((item) => item.id === "load.applicationPointYmm")!.value = Number.MAX_VALUE;
  const result = calculateFastenerGroupLoad(input);
  assert.equal(result.status, "unsupported");
  assert.equal(result.fasteners, undefined);
  assert.equal(result.totalMomentAboutCentroidNmm, undefined);
  assert.ok(result.issues.some((issue) => issue.code === "COMPUTATION_OVERFLOW"));
});

test("schema rejects fewer than two fasteners, duplicate IDs and a zero resultant", async () => {
  const { fastenerGroupInputSchema } = await import("./fastener-group-schemas.ts");
  const one = fastenerGroupFixture();
  one.fasteners = one.fasteners.slice(0, 1);
  assert.equal(fastenerGroupInputSchema.safeParse(one).success, false);

  const duplicate = fastenerGroupFixture();
  duplicate.fasteners[1]!.id = "A";
  assert.equal(fastenerGroupInputSchema.safeParse(duplicate).success, false);

  const zero = fastenerGroupFixture();
  zero.load = { forceXN: 0, forceYN: 0, applicationPointXmm: 0, applicationPointYmm: 0, freeMomentNmm: 0 };
  assert.equal(fastenerGroupInputSchema.safeParse(zero).success, false);
});
