import assert from "node:assert/strict";
import test from "node:test";

import { analysisRequestSchema, analysisResultSchema, evidenceSchema, materialSchema, strengthInputSchema } from "./schemas.ts";
import { syntheticInput, syntheticPlateInput } from "./fixtures.test.ts";

test("strength input rejects invalid dimensions but accepts a zero force", () => {
  const input = syntheticInput("axial-rectangle-v1");
  assert.equal(strengthInputSchema.safeParse({ ...input, widthMm: -1 }).success, false);
  assert.equal(strengthInputSchema.safeParse({ ...input, lengthMm: Number.POSITIVE_INFINITY }).success, false);
  assert.equal(strengthInputSchema.safeParse({ ...input, forceN: 0, evidence: input.evidence.map((item) => item.id === "force" ? { ...item, value: 0 } : item) }).success, true);
});

test("Euler column inputs require a compressive force and explicit effective length factor", () => {
  const base = syntheticInput("axial-rectangle-v1");
  const forceEvidence = { ...base.evidence.find((item) => item.id === "force")!, value: -1 };
  const input = {
    ...base,
    method: "euler-column-buckling-v1",
    forceN: -1,
    effectiveLengthFactor: 1,
    evidence: [
      ...base.evidence.filter((item) => item.id !== "force"),
      forceEvidence,
      { id: "effective-length", label: "TEST ONLY K", status: "sourced" as const, unit: "ratio" as const, value: 1, sourceUrl: "https://example.invalid/test", sourceLocator: "fixture", dependsOn: [] },
    ],
    assignments: { ...base.assignments, forceN: "force", effectiveLengthFactor: "effective-length" },
  };
  assert.equal(strengthInputSchema.safeParse(input).success, true);
  assert.equal(strengthInputSchema.safeParse({ ...input, forceN: 1, evidence: input.evidence.map((item) => item.id === "force" ? { ...item, value: 1 } : item) }).success, false);
  const { effectiveLengthFactor: _factor, ...withoutFactor } = input;
  assert.equal(strengthInputSchema.safeParse(withoutFactor).success, false);
});

test("evidence ranges are ordered and source URLs are safe", () => {
  const input = syntheticInput("axial-rectangle-v1");
  const base = input.evidence[0]!;
  assert.equal(strengthInputSchema.safeParse({ ...input, evidence: [{ ...base, range: [2, 1] }, ...input.evidence.slice(1)] }).success, false);
  assert.equal(strengthInputSchema.safeParse({ ...input, evidence: [{ ...base, sourceUrl: "file:///etc/passwd" }, ...input.evidence.slice(1)] }).success, false);
});

test("image evidence uses unique one-based view references bounded to four", () => {
  const evidence = { id: "view-fact", label: "Visible mounting face", status: "unknown", dependsOn: [] };
  assert.deepEqual(evidenceSchema.parse({ ...evidence, sourceImageIndices: [1, 4] }).sourceImageIndices, [1, 4]);
  assert.equal(evidenceSchema.safeParse({ ...evidence, sourceImageIndices: [1, 1] }).success, false);
  assert.equal(evidenceSchema.safeParse({ ...evidence, sourceImageIndices: [5] }).success, false);
});

test("schema rejects duplicate, broken and cyclic provenance", () => {
  const input = syntheticInput("axial-rectangle-v1");
  assert.equal(strengthInputSchema.safeParse({ ...input, evidence: [...input.evidence, input.evidence[0]!] }).success, false);
  assert.equal(strengthInputSchema.safeParse({ ...input, evidence: input.evidence.map((item, index) => index === 0 ? { ...item, dependsOn: ["missing"] } : item) }).success, false);
  assert.equal(strengthInputSchema.safeParse({ ...input, evidence: input.evidence.map((item, index) => index === 0 ? { ...item, dependsOn: ["width"] } : index === 1 ? { ...item, dependsOn: ["length"] } : item) }).success, false);
});

test("schema rejects unknown assignment paths and unit or value mismatches", () => {
  const input = syntheticInput("axial-rectangle-v1");
  assert.equal(strengthInputSchema.safeParse({ ...input, assignments: { ...input.assignments, surprise: "length" } }).success, false);
  assert.equal(strengthInputSchema.safeParse({ ...input, assignments: { ...input.assignments, widthMm: "force" } }).success, false);
  assert.equal(strengthInputSchema.safeParse({ ...input, widthMm: 11 }).success, false);
});

