import assert from "node:assert/strict";
import test from "node:test";

import { calculateTongueRoot } from "./tongue-root-calculate.ts";
import { tongueRootFixture } from "./tongue-root-fixtures.test.ts";
import { tongueRootInputSchema } from "./tongue-root-schemas.ts";

test("tongue-root beam screen calculates bending, maximum shear and Timoshenko tip deflection", () => {
  const input = tongueRootFixture();
  const result = calculateTongueRoot(input);
  assert.equal(result.status, "conditional", "even a root screen must never pass the whole joint");
  assert.equal(result.stressMPa?.rootBending, 4.8);
  assert.equal(result.stressMPa?.maximumTransverseShear, 0.3);
  assert.ok(Math.abs(result.deflectionMm!.bending - 0.128) < 1e-12);
  const expectedShearDeflection = 10 * 20 / ((5 / 6) * 700 * 50);
  assert.ok(Math.abs(result.deflectionMm!.shear - expectedShearDeflection) < 1e-12);
  assert.ok(Math.abs(result.deflectionMm!.total - (0.128 + expectedShearDeflection)) < 1e-12);
  assert.equal(result.utilization?.governing, result.utilization?.bending);
  assert.match(result.checkedScope, /never a pass/);
  assert.ok(result.unchecked.some((item) => item.includes("groove wall bearing")));
});

test("tongue-root screen fails when root bending or deflection exceeds the supplied limit", () => {
  const input = tongueRootFixture();
  input.loads.transverseForceN = 100;
  input.evidence.find((item) => item.id === "loads.transverseForceN")!.value = 100;
  input.maxDeflectionMm = 0.5;
  input.evidence.find((item) => item.id === "maxDeflectionMm")!.value = 0.5;
  const result = calculateTongueRoot(input);
  assert.equal(result.status, "fail");
  assert.ok(result.issues.some((issue) => issue.code === "ROOT_BENDING_LIMIT_EXCEEDED"));
  assert.ok(result.issues.some((issue) => issue.code === "ROOT_DEFLECTION_LIMIT_EXCEEDED"));
});

test("tongue-root input requires traceable evidence and linked material evidence", () => {
  const input = tongueRootFixture();
  const evidence = input.evidence.find((item) => item.id === "material.youngModulusMPa")!;
  input.material.evidenceIds = input.material.evidenceIds.filter((id) => id !== evidence.id);
  assert.doesNotThrow(() => tongueRootInputSchema.parse(input));
  assert.equal(calculateTongueRoot(input).status, "needs-input");

  input.material.evidenceIds.push(evidence.id);
  evidence.status = "assumed";
  tongueRootInputSchema.parse(input);
  assert.equal(calculateTongueRoot(input).status, "needs-input");
});

test("tongue-root profile identity must be a Workbench SHA-256", () => {
  const input = tongueRootFixture();
  assert.doesNotThrow(() => tongueRootInputSchema.parse(input));
  input.material.manufacturing.profileHash = "not-a-profile-hash";
  assert.throws(() => tongueRootInputSchema.parse(input), /SHA-256 hash of a registered Workbench profile/);
});

test("tongue-root screen is unsupported when the print profile mismatches the supplied allowables", () => {
  const input = tongueRootFixture();
  input.material.suitability = "mismatch";
  assert.equal(calculateTongueRoot(input).status, "unsupported");
});

test("tongue-root report stays conditional when the print profile has no effective-section qualification", () => {
  const input = tongueRootFixture();
  input.material.manufacturing.effectiveSection = "unknown";
  const result = calculateTongueRoot(input);
  assert.equal(result.status, "conditional");
  assert.ok(result.issues.some((issue) => issue.code === "EFFECTIVE_SECTION_UNCONFIRMED"));
});
