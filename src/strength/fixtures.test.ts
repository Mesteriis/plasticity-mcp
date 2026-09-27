import type { RectangularMethodId, StrengthInput } from "./contracts.ts";

export function syntheticInput(method: RectangularMethodId): StrengthInput {
  const evidence = [
    { id: "length", label: "TEST ONLY length", status: "measured" as const, unit: "mm" as const, value: 100, dependsOn: [] },
    { id: "width", label: "TEST ONLY width", status: "measured" as const, unit: "mm" as const, value: 10, dependsOn: [] },
    { id: "height", label: "TEST ONLY height", status: "measured" as const, unit: "mm" as const, value: 5, dependsOn: [] },
    { id: "force", label: "TEST ONLY force", status: "assumed" as const, unit: "N" as const, value: 1, dependsOn: [] },
    { id: "young", label: "TEST ONLY modulus", status: "sourced" as const, unit: "MPa" as const, value: 4000, sourceUrl: "https://example.invalid/test-material", sourceLocator: "synthetic fixture", dependsOn: [] },
    { id: "tensile", label: "TEST ONLY tensile limit", status: "sourced" as const, unit: "MPa" as const, value: 30, sourceUrl: "https://example.invalid/test-material", sourceLocator: "synthetic fixture", dependsOn: [] },
    { id: "compressive", label: "TEST ONLY compressive limit", status: "sourced" as const, unit: "MPa" as const, value: 30, sourceUrl: "https://example.invalid/test-material", sourceLocator: "synthetic fixture", dependsOn: [] },
    { id: "sf", label: "TEST ONLY safety factor", status: "assumed" as const, unit: "ratio" as const, value: 2, dependsOn: [] },
    { id: "disp", label: "TEST ONLY displacement limit", status: "assumed" as const, unit: "mm" as const, value: 2, dependsOn: [] },
  ];
  return {
    goal: "Synthetic test member",
    method,
    lengthMm: 100,
    widthMm: 10,
    heightMm: 5,
    forceN: 1,
    material: {
      id: "synthetic-material",
      name: "TEST ONLY material",
      evidenceIds: ["young", "tensile", "compressive"],
      youngMPa: 4000,
      tensileLimitMPa: 30,
      compressiveLimitMPa: 30,
      suitability: "matched",
      manufacturing: {
        printerId: "synthetic-printer",
        profileHash: "fixture-profile-v1",
        orientationDeg: [0, 0, 0],
        infillPercent: 100,
        temperatureC: 200,
        effectiveSection: "solid",
      },
    },
    safetyFactor: 2,
    maxDisplacementMm: 2,
    evidence,
    assignments: {
      lengthMm: "length",
      widthMm: "width",
      heightMm: "height",
      forceN: "force",
      "material.youngMPa": "young",
      "material.tensileLimitMPa": "tensile",
      "material.compressiveLimitMPa": "compressive",
      safetyFactor: "sf",
      maxDisplacementMm: "disp",
    },
    assumptions: [
      { code: "static-load", confirmed: true, evidenceIds: ["force"] },
      { code: "ideal-support", confirmed: true, evidenceIds: [] },
      { code: "linear-elastic", confirmed: true, evidenceIds: ["young"] },
      { code: "homogeneous-equivalent-section", confirmed: true, evidenceIds: ["young"] },
      { code: "negligible-shear-deformation", confirmed: true, evidenceIds: [] },
      { code: "no-lateral-instability", confirmed: true, evidenceIds: [] },
    ],
  };
}

