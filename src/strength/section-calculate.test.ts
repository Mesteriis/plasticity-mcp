import assert from "node:assert/strict";
import test from "node:test";

import { calculateSection } from "./section-calculate.ts";
import { sectionScenarioInputSchema } from "./section-schemas.ts";
import type { SectionScenarioInput } from "./section-contracts.ts";
import { circleLoop, rectangleLoop, sectionScenarioFixture } from "./section-fixtures.test.ts";
import { integrateSection, type Point2, type SectionLoop } from "./section-geometry.ts";

test("section schema is strict and rejects duplicate load IDs and missing evidence", () => {
  const input = sectionScenarioFixture();
  assert.equal(sectionScenarioInputSchema.safeParse({ ...input, surprise: true }).success, false);
  assert.equal(sectionScenarioInputSchema.safeParse({ ...input, pointForces: [...input.pointForces, input.pointForces[0]!] }).success, false);
  const loadEvidenceIds = new Set(input.pointForces.flatMap((force) => force.evidenceIds));
  const withoutLoads = {
    ...input,
    pointForces: [],
    evidence: input.evidence.filter((item) => !loadEvidenceIds.has(item.id)),
    assignments: Object.fromEntries(Object.entries(input.assignments).filter(([path]) => !path.startsWith("pointForces."))),
    assumptions: input.assumptions.map((assumption) => ({ ...assumption, evidenceIds: assumption.evidenceIds.filter((id) => !loadEvidenceIds.has(id)) })),
  };
  assert.equal(sectionScenarioInputSchema.safeParse(withoutLoads).success, false);
  assert.equal(sectionScenarioInputSchema.safeParse({ ...input, evidence: input.evidence.slice(1) }).success, false);
  assert.equal(sectionScenarioInputSchema.safeParse(input).success, true);
});

test("zero force remains a valid sourced physical input", () => {
  const input = sectionScenarioFixture({ forceN: [0, 0, 0] });
  assert.equal(sectionScenarioInputSchema.safeParse(input).success, true);
  const result = calculateSection(input);
  assert.equal(result.status, "pass");
  assert.deepEqual(result.normalStressMPa, { minimum: 0, maximum: 0 });
});

test("calculates pure axial tension", () => {
  const result = calculateSection(sectionScenarioFixture({ forceN: [0, 0, 100] }));
  assert.equal(result.status, "pass");
  assert.equal(result.resultants.axialN, 100);
  assert.deepEqual(result.normalStressMPa, { minimum: 2.5, maximum: 2.5 });
  assert.equal(result.tensileUtilization, 0.5);
  assert.equal(result.compressiveUtilization, 0);
});

test("calculates bending independently about each section axis", () => {
  const aboutX = calculateSection(sectionScenarioFixture({ forceN: [0, 0, 0], freeMoments: [[100, 0, 0]] }));
  near(aboutX.normalStressMPa!.minimum, -3.75);
  near(aboutX.normalStressMPa!.maximum, 3.75);
  assert.equal(aboutX.resultants.bendingXNmm, 100);

  const aboutY = calculateSection(sectionScenarioFixture({ forceN: [0, 0, 0], freeMoments: [[0, 100, 0]] }));
  near(aboutY.normalStressMPa!.minimum, -1.5);
  near(aboutY.normalStressMPa!.maximum, 1.5);
  assert.equal(aboutY.resultants.bendingYNmm, 100);
});

test("uses the general inertia matrix for unsymmetric bending", () => {
  const angle = Math.PI / 6;
  const loops = [rotateLoop(rectangleLoop(-5, -2, 10, 4), angle)];
  const input = sectionScenarioFixture({ loops, forceN: [0, 0, 0], freeMoments: [[100, 50, 0]] });
  const result = calculateSection(input);
  const { ixxMm4: ixx, iyyMm4: iyy, ixyMm4: ixy } = input.properties;
  const determinant = ixx * iyy - ixy ** 2;
  const a = -(ixx * 50 + ixy * 100) / determinant;
  const b = (ixy * 50 + iyy * 100) / determinant;
  const values = loops[0]!.segments.map((segment) => segment.kind === "line" ? segment.start : [0, 0] as Point2)
    .map(([x, y]) => a * x + b * y);
  near(result.normalStressMPa!.minimum, Math.min(...values), 1e-11);
  near(result.normalStressMPa!.maximum, Math.max(...values), 1e-11);
  assert.ok(Math.abs(ixy) > 100);
});

