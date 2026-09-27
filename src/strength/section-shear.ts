import type { LocalSectionProperties, Point2, SectionLoop } from "./section-geometry.ts";

export type DirectShearModel = "solid-rectangle" | "solid-circle" | "concentric-circular-annulus";
export type TorsionSectionModel = Exclude<DirectShearModel, "solid-rectangle"> | "thin-walled-rectangular-single-cell";

export interface DirectShearFamily {
  model: DirectShearModel;
  maximumToAverageFactor: number;
  scopeLabel: string;
}

interface CircularLoop {
  center: Point2;
  radius: number;
}

export interface CircularSectionFamily {
  model: Exclude<TorsionSectionModel, "thin-walled-rectangular-single-cell">;
  outerRadiusMm: number;
  innerRadiusMm?: number;
}

export interface ThinWalledSingleCellFamily {
  model: "thin-walled-rectangular-single-cell";
  medianAreaMm2: number;
  wallThicknessMm: number;
}

const COINCIDENCE_TOLERANCE_MM = 1e-5;
const ANGLE_TOLERANCE_RADIANS = 1e-8;

export function classifyDirectShearFamily(
  loops: SectionLoop[],
  properties: LocalSectionProperties,
): DirectShearFamily | null {
  if (properties.rectangular && properties.innerLoopCount === 0) {
    return {
      model: "solid-rectangle",
      maximumToAverageFactor: 3 / 2,
      scopeLabel: "maximum direct shear for a solid rectangular section",
    };
  }

  const circular = classifyCircularSection(loops, properties);
  if (circular?.model === "solid-circle") {
    return {
      model: "solid-circle",
      maximumToAverageFactor: 4 / 3,
      scopeLabel: "maximum direct shear for a solid circular section",
    };
  }
  if (circular?.model !== "concentric-circular-annulus" || circular.innerRadiusMm === undefined) return null;
  const numerator = circular.outerRadiusMm ** 2 + circular.outerRadiusMm * circular.innerRadiusMm + circular.innerRadiusMm ** 2;
  const denominator = circular.outerRadiusMm ** 2 + circular.innerRadiusMm ** 2;
  const maximumToAverageFactor = 4 / 3 * numerator / denominator;
  if (!Number.isFinite(maximumToAverageFactor)) return null;
  return {
    model: "concentric-circular-annulus",
    maximumToAverageFactor,
    scopeLabel: "maximum direct shear for a concentric circular annulus",
  };
}

export function classifyCircularSection(
  loops: SectionLoop[],
  properties: LocalSectionProperties,
): CircularSectionFamily | null {
  const circles = loops.map(circularLoop);
  if (circles.some((circle) => circle === null)) return null;
  const proven = circles as CircularLoop[];
  if (properties.innerLoopCount === 0 && proven.length === 1) {
    return { model: "solid-circle", outerRadiusMm: proven[0]!.radius };
  }
  if (properties.innerLoopCount !== 1 || proven.length !== 2) return null;
  const [inner, outer] = [...proven].sort((left, right) => left.radius - right.radius);
  if (!inner || !outer || !samePoint(inner.center, outer.center) || !(outer.radius > inner.radius + COINCIDENCE_TOLERANCE_MM)) {
    return null;
  }
  return {
    model: "concentric-circular-annulus",
    outerRadiusMm: outer.radius,
    innerRadiusMm: inner.radius,
  };
}

