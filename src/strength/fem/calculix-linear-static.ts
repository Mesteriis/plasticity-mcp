import { spawn } from "node:child_process";
import { access, readFile, realpath, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { orthotropicElasticConstantsError, resolveOrthotropicOrientation, type OrthotropicCaseMaterial, type OrthotropicMaterialOrientation } from "./orthotropic-material.ts";
import { calculateOrthotropicTsaiWu, type OrthotropicTsaiWuStrengths } from "./orthotropic-tsai-wu.ts";
import { MAX_LAYERWISE_FEA_LAYERS } from "./layer-plane-plan.ts";

export interface OrthotropicTsaiWuCriterionInput {
  strengths: OrthotropicTsaiWuStrengths;
  interactions: { xy: number; xz: number; yz: number };
}

export interface LinearStaticCaseRequest {
  workspacePath: string;
  meshPath: string;
  jobName: string;
  youngsModulusMPa: number;
  poissonRatio: number;
  orthotropicMaterial?: OrthotropicCaseMaterial;
  layerwiseOrthotropicRegions?: Array<{ layerIndex: number; elsetName: string; orientation: OrthotropicMaterialOrientation }>;
  orthotropicTsaiWuCriterion?: OrthotropicTsaiWuCriterionInput;
  supports: Array<{ nodeSetName: string; axes: Array<1 | 2 | 3> }>;
  prescribedDisplacement?: { nodeSetName: string; axis: 1 | 2 | 3; valueMm: number };
  displacementObservation?: { nodeSetName: string; axis: 1 | 2 | 3 };
  loadIncludePath?: string;
  anchors: Array<{ nodeId: number; axis: 1 | 2 | 3; valueMm: number }>;
}

export interface LinearStaticCaseResult {
  solver: "CalculiX 2.20";
  elementFamily: "C3D4";
  stressCoordinateBasis: "global" | "material-local" | "layer-local";
  stressIntegrationPointCount: number;
  stressTensorComponentExtrema: Record<"sxx" | "syy" | "szz" | "sxy" | "sxz" | "syz", {
    minimumMPa: number;
    maximumMPa: number;
    minimumLocation: { elementId: number; integrationPoint: number; centroidMm: [number, number, number] };
    maximumLocation: { elementId: number; integrationPoint: number; centroidMm: [number, number, number] };
  }>;
  orthotropicTsaiWu?: {
    maximumFailureIndex: number;
    maximumFailureIndexLocation: { elementId: number; integrationPoint: number; centroidMm: [number, number, number] };
    minimumLoadFactorToIndexOne: number | null;
    minimumLoadFactorLocation: { elementId: number; integrationPoint: number; centroidMm: [number, number, number] } | null;
  };
  minimumSxxMPa: number;
  maximumSxxMPa: number;
  maximumVonMisesMPa: number;
  maximumVonMisesLocation: {
    elementId: number;
    integrationPoint: number;
    centroidMm: [number, number, number];
  };
  maximumPrincipalStressMPa: number;
  maximumPrincipalStressLocation: { elementId: number; integrationPoint: number; centroidMm: [number, number, number] };
  minimumPrincipalStressMPa: number;
  minimumPrincipalStressLocation: { elementId: number; integrationPoint: number; centroidMm: [number, number, number] };
  prescribedDisplacementMm: number | null;
  displacementObservationNodeSetName: string;
  displacementObservationAxis: 1 | 2 | 3;
  maximumDisplacementOnSetMm: number;
  supportReactionN: [number, number, number];
  supportReactionMomentNmm: [number, number, number];
  supportReactionsByNodeSet: Array<{
    nodeSetName: string;
    forceN: [number, number, number];
    momentNmm: [number, number, number];
  }>;
  jobName: string;
  inputPath: string;
  reportPath: string;
}

const SOLVER_IMAGE = "plasticity-mcp-calculix:2.20";
const MAX_OUTPUT_BYTES = 1024 * 1024;
const SOLVER_TIMEOUT_MS = 120_000;

export async function runLinearStaticCase(
  request: LinearStaticCaseRequest,
  signal?: AbortSignal,
): Promise<LinearStaticCaseResult> {
  validateRequest(request);
  const workspace = await realpath(request.workspacePath);
  const meshPath = await realpath(request.meshPath);
  const meshRelative = relative(workspace, meshPath);
  if (!meshRelative || meshRelative.startsWith(`..${sep}`) || meshRelative === ".." || meshRelative.startsWith(sep)) {
    throw new Error("CalculiX mesh input must be inside its dedicated workspace");
  }
  const mesh = await readFile(meshPath, "utf8");
  const observation = request.displacementObservation ?? request.prescribedDisplacement;
  if (!observation) throw new Error("A displacement observation node set is required");
  if (!mesh.startsWith("*NODE\n") || !mesh.includes("*ELEMENT, TYPE=C3D4, ELSET=SOLID\n")
    || (request.layerwiseOrthotropicRegions ?? []).some(({ elsetName }) => !mesh.includes(`*ELSET, ELSET=${elsetName}\n`))
    || request.supports.some((support) => !mesh.includes(`*NSET, NSET=${support.nodeSetName}\n`))
    || !mesh.includes(`*NSET, NSET=${observation.nodeSetName}\n`)
    || (request.prescribedDisplacement && !mesh.includes(`*NSET, NSET=${request.prescribedDisplacement.nodeSetName}\n`))) {
    throw new Error("Mesh fragment is missing its native tetrahedra or requested boundary node sets");
  }
  let loadRelative: string | undefined;
  if (request.loadIncludePath) {
    const loadPath = await realpath(request.loadIncludePath);
    loadRelative = relative(workspace, loadPath);
    if (!loadRelative || loadRelative.startsWith(`..${sep}`) || loadRelative === ".." || loadRelative.startsWith(sep)) {
      throw new Error("CalculiX load input must be inside its dedicated workspace");
    }
    const loadText = await readFile(loadPath, "utf8");
    if (!loadText.startsWith("*CLOAD\n") || !/^\d+, [123], [-+0-9.Ee]+$/m.test(loadText)) {
      throw new Error("CalculiX load include is missing nodal CLOAD data");
    }
  }
  const inputPath = resolve(workspace, `${request.jobName}.inp`);
  const reportPath = resolve(workspace, `${request.jobName}.dat`);
  await access(inputPath).then(() => { throw new Error("CalculiX job input already exists; refusing overwrite"); }, () => undefined);
  await access(reportPath).then(() => { throw new Error("CalculiX report already exists; refusing overwrite"); }, () => undefined);
  const deck = renderCalculixDeck(request, meshRelative, loadRelative, observation);
  await writeFile(inputPath, deck, { flag: "wx", mode: 0o600 });
  await runContainer(workspace, request.jobName, signal);
  const report = await readFile(reportPath, "utf8");
  return parseCalculixReport(report, request, inputPath, reportPath, mesh);
}

export function parseCalculixReport(
  report: string,
  request: Pick<LinearStaticCaseRequest, "jobName" | "prescribedDisplacement" | "displacementObservation" | "supports" | "orthotropicMaterial" | "layerwiseOrthotropicRegions" | "orthotropicTsaiWuCriterion">,
  inputPath: string,
  reportPath: string,
  meshText: string,
): LinearStaticCaseResult {
  const stressHeader = report.indexOf("stresses (elem, integ.pnt.,sxx,syy,szz,sxy,sxz,syz)");
  const forceHeader = report.indexOf("forces (fx,fy,fz)");
  const displacementHeader = report.indexOf("displacements (vx,vy,vz)");
  if (stressHeader < 0 || forceHeader <= stressHeader || displacementHeader <= forceHeader) {
    throw new Error("CalculiX report is missing stress, support-reaction or displacement output sections");
  }
  const stressLines = report.slice(stressHeader, forceHeader).split(/\r?\n/).slice(1);
  const stresses: Array<{
    elementId: number;
    integrationPoint: number;
    tensor: [number, number, number, number, number, number];
    vonMisesMPa: number;
    principalStressMPa: [number, number, number];
  }> = [];
  for (const line of stressLines) {
    const values = numericStressRow(line);
    if (values.length >= 8) {
      const elementId = values[0]!;
      const integrationPoint = values[1]!;
      if (!Number.isSafeInteger(elementId) || elementId <= 0 || !Number.isSafeInteger(integrationPoint) || integrationPoint <= 0) {
        throw new Error("CalculiX integration-point stress has an invalid element or integration-point ID");
      }
      const tensor = values.slice(2, 8) as [number, number, number, number, number, number];
      stresses.push({ elementId, integrationPoint, tensor, vonMisesMPa: vonMises(tensor), principalStressMPa: principalStressEigenvalues(tensor) });
    }
  }
  if (stresses.length === 0) throw new Error("CalculiX report contains no integration-point stresses");
  const supportForcesBySet = new Map<string, Array<{ nodeId: number; force: [number, number, number] }>>();
  const forceLines = report.slice(forceHeader, displacementHeader).split(/\r?\n/);
  let activeSupportSet: string | undefined;
  for (const line of forceLines) {
    const section = /^forces\s*\(fx,fy,fz\)\s+for set\s+(.+?)\s+and time\b/i.exec(line.trim());
    if (section) {
      activeSupportSet = section[1]!.trim().toUpperCase();
      if (!request.supports.some((support) => support.nodeSetName.toUpperCase() === activeSupportSet)) {
        throw new Error(`CalculiX report contains reactions for unexpected node set ${section[1]}`);
      }
      if (supportForcesBySet.has(activeSupportSet)) throw new Error(`CalculiX report repeats support reaction output for node set ${section[1]}`);
      supportForcesBySet.set(activeSupportSet, []);
      continue;
    }
    const values = numericRow(line);
    if (values.length >= 4 && activeSupportSet) {
      if (!Number.isSafeInteger(values[0]) || values[0]! <= 0) throw new Error("CalculiX support reaction has an invalid node ID");
      supportForcesBySet.get(activeSupportSet)!.push({ nodeId: values[0]!, force: values.slice(1, 4) as [number, number, number] });
    }
  }
  const missingSupport = request.supports.find((support) => !supportForcesBySet.get(support.nodeSetName.toUpperCase())?.length);
  if (missingSupport) throw new Error(`CalculiX report contains no support reaction forces for node set ${missingSupport.nodeSetName}`);
  const supportForces = [...supportForcesBySet.values()].flat();
  if (supportForces.length === 0) throw new Error("CalculiX report contains no support reaction forces");
  const displacementLines = report.slice(displacementHeader).split(/\r?\n/).slice(1);
  const displacements: Array<[number, number, number]> = [];
  for (const line of displacementLines) {
    const values = numericRow(line);
    if (values.length >= 4) displacements.push(values.slice(1, 4) as [number, number, number]);
  }
  if (displacements.length === 0) throw new Error("CalculiX report contains no nodal displacement output");
  const maximumStress = stresses.reduce((maximum, stress) => stress.vonMisesMPa > maximum.vonMisesMPa ? stress : maximum);
  const maximumPrincipalStress = stresses.reduce((maximum, stress) => stress.principalStressMPa[2] > maximum.principalStressMPa[2] ? stress : maximum);
  const minimumPrincipalStress = stresses.reduce((minimum, stress) => stress.principalStressMPa[0] < minimum.principalStressMPa[0] ? stress : minimum);
  const maximumVonMisesMPa = maximumStress.vonMisesMPa;
  const observation = request.displacementObservation ?? request.prescribedDisplacement;
  if (!observation) throw new Error("A displacement observation node set is required to parse CalculiX output");
  const axialIndex = observation.axis - 1;
  const maximumDisplacementOnSetMm = displacements.reduce((maximum, vector) => Math.max(maximum, Math.abs(vector[axialIndex]!)), 0);
  const nodeCoordinates = parseMeshNodeCoordinates(meshText);
  const elementNodes = parseMeshTetrahedra(meshText, nodeCoordinates);
  const missingStressElement = stresses.find((stress) => !elementNodes.has(stress.elementId));
  if (missingStressElement) throw new Error(`CalculiX stress element ${missingStressElement.elementId} is missing from the mesh`);
  const stressLocation = (stress: typeof maximumStress) => {
    const element = elementNodes.get(stress.elementId);
    if (!element) throw new Error(`CalculiX stress element ${stress.elementId} is missing from the mesh`);
    const centroidMm = element.reduce<[number, number, number]>((centroid, nodeId) => {
      const coordinate = nodeCoordinates.get(nodeId);
      if (!coordinate) throw new Error(`CalculiX element ${stress.elementId} references missing mesh node ${nodeId}`);
      return [centroid[0] + coordinate[0] / 4, centroid[1] + coordinate[1] / 4, centroid[2] + coordinate[2] / 4];
    }, [0, 0, 0]);
    return { elementId: stress.elementId, integrationPoint: stress.integrationPoint, centroidMm };
  };
  let orthotropicTsaiWu: LinearStaticCaseResult["orthotropicTsaiWu"];
  if (request.orthotropicTsaiWuCriterion) {
    if (!request.orthotropicMaterial) throw new Error("The Tsai-Wu criterion requires material-local orthotropic stress output");
    const points = stresses.map((stress) => calculateOrthotropicTsaiWu({
      ...request.orthotropicTsaiWuCriterion!,
      stressTensorMPa: stress.tensor,
      location: stressLocation(stress),
    }));
    const maximumFailure = points.reduce((maximum, point) => point.failureIndex > maximum.failureIndex ? point : maximum);
    const reserveFactors = points.filter((point) => point.loadFactorToIndexOne !== null);
    const minimumReserve = reserveFactors.length
      ? reserveFactors.reduce((minimum, point) => point.loadFactorToIndexOne! < minimum.loadFactorToIndexOne! ? point : minimum)
      : null;
    orthotropicTsaiWu = {
      maximumFailureIndex: maximumFailure.failureIndex,
      maximumFailureIndexLocation: maximumFailure.location,
      minimumLoadFactorToIndexOne: minimumReserve?.loadFactorToIndexOne ?? null,
      minimumLoadFactorLocation: minimumReserve?.location ?? null,
    };
  }
  const componentNames = ["sxx", "syy", "szz", "sxy", "sxz", "syz"] as const;
  const stressTensorComponentExtrema = Object.fromEntries(componentNames.map((name, componentIndex) => {
    const minimum = stresses.reduce((current, stress) => stress.tensor[componentIndex]! < current.tensor[componentIndex]! ? stress : current);
    const maximum = stresses.reduce((current, stress) => stress.tensor[componentIndex]! > current.tensor[componentIndex]! ? stress : current);
    return [name, {
      minimumMPa: minimum.tensor[componentIndex]!,
      maximumMPa: maximum.tensor[componentIndex]!,
      minimumLocation: stressLocation(minimum),
      maximumLocation: stressLocation(maximum),
    }];
  })) as LinearStaticCaseResult["stressTensorComponentExtrema"];
  const supportReactionN = supportForces.reduce<[number, number, number]>((sum, row) => [sum[0] + row.force[0], sum[1] + row.force[1], sum[2] + row.force[2]], [0, 0, 0]);
  const supportReactionMomentNmm = supportForces.reduce<[number, number, number]>((sum, row) => {
    const point = nodeCoordinates.get(row.nodeId);
    if (!point) throw new Error(`CalculiX support reaction node ${row.nodeId} is missing from the mesh`);
    const moment = cross(point, row.force);
    return [sum[0] + moment[0], sum[1] + moment[1], sum[2] + moment[2]];
  }, [0, 0, 0]);
  const supportReactionsByNodeSet = request.supports.map((support) => {
    const rows = supportForcesBySet.get(support.nodeSetName.toUpperCase())!;
    return {
      nodeSetName: support.nodeSetName,
      forceN: rows.reduce<[number, number, number]>((sum, row) => [sum[0] + row.force[0], sum[1] + row.force[1], sum[2] + row.force[2]], [0, 0, 0]),
      momentNmm: rows.reduce<[number, number, number]>((sum, row) => {
        const point = nodeCoordinates.get(row.nodeId);
        if (!point) throw new Error(`CalculiX support reaction node ${row.nodeId} is missing from the mesh`);
        const moment = cross(point, row.force);
        return [sum[0] + moment[0], sum[1] + moment[1], sum[2] + moment[2]];
      }, [0, 0, 0]),
    };
  });
  return {
    solver: "CalculiX 2.20",
    elementFamily: "C3D4",
    stressCoordinateBasis: request.layerwiseOrthotropicRegions
      ? "layer-local"
      : request.orthotropicMaterial ? "material-local" : "global",
    stressIntegrationPointCount: stresses.length,
    stressTensorComponentExtrema,
    ...(orthotropicTsaiWu ? { orthotropicTsaiWu } : {}),
    minimumSxxMPa: stresses.reduce((minimum, stress) => Math.min(minimum, stress.tensor[0]!), Number.POSITIVE_INFINITY),
    maximumSxxMPa: stresses.reduce((maximum, stress) => Math.max(maximum, stress.tensor[0]!), Number.NEGATIVE_INFINITY),
    maximumVonMisesMPa,
    maximumVonMisesLocation: stressLocation(maximumStress),
    maximumPrincipalStressMPa: maximumPrincipalStress.principalStressMPa[2],
    maximumPrincipalStressLocation: stressLocation(maximumPrincipalStress),
    minimumPrincipalStressMPa: minimumPrincipalStress.principalStressMPa[0],
    minimumPrincipalStressLocation: stressLocation(minimumPrincipalStress),
    prescribedDisplacementMm: request.prescribedDisplacement?.valueMm ?? null,
    displacementObservationNodeSetName: observation.nodeSetName,
    displacementObservationAxis: observation.axis,
    maximumDisplacementOnSetMm,
    supportReactionN,
    supportReactionMomentNmm,
    supportReactionsByNodeSet,
    jobName: request.jobName,
    inputPath,
    reportPath,
  };
}

function parseMeshTetrahedra(mesh: string, nodeCoordinates: Map<number, [number, number, number]>): Map<number, [number, number, number, number]> {
  const elements = new Map<number, [number, number, number, number]>();
  let readingElements = false;
  for (const line of mesh.split(/\r?\n/)) {
    if (line.startsWith("*")) {
      readingElements = /^\*ELEMENT,\s*TYPE=C3D4,\s*ELSET=SOLID\s*$/i.test(line);
      continue;
    }
    if (!readingElements || !line.trim()) continue;
    const fields = line.split(",").map((field) => Number(field.trim()));
    const [elementId, ...nodeIds] = fields;
    if (fields.length !== 5 || !Number.isSafeInteger(elementId) || elementId! <= 0
      || nodeIds.some((nodeId) => !Number.isSafeInteger(nodeId) || nodeId <= 0)
      || new Set(nodeIds).size !== 4 || elements.has(elementId!)) {
      throw new Error("CalculiX C3D4 mesh contains an invalid or duplicate element");
    }
    for (const nodeId of nodeIds) {
      if (!nodeCoordinates.has(nodeId!)) throw new Error(`CalculiX element ${elementId} references missing mesh node ${nodeId}`);
    }
    elements.set(elementId!, nodeIds as [number, number, number, number]);
  }
  if (elements.size === 0) throw new Error("CalculiX mesh contains no C3D4 elements for stress location mapping");
  return elements;
}

function parseMeshNodeCoordinates(mesh: string): Map<number, [number, number, number]> {
  const coordinates = new Map<number, [number, number, number]>();
  let readingNodes = false;
  for (const line of mesh.split(/\r?\n/)) {
    if (line.startsWith("*")) {
      readingNodes = /^\*NODE(?:\s|$)/i.test(line);
      continue;
    }
    if (!readingNodes || !line.trim()) continue;
    const fields = line.split(",").map((field) => field.trim());
    if (fields.length < 4) continue;
    const [nodeId, x, y, z] = fields.map(Number);
    if (!Number.isSafeInteger(nodeId) || nodeId! <= 0 || ![x, y, z].every(Number.isFinite) || coordinates.has(nodeId!)) {
      throw new Error("CalculiX mesh contains invalid or duplicate node coordinates");
    }
    coordinates.set(nodeId!, [x!, y!, z!]);
  }
  if (coordinates.size === 0) throw new Error("CalculiX mesh contains no node coordinates for support moment calculation");
  return coordinates;
}

function cross(first: [number, number, number], second: [number, number, number]): [number, number, number] {
  return [first[1] * second[2] - first[2] * second[1], first[2] * second[0] - first[0] * second[2], first[0] * second[1] - first[1] * second[0]];
}

export function renderCalculixDeck(
  request: LinearStaticCaseRequest,
  meshRelative: string,
  loadRelative: string | undefined,
  observation: { nodeSetName: string; axis: 1 | 2 | 3 },
): string {
  const orthotropic = request.orthotropicMaterial;
  const layerwiseRegions = request.layerwiseOrthotropicRegions;
  const orientation = orthotropic && !layerwiseRegions ? resolveOrthotropicOrientation(orthotropic.orientation) : undefined;
  const layerOrientations = layerwiseRegions?.map((region) => ({
    name: `${region.elsetName}_AXES`,
    orientation: resolveOrthotropicOrientation(region.orientation),
  }));
  const lines = [
    "*HEADING",
    "Plasticity MCP verified linear static displacement case",
    `*INCLUDE, INPUT=${meshRelative}`,
    ...(orientation ? [
      "*ORIENTATION, NAME=PLASTICITY_MATERIAL_AXES, SYSTEM=RECTANGULAR",
      [...orientation.calculixPointA, ...orientation.calculixPointB].join(", "),
    ] : []),
    ...(layerOrientations?.flatMap(({ name, orientation: frame }) => [
      `*ORIENTATION, NAME=${name}, SYSTEM=RECTANGULAR`,
      [...frame.calculixPointA, ...frame.calculixPointB].join(", "),
    ]) ?? []),
    "*MATERIAL, NAME=PLASTICITY_MATERIAL",
    ...(orthotropic ? [
      "*ELASTIC, TYPE=ENGINEERING CONSTANTS",
      `${request.youngsModulusMPa}, ${orthotropic.youngsModulus2MPa}, ${orthotropic.youngsModulus3MPa}, ${request.poissonRatio}, ${orthotropic.poissonRatio13}, ${orthotropic.poissonRatio23}, ${orthotropic.shearModulus12MPa}, ${orthotropic.shearModulus13MPa}`,
      `${orthotropic.shearModulus23MPa}`,
    ] : ["*ELASTIC", `${request.youngsModulusMPa}, ${request.poissonRatio}`]),
    ...(layerOrientations
      ? layerOrientations.map(({ name }, index) => `*SOLID SECTION, ELSET=${layerwiseRegions![index]!.elsetName}, MATERIAL=PLASTICITY_MATERIAL, ORIENTATION=${name}`)
      : [`*SOLID SECTION, ELSET=SOLID, MATERIAL=PLASTICITY_MATERIAL${orientation ? ", ORIENTATION=PLASTICITY_MATERIAL_AXES" : ""}`]),
    "*STEP",
    "*STATIC",
    "*BOUNDARY",
    ...request.supports.flatMap((support) => support.axes.map((axis) => `${support.nodeSetName}, ${axis}, ${axis}, 0.`)),
    ...request.anchors.map((anchor) => `${anchor.nodeId}, ${anchor.axis}, ${anchor.axis}, ${anchor.valueMm}`),
    ...(request.prescribedDisplacement
      ? [`${request.prescribedDisplacement.nodeSetName}, ${request.prescribedDisplacement.axis}, ${request.prescribedDisplacement.axis}, ${request.prescribedDisplacement.valueMm}`]
      : []),
    ...(loadRelative ? [`*INCLUDE, INPUT=${loadRelative}`] : []),
    "*EL PRINT, ELSET=SOLID",
    "S",
    ...request.supports.flatMap((support) => [`*NODE PRINT, NSET=${support.nodeSetName}`, "RF"]),
    `*NODE PRINT, NSET=${observation.nodeSetName}`,
    "U",
    "*END STEP",
    "",
  ];
  return lines.join("\n");
}

function validateRequest(request: LinearStaticCaseRequest): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(request.jobName)) throw new Error("CalculiX job name is invalid");
  if (!Number.isFinite(request.youngsModulusMPa) || request.youngsModulusMPa <= 0 || !Number.isFinite(request.poissonRatio)) {
    throw new Error("Linear elastic material properties are invalid");
  }
  if (request.orthotropicMaterial) {
    const material = request.orthotropicMaterial;
    const error = orthotropicElasticConstantsError({
      youngsModulusMPa: request.youngsModulusMPa,
      youngsModulus2MPa: material.youngsModulus2MPa,
      youngsModulus3MPa: material.youngsModulus3MPa,
      poissonRatio12: request.poissonRatio,
      poissonRatio13: material.poissonRatio13,
      poissonRatio23: material.poissonRatio23,
      shearModulus12MPa: material.shearModulus12MPa,
      shearModulus13MPa: material.shearModulus13MPa,
      shearModulus23MPa: material.shearModulus23MPa,
    });
    if (error) throw new Error(error);
    if (request.layerwiseOrthotropicRegions) {
      validateLayerwiseRegions(request.layerwiseOrthotropicRegions);
      const frames = request.layerwiseOrthotropicRegions.map((region) => resolveOrthotropicOrientation(region.orientation));
      if (frames.some((frame) => Math.abs(frame.axis3Global.reduce((sum, value, axis) => sum + value * frames[0]!.axis3Global[axis]!, 0)) < 1 - 1e-6)) {
        throw new Error("All layerwise material frames must use the same confirmed build axis");
      }
    } else resolveOrthotropicOrientation(material.orientation);
  } else if (request.poissonRatio <= -1 || request.poissonRatio >= 0.5) {
    throw new Error("Linear isotropic Poisson ratio must be greater than -1 and less than 0.5");
  }
  if (!request.orthotropicMaterial && request.layerwiseOrthotropicRegions) {
    throw new Error("Layerwise material frames require one measured orthotropic material tensor");
  }
  if (request.orthotropicTsaiWuCriterion && !request.orthotropicMaterial) {
    throw new Error("The Tsai-Wu criterion requires an orthotropic material model");
  }
  const observation = request.displacementObservation ?? request.prescribedDisplacement;
  if (!Array.isArray(request.supports) || request.supports.length < 1 || request.supports.length > 8) {
    throw new Error("Static FEA requires 1..8 explicit support faces");
  }
  const supportSetNames = request.supports.map((support) => support.nodeSetName);
  if (new Set(supportSetNames).size !== supportSetNames.length) throw new Error("Support node-set names must be unique");
  if (request.supports.some((support) => !/^[A-Z][A-Z0-9_]{0,63}$/.test(support.nodeSetName)
    || !Array.isArray(support.axes) || support.axes.length < 1 || new Set(support.axes).size !== support.axes.length
    || support.axes.some((axis) => ![1, 2, 3].includes(axis)))
    || !observation || !/^[A-Z][A-Z0-9_]{0,63}$/.test(observation.nodeSetName)
    || (request.prescribedDisplacement && !/^[A-Z][A-Z0-9_]{0,63}$/.test(request.prescribedDisplacement.nodeSetName))) {
    throw new Error("CalculiX boundary node-set name is invalid");
  }
  if (supportSetNames.includes(observation.nodeSetName)) throw new Error("Support and displacement observation node sets must be distinct");
  if (request.prescribedDisplacement && supportSetNames.includes(request.prescribedDisplacement.nodeSetName)) {
    throw new Error("Support and displacement node sets must be distinct");
  }
  if (![1, 2, 3].includes(observation.axis)
    || (request.prescribedDisplacement && (![1, 2, 3].includes(request.prescribedDisplacement.axis)
      || !Number.isFinite(request.prescribedDisplacement.valueMm)))) throw new Error("Boundary displacement data is invalid");
  if (!request.prescribedDisplacement && !request.loadIncludePath) throw new Error("A static case requires an explicit prescribed displacement or load include");
  if (!Array.isArray(request.anchors) || request.anchors.length > 16) throw new Error("Anchor constraints must contain at most 16 entries");
  for (const anchor of request.anchors) {
    if (!Number.isSafeInteger(anchor.nodeId) || anchor.nodeId <= 0 || ![1, 2, 3].includes(anchor.axis) || !Number.isFinite(anchor.valueMm)) {
      throw new Error("Anchor node constraint is invalid");
    }
  }
}