test("is invariant under rigid world translation and rotation", () => {
  const base = sectionScenarioFixture({ forceN: [10, 0, 100], pointMm: [0, 10, 0] });
  const translated: SectionScenarioInput = {
    ...base,
    frame: { ...base.frame, originMm: [20, -4, 8] },
    pointForces: base.pointForces.map((force) => ({ ...force, pointMm: [20, 6, 8] })),
    evidence: base.evidence.map((item) => {
      const replacements: Record<string, number> = {
        "pointForces.load-1.pointMm.x": 20,
        "pointForces.load-1.pointMm.y": 6,
        "pointForces.load-1.pointMm.z": 8,
      };
      const path = Object.entries(base.assignments).find(([, id]) => id === item.id)?.[0];
      const replacement = path === undefined ? undefined : replacements[path];
      return replacement === undefined ? item : { ...item, value: replacement };
    }),
  };
  const rotated: SectionScenarioInput = {
    ...base,
    frame: { originMm: [0, 0, 0], normal: [0, 0, 1], xDirection: [0, 1, 0] },
    pointForces: base.pointForces.map((force) => ({ ...force, forceN: [0, 10, 100], pointMm: [-10, 0, 0] })),
    evidence: remapLoadEvidence(base, { forceN: [0, 10, 100], pointMm: [-10, 0, 0] }),
  };
  const reference = calculateSection(base);
  assert.deepEqual(calculateSection(translated).resultants, reference.resultants);
  assert.deepEqual(calculateSection(translated).normalStressMPa, reference.normalStressMPa);
  assert.deepEqual(calculateSection(rotated).resultants, reference.resultants);
  assert.deepEqual(calculateSection(rotated).normalStressMPa, reference.normalStressMPa);
});

test("derives a bending moment from force application point", () => {
  const result = calculateSection(sectionScenarioFixture({ forceN: [0, 0, 10], pointMm: [5, 0, 0] }));
  assert.equal(result.resultants.bendingXNmm, 0);
  assert.equal(result.resultants.bendingYNmm, -50);
  assert.equal(result.resultants.torsionNmm, 0);
});

test("checks direct shear for a proven solid rectangle", () => {
  const result = calculateSection(sectionScenarioFixture({ forceN: [20, 0, 0] }));
  assert.equal(result.status, "pass");
  near(result.shearStressMPa!, 0.75);
  near(result.shearUtilization!, 0.3);

  const missing = calculateSection(sectionScenarioFixture({ forceN: [20, 0, 0], shearLimitMPa: null }));
  assert.equal(missing.status, "needs-input");
  assert.ok(missing.issues.some((issue) => issue.code === "MISSING_SHEAR_LIMIT"));

});

test("checks maximum direct shear for an exact solid circle", () => {
  const loops = [circleLoop([4, -2], 3)];
  const forceN: [number, number, number] = [90, 0, 0];
  const result = calculateSection(sectionScenarioFixture({ loops, forceN, pointMm: [4, -2, 0], shearLimitMPa: 100 }));

  assert.equal(result.status, "pass");
  assert.equal(result.methodVersion, "1.3.0");
  near(result.shearStressMPa!, 4 * 90 / (3 * 9 * Math.PI));
  assert.equal(result.shearModel, "solid-circle");
  assert.match(result.checkedScope, /solid circular section/i);
});

test("circular direct shear is invariant to the in-plane load direction", () => {
  const loops = [circleLoop([0, 0], 3)];
  const alongX = calculateSection(sectionScenarioFixture({ loops, forceN: [12, 0, 0], shearLimitMPa: 100 }));
  const alongY = calculateSection(sectionScenarioFixture({ loops, forceN: [0, -12, 0], shearLimitMPa: 100 }));

  near(alongX.shearStressMPa!, alongY.shearStressMPa!);
  assert.equal(alongX.shearModel, "solid-circle");
  assert.equal(alongY.shearModel, "solid-circle");
});

test("recognizes a solid circle assembled from adjacent exact arcs", () => {
  const loops: SectionLoop[] = [{ segments: [
    { kind: "arc", center: [0, 0], radius: 4, startRadians: 0, sweepRadians: Math.PI },
    { kind: "arc", center: [0, 0], radius: 4, startRadians: Math.PI, sweepRadians: Math.PI },
  ] }];
  const result = calculateSection(sectionScenarioFixture({ loops, forceN: [0, 32, 0] }));

  assert.equal(result.status, "pass");
  near(result.shearStressMPa!, 4 * 32 / (3 * 16 * Math.PI));
  assert.equal(result.shearModel, "solid-circle");
});

