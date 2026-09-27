import type { FastenerScenarioInput } from "./fastener-contracts.ts";

export function fastenerScenarioFixture(geometry: Partial<FastenerScenarioInput["geometry"]> = {}): FastenerScenarioInput {
  const resolvedGeometry = {
    thicknessMm: 2,
    holeDiameterMm: 5,
    loadedEdgeDistanceMm: 10,
    oppositeEdgeDistanceMm: 15,
    grossWidthMm: 25,
    sideClearancesMm: [10, 10] as [number, number],
    ...geometry,
  };
  const values: Record<string, [number, "mm" | "N" | "MPa" | "ratio", "measured" | "sourced" | "assumed"]> = {
    "geometry.thicknessMm": [resolvedGeometry.thicknessMm, "mm", "measured"],
    "geometry.holeDiameterMm": [resolvedGeometry.holeDiameterMm, "mm", "measured"],
    "geometry.loadedEdgeDistanceMm": [resolvedGeometry.loadedEdgeDistanceMm, "mm", "measured"],
    "geometry.oppositeEdgeDistanceMm": [resolvedGeometry.oppositeEdgeDistanceMm, "mm", "measured"],
    "geometry.grossWidthMm": [resolvedGeometry.grossWidthMm, "mm", "measured"],
    "geometry.sideClearancesMm.0": [resolvedGeometry.sideClearancesMm[0], "mm", "measured"],
    "geometry.sideClearancesMm.1": [resolvedGeometry.sideClearancesMm[1], "mm", "measured"],
    loadN: [100, "N", "sourced"],
    "material.bearingLimitMPa": [200, "MPa", "sourced"],
    "material.shearLimitMPa": [100, "MPa", "sourced"],
    "material.tensileLimitMPa": [100, "MPa", "sourced"],
    safetyFactor: [2, "ratio", "assumed"],
  };
  const evidence = Object.entries(values).map(([path, [value, unit, status]]) => ({
    id: path,
    label: path,
    status,
    unit,
    value,
    ...(status === "sourced" ? { sourceUrl: "https://example.test/source", sourceHash: "sha256:test" } : {}),
    ...(status === "measured" ? { sourceLocator: "plasticity:test" } : {}),
    dependsOn: [],
  }));
  return {
    kind: "single-fastener-plate",
    goal: "test one loaded hole",
    method: "single-fastener-plate-v1",
    geometry: resolvedGeometry,
    loadN: 100,
    material: {
      id: "test",
      name: "test",
      evidenceIds: [
        "material.bearingLimitMPa",
        "material.shearLimitMPa",
        "material.tensileLimitMPa",
      ],
      bearingLimitMPa: 200,
      shearLimitMPa: 100,
      tensileLimitMPa: 100,
      suitability: "matched",
      manufacturing: {
        printerId: "test",
        profileHash: "test",
        orientationDeg: [0, 0, 0],
        infillPercent: 100,
        temperatureC: 20,
        effectiveSection: "solid",
      },
    },
    safetyFactor: 2,
    evidence,
    assignments: Object.fromEntries(Object.keys(values).map((path) => [path, path])),
    assumptions: [
      "static-in-plane-load",
      "single-fastener-load-path",
      "load-centered-through-thickness",
      "homogeneous-equivalent-plate",
      "nominal-bearing-contact",
    ].map((code) => ({ code, confirmed: true, evidenceIds: [] })),
  };
}
