import { createHash } from "node:crypto";

import type { Evidence } from "./contracts.ts";
import type { FastenerGroupCalculation, FastenerGroupInput } from "./fastener-group-contracts.ts";
import { calculateFastenerGroupLoad } from "./fastener-group-calculate.ts";
import type { FastenerGroupLayoutEvidence } from "../plasticity/fastener-group-layout.ts";
import { calculateFastenerGroupEdgeShearOut, type FastenerGroupEdgeShearOutResult } from "./fastener-group-edge-shear-out.ts";
import { calculateMinimumStraightNetWidth } from "./fastener-group-net-section.ts";
import type { FastenerGroupTestRecord } from "./fastener-group-test.ts";
import type { MaterialCouponProcess } from "./material-qualification.ts";

export interface FastenerGroupPlateBearingInput {
  group: FastenerGroupInput;
  netTension?: {
    axis: "x" | "y";
    demandN: number;
    tensileDesignAllowableMPa: number;
    allowableEvidence: Evidence;
    assumptions: {
      uniformMembraneTension: boolean;
      loadCenteredThroughThickness: boolean;
      straightCutFailurePath: boolean;
    };
  };
  edgeShearOut?: {
    shearDesignAllowableMPa: number;
    allowableEvidence: Evidence;
    assumptions: {
      homogeneousEquivalentPlate: boolean;
      loadCenteredThroughThickness: boolean;
      twoPlaneShearOut: boolean;
    };
  };
  physicalTest?: {
    recordId: string;
    process: MaterialCouponProcess;
    safetyFactor: number;
    geometryToleranceMm: number;
    geometryToleranceEvidence: Evidence;
    processMatchesPartConfirmed: true;
    fixtureAndLoadPathMatchConfirmed: true;
  };
  plate: {
    boundaryFaceId: string;
    opposedFaceId: string;
    bearingDesignAllowableMPa: number;
    allowableEvidence: Evidence;
    materialConfiguration: string;
    materialSuitability: "matched" | "unconfirmed" | "mismatch";
    assumptions: {
      homogeneousEquivalentPlate: boolean;
      nominalBearingContact: boolean;
      loadCenteredThroughThickness: boolean;
    };
  };
}

export interface FastenerGroupTestGeometryMatch {
  plateDeltaMm: { width: number; height: number; thickness: number };
  maximumHoleCenterOffsetMm: number;
  maximumHoleDiameterDeltaMm: number;
  matchedHoleCount: number;
}

export interface FastenerGroupPlateBearingCalculation {
  kind: "fastener-group-plate-bearing";
  status: "needs-input" | "unsupported" | "conditional" | "fail";
  method: "fastener-group-plate-bearing-v1";
  methodVersion: "1.0.0";
  inputHash: string;
  geometryBinding?: FastenerGroupLayoutEvidence["binding"];
  plate?: {
    thicknessMm: number;
    bearingDesignAllowableMPa: number;
    allowableEvidenceId: string;
    materialConfiguration: string;
  };
  fasteners?: Array<{
    id: string;
    holeDiameterMm: number;
    bearingDemandN: number;
    nominalBearingStressMPa: number;
    utilization: number;
  }>;
  governing?: { fastenerId: string; utilization: number };
  bearingCheckStatus?: "within-allowable" | "exceeds-allowable" | "conditional";
  netSection?: {
    method: "straight-transverse-cut-v1";
    axis: "x" | "y";
    demandN: number;
    grossWidthMm: number;
    criticalOffsetMm: number;
    minimumNetWidthMm: number;
    thicknessMm: number;
    netAreaMm2: number;
    tensileStressMPa: number;
    tensileDesignAllowableMPa: number;
    allowableEvidenceId: string;
    utilization: number;
    intersectedHoles: Array<{ id: string; chordWidthMm: number }>;
    checkStatus: "within-allowable" | "exceeds-allowable" | "conditional";
  };
  edgeShearOut?: FastenerGroupEdgeShearOutResult & {
    method: "two-plane-loaded-edge-v1";
    designAllowableMPa: number;
    allowableEvidenceId: string;
  };
  physicalTestComparison?: {
    recordId: string;
    testedAt: string;
    loadAxis: "x" | "y";
    externalDemandN: number;
    safetyFactor: number;
    factoredDemandN: number;
    specimenCount: number;
    minimumObservedPeakLoadN: number;
    geometryToleranceMm: number;
    geometryToleranceEvidenceId: string;
    geometryMatch: FastenerGroupTestGeometryMatch;
    observedLoadRatio: number;
    outcome: "below-minimum-observed-failure-load" | "above-minimum-observed-failure-load";
    observedFailureModes: FastenerGroupTestRecord["outcomes"][number]["failureMode"][];
    interpretation: string;
  };
  checkedScope: string;
  issues: { code: string; message: string; evidenceIds: string[] }[];
  unchecked: string[];
}

