import assert from "node:assert/strict";
import test from "node:test";

import { materialTestPlanInputSchema, planSingleMaterialStrengthTests } from "./material-test-plan.ts";

const process = {
  printerId: "creality-k1c",
  materialId: "pla-plus-user-roll",
  profileHash: "a".repeat(64),
  orientationDeg: [0, 0, 0] as [number, number, number],
  infillPercent: 100,
  infillPattern: "grid",
  wallLoops: 2,
  topShellLayers: 5,
  bottomShellLayers: 3,
  nozzleTemperatureC: 220,
  layerHeightMm: 0.2,
};

test("plans exact one-material layerwise elastic measurements without supplying property values", () => {
  const plan = planSingleMaterialStrengthTests({ process, scopes: ["layerwise-elastic-response"] });
  assert.equal(plan.materialModel, "one-material-orthotropic-bulk-and-same-material-interfaces");
  assert.deepEqual(plan.process, process);
  assert.deepEqual(plan.tasks.map((task) => task.id), ["E1", "E2", "E3", "nu12", "nu13", "nu23", "G12", "G13", "G23"]);
  assert.ok(plan.tasks.filter((task) => task.id !== "nu12").every((task) => task.recordWith === "plasticity_record_material_coupon_data"));
  assert.equal(plan.tasks.find((task) => task.id === "nu12")?.recordWith, "plasticity_record_material_coupon_data");
  assert.ok(plan.tasks.find((task) => task.id === "nu12")?.conditions.some((condition) => condition.includes("same value and evidence")));
  assert.ok(plan.tasks.every((task) => !("value" in task)));
  assert.ok(plan.solverLimits[0]!.includes("assumes perfectly bonded interfaces"));
  assert.ok(plan.limitations.some((limitation) => limitation.includes("no multi-material model")));
});

test("plans the calibrated same-material DCB/ENF/MMB evidence and leaves MMB mix as a measurement", () => {
  const plan = planSingleMaterialStrengthTests({
    process,
    scopes: ["layer-interface-mixed-mode"],
    interfaceNormalGlobal: [0, 0, 1],
    interfaceShearDirectionGlobal: [1, 0, 0],
  });
  assert.deepEqual(plan.tasks.map((task) => task.id), ["DCB-mode-I", "ENF-mode-II", "MMB-1", "MMB-2", "cohesive-K"]);
  const dcb = plan.tasks.find((task) => task.id === "DCB-mode-I");
  const enf = plan.tasks.find((task) => task.id === "ENF-mode-II");
  const mmb = plan.tasks.filter((task) => task.id.startsWith("MMB-"));
  assert.deepEqual(dcb?.globalDirection, [0, 0, 1]);
  assert.ok(dcb?.conditions.some((condition) => condition.includes("L=125 mm") && condition.includes("width=25 mm") && condition.includes("a=55 mm")));
  assert.ok(dcb?.conditions.some((condition) => condition.toLowerCase().includes("generic-pla literature planning reference") && condition.includes("not CR-PLA qualification")));
  assert.ok(dcb?.conditions.some((condition) => condition.includes("cites D5568 in its conclusion")));
  assert.deepEqual(enf?.globalDirection, [1, 0, 0]);
  assert.ok(mmb.every((task) => task.globalDirection === undefined), "MMB load directions depend on the selected fixture and must not be invented");
  assert.ok(mmb.every((task) => task.conditions.some((condition) => condition.includes("distinct measured tangential energy fractions"))));
  const stiffness = plan.tasks.find((task) => task.id === "cohesive-K");
  assert.equal(stiffness?.recordWith, undefined);
  assert.equal(stiffness?.provideTo, "plasticity_analyze_cohesive_interface");
  assert.ok(stiffness?.conditions.some((condition) => condition.includes("MPa/mm") && condition.includes("not stored")));
  assert.ok(plan.solverLimits.some((limitation) => limitation.includes("Mode-III")));
});

