import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import type { PlasticityOperations } from "../../plasticity/operations.ts";
import { generateCalculiXMeshFromStep, readElementSICN } from "./step-face-mapping.ts";
import { runLinearStaticCase, type LinearStaticCaseResult } from "./calculix-linear-static.ts";
import { classifyRefinementTrend, maximumStressLocationShiftMm } from "./refinement-diagnostics.ts";
import { resolveFemSupportConditions, type FemReportContent, type FemStaticInput } from "./fem-report-store.ts";
import { rigidBodyConstraintRank } from "./rigid-body-constraints.ts";
import { confirmedLayerOrthotropicFrames, createCohesiveLayerPlanePlan } from "./layer-plane-plan.ts";

export async function analyzeStaticSolid(
  operations: PlasticityOperations,
  input: FemStaticInput,
  workspace: string,
  signal?: AbortSignal,
): Promise<FemReportContent> {
  throwIfAborted(signal);
  const initial = await operations.state();
  throwIfAborted(signal);
  if (initial.revision !== input.revision) throw new Error("Static FEA input revision is stale");
  const body = initial.bodies.find((candidate) => candidate.id === input.bodyId);
  if (!body || body.type !== "Solid" || !body.boundsMm) throw new Error("Static FEA currently requires one current bounded native Solid");
  const supportConditions = resolveFemSupportConditions(input);
  const layerSplitPlanes = input.layerPlanePlan ? createCohesiveLayerPlanePlan(input.layerPlanePlan).planes : undefined;
  const layerFrames = input.layerPlanePlan ? confirmedLayerOrthotropicFrames(input.layerPlanePlan) : undefined;
  const supportFaceIds = supportConditions.map((condition) => condition.faceId);
  const meshSizesMm = Array.from({ length: input.meshRefinementSteps + 1 }, (_, index) => input.meshSizeMm / (2 ** index));
  for (const meshSizeMm of meshSizesMm) {
    const estimatedCells = body.boundsMm.min.reduce((product, minimum, axis) => {
      const extent = body.boundsMm!.max[axis]! - minimum;
      return product * Math.ceil(extent / (meshSizeMm * 0.5));
    }, 1);
    if (!Number.isSafeInteger(estimatedCells) || estimatedCells > 300_000) {
      throw new Error(`Requested mesh level ${meshSizeMm} mm is too fine for this Solid's bounding box; increase meshSizeMm or reduce meshRefinementSteps`);
    }
  }
  const supportFaces = supportFaceIds.map((id) => body.faces.find((face) => face.id === id));
  const loadCases = input.loadCases.length > 0
    ? input.loadCases
    : [{ name: "default", faceLoads: input.faceLoads, resultantLoads: input.resultantLoads }];
  const axisName = { 1: "x", 2: "y", 3: "z" } as const;
  const normalizedInput = {
    ...input,
    supportFaceIds: [],
    supportConditions: supportConditions.map((condition) => ({
      faceId: condition.faceId,
      fixedTranslationAxes: condition.fixedTranslationAxes.map((axis) => axisName[axis]),
    })),
    faceLoads: [],
    resultantLoads: [],
    loadCases,
  };
  const allLoadIds = loadCases.flatMap((item) => [...item.faceLoads.map((load) => load.faceId), ...item.resultantLoads.map((load) => load.faceId)]);
  const loadedFaceIds = [...new Set(allLoadIds)];
  const loadedFaces = loadedFaceIds.map((id) => body.faces.find((face) => face.id === id));
  if (supportFaces.some((face) => !face || !face.planar || face.surfaceType !== "Plane")
    || loadedFaces.some((face) => !face || !face.planar || face.surfaceType !== "Plane")) {
    throw new Error("Support and loaded faces must be current native planar faces on the selected Solid");
  }
  const currentSupportFaces = supportFaces as NonNullable<typeof supportFaces[number]>[];
  const currentLoadedFaces = loadedFaces as NonNullable<typeof loadedFaces[number]>[];
  const selectedFaces = [...currentSupportFaces, ...currentLoadedFaces].map((face) => ({
    faceId: face.id,
    surfaceType: face.surfaceType,
    centerMm: face.centerMm,
    normal: face.normal,
    boundsMm: face.boundsMm,
  }));
  const stepPath = join(workspace, "native-solid.step");
  throwIfAborted(signal);
  await operations.exportStep([body.id], stepPath, initial.revision);
  throwIfAborted(signal);
  const afterExport = await operations.state();
  const selectedFaceIds = [...supportFaceIds, ...loadedFaceIds];
  assertSameBodyGeometry(initial, afterExport, body.id, selectedFaceIds);

  const caseResults = loadCases.map((loadCase) => ({ name: loadCase.name, levels: [] as Array<{
    meshSizeMm: number; meshSha256: string; nodeCount: number; tetrahedronCount: number;
    minimumScaledInverseConditionNumber: number; fifthPercentileSampledSICN: number; medianSampledSICN: number;
    minimumSICNElementId: number; minimumSICNElementCentroidMm: [number, number, number];
    calculation: LinearStaticCaseResult & {
      maximumVonMisesElementSICN: number;
      forceEquilibriumResidualN: [number, number, number]; momentEquilibriumResidualNmm: [number, number, number];
    };
    totalResultantN: [number, number, number]; totalResultantMomentNmm: [number, number, number];
    loadFile: string;
    layerRegionGroups?: NonNullable<Awaited<ReturnType<typeof generateCalculiXMeshFromStep>>["mesh"]["layerRegionGroups"]>;
    surfaceLoads: Awaited<ReturnType<typeof generateCalculiXMeshFromStep>>["mesh"]["surfaceLoads"];
    resultantLoads: Awaited<ReturnType<typeof generateCalculiXMeshFromStep>>["mesh"]["resultantLoads"];
  }> }));
  let firstMesh: Awaited<ReturnType<typeof generateCalculiXMeshFromStep>>["mesh"] | undefined;
  let firstMapped: Awaited<ReturnType<typeof generateCalculiXMeshFromStep>> | undefined;
  let supportRigidBodyConstraintRank: 6 | undefined;
  for (const [levelIndex, meshSizeMm] of meshSizesMm.entries()) {
    let canonicalMeshText: string | undefined;
    let canonicalMeshSha256: string | undefined;
    for (const [caseIndex, loadCase] of loadCases.entries()) {
      throwIfAborted(signal);
      const meshPath = levelIndex === 0 && caseIndex === 0
        ? join(workspace, "solid-mesh.inp")
        : join(workspace, `solid-mesh-level-${levelIndex + 1}-case-${caseIndex + 1}.inp`);
      const caseMapped = await generateCalculiXMeshFromStep(
        stepPath, selectedFaces, selectedFaceIds, meshSizeMm, meshPath, undefined,
        loadCase.faceLoads, signal, loadCase.resultantLoads,
        meshPath.replace(/\.inp$/i, ".msh"),
        layerSplitPlanes,
      );
      let layerwiseOrthotropicRegions: NonNullable<Parameters<typeof runLinearStaticCase>[0]["layerwiseOrthotropicRegions"]> | undefined;
      if (layerFrames) {
        const groups = caseMapped.mesh.layerRegionGroups;
        if (!groups || groups.length !== layerFrames.length || groups.length !== input.layerPlanePlan!.totalLayerCount) {
          throw new Error("Static FEA layer mesh does not contain every confirmed G-code layer region");
        }
        layerwiseOrthotropicRegions = groups.map((group, index) => {
          const frame = layerFrames[index];
          if (!frame || group.layerIndex !== frame.layerIndex || group.layerIndex !== index + 1) {
            throw new Error(`Static FEA mesh layer ${index + 1} does not match its confirmed G-code direction`);
          }
          return { layerIndex: group.layerIndex, elsetName: group.elsetName, orientation: frame.orientation };
        });
      } else if (caseMapped.mesh.layerRegionGroups) {
        throw new Error("Gmsh produced layer regions without a complete confirmed material-frame plan");
      }
      if (caseMapped.mesh.sharedSurfaceNodeCount > 0) throw new Error("Support and loaded faces share mesh nodes; this static FEA boundary configuration is unsupported");
      const meshText = await readFile(meshPath, "utf8");
      if (canonicalMeshText === undefined) canonicalMeshText = meshText;
      else if (meshText !== canonicalMeshText) throw new Error(`Gmsh did not reproduce an identical mesh for all load cases at ${meshSizeMm} mm; comparison was stopped`);
      canonicalMeshSha256 ??= createHash("sha256").update(meshText).digest("hex");
      const supportSets = supportFaceIds.map((id) => caseMapped.mesh.nodeSets.find((set) => set.faceId === id));
      if (supportSets.some((set) => !set)) throw new Error(`Mapped mesh is missing support node-set evidence for case ${loadCase.name}`);
      if (caseIndex === 0) {
        const rank = rigidBodyConstraintRank(meshText, supportSets.map((set, index) => ({
          nodeSetName: set!.setName,
          axes: supportConditions[index]!.fixedTranslationAxes,
        })), body.boundsMm);
        if (rank < 6) {
          throw new Error(`Specified support translations constrain only ${rank} of 6 rigid-body modes; change the support faces or fixed global axes before solving`);
        }
        supportRigidBodyConstraintRank = 6;
      }
      if (levelIndex === 0 && caseIndex === 0) {
        firstMesh = caseMapped.mesh;
        firstMapped = caseMapped;
      }
      const caseLoadedIds = [...new Set([...loadCase.faceLoads.map((load) => load.faceId), ...loadCase.resultantLoads.map((load) => load.faceId)])];
      const loadedSet = caseMapped.mesh.nodeSets.find((set) => set.faceId === caseLoadedIds[0]);
      if (supportSets.some((set) => !set) || !loadedSet || !caseMapped.mesh.loadFile) throw new Error(`Mapped mesh is missing support or load evidence for case ${loadCase.name}`);
      const firstTraction = loadCase.faceLoads.find((load) => load.faceId === caseLoadedIds[0])?.tractionNPerMm2
        ?? loadCase.resultantLoads.find((load) => load.faceId === caseLoadedIds[0])?.forceN;
      const observationVector = firstTraction?.some((component) => component !== 0)
        ? firstTraction
        : loadCase.resultantLoads.find((load) => load.faceId === caseLoadedIds[0])?.momentNmm;
      if (!observationVector || !observationVector.some((component) => component !== 0)) throw new Error(`Cannot select a displacement axis for case ${loadCase.name}`);
      const observationAxis = ([0, 1, 2] as const).reduce((bestAxis, axis) => Math.abs(observationVector[axis]!) > Math.abs(observationVector[bestAxis]!) ? axis : bestAxis, 0);
      const jobName = levelIndex === 0
        ? caseIndex === 0 ? "static-fem" : `static-fem-case-${caseIndex + 1}`
        : `static-fem-level-${levelIndex + 1}-case-${caseIndex + 1}`;
      const solverCalculation = await runLinearStaticCase({
        workspacePath: workspace,
        meshPath,
        loadIncludePath: caseMapped.mesh.loadFile,
        jobName,
        youngsModulusMPa: input.youngsModulusMPa,
        poissonRatio: input.poissonRatio,
        ...(input.orthotropicMaterial ? { orthotropicMaterial: {
          youngsModulus2MPa: input.orthotropicMaterial.youngsModulus2MPa,
          youngsModulus3MPa: input.orthotropicMaterial.youngsModulus3MPa,
          poissonRatio13: input.orthotropicMaterial.poissonRatio13,
          poissonRatio23: input.orthotropicMaterial.poissonRatio23,
          shearModulus12MPa: input.orthotropicMaterial.shearModulus12MPa,
          shearModulus13MPa: input.orthotropicMaterial.shearModulus13MPa,
          shearModulus23MPa: input.orthotropicMaterial.shearModulus23MPa,
          orientation: input.orthotropicMaterial.orientation,
        } } : {}),
        ...(layerwiseOrthotropicRegions ? { layerwiseOrthotropicRegions } : {}),
        ...(input.orthotropicMaterial?.tsaiWuCriterion ? { orthotropicTsaiWuCriterion: {
          strengths: input.orthotropicMaterial.tsaiWuCriterion.strengths,
          interactions: input.orthotropicMaterial.tsaiWuCriterion.interactions,
        } } : {}),
        supports: supportSets.map((set, index) => ({ nodeSetName: set!.setName, axes: supportConditions[index]!.fixedTranslationAxes })),
        displacementObservation: { nodeSetName: loadedSet.setName, axis: (observationAxis + 1) as 1 | 2 | 3 },
        anchors: [],
      }, signal);
      const maximumVonMisesElementSICN = await readElementSICN(
        caseMapped.mesh.elementSICNFile,
        caseMapped.elementIds,
        solverCalculation.maximumVonMisesLocation.elementId,
      );
      const calculation = {
        ...solverCalculation,
        maximumVonMisesElementSICN,
        maximumVonMisesOnMinimumSICNElement: solverCalculation.maximumVonMisesLocation.elementId === caseMapped.mesh.minimumSICNElementId,
        forceEquilibriumResidualN: solverCalculation.supportReactionN.map((value, axis) => value + caseMapped.mesh.totalResultantN[axis]!) as [number, number, number],
        momentEquilibriumResidualNmm: solverCalculation.supportReactionMomentNmm.map((value, axis) => value + caseMapped.mesh.totalResultantMomentNmm[axis]!) as [number, number, number],
      };
      caseResults[caseIndex]!.levels.push({
        meshSizeMm, meshSha256: canonicalMeshSha256, nodeCount: caseMapped.mesh.nodeCount,
        tetrahedronCount: caseMapped.mesh.tetrahedronCount,
        minimumScaledInverseConditionNumber: caseMapped.mesh.minimumScaledInverseConditionNumber,
        fifthPercentileSampledSICN: caseMapped.mesh.fifthPercentileSampledSICN,
        medianSampledSICN: caseMapped.mesh.medianSampledSICN,
        minimumSICNElementId: caseMapped.mesh.minimumSICNElementId,
        minimumSICNElementCentroidMm: caseMapped.mesh.minimumSICNElementCentroidMm,
        calculation,
        totalResultantN: caseMapped.mesh.totalResultantN,
        totalResultantMomentNmm: caseMapped.mesh.totalResultantMomentNmm,
        loadFile: caseMapped.mesh.loadFile!,
        ...(caseMapped.mesh.layerRegionGroups ? { layerRegionGroups: caseMapped.mesh.layerRegionGroups } : {}),
        surfaceLoads: caseMapped.mesh.surfaceLoads,
        resultantLoads: caseMapped.mesh.resultantLoads,
      });
    }
  }
  if (!firstMesh || !firstMapped) throw new Error("Static FEA did not produce a base mesh");
  const caseReports = caseResults.map(({ name, levels }) => {
    const first = levels[0]!;
    return {
      name, meshSha256: first.meshSha256, loadFile: first.loadFile, surfaceLoads: first.surfaceLoads, resultantLoads: first.resultantLoads,
      totalResultantN: first.totalResultantN, totalResultantMomentNmm: first.totalResultantMomentNmm,
      calculation: first.calculation,
      refinementDiagnostics: {
        maximumVonMisesMPa: classifyRefinementTrend(levels.map((level) => level.calculation.maximumVonMisesMPa)),
        maximumDisplacementOnSetMm: classifyRefinementTrend(levels.map((level) => level.calculation.maximumDisplacementOnSetMm)),
        ...(levels.every((level) => level.calculation.maximumPrincipalStressMPa !== undefined)
          ? { maximumPrincipalStressMPa: classifyRefinementTrend(levels.map((level) => level.calculation.maximumPrincipalStressMPa!)) }
          : {}),
        ...(levels.every((level) => level.calculation.minimumPrincipalStressMPa !== undefined)
          ? { minimumPrincipalStressMPa: classifyRefinementTrend(levels.map((level) => level.calculation.minimumPrincipalStressMPa!)) }
          : {}),
        interpretation: "sampled-trend-only" as const,
      },
      meshLevels: levels.map((level, index) => {
        const previous = levels[index - 1]?.calculation;
        const current = level.calculation;
        const percent = (value: number, base: number): number | null => base === 0 ? null : (value - base) / Math.abs(base) * 100;
        return {
          meshSizeMm: level.meshSizeMm, meshSha256: level.meshSha256, nodeCount: level.nodeCount,
          tetrahedronCount: level.tetrahedronCount, minimumScaledInverseConditionNumber: level.minimumScaledInverseConditionNumber,
          ...(level.layerRegionGroups ? { layerRegionGroups: level.layerRegionGroups } : {}),
          fifthPercentileSampledSICN: level.fifthPercentileSampledSICN, medianSampledSICN: level.medianSampledSICN,
          minimumSICNElementId: level.minimumSICNElementId, minimumSICNElementCentroidMm: level.minimumSICNElementCentroidMm,
          totalResultantN: level.totalResultantN, totalResultantMomentNmm: level.totalResultantMomentNmm,
          calculation: level.calculation,
          relativeChangeFromPreviousPercent: previous ? {
            maximumVonMisesMPa: percent(current.maximumVonMisesMPa, previous.maximumVonMisesMPa),
            maximumDisplacementOnSetMm: percent(current.maximumDisplacementOnSetMm, previous.maximumDisplacementOnSetMm),
            ...(current.maximumPrincipalStressMPa === undefined || previous.maximumPrincipalStressMPa === undefined
              ? {} : { maximumPrincipalStressMPa: percent(current.maximumPrincipalStressMPa, previous.maximumPrincipalStressMPa) }),
            ...(current.minimumPrincipalStressMPa === undefined || previous.minimumPrincipalStressMPa === undefined
              ? {} : { minimumPrincipalStressMPa: percent(current.minimumPrincipalStressMPa, previous.minimumPrincipalStressMPa) }),
            maximumVonMisesLocationShiftMm: maximumStressLocationShiftMm(
              previous.maximumVonMisesLocation,
              current.maximumVonMisesLocation,
            ),
          } : null,
        };
      }),
    };
  });
  const calculation = caseReports[0]!.calculation;
  throwIfAborted(signal);

  const completed = await operations.state();
  assertSameBodyGeometry(afterExport, completed, body.id, selectedFaceIds);
  const mappedSupportFaces = supportFaceIds.map((id) => firstMapped!.mappings.find((face) => face.faceId === id));
  if (mappedSupportFaces.some((face) => !face)) throw new Error("A native support face did not map into the exported STEP solid");
  return {
    kind: "static-fem-linear-elastic",
    binding: {
      sessionId: operations.datumRegistry.sessionId,
      documentToken: completed.documentToken,
      revision: completed.revision,
      bodyId: body.id,
    },
    input: { ...normalizedInput, revision: completed.revision },
    bodyName: body.name,
    boundsMm: body.boundsMm,
    gmshVersion: firstMapped.gmshVersion,
    faceMappings: firstMapped.mappings,
    supportFaceAreasMm2: mappedSupportFaces.map((face) => ({ faceId: face!.faceId, areaMm2: face!.areaMm2 })),
    supportRigidBodyConstraintRank,
    mesh: { ...firstMesh, meshSha256: caseReports[0]!.meshSha256 },
    calculation,
    cases: caseReports,
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Static FEA analysis was cancelled");
}

function assertSameBodyGeometry(
  before: Awaited<ReturnType<PlasticityOperations["state"]>>,
  after: Awaited<ReturnType<PlasticityOperations["state"]>>,
  bodyId: number,
  faceIds: string[],
): void {
  const beforeBody = before.bodies.find((body) => body.id === bodyId);
  const afterBody = after.bodies.find((body) => body.id === bodyId);
  if (before.documentToken !== after.documentToken || before.revision !== after.revision || !beforeBody || !afterBody
    || beforeBody.versionId !== afterBody.versionId || JSON.stringify(beforeBody.boundsMm) !== JSON.stringify(afterBody.boundsMm)) {
    throw new Error("Plasticity document or Solid geometry changed during FEA; result was discarded");
  }
  for (const faceId of faceIds) {
    const first = beforeBody.faces.find((face) => face.id === faceId);
    const second = afterBody.faces.find((face) => face.id === faceId);
    if (!first || !second || JSON.stringify(first) !== JSON.stringify(second)) {
      throw new Error("Selected support or load face changed during FEA; result was discarded");
    }
  }
}
