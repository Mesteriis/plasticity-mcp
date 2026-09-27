import { createHash } from "node:crypto";

import type { Calculation, StrengthInput } from "./contracts.ts";
import { strengthMethod } from "./methods.ts";
import { solveSimplySupportedUniformPlate } from "./plate-theory.ts";
import { validateEvidence } from "./provenance.ts";

type Issue = Calculation["issues"][number];

const COMMON_UNCHECKED = [
  "attachment/support integrity",
  "local stress concentrations",
  "shear strength",
  "long-term behavior",
] as const;

export function calculate(input: StrengthInput): Calculation {
  const descriptor = strengthMethod(input.method);
  const issues: Issue[] = [];
  const unsupportedCodes = new Set<string>();
  let needsInput = false;
  let conditional = false;

  if (input.method === "axial-rectangle-v1" && input.forceN !== undefined && input.forceN < 0) {
    add("AXIAL_COMPRESSION_UNSUPPORTED", "The axial method supports tension only.", assignmentEvidence(input, "forceN"));
    unsupportedCodes.add("AXIAL_COMPRESSION_UNSUPPORTED");
  }
  if (input.method === "euler-column-buckling-v1" && input.forceN !== undefined && input.forceN >= 0) {
    add("EULER_COMPRESSION_REQUIRED", "The Euler column method requires a negative forceN value to denote axial compression.", assignmentEvidence(input, "forceN"));
    unsupportedCodes.add("EULER_COMPRESSION_REQUIRED");
  }
  if (input.material.suitability === "mismatch") {
    add("MATERIAL_PROCESS_MISMATCH", "Material properties do not match the selected manufacturing process.", input.material.evidenceIds);
    unsupportedCodes.add("MATERIAL_PROCESS_MISMATCH");
  } else if (input.material.suitability === "unconfirmed") {
    add("MATERIAL_UNCONFIRMED", "Material properties are not confirmed for the selected printer profile and orientation.", input.material.evidenceIds);
    conditional = true;
  }

  for (const assumptionCode of descriptor.assumptions) {
    const assumption = input.assumptions.find((candidate) => candidate.code === assumptionCode);
    if (!assumption?.confirmed) {
      add("ASSUMPTION_UNCONFIRMED", `Required assumption is not confirmed: ${assumptionCode}.`, assumption?.evidenceIds ?? []);
      conditional = true;
    }
  }
  for (const provenanceCode of validateEvidence(input)) {
    add("INVALID_PROVENANCE", provenanceCode, []);
    needsInput = true;
  }

  for (const path of descriptor.requiredInputPaths) {
    if (readNumericPath(input, path) === undefined) {
      add("MISSING_INPUT", `Required numeric input is missing: ${path}.`, assignmentEvidence(input, path));
      needsInput = true;
    }
    const evidenceId = input.assignments[path];
    const evidence = evidenceId ? input.evidence.find((candidate) => candidate.id === evidenceId) : undefined;
    if (evidence?.range !== undefined) {
      add("RANGE_REQUIRES_SCENARIO", `Choose a supported scenario value for ranged input: ${path}.`, [evidence.id]);
      needsInput = true;
    } else if (evidence?.status === "unknown") {
      add("UNKNOWN_EVIDENCE_REQUIRES_INPUT", `Evidence remains unknown for: ${path}.`, [evidence.id]);
      needsInput = true;
    }
  }
  if (
    input.method === "simply-supported-plate-uniform-pressure-v1" &&
    input.poissonRatio !== undefined &&
    !hasMeasuredOrSourcedAssignment(input, "poissonRatio")
  ) {
    add("POISSON_EVIDENCE_REQUIRED", "Poisson ratio must have measured or sourced evidence for the selected material process.", assignmentEvidence(input, "poissonRatio"));
    needsInput = true;
  }
  if (input.method === "euler-column-buckling-v1") {
    for (const path of [
      "effectiveLengthFactor",
      "material.youngMPa",
      "material.elasticLimitMPa",
      "material.compressiveLimitMPa",
    ]) {
      if (!hasTraceableAssignment(input, path)) {
        add("TRACEABLE_COLUMN_INPUT_REQUIRED", `A measured, sourced or derived evidence assignment is required for ${path}.`, assignmentEvidence(input, path));
        needsInput = true;
      }
    }
  }

  let stressMPa: number | undefined;
  let displacementMm: number | undefined;
  let strengthUtilization: number | undefined;
  let displacementUtilization: number | undefined;
  let plate: Calculation["plate"];
  let buckling: Calculation["buckling"];

  const { lengthMm, widthMm, heightMm, forceN, pressureMPa, poissonRatio, safetyFactor, maxDisplacementMm } = input;
  const youngMPa = input.material.youngMPa;
  if (
    lengthMm !== undefined && widthMm !== undefined && heightMm !== undefined &&
    forceN !== undefined && youngMPa !== undefined
  ) {
    if (input.method === "axial-rectangle-v1" && forceN >= 0) {
      const area = widthMm * heightMm;
      stressMPa = forceN / area;
      displacementMm = forceN * lengthMm / (youngMPa * area);
    } else if (input.method === "cantilever-tip-rectangle-v1") {
      const inertia = widthMm * heightMm ** 3 / 12;
      stressMPa = 6 * Math.abs(forceN) * lengthMm / (widthMm * heightMm ** 2);
      displacementMm = Math.abs(forceN) * lengthMm ** 3 / (3 * youngMPa * inertia);
      if (lengthMm / heightMm < 20) {
        add("SLENDERNESS_OUTSIDE_PRODUCT_LIMIT", "The cantilever requires L/h >= 20 for this product method.", dimensionEvidence(input));
        unsupportedCodes.add("SLENDERNESS_OUTSIDE_PRODUCT_LIMIT");
      }
      if (Number.isFinite(displacementMm) && displacementMm / lengthMm > 0.01) {
        add("DEFLECTION_RATIO_OUTSIDE_PRODUCT_LIMIT", "Calculated deflection exceeds the method limit of L/100.", dimensionEvidence(input));
        unsupportedCodes.add("DEFLECTION_RATIO_OUTSIDE_PRODUCT_LIMIT");
      }
    } else if (
      input.method === "euler-column-buckling-v1" && forceN < 0 &&
      input.effectiveLengthFactor !== undefined && input.material.elasticLimitMPa !== undefined &&
      input.material.compressiveLimitMPa !== undefined && safetyFactor !== undefined
    ) {
      const areaMm2 = widthMm * heightMm;
      const weakSecondMomentMm4 = Math.min(
        widthMm * heightMm ** 3 / 12,
        heightMm * widthMm ** 3 / 12,
      );
      const radiusOfGyrationMm = Math.sqrt(weakSecondMomentMm4 / areaMm2);
      const effectiveLengthMm = input.effectiveLengthFactor * lengthMm;
      const slendernessRatio = effectiveLengthMm / radiusOfGyrationMm;
      const elasticTransitionSlenderness = Math.PI * Math.sqrt(youngMPa / input.material.elasticLimitMPa);
      const criticalStressMPa = Math.PI ** 2 * youngMPa / slendernessRatio ** 2;
      const criticalLoadN = criticalStressMPa * areaMm2;
      const appliedCompressiveStressMPa = Math.abs(forceN) / areaMm2;
      const bucklingUtilization = Math.abs(forceN) * safetyFactor / criticalLoadN;
      const compressiveUtilization = Math.abs(forceN) * safetyFactor / (areaMm2 * input.material.compressiveLimitMPa);
      stressMPa = appliedCompressiveStressMPa;
      strengthUtilization = Math.max(bucklingUtilization, compressiveUtilization);
      buckling = {
        areaMm2,
        secondMomentMm4: weakSecondMomentMm4,
        radiusOfGyrationMm,
        effectiveLengthMm,
        slendernessRatio,
        elasticTransitionSlenderness,
        criticalLoadN,
        criticalStressMPa,
        appliedCompressiveStressMPa,
        bucklingUtilization,
        compressiveUtilization,
      };
      if (slendernessRatio < elasticTransitionSlenderness) {
        add("EULER_OUTSIDE_ELASTIC_RANGE", "Euler elastic buckling is not applicable because its critical stress exceeds the supplied material elastic limit; an inelastic-column method is required.", bucklingEvidence(input));
        unsupportedCodes.add("EULER_OUTSIDE_ELASTIC_RANGE");
      }
      if (strengthUtilization > 1) {
        if (bucklingUtilization > 1) {
          add("BUCKLING_LIMIT_EXCEEDED", "Factored axial compression exceeds the Euler elastic critical load.", bucklingEvidence(input));
        }
        if (compressiveUtilization > 1) {
          add("CRUSHING_LIMIT_EXCEEDED", "Factored nominal compressive stress exceeds the supplied compressive allowable.", bucklingEvidence(input));
        }
      }
    }
  }

  if (
    input.method === "simply-supported-plate-uniform-pressure-v1" &&
    lengthMm !== undefined && widthMm !== undefined && heightMm !== undefined &&
    pressureMPa !== undefined && poissonRatio !== undefined && youngMPa !== undefined
  ) {
    try {
      const solved = solveSimplySupportedUniformPlate({
        lengthMm,
        widthMm,
        thicknessMm: heightMm,
        pressureMPa,
        youngMPa,
        poissonRatio,
      });
      stressMPa = solved.maximumCenterSurfaceStressMPa;
      displacementMm = solved.centerDeflectionMm;
      plate = {
        flexuralRigidityNmm: solved.flexuralRigidityNmm,
        centerMomentsN: { x: solved.centerMomentXN, y: solved.centerMomentYN },
        centerSurfaceStressMPa: { ...solved.centerSurfaceStressMPa },
        seriesMaxOddIndex: solved.seriesMaxOddIndex,
      };
      if (Math.min(lengthMm, widthMm) / heightMm < 10) {
        add("THICKNESS_OUTSIDE_THIN_PLATE_LIMIT", "The shorter clear span must be at least ten times the thickness for this thin-plate passport.", dimensionEvidence(input));
        unsupportedCodes.add("THICKNESS_OUTSIDE_THIN_PLATE_LIMIT");
      }
      if (displacementMm / heightMm > 0.5) {
        add("DEFLECTION_OUTSIDE_LINEAR_PLATE_LIMIT", "Centre deflection exceeds half the thickness, outside this small-deflection plate passport.", displacementEvidence(input));
        unsupportedCodes.add("DEFLECTION_OUTSIDE_LINEAR_PLATE_LIMIT");
      }
    } catch (error) {
      add("COMPUTATION_OVERFLOW", error instanceof Error ? error.message : String(error), plateEvidence(input));
      unsupportedCodes.add("COMPUTATION_OVERFLOW");
    }
  }

  if ([stressMPa, displacementMm, strengthUtilization, ...Object.values(buckling ?? {})].some((value) => value !== undefined && !Number.isFinite(value))) {
    stressMPa = undefined;
    displacementMm = undefined;
    strengthUtilization = undefined;
    buckling = undefined;
    add("COMPUTATION_OVERFLOW", "The selected values produce a non-finite calculation.", []);
    unsupportedCodes.add("COMPUTATION_OVERFLOW");
  }

  const limit = input.method === "axial-rectangle-v1"
    ? input.material.tensileLimitMPa
    : minimumDefined(input.material.tensileLimitMPa, input.material.compressiveLimitMPa);
  if (input.method !== "euler-column-buckling-v1" && stressMPa !== undefined && limit !== undefined && safetyFactor !== undefined) {
    strengthUtilization = stressMPa / (limit / safetyFactor);
    if (!Number.isFinite(strengthUtilization)) {
      strengthUtilization = undefined;
      add("COMPUTATION_OVERFLOW", "Strength utilization is non-finite.", []);
      unsupportedCodes.add("COMPUTATION_OVERFLOW");
    } else if (strengthUtilization > 1) {
      add("STRENGTH_LIMIT_EXCEEDED", "Nominal stress exceeds the allowable stress for the selected safety factor.", strengthEvidence(input));
    }
  }
  if (displacementMm !== undefined && maxDisplacementMm !== undefined) {
    displacementUtilization = maxDisplacementMm === 0
      ? (displacementMm === 0 ? 0 : Number.POSITIVE_INFINITY)
      : displacementMm / maxDisplacementMm;
    if (!Number.isFinite(displacementUtilization)) {
      add("DISPLACEMENT_LIMIT_EXCEEDED", "Calculated displacement exceeds the zero displacement limit.", displacementEvidence(input));
      displacementUtilization = undefined;
    } else if (displacementUtilization > 1) {
      add("DISPLACEMENT_LIMIT_EXCEEDED", "Calculated displacement exceeds the selected limit.", displacementEvidence(input));
    }
  }

  const failed = issues.some((issue) => ["STRENGTH_LIMIT_EXCEEDED", "DISPLACEMENT_LIMIT_EXCEEDED", "BUCKLING_LIMIT_EXCEEDED", "CRUSHING_LIMIT_EXCEEDED"].includes(issue.code));
  const status: Calculation["status"] = unsupportedCodes.size > 0
    ? "unsupported"
    : needsInput
      ? "needs-input"
      : failed
        ? "fail"
        : conditional
          ? "conditional"
          : "pass";

  const unchecked: string[] = [...COMMON_UNCHECKED];
  if (input.method === "cantilever-tip-rectangle-v1") {
    unchecked.push("lateral-torsional instability outside the confirmed idealization");
  } else if (input.method === "euler-column-buckling-v1") {
    unchecked.push(
      "eccentric loading, initial crookedness and load-introduction bending",
      "inelastic column buckling, local buckling and torsional/flexural-torsional modes",
      "intermediate restraints, joints, anisotropy, creep, fatigue, impact and code compliance",
    );
  } else if (input.method === "simply-supported-plate-uniform-pressure-v1") {
    unchecked.push(
      "edge fixity, compliance and reaction concentrations",
      "openings, ribs, bosses, curvature and varying thickness",
      "membrane action, buckling, local contact and structural-code compliance",
      "printed anisotropy and layer delamination outside the homogeneous-equivalent assumption",
    );
  } else {
    unchecked.push("buckling and compression");
  }
  return omitUndefined({
    status,
    method: input.method,
    methodVersion: descriptor.version,
    inputHash: hashStrengthInput(input),
    checkedScope: input.method === "axial-rectangle-v1"
      ? "Nominal axial tension and elastic extension of one constant solid-equivalent rectangular member."
      : input.method === "cantilever-tip-rectangle-v1"
        ? "Nominal surface bending stress and Euler-Bernoulli tip deflection of one ideal rectangular cantilever."
        : input.method === "euler-column-buckling-v1"
          ? "Elastic Euler critical load and nominal crushing utilization of one straight, solid-equivalent prismatic rectangular column under centred axial compression."
          : "Centre surface bending stress and centre deflection of one homogeneous isotropic, simply supported rectangular plate under static uniform pressure on all four ideal edge supports.",
    stressMPa,
    displacementMm,
    strengthUtilization,
    displacementUtilization,
    plate,
    buckling,
    issues,
    unchecked,
  });

  function add(code: string, message: string, evidenceIds: string[]): void {
    issues.push({ code, message, evidenceIds: [...new Set(evidenceIds)] });
  }
}