test("missing numeric values and unknown evidence remain representable", () => {
  const input = syntheticInput("axial-rectangle-v1");
  const { lengthMm: _length, ...withoutLength } = input;
  const candidate = {
    ...withoutLength,
    evidence: input.evidence.map((item) => item.id === "length" ? { id: item.id, label: item.label, status: "unknown" as const, unit: "mm" as const, dependsOn: [] } : item),
    assignments: Object.fromEntries(Object.entries(input.assignments).filter(([path]) => path !== "lengthMm")),
  };
  assert.equal(strengthInputSchema.safeParse(candidate).success, true);
});

test("section evidence units and optional shear limit remain strict", () => {
  for (const unit of ["Nmm", "mm2", "mm4"] as const) {
    assert.equal(evidenceSchema.safeParse({ id: unit, label: unit, status: "measured", unit, value: 1, dependsOn: [] }).success, true);
  }
  const material = syntheticInput("axial-rectangle-v1").material;
  assert.equal(materialSchema.safeParse({ ...material, shearLimitMPa: 12 }).success, true);
  assert.equal(materialSchema.safeParse({ ...material, shearLimitMPa: 12, surprise: true }).success, false);
});

test("plate schema accepts bounded Poisson ratio and nonnegative pressure", () => {
  const input = syntheticPlateInput();
  assert.equal(strengthInputSchema.safeParse(input).success, true);
  assert.equal(strengthInputSchema.safeParse({ ...input, pressureMPa: -0.001 }).success, false);
  assert.equal(strengthInputSchema.safeParse({ ...input, poissonRatio: 0.5 }).success, false);
  assert.equal(strengthInputSchema.safeParse({ ...input, poissonRatio: -1 }).success, false);
  assert.equal(strengthInputSchema.safeParse({ ...input, forceN: 1 }).success, false);
  const member = syntheticInput("axial-rectangle-v1");
  assert.equal(strengthInputSchema.safeParse({ ...member, pressureMPa: 0.001 }).success, false);
});

test("Codex analysis may ask one next-step question package, but not a later-stage checklist", () => {
  const base = { observations: [], proposedMethod: null, unsupportedConditions: [] };
  assert.equal(analysisResultSchema.safeParse({ ...base, questions: [] }).success, true);
  assert.equal(analysisResultSchema.safeParse({
    ...base,
    questions: [{ id: "q1", question: "What does the bracket support and how is it mounted?", resolves: ["load-path"], reason: "The next decision depends on the load path." }],
  }).success, true);
  assert.equal(analysisResultSchema.safeParse({
    ...base,
    questions: [
      { id: "q1", question: "What load does it carry?", resolves: ["load"], reason: "Load is required." },
      { id: "q2", question: "What is the material?", resolves: ["material"], reason: "Material is required." },
    ],
  }).success, false);
});

test("follow-up answers retain the full prior question for stateless Codex turns", () => {
  const base = { requestId: "follow-up", prompt: "Analyze the same bracket", imagePaths: [], evidence: [] };
  assert.equal(analysisRequestSchema.safeParse({ ...base, answers: [] }).success, true);
  assert.equal(analysisRequestSchema.safeParse({
    ...base,
    answers: [{ questionId: "q1", question: "What does the bracket support?", answer: "I do not know the weight." }],
  }).success, true);
  assert.equal(analysisRequestSchema.safeParse({
    ...base,
    answers: [{ questionId: "q1", answer: "I do not know the weight." }],
  }).success, false);
});

test("analysis requests accept up to four images and reject excess paths before execution", () => {
  const base = { requestId: "multi-view", prompt: "Inspect these views of one part", evidence: [], answers: [] };
  assert.equal(analysisRequestSchema.safeParse({ ...base, imagePaths: ["front.png", "side.png", "back.png", "detail.png"] }).success, true);
  assert.equal(analysisRequestSchema.safeParse({ ...base, imagePaths: ["1.png", "2.png", "3.png", "4.png", "5.png"] }).success, false);
});
