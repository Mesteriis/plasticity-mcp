export interface SimplySupportedUniformPlateInput {
  lengthMm: number;
  widthMm: number;
  thicknessMm: number;
  pressureMPa: number;
  youngMPa: number;
  poissonRatio: number;
}

export interface SimplySupportedUniformPlateResult {
  flexuralRigidityNmm: number;
  centerDeflectionMm: number;
  centerMomentXN: number;
  centerMomentYN: number;
  centerSurfaceStressMPa: { x: number; y: number };
  maximumCenterSurfaceStressMPa: number;
  seriesMaxOddIndex: 401;
}

const SERIES_MAX_ODD_INDEX = 401 as const;

/**
 * Classical Navier solution at the centre of a uniformly loaded rectangular
 * Kirchhoff-Love plate with all four edges simply supported. Moments are per
 * unit edge length (N mm/mm = N); pressure in MPa is N/mm².
 */
export function solveSimplySupportedUniformPlate(
  input: SimplySupportedUniformPlateInput,
): SimplySupportedUniformPlateResult {
  requirePositive(input.lengthMm, "Plate length");
  requirePositive(input.widthMm, "Plate width");
  requirePositive(input.thicknessMm, "Plate thickness");
  requirePositive(input.youngMPa, "Young's modulus");
  if (!Number.isFinite(input.pressureMPa) || input.pressureMPa < 0) {
    throw new RangeError("Plate pressure must be finite and nonnegative");
  }
  if (!Number.isFinite(input.poissonRatio) || input.poissonRatio <= -1 || input.poissonRatio >= 0.5) {
    throw new RangeError("Poisson ratio must satisfy -1 < nu < 0.5 for this isotropic plate method");
  }

  const { lengthMm: a, widthMm: b, thicknessMm: thickness, pressureMPa: pressure, youngMPa, poissonRatio: nu } = input;
  const flexuralRigidityNmm = youngMPa * thickness ** 3 / (12 * (1 - nu ** 2));
  let deflectionSeries = 0;
  let momentXSeries = 0;
  let momentYSeries = 0;
  for (let m = 1; m <= SERIES_MAX_ODD_INDEX; m += 2) {
    const centerSignM = oddCenterSign(m);
    const mOverA2 = (m / a) ** 2;
    for (let n = 1; n <= SERIES_MAX_ODD_INDEX; n += 2) {
      const centerSign = centerSignM * oddCenterSign(n);
      const nOverB2 = (n / b) ** 2;
      const waveNumberSquared = mOverA2 + nOverB2;
      const common = centerSign / (m * n * waveNumberSquared ** 2);
      deflectionSeries += common;
      momentXSeries += common * (mOverA2 + nu * nOverB2);
      momentYSeries += common * (nu * mOverA2 + nOverB2);
    }
  }

  const centerDeflectionMm = stableZero(16 * pressure * deflectionSeries /
    (Math.PI ** 6 * flexuralRigidityNmm));
  const centerMomentXN = stableZero(16 * pressure * momentXSeries / Math.PI ** 4);
  const centerMomentYN = stableZero(16 * pressure * momentYSeries / Math.PI ** 4);
  const centerSurfaceStressMPa = {
    x: stableZero(6 * centerMomentXN / thickness ** 2),
    y: stableZero(6 * centerMomentYN / thickness ** 2),
  };
  const maximumCenterSurfaceStressMPa = Math.max(
    Math.abs(centerSurfaceStressMPa.x),
    Math.abs(centerSurfaceStressMPa.y),
  );
  const values = [
    flexuralRigidityNmm,
    centerDeflectionMm,
    centerMomentXN,
    centerMomentYN,
    centerSurfaceStressMPa.x,
    centerSurfaceStressMPa.y,
    maximumCenterSurfaceStressMPa,
  ];
  if (!values.every(Number.isFinite)) throw new RangeError("Plate calculation overflowed to a non-finite value");
  return {
    flexuralRigidityNmm,
    centerDeflectionMm,
    centerMomentXN,
    centerMomentYN,
    centerSurfaceStressMPa,
    maximumCenterSurfaceStressMPa,
    seriesMaxOddIndex: SERIES_MAX_ODD_INDEX,
  };
}

function oddCenterSign(index: number): 1 | -1 {
  return ((index - 1) / 2) % 2 === 0 ? 1 : -1;
}

function requirePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be finite and positive`);
}

function stableZero(value: number): number {
  return Math.abs(value) <= 1e-15 ? 0 : value;
}
