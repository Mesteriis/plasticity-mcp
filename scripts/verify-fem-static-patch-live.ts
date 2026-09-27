#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { runLinearStaticCase } from "../src/strength/fem/calculix-linear-static.ts";
import { generateCalculiXMeshFromStep } from "../src/strength/fem/step-face-mapping.ts";
import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const syntheticMaterialEvidence = {
  youngsModulusEvidence: {
    id: "static-patch-test-youngs-modulus",
    label: "Synthetic static FEA acceptance modulus",
    status: "assumed" as const,
    unit: "MPa" as const,
    value: 2000,
    derivation: "Synthetic solver acceptance fixture only; not a physical material qualification.",
    dependsOn: [],
  },
  poissonRatioEvidence: {
    id: "static-patch-test-poisson-ratio",
    label: "Synthetic static FEA acceptance Poisson ratio",
    status: "assumed" as const,
    unit: "ratio" as const,
    value: 0.3,
    derivation: "Synthetic solver acceptance fixture only; not a physical material qualification.",
    dependsOn: [],
  },
};
interface Options { help: boolean; target?: string; allowMutations: boolean; output?: string }

function parseArgs(argv: string[]): Options {
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
    } else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Pass --target with an explicit Plasticity window ID");
  if (!options.allowMutations) throw new Error("Pass --allow-disposable-mutations to authorize the disposable patch-test solid");
  if (!options.output) throw new Error("Pass --output with a new evidence directory");
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: npm run accept:fem-static-patch -- --target WINDOW_ID --allow-disposable-mutations --output NEW_DIRECTORY");
    return;
  }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const evidence: Record<string, unknown> = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    targetId: options.target,
    plasticityVersion: "26.1.3",
    testCase: {
      geometryMm: [10, 5, 4],
      material: {
        youngsModulusMPa: 2000,
        poissonRatio: 0.3,
        youngsModulusEvidence: "explicit synthetic acceptance assumption",
        poissonRatioEvidence: "explicit synthetic acceptance assumption",
      },
      displacementMm: 0.5,
      selectiveSupportFixture: { closedHollowWallThicknessMm: 1, meshSizeMm: 2, refinementSteps: 3, supportAxes: [["x", "y"], ["z"]] },
    },
  };
  const store = join(output, "strength-store");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(projectRoot, "scripts", "run-server.ts")],
    cwd: projectRoot,
    env: {
      ...selectedEnvironment(process.env),
      PLASTICITY_STRENGTH_ROOT: store,
      PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "plasticity-fem-static-patch-acceptance", version: "1.0.0" });
  let initial: any;
  let disposableBodyId: number | undefined;
  const disposableBodyIds = new Set<number>();
  let disposableUndoCount = 0;
  let partialSupportReportId: string | undefined;
  let partialSupportEvidence: Record<string, unknown> | undefined;
  try {
    await client.connect(transport);
    const windows = await call(client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    initial = await call(client, "plasticity_connect", { targetId: options.target });
    requireCondition(initial.bodies.length === 0, "Refusing the live solver test in a nonempty document");
    const snapshot = await call(client, "plasticity_capture_snapshot", { label: "fem-static-patch-before" });

    const created = await call(client, "plasticity_create_box", {
      originMm: [0, 0, 0],
      sizeMm: [10, 5, 4],
      name: "Disposable FEA static patch probe",
      intent: "Authorized end-to-end Gmsh and CalculiX acceptance",
      revision: initial.revision,
    });
    requireCondition(created.bodies.length === 1, "Native probe did not produce exactly one Solid");
    const body = created.bodies[0];
    disposableBodyId = body.id;
    disposableBodyIds.add(body.id);
    disposableUndoCount += 1;
    requireCondition(body.faces.length === 6, `Expected 6 native box faces, found ${body.faces.length}`);
    const stepPath = join(output, "probe.step");
    const exported = await call(client, "plasticity_export_step", { ids: [body.id], path: stepPath, revision: created.revision });
    const afterExport = await call(client, "plasticity_status", {});
    requireCondition(afterExport.bodies.length === 1 && afterExport.bodies[0].id === body.id, "STEP export changed native scene contents");

    const faces = body.faces.map((face: any) => ({
      faceId: face.id,
      surfaceType: face.surfaceType,
      centerMm: face.centerMm,
      normal: face.normal,
      boundsMm: face.boundsMm,
    }));
    const supportFace = faces.find((face: any) => face.normal[0] < -0.99999);
    const loadedFace = faces.find((face: any) => face.normal[0] > 0.99999);
    requireCondition(supportFace && loadedFace, "Could not identify opposing native planar end faces");
    const mcpReport = await call(client, "plasticity_analyze_static_fem", {
      bodyId: body.id,
      revision: afterExport.revision,
      supportConditions: [{ faceId: supportFace.faceId, fixedTranslationAxes: ["x", "y", "z"] }],
      loadCases: [
        {
          name: "combined-load",
          faceLoads: [{ faceId: loadedFace.faceId, tractionNPerMm2: [100, 0, 0] }],
          resultantLoads: [{
            faceId: loadedFace.faceId,
            forceN: [0, 100, 0],
            applicationPointMm: loadedFace.centerMm,
            momentNmm: [0, 0, 500],
          }],
        },
        {
          name: "transverse-load",
          faceLoads: [],
          resultantLoads: [{
            faceId: loadedFace.faceId,
            forceN: [0, 0, 40],
            applicationPointMm: loadedFace.centerMm,
            momentNmm: [0, 100, 0],
          }],
        },
      ],
      meshSizeMm: 2,
      meshRefinementSteps: 3,
      orthotropicMaterial: {
        youngsModulus2MPa: 1500,
        youngsModulus3MPa: 1000,
        poissonRatio13: 0.22,
        poissonRatio23: 0.27,
        shearModulus12MPa: 500,
        shearModulus13MPa: 400,
        shearModulus23MPa: 300,
        evidence: {
          youngsModulus2MPa: syntheticOrthotropicEvidence("e2", "Orthotropic E2", 1500, "MPa"),
          youngsModulus3MPa: syntheticOrthotropicEvidence("e3", "Orthotropic E3", 1000, "MPa"),
          poissonRatio13: syntheticOrthotropicEvidence("nu13", "Orthotropic nu13", 0.22, "ratio"),
          poissonRatio23: syntheticOrthotropicEvidence("nu23", "Orthotropic nu23", 0.27, "ratio"),
          shearModulus12MPa: syntheticOrthotropicEvidence("g12", "Orthotropic G12", 500, "MPa"),
          shearModulus13MPa: syntheticOrthotropicEvidence("g13", "Orthotropic G13", 400, "MPa"),
          shearModulus23MPa: syntheticOrthotropicEvidence("g23", "Orthotropic G23", 300, "MPa"),
        },
        orientation: {
          axis1DirectionGlobal: [1, 0, 0],
          axis2ReferenceDirectionGlobal: [0, 1, 0],
          buildDirectionGlobal: [0, 0, 1],
          evidence: { status: "user-confirmed", description: "Synthetic acceptance assumption: material axis 1 is global X and material axis 2 is global Y." },
        },
      },
      ...syntheticMaterialEvidence,
      youngsModulusMPa: 2000,
      poissonRatio: 0.3,
    });
    requireCondition(mcpReport.kind === "static-fem-linear-elastic" && mcpReport.mesh.elementFamily === "C3D4", "Public MCP did not return a CalculiX Solid analysis");
    requireCondition(mcpReport.input.youngsModulusEvidence?.status === "assumed"
      && mcpReport.input.poissonRatioEvidence.status === "assumed",
    "Public MCP did not preserve the explicit scenario-only material assumptions");
    requireCondition(mcpReport.input.orthotropicMaterial?.youngsModulus2MPa === 1500
      && mcpReport.input.orthotropicMaterial?.orientation?.axis1DirectionGlobal.join(",") === "1,0,0"
      && mcpReport.input.orthotropicMaterial?.orientation?.buildDirectionGlobal.join(",") === "0,0,1"
      && mcpReport.calculation.stressCoordinateBasis === "material-local"
      && mcpReport.cases.every((loadCase: any) => loadCase.meshLevels.every((level: any) => level.calculation.stressCoordinateBasis === "material-local")),
    "Public MCP did not persist the orthotropic constants, print axes and local stress-coordinate basis");
    requireCondition(mcpReport.input.supportConditions?.length === 1
      && mcpReport.input.supportConditions[0]?.faceId === supportFace.faceId
      && mcpReport.input.supportConditions[0]?.fixedTranslationAxes.join(",") === "x,y,z",
    "Public MCP report did not retain the explicit global support condition");
    requireCondition(mcpReport.cases.length === 2 && mcpReport.cases[0].name === "combined-load" && mcpReport.cases[1].name === "transverse-load", "Public MCP did not preserve both named independent load cases");
    requireCondition(mcpReport.cases[0].calculation.jobName !== mcpReport.cases[1].calculation.jobName, "Named cases did not receive separate solver jobs");
    requireCondition(mcpReport.cases.every((loadCase: any) => loadCase.meshLevels.length === 4), "Public MCP did not return all four requested mesh refinement levels");
    for (const loadCase of mcpReport.cases) {
      requireCondition(["increasing", "decreasing", "unchanged", "non-monotonic", "insufficient-levels"].includes(loadCase.refinementDiagnostics.maximumPrincipalStressMPa)
        && ["increasing", "decreasing", "unchanged", "non-monotonic", "insufficient-levels"].includes(loadCase.refinementDiagnostics.minimumPrincipalStressMPa),
      `Public MCP omitted principal-stress mesh trends for ${loadCase.name}`);
      requireCondition(loadCase.meshLevels[0].relativeChangeFromPreviousPercent === null
        && loadCase.meshLevels.slice(1).every((level: any) => Number.isFinite(level.relativeChangeFromPreviousPercent.maximumPrincipalStressMPa)
          && Number.isFinite(level.relativeChangeFromPreviousPercent.minimumPrincipalStressMPa)),
      `Public MCP omitted signed principal-stress changes for ${loadCase.name}`);
    }
    requireCondition(Number.isSafeInteger(mcpReport.mesh.minimumSICNElementId)
      && mcpReport.mesh.minimumSICNElementId > 0
      && mcpReport.mesh.minimumSICNElementCentroidMm.every((value: number, axis: number) => value >= mcpReport.mesh.boundsMm.min[axis] && value <= mcpReport.mesh.boundsMm.max[axis]),
    "Public MCP omitted or misplaced the minimum-SICN tetrahedron");
    requireCondition(mcpReport.calculation.maximumVonMisesOnMinimumSICNElement
      === (mcpReport.calculation.maximumVonMisesLocation.elementId === mcpReport.mesh.minimumSICNElementId),
    "Public MCP stress/mesh-quality overlap flag is inconsistent");
    requireCondition(Number.isFinite(mcpReport.calculation.maximumVonMisesElementSICN)
      && mcpReport.calculation.maximumVonMisesElementSICN >= mcpReport.mesh.minimumScaledInverseConditionNumber
      && mcpReport.calculation.maximumVonMisesElementSICN <= 1,
    "Public MCP omitted a valid SICN value for the peak-stress element");
    requirePrincipalStressEvidence(mcpReport.calculation, mcpReport.mesh.boundsMm, "Public MCP base report");
    const expectedMeshSizesMm = [2, 1, 0.5, 0.25];
    for (let levelIndex = 0; levelIndex < expectedMeshSizesMm.length; levelIndex += 1) {
      const levelHashes = mcpReport.cases.map((loadCase: any) => loadCase.meshLevels[levelIndex].meshSha256);
      requireCondition(new Set(levelHashes).size === 1, `Load cases at mesh level ${levelIndex + 1} did not share the same mesh`);
      requireCondition(mcpReport.cases[0].meshLevels[levelIndex].meshSizeMm === expectedMeshSizesMm[levelIndex], "Unexpected mesh refinement size");
      for (const loadCase of mcpReport.cases) {
        const level = loadCase.meshLevels[levelIndex];
        requireCondition(Number.isSafeInteger(level.minimumSICNElementId)
          && level.calculation.maximumVonMisesOnMinimumSICNElement === (level.calculation.maximumVonMisesLocation.elementId === level.minimumSICNElementId),
        `Stress/mesh-quality overlap flag is inconsistent on ${loadCase.name}, level ${levelIndex + 1}`);
        requireCondition(Number.isFinite(level.calculation.maximumVonMisesElementSICN)
          && level.calculation.maximumVonMisesElementSICN >= level.minimumScaledInverseConditionNumber
          && level.calculation.maximumVonMisesElementSICN <= 1,
        `Peak-stress element SICN is missing or invalid on ${loadCase.name}, level ${levelIndex + 1}`);
        requirePrincipalStressEvidence(level.calculation, mcpReport.mesh.boundsMm, `${loadCase.name}, level ${levelIndex + 1}`);
      }
    }
    requireCondition(mcpReport.cases.every((loadCase: any) => loadCase.meshLevels[1].relativeChangeFromPreviousPercent !== null), "Refinement trend is missing");
    requireCondition(mcpReport.strengthPass === false && mcpReport.printApproved === false, "FEA report incorrectly presented itself as a strength or print approval");
    near(mcpReport.mesh.surfaceLoads[0].surfaceAreaMm2, 20, 1e-5, "public MCP mapped loaded-face area");
    near(mcpReport.mesh.totalResultantN[0], 2000, 1e-5, "public MCP transferred load resultant");
    near(mcpReport.mesh.totalResultantN[1], 100, 1e-5, "public MCP point-force resultant");
    near(mcpReport.calculation.supportReactionN[0], -2000, 0.01, "public MCP support reaction");
    near(mcpReport.calculation.supportReactionN[1], -100, 0.01, "public MCP support reaction");
    near(mcpReport.mesh.totalResultantMomentNmm[1], 4000, 0.1, "public MCP applied moment about global origin");
    near(mcpReport.mesh.totalResultantMomentNmm[0], -200, 0.1, "public MCP applied moment about global origin");
    near(mcpReport.mesh.totalResultantMomentNmm[2], -3500, 0.1, "public MCP applied moment about global origin");
    near(mcpReport.calculation.supportReactionMomentNmm[0], 200, 0.1, "public MCP support reaction moment");
    near(mcpReport.calculation.supportReactionMomentNmm[1], -4000, 0.1, "public MCP support reaction moment");
    near(mcpReport.calculation.supportReactionMomentNmm[2], 3500, 0.1, "public MCP support reaction moment");
    for (const residual of [...mcpReport.calculation.forceEquilibriumResidualN, ...mcpReport.calculation.momentEquilibriumResidualNmm]) {
      near(residual, 0, 0.01, "public MCP global equilibrium residual");
    }
    for (const loadCase of mcpReport.cases) {
      for (const residual of [...loadCase.calculation.forceEquilibriumResidualN, ...loadCase.calculation.momentEquilibriumResidualNmm]) {
        near(residual, 0, 0.01, `equilibrium residual for ${loadCase.name}`);
      }
    }
    near(mcpReport.cases[1].totalResultantN[2], 40, 1e-5, "second-case force resultant");
    near(mcpReport.cases[1].calculation.supportReactionN[2], -40, 0.01, "second-case support reaction");
    const persistedMcpReport = await call(client, "plasticity_static_fem_report", { reportId: mcpReport.id });
    requireCondition(persistedMcpReport.freshness.status === "current", "New MCP FEA report is not bound to the current CAD state");
    const afterMcpAnalysis = await call(client, "plasticity_status", {});
    requireCondition(afterMcpAnalysis.bodies.length === 1 && afterMcpAnalysis.bodies[0].id === body.id, "MCP FEA analysis changed the native scene contents");

    const layerProfileHash = "d".repeat(64);
    const layerwiseReport = await call(client, "plasticity_analyze_static_fem", {
      bodyId: body.id,
      revision: afterMcpAnalysis.revision,
      supportConditions: [{ faceId: supportFace.faceId, fixedTranslationAxes: ["x", "y", "z"] }],
      loadCases: [{
        name: "layerwise-orthotropic",
        faceLoads: [],
        resultantLoads: [{ faceId: loadedFace.faceId, forceN: [100, 0, 0], applicationPointMm: loadedFace.centerMm, momentNmm: [0, 0, 0] }],
      }],
      meshSizeMm: 2,
      meshRefinementSteps: 0,
      orthotropicMaterial: {
        youngsModulus2MPa: 1500, youngsModulus3MPa: 1000,
        poissonRatio13: 0.22, poissonRatio23: 0.27,
        shearModulus12MPa: 500, shearModulus13MPa: 400, shearModulus23MPa: 300,
        evidence: {
          youngsModulus2MPa: syntheticOrthotropicEvidence("layer-e2", "Layer fixture E2", 1500, "MPa"),
          youngsModulus3MPa: syntheticOrthotropicEvidence("layer-e3", "Layer fixture E3", 1000, "MPa"),
          poissonRatio13: syntheticOrthotropicEvidence("layer-nu13", "Layer fixture nu13", 0.22, "ratio"),
          poissonRatio23: syntheticOrthotropicEvidence("layer-nu23", "Layer fixture nu23", 0.27, "ratio"),
          shearModulus12MPa: syntheticOrthotropicEvidence("layer-g12", "Layer fixture G12", 500, "MPa"),
          shearModulus13MPa: syntheticOrthotropicEvidence("layer-g13", "Layer fixture G13", 400, "MPa"),
          shearModulus23MPa: syntheticOrthotropicEvidence("layer-g23", "Layer fixture G23", 300, "MPa"),
        },
        process: {
          printerId: "static-patch-acceptance-printer", materialId: "static-patch-acceptance-pla",
          profileHash: layerProfileHash, orientationDeg: [0, 0, 0], infillPercent: 100, nozzleTemperatureC: 210, layerHeightMm: 1,
        },
        orientation: {
          axis1DirectionGlobal: [1, 0, 0], axis2ReferenceDirectionGlobal: [0, 1, 0], buildDirectionGlobal: [0, 0, 1],
          evidence: { status: "user-confirmed", description: "Synthetic acceptance fixture only: coupon axis 1=X and build axis=+Z." },
        },
      },
      ...syntheticMaterialEvidence,
      youngsModulusMPa: 2000,
      poissonRatio: 0.3,
      layerPlanePlan: {
        processProfileHash: layerProfileHash,
        firstInterfacePointMm: [0, 0, 1],
        buildDirectionGlobal: [0, 0, 1],
        layerHeightMm: 1,
        totalLayerCount: 4,
        interfaceLayerIndices: [1, 2, 3],
        pathFrameMapping: {
          slicerXDirectionGlobal: [1, 0, 0],
          evidence: { status: "user-confirmed", description: "Synthetic acceptance fixture only: slicer X maps to CAD global X." },
        },
        roadAxisMapping: {
          status: "user-confirmed",
          couponAxis1Meaning: "dominant-deposition-road-direction",
          evidence: { description: "Synthetic acceptance fixture only: coupon axis 1 follows the dominant deposited road." },
        },
        layerPathEvidence: {
          jobId: "static-patch-layer-job",
          profileHash: layerProfileHash,
          sourceArtifactHash: "e".repeat(64),
          gcodeArtifactHash: "f".repeat(64),
          layerCount: 4,
          coordinateFrame: "slicer-build",
          layers: [0, 90, 0, 90].map((principalDirectionDeg, index) => ({
            layerIndex: index + 1,
            depositionLayerZMm: index + 1,
            pathOrientation: {
              layerIndex: index + 1, planarPathLengthMm: 100,
              principalDirectionDeg, directionalConcentration: 0.9,
              curvedExtrusionMoves: 0, coverage: "complete-linear",
            },
          })),
        },
      },
    });
    requireCondition(layerwiseReport.calculation.stressCoordinateBasis === "layer-local"
      && layerwiseReport.mesh.layerRegionGroups?.length === 4
      && layerwiseReport.mesh.layerRegionGroups.every((group: any, index: number) => group.layerIndex === index + 1 && group.tetrahedronCount > 0),
    "Public MCP did not mesh and assign every confirmed deposition layer in local orthotropic frames");
    const layerwiseDeck = await readFile(layerwiseReport.calculation.inputPath, "utf8");
    for (let layerIndex = 1; layerIndex <= 4; layerIndex += 1) {
      requireCondition(layerwiseDeck.includes(`*SOLID SECTION, ELSET=LAYER_${layerIndex}, MATERIAL=PLASTICITY_MATERIAL, ORIENTATION=LAYER_${layerIndex}_AXES`),
        `CalculiX deck omitted the shared material assignment for layer ${layerIndex}`);
    }
    const persistedLayerwiseReport = await call(client, "plasticity_static_fem_report", { reportId: layerwiseReport.id });
    requireCondition(persistedLayerwiseReport.freshness.status === "current"
      && persistedLayerwiseReport.calculation.stressCoordinateBasis === "layer-local"
      && persistedLayerwiseReport.mesh.layerRegionGroups?.length === 4,
    "Persisted layerwise report lost its per-layer mesh or local stress-coordinate basis");
    evidence.layerwiseStaticMcpReport = {
      reportId: layerwiseReport.id,
      freshness: persistedLayerwiseReport.freshness,
      materialIdentity: layerwiseReport.input.orthotropicMaterial.process,
      confirmedLayerCount: layerwiseReport.input.layerPlanePlan.totalLayerCount,
      meshLayerRegionGroups: layerwiseReport.mesh.layerRegionGroups,
      result: layerwiseReport.calculation,
      layerSectionAssignments: layerwiseDeck.split(/\r?\n/).filter((line: string) => line.startsWith("*SOLID SECTION, ELSET=LAYER_")),
      limitation: "Synthetic software acceptance only; one material tensor, perfectly bonded interfaces, not physical qualification.",
    };

    const hollowed = await call(client, "plasticity_hollow_solids", {
      ids: [body.id],
      wallThicknessMm: 1,
      direction: "inward",
      intent: "Create a disposable closed shell for the selective-restraint FEA acceptance",
      revision: afterMcpAnalysis.revision,
    });
    requireCondition(hollowed.bodies.length === 1, "Hollow fixture did not preserve exactly one native Solid");
    const hollowBody = hollowed.bodies[0];
    disposableBodyId = hollowBody.id;
    disposableBodyIds.add(hollowBody.id);
    disposableUndoCount += 1;
    const hollowFaces = hollowBody.faces.filter((face: any) => face.surfaceType === "Plane" && Math.abs(face.normal[0]) > 0.99999);
    const partialEndSupport = hollowFaces.find((face: any) => face.normal[0] < -0.99999
      && Math.abs(face.centerMm[0] - hollowBody.boundsMm.min[0]) < 1e-5);
    const internalAxialSupport = hollowFaces.find((face: any) => face.centerMm[0] > hollowBody.boundsMm.min[0] + 0.1
      && face.centerMm[0] < hollowBody.boundsMm.max[0] - 0.1
      && face.centerMm[0] > (hollowBody.boundsMm.min[0] + hollowBody.boundsMm.max[0]) / 2);
    const partialLoadedFace = hollowFaces.find((face: any) => face.normal[0] > 0.99999
      && Math.abs(face.centerMm[0] - hollowBody.boundsMm.max[0]) < 1e-5);
    requireCondition(partialEndSupport && internalAxialSupport && partialLoadedFace,
      "Could not identify separated outer, internal and loaded planar faces in the hollow fixture");
    const partialReport = await call(client, "plasticity_analyze_static_fem", {
      bodyId: hollowBody.id,
      revision: hollowed.revision,
      supportConditions: [
        { faceId: partialEndSupport.id, fixedTranslationAxes: ["x", "y"] },
        { faceId: internalAxialSupport.id, fixedTranslationAxes: ["z"] },
      ],
      faceLoads: [{ faceId: partialLoadedFace.id, tractionNPerMm2: [1, 0, 0] }],
      resultantLoads: [],
      meshSizeMm: 1,
      meshRefinementSteps: 0,
      ...syntheticMaterialEvidence,
      youngsModulusMPa: 2000,
      poissonRatio: 0.3,
    });
    partialSupportReportId = partialReport.id;
    requireCondition(partialReport.kind === "static-fem-linear-elastic" && partialReport.input.supportConditions?.length === 2,
      "Public MCP did not solve the selective-restraint hollow fixture");
    requireCondition(partialReport.input.youngsModulusEvidence?.status === "assumed"
      && partialReport.input.poissonRatioEvidence.status === "assumed",
    "Partial-restraint report lost its scenario-only material assumptions");
    requireCondition(partialReport.input.supportConditions[0]?.faceId === partialEndSupport.id
      && partialReport.input.supportConditions[0]?.fixedTranslationAxes.join(",") === "x,y"
      && partialReport.input.supportConditions[1]?.faceId === internalAxialSupport.id
      && partialReport.input.supportConditions[1]?.fixedTranslationAxes.join(",") === "z",
    "Public MCP report did not preserve each selective support condition");
    requireCondition(partialReport.supportRigidBodyConstraintRank === 6, "Public MCP did not report complete rigid-body restraint rank for separated partial supports");
    const endSupportSet = partialReport.mesh.nodeSets.find((set: any) => set.faceId === partialEndSupport.id);
    const internalSupportSet = partialReport.mesh.nodeSets.find((set: any) => set.faceId === internalAxialSupport.id);
    const reactionsBySupport = partialReport.calculation.supportReactionsByNodeSet;
    requireCondition(Array.isArray(reactionsBySupport)
      && reactionsBySupport.length === 2
      && reactionsBySupport[0]?.nodeSetName === endSupportSet?.setName
      && reactionsBySupport[1]?.nodeSetName === internalSupportSet?.setName,
    "Public MCP did not report reactions separately for both selected supports");
    for (let axis = 0; axis < 3; axis += 1) {
      near(reactionsBySupport.reduce((sum: number, reaction: any) => sum + reaction.forceN[axis], 0), partialReport.calculation.supportReactionN[axis], 1e-6,
        "per-support reaction force sum");
      near(reactionsBySupport.reduce((sum: number, reaction: any) => sum + reaction.momentNmm[axis], 0), partialReport.calculation.supportReactionMomentNmm[axis], 1e-6,
        "per-support reaction moment sum");
    }
    const partialDeck = await readFile(partialReport.calculation.inputPath, "utf8");
    requireCondition(endSupportSet && internalSupportSet
      && partialDeck.includes(`${endSupportSet.setName}, 1, 1, 0.`)
      && partialDeck.includes(`${endSupportSet.setName}, 2, 2, 0.`)
      && partialDeck.includes(`${internalSupportSet.setName}, 3, 3, 0.`)
      && !partialDeck.includes(`${endSupportSet.setName}, 3, 3, 0.`),
    "CalculiX deck does not match the public MCP's per-face partial restraints");
    const persistedPartialReport = await call(client, "plasticity_static_fem_report", { reportId: partialReport.id });
    requireCondition(persistedPartialReport.freshness.status === "current" && partialReport.strengthPass === false && partialReport.printApproved === false,
      "Selective-restraint result is not current or incorrectly implies approval");
    requireCondition(persistedPartialReport.calculation.supportReactionsByNodeSet?.length === 2,
      "Persisted MCP report omitted the per-support reaction breakdown");
    for (const residual of [...partialReport.calculation.forceEquilibriumResidualN, ...partialReport.calculation.momentEquilibriumResidualNmm]) {
      near(residual, 0, 0.01, "selective-restraint global equilibrium residual");
    }
    partialSupportEvidence = {
      reportId: partialReport.id,
      supportRigidBodyConstraintRank: partialReport.supportRigidBodyConstraintRank,
      freshness: persistedPartialReport.freshness,
      supportConditions: partialReport.input.supportConditions,
      materialEvidence: {
        youngsModulusEvidence: partialReport.input.youngsModulusEvidence,
        poissonRatioEvidence: partialReport.input.poissonRatioEvidence,
      },
      result: partialReport.calculation,
      mesh: partialReport.mesh,
      actualDeckBoundaryLines: partialDeck.split(/\r?\n/).filter((line: string) => line.includes(", 1, 1, 0.") || line.includes(", 2, 2, 0.") || line.includes(", 3, 3, 0.")),
    };
    evidence.publicMcpPartialSupportReport = partialSupportEvidence;
    evidence.selectiveRestraintFixture = {
      bodyBoundsMm: hollowBody.boundsMm,
      planarAxialFaces: hollowFaces.map((face: any) => ({ id: face.id, centerMm: face.centerMm, normal: face.normal })),
      wallThicknessMm: 1,
      fixtureKind: "closed hollow box with spatially separated support faces",
    };

    const solutions = [];
    for (const meshSizeMm of [2, 1]) {
      const label = meshSizeMm === 2 ? "coarse" : "fine";
      const meshPath = join(output, `probe-mesh-${label}.inp`);
      const mapping = await generateCalculiXMeshFromStep(
        stepPath,
        faces,
        [supportFace.faceId, loadedFace.faceId],
        meshSizeMm,
        meshPath,
        undefined,
        [{ faceId: loadedFace.faceId, tractionNPerMm2: [100, 0, 0] }],
      );
      requireCondition(mapping.mesh.nodeSets.every((set) => set.nodeCount > 0), "Gmsh returned an empty boundary node set");
      const meshText = await readFile(meshPath, "utf8");
      const anchors = [
        { point: [0, 0, 0], axis: 2 as const, valueMm: 0 },
        { point: [0, 0, 0], axis: 3 as const, valueMm: 0 },
        { point: [0, 5, 0], axis: 3 as const, valueMm: 0 },
      ].map((anchor) => ({ nodeId: findNode(meshText, anchor.point), axis: anchor.axis, valueMm: anchor.valueMm }));
      const supportSet = mapping.mesh.nodeSets.find((set) => set.faceId === supportFace.faceId)!;
      const loadedSet = mapping.mesh.nodeSets.find((set) => set.faceId === loadedFace.faceId)!;
      const result = await runLinearStaticCase({
        workspacePath: output,
        meshPath,
        jobName: `axial-${label}`,
        youngsModulusMPa: 2000,
        poissonRatio: 0.3,
        supports: [{ nodeSetName: supportSet.setName, axes: [1] }],
        prescribedDisplacement: { nodeSetName: loadedSet.setName, axis: 1, valueMm: 0.5 },
        anchors,
      });
      near(result.minimumSxxMPa, 100, 0.02, `${label} minimum axial integration-point stress`);
      near(result.maximumSxxMPa, 100, 0.02, `${label} maximum axial integration-point stress`);
      near(result.maximumVonMisesMPa, 100, 0.02, `${label} maximum von Mises stress`);
      near(result.maximumDisplacementOnSetMm, 0.5, 1e-8, `${label} prescribed-face displacement`);
      solutions.push({ mesh: mapping.mesh, result });
    }
    requireCondition(solutions[1]!.mesh.tetrahedronCount > solutions[0]!.mesh.tetrahedronCount, "Refined mesh did not increase the element count");
    near(solutions[0]!.result.maximumSxxMPa, solutions[1]!.result.maximumSxxMPa, 1e-8, "coarse/fine axial stress agreement");
    near(solutions[0]!.result.maximumDisplacementOnSetMm, solutions[1]!.result.maximumDisplacementOnSetMm, 1e-8, "coarse/fine displacement agreement");

    const fineMesh = solutions[1]!.mesh;
    const load = fineMesh.surfaceLoads[0];
    if (!load || load.faceId !== loadedFace.faceId) throw new Error("Gmsh did not return load transfer evidence for the loaded native face");
    near(load.surfaceAreaMm2, 20, 1e-5, "integrated loaded face area");
    near(load.resultantN[0], 2000, 1e-5, "integrated axial face force");
    const fineMeshPath = join(output, "probe-mesh-fine.inp");
    const meshText = await readFile(fineMeshPath, "utf8");
    const anchors = [
      { point: [0, 0, 0], axis: 2 as const, valueMm: 0 },
      { point: [0, 0, 0], axis: 3 as const, valueMm: 0 },
      { point: [0, 5, 0], axis: 3 as const, valueMm: 0 },
    ].map((anchor) => ({ nodeId: findNode(meshText, anchor.point), axis: anchor.axis, valueMm: anchor.valueMm }));
    const supportSet = fineMesh.nodeSets.find((set) => set.faceId === supportFace.faceId)!;
    const loadedSet = fineMesh.nodeSets.find((set) => set.faceId === loadedFace.faceId)!;
    const forceControlledResult = await runLinearStaticCase({
      workspacePath: output,
      meshPath: fineMeshPath,
      jobName: "axial-force",
      youngsModulusMPa: 2000,
      poissonRatio: 0.3,
        supports: [{ nodeSetName: supportSet.setName, axes: [1] }],
      displacementObservation: { nodeSetName: loadedSet.setName, axis: 1 },
      loadIncludePath: fineMesh.loadFile!,
      anchors,
    });
    near(forceControlledResult.minimumSxxMPa, 100, 0.02, "force-controlled minimum axial integration-point stress");
    near(forceControlledResult.maximumSxxMPa, 100, 0.02, "force-controlled maximum axial integration-point stress");
    near(forceControlledResult.maximumVonMisesMPa, 100, 0.02, "force-controlled maximum von Mises stress");
    near(forceControlledResult.maximumDisplacementOnSetMm, 0.5, 1e-7, "force-controlled loaded-face displacement");
    near(forceControlledResult.supportReactionN[0], -load.resultantN[0], 0.01, "axial support reaction equilibrium");
    near(forceControlledResult.supportReactionN[1], -load.resultantN[1], 0.01, "transverse Y support reaction equilibrium");
    near(forceControlledResult.supportReactionN[2], -load.resultantN[2], 0.01, "transverse Z support reaction equilibrium");

    const journal = await call(client, "plasticity_construction_journal", {});
    requireCondition(journal.syncStatus === "in-sync" && !journal.entries.some((entry: { status: string }) => entry.status === "unknown"), "Construction journal is not clean before cleanup");
    let cleaned = await call(client, "plasticity_undo", {
      intent: "Cleanup disposable hollow FEA fixture",
      revision: (await call(client, "plasticity_status", {})).revision,
    });
    disposableUndoCount -= 1;
    requireCondition(cleaned.bodies.length === 1 && disposableBodyIds.has(cleaned.bodies[0].id), "Undo did not restore the original disposable FEA box");
    cleaned = await call(client, "plasticity_undo", { intent: "Cleanup disposable FEA static patch probe", revision: cleaned.revision });
    disposableUndoCount -= 1;
    requireCondition(cleaned.documentToken === initial.documentToken && cleaned.bodies.length === 0, "Undo did not restore the empty document");
    disposableBodyId = undefined;
    const staleMcpReport = await call(client, "plasticity_static_fem_report", { reportId: mcpReport.id });
    requireCondition(staleMcpReport.freshness.status === "stale", "MCP FEA report did not become stale after its Solid was removed");
    const stalePartialReport = await call(client, "plasticity_static_fem_report", { reportId: partialSupportReportId });
    requireCondition(stalePartialReport.freshness.status === "stale", "Selective-restraint MCP FEA report did not become stale after cleanup");
    if (partialSupportEvidence) partialSupportEvidence.freshnessAfterCleanup = stalePartialReport.freshness;
    const changes = await call(client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(changes.diff), "Scene contents differ from the original empty snapshot");

    evidence.completedAt = new Date().toISOString();
    evidence.nativeBodyId = body.id;
    evidence.stepBytes = exported.bytes;
    evidence.publicMcpReport = {
      reportId: mcpReport.id,
      freshness: persistedMcpReport.freshness,
      freshnessAfterDisposableSolidCleanup: staleMcpReport.freshness,
      supportConditions: mcpReport.input.supportConditions,
      orthotropicMaterial: mcpReport.input.orthotropicMaterial,
      materialEvidence: {
        youngsModulusEvidence: mcpReport.input.youngsModulusEvidence,
        poissonRatioEvidence: mcpReport.input.poissonRatioEvidence,
      },
      result: mcpReport.calculation,
      cases: mcpReport.cases,
      mesh: mcpReport.mesh,
    };
    evidence.meshRefinement = solutions;
    evidence.forceControlledCalculix = forceControlledResult;
    evidence.cleanup = { restoredEmptyDocument: true, sceneContentsRestored: true, revisionChanged: true, undoSteps: 2 };
    await writeFile(join(output, "evidence.json"), JSON.stringify(sanitizeEvidence(evidence), null, 2), { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ ok: true, evidence: join(output, "evidence.json") }, null, 2));
  } catch (error) {
    evidence.failure = error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
    if (initial && disposableBodyId !== undefined) {
      try {
        const current = await call(client, "plasticity_status", {});
        if (current.bodies.length === 1 && disposableBodyIds.has(current.bodies[0].id)) {
          let cleanupState = current;
          let cleanedCount = 0;
          while (disposableUndoCount > 0 && cleanupState.bodies.length === 1 && disposableBodyIds.has(cleanupState.bodies[0].id)) {
            cleanupState = await call(client, "plasticity_undo", { intent: "Failure cleanup of disposable FEA probe", revision: cleanupState.revision });
            disposableUndoCount -= 1;
            cleanedCount += 1;
          }
          evidence.cleanup = { restoredEmptyDocument: cleanupState.bodies.length === 0, undoSteps: cleanedCount };
        } else {
          evidence.cleanup = { restoredEmptyDocument: false, reason: "Scene changed independently; no automatic Undo was attempted" };
        }
      } catch (cleanupError) {
        evidence.cleanup = { restoredEmptyDocument: false, reason: cleanupError instanceof Error ? cleanupError.message.slice(0, 1_000) : String(cleanupError) };
      }
    }
    await writeFile(join(output, "failure.json"), JSON.stringify(sanitizeEvidence(evidence), null, 2), { flag: "wx", mode: 0o600 });
    throw error;
  } finally {
    await client.close().catch(() => {});
  }
}

