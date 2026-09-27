import { createHash } from "node:crypto";

import type { Evidence } from "./contracts.ts";
import type { InsertRetentionCalculation, InsertRetentionInput } from "./insert-retention-contracts.ts";
import { validateInsertRetentionEvidence } from "./insert-retention-provenance.ts";

const REQUIRED_ASSUMPTIONS = [
  "static-load",
  "worst-case-per-insert-demand-known",
  "insert-installed-flush",
  "screw-does-not-bottom-out",
  "installation-process-matches-qualification",
  "hole-boss-and-host-match-qualification",
] as const;

const REQUIRED_INPUT_PATHS = [
  "configuration.insertLengthMm",
  "configuration.threadPitchMm",
  "configuration.holeDiameterMm",
  "configuration.holeDepthMm",
  "demands.axialPulloutPerInsertN",
  "demands.torquePerInsertNmm",
  "capacity.pulloutN",
  "capacity.torqueOutNmm",
  "safetyFactor",
] as const;

const CONFIGURATION_PATHS = [
  "configuration.insertLengthMm",
  "configuration.threadPitchMm",
  "configuration.holeDiameterMm",
  "configuration.holeDepthMm",
] as const;

const CAPACITY_PATHS = ["capacity.pulloutN", "capacity.torqueOutNmm"] as const;

export function calculateInsertRetention(input: InsertRetentionInput): InsertRetentionCalculation {
  const issues: InsertRetentionCalculation["issues"] = [];
  let needsInput = false;
  let conditional = false;
  let unsupported = false;
  const evidenceIds = (...paths: string[]) => paths.flatMap((path) => input.assignments[path] ? [input.assignments[path]!] : []);
  const add = (code: string, message: string, ids: string[] = []): void => {
    issues.push({ code, message, evidenceIds: [...new Set(ids)] });
  };

  for (const issue of validateInsertRetentionEvidence(input)) {
    add("INVALID_PROVENANCE", issue);
    needsInput = true;
  }
  for (const path of REQUIRED_INPUT_PATHS) {
    const evidence = assignedEvidence(input, path);
    if (evidence?.range !== undefined) {
      add("RANGE_REQUIRES_SCENARIO", `Choose one supported scenario value for ranged input: ${path}.`, evidenceIds(path));
      needsInput = true;
    } else if (evidence?.status === "unknown") {
      add("UNKNOWN_EVIDENCE_REQUIRES_INPUT", `Evidence remains unknown for: ${path}.`, evidenceIds(path));
      needsInput = true;
    }
  }
  for (const path of CONFIGURATION_PATHS) {
    if (!hasTraceableEvidence(input, assignedEvidence(input, path))) {
      add("CONFIGURATION_EVIDENCE_REQUIRED", `${path} requires measured, sourced, or traceably derived evidence.`, evidenceIds(path));
      needsInput = true;
    }
  }
  for (const path of CAPACITY_PATHS) {
    const evidence = assignedEvidence(input, path);
    if (!isDirectlyTraceable(evidence)) {
      add("CAPACITY_EVIDENCE_REQUIRED", `${path} requires measured evidence or a sourced record with URL and hash.`, evidenceIds(path));
      needsInput = true;
    }
    if (evidence && !input.capacity.evidenceIds.includes(evidence.id)) {
      add("CAPACITY_EVIDENCE_NOT_LINKED", `${path} evidence is not linked from the qualification record.`, [evidence.id]);
      needsInput = true;
    }
  }
  for (const code of REQUIRED_ASSUMPTIONS) {
    const assumption = input.assumptions.find((item) => item.code === code);
    if (!assumption?.confirmed) {
      add("ASSUMPTION_UNCONFIRMED", `Required assumption is not confirmed: ${code}.`, assumption?.evidenceIds ?? []);
      conditional = true;
    }
  }
  if (input.capacity.suitability === "mismatch") {
    add("QUALIFICATION_MISMATCH", "Retention capacity does not match the insert, host material, print profile, orientation, pocket, or installation process.", input.capacity.evidenceIds);
    unsupported = true;
  } else if (input.capacity.suitability === "unconfirmed") {
    add("QUALIFICATION_UNCONFIRMED", "Retention capacity is not confirmed for the complete insert, host, pocket, print, and installation configuration.", input.capacity.evidenceIds);
    conditional = true;
  }

  let minimumHoleDepthGuidanceMm: number | undefined = input.configuration.insertLengthMm + 2 * input.configuration.threadPitchMm;
  if (input.configuration.holeDepthMm < minimumHoleDepthGuidanceMm) {
    add("HOLE_DEPTH_BELOW_GUIDANCE", "Hole depth is below insert length plus two thread pitches; screw bottoming and insert jack-out require review.", evidenceIds("configuration.insertLengthMm", "configuration.threadPitchMm", "configuration.holeDepthMm"));
    conditional = true;
  }
  if (input.demands.axialPulloutPerInsertN > 0 && input.demands.torquePerInsertNmm > 0) {
    add("COMBINED_RETENTION_INTERACTION_UNVERIFIED", "Pullout and torque-out capacities are checked separately; no validated combined interaction is applied.", evidenceIds("demands.axialPulloutPerInsertN", "demands.torquePerInsertNmm"));
    conditional = true;
  }

  let factoredDemand: InsertRetentionCalculation["factoredDemand"] = {
    pulloutN: input.demands.axialPulloutPerInsertN * input.safetyFactor,
    torqueNmm: input.demands.torquePerInsertNmm * input.safetyFactor,
  };
  let utilization: InsertRetentionCalculation["utilization"] = {
    pullout: factoredDemand.pulloutN / input.capacity.pulloutN,
    torqueOut: factoredDemand.torqueNmm / input.capacity.torqueOutNmm,
  };
  if (utilization.pullout > 1) add("PULLOUT_CAPACITY_EXCEEDED", "Factored axial pullout demand exceeds the per-insert qualified pullout capacity.", evidenceIds("demands.axialPulloutPerInsertN", "capacity.pulloutN", "safetyFactor"));
  if (utilization.torqueOut > 1) add("TORQUE_OUT_CAPACITY_EXCEEDED", "Factored torque demand exceeds the per-insert qualified torque-out capacity.", evidenceIds("demands.torquePerInsertNmm", "capacity.torqueOutNmm", "safetyFactor"));
  if ([...Object.values(factoredDemand), ...Object.values(utilization), minimumHoleDepthGuidanceMm].some((value) => !Number.isFinite(value))) {
    factoredDemand = undefined;
    utilization = undefined;
    minimumHoleDepthGuidanceMm = undefined;
    add("COMPUTATION_OVERFLOW", "The selected values produce a non-finite insert-retention calculation.");
    unsupported = true;
  }
  const failed = issues.some((issue) => issue.code.endsWith("CAPACITY_EXCEEDED"));
  const status: InsertRetentionCalculation["status"] = unsupported
    ? "unsupported"
    : needsInput
      ? "needs-input"
      : failed
        ? "fail"
        : conditional
          ? "conditional"
          : "pass";
  return omitUndefined({
    kind: "heat-set-insert-retention",
    status,
    method: input.method,
    methodVersion: "1.0.0",
    inputHash: hashInsertRetentionInput(input),
    utilization,
    factoredDemand,
    minimumHoleDepthGuidanceMm,
    checkedScope: "One installed heat-set insert: independent axial pullout and torque-out screening against explicitly qualified per-insert capacities.",
    issues,
    unchecked: [
      "combined pullout and torque interaction",
      "transverse shear, bearing, prying and host-part bending",
      "boss splitting, local cracking and layer delamination",
      "thread stripping and screw tensile or shear failure",
      "installation defects, temperature history and residual stress",
      "fatigue, vibration, creep, impact, thermal cycling and aging",
      "load distribution among multiple inserts and structural-code compliance",
    ],
  });
}