export function hashStrengthInput(input: StrengthInput): string {
  return createHash("sha256").update(JSON.stringify(sortJson(input))).digest("hex");
}

function readNumericPath(input: StrengthInput, path: string): number | undefined {
  switch (path) {
    case "lengthMm": return input.lengthMm;
    case "widthMm": return input.widthMm;
    case "heightMm": return input.heightMm;
    case "forceN": return input.forceN;
    case "pressureMPa": return input.pressureMPa;
    case "poissonRatio": return input.poissonRatio;
    case "material.youngMPa": return input.material.youngMPa;
    case "material.elasticLimitMPa": return input.material.elasticLimitMPa;
    case "material.tensileLimitMPa": return input.material.tensileLimitMPa;
    case "material.compressiveLimitMPa": return input.material.compressiveLimitMPa;
    case "safetyFactor": return input.safetyFactor;
    case "effectiveLengthFactor": return input.effectiveLengthFactor;
    case "maxDisplacementMm": return input.maxDisplacementMm;
    default: return undefined;
  }
}

function assignmentEvidence(input: StrengthInput, path: string): string[] {
  const id = input.assignments[path];
  return id ? [id] : [];
}

function hasMeasuredOrSourcedAssignment(input: StrengthInput, path: string): boolean {
  const evidenceId = input.assignments[path];
  const evidence = evidenceId === undefined ? undefined : input.evidence.find((candidate) => candidate.id === evidenceId);
  return evidence?.status === "measured" || evidence?.status === "sourced";
}

