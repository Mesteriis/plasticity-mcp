import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { analyzeMaterialInterfaceTestCurve, analyzeMixedModeMaterialInterfaceTestCurve, calculateInterfaceSpecimenStrengths, InterfaceTestStore, interfaceTestHash, interfaceTestInputSchema, type InterfaceTestInput } from "./interface-test.ts";

test("calculates nominal interface stress from each measured specimen force and net area", () => {
  const result = calculateInterfaceSpecimenStrengths({ specimens: [
    { specimenId: "A", peakForceN: 180, netCrossSectionMm2: 10, failureLocation: "interface", sourceHash: "a".repeat(64), sourceLocator: "report.pdf!A-1" },
    { specimenId: "B", peakForceN: 165, netCrossSectionMm2: 10, failureLocation: "interface", sourceHash: "b".repeat(64), sourceLocator: "report.pdf!B-1" },
    { specimenId: "C", peakForceN: 900, netCrossSectionMm2: 10, failureLocation: "material-a", sourceHash: "c".repeat(64), sourceLocator: "report.pdf!C-1" },
  ] });
  assert.deepEqual(result.specimens.map((specimen) => specimen.nominalPeakStrengthMPa), [18, 16.5, 90]);
  assert.equal(result.summary.specimenCount, 3);
  assert.equal(result.summary.interfaceFailureCount, 2);
  assert.equal(result.summary.minimumPeakStrengthMPa, 16.5);
  assert.equal(result.summary.maximumPeakStrengthMPa, 18);
  assert.equal(result.summary.meanPeakStrengthMPa, 17.25);
  assert.equal(result.summary.sampleStandardDeviationMPa, Math.sqrt(1.125));
  const noInterfaceFailures = calculateInterfaceSpecimenStrengths({ specimens: [
    { specimenId: "bulk", peakForceN: 900, netCrossSectionMm2: 10, failureLocation: "material-a", sourceHash: "d".repeat(64), sourceLocator: "report.pdf!bulk" },
  ] });
  assert.equal(noInterfaceFailures.summary.minimumPeakStrengthMPa, null);
  assert.equal(noInterfaceFailures.summary.maximumPeakStrengthMPa, null);
  assert.equal(noInterfaceFailures.summary.meanPeakStrengthMPa, null);
  assert.equal(noInterfaceFailures.summary.sampleStandardDeviationMPa, null);
  assert.throws(() => calculateInterfaceSpecimenStrengths({ specimens: [
    { specimenId: "A", peakForceN: 180, netCrossSectionMm2: 0, failureLocation: "interface", sourceHash: "a".repeat(64), sourceLocator: "report.pdf!A-1" },
  ] }), />0|positive/i);
});

test("stores an interlayer test immutably and matches the exact process pair and protocol", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-interface-test-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const store = new InterfaceTestStore(root);
  const input = interfaceTestInput();
  const first = await store.record(input);
  const duplicate = await store.record(input);
  assert.equal(first.alreadyExisted, false);
  assert.equal(duplicate.alreadyExisted, true);
  assert.equal(first.record.id, interfaceTestHash(input));
  assert.equal(first.record.recordStatus, "caller-attested-physical-material-interface-test");
  assert.equal((await store.list()).length, 1);
  assert.equal((await store.match(query(input))).status, "matched");
  assert.equal((await store.match({ ...query(input), testMode: "interface-shear", loadDirectionGlobal: [1, 0, 0] })).status, "no-match");
  assert.equal((await store.match({ ...query(input), materialAProcess: { ...input.materialAProcess, orientationDeg: [90, 0, 0] } })).status, "no-match");
  const changedWallsA = { ...input.materialAProcess, wallLoops: input.materialAProcess.wallLoops! + 1 };
  const changedWallsB = { ...input.materialBProcess, wallLoops: input.materialBProcess.wallLoops! + 1 };
  assert.equal((await store.match({ ...query(input), materialAProcess: changedWallsA, materialBProcess: changedWallsB })).status, "no-match");
  const changedPatternA = { ...input.materialAProcess, infillPattern: "gyroid" };
  const changedPatternB = { ...input.materialBProcess, infillPattern: "gyroid" };
  assert.equal((await store.match({ ...query(input), materialAProcess: changedPatternA, materialBProcess: changedPatternB })).status, "no-match");
});

