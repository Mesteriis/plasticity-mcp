import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { exactMaterialCouponProcessSchema, MaterialCouponQualificationStore } from "../src/strength/material-qualification.ts";
import { StrengthStore } from "../src/strength/store.ts";
import { materializeRectangularCouponInput, rectangularCouponInputSchema } from "../src/strength/rectangular-coupon.ts";
import { calculate } from "../src/strength/calculate.ts";
import { sizeMember } from "../src/strength/size-member.ts";
import { assertCouponCalculation, parseMaterialCouponArgs, syntheticCouponFixture, syntheticCouponScenario } from "./verify-material-coupon-live.ts";

test("material coupon runner is inert by default and guards live stores", () => {
  assert.equal(parseMaterialCouponArgs([]).help, true);
  const result = spawnSync(process.execPath, [new URL("./verify-material-coupon-live.ts", import.meta.url).pathname], { encoding: "utf8" });
  assert.equal(result.status, 0); assert.match(result.stdout, /No args\/--help are inert/);
  const args = ["--target", "experimental", "--allow-live", "--case", "registry", "--output", "new-output"];
  assert.equal(parseMaterialCouponArgs(args).case, "registry");
  for (const flag of ["--target", "--allow-live", "--case", "--output"]) {
    const copy = [...args]; copy.splice(copy.indexOf(flag), flag === "--allow-live" ? 1 : 2);
    assert.throws(() => parseMaterialCouponArgs(copy), /required|new directory/);
  }
  assert.throws(() => parseMaterialCouponArgs(["--case", "physical"]), /registry or calculation/);
  assert.throws(() => parseMaterialCouponArgs(["--target", "--allow-live"]), /requires a value/);
  assert.throws(() => parseMaterialCouponArgs(["--network"]), /Unknown argument/);
});

test("synthetic partial coupon sources have real fixture hashes and combine without inventing properties", async context => {
  const root = await mkdtemp(join(tmpdir(), "coupon-acceptance-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new MaterialCouponQualificationStore(root);
  const records = [];
  for (const kind of ["elastic", "strength"] as const) {
    const fixture = syntheticCouponFixture(kind);
    assert.match(fixture.input.notes!, /no physical tests/i);
    const hash = createHash("sha256").update(fixture.sourceText).digest("hex");
    assert(fixture.input.evidence.every(e => e.sourceHash === hash));
    records.push((await store.record(fixture.input)).record);
  }
  assert.equal((await store.match({ process: exactMaterialCouponProcessSchema.parse(records[0]!.process) })).status, "ambiguous");
  const combined = await store.combine(records.map(r => r.id), 6);
  assert.deepEqual(combined.record.properties, { youngModulusMPa: 2000, shearModulusMPa: 740, tensileStrengthMPa: 31 });
  assert.equal((await store.match({ process: exactMaterialCouponProcessSchema.parse(records[0]!.process) })).selected?.id, combined.record.id);
  const conflict = (await store.record(syntheticCouponFixture("conflict").input)).record;
  await assert.rejects(store.combine([records[0]!.id, conflict.id], 6), /conflict/i);
});

test("coupon result gates require independent numeric results and conditional unbound status", () => {
  const { scenario, allowables } = syntheticCouponScenario("cantilever-tip-rectangle-v1");
  const report = { input: { ...scenario, material: { youngMPa: 2000, tensileLimitMPa: allowables.tensileMPa, compressiveLimitMPa: allowables.compressiveMPa, suitability: "unconfirmed" } },
    result: { method: scenario.method, status: "conditional", issues: [{ code: "MATERIAL_UNCONFIRMED" }], stressMPa: 0.24, displacementMm: 0.16, strengthUtilization: 0.032, displacementUtilization: 0.08 } };
  assert.doesNotThrow(() => assertCouponCalculation(report, "cantilever-tip-rectangle-v1"));
  for (const result of [{ status: "pass" }, { stressMPa: 0.02 }, { displacementMm: 1.6 }, { strengthUtilization: NaN }, { displacementUtilization: 1.6 }, { issues: [] }]) {
    assert.throws(() => assertCouponCalculation({ ...report, result: { ...report.result, ...result } }, "cantilever-tip-rectangle-v1"));
  }
  assert.throws(() => assertCouponCalculation({ ...report, input: { ...report.input, binding: { bodyId: 1 } } }, "cantilever-tip-rectangle-v1"), /binding/);
  assert.throws(() => assertCouponCalculation({ ...report, input: { ...report.input, material: { ...report.input.material, tensileLimitMPa: 31 } } }, "cantilever-tip-rectangle-v1"));
  const axial = { ...report, input: { ...report.input, method: "axial-rectangle-v1" }, result: { ...report.result, method: "axial-rectangle-v1", stressMPa: 0.02, displacementMm: 0.001, strengthUtilization: 0.04 / 15, displacementUtilization: 0.0005 } };
  assert.doesNotThrow(() => assertCouponCalculation(axial, "axial-rectangle-v1"));
});

test("reviewed scenarios and all size candidates stay inside the actual method limits", async context => {
  const root = await mkdtemp(join(tmpdir(), "coupon-formula-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new StrengthStore(root);
  await store.materialQualifications.record(syntheticCouponFixture().input);
  for (const method of ["axial-rectangle-v1", "cantilever-tip-rectangle-v1"] as const) {
    const resolved = await materializeRectangularCouponInput(store, rectangularCouponInputSchema.parse(syntheticCouponScenario(method)));
    assert(resolved.input);
    assertCouponCalculation({ input: resolved.input, result: calculate(resolved.input) }, method);
    const sizes = sizeMember({ input: resolved.input, heightsMm: method === "axial-rectangle-v1" ? [5, 8, 10] : [4, 4.5, 5] });
    assert.equal(sizes.recommendation, "conditional");
    for (const candidate of sizes.candidates) assertCouponCalculation({ input: resolved.input, result: candidate.result }, method, candidate.heightMm);
  }
});
