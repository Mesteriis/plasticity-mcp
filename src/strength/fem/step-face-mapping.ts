import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { MAX_LAYER_INTERFACE_PLANES, MAX_LAYERWISE_FEA_LAYERS } from "./layer-plane-plan.ts";

export type Vector3 = [number, number, number];
export interface NativePlanarFaceReference {
  faceId: string;
  surfaceType: string;
  centerMm: Vector3;
  normal: Vector3;
  boundsMm: { min: Vector3; max: Vector3 };
}

export interface StepFaceMapping {
  faceId: string;
  surfaceEntityTag: number;
  surfaceType: "Plane";
  centerMm: Vector3;
  normal: Vector3;
  boundsMm: { min: Vector3; max: Vector3 };
  areaMm2: number;
  maxSignatureErrorMm: number;
  normalDot: number;
}

export interface StepFaceMappingResult {
  schemaVersion: 1;
  gmshVersion: string;
  volumeCount: 1;
  surfaceCount: number;
  toleranceMm: number;
  mappings: StepFaceMapping[];
  mesh?: CalculiXMeshSummary;
}

export interface CalculiXMeshSummary {
  meshFile: string;
  codeAsterMeshFile?: string;
  codeAsterMeshFormat?: "GMSH-2.2";
  codeAsterPhysicalGroups?: Array<{ dimension: 2 | 3; tag: number; name: string; faceId: string | null }>;
  elementSICNFile: string;
  meshSizeMm: number;
  elementFamily: "C3D4";
  nodeCount: number;
  tetrahedronCount: number;
  layerRegionGroups?: Array<{ layerIndex: number; elsetName: string; tetrahedronCount: number }>;
  minimumScaledInverseConditionNumber: number;
  minimumSICNElementId: number;
  minimumSICNElementCentroidMm: Vector3;
  fifthPercentileSampledSICN: number;
  medianSampledSICN: number;
  boundsMm: { min: Vector3; max: Vector3 };
  nodeSets: Array<{ faceId: string; setName: string; nodeCount: number }>;
  sharedSurfaceNodeCount: number;
  loadFile: string | null;
  surfaceLoads: Array<{ faceId: string; surfaceAreaMm2: number; tractionNPerMm2: Vector3; resultantN: Vector3; resultantMomentNmm: Vector3; loadedNodeCount: number }>;
  resultantLoads: Array<{ faceId: string; forceN: Vector3; applicationPointMm: Vector3; momentNmm: Vector3; appliedMomentAtOriginNmm: Vector3 }>;
  totalResultantN: Vector3;
  totalResultantMomentNmm: Vector3;
}

export interface CalculiXSurfaceLoad {
  faceId: string;
  tractionNPerMm2: Vector3;
}

export interface CalculiXResultantLoad {
  faceId: string;
  forceN: Vector3;
  applicationPointMm: Vector3;
  momentNmm: Vector3;
}

const DEFAULT_TOLERANCE_MM = 0.0001;
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const MAPPING_TIMEOUT_MS = 90_000;
const PYTHON_HELPER = fileURLToPath(new URL("../../../scripts/fem/map-step-faces.py", import.meta.url));

export async function mapNativePlanarFacesToStep(
  stepPath: string,
  faces: NativePlanarFaceReference[],
  toleranceMm = DEFAULT_TOLERANCE_MM,
): Promise<StepFaceMappingResult> {
  const request = validateRequest(stepPath, faces, toleranceMm);
  const helper = await realpath(PYTHON_HELPER);
  const inputPath = await realpath(resolve(stepPath));
  const pythonPath = process.env.PLASTICITY_FEA_PYTHON ?? "python3";
  const pythonPathEnv = process.env.PLASTICITY_GMSH_PYTHON_PATH
    ? resolve(process.env.PLASTICITY_GMSH_PYTHON_PATH)
    : join(await homebrewPackageRootForGmsh(), "lib");
  const output = await runPython(helper, inputPath, request, pythonPath, pythonPathEnv);
  return parseStepFaceMappingResult(output, faces, toleranceMm);
}