test("preserves actual specimen G-code road-orientation provenance and rejects unconfirmed or mismatched frames", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-interface-path-evidence-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const store = new InterfaceTestStore(root);
  const input = interfaceTestInput();
  input.depositionPathEvidence = {
    jobId: "coupon-dcb-01",
    profileHash: input.materialAProcess.profileHash,
    sourceArtifactHash: "1".repeat(64),
    gcodeArtifactHash: "2".repeat(64),
    layerCount: 120,
    coordinateFrame: "slicer-build",
    layers: [{
      layerIndex: 12,
      depositionLayerZMm: 2.4,
      planarPathLengthMm: 350,
      principalDirectionDeg: 45,
      directionalConcentration: 0.82,
      curvedExtrusionMoves: 0,
      coverage: "complete-linear",
    }],
    slicerXDirectionGlobal: [1, 0, 0],
    slicerYDirectionGlobal: [0, 1, 0],
    buildDirectionGlobal: [0, 0, 1],
    mappingEvidence: { status: "user-confirmed", description: "Verified slicer build axes against CAD global axes." },
  };
  const stored = await store.record(input);
  assert.deepEqual(stored.record.depositionPathEvidence, input.depositionPathEvidence);
  assert.equal((await store.read(stored.record.id)).depositionPathEvidence?.gcodeArtifactHash, "2".repeat(64));

  const profileMismatch = structuredClone(input);
  profileMismatch.depositionPathEvidence!.profileHash = "3".repeat(64);
  assert.throws(() => interfaceTestInputSchema.parse(profileMismatch), /profile hash must match the tested material process/i);
  const frameMismatch = structuredClone(input);
  frameMismatch.depositionPathEvidence!.buildDirectionGlobal = [1, 0, 0];
  assert.throws(() => interfaceTestInputSchema.parse(frameMismatch), /must align with the tested layer-interface normal/i);
  const outOfRangeLayer = structuredClone(input);
  outOfRangeLayer.depositionPathEvidence!.layers[0]!.layerIndex = 121;
  assert.throws(() => interfaceTestInputSchema.parse(outOfRangeLayer), /within the sliced layer count/i);
});

test("reports conflicting interface measurements as ambiguous instead of selecting one", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-interface-test-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const store = new InterfaceTestStore(root);
  const first = interfaceTestInput();
  const second = interfaceTestInput();
  setRepresentativeStrength(second, 12);
  second.specimenResults![0]!.sourceHash = "e".repeat(64);
  second.specimenResults![0]!.sourceLocator = "second test report, specimen A-1";
  second.evidence[0]!.sourceHash = "e".repeat(64);
  second.evidence[0]!.sourceLocator = "second test report, specimen A-1";
  second.testedAt = "2026-09-24T12:00:00.000Z";
  await store.record(first);
  await store.record(second);
  const match = await store.match(query(first));
  assert.equal(match.status, "ambiguous");
  assert.equal(match.selected, null);
  assert.equal(match.records.length, 2);
});

test("reports conflicting complete traction-separation curves as ambiguous even when peak strength matches", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-interface-curve-conflict-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const store = new InterfaceTestStore(root);
  const first = interfaceTestInput();
  const second = interfaceTestInput();
  first.tractionSeparationCurve = curve("e", 0.06);
  second.tractionSeparationCurve = curve("f", 0.08);
  first.fractureMethod = "dcb-mode-i";
  second.fractureMethod = "dcb-mode-i";
  first.testMethod = "ASTM D5528 DCB";
  second.testMethod = "ASTM D5528 DCB";
  Reflect.deleteProperty(first, "representativeSpecimenId");
  Reflect.deleteProperty(second, "representativeSpecimenId");
  second.testedAt = "2026-09-24T12:00:00.000Z";
  await store.record(first);
  await store.record(second);
  const match = await store.match(query(first));
  assert.equal(match.status, "ambiguous");
  assert.equal(match.selected, null);
  assert.equal(match.records.length, 2);
});