function hasTraceableAssignment(input: StrengthInput, path: string): boolean {
  const evidenceId = input.assignments[path];
  const evidence = evidenceId === undefined ? undefined : input.evidence.find((candidate) => candidate.id === evidenceId);
  return evidence?.status === "measured" || evidence?.status === "sourced" || evidence?.status === "derived";
}

function dimensionEvidence(input: StrengthInput): string[] {
  return ["lengthMm", "widthMm", "heightMm"].flatMap((path) => assignmentEvidence(input, path));
}

function strengthEvidence(input: StrengthInput): string[] {
  const loadPaths = input.method === "simply-supported-plate-uniform-pressure-v1"
    ? ["pressureMPa", "lengthMm", "widthMm", "heightMm", "poissonRatio"]
    : ["forceN", "widthMm", "heightMm"];
  return [...loadPaths, "safetyFactor", "material.tensileLimitMPa", "material.compressiveLimitMPa"]
    .flatMap((path) => assignmentEvidence(input, path));
}

function displacementEvidence(input: StrengthInput): string[] {
  const loadPaths = input.method === "simply-supported-plate-uniform-pressure-v1"
    ? ["pressureMPa", "poissonRatio"]
    : ["forceN"];
  return [...loadPaths, "lengthMm", "widthMm", "heightMm", "material.youngMPa", "maxDisplacementMm"]
    .flatMap((path) => assignmentEvidence(input, path));
}

function plateEvidence(input: StrengthInput): string[] {
  return [
    "lengthMm",
    "widthMm",
    "heightMm",
    "pressureMPa",
    "poissonRatio",
    "material.youngMPa",
  ].flatMap((path) => assignmentEvidence(input, path));
}

function bucklingEvidence(input: StrengthInput): string[] {
  return [
    "lengthMm", "widthMm", "heightMm", "forceN", "effectiveLengthFactor",
    "material.youngMPa", "material.elasticLimitMPa", "material.compressiveLimitMPa", "safetyFactor",
  ].flatMap((path) => assignmentEvidence(input, path));
}

function minimumDefined(first: number | undefined, second: number | undefined): number | undefined {
  if (first === undefined || second === undefined) return undefined;
  return Math.min(first, second);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, sortJson(entry)]));
}

function omitUndefined<T extends Record<string, unknown>>(value: T): Calculation {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as unknown as Calculation;
}
