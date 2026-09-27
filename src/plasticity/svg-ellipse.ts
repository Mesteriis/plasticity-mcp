export type SvgPoint2D = [number, number];

export interface SvgEllipseFit {
  center: SvgPoint2D;
  majorRadius: number;
  minorRadius: number;
  majorAxis: SvgPoint2D;
  minorAxis: SvgPoint2D;
  rotationDegrees: number;
}

export interface SvgEllipseArc {
  sweepRadians: number;
  largeArcFlag: 0 | 1;
  sweepFlag: 0 | 1;
  boundsPoints: SvgPoint2D[];
}

/** Fits an ellipse through five distinct planar samples. Intended for validating rational conic B-Rep curves. */
export function fitSvgConicEllipse(samples: SvgPoint2D[]): SvgEllipseFit {
  if (samples.length !== 5 || samples.some((point) => point.length !== 2 || !point.every(Number.isFinite))) {
    throw new Error("Rational conic requires five finite planar samples");
  }

  const origin: SvgPoint2D = [
    samples.reduce((sum, point) => sum + point[0], 0) / samples.length,
    samples.reduce((sum, point) => sum + point[1], 0) / samples.length,
  ];
  const scale = Math.max(...samples.map((point) => Math.hypot(point[0] - origin[0], point[1] - origin[1])));
  if (!(scale > 1e-12) || !Number.isFinite(scale)) throw new Error("Rational conic samples do not define a stable ellipse");

  const rows = samples.map(([xWorld, yWorld]) => {
    const x = (xWorld - origin[0]) / scale;
    const y = (yWorld - origin[1]) / scale;
    return [x * x, x * y, y * y, x, y, 1];
  });
  const coefficients = rows[0]!.map((_, column) => {
    const minor = rows.map((row) => row.filter((__, index) => index !== column));
    return (column % 2 === 0 ? 1 : -1) * determinant(minor);
  });
  const coefficientScale = Math.max(...coefficients.map(Math.abs));
  if (!(coefficientScale > 1e-14) || !Number.isFinite(coefficientScale)) {
    throw new Error("Rational conic samples do not define a stable ellipse");
  }
  let [a, b, c, d, e, f] = coefficients.map((value) => value / coefficientScale);
  if (a! + c! < 0) [a, b, c, d, e, f] = [-a!, -b!, -c!, -d!, -e!, -f!];

  const trace = a! + c!;
  const discriminant = Math.hypot(a! - c!, b!);
  const lambdaMin = (trace - discriminant) / 2;
  const lambdaMax = (trace + discriminant) / 2;
  const quadraticDeterminant = a! * c! - b! * b! / 4;
  if (!(lambdaMin > 1e-12) || !(lambdaMax > 0) || !(quadraticDeterminant > 1e-14)) {
    throw new Error("Rational conic samples do not define a stable ellipse");
  }

  const centerNormalized: SvgPoint2D = [
    (b! * e! - 2 * c! * d!) / (4 * quadraticDeterminant),
    (b! * d! - 2 * a! * e!) / (4 * quadraticDeterminant),
  ];
  const [cx, cy] = centerNormalized;
  const level = -(a! * cx * cx + b! * cx * cy + c! * cy * cy + d! * cx + e! * cy + f!);
  if (!(level > 1e-14) || !Number.isFinite(level)) {
    throw new Error("Rational conic samples do not define a stable ellipse");
  }
  const majorRadius = scale * Math.sqrt(level / lambdaMin);
  const minorRadius = scale * Math.sqrt(level / lambdaMax);
  if (!Number.isFinite(majorRadius) || !Number.isFinite(minorRadius) || !(minorRadius > 1e-12)) {
    throw new Error("Rational conic samples do not define positive ellipse radii");
  }

  let axisX: number;
  let axisY: number;
  if (Math.abs(b!) > 1e-14) {
    axisX = b!;
    axisY = 2 * (lambdaMin - a!);
  } else if (a! <= c!) {
    axisX = 1;
    axisY = 0;
  } else {
    axisX = 0;
    axisY = 1;
  }
  const axisLength = Math.hypot(axisX, axisY);
  axisX /= axisLength;
  axisY /= axisLength;
  if (axisX < -1e-12 || (Math.abs(axisX) <= 1e-12 && axisY < 0)) {
    axisX = -axisX;
    axisY = -axisY;
  }
  const majorAxis: SvgPoint2D = [axisX, axisY];
  const minorAxis: SvgPoint2D = [-axisY, axisX];
  const ellipse: SvgEllipseFit = {
    center: [origin[0] + scale * cx, origin[1] + scale * cy],
    majorRadius,
    minorRadius,
    majorAxis,
    minorAxis,
    rotationDegrees: Math.atan2(axisY, axisX) * 180 / Math.PI,
  };
  for (const point of samples) {
    if (Math.abs(normalizedEllipseRadius(ellipse.center, majorRadius, minorRadius, majorAxis, minorAxis, point) - 1) > 1e-7) {
      throw new Error("Rational conic samples do not agree with one stable ellipse");
    }
  }
  return ellipse;
}

