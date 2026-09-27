export interface OrthotropicTsaiWuStrengths {
  xTensionMPa: number;
  xCompressionMPa: number;
  yTensionMPa: number;
  yCompressionMPa: number;
  zTensionMPa: number;
  zCompressionMPa: number;
  xyShearMPa: number;
  xzShearMPa: number;
  yzShearMPa: number;
}

export interface OrthotropicTsaiWuPoint {
  strengths: OrthotropicTsaiWuStrengths;
  interactions: { xy: number; xz: number; yz: number };
  stressTensorMPa: [number, number, number, number, number, number];
  location: { elementId: number; integrationPoint: number; centroidMm: [number, number, number] };
}

export interface OrthotropicTsaiWuPointResult {
  failureIndex: number;
  loadFactorToIndexOne: number | null;
  linearTerm: number;
  quadraticTerm: number;
  stressTensorMPa: [number, number, number, number, number, number];
  location: OrthotropicTsaiWuPoint["location"];
}

export function calculateOrthotropicTsaiWu(input: OrthotropicTsaiWuPoint): OrthotropicTsaiWuPointResult {
  const { strengths, interactions, stressTensorMPa: stress, location } = input;
  const strengthValues = Object.values(strengths);
  if (strengthValues.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error("Tsai-Wu directional strengths must be finite and positive");
  }
  if (stress.some((value) => !Number.isFinite(value)) || location.centroidMm.some((value) => !Number.isFinite(value))
    || !Number.isSafeInteger(location.elementId) || location.elementId <= 0
    || !Number.isSafeInteger(location.integrationPoint) || location.integrationPoint <= 0) {
    throw new Error("Tsai-Wu stress tensor and mesh location must be finite and valid");
  }
  const { xy, xz, yz } = interactions;
  if ([xy, xz, yz].some((value) => !Number.isFinite(value) || Math.abs(value) >= 1)) {
    throw new Error("Normalized Tsai-Wu interaction coefficients must be finite and strictly between -1 and 1");
  }
  const determinant = 1 + 2 * xy * xz * yz - xy * xy - xz * xz - yz * yz;
  if (!Number.isFinite(determinant) || 1 - xy * xy <= 0 || determinant <= 1e-12) {
    throw new Error("Normalized Tsai-Wu interaction matrix must be positive definite");
  }

  const [s1, s2, s3, t12, t13, t23] = stress;
  const f1 = 1 / strengths.xTensionMPa - 1 / strengths.xCompressionMPa;
  const f2 = 1 / strengths.yTensionMPa - 1 / strengths.yCompressionMPa;
  const f3 = 1 / strengths.zTensionMPa - 1 / strengths.zCompressionMPa;
  const f11 = 1 / (strengths.xTensionMPa * strengths.xCompressionMPa);
  const f22 = 1 / (strengths.yTensionMPa * strengths.yCompressionMPa);
  const f33 = 1 / (strengths.zTensionMPa * strengths.zCompressionMPa);
  const f12 = xy * Math.sqrt(f11 * f22);
  const f13 = xz * Math.sqrt(f11 * f33);
  const f23 = yz * Math.sqrt(f22 * f33);
  const linearTerm = f1 * s1 + f2 * s2 + f3 * s3;
  const quadraticTerm = f11 * s1 * s1 + f22 * s2 * s2 + f33 * s3 * s3
    + 2 * f12 * s1 * s2 + 2 * f13 * s1 * s3 + 2 * f23 * s2 * s3
    + (t12 / strengths.xyShearMPa) ** 2
    + (t13 / strengths.xzShearMPa) ** 2
    + (t23 / strengths.yzShearMPa) ** 2;
  const failureIndex = linearTerm + quadraticTerm;
  if (![linearTerm, quadraticTerm, failureIndex].every(Number.isFinite) || quadraticTerm < 0) {
    throw new Error("Tsai-Wu result is outside the finite positive-definite numeric range");
  }
  if (quadraticTerm === 0 && linearTerm === 0) {
    return { failureIndex, loadFactorToIndexOne: null, linearTerm, quadraticTerm, stressTensorMPa: stress, location };
  }
  const discriminant = linearTerm * linearTerm + 4 * quadraticTerm;
  if (!Number.isFinite(discriminant) || discriminant <= 0) {
    throw new Error("Tsai-Wu proportional reserve-factor discriminant is invalid");
  }
  const root = Math.sqrt(discriminant);
  const loadFactorToIndexOne = linearTerm >= 0
    ? 2 / (linearTerm + root)
    : (root - linearTerm) / (2 * quadraticTerm);
  if (!Number.isFinite(loadFactorToIndexOne) || loadFactorToIndexOne <= 0) {
    throw new Error("Tsai-Wu proportional reserve factor is outside the finite numeric range");
  }
  return { failureIndex, loadFactorToIndexOne, linearTerm, quadraticTerm, stressTensorMPa: stress, location };
}
