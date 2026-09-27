import { createHash } from "node:crypto";

export type Point2 = [number, number];

export type SectionSegment =
  | { kind: "line"; start: Point2; end: Point2 }
  | { kind: "arc"; center: Point2; radius: number; startRadians: number; sweepRadians: number };

export interface SectionLoop {
  segments: SectionSegment[];
}

export interface LocalSectionProperties {
  areaMm2: number;
  centroidLocalMm: Point2;
  ixxMm4: number;
  iyyMm4: number;
  ixyMm4: number;
  principal: { majorMm4: number; minorMm4: number; angleDegrees: number };
  innerLoopCount: number;
  boundaryKinds: Array<"line" | "circle">;
  rectangular: boolean;
  topologySignature: string;
}

export interface SectionProperties extends LocalSectionProperties {
  centroidMm: [number, number, number];
  source: "native-brep-boundary" | "native-brep-temporary-section";
}

interface BoundaryIntegrals {
  area: number;
  firstX: number;
  firstY: number;
  ixx: number;
  iyy: number;
  ixy: number;
}

type Complex = [number, number];
type Fourier = Map<number, Complex>;

const CLOSURE_TOLERANCE_MM = 1e-5;
const GEOMETRY_TOLERANCE = 1e-9;
const MAX_SWEEP = 2 * Math.PI;

export function integrateSection(loops: SectionLoop[]): LocalSectionProperties {
  validateLoops(loops);
  const depths = containmentDepths(loops);
  if (depths.filter((depth) => depth === 0).length !== 1) {
    throw new Error("Section must contain exactly one outer island");
  }

  const total = emptyIntegrals();
  const normalizedLoops: SectionLoop[] = [];
  for (let index = 0; index < loops.length; index += 1) {
    const loop = loops[index]!;
    const raw = integrateLoop(loop);
    if (Math.abs(raw.area) <= GEOMETRY_TOLERANCE) throw new Error("Section loop has non-positive area");
    const desiredSign = depths[index]! % 2 === 0 ? 1 : -1;
    const factor = Math.sign(raw.area) === desiredSign ? 1 : -1;
    addIntegrals(total, raw, factor);
    normalizedLoops.push(factor === 1 ? loop : reverseLoop(loop));
  }
  assertFiniteIntegrals(total);
  if (!(total.area > GEOMETRY_TOLERANCE)) throw new Error("Section has non-positive area");

  const centroidX = total.firstX / total.area;
  const centroidY = total.firstY / total.area;
  let ixx = total.ixx - total.area * centroidY ** 2;
  let iyy = total.iyy - total.area * centroidX ** 2;
  let ixy = total.ixy - total.area * centroidX * centroidY;
  const scale = Math.max(1, Math.abs(total.ixx), Math.abs(total.iyy));
  if (Math.abs(ixx) <= scale * 1e-13) ixx = 0;
  if (Math.abs(iyy) <= scale * 1e-13) iyy = 0;
  if (Math.abs(ixy) <= scale * 1e-13) ixy = 0;
  if (![centroidX, centroidY, ixx, iyy, ixy].every(Number.isFinite)) {
    throw new Error("Section integration produced a non-finite result");
  }
  const determinant = ixx * iyy - ixy ** 2;
  if (!(ixx > 0) || !(iyy > 0) || !(determinant > 0) || !Number.isFinite(determinant)) {
    throw new Error("Section inertia tensor has a non-positive determinant");
  }

  const average = (ixx + iyy) / 2;
  const radius = Math.hypot((ixx - iyy) / 2, ixy);
  const major = average + radius;
  const minor = average - radius;
  const angleDegrees = 0.5 * Math.atan2(-2 * ixy, ixx - iyy) * 180 / Math.PI;
  const kinds = new Set(loops.flatMap((loop) => loop.segments.map((segment) => segment.kind === "line" ? "line" as const : "circle" as const)));
  return {
    areaMm2: total.area,
    centroidLocalMm: [centroidX, centroidY],
    ixxMm4: ixx,
    iyyMm4: iyy,
    ixyMm4: ixy,
    principal: { majorMm4: major, minorMm4: minor, angleDegrees },
    innerLoopCount: depths.filter((depth) => depth % 2 === 1).length,
    boundaryKinds: (["line", "circle"] as const).filter((kind) => kinds.has(kind)),
    rectangular: loops.length === 1 && isRectangle(normalizedLoops[0]!),
    topologySignature: topologySignature(normalizedLoops),
  };
}