function validateLayerwiseRegions(regions: NonNullable<LinearStaticCaseRequest["layerwiseOrthotropicRegions"]>): void {
  if (!Array.isArray(regions) || regions.length < 2 || regions.length > MAX_LAYERWISE_FEA_LAYERS) {
    throw new Error(`Layerwise orthotropic analysis requires 2..${MAX_LAYERWISE_FEA_LAYERS} ordered element regions`);
  }
  const names = regions.map(({ elsetName, layerIndex }, index) => {
    if (layerIndex !== index + 1) throw new Error("Layerwise orthotropic regions must include every layer in ascending order");
    return elsetName;
  });
  if (names.some((name) => !/^[A-Z][A-Z0-9_]{0,60}$/.test(name) || name === "SOLID" || name.endsWith("_AXES"))
    || new Set(names).size !== names.length) {
    throw new Error("Layerwise orthotropic element-set names must be unique safe CalculiX identifiers");
  }
}

async function runContainer(workspace: string, jobName: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("CalculiX job was cancelled before start");
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
  await new Promise<void>((resolveJob, reject) => {
    const child = spawn("docker", [
      "run", "--rm", "--network=none", "--memory=1g", "--cpus=2", "--pids-limit=64", "--read-only",
      "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=64m",
      "--mount", `type=bind,src=${workspace},dst=/work`,
      "--workdir", "/work", "--user", `${uid}:${gid}`, SOLVER_IMAGE, "-i", jobName,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const terminate = () => {
      child.kill("SIGTERM");
      const forceKill = setTimeout(() => child.kill("SIGKILL"), 2_000);
      forceKill.unref();
    };
    const abort = () => terminate();
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => { timedOut = true; terminate(); }, SOLVER_TIMEOUT_MS);
    timeout.unref();
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-MAX_OUTPUT_BYTES); });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-MAX_OUTPUT_BYTES); });
    child.once("error", (error) => { clearTimeout(timeout); signal?.removeEventListener("abort", abort); reject(error); });
    child.once("close", (code, terminationSignal) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(new Error("CalculiX job was cancelled"));
      else if (timedOut) reject(new Error("CalculiX job timed out"));
      else if (code === 0 && stdout.includes("Job finished")) resolveJob();
      else reject(new Error(`CalculiX job failed (${terminationSignal ?? code}): ${stderr.slice(-4_000)}${stdout.slice(-4_000)}`));
    });
  });
}

