import assert from "node:assert/strict";
import test from "node:test";

import { calculate } from "./calculate.ts";
import { listStrengthMethods } from "./methods.ts";
import { conditionalSyntheticInput, syntheticEulerColumnInput, syntheticInput, syntheticPlateInput } from "./fixtures.test.ts";

test("method catalogue publishes versioned passports", () => {
  const methods = listStrengthMethods();
  assert.deepEqual(methods.map((item) => item.id), ["axial-rectangle-v1", "cantilever-tip-rectangle-v1", "simply-supported-plate-uniform-pressure-v1", "euler-column-buckling-v1", "single-fastener-plate-v1", "fastener-member-v1", "tongue-root-transverse-v1", "threaded-receiver-axial-v1", "heat-set-insert-retention-v1", "fastener-group-elastic-in-plane-v1", "planar-section-resultants-v1"]);
  assert.deepEqual(methods.map((item) => item.version), ["1.0.0", "1.0.0", "1.0.0", "1.0.0", "1.0.0", "1.0.0", "1.0.0", "1.0.0", "1.0.0", "1.0.0", "1.3.0"]);
  assert.ok(methods.every((item) => item.sourceUrls.every((url) => url.startsWith("https://"))));
});

test("axial reference case", () => {
  const result = calculate(syntheticInput("axial-rectangle-v1"));
  assert.equal(result.status, "pass");
  assert.equal(result.stressMPa, 0.02);
  assert.equal(result.displacementMm, 0.0005);
  assert.equal(result.strengthUtilization, 0.02 / 15);
  assert.equal(result.displacementUtilization, 0.00025);
});

test("cantilever reference case", () => {
  const result = calculate(syntheticInput("cantilever-tip-rectangle-v1"));
  assert.equal(result.status, "pass");
  assert.ok(Math.abs(result.stressMPa! - 2.4) < 1e-12);
  assert.ok(Math.abs(result.displacementMm! - 0.8) < 1e-12);
});

test("elastic Euler buckling uses the weak rectangular axis and checks crushing separately", () => {
  const input = syntheticEulerColumnInput();
  const result = calculate(input);
  assert.equal(result.status, "pass");
  assert.ok(Math.abs(result.buckling!.secondMomentMm4 - 1666.6666666666667) < 1e-10);
  assert.ok(Math.abs(result.buckling!.criticalLoadN - 822.4670334241132) < 1e-9);
  assert.ok(Math.abs(result.buckling!.criticalStressMPa - 4.112335167120566) < 1e-10);
  assert.ok(Math.abs(result.buckling!.slendernessRatio - 69.2820323027551) < 1e-10);
  assert.ok(Math.abs(result.buckling!.bucklingUtilization - 200 / 822.4670334241132) < 1e-12);
  assert.ok(Math.abs(result.buckling!.compressiveUtilization - 100 / 3000) < 1e-12);

  const shortColumn = calculate({
    ...input,
    lengthMm: 20,
    evidence: input.evidence.map((item) => item.id === "length" ? { ...item, value: 20 } : item),
  });
  assert.equal(shortColumn.status, "unsupported");
  assert.ok(shortColumn.issues.some((issue) => issue.code === "EULER_OUTSIDE_ELASTIC_RANGE"));
});

test("Euler column calculation requires traceable boundary and elastic-limit inputs", () => {
  const input = syntheticEulerColumnInput();
  const untraceable = calculate({
    ...input,
    evidence: input.evidence.map((item) => item.id === "effective-length" ? { ...item, status: "assumed" } : item),
  });
  assert.equal(untraceable.status, "needs-input");
  assert.ok(untraceable.issues.some((issue) => issue.code === "TRACEABLE_COLUMN_INPUT_REQUIRED"));
});