test("rejects invalid material-pair declarations and untraceable measurements", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-interface-test-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const store = new InterfaceTestStore(root);
  const missingLayerHeight = interfaceTestInput();
  missingLayerHeight.interfaceKind = "same-material-layer";
  missingLayerHeight.materialBProcess = structuredClone(missingLayerHeight.materialAProcess);
  Reflect.deleteProperty(missingLayerHeight.materialAProcess, "layerHeightMm");
  Reflect.deleteProperty(missingLayerHeight.materialBProcess, "layerHeightMm");
  await assert.rejects(() => store.record(missingLayerHeight), /exact material coupon process requires the measured slicer layer height/i);
  const mismatch = interfaceTestInput();
  mismatch.interfaceKind = "same-material-layer";
  await assert.rejects(() => store.record(mismatch), /same-material layer test requires matching material process records/i);
  const wrongLoadAxis = interfaceTestInput();
  wrongLoadAxis.testMode = "interface-shear";
  await assert.rejects(() => store.record(wrongLoadAxis), /must lie in the interface plane/i);
  const invalid = interfaceTestInput();
  invalid.evidence[0]!.sourceHash = "bad";
  await assert.rejects(() => store.record(invalid), /SHA-256/i);
  const missingRawMeasurements = interfaceTestInput();
  missingRawMeasurements.interfaceKind = "same-material-layer";
  missingRawMeasurements.materialBProcess = structuredClone(missingRawMeasurements.materialAProcess);
  Reflect.deleteProperty(missingRawMeasurements, "specimenResults");
  Reflect.deleteProperty(missingRawMeasurements, "representativeSpecimenId");
  await assert.rejects(() => store.record(missingRawMeasurements), /raw specimen force and cross-section measurements/i);
});

test("detects tampered interface records when listing the registry", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-interface-test-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const store = new InterfaceTestStore(root);
  const { record } = await store.record(interfaceTestInput());
  await writeFile(join(root, `${record.id}.json`), JSON.stringify({ ...record, notes: "tampered" }));
  await assert.rejects(() => store.list(), /content hash mismatch/i);
});

test("reads legacy same-material interface records without inventing a layer height", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-legacy-interface-test-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const input = interfaceTestInput();
  input.interfaceKind = "same-material-layer";
  input.materialBProcess = structuredClone(input.materialAProcess);
  Reflect.deleteProperty(input.materialAProcess, "layerHeightMm");
  Reflect.deleteProperty(input.materialBProcess, "layerHeightMm");
  const id = createHash("sha256").update(canonicalJson(input)).digest("hex");
  const legacyRecord = {
    ...input, id, createdAt: "2026-09-20T10:00:00.000Z", recordStatus: "caller-attested-physical-material-interface-test" as const,
  };
  const store = new InterfaceTestStore(root);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, `${id}.json`), JSON.stringify(legacyRecord));

  assert.deepEqual(await store.read(id), legacyRecord);
  assert.equal((await store.read(id)).materialAProcess.layerHeightMm, undefined);
});