export async function generateCalculiXMeshFromStep(
  stepPath: string,
  faces: NativePlanarFaceReference[],
  nodeSetFaceIds: string[],
  meshSizeMm: number,
  meshOutputPath: string,
  toleranceMm = DEFAULT_TOLERANCE_MM,
  surfaceLoads: CalculiXSurfaceLoad[] = [],
  signal?: AbortSignal,
  resultantLoads: CalculiXResultantLoad[] = [],
  codeAsterMeshOutputPath?: string,
  layerSplitPlanes?: Array<{ pointMm: Vector3; normalGlobal: Vector3 }>,
): Promise<StepFaceMappingResult & { mesh: CalculiXMeshSummary; elementIds: ReadonlySet<number> }> {
  const base = validateRequest(stepPath, faces, toleranceMm);
  if (!Array.isArray(nodeSetFaceIds) || nodeSetFaceIds.length < 1 || new Set(nodeSetFaceIds).size !== nodeSetFaceIds.length) {
    throw new Error("At least one unique face ID is required for a CalculiX node set");
  }
  if (nodeSetFaceIds.some((id) => !faces.some((face) => face.faceId === id))) throw new Error("Node-set faces must be included in the mapped native face references");
  if (!Number.isFinite(meshSizeMm) || meshSizeMm <= 0 || meshSizeMm > 100) throw new Error("meshSizeMm must be finite and in (0, 100]");
  if (!meshOutputPath.toLowerCase().endsWith(".inp")) throw new Error("CalculiX mesh output must use the .inp extension");
  if (codeAsterMeshOutputPath !== undefined && !resolve(codeAsterMeshOutputPath).toLowerCase().endsWith(".msh")) {
    throw new Error("Code_Aster mesh output must use the .msh extension");
  }
  if (layerSplitPlanes !== undefined) {
    if (!Array.isArray(layerSplitPlanes) || layerSplitPlanes.length < 1 || layerSplitPlanes.length > MAX_LAYER_INTERFACE_PLANES
      || layerSplitPlanes.some((plane) => !plane || !Array.isArray(plane.pointMm) || !Array.isArray(plane.normalGlobal)
        || !plane.pointMm.every(Number.isFinite) || !plane.normalGlobal.every(Number.isFinite)
        || Math.abs(Math.hypot(...plane.normalGlobal) - 1) > 1e-6)) {
      throw new Error(`Layer split planes must contain 1..${MAX_LAYER_INTERFACE_PLANES} finite, unit-normal planes`);
    }
    const normal = layerSplitPlanes[0]!.normalGlobal;
    const offsets = layerSplitPlanes.map((plane) => {
      if (normal.reduce((sum, value, axis) => sum + value * plane.normalGlobal[axis]!, 0) < 1 - 1e-9) {
        throw new Error("Layer split planes must have parallel normals pointing in the same direction");
      }
      return normal.reduce((sum, value, axis) => sum + value * plane.pointMm[axis]!, 0);
    });
    if (offsets.some((offset, index) => index > 0 && offset <= offsets[index - 1]! + 1e-9)) {
      throw new Error("Layer split planes must be ordered and separated along their shared normal");
    }
  }
  if (!Array.isArray(surfaceLoads) || surfaceLoads.length > 32) throw new Error("At most 32 face traction loads are supported");
  if (!Array.isArray(resultantLoads) || resultantLoads.length > 32) throw new Error("At most 32 face force/moment loads are supported");
  const nodeSetIds = new Set(nodeSetFaceIds);
  const resultantFaceIds = new Set<string>();
  for (const load of resultantLoads) {
    if (!load || !nodeSetIds.has(load.faceId) || resultantFaceIds.has(load.faceId)
      || ![...load.forceN, ...load.applicationPointMm, ...load.momentNmm].every(Number.isFinite)
      || (!load.forceN.some((value) => value !== 0) && !load.momentNmm.some((value) => value !== 0))) {
      throw new Error("Each resultant face load requires a unique mapped node-set face, finite force/point/moment, and a nonzero force or moment");
    }
    resultantFaceIds.add(load.faceId);
  }
  const loadedFaceIds = new Set<string>();
  for (const load of surfaceLoads) {
    if (!load || !nodeSetFaceIds.includes(load.faceId) || loadedFaceIds.has(load.faceId)
      || !Array.isArray(load.tractionNPerMm2) || load.tractionNPerMm2.length !== 3
      || !load.tractionNPerMm2.every(Number.isFinite) || Math.hypot(...load.tractionNPerMm2) === 0) {
      throw new Error("Each surface traction requires one unique node-set face and a nonzero finite 3-vector in N/mm²");
    }
    loadedFaceIds.add(load.faceId);
  }
  const helper = await realpath(PYTHON_HELPER);
  const inputPath = await realpath(resolve(stepPath));
  const requestedOutputPath = resolve(meshOutputPath);
  const requestedElementSICNPath = requestedOutputPath.replace(/\.inp$/i, "-sicn.csv");
  const requestedLoadPath = surfaceLoads.length || resultantLoads.length ? requestedOutputPath.replace(/\.inp$/i, "-loads.inp") : undefined;
  const pythonPath = process.env.PLASTICITY_FEA_PYTHON ?? "python3";
  const pythonPathEnv = process.env.PLASTICITY_GMSH_PYTHON_PATH
    ? resolve(process.env.PLASTICITY_GMSH_PYTHON_PATH)
    : join(await homebrewPackageRootForGmsh(), "lib");
  const output = await runPython(helper, inputPath, {
    ...base,
    mesh: {
      meshSizeMm,
      outputPath: requestedOutputPath,
      elementSICNOutputPath: requestedElementSICNPath,
      ...(codeAsterMeshOutputPath ? { codeAsterOutputPath: resolve(codeAsterMeshOutputPath) } : {}),
      ...(layerSplitPlanes ? { layerSplitPlanes, mappingToleranceMm: toleranceMm } : {}),
      nodeSetFaceIds,
      ...(requestedLoadPath ? { loadOutputPath: requestedLoadPath } : {}),
      surfaceLoads,
      resultantLoads,
    },
  }, pythonPath, pythonPathEnv, signal);
  const parsed = parseStepFaceMappingResult(output, faces, toleranceMm);
  if (!parsed.mesh || parsed.mesh.meshFile !== requestedOutputPath || parsed.mesh.elementSICNFile !== requestedElementSICNPath || parsed.mesh.meshSizeMm !== meshSizeMm
    || parsed.mesh.nodeSets.length !== nodeSetFaceIds.length
    || parsed.mesh.nodeSets.some((nodeSet, index) => nodeSet.faceId !== nodeSetFaceIds[index])
    || parsed.mesh.surfaceLoads.length !== surfaceLoads.length
    || parsed.mesh.surfaceLoads.some((load, index) => load.faceId !== surfaceLoads[index]?.faceId)
    || parsed.mesh.resultantLoads.length !== resultantLoads.length
    || parsed.mesh.resultantLoads.some((load, index) => load.faceId !== resultantLoads[index]?.faceId)
    || (layerSplitPlanes === undefined) !== (parsed.mesh.layerRegionGroups === undefined)
    || (layerSplitPlanes && (parsed.mesh.layerRegionGroups?.length !== layerSplitPlanes.length + 1
      || parsed.mesh.layerRegionGroups.some((group, index) => group.layerIndex !== index + 1 || group.elsetName !== `LAYER_${index + 1}`)))
    || parsed.mesh.loadFile !== (requestedLoadPath ?? null)
    || parsed.mesh.codeAsterMeshFile !== (codeAsterMeshOutputPath ? resolve(codeAsterMeshOutputPath) : undefined)) {
    throw new Error("Gmsh returned incomplete mesh or boundary node-set evidence");
  }
  const elementIds = verifyMinimumSICNElementLocator(await readFile(requestedOutputPath, "utf8"), parsed.mesh, parsed.mesh.tetrahedronCount);
  if (parsed.mesh.layerRegionGroups) verifyLayerRegionElementSets(await readFile(requestedOutputPath, "utf8"), parsed.mesh.layerRegionGroups, elementIds);
  return { ...parsed, mesh: parsed.mesh, elementIds } as StepFaceMappingResult & { mesh: CalculiXMeshSummary; elementIds: ReadonlySet<number> };
}

