type ElasticMaterial = { youngsModulusMPa: number; poissonRatio: number };

export interface CohesiveMeshResolutionAssessment {
  maximumCohesiveEdgeMm: number;
  recommendedElementsAcrossZone: 5;
  materialEstimates: Array<{
    material: "A" | "B";
    indicativeProcessZoneLengthMm: number;
    estimatedElementsAcrossZone: number;
  }>;
  status: "meets-indicative-five-element-screen" | "below-indicative-five-element-screen";
  interpretation: string;
}

const INTERFACE_COINCIDENCE_TOLERANCE_MM = 1e-8;

export function assessCohesiveMeshResolution(
  meshText: string,
  materials: { materialA: ElasticMaterial; materialB: ElasticMaterial },
  cohesiveLaw: { peakTractionMPa: number; fractureEnergyNPerMm: number },
): CohesiveMeshResolutionAssessment {
  validateMaterial("material A", materials.materialA);
  validateMaterial("material B", materials.materialB);
  if (!Number.isFinite(cohesiveLaw.peakTractionMPa) || cohesiveLaw.peakTractionMPa <= 0) {
    throw new Error("Cohesive peak traction must be positive");
  }
  if (!Number.isFinite(cohesiveLaw.fractureEnergyNPerMm) || cohesiveLaw.fractureEnergyNPerMm <= 0) {
    throw new Error("Cohesive fracture energy must be positive");
  }

  const sections = readMsh22Sections(meshText);
  const nodes = readNodes(sections.nodes);
  const maximumCohesiveEdgeMm = readPenta6MaximumEdge(sections.elements, nodes);
  const materialEstimates = ([
    ["A", materials.materialA],
    ["B", materials.materialB],
  ] as const).map(([material, properties]) => {
    const indicativeProcessZoneLengthMm = properties.youngsModulusMPa
      / (1 - properties.poissonRatio ** 2)
      * cohesiveLaw.fractureEnergyNPerMm
      / cohesiveLaw.peakTractionMPa ** 2;
    return {
      material,
      indicativeProcessZoneLengthMm,
      estimatedElementsAcrossZone: indicativeProcessZoneLengthMm / maximumCohesiveEdgeMm,
    };
  });
  const status = materialEstimates.every((estimate) => estimate.estimatedElementsAcrossZone >= 5)
    ? "meets-indicative-five-element-screen"
    : "below-indicative-five-element-screen";

  return {
    maximumCohesiveEdgeMm,
    recommendedElementsAcrossZone: 5,
    materialEstimates,
    status,
    interpretation: "Indicative screening estimate only, based on each adjoining isotropic material separately; it is not a bimaterial process-zone solution or proof of mesh convergence, calibrated strength, or print suitability.",
  };
}

function validateMaterial(label: string, material: ElasticMaterial): void {
  if (!Number.isFinite(material.youngsModulusMPa) || material.youngsModulusMPa <= 0
    || !Number.isFinite(material.poissonRatio) || material.poissonRatio <= -1 || material.poissonRatio >= 0.5) {
    throw new Error(`${label} elastic constants are outside the supported isotropic range`);
  }
}

function readMsh22Sections(text: string): { nodes: string[]; elements: string[] } {
  const lines = text.split(/\r?\n/);
  const formatStart = lines.indexOf("$MeshFormat");
  if (formatStart < 0 || lines[formatStart + 1]?.trim() !== "2.2 0 8" || lines[formatStart + 2] !== "$EndMeshFormat") {
    throw new Error("Cohesive mesh must use ASCII Gmsh MSH 2.2 with 8-byte coordinates");
  }
  return {
    nodes: readSection(lines, "Nodes"),
    elements: readSection(lines, "Elements"),
  };
}

function readSection(lines: string[], name: "Nodes" | "Elements"): string[] {
  const start = lines.indexOf(`$${name}`);
  const end = lines.indexOf(`$End${name}`, start + 1);
  if (start < 0 || end <= start + 1) throw new Error(`Cohesive mesh is missing its Gmsh ${name} section`);
  const rows = lines.slice(start + 1, end);
  const count = Number(rows[0]);
  if (!Number.isSafeInteger(count) || count < 1 || rows.length !== count + 1) {
    throw new Error(`Cohesive mesh has an invalid Gmsh ${name} count`);
  }
  return rows.slice(1);
}

function readNodes(lines: string[]): Map<number, [number, number, number]> {
  const nodes = new Map<number, [number, number, number]>();
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    const id = Number(fields[0]);
    const coordinates = fields.slice(1).map(Number);
    if (fields.length !== 4 || !Number.isSafeInteger(id) || id <= 0 || nodes.has(id)
      || coordinates.length !== 3 || coordinates.some((value) => !Number.isFinite(value))) {
      throw new Error("Cohesive mesh contains an invalid or duplicate node ID/coordinate");
    }
    nodes.set(id, coordinates as [number, number, number]);
  }
  return nodes;
}

function readPenta6MaximumEdge(elements: string[], nodes: Map<number, [number, number, number]>): number {
  const faceEdges = [[0, 1], [1, 2], [2, 0], [3, 4], [4, 5], [5, 3]] as const;
  let maximumEdgeMm = 0;
  let elementCount = 0;
  for (const line of elements) {
    const fields = line.trim().split(/\s+/);
    if (fields[1] !== "6") continue;
    const elementId = Number(fields[0]);
    const tagCount = Number(fields[2]);
    const firstNodeIndex = 3 + tagCount;
    if (!Number.isSafeInteger(elementId) || elementId <= 0 || !Number.isSafeInteger(tagCount) || tagCount < 0
      || fields.length !== firstNodeIndex + 6) {
      throw new Error("Cohesive mesh contains an invalid PENTA6 element");
    }
    const nodeIds = fields.slice(firstNodeIndex).map(Number);
    const faceNodes = nodeIds.map((id) => nodes.get(id));
    if (nodeIds.some((id) => !Number.isSafeInteger(id) || id <= 0) || faceNodes.some((node) => node === undefined)) {
      throw new Error(`PENTA6 element ${elementId} references an unknown node`);
    }
    const coordinates = faceNodes as [number, number, number][];
    for (let index = 0; index < 3; index += 1) {
      if (distance(coordinates[index]!, coordinates[index + 3]!) > INTERFACE_COINCIDENCE_TOLERANCE_MM) {
        throw new Error(`PENTA6 element ${elementId} has non-coincident duplicated interface nodes`);
      }
    }
    const edgeLengths = faceEdges.map(([a, b]) => distance(coordinates[a]!, coordinates[b]!));
    const elementMaximum = Math.max(...edgeLengths);
    const [a, b, c] = coordinates;
    const twiceArea = norm(cross(subtract(b!, a!), subtract(c!, a!)));
    if (!Number.isFinite(elementMaximum) || elementMaximum <= 0 || twiceArea <= elementMaximum ** 2 * 1e-12) {
      throw new Error(`PENTA6 element ${elementId} has a degenerate cohesive face`);
    }
    maximumEdgeMm = Math.max(maximumEdgeMm, elementMaximum);
    elementCount += 1;
  }
  if (elementCount === 0 || !Number.isFinite(maximumEdgeMm)) {
    throw new Error("Cohesive mesh must contain at least one valid PENTA6 interface element");
  }
  return maximumEdgeMm;
}

function distance(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function subtract(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function norm(vector: [number, number, number]): number {
  return Math.hypot(...vector);
}
