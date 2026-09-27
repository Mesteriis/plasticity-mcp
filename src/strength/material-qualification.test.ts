import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MaterialCouponQualificationStore,
  materialCouponQualificationHash,
  materialCouponQualificationInputSchema,
  orthotropicTsaiWuInteractionTestAxis,
  orthotropicTsaiWuTestMetadata,
  type MaterialCouponQualificationInput,
} from "./material-qualification.ts";

test("stores immutable physical coupon data idempotently and returns an exact process match", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-material-coupons-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const store = new MaterialCouponQualificationStore(root);
  const input = qualificationInput();
  const first = await store.record(input);
  const duplicate = await store.record(input);

  assert.equal(first.alreadyExisted, false);
  assert.equal(duplicate.alreadyExisted, true);
  assert.equal(first.record.id, materialCouponQualificationHash(input));
  assert.equal(first.record.recordStatus, "caller-attested-physical-coupon-record");
  assert.equal((await store.list()).length, 1);
  assert.equal((await store.match({ process: input.process })).status, "matched");
  assert.deepEqual(await store.read(first.record.id), first.record);
  assert.equal((await store.match({ process: { ...input.process, orientationDeg: [90, 0, 0] } })).status, "no-match");
  assert.equal((await store.match({ process: { ...input.process, wallLoops: input.process.wallLoops! + 1 } })).status, "no-match");
  assert.equal((await store.match({ process: { ...input.process, infillPattern: "gyroid" } })).status, "no-match");
  const processWithoutLayerHeight = { ...input.process };
  Reflect.deleteProperty(processWithoutLayerHeight, "layerHeightMm");
  await assert.rejects(() => store.match({ process: processWithoutLayerHeight }), /measured slicer layer height/i);
  const processWithoutWalls = { ...input.process };
  Reflect.deleteProperty(processWithoutWalls, "wallLoops");
  await assert.rejects(() => store.match({ process: processWithoutWalls }), /requires the measured slicer wallLoops setting/i);
});

test("records only the required measured E1 when unmeasured properties are outside the selected analysis", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-material-coupons-partial-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const store = new MaterialCouponQualificationStore(root);
  const input = qualificationInput();
  for (const property of ["shearModulusMPa", "tensileStrengthMPa", "shearStrengthMPa"] as const) {
    Reflect.deleteProperty(input.properties, property);
    Reflect.deleteProperty(input.propertyEvidence, property);
  }
  input.evidence = input.evidence.filter((item) => item.id === "young-modulus");

  const saved = await store.record(input);
  const match = await store.match({ process: input.process });
  assert.equal(match.status, "matched");
  assert.equal(saved.record.properties.youngModulusMPa, 2100);
  assert.equal(saved.record.properties.shearModulusMPa, undefined);
  assert.equal(match.selected?.propertyEvidence.shearModulusMPa, undefined);

  const complete = qualificationInput();
  await store.record(complete);
  const supersedingMatch = await store.match({ process: complete.process });
  assert.equal(supersedingMatch.status, "matched");
  assert.equal(supersedingMatch.selected?.id, materialCouponQualificationHash(complete));

  const unpaired = structuredClone(input);
  unpaired.properties.shearModulusMPa = 740;
  await assert.rejects(() => store.record(unpaired), /shearModulusMPa and its measured evidence must be recorded together/i);
});

