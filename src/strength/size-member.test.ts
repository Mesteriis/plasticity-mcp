import assert from "node:assert/strict";
import test from "node:test";

import { sizeMember } from "./size-member.ts";
import { conditionalSyntheticInput, syntheticInput, syntheticPlateInput, withAssignedValue } from "./fixtures.test.ts";

test("unsupported and failed candidates are not recommendations", () => {
  const input = withAssignedValue(syntheticInput("cantilever-tip-rectangle-v1"), "maxDisplacementMm", 0.5);
  const result = sizeMember({ input, heightsMm: [6, 4, 5] });
  assert.deepEqual(result.candidates.map((candidate) => candidate.heightMm), [4, 5, 6]);
  assert.equal(result.recommendedHeightMm, null);
  assert.equal(result.recommendation, "none");
});

test("sizing selects the smallest passing explicit candidate", () => {
  let input = syntheticInput("cantilever-tip-rectangle-v1");
  input = withAssignedValue(input, "lengthMm", 200);
  input = withAssignedValue(input, "widthMm", 20);
  input = withAssignedValue(input, "forceN", 1);
  input = withAssignedValue(input, "material.youngMPa", 2000);
  input = withAssignedValue(input, "maxDisplacementMm", 1);
  const result = sizeMember({ input, heightsMm: [10, 7, 9, 8] });
  assert.deepEqual(result.candidates.map((candidate) => candidate.heightMm), [7, 8, 9, 10]);
  assert.equal(result.recommendedHeightMm, 10);
  assert.equal(result.recommendation, "verified-scheme");
  assert.equal(result.candidates[2]!.result.displacementMm, 800 / 729);
  assert.equal(result.candidates[3]!.result.displacementMm, 0.8);
});

test("an unconfirmed process can only yield a conditional recommendation", () => {
  let input = conditionalSyntheticInput("cantilever-tip-rectangle-v1");
  input = withAssignedValue(input, "lengthMm", 200);
  input = withAssignedValue(input, "widthMm", 20);
  input = withAssignedValue(input, "material.youngMPa", 2000);
  input = withAssignedValue(input, "maxDisplacementMm", 1);
  const result = sizeMember({ input, heightsMm: [9, 10] });
  assert.equal(result.recommendedHeightMm, 10);
  assert.equal(result.recommendation, "conditional");
});

test("all failed axial candidates yield no recommendation", () => {
  const input = withAssignedValue(syntheticInput("axial-rectangle-v1"), "forceN", 10_000);
  const result = sizeMember({ input, heightsMm: [1, 2, 3] });
  assert.equal(result.recommendedHeightMm, null);
  assert.ok(result.candidates.every((candidate) => candidate.result.status === "fail"));
});

test("plate sizing evaluates an explicit finite list of candidate thicknesses", () => {
  const base = syntheticPlateInput();
  const input = {
    ...base,
    maxDisplacementMm: 0.03,
    evidence: base.evidence.map((item) => item.id === "disp" ? { ...item, value: 0.03 } : item),
  };
  const result = sizeMember({ input, heightsMm: [1, 1.5, 2] });
  assert.deepEqual(result.candidates.map((candidate) => candidate.heightMm), [1, 1.5, 2]);
  assert.ok(result.candidates[0]!.result.displacementMm! > result.candidates[1]!.result.displacementMm!);
  assert.ok(result.candidates[1]!.result.displacementMm! > result.candidates[2]!.result.displacementMm!);
  assert.equal(result.recommendedHeightMm, 1.5);
  assert.equal(result.recommendation, "verified-scheme");
});

test("candidate evaluation does not mutate caller evidence", () => {
  const input = syntheticInput("cantilever-tip-rectangle-v1");
  const before = structuredClone(input);
  const result = sizeMember({ input, heightsMm: [5, 10] });
  assert.deepEqual(input, before);
  const heightEvidence = result.candidates[1]!.result.inputHash;
  assert.notEqual(heightEvidence, result.candidates[0]!.result.inputHash);
});

test("sizing rejects invalid candidate lists", () => {
  const input = syntheticInput("axial-rectangle-v1");
  assert.throws(() => sizeMember({ input, heightsMm: [] }), /1.*200/);
  assert.throws(() => sizeMember({ input, heightsMm: [1, 1] }), /unique/);
  assert.throws(() => sizeMember({ input, heightsMm: [0] }), /positive/);
  assert.throws(() => sizeMember({ input, heightsMm: Array.from({ length: 201 }, (_, index) => index + 1) }), /1.*200/);
});
