import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { NativePlanarFaceReference, Vector3 } from "./step-face-mapping.ts";
import { MAX_LAYER_INTERFACE_PLANES } from "./layer-plane-plan.ts";

const COHESIVE_MESH_HELPER = fileURLToPath(new URL("../../../scripts/fem/cohesive-mesh.py", import.meta.url));
const MESH_TIMEOUT_MS = 120_000;
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;

export interface CohesiveBoundaryFace extends NativePlanarFaceReference { physicalTag: number }
export interface CohesiveSplitPlane { pointMm: Vector3; normalGlobal: Vector3 }
export interface CohesiveStepMeshRequest {
  stepPath: string;
  outputPath: string;
  splitPlanes: CohesiveSplitPlane[];
  meshSizeMm: number;
  boundaryFaces: NativePlanarFaceReference[];
  layerwiseRegions?: boolean;
}
export interface CohesiveStepMeshResult {
  gmshVersion: string;
  volumeCount: number;
  interfaceSurfaceCount: number;
  splitPlanes: CohesiveSplitPlane[];
  interfaceSurfaceGroups: Array<{ planeIndex: number; physicalTag: number; surfaceEntityTags: number[]; triangleCount: number }>;
  meshSizeMm: number;
  materialATetrahedronCount?: number;
  materialBTetrahedronCount?: number;
  cohesiveVolumeTag: number;
  layerwiseRegions: boolean;
  layerRegionGroups?: Array<{ layerIndex: number; physicalTag: number; name: string; tetrahedronCount: number }>;
  interfaceTriangleCount: number;
  duplicatedNodeCount: number;
  cohesiveElementCount: number;
  cohesiveElementIds: number[];
  boundaryGroups: Array<{ faceId: string; physicalTag: number; name: string; surfaceEntityTag: number }>;
  outputPath: string;
}

