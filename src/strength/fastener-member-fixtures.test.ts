import type { FastenerMemberInput } from "./fastener-member-contracts.ts";

export function fastenerMemberFixture(): FastenerMemberInput {
  const values: Record<string, [number, "mm" | "mm2" | "N" | "MPa" | "ratio", "sourced" | "assumed"]> = {
    "geometry.nominalDiameterMm": [6, "mm", "sourced"],
    "geometry.tensileStressAreaMm2": [20, "mm2", "sourced"],
    "geometry.shearAreaPerPlaneMm2": [Math.PI * 9, "mm2", "sourced"],
    "geometry.shearPlaneCount": [1, "ratio", "sourced"],
    "loads.axialTensionN": [1_000, "N", "sourced"],
    "loads.transverseShearN": [500, "N", "sourced"],
    "material.tensileLimitMPa": [500, "MPa", "sourced"],
    "material.shearLimitMPa": [300, "MPa", "sourced"],
    safetyFactor: [2, "ratio", "assumed"],
  };
  const evidence = Object.entries(values).map(([path, [value, unit, status]]) => ({
    id: path,
    label: path,
    status,
    unit,
    value,
    ...(status === "sourced" ? { sourceUrl: "https://example.test/fastener", sourceHash: "sha256:test" } : {}),
    dependsOn: [],
  }));
  return {
    kind: "fastener-member",
    goal: "check one M6 fastener",
    method: "fastener-member-v1",
    geometry: {
      nominalDiameterMm: 6,
      tensileStressAreaMm2: 20,
      shearAreaPerPlaneMm2: Math.PI * 9,
      shearPlaneCount: 1,
      shearPlaneLocation: "unthreaded-shank",
    },
    loads: { axialTensionN: 1_000, transverseShearN: 500 },
    material: {
      id: "steel-test",
      name: "test fastener steel",
      tensileLimitMPa: 500,
      shearLimitMPa: 300,
      evidenceIds: ["material.tensileLimitMPa", "material.shearLimitMPa"],
      suitability: "matched",
    },
    safetyFactor: 2,
    evidence,
    assignments: Object.fromEntries(Object.keys(values).map((path) => [path, path])),
    assumptions: [
      "static-load",
      "single-fastener-load-known",
      "no-fastener-bending",
      "axial-load-collinear",
      "shear-plane-count-and-location-known",
      "axial-force-includes-applicable-preload",
      "interaction-criterion-accepted",
    ].map((code) => ({ code, confirmed: true, evidenceIds: [] })),
  };
}