function findNode(meshText: string, point: number[]): number {
  const nodeSection = meshText.split(/^\*NODE\s*$/m)[1]?.split(/^\*/m)[0];
  if (!nodeSection) throw new Error("CalculiX mesh is missing its node section");
  const candidates = nodeSection.split(/\r?\n/).map((line) => line.trim().split(/\s*,\s*/).map(Number))
    .filter((values) => values.length === 4 && values.every(Number.isFinite))
    .map(([id, x, y, z]) => ({ id: id!, error: Math.hypot(x! - point[0]!, y! - point[1]!, z! - point[2]!) }))
    .sort((left, right) => left.error - right.error);
  if (!candidates[0] || candidates[0].error > 1e-7 || candidates[1]?.error === candidates[0].error) {
    throw new Error(`Could not identify one mesh node at ${point.join(", ")} mm`);
  }
  return candidates[0].id;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await client.callTool({ name, arguments: args }) as {
    isError?: boolean;
    content: Array<{ type: string; text?: string }>;
  };
  const item = response.content.find((entry) => entry.type === "text");
  if (response.isError || !item || item.type !== "text" || typeof item.text !== "string") throw new Error(`${name} failed: ${JSON.stringify(response.content)}`);
  return JSON.parse(item.text);
}

function selectedEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([key, value]) => value !== undefined && /^(PATH|HOME|TMPDIR|TMP|TEMP|LANG|LC_[A-Z_]+|CODEX_HOME|CODEX_CLI_PATH|OPENAI_API_KEY|PLASTICITY_[A-Z0-9_]+|PLASTICITY_MCP_[A-Z0-9_]+)$/.test(key)));
}

