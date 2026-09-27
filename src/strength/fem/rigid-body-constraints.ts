export type ConstraintAxis = 1 | 2 | 3;

export interface FaceTranslationConstraint {
  nodeSetName: string;
  axes: ConstraintAxis[];
}

export function rigidBodyConstraintRank(
  inputDeck: string,
  supports: readonly FaceTranslationConstraint[],
  boundsMm: { min: [number, number, number]; max: [number, number, number] },
): number {
  const nodeCoordinates = new Map<number, [number, number, number]>();
  const nodeSets = new Map<string, number[]>();
  let section: "none" | "nodes" | "node-set" = "none";
  let currentSet: string | undefined;

  for (const [lineIndex, rawLine] of inputDeck.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("**")) continue;
    if (line.startsWith("*")) {
      section = "none";
      currentSet = undefined;
      if (/^\*NODE(?:\s|,|$)/i.test(line)) {
        section = "nodes";
      } else if (/^\*NSET(?:\s|,)/i.test(line)) {
        if (/\bGENERATE\b/i.test(line)) throw new Error("Generated CalculiX node sets are not supported in the restraint preflight");
        const match = line.match(/\bNSET\s*=\s*([^,\s]+)/i);
        if (!match) throw new Error(`CalculiX node set on line ${lineIndex + 1} has no name`);
        currentSet = match[1]!.toUpperCase();
        if (nodeSets.has(currentSet)) throw new Error(`CalculiX node set ${currentSet} is repeated`);
        nodeSets.set(currentSet, []);
        section = "node-set";
      }
      continue;
    }

    const fields = line.split(",").map((field) => field.trim());
    if (section === "nodes") {
      const id = Number(fields[0]);
      const coordinates = fields.slice(1).map(Number);
      if (!Number.isSafeInteger(id) || id <= 0 || coordinates.length !== 3 || !coordinates.every(Number.isFinite)) {
        throw new Error(`Invalid CalculiX node record on line ${lineIndex + 1}`);
      }
      if (nodeCoordinates.has(id)) throw new Error(`CalculiX node ${id} is repeated`);
      nodeCoordinates.set(id, coordinates as [number, number, number]);
    } else if (section === "node-set") {
      const ids = fields.map(Number);
      if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error(`Invalid CalculiX node-set record on line ${lineIndex + 1}`);
      nodeSets.get(currentSet!)!.push(...ids);
    }
  }

  const origin = boundsMm.min.map((minimum, axis) => (minimum + boundsMm.max[axis]!) / 2) as [number, number, number];
  const lengthScale = Math.hypot(...boundsMm.min.map((minimum, axis) => boundsMm.max[axis]! - minimum));
  if (!Number.isFinite(lengthScale) || lengthScale <= 0) throw new Error("Rigid-body restraint preflight requires nonzero finite Solid bounds");

  const basis: Array<{ pivot: number; row: number[] }> = [];
  for (const support of supports) {
    const nodeIds = nodeSets.get(support.nodeSetName.toUpperCase());
    if (!nodeIds?.length) throw new Error(`Support face node set ${support.nodeSetName} has no mesh nodes`);
    if (!support.axes.length || support.axes.some((axis) => axis !== 1 && axis !== 2 && axis !== 3)
      || new Set(support.axes).size !== support.axes.length) {
      throw new Error(`Support face ${support.nodeSetName} has invalid fixed translation axes`);
    }
    for (const nodeId of nodeIds) {
      const coordinates = nodeCoordinates.get(nodeId);
      if (!coordinates) throw new Error(`Support node set ${support.nodeSetName} references missing mesh node ${nodeId}`);
      const relative = coordinates.map((coordinate, axis) => (coordinate - origin[axis]!) / lengthScale) as [number, number, number];
      for (const axis of support.axes) {
        const row = rigidTranslationRow(relative, axis);
        addIndependentRow(basis, row);
        if (basis.length === 6) return 6;
      }
    }
  }
  return basis.length;
}

function rigidTranslationRow(position: [number, number, number], axis: ConstraintAxis): number[] {
  const [x, y, z] = position;
  if (axis === 1) return [1, 0, 0, 0, z, -y];
  if (axis === 2) return [0, 1, 0, -z, 0, x];
  return [0, 0, 1, y, -x, 0];
}

function addIndependentRow(basis: Array<{ pivot: number; row: number[] }>, candidate: number[]): void {
  const row = [...candidate];
  for (const item of basis) {
    const factor = row[item.pivot]!;
    for (let column = item.pivot; column < 6; column += 1) row[column] = row[column]! - factor * item.row[column]!;
  }
  const pivot = row.findIndex((value) => Math.abs(value) > 1e-10);
  if (pivot < 0) return;
  const pivotValue = row[pivot]!;
  for (let column = pivot; column < 6; column += 1) row[column] = row[column]! / pivotValue;
  for (const item of basis) {
    const factor = item.row[pivot]!;
    for (let column = pivot; column < 6; column += 1) item.row[column] = item.row[column]! - factor * row[column]!;
  }
  const insertionIndex = basis.findIndex((item) => item.pivot > pivot);
  basis.splice(insertionIndex < 0 ? basis.length : insertionIndex, 0, { pivot, row });
}