test("simply-supported rectangular plate reports centre moments, stress and deflection", () => {
  const result = calculate(syntheticPlateInput());

  assert.equal(result.status, "pass");
  assert.equal(result.method, "simply-supported-plate-uniform-pressure-v1");
  assert.equal(result.methodVersion, "1.0.0");
  assert.ok(Math.abs(result.stressMPa! - 0.114927314218) < 2e-12);
  assert.ok(Math.abs(result.displacementMm! - 0.007097742569) < 2e-12);
  assert.ok(Math.abs(result.plate!.centerMomentsN.x - 0.076618209479) < 2e-12);
  assert.ok(Math.abs(result.plate!.centerSurfaceStressMPa.y - 0.114927314218) < 2e-12);
  assert.equal(result.plate!.seriesMaxOddIndex, 401);
  assert.ok(result.strengthUtilization! < 1);
  assert.ok(result.displacementUtilization! < 1);
  assert.match(result.checkedScope, /simply supported rectangular plate/i);
});

test("plate passport rejects thick and large-deflection cases without hiding calculated values", () => {
  const thick = calculate(syntheticPlateInput({
    heightMm: 5,
    evidence: syntheticPlateInput().evidence.map((item) => item.id === "height" ? { ...item, value: 5 } : item),
  }));
  assert.equal(thick.status, "unsupported");
  assert.ok(thick.issues.some((issue) => issue.code === "THICKNESS_OUTSIDE_THIN_PLATE_LIMIT"));
  assert.ok(thick.stressMPa !== undefined);

  const base = syntheticPlateInput();
  const large = calculate({
    ...base,
    pressureMPa: 0.2,
    evidence: base.evidence.map((item) => item.id === "pressure" ? { ...item, value: 0.2 } : item),
  });
  assert.equal(large.status, "unsupported");
  assert.ok(large.issues.some((issue) => issue.code === "DEFLECTION_OUTSIDE_LINEAR_PLATE_LIMIT"));
  assert.ok(large.displacementMm! > base.heightMm! / 2);
});

test("plate pressure and Poisson ratio require matching evidence", () => {
  const base = syntheticPlateInput();
  const { poissonRatio: _poissonRatio, ...withoutPoisson } = base;
  const missing = calculate({
    ...withoutPoisson,
    assignments: Object.fromEntries(Object.entries(base.assignments).filter(([path]) => path !== "poissonRatio")),
  });
  assert.equal(missing.status, "needs-input");
  assert.ok(missing.issues.some((issue) => issue.code === "MISSING_INPUT" && /poissonRatio/.test(issue.message)));

  const unsourced = calculate({
    ...base,
    evidence: base.evidence.map((item) => {
      if (item.id !== "poisson") return item;
      const { sourceUrl: _sourceUrl, sourceLocator: _sourceLocator, ...rest } = item;
      return { ...rest, status: "assumed" as const };
    }),
  });
  assert.equal(unsourced.status, "needs-input");
  assert.ok(unsourced.issues.some((issue) => issue.code === "POISSON_EVIDENCE_REQUIRED"));

  const unknownSupport = calculate({
    ...base,
    assumptions: base.assumptions.map((item) => item.code === "ideal-simply-supported-four-edges" ? { ...item, confirmed: false } : item),
  });
  assert.equal(unknownSupport.status, "conditional");
});

test("cantilever formula scales independently with force and section axes", () => {
  const base = syntheticInput("cantilever-tip-rectangle-v1");
  const nominal = calculate(base);
  const doubledForce = calculate(withAssignedValue(base, "forceN", "force", 2));
  const doubledHeight = calculate(withAssignedValue(base, "heightMm", "height", 10));
  const swapped = calculate({
    ...base,
    widthMm: 5,
    heightMm: 10,
    evidence: base.evidence.map((item) => item.id === "width" ? { ...item, value: 5 } : item.id === "height" ? { ...item, value: 10 } : item),
  });
  assert.equal(doubledForce.stressMPa, nominal.stressMPa! * 2);
  assert.equal(doubledForce.displacementMm, nominal.displacementMm! * 2);
  assert.equal(doubledHeight.stressMPa, nominal.stressMPa! / 4);
  assert.equal(doubledHeight.displacementMm, nominal.displacementMm! / 8);
  assert.notEqual(swapped.stressMPa, nominal.stressMPa);
  assert.notEqual(swapped.displacementMm, nominal.displacementMm);
});

test("unsupported applicability outranks missing data", () => {
  const input = syntheticInput("axial-rectangle-v1");
  const { youngMPa: _young, ...material } = input.material;
  const result = calculate(withAssignedValue({ ...input, material }, "forceN", "force", -1));
  assert.equal(result.status, "unsupported");
  assert.ok(result.issues.some((issue) => issue.code === "AXIAL_COMPRESSION_UNSUPPORTED"));
});

