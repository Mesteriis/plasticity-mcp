import type { Evidence, EvidenceUnit, StrengthInput } from "./contracts.ts";
import type { SectionScenarioInput } from "./section-contracts.ts";

interface AssignmentRule {
  unit: EvidenceUnit;
  read(input: StrengthInput): number | undefined;
}

const ASSIGNMENT_RULES: Record<string, AssignmentRule> = {
  lengthMm: { unit: "mm", read: (input) => input.lengthMm },
  widthMm: { unit: "mm", read: (input) => input.widthMm },
  heightMm: { unit: "mm", read: (input) => input.heightMm },
  forceN: { unit: "N", read: (input) => input.forceN },
  effectiveLengthFactor: { unit: "ratio", read: (input) => input.effectiveLengthFactor },
  pressureMPa: { unit: "MPa", read: (input) => input.pressureMPa },
  poissonRatio: { unit: "ratio", read: (input) => input.poissonRatio },
  "material.youngMPa": { unit: "MPa", read: (input) => input.material.youngMPa },
  "material.tensileLimitMPa": { unit: "MPa", read: (input) => input.material.tensileLimitMPa },
  "material.compressiveLimitMPa": { unit: "MPa", read: (input) => input.material.compressiveLimitMPa },
  "material.elasticLimitMPa": { unit: "MPa", read: (input) => input.material.elasticLimitMPa },
  safetyFactor: { unit: "ratio", read: (input) => input.safetyFactor },
  maxDisplacementMm: { unit: "mm", read: (input) => input.maxDisplacementMm },
};

