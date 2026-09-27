#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
interface Options { help: boolean; target?: string; allowMutations: boolean; output?: string }

export function parseBracketAcceptanceArgs(argv: string[]): Options {
  if (argv.length === 0) return { help: true, allowMutations: false };
  const options: Options = { help: false, allowMutations: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--allow-disposable-mutations") options.allowMutations = true;
    else if (argument === "--target" || argument === "--output") {
      const value = argv[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      if (argument === "--target") options.target = value;
      else options.output = value;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Pass --target with an explicit Plasticity window ID");
  if (!options.allowMutations) throw new Error("Pass --allow-disposable-mutations for the disposable bracket fixture");
  if (!options.output) throw new Error("Pass --output with a new evidence directory");
  return options;
}

const syntheticMaterial = {
  youngsModulusMPa: 2_000,
  poissonRatio: 0.3,
  youngsModulusEvidence: {
    id: "bracket-test-youngs-modulus",
    label: "Synthetic representative-bracket solver fixture modulus",
    status: "assumed" as const,
    unit: "MPa" as const,
    value: 2_000,
    derivation: "Software acceptance fixture only; not a physical material qualification.",
    dependsOn: [],
  },
  poissonRatioEvidence: {
    id: "bracket-test-poisson-ratio",
    label: "Synthetic representative-bracket solver fixture Poisson ratio",
    status: "assumed" as const,
    unit: "ratio" as const,
    value: 0.3,
    derivation: "Software acceptance fixture only; not a physical material qualification.",
    dependsOn: [],
  },
};

async function main(): Promise<void> {
  const options = parseBracketAcceptanceArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: npm run accept:fem-bracket -- --target WINDOW_ID --allow-disposable-mutations --output NEW_DIRECTORY");
    return;
  }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(projectRoot, "scripts", "run-server.ts")],
    cwd: projectRoot,
    env: {
      ...selectedEnvironment(process.env),
      PLASTICITY_STRENGTH_ROOT: join(output, "strength-store"),
      PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "plasticity-fem-bracket-acceptance", version: "1.0.0" });
  const evidence: Record<string, unknown> = { schemaVersion: 1, startedAt: new Date().toISOString(), plasticityVersion: "26.1.3", workbenchUsed: false };
  let initial: any;
  let knownRevision: string | undefined;
  let confirmedUndoSteps = 0;
  let ownsDocument = false;
  try {
    await client.connect(transport);
    const windows = await call(client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity window was not found");
    initial = await call(client, "plasticity_connect", { targetId: options.target });
    requireCondition(initial.bodies.length === 0 && initial.regions.length === 0, "Refusing live FEA acceptance in a nonempty document");
    knownRevision = initial.revision;
    ownsDocument = true;
    const snapshot = await call(client, "plasticity_capture_snapshot", { label: "representative-bracket-fea-before" });

    const wire = await call(client, "plasticity_create_polyline", {
      pointsMm: [[0, 0, 0], [30, 0, 0], [30, 6, 0], [10, 6, 0], [10, 25, 0], [0, 25, 0]],
      closed: true,
      intent: "Create a disposable rounded L-bracket section for solver integration acceptance",
      revision: knownRevision,
    });
    confirmedUndoSteps += 1;
    knownRevision = wire.revision;
    const wireId = wire.bodies.find((body: any) => body.type === "Wire")?.id;
    requireCondition(Number.isInteger(wireId), "Native bracket profile Wire was not created");
    const vertices = await call(client, "plasticity_list_curve_vertices", {});
    const rootCorner = vertices.vertices.find((vertex: any) => vertex.bodyId === wireId
      && Math.abs(vertex.positionMm[0] - 10) < 1e-7
      && Math.abs(vertex.positionMm[1] - 6) < 1e-7
      && Math.abs(vertex.positionMm[2]) < 1e-7);
    requireCondition(rootCorner, "Could not identify the exact concave bracket-root profile vertex");
    const rounded = await call(client, "plasticity_fillet_curve_vertices", {
      vertices: [{ bodyId: rootCorner.bodyId, vertexId: rootCorner.vertexId }],
      radiusMm: 4,
      intent: "Round the disposable bracket's internal root corner for mesh-sensitivity study",
      revision: knownRevision,
    });
    confirmedUndoSteps += 1;
    knownRevision = rounded.revision;
    const regionList = await call(client, "plasticity_list_regions", {});
    requireCondition(regionList.regions.length === 1, `Expected one rounded bracket profile region, found ${regionList.regions.length}`);
    const extruded = await call(client, "plasticity_extrude_regions", {
      regionIds: [regionList.regions[0].id],
      distanceMm: 15,
      intent: "Create the disposable 15 mm-wide native bracket solid",
      revision: knownRevision,
    });
    confirmedUndoSteps += 1;
    knownRevision = extruded.revision;
    const bracket = extruded.bodies.find((body: any) => body.type === "Solid");
    requireCondition(bracket && bracket.boundsMm, "Bracket extrusion did not produce a bounded native Solid");
    near(bracket.boundsMm.min[0], 0, 0.01, "bracket min X");
    near(bracket.boundsMm.max[0], 30, 0.01, "bracket max X");
    near(bracket.boundsMm.min[1], 0, 0.01, "bracket min Y");
    near(bracket.boundsMm.max[1], 25, 0.01, "bracket max Y");
    near(bracket.boundsMm.min[2], 0, 0.01, "bracket min Z");
    near(bracket.boundsMm.max[2], 15, 0.01, "bracket max Z");

    const support = bracket.faces.find((face: any) => face.planar && face.normal[0] < -0.99999
      && Math.abs(face.boundsMm.min[0]) < 0.01 && Math.abs(face.boundsMm.max[0]) < 0.01);
    const loaded = bracket.faces.find((face: any) => face.planar && face.normal[1] > 0.99999
      && Math.abs(face.boundsMm.min[1] - 6) < 0.01 && Math.abs(face.boundsMm.max[1] - 6) < 0.01);
    requireCondition(support && loaded && support.id !== loaded.id, "Could not identify exact, distinct wall-support and shelf-load planar faces");
    const modelState = await call(client, "plasticity_status", {});
    knownRevision = modelState.revision;
    const loadedFaceMeasurement = await call(client, "plasticity_measure_face_properties", { faces: [{ bodyId: bracket.id, faceId: loaded.id }], revision: knownRevision });
    requireCondition(loadedFaceMeasurement.faces.length === 1 && loadedFaceMeasurement.faces[0].areaMm2 > 0, "Could not measure exact loaded-face area from native B-rep");
    evidence.fixture = {
      name: "rounded single-piece L-bracket",
      bodyId: bracket.id,
      profileRootRadiusMm: 4,
      boundsMm: bracket.boundsMm,
      supportFace: { id: support.id, centerMm: support.centerMm, normal: support.normal },
      loadedFace: { id: loaded.id, centerMm: loaded.centerMm, normal: loaded.normal, areaMm2: loadedFaceMeasurement.faces[0].areaMm2 },
      measurementSource: "native-brep",
    };

    const analysisInput = {
      bodyId: bracket.id,
      revision: knownRevision,
      supportConditions: [{ faceId: support.id, fixedTranslationAxes: ["x", "y", "z"] }],
      loadCases: [{
        name: "vertical-shelf-load",
        faceLoads: [{ faceId: loaded.id, tractionNPerMm2: [0, -0.1, 0] }],
        resultantLoads: [],
      }],
      meshSizeMm: 6,
      meshRefinementSteps: 2,
      ...syntheticMaterial,
    };
    const underconstrained = await client.callTool({
      name: "plasticity_analyze_static_fem",
      arguments: {
        ...analysisInput,
        supportConditions: [{ faceId: support.id, fixedTranslationAxes: ["x"] }],
      },
    });
    requireCondition(underconstrained.isError === true && /constrain only 3 of 6 rigid-body modes/.test(JSON.stringify(underconstrained.content)),
      "Public FEA MCP did not reject rigid-body motion before invoking the solver");
    const report = await call(client, "plasticity_analyze_static_fem", analysisInput);
    requireCondition(report.kind === "static-fem-linear-elastic" && report.input.meshRefinementSteps === 2, "Public FEA MCP did not return the requested three-level representative bracket analysis");
    requireCondition(report.cases.length === 1 && report.cases[0].meshLevels.length === 3, "Representative bracket report omitted mesh levels");
    requireCondition(report.supportRigidBodyConstraintRank === 6, "FEA report omitted the full rigid-body restraint-rank evidence");
    requireCondition(report.cases.every((loadCase: any) => loadCase.refinementDiagnostics?.interpretation === "sampled-trend-only"
      && ["increasing", "decreasing", "unchanged", "non-monotonic", "insufficient-levels"].includes(loadCase.refinementDiagnostics.maximumVonMisesMPa)
      && ["increasing", "decreasing", "unchanged", "non-monotonic", "insufficient-levels"].includes(loadCase.refinementDiagnostics.maximumDisplacementOnSetMm)),
    "Public FEA MCP omitted sampled-only mesh trend classifications");
    requireCondition(report.strengthPass === false && report.printApproved === false, "Solver report incorrectly claims strength or print approval");
    requireCondition(report.input.youngsModulusEvidence.status === "assumed" && report.input.poissonRatioEvidence.status === "assumed", "Synthetic assumptions were not preserved in the report");
    const reportView = await call(client, "plasticity_static_fem_report", { reportId: report.id });
    requireCondition(reportView.freshness.status === "current", "Representative bracket FEA report is not current immediately after analysis");
    const finerReport = await call(client, "plasticity_analyze_static_fem", { ...analysisInput, meshSizeMm: 3 });
    requireCondition(finerReport.kind === "static-fem-linear-elastic" && finerReport.cases.length === 1 && finerReport.cases[0].meshLevels.length === 3,
      "Second public FEA report did not return the overlapping fine mesh levels");
    const refinementComparison = await call(client, "plasticity_compare_static_fem_refinement_reports", { reportIds: [report.id, finerReport.id] });
    requireCondition(refinementComparison.freshness.status === "current" && refinementComparison.cases.length === 1
      && refinementComparison.cases[0].meshLevels.length === 4
      && refinementComparison.cases[0].refinementDiagnostics.interpretation === "sampled-trend-only"
      && refinementComparison.cases[0].refinementDiagnostics.maximumVonMisesMPa === "increasing"
      && refinementComparison.cases[0].refinementDiagnostics.maximumDisplacementOnSetMm === "increasing",
    "Public MCP did not merge the overlapping reports into four current, diagnostic-only levels");
    const finerView = await call(client, "plasticity_static_fem_report", { reportId: finerReport.id });
    requireCondition(finerView.freshness.status === "current", "Second representative bracket FEA report is not current immediately after analysis");
    const couponFixture = await recordSyntheticOrthotropicTsaiWuCoupon(client);
    const orthotropicInput = {
      bodyId: bracket.id,
      revision: knownRevision,
      supportConditions: [{ faceId: support.id, fixedTranslationAxes: ["x", "y", "z"] }],
      loadCases: [{ name: "synthetic-single-material-screen", faceLoads: [{ faceId: loaded.id, tractionNPerMm2: [0, -0.1, 0] }], resultantLoads: [] }],
      meshSizeMm: 6,
      youngsModulusMPa: 2_100,
      youngsModulusEvidence: syntheticEvidence("orthotropic-screen-e1", 2_100, "MPa"),
      poissonRatio: 0.3,
      poissonRatioEvidence: syntheticEvidence("orthotropic-screen-nu12", 0.3, "ratio"),
      orthotropicMaterial: {
        youngsModulus2MPa: couponFixture.constants.youngsModulus2MPa,
        youngsModulus3MPa: couponFixture.constants.youngsModulus3MPa,
        poissonRatio13: couponFixture.constants.poissonRatio13,
        poissonRatio23: couponFixture.constants.poissonRatio23,
        shearModulus12MPa: couponFixture.constants.shearModulus12MPa,
        shearModulus13MPa: couponFixture.constants.shearModulus13MPa,
        shearModulus23MPa: couponFixture.constants.shearModulus23MPa,
        evidence: couponFixture.orthotropicPropertyEvidence,
        orientation: {
          axis1DirectionGlobal: [1, 0, 0], axis2ReferenceDirectionGlobal: [0, 1, 0], buildDirectionGlobal: [0, 0, 1],
          evidence: { status: "user-confirmed", description: "Synthetic acceptance fixture axes only; not physical print-orientation evidence." },
        },
        process: couponFixture.process,
        tsaiWuQualificationRecordId: couponFixture.recordId,
      },
    };
    const orthotropicReport = await call(client, "plasticity_analyze_static_fem", orthotropicInput);
    requireCondition(orthotropicReport.orthotropicTsaiWuScreen?.kind === "orthotropic-tsai-wu-3d-proportional-load-factor-screen",
      "Public FEA MCP did not load the exact-process coupon and return the Tsai-Wu diagnostic");
    requireCondition(orthotropicReport.strengthPass === false && orthotropicReport.printApproved === false,
      "Synthetic Tsai-Wu acceptance must never return a strength pass or print approval");
    requireCondition(orthotropicReport.input.orthotropicMaterial.tsaiWuCriterion.qualificationRecordId === couponFixture.recordId
      && orthotropicReport.input.orthotropicMaterial.tsaiWuCriterion.strengthEvidence.xTensionMPa.process.materialId === couponFixture.process.materialId,
    "Persisted FEA input did not preserve the coupon-record reference and one-material process identity");
    const orthotropicView = await call(client, "plasticity_static_fem_report", { reportId: orthotropicReport.id });
    requireCondition(orthotropicView.freshness.status === "current", "Coupon-bound orthotropic FEA report is not current after analysis");
    evidence.orthotropicCouponBinding = {
      reportId: orthotropicReport.id,
      recordId: couponFixture.recordId,
      process: couponFixture.process,
      criterion: orthotropicReport.orthotropicTsaiWuScreen,
      freshness: orthotropicView.freshness,
      strengthPass: orthotropicReport.strengthPass,
      printApproved: orthotropicReport.printApproved,
      methodScope: "synthetic isolated single-material software acceptance; not a physical material qualification or strength result",
    };
    const layerAngle = Math.PI / 4;
    const layerNormal = [Math.sin(layerAngle), 0, Math.cos(layerAngle)] as [number, number, number];
    await call(client, "plasticity_rotate", {
      ids: [bracket.id], pivotMm: [0, 0, 0], axis: [0, 1, 0], degrees: 45,
      intent: "Rotate the disposable bracket so its build-layer normal is oblique to global axes for cohesive MCP acceptance",
      revision: knownRevision,
    });
    confirmedUndoSteps += 1;
    const tiltedState = await call(client, "plasticity_status", {});
    knownRevision = tiltedState.revision;
    const tiltedBracket = tiltedState.bodies.find((body: any) => body.id === bracket.id && body.type === "Solid");
    requireCondition(tiltedBracket, "Rotated acceptance bracket disappeared before the oblique cohesive analysis");
    const tiltedProcess = { ...couponFixture.process, orientationDeg: [0, 45, 0] };
    const tiltedMaterialId = (tiltedProcess as Record<string, unknown>).materialId;
    const tiltedCoupon = await recordSyntheticOrthotropicCoupon(client, tiltedProcess, layerNormal);
    const layerTestRecord = await recordSyntheticSameMaterialLayerTest(client, tiltedProcess, layerNormal);
    const dot3 = (left: number[], right: number[]) => left.reduce((sum, value, index) => sum + value * right[index]!, 0);
    const layerTangent: [number, number, number] = [Math.cos(layerAngle), 0, -Math.sin(layerAngle)];
    const modeIFractureEnergyNPerMm = 0.0010998;
    const modeIIFractureEnergyNPerMm = modeIFractureEnergyNPerMm * 2;
    const modeIIRecord = await recordSyntheticLayerInterfaceCurve(client, {
      process: tiltedProcess,
      interfaceNormalGlobal: layerNormal,
      loadDirectionGlobal: layerTangent,
      testMode: "interface-shear",
      testMethod: "Synthetic ASTM D7905 ENF cohesive integration fixture",
      fixtureIndex: 101,
      peakNormalTractionMPa: 0,
      peakTangentialTractionMPa: 2,
      normalEnergyNPerMm: 0,
      tangentialEnergyNPerMm: modeIIFractureEnergyNPerMm,
    });
    const mixedModeRecords = await Promise.all([0.25, 0.75].map((tangentialEnergyFraction, index) => {
      const totalEnergy = modeIFractureEnergyNPerMm
        + (modeIIFractureEnergyNPerMm - modeIFractureEnergyNPerMm) * tangentialEnergyFraction ** 2;
      const normalEnergy = totalEnergy * (1 - tangentialEnergyFraction);
      const tangentialEnergy = totalEnergy * tangentialEnergyFraction;
      const peakNormalTractionMPa = 2.4;
      const peakTangentialTractionMPa = 2;
      const directionMagnitude = Math.hypot(Math.sqrt(1 - tangentialEnergyFraction), Math.sqrt(tangentialEnergyFraction));
      const loadDirectionGlobal = layerNormal.map((component, axis) =>
        (Math.sqrt(1 - tangentialEnergyFraction) * component + Math.sqrt(tangentialEnergyFraction) * layerTangent[axis]!) / directionMagnitude,
      ) as [number, number, number];
      return recordSyntheticLayerInterfaceCurve(client, {
        process: tiltedProcess,
        interfaceNormalGlobal: layerNormal,
        loadDirectionGlobal,
        testMode: "mixed-mode",
        testMethod: "Synthetic ASTM D6671 MMB cohesive integration fixture",
        fixtureIndex: 102 + index,
        peakNormalTractionMPa,
        peakTangentialTractionMPa,
        normalEnergyNPerMm: normalEnergy,
        tangentialEnergyNPerMm: tangentialEnergy,
      });
    }));
    const cohesiveSupport = tiltedBracket.faces.find((face: any) => face.planar && dot3(face.normal, layerNormal) < -0.99999
      && dot3(face.centerMm, layerNormal) < 0.01);
    const cohesiveLoad = tiltedBracket.faces.find((face: any) => face.planar && dot3(face.normal, layerNormal) > 0.99999
      && dot3(face.centerMm, layerNormal) > 14.99);
    requireCondition(cohesiveSupport && cohesiveLoad && cohesiveSupport.id !== cohesiveLoad.id,
      "Could not identify exact native support and load faces on opposite sides of the synthetic layer planes");
    evidence.cohesiveBoundaryFaces = {
      support: { id: cohesiveSupport.id, centerMm: cohesiveSupport.centerMm, normal: cohesiveSupport.normal, boundsMm: cohesiveSupport.boundsMm },
      loaded: { id: cohesiveLoad.id, centerMm: cohesiveLoad.centerMm, normal: cohesiveLoad.normal, boundsMm: cohesiveLoad.boundsMm },
    };
    const cohesiveReport = await call(client, "plasticity_analyze_cohesive_interface", {
      bodyId: bracket.id,
      revision: knownRevision,
      interfaceTestRecordId: layerTestRecord.recordId,
      splitPlanes: [5, 10].map((offset) => ({
        pointMm: layerNormal.map((component) => component * offset),
        normalGlobal: layerNormal,
      })),
      layerPlanePlan: {
        processProfileHash: "a".repeat(64),
        firstInterfacePointMm: layerNormal.map((component) => component * 5),
        buildDirectionGlobal: layerNormal,
        layerHeightMm: 0.2,
        totalLayerCount: 40,
        interfaceLayerIndices: [1, 26],
        interfaceOffsetsMm: [0, 5],
      },
      negativeSideMaterial: "A",
      supportFaceId: cohesiveSupport.id,
      loadedFaceId: cohesiveLoad.id,
      meshSizeMm: 6,
      poissonRatioA: 0.3,
      poissonRatioEvidenceA: sourcedFixtureEvidence("cohesive-nu-a", 0.3, "ratio"),
      poissonRatioB: 0.3,
      poissonRatioEvidenceB: sourcedFixtureEvidence("cohesive-nu-b", 0.3, "ratio"),
      useOrthotropicBulkProperties: true,
      modeIIRecordId: modeIIRecord.recordId,
      mixedModeRecordIds: mixedModeRecords.map((record) => record.recordId),
      initialStiffnessMPaPerMm: 100_000,
      initialStiffnessEvidence: sourcedFixtureEvidence("cohesive-stiffness", 100_000, "MPa/mm"),
      prescribedDisplacementGlobalMm: layerNormal.map((component, axis) => 0.03 * component + 0.03 * layerTangent[axis]!),
      adherencePenalty: 0.00001,
      increments: 100,
    }, 600_000);
    requireCondition(cohesiveReport.physicalTest.interfaceKind === "same-material-layer"
      && cohesiveReport.solver.solver === "Code_Aster 17.4.0"
      && cohesiveReport.solver.resultInterpretation === "raw-mixed-mode-cohesive-solver-response"
      && cohesiveReport.turonCalibration?.calibration.materialPair.interfaceKind === "same-material-layer"
      && cohesiveReport.turonCalibration.calibration.materialPair.materialAProcess.materialId === tiltedMaterialId
      && cohesiveReport.turonCalibration.calibration.materialPair.materialBProcess.materialId === tiltedMaterialId
      && cohesiveReport.turonCalibration.calibration.samples.length === 2
      && cohesiveReport.mesh.volumeCount === 3
      && cohesiveReport.mesh.interfaceSurfaceCount === 2,
    "Same-material orthotropic cohesive MCP route did not return the expected two-interface solver response");
    requireCondition(cohesiveReport.strengthPass === false && cohesiveReport.printApproved === false,
      "Cohesive acceptance must never return a strength pass or print approval");
    const cohesiveView = await call(client, "plasticity_cohesive_fem_report", { reportId: cohesiveReport.id });
    requireCondition(cohesiveView.freshness.status === "current", "Same-material cohesive report is not current after analysis");
    evidence.sameMaterialLayerCohesive = {
      reportId: cohesiveReport.id,
      interfaceTestRecordId: layerTestRecord.recordId,
      modeIIRecordId: modeIIRecord.recordId,
      mixedModeRecordIds: mixedModeRecords.map((record) => record.recordId),
      couponRecordId: tiltedCoupon.recordId,
      process: tiltedProcess,
      materialAssignment: cohesiveReport.materialAssignment,
      solver: cohesiveReport.solver.solver,
      solverInterpretation: cohesiveReport.solver.resultInterpretation,
      turonCalibration: cohesiveReport.turonCalibration.calibration,
      mesh: {
        volumeCount: cohesiveReport.mesh.volumeCount,
        interfaceSurfaceCount: cohesiveReport.mesh.interfaceSurfaceCount,
        cohesiveElementCount: cohesiveReport.mesh.cohesiveElementCount,
        meshSizeMm: cohesiveReport.mesh.meshSizeMm,
      },
      reportFreshness: cohesiveView.freshness,
      strengthPass: cohesiveReport.strengthPass,
      printApproved: cohesiveReport.printApproved,
      methodScope: "synthetic isolated same-material layer-interface software acceptance; not a physical adhesion qualification or strength result",
    };
    const firstStudy = report.cases[0].meshLevels;
    const secondStudy = finerReport.cases[0].meshLevels;
    requireCondition(firstStudy[1].meshSha256 === secondStudy[0].meshSha256 && firstStudy[2].meshSha256 === secondStudy[1].meshSha256,
      "Overlapping mesh sizes from separate MCP reports were not byte-identical; refusing to merge their trends");
    const levels = [...firstStudy, secondStudy[2]];
    for (let index = 1; index < levels.length; index += 1) {
      requireCondition(levels[index].meshSizeMm < levels[index - 1].meshSizeMm, "Merged refinement study is not strictly ordered by mesh size");
      requireCondition(levels[index].tetrahedronCount > levels[index - 1].tetrahedronCount, "Merged refinement study did not increase tetrahedron count");
      requireCondition(levels[index].meshSha256 !== levels[index - 1].meshSha256, "Merged refinement study contains a duplicate mesh level");
    }
    for (let index = 1; index < levels.length; index += 1) {
      requireCondition(levels[index].relativeChangeFromPreviousPercent !== null, "A refinement level omitted its stress/displacement change record");
    }
    const finest = levels.at(-1)!;
    const load = report.mesh.surfaceLoads.find((item: any) => item.faceId === loaded.id);
    requireCondition(load, "FEA report omitted native loaded-face transfer evidence");
    near(load.surfaceAreaMm2, loadedFaceMeasurement.faces[0].areaMm2, 0.01, "loaded-face area transfer");
    near(load.resultantN[1], -0.1 * loadedFaceMeasurement.faces[0].areaMm2, 0.01, "loaded-face force transfer");
    for (const residual of [...report.cases[0].calculation.forceEquilibriumResidualN, ...report.cases[0].calculation.momentEquilibriumResidualNmm]) {
      near(residual, 0, 0.02, "bracket FEA equilibrium residual");
    }
    evidence.fea = {
      reportId: report.id,
      additionalReportId: finerReport.id,
      supportRigidBodyConstraintRank: report.supportRigidBodyConstraintRank,
      underconstrainedSupportError: JSON.stringify(underconstrained.content),
      refinementComparison,
      freshness: { first: reportView.freshness, second: finerView.freshness },
      methodScope: "linear-elastic single Solid; synthetic boundary conditions/material; no strength verdict",
      loadCase: report.cases[0],
      mesh: {
        gmshVersion: report.gmshVersion,
        refinementLevels: levels,
        finestPeakLocator: finest.calculation.maximumVonMisesLocation,
      },
      loadTransfer: load,
      equilibrium: {
        forceResidualN: report.cases[0].calculation.forceEquilibriumResidualN,
        momentResidualNmm: report.cases[0].calculation.momentEquilibriumResidualNmm,
        supportReactionN: report.cases[0].calculation.supportReactionN,
      },
      strengthPass: report.strengthPass,
      printApproved: report.printApproved,
    };
    const journal = await call(client, "plasticity_construction_journal", {});
    requireCondition(journal.syncStatus === "in-sync" && !journal.entries.some((entry: { status: string }) => entry.status === "unknown"), "Construction journal is uncertain before bracket cleanup");
    if (!knownRevision) throw new Error("Bracket revision was not recorded before cleanup");
    const removed = await undoOwnedSteps(client, initial, knownRevision, confirmedUndoSteps);
    confirmedUndoSteps = 0;
    ownsDocument = false;
    requireCondition(removed.documentToken === initial.documentToken && removed.bodies.length === 0 && removed.regions.length === 0, "Bracket cleanup did not restore the empty document");
    const stale = await call(client, "plasticity_static_fem_report", { reportId: report.id });
    const finerStale = await call(client, "plasticity_static_fem_report", { reportId: finerReport.id });
    const orthotropicStale = await call(client, "plasticity_static_fem_report", { reportId: orthotropicReport.id });
    const cohesiveStale = await call(client, "plasticity_cohesive_fem_report", { reportId: cohesiveReport.id });
    requireCondition(stale.freshness.status === "stale" && finerStale.freshness.status === "stale" && orthotropicStale.freshness.status === "stale" && cohesiveStale.freshness.status === "stale", "Bracket solver reports did not become stale after removal of their Solid");
    const changes = await call(client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(changes.diff), "Scene content differs from the initial empty snapshot after bracket cleanup");
    evidence.feaFreshnessAfterCleanup = { first: stale.freshness, second: finerStale.freshness, orthotropicCouponBinding: orthotropicStale.freshness, sameMaterialLayerCohesive: cohesiveStale.freshness };
    evidence.cleanup = { restoredEmptyDocument: true, sceneContentsRestored: true, undoSteps: 4, journalSyncStatus: "in-sync" };
    evidence.completedAt = new Date().toISOString();
    await writeFile(join(output, "evidence.json"), `${JSON.stringify(sanitizeEvidence(evidence), null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ ok: true, evidence: join(output, "evidence.json") }, null, 2));
  } catch (error) {
    evidence.failure = error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
    if (initial && ownsDocument && confirmedUndoSteps > 0 && knownRevision) {
      evidence.cleanup = await undoOwnedSteps(client, initial, knownRevision, confirmedUndoSteps)
        .then((state) => ({ restoredEmptyDocument: state.documentToken === initial.documentToken && state.bodies.length === 0 && state.regions.length === 0, undoSteps: confirmedUndoSteps }))
        .catch((cleanupError) => ({ restoredEmptyDocument: false, reason: cleanupError instanceof Error ? cleanupError.message.slice(0, 1_000) : String(cleanupError) }));
    } else if (confirmedUndoSteps > 0) evidence.cleanup = { restoredEmptyDocument: false, reason: "Revision/document ownership was not proven; no automatic Undo was attempted" };
    await writeFile(join(output, "failure.json"), `${JSON.stringify(sanitizeEvidence(evidence), null, 2)}\n`, { flag: "wx", mode: 0o600 }).catch(() => {});
    throw error;
  } finally {
    await client.close().catch(() => {});
  }
}

async function recordSyntheticOrthotropicTsaiWuCoupon(client: Client): Promise<{
  recordId: string;
  process: Record<string, unknown>;
  constants: Record<string, number>;
  orthotropicPropertyEvidence: Record<string, unknown>;
}> {
  const process = {
    printerId: "synthetic-acceptance-printer",
    materialId: "synthetic-acceptance-single-material",
    profileHash: "a".repeat(64),
    orientationDeg: [0, 0, 0],
    infillPercent: 100,
    nozzleTemperatureC: 220,
    layerHeightMm: 0.2,
  };
  const constants = {
    youngsModulus2MPa: 1_800,
    youngsModulus3MPa: 900,
    poissonRatio13: 0.22,
    poissonRatio23: 0.26,
    shearModulus12MPa: 700,
    shearModulus13MPa: 350,
    shearModulus23MPa: 300,
  };
  const strengths = {
    xTensionMPa: 80, xCompressionMPa: 90, yTensionMPa: 60, yCompressionMPa: 70,
    zTensionMPa: 20, zCompressionMPa: 40, xyShearMPa: 25, xzShearMPa: 12, yzShearMPa: 10,
  };
  const interactions = { xy: 0.2, xz: 0.1, yz: 0.15 };
  const source = "https://example.test/synthetic-acceptance-only";
  const evidence = [
    ...Object.entries({ youngModulusMPa: 2_100, shearModulusMPa: 740, tensileStrengthMPa: 31, shearStrengthMPa: 17 })
      .map(([key, value], index) => ({ id: `base-${key}`, label: `Synthetic acceptance ${key}`, status: "measured", unit: "MPa", value, sourceUrl: source, sourceHash: fixtureHash(index), sourceLocator: `synthetic-only/${key}`, dependsOn: [] })),
    ...Object.entries(constants).map(([key, value], index) => ({ id: `ortho-${key}`, label: `Synthetic acceptance ${key}`, status: "measured", unit: key.startsWith("poisson") ? "ratio" : "MPa", value, sourceUrl: source, sourceHash: fixtureHash(index + 4), sourceLocator: `synthetic-only/${key}`, dependsOn: [] })),
    ...Object.entries(strengths).map(([key, value], index) => ({ id: `strength-${key}`, label: `Synthetic acceptance ${key}`, status: "measured", unit: "MPa", value, sourceUrl: source, sourceHash: fixtureHash(index + 11), sourceLocator: `synthetic-only/${key}`, dependsOn: [] })),
    ...Object.keys(interactions).map((key, index) => ({ id: `biaxial-${key}`, label: `Synthetic acceptance biaxial ${key}`, status: "measured", sourceUrl: source, sourceHash: fixtureHash(index + 20), sourceLocator: `synthetic-only/biaxial-${key}`, dependsOn: [] })),
    ...Object.entries(interactions).map(([key, value], index) => ({ id: `interaction-${key}`, label: `Synthetic acceptance interaction ${key}`, status: "derived", unit: "ratio", value, sourceUrl: source, sourceHash: fixtureHash(index + 23), sourceLocator: `synthetic-only/fit-${key}`, derivation: "Synthetic test-fixture fit only.", dependsOn: [`biaxial-${key}`] })),
  ];
  const basePropertyEvidence = { youngModulusMPa: ["base-youngModulusMPa"], shearModulusMPa: ["base-shearModulusMPa"], tensileStrengthMPa: ["base-tensileStrengthMPa"], shearStrengthMPa: ["base-shearStrengthMPa"] };
  const qualification = await call(client, "plasticity_record_material_coupon_data", {
    process,
    properties: { youngModulusMPa: 2_100, shearModulusMPa: 740, tensileStrengthMPa: 31, shearStrengthMPa: 17 },
    propertyEvidence: basePropertyEvidence,
    orthotropicMaterial: {
      ...constants,
      propertyEvidence: Object.fromEntries(Object.keys(constants).map((key) => [key, [`ortho-${key}`]])),
      orientation: {
        axis1DirectionGlobal: [1, 0, 0], axis2ReferenceDirectionGlobal: [0, 1, 0], buildDirectionGlobal: [0, 0, 1],
        evidence: { status: "user-confirmed", description: "Synthetic acceptance axes only; no physical print orientation is claimed." },
      },
      tsaiWuCriterion: {
        strengths,
        interactions,
        strengthEvidence: Object.fromEntries(Object.keys(strengths).map((key) => [key, [`strength-${key}`]])),
        interactionEvidence: { xy: "interaction-xy", xz: "interaction-xz", yz: "interaction-yz" },
      },
    },
    evidence,
    testStandard: "isolated synthetic software acceptance fixture",
    specimenCount: 1,
    testedAt: new Date().toISOString(),
    source: "physical-coupon-test",
    callerConfirmsPhysicalTests: true,
  });
  const recordId = qualification.record?.id;
  requireCondition(typeof recordId === "string", "Synthetic coupon fixture did not return its immutable record ID");
  const orthotropicPropertyEvidence = Object.fromEntries(Object.entries(constants).map(([key, value], index) => [key, {
    id: `orthotropic-fea-${key}`, label: `Synthetic acceptance ${key}`, status: "measured",
    unit: key.startsWith("poisson") ? "ratio" : "MPa", value, sourceUrl: source,
    sourceHash: fixtureHash(index + 40), sourceLocator: `synthetic-only/fea-${key}`, dependsOn: [],
  }]));
  return { recordId, process, constants, orthotropicPropertyEvidence };
}

function syntheticEvidence(id: string, value: number, unit: "MPa" | "ratio"): Record<string, unknown> {
  return {
    id, label: `Synthetic acceptance ${id}`, status: "assumed", unit, value,
    derivation: "Isolated software acceptance fixture only; not a physical material qualification.", dependsOn: [],
  };
}

function sourcedFixtureEvidence(id: string, value: number, unit: "MPa" | "ratio" | "MPa/mm"): Record<string, unknown> {
  return {
    id,
    label: `Synthetic acceptance ${id}`,
    status: "sourced",
    unit,
    value,
    sourceUrl: "https://example.test/synthetic-acceptance-only",
    sourceHash: fixtureHash(70 + id.length),
    sourceLocator: `synthetic-only/${id}`,
    dependsOn: [],
  };
}

async function recordSyntheticSameMaterialLayerTest(
  client: Client,
  process: Record<string, unknown>,
  interfaceNormalGlobal: [number, number, number] = [0, 0, 1],
): Promise<{ recordId: string }> {
  const peakStrengthMPa = 2.4;
  const record = await call(client, "plasticity_record_material_interface_test", {
    interfaceKind: "same-material-layer",
    materialAProcess: process,
    materialBProcess: process,
    testMode: "normal-tension",
    interfaceNormalGlobal,
    loadDirectionGlobal: interfaceNormalGlobal,
    testMethod: "Synthetic DCB cohesive integration fixture",
    testProtocolHash: fixtureHash(62),
    specimenDescription: "Synthetic same-material layer coupon for software acceptance only.",
    fixtureDescription: "Synthetic normal-opening displacement fixture, not a physical test.",
    measuredPeakStrengthMPa: peakStrengthMPa,
    tractionSeparationCurve: {
      sourceHash: fixtureHash(63),
      sourceLocator: "synthetic-only/cohesive-curve.csv",
      points: [
        { separationMm: 0, tractionMPa: 0 },
        { separationMm: 0.000167, tractionMPa: peakStrengthMPa },
        { separationMm: 0.0005, tractionMPa: 1.2 },
        { separationMm: 0.001, tractionMPa: 0 },
      ],
    },
    failureLocation: "interface",
    evidence: [{
      id: "synthetic-layer-peak",
      label: "Synthetic same-material layer peak strength",
      status: "measured",
      unit: "MPa",
      value: peakStrengthMPa,
      sourceUrl: "https://example.test/synthetic-acceptance-only",
      sourceHash: fixtureHash(64),
      sourceLocator: "synthetic-only/peak-strength",
      dependsOn: [],
    }],
    specimenCount: 1,
    testedAt: new Date().toISOString(),
    source: "physical-material-interface-test",
    callerConfirmsPhysicalTests: true,
  });
  const recordId = record.record?.id;
  requireCondition(typeof recordId === "string", "Synthetic same-material layer test did not return its immutable record ID");
  return { recordId };
}

async function recordSyntheticLayerInterfaceCurve(
  client: Client,
  input: {
    process: Record<string, unknown>;
    interfaceNormalGlobal: [number, number, number];
    loadDirectionGlobal: [number, number, number];
    testMode: "interface-shear" | "mixed-mode";
    testMethod: string;
    fixtureIndex: number;
    peakNormalTractionMPa: number;
    peakTangentialTractionMPa: number;
    normalEnergyNPerMm: number;
    tangentialEnergyNPerMm: number;
  },
): Promise<{ recordId: string }> {
  const measuredPeakStrengthMPa = Math.hypot(input.peakNormalTractionMPa, input.peakTangentialTractionMPa);
  const record = await call(client, "plasticity_record_material_interface_test", {
    interfaceKind: "same-material-layer",
    materialAProcess: input.process,
    materialBProcess: input.process,
    testMode: input.testMode,
    interfaceNormalGlobal: input.interfaceNormalGlobal,
    loadDirectionGlobal: input.loadDirectionGlobal,
    testMethod: input.testMethod,
    testProtocolHash: fixtureHash(input.fixtureIndex),
    specimenDescription: "Synthetic same-material printed-layer specimen for software acceptance only.",
    fixtureDescription: "Synthetic mixed opening/shear displacement fixture, not a physical test.",
    measuredPeakStrengthMPa,
    ...(input.testMode === "interface-shear" ? {
      tractionSeparationCurve: {
        sourceHash: fixtureHash(input.fixtureIndex + 10),
        sourceLocator: `synthetic-only/interface-curve-${input.fixtureIndex}.csv`,
        points: [
          { separationMm: 0, tractionMPa: 0 },
          { separationMm: input.tangentialEnergyNPerMm / input.peakTangentialTractionMPa, tractionMPa: input.peakTangentialTractionMPa },
          { separationMm: 2 * input.tangentialEnergyNPerMm / input.peakTangentialTractionMPa, tractionMPa: 0 },
        ],
      },
    } : {
      mixedModeTractionSeparationCurve: {
        sourceHash: fixtureHash(input.fixtureIndex + 10),
        sourceLocator: `synthetic-only/mixed-mode-curve-${input.fixtureIndex}.csv`,
        points: [
          { normalSeparationMm: 0, tangentialSeparationMm: 0, normalTractionMPa: 0, tangentialTractionMPa: 0 },
          {
            normalSeparationMm: input.normalEnergyNPerMm / input.peakNormalTractionMPa,
            tangentialSeparationMm: input.tangentialEnergyNPerMm / input.peakTangentialTractionMPa,
            normalTractionMPa: input.peakNormalTractionMPa,
            tangentialTractionMPa: input.peakTangentialTractionMPa,
          },
          {
            normalSeparationMm: 2 * input.normalEnergyNPerMm / input.peakNormalTractionMPa,
            tangentialSeparationMm: 2 * input.tangentialEnergyNPerMm / input.peakTangentialTractionMPa,
            normalTractionMPa: 0,
            tangentialTractionMPa: 0,
          },
        ],
      },
    }),
    failureLocation: "interface",
    evidence: [{
      id: `synthetic-layer-interface-peak-${input.fixtureIndex}`,
      label: "Synthetic same-material layer interface peak strength",
      status: "measured",
      unit: "MPa",
      value: measuredPeakStrengthMPa,
      sourceUrl: "https://example.test/synthetic-acceptance-only",
      sourceHash: fixtureHash(input.fixtureIndex + 20),
      sourceLocator: `synthetic-only/interface-peak-${input.fixtureIndex}`,
      dependsOn: [],
    }],
    specimenCount: 1,
    testedAt: new Date().toISOString(),
    source: "physical-material-interface-test",
    callerConfirmsPhysicalTests: true,
  });
  const recordId = record.record?.id;
  requireCondition(typeof recordId === "string", `Synthetic ${input.testMode} same-material interface test did not return its immutable record ID`);
  return { recordId };
}

async function recordSyntheticOrthotropicCoupon(
  client: Client,
  process: Record<string, unknown>,
  buildDirectionGlobal: [number, number, number],
): Promise<{ recordId: string }> {
  const properties = { youngModulusMPa: 2_100, shearModulusMPa: 740, tensileStrengthMPa: 31, shearStrengthMPa: 17 };
  const orthotropic = {
    youngsModulus2MPa: 1_800, youngsModulus3MPa: 900, poissonRatio13: 0.22,
    poissonRatio23: 0.26, shearModulus12MPa: 700, shearModulus13MPa: 350, shearModulus23MPa: 300,
  };
  const sourceUrl = "https://example.test/synthetic-acceptance-only";
  const evidence = [
    ...Object.entries(properties).map(([key, value], index) => ({
      id: `tilted-${key}`, label: `Synthetic tilted acceptance ${key}`, status: "measured", unit: "MPa", value,
      sourceUrl, sourceHash: fixtureHash(index + 80), sourceLocator: `synthetic-only/tilted-${key}`, dependsOn: [],
    })),
    ...Object.entries(orthotropic).map(([key, value], index) => ({
      id: `tilted-${key}`, label: `Synthetic tilted acceptance ${key}`, status: "measured",
      unit: key.startsWith("poisson") ? "ratio" : "MPa", value,
      sourceUrl, sourceHash: fixtureHash(index + 90), sourceLocator: `synthetic-only/tilted-${key}`, dependsOn: [],
    })),
  ];
  const result = await call(client, "plasticity_record_material_coupon_data", {
    process,
    properties,
    propertyEvidence: {
      youngModulusMPa: ["tilted-youngModulusMPa"], shearModulusMPa: ["tilted-shearModulusMPa"],
      tensileStrengthMPa: ["tilted-tensileStrengthMPa"], shearStrengthMPa: ["tilted-shearStrengthMPa"],
    },
    orthotropicMaterial: {
      ...orthotropic,
      propertyEvidence: Object.fromEntries(Object.keys(orthotropic).map((key) => [key, [`tilted-${key}`]])),
      orientation: {
        axis1DirectionGlobal: [buildDirectionGlobal[2], 0, -buildDirectionGlobal[0]],
        axis2ReferenceDirectionGlobal: [0, 1, 0],
        buildDirectionGlobal,
        evidence: { status: "user-confirmed", description: "Synthetic acceptance frame only; no physical print orientation is claimed." },
      },
    },
    evidence,
    testStandard: "isolated synthetic tilted-layer software acceptance fixture",
    specimenCount: 1,
    testedAt: new Date().toISOString(),
    source: "physical-coupon-test",
    callerConfirmsPhysicalTests: true,
  });
  requireCondition(typeof result.record?.id === "string", "Synthetic coupon for the tilted print process was not recorded");
  return { recordId: result.record.id };
}

function fixtureHash(value: number): string {
  return value.toString(16).padStart(64, "0");
}

async function undoOwnedSteps(client: Client, initial: any, expectedRevision: string, count: number): Promise<any> {
  let state = await call(client, "plasticity_status", {});
  requireCondition(state.documentToken === initial.documentToken && state.revision === expectedRevision, "Document or revision changed independently; refusing automatic cleanup");
  const journal = await call(client, "plasticity_construction_journal", {});
  requireCondition(journal.syncStatus === "in-sync" && !journal.entries.some((entry: { status: string }) => entry.status === "unknown"), "Construction journal is uncertain; refusing automatic cleanup");
  for (let index = 0; index < count; index += 1) {
    state = await call(client, "plasticity_undo", { intent: "Cleanup disposable representative bracket FEA acceptance", revision: state.revision });
  }
  return state;
}

async function call(client: Client, name: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<any> {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
  const text = toolText(response);
  if ("isError" in response && response.isError) throw new Error(text);
  return JSON.parse(text);
}

function toolText(response: unknown): string {
  if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content");
  const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string");
  if (!item) throw new Error("MCP tool returned no text content");
  return item.text;
}

function near(actual: number, expected: number, tolerance: number, label: string): void {
  requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`);
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : []));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
