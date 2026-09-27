import type { Evidence, EvidenceUnit } from "./contracts.ts";
import type { TongueRootInput } from "./tongue-root-contracts.ts";

const RULES: Record<string, { unit: EvidenceUnit; read(input: TongueRootInput): number }> = {
  "geometry.rootWidthMm": { unit: "mm", read: (input) => input.geometry.rootWidthMm },
  "geometry.rootThicknessMm": { unit: "mm", read: (input) => input.geometry.rootThicknessMm },
  "geometry.leverArmMm": { unit: "mm", read: (input) => input.geometry.leverArmMm },
  "loads.transverseForceN": { unit: "N", read: (input) => input.loads.transverseForceN },
  "material.youngModulusMPa": { unit: "MPa", read: (input) => input.material.youngModulusMPa },
  "material.shearModulusMPa": { unit: "MPa", read: (input) => input.material.shearModulusMPa },
  "material.tensileAllowableMPa": { unit: "MPa", read: (input) => input.material.tensileAllowableMPa },
  "material.shearAllowableMPa": { unit: "MPa", read: (input) => input.material.shearAllowableMPa },
  shearCorrectionFactor: { unit: "ratio", read: (input) => input.shearCorrectionFactor },
  safetyFactor: { unit: "ratio", read: (input) => input.safetyFactor },
  maxDeflectionMm: { unit: "mm", read: (input) => input.maxDeflectionMm },
};

export function validateTongueRootEvidence(input: TongueRootInput): string[] {
  const issues: string[] = [];
  const byId = new Map<string, Evidence>();
  for (const item of input.evidence) {
    if (byId.has(item.id)) issues.push(`DUPLICATE_EVIDENCE_ID:${item.id}`);
    else byId.set(item.id, item);
  }
  for (const item of input.evidence) for (const dependency of item.dependsOn) {
    if (!byId.has(dependency)) issues.push(`BROKEN_DEPENDENCY:${item.id}:${dependency}`);
  }
  for (const [path, id] of Object.entries(input.assignments)) {
    const rule = RULES[path];
    const evidence = byId.get(id);
    if (!rule) issues.push(`UNKNOWN_ASSIGNMENT_PATH:${path}`);
    else if (!evidence) issues.push(`BROKEN_ASSIGNMENT:${path}:${id}`);
    else {
      if (evidence.unit !== rule.unit) issues.push(`ASSIGNMENT_UNIT_MISMATCH:${path}:${id}`);
      if (evidence.value !== rule.read(input)) issues.push(`ASSIGNMENT_VALUE_MISMATCH:${path}:${id}`);
    }
  }
  for (const path of Object.keys(RULES)) if (!(path in input.assignments)) issues.push(`MISSING_ASSIGNMENT:${path}`);
  for (const id of input.material.evidenceIds) if (!byId.has(id)) issues.push(`BROKEN_MATERIAL_EVIDENCE:${id}`);
  for (const assumption of input.assumptions) for (const id of assumption.evidenceIds) {
    if (!byId.has(id)) issues.push(`BROKEN_ASSUMPTION_EVIDENCE:${assumption.code}:${id}`);
  }
  return issues;
}

export function hasTraceableTongueRootEvidence(input: TongueRootInput, evidence: Evidence | undefined, visiting = new Set<string>()): boolean {
  if (!evidence || visiting.has(evidence.id)) return false;
  if (evidence.status === "measured") return evidence.sourceLocator !== undefined;
  if (evidence.status === "sourced") return evidence.sourceUrl !== undefined && evidence.sourceHash !== undefined;
  if (evidence.status !== "derived" || !evidence.derivation || evidence.dependsOn.length === 0) return false;
  const next = new Set(visiting).add(evidence.id);
  return evidence.dependsOn.every((id) => hasTraceableTongueRootEvidence(input, input.evidence.find((item) => item.id === id), next));
}