export async function readElementSICN(path: string, validElementIds: ReadonlySet<number>, elementId: number): Promise<number> {
  if (!Number.isSafeInteger(elementId) || elementId <= 0 || !(validElementIds instanceof Set) || validElementIds.size < 1 || validElementIds.size > 500_000) {
    throw new Error("SICN lookup requires a positive element ID and supported mesh element IDs");
  }
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let lineNumber = 0;
  const seen = new Set<number>();
  let requestedValue: number | undefined;
  for await (const line of lines) {
    lineNumber += 1;
    if (lineNumber === 1) {
      if (line !== "elementId,minSICN") throw new Error("SICN table has an invalid header");
      continue;
    }
    const [rawId, rawQuality, ...extra] = line.split(",");
    const id = Number(rawId);
    const quality = Number(rawQuality);
    if (extra.length || !Number.isSafeInteger(id) || id <= 0 || !validElementIds.has(id) || !Number.isFinite(quality) || quality <= 0 || quality > 1) {
      throw new Error(`SICN table contains an invalid SICN row at line ${lineNumber}: element=${rawId}, value=${rawQuality}`);
    }
    if (seen.has(id)) throw new Error(`SICN table contains duplicate element ${id}`);
    seen.add(id);
    if (id === elementId) requestedValue = quality;
  }
  if (lineNumber < 1 || seen.size !== validElementIds.size) throw new Error("SICN table does not contain the expected mesh element IDs");
  if (requestedValue === undefined) throw new Error(`SICN table does not contain element ${elementId}`);
  return requestedValue;
}