export function linearStressExtrema(
  loops: SectionLoop[],
  coefficients: { constant: number; x: number; y: number },
): { minimum: number; maximum: number; minimumAt: Point2; maximumAt: Point2 } {
  integrateSection(loops);
  if (![coefficients.constant, coefficients.x, coefficients.y].every(Number.isFinite)) {
    throw new Error("Linear stress coefficients must be finite");
  }
  const candidates: Point2[] = [];
  for (const loop of loops) {
    for (const segment of loop.segments) {
      candidates.push(segmentStart(segment), segmentEnd(segment));
      if (segment.kind === "arc" && Math.hypot(coefficients.x, coefficients.y) > 0) {
        const maximumAngle = Math.atan2(coefficients.y, coefficients.x);
        for (const angle of [maximumAngle, maximumAngle + Math.PI]) {
          if (angleOnArc(angle, segment, true)) candidates.push(pointOnArc(segment, angle));
        }
      }
    }
  }
  if (candidates.length === 0) throw new Error("Section has no boundary points");
  const value = ([x, y]: Point2): number => coefficients.constant + coefficients.x * x + coefficients.y * y;
  let minimumAt = candidates[0]!;
  let maximumAt = candidates[0]!;
  let minimum = value(minimumAt);
  let maximum = minimum;
  for (const point of candidates.slice(1)) {
    const candidate = value(point);
    if (candidate < minimum) {
      minimum = candidate;
      minimumAt = point;
    }
    if (candidate > maximum) {
      maximum = candidate;
      maximumAt = point;
    }
  }
  if (![minimum, maximum, ...minimumAt, ...maximumAt].every(Number.isFinite)) {
    throw new Error("Linear stress extrema are non-finite");
  }
  return { minimum, maximum, minimumAt, maximumAt };
}

export function sectionHasConcaveOuterBoundary(loops: SectionLoop[]): boolean {
  validateLoops(loops);
  const depths = containmentDepths(loops);
  const outerIndexes = depths.flatMap((depth, index) => depth === 0 ? [index] : []);
  if (outerIndexes.length !== 1) throw new Error("Section must contain exactly one outer island");
  const outer = loops[outerIndexes[0]!]!;
  const orientation = Math.sign(integrateLoop(outer).area);
  if (orientation === 0) throw new Error("Section outer boundary has non-positive area");
  for (const segment of outer.segments) {
    if (segment.kind === "arc" && orientation * segment.sweepRadians < -GEOMETRY_TOLERANCE) return true;
  }
  for (let index = 0; index < outer.segments.length; index += 1) {
    const previous = outer.segments[index]!;
    const next = outer.segments[(index + 1) % outer.segments.length]!;
    const incoming = segmentTangent(previous, false);
    const outgoing = segmentTangent(next, true);
    const turn = Math.atan2(cross2(incoming, outgoing), dot2(incoming, outgoing));
    if (orientation * turn < -GEOMETRY_TOLERANCE) return true;
  }
  return false;
}

function validateLoops(loops: SectionLoop[]): void {
  if (loops.length === 0) throw new Error("Section requires at least one closed loop");
  for (const [loopIndex, loop] of loops.entries()) {
    if (loop.segments.length === 0) throw new Error(`Section loop ${loopIndex} is empty`);
    for (const [segmentIndex, segment] of loop.segments.entries()) {
      validateSegment(segment, loopIndex, segmentIndex);
      const next = loop.segments[(segmentIndex + 1) % loop.segments.length]!;
      if (distance(segmentEnd(segment), segmentStart(next)) > CLOSURE_TOLERANCE_MM) {
        throw new Error(`Section loop ${loopIndex} is open at segment ${segmentIndex}`);
      }
    }
  }
  rejectBoundaryIntersections(loops);
}