export async function generateCohesiveMeshFromStep(request: CohesiveStepMeshRequest, signal?: AbortSignal): Promise<CohesiveStepMeshResult> {
  validateCohesiveStepMeshRequest(request);
  if (signal?.aborted) throw new Error("Cohesive mesh generation was cancelled before start");
  const helper = await realpath(COHESIVE_MESH_HELPER);
  const stepPath = await realpath(resolve(request.stepPath));
  if (stepPath === resolve(request.outputPath)) {
    throw new Error("Cohesive mesh output must be a separate file from the STEP input");
  }
  const outputPath = resolve(request.outputPath);
  try {
    await access(outputPath);
    throw new Error("Refusing to overwrite an existing cohesive mesh");
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  const pythonPath = process.env.PLASTICITY_FEA_PYTHON ?? "python3";
  const gmshPythonPath = process.env.PLASTICITY_GMSH_PYTHON_PATH
    ? resolve(process.env.PLASTICITY_GMSH_PYTHON_PATH)
    : await homebrewPackageRootForGmsh();
  const taggedFaces = request.boundaryFaces.map((face, index) => ({ ...face, physicalTag: 1001 + index }));
  const stdout = await runMeshWorker(helper, stepPath, {
    outputPath,
    splitPlanes: request.splitPlanes,
    meshSizeMm: request.meshSizeMm,
    layerwiseRegions: request.layerwiseRegions ?? false,
    materialATag: 1,
    materialBTag: 2,
    interfaceSurfaceTag: 3,
    boundaryFaces: taggedFaces.map((face) => ({
      faceId: face.faceId,
      physicalTag: face.physicalTag,
      centerMm: face.centerMm,
      normalGlobal: face.normal,
      boundsMm: face.boundsMm,
    })),
  }, pythonPath, gmshPythonPath, signal);
  return parseCohesiveStepMeshResult(stdout, { ...request, stepPath, outputPath }, taggedFaces);
}

export function validateCohesiveStepMeshRequest(request: CohesiveStepMeshRequest): void {
  if (!request || typeof request.stepPath !== "string" || !request.stepPath
    || ![".step", ".stp"].includes(request.stepPath.slice(request.stepPath.lastIndexOf(".")).toLowerCase())) {
    throw new Error("Cohesive mesh generation requires a STEP input path");
  }
  if (typeof request.outputPath !== "string" || !request.outputPath.startsWith("/") || !request.outputPath.toLowerCase().endsWith(".msh")) {
    throw new Error("Cohesive mesh outputPath must be an absolute .msh path");
  }
  if (!Number.isFinite(request.meshSizeMm) || request.meshSizeMm <= 0 || request.meshSizeMm > 100) {
    throw new Error("Cohesive meshSizeMm must be finite and in (0, 100]");
  }
  if (request.layerwiseRegions !== undefined && typeof request.layerwiseRegions !== "boolean") {
    throw new Error("Cohesive layerwiseRegions must be boolean when provided");
  }
  if (!Array.isArray(request.splitPlanes) || request.splitPlanes.length < 1 || request.splitPlanes.length > MAX_LAYER_INTERFACE_PLANES) {
    throw new Error(`Cohesive mesh requires 1..${MAX_LAYER_INTERFACE_PLANES} split planes`);
  }
  let sharedNormal: Vector3 | undefined;
  const planeOffsets: number[] = [];
  request.splitPlanes.forEach((plane, index) => {
    if (!isVector(plane?.pointMm) || !isVector(plane.normalGlobal)) {
      throw new Error(`Cohesive split plane ${index} must contain finite three-dimensional vectors`);
    }
    if (Math.abs(Math.hypot(...plane.normalGlobal) - 1) > 1e-6) {
      throw new Error(`Cohesive split-plane normal ${index} must be a unit vector`);
    }
    if (sharedNormal && sharedNormal.reduce((sum, value, axis) => sum + value * plane.normalGlobal[axis]!, 0) < 1 - 1e-9) {
      throw new Error("All cohesive split planes must use parallel normals pointing in the same direction");
    }
    sharedNormal ??= plane.normalGlobal;
    planeOffsets.push(plane.pointMm.reduce((sum, value, axis) => sum + value * sharedNormal![axis]!, 0));
  });
  if (planeOffsets.some((offset, index) => index > 0 && planeOffsets[index - 1]! >= offset - 1e-9)) {
    throw new Error("Cohesive split planes must be ordered and separated along their shared normal");
  }
  if (!Array.isArray(request.boundaryFaces) || request.boundaryFaces.length < 2 || request.boundaryFaces.length > 32) {
    throw new Error("Cohesive mesh requires 2..32 native boundary faces");
  }
  const faceIds = new Set<string>();
  for (const face of request.boundaryFaces) {
    if (!face || typeof face.faceId !== "string" || !face.faceId || faceIds.has(face.faceId)) {
      throw new Error("Cohesive boundary face IDs must be unique and nonempty");
    }
    faceIds.add(face.faceId);
    if (face.surfaceType !== "Plane" || !isVector(face.centerMm) || !isVector(face.normal)
      || !isVector(face.boundsMm?.min) || !isVector(face.boundsMm?.max)
      || Math.hypot(...face.normal) < 1e-12
      || face.boundsMm.min.some((value, axis) => value > face.boundsMm.max[axis]!)) {
      throw new Error(`Cohesive boundary face ${face.faceId} must be a valid native planar face`);
    }
  }
}

export function parseCohesiveStepMeshResult(
  stdout: string,
  request: CohesiveStepMeshRequest,
  taggedFaces: CohesiveBoundaryFace[] = request.boundaryFaces.map((face, index) => ({ ...face, physicalTag: 1001 + index })),
): CohesiveStepMeshResult {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { throw new Error("Gmsh cohesive mesh worker returned invalid JSON"); }
  const layerwiseRegions = request.layerwiseRegions ?? false;
  const expectedInterfaceTagBase = layerwiseRegions ? Math.max(3, request.splitPlanes.length + 2) : 3;
  if (!isRecord(value) || value.ok !== true || typeof value.gmshVersion !== "string" || !/^4\.15\.\d+$/.test(value.gmshVersion)
    || value.volumeCount !== request.splitPlanes.length + 1 || !isPositiveInteger(value.interfaceSurfaceCount)
    || value.outputPath !== resolve(request.outputPath) || value.meshSizeMm !== request.meshSizeMm
    || value.materialATag !== 1 || value.materialBTag !== 2 || !isPositiveInteger(value.cohesiveVolumeTag)
    || value.layerwiseRegions !== layerwiseRegions
    || !Array.isArray(value.interfaceSurfaceTags) || value.interfaceSurfaceTags.length !== request.splitPlanes.length
    || value.interfaceSurfaceTags.some((tag, index) => tag !== expectedInterfaceTagBase + index)
    || !Array.isArray(value.splitPlanes) || value.splitPlanes.length !== request.splitPlanes.length
    || value.splitPlanes.some((plane, index) => !isRecord(plane) || !isVector(plane.pointMm) || !isVector(plane.normalGlobal)
      || !sameVector(plane.pointMm, request.splitPlanes[index]!.pointMm) || !sameUnitVector(plane.normalGlobal, request.splitPlanes[index]!.normalGlobal))) {
    throw new Error("Gmsh cohesive mesh worker returned an invalid response envelope");
  }
  if ([1, 2, ...(value.interfaceSurfaceTags as number[]), ...taggedFaces.map((face) => face.physicalTag)].includes(value.cohesiveVolumeTag)) {
    throw new Error("Gmsh cohesive mesh worker returned a conflicting cohesive volume physical tag");
  }
  for (const key of ["interfaceTriangleCount", "duplicatedNodeCount", "cohesiveElementCount"] as const) {
    if (!isPositiveInteger(value[key]) || value[key] > 500_000) throw new Error(`Gmsh cohesive mesh worker returned invalid ${key}`);
  }
  if (layerwiseRegions) {
    if (!Array.isArray(value.layerRegionGroups) || value.layerRegionGroups.length !== request.splitPlanes.length + 1
      || value.layerRegionGroups.some((group, index) => !isRecord(group) || group.layerIndex !== index + 1
        || group.physicalTag !== index + 1 || group.name !== `GM${index + 1}`
        || !isPositiveInteger(group.tetrahedronCount) || group.tetrahedronCount > 500_000)) {
      throw new Error("Gmsh cohesive mesh worker returned invalid ordered layer-region groups");
    }
  } else {
    for (const key of ["materialATetrahedronCount", "materialBTetrahedronCount"] as const) {
      if (!isPositiveInteger(value[key]) || value[key] > 500_000) throw new Error(`Gmsh cohesive mesh worker returned invalid ${key}`);
    }
  }
  if (!Array.isArray(value.cohesiveElementIds) || value.cohesiveElementIds.length !== value.cohesiveElementCount
    || value.cohesiveElementIds.some((id) => !isPositiveInteger(id))
    || new Set(value.cohesiveElementIds).size !== value.cohesiveElementIds.length) {
    throw new Error("Gmsh cohesive mesh worker returned invalid cohesive element IDs");
  }
  if (!isRecord(value.interfaceTriangleCountsByTag)
    || request.splitPlanes.some((_plane, index) => !isPositiveInteger(value.interfaceTriangleCountsByTag?.[String(expectedInterfaceTagBase + index)]))) {
    throw new Error("Gmsh cohesive mesh worker returned invalid per-interface triangle counts");
  }
  if (!Array.isArray(value.interfaceSurfaceGroups) || value.interfaceSurfaceGroups.length !== request.splitPlanes.length) {
    throw new Error("Gmsh cohesive mesh worker returned invalid split-plane surface groups");
  }
  const interfaceSurfaceGroups = request.splitPlanes.map((_plane, index) => {
    const group = value.interfaceSurfaceGroups?.[index];
    if (!isRecord(group) || group.planeIndex !== index || group.physicalTag !== expectedInterfaceTagBase + index
      || !Array.isArray(group.surfaceEntityTags) || group.surfaceEntityTags.length === 0
      || group.surfaceEntityTags.some((tag) => !isPositiveInteger(tag))
      || group.triangleCount !== value.interfaceTriangleCountsByTag?.[String(expectedInterfaceTagBase + index)]) {
      throw new Error(`Gmsh cohesive mesh worker returned an invalid surface group for split plane ${index}`);
    }
    return { planeIndex: index, physicalTag: expectedInterfaceTagBase + index, surfaceEntityTags: [...group.surfaceEntityTags] as number[], triangleCount: group.triangleCount as number };
  });
  if (!Array.isArray(value.boundaryGroups) || value.boundaryGroups.length !== taggedFaces.length) {
    throw new Error("Gmsh cohesive mesh worker did not map every requested native boundary face");
  }
  const groups = value.boundaryGroups as unknown[];
  const boundaryGroups = taggedFaces.map((face) => {
    const group = groups.find((candidate) => isRecord(candidate) && candidate.faceId === face.faceId);
    if (!isRecord(group) || group.physicalTag !== face.physicalTag || group.name !== `GM${face.physicalTag}`
      || !isPositiveInteger(group.surfaceEntityTag)) {
      throw new Error(`Gmsh cohesive mesh worker returned an invalid boundary face group for ${face.faceId}`);
    }
    return { faceId: face.faceId, physicalTag: face.physicalTag, name: group.name, surfaceEntityTag: group.surfaceEntityTag };
  });
  if (new Set(boundaryGroups.map((group) => group.surfaceEntityTag)).size !== boundaryGroups.length) {
    throw new Error("Gmsh cohesive boundary groups must map to distinct native surfaces");
  }
  return {
    gmshVersion: value.gmshVersion,
    volumeCount: value.volumeCount as number,
    interfaceSurfaceCount: value.interfaceSurfaceCount,
    splitPlanes: request.splitPlanes.map((plane) => ({ pointMm: plane.pointMm, normalGlobal: plane.normalGlobal })),
    interfaceSurfaceGroups,
    meshSizeMm: value.meshSizeMm,
    ...(!layerwiseRegions ? {
      materialATetrahedronCount: value.materialATetrahedronCount as number,
      materialBTetrahedronCount: value.materialBTetrahedronCount as number,
    } : {}),
    cohesiveVolumeTag: value.cohesiveVolumeTag,
    layerwiseRegions,
    ...(layerwiseRegions ? { layerRegionGroups: value.layerRegionGroups as NonNullable<CohesiveStepMeshResult["layerRegionGroups"]> } : {}),
    interfaceTriangleCount: value.interfaceTriangleCount,
    duplicatedNodeCount: value.duplicatedNodeCount,
    cohesiveElementCount: value.cohesiveElementCount,
    cohesiveElementIds: [...value.cohesiveElementIds],
    boundaryGroups,
    outputPath: value.outputPath,
  };
}

async function homebrewPackageRootForGmsh(): Promise<string> {
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    const binary = join(entry, "gmsh");
    try {
      await access(binary, constants.X_OK);
      const resolved = await realpath(binary);
      const packageRoot = dirname(dirname(resolved));
      await access(join(packageRoot, "lib", "gmsh.py"), constants.R_OK);
      return join(packageRoot, "lib");
    } catch { /* Keep searching for a Homebrew Gmsh installation. */ }
  }
  throw new Error("Gmsh 4.15.x Homebrew Python API was not found; install Gmsh or set PLASTICITY_GMSH_PYTHON_PATH");
}