export function fitSvgEllipse(samples: SvgPoint2D[]): SvgEllipseFit {
  if (samples.length !== 5 || samples.some((point) => point.length !== 2 || !point.every(Number.isFinite))) {
    throw new Error("Native Ellipse requires five finite full-carrier samples");
  }
  const center: SvgPoint2D = [
    (samples[0]![0] + samples[2]![0]) / 2,
    (samples[0]![1] + samples[2]![1]) / 2,
  ];
  const oppositeCenter: SvgPoint2D = [
    (samples[1]![0] + samples[3]![0]) / 2,
    (samples[1]![1] + samples[3]![1]) / 2,
  ];
  const scale = Math.max(1, ...samples.map((point) => Math.hypot(point[0] - center[0], point[1] - center[1])));
  const tolerance = scale * 1e-8;
  const near = (left: SvgPoint2D, right: SvgPoint2D): boolean => Math.hypot(left[0] - right[0], left[1] - right[1]) <= tolerance;
  if (!near(samples[0]!, samples[4]!) || !near(center, oppositeCenter) ||
      !near([2 * center[0] - samples[0]![0], 2 * center[1] - samples[0]![1]], samples[2]!) ||
      !near([2 * center[0] - samples[1]![0], 2 * center[1] - samples[1]![1]], samples[3]!)) {
    throw new Error("Native Ellipse carrier samples do not form two diametric pairs");
  }

  const first: SvgPoint2D = [samples[0]![0] - center[0], samples[0]![1] - center[1]];
  const quarter: SvgPoint2D = [samples[1]![0] - center[0], samples[1]![1] - center[1]];
  const xx = first[0] * first[0] + quarter[0] * quarter[0];
  const xy = first[0] * first[1] + quarter[0] * quarter[1];
  const yy = first[1] * first[1] + quarter[1] * quarter[1];
  const halfTrace = (xx + yy) / 2;
  const halfDifference = Math.hypot((xx - yy) / 2, xy);
  const majorRadius = Math.sqrt(halfTrace + halfDifference);
  const minorRadius = Math.sqrt(halfTrace - halfDifference);
  if (!Number.isFinite(majorRadius) || !Number.isFinite(minorRadius) || !(minorRadius > 0)) {
    throw new Error("Native Ellipse carrier samples do not define positive finite radii");
  }

  const rotation = halfDifference <= majorRadius * majorRadius * 1e-12
    ? 0
    : Math.atan2(2 * xy, xx - yy) / 2;
  let majorX = Math.cos(rotation);
  let majorY = Math.sin(rotation);
  if (majorX < -1e-12 || (Math.abs(majorX) <= 1e-12 && majorY < 0)) {
    majorX = -majorX;
    majorY = -majorY;
  }
  const majorAxis: SvgPoint2D = [majorX, majorY];
  const minorAxis: SvgPoint2D = [-majorY, majorX];
  for (const point of samples.slice(0, 4)) {
    if (Math.abs(normalizedEllipseRadius(center, majorRadius, minorRadius, majorAxis, minorAxis, point) - 1) > 1e-8) {
      throw new Error("Native Ellipse carrier samples do not agree with one analytic ellipse");
    }
  }
  return {
    center,
    majorRadius,
    minorRadius,
    majorAxis,
    minorAxis,
    rotationDegrees: Math.atan2(majorY, majorX) * 180 / Math.PI,
  };
}