function validateSegment(segment: SectionSegment, loopIndex: number, segmentIndex: number): void {
  const values = segment.kind === "line"
    ? [...segment.start, ...segment.end]
    : [...segment.center, segment.radius, segment.startRadians, segment.sweepRadians];
  if (!values.every(Number.isFinite)) throw new Error(`Section segment ${loopIndex}:${segmentIndex} must be finite`);
  if (segment.kind === "line") {
    if (distance(segment.start, segment.end) <= GEOMETRY_TOLERANCE) throw new Error("Section contains a zero-length line");
    return;
  }
  if (!(segment.radius > 0)) throw new Error("Arc radius must be positive");
  if (!(Math.abs(segment.sweepRadians) > GEOMETRY_TOLERANCE)) throw new Error("Arc sweep must be nonzero");
  if (Math.abs(segment.sweepRadians) > MAX_SWEEP + GEOMETRY_TOLERANCE) {
    throw new Error("Arc sweep cannot exceed one full circle");
  }
  if (![segment.radius ** 2, segment.radius ** 4].every(Number.isFinite)) {
    throw new Error("Arc radius causes non-finite integration overflow");
  }
}

function containmentDepths(loops: SectionLoop[]): number[] {
  return loops.map((loop, index) => {
    const point = segmentStart(loop.segments[0]!);
    return loops.reduce((depth, candidate, candidateIndex) =>
      candidateIndex !== index && pointInLoop(point, candidate) ? depth + 1 : depth, 0);
  });
}

function pointInLoop(point: Point2, loop: SectionLoop): boolean {
  let crossings = 0;
  for (const segment of loop.segments) {
    if (segment.kind === "line") {
      const [x1, y1] = segment.start;
      const [x2, y2] = segment.end;
      if ((y1 > point[1]) !== (y2 > point[1])) {
        const x = x1 + (point[1] - y1) * (x2 - x1) / (y2 - y1);
        if (x > point[0]) crossings += 1;
      }
      continue;
    }
    const normalized = (point[1] - segment.center[1]) / segment.radius;
    if (normalized < -1 - GEOMETRY_TOLERANCE || normalized > 1 + GEOMETRY_TOLERANCE) continue;
    const base = Math.asin(Math.max(-1, Math.min(1, normalized)));
    for (const angle of uniqueAngles([base, Math.PI - base])) {
      const fraction = arcFraction(angle, segment);
      if (fraction === null || fraction < -GEOMETRY_TOLERANCE || fraction >= 1 - GEOMETRY_TOLERANCE) continue;
      if (Math.abs(Math.cos(angle)) <= GEOMETRY_TOLERANCE) continue;
      const x = segment.center[0] + segment.radius * Math.cos(angle);
      if (x > point[0]) crossings += 1;
    }
  }
  return crossings % 2 === 1;
}

function integrateLoop(loop: SectionLoop): BoundaryIntegrals {
  const result = emptyIntegrals();
  for (const segment of loop.segments) addIntegrals(result, integrateSegment(segment), 1);
  assertFiniteIntegrals(result);
  return result;
}

