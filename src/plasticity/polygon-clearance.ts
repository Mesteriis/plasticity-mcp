export type Vector3 = [number, number, number];

interface ClosestPair { distanceMm: number; first: Vector3; second: Vector3 }
interface Triangle { a: Vector3; b: Vector3; c: Vector3 }
interface TriangleBounds { min: Vector3; max: Vector3 }
type Point2 = readonly [number, number];

const EPSILON = 1e-10;
const MAX_FACE_TRIANGLES = 4096;

/** Exact Euclidean clearance for two finite, nonparallel polygonal planar regions. */
export function measureNonparallelPolygonClearance(firstLoops: Vector3[][], secondLoops: Vector3[][]): ClosestPair {
  const firstNormal = polygonNormal(firstLoops[0] ?? [], "First");
  const secondNormal = polygonNormal(secondLoops[0] ?? [], "Second");
  if (magnitude(cross(firstNormal, secondNormal)) <= 1e-8) throw new Error("Polygon clearance requires nonparallel face planes");
  const firstTriangles = triangulateRegion(firstLoops, firstNormal, "First").map((triangle) => ({ triangle, bounds: triangleBounds(triangle) }));
  const secondTriangles = triangulateRegion(secondLoops, secondNormal, "Second").map((triangle) => ({ triangle, bounds: triangleBounds(triangle) }));
  let closest: ClosestPair | undefined;
  for (const first of firstTriangles) {
    for (const second of secondTriangles) {
      if (closest && boundsDistanceSquared(first.bounds, second.bounds) > closest.distanceMm ** 2) continue;
      const a = first.triangle;
      const b = second.triangle;
      const intersection = triangleIntersection(a, b, firstNormal, secondNormal);
      if (intersection) return { distanceMm: 0, first: intersection, second: intersection };
      for (const point of [a.a, a.b, a.c]) closest = chooseCloser(closest, pair(point, closestPointOnTriangle(point, b)));
      for (const point of [b.a, b.b, b.c]) closest = chooseCloser(closest, reverse(pair(point, closestPointOnTriangle(point, a))));
      for (const [aStart, aEnd] of triangleEdges(a)) {
        for (const [bStart, bEnd] of triangleEdges(b)) {
          const pairResult = closestSegments(aStart, aEnd, bStart, bEnd);
          closest = chooseCloser(closest, pairResult);
        }
      }
    }
  }
  if (!closest) throw new Error("Polygon clearance could not construct triangle pairs");
  return closest;
}

function polygonNormal(vertices: Vector3[], label: string): Vector3 {
  if (vertices.length < 3) throw new Error(`${label} polygon requires at least three vertices`);
  if (vertices.length > 512) throw new Error(`${label} polygon exceeds the 512-vertex limit`);
  if (vertices.some((point) => point.length !== 3 || !point.every(Number.isFinite))) throw new Error(`${label} polygon coordinates must be finite`);
  const origin = vertices[0]!;
  let normal: Vector3 = [0, 0, 0];
  for (let index = 1; index < vertices.length - 1; index += 1) {
    normal = cross(subtract(vertices[index]!, origin), subtract(vertices[index + 1]!, origin));
    if (magnitude(normal) > EPSILON) break;
  }
  if (magnitude(normal) <= EPSILON) throw new Error(`${label} polygon is degenerate`);
  normal = normalize(normal);
  for (const point of vertices) {
    if (Math.abs(dot(subtract(point, origin), normal)) > 1e-7) throw new Error(`${label} polygon vertices are not coplanar`);
  }
  return normal;
}