export function verifyMinimumSICNElementLocator(
  meshText: string,
  evidence: Pick<CalculiXMeshSummary, "minimumSICNElementId" | "minimumSICNElementCentroidMm">,
  expectedElementCount?: number,
): ReadonlySet<number> {
  const coordinates = new Map<number, Vector3>();
  let readingNodes = false;
  let readingElements = false;
  let minimumElementFound = false;
  const elementIds = new Set<number>();
  for (const line of meshText.split(/\r?\n/)) {
    if (line.startsWith("*")) {
      readingNodes = /^\*NODE\s*$/i.test(line);
      readingElements = /^\*ELEMENT,\s*TYPE=C3D4,\s*ELSET=SOLID\s*$/i.test(line);
      continue;
    }
    if (!line.trim()) continue;
    if (readingNodes) {
      const values = line.split(",").map((value) => Number(value.trim()));
      const [nodeId, x, y, z] = values;
      if (values.length !== 4 || !Number.isSafeInteger(nodeId) || nodeId! <= 0 || ![x, y, z].every(Number.isFinite) || coordinates.has(nodeId!)) {
        throw new Error("CalculiX mesh contains invalid node coordinates while checking the minimum-SICN element");
      }
      coordinates.set(nodeId!, [x!, y!, z!]);
    } else if (readingElements) {
      const values = line.split(",").map((value) => Number(value.trim()));
      const [elementId, ...nodeIds] = values;
      if (values.length !== 5 || !Number.isSafeInteger(elementId) || elementId! <= 0 || elementIds.has(elementId!)
        || nodeIds.some((nodeId) => !Number.isSafeInteger(nodeId) || nodeId <= 0)) {
        throw new Error("CalculiX mesh contains invalid C3D4 element connectivity");
      }
      elementIds.add(elementId!);
      const elementCoordinates = nodeIds.map((nodeId) => coordinates.get(nodeId!));
      if (elementCoordinates.some((coordinate) => !coordinate)) throw new Error(`C3D4 element ${elementId} references a missing mesh node`);
      if (elementId !== evidence.minimumSICNElementId) continue;
      if (minimumElementFound) throw new Error("CalculiX mesh contains duplicate minimum-SICN element evidence");
      const centroid = [0, 1, 2].map((axis) => elementCoordinates.reduce((sum, coordinate) => sum + coordinate![axis]!, 0) / 4);
      if (centroid.some((coordinate, axis) => Math.abs(coordinate - evidence.minimumSICNElementCentroidMm[axis]!) > 1e-9)) {
        throw new Error("Gmsh minimum-SICN centroid does not match the written CalculiX mesh element");
      }
      minimumElementFound = true;
    }
  }
  if (!minimumElementFound) throw new Error(`Minimum-SICN element ${evidence.minimumSICNElementId} is absent from the written CalculiX mesh`);
  if (expectedElementCount !== undefined && elementIds.size !== expectedElementCount) throw new Error("CalculiX mesh element count does not match Gmsh mesh summary");
  return elementIds;
}