function integrateSegment(segment: SectionSegment): BoundaryIntegrals {
  if (segment.kind === "line") {
    const [x0, y0] = segment.start;
    const [x1, y1] = segment.end;
    const x = [x0, x1 - x0];
    const y = [y0, y1 - y0];
    const xPrime = x1 - x0;
    const yPrime = y1 - y0;
    return {
      area: 0.5 * integratePolynomial(subtractPolynomial(scalePolynomial(x, yPrime), scalePolynomial(y, xPrime))),
      firstX: 0.5 * yPrime * integratePolynomial(powerPolynomial(x, 2)),
      firstY: -0.5 * xPrime * integratePolynomial(powerPolynomial(y, 2)),
      ixx: -xPrime / 3 * integratePolynomial(powerPolynomial(y, 3)),
      iyy: yPrime / 3 * integratePolynomial(powerPolynomial(x, 3)),
      ixy: 0.5 * yPrime * integratePolynomial(multiplyPolynomial(powerPolynomial(x, 2), y)),
    };
  }
  const cosine = new Map<number, Complex>([[1, [0.5, 0]], [-1, [0.5, 0]]]);
  const sine = new Map<number, Complex>([[1, [0, -0.5]], [-1, [0, 0.5]]]);
  const x = addFourier(constantFourier(segment.center[0]), scaleFourier(cosine, segment.radius));
  const y = addFourier(constantFourier(segment.center[1]), scaleFourier(sine, segment.radius));
  const xPrime = scaleFourier(sine, -segment.radius);
  const yPrime = scaleFourier(cosine, segment.radius);
  const integral = (series: Fourier): number => integrateFourier(series, segment.startRadians, segment.sweepRadians);
  return {
    area: 0.5 * integral(subtractFourier(multiplyFourier(x, yPrime), multiplyFourier(y, xPrime))),
    firstX: 0.5 * integral(multiplyFourier(powerFourier(x, 2), yPrime)),
    firstY: -0.5 * integral(multiplyFourier(powerFourier(y, 2), xPrime)),
    ixx: -1 / 3 * integral(multiplyFourier(powerFourier(y, 3), xPrime)),
    iyy: 1 / 3 * integral(multiplyFourier(powerFourier(x, 3), yPrime)),
    ixy: 0.5 * integral(multiplyFourier(multiplyFourier(powerFourier(x, 2), y), yPrime)),
  };
}

function integratePolynomial(value: number[]): number {
  return value.reduce((sum, coefficient, power) => sum + coefficient / (power + 1), 0);
}

function scalePolynomial(value: number[], factor: number): number[] {
  return value.map((coefficient) => coefficient * factor);
}

function subtractPolynomial(left: number[], right: number[]): number[] {
  return Array.from({ length: Math.max(left.length, right.length) }, (_, index) =>
    (left[index] ?? 0) - (right[index] ?? 0));
}

function multiplyPolynomial(left: number[], right: number[]): number[] {
  const result = Array.from({ length: left.length + right.length - 1 }, () => 0);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      result[leftIndex + rightIndex]! += left[leftIndex]! * right[rightIndex]!;
    }
  }
  return result;
}

function powerPolynomial(value: number[], exponent: number): number[] {
  let result = [1];
  for (let index = 0; index < exponent; index += 1) result = multiplyPolynomial(result, value);
  return result;
}

function emptyIntegrals(): BoundaryIntegrals {
  return { area: 0, firstX: 0, firstY: 0, ixx: 0, iyy: 0, ixy: 0 };
}

function addIntegrals(target: BoundaryIntegrals, source: BoundaryIntegrals, factor: number): void {
  target.area += factor * source.area;
  target.firstX += factor * source.firstX;
  target.firstY += factor * source.firstY;
  target.ixx += factor * source.ixx;
  target.iyy += factor * source.iyy;
  target.ixy += factor * source.ixy;
}

function assertFiniteIntegrals(value: BoundaryIntegrals): void {
  if (!Object.values(value).every(Number.isFinite)) throw new Error("Section integration produced non-finite overflow");
}

function constantFourier(value: number): Fourier {
  return new Map([[0, [value, 0]]]);
}

function addFourier(left: Fourier, right: Fourier): Fourier {
  const result = new Map(left);
  for (const [power, value] of right) result.set(power, addComplex(result.get(power) ?? [0, 0], value));
  return result;
}

function subtractFourier(left: Fourier, right: Fourier): Fourier {
  return addFourier(left, scaleFourier(right, -1));
}

function scaleFourier(value: Fourier, factor: number): Fourier {
  return new Map([...value].map(([power, coefficient]) => [power, scaleComplex(coefficient, factor)]));
}

function multiplyFourier(left: Fourier, right: Fourier): Fourier {
  const result: Fourier = new Map();
  for (const [leftPower, leftValue] of left) {
    for (const [rightPower, rightValue] of right) {
      const power = leftPower + rightPower;
      result.set(power, addComplex(result.get(power) ?? [0, 0], multiplyComplex(leftValue, rightValue)));
    }
  }
  return result;
}