test("does not combine complementary coupon records implicitly", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-material-coupons-complementary-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const store = new MaterialCouponQualificationStore(root);
  const shear = qualificationInput();
  const tension = qualificationInput();
  for (const property of ["tensileStrengthMPa", "shearStrengthMPa"] as const) {
    Reflect.deleteProperty(shear.properties, property);
    Reflect.deleteProperty(shear.propertyEvidence, property);
  }
  shear.evidence = shear.evidence.filter((item) => item.id === "young-modulus" || item.id === "shear-modulus");
  Reflect.deleteProperty(tension.properties, "shearModulusMPa");
  Reflect.deleteProperty(tension.properties, "shearStrengthMPa");
  Reflect.deleteProperty(tension.propertyEvidence, "shearModulusMPa");
  Reflect.deleteProperty(tension.propertyEvidence, "shearStrengthMPa");
  tension.evidence = tension.evidence.filter((item) => item.id === "young-modulus" || item.id === "tensile-strength");
  const shearRecord = await store.record(shear);
  const tensionRecord = await store.record(tension);

  const match = await store.match({ process: shear.process });
  assert.equal(match.status, "ambiguous");
  assert.equal(match.selected, null);
  assert.match(match.reasons[0]!, /Compatible partial coupon records.*no single record/i);

  const combined = await store.combine([shearRecord.record.id, tensionRecord.record.id], 8);
  assert.equal(combined.record.composedFromRecordIds?.length, 2);
  assert.deepEqual(combined.record.composedFromRecordIds, [shearRecord.record.id, tensionRecord.record.id].toSorted());
  assert.equal(combined.record.specimenCount, 8);
  assert.deepEqual(combined.record.propertyEvidence.youngModulusMPa, ["young-modulus"]);
  assert.deepEqual(combined.record.propertyEvidence.shearModulusMPa, ["shear-modulus"]);
  assert.deepEqual(combined.record.propertyEvidence.tensileStrengthMPa, ["tensile-strength"]);
  const combinedMatch = await store.match({ process: shear.process });
  assert.equal(combinedMatch.status, "matched");
  assert.equal(combinedMatch.selected?.id, combined.record.id);
  const reversed = await store.combine([tensionRecord.record.id, shearRecord.record.id], 8);
  assert.equal(reversed.alreadyExisted, true);
  assert.equal(reversed.record.id, combined.record.id);
});

test("does not silently select conflicting property values for the same exact print process", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-material-coupons-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const store = new MaterialCouponQualificationStore(root);
  const first = qualificationInput();
  const second = qualificationInput();
  second.properties.tensileStrengthMPa = 28;
  second.evidence.find((item) => item.id === "tensile-strength")!.value = 28;
  second.testedAt = "2026-09-24T10:00:00.000Z";
  await store.record(first);
  await store.record(second);

  const match = await store.match({ process: first.process });
  assert.equal(match.status, "ambiguous");
  assert.equal(match.selected, null);
  assert.equal(match.records.length, 2);
  await assert.rejects(() => store.combine(match.records.map((record) => record.id), 5), /Conflicting coupon values/i);
});

test("does not combine otherwise-compatible coupons from different print processes", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-material-coupons-process-mismatch-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const store = new MaterialCouponQualificationStore(root);
  const first = await store.record(qualificationInput());
  const secondInput = qualificationInput();
  secondInput.process.orientationDeg = [90, 0, 0];
  const second = await store.record(secondInput);
  await assert.rejects(
    () => store.combine([first.record.id, second.record.id], 10),
    /only when printer, material, profile hash, orientation, infill percentage and pattern, wall loops, top\/bottom shell layers, nozzle temperature and layer height/i,
  );
});

