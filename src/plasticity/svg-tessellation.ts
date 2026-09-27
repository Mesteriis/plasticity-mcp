export type Vector3Tuple = [number, number, number];

export interface CurveEvaluation {
  point: Vector3Tuple;
  tangent: Vector3Tuple;
}

export interface CurveTessellation {
  points: Vector3Tuple[];
  maxChordDeviationMm: number;
  samples: number;
}

/**
 * Approximate one native curve with a polyline. The tolerance is checked at
 * quarter, midpoint, and three-quarter samples of each proposed chord; the
 * angular tolerance also bounds tangent rotation between adjacent probes.
 * The function is deliberately self-contained so its source can be injected
 * into Plasticity's renderer context for native B-Rep evaluation.
 */
export function tessellateCurve(
  evaluate: (parameter: number) => CurveEvaluation,
  chordToleranceMm: number,
  angleToleranceDegrees: number,
): CurveTessellation {
  const MAX_CURVE_TESSELLATION_POINTS = 16_384;
  const MAX_CURVE_TESSELLATION_DEPTH = 18;
  const INITIAL_CURVE_TESSELLATION_SEGMENTS = 16;
  if (!Number.isFinite(chordToleranceMm) || chordToleranceMm <= 0 || chordToleranceMm > 5) {
    throw new Error("SVG curve chord tolerance must be a positive finite value within (0, 5] mm");
  }
  if (!Number.isFinite(angleToleranceDegrees) || angleToleranceDegrees <= 0 || angleToleranceDegrees > 30) {
    throw new Error("SVG curve angle tolerance must be a positive finite value within (0, 30] degrees");
  }

  const evaluations = new Map<number, CurveEvaluation>();
  const sample = (parameter: number): CurveEvaluation => {
    const cached = evaluations.get(parameter);
    if (cached) return cached;
    const value = evaluate(parameter);
    if (!value || !Array.isArray(value.point) || value.point.length !== 3 || !Array.isArray(value.tangent) || value.tangent.length !== 3) {
      throw new Error("SVG curve evaluator returned an invalid point or tangent");
    }
    if (![...value.point, ...value.tangent].every(Number.isFinite)) {
      throw new Error("SVG curve evaluator returned a non-finite point or tangent");
    }
    const tangentLength = Math.hypot(...value.tangent);
    if (!(tangentLength > 1e-12)) throw new Error("SVG curve evaluator returned a zero tangent");
    const normalized = {
      point: [...value.point] as Vector3Tuple,
      tangent: value.tangent.map((component) => component / tangentLength) as Vector3Tuple,
    };
    evaluations.set(parameter, normalized);
    return normalized;
  };

  const first = sample(0);
  const last = sample(1);
  const points: Vector3Tuple[] = [first.point];
  let maxChordDeviationMm = 0;
  const angleLimitRadians = angleToleranceDegrees * Math.PI / 180;
  const distanceFromChord = (point: Vector3Tuple, start: Vector3Tuple, end: Vector3Tuple): number => {
    const direction = end.map((component, axis) => component - start[axis]!) as Vector3Tuple;
    const relative = point.map((component, axis) => component - start[axis]!) as Vector3Tuple;
    const squaredLength = direction.reduce((sum, component) => sum + component * component, 0);
    const parameter = squaredLength > 1e-24
      ? Math.max(0, Math.min(1, relative.reduce((sum, component, axis) => sum + component * direction[axis]!, 0) / squaredLength))
      : 0;
    return Math.hypot(...relative.map((component, axis) => component - direction[axis]! * parameter));
  };
  const tangentAngle = (left: Vector3Tuple, right: Vector3Tuple): number => {
    const cosine = Math.max(-1, Math.min(1, left.reduce((sum, component, axis) => sum + component * right[axis]!, 0)));
    return Math.acos(cosine);
  };

  const subdivide = (startParameter: number, start: CurveEvaluation, endParameter: number, end: CurveEvaluation, depth: number): void => {
    const span = endParameter - startParameter;
    const probes = [sample(startParameter + span * 0.25), sample(startParameter + span * 0.5), sample(startParameter + span * 0.75)];
    const deviation = Math.max(...probes.map((probe) => distanceFromChord(probe.point, start.point, end.point)));
    const tangentSamples = [start, ...probes, end];
    let maximumAngle = 0;
    for (let index = 0; index + 1 < tangentSamples.length; index += 1) {
      maximumAngle = Math.max(maximumAngle, tangentAngle(tangentSamples[index]!.tangent, tangentSamples[index + 1]!.tangent));
    }
    if (deviation <= chordToleranceMm && maximumAngle <= angleLimitRadians) {
      maxChordDeviationMm = Math.max(maxChordDeviationMm, deviation);
      if (points.length >= MAX_CURVE_TESSELLATION_POINTS) throw new Error("SVG curve tessellation exceeds the point limit");
      points.push(end.point);
      return;
    }
    if (depth >= MAX_CURVE_TESSELLATION_DEPTH) throw new Error("SVG curve could not meet the requested chord and angular tolerances");
    if (points.length + evaluations.size >= MAX_CURVE_TESSELLATION_POINTS * 3) throw new Error("SVG curve tessellation exceeds the evaluation limit");
    const middleParameter = startParameter + span * 0.5;
    const middle = sample(middleParameter);
    subdivide(startParameter, start, middleParameter, middle, depth + 1);
    subdivide(middleParameter, middle, endParameter, end, depth + 1);
  };

  let previousParameter = 0;
  let previous = first;
  for (let index = 1; index <= INITIAL_CURVE_TESSELLATION_SEGMENTS; index += 1) {
    const parameter = index / INITIAL_CURVE_TESSELLATION_SEGMENTS;
    const current = parameter === 1 ? last : sample(parameter);
    subdivide(previousParameter, previous, parameter, current, 0);
    previousParameter = parameter;
    previous = current;
  }
  return { points, maxChordDeviationMm, samples: evaluations.size };
}
