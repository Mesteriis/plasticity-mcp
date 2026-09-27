#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { generateCohesiveMeshFromStep } from "../src/strength/fem/cohesive-step-mesh.ts";
import { runCodeAsterCohesiveCase } from "../src/strength/fem/code-aster-cohesive-runner.ts";
import { codeAsterTuronDeckInputFromCalibration } from "../src/strength/fem/code-aster-turon-deck.ts";
import { runCodeAsterTuronCase } from "../src/strength/fem/code-aster-turon-runner.ts";

const workspace = await mkdtemp(join(tmpdir(), "plasticity-cohesive-layer-stack-"));
try {
  const gmshPythonPath = await findGmshPythonPath();
  const stepPath = join(workspace, "box.step");
  const python = process.env.PLASTICITY_FEA_PYTHON ?? "python3";
  const splitAngle = Math.PI / 4;
  const splitNormal = [Math.sin(splitAngle), 0, Math.cos(splitAngle)] as [number, number, number];
  const createdStep = spawnSync(python, [
    "-c",
    "import gmsh,sys,json,math; gmsh.initialize(); gmsh.option.setNumber('General.Terminal',0); gmsh.model.add('tilted-layer-stack-acceptance'); gmsh.model.occ.addBox(0,0,0,10,10,10); gmsh.model.occ.rotate([(3,1)],0,0,0,0,1,0,math.pi/4); gmsh.model.occ.synchronize(); n=[math.sin(math.pi/4),0,math.cos(math.pi/4)]; faces=[];\nfor _,tag in gmsh.model.getEntities(2):\n c=gmsh.model.occ.getCenterOfMass(2,tag); uv=gmsh.model.getParametrization(2,tag,c); normal=gmsh.model.getNormal(tag,uv); length=math.sqrt(sum(v*v for v in normal)); normal=[v/length for v in normal];\n if abs(abs(sum(normal[i]*n[i] for i in range(3)))-1)<1e-6:\n  b=gmsh.model.occ.getBoundingBox(2,tag); faces.append({'faceId':'support' if sum(normal[i]*n[i] for i in range(3))<0 else 'loaded','surfaceType':'Plane','centerMm':list(c),'normal':normal,'boundsMm':{'min':list(b[:3]),'max':list(b[3:])}})\ngmsh.write(sys.argv[1]); print(json.dumps(faces)); gmsh.finalize()",
    stepPath,
  ], { encoding: "utf8", env: { ...process.env, PYTHONPATH: [gmshPythonPath, process.env.PYTHONPATH].filter(Boolean).join(delimiter) } });
  if (createdStep.error || createdStep.status !== 0) {
    throw new Error(`Could not create the synthetic STEP box with Gmsh: ${(createdStep.stderr || createdStep.error?.message || "unknown error").slice(-2_000)}`);
  }

  const boundaryLine = createdStep.stdout.trim().split(/\r?\n/).at(-1);
  if (!boundaryLine) throw new Error("Gmsh did not return tilted STEP boundary face signatures");
  const boundaryFaces = JSON.parse(boundaryLine) as Array<{
    faceId: string; surfaceType: "Plane"; centerMm: [number, number, number]; normal: [number, number, number];
    boundsMm: { min: [number, number, number]; max: [number, number, number] };
  }>;
  if (boundaryFaces.length !== 2) throw new Error("Could not identify both exact tilted end faces on the synthetic STEP box");
  const mesh = await generateCohesiveMeshFromStep({
    stepPath,
    outputPath: join(workspace, "cohesive.msh"),
    splitPlanes: [3, 7].map((offset) => ({
      pointMm: splitNormal.map((component) => component * offset) as [number, number, number],
      normalGlobal: splitNormal,
    })),
    meshSizeMm: 5,
    boundaryFaces,
  });
  if (mesh.volumeCount !== 3 || mesh.interfaceSurfaceGroups.length !== 2 || mesh.cohesiveElementCount < 2) {
    throw new Error("The two-plane STEP mesh did not produce three volume bands and two cohesive interfaces");
  }
  const layerwiseMesh = await generateCohesiveMeshFromStep({
    stepPath,
    outputPath: join(workspace, "layerwise-cohesive.msh"),
    splitPlanes: mesh.splitPlanes,
    meshSizeMm: mesh.meshSizeMm,
    boundaryFaces,
    layerwiseRegions: true,
  });
  if (layerwiseMesh.volumeCount !== 3 || layerwiseMesh.layerRegionGroups?.length !== 3
    || layerwiseMesh.layerRegionGroups.some((group, index) => group.layerIndex !== index + 1 || group.physicalTag !== index + 1)
    || layerwiseMesh.interfaceSurfaceGroups.some((group, index) => group.physicalTag !== 4 + index)
    || layerwiseMesh.cohesiveVolumeTag !== 1003) {
    throw new Error("The per-layer STEP mesh did not preserve three ordered layer groups and two isolated interfaces");
  }

  const isotropic = await runCodeAsterCohesiveCase({
    workspacePath: workspace,
    deck: {
      materialAGrid: "GM1", materialBGrid: "GM2", supportFaceGroup: "GM1001", loadedFaceGroup: "GM1002", cohesiveElementGroup: `GM${mesh.cohesiveVolumeTag}`,
      materialA: { youngsModulusMPa: 2_000, poissonRatio: 0.3 },
      materialB: { youngsModulusMPa: 2_000, poissonRatio: 0.3 },
      modeI: { peakTractionMPa: 2.4, fractureEnergyNPerMm: 0.12, adherencePenalty: 0.00001 },
      interfaceNormalGlobal: splitNormal, displacementDirectionGlobal: splitNormal,
      prescribedDisplacementMm: 0.001, increments: 100,
    },
  });
  const orthotropicWorkspace = join(workspace, "orthotropic-single-material");
  await mkdir(orthotropicWorkspace);
  await copyFile(join(workspace, "cohesive.msh"), join(orthotropicWorkspace, "cohesive.msh"));
  const singleMaterial = {
    youngsModulusMPa: 2_000, youngsModulus2MPa: 1_500, youngsModulus3MPa: 800,
    poissonRatio12: 0.3, poissonRatio13: 0.2, poissonRatio23: 0.25,
    shearModulus12MPa: 600, shearModulus13MPa: 350, shearModulus23MPa: 300,
    orientation: {
      axis1DirectionGlobal: [Math.cos(splitAngle), 0, -Math.sin(splitAngle)] as [number, number, number],
      axis2ReferenceDirectionGlobal: [0, 1, 0] as [number, number, number],
      buildDirectionGlobal: splitNormal,
    },
  };
  const layerwiseWorkspace = join(workspace, "layerwise-orthotropic-single-material");
  await mkdir(layerwiseWorkspace);
  await copyFile(join(workspace, "layerwise-cohesive.msh"), join(layerwiseWorkspace, "cohesive.msh"));
  const layerwiseOrthotropic = await runCodeAsterCohesiveCase({
    workspacePath: layerwiseWorkspace,
    deck: {
      materialAGrid: "GM1", materialBGrid: "GM2", supportFaceGroup: "GM1001", loadedFaceGroup: "GM1002",
      cohesiveElementGroup: `GM${layerwiseMesh.cohesiveVolumeTag}`,
      materialA: { youngsModulusMPa: 2_000, poissonRatio: 0.3 },
      materialB: { youngsModulusMPa: 2_000, poissonRatio: 0.3 },
      orthotropicMaterialA: singleMaterial,
      orthotropicMaterialB: singleMaterial,
      layerwiseOrthotropicRegions: layerwiseMesh.layerRegionGroups!.map((region, index) => {
        const angle = [0, Math.PI / 2, Math.PI / 4][index]!;
        const axis1Base = [Math.cos(splitAngle), 0, -Math.sin(splitAngle)];
        const axis2Base = [0, 1, 0];
        return {
          layerIndex: region.layerIndex,
          grid: region.name,
          orientation: {
            axis1DirectionGlobal: axis1Base.map((value, axis) => value * Math.cos(angle) + axis2Base[axis]! * Math.sin(angle)) as [number, number, number],
            axis2ReferenceDirectionGlobal: axis1Base.map((value, axis) => -value * Math.sin(angle) + axis2Base[axis]! * Math.cos(angle)) as [number, number, number],
            buildDirectionGlobal: splitNormal,
          },
        };
      }),
      modeI: { peakTractionMPa: 2.4, fractureEnergyNPerMm: 0.12, adherencePenalty: 0.00001 },
      interfaceNormalGlobal: splitNormal, displacementDirectionGlobal: splitNormal,
      prescribedDisplacementMm: 0.001, increments: 100,
    },
  });
  const layerwiseTuronWorkspace = join(workspace, "layerwise-turon-single-material");
  await mkdir(layerwiseTuronWorkspace);
  await copyFile(join(workspace, "layerwise-cohesive.msh"), join(layerwiseTuronWorkspace, "cohesive.msh"));
  const turonOrthotropic = {
    youngsModulus2MPa: singleMaterial.youngsModulus2MPa, youngsModulus3MPa: singleMaterial.youngsModulus3MPa,
    poissonRatio13: singleMaterial.poissonRatio13, poissonRatio23: singleMaterial.poissonRatio23,
    shearModulus12MPa: singleMaterial.shearModulus12MPa, shearModulus13MPa: singleMaterial.shearModulus13MPa,
    shearModulus23MPa: singleMaterial.shearModulus23MPa,
    orientation: {
      axis1DirectionGlobal: singleMaterial.orientation.axis1DirectionGlobal,
      axis2ReferenceDirectionGlobal: singleMaterial.orientation.axis2ReferenceDirectionGlobal,
      buildDirectionGlobal: singleMaterial.orientation.buildDirectionGlobal,
    },
  };
  const turon = await runCodeAsterTuronCase({
    workspacePath: layerwiseTuronWorkspace,
    deck: codeAsterTuronDeckInputFromCalibration({
      etaBk: 2,
      pureModePeakTractionMPa: { modeI: 2.4, modeII: 2 },
      pureModeFractureEnergyNPerMm: { modeI: 0.12, modeII: 0.16 },
    }, {
      materialAGrid: "GM1", materialBGrid: "GM2", supportFaceGroup: "GM1001", loadedFaceGroup: "GM1002",
      cohesiveElementGroup: `GM${layerwiseMesh.cohesiveVolumeTag}`,
      materialA: { youngsModulusMPa: 2_000, poissonRatio: 0.3 },
      materialB: { youngsModulusMPa: 2_000, poissonRatio: 0.3 },
      orthotropicMaterialA: turonOrthotropic, orthotropicMaterialB: turonOrthotropic,
      layerwiseOrthotropicRegions: layerwiseMesh.layerRegionGroups!.map((region, index) => {
        const angle = [0, Math.PI / 2, Math.PI / 4][index]!;
        const axis1Base = [Math.cos(splitAngle), 0, -Math.sin(splitAngle)];
        const axis2Base = [0, 1, 0];
        return {
          layerIndex: region.layerIndex,
          grid: region.name,
          orientation: {
            axis1DirectionGlobal: axis1Base.map((value, axis) => value * Math.cos(angle) + axis2Base[axis]! * Math.sin(angle)) as [number, number, number],
            axis2ReferenceDirectionGlobal: axis1Base.map((value, axis) => -value * Math.sin(angle) + axis2Base[axis]! * Math.cos(angle)) as [number, number, number],
            buildDirectionGlobal: splitNormal,
          },
        };
      }),
      stiffnessMPaPerMm: 100_000, residualStiffnessRatio: 0.001,
      interfaceNormalGlobal: splitNormal, prescribedDisplacementGlobalMm: [0, 0.1, 0.1],
      increments: 100,
    }),
  });
  const orthotropic = await runCodeAsterCohesiveCase({
    workspacePath: orthotropicWorkspace,
    deck: {
      materialAGrid: "GM1", materialBGrid: "GM2", supportFaceGroup: "GM1001", loadedFaceGroup: "GM1002", cohesiveElementGroup: `GM${mesh.cohesiveVolumeTag}`,
      materialA: { youngsModulusMPa: 2_000, poissonRatio: 0.3 },
      materialB: { youngsModulusMPa: 2_000, poissonRatio: 0.3 },
      orthotropicMaterialA: singleMaterial,
      orthotropicMaterialB: singleMaterial,
      modeI: { peakTractionMPa: 2.4, fractureEnergyNPerMm: 0.12, adherencePenalty: 0.00001 },
      interfaceNormalGlobal: splitNormal, displacementDirectionGlobal: splitNormal,
      prescribedDisplacementMm: 0.001, increments: 100,
    },
  });
  for (const result of [isotropic, orthotropic, layerwiseOrthotropic]) {
    if (result.result.displacementHistory.length < 2 || result.result.interfaceStateHistory.at(-1)?.elementCount !== mesh.cohesiveElementCount) {
      throw new Error("Code_Aster did not return states for every generated multi-plane cohesive element");
    }
  }
  if (Math.abs(orthotropic.result.displacementHistory.at(-1)!.maxMm - 0.001) > 1e-6) {
    throw new Error("Oblique displacement component was not projected back to the requested normal opening");
  }
  if (orthotropic.solver !== "Code_Aster 17.4.0" || layerwiseOrthotropic.solver !== "Code_Aster 17.4.0") throw new Error("Single-material orthotropic acceptance did not use the validated Code_Aster 17.4 solver");
  if (turon.solver !== "Code_Aster 17.4.0" || turon.damageHistory.length < 2 || !Number.isFinite(turon.maxDamageV3)) {
    throw new Error("Layerwise orthotropic mixed-mode Turon acceptance did not return a valid solver damage history");
  }
  console.log(JSON.stringify({ ok: true, gmshVersion: mesh.gmshVersion, runs: [
    { materialModel: "isotropic-single-material", solver: isotropic.solver, increments: isotropic.result.displacementHistory.length },
    { materialModel: "homogeneous-orthotropic-single-material", solver: orthotropic.solver, increments: orthotropic.result.displacementHistory.length },
    { materialModel: "layerwise-axes-same-orthotropic-single-material", solver: layerwiseOrthotropic.solver, increments: layerwiseOrthotropic.result.displacementHistory.length },
    { materialModel: "layerwise-axes-same-orthotropic-single-material-turon", solver: turon.solver, increments: turon.damageHistory.length, maxDamageV3: turon.maxDamageV3 },
    ], volumeCount: mesh.volumeCount, interfaceGroups: mesh.interfaceSurfaceGroups, cohesiveElementCount: mesh.cohesiveElementCount,
    layerwiseMesh: { regions: layerwiseMesh.layerRegionGroups, interfaces: layerwiseMesh.interfaceSurfaceGroups, cohesiveVolumeTag: layerwiseMesh.cohesiveVolumeTag } }));
} finally {
  if (process.env.PLASTICITY_KEEP_COHESIVE_ACCEPTANCE_WORKSPACE === "1") {
    console.error(`Cohesive acceptance workspace retained: ${workspace}`);
  } else {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function findGmshPythonPath(): Promise<string> {
  if (process.env.PLASTICITY_GMSH_PYTHON_PATH) {
    const configuredPath = process.env.PLASTICITY_GMSH_PYTHON_PATH;
    await access(join(configuredPath, "gmsh.py"), constants.R_OK);
    return configuredPath;
  }
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    const binary = join(entry, "gmsh");
    try {
      await access(binary, constants.X_OK);
      const resolved = await realpath(binary);
      const packageRoot = dirname(dirname(resolved));
      const pythonPath = join(packageRoot, "lib");
      await access(join(pythonPath, "gmsh.py"), constants.R_OK);
      return pythonPath;
    } catch { /* Continue through PATH until the active Gmsh package is found. */ }
  }
  throw new Error("Gmsh 4.15.x Homebrew Python API was not found; install Gmsh or set PLASTICITY_GMSH_PYTHON_PATH");
}