test("stores Poisson ratio nu12 with traceable exact-process evidence and rejects conflicting measurements", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-material-coupons-nu12-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const store = new MaterialCouponQualificationStore(root);
  const first = qualificationInput();
  first.poissonRatio = 0.31;
  first.poissonRatioEvidence = ["nu12-test-a"];
  first.evidence.push({
    id: "nu12-test-a", label: "Measured nu12 from axis-1 tensile coupon", status: "measured", unit: "ratio", value: 0.31,
    sourceUrl: "https://example.com/coupon-report.pdf", sourceHash: "a".repeat(64), sourceLocator: "page 4, specimen group A", dependsOn: [],
  });
  const saved = await store.record(first);
  assert.equal(saved.record.poissonRatio, 0.31);
  assert.deepEqual(saved.record.poissonRatioEvidence, ["nu12-test-a"]);
  assert.equal((await store.match({ process: first.process })).selected?.id, saved.record.id);

  const conflict = structuredClone(first);
  conflict.poissonRatio = 0.28;
  conflict.poissonRatioEvidence = ["nu12-test-b"];
  conflict.evidence.find((item) => item.id === "nu12-test-a")!.id = "nu12-test-b";
  conflict.evidence.find((item) => item.id === "nu12-test-b")!.value = 0.28;
  conflict.evidence.find((item) => item.id === "nu12-test-b")!.sourceHash = "c".repeat(64);
  conflict.testedAt = "2026-09-24T10:00:00.000Z";
  await store.record(conflict);
  assert.equal((await store.match({ process: first.process })).status, "ambiguous");

  const mismatchedEvidence = structuredClone(qualificationInput());
  mismatchedEvidence.poissonRatio = 0.31;
  mismatchedEvidence.poissonRatioEvidence = ["nu12-mismatch"];
  mismatchedEvidence.evidence.push({
    id: "nu12-mismatch", label: "Measured nu12", status: "measured", unit: "ratio", value: 0.3,
    sourceUrl: "https://example.com/coupon-report.pdf", sourceHash: "d".repeat(64), sourceLocator: "page 5", dependsOn: [],
  });
  await assert.rejects(() => store.record(mismatchedEvidence), /nu12.*matching measured ratio evidence/i);
});

test("requires traceable measured properties and rejects tampered stored records", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-material-coupons-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const store = new MaterialCouponQualificationStore(root);
  await assert.rejects(() => store.record({ ...qualificationInput(), callerConfirmsPhysicalTests: false } as never), /expected true/i);
  const legacyProcess = qualificationInput();
  Reflect.deleteProperty(legacyProcess.process, "layerHeightMm");
  await assert.rejects(() => store.record(legacyProcess), /requires the measured slicer layer height/i);
  const invalid = qualificationInput();
  invalid.evidence.find((item) => item.id === "young-modulus")!.sourceHash = "short";
  await assert.rejects(() => store.record(invalid), /SHA-256 sourceHash/i);
  const { record } = await store.record(qualificationInput());
  await writeFile(join(root, `${record.id}.json`), JSON.stringify({ ...record, notes: "tampered" }));
  await assert.rejects(() => store.list(), /hash mismatch/i);
});

test("reads legacy coupon records without inventing their missing layer height", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-legacy-material-coupon-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const input = qualificationInput();
  Reflect.deleteProperty(input.process, "layerHeightMm");
  const id = createHash("sha256").update(canonicalJson(input)).digest("hex");
  const legacyRecord = {
    ...input, id, createdAt: "2026-09-20T10:00:00.000Z", recordStatus: "caller-attested-physical-coupon-record" as const,
  };
  const store = new MaterialCouponQualificationStore(root);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, `${id}.json`), JSON.stringify(legacyRecord));

  assert.deepEqual(await store.read(id), legacyRecord);
  assert.equal((await store.read(id)).process.layerHeightMm, undefined);
});

test("binds orthotropic tensors and print axes to immutable exact-process coupon records", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-material-coupons-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const store = new MaterialCouponQualificationStore(root);
  const first = withOrthotropic(qualificationInput(), "orthotropic-a", 1_500);
  const saved = await store.record(first);
  assert.equal((await store.match({ process: first.process })).selected?.orthotropicMaterial?.youngsModulus2MPa, 1_500);
  assert.equal(saved.record.id, materialCouponQualificationHash(first));

  const conflicting = withOrthotropic(qualificationInput(), "orthotropic-b", 1_600);
  conflicting.testedAt = "2026-09-24T11:00:00.000Z";
  await store.record(conflicting);
  assert.equal((await store.match({ process: first.process })).status, "ambiguous");

  const mismatchedEvidence = withOrthotropic(qualificationInput(), "orthotropic-c", 1_700);
  mismatchedEvidence.evidence.find((item) => item.id === "orthotropic-c-youngsModulus2MPa")!.value = 1_699;
  await assert.rejects(() => store.record(mismatchedEvidence), /exact measured coupon evidence/i);

  const sourcedTensor = withOrthotropic(qualificationInput(), "orthotropic-sourced", 1_700);
  sourcedTensor.evidence.find((item) => item.id === "orthotropic-sourced-youngsModulus2MPa")!.status = "sourced";
  await assert.rejects(() => store.record(sourcedTensor), /exact measured coupon evidence/i);

  const invalidAxes = withOrthotropic(qualificationInput(), "orthotropic-d", 1_800);
  invalidAxes.orthotropicMaterial!.orientation.buildDirectionGlobal = [0, 1, 0];
  await assert.rejects(() => store.record(invalidAxes), /axis 3 must align/i);
});

