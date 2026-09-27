import { createHash } from "node:crypto";

import type { SectionCalculation, SectionScenarioInput } from "./section-contracts.ts";
import { integrateSection, linearStressExtrema, sectionHasConcaveOuterBoundary, type LocalSectionProperties } from "./section-geometry.ts";
import { classifyCircularSection, classifyDirectShearFamily, classifyThinWalledRectangularSingleCell, type TorsionSectionModel, type DirectShearModel } from "./section-shear.ts";
import { strengthMethod } from "./methods.ts";
import { validateSectionEvidence } from "./provenance.ts";
import { forceAtPointMomentNmm } from "./units.ts";

type Vector3 = [number, number, number];
type Issue = SectionCalculation["issues"][number];

const RESULTANT_TOLERANCE = 1e-9;
const PROPERTY_RELATIVE_TOLERANCE = 1e-9;

export function calculateSection(input: SectionScenarioInput): SectionCalculation {
  const descriptor = strengthMethod(input.method);
  const issues: Issue[] = [];
  let unsupported = false;
  let needsInput = false;
  let conditional = false;
  let computationValid = true;
  let frame: { x: Vector3; y: Vector3; n: Vector3 } | null = null;
  let measuredProperties: LocalSectionProperties | null = null;

  try {
    frame = sectionFrame(input.frame.normal, input.frame.xDirection);
  } catch (error) {
    add("INVALID_SECTION_FRAME", error instanceof Error ? error.message : String(error), []);
    unsupported = true;
    computationValid = false;
  }
  try {
    measuredProperties = integrateSection(input.loops);
    if (!propertiesMatch(measuredProperties, input.properties)) {
      add("SECTION_PROPERTIES_MISMATCH", "Section loops do not match the supplied exact properties or topology signature.", sectionPropertyEvidence(input));
      unsupported = true;
      measuredProperties = null;
    }
  } catch (error) {
    add("SECTION_GEOMETRY_UNSUPPORTED", error instanceof Error ? error.message : String(error), sectionPropertyEvidence(input));
    unsupported = true;
  }

  if (input.material.suitability === "mismatch") {
    add("MATERIAL_PROCESS_MISMATCH", "Material properties do not match the selected manufacturing process.", input.material.evidenceIds);
    unsupported = true;
  } else if (input.material.suitability === "unconfirmed") {
    add("MATERIAL_UNCONFIRMED", "Material properties are not confirmed for the selected printer profile and orientation.", input.material.evidenceIds);
    conditional = true;
  }
  if (input.material.manufacturing.effectiveSection === "unknown") {
    add("EFFECTIVE_SECTION_UNCONFIRMED", "The effective printed section is not confirmed for this process profile.", input.material.evidenceIds);
    conditional = true;
  }

  for (const assumptionCode of descriptor.assumptions) {
    const assumption = input.assumptions.find((candidate) => candidate.code === assumptionCode);
    if (!assumption?.confirmed) {
      add("ASSUMPTION_UNCONFIRMED", `Required assumption is not confirmed: ${assumptionCode}.`, assumption?.evidenceIds ?? []);
      conditional = true;
    }
  }
  for (const provenanceCode of validateSectionEvidence(input)) {
    add("INVALID_PROVENANCE", provenanceCode, []);
    needsInput = true;
  }

  for (const path of ["material.tensileLimitMPa", "material.compressiveLimitMPa", "safetyFactor"] as const) {
    if (readRequiredValue(input, path) === undefined) {
      add("MISSING_INPUT", `Required numeric input is missing: ${path}.`, assignmentEvidence(input, path));
      needsInput = true;
    }
  }
  for (const [path, evidenceId] of Object.entries(input.assignments)) {
    const evidence = input.evidence.find((candidate) => candidate.id === evidenceId);
    if (evidence?.range !== undefined) {
      add("RANGE_REQUIRES_SCENARIO", `Choose a supported scenario value for ranged input: ${path}.`, [evidence.id]);
      needsInput = true;
    } else if (evidence?.status === "unknown") {
      add("UNKNOWN_EVIDENCE_REQUIRES_INPUT", `Evidence remains unknown for: ${path}.`, [evidence.id]);
      needsInput = true;
    }
  }

  const zeroResultants: SectionCalculation["resultants"] = {
    axialN: 0,
    shearXN: 0,
    shearYN: 0,
    bendingXNmm: 0,
    bendingYNmm: 0,
    torsionNmm: 0,
  };
  let resultants = zeroResultants;
  if (frame && measuredProperties) {
    try {
      const centroidWorld = add3(
        input.frame.originMm,
        add3(scale3(frame.x, measuredProperties.centroidLocalMm[0]), scale3(frame.y, measuredProperties.centroidLocalMm[1])),
      );
      let forceWorld: Vector3 = [0, 0, 0];
      let momentWorld: Vector3 = [0, 0, 0];
      for (const force of input.pointForces) {
        forceWorld = add3(forceWorld, force.forceN);
        momentWorld = add3(momentWorld, forceAtPointMomentNmm(subtract3(force.pointMm, centroidWorld), force.forceN));
      }
      for (const moment of input.freeMoments) momentWorld = add3(momentWorld, moment.momentNmm);
      const projected = [
        dot3(forceWorld, frame.n),
        dot3(forceWorld, frame.x),
        dot3(forceWorld, frame.y),
        dot3(momentWorld, frame.x),
        dot3(momentWorld, frame.y),
        dot3(momentWorld, frame.n),
      ].map(stableZero);
      if (!projected.every(Number.isFinite)) throw new RangeError("Section resultants overflowed to a non-finite value");
      resultants = {
        axialN: projected[0]!,
        shearXN: projected[1]!,
        shearYN: projected[2]!,
        bendingXNmm: projected[3]!,
        bendingYNmm: projected[4]!,
        torsionNmm: projected[5]!,
      };
    } catch (error) {
      add("COMPUTATION_OVERFLOW", error instanceof Error ? error.message : String(error), loadEvidence(input));
      unsupported = true;
      computationValid = false;
    }
  }

  let normalStressMPa: SectionCalculation["normalStressMPa"];
  if (computationValid && measuredProperties) {
    const determinant = measuredProperties.ixxMm4 * measuredProperties.iyyMm4 - measuredProperties.ixyMm4 ** 2;
    const coefficientX = -(
      measuredProperties.ixxMm4 * resultants.bendingYNmm +
      measuredProperties.ixyMm4 * resultants.bendingXNmm
    ) / determinant;
    const coefficientY = (
      measuredProperties.ixyMm4 * resultants.bendingYNmm +
      measuredProperties.iyyMm4 * resultants.bendingXNmm
    ) / determinant;
    const constant = resultants.axialN / measuredProperties.areaMm2 -
      coefficientX * measuredProperties.centroidLocalMm[0] -
      coefficientY * measuredProperties.centroidLocalMm[1];
    try {
      const extrema = linearStressExtrema(input.loops, { constant, x: coefficientX, y: coefficientY });
      normalStressMPa = { minimum: stableZero(extrema.minimum), maximum: stableZero(extrema.maximum) };
    } catch (error) {
      add("COMPUTATION_OVERFLOW", error instanceof Error ? error.message : String(error), loadEvidence(input));
      unsupported = true;
      computationValid = false;
    }
  }

  let shearStressMPa: number | undefined;
  let shearUtilization: number | undefined;
  let shearModel: DirectShearModel | undefined;
  let shearScopeLabel: string | undefined;
  const transverseShear = Math.hypot(resultants.shearXN, resultants.shearYN);
  if (transverseShear > RESULTANT_TOLERANCE && measuredProperties) {
    const family = classifyDirectShearFamily(input.loops, measuredProperties);
    if (!family) {
      add("SECTION_FAMILY_SHEAR_UNSUPPORTED", "Direct-shear distribution is supported only for a proven solid rectangle, solid circle or concentric circular annulus.", loadEvidence(input));
      unsupported = true;
    } else {
      shearModel = family.model;
      shearScopeLabel = family.scopeLabel;
      shearStressMPa = family.maximumToAverageFactor * transverseShear / measuredProperties.areaMm2;
      if (!Number.isFinite(shearStressMPa)) {
        shearStressMPa = undefined;
        add("COMPUTATION_OVERFLOW", "Direct-shear calculation is non-finite.", loadEvidence(input));
        unsupported = true;
      }
    }
  }

  let torsionalShearStressMPa: number | undefined;
  let torsionUtilization: number | undefined;
  let torsionModel: TorsionSectionModel | undefined;
  let torsionalShearFlowNPerMm: number | undefined;
  let torsionalMedianAreaMm2: number | undefined;
  let torsionalWallThicknessMm: number | undefined;
  let torsionScopeLabel: string | undefined;
  const torsionMagnitude = Math.abs(resultants.torsionNmm);
  if (torsionMagnitude > RESULTANT_TOLERANCE && measuredProperties) {
    const family = classifyCircularSection(input.loops, measuredProperties);
    const thinWall = family ? null : classifyThinWalledRectangularSingleCell(input.loops, measuredProperties);
    if (!family && !thinWall) {
      add("TORSION_SECTION_FAMILY_UNSUPPORTED", "Elastic torsional shear is supported only for a proven solid circle, concentric circular annulus or uniform-thickness rectangular single-cell closed section.", loadEvidence(input));
      unsupported = true;
    } else {
      if (family) {
        torsionModel = family.model;
        torsionScopeLabel = family.model === "solid-circle"
          ? "maximum elastic torsional shear for a solid circular section"
          : "maximum elastic torsional shear for a concentric circular annulus";
        const polarMomentMm4 = measuredProperties.ixxMm4 + measuredProperties.iyyMm4;
        torsionalShearStressMPa = torsionMagnitude * family.outerRadiusMm / polarMomentMm4;
      } else if (thinWall) {
        torsionModel = thinWall.model;
        torsionalMedianAreaMm2 = thinWall.medianAreaMm2;
        torsionalWallThicknessMm = thinWall.wallThicknessMm;
        torsionalShearFlowNPerMm = torsionMagnitude / (2 * thinWall.medianAreaMm2);
        torsionalShearStressMPa = torsionalShearFlowNPerMm / thinWall.wallThicknessMm;
        torsionScopeLabel = "nominal uniform torsional shear for a uniform-thickness thin-walled rectangular single-cell section under pure torque";
        const assumption = input.assumptions.find((candidate) => candidate.code === "THIN_WALLED_SINGLE_CELL_TORSION");
        if (!assumption?.confirmed) {
          add("THIN_WALLED_TORSION_ASSUMPTION_UNCONFIRMED", "Confirm that the wall is thin relative to the cell dimensions, the section is a single closed cell, and the applied torque is introduced without significant distortion or end-restraint effects.", assumption?.evidenceIds ?? []);
          conditional = true;
        }
      }
      if (!Number.isFinite(torsionalShearStressMPa)) {
        torsionalShearStressMPa = undefined;
        add("COMPUTATION_OVERFLOW", "Torsional-shear calculation is non-finite.", loadEvidence(input));
        unsupported = true;
      }
    }
  }

  if (shearStressMPa !== undefined && torsionalShearStressMPa !== undefined) {
    add("COMBINED_SHEAR_TORSION_UNSUPPORTED", "The interaction of transverse-shear and torsional-shear stress fields is outside this method passport.", loadEvidence(input));
    unsupported = true;
  }

  if (shearStressMPa !== undefined || torsionalShearStressMPa !== undefined) {
    if (input.material.shearLimitMPa === undefined) {
      add("MISSING_SHEAR_LIMIT", "A sourced shear limit is required for the shear-stress check.", assignmentEvidence(input, "material.shearLimitMPa"));
      needsInput = true;
    } else if (!hasMeasuredOrSourcedAssignment(input, "material.shearLimitMPa")) {
      add("SHEAR_LIMIT_EVIDENCE_REQUIRED", "The shear limit must have measured or sourced evidence for this material process.", assignmentEvidence(input, "material.shearLimitMPa"));
      needsInput = true;
    } else if (input.safetyFactor !== undefined) {
      const allowableShearMPa = input.material.shearLimitMPa / input.safetyFactor;
      if (shearStressMPa !== undefined) {
        shearUtilization = shearStressMPa / allowableShearMPa;
        if (!Number.isFinite(shearUtilization)) {
          shearUtilization = undefined;
          add("COMPUTATION_OVERFLOW", "Direct-shear utilization is non-finite.", shearEvidence(input));
          unsupported = true;
        } else if (shearUtilization > 1) {
          add("SHEAR_LIMIT_EXCEEDED", "Maximum direct shear exceeds the allowable shear stress.", shearEvidence(input));
        }
      }
      if (torsionalShearStressMPa !== undefined) {
        torsionUtilization = torsionalShearStressMPa / allowableShearMPa;
        if (!Number.isFinite(torsionUtilization)) {
          torsionUtilization = undefined;
          add("COMPUTATION_OVERFLOW", "Torsional-shear utilization is non-finite.", torsionEvidence(input));
          unsupported = true;
        } else if (torsionUtilization > 1) {
          add("TORSIONAL_SHEAR_LIMIT_EXCEEDED", "Maximum torsional shear exceeds the allowable shear stress.", torsionEvidence(input));
        }
      }
    }
  }

  let tensileUtilization: number | undefined;
  let compressiveUtilization: number | undefined;
  if (normalStressMPa && input.safetyFactor !== undefined) {
    if (input.material.tensileLimitMPa !== undefined) {
      tensileUtilization = Math.max(0, normalStressMPa.maximum) / (input.material.tensileLimitMPa / input.safetyFactor);
      if (tensileUtilization > 1) add("TENSILE_LIMIT_EXCEEDED", "Nominal tensile stress exceeds the allowable tensile stress.", normalEvidence(input));
    }
    if (input.material.compressiveLimitMPa !== undefined) {
      compressiveUtilization = Math.max(0, -normalStressMPa.minimum) / (input.material.compressiveLimitMPa / input.safetyFactor);
      if (compressiveUtilization > 1) add("COMPRESSIVE_LIMIT_EXCEEDED", "Nominal compressive stress exceeds the allowable compressive stress.", normalEvidence(input));
    }
    if ([tensileUtilization, compressiveUtilization].some((value) => value !== undefined && !Number.isFinite(value))) {
      tensileUtilization = undefined;
      compressiveUtilization = undefined;
      add("COMPUTATION_OVERFLOW", "Normal-stress utilization is non-finite.", normalEvidence(input));
      unsupported = true;
    }
  }

  if (measuredProperties && measuredProperties.innerLoopCount > 0) {
    add("LOCAL_STRESS_CONCENTRATION_UNCHECKED", "Inner boundaries make local stress concentration and net-section failure unchecked.", sectionPropertyEvidence(input));
    conditional = true;
  }
  if (measuredProperties && sectionHasConcaveOuterBoundary(input.loops)) {
    add("CONCAVE_SECTION_SCOPE", "A concave outer boundary keeps nominal stress conditional because local concentration is unchecked.", sectionPropertyEvidence(input));
    conditional = true;
  }

  const failed = issues.some((issue) => [
    "TENSILE_LIMIT_EXCEEDED",
    "COMPRESSIVE_LIMIT_EXCEEDED",
    "SHEAR_LIMIT_EXCEEDED",
    "TORSIONAL_SHEAR_LIMIT_EXCEEDED",
  ].includes(issue.code));
  const status: SectionCalculation["status"] = unsupported
    ? "unsupported"
    : needsInput
      ? "needs-input"
      : failed
        ? "fail"
        : conditional
          ? "conditional"
          : "pass";
  const checked = ["nominal axial and biaxial-bending normal stress"];
  if (shearStressMPa !== undefined && shearScopeLabel !== undefined) checked.push(shearScopeLabel);
  if (torsionalShearStressMPa !== undefined && torsionScopeLabel !== undefined) checked.push(torsionScopeLabel);
  const unchecked = [
    torsionalShearStressMPa === undefined ? "torsional stress and twist" : "torsional twist",
    "deflection and support compliance",
    "buckling, fatigue, creep and impact",
    "local load introduction, joints, bearing and tear-out",
    "layer delamination and structural-code compliance",
  ];
  if (!computationValid) unchecked.unshift("section resultants unavailable because the calculation overflowed");
  if (shearStressMPa !== undefined && torsionalShearStressMPa !== undefined) unchecked.unshift("combined transverse-shear and torsional-stress interaction");
  if (
    normalStressMPa &&
    (Math.abs(normalStressMPa.minimum) > RESULTANT_TOLERANCE || Math.abs(normalStressMPa.maximum) > RESULTANT_TOLERANCE) &&
    (shearStressMPa !== undefined || torsionalShearStressMPa !== undefined)
  ) {
    unchecked.unshift("normal-stress and shear-stress interaction");
  }
  if (measuredProperties?.innerLoopCount) unchecked.unshift("local stress concentration and net-section fracture around inner boundaries");
  return omitUndefined({
    kind: "planar-section",
    status,
    method: "planar-section-resultants-v1",
    methodVersion: "1.3.0",
    inputHash: hashSectionInput(input),
    resultants,
    normalStressMPa,
    shearStressMPa,
    shearModel,
    torsionalShearStressMPa,
    torsionModel,
    torsionalShearFlowNPerMm,
    torsionalMedianAreaMm2,
    torsionalWallThicknessMm,
    tensileUtilization,
    compressiveUtilization,
    shearUtilization,
    torsionUtilization,
    checkedScope: checked.join("; ") + ".",
    issues,
    unchecked,
  });

  function add(code: string, message: string, evidenceIds: string[]): void {
    issues.push({ code, message, evidenceIds: [...new Set(evidenceIds)] });
  }
}