test("plans a focused normal tensile test for layer-interface strength without expanding to a full material matrix", () => {
  const plan = planSingleMaterialStrengthTests({
    process,
    scopes: ["layer-interface-normal-tension"],
    interfaceNormalGlobal: [0, 0, 1],
  });
  assert.deepEqual(plan.tasks.map((task) => task.id), ["layer-normal-tension"]);
  const task = plan.tasks[0]!;
  assert.equal(task.kind, "interface-strength");
  assert.equal(task.recordWith, "plasticity_record_material_interface_test");
  assert.deepEqual(task.globalDirection, [0, 0, 1]);
  assert.match(task.measurement, /nominal peak stress/i);
  assert.match(task.measurement, /force\/area.*N\/mm² = MPa/i);
  assert.match(task.measurement, /do not label it local interface traction/i);
  assert.ok(task.conditions.some((condition) => /one raw result for every specimen/i.test(condition)));
  assert.ok(task.conditions.some((condition) => /failure.*layer interface/i.test(condition)));
  assert.ok(plan.solverLimits.some((limitation) => /not.*fracture energy|cannot.*cohesive/i.test(limitation)));
});

test("plans a focused same-material ENF Mode-II initiation-energy test with explicit shear axis", () => {
  const plan = planSingleMaterialStrengthTests({
    process,
    scopes: ["layer-interface-mode-ii"],
    interfaceNormalGlobal: [0, 0, 1],
    interfaceShearDirectionGlobal: [1, 0, 0],
  });
  assert.deepEqual(plan.tasks.map((task) => task.id), ["ENF-mode-II-energy"]);
  assert.deepEqual(plan.tasks[0]?.globalDirection, [1, 0, 0]);
  assert.match(plan.tasks[0]?.measurement ?? "", /at least three crack-length compliance calibration runs/i);
  assert.match(plan.tasks[0]?.measurement ?? "", /plasticity_calculate_enf_mode_ii_energy/i);
  assert.ok(plan.tasks[0]?.conditions.some((condition) => /does not conform to ASTM D7905.*printed PLA/i.test(condition)));
  assert.ok(plan.solverLimits.some((limitation) => /not a Mode-II R-curve.*cohesive FEA/i.test(limitation)));
});

test("rejects incomplete or contradictory interface plans and a process without measured layer height", () => {
  assert.equal(materialTestPlanInputSchema.safeParse({ process, scopes: ["layer-interface-mode-i"] }).success, false);
  assert.equal(materialTestPlanInputSchema.safeParse({ process, scopes: ["layer-interface-normal-tension"] }).success, false);
  assert.equal(materialTestPlanInputSchema.safeParse({
    process, scopes: ["layer-interface-mixed-mode"], interfaceNormalGlobal: [0, 0, 1],
  }).success, false);
  assert.equal(materialTestPlanInputSchema.safeParse({
    process, scopes: ["layer-interface-mode-ii"], interfaceNormalGlobal: [0, 0, 1],
  }).success, false);
  assert.equal(materialTestPlanInputSchema.safeParse({
    process, scopes: ["layer-interface-mixed-mode"], interfaceNormalGlobal: [0, 0, 1], interfaceShearDirectionGlobal: [0, 0, 1],
  }).success, false);
  const withoutLayerHeight = { ...process } as Partial<typeof process>;
  delete withoutLayerHeight.layerHeightMm;
  assert.throws(() => planSingleMaterialStrengthTests({
    process: withoutLayerHeight as typeof process,
    scopes: ["layer-interface-mode-i"], interfaceNormalGlobal: [0, 0, 1],
  }), /measured slicer layer height/i);
});

test("plans directional bulk strength values and biaxial interactions as separate measurements", () => {
  const plan = planSingleMaterialStrengthTests({ process, scopes: ["directional-strength-screen"] });
  assert.equal(plan.tasks.length, 12);
  assert.equal(plan.tasks.filter((task) => task.kind === "biaxial-interaction").length, 3);
  assert.ok(plan.tasks.some((task) => task.id === "Z_T" && task.materialAxis === "material axis 3"));
  assert.ok(plan.tasks.every((task) => task.measurement.length > 0));
});