test("stores and matches orthotropic Tsai-Wu tests only for their exact single-material process", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-material-coupons-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const store = new MaterialCouponQualificationStore(root);
  const first = withOrthotropicTsaiWu(withOrthotropic(qualificationInput(), "tsai-wu-a", 1_500));
  const parsed = materialCouponQualificationInputSchema.safeParse(first);
  assert.equal(parsed.success, true, parsed.success ? undefined : parsed.error.message);
  const saved = await store.record(first);
  const match = await store.match({ process: first.process });
  assert.equal(match.status, "matched");
  assert.equal(match.selected?.orthotropicMaterial?.tsaiWuCriterion?.strengths.zTensionMPa, 12);
  assert.deepEqual(match.selected?.orthotropicMaterial?.tsaiWuCriterion?.interactions, { xy: 0.2, xz: -0.1, yz: 0.15 });
  assert.equal(saved.record.id, materialCouponQualificationHash(first));

  const sameResultsFromAnotherReport = withOrthotropicTsaiWu(withOrthotropic(qualificationInput(), "tsai-wu-copy", 1_500));
  sameResultsFromAnotherReport.testedAt = "2026-09-24T11:00:00.000Z";
  await store.record(sameResultsFromAnotherReport);
  const duplicateResultsMatch = await store.match({ process: first.process });
  assert.equal(duplicateResultsMatch.status, "matched");
  assert.equal(duplicateResultsMatch.records.length, 2);

  const mismatchedEvidence = withOrthotropicTsaiWu(withOrthotropic(qualificationInput(), "tsai-wu-b", 1_500));
  mismatchedEvidence.evidence.find((item) => item.id === "tsai-wu-b-strength-xTensionMPa")!.value = 99;
  await assert.rejects(() => store.record(mismatchedEvidence), /exact measured Tsai-Wu evidence/i);

  const missingBiaxialRecord = withOrthotropicTsaiWu(withOrthotropic(qualificationInput(), "tsai-wu-missing", 1_500));
  missingBiaxialRecord.evidence.find((item) => item.id === "tsai-wu-missing-interaction-xy")!.dependsOn = ["missing-biaxial-report"];
  await assert.rejects(() => store.record(missingBiaxialRecord), /references missing evidence/i);

  const conflict = withOrthotropicTsaiWu(withOrthotropic(qualificationInput(), "tsai-wu-c", 1_500));
  conflict.orthotropicMaterial!.tsaiWuCriterion!.interactions.xy = 0.25;
  conflict.evidence.find((item) => item.id === "tsai-wu-c-interaction-xy")!.value = 0.25;
  conflict.testedAt = "2026-09-24T12:00:00.000Z";
  await store.record(conflict);
  assert.equal((await store.match({ process: first.process })).status, "ambiguous");
});

test("requires every Tsai-Wu strength and interaction test to identify its material axis and loading mode", () => {
  const candidate = withOrthotropicTsaiWu(withOrthotropic(qualificationInput(), "tsai-wu-directions", 1_500));
  delete candidate.evidence.find((item) => item.id === "tsai-wu-directions-strength-xTensionMPa")!.testAxis;
  assert.equal(materialCouponQualificationInputSchema.safeParse(candidate).success, false);
  const wrongAxis = withOrthotropicTsaiWu(withOrthotropic(qualificationInput(), "tsai-wu-wrong-axis", 1_500));
  wrongAxis.evidence.find((item) => item.id === "tsai-wu-wrong-axis-strength-xTensionMPa")!.testAxis = "material-2";
  assert.equal(materialCouponQualificationInputSchema.safeParse(wrongAxis).success, false);
});