function powerFourier(value: Fourier, exponent: number): Fourier {
  let result = constantFourier(1);
  for (let index = 0; index < exponent; index += 1) result = multiplyFourier(result, value);
  return result;
}

function integrateFourier(value: Fourier, start: number, sweep: number): number {
  const end = start + sweep;
  let result: Complex = [0, 0];
  for (const [power, coefficient] of value) {
    if (power === 0) {
      result = addComplex(result, scaleComplex(coefficient, sweep));
      continue;
    }
    const numerator = subtractComplex(exponential(power * end), exponential(power * start));
    const factor: Complex = [numerator[1] / power, -numerator[0] / power];
    result = addComplex(result, multiplyComplex(coefficient, factor));
  }
  if (Math.abs(result[1]) > Math.max(1, Math.abs(result[0])) * 1e-10) {
    throw new Error("Section integration produced a non-real Fourier result");
  }
  return result[0];
}

function addComplex(left: Complex, right: Complex): Complex {
  return [left[0] + right[0], left[1] + right[1]];
}

function subtractComplex(left: Complex, right: Complex): Complex {
  return [left[0] - right[0], left[1] - right[1]];
}

function scaleComplex(value: Complex, factor: number): Complex {
  return [value[0] * factor, value[1] * factor];
}

function multiplyComplex(left: Complex, right: Complex): Complex {
  return [left[0] * right[0] - left[1] * right[1], left[0] * right[1] + left[1] * right[0]];
}

function exponential(angle: number): Complex {
  return [Math.cos(angle), Math.sin(angle)];
}

function rejectBoundaryIntersections(loops: SectionLoop[]): void {
  for (let firstLoop = 0; firstLoop < loops.length; firstLoop += 1) {
    const firstSegments = loops[firstLoop]!.segments;
    for (let firstIndex = 0; firstIndex < firstSegments.length; firstIndex += 1) {
      for (let secondLoop = firstLoop; secondLoop < loops.length; secondLoop += 1) {
        const secondSegments = loops[secondLoop]!.segments;
        const startIndex = secondLoop === firstLoop ? firstIndex + 1 : 0;
        for (let secondIndex = startIndex; secondIndex < secondSegments.length; secondIndex += 1) {
          const intersections = segmentIntersections(firstSegments[firstIndex]!, secondSegments[secondIndex]!);
          if (intersections === "overlap") throw new Error("Section boundary has a self-intersection or overlap");
          if (intersections.length === 0) continue;
          const adjacent = firstLoop === secondLoop && (
            secondIndex === firstIndex + 1 ||
            (firstIndex === 0 && secondIndex === firstSegments.length - 1)
          );
          if (!adjacent) throw new Error("Section boundary has a self-intersection");
          const shared = firstSegments.length === 2
            ? [segmentStart(firstSegments[firstIndex]!), segmentEnd(firstSegments[firstIndex]!)]
            : [secondIndex === firstIndex + 1
                ? segmentEnd(firstSegments[firstIndex]!)
                : segmentStart(firstSegments[firstIndex]!)];
          if (intersections.some((point) => shared.every((candidate) => distance(point, candidate) > CLOSURE_TOLERANCE_MM))) {
            throw new Error("Section boundary has a self-intersection");
          }
        }
      }
    }
  }
}

function segmentIntersections(first: SectionSegment, second: SectionSegment): Point2[] | "overlap" {
  if (first.kind === "line" && second.kind === "line") return lineLineIntersections(first, second);
  if (first.kind === "line" && second.kind === "arc") return lineArcIntersections(first, second);
  if (first.kind === "arc" && second.kind === "line") return lineArcIntersections(second, first);
  return arcArcIntersections(first as Extract<SectionSegment, { kind: "arc" }>, second as Extract<SectionSegment, { kind: "arc" }>);
}