function near(actual: number, expected: number, tolerance: number, label: string): void {
  requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`);
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function syntheticOrthotropicEvidence(id: string, label: string, value: number, unit: "MPa" | "ratio") {
  return {
    id: `orthotropic-${id}`,
    label,
    status: "assumed" as const,
    unit,
    value,
    derivation: "Synthetic acceptance assumption only; not a physical material qualification.",
    dependsOn: [],
  };
}

function requirePrincipalStressEvidence(calculation: any, boundsMm: { min: number[]; max: number[] }, label: string): void {
  requireCondition(Number.isFinite(calculation.maximumPrincipalStressMPa)
    && Number.isFinite(calculation.minimumPrincipalStressMPa)
    && calculation.minimumPrincipalStressMPa <= calculation.maximumPrincipalStressMPa,
  `${label} omitted ordered principal stress extrema`);
  for (const [name, location] of [["maximum", calculation.maximumPrincipalStressLocation], ["minimum", calculation.minimumPrincipalStressLocation]] as const) {
    requireCondition(Number.isSafeInteger(location.elementId) && location.elementId > 0
      && Number.isSafeInteger(location.integrationPoint) && location.integrationPoint > 0
      && location.centroidMm.every((value: number, axis: number) => value >= boundsMm.min[axis]! && value <= boundsMm.max[axis]!),
    `${label} has invalid ${name} principal-stress location`);
  }
}

await main();
