import assert from "node:assert/strict";
import test from "node:test";

import { calculateFastenerMember } from "./fastener-member-calculate.ts";
import { fastenerMemberFixture } from "./fastener-member-fixtures.test.ts";

test("checks fastener tension, shear and the NASA combined-load interaction", () => {
  const result = calculateFastenerMember(fastenerMemberFixture());
  assert.equal(result.status, "pass");
  assert.equal(result.stressMPa?.tension, 50);
  assert.ok(Math.abs(result.stressMPa!.shear - 500 / (Math.PI * 9)) < 1e-12);
  assert.equal(result.loadRatio?.tension, 0.2);
  assert.ok(Math.abs(result.loadRatio!.shear - (500 * 2) / (300 * Math.PI * 9)) < 1e-12);
  assert.ok(Math.abs(result.interactionValue! - (result.loadRatio!.tension ** 2 + result.loadRatio!.shear ** 3)) < 1e-12);
  assert.match(result.checkedScope, /R_t\^2 \+ R_s\^3/i);
});

test("combined loading can fail while each component ratio is below one", () => {
  const input = fastenerMemberFixture();
  input.geometry.shearAreaPerPlaneMm2 = 20;
  input.loads = { axialTensionN: 4_000, transverseShearN: 2_400 };
  for (const [id, value] of [
    ["geometry.shearAreaPerPlaneMm2", 20],
    ["loads.axialTensionN", 4_000],
    ["loads.transverseShearN", 2_400],
  ] as const) input.evidence.find((item) => item.id === id)!.value = value;
  const result = calculateFastenerMember(input);
  assert.equal(result.loadRatio?.tension, 0.8);
  assert.equal(result.loadRatio?.shear, 0.8);
  assert.ok(result.interactionValue! > 1);
  assert.equal(result.status, "fail");
  assert.ok(result.issues.some((issue) => issue.code === "COMBINED_LOAD_LIMIT_EXCEEDED"));
});

test("double shear uses both explicitly confirmed shear planes", () => {
  const single = fastenerMemberFixture();
  const double = structuredClone(single);
  double.geometry.shearPlaneCount = 2;
  double.evidence.find((item) => item.id === "geometry.shearPlaneCount")!.value = 2;
  assert.equal(calculateFastenerMember(double).stressMPa!.shear, calculateFastenerMember(single).stressMPa!.shear / 2);
});

test("a pure shear case does not require combined-interaction acceptance", () => {
  const input = fastenerMemberFixture();
  input.loads.axialTensionN = 0;
  input.evidence.find((item) => item.id === "loads.axialTensionN")!.value = 0;
  input.assumptions = input.assumptions.filter((item) => item.code !== "interaction-criterion-accepted");
  const result = calculateFastenerMember(input);
  assert.equal(result.status, "pass");
  assert.equal(result.stressMPa?.tension, 0);
  assert.ok(!result.issues.some((issue) => issue.code === "INTERACTION_CRITERION_UNCONFIRMED"));
});

test("requires traceable material limits and effective areas", () => {
  const input = fastenerMemberFixture();
  input.evidence = input.evidence.map((item) => {
    if (item.id !== "material.shearLimitMPa" && item.id !== "geometry.tensileStressAreaMm2") return item;
    const { sourceUrl: _sourceUrl, sourceHash: _sourceHash, ...rest } = item;
    return { ...rest, status: "assumed" as const };
  });
  const result = calculateFastenerMember(input);
  assert.equal(result.status, "needs-input");
  assert.ok(result.issues.some((issue) => issue.code === "MATERIAL_LIMIT_EVIDENCE_REQUIRED"));
  assert.ok(result.issues.some((issue) => issue.code === "EFFECTIVE_AREA_EVIDENCE_REQUIRED"));
});

test("rejects an effective area larger than the nominal shank area", () => {
  const input = fastenerMemberFixture();
  input.geometry.tensileStressAreaMm2 = 30;
  input.evidence.find((item) => item.id === "geometry.tensileStressAreaMm2")!.value = 30;
  const result = calculateFastenerMember(input);
  assert.equal(result.status, "unsupported");
  assert.ok(result.issues.some((issue) => issue.code === "EFFECTIVE_AREA_EXCEEDS_SHANK"));
});

test("unconfirmed applicability remains conditional and exclusions stay visible", () => {
  const input = fastenerMemberFixture();
  input.assumptions = input.assumptions.map((item) => item.code === "no-fastener-bending" ? { ...item, confirmed: false } : item);
  const result = calculateFastenerMember(input);
  assert.equal(result.status, "conditional");
  assert.ok(result.unchecked.includes("fastener bending from joint gaps, shims, eccentricity or flange rotation"));
});

test("schema rejects a no-load request and unknown shear-plane location", async () => {
  const { fastenerMemberInputSchema } = await import("./fastener-member-schemas.ts");
  const input = fastenerMemberFixture();
  input.loads = { axialTensionN: 0, transverseShearN: 0 };
  input.evidence.find((item) => item.id === "loads.axialTensionN")!.value = 0;
  input.evidence.find((item) => item.id === "loads.transverseShearN")!.value = 0;
  assert.equal(fastenerMemberInputSchema.safeParse(input).success, false);
  assert.equal(fastenerMemberInputSchema.safeParse({ ...fastenerMemberFixture(), geometry: { ...fastenerMemberFixture().geometry, shearPlaneLocation: "unknown" } }).success, false);
});