export function hashInsertRetentionInput(input: InsertRetentionInput): string {
  return createHash("sha256").update(JSON.stringify(canonicalJson(input))).digest("hex");
}

function assignedEvidence(input: InsertRetentionInput, path: string): Evidence | undefined {
  const id = input.assignments[path];
  return id === undefined ? undefined : input.evidence.find((item) => item.id === id);
}

function isDirectlyTraceable(evidence: Evidence | undefined): boolean {
  if (evidence?.status === "measured") return evidence.sourceLocator !== undefined;
  if (evidence?.status === "sourced") return evidence.sourceUrl !== undefined && evidence.sourceHash !== undefined;
  return false;
}

function hasTraceableEvidence(input: InsertRetentionInput, evidence: Evidence | undefined, visiting = new Set<string>()): boolean {
  if (!evidence || visiting.has(evidence.id)) return false;
  if (isDirectlyTraceable(evidence)) return true;
  if (evidence.status !== "derived" || !evidence.derivation || evidence.dependsOn.length === 0) return false;
  const next = new Set(visiting).add(evidence.id);
  return evidence.dependsOn.every((id) => hasTraceableEvidence(input, input.evidence.find((item) => item.id === id), next));
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Insert-retention input numbers must be finite");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalJson(entry)]));
}

function omitUndefined<T extends Record<string, unknown>>(value: T): InsertRetentionCalculation {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as unknown as InsertRetentionCalculation;
}
