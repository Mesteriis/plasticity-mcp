export interface OrthotropicElasticConstants {
  youngsModulusMPa: number;
  youngsModulus2MPa: number;
  youngsModulus3MPa: number;
  poissonRatio12: number;
  poissonRatio13: number;
  poissonRatio23: number;
  shearModulus12MPa: number;
  shearModulus13MPa: number;
  shearModulus23MPa: number;
}

export interface OrthotropicMaterialOrientation {
  axis1DirectionGlobal: [number, number, number];
  axis2ReferenceDirectionGlobal: [number, number, number];
  buildDirectionGlobal: [number, number, number];
}

export interface OrthotropicMaterialProperties {
  youngsModulus2MPa: number;
  youngsModulus3MPa: number;
  poissonRatio13: number;
  poissonRatio23: number;
  shearModulus12MPa: number;
  shearModulus13MPa: number;
  shearModulus23MPa: number;
}

export interface OrthotropicCaseMaterial extends OrthotropicMaterialProperties {
  orientation: OrthotropicMaterialOrientation;
}

export interface ResolvedOrthotropicOrientation {
  axis1Global: [number, number, number];
  axis2Global: [number, number, number];
  axis3Global: [number, number, number];
  buildDirectionGlobal: [number, number, number];
  calculixPointA: [number, number, number];
  calculixPointB: [number, number, number];
}

export function orthotropicElasticConstantsError(constants: OrthotropicElasticConstants): string | undefined {
  const youngs = [constants.youngsModulusMPa, constants.youngsModulus2MPa, constants.youngsModulus3MPa];
  const shear = [constants.shearModulus12MPa, constants.shearModulus13MPa, constants.shearModulus23MPa];
  const poisson = [constants.poissonRatio12, constants.poissonRatio13, constants.poissonRatio23];
  if ([...youngs, ...shear, ...poisson].some((value) => !Number.isFinite(value))) return "Orthotropic engineering constants must be finite";
  if ([...youngs, ...shear].some((value) => value <= 0)) return "Orthotropic Young's and shear moduli must be positive";

  const [e1, e2, e3] = youngs as [number, number, number];
  const [nu12, nu13, nu23] = poisson as [number, number, number];
  const r12 = nu12 * Math.sqrt(e2 / e1);
  const r13 = nu13 * Math.sqrt(e3 / e1);
  const r23 = nu23 * Math.sqrt(e3 / e2);
  if (![r12, r13, r23].every(Number.isFinite)) return "Orthotropic Poisson ratios and moduli exceed the stable numeric range";
  if (Math.abs(r12) >= 1 || 1 - r12 * r12 <= 0) return "Orthotropic normal compliance is not positive definite (E1/E2/nu12)";
  const determinant = 1 + 2 * r12 * r13 * r23 - r12 * r12 - r13 * r13 - r23 * r23;
  if (!Number.isFinite(determinant) || determinant <= 0) return "Orthotropic normal compliance is not positive definite";
  return undefined;
}

export function resolveOrthotropicOrientation(
  orientation: OrthotropicMaterialOrientation,
): ResolvedOrthotropicOrientation {
  const axis1Global = normalize(orientation.axis1DirectionGlobal, "Material axis 1");
  const reference2 = normalize(orientation.axis2ReferenceDirectionGlobal, "Material axis 2 reference");
  const projection = dot(reference2, axis1Global);
  const projected2 = reference2.map((component, index) => component - projection * axis1Global[index]!) as [number, number, number];
  const axis2Global = normalize(projected2, "Material axis 2 reference must not be parallel to axis 1");
  const axis3Global = normalize(cross(axis1Global, axis2Global), "Material orientation frame is degenerate");
  const buildDirectionGlobal = normalize(orientation.buildDirectionGlobal, "Print build direction");
  if (1 - Math.abs(dot(axis3Global, buildDirectionGlobal)) > 1e-6) {
    throw new Error("Material axis 3 must align with the user-confirmed print build direction; the current orthotropic model treats axis 3 as the layer-normal direction");
  }
  const calculixPointA = axis1Global;
  const calculixPointB = axis1Global.map((component, index) => component + axis2Global[index]!) as [number, number, number];
  return { axis1Global, axis2Global, axis3Global, buildDirectionGlobal, calculixPointA, calculixPointB };
}

export function orthotropicEulerAngles(orientation: OrthotropicMaterialOrientation): [number, number, number] {
  const resolved = resolveOrthotropicOrientation(orientation);
  const matrix = [resolved.axis1Global, resolved.axis2Global, resolved.axis3Global];
  const r00 = matrix[0]![0]!; const r10 = matrix[0]![1]!; const r20 = matrix[0]![2]!;
  const r01 = matrix[1]![0]!; const r11 = matrix[1]![1]!; const r21 = matrix[1]![2]!;
  const r02 = matrix[2]![0]!; const r12 = matrix[2]![1]!; const r22 = matrix[2]![2]!;
  const theta = Math.acos(Math.max(-1, Math.min(1, r22)));
  let psi: number;
  let phi: number;
  if (Math.abs(Math.sin(theta)) > 1e-10) {
    psi = Math.atan2(r02, -r12);
    phi = Math.atan2(r20, r21);
  } else {
    psi = Math.atan2(r10, r00);
    phi = 0;
  }
  return [psi, theta, phi].map((angle) => cleanZero(angle * 180 / Math.PI)) as [number, number, number];
}

function cleanZero(value: number): number {
  return Math.abs(value) < 1e-12 ? 0 : Number(value.toPrecision(12));
}

function normalize(vector: [number, number, number], description: string): [number, number, number] {
  const magnitude = Math.hypot(...vector);
  if (!Number.isFinite(magnitude) || magnitude <= 1e-12) throw new Error(`${description} must be a finite nonzero vector`);
  return vector.map((component) => component / magnitude) as [number, number, number];
}

function dot(left: [number, number, number], right: [number, number, number]): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function cross(left: [number, number, number], right: [number, number, number]): [number, number, number] {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}