test("checks maximum direct shear for an exact concentric circular annulus", () => {
  const outerRadius = 5;
  const innerRadius = 3;
  const loops = [circleLoop([2, 7], outerRadius), circleLoop([2, 7], innerRadius)];
  const forceN: [number, number, number] = [60, 80, 0];
  const result = calculateSection(sectionScenarioFixture({ loops, forceN, pointMm: [2, 7, 0], shearLimitMPa: 100 }));
  const area = Math.PI * (outerRadius ** 2 - innerRadius ** 2);
  const factor = 4 / 3 * (outerRadius ** 2 + outerRadius * innerRadius + innerRadius ** 2) /
    (outerRadius ** 2 + innerRadius ** 2);

  assert.equal(result.status, "conditional");
  near(result.shearStressMPa!, factor * 100 / area);
  assert.equal(result.shearModel, "concentric-circular-annulus");
  assert.match(result.checkedScope, /concentric circular annulus/i);
  assert.ok(result.issues.some((issue) => issue.code === "LOCAL_STRESS_CONCENTRATION_UNCHECKED"));
});

test("does not infer annular shear for an eccentric circular hole", () => {
  const loops = [circleLoop([0, 0], 5), circleLoop([0.5, 0], 3)];
  const result = calculateSection(sectionScenarioFixture({ loops, forceN: [100, 0, 0] }));

  assert.equal(result.status, "unsupported");
  assert.equal(result.shearStressMPa, undefined);
  assert.equal(result.shearModel, undefined);
  assert.ok(result.issues.some((issue) => issue.code === "SECTION_FAMILY_SHEAR_UNSUPPORTED"));
});

test("retains torsion and a simultaneous normal failure", () => {
  const result = calculateSection(sectionScenarioFixture({ forceN: [0, 0, 1_000], freeMoments: [[0, 0, 10]] }));
  assert.equal(result.status, "unsupported");
  assert.equal(result.resultants.torsionNmm, 10);
  assert.ok(result.tensileUtilization! > 1);
  assert.ok(result.issues.some((issue) => issue.code === "TORSION_SECTION_FAMILY_UNSUPPORTED"));
  assert.ok(result.issues.some((issue) => issue.code === "TENSILE_LIMIT_EXCEEDED"));
});

test("checks elastic torsional shear for an exact solid circle", () => {
  const radius = 3;
  const torqueNmm = 100;
  const loops = [circleLoop([0, 0], radius)];
  const result = calculateSection(sectionScenarioFixture({
    loops,
    forceN: [0, 0, 0],
    freeMoments: [[0, 0, torqueNmm]],
    shearLimitMPa: 10,
  }));

  assert.equal(result.status, "pass");
  assert.equal(result.methodVersion, "1.3.0");
  near(result.torsionalShearStressMPa!, torqueNmm * radius / (Math.PI * radius ** 4 / 2));
  assert.equal(result.torsionModel, "solid-circle");
  near(result.torsionUtilization!, result.torsionalShearStressMPa! / 5);
  assert.match(result.checkedScope, /torsional shear.*solid circular/i);
});

test("checks annular torsion and is invariant to torque sign", () => {
  const outerRadius = 5;
  const innerRadius = 3;
  const loops = [circleLoop([0, 0], outerRadius), circleLoop([0, 0], innerRadius)];
  const positive = calculateSection(sectionScenarioFixture({
    loops,
    forceN: [0, 0, 0],
    freeMoments: [[0, 0, 1_000]],
    shearLimitMPa: 100,
  }));
  const negative = calculateSection(sectionScenarioFixture({
    loops,
    forceN: [0, 0, 0],
    freeMoments: [[0, 0, -1_000]],
    shearLimitMPa: 100,
  }));
  const expected = 1_000 * outerRadius / (Math.PI * (outerRadius ** 4 - innerRadius ** 4) / 2);

  assert.equal(positive.status, "conditional");
  near(positive.torsionalShearStressMPa!, expected);
  near(negative.torsionalShearStressMPa!, expected);
  assert.equal(positive.torsionModel, "concentric-circular-annulus");
});

