import { createHash } from "node:crypto";

import type { Evidence } from "./contracts.ts";
import type { FastenerGroupCalculation, FastenerGroupInput } from "./fastener-group-contracts.ts";
import { fastenerGroupRules, validateFastenerGroupEvidence } from "./fastener-group-provenance.ts";

const REQUIRED_ASSUMPTIONS = [
  "static-in-plane-load",
  "rigid-attachment-member",
  "identical-fastener-in-plane-stiffness",
  "no-slip-or-clearance-redistribution",
  "fastener-points-represent-load-transfer-centers",
  "load-resultant-is-complete",
] as const;

const LOAD_PATHS = [
  "load.forceXN",
  "load.forceYN",
  "load.applicationPointXmm",
  "load.applicationPointYmm",
  "load.freeMomentNmm",
] as const;

export function calculateFastenerGroupLoad(input: FastenerGroupInput): FastenerGroupCalculation {
  const issues: FastenerGroupCalculation["issues"] = [];
  let needsInput = false;
  let conditional = false;
  let unsupported = false;
  const evidenceIds = (...paths: string[]) => paths.flatMap((path) => input.assignments[path] ? [input.assignments[path]!] : []);
  const add = (code: string, message: string, ids: string[] = []): void => {
    issues.push({ code, message, evidenceIds: [...new Set(ids)] });
  };

  for (const issue of validateFastenerGroupEvidence(input)) {
    add("INVALID_PROVENANCE", issue);
    needsInput = true;
  }
  const rules = fastenerGroupRules(input);
  for (const path of Object.keys(rules)) {
    const evidence = assignedEvidence(input, path);
    if (evidence?.range !== undefined) {
      add("RANGE_REQUIRES_SCENARIO", `Choose one supported scenario value for ranged input: ${path}.`, evidenceIds(path));
      needsInput = true;
    } else if (evidence?.status === "unknown") {
      add("UNKNOWN_EVIDENCE_REQUIRES_INPUT", `Evidence remains unknown for: ${path}.`, evidenceIds(path));
      needsInput = true;
    }
  }
  const positionPaths = [
    ...input.fasteners.flatMap((_, index) => [`fasteners.${index}.xMm`, `fasteners.${index}.yMm`]),
    "load.applicationPointXmm",
    "load.applicationPointYmm",
  ];
  for (const path of positionPaths) {
    if (!hasTraceableEvidence(input, assignedEvidence(input, path))) {
      add("FASTENER_POSITION_EVIDENCE_REQUIRED", `${path} requires measured, sourced, or traceably derived evidence.`, evidenceIds(path));
      needsInput = true;
    }
  }
  for (const path of LOAD_PATHS) {
    const evidence = assignedEvidence(input, path);
    if (evidence?.status === "assumed") {
      add("ASSUMED_LOAD", `${path} is an assumed load-case value.`, [evidence.id]);
      conditional = true;
    } else if (!hasTraceableEvidence(input, evidence)) {
      add("LOAD_EVIDENCE_REQUIRED", `${path} requires measured, sourced, traceably derived, or explicitly assumed evidence.`, evidenceIds(path));
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
  for (const [index, capacity] of (input.shearCapacities ?? []).entries()) {
    const path = `fastenerShearCapacities.${index}.allowableShearN`;
    if (!hasTraceableEvidence(input, assignedEvidence(input, path))) {
      add("FASTENER_SHEAR_ALLOWABLE_EVIDENCE_REQUIRED", `${path} requires measured, sourced, or traceably derived design-allowable evidence.`, evidenceIds(path));
      needsInput = true;
    }
    if (capacity.allowableShearN <= 0) {
      add("FASTENER_SHEAR_ALLOWABLE_INVALID", `The design allowable must be positive for fastener ${capacity.fastenerId}.`, evidenceIds(path));
      needsInput = true;
    }
  }

  const count = input.fasteners.length;
  let centroidMm: FastenerGroupCalculation["centroidMm"];
  let totalMomentAboutCentroidNmm: number | undefined;
  let polarSumMm2: number | undefined;
  let directPerFastenerN: FastenerGroupCalculation["directPerFastenerN"];
  let fasteners: FastenerGroupCalculation["fasteners"];
  let governing: FastenerGroupCalculation["governing"];
  let equilibrium: FastenerGroupCalculation["equilibrium"];
  if (count < 2) {
    add("AT_LEAST_TWO_FASTENERS_REQUIRED", "The elastic group method requires at least two distinct transfer points.");
    unsupported = true;
  } else {
    centroidMm = {
      x: input.fasteners.reduce((sum, fastener) => sum + fastener.xMm, 0) / count,
      y: input.fasteners.reduce((sum, fastener) => sum + fastener.yMm, 0) / count,
    };
    const offsets = input.fasteners.map((fastener) => ({ x: fastener.xMm - centroidMm!.x, y: fastener.yMm - centroidMm!.y }));
    polarSumMm2 = offsets.reduce((sum, offset) => sum + offset.x ** 2 + offset.y ** 2, 0);
    const arm = {
      x: input.load.applicationPointXmm - centroidMm.x,
      y: input.load.applicationPointYmm - centroidMm.y,
    };
    totalMomentAboutCentroidNmm = input.load.freeMomentNmm + arm.x * input.load.forceYN - arm.y * input.load.forceXN;
    directPerFastenerN = { x: input.load.forceXN / count, y: input.load.forceYN / count };
    if (polarSumMm2 === 0) {
      add("ZERO_GROUP_POLAR_SUM", "Fastener transfer points coincide, so the group cannot resist an in-plane moment in this model.", positionPaths.flatMap((path) => evidenceIds(path)));
      unsupported = true;
    } else {
      fasteners = input.fasteners.map((fastener, index) => {
        const offset = offsets[index]!;
        const momentN = {
          x: -totalMomentAboutCentroidNmm! * offset.y / polarSumMm2!,
          y: totalMomentAboutCentroidNmm! * offset.x / polarSumMm2!,
        };
        const resultantN = { x: directPerFastenerN!.x + momentN.x, y: directPerFastenerN!.y + momentN.y };
        return {
          id: fastener.id,
          positionMm: { x: fastener.xMm, y: fastener.yMm },
          offsetFromCentroidMm: normalizeVector(offset),
          directN: normalizeVector(directPerFastenerN!),
          momentN: normalizeVector(momentN),
          resultantN: normalizeVector(resultantN),
          magnitudeN: Math.hypot(resultantN.x, resultantN.y),
        };
      });
      const governingFastener = fasteners.reduce((largest, candidate) => candidate.magnitudeN > largest.magnitudeN ? candidate : largest);
      governing = { fastenerId: governingFastener.id, shearDemandN: governingFastener.magnitudeN };
      const forceX = fasteners.reduce((sum, fastener) => sum + fastener.resultantN.x, 0);
      const forceY = fasteners.reduce((sum, fastener) => sum + fastener.resultantN.y, 0);
      const moment = fasteners.reduce((sum, fastener) => sum
        + fastener.offsetFromCentroidMm.x * fastener.resultantN.y
        - fastener.offsetFromCentroidMm.y * fastener.resultantN.x, 0);
      equilibrium = {
        forceResidualN: Math.hypot(forceX - input.load.forceXN, forceY - input.load.forceYN),
        momentResidualNmm: Math.abs(moment - totalMomentAboutCentroidNmm),
      };
    }
  }

  const numeric = [
    ...(centroidMm ? Object.values(centroidMm) : []),
    ...(totalMomentAboutCentroidNmm === undefined ? [] : [totalMomentAboutCentroidNmm]),
    ...(polarSumMm2 === undefined ? [] : [polarSumMm2]),
    ...(directPerFastenerN ? Object.values(directPerFastenerN) : []),
    ...(fasteners ?? []).flatMap((fastener) => [
      ...Object.values(fastener.positionMm),
      ...Object.values(fastener.offsetFromCentroidMm),
      ...Object.values(fastener.directN),
      ...Object.values(fastener.momentN),
      ...Object.values(fastener.resultantN),
      fastener.magnitudeN,
    ]),
    ...(governing ? [governing.shearDemandN] : []),
    ...(equilibrium ? Object.values(equilibrium) : []),
  ];
  if (numeric.some((value) => !Number.isFinite(value))) {
    centroidMm = undefined;
    totalMomentAboutCentroidNmm = undefined;
    polarSumMm2 = undefined;
    directPerFastenerN = undefined;
    fasteners = undefined;
    governing = undefined;
    equilibrium = undefined;
    add("COMPUTATION_OVERFLOW", "The selected coordinates or loads produce a non-finite group-load calculation.");
    unsupported = true;
  }

  let status: FastenerGroupCalculation["status"] = unsupported
    ? "unsupported"
    : needsInput
      ? "needs-input"
      : conditional
      ? "conditional"
      : "calculated";
  let fastenerShearCheck: FastenerGroupCalculation["fastenerShearCheck"];
  if (input.shearCapacities && fasteners) {
    const perFastener = input.shearCapacities.map((capacity, index) => {
      const demand = fasteners!.find((item) => item.id === capacity.fastenerId)!;
      return {
        id: capacity.fastenerId,
        configuration: capacity.configuration,
        shearDemandN: demand.magnitudeN,
        allowableShearN: capacity.allowableShearN,
        utilization: demand.magnitudeN / capacity.allowableShearN,
        evidenceId: input.assignments[`fastenerShearCapacities.${index}.allowableShearN`]!,
      };
    });
    if (perFastener.some((item) => !Number.isFinite(item.utilization))) {
      add("SHEAR_UTILIZATION_OVERFLOW", "The selected shear allowable is too small to represent a finite utilization ratio.", perFastener.map((item) => item.evidenceId));
      status = "unsupported";
    } else {
      const governingCapacity = perFastener.reduce((largest, candidate) => candidate.utilization > largest.utilization ? candidate : largest);
      const exceeds = perFastener.some((item) => item.utilization > 1);
      if (exceeds) {
        add("FASTENER_SHEAR_ALLOWABLE_EXCEEDED", `At least one calculated fastener shear demand exceeds its traceable design allowable; governing fastener is ${governingCapacity.id}.`, perFastener.filter((item) => item.utilization > 1).map((item) => item.evidenceId));
      }
      fastenerShearCheck = {
        status: exceeds ? "exceeds-allowable" : status === "calculated" ? "within-allowable" : "conditional",
        fasteners: perFastener,
        governing: { fastenerId: governingCapacity.id, utilization: governingCapacity.utilization },
        allowableBasis: "traceable-design-allowable-including-safety-factor",
        checkedScope: "Individual fastener in-plane shear demand versus its traceable design allowable only; all fasteners and loads are taken from this group's elastic distribution.",
        unchecked: ["plate bearing, tear-out, insert pullout, thread failure and joint-level strength"],
      };
    }
  }
  return omitUndefined({
    kind: "fastener-group-load",
    status,
    method: input.method,
    methodVersion: "1.0.0",
    inputHash: hashFastenerGroupInput(input),
    centroidMm,
    totalMomentAboutCentroidNmm,
    polarSumMm2,
    directPerFastenerN,
    fasteners,
    governing,
    equilibrium,
    fastenerShearCheck,
    checkedScope: "Elastic in-plane load distribution for a rigid attachment with identical fastener stiffness. An optional fastenerShearCheck compares individual fastener shear with traceable design allowables; it is not a joined-member or complete-joint strength pass.",
    issues,
    unchecked: [
      "insert, thread, bearing, tear-out and net-section strength",
      ...(fastenerShearCheck ? [] : ["fastener member shear strength"]),
      "out-of-plane force, prying, flange bending and fastener bending",
      "preload, friction, joint slip, hole clearance and nonlinear redistribution",
      "unequal fastener stiffness, compliant members and plastic load redistribution",
      "fatigue, vibration, creep, impact, temperature and structural-code compliance",
    ],
  });
}

export function hashFastenerGroupInput(input: FastenerGroupInput): string {
  return createHash("sha256").update(JSON.stringify(canonicalJson(input))).digest("hex");
}

function assignedEvidence(input: FastenerGroupInput, path: string): Evidence | undefined {
  const id = input.assignments[path];
  return id === undefined ? undefined : input.evidence.find((item) => item.id === id);
}

function isDirectlyTraceable(evidence: Evidence | undefined): boolean {
  if (evidence?.status === "measured") return evidence.sourceLocator !== undefined;
  if (evidence?.status === "sourced") return evidence.sourceUrl !== undefined && evidence.sourceHash !== undefined;
  return false;
}

function hasTraceableEvidence(input: FastenerGroupInput, evidence: Evidence | undefined, visiting = new Set<string>()): boolean {
  if (!evidence || visiting.has(evidence.id)) return false;
  if (isDirectlyTraceable(evidence)) return true;
  if (evidence.status !== "derived" || !evidence.derivation || evidence.dependsOn.length === 0) return false;
  const next = new Set(visiting).add(evidence.id);
  return evidence.dependsOn.every((id) => hasTraceableEvidence(input, input.evidence.find((item) => item.id === id), next));
}

function normalizeVector(vector: { x: number; y: number }): { x: number; y: number } {
  return { x: normalizeZero(vector.x), y: normalizeZero(vector.y) };
}

function normalizeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Fastener-group input numbers must be finite");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalJson(entry)]));
}

function omitUndefined<T extends Record<string, unknown>>(value: T): FastenerGroupCalculation {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as unknown as FastenerGroupCalculation;
}