export function verifyLayerRegionElementSets(
  meshText: string,
  groups: NonNullable<CalculiXMeshSummary["layerRegionGroups"]>,
  allElementIds: ReadonlySet<number>,
): void {
  const assigned = new Set<number>();
  const counts = new Map(groups.map((group) => [group.elsetName, 0]));
  const seenGroups = new Set<string>();
  let currentGroup: typeof groups[number] | undefined;
  for (const line of meshText.split(/\r?\n/)) {
    if (line.startsWith("*")) {
      const match = /^\*ELSET,\s*ELSET=([A-Z][A-Z0-9_]*)\s*$/i.exec(line);
      currentGroup = match ? groups.find((group) => group.elsetName === match[1]) : undefined;
      if (currentGroup) {
        if (seenGroups.has(currentGroup.elsetName)) throw new Error(`CalculiX layer ELSET ${currentGroup.elsetName} is duplicated`);
        seenGroups.add(currentGroup.elsetName);
      }
      continue;
    }
    if (!currentGroup || !line.trim()) continue;
    const values = line.split(",").map((value) => Number(value.trim()));
    if (values.some((value) => !Number.isSafeInteger(value) || value <= 0)) throw new Error(`CalculiX layer ELSET ${currentGroup.elsetName} contains an invalid element ID`);
    for (const id of values) {
      if (!allElementIds.has(id) || assigned.has(id)) throw new Error(`CalculiX element ${id} is absent or duplicated across layer ELSETs`);
      assigned.add(id);
      counts.set(currentGroup.elsetName, counts.get(currentGroup.elsetName)! + 1);
    }
  }
  if (assigned.size !== allElementIds.size || seenGroups.size !== groups.length
    || groups.some((group) => counts.get(group.elsetName) !== group.tetrahedronCount)) {
    throw new Error("CalculiX layer ELSETs do not form an exact partition of the solid tetrahedra");
  }
}

export function parseStepFaceMappingResult(
  output: string,
  expectedFaces: NativePlanarFaceReference[],
  expectedToleranceMm = DEFAULT_TOLERANCE_MM,
): StepFaceMappingResult {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error("Gmsh face mapper returned invalid JSON");
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.gmshVersion !== "string"
    || !value.gmshVersion.startsWith("4.15.") || value.volumeCount !== 1
    || !Number.isInteger(value.surfaceCount) || (value.surfaceCount as number) < 1
    || value.toleranceMm !== expectedToleranceMm || !Array.isArray(value.mappings)) {
    throw new Error("Gmsh face mapper returned an invalid response envelope");
  }
  if (value.mappings.length !== expectedFaces.length) throw new Error("Gmsh face mapper returned an incomplete face mapping");
  const expectedById = new Map(expectedFaces.map((face) => [face.faceId, face]));
  const seenFaces = new Set<string>();
  const seenEntities = new Set<number>();
  const mappings: StepFaceMapping[] = value.mappings.map((item: unknown) => {
    if (!isRecord(item) || typeof item.faceId !== "string" || !expectedById.has(item.faceId)
      || seenFaces.has(item.faceId) || !Number.isInteger(item.surfaceEntityTag) || (item.surfaceEntityTag as number) < 1
      || item.surfaceType !== "Plane" || !isVector(item.centerMm) || !isVector(item.normal)
      || !isRecord(item.boundsMm) || !isVector(item.boundsMm.min) || !isVector(item.boundsMm.max)
      || !isPositive(item.areaMm2) || !isNonnegative(item.maxSignatureErrorMm)
      || item.maxSignatureErrorMm > expectedToleranceMm || typeof item.normalDot !== "number" || item.normalDot < 0.99999) {
      throw new Error("Gmsh face mapper returned an invalid mapping entry");
    }
    if (seenEntities.has(item.surfaceEntityTag as number)) throw new Error("Gmsh face mapper returned a non-bijective mapping");
    seenFaces.add(item.faceId);
    seenEntities.add(item.surfaceEntityTag as number);
    return item as unknown as StepFaceMapping;
  });
  if (seenFaces.size !== expectedById.size) throw new Error("Gmsh face mapper omitted a requested native face");
  const result: StepFaceMappingResult = {
    schemaVersion: 1,
    gmshVersion: value.gmshVersion,
    volumeCount: 1,
    surfaceCount: value.surfaceCount as number,
    toleranceMm: expectedToleranceMm,
    mappings,
  };
  if (value.mesh !== undefined) result.mesh = parseMeshSummary(value.mesh);
  return result;
}