test("stores and analyzes a complete measured traction-separation curve without promoting it to a design allowable", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-interface-curve-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const store = new InterfaceTestStore(root);
  const input = interfaceTestInput();
  input.testMethod = "ASTM D5528 DCB";
  input.tractionSeparationCurve = {
    sourceHash: "e".repeat(64),
    sourceLocator: "raw.csv, specimens 1-5, compliance-corrected curve",
    points: [
      { separationMm: 0, tractionMPa: 0 },
      { separationMm: 0.01, tractionMPa: 10 },
      { separationMm: 0.02, tractionMPa: 18 },
      { separationMm: 0.04, tractionMPa: 12 },
      { separationMm: 0.06, tractionMPa: 0 },
    ],
  };
  input.fractureMethod = "dcb-mode-i";
  Reflect.deleteProperty(input, "representativeSpecimenId");
  const { record } = await store.record(input);
  const analysis = analyzeMaterialInterfaceTestCurve(record);
  assert.deepEqual(analysis, {
    mode: "normal-tension",
    sourceHash: "e".repeat(64),
    sourceLocator: "raw.csv, specimens 1-5, compliance-corrected curve",
    peakStrengthMPa: 18,
    peakSeparationMm: 0.02,
    initialSegmentStiffnessMPaPerMm: 1000,
    fractureEnergyNPerMm: 0.61,
    finalSeparationMm: 0.06,
    interpretation: "measured-curve-summary-only",
    limitations: [
      "This curve summary is not a qualified cohesive law or design allowable.",
      "The initial stiffness is the slope of the first measured segment and may be sensitive to fixture compliance and sampling resolution.",
      "Mixed-mode interaction, fatigue, rate, temperature and process variation are not modeled.",
    ],
  });
});

test("rejects incomplete, non-monotone, or peak-inconsistent interface curves", () => {
  const incomplete = interfaceTestInput();
  incomplete.tractionSeparationCurve = {
    sourceHash: "e".repeat(64), sourceLocator: "curve",
    points: [
      { separationMm: 0, tractionMPa: 0 },
      { separationMm: 0.01, tractionMPa: 18 },
      { separationMm: 0.02, tractionMPa: 18 },
    ],
  };
  assert.throws(() => analyzeMaterialInterfaceTestCurve(incomplete), /must end at zero traction/);

  const nonMonotone = interfaceTestInput();
  nonMonotone.tractionSeparationCurve = {
    sourceHash: "e".repeat(64), sourceLocator: "curve",
    points: [{ separationMm: 0, tractionMPa: 0 }, { separationMm: 0.02, tractionMPa: 18 }, { separationMm: 0.01, tractionMPa: 0 }],
  };
  assert.throws(() => analyzeMaterialInterfaceTestCurve(nonMonotone), /strictly increasing/);

  const mismatchedPeak = interfaceTestInput();
  mismatchedPeak.tractionSeparationCurve = {
    sourceHash: "e".repeat(64), sourceLocator: "curve",
    points: [{ separationMm: 0, tractionMPa: 0 }, { separationMm: 0.01, tractionMPa: 10 }, { separationMm: 0.02, tractionMPa: 0 }],
  };
  assert.throws(() => analyzeMaterialInterfaceTestCurve(mismatchedPeak), /peak traction must exactly match/);

  const cohesiveFailureNotObserved = interfaceTestInput();
  cohesiveFailureNotObserved.failureLocation = "material-a";
  cohesiveFailureNotObserved.tractionSeparationCurve = curve("e", 0.06);
  cohesiveFailureNotObserved.fractureMethod = "dcb-mode-i";
  assert.throws(() => analyzeMaterialInterfaceTestCurve(cohesiveFailureNotObserved), /requires observed failure at the tested interface/);
});

test("requires an explicit fracture method classification for persisted traction curves", () => {
  const input = interfaceTestInput();
  input.interfaceKind = "same-material-layer";
  input.materialBProcess = structuredClone(input.materialAProcess);
  delete input.specimenResults;
  delete input.representativeSpecimenId;
  input.testMethod = "ASTM D5528 DCB";
  input.tractionSeparationCurve = curve("a", 0.06);
  assert.throws(() => interfaceTestInputSchema.parse(input), /must declare its physical fracture-test method/i);
  input.fractureMethod = "enf-mode-ii";
  assert.throws(() => interfaceTestInputSchema.parse(input), /fractureMethod must be dcb-mode-i/i);
  input.fractureMethod = "dcb-mode-i";
  assert.doesNotThrow(() => interfaceTestInputSchema.parse(input));
});