function triangulateRegion(loops: Vector3[][], normal: Vector3, label: string): Triangle[] {
  if (loops.length === 0) throw new Error(`${label} polygon region requires at least one boundary loop`);
  const totalVertices = loops.reduce((count, loop) => count + loop.length, 0);
  if (totalVertices > 512) throw new Error(`${label} polygon region exceeds the 512-vertex limit`);
  const origin = loops[0]![0]!;
  const reference: Vector3 = Math.abs(normal[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0];
  const x = normalize(cross(reference, normal));
  const y = cross(normal, x);
  const pointsByLoop = loops.map((vertices, loopIndex) => {
    if (vertices.length < 3) throw new Error(`${label} polygon boundary loop requires at least three vertices`);
    const loopNormal = polygonNormal(vertices, `${label} loop ${loopIndex + 1}`);
    if (magnitude(cross(loopNormal, normal)) > 1e-8 || vertices.some((point) => Math.abs(dot(subtract(point, origin), normal)) > 1e-7)) {
      throw new Error(`${label} polygon boundary loops must share one plane`);
    }
    const points = vertices.map((point) => {
      const relative = subtract(point, origin);
      return [dot(relative, x), dot(relative, y)] as const;
    });
    for (let index = 0; index < points.length; index += 1) {
      if (distanceSquared2(points[index]!, points[(index + 1) % points.length]!) <= EPSILON * EPSILON) {
        throw new Error(`${label} polygon has a zero-length boundary edge`);
      }
    }
    validateSimpleLoop(points, label);
    const indices = removeCollinearVertices(points, label);
    return indices.map((index) => points[index]!);
  });

  for (let firstLoop = 0; firstLoop < pointsByLoop.length; firstLoop += 1) {
    const first = pointsByLoop[firstLoop]!;
    for (let secondLoop = firstLoop + 1; secondLoop < pointsByLoop.length; secondLoop += 1) {
      const second = pointsByLoop[secondLoop]!;
      for (let firstEdge = 0; firstEdge < first.length; firstEdge += 1) {
        for (let secondEdge = 0; secondEdge < second.length; secondEdge += 1) {
          if (segmentsIntersect2(first[firstEdge]!, first[(firstEdge + 1) % first.length]!,
            second[secondEdge]!, second[(secondEdge + 1) % second.length]!)) {
            throw new Error(`${label} polygon boundary loops must be disjoint and non-touching`);
          }
        }
      }
    }
  }

  const xBreaks = [...new Set(pointsByLoop.flatMap((loop) => loop.map((point) => point[0])))].sort((a, b) => a - b);
  const triangles: Triangle[] = [];
  for (let slab = 0; slab < xBreaks.length - 1; slab += 1) {
    const left = xBreaks[slab]!;
    const right = xBreaks[slab + 1]!;
    if (right - left <= EPSILON) continue;
    const middle = (left + right) / 2;
    const crossings: Array<{ start: Point2; end: Point2; y: number }> = [];
    for (const loop of pointsByLoop) {
      for (let edge = 0; edge < loop.length; edge += 1) {
        const start = loop[edge]!;
        const end = loop[(edge + 1) % loop.length]!;
        if (Math.min(start[0], end[0]) < middle && Math.max(start[0], end[0]) > middle) {
          crossings.push({ start, end, y: interpolateY(start, end, middle) });
        }
      }
    }
    crossings.sort((a, b) => a.y - b.y);
    if (crossings.length % 2 !== 0) throw new Error(`${label} polygon region has an invalid boundary parity`);
    for (let index = 0; index < crossings.length; index += 2) {
      const lower = crossings[index]!;
      const upper = crossings[index + 1]!;
      if (upper.y - lower.y <= EPSILON) continue;
      const corners: Point2[] = [
        [left, interpolateY(lower.start, lower.end, left)],
        [right, interpolateY(lower.start, lower.end, right)],
        [right, interpolateY(upper.start, upper.end, right)],
        [left, interpolateY(upper.start, upper.end, left)],
      ];
      const mapped = corners.map((point) => add(origin, add(scale(x, point[0]), scale(y, point[1]))));
      for (const candidate of [
        { a: mapped[0]!, b: mapped[1]!, c: mapped[2]! },
        { a: mapped[0]!, b: mapped[2]!, c: mapped[3]! },
      ]) {
        if (magnitude(cross(subtract(candidate.b, candidate.a), subtract(candidate.c, candidate.a))) > EPSILON) {
          if (triangles.length >= MAX_FACE_TRIANGLES) throw new Error(`${label} polygon region exceeds the ${MAX_FACE_TRIANGLES}-triangle decomposition limit`);
          triangles.push(candidate);
        }
      }
    }
  }
  if (triangles.length === 0) throw new Error(`${label} polygon region is degenerate`);
  return triangles;
}

function validateSimpleLoop(points: Point2[], label: string): void {
  for (let first = 0; first < points.length; first += 1) {
    const firstNext = (first + 1) % points.length;
    const previous = points[(first + points.length - 1) % points.length]!;
    const current = points[first]!;
    const next = points[firstNext]!;
    if (Math.abs(orient(previous, current, next)) <= EPSILON
      && (current[0] - previous[0]) * (current[0] - next[0])
        + (current[1] - previous[1]) * (current[1] - next[1]) > EPSILON) {
      throw new Error(`${label} polygon boundary must form a simple polygon`);
    }
    for (let second = first + 1; second < points.length; second += 1) {
      const secondNext = (second + 1) % points.length;
      if (first === second || firstNext === second || secondNext === first) continue;
      if (segmentsIntersect2(points[first]!, points[firstNext]!, points[second]!, points[secondNext]!)) {
        throw new Error(`${label} polygon boundary must form a simple polygon`);
      }
    }
  }
}

function removeCollinearVertices(points: Point2[], label: string): number[] {
  const indices = points.map((_, index) => index);
  let changed = true;
  while (changed && indices.length > 3) {
    changed = false;
    for (let cursor = 0; cursor < indices.length; cursor += 1) {
      const previous = indices[(cursor + indices.length - 1) % indices.length]!;
      const current = indices[cursor]!;
      const next = indices[(cursor + 1) % indices.length]!;
      if (Math.abs(orient(points[previous]!, points[current]!, points[next]!)) <= EPSILON
        && (points[current]![0] - points[previous]![0]) * (points[current]![0] - points[next]![0])
          + (points[current]![1] - points[previous]![1]) * (points[current]![1] - points[next]![1]) <= EPSILON) {
        indices.splice(cursor, 1);
        changed = true;
        break;
      }
    }
  }
  if (indices.length < 3) throw new Error(`${label} polygon is degenerate`);
  return indices;
}

function interpolateY(start: Point2, end: Point2, x: number): number {
  const ratio = (x - start[0]) / (end[0] - start[0]);
  return start[1] + ratio * (end[1] - start[1]);
}

function segmentsIntersect2(a: Point2, b: Point2, c: Point2, d: Point2): boolean {
  const abC = orient(a, b, c);
  const abD = orient(a, b, d);
  const cdA = orient(c, d, a);
  const cdB = orient(c, d, b);
  if (((abC > EPSILON && abD < -EPSILON) || (abC < -EPSILON && abD > EPSILON))
    && ((cdA > EPSILON && cdB < -EPSILON) || (cdA < -EPSILON && cdB > EPSILON))) return true;
  return (Math.abs(abC) <= EPSILON && pointOnSegment2(c, a, b))
    || (Math.abs(abD) <= EPSILON && pointOnSegment2(d, a, b))
    || (Math.abs(cdA) <= EPSILON && pointOnSegment2(a, c, d))
    || (Math.abs(cdB) <= EPSILON && pointOnSegment2(b, c, d));
}

function pointOnSegment2(point: Point2, start: Point2, end: Point2): boolean {
  return point[0] >= Math.min(start[0], end[0]) - EPSILON && point[0] <= Math.max(start[0], end[0]) + EPSILON
    && point[1] >= Math.min(start[1], end[1]) - EPSILON && point[1] <= Math.max(start[1], end[1]) + EPSILON;
}

function distanceSquared2(a: Point2, b: Point2): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
}

