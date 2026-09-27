import { createHash } from "node:crypto";

import type { Evidence } from "./contracts.ts";
import type { FastenerCalculation, FastenerScenarioInput } from "./fastener-contracts.ts";
import { validateFastenerEvidence } from "./fastener-provenance.ts";

const REQUIRED_ASSUMPTIONS = [
  "static-in-plane-load",
  "single-fastener-load-path",
  "load-centered-through-thickness",
  "homogeneous-equivalent-plate",
  "nominal-bearing-contact",
] as const;

const REQUIRED_MATERIAL_PATHS = [
  "material.bearingLimitMPa",
  "material.shearLimitMPa",
  "material.tensileLimitMPa",
] as const;

const REQUIRED_INPUT_PATHS = [
  "geometry.thicknessMm",
  "geometry.holeDiameterMm",
  "geometry.loadedEdgeDistanceMm",
  "geometry.oppositeEdgeDistanceMm",
  "geometry.grossWidthMm",
  "geometry.sideClearancesMm.0",
  "geometry.sideClearancesMm.1",
  "loadN",
  "safetyFactor",
] as const;

export function calculateSingleFastener(input: FastenerScenarioInput): FastenerCalculation {
  const issues: FastenerCalculation["issues"] = [];
  const unsupported = new Set<string>();
  let needsInput = false;
  let conditional = false;
  const evidenceIds = (...paths: string[]) => paths.flatMap((path) => input.assignments[path] ? [input.assignments[path]!] : []);
  const add = (code: string, message: string, ids: string[] = []): void => {
    issues.push({ code, message, evidenceIds: [...new Set(ids)] });
  };

  for (const issue of validateFastenerEvidence(input)) {
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
  for (const code of REQUIRED_ASSUMPTIONS) {
    const assumption = input.assumptions.find((item) => item.code === code);
    if (!assumption?.confirmed) {
      add("ASSUMPTION_UNCONFIRMED", `Required assumption is not confirmed: ${code}.`, assumption?.evidenceIds ?? []);
      conditional = true;
    }
  }
  if (input.material.suitability === "mismatch") {
    add("MATERIAL_PROCESS_MISMATCH", "Material limits do not match the selected manufacturing profile and orientation.", input.material.evidenceIds);
    unsupported.add("MATERIAL_PROCESS_MISMATCH");
  } else if (input.material.suitability === "unconfirmed") {
    add("MATERIAL_UNCONFIRMED", "Material limits are not confirmed for the selected manufacturing profile and orientation.", input.material.evidenceIds);
    conditional = true;
  }
  for (const path of REQUIRED_MATERIAL_PATHS) {
    const value = readMaterialLimit(input, path);
    const evidence = assignedEvidence(input, path);
    if (!(value !== undefined && value > 0)) {
      add("MISSING_INPUT", `Required positive material input is missing: ${path}.`, evidenceIds(path));
      needsInput = true;
    }
    if (!isTraceableMaterialEvidence(evidence)) {
      add("MATERIAL_LIMIT_EVIDENCE_REQUIRED", `${path} requires measured evidence or a sourced record with URL and hash.`, evidenceIds(path));
      needsInput = true;
    }
    if (evidence && !input.material.evidenceIds.includes(evidence.id)) {
      add("MATERIAL_EVIDENCE_NOT_LINKED", `${path} evidence is not linked from the material record.`, [evidence.id]);
      needsInput = true;
    }
  }

  const { thicknessMm: t, holeDiameterMm: d, loadedEdgeDistanceMm: e, grossWidthMm: w } = input.geometry;
  const ligament = e - d / 2;
  const netWidth = w - d;
  const edgeDistanceToDiameter = e / d;
  const widthToDiameter = w / d;
  if (!(ligament > 0)) {
    add("NO_LOADED_EDGE_LIGAMENT", "The loaded-edge ligament e - d/2 must be positive.", evidenceIds("geometry.loadedEdgeDistanceMm", "geometry.holeDiameterMm"));
    unsupported.add("NO_LOADED_EDGE_LIGAMENT");
  }
  if (!(netWidth > 0)) {
    add("NO_NET_SECTION", "The net width w - d must be positive.", evidenceIds("geometry.grossWidthMm", "geometry.holeDiameterMm"));
    unsupported.add("NO_NET_SECTION");
  }
  if (!(input.geometry.oppositeEdgeDistanceMm > d / 2)) {
    add("NO_OPPOSITE_EDGE_LIGAMENT", "The opposite-edge ligament must be positive.", evidenceIds("geometry.oppositeEdgeDistanceMm", "geometry.holeDiameterMm"));
    unsupported.add("NO_OPPOSITE_EDGE_LIGAMENT");
  }
  if (input.geometry.sideClearancesMm.some((value) => !(value > 0))) {
    add("NO_SIDE_LIGAMENT", "Both transverse hole-to-edge clearances must be positive.", evidenceIds("geometry.sideClearancesMm.0", "geometry.sideClearancesMm.1"));
    unsupported.add("NO_SIDE_LIGAMENT");
  }
  const reconstructedWidth = input.geometry.sideClearancesMm[0] + d + input.geometry.sideClearancesMm[1];
  if (Math.abs(reconstructedWidth - w) > 1e-6) {
    add("INCONSISTENT_PLATE_GEOMETRY", "Gross width must equal both side clearances plus the hole diameter.", evidenceIds("geometry.grossWidthMm", "geometry.holeDiameterMm", "geometry.sideClearancesMm.0", "geometry.sideClearancesMm.1"));
    unsupported.add("INCONSISTENT_PLATE_GEOMETRY");
  }
  if (edgeDistanceToDiameter < 1.5) {
    add("EDGE_DISTANCE_OUTSIDE_METHOD_LIMIT", "The simplified tear-out method does not support e/d below 1.5.", evidenceIds("geometry.loadedEdgeDistanceMm", "geometry.holeDiameterMm"));
    unsupported.add("EDGE_DISTANCE_OUTSIDE_METHOD_LIMIT");
  } else if (edgeDistanceToDiameter < 2) {
    add("EDGE_DISTANCE_BELOW_NOMINAL", "The edge distance is below the nominal 2d practice and requires deliberate review.", evidenceIds("geometry.loadedEdgeDistanceMm", "geometry.holeDiameterMm"));
    conditional = true;
  }

  let stressMPa: FastenerCalculation["stressMPa"];
  let utilization: FastenerCalculation["utilization"];
  if (ligament > 0 && netWidth > 0) {
    stressMPa = {
      bearing: input.loadN / (d * t),
      shearOut: input.loadN / (2 * t * ligament),
      netTension: input.loadN / (t * netWidth),
    };
    const bearing = input.material.bearingLimitMPa;
    const shear = input.material.shearLimitMPa;
    const tensile = input.material.tensileLimitMPa;
    if (bearing !== undefined && shear !== undefined && tensile !== undefined) {
      utilization = {
        bearing: stressMPa.bearing / (bearing / input.safetyFactor),
        shearOut: stressMPa.shearOut / (shear / input.safetyFactor),
        netTension: stressMPa.netTension / (tensile / input.safetyFactor),
      };
      const checks: Array<[keyof typeof utilization, string, string, string[]]> = [
        ["bearing", "BEARING_LIMIT_EXCEEDED", "Nominal projected bearing stress exceeds the allowable bearing stress.", ["loadN", "geometry.holeDiameterMm", "geometry.thicknessMm", "material.bearingLimitMPa", "safetyFactor"]],
        ["shearOut", "SHEAR_OUT_LIMIT_EXCEEDED", "Two-plane loaded-edge shear stress exceeds the allowable shear stress.", ["loadN", "geometry.loadedEdgeDistanceMm", "geometry.holeDiameterMm", "geometry.thicknessMm", "material.shearLimitMPa", "safetyFactor"]],
        ["netTension", "NET_TENSION_LIMIT_EXCEEDED", "Nominal net-section tensile stress exceeds the allowable tensile stress.", ["loadN", "geometry.grossWidthMm", "geometry.holeDiameterMm", "geometry.thicknessMm", "material.tensileLimitMPa", "safetyFactor"]],
      ];
      for (const [key, code, message, paths] of checks) if (utilization[key] > 1) add(code, message, evidenceIds(...paths));
    }
  }
  if ([...(stressMPa ? Object.values(stressMPa) : []), ...(utilization ? Object.values(utilization) : [])].some((value) => !Number.isFinite(value))) {
    stressMPa = undefined;
    utilization = undefined;
    add("COMPUTATION_OVERFLOW", "The selected values produce a non-finite calculation.");
    unsupported.add("COMPUTATION_OVERFLOW");
  }
  const failed = issues.some((issue) => issue.code.endsWith("LIMIT_EXCEEDED"));
  const status: FastenerCalculation["status"] = unsupported.size > 0
    ? "unsupported"
    : needsInput
      ? "needs-input"
      : failed
        ? "fail"
        : conditional
          ? "conditional"
          : "pass";
  return omitUndefined({
    kind: "single-fastener-plate",
    status,
    method: input.method,
    methodVersion: "1.0.0",
    inputHash: hashFastenerInput(input),
    stressMPa,
    utilization,
    geometryRatios: { edgeDistanceToDiameter, widthToDiameter },
    checkedScope: "Nominal projected bearing, conservative two-plane loaded-edge shear-out, and nominal net-section tension for one through fastener in a flat constant-thickness plate.",
    issues,
    unchecked: [
      "fastener shear, tension and combined loading",
      "joint slip, preload, clearance and load distribution",
      "hole stress concentration, fatigue, creep and impact",
      "plate bending, prying, pull-through and washer contact",
      "insert, thread and surrounding-part failure",
      "multiple-fastener interaction and structural-code compliance",
      "printed anisotropy and layer delamination outside the homogeneous-equivalent assumption",
    ],
  });
}

export function hashFastenerInput(input: FastenerScenarioInput): string {
  return createHash("sha256").update(JSON.stringify(canonicalJson(input))).digest("hex");
}

function readMaterialLimit(input: FastenerScenarioInput, path: typeof REQUIRED_MATERIAL_PATHS[number]): number | undefined {
  if (path === "material.bearingLimitMPa") return input.material.bearingLimitMPa;
  if (path === "material.shearLimitMPa") return input.material.shearLimitMPa;
  return input.material.tensileLimitMPa;
}

function assignedEvidence(input: FastenerScenarioInput, path: string): Evidence | undefined {
  const id = input.assignments[path];
  return id === undefined ? undefined : input.evidence.find((item) => item.id === id);
}

function isTraceableMaterialEvidence(evidence: Evidence | undefined): boolean {
  if (evidence?.status === "measured") return evidence.sourceLocator !== undefined;
  if (evidence?.status === "sourced") return evidence.sourceUrl !== undefined && evidence.sourceHash !== undefined;
  return false;
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Fastener input numbers must be finite");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalJson(entry)]));
}

function omitUndefined<T extends Record<string, unknown>>(value: T): FastenerCalculation {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as unknown as FastenerCalculation;
}