test("stores and integrates a measured mixed-mode traction-separation curve in its local normal/tangent basis", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-interface-mixed-curve-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const input = interfaceTestInput();
  input.testMode = "mixed-mode";
  input.testMethod = "ASTM D6671 MMB";
  input.fractureMethod = "mmb-mixed-mode";
  input.loadDirectionGlobal = [Math.SQRT1_2, 0, Math.SQRT1_2];
  delete input.tractionSeparationCurve;
  input.mixedModeTractionSeparationCurve = {
    sourceHash: "f".repeat(64), sourceLocator: "MMB.csv, compliance-corrected vector response",
    points: [
      { normalSeparationMm: 0, tangentialSeparationMm: 0, normalTractionMPa: 0, tangentialTractionMPa: 0 },
      { normalSeparationMm: 0.01, tangentialSeparationMm: 0.01, normalTractionMPa: 10, tangentialTractionMPa: 10 },
      { normalSeparationMm: 0.02, tangentialSeparationMm: 0.03, normalTractionMPa: 18, tangentialTractionMPa: 24 },
      { normalSeparationMm: 0.04, tangentialSeparationMm: 0.05, normalTractionMPa: 12, tangentialTractionMPa: 8 },
      { normalSeparationMm: 0.06, tangentialSeparationMm: 0.08, normalTractionMPa: 0, tangentialTractionMPa: 0 },
    ],
  };
  setRepresentativeStrength(input, 30);

  const store = new InterfaceTestStore(root);
  const { record } = await store.record(input);
  const summary = analyzeMixedModeMaterialInterfaceTestCurve(record);
  assert.equal(summary.mode, "mixed-mode");
  assert.equal(summary.sourceHash, "f".repeat(64));
  assert.equal(summary.peakResultantStrengthMPa, 30);
  assert.equal(summary.normalFractureEnergyNPerMm, 0.61);
  assert.equal(summary.tangentialFractureEnergyNPerMm, 0.83);
  assert.equal(summary.totalFractureEnergyNPerMm, 1.44);
  assert.equal(summary.tangentialEnergyFraction, 0.83 / 1.44);
  assert.ok(Math.abs(summary.initialResultantStiffnessMPaPerMm - 1_000) < 1e-9);
  assert.equal((await store.match({
    interfaceKind: input.interfaceKind, materialAProcess: input.materialAProcess, materialBProcess: input.materialBProcess,
    testMode: "mixed-mode", interfaceNormalGlobal: input.interfaceNormalGlobal,
    loadDirectionGlobal: input.loadDirectionGlobal, testProtocolHash: input.testProtocolHash,
  })).selected?.id, record.id);
});

test("requires complete interface-failure MMB curves and mixed loading direction", () => {
  const input = interfaceTestInput();
  input.testMode = "mixed-mode";
  input.testMethod = "ASTM D6671 MMB";
  input.fractureMethod = "mmb-mixed-mode";
  input.loadDirectionGlobal = [Math.SQRT1_2, 0, Math.SQRT1_2];
  delete input.tractionSeparationCurve;
  input.mixedModeTractionSeparationCurve = {
    sourceHash: "f".repeat(64), sourceLocator: "curve.csv",
    points: [
      { normalSeparationMm: 0, tangentialSeparationMm: 0, normalTractionMPa: 0, tangentialTractionMPa: 0 },
      { normalSeparationMm: 0.01, tangentialSeparationMm: 0.01, normalTractionMPa: 10, tangentialTractionMPa: 10 },
      { normalSeparationMm: 0.02, tangentialSeparationMm: 0.02, normalTractionMPa: 0, tangentialTractionMPa: 0 },
    ],
  };
  setRepresentativeStrength(input, Math.sqrt(200));
  assert.throws(() => analyzeMixedModeMaterialInterfaceTestCurve({ ...input, failureLocation: "material-a" }), /observed failure at the tested interface/);
  assert.throws(() => interfaceTestInputSchema.parse({ ...input, tractionSeparationCurve: curve("a", 0.06) }), /only be attached to their matching test mode/);
  assert.throws(() => interfaceTestInputSchema.parse({ ...input, loadDirectionGlobal: [0, 0, 1] }), /must include normal and tangential loading/);
});