export function hashSectionInput(input: SectionScenarioInput): string {
  return createHash("sha256").update(JSON.stringify(sortJson(input))).digest("hex");
}

function sectionFrame(normal: Vector3, xDirection: Vector3): { x: Vector3; y: Vector3; n: Vector3 } {
  const n = normalize3(normal);
  if (!n) throw new Error("Section normal must have nonzero finite length");
  const projected = subtract3(xDirection, scale3(n, dot3(xDirection, n)));
  const x = normalize3(projected);
  if (!x) throw new Error("Section X direction must not be parallel to the section normal");
  const y = normalize3(cross3(n, x));
  if (!y) throw new Error("Section frame could not be normalized");
  return { x, y, n };
}

function propertiesMatch(actual: LocalSectionProperties, expected: LocalSectionProperties): boolean {
  const scalarPairs: Array<[number, number]> = [
    [actual.areaMm2, expected.areaMm2],
    [actual.centroidLocalMm[0], expected.centroidLocalMm[0]],
    [actual.centroidLocalMm[1], expected.centroidLocalMm[1]],
    [actual.ixxMm4, expected.ixxMm4],
    [actual.iyyMm4, expected.iyyMm4],
    [actual.ixyMm4, expected.ixyMm4],
    [actual.principal.majorMm4, expected.principal.majorMm4],
    [actual.principal.minorMm4, expected.principal.minorMm4],
    [actual.principal.angleDegrees, expected.principal.angleDegrees],
  ];
  return scalarPairs.every(([left, right]) => Math.abs(left - right) <= PROPERTY_RELATIVE_TOLERANCE * Math.max(1, Math.abs(left), Math.abs(right))) &&
    actual.innerLoopCount === expected.innerLoopCount &&
    actual.rectangular === expected.rectangular &&
    actual.topologySignature === expected.topologySignature &&
    actual.boundaryKinds.join(",") === expected.boundaryKinds.join(",");
}