export function analyzeSvgEllipseArc(
  ellipse: SvgEllipseFit,
  start: SvgPoint2D,
  end: SvgPoint2D,
  startTangent: SvgPoint2D,
  parameterStart: number,
  parameterEnd: number,
  parameterPeriod: number,
): SvgEllipseArc {
  if (![...start, ...end, ...startTangent, parameterStart, parameterEnd, parameterPeriod].every(Number.isFinite)) {
    throw new Error("Native Ellipse arc parameters and vectors must be finite");
  }
  const thetaAt = (point: SvgPoint2D): number => {
    const dx = point[0] - ellipse.center[0];
    const dy = point[1] - ellipse.center[1];
    return Math.atan2(
      (dx * ellipse.minorAxis[0] + dy * ellipse.minorAxis[1]) / ellipse.minorRadius,
      (dx * ellipse.majorAxis[0] + dy * ellipse.majorAxis[1]) / ellipse.majorRadius,
    );
  };
  const thetaStart = thetaAt(start);
  const thetaEnd = thetaAt(end);
  const endpointRadiusError = Math.max(
    Math.abs(normalizedEllipseRadius(ellipse.center, ellipse.majorRadius, ellipse.minorRadius, ellipse.majorAxis, ellipse.minorAxis, start) - 1),
    Math.abs(normalizedEllipseRadius(ellipse.center, ellipse.majorRadius, ellipse.minorRadius, ellipse.majorAxis, ellipse.minorAxis, end) - 1),
  );
  if (endpointRadiusError > 1e-8) throw new Error("Native Ellipse arc endpoints do not lie on the fitted analytic ellipse");
  if (!(parameterPeriod > 0)) throw new Error("Native Ellipse carrier parameter interval must be positive");
  const sweepRadians = Math.abs(parameterEnd - parameterStart) / parameterPeriod * 2 * Math.PI;
  if (!(sweepRadians > 1e-10 && sweepRadians < 2 * Math.PI - 1e-10)) {
    throw new Error("Native Ellipse arc sweep must be strictly between zero and one full turn");
  }

  const positiveTangent: SvgPoint2D = [
    -ellipse.majorRadius * Math.sin(thetaStart) * ellipse.majorAxis[0] + ellipse.minorRadius * Math.cos(thetaStart) * ellipse.minorAxis[0],
    -ellipse.majorRadius * Math.sin(thetaStart) * ellipse.majorAxis[1] + ellipse.minorRadius * Math.cos(thetaStart) * ellipse.minorAxis[1],
  ];
  const tangentLength = Math.hypot(...startTangent);
  const positiveTangentLength = Math.hypot(...positiveTangent);
  if (!(tangentLength > 0) || !(positiveTangentLength > 0)) throw new Error("Native Ellipse arc tangent must be nonzero");
  const alignment = (startTangent[0] * positiveTangent[0] + startTangent[1] * positiveTangent[1]) / (tangentLength * positiveTangentLength);
  if (Math.abs(Math.abs(alignment) - 1) > 1e-7) throw new Error("Native Ellipse start tangent does not follow the fitted analytic ellipse");
  const sweepFlag: 0 | 1 = alignment > 0 ? 1 : 0;
  const expectedEnd = thetaStart + (sweepFlag === 1 ? sweepRadians : -sweepRadians);
  const endpointAngleError = Math.atan2(Math.sin(thetaEnd - expectedEnd), Math.cos(thetaEnd - expectedEnd));
  if (Math.abs(endpointAngleError) > 1e-6) throw new Error("Native Ellipse arc interval, endpoints, and tangent disagree");

  const pointAt = (theta: number): SvgPoint2D => [
    ellipse.center[0] + ellipse.majorRadius * Math.cos(theta) * ellipse.majorAxis[0] + ellipse.minorRadius * Math.sin(theta) * ellipse.minorAxis[0],
    ellipse.center[1] + ellipse.majorRadius * Math.cos(theta) * ellipse.majorAxis[1] + ellipse.minorRadius * Math.sin(theta) * ellipse.minorAxis[1],
  ];
  const positiveAngle = (angle: number): number => (angle % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  const inSweep = (angle: number): boolean => {
    const distance = sweepFlag === 1 ? positiveAngle(angle - thetaStart) : positiveAngle(thetaStart - angle);
    return distance <= sweepRadians + 1e-10;
  };
  const xExtremum = Math.atan2(ellipse.minorRadius * ellipse.minorAxis[0], ellipse.majorRadius * ellipse.majorAxis[0]);
  const yExtremum = Math.atan2(ellipse.minorRadius * ellipse.minorAxis[1], ellipse.majorRadius * ellipse.majorAxis[1]);
  const boundsPoints = [start, end];
  for (const angle of [xExtremum, xExtremum + Math.PI, yExtremum, yExtremum + Math.PI]) {
    if (inSweep(angle)) boundsPoints.push(pointAt(angle));
  }
  return { sweepRadians, largeArcFlag: sweepRadians > Math.PI + 1e-10 ? 1 : 0, sweepFlag, boundsPoints };
}

function normalizedEllipseRadius(
  center: SvgPoint2D,
  majorRadius: number,
  minorRadius: number,
  majorAxis: SvgPoint2D,
  minorAxis: SvgPoint2D,
  point: SvgPoint2D,
): number {
  const dx = point[0] - center[0];
  const dy = point[1] - center[1];
  return Math.hypot(
    (dx * majorAxis[0] + dy * majorAxis[1]) / majorRadius,
    (dx * minorAxis[0] + dy * minorAxis[1]) / minorRadius,
  );
}

function determinant(matrix: number[][]): number {
  const size = matrix.length;
  const values = matrix.map((row) => row.slice());
  let result = 1;
  for (let column = 0; column < size; column++) {
    let pivot = column;
    for (let row = column + 1; row < size; row++) {
      if (Math.abs(values[row]![column]!) > Math.abs(values[pivot]![column]!)) pivot = row;
    }
    const pivotValue = values[pivot]![column]!;
    if (Math.abs(pivotValue) <= 1e-14) return 0;
    if (pivot !== column) {
      [values[pivot], values[column]] = [values[column]!, values[pivot]!];
      result = -result;
    }
    result *= values[column]![column]!;
    for (let row = column + 1; row < size; row++) {
      const factor = values[row]![column]! / values[column]![column]!;
      for (let next = column + 1; next < size; next++) values[row]![next] = values[row]![next]! - factor * values[column]![next]!;
    }
  }
  return result;
}