function runMeshWorker(helper: string, stepPath: string, request: object, pythonPath: string, gmshPath: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    if (signal?.aborted) { reject(new Error("Cohesive mesh generation was cancelled before start")); return; }
    const child = spawn(pythonPath, [helper], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONPATH: [gmshPath, process.env.PYTHONPATH].filter(Boolean).join(delimiter) },
    });
    let stdout = "";
    let stdoutBytes = 0;
    let stderr = "";
    let timedOut = false;
    let oversized = false;
    const terminate = () => {
      child.kill("SIGTERM");
      const forceKill = setTimeout(() => child.kill("SIGKILL"), 2_000);
      forceKill.unref();
    };
    const abort = () => terminate();
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => { timedOut = true; terminate(); }, MESH_TIMEOUT_MS);
    timeout.unref();
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > MAX_STDOUT_BYTES) { oversized = true; terminate(); }
      else stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_BYTES); });
    child.once("error", (error) => { clearTimeout(timeout); signal?.removeEventListener("abort", abort); reject(error); });
    child.once("close", (code, terminationSignal) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(new Error("Cohesive mesh generation was cancelled"));
      else if (timedOut) reject(new Error("Cohesive mesh generation timed out"));
      else if (oversized) reject(new Error("Gmsh cohesive mesh response exceeded 1 MiB"));
      else if (code !== 0) reject(new Error(`Gmsh cohesive mesh generation failed (${terminationSignal ?? code}): ${stderr.slice(-4_000)}`));
      else resolveOutput(stdout);
    });
    child.stdin.end(JSON.stringify({ ...request, stepPath }));
  });
}

function isVector(value: unknown): value is Vector3 {
  return Array.isArray(value) && value.length === 3 && value.every((component) => typeof component === "number" && Number.isFinite(component));
}

function sameVector(first: Vector3, second: Vector3): boolean {
  return first.every((value, axis) => Math.abs(value - second[axis]!) <= 1e-9);
}

function sameUnitVector(first: Vector3, second: Vector3): boolean {
  return Math.hypot(...first.map((value, axis) => value - second[axis]!)) <= 1e-6;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
