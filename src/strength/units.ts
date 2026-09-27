import type { Evidence } from "./contracts.ts";

type Vector3 = [number, number, number];

export function forceAtPointMomentNmm(offsetMm: Vector3, forceN: Vector3): Vector3 {
  if (![...offsetMm, ...forceN].every(Number.isFinite)) throw new RangeError("Force moment inputs must be finite");
  const result: Vector3 = [
    offsetMm[1] * forceN[2] - offsetMm[2] * forceN[1],
    offsetMm[2] * forceN[0] - offsetMm[0] * forceN[2],
    offsetMm[0] * forceN[1] - offsetMm[1] * forceN[0],
  ];
  if (!result.every(Number.isFinite)) throw new RangeError("Force moment calculation overflowed to a non-finite value");
  return result;
}

export function massToForceN(massKg: number, gravityMps2: number): number {
  if (!Number.isFinite(massKg) || massKg < 0) throw new RangeError("massKg must be finite and nonnegative");
  if (!Number.isFinite(gravityMps2) || gravityMps2 <= 0) throw new RangeError("gravityMps2 must be finite and positive");
  const force = massKg * gravityMps2;
  if (!Number.isFinite(force)) throw new RangeError("mass-to-force conversion overflowed");
  return force;
}

export function massToForceEvidence(
  id: string,
  massEvidenceId: string,
  gravityEvidenceId: string,
  massKg: number,
  gravityMps2: number,
): Evidence {
  return {
    id,
    label: "Force derived from mass and explicit gravity",
    status: "derived",
    unit: "N",
    value: massToForceN(massKg, gravityMps2),
    dependsOn: [massEvidenceId, gravityEvidenceId],
    derivation: "forceN = massKg × gravityMps2",
  };
}