function lineLineIntersections(
  first: Extract<SectionSegment, { kind: "line" }>,
  second: Extract<SectionSegment, { kind: "line" }>,
): Point2[] | "overlap" {
  const r = subtractPoint(first.end, first.start);
  const s = subtractPoint(second.end, second.start);
  const denominator = cross2(r, s);
  const offset = subtractPoint(second.start, first.start);
  if (Math.abs(denominator) <= GEOMETRY_TOLERANCE) {
    if (Math.abs(cross2(offset, r)) > GEOMETRY_TOLERANCE) return [];
    const rr = dot2(r, r);
    const values = [dot2(offset, r) / rr, dot2(subtractPoint(second.end, first.start), r) / rr].sort((a, b) => a - b);
    const low = Math.max(0, values[0]!);
    const high = Math.min(1, values[1]!);
    if (high < low - GEOMETRY_TOLERANCE) return [];
    if (high - low > GEOMETRY_TOLERANCE) return "overlap";
    return [addPoint(first.start, scalePoint(r, Math.max(0, Math.min(1, (low + high) / 2))))];
  }
  const t = cross2(offset, s) / denominator;
  const u = cross2(offset, r) / denominator;
  if (!withinUnit(t) || !withinUnit(u)) return [];
  return [addPoint(first.start, scalePoint(r, t))];
}

function lineArcIntersections(
  line: Extract<SectionSegment, { kind: "line" }>,
  arc: Extract<SectionSegment, { kind: "arc" }>,
): Point2[] {
  const direction = subtractPoint(line.end, line.start);
  const offset = subtractPoint(line.start, arc.center);
  const a = dot2(direction, direction);
  const b = 2 * dot2(offset, direction);
  const c = dot2(offset, offset) - arc.radius ** 2;
  const discriminant = b ** 2 - 4 * a * c;
  if (discriminant < -GEOMETRY_TOLERANCE) return [];
  const root = Math.sqrt(Math.max(0, discriminant));
  const values = uniqueNumbers([(-b - root) / (2 * a), (-b + root) / (2 * a)]);
  return values
    .filter(withinUnit)
    .map((t) => addPoint(line.start, scalePoint(direction, t)))
    .filter((point) => angleOnArc(Math.atan2(point[1] - arc.center[1], point[0] - arc.center[0]), arc, true));
}

function arcArcIntersections(
  first: Extract<SectionSegment, { kind: "arc" }>,
  second: Extract<SectionSegment, { kind: "arc" }>,
): Point2[] | "overlap" {
  const offset = subtractPoint(second.center, first.center);
  const centerDistance = Math.hypot(...offset);
  if (centerDistance <= GEOMETRY_TOLERANCE && Math.abs(first.radius - second.radius) <= GEOMETRY_TOLERANCE) {
    for (const firstInterval of arcCoverage(first)) {
      for (const secondInterval of arcCoverage(second)) {
        const overlap = Math.min(firstInterval[1], secondInterval[1]) - Math.max(firstInterval[0], secondInterval[0]);
        if (overlap > GEOMETRY_TOLERANCE) return "overlap";
      }
    }
    return uniquePoints([segmentStart(first), segmentEnd(first), segmentStart(second), segmentEnd(second)])
      .filter((point) => {
        const angle = Math.atan2(point[1] - first.center[1], point[0] - first.center[0]);
        return angleOnArc(angle, first, true) && angleOnArc(angle, second, true);
      });
  }
  if (centerDistance > first.radius + second.radius + GEOMETRY_TOLERANCE) return [];
  if (centerDistance < Math.abs(first.radius - second.radius) - GEOMETRY_TOLERANCE || centerDistance <= GEOMETRY_TOLERANCE) return [];
  const along = (first.radius ** 2 - second.radius ** 2 + centerDistance ** 2) / (2 * centerDistance);
  const heightSquared = first.radius ** 2 - along ** 2;
  if (heightSquared < -GEOMETRY_TOLERANCE) return [];
  const unit = scalePoint(offset, 1 / centerDistance);
  const base = addPoint(first.center, scalePoint(unit, along));
  const perpendicular: Point2 = [-unit[1], unit[0]];
  const height = Math.sqrt(Math.max(0, heightSquared));
  return uniquePoints([
    addPoint(base, scalePoint(perpendicular, height)),
    addPoint(base, scalePoint(perpendicular, -height)),
  ]).filter((point) => {
    const firstAngle = Math.atan2(point[1] - first.center[1], point[0] - first.center[0]);
    const secondAngle = Math.atan2(point[1] - second.center[1], point[0] - second.center[0]);
    return angleOnArc(firstAngle, first, true) && angleOnArc(secondAngle, second, true);
  });
}