export function validateEvidence(input: StrengthInput): string[] {
  const issues: string[] = [];
  const counts = new Map<string, number>();
  for (const item of input.evidence) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
  for (const [id, count] of counts) if (count > 1) issues.push(`DUPLICATE_EVIDENCE_ID:${id}`);

  const byId = new Map<string, Evidence>();
  for (const item of input.evidence) if (!byId.has(item.id)) byId.set(item.id, item);
  for (const item of input.evidence) {
    for (const dependency of item.dependsOn) {
      if (!byId.has(dependency)) issues.push(`BROKEN_DEPENDENCY:${item.id}:${dependency}`);
    }
  }
  const cyclic = findCycleRoots(input.evidence, byId);
  for (const id of cyclic) issues.push(`EVIDENCE_CYCLE:${id}`);

  const assignmentEntries = Object.entries(input.assignments);
  for (const [path] of assignmentEntries) {
    if (!(path in ASSIGNMENT_RULES)) issues.push(`UNKNOWN_ASSIGNMENT_PATH:${path}`);
  }
  for (const [path, evidenceId] of assignmentEntries) {
    if (!byId.has(evidenceId)) issues.push(`BROKEN_ASSIGNMENT:${path}:${evidenceId}`);
  }
  for (const [path, evidenceId] of assignmentEntries) {
    const rule = ASSIGNMENT_RULES[path];
    const item = byId.get(evidenceId);
    if (!rule || !item) continue;
    if (item.unit !== rule.unit) issues.push(`ASSIGNMENT_UNIT_MISMATCH:${path}:${evidenceId}`);
  }
  for (const [path, evidenceId] of assignmentEntries) {
    const rule = ASSIGNMENT_RULES[path];
    const item = byId.get(evidenceId);
    if (!rule || !item) continue;
    const assignedValue = rule.read(input);
    if (assignedValue === undefined || item.value === undefined) {
      issues.push(`ASSIGNMENT_VALUE_MISMATCH:${path}:${evidenceId}`);
    } else if (item.value !== assignedValue) {
      issues.push(`ASSIGNMENT_VALUE_MISMATCH:${path}:${evidenceId}`);
    }
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

export function validateSectionEvidence(input: SectionScenarioInput): string[] {
  const issues: string[] = [];
  const counts = new Map<string, number>();
  for (const item of input.evidence) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
  for (const [id, count] of counts) if (count > 1) issues.push(`DUPLICATE_EVIDENCE_ID:${id}`);

  const loadCounts = new Map<string, number>();
  for (const load of [...input.pointForces, ...input.freeMoments]) {
    loadCounts.set(load.id, (loadCounts.get(load.id) ?? 0) + 1);
  }
  for (const [id, count] of loadCounts) if (count > 1) issues.push(`DUPLICATE_LOAD_ID:${id}`);

  const byId = new Map<string, Evidence>();
  for (const item of input.evidence) if (!byId.has(item.id)) byId.set(item.id, item);
  for (const item of input.evidence) {
    for (const dependency of item.dependsOn) {
      if (!byId.has(dependency)) issues.push(`BROKEN_DEPENDENCY:${item.id}:${dependency}`);
    }
  }
  for (const id of findCycleRoots(input.evidence, byId)) issues.push(`EVIDENCE_CYCLE:${id}`);

  const rules = sectionAssignmentRules(input);
  for (const path of rules.keys()) {
    if (!(path in input.assignments)) issues.push(`MISSING_ASSIGNMENT:${path}`);
  }
  for (const path of Object.keys(input.assignments)) {
    if (!rules.has(path)) issues.push(`UNKNOWN_ASSIGNMENT_PATH:${path}`);
  }
  for (const [path, evidenceId] of Object.entries(input.assignments)) {
    if (!byId.has(evidenceId)) issues.push(`BROKEN_ASSIGNMENT:${path}:${evidenceId}`);
  }
  for (const [path, evidenceId] of Object.entries(input.assignments)) {
    const rule = rules.get(path);
    const item = byId.get(evidenceId);
    if (!rule || !item) continue;
    if (item.unit !== rule.unit) issues.push(`ASSIGNMENT_UNIT_MISMATCH:${path}:${evidenceId}`);
    if (item.value === undefined || item.value !== rule.value) {
      issues.push(`ASSIGNMENT_VALUE_MISMATCH:${path}:${evidenceId}`);
    }
  }

  for (const load of [...input.pointForces, ...input.freeMoments]) {
    for (const evidenceId of load.evidenceIds) {
      if (!byId.has(evidenceId)) issues.push(`BROKEN_LOAD_EVIDENCE:${load.id}:${evidenceId}`);
    }
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

function sectionAssignmentRules(input: SectionScenarioInput): Map<string, { unit: EvidenceUnit; value: number }> {
  const rules = new Map<string, { unit: EvidenceUnit; value: number }>();
  const add = (path: string, unit: EvidenceUnit, value: number | undefined): void => {
    if (value !== undefined) rules.set(path, { unit, value });
  };
  add("properties.areaMm2", "mm2", input.properties.areaMm2);
  add("properties.centroidLocalMm.x", "mm", input.properties.centroidLocalMm[0]);
  add("properties.centroidLocalMm.y", "mm", input.properties.centroidLocalMm[1]);
  add("properties.ixxMm4", "mm4", input.properties.ixxMm4);
  add("properties.iyyMm4", "mm4", input.properties.iyyMm4);
  add("properties.ixyMm4", "mm4", input.properties.ixyMm4);
  for (const load of input.pointForces) {
    for (const [index, axis] of (["x", "y", "z"] as const).entries()) {
      add(`pointForces.${load.id}.forceN.${axis}`, "N", load.forceN[index]);
      add(`pointForces.${load.id}.pointMm.${axis}`, "mm", load.pointMm[index]);
    }
  }
  for (const moment of input.freeMoments) {
    for (const [index, axis] of (["x", "y", "z"] as const).entries()) {
      add(`freeMoments.${moment.id}.momentNmm.${axis}`, "Nmm", moment.momentNmm[index]);
    }
  }
  add("material.tensileLimitMPa", "MPa", input.material.tensileLimitMPa);
  add("material.compressiveLimitMPa", "MPa", input.material.compressiveLimitMPa);
  add("material.shearLimitMPa", "MPa", input.material.shearLimitMPa);
  add("safetyFactor", "ratio", input.safetyFactor);
  return rules;
}

function findCycleRoots(evidence: Evidence[], byId: Map<string, Evidence>): string[] {
  const state = new Map<string, "visiting" | "done">();
  const roots = new Set<string>();
  function visit(id: string): void {
    const current = state.get(id);
    if (current === "visiting") {
      roots.add(id);
      return;
    }
    if (current === "done") return;
    state.set(id, "visiting");
    for (const dependency of byId.get(id)?.dependsOn ?? []) if (byId.has(dependency)) visit(dependency);
    state.set(id, "done");
  }
  for (const item of evidence) visit(item.id);
  return [...roots].sort();
}