export function calculateFastenerGroupPlateBearing(
  input: FastenerGroupPlateBearingInput,
  geometry: FastenerGroupLayoutEvidence,
  physicalTestRecord?: FastenerGroupTestRecord,
  physicalTestGeometryMatch?: FastenerGroupTestGeometryMatch,
): FastenerGroupPlateBearingCalculation {
  const issues: FastenerGroupPlateBearingCalculation["issues"] = [];
  const add = (code: string, message: string, evidenceIds: string[] = []): void => {
    issues.push({ code, message, evidenceIds: [...new Set(evidenceIds)] });
  };
  const groupResult = calculateFastenerGroupLoad(input.group);
  for (const issue of groupResult.issues) add(`GROUP_${issue.code}`, issue.message, issue.evidenceIds);
  let status: FastenerGroupPlateBearingCalculation["status"] = "conditional";

  if (input.plate.materialSuitability === "mismatch") {
    add("MATERIAL_PROCESS_MISMATCH", "Bearing allowable does not match the selected plate manufacturing configuration.", [input.plate.allowableEvidence.id]);
    status = "unsupported";
  }
  if (!(input.plate.bearingDesignAllowableMPa > 0) || !Number.isFinite(input.plate.bearingDesignAllowableMPa)) {
    add("INVALID_BEARING_ALLOWABLE", "The factored bearing design allowable must be finite and positive.", [input.plate.allowableEvidence.id]);
    status = "needs-input";
  }
  const evidence = input.plate.allowableEvidence;
  const allowableEvidenceValid = evidence.unit === "MPa"
    && evidence.value === input.plate.bearingDesignAllowableMPa
    && isDirectlyTraceable(evidence);
  if (!allowableEvidenceValid) {
    add("BEARING_ALLOWABLE_EVIDENCE_REQUIRED", "The bearing design allowable must match directly sourced or measured MPa evidence with a source URL and hash or a measurement locator.", [evidence.id]);
    if (status !== "unsupported") status = "needs-input";
  }
  if (!input.plate.materialConfiguration.trim()) {
    add("MATERIAL_CONFIGURATION_REQUIRED", "Identify the exact material and manufacturing configuration for this bearing allowable.", [evidence.id]);
    if (status !== "unsupported") status = "needs-input";
  }
  if (input.plate.materialSuitability === "unconfirmed") {
    add("MATERIAL_CONFIGURATION_UNCONFIRMED", "The allowable's match to the plate manufacturing configuration is unconfirmed.", [evidence.id]);
  }
  const assumptions = input.plate.assumptions;
  for (const [code, confirmed] of [
    ["homogeneous-equivalent-plate", assumptions.homogeneousEquivalentPlate],
    ["nominal-bearing-contact", assumptions.nominalBearingContact],
    ["load-centered-through-thickness", assumptions.loadCenteredThroughThickness],
  ] as const) {
    if (!confirmed) add("PLATE_ASSUMPTION_UNCONFIRMED", `Required local bearing assumption is unconfirmed: ${code}.`);
  }

  if (geometry.status !== "verified" || !geometry.plate || !geometry.fasteners || geometry.plate.thicknessMm === undefined) {
    add("NATIVE_PLATE_GEOMETRY_REQUIRED", `Exact opposed perforated plate geometry is unavailable: ${geometry.reasons.join(", ") || "thickness was not measured"}.`);
    status = status === "needs-input" ? status : "unsupported";
  }
  if (!input.group.binding) {
    add("CAD_BOUND_GROUP_REQUIRED", "The load distribution must be bound to current native fastener geometry.");
    status = status === "needs-input" ? status : "unsupported";
  } else if (geometry.status === "verified" && geometry.binding) {
    if (input.group.binding.bodyId !== geometry.binding.bodyId
        || input.group.binding.sessionId !== geometry.binding.sessionId
        || input.group.binding.documentToken !== geometry.binding.documentToken
        || input.group.binding.revision !== geometry.binding.revision
        || input.group.binding.topologySignature !== geometry.binding.groupTopologySignature
        || input.group.binding.cylindricalFaceIds.length !== geometry.binding.cylindricalFaceIds.length
        || input.group.binding.cylindricalFaceIds.some((id, index) => id !== geometry.binding!.cylindricalFaceIds[index])) {
      add("CAD_BINDING_MISMATCH", "The native plate geometry and fastener load distribution do not share one exact current binding.");
      status = "unsupported";
    }
    if (geometry.binding.boundaryFaceId !== input.plate.boundaryFaceId || geometry.binding.opposedFaceId !== input.plate.opposedFaceId) {
      add("PLATE_FACE_BINDING_MISMATCH", "The measured native plate faces differ from the explicitly requested strength faces.");
      status = "unsupported";
    }
  }

  const resultFasteners = groupResult.fasteners;
  if (groupResult.status === "needs-input") {
    add("GROUP_LOAD_NEEDS_INPUT", "The fastener-group load distribution has unresolved inputs; bearing utilization was not calculated.", groupResult.issues.flatMap((issue) => issue.evidenceIds));
    status = status === "unsupported" ? status : "needs-input";
  } else if (groupResult.status === "unsupported" || !resultFasteners) {
    add("GROUP_LOAD_UNSUPPORTED", "The fastener-group load distribution is unsupported; bearing utilization was not calculated.", groupResult.issues.flatMap((issue) => issue.evidenceIds));
    status = "unsupported";
  }

  const fasteners: FastenerGroupPlateBearingCalculation["fasteners"] = [];
  if (geometry.status === "verified" && geometry.plate?.thicknessMm && geometry.fasteners && resultFasteners
      && !issues.some((issue) => issue.code === "CAD_BINDING_MISMATCH" || issue.code === "GROUP_LOAD_NEEDS_INPUT" || issue.code === "GROUP_LOAD_UNSUPPORTED")) {
    const geometryById = new Map(geometry.fasteners.map((fastener) => [fastener.id, fastener]));
    if (resultFasteners.length !== geometry.fasteners.length || resultFasteners.some((fastener) => !geometryById.has(fastener.id))) {
      add("FASTENER_IDENTITY_MISMATCH", "The load report and native plate measurement do not contain the same fastener identities.");
      status = "unsupported";
    } else {
      for (const demand of resultFasteners) {
        const measured = geometryById.get(demand.id)!;
        const nominalBearingStressMPa = demand.magnitudeN / (measured.holeDiameterMm * geometry.plate.thicknessMm);
        const utilization = nominalBearingStressMPa / input.plate.bearingDesignAllowableMPa;
        if (![nominalBearingStressMPa, utilization].every(Number.isFinite)) {
          add("BEARING_COMPUTATION_OVERFLOW", `Nominal bearing calculation is not finite for fastener ${demand.id}.`, [evidence.id]);
          status = "unsupported";
          continue;
        }
        fasteners.push({
          id: demand.id,
          holeDiameterMm: measured.holeDiameterMm,
          bearingDemandN: demand.magnitudeN,
          nominalBearingStressMPa,
          utilization,
        });
      }
    }
  }

  if (fasteners.length > 0 && !issues.some((issue) => issue.code === "BEARING_COMPUTATION_OVERFLOW" || issue.code === "FASTENER_IDENTITY_MISMATCH")) {
    const governing = fasteners.reduce((largest, fastener) => fastener.utilization > largest.utilization ? fastener : largest);
    const exceeds = fasteners.some((fastener) => fastener.utilization > 1);
    const assumptionsConfirmed = Object.values(assumptions).every(Boolean);
    const trusted = input.plate.materialSuitability === "matched" && allowableEvidenceValid;
    const groupModelQualified = groupResult.status === "calculated";
    const qualified = trusted && assumptionsConfirmed && groupModelQualified;
    const checkStatus = !qualified
      ? "conditional" as const
      : exceeds ? "exceeds-allowable" as const : "within-allowable" as const;
    let netSection: FastenerGroupPlateBearingCalculation["netSection"];
    let edgeShearOut: FastenerGroupPlateBearingCalculation["edgeShearOut"];
    if (input.netTension) {
      const netInput = input.netTension;
      const bounds = geometry.plate!.boundsMm;
      const loadAlongX = netInput.axis === "x";
      const grossWidthMm = loadAlongX ? geometry.plate!.sizeMm.y : geometry.plate!.sizeMm.x;
      const minimumCoordinate = loadAlongX ? bounds.minY : bounds.minX;
      const width = calculateMinimumStraightNetWidth({
        grossWidthMm,
        holes: geometry.fasteners!.map((fastener) => ({
          id: fastener.id,
          centerOffsetMm: (loadAlongX ? fastener.localCenterMm.y : fastener.localCenterMm.x) - minimumCoordinate,
          diameterMm: fastener.holeDiameterMm,
        })),
      });
      const thicknessMm = geometry.plate!.thicknessMm!;
      const netAreaMm2 = width.minimumNetWidthMm * thicknessMm;
      const tensileStressMPa = netInput.demandN / netAreaMm2;
      const utilization = tensileStressMPa / netInput.tensileDesignAllowableMPa;
      const netAssumptionsConfirmed = Object.values(netInput.assumptions).every(Boolean);
      const netEvidenceValid = netInput.allowableEvidence.unit === "MPa"
        && netInput.allowableEvidence.value === netInput.tensileDesignAllowableMPa
        && isDirectlyTraceable(netInput.allowableEvidence);
      const netQualified = netAssumptionsConfirmed && netEvidenceValid && input.plate.materialSuitability === "matched";
      const netExceeds = utilization > 1;
      netSection = {
        method: "straight-transverse-cut-v1",
        axis: netInput.axis,
        demandN: netInput.demandN,
        grossWidthMm,
        criticalOffsetMm: width.criticalOffsetMm,
        minimumNetWidthMm: width.minimumNetWidthMm,
        thicknessMm,
        netAreaMm2,
        tensileStressMPa,
        tensileDesignAllowableMPa: netInput.tensileDesignAllowableMPa,
        allowableEvidenceId: netInput.allowableEvidence.id,
        utilization,
        intersectedHoles: width.intersectedHoles,
        checkStatus: !netQualified ? "conditional" : netExceeds ? "exceeds-allowable" : "within-allowable",
      };
      if (!netAssumptionsConfirmed) add("NET_SECTION_ASSUMPTIONS_UNCONFIRMED", "Confirm uniform membrane tension, centered loading through thickness, and a straight transverse failure path.", [netInput.allowableEvidence.id]);
      if (!netEvidenceValid) add("NET_SECTION_ALLOWABLE_EVIDENCE_REQUIRED", "The tensile allowable must exactly match traceable sourced or measured MPa evidence.", [netInput.allowableEvidence.id]);
      if (input.plate.materialSuitability !== "matched") add("NET_SECTION_MATERIAL_MATCH_UNCONFIRMED", "The plate material configuration is not confirmed against the tensile allowable.", [netInput.allowableEvidence.id]);
      if (netQualified && netExceeds) add("NET_SECTION_ALLOWABLE_EXCEEDED", `Straight-cut net-section tensile utilization is ${utilization.toPrecision(5)}.`, [netInput.allowableEvidence.id]);
    }
    if (input.edgeShearOut) {
      const shearInput = input.edgeShearOut;
      const assumptionsConfirmed = Object.values(shearInput.assumptions).every(Boolean);
      const allowableEvidenceValid = shearInput.allowableEvidence.unit === "MPa"
        && shearInput.allowableEvidence.value === shearInput.shearDesignAllowableMPa
        && isDirectlyTraceable(shearInput.allowableEvidence);
      const shearQualified = assumptionsConfirmed && allowableEvidenceValid
        && input.plate.materialSuitability === "matched"
        && groupResult.status === "calculated";
      const evaluated = calculateFastenerGroupEdgeShearOut({
        thicknessMm: geometry.plate!.thicknessMm!,
        designAllowableMPa: shearInput.shearDesignAllowableMPa,
        qualified: shearQualified,
        fasteners: geometry.fasteners!.map((fastener) => ({
          id: fastener.id,
          holeDiameterMm: fastener.holeDiameterMm,
          centerToEdgesMm: fastener.centerToEdgesMm,
        })),
        demands: resultFasteners!.map((fastener) => ({
          id: fastener.id,
          resultantN: fastener.resultantN,
          magnitudeN: fastener.magnitudeN,
        })),
      });
      edgeShearOut = {
        ...evaluated,
        method: "two-plane-loaded-edge-v1",
        designAllowableMPa: shearInput.shearDesignAllowableMPa,
        allowableEvidenceId: shearInput.allowableEvidence.id,
      };
      for (const issue of evaluated.issues) add("EDGE_SHEAR_OUT_CHECK", issue, [shearInput.allowableEvidence.id]);
      if (!assumptionsConfirmed) add("EDGE_SHEAR_OUT_ASSUMPTIONS_UNCONFIRMED", "Confirm a homogeneous equivalent plate, centered through-thickness loading, and the two-plane loaded-edge shear-out model.", [shearInput.allowableEvidence.id]);
      if (!allowableEvidenceValid) add("EDGE_SHEAR_OUT_ALLOWABLE_EVIDENCE_REQUIRED", "The shear-out design allowable must exactly match directly traceable measured or sourced MPa evidence.", [shearInput.allowableEvidence.id]);
      if (input.plate.materialSuitability !== "matched") add("EDGE_SHEAR_OUT_MATERIAL_MATCH_UNCONFIRMED", "The shear-out allowable is not confirmed for this exact plate manufacturing configuration.", [shearInput.allowableEvidence.id]);
    }
    let physicalTestComparison: FastenerGroupPlateBearingCalculation["physicalTestComparison"];
    if (input.physicalTest) {
      if (!physicalTestRecord || physicalTestRecord.id !== input.physicalTest.recordId) {
        add("PHYSICAL_GROUP_TEST_RECORD_REQUIRED", "The selected immutable physical group-test record could not be supplied to the calculation.");
        status = "unsupported";
      } else if (physicalTestRecord.fixture.loadAxis !== input.netTension?.axis) {
        add("PHYSICAL_GROUP_TEST_LOAD_AXIS_MISMATCH", "The recorded physical test load axis differs from the explicit external plate tensile resultant.");
        status = "unsupported";
      } else if (!physicalTestGeometryMatch) {
        add("PHYSICAL_GROUP_TEST_GEOMETRY_MATCH_REQUIRED", "The physical test comparison requires the verified live-CAD geometry match details.");
        status = "unsupported";
      } else {
        const minimumObservedPeakLoadN = Math.min(...physicalTestRecord.outcomes.map((item) => item.peakLoadN));
        const factoredDemandN = input.netTension.demandN * input.physicalTest.safetyFactor;
        const observedLoadRatio = factoredDemandN / minimumObservedPeakLoadN;
        if (![minimumObservedPeakLoadN, factoredDemandN, observedLoadRatio].every(Number.isFinite)) {
          add("PHYSICAL_GROUP_TEST_COMPARISON_OVERFLOW", "The factored demand-to-observed-test-load ratio is not finite.");
          status = "unsupported";
        } else {
          const outcome = factoredDemandN > minimumObservedPeakLoadN
            ? "above-minimum-observed-failure-load" as const
            : "below-minimum-observed-failure-load" as const;
          if (outcome === "above-minimum-observed-failure-load") {
            add("PHYSICAL_GROUP_TEST_LOAD_EXCEEDED", "Factored design demand exceeds the lowest recorded specimen peak load; this is a test benchmark exceedance, not a statistical allowable comparison.");
          }
          physicalTestComparison = {
            recordId: physicalTestRecord.id,
            testedAt: physicalTestRecord.testedAt,
            loadAxis: physicalTestRecord.fixture.loadAxis,
            externalDemandN: input.netTension.demandN,
            safetyFactor: input.physicalTest.safetyFactor,
            factoredDemandN,
            specimenCount: physicalTestRecord.outcomes.length,
            minimumObservedPeakLoadN,
            geometryToleranceMm: input.physicalTest.geometryToleranceMm,
            geometryToleranceEvidenceId: input.physicalTest.geometryToleranceEvidence.id,
            geometryMatch: physicalTestGeometryMatch,
            observedLoadRatio,
            outcome,
            observedFailureModes: [...new Set(physicalTestRecord.outcomes.map((item) => item.failureMode))].sort(),
            interpretation: "Exact-configuration physical-test benchmark only. This is not a statistically reduced design allowable, does not prove an unobserved failure mode, and is not a strength pass.",
          };
        }
      }
    }
    return {
      kind: "fastener-group-plate-bearing",
      status: status === "unsupported" ? "unsupported" : status === "needs-input" ? "needs-input" : qualified && exceeds || netSection?.checkStatus === "exceeds-allowable" || edgeShearOut?.status === "exceeds-allowable" ? "fail" : "conditional",
      method: "fastener-group-plate-bearing-v1",
      methodVersion: "1.0.0",
      inputHash: hashFastenerGroupPlateBearingInput(input, geometry),
      geometryBinding: geometry.binding,
      plate: {
        thicknessMm: geometry.plate!.thicknessMm!,
        bearingDesignAllowableMPa: input.plate.bearingDesignAllowableMPa,
        allowableEvidenceId: evidence.id,
        materialConfiguration: input.plate.materialConfiguration,
      },
      fasteners,
      governing: { fastenerId: governing.id, utilization: governing.utilization },
      bearingCheckStatus: checkStatus,
      ...(netSection === undefined ? {} : { netSection }),
      ...(edgeShearOut === undefined ? {} : { edgeShearOut }),
      ...(physicalTestComparison === undefined ? {} : { physicalTestComparison }),
      checkedScope: netSection || edgeShearOut
        ? `Conditional local projected-bearing plus explicitly requested bounded multi-hole plate screens using exact native geometry${physicalTestComparison ? " and an exact-configuration physical test-load benchmark" : ""}. Net tension uses a separately supplied external resultant; local edge shear-out only accepts per-fastener loads aligned with local X/Y and measured rectangular free edges. Unsupported, angled/staggered paths, shared-ligament mechanics, bypass and the complete joint remain unchecked.`
        : "Conditional local nominal projected bearing screen at each exact native through-hole, using the bound elastic in-plane fastener demand and a traceable allowable already including its safety factor. This is not a multi-hole plate or complete-joint strength pass.",
      issues: [
        ...issues,
        ...(!assumptionsConfirmed ? [{ code: "BEARING_MODEL_ASSUMPTIONS_UNCONFIRMED", message: "One or more local bearing model assumptions remain unconfirmed.", evidenceIds: [] }] : []),
        ...(!trusted ? [{ code: "BEARING_ALLOWABLE_MATCH_UNCONFIRMED", message: "The bearing allowable is traceable but its exact manufacturing configuration is not confirmed.", evidenceIds: [evidence.id] }] : []),
        ...(exceeds ? [{ code: "PLATE_BEARING_ALLOWABLE_EXCEEDED", message: `At least one hole's nominal projected bearing stress exceeds the design allowable; governing fastener is ${governing.id}.`, evidenceIds: [evidence.id] }] : []),
      ],
      unchecked: [
        ...(netSection ? [] : ["multi-hole net-section tension and compression"]),
        ...(netSection ? ["angled/staggered net-section paths, compression-side buckling, and load-bypass interaction"] : []),
        ...(edgeShearOut ? ["shared inter-hole ligament failure and hole-to-edge shear-out for unsupported per-fastener directions or edge ratios"] : ["shared inter-hole ligament failure and hole-to-edge shear-out"]),
        ...(physicalTestComparison ? ["statistical reduction and transfer of the observed test benchmark to untested units; explicit shared-ligament constitutive/failure mechanics"] : []),
        "bearing-bypass interaction and load redistribution around holes",
        "plate bending, out-of-plane load, prying and contact pressure concentration",
        "fastener tension/shear interaction, preload, clearance and joint slip",
        "fatigue, creep, impact, temperature, print-layer failure and structural-code compliance",
      ],
    };
  }

  return {
    kind: "fastener-group-plate-bearing",
    status,
    method: "fastener-group-plate-bearing-v1",
    methodVersion: "1.0.0",
    inputHash: hashFastenerGroupPlateBearingInput(input, geometry),
    ...(geometry.binding === undefined ? {} : { geometryBinding: geometry.binding }),
    ...(geometry.plate?.thicknessMm === undefined ? {} : { plate: {
      thicknessMm: geometry.plate.thicknessMm,
      bearingDesignAllowableMPa: input.plate.bearingDesignAllowableMPa,
      allowableEvidenceId: evidence.id,
      materialConfiguration: input.plate.materialConfiguration,
    } }),
    checkedScope: "No bearing utilization was calculated because required native geometry, load evidence, or traceable material evidence is unresolved.",
    issues,
    unchecked: [
      "all plate failure modes",
      "shared inter-hole ligament and multi-hole net-section strength",
      "complete-joint strength",
    ],
  };
}

export function hashFastenerGroupPlateBearingInput(input: FastenerGroupPlateBearingInput, geometry: FastenerGroupLayoutEvidence): string {
  return hashFastenerGroupPlateBearingBinding(input, geometry.binding);
}

export function hashFastenerGroupPlateBearingBinding(input: FastenerGroupPlateBearingInput, binding: FastenerGroupLayoutEvidence["binding"]): string {
  return createHash("sha256").update(JSON.stringify(canonicalJson({ input, binding }))).digest("hex");
}

function isDirectlyTraceable(evidence: Evidence): boolean {
  if (evidence.status === "measured") return evidence.sourceLocator !== undefined;
  if (evidence.status === "sourced") return evidence.sourceUrl !== undefined && evidence.sourceHash !== undefined;
  return false;
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Group plate input values must be finite");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalJson(entry)]));
}