function withOrthotropicTsaiWu(input: MaterialCouponQualificationInput): MaterialCouponQualificationInput {
  const prefix = input.orthotropicMaterial!.propertyEvidence.youngsModulus2MPa[0]!.replace(/-youngsModulus2MPa$/, "");
  const strengths = {
    xTensionMPa: 35, xCompressionMPa: 42, yTensionMPa: 28, yCompressionMPa: 31,
    zTensionMPa: 12, zCompressionMPa: 22, xyShearMPa: 18, xzShearMPa: 11, yzShearMPa: 10,
  };
  const interactions = { xy: 0.2, xz: -0.1, yz: 0.15 };
  const evidence = [
    ...Object.entries(strengths).map(([key, value], index) => ({
      id: `${prefix}-strength-${key}`,
      label: `Measured orthotropic failure strength ${key}`, status: "measured" as const, unit: "MPa" as const,
      ...orthotropicTsaiWuTestMetadata[key as keyof typeof orthotropicTsaiWuTestMetadata],
      value, sourceUrl: "https://example.org/orthotropic-failure-tests.pdf", sourceHash: `${index + 1}`.repeat(64),
      sourceLocator: `test report ${key}`, dependsOn: [],
    })),
    ...Object.keys(interactions).map((key, index) => ({
      id: `${prefix}-biaxial-${key}`,
      label: `Measured biaxial failure dataset ${key}`, status: "measured" as const,
      testAxis: orthotropicTsaiWuInteractionTestAxis[key as keyof typeof orthotropicTsaiWuInteractionTestAxis], testMode: "biaxial" as const,
      sourceUrl: "https://example.org/orthotropic-biaxial-tests.pdf", sourceHash: `${index + 1}`.repeat(64),
      sourceLocator: `biaxial report ${key}`, dependsOn: [],
    })),
    ...Object.entries(interactions).map(([key, value], index) => ({
      id: `${prefix}-interaction-${key}`,
      label: `Derived normalized interaction ${key}`, status: "derived" as const, unit: "ratio" as const,
      testAxis: orthotropicTsaiWuInteractionTestAxis[key as keyof typeof orthotropicTsaiWuInteractionTestAxis], testMode: "biaxial" as const,
      value, sourceUrl: "https://example.org/orthotropic-biaxial-tests.pdf", sourceHash: `${index + 4}`.repeat(64),
      sourceLocator: `biaxial fit ${key}`, derivation: "Normalized interaction fit from the cited biaxial failure tests.",
      dependsOn: [`${prefix}-biaxial-${key}`],
    })),
  ];
  const strengthEvidence: NonNullable<NonNullable<MaterialCouponQualificationInput["orthotropicMaterial"]>["tsaiWuCriterion"]>["strengthEvidence"] = {
    xTensionMPa: [`${prefix}-strength-xTensionMPa`], xCompressionMPa: [`${prefix}-strength-xCompressionMPa`],
    yTensionMPa: [`${prefix}-strength-yTensionMPa`], yCompressionMPa: [`${prefix}-strength-yCompressionMPa`],
    zTensionMPa: [`${prefix}-strength-zTensionMPa`], zCompressionMPa: [`${prefix}-strength-zCompressionMPa`],
    xyShearMPa: [`${prefix}-strength-xyShearMPa`], xzShearMPa: [`${prefix}-strength-xzShearMPa`], yzShearMPa: [`${prefix}-strength-yzShearMPa`],
  };
  const interactionEvidence: NonNullable<NonNullable<MaterialCouponQualificationInput["orthotropicMaterial"]>["tsaiWuCriterion"]>["interactionEvidence"] = {
    xy: `${prefix}-interaction-xy`, xz: `${prefix}-interaction-xz`, yz: `${prefix}-interaction-yz`,
  };
  input.orthotropicMaterial!.tsaiWuCriterion = {
    strengths,
    interactions,
    strengthEvidence,
    interactionEvidence,
  };
  input.evidence.push(...evidence);
  return input;
}