test("checks thin-walled uniform rectangular single-cell torsion with Bredt shear flow", () => {
  const loops = [rectangleLoop(-10, -5, 20, 10), rectangleLoop(-9, -4, 18, 8)];
  const result = calculateSection(sectionScenarioFixture({
    loops,
    forceN: [0, 0, 0],
    freeMoments: [[0, 0, 100]],
    shearLimitMPa: 10,
    thinWallAssumption: true,
  }));

  assert.equal(result.status, "conditional");
  assert.equal(result.methodVersion, "1.3.0");
  assert.equal(result.torsionModel, "thin-walled-rectangular-single-cell");
  near(result.torsionalMedianAreaMm2!, 171);
  near(result.torsionalWallThicknessMm!, 1);
  near(result.torsionalShearFlowNPerMm!, 100 / (2 * 171));
  near(result.torsionalShearStressMPa!, 100 / (2 * 171));
  near(result.torsionUtilization!, (100 / (2 * 171)) / 5);
  assert.match(result.checkedScope, /thin-walled rectangular single-cell/i);
  assert.ok(result.unchecked.includes("local stress concentration and net-section fracture around inner boundaries"));
});

test("keeps thin-wall torsion conditional until applicability is confirmed and rejects nonuniform cells", () => {
  const loops = [rectangleLoop(-10, -5, 20, 10), rectangleLoop(-9, -4, 18, 8)];
  const unconfirmed = calculateSection(sectionScenarioFixture({
    loops,
    forceN: [0, 0, 0],
    freeMoments: [[0, 0, 100]],
  }));
  assert.equal(unconfirmed.status, "conditional");
  assert.ok(unconfirmed.issues.some((issue) => issue.code === "THIN_WALLED_TORSION_ASSUMPTION_UNCONFIRMED"));

  const unequalWalls = [rectangleLoop(-10, -5, 20, 10), rectangleLoop(-8.5, -4, 17, 8)];
  const unsupported = calculateSection(sectionScenarioFixture({
    loops: unequalWalls,
    forceN: [0, 0, 0],
    freeMoments: [[0, 0, 100]],
    thinWallAssumption: true,
  }));
  assert.equal(unsupported.status, "unsupported");
  assert.equal(unsupported.torsionalShearStressMPa, undefined);
  assert.ok(unsupported.issues.some((issue) => issue.code === "TORSION_SECTION_FAMILY_UNSUPPORTED"));
});

test("keeps noncircular torsion and combined transverse shear plus torsion unsupported", () => {
  const rectangle = calculateSection(sectionScenarioFixture({ freeMoments: [[0, 0, 100]] }));
  assert.equal(rectangle.status, "unsupported");
  assert.equal(rectangle.torsionalShearStressMPa, undefined);
  assert.ok(rectangle.issues.some((issue) => issue.code === "TORSION_SECTION_FAMILY_UNSUPPORTED"));

  const combined = calculateSection(sectionScenarioFixture({
    loops: [circleLoop([0, 0], 3)],
    forceN: [20, 0, 0],
    freeMoments: [[0, 0, 100]],
    shearLimitMPa: 100,
  }));
  assert.equal(combined.status, "unsupported");
  assert.ok(combined.shearStressMPa !== undefined);
  assert.ok(combined.torsionalShearStressMPa !== undefined);
  assert.ok(combined.issues.some((issue) => issue.code === "COMBINED_SHEAR_TORSION_UNSUPPORTED"));
});

test("fails a circular torsion check above the allowable shear stress", () => {
  const result = calculateSection(sectionScenarioFixture({
    loops: [circleLoop([0, 0], 3)],
    forceN: [0, 0, 0],
    freeMoments: [[0, 0, 1_000]],
    shearLimitMPa: 5,
  }));

  assert.equal(result.status, "fail");
  assert.ok(result.torsionUtilization! > 1);
  assert.ok(result.issues.some((issue) => issue.code === "TORSIONAL_SHEAR_LIMIT_EXCEEDED"));
});

test("circular torsion requires a sourced or measured shear limit", () => {
  const result = calculateSection(sectionScenarioFixture({
    loops: [circleLoop([0, 0], 3)],
    forceN: [0, 0, 0],
    freeMoments: [[0, 0, 100]],
    shearLimitMPa: null,
  }));

  assert.equal(result.status, "needs-input");
  assert.ok(result.issues.some((issue) => issue.code === "MISSING_SHEAR_LIMIT"));
});

test("marks unconfirmed process and inner-loop nominal stress conditional", () => {
  const process = calculateSection(sectionScenarioFixture({ suitability: "unconfirmed" }));
  assert.equal(process.status, "conditional");
  assert.ok(process.issues.some((issue) => issue.code === "MATERIAL_UNCONFIRMED"));

  const holed = calculateSection(sectionScenarioFixture({ loops: [rectangleLoop(-5, -2, 10, 4), circleLoop([0, 0], 1)] }));
  assert.equal(holed.status, "conditional");
  assert.ok(holed.issues.some((issue) => issue.code === "LOCAL_STRESS_CONCENTRATION_UNCHECKED"));
});