function numericRow(line: string): number[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  const parts = trimmed.split(/\s+/);
  if (parts.some((part) => !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/.test(part))) return [];
  const values = parts.map(Number);
  return values.every(Number.isFinite) ? values : [];
}

function numericStressRow(line: string): number[] {
  const fields = line.trim().split(/\s+/);
  if (fields.length < 8) return [];
  const values = fields.slice(0, 8).map(Number);
  if (!values.every(Number.isFinite)) return [];
  const materialLabel = fields.slice(8);
  if (materialLabel.length > 1 || (materialLabel.length === 1 && !/^[A-Z][A-Z0-9_]*$/i.test(materialLabel[0]!))) {
    throw new Error("CalculiX integration-point stress has an invalid material label");
  }
  return values;
}

export function principalStressEigenvalues([xx, yy, zz, xy, xz, yz]: [number, number, number, number, number, number]): [number, number, number] {
  if (![xx, yy, zz, xy, xz, yz].every(Number.isFinite)) throw new Error("Stress tensor must contain six finite values");
  const mean = (xx + yy + zz) / 3;
  const a = xx - mean;
  const b = yy - mean;
  const c = zz - mean;
  const pSquared = (a * a + b * b + c * c + 2 * (xy * xy + xz * xz + yz * yz)) / 6;
  if (pSquared === 0) return [mean, mean, mean];
  const p = Math.sqrt(pSquared);
  const determinant = a * b * c + 2 * xy * xz * yz - a * yz * yz - b * xz * xz - c * xy * xy;
  const normalizedDeterminant = Math.max(-1, Math.min(1, determinant / (2 * p * p * p)));
  if (normalizedDeterminant >= 1 - 1e-14) return [mean - p, mean - p, mean + 2 * p];
  if (normalizedDeterminant <= -1 + 1e-14) return [mean - 2 * p, mean + p, mean + p];
  const angle = Math.acos(normalizedDeterminant) / 3;
  const largest = mean + 2 * p * Math.cos(angle);
  const smallest = mean + 2 * p * Math.cos(angle + 2 * Math.PI / 3);
  const middle = 3 * mean - largest - smallest;
  return [smallest, middle, largest].sort((left, right) => left - right) as [number, number, number];
}

function vonMises([xx, yy, zz, xy, xz, yz]: [number, number, number, number, number, number]): number {
  return Math.sqrt(0.5 * ((xx - yy) ** 2 + (yy - zz) ** 2 + (zz - xx) ** 2) + 3 * (xy ** 2 + xz ** 2 + yz ** 2));
}