function process(materialId: string) {
  return {
    printerId: "creality-k1c-0.4",
    materialId,
    profileHash: "b".repeat(64),
    orientationDeg: [0, 0, 0] as [number, number, number],
    infillPercent: 100,
    infillPattern: "grid",
    wallLoops: 2,
    topShellLayers: 5,
    bottomShellLayers: 3,
    nozzleTemperatureC: 220,
    layerHeightMm: 0.2,
  };
}

function curve(hashPrefix: string, finalSeparationMm: number) {
  return {
    sourceHash: hashPrefix.repeat(64), sourceLocator: "raw.csv, corrected traction-separation data",
    points: [
      { separationMm: 0, tractionMPa: 0 },
      { separationMm: 0.01, tractionMPa: 10 },
      { separationMm: 0.02, tractionMPa: 18 },
      { separationMm: finalSeparationMm / 2, tractionMPa: 12 },
      { separationMm: finalSeparationMm, tractionMPa: 0 },
    ],
  };
}

function interfaceTestInput(): InterfaceTestInput {
  const value = 18;
  return {
    interfaceKind: "dissimilar-material-bond",
    materialAProcess: process("pla-brand-a"),
    materialBProcess: process("tpu-brand-b"),
    testMode: "normal-tension",
    interfaceNormalGlobal: [0, 0, 1],
    loadDirectionGlobal: [0, 0, 1],
    testMethod: "Documented tensile butt-joint coupon",
    testProtocolHash: "c".repeat(64),
    specimenDescription: "Two printed tabs bonded across one planar material interface.",
    fixtureDescription: "Axial grips load both printed halves normal to the bond plane.",
    measuredPeakStrengthMPa: value,
    specimenResults: Array.from({ length: 5 }, (_, index) => {
      const specimenId = `A-${index + 1}`;
      const strengths = [18, 17, 16, 20, 21];
      return {
        specimenId,
        peakForceN: strengths[index]! * 10,
        netCrossSectionMm2: 10,
        nominalPeakStrengthMPa: strengths[index]!,
        failureLocation: index === 1 ? "material-a" as const : "interface" as const,
        sourceHash: `${index + 1}`.repeat(64),
        sourceLocator: `test report, specimen ${specimenId}`,
      };
    }),
    representativeSpecimenId: "A-1",
    failureLocation: "interface",
    evidence: [{
      id: "interface-peak-strength",
      label: "Measured nominal peak interface stress",
      status: "measured",
      unit: "MPa",
      value,
      sourceHash: "1".repeat(64),
      sourceLocator: "test report, specimen A-1",
      dependsOn: [],
    }],
    specimenCount: 5,
    testedAt: "2026-09-24T10:00:00.000Z",
    source: "physical-material-interface-test",
    callerConfirmsPhysicalTests: true,
  };
}

function query(input: InterfaceTestInput) {
  return {
    interfaceKind: input.interfaceKind,
    materialAProcess: input.materialAProcess,
    materialBProcess: input.materialBProcess,
    testMode: input.testMode,
    interfaceNormalGlobal: input.interfaceNormalGlobal,
    loadDirectionGlobal: input.loadDirectionGlobal,
    testProtocolHash: input.testProtocolHash,
  };
}

function setRepresentativeStrength(input: InterfaceTestInput, value: number): void {
  input.measuredPeakStrengthMPa = value;
  input.evidence[0]!.value = value;
  if (input.tractionSeparationCurve || input.mixedModeTractionSeparationCurve) {
    Reflect.deleteProperty(input, "representativeSpecimenId");
    return;
  }
  const representative = input.specimenResults?.find((specimen) => specimen.specimenId === input.representativeSpecimenId);
  if (representative) {
    representative.peakForceN = value * representative.netCrossSectionMm2;
    representative.nominalPeakStrengthMPa = value;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}
