import type { Evidence, EvidenceUnit } from "./contracts.ts";
import type { FastenerGroupInput } from "./fastener-group-contracts.ts";

interface Rule {
  unit: EvidenceUnit;
  read(input: FastenerGroupInput): number;
}

export function fastenerGroupRules(input: FastenerGroupInput): Record<string, Rule> {
  const rules: Record<string, Rule> = {
    "load.forceXN": { unit: "N", read: (value) => value.load.forceXN },
    "load.forceYN": { unit: "N", read: (value) => value.load.forceYN },
    "load.applicationPointXmm": { unit: "mm", read: (value) => value.load.applicationPointXmm },
    "load.applicationPointYmm": { unit: "mm", read: (value) => value.load.applicationPointYmm },
    "load.freeMomentNmm": { unit: "Nmm", read: (value) => value.load.freeMomentNmm },
  };
  for (const [index] of input.fasteners.entries()) {
    rules[`fasteners.${index}.xMm`] = { unit: "mm", read: (value) => value.fasteners[index]!.xMm };
    rules[`fasteners.${index}.yMm`] = { unit: "mm", read: (value) => value.fasteners[index]!.yMm };
  }
  for (const [index] of (input.shearCapacities ?? []).entries()) {
    rules[`fastenerShearCapacities.${index}.allowableShearN`] = {
      unit: "N",
      read: (value) => value.shearCapacities![index]!.allowableShearN,
    };
  }
  return rules;
}

export function validateFastenerGroupEvidence(input: FastenerGroupInput): string[] {
  const issues: string[] = [];
  const rules = fastenerGroupRules(input);
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
    const rule = rules[path];
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
    if (item.value === undefined || item.value !== rule.read(input)) issues.push(`ASSIGNMENT_VALUE_MISMATCH:${path}:${evidenceId}`);
  }
  for (const path of Object.keys(rules)) if (!(path in input.assignments)) issues.push(`MISSING_ASSIGNMENT:${path}`);
  for (const assumption of input.assumptions) {
    for (const evidenceId of assumption.evidenceIds) if (!byId.has(evidenceId)) issues.push(`BROKEN_ASSUMPTION_EVIDENCE:${assumption.code}:${evidenceId}`);
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