test("keeps a concave outer boundary conditional", () => {
  const concave: SectionLoop = { segments: [
    { kind: "line", start: [0, 0], end: [6, 0] },
    { kind: "line", start: [6, 0], end: [6, 2] },
    { kind: "line", start: [6, 2], end: [2, 2] },
    { kind: "line", start: [2, 2], end: [2, 6] },
    { kind: "line", start: [2, 6], end: [0, 6] },
    { kind: "line", start: [0, 6], end: [0, 0] },
  ] };
  const result = calculateSection(sectionScenarioFixture({ loops: [concave], forceN: [0, 0, 10] }));
  assert.equal(result.status, "conditional");
  assert.ok(result.issues.some((issue) => issue.code === "CONCAVE_SECTION_SCOPE"));
});

test("reports invalid provenance as needs-input", () => {
  const input = sectionScenarioFixture();
  const result = calculateSection({ ...input, evidence: input.evidence.slice(1) });
  assert.equal(result.status, "needs-input");
  assert.ok(result.issues.some((issue) => issue.code === "INVALID_PROVENANCE"));
});

test("rejects section properties that do not match the exact boundary", () => {
  const input = sectionScenarioFixture();
  const result = calculateSection({
    ...input,
    properties: {
      ...input.properties,
      principal: { ...input.properties.principal, majorMm4: input.properties.principal.majorMm4 + 1 },
    },
  });
  assert.equal(result.status, "unsupported");
  assert.ok(result.issues.some((issue) => issue.code === "SECTION_PROPERTIES_MISMATCH"));
});

test("requires measured or sourced evidence for a shear limit", () => {
  const input = sectionScenarioFixture({ forceN: [20, 0, 0] });
  const shearEvidenceId = input.assignments["material.shearLimitMPa"]!;
  const result = calculateSection({
    ...input,
    evidence: input.evidence.map((item) => item.id === shearEvidenceId ? { ...item, status: "assumed" as const } : item),
  });
  assert.equal(result.status, "needs-input");
  assert.ok(result.issues.some((issue) => issue.code === "SHEAR_LIMIT_EVIDENCE_REQUIRED"));
});

test("rejects a parallel frame direction and non-finite resultant overflow", () => {
  const parallel = calculateSection({ ...sectionScenarioFixture(), frame: { originMm: [0, 0, 0], normal: [0, 0, 1], xDirection: [0, 0, 2] } });
  assert.equal(parallel.status, "unsupported");
  assert.equal(parallel.normalStressMPa, undefined);
  assert.ok(parallel.issues.some((issue) => issue.code === "INVALID_SECTION_FRAME"));

  const overflowInput = sectionScenarioFixture({ forceN: [Number.MAX_VALUE, Number.MAX_VALUE, 0], pointMm: [Number.MAX_VALUE, 0, 0] });
  const overflow = calculateSection(overflowInput);
  assert.equal(overflow.status, "unsupported");
  assert.equal(overflow.normalStressMPa, undefined);
  assert.ok(overflow.issues.some((issue) => issue.code === "COMPUTATION_OVERFLOW"));
});

function rotateLoop(loop: SectionLoop, radians: number): SectionLoop {
  const rotate = ([x, y]: Point2): Point2 => [
    x * Math.cos(radians) - y * Math.sin(radians),
    x * Math.sin(radians) + y * Math.cos(radians),
  ];
  return { segments: loop.segments.map((segment) => {
    if (segment.kind === "line") return { kind: "line" as const, start: rotate(segment.start), end: rotate(segment.end) };
    return { ...segment, center: rotate(segment.center), startRadians: segment.startRadians + radians };
  }) };
}

function remapLoadEvidence(
  input: SectionScenarioInput,
  values: { forceN: [number, number, number]; pointMm: [number, number, number] },
): SectionScenarioInput["evidence"] {
  const replacements = new Map<string, number>();
  for (const [index, axis] of (["x", "y", "z"] as const).entries()) {
    replacements.set(`pointForces.load-1.forceN.${axis}`, values.forceN[index]!);
    replacements.set(`pointForces.load-1.pointMm.${axis}`, values.pointMm[index]!);
  }
  return input.evidence.map((item) => {
    const path = Object.entries(input.assignments).find(([, id]) => id === item.id)?.[0];
    return path && replacements.has(path) ? { ...item, value: replacements.get(path)! } : item;
  });
}

function near(actual: number, expected: number, tolerance = 1e-12): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected} within ${tolerance}`);
}
