import { isDeepStrictEqual } from "node:util";

import type { StoredFemReport } from "./fem-report-store.ts";
import { classifyRefinementTrend, maximumStressLocationShiftMm } from "./refinement-diagnostics.ts";

const calculationFields = [
  "solver",
  "elementFamily",
  "stressCoordinateBasis",
  "stressIntegrationPointCount",
  "stressTensorComponentExtrema",
  "orthotropicTsaiWu",
  "maximumSxxMPa",
  "minimumSxxMPa",
  "maximumVonMisesMPa",
  "maximumVonMisesLocation",
  "maximumPrincipalStressMPa",
  "maximumPrincipalStressLocation",
  "minimumPrincipalStressMPa",
  "minimumPrincipalStressLocation",
  "maximumVonMisesElementSICN",
  "maximumVonMisesOnMinimumSICNElement",
  "maximumDisplacementOnSetMm",
  "prescribedDisplacementMm",
  "displacementObservationNodeSetName",
  "displacementObservationAxis",
  "supportReactionN",
  "supportReactionMomentNmm",
  "supportReactionsByNodeSet",
  "forceEquilibriumResidualN",
  "momentEquilibriumResidualNmm",
] as const;

export function compareFemRefinementReports(reports: readonly StoredFemReport[]) {
  if (reports.length < 2 || reports.length > 4) throw new Error("Provide 2–4 FEA reports for a refinement comparison");
  if (new Set(reports.map((report) => report.id)).size !== reports.length) throw new Error("FEA report IDs must be unique");

  const reference = reports[0]!;
  for (const report of reports.slice(1)) {
    if (!isDeepStrictEqual(report.binding, reference.binding)) throw new Error("FEA reports must refer to the same CAD session, document, revision and body");
    if (!isDeepStrictEqual(comparisonInput(report), comparisonInput(reference))) throw new Error("FEA reports must use identical loads, supports, material properties and evidence");
    if (report.bodyName !== reference.bodyName || !isDeepStrictEqual(report.boundsMm, reference.boundsMm)
      || !isDeepStrictEqual(report.faceMappings, reference.faceMappings)
      || !isDeepStrictEqual(report.supportFaceAreasMm2, reference.supportFaceAreasMm2)) {
      throw new Error("FEA reports do not contain identical native geometry evidence");
    }
  }

  const referenceCases = requireCases(reference);
  const caseNames = referenceCases.map((item) => item.name);
  const cases = referenceCases.map((referenceCase) => {
    const levelsByHash = new Map<string, {
      meshSizeMm: number;
      meshSha256: string;
      nodeCount: number;
      tetrahedronCount: number;
      minimumScaledInverseConditionNumber: number;
      fifthPercentileSampledSICN?: number | undefined;
      medianSampledSICN?: number | undefined;
      minimumSICNElementId?: number | undefined;
      minimumSICNElementCentroidMm?: [number, number, number] | undefined;
      calculation: StoredFemReport["calculation"];
    }>();
    const meshHashBySize = new Map<number, string>();

    for (const report of reports) {
      const reportCases = requireCases(report);
      if (!isDeepStrictEqual(reportCases.map((item) => item.name), caseNames)) {
        throw new Error("FEA reports must contain the same named load cases in the same order");
      }
      const loadCase = reportCases.find((item) => item.name === referenceCase.name)!;
      if (!loadCase.meshLevels?.length) throw new Error(`FEA report ${report.id} has no mesh-level evidence for case ${loadCase.name}`);
      for (const level of loadCase.meshLevels) {
        const previousHashAtSize = meshHashBySize.get(level.meshSizeMm);
        if (previousHashAtSize !== undefined && previousHashAtSize !== level.meshSha256) {
          throw new Error(`Mesh size ${level.meshSizeMm} mm produced different mesh hashes; the reports cannot be merged`);
        }
        meshHashBySize.set(level.meshSizeMm, level.meshSha256);
        const existing = levelsByHash.get(level.meshSha256);
        if (existing) {
          if (existing.meshSizeMm !== level.meshSizeMm || existing.nodeCount !== level.nodeCount
            || existing.tetrahedronCount !== level.tetrahedronCount
            || existing.minimumScaledInverseConditionNumber !== level.minimumScaledInverseConditionNumber
            || existing.fifthPercentileSampledSICN !== level.fifthPercentileSampledSICN
            || existing.medianSampledSICN !== level.medianSampledSICN
            || existing.minimumSICNElementId !== level.minimumSICNElementId
            || !isDeepStrictEqual(existing.minimumSICNElementCentroidMm, level.minimumSICNElementCentroidMm)
            || !sameSolverResult(existing.calculation, level.calculation)) {
            throw new Error(`Repeated mesh ${level.meshSha256} did not reproduce identical solver evidence`);
          }
          continue;
        }
        levelsByHash.set(level.meshSha256, {
          meshSizeMm: level.meshSizeMm,
          meshSha256: level.meshSha256,
          nodeCount: level.nodeCount,
          tetrahedronCount: level.tetrahedronCount,
          minimumScaledInverseConditionNumber: level.minimumScaledInverseConditionNumber,
          ...(level.fifthPercentileSampledSICN === undefined ? {} : { fifthPercentileSampledSICN: level.fifthPercentileSampledSICN }),
          ...(level.medianSampledSICN === undefined ? {} : { medianSampledSICN: level.medianSampledSICN }),
          ...(level.minimumSICNElementId === undefined ? {} : { minimumSICNElementId: level.minimumSICNElementId }),
          ...(level.minimumSICNElementCentroidMm === undefined ? {} : { minimumSICNElementCentroidMm: level.minimumSICNElementCentroidMm }),
          calculation: level.calculation,
        });
      }
    }

    const mergedLevels = [...levelsByHash.values()].sort((left, right) => right.meshSizeMm - left.meshSizeMm);
    if (mergedLevels.length < 2) throw new Error(`FEA reports for case ${referenceCase.name} do not provide at least two distinct mesh levels`);
    for (let index = 1; index < mergedLevels.length; index += 1) {
      const previous = mergedLevels[index - 1]!;
      const current = mergedLevels[index]!;
      if (current.meshSizeMm >= previous.meshSizeMm || current.tetrahedronCount <= previous.tetrahedronCount) {
        throw new Error("Combined refinement levels must have strictly finer mesh sizes and increasing element counts");
      }
    }

    return {
      name: referenceCase.name,
      refinementDiagnostics: {
        maximumVonMisesMPa: classifyRefinementTrend(mergedLevels.map((level) => level.calculation.maximumVonMisesMPa)),
        maximumDisplacementOnSetMm: classifyRefinementTrend(mergedLevels.map((level) => level.calculation.maximumDisplacementOnSetMm)),
        ...(mergedLevels.every((level) => level.calculation.maximumPrincipalStressMPa !== undefined)
          ? { maximumPrincipalStressMPa: classifyRefinementTrend(mergedLevels.map((level) => level.calculation.maximumPrincipalStressMPa!)) }
          : {}),
        ...(mergedLevels.every((level) => level.calculation.minimumPrincipalStressMPa !== undefined)
          ? { minimumPrincipalStressMPa: classifyRefinementTrend(mergedLevels.map((level) => level.calculation.minimumPrincipalStressMPa!)) }
          : {}),
        interpretation: "sampled-trend-only" as const,
      },
      meshLevels: mergedLevels.map((level, index) => {
        const previous = mergedLevels[index - 1]?.calculation;
        const current = level.calculation;
        const relativeChange = (value: number, base: number): number | null => base === 0 ? null : (value - base) / Math.abs(base) * 100;
        return {
          meshSizeMm: level.meshSizeMm,
          meshSha256: level.meshSha256,
          nodeCount: level.nodeCount,
          tetrahedronCount: level.tetrahedronCount,
          minimumScaledInverseConditionNumber: level.minimumScaledInverseConditionNumber,
          ...(level.fifthPercentileSampledSICN === undefined ? {} : { fifthPercentileSampledSICN: level.fifthPercentileSampledSICN }),
          ...(level.medianSampledSICN === undefined ? {} : { medianSampledSICN: level.medianSampledSICN }),
          ...(level.minimumSICNElementId === undefined ? {} : { minimumSICNElementId: level.minimumSICNElementId }),
          ...(level.minimumSICNElementCentroidMm === undefined ? {} : { minimumSICNElementCentroidMm: level.minimumSICNElementCentroidMm }),
          maximumVonMisesMPa: current.maximumVonMisesMPa,
          ...(current.stressCoordinateBasis === undefined ? {} : { stressCoordinateBasis: current.stressCoordinateBasis }),
          maximumDisplacementOnSetMm: current.maximumDisplacementOnSetMm,
          maximumVonMisesLocation: current.maximumVonMisesLocation,
          ...(current.maximumPrincipalStressMPa === undefined ? {} : { maximumPrincipalStressMPa: current.maximumPrincipalStressMPa }),
          ...(current.maximumPrincipalStressLocation === undefined ? {} : { maximumPrincipalStressLocation: current.maximumPrincipalStressLocation }),
          ...(current.minimumPrincipalStressMPa === undefined ? {} : { minimumPrincipalStressMPa: current.minimumPrincipalStressMPa }),
          ...(current.minimumPrincipalStressLocation === undefined ? {} : { minimumPrincipalStressLocation: current.minimumPrincipalStressLocation }),
          ...(current.stressTensorComponentExtrema === undefined ? {} : { stressTensorComponentExtrema: current.stressTensorComponentExtrema }),
          relativeChangeFromPreviousPercent: previous ? {
            maximumVonMisesMPa: relativeChange(current.maximumVonMisesMPa, previous.maximumVonMisesMPa),
            maximumDisplacementOnSetMm: relativeChange(current.maximumDisplacementOnSetMm, previous.maximumDisplacementOnSetMm),
            ...(current.maximumPrincipalStressMPa === undefined || previous.maximumPrincipalStressMPa === undefined
              ? {} : { maximumPrincipalStressMPa: relativeChange(current.maximumPrincipalStressMPa, previous.maximumPrincipalStressMPa) }),
            ...(current.minimumPrincipalStressMPa === undefined || previous.minimumPrincipalStressMPa === undefined
              ? {} : { minimumPrincipalStressMPa: relativeChange(current.minimumPrincipalStressMPa, previous.minimumPrincipalStressMPa) }),
            maximumVonMisesLocationShiftMm: maximumStressLocationShiftMm(previous.maximumVonMisesLocation, current.maximumVonMisesLocation),
          } : null,
        };
      }),
    };
  });

  return {
    kind: "static-fem-refinement-comparison" as const,
    interpretation: "sampled-trend-only" as const,
    binding: reference.binding,
    reports: reports.map(({ id, createdAt }) => ({ id, createdAt })),
    cases,
  };
}

function comparisonInput(report: StoredFemReport): Omit<StoredFemReport["input"], "meshSizeMm" | "meshRefinementSteps"> {
  const { meshSizeMm: _meshSizeMm, meshRefinementSteps: _meshRefinementSteps, ...input } = report.input;
  return input;
}

function requireCases(report: StoredFemReport): NonNullable<StoredFemReport["cases"]> {
  if (!report.cases?.length) throw new Error(`FEA report ${report.id} has no named-case refinement evidence`);
  return report.cases;
}

function sameSolverResult(
  first: StoredFemReport["calculation"],
  second: StoredFemReport["calculation"],
): boolean {
  return calculationFields.every((field) => isDeepStrictEqual(first[field], second[field]));
}
