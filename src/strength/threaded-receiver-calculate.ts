import { createHash } from "node:crypto";

import type { Evidence } from "./contracts.ts";
import type { ThreadedReceiverCalculation, ThreadedReceiverInput } from "./threaded-receiver-contracts.ts";
import { validateThreadedReceiverEvidence } from "./threaded-receiver-provenance.ts";

const REQUIRED_ASSUMPTIONS = [
  "static-axial-load",
  "worst-case-receiver-demand-known",
  "fully-formed-engaged-thread-count-known",
  "capacity-matches-thread-form-class-material-and-engagement",
  "axial-force-includes-applicable-preload",
  "no-prying-bending-or-transverse-load",
] as const;

const REQUIRED_PATHS = [
  "configuration.nominalDiameterMm",
  "configuration.pitchMm",
  "configuration.engagementMm",
  "configuration.completeThreadCount",
  "loads.axialTensionN",
  "capacity.internalThreadStripAllowableN",
  "capacity.externalThreadStripAllowableN",
  "capacity.fastenerTensileAllowableN",
  "safetyFactor",
] as const;

const CAPACITY_PATHS = [
  "capacity.internalThreadStripAllowableN",
  "capacity.externalThreadStripAllowableN",
  "capacity.fastenerTensileAllowableN",
] as const;