function triangleBounds(triangle: Triangle): TriangleBounds {
  const points = [triangle.a, triangle.b, triangle.c];
  return {
    min: [0, 1, 2].map((axis) => Math.min(...points.map((point) => point[axis]!))) as Vector3,
    max: [0, 1, 2].map((axis) => Math.max(...points.map((point) => point[axis]!))) as Vector3,
  };
}

function boundsDistanceSquared(first: TriangleBounds, second: TriangleBounds): number {
  return [0, 1, 2].reduce((distance, axis) => {
    const separation = Math.max(0, first.min[axis]! - second.max[axis]!, second.min[axis]! - first.max[axis]!);
    return distance + separation * separation;
  }, 0);
}

function triangleIntersection(first: Triangle, second: Triangle, firstNormal: Vector3, secondNormal: Vector3): Vector3 | null {
  for (const [start, end] of triangleEdges(first)) {
    const intersection = segmentTriangleIntersection(start, end, second, secondNormal);
    if (intersection) return intersection;
  }
  for (const [start, end] of triangleEdges(second)) {
    const intersection = segmentTriangleIntersection(start, end, first, firstNormal);
    if (intersection) return intersection;
  }
  return null;
}

function segmentTriangleIntersection(start: Vector3, end: Vector3, triangle: Triangle, normal: Vector3): Vector3 | null {
  const startDistance = dot(subtract(start, triangle.a), normal);
  const endDistance = dot(subtract(end, triangle.a), normal);
  if (startDistance * endDistance > EPSILON || Math.abs(startDistance - endDistance) <= EPSILON) return null;
  const parameter = startDistance / (startDistance - endDistance);
  if (parameter < -EPSILON || parameter > 1 + EPSILON) return null;
  const hit = add(start, scale(subtract(end, start), Math.max(0, Math.min(1, parameter))));
  return pointInTriangle(hit, triangle, normal) ? hit : null;
}