export function syntheticEulerColumnInput(): StrengthInput {
  const base = syntheticInput("axial-rectangle-v1");
  return {
    ...base,
    method: "euler-column-buckling-v1",
    lengthMm: 200,
    widthMm: 20,
    heightMm: 10,
    forceN: -100,
    effectiveLengthFactor: 1,
    material: {
      ...base.material,
      evidenceIds: [...base.material.evidenceIds, "elastic-limit"],
      youngMPa: 2000,
      elasticLimitMPa: 20,
      compressiveLimitMPa: 30,
    },
    evidence: [
      ...base.evidence.map((item) => item.id === "length" ? { ...item, value: 200 }
        : item.id === "width" ? { ...item, value: 20 }
          : item.id === "height" ? { ...item, value: 10 }
            : item.id === "force" ? { ...item, value: -100 }
              : item.id === "young" ? { ...item, value: 2000 }
                : item),
      { id: "elastic-limit", label: "TEST ONLY elastic limit", status: "sourced", unit: "MPa", value: 20, sourceUrl: "https://example.invalid/test-material", sourceLocator: "synthetic fixture", dependsOn: [] },
      { id: "effective-length", label: "TEST ONLY effective length factor", status: "sourced", unit: "ratio", value: 1, sourceUrl: "https://example.invalid/test-boundary", sourceLocator: "synthetic fixture", dependsOn: [] },
    ],
    assignments: { ...base.assignments, "material.youngMPa": "young", forceN: "force", "material.elasticLimitMPa": "elastic-limit", effectiveLengthFactor: "effective-length" },
    assumptions: [
      { code: "static-load", confirmed: true, evidenceIds: ["force"] },
      { code: "centred-axial-compression", confirmed: true, evidenceIds: ["force"] },
      { code: "straight-prismatic-column", confirmed: true, evidenceIds: ["length", "width", "height"] },
      { code: "ideal-effective-length-factor", confirmed: true, evidenceIds: ["effective-length"] },
      { code: "linear-elastic", confirmed: true, evidenceIds: ["young", "elastic-limit"] },
      { code: "homogeneous-equivalent-section", confirmed: true, evidenceIds: ["young"] },
    ],
  };
}

export function conditionalSyntheticInput(method: RectangularMethodId): StrengthInput {
  const input = syntheticInput(method);
  return { ...input, material: { ...input.material, suitability: "unconfirmed" } };
}

export function syntheticPlateInput(overrides: Partial<StrengthInput> = {}): StrengthInput {
  const withForce = syntheticInput("simply-supported-plate-uniform-pressure-v1");
  const { forceN: _forceN, ...base } = withForce;
  const pressure = { id: "pressure", label: "TEST ONLY pressure", status: "assumed" as const, unit: "MPa" as const, value: 0.001, dependsOn: [] };
  const poisson = { id: "poisson", label: "TEST ONLY Poisson ratio", status: "sourced" as const, unit: "ratio" as const, value: 0.3, sourceUrl: "https://example.invalid/test-material", sourceLocator: "synthetic fixture", dependsOn: [] };
  return {
    ...base,
    goal: "Synthetic uniformly loaded plate",
    lengthMm: 40,
    widthMm: 40,
    heightMm: 2,
    pressureMPa: 0.001,
    poissonRatio: 0.3,
    material: { ...base.material, youngMPa: 2_000 },
    maxDisplacementMm: 0.1,
    evidence: [
      ...base.evidence.filter((item) => item.id !== "force").map((item) => {
        if (item.id === "length" || item.id === "width") return { ...item, value: 40 };
        if (item.id === "height") return { ...item, value: 2 };
        if (item.id === "young") return { ...item, value: 2_000 };
        if (item.id === "disp") return { ...item, value: 0.1 };
        return item;
      }),
      pressure,
      poisson,
    ],
    assignments: {
      ...Object.fromEntries(Object.entries(base.assignments).filter(([path]) => path !== "forceN")),
      pressureMPa: pressure.id,
      poissonRatio: poisson.id,
    },
    assumptions: [
      { code: "static-load", confirmed: true, evidenceIds: [pressure.id] },
      { code: "uniform-pressure", confirmed: true, evidenceIds: [pressure.id] },
      { code: "ideal-simply-supported-four-edges", confirmed: true, evidenceIds: [] },
      { code: "linear-elastic", confirmed: true, evidenceIds: ["young"] },
      { code: "homogeneous-isotropic-equivalent-plate", confirmed: true, evidenceIds: ["young", poisson.id] },
      { code: "thin-plate-kinematics", confirmed: true, evidenceIds: [] },
    ],
    ...overrides,
  };
}

export function withAssignedValue(input: StrengthInput, path: string, value: number): StrengthInput {
  const evidenceId = input.assignments[path];
  if (!evidenceId) throw new Error(`Fixture has no assignment for ${path}`);
  const evidence = input.evidence.map((item) => item.id === evidenceId ? { ...item, value } : item);
  if (path.startsWith("material.")) {
    const key = path.slice("material.".length);
    return { ...input, material: { ...input.material, [key]: value }, evidence };
  }
  return { ...input, [path]: value, evidence };
}