function arcCoverage(segment: Extract<SectionSegment, { kind: "arc" }>): Array<[number, number]> {
  const length = Math.abs(segment.sweepRadians);
  if (Math.abs(length - MAX_SWEEP) <= GEOMETRY_TOLERANCE) return [[0, MAX_SWEEP]];
  const start = normalizeAngle(segment.sweepRadians >= 0
    ? segment.startRadians
    : segment.startRadians + segment.sweepRadians);
  const end = start + length;
  return end <= MAX_SWEEP
    ? [[start, end]]
    : [[start, MAX_SWEEP], [0, end - MAX_SWEEP]];
}

function isRectangle(loop: SectionLoop): boolean {
  if (loop.segments.length !== 4 || loop.segments.some((segment) => segment.kind !== "line")) return false;
  const vectors = loop.segments.map((segment) => subtractPoint(segmentEnd(segment), segmentStart(segment)));
  if (vectors.some((vector) => Math.hypot(...vector) <= GEOMETRY_TOLERANCE)) return false;
  for (let index = 0; index < 4; index += 1) {
    const current = vectors[index]!;
    const next = vectors[(index + 1) % 4]!;
    if (Math.abs(dot2(current, next)) > Math.hypot(...current) * Math.hypot(...next) * 1e-9) return false;
  }
  return Math.abs(cross2(vectors[0]!, vectors[2]!)) <= Math.hypot(...vectors[0]!) * Math.hypot(...vectors[2]!) * 1e-9 &&
    Math.abs(cross2(vectors[1]!, vectors[3]!)) <= Math.hypot(...vectors[1]!) * Math.hypot(...vectors[3]!) * 1e-9;
}