function withOrthotropic(input: MaterialCouponQualificationInput, id: string, youngsModulus2MPa: number): MaterialCouponQualificationInput {
  const values = {
    youngsModulus2MPa, youngsModulus3MPa: 800, poissonRatio13: 0.2, poissonRatio23: 0.25,
    shearModulus12MPa: 600, shearModulus13MPa: 350, shearModulus23MPa: 300,
  };
  const propertyEvidence = {
    youngsModulus2MPa: [`${id}-youngsModulus2MPa`], youngsModulus3MPa: [`${id}-youngsModulus3MPa`],
    poissonRatio13: [`${id}-poissonRatio13`], poissonRatio23: [`${id}-poissonRatio23`],
    shearModulus12MPa: [`${id}-shearModulus12MPa`], shearModulus13MPa: [`${id}-shearModulus13MPa`], shearModulus23MPa: [`${id}-shearModulus23MPa`],
  };
  const extraEvidence = Object.entries(values).map(([key, value], index) => ({
    id: `${id}-${key}`, label: `Measured ${key}`, status: "measured" as const, value,
    unit: key.startsWith("poisson") ? "ratio" as const : "MPa" as const,
    sourceUrl: "https://example.com/orthotropic-coupon.pdf", sourceHash: `${index + 2}`.repeat(64), sourceLocator: `coupon.pdf!${key}`, dependsOn: [],
  }));
  return {
    ...input,
    orthotropicMaterial: {
      ...values, propertyEvidence,
      orientation: {
        axis1DirectionGlobal: [1, 0, 0], axis2ReferenceDirectionGlobal: [0, 1, 0], buildDirectionGlobal: [0, 0, 1],
        evidence: { status: "user-confirmed", description: "Axes confirmed against the CAD global frame and the printer build direction." },
      },
    },
    evidence: [...input.evidence, ...extraEvidence],
  };
}

function qualificationInput(): MaterialCouponQualificationInput {
  const properties: MaterialCouponQualificationInput["properties"] = {
    youngModulusMPa: 2100,
    shearModulusMPa: 740,
    tensileStrengthMPa: 31,
    shearStrengthMPa: 17,
  };
  const ids = ["young-modulus", "shear-modulus", "tensile-strength", "shear-strength"];
  const values = Object.values(properties);
  const paths = ["youngModulusMPa", "shearModulusMPa", "tensileStrengthMPa", "shearStrengthMPa"] as const;
  return {
    process: {
      printerId: "creality-k1c-0.4",
      materialId: "generic-pla-k1c-0.4",
      profileHash: "b".repeat(64),
      orientationDeg: [0, 0, 0],
      infillPercent: 100,
      infillPattern: "grid",
      wallLoops: 2,
      topShellLayers: 5,
      bottomShellLayers: 3,
      nozzleTemperatureC: 220,
      layerHeightMm: 0.2,
    },
    properties,
    propertyEvidence: {
      youngModulusMPa: [ids[0]!],
      shearModulusMPa: [ids[1]!],
      tensileStrengthMPa: [ids[2]!],
      shearStrengthMPa: [ids[3]!],
    },
    evidence: ids.map((id, index) => ({
      id,
      label: paths[index]!,
      status: "measured" as const,
      unit: "MPa" as const,
      value: values[index],
      sourceUrl: "https://example.com/coupon-report.pdf",
      sourceHash: `${index + 1}`.repeat(64),
      sourceLocator: `coupon-report:${id}`,
      dependsOn: [],
    })),
    testStandard: "ASTM D638 and documented shear coupon procedure",
    specimenCount: 5,
    testedAt: "2026-09-23T10:00:00.000Z",
    notes: "Values are entered from the cited report; no statistical reduction is performed by this registry.",
    source: "physical-coupon-test",
    callerConfirmsPhysicalTests: true,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}