export function calculateThreadedReceiver(input: ThreadedReceiverInput): ThreadedReceiverCalculation {
  const issues: ThreadedReceiverCalculation["issues"] = [];
  let needsInput = false;
  let conditional = false;
  let unsupported = false;
  let failureModeRequirementFailed = false;
  const evidenceIds = (...paths: string[]) => paths.flatMap((path) => input.assignments[path] ? [input.assignments[path]!] : []);
  const add = (code: string, message: string, ids: string[] = []): void => {
    issues.push({ code, message, evidenceIds: [...new Set(ids)] });
  };

  for (const issue of validateThreadedReceiverEvidence(input)) {
    add("INVALID_PROVENANCE", issue);
    needsInput = true;
  }
  for (const path of REQUIRED_PATHS) {
    const evidence = assignedEvidence(input, path);
    if (evidence?.range !== undefined) {
      add("RANGE_REQUIRES_SCENARIO", `Choose one supported scenario value for ranged input: ${path}.`, evidenceIds(path));
      needsInput = true;
    } else if (evidence?.status === "unknown") {
      add("UNKNOWN_EVIDENCE_REQUIRES_INPUT", `Evidence remains unknown for: ${path}.`, evidenceIds(path));
      needsInput = true;
    }
  }
  for (const path of CAPACITY_PATHS) {
    const evidence = assignedEvidence(input, path);
    if (!isDirectlyTraceable(evidence) || (evidence && !input.capacity.evidenceIds.includes(evidence.id))) {
      add("CAPACITY_EVIDENCE_REQUIRED", `${path} requires measured or sourced evidence linked to the matched capacity record.`, evidence ? [evidence.id] : []);
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
    add("CAPACITY_CONFIGURATION_MISMATCH", "The capacities do not match the selected thread form, class, materials, engagement, condition, or receiver configuration.", input.capacity.evidenceIds);
    unsupported = true;
  } else if (input.capacity.suitability === "unconfirmed") {
    add("CAPACITY_CONFIGURATION_UNCONFIRMED", "The capacity match to the selected thread form, class, materials, engagement, condition, and receiver configuration is unconfirmed.", input.capacity.evidenceIds);
    conditional = true;
  }
  if (input.configuration.receiverType !== "tapped-hole" && input.configuration.capacityBasis === "qualified-shear-area-calculation") {
    add("PROCURED_RECEIVER_REQUIRES_SPECIFIED_OR_TESTED_LOAD", "A procured nut or threaded insert requires its specified controlled allowable tensile load or a dedicated assembly test, not a nominal thread-stripping calculation.", input.capacity.evidenceIds);
    unsupported = true;
  }
  if (input.configuration.completeThreadCount * input.configuration.pitchMm > input.configuration.engagementMm + 1e-9) {
    add("ENGAGED_THREAD_COUNT_EXCEEDS_LENGTH", "The stated complete engaged threads occupy more than the stated engagement length.", evidenceIds("configuration.pitchMm", "configuration.engagementMm", "configuration.completeThreadCount"));
    unsupported = true;
  }

  let factoredDemandN: number | undefined = input.loads.axialTensionN * input.safetyFactor;
  let utilization: ThreadedReceiverCalculation["utilization"] = {
    internalThreadStrip: factoredDemandN / input.capacity.internalThreadStripAllowableN,
    externalThreadStrip: factoredDemandN / input.capacity.externalThreadStripAllowableN,
    fastenerTension: factoredDemandN / input.capacity.fastenerTensileAllowableN,
  };
  const modes = [
    { mode: "internal-thread-strip" as const, allowableLoadN: input.capacity.internalThreadStripAllowableN, utilization: utilization.internalThreadStrip },
    { mode: "external-thread-strip" as const, allowableLoadN: input.capacity.externalThreadStripAllowableN, utilization: utilization.externalThreadStrip },
    { mode: "fastener-tension" as const, allowableLoadN: input.capacity.fastenerTensileAllowableN, utilization: utilization.fastenerTension },
  ];
  let governing: ThreadedReceiverCalculation["governing"] = modes.reduce((left, right) => right.utilization > left.utilization ? right : left);
  const minimumThreadStripAllowableN = Math.min(input.capacity.internalThreadStripAllowableN, input.capacity.externalThreadStripAllowableN);
  const hierarchyMarginN = minimumThreadStripAllowableN - input.capacity.fastenerTensileAllowableN;
  let failureHierarchy: ThreadedReceiverCalculation["failureHierarchy"] = {
    status: hierarchyMarginN >= 0 ? "fastener-tension-before-thread-stripping" : "thread-stripping-before-fastener-tension",
    minimumThreadStripAllowableN,
    fastenerTensileAllowableN: input.capacity.fastenerTensileAllowableN,
    marginN: hierarchyMarginN,
  };

  if (utilization.internalThreadStrip > 1) add("INTERNAL_THREAD_STRIP_LIMIT_EXCEEDED", "Factored axial demand exceeds the internal-thread stripping allowable load.", evidenceIds("loads.axialTensionN", "capacity.internalThreadStripAllowableN", "safetyFactor"));
  if (utilization.externalThreadStrip > 1) add("EXTERNAL_THREAD_STRIP_LIMIT_EXCEEDED", "Factored axial demand exceeds the external-thread stripping allowable load.", evidenceIds("loads.axialTensionN", "capacity.externalThreadStripAllowableN", "safetyFactor"));
  if (utilization.fastenerTension > 1) add("FASTENER_TENSION_LIMIT_EXCEEDED", "Factored axial demand exceeds the fastener tensile allowable load.", evidenceIds("loads.axialTensionN", "capacity.fastenerTensileAllowableN", "safetyFactor"));
  if (failureHierarchy.status === "thread-stripping-before-fastener-tension") {
    if (input.criteria.requireFastenerTensionBeforeThreadStripping) {
      add("FAILURE_MODE_REQUIREMENT_NOT_MET", "The selected thread engagement can strip before the fastener reaches its tensile allowable, contrary to the explicit failure-mode requirement.", evidenceIds(...CAPACITY_PATHS));
      failureModeRequirementFailed = true;
    } else {
      add("THREAD_STRIPPING_GOVERNS_FAILURE_MODE", "Thread stripping is weaker than fastener tension. The applied-load check passes only conditionally because tensile fastener failure was not required to govern.", evidenceIds(...CAPACITY_PATHS));
      conditional = true;
    }
  }
  if (![factoredDemandN, ...Object.values(utilization), ...modes.map((mode) => mode.allowableLoadN), hierarchyMarginN].every(Number.isFinite)) {
    factoredDemandN = undefined;
    utilization = undefined;
    governing = undefined;
    failureHierarchy = undefined;
    add("COMPUTATION_OVERFLOW", "The selected values produce a non-finite threaded-receiver calculation.");
    unsupported = true;
  }

  const capacityFailed = issues.some((issue) => issue.code.endsWith("LIMIT_EXCEEDED"));
  const status: ThreadedReceiverCalculation["status"] = unsupported
    ? "unsupported"
    : needsInput
      ? "needs-input"
      : capacityFailed || failureModeRequirementFailed
        ? "fail"
        : conditional
          ? "conditional"
          : "pass";
  return omitUndefined({
    kind: "threaded-receiver",
    status,
    method: input.method,
    methodVersion: "1.0.0",
    inputHash: hashThreadedReceiverInput(input),
    factoredDemandN,
    utilization,
    governing,
    failureHierarchy,
    checkedScope: "One axially loaded threaded receiver using three explicit qualified allowable loads: internal and external thread stripping plus fastener tension. No capacity is derived from nominal M size alone.",
    issues,
    unchecked: [
      "preload generation, torque scatter, joint separation and relaxation beyond the supplied axial demand",
      "transverse shear, bearing, slip, prying, fastener bending and eccentric load introduction",
      "nonuniform thread load distribution unless already included in the qualified allowable loads",
      "incomplete lead or runout thread interference and blind-hole bottoming",
      "fatigue, vibration, galling, wear, corrosion, creep, impact and temperature",
      "receiver parent-part pullout, boss splitting and surrounding-member failure",
      "multiple-fastener load distribution and structural-code compliance",
    ],
  });
}

export function hashThreadedReceiverInput(input: ThreadedReceiverInput): string {
  return createHash("sha256").update(JSON.stringify(canonicalJson(input))).digest("hex");
}

function assignedEvidence(input: ThreadedReceiverInput, path: string): Evidence | undefined {
  const id = input.assignments[path];
  return id === undefined ? undefined : input.evidence.find((item) => item.id === id);
}

function isDirectlyTraceable(evidence: Evidence | undefined): boolean {
  if (evidence?.status === "measured") return evidence.sourceLocator !== undefined;
  if (evidence?.status === "sourced") return evidence.sourceUrl !== undefined && evidence.sourceHash !== undefined;
  return false;
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Threaded receiver input numbers must be finite");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalJson(entry)]));
}

function omitUndefined<T extends Record<string, unknown>>(value: T): ThreadedReceiverCalculation {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as unknown as ThreadedReceiverCalculation;
}