function closestPointOnTriangle(point: Vector3, triangle: Triangle): Vector3 {
  const normal = normalize(cross(subtract(triangle.b, triangle.a), subtract(triangle.c, triangle.a)));
  const projected = subtract(point, scale(normal, dot(subtract(point, triangle.a), normal)));
  if (pointInTriangle(projected, triangle, normal)) return projected;
  let best: ClosestPair | undefined;
  for (const [start, end] of triangleEdges(triangle)) best = chooseCloser(best, pointSegmentPair(point, start, end));
  if (!best) throw new Error("Triangle has no boundary segments");
  return best.second;
}

function pointInTriangle(point: Vector3, triangle: Triangle, normal: Vector3): boolean {
  const first = dot(cross(subtract(triangle.b, triangle.a), subtract(point, triangle.a)), normal);
  const second = dot(cross(subtract(triangle.c, triangle.b), subtract(point, triangle.b)), normal);
  const third = dot(cross(subtract(triangle.a, triangle.c), subtract(point, triangle.c)), normal);
  return (first >= -1e-8 && second >= -1e-8 && third >= -1e-8)
    || (first <= 1e-8 && second <= 1e-8 && third <= 1e-8);
}

function pointSegmentPair(point: Vector3, start: Vector3, end: Vector3): ClosestPair {
  const direction = subtract(end, start);
  const lengthSquared = dot(direction, direction);
  const parameter = lengthSquared <= EPSILON ? 0 : Math.max(0, Math.min(1, dot(subtract(point, start), direction) / lengthSquared));
  const closest = add(start, scale(direction, parameter));
  return pair(point, closest);
}

function closestSegments(firstStart: Vector3, firstEnd: Vector3, secondStart: Vector3, secondEnd: Vector3): ClosestPair {
  const firstDirection = subtract(firstEnd, firstStart);
  const secondDirection = subtract(secondEnd, secondStart);
  const offset = subtract(firstStart, secondStart);
  const a = dot(firstDirection, firstDirection);
  const e = dot(secondDirection, secondDirection);
  if (a <= EPSILON || e <= EPSILON) return pair(closestPointOnSegment(firstStart, secondStart, secondEnd), closestPointOnSegment(secondStart, firstStart, firstEnd));
  const b = dot(firstDirection, secondDirection);
  const c = dot(firstDirection, offset);
  const f = dot(secondDirection, offset);
  const denominator = a * e - b * b;
  const parallelTolerance = Number.EPSILON * a * e * 32;
  let firstParameter = Math.abs(denominator) <= parallelTolerance ? 0 : Math.max(0, Math.min(1, (b * f - c * e) / denominator));
  let secondParameter = (b * firstParameter + f) / e;
  if (secondParameter < 0) { secondParameter = 0; firstParameter = Math.max(0, Math.min(1, -c / a)); }
  else if (secondParameter > 1) { secondParameter = 1; firstParameter = Math.max(0, Math.min(1, (b - c) / a)); }
  return pair(add(firstStart, scale(firstDirection, firstParameter)), add(secondStart, scale(secondDirection, secondParameter)));
}

function closestPointOnSegment(point: Vector3, start: Vector3, end: Vector3): Vector3 {
  const direction = subtract(end, start);
  const lengthSquared = dot(direction, direction);
  const parameter = lengthSquared <= EPSILON ? 0 : Math.max(0, Math.min(1, dot(subtract(point, start), direction) / lengthSquared));
  return add(start, scale(direction, parameter));
}

function triangleEdges(triangle: Triangle): Array<[Vector3, Vector3]> {
  return [[triangle.a, triangle.b], [triangle.b, triangle.c], [triangle.c, triangle.a]];
}

function chooseCloser(current: ClosestPair | undefined, candidate: ClosestPair): ClosestPair {
  return current && current.distanceMm <= candidate.distanceMm ? current : candidate;
}
function pair(first: Vector3, second: Vector3): ClosestPair { return { first, second, distanceMm: magnitude(subtract(first, second)) }; }
function reverse(value: ClosestPair): ClosestPair { return { ...value, first: value.second, second: value.first }; }
function orient(a: readonly number[], b: readonly number[], c: readonly number[]): number { return (b[0]! - a[0]!) * (c[1]! - a[1]!) - (b[1]! - a[1]!) * (c[0]! - a[0]!); }
function add(a: Vector3, b: Vector3): Vector3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function subtract(a: Vector3, b: Vector3): Vector3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function scale(value: Vector3, factor: number): Vector3 { return [value[0] * factor, value[1] * factor, value[2] * factor]; }
function dot(a: Vector3, b: Vector3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a: Vector3, b: Vector3): Vector3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function magnitude(value: Vector3): number { return Math.hypot(...value); }
function normalize(value: Vector3): Vector3 { const length = magnitude(value); if (!Number.isFinite(length) || length <= EPSILON) throw new Error("Polygon geometry has a zero-length vector"); return scale(value, 1 / length); }
