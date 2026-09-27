import { createHash } from "node:crypto";

import type { TongueRootCalculation, TongueRootInput } from "./tongue-root-contracts.ts";
import { hasTraceableTongueRootEvidence, validateTongueRootEvidence } from "./tongue-root-provenance.ts";

const REQUIRED_ASSUMPTIONS = [
  "static-load",
  "ideal-fixed-root",
  "beam-kinematics-applicable",
  "point-load-at-known-lever-arm",
  "rectangular-prismatic-root",
  "linear-elastic-effective-properties",
  "root-stress-concentration-not-included",
] as const;

export function calculateTongueRoot(input: TongueRootInput): TongueRootCalculation {
  const issues: TongueRootCalculation["issues"] = [];
  let needsInput = false;
  let unsupported = false;
  const add = (code: string, message: string, evidenceIds: string[] = []): void => {
    issues.push({ code, message, evidenceIds: [...new Set(evidenceIds)] });
  };
  const ids = (...paths: string[]) => paths.flatMap((path) => input.assignments[path] ? [input.assignments[path]!] : []);

  for (const issue of validateTongueRootEvidence(input)) {
    add("INVALID_PROVENANCE", issue);
    needsInput = true;
  }
  for (const [path, id] of Object.entries(input.assignments)) {
    const evidence = input.evidence.find((item) => item.id === id);
    if (evidence?.status === "unknown" || evidence?.range !== undefined) {
      add("INPUT_NOT_RESOLVED", `Select one confirmed scenario value for ${path}.`, [id]);
      needsInput = true;
    } else if (!hasTraceableTongueRootEvidence(input, evidence)) {
      add("TRACEABLE_EVIDENCE_REQUIRED", `${path} needs measured, sourced, or traceably derived evidence.`, [id]);
      needsInput = true;
    }
  }
  for (const code of REQUIRED_ASSUMPTIONS) {
    if (!input.assumptions.some((item) => item.code === code && item.confirmed)) {
      const item = input.assumptions.find((candidate) => candidate.code === code);
      add("ASSUMPTION_UNCONFIRMED", `Required assumption is not confirmed: ${code}.`, item?.evidenceIds ?? []);
    }
  }
  if (input.material.suitability === "mismatch") {
    add("MATERIAL_MISMATCH", "Material properties do not match the selected print, orientation, and process.", input.material.evidenceIds);
    unsupported = true;
  } else if (input.material.suitability === "unconfirmed") {
    add("MATERIAL_UNCONFIRMED", "Material properties have not been confirmed for the selected print, orientation, and process.", input.material.evidenceIds);
  }
  if (input.material.manufacturing.effectiveSection === "unknown") {
    add("EFFECTIVE_SECTION_UNCONFIRMED", "The printed section is not confirmed as solid or as a validated effective section for this printer/profile.", input.material.evidenceIds);
  }
  for (const path of ["material.youngModulusMPa", "material.shearModulusMPa", "material.tensileAllowableMPa", "material.shearAllowableMPa"]) {
    const id = input.assignments[path];
    if (id && !input.material.evidenceIds.includes(id)) {
      add("MATERIAL_EVIDENCE_NOT_LINKED", `${path} evidence must be linked from the material record.`, [id]);
      needsInput = true;
    }
  }
  const { rootWidthMm: b, rootThicknessMm: h, leverArmMm: length } = input.geometry;
  const force = input.loads.transverseForceN;
  const area = b * h;
  const secondMoment = b * h ** 3 / 12;
  const moment = force * length;
  const bendingStress = 6 * moment / (b * h ** 2);
  const maxShearStress = 1.5 * force / area;
  const bendingDeflection = force * length ** 3 / (3 * input.material.youngModulusMPa * secondMoment);
  const shearDeflection = force * length / (input.shearCorrectionFactor * input.material.shearModulusMPa * area);
  const totalDeflection = bendingDeflection + shearDeflection;
  const utilizations = {
    bending: bendingStress * input.safetyFactor / input.material.tensileAllowableMPa,
    shear: maxShearStress * input.safetyFactor / input.material.shearAllowableMPa,
    deflection: totalDeflection / input.maxDeflectionMm,
    governing: Math.max(
      bendingStress * input.safetyFactor / input.material.tensileAllowableMPa,
      maxShearStress * input.safetyFactor / input.material.shearAllowableMPa,
      totalDeflection / input.maxDeflectionMm,
    ),
  };
  if (Object.values({ bendingStress, maxShearStress, bendingDeflection, shearDeflection, totalDeflection, ...utilizations }).some((value) => !Number.isFinite(value))) {
    add("COMPUTATION_OVERFLOW", "Selected values produced a non-finite beam screening calculation.");
    needsInput = true;
  }
  if (utilizations.bending > 1) add("ROOT_BENDING_LIMIT_EXCEEDED", "Factored root bending stress exceeds the supplied tensile allowable.", ids("loads.transverseForceN", "geometry.leverArmMm", "geometry.rootWidthMm", "geometry.rootThicknessMm", "material.tensileAllowableMPa", "safetyFactor"));
  if (utilizations.shear > 1) add("ROOT_SHEAR_LIMIT_EXCEEDED", "Factored maximum transverse shear stress exceeds the supplied shear allowable.", ids("loads.transverseForceN", "geometry.rootWidthMm", "geometry.rootThicknessMm", "material.shearAllowableMPa", "safetyFactor"));
  if (utilizations.deflection > 1) add("ROOT_DEFLECTION_LIMIT_EXCEEDED", "Calculated tip deflection exceeds the specified limit.", ids("loads.transverseForceN", "geometry.leverArmMm", "geometry.rootWidthMm", "geometry.rootThicknessMm", "material.youngModulusMPa", "material.shearModulusMPa", "maxDeflectionMm"));

  const failed = issues.some((issue) => issue.code.endsWith("LIMIT_EXCEEDED"));
  const status: TongueRootCalculation["status"] = unsupported ? "unsupported" : needsInput ? "needs-input" : failed ? "fail" : "conditional";
  return omitUndefined({
    kind: "tongue-root",
    status,
    method: input.method,
    methodVersion: "1.0.0",
    inputHash: hashTongueRootInput(input),
    stressMPa: { rootBending: bendingStress, maximumTransverseShear: maxShearStress },
    deflectionMm: { bending: bendingDeflection, shear: shearDeflection, total: totalDeflection },
    utilization: utilizations,
    checkedScope: "Rectangular prismatic tongue root under one transverse point load at a known lever arm; Euler-Bernoulli bending plus Timoshenko shear deflection and rectangular-section maximum shear. This is a root-only screening calculation, never a pass for the tongue-and-groove joint.",
    issues,
    unchecked: [
      "groove wall bearing, splitting, local contact pressure, engagement-length distribution and retention",
      "root stress concentration, notch sensitivity, fillet geometry and three-dimensional load introduction",
      "combined or multiaxial stress interaction, torsion, off-axis force and load sharing",
      "print anisotropy, layer bonding, voids and process variability beyond the supplied effective properties",
      "fatigue, creep, impact, temperature, wear and environmental effects",
      "complete mating component strength, assembly tolerance, fit and whole-joint safety",
      "physical testing and qualified engineering review for safety-critical use",
    ],
  });
}

export function hashTongueRootInput(input: TongueRootInput): string {
  return createHash("sha256").update(JSON.stringify(canonicalJson(input))).digest("hex");
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Tongue root input numbers must be finite");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalJson(item)]));
}

function omitUndefined<T extends Record<string, unknown>>(value: T): TongueRootCalculation {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as unknown as TongueRootCalculation;
}
