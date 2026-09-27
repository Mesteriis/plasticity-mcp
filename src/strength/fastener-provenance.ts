import type { Evidence, EvidenceUnit } from "./contracts.ts";
import type { FastenerScenarioInput } from "./fastener-contracts.ts";

const RULES: Record<string, { unit: EvidenceUnit; read(input: FastenerScenarioInput): number }> = {
  "geometry.thicknessMm": { unit: "mm", read: (input) => input.geometry.thicknessMm },
  "geometry.holeDiameterMm": { unit: "mm", read: (input) => input.geometry.holeDiameterMm },
  "geometry.loadedEdgeDistanceMm": { unit: "mm", read: (input) => input.geometry.loadedEdgeDistanceMm },
  "geometry.oppositeEdgeDistanceMm": { unit: "mm", read: (input) => input.geometry.oppositeEdgeDistanceMm },
  "geometry.grossWidthMm": { unit: "mm", read: (input) => input.geometry.grossWidthMm },
  "geometry.sideClearancesMm.0": { unit: "mm", read: (input) => input.geometry.sideClearancesMm[0] },
  "geometry.sideClearancesMm.1": { unit: "mm", read: (input) => input.geometry.sideClearancesMm[1] },
  loadN: { unit: "N", read: (input) => input.loadN },
  "material.bearingLimitMPa": { unit: "MPa", read: (input) => input.material.bearingLimitMPa! },
  "material.shearLimitMPa": { unit: "MPa", read: (input) => input.material.shearLimitMPa! },
  "material.tensileLimitMPa": { unit: "MPa", read: (input) => input.material.tensileLimitMPa! },
  safetyFactor: { unit: "ratio", read: (input) => input.safetyFactor },
};

export function validateFastenerEvidence(input: FastenerScenarioInput): string[] {
  const issues: string[] = [];
  const counts = new Map<string, number>();
  for (const item of input.evidence) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
  for (const [id, count] of counts) if (count > 1) issues.push(`DUPLICATE_EVIDENCE_ID:${id}`);
  const byId = new Map<string, Evidence>();
  for (const item of input.evidence) if (!byId.has(item.id)) byId.set(item.id, item);
  for (const item of input.evidence) {
    for (const dependency of item.dependsOn) if (!byId.has(dependency)) issues.push(`BROKEN_DEPENDENCY:${item.id}:${dependency}`);
  }
  for (const id of cycleRoots(input.evidence, byId)) issues.push(`EVIDENCE_CYCLE:${id}`);
  for (const [path, evidenceId] of Object.entries(input.assignments)) {
    const rule = RULES[path];
    if (!rule) {
      issues.push(`UNKNOWN_ASSIGNMENT_PATH:${path}`);
      continue;
    }
    const item = byId.get(evidenceId);
    if (!item) {
      issues.push(`BROKEN_ASSIGNMENT:${path}:${evidenceId}`);
      continue;
    }
    if (item.unit !== rule.unit) issues.push(`ASSIGNMENT_UNIT_MISMATCH:${path}:${evidenceId}`);
    const value = rule.read(input);
    if (item.value === undefined || item.value !== value) issues.push(`ASSIGNMENT_VALUE_MISMATCH:${path}:${evidenceId}`);
  }
  for (const path of Object.keys(RULES)) {
    if (!(path in input.assignments)) issues.push(`MISSING_ASSIGNMENT:${path}`);
  }
  for (const evidenceId of input.material.evidenceIds) {
    if (!byId.has(evidenceId)) issues.push(`BROKEN_MATERIAL_EVIDENCE:${evidenceId}`);
  }
  for (const assumption of input.assumptions) {
    for (const evidenceId of assumption.evidenceIds) {
      if (!byId.has(evidenceId)) issues.push(`BROKEN_ASSUMPTION_EVIDENCE:${assumption.code}:${evidenceId}`);
    }
  }
  if (input.material.manufacturing.effectiveSection === "validated-effective") {
    const hasProcessEvidence = input.material.evidenceIds.some((id) => {
      const item = byId.get(id);
      return item !== undefined && (item.status === "measured" || item.status === "sourced") && item.sourceLocator !== undefined;
    });
    if (!hasProcessEvidence) issues.push("VALIDATED_EFFECTIVE_PROCESS_EVIDENCE_REQUIRED");
  }
  return issues;
}

function cycleRoots(evidence: Evidence[], byId: Map<string, Evidence>): string[] {
  const state = new Map<string, "visiting" | "done">();
  const cyclic = new Set<string>();
  const visit = (id: string, stack: string[]): void => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") {
      const start = stack.indexOf(id);
      for (const member of stack.slice(start)) cyclic.add(member);
      return;
    }
    const item = byId.get(id);
    if (!item) return;
    state.set(id, "visiting");
    for (const dependency of item.dependsOn) visit(dependency, [...stack, id]);
    state.set(id, "done");
  };
  for (const item of evidence) visit(item.id, []);
  return [...cyclic].sort();
}
