import type { TongueRootInput } from "./tongue-root-contracts.ts";

const assumptionCodes = [
  "static-load",
  "ideal-fixed-root",
  "beam-kinematics-applicable",
  "point-load-at-known-lever-arm",
  "rectangular-prismatic-root",
  "linear-elastic-effective-properties",
  "root-stress-concentration-not-included",
];

export function tongueRootFixture(): TongueRootInput {
  const values: Record<string, { value: number; unit: "mm" | "N" | "MPa" | "ratio" }> = {
    "geometry.rootWidthMm": { value: 10, unit: "mm" },
    "geometry.rootThicknessMm": { value: 5, unit: "mm" },
    "geometry.leverArmMm": { value: 20, unit: "mm" },
    "loads.transverseForceN": { value: 10, unit: "N" },
    "material.youngModulusMPa": { value: 2000, unit: "MPa" },
    "material.shearModulusMPa": { value: 700, unit: "MPa" },
    "material.tensileAllowableMPa": { value: 30, unit: "MPa" },
    "material.shearAllowableMPa": { value: 15, unit: "MPa" },
    shearCorrectionFactor: { value: 5 / 6, unit: "ratio" },
    safetyFactor: { value: 2, unit: "ratio" },
    maxDeflectionMm: { value: 5, unit: "mm" },
  };
  const evidence = Object.entries(values).map(([path, item]) => ({
    id: path,
    label: path,
    status: "sourced" as const,
    unit: item.unit,
    value: item.value,
    sourceUrl: "https://example.test/material-and-measurement-record",
    sourceHash: "a".repeat(64),
    sourceLocator: `record:${path}`,
    dependsOn: [],
  }));
  return {
    kind: "tongue-root",
    goal: "Screen rectangular tongue root",
    method: "tongue-root-transverse-v1",
    geometry: { rootWidthMm: 10, rootThicknessMm: 5, leverArmMm: 20 },
    loads: { transverseForceN: 10 },
    material: {
      id: "profile-test",
      name: "Documented printed polymer profile",
      youngModulusMPa: 2000,
      shearModulusMPa: 700,
      tensileAllowableMPa: 30,
      shearAllowableMPa: 15,
      suitability: "matched",
      evidenceIds: ["material.youngModulusMPa", "material.shearModulusMPa", "material.tensileAllowableMPa", "material.shearAllowableMPa"],
      manufacturing: {
        printerId: "creality-k1c",
        profileHash: "b".repeat(64),
        orientationDeg: [0, 0, 0],
        infillPercent: 100,
        temperatureC: 220,
        effectiveSection: "validated-effective",
      },
    },
    shearCorrectionFactor: 5 / 6,
    safetyFactor: 2,
    maxDeflectionMm: 5,
    evidence,
    assignments: Object.fromEntries(evidence.map((item) => [item.label, item.id])),
    assumptions: assumptionCodes.map((code) => ({ code, confirmed: true, evidenceIds: [] })),
  };
}