export function classifyThinWalledRectangularSingleCell(
  loops: SectionLoop[],
  properties: LocalSectionProperties,
): ThinWalledSingleCellFamily | null {
  if (loops.length !== 2 || properties.innerLoopCount !== 1) return null;
  const rectangles = loops.map(rectangleLoop);
  if (rectangles.some((rectangle) => rectangle === null)) return null;
  const proven = rectangles as RectangleLoop[];
  const [first, second] = proven;
  if (!first || !second) return null;
  const outer = first.area > second.area ? first : second;
  const inner = first.area > second.area ? second : first;
  const outerCenter: Point2 = [(outer.minX + outer.maxX) / 2, (outer.minY + outer.maxY) / 2];
  const innerCenter: Point2 = [(inner.minX + inner.maxX) / 2, (inner.minY + inner.maxY) / 2];
  if (!samePoint(outerCenter, innerCenter)) return null;
  if (!(inner.width > 0 && inner.height > 0 && outer.width > inner.width && outer.height > inner.height)) return null;
  const wallX = (outer.width - inner.width) / 2;
  const wallY = (outer.height - inner.height) / 2;
  if (!(wallX > COINCIDENCE_TOLERANCE_MM) || !near(wallX, wallY)) return null;
  const medianWidth = (outer.width + inner.width) / 2;
  const medianHeight = (outer.height + inner.height) / 2;
  const medianAreaMm2 = medianWidth * medianHeight;
  if (!Number.isFinite(medianAreaMm2) || medianAreaMm2 <= 0) return null;
  return { model: "thin-walled-rectangular-single-cell", medianAreaMm2, wallThicknessMm: (wallX + wallY) / 2 };
}

interface RectangleLoop {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
  area: number;
}

function rectangleLoop(loop: SectionLoop): RectangleLoop | null {
  if (loop.segments.length !== 4 || loop.segments.some((segment) => segment.kind !== "line")) return null;
  const points = loop.segments.flatMap((segment) => segment.kind === "line" ? [segment.start, segment.end] : []);
  const xs = uniqueCoordinates(points.map((point) => point[0]));
  const ys = uniqueCoordinates(points.map((point) => point[1]));
  if (xs.length !== 2 || ys.length !== 2 || points.some((point) =>
    !xs.some((x) => near(point[0], x)) || !ys.some((y) => near(point[1], y)),
  )) return null;
  for (const segment of loop.segments) {
    if (segment.kind !== "line") return null;
    const dx = Math.abs(segment.end[0] - segment.start[0]);
    const dy = Math.abs(segment.end[1] - segment.start[1]);
    if ((dx <= COINCIDENCE_TOLERANCE_MM) === (dy <= COINCIDENCE_TOLERANCE_MM)) return null;
  }
  const width = xs[1]! - xs[0]!;
  const height = ys[1]! - ys[0]!;
  return { minX: xs[0]!, maxX: xs[1]!, minY: ys[0]!, maxY: ys[1]!, width, height, area: width * height };
}

function uniqueCoordinates(values: number[]): number[] {
  const sorted = [...values].sort((left, right) => left - right);
  const unique: number[] = [];
  for (const value of sorted) {
    if (unique.length === 0 || !near(value, unique.at(-1)!)) unique.push(value);
  }
  return unique;
}

function circularLoop(loop: SectionLoop): CircularLoop | null {
  const first = loop.segments[0];
  if (!first || first.kind !== "arc") return null;
  const orientation = Math.sign(first.sweepRadians);
  let totalSweep = 0;
  for (const segment of loop.segments) {
    if (
      segment.kind !== "arc" ||
      Math.sign(segment.sweepRadians) !== orientation ||
      !samePoint(segment.center, first.center) ||
      !near(segment.radius, first.radius)
    ) {
      return null;
    }
    totalSweep += segment.sweepRadians;
  }
  if (Math.abs(Math.abs(totalSweep) - 2 * Math.PI) > ANGLE_TOLERANCE_RADIANS) return null;
  return { center: [...first.center], radius: first.radius };
}

function samePoint(left: Point2, right: Point2): boolean {
  return Math.hypot(left[0] - right[0], left[1] - right[1]) <= COINCIDENCE_TOLERANCE_MM;
}

function near(left: number, right: number): boolean {
  return Math.abs(left - right) <= COINCIDENCE_TOLERANCE_MM;
}
