import type { Calculation, Evidence, StrengthInput } from "./contracts.ts";
import { calculate } from "./calculate.ts";

export interface SizeRequest {
  input: StrengthInput;
  heightsMm: number[];
}

export interface SizeResult {
  candidates: { heightMm: number; result: Calculation }[];
  recommendedHeightMm: number | null;
  recommendation: "verified-scheme" | "conditional" | "none";
}

export function sizeMember(request: SizeRequest): SizeResult {
  validateHeights(request.heightsMm);
  const heights = [...request.heightsMm].sort((left, right) => left - right);
  const candidates = heights.map((heightMm) => ({
    heightMm,
    result: calculate(candidateInput(request.input, heightMm)),
  }));
  const passing = candidates.find((candidate) => candidate.result.status === "pass");
  if (passing) {
    return { candidates, recommendedHeightMm: passing.heightMm, recommendation: "verified-scheme" };
  }
  const conditional = candidates.find((candidate) => candidate.result.status === "conditional");
  if (conditional) {
    return { candidates, recommendedHeightMm: conditional.heightMm, recommendation: "conditional" };
  }
  return { candidates, recommendedHeightMm: null, recommendation: "none" };
}

function validateHeights(heights: number[]): void {
  if (heights.length < 1 || heights.length > 200) throw new RangeError("heightsMm must contain 1 to 200 candidates");
  if (heights.some((height) => !Number.isFinite(height) || height <= 0)) {
    throw new RangeError("Every candidate height must be finite and positive");
  }
  if (new Set(heights).size !== heights.length) throw new RangeError("Candidate heights must be unique");
}

function candidateInput(input: StrengthInput, heightMm: number): StrengthInput {
  const evidenceId = input.assignments.heightMm;
  const existing = evidenceId === undefined
    ? undefined
    : input.evidence.find((candidate) => candidate.id === evidenceId);
  const candidateId = evidenceId ?? "candidate-height";
  const candidateEvidence: Evidence = {
    id: candidateId,
    label: `Explicit candidate height ${heightMm} mm`,
    status: "derived",
    unit: "mm",
    value: heightMm,
    dependsOn: existing ? [...existing.dependsOn] : [],
    derivation: "Selected from the caller-provided discrete height candidate list.",
  };
  const evidence = existing
    ? input.evidence.map((item) => item.id === candidateId ? candidateEvidence : { ...item, dependsOn: [...item.dependsOn] })
    : [...input.evidence.map((item) => ({ ...item, dependsOn: [...item.dependsOn] })), candidateEvidence];
  return {
    ...input,
    heightMm,
    material: {
      ...input.material,
      evidenceIds: [...input.material.evidenceIds],
      manufacturing: {
        ...input.material.manufacturing,
        orientationDeg: [...input.material.manufacturing.orientationDeg],
      },
    },
    evidence,
    assignments: { ...input.assignments, heightMm: candidateId },
    assumptions: input.assumptions.map((assumption) => ({ ...assumption, evidenceIds: [...assumption.evidenceIds] })),
    ...(input.binding === undefined ? {} : { binding: { ...input.binding } }),
  };
}
