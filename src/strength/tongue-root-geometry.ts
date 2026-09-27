import type { SectionLoop, LocalSectionProperties } from "./section-geometry.ts";

export interface RectangularRootDimensions {
  rootWidthMm: number;
  rootThicknessMm: number;
}

const ABSOLUTE_TOLERANCE_MM = 1e-5;
const RELATIVE_TOLERANCE = 1e-8;

export function rectangularRootDimensions(
  loops: SectionLoop[],
  properties: LocalSectionProperties,
): RectangularRootDimensions {
  if (!properties.rectangular || properties.innerLoopCount !== 0 || properties.boundaryKinds.length !== 1 || properties.boundaryKinds[0] !== "line") {
    throw new Error("Tongue-root verification requires one solid rectangular native section without holes or curved boundaries");
  }
  if (loops.length !== 1 || loops[0]!.segments.length !== 4 || loops[0]!.segments.some((segment) => segment.kind !== "line")) {
    throw new Error("Tongue-root verification requires exactly four native straight section edges");
  }
  const points = loops[0]!.segments.flatMap((segment) => segment.kind === "line" ? [segment.start, segment.end] : []);
  const minX = Math.min(...points.map(([x]) => x));
  const maxX = Math.max(...points.map(([x]) => x));
  const minY = Math.min(...points.map(([, y]) => y));
  const maxY = Math.max(...points.map(([, y]) => y));
  const widthMm = maxX - minX;
  const thicknessMm = maxY - minY;
  const tolerance = Math.max(ABSOLUTE_TOLERANCE_MM, Math.max(widthMm, thicknessMm) * RELATIVE_TOLERANCE);
  if (!(widthMm > tolerance && thicknessMm > tolerance)) throw new Error("Native rectangular section dimensions are degenerate or below measurement tolerance");

  const corners = new Set<string>();
  for (const [x, y] of points) {
    const left = Math.abs(x - minX) <= tolerance;
    const right = Math.abs(x - maxX) <= tolerance;
    const bottom = Math.abs(y - minY) <= tolerance;
    const top = Math.abs(y - maxY) <= tolerance;
    if (!(left || right) || !(bottom || top)) throw new Error("Section edges are rotated relative to the requested width/thickness axes");
    corners.add(`${left ? 0 : 1}:${bottom ? 0 : 1}`);
  }
  if (corners.size !== 4) throw new Error("Native section boundary does not form four rectangular corners");
  for (const segment of loops[0]!.segments) {
    if (segment.kind !== "line") throw new Error("Rectangular section edges must be straight native B-rep lines");
    const horizontal = Math.abs(segment.start[1] - segment.end[1]) <= tolerance;
    const vertical = Math.abs(segment.start[0] - segment.end[0]) <= tolerance;
    if (horizontal === vertical) throw new Error("Native section contains a diagonal or zero-length edge");
  }
  const expectedArea = widthMm * thicknessMm;
  if (Math.abs(properties.areaMm2 - expectedArea) > Math.max(1, expectedArea) * RELATIVE_TOLERANCE) {
    throw new Error("Measured section area does not match the rectangular root dimensions");
  }
  return { rootWidthMm: widthMm, rootThicknessMm: thicknessMm };
}
