import { createHash } from "node:crypto";

import type { Evidence } from "./contracts.ts";
import type { FastenerMemberCalculation, FastenerMemberInput } from "./fastener-member-contracts.ts";
import { validateFastenerMemberEvidence } from "./fastener-member-provenance.ts";

const REQUIRED_ASSUMPTIONS = [
  "static-load",
  "single-fastener-load-known",
  "no-fastener-bending",
  "axial-load-collinear",
  "shear-plane-count-and-location-known",
  "axial-force-includes-applicable-preload",
] as const;

const REQUIRED_INPUT_PATHS = [
  "geometry.nominalDiameterMm",
  "geometry.tensileStressAreaMm2",
  "geometry.shearAreaPerPlaneMm2",
  "geometry.shearPlaneCount",
  "loads.axialTensionN",
  "loads.transverseShearN",
  "safetyFactor",
] as const;

const AREA_PATHS = ["geometry.tensileStressAreaMm2", "geometry.shearAreaPerPlaneMm2"] as const;

export function calculateFastenerMember(input: FastenerMemberInput): FastenerMemberCalculation {
  const issues: FastenerMemberCalculation["issues"] = [];
  const unsupported = new Set<string>();
  let needsInput = false;
  let conditional = false;
  const evidenceIds = (...paths: string[]) => paths.flatMap((path) => input.assignments[path] ? [input.assignments[path]!] : []);
  const add = (code: string, message: string, ids: string[] = []): void => {
    issues.push({ code, message, evidenceIds: [...new Set(ids)] });
  };

  for (const issue of validateFastenerMemberEvidence(input)) {
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
  for (const path of AREA_PATHS) {
    if (!hasTraceableEvidence(input, assignedEvidence(input, path))) {
      add("EFFECTIVE_AREA_EVIDENCE_REQUIRED", `${path} requires measured, sourced, or traceably derived evidence.`, evidenceIds(path));
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
  const combined = input.loads.axialTensionN > 0 && input.loads.transverseShearN > 0;
  if (combined) {
    const interaction = input.assumptions.find((item) => item.code === "interaction-criterion-accepted");
    if (!interaction?.confirmed) {
      add("INTERACTION_CRITERION_UNCONFIRMED", "Combined loading requires explicit acceptance of the NASA R_t^2 + R_s^3 screening criterion for this task.", interaction?.evidenceIds ?? []);
      conditional = true;
    }
  }
  if (input.material.suitability === "mismatch") {
    add("FASTENER_MATERIAL_MISMATCH", "Material limits do not match the selected fastener grade, condition, or shear-plane location.", input.material.evidenceIds);
    unsupported.add("FASTENER_MATERIAL_MISMATCH");
  } else if (input.material.suitability === "unconfirmed") {
    add("FASTENER_MATERIAL_UNCONFIRMED", "Material limits are not confirmed for the selected fastener grade, condition, and shear-plane location.", input.material.evidenceIds);
    conditional = true;
  }

  requireMaterialLimit(input, "material.tensileLimitMPa", input.material.tensileLimitMPa, add, () => { needsInput = true; });
  requireMaterialLimit(input, "material.shearLimitMPa", input.material.shearLimitMPa, add, () => { needsInput = true; });

  const shankAreaMm2 = Math.PI * input.geometry.nominalDiameterMm ** 2 / 4;
  if (input.geometry.tensileStressAreaMm2 > shankAreaMm2 * (1 + 1e-12) || input.geometry.shearAreaPerPlaneMm2 > shankAreaMm2 * (1 + 1e-12)) {
    add("EFFECTIVE_AREA_EXCEEDS_SHANK", "An effective tensile or shear area cannot exceed the nominal circular shank area.", evidenceIds("geometry.nominalDiameterMm", ...AREA_PATHS));
    unsupported.add("EFFECTIVE_AREA_EXCEEDS_SHANK");
  }

  let stressMPa: FastenerMemberCalculation["stressMPa"] = {
    tension: input.loads.axialTensionN / input.geometry.tensileStressAreaMm2,
    shear: input.loads.transverseShearN / (input.geometry.shearAreaPerPlaneMm2 * input.geometry.shearPlaneCount),
  };
  let allowableLoadN: FastenerMemberCalculation["allowableLoadN"];
  let loadRatio: FastenerMemberCalculation["loadRatio"];
  let interactionValue: number | undefined;
  const tensileLimit = input.material.tensileLimitMPa;
  const shearLimit = input.material.shearLimitMPa;
  if (tensileLimit !== undefined && shearLimit !== undefined) {
    allowableLoadN = {
      tension: tensileLimit * input.geometry.tensileStressAreaMm2 / input.safetyFactor,
      shear: shearLimit * input.geometry.shearAreaPerPlaneMm2 * input.geometry.shearPlaneCount / input.safetyFactor,
    };
    loadRatio = {
      tension: input.loads.axialTensionN / allowableLoadN.tension,
      shear: input.loads.transverseShearN / allowableLoadN.shear,
    };
    interactionValue = loadRatio.tension ** 2 + loadRatio.shear ** 3;
    if (loadRatio.tension > 1) add("TENSION_LIMIT_EXCEEDED", "Fastener axial tension exceeds the factored tensile allowable load.", evidenceIds("loads.axialTensionN", "geometry.tensileStressAreaMm2", "material.tensileLimitMPa", "safetyFactor"));
    if (loadRatio.shear > 1) add("SHEAR_LIMIT_EXCEEDED", "Fastener transverse shear exceeds the factored shear allowable load.", evidenceIds("loads.transverseShearN", "geometry.shearAreaPerPlaneMm2", "geometry.shearPlaneCount", "material.shearLimitMPa", "safetyFactor"));
    if (combined && interactionValue > 1) add("COMBINED_LOAD_LIMIT_EXCEEDED", "NASA fastener tension-shear interaction R_t^2 + R_s^3 exceeds 1.", evidenceIds("loads.axialTensionN", "loads.transverseShearN", "material.tensileLimitMPa", "material.shearLimitMPa", "safetyFactor"));
  }
  const numeric = [
    ...(stressMPa ? Object.values(stressMPa) : []),
    ...(allowableLoadN ? Object.values(allowableLoadN) : []),
    ...(loadRatio ? Object.values(loadRatio) : []),
    ...(interactionValue === undefined ? [] : [interactionValue]),
  ];
  if (numeric.some((value) => !Number.isFinite(value))) {
    stressMPa = undefined;
    allowableLoadN = undefined;
    loadRatio = undefined;
    interactionValue = undefined;
    add("COMPUTATION_OVERFLOW", "The selected values produce a non-finite fastener calculation.");
    unsupported.add("COMPUTATION_OVERFLOW");
  }

  const failed = issues.some((issue) => issue.code.endsWith("LIMIT_EXCEEDED"));
  const status: FastenerMemberCalculation["status"] = unsupported.size > 0
    ? "unsupported"
    : needsInput
      ? "needs-input"
      : failed
        ? "fail"
        : conditional
          ? "conditional"
          : "pass";
  return omitUndefined({
    kind: "fastener-member",
    status,
    method: input.method,
    methodVersion: "1.0.0",
    inputHash: hashFastenerMemberInput(input),
    stressMPa,
    allowableLoadN,
    loadRatio,
    interactionValue,
    checkedScope: `One explicitly loaded fastener: axial tension, direct shear over ${input.geometry.shearPlaneCount} equal effective plane${input.geometry.shearPlaneCount === 1 ? "" : "s"} through ${input.geometry.shearPlaneLocation === "threads" ? "threads" : "the unthreaded shank"}, and NASA combined-load screening R_t^2 + R_s^3 <= 1.`,
    issues,
    unchecked: [
      "fastener bending from joint gaps, shims, eccentricity or flange rotation",
      "joint slip, friction, clamp preload loss and load redistribution",
      "thread stripping, tapped-hole or insert pull-out and head pull-through",
      "bearing, tear-out and net-section failure of every joined member",
      "fatigue, vibration, creep, impact, temperature and corrosion",
      "multiple-fastener group distribution and structural-code compliance",
      "critical-use validation of the selected interaction equation and allowables",
    ],
  });
}

export function hashFastenerMemberInput(input: FastenerMemberInput): string {
  return createHash("sha256").update(JSON.stringify(canonicalJson(input))).digest("hex");
}

function requireMaterialLimit(
  input: FastenerMemberInput,
  path: "material.tensileLimitMPa" | "material.shearLimitMPa",
  value: number | undefined,
  add: (code: string, message: string, evidenceIds?: string[]) => void,
  missing: () => void,
): void {
  const evidence = assignedEvidence(input, path);
  if (!(value !== undefined && value > 0)) {
    add("MISSING_INPUT", `Required positive material input is missing: ${path}.`, evidence ? [evidence.id] : []);
    missing();
  }
  if (!isDirectlyTraceable(evidence)) {
    add("MATERIAL_LIMIT_EVIDENCE_REQUIRED", `${path} requires measured evidence or a sourced record with URL and hash.`, evidence ? [evidence.id] : []);
    missing();
  }
  if (evidence && !input.material.evidenceIds.includes(evidence.id)) {
    add("MATERIAL_EVIDENCE_NOT_LINKED", `${path} evidence is not linked from the fastener material record.`, [evidence.id]);
    missing();
  }
}

function assignedEvidence(input: FastenerMemberInput, path: string): Evidence | undefined {
  const id = input.assignments[path];
  return id === undefined ? undefined : input.evidence.find((item) => item.id === id);
}

function isDirectlyTraceable(evidence: Evidence | undefined): boolean {
  if (evidence?.status === "measured") return evidence.sourceLocator !== undefined;
  if (evidence?.status === "sourced") return evidence.sourceUrl !== undefined && evidence.sourceHash !== undefined;
  return false;
}

function hasTraceableEvidence(input: FastenerMemberInput, evidence: Evidence | undefined, visiting = new Set<string>()): boolean {
  if (!evidence || visiting.has(evidence.id)) return false;
  if (isDirectlyTraceable(evidence)) return true;
  if (evidence.status !== "derived" || !evidence.derivation || evidence.dependsOn.length === 0) return false;
  const next = new Set(visiting).add(evidence.id);
  return evidence.dependsOn.every((id) => hasTraceableEvidence(input, input.evidence.find((item) => item.id === id), next));
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Fastener member input numbers must be finite");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalJson(entry)]));
}

function omitUndefined<T extends Record<string, unknown>>(value: T): FastenerMemberCalculation {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as unknown as FastenerMemberCalculation;
}
