import type { Evidence, EvidenceUnit } from "./contracts.ts";
import type { InsertRetentionInput } from "./insert-retention-contracts.ts";

const RULES: Record<string, { unit: EvidenceUnit; read(input: InsertRetentionInput): number }> = {
  "configuration.insertLengthMm": { unit: "mm", read: (input) => input.configuration.insertLengthMm },
  "configuration.threadPitchMm": { unit: "mm", read: (input) => input.configuration.threadPitchMm },
  "configuration.holeDiameterMm": { unit: "mm", read: (input) => input.configuration.holeDiameterMm },
  "configuration.holeDepthMm": { unit: "mm", read: (input) => input.configuration.holeDepthMm },
  "demands.axialPulloutPerInsertN": { unit: "N", read: (input) => input.demands.axialPulloutPerInsertN },
  "demands.torquePerInsertNmm": { unit: "Nmm", read: (input) => input.demands.torquePerInsertNmm },
  "capacity.pulloutN": { unit: "N", read: (input) => input.capacity.pulloutN },
  "capacity.torqueOutNmm": { unit: "Nmm", read: (input) => input.capacity.torqueOutNmm },
  safetyFactor: { unit: "ratio", read: (input) => input.safetyFactor },
};

export function validateInsertRetentionEvidence(input: InsertRetentionInput): string[] {
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
    if (item.value === undefined || item.value !== rule.read(input)) issues.push(`ASSIGNMENT_VALUE_MISMATCH:${path}:${evidenceId}`);
  }
  for (const path of Object.keys(RULES)) if (!(path in input.assignments)) issues.push(`MISSING_ASSIGNMENT:${path}`);
  for (const evidenceId of input.capacity.evidenceIds) if (!byId.has(evidenceId)) issues.push(`BROKEN_CAPACITY_EVIDENCE:${evidenceId}`);
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
