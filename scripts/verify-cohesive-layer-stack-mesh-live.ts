#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { generateCohesiveMeshFromStep } from "../src/strength/fem/cohesive-step-mesh.ts";

const layerCount = Number(process.env.PLASTICITY_COHESIVE_LAYER_COUNT ?? 34);
if (!Number.isSafeInteger(layerCount) || layerCount < 2 || layerCount > 256) {
  throw new Error("PLASTICITY_COHESIVE_LAYER_COUNT must be an integer from 2 through 256");
}

const workspace = await mkdtemp(join(tmpdir(), "plasticity-cohesive-layer-mesh-"));
try {
  const gmshPythonPath = await findGmshPythonPath();
  const stepPath = join(workspace, "box.step");
  const splitAngle = Math.PI / 4;
  const splitNormal = [Math.sin(splitAngle), 0, Math.cos(splitAngle)] as [number, number, number];
  const python = process.env.PLASTICITY_FEA_PYTHON ?? "python3";
  const createdStep = spawnSync(python, [
    "-c",
    "import gmsh,sys,json,math; gmsh.initialize(); gmsh.option.setNumber('General.Terminal',0); gmsh.model.add('layer-stack-mesh-acceptance'); gmsh.model.occ.addBox(0,0,0,10,10,10); gmsh.model.occ.rotate([(3,1)],0,0,0,0,1,0,math.pi/4); gmsh.model.occ.synchronize(); n=[math.sin(math.pi/4),0,math.cos(math.pi/4)]; faces=[];\nfor _,tag in gmsh.model.getEntities(2):\n c=gmsh.model.occ.getCenterOfMass(2,tag); uv=gmsh.model.getParametrization(2,tag,c); normal=gmsh.model.getNormal(tag,uv); length=math.sqrt(sum(v*v for v in normal)); normal=[v/length for v in normal];\n if abs(abs(sum(normal[i]*n[i] for i in range(3)))-1)<1e-6:\n  b=gmsh.model.occ.getBoundingBox(2,tag); faces.append({'faceId':'support' if sum(normal[i]*n[i] for i in range(3))<0 else 'loaded','surfaceType':'Plane','centerMm':list(c),'normal':normal,'boundsMm':{'min':list(b[:3]),'max':list(b[3:])}})\ngmsh.write(sys.argv[1]); print(json.dumps(faces)); gmsh.finalize()",
    stepPath,
  ], { encoding: "utf8", env: { ...process.env, PYTHONPATH: [gmshPythonPath, process.env.PYTHONPATH].filter(Boolean).join(delimiter) } });
  if (createdStep.error || createdStep.status !== 0) {
    throw new Error(`Could not create the synthetic STEP box with Gmsh: ${(createdStep.stderr || createdStep.error?.message || "unknown error").slice(-2_000)}`);
  }

  const faceLine = createdStep.stdout.trim().split(/\r?\n/).at(-1);
  if (!faceLine) throw new Error("Gmsh did not return tilted STEP boundary face signatures");
  const boundaryFaces = JSON.parse(faceLine) as Array<{
    faceId: string; surfaceType: "Plane"; centerMm: [number, number, number]; normal: [number, number, number];
    boundsMm: { min: [number, number, number]; max: [number, number, number] };
  }>;
  if (boundaryFaces.length !== 2) throw new Error("Could not identify both exact tilted end faces on the synthetic STEP box");

  const splitPlanes = Array.from({ length: layerCount - 1 }, (_, index) => {
    const offset = 10 * (index + 1) / layerCount;
    return {
      pointMm: splitNormal.map((component) => component * offset) as [number, number, number],
      normalGlobal: splitNormal,
    };
  });
  const mesh = await generateCohesiveMeshFromStep({
    stepPath,
    outputPath: join(workspace, "layerwise-cohesive.msh"),
    splitPlanes,
    meshSizeMm: 5,
    boundaryFaces,
    layerwiseRegions: true,
  });
  const regions = mesh.layerRegionGroups ?? [];
  if (mesh.volumeCount !== layerCount || regions.length !== layerCount || mesh.interfaceSurfaceGroups.length !== layerCount - 1
    || regions.some((group, index) => group.layerIndex !== index + 1 || group.physicalTag !== index + 1)
    || mesh.interfaceSurfaceGroups.some((group, index) => group.physicalTag !== layerCount + 1 + index)
    || mesh.cohesiveVolumeTag !== 1003 || mesh.cohesiveElementCount < layerCount - 1) {
    throw new Error(`Gmsh layer-stack acceptance failed: expected ${layerCount} regions/${layerCount - 1} interfaces/tag 1003, received ${mesh.volumeCount} regions/${mesh.interfaceSurfaceGroups.length} interfaces/tag ${String(mesh.cohesiveVolumeTag)} with ${regions.length} region groups and ${mesh.cohesiveElementCount} cohesive elements`);
  }

  console.log(JSON.stringify({
    ok: true,
    gmshVersion: mesh.gmshVersion,
    layerCount: mesh.volumeCount,
    interfaceCount: mesh.interfaceSurfaceGroups.length,
    cohesiveElementCount: mesh.cohesiveElementCount,
    cohesiveVolumeTag: mesh.cohesiveVolumeTag,
    firstRegion: regions[0],
    lastRegion: regions.at(-1),
    firstInterface: mesh.interfaceSurfaceGroups[0],
    lastInterface: mesh.interfaceSurfaceGroups.at(-1),
  }));
} finally {
  if (process.env.PLASTICITY_KEEP_COHESIVE_ACCEPTANCE_WORKSPACE === "1") {
    console.error(`Cohesive mesh acceptance workspace retained: ${workspace}`);
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
      const pythonPath = join(dirname(dirname(resolved)), "lib");
      await access(join(pythonPath, "gmsh.py"), constants.R_OK);
      return pythonPath;
    } catch { /* Continue through PATH until the active Gmsh package is found. */ }
  }
  throw new Error("Gmsh 4.15.x Homebrew Python API was not found; install Gmsh or set PLASTICITY_GMSH_PYTHON_PATH");
}