function parseMeshSummary(value: unknown): CalculiXMeshSummary {
  if (!isRecord(value) || typeof value.meshFile !== "string" || !value.meshFile.startsWith("/")
    || typeof value.elementSICNFile !== "string" || !value.elementSICNFile.startsWith("/")
    || !isPositive(value.meshSizeMm) || value.elementFamily !== "C3D4"
    || !Number.isInteger(value.nodeCount) || (value.nodeCount as number) < 4 || (value.nodeCount as number) > 1_000_000
    || !Number.isInteger(value.tetrahedronCount) || (value.tetrahedronCount as number) < 1 || (value.tetrahedronCount as number) > 500_000
    || !isPositive(value.minimumScaledInverseConditionNumber) || value.minimumScaledInverseConditionNumber > 1
    || !Number.isSafeInteger(value.minimumSICNElementId) || (value.minimumSICNElementId as number) <= 0
    || !isVector(value.minimumSICNElementCentroidMm)
    || !isRecord(value.boundsMm) || !isVector(value.boundsMm.min) || !isVector(value.boundsMm.max)
    || !Array.isArray(value.nodeSets) || value.nodeSets.length < 1
    || !Number.isInteger(value.sharedSurfaceNodeCount) || (value.sharedSurfaceNodeCount as number) < 0
    || !(value.loadFile === null || (typeof value.loadFile === "string" && value.loadFile.startsWith("/")))
    || !Array.isArray(value.surfaceLoads) || !Array.isArray(value.resultantLoads)
    || !isVector(value.totalResultantN) || !isVector(value.totalResultantMomentNmm)) {
    throw new Error("Gmsh returned invalid CalculiX mesh evidence");
  }
  if (!isFiniteUnitInterval(value.fifthPercentileSampledSICN) || !isFiniteUnitInterval(value.medianSampledSICN)
    || (value.fifthPercentileSampledSICN as number) < value.minimumScaledInverseConditionNumber
    || (value.medianSampledSICN as number) < (value.fifthPercentileSampledSICN as number)) {
    throw new Error(`Gmsh returned inconsistent sampled SICN distribution (min=${String(value.minimumScaledInverseConditionNumber)}, p05=${String(value.fifthPercentileSampledSICN)}, median=${String(value.medianSampledSICN)})`);
  }
  if (value.layerRegionGroups !== undefined) {
    if (!Array.isArray(value.layerRegionGroups) || value.layerRegionGroups.length < 2 || value.layerRegionGroups.length > MAX_LAYERWISE_FEA_LAYERS) {
      throw new Error("Gmsh returned invalid layer region groups");
    }
    const groups = value.layerRegionGroups as unknown[];
    const parsedGroups = groups.map((group, index) => {
      if (!isRecord(group) || group.layerIndex !== index + 1 || group.elsetName !== `LAYER_${index + 1}`
        || !Number.isInteger(group.tetrahedronCount) || (group.tetrahedronCount as number) <= 0) {
        throw new Error("Gmsh returned invalid ordered layer region groups");
      }
      return group as unknown as NonNullable<CalculiXMeshSummary["layerRegionGroups"]>[number];
    });
    if (parsedGroups.reduce((sum, group) => sum + group.tetrahedronCount, 0) !== value.tetrahedronCount) {
      throw new Error("Gmsh layer region counts do not partition the C3D4 solid mesh");
    }
  }
  const nodeSets = value.nodeSets.map((nodeSet: unknown) => {
    if (!isRecord(nodeSet) || typeof nodeSet.faceId !== "string" || !nodeSet.faceId
      || typeof nodeSet.setName !== "string" || !/^FACE_[1-9][0-9]*$/.test(nodeSet.setName)
      || !Number.isInteger(nodeSet.nodeCount) || (nodeSet.nodeCount as number) < 1 || nodeSet.nodeCount > value.nodeCount) {
      throw new Error("Gmsh returned an invalid boundary node set");
    }
    return nodeSet as unknown as CalculiXMeshSummary["nodeSets"][number];
  });
  if (new Set(nodeSets.map((set) => set.faceId)).size !== nodeSets.length || new Set(nodeSets.map((set) => set.setName)).size !== nodeSets.length) {
    throw new Error("Gmsh returned duplicate face or node-set names");
  }
  const codeAsterFields = [value.codeAsterMeshFile, value.codeAsterMeshFormat, value.codeAsterPhysicalGroups];
  if (codeAsterFields.some((field) => field !== undefined)) {
    if (typeof value.codeAsterMeshFile !== "string" || !value.codeAsterMeshFile.startsWith("/")
      || value.codeAsterMeshFormat !== "GMSH-2.2"
      || !Array.isArray(value.codeAsterPhysicalGroups) || value.codeAsterPhysicalGroups.length !== nodeSets.length + 1) {
      throw new Error("Gmsh returned incomplete Code_Aster mesh evidence");
    }
    const physicalGroups = value.codeAsterPhysicalGroups;
    const solidGroup = physicalGroups[0];
    if (!isRecord(solidGroup) || solidGroup.dimension !== 3 || solidGroup.tag !== 1 || solidGroup.name !== "GM1" || solidGroup.faceId !== null) {
      throw new Error("Gmsh returned an invalid Code_Aster volume physical group");
    }
    for (const [index, nodeSet] of nodeSets.entries()) {
      const group = physicalGroups[index + 1];
      if (!isRecord(group) || group.dimension !== 2 || group.tag !== 1001 + index
        || group.name !== `GM${group.tag}` || group.faceId !== nodeSet.faceId) {
        throw new Error("Gmsh returned a Code_Aster physical face group that does not match its native Plasticity face binding");
      }
    }
  }
  const bounds = value.boundsMm as { min: Vector3; max: Vector3 };
  if (bounds.min.some((minimum, axis) => minimum > bounds.max[axis]!)
    || (value.sharedSurfaceNodeCount as number) > (value.nodeCount as number)
    || (value.minimumSICNElementCentroidMm as Vector3).some((coordinate, axis) => coordinate < bounds.min[axis]! || coordinate > bounds.max[axis]!)) {
    throw new Error("Gmsh returned inconsistent mesh bounds or shared-node evidence");
  }
  const surfaceLoads = value.surfaceLoads.map((load: unknown) => {
    if (!isRecord(load) || typeof load.faceId !== "string" || !load.faceId || !isPositive(load.surfaceAreaMm2)
      || !isVector(load.tractionNPerMm2) || Math.hypot(...load.tractionNPerMm2) === 0
      || !isVector(load.resultantN) || !isVector(load.resultantMomentNmm) || !Number.isInteger(load.loadedNodeCount) || (load.loadedNodeCount as number) < 1
      || (load.loadedNodeCount as number) > (value.nodeCount as number)) {
      throw new Error("Gmsh returned an invalid surface-traction transfer summary");
    }
    return load as unknown as CalculiXMeshSummary["surfaceLoads"][number];
  });
  if (new Set(surfaceLoads.map((load) => load.faceId)).size !== surfaceLoads.length
    || (value.loadFile === null) !== (surfaceLoads.length === 0 && value.resultantLoads.length === 0)
    || surfaceLoads.some((load) => load.faceId && !nodeSets.some((nodeSet) => nodeSet.faceId === load.faceId))) {
    throw new Error("Gmsh returned an incomplete or duplicated surface load transfer");
  }
  const resultantLoads = value.resultantLoads.map((load: unknown) => {
    if (!isRecord(load) || typeof load.faceId !== "string" || !nodeSets.some((set) => set.faceId === load.faceId)
      || !isVector(load.forceN) || !isVector(load.applicationPointMm) || !isVector(load.momentNmm)
      || !isVector(load.appliedMomentAtOriginNmm)
      || (!load.forceN.some((component) => component !== 0) && !load.momentNmm.some((component) => component !== 0))) {
      throw new Error("Gmsh returned an invalid face force/moment transfer summary");
    }
    const expectedMoment = addVectors(cross(load.applicationPointMm, load.forceN), load.momentNmm);
    if (expectedMoment.some((component, axis) => Math.abs(component - load.appliedMomentAtOriginNmm[axis]!) > Math.max(1e-6, Math.abs(component) * 1e-9))) {
      throw new Error("Gmsh returned an inconsistent applied force moment");
    }
    return load as unknown as CalculiXMeshSummary["resultantLoads"][number];
  });
  if (new Set(resultantLoads.map((load) => load.faceId)).size !== resultantLoads.length) {
    throw new Error("Gmsh returned duplicate face force/moment transfers");
  }
  const expectedResultant = [0, 1, 2].map((axis) => surfaceLoads.reduce(
    (total, load) => total + load.tractionNPerMm2[axis]! * load.surfaceAreaMm2,
    resultantLoads.reduce((sum, load) => sum + load.forceN[axis]!, 0),
  ));
  if (expectedResultant.some((expected, axis) => Math.abs(expected - value.totalResultantN[axis]!) > Math.max(1e-6, Math.abs(expected) * 1e-9))) {
    throw new Error("Gmsh returned a total resultant inconsistent with its mapped face tractions");
  }
  const expectedMoment = [0, 1, 2].map((axis) => surfaceLoads.reduce((sum, load) => sum + load.resultantMomentNmm[axis]!,
    resultantLoads.reduce((total, load) => total + load.appliedMomentAtOriginNmm[axis]!, 0)));
  if (expectedMoment.some((expected, axis) => Math.abs(expected - value.totalResultantMomentNmm[axis]!) > Math.max(1e-6, Math.abs(expected) * 1e-9))) {
    throw new Error("Gmsh returned a total resultant moment inconsistent with its mapped face loads");
  }
  return value as unknown as CalculiXMeshSummary;
}

