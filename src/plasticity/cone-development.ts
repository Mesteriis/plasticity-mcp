export interface ConeCircularBoundary {
  pointOnCircleMm: [number, number, number];
  circumferenceMm: number;
}

export interface ConeDevelopmentInput {
  basisRadiusMm: number;
  semiAngleRad: number;
  axisOriginMm: [number, number, number];
  axisDirection: [number, number, number];
  circularBoundaries: ConeCircularBoundary[];
}

export interface ConeDevelopmentResult {
  axialHeightMm: number;
  innerRadiusMm: number;
  outerRadiusMm: number;
  includedAngleRad: number;
  slantLengthMm: number;
}

export interface ConeDevelopmentCurvePlan {
  arcs: [
    { centerMm: [number, number, number]; radiusMm: number; startAngleDegrees: number; sweepAngleDegrees: number },
    { centerMm: [number, number, number]; radiusMm: number; startAngleDegrees: number; sweepAngleDegrees: number },
  ];
  radialSegments: [[ [number, number, number], [number, number, number] ], [ [number, number, number], [number, number, number] ]];
  normal: [number, number, number];
  xDirection: [number, number, number];
}

const TAU = 2 * Math.PI;
const GEOMETRY_TOLERANCE_MM = 0.01;

export function calculateConeDevelopment(input: ConeDevelopmentInput): ConeDevelopmentResult {
  if (!Number.isFinite(input.basisRadiusMm) || input.basisRadiusMm <= 0) {
    throw new Error("Cone development requires a finite positive native cone radius");
  }
  if (!Number.isFinite(input.semiAngleRad) || input.semiAngleRad <= 0 || input.semiAngleRad >= Math.PI / 2) {
    throw new Error("Cone development requires a native semi-angle strictly between 0 and 90 degrees");
  }
  const axisLength = Math.hypot(...input.axisDirection);
  if (!Number.isFinite(axisLength) || axisLength <= 0) throw new Error("Cone development requires a finite nonzero native axis");
  if (input.circularBoundaries.length !== 2) {
    throw new Error("Cone development requires exactly two full circular boundaries");
  }
  if ([...input.axisOriginMm, ...input.axisDirection].some((value) => !Number.isFinite(value))) {
    throw new Error("Cone development axis values must be finite");
  }

  const axis = input.axisDirection.map((value) => value / axisLength) as [number, number, number];
  const tangent = Math.tan(input.semiAngleRad);
  const boundaries = input.circularBoundaries.map((boundary) => {
    if (boundary.pointOnCircleMm.some((value) => !Number.isFinite(value)) || !Number.isFinite(boundary.circumferenceMm) || boundary.circumferenceMm <= 0) {
      throw new Error("Cone development boundaries require finite points and positive circumferences");
    }
    const relative = boundary.pointOnCircleMm.map((value, index) => value - input.axisOriginMm[index]!) as [number, number, number];
    const station = dot(relative, axis);
    const radial = relative.map((value, index) => value - axis[index]! * station) as [number, number, number];
    const measuredRadius = boundary.circumferenceMm / TAU;
    const pointRadius = Math.hypot(...radial);
    const expectedRadius = Math.abs(input.basisRadiusMm + station * tangent);
    if (expectedRadius <= 0 || Math.abs(measuredRadius - expectedRadius) > GEOMETRY_TOLERANCE_MM || Math.abs(pointRadius - expectedRadius) > GEOMETRY_TOLERANCE_MM) {
      throw new Error("Circular boundary does not match the native cone at its axial position");
    }
    return { station, radius: measuredRadius };
  });

  const stationDistanceMm = Math.abs(boundaries[0]!.station - boundaries[1]!.station);
  if (stationDistanceMm <= GEOMETRY_TOLERANCE_MM) {
    throw new Error("Cone development boundaries must lie on distinct axial planes");
  }
  const radii = boundaries.map((boundary) => boundary.radius).sort((first, second) => first - second);
  const radialDifferenceMm = radii[1]! - radii[0]!;
  if (radialDifferenceMm <= GEOMETRY_TOLERANCE_MM) {
    throw new Error("Cone development boundaries must have distinct positive radii");
  }

  const slantLengthMm = Math.hypot(stationDistanceMm, radialDifferenceMm);
  const includedAngleRad = TAU * radialDifferenceMm / slantLengthMm;
  const innerRadiusMm = slantLengthMm * radii[0]! / radialDifferenceMm;
  const outerRadiusMm = slantLengthMm * radii[1]! / radialDifferenceMm;
  if (![slantLengthMm, includedAngleRad, innerRadiusMm, outerRadiusMm].every(Number.isFinite) || includedAngleRad <= 0 || includedAngleRad >= TAU || innerRadiusMm <= 0 || outerRadiusMm <= innerRadiusMm) {
    throw new Error("Native cone dimensions do not define a finite annular-sector development");
  }

  return { axialHeightMm: stationDistanceMm, innerRadiusMm, outerRadiusMm, includedAngleRad, slantLengthMm };
}

export function planConeDevelopmentCurves(
  originMm: [number, number, number],
  development: ConeDevelopmentResult,
): ConeDevelopmentCurvePlan {
  if (originMm.some((value) => !Number.isFinite(value))) throw new Error("Cone development placement origin must be finite");
  if (![development.innerRadiusMm, development.outerRadiusMm, development.includedAngleRad].every(Number.isFinite) ||
      development.innerRadiusMm <= 0 || development.outerRadiusMm <= development.innerRadiusMm ||
      development.includedAngleRad <= 0 || development.includedAngleRad >= TAU) {
    throw new Error("Cone development profile dimensions are invalid");
  }
  const angleDeg = development.includedAngleRad * 180 / Math.PI;
  const point = (radius: number, angle: number): [number, number, number] => [
    originMm[0] + radius * Math.cos(angle),
    originMm[1] + radius * Math.sin(angle),
    originMm[2],
  ];
  return {
    arcs: [
      { centerMm: [...originMm], radiusMm: development.outerRadiusMm, startAngleDegrees: 0, sweepAngleDegrees: angleDeg },
      { centerMm: [...originMm], radiusMm: development.innerRadiusMm, startAngleDegrees: angleDeg, sweepAngleDegrees: -angleDeg },
    ],
    radialSegments: [
      [point(development.outerRadiusMm, development.includedAngleRad), point(development.innerRadiusMm, development.includedAngleRad)],
      [point(development.innerRadiusMm, 0), point(development.outerRadiusMm, 0)],
    ],
    normal: [0, 0, 1],
    xDirection: [1, 0, 0],
  };
}

function dot(first: [number, number, number], second: [number, number, number]): number {
  return first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
}