function topologySignature(loops: SectionLoop[]): string {
  const canonical = loops.map(canonicalLoop).sort();
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function canonicalLoop(loop: SectionLoop): string {
  const records = loop.segments.map((segment) => {
    if (segment.kind === "line") return ["line", ...segment.start.map(stableNumber), ...segment.end.map(stableNumber)];
    const fullCircle = Math.abs(Math.abs(segment.sweepRadians) - MAX_SWEEP) <= GEOMETRY_TOLERANCE;
    return [
      "arc",
      ...segment.center.map(stableNumber),
      stableNumber(segment.radius),
      stableNumber(fullCircle ? 0 : normalizeAngle(segment.startRadians)),
      stableNumber(segment.sweepRadians),
    ];
  }).map((record) => JSON.stringify(record));
  const rotations = records.map((_, index) => [...records.slice(index), ...records.slice(0, index)].join("|"));
  return rotations.sort()[0]!;
}

function stableNumber(value: number): number {
  const stable = Number(value.toPrecision(14));
  return Object.is(stable, -0) ? 0 : stable;
}

function reverseLoop(loop: SectionLoop): SectionLoop {
  return { segments: [...loop.segments].reverse().map((segment): SectionSegment => {
    if (segment.kind === "line") return { kind: "line", start: segment.end, end: segment.start };
    return {
      kind: "arc",
      center: segment.center,
      radius: segment.radius,
      startRadians: segment.startRadians + segment.sweepRadians,
      sweepRadians: -segment.sweepRadians,
    };
  }) };
}

function segmentStart(segment: SectionSegment): Point2 {
  return segment.kind === "line" ? segment.start : pointOnArc(segment, segment.startRadians);
}

function segmentEnd(segment: SectionSegment): Point2 {
  return segment.kind === "line" ? segment.end : pointOnArc(segment, segment.startRadians + segment.sweepRadians);
}

function segmentTangent(segment: SectionSegment, atStart: boolean): Point2 {
  if (segment.kind === "line") {
    const vector = subtractPoint(segment.end, segment.start);
    return scalePoint(vector, 1 / Math.hypot(...vector));
  }
  const angle = segment.startRadians + (atStart ? 0 : segment.sweepRadians);
  const sign = Math.sign(segment.sweepRadians);
  return [-Math.sin(angle) * sign, Math.cos(angle) * sign];
}

function midpointOnArc(segment: Extract<SectionSegment, { kind: "arc" }>): Point2 {
  return pointOnArc(segment, segment.startRadians + segment.sweepRadians / 2);
}

function pointOnArc(segment: Extract<SectionSegment, { kind: "arc" }>, angle: number): Point2 {
  return [
    segment.center[0] + segment.radius * Math.cos(angle),
    segment.center[1] + segment.radius * Math.sin(angle),
  ];
}

function angleOnArc(angle: number, segment: Extract<SectionSegment, { kind: "arc" }>, includeEnd: boolean): boolean {
  const fraction = arcFraction(angle, segment);
  return fraction !== null && fraction >= -GEOMETRY_TOLERANCE &&
    (includeEnd ? fraction <= 1 + GEOMETRY_TOLERANCE : fraction < 1 - GEOMETRY_TOLERANCE);
}

function arcFraction(angle: number, segment: Extract<SectionSegment, { kind: "arc" }>): number | null {
  if (Math.abs(Math.abs(segment.sweepRadians) - MAX_SWEEP) <= GEOMETRY_TOLERANCE) {
    const directed = segment.sweepRadians > 0
      ? normalizeAngle(angle - segment.startRadians)
      : normalizeAngle(segment.startRadians - angle);
    return directed / MAX_SWEEP;
  }
  let best: number | null = null;
  const approximate = (segment.startRadians - angle) / (2 * Math.PI);
  for (let offset = Math.floor(approximate) - 2; offset <= Math.ceil(approximate) + 2; offset += 1) {
    const equivalent = angle + offset * 2 * Math.PI;
    const fraction = (equivalent - segment.startRadians) / segment.sweepRadians;
    if (fraction >= -GEOMETRY_TOLERANCE && fraction <= 1 + GEOMETRY_TOLERANCE) {
      if (best === null || Math.abs(fraction - 0.5) < Math.abs(best - 0.5)) best = fraction;
    }
  }
  return best;
}

function normalizeAngle(value: number): number {
  const normalized = value % (2 * Math.PI);
  return normalized < 0 ? normalized + 2 * Math.PI : normalized;
}

function withinUnit(value: number): boolean {
  return value >= -GEOMETRY_TOLERANCE && value <= 1 + GEOMETRY_TOLERANCE;
}

function uniqueAngles(values: number[]): number[] {
  return uniqueNumbers(values.map(normalizeAngle));
}

function uniqueNumbers(values: number[]): number[] {
  return values.filter((value, index) => values.findIndex((candidate) => Math.abs(candidate - value) <= GEOMETRY_TOLERANCE) === index);
}

function uniquePoints(values: Point2[]): Point2[] {
  return values.filter((value, index) => values.findIndex((candidate) => distance(candidate, value) <= GEOMETRY_TOLERANCE) === index);
}

function addPoint(left: Point2, right: Point2): Point2 {
  return [left[0] + right[0], left[1] + right[1]];
}

function subtractPoint(left: Point2, right: Point2): Point2 {
  return [left[0] - right[0], left[1] - right[1]];
}

function scalePoint(value: Point2, factor: number): Point2 {
  return [value[0] * factor, value[1] * factor];
}

function dot2(left: Point2, right: Point2): number {
  return left[0] * right[0] + left[1] * right[1];
}

function cross2(left: Point2, right: Point2): number {
  return left[0] * right[1] - left[1] * right[0];
}

function distance(left: Point2, right: Point2): number {
  return Math.hypot(left[0] - right[0], left[1] - right[1]);
}