function hasMeasuredOrSourcedAssignment(input: SectionScenarioInput, path: string): boolean {
  const evidenceId = input.assignments[path];
  const evidence = evidenceId === undefined ? undefined : input.evidence.find((candidate) => candidate.id === evidenceId);
  return evidence?.status === "measured" || evidence?.status === "sourced";
}

function readRequiredValue(
  input: SectionScenarioInput,
  path: "material.tensileLimitMPa" | "material.compressiveLimitMPa" | "safetyFactor",
): number | undefined {
  if (path === "material.tensileLimitMPa") return input.material.tensileLimitMPa;
  if (path === "material.compressiveLimitMPa") return input.material.compressiveLimitMPa;
  return input.safetyFactor;
}

function assignmentEvidence(input: SectionScenarioInput, path: string): string[] {
  const id = input.assignments[path];
  return id ? [id] : [];
}

function sectionPropertyEvidence(input: SectionScenarioInput): string[] {
  return [
    "properties.areaMm2",
    "properties.centroidLocalMm.x",
    "properties.centroidLocalMm.y",
    "properties.ixxMm4",
    "properties.iyyMm4",
    "properties.ixyMm4",
  ].flatMap((path) => assignmentEvidence(input, path));
}

function loadEvidence(input: SectionScenarioInput): string[] {
  return [...input.pointForces, ...input.freeMoments].flatMap((load) => load.evidenceIds);
}