test("missing modulus needs input and a range is not guessed", () => {
  const input = syntheticInput("axial-rectangle-v1");
  const { youngMPa: _young, ...material } = input.material;
  const missing = calculate({ ...input, material, assignments: Object.fromEntries(Object.entries(input.assignments).filter(([path]) => path !== "material.youngMPa")) });
  assert.equal(missing.status, "needs-input");
  const ranged = calculate({ ...input, evidence: input.evidence.map((item) => item.id === "force" ? { ...item, range: [1, 2] as [number, number] } : item) });
  assert.equal(ranged.status, "needs-input");
  assert.ok(ranged.issues.some((issue) => issue.code === "RANGE_REQUIRES_SCENARIO"));

  const unknown = calculate({
    ...input,
    evidence: input.evidence.map((item) => item.id === "force" ? { ...item, status: "unknown" as const } : item),
  });
  assert.equal(unknown.status, "needs-input");
  assert.ok(unknown.issues.some((issue) => issue.code === "UNKNOWN_EVIDENCE_REQUIRES_INPUT"));
});

test("product applicability rejects a stocky or excessively deforming cantilever", () => {
  const stocky = calculate(withAssignedValue(syntheticInput("cantilever-tip-rectangle-v1"), "heightMm", "height", 6));
  assert.equal(stocky.status, "unsupported");
  assert.ok(stocky.issues.some((issue) => issue.code === "SLENDERNESS_OUTSIDE_PRODUCT_LIMIT"));

  const long = withAssignedValue(syntheticInput("cantilever-tip-rectangle-v1"), "lengthMm", "length", 200);
  const excessive = calculate(long);
  assert.equal(excessive.status, "unsupported");
  assert.ok(excessive.issues.some((issue) => issue.code === "DEFLECTION_RATIO_OUTSIDE_PRODUCT_LIMIT"));
});

test("failed criterion remains fail when material evidence is unconfirmed", () => {
  const input = withAssignedValue(conditionalSyntheticInput("axial-rectangle-v1"), "forceN", "force", 1_000);
  const result = calculate(input);
  assert.equal(result.status, "fail");
  assert.ok(result.strengthUtilization! > 1);
  assert.ok(result.issues.some((issue) => issue.code === "MATERIAL_UNCONFIRMED"));
});

test("unconfirmed applicability produces a conditional result and exclusions remain visible", () => {
  const result = calculate(conditionalSyntheticInput("cantilever-tip-rectangle-v1"));
  assert.equal(result.status, "conditional");
  assert.deepEqual(result.unchecked.slice(0, 5), [
    "attachment/support integrity",
    "local stress concentrations",
    "shear strength",
    "long-term behavior",
    "lateral-torsional instability outside the confirmed idealization",
  ]);
});

test("calculation refuses non-finite results", () => {
  const input = withAssignedValue(syntheticInput("cantilever-tip-rectangle-v1"), "lengthMm", "length", Number.MAX_VALUE);
  const overflow = calculate(input);
  assert.equal(overflow.status, "unsupported");
  assert.ok(overflow.issues.some((issue) => issue.code === "COMPUTATION_OVERFLOW"));
  assert.equal(overflow.displacementMm, undefined);
});

test("a zero displacement limit fails without serializing infinity", () => {
  const input = withAssignedValue(syntheticInput("axial-rectangle-v1"), "maxDisplacementMm", "disp", 0);
  const result = calculate(input);
  assert.equal(result.status, "fail");
  assert.equal(result.displacementUtilization, undefined);
  assert.ok(result.issues.some((issue) => issue.code === "DISPLACEMENT_LIMIT_EXCEEDED"));
});

function withAssignedValue(
  input: ReturnType<typeof syntheticInput>,
  path: "lengthMm" | "widthMm" | "heightMm" | "forceN" | "maxDisplacementMm",
  evidenceId: string,
  value: number,
): ReturnType<typeof syntheticInput> {
  return {
    ...input,
    [path]: value,
    evidence: input.evidence.map((item) => item.id === evidenceId ? { ...item, value } : item),
  };
}