function cross(first: Vector3, second: Vector3): Vector3 {
  return [first[1] * second[2] - first[2] * second[1], first[2] * second[0] - first[0] * second[2], first[0] * second[1] - first[1] * second[0]];
}

function addVectors(first: Vector3, second: Vector3): Vector3 {
  return [first[0] + second[0], first[1] + second[1], first[2] + second[2]];
}

function validateRequest(stepPath: string, faces: NativePlanarFaceReference[], toleranceMm: number): object {
  if (!stepPath || ![".step", ".stp"].includes(stepPath.slice(stepPath.lastIndexOf(".")).toLowerCase())) {
    throw new Error("Face mapping requires a STEP file path");
  }
  if (!Array.isArray(faces) || faces.length < 1 || faces.length > 32) throw new Error("Select 1..32 native faces for mapping");
  if (!Number.isFinite(toleranceMm) || toleranceMm <= 0 || toleranceMm > 0.01) {
    throw new Error("Face mapping tolerance must be in (0, 0.01] mm");
  }
  const ids = new Set<string>();
  for (const face of faces) {
    if (!face.faceId || ids.has(face.faceId)) throw new Error("Native face IDs must be unique and nonempty");
    ids.add(face.faceId);
    if (face.surfaceType !== "Plane") throw new Error(`Native face ${face.faceId} is not planar`);
    if (![...face.centerMm, ...face.normal, ...face.boundsMm.min, ...face.boundsMm.max].every(Number.isFinite)) {
      throw new Error(`Native face ${face.faceId} contains non-finite geometry`);
    }
    if (Math.hypot(...face.normal) < 1e-12 || face.boundsMm.min.some((value, axis) => value > face.boundsMm.max[axis]!)) {
      throw new Error(`Native face ${face.faceId} has invalid normal or bounds`);
    }
  }
  return { stepPath: resolve(stepPath), faces, toleranceMm };
}