function normalEvidence(input: SectionScenarioInput): string[] {
  return [
    ...loadEvidence(input),
    ...sectionPropertyEvidence(input),
    ...assignmentEvidence(input, "material.tensileLimitMPa"),
    ...assignmentEvidence(input, "material.compressiveLimitMPa"),
    ...assignmentEvidence(input, "safetyFactor"),
  ];
}

function shearEvidence(input: SectionScenarioInput): string[] {
  return [
    ...loadEvidence(input),
    ...assignmentEvidence(input, "properties.areaMm2"),
    ...assignmentEvidence(input, "material.shearLimitMPa"),
    ...assignmentEvidence(input, "safetyFactor"),
  ];
}

function torsionEvidence(input: SectionScenarioInput): string[] {
  return [
    ...loadEvidence(input),
    ...sectionPropertyEvidence(input),
    ...assignmentEvidence(input, "material.shearLimitMPa"),
    ...assignmentEvidence(input, "safetyFactor"),
  ];
}

function stableZero(value: number): number {
  return Math.abs(value) <= RESULTANT_TOLERANCE ? 0 : value;
}

function normalize3(value: Vector3): Vector3 | null {
  if (!value.every(Number.isFinite)) return null;
  const length = Math.hypot(...value);
  return length > RESULTANT_TOLERANCE ? scale3(value, 1 / length) : null;
}

function add3(left: Vector3, right: Vector3): Vector3 {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}

function subtract3(left: Vector3, right: Vector3): Vector3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function scale3(value: Vector3, factor: number): Vector3 {
  return [value[0] * factor, value[1] * factor, value[2] * factor];
}

function dot3(left: Vector3, right: Vector3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function cross3(left: Vector3, right: Vector3): Vector3 {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, sortJson(entry)]));
}

function omitUndefined<T extends Record<string, unknown>>(value: T): SectionCalculation {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as unknown as SectionCalculation;
}
