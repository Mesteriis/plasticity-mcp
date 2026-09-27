export interface StlValidation {
  triangles: number;
  bounds: { min: [number, number, number]; max: [number, number, number] };
  format: "binary" | "ascii";
}

export function validateStl(data: Buffer): StlValidation {
  if (data.length < 15) throw new Error("STL reference mesh is empty or truncated");
  const triangleCount = data.length >= 84 ? data.readUInt32LE(80) : -1;
  if (triangleCount > 0 && 84 + triangleCount * 50 === data.length) {
    return validateBinaryStl(data, triangleCount);
  }
  return validateAsciiStl(data);
}

function validateBinaryStl(data: Buffer, triangleCount: number): StlValidation {
  const bounds = emptyBounds();
  let offset = 84;
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    for (let component = 0; component < 12; component += 1) {
      const value = data.readFloatLE(offset + component * 4);
      if (!Number.isFinite(value)) throw new Error("Binary STL contains a non-finite normal or vertex coordinate");
      if (component >= 3) addPoint(bounds, value, (component - 3) % 3);
    }
    offset += 50;
  }
  return { triangles: triangleCount, bounds: finishBounds(bounds), format: "binary" };
}

function validateAsciiStl(data: Buffer): StlValidation {
  const text = data.toString("utf8");
  if (text.includes("\0") || text.includes("\uFFFD")) throw new Error("ASCII STL is not valid UTF-8 text");
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0);
  if (!/^solid(?:\s|$)/iu.test(lines[0] ?? "") || !/^endsolid(?:\s|$)/iu.test(lines.at(-1) ?? "")) {
    throw new Error("Reference mesh is neither a valid binary STL nor an ASCII STL document");
  }
  const bounds = emptyBounds();
  let triangleCount = 0;
  let verticesInTriangle = 0;
  let inTriangle = false;
  let loopState: "none" | "open" | "closed" = "none";
  for (const line of lines.slice(1, -1)) {
    const fields = line.split(/\s+/u);
    if (/^facet$/iu.test(fields[0] ?? "")) {
      if (inTriangle || fields.length !== 5 || fields[1]!.toLowerCase() !== "normal") throw new Error("ASCII STL contains a malformed facet declaration");
      fields.slice(2).forEach((value) => finite(value, "STL facet normal"));
      inTriangle = true;
      verticesInTriangle = 0;
      loopState = "none";
      continue;
    }
    if (/^vertex$/iu.test(fields[0] ?? "")) {
      if (!inTriangle || loopState !== "open" || fields.length !== 4 || verticesInTriangle >= 3) throw new Error("ASCII STL contains a malformed vertex");
      const point = fields.slice(1).map((value) => finite(value, "STL vertex")) as [number, number, number];
      point.forEach((value, axis) => addPoint(bounds, value, axis));
      verticesInTriangle += 1;
      continue;
    }
    if (line.toLowerCase() === "outer loop") {
      if (!inTriangle || loopState !== "none" || verticesInTriangle !== 0) throw new Error("ASCII STL contains a malformed outer loop");
      loopState = "open";
      continue;
    }
    if (line.toLowerCase() === "endloop") {
      if (!inTriangle || loopState !== "open" || verticesInTriangle !== 3) throw new Error("ASCII STL loop must contain exactly three vertices");
      loopState = "closed";
      continue;
    }
    if (/^endfacet$/iu.test(fields[0] ?? "")) {
      if (!inTriangle || loopState !== "closed" || verticesInTriangle !== 3 || fields.length !== 1) throw new Error("ASCII STL facet must contain a closed loop with exactly three vertices");
      triangleCount += 1;
      inTriangle = false;
      loopState = "none";
      continue;
    }
    throw new Error("ASCII STL contains unsupported or malformed facet syntax");
  }
  if (inTriangle || triangleCount === 0) throw new Error("ASCII STL contains no complete triangles");
  return { triangles: triangleCount, bounds: finishBounds(bounds), format: "ascii" };
}

function finite(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be finite`);
  return parsed;
}

function emptyBounds() {
  return { min: [Infinity, Infinity, Infinity] as [number, number, number], max: [-Infinity, -Infinity, -Infinity] as [number, number, number] };
}

function addPoint(bounds: ReturnType<typeof emptyBounds>, value: number, axis: number): void {
  bounds.min[axis] = Math.min(bounds.min[axis]!, value);
  bounds.max[axis] = Math.max(bounds.max[axis]!, value);
}

function finishBounds(bounds: ReturnType<typeof emptyBounds>) {
  if (![...bounds.min, ...bounds.max].every(Number.isFinite)) throw new Error("STL contains no finite vertex coordinates");
  return bounds;
}