async function homebrewPackageRootForGmsh(): Promise<string> {
  const pathEntries = (process.env.PATH ?? "").split(delimiter);
  for (const entry of pathEntries) {
    const binary = join(entry, "gmsh");
    try {
      await access(binary, 0o1);
      const resolved = await realpath(binary);
      const packageRoot = dirname(dirname(resolved));
      await access(join(packageRoot, "lib", "gmsh.py"));
      return packageRoot;
    } catch {
      // Continue searching PATH for a Homebrew Gmsh install.
    }
  }
  throw new Error("Gmsh 4.15.x Homebrew Python API was not found; install Gmsh or set PLASTICITY_GMSH_PYTHON_PATH");
}

function runPython(
  helperPath: string,
  stepPath: string,
  request: object,
  pythonPath: string,
  gmshPythonPath: string,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    if (signal?.aborted) {
      reject(new Error("Gmsh face mapping was cancelled before start"));
      return;
    }
    const child = spawn(pythonPath, [helperPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONPATH: [gmshPythonPath, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
      },
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let timedOut = false;
    const terminate = () => {
      child.kill("SIGTERM");
      const forceKill = setTimeout(() => child.kill("SIGKILL"), 2_000);
      forceKill.unref();
    };
    const abort = () => terminate();
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => { timedOut = true; terminate(); }, MAPPING_TIMEOUT_MS);
    timeout.unref();
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > MAX_STDOUT_BYTES) child.kill("SIGTERM");
      else stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_BYTES); });
    child.once("error", (error) => { clearTimeout(timeout); signal?.removeEventListener("abort", abort); reject(error); });
    child.once("close", (code, terminationSignal) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(new Error("Gmsh face mapping was cancelled"));
      else if (timedOut) reject(new Error("Gmsh face mapping timed out"));
      else if (code !== 0) reject(new Error(`Gmsh face mapping failed (${terminationSignal ?? code}): ${stderr.slice(-4_000)}`));
      else resolveOutput(stdout);
    });
    child.stdin.end(JSON.stringify({ ...request, stepPath }));
  });
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVector(value: unknown): value is Vector3 {
  return Array.isArray(value) && value.length === 3 && value.every((component) => typeof component === "number" && Number.isFinite(component));
}

function isPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isFiniteUnitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1;
}

function isNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
