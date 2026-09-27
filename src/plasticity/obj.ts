export const MAX_OBJ_BYTES = 1024 * 1024 * 1024;

export interface ObjValidation {
  objects: number;
  vertices: number;
  textureCoordinates: number;
  normals: number;
  faces: number;
  triangles: number;
  boundsMm: {
    min: [number, number, number];
    max: [number, number, number];
    size: [number, number, number];
  };
}

export function validateObj(data: Buffer): ObjValidation {
  if (data.length === 0 || data.length > MAX_OBJ_BYTES) throw new Error("Plasticity produced an empty or excessively large OBJ file");
  const text = data.toString("utf8");
  if (text.includes("\0") || text.includes("\uFFFD")) throw new Error("Plasticity produced an invalid UTF-8 OBJ file");
  let declaredObjects = 0;
  let textureCoordinates = 0;
  let normals = 0;
  let faces = 0;
  let triangles = 0;
  const vertices: Array<[number, number, number]> = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const fields = line.split(/\s+/u);
    const keyword = fields[0];
    if (keyword === "o") {
      declaredObjects += 1;
      continue;
    }
    if (keyword === "v") {
      if (fields.length < 4 || fields.length > 5) throw new Error("Plasticity produced a malformed OBJ vertex");
      vertices.push([
        finiteNumber(fields[1], "OBJ vertex X"),
        finiteNumber(fields[2], "OBJ vertex Y"),
        finiteNumber(fields[3], "OBJ vertex Z"),
      ]);
      continue;
    }
    if (keyword === "vt") {
      if (fields.length < 2 || fields.length > 4) throw new Error("Plasticity produced a malformed OBJ texture coordinate");
      fields.slice(1).forEach((field) => finiteNumber(field, "OBJ texture coordinate"));
      textureCoordinates += 1;
      continue;
    }
    if (keyword === "vn") {
      if (fields.length !== 4) throw new Error("Plasticity produced a malformed OBJ normal");
      fields.slice(1).forEach((field) => finiteNumber(field, "OBJ normal"));
      normals += 1;
      continue;
    }
    if (keyword === "f") {
      if (fields.length < 4) throw new Error("Plasticity produced an OBJ face with fewer than three vertices");
      for (const reference of fields.slice(1)) validateFaceReference(reference, vertices.length, textureCoordinates, normals);
      faces += 1;
      triangles += fields.length - 3;
    }
  }
  if (vertices.length === 0 || faces === 0) throw new Error("Plasticity produced an OBJ file without mesh vertices and faces");
  const min: [number, number, number] = [...vertices[0]!] as [number, number, number];
  const max: [number, number, number] = [...vertices[0]!] as [number, number, number];
  for (const vertex of vertices.slice(1)) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis]!, vertex[axis]!);
      max[axis] = Math.max(max[axis]!, vertex[axis]!);
    }
  }
  return {
    objects: Math.max(1, declaredObjects),
    vertices: vertices.length,
    textureCoordinates,
    normals,
    faces,
    triangles,
    boundsMm: { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] },
  };
}

function finiteNumber(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (value === undefined || value.trim().length === 0 || !Number.isFinite(parsed)) throw new Error(`${label} must be finite`);
  return parsed;
}

function validateFaceReference(reference: string, vertexCount: number, textureCount: number, normalCount: number): void {
  const parts = reference.split("/");
  if (parts.length > 3 || parts[0]?.length === 0) throw new Error("Plasticity produced a malformed OBJ face reference");
  validateIndex(parts[0]!, vertexCount, "vertex");
  if (parts.length >= 2 && parts[1]?.length) validateIndex(parts[1], textureCount, "texture coordinate");
  if (parts.length === 3 && parts[2]?.length) validateIndex(parts[2], normalCount, "normal");
}

function validateIndex(value: string, count: number, label: string): void {
  const index = Number(value);
  if (!Number.isInteger(index) || index === 0) throw new Error(`OBJ ${label} index must be a nonzero integer`);
  const resolved = index > 0 ? index - 1 : count + index;
  if (resolved < 0 || resolved >= count) throw new Error(`OBJ ${label} index is out of range`);
}
