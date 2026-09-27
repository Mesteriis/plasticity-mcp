import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InterfaceTestStore, type InterfaceTestInput } from "../interface-test.ts";
import { assertTuronDisplacementMatchesMeasuredShear, calibrateTuronCandidateFromInterfaceTests } from "./code-aster-turon-physical-calibration.ts";

test("calibrates an ETA_BK candidate only from matching DCB, ENF and distinct MMB evidence", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-turon-calibration-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const store = new InterfaceTestStore(root);
  const modeI = await store.record(pureModeInput("normal-tension", "a", [0, 0, 1], 10, 0.2));
  const modeII = await store.record(pureModeInput("interface-shear", "b", [1, 0, 0], 20, 0.4));
  const mixed25 = await store.record(mixedModeInput("c", 0.25, 1.1875, [Math.sin(Math.PI / 6), 0, Math.cos(Math.PI / 6)]));
  const mixed75 = await store.record(mixedModeInput("d", 0.75, 2.6875, [Math.sin(Math.PI / 3), 0, Math.cos(Math.PI / 3)]));

  const result = await calibrateTuronCandidateFromInterfaceTests(store, {
    modeIRecordId: modeI.record.id,
    modeIIRecordId: modeII.record.id,
    mixedModeRecordIds: [mixed25.record.id, mixed75.record.id],
  });
  assert.ok(Math.abs(result.etaBk - 2) < 1e-12);
  assert.equal(result.modeIRecordId, modeI.record.id);
  assert.equal(result.modeIIRecordId, modeII.record.id);
  assert.deepEqual(result.materialProcess, modeI.record.materialAProcess);
  assert.equal("materialPair" in result, false);
  assert.deepEqual(result.pureModePeakTractionMPa, { modeI: 10, modeII: 20 });
  assert.deepEqual(result.mixedModeRecordIds, [mixed25.record.id, mixed75.record.id]);
  assert.ok(result.samples.every((sample) => Math.abs(sample.relativeEnergyResidual) < 1e-12));
  assert.equal(result.interpretation, "candidate-calibration-requires-engineering-review");
  assert.ok(result.limitations.some((limitation) => limitation.includes("initial cohesive stiffness K")));
  assert.ok(result.limitations.some((limitation) => limitation.includes("does not establish that the physical interface is isotropic")));
});

test("requires mixed-mode displacement to use the measured same-material interface shear axis", () => {
  assert.doesNotThrow(() => assertTuronDisplacementMatchesMeasuredShear(
    [0.01, 0, 0.01], [0, 0, 1], [1, 0, 0],
  ));
  assert.throws(() => assertTuronDisplacementMatchesMeasuredShear(
    [0, 0, 0.01], [0, 0, 1], [1, 0, 0],
  ), /both opening-normal and in-plane tangential components/i);
  assert.throws(() => assertTuronDisplacementMatchesMeasuredShear(
    [0.01, 0, 0], [0, 0, 1], [1, 0, 0],
  ), /both opening-normal and in-plane tangential components/i);
  assert.throws(() => assertTuronDisplacementMatchesMeasuredShear(
    [0, 0.01, 0.01], [0, 0, 1], [1, 0, 0],
  ), /align with the measured ENF\/MMB shear direction/i);
});

test("rejects Turon calibration from dissimilar-material bond tests", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-turon-dissimilar-materials-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const store = new InterfaceTestStore(root);
  const dissimilar = <T extends InterfaceTestInput>(input: T): T => ({
    ...input,
    interfaceKind: "dissimilar-material-bond",
    materialBProcess: process("tpu-brand-b"),
  });
  const modeI = await store.record(dissimilar(pureModeInput("normal-tension", "a", [0, 0, 1], 10, 0.2)));
  const modeII = await store.record(dissimilar(pureModeInput("interface-shear", "b", [1, 0, 0], 20, 0.4)));
  const mixed25 = await store.record(dissimilar(mixedModeInput("c", 0.25, 1.1875, [Math.sin(Math.PI / 6), 0, Math.cos(Math.PI / 6)])));
  const mixed75 = await store.record(dissimilar(mixedModeInput("d", 0.75, 2.6875, [Math.sin(Math.PI / 3), 0, Math.cos(Math.PI / 3)])));

  await assert.rejects(() => calibrateTuronCandidateFromInterfaceTests(store, {
    modeIRecordId: modeI.record.id,
    modeIIRecordId: modeII.record.id,
    mixedModeRecordIds: [mixed25.record.id, mixed75.record.id],
  }), /only same-material printed-layer interfaces/);
});

test("rejects a free-text tensile method that conflicts with the declared DCB fracture method", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-turon-protocol-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const store = new InterfaceTestStore(root);
  const modeIInput = pureModeInput("normal-tension", "a", [0, 0, 1], 10, 0.2);
  modeIInput.testMethod = "Unspecified tensile coupon";
  await assert.rejects(() => store.record(modeIInput), /testMethod must explicitly identify the DCB physical test/i);
});

test("rejects calibration when chosen records do not share an ordered physical interface", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-turon-calibration-mismatch-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const store = new InterfaceTestStore(root);
  const modeI = await store.record(pureModeInput("normal-tension", "a", [0, 0, 1], 10, 0.2));
  const modeIIInput = pureModeInput("interface-shear", "b", [1, 0, 0], 20, 0.4);
  const differentProcess = process("different-pla");
  modeIIInput.materialAProcess = differentProcess;
  modeIIInput.materialBProcess = differentProcess;
  const modeII = await store.record(modeIIInput);
  const mixed25 = await store.record(mixedModeInput("c", 0.25, 1.1875, [Math.sin(Math.PI / 6), 0, Math.cos(Math.PI / 6)]));
  const mixed75 = await store.record(mixedModeInput("d", 0.75, 2.6875, [Math.sin(Math.PI / 3), 0, Math.cos(Math.PI / 3)]));
  await assert.rejects(() => calibrateTuronCandidateFromInterfaceTests(store, {
    modeIRecordId: modeI.record.id, modeIIRecordId: modeII.record.id,
    mixedModeRecordIds: [mixed25.record.id, mixed75.record.id],
  }), /same single-material print process and interface normal/);
});

test("rejects mixed-mode calibration when ENF and MMB shear directions differ", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-turon-tangent-direction-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const store = new InterfaceTestStore(root);
  const modeI = await store.record(pureModeInput("normal-tension", "a", [0, 0, 1], 10, 0.2));
  const modeII = await store.record(pureModeInput("interface-shear", "b", [1, 0, 0], 20, 0.4));
  const mixed25 = await store.record(mixedModeInput("c", 0.25, 1.1875, [0, Math.sin(Math.PI / 6), Math.cos(Math.PI / 6)]));
  const mixed75 = await store.record(mixedModeInput("d", 0.75, 2.6875, [0, Math.sin(Math.PI / 3), Math.cos(Math.PI / 3)]));

  await assert.rejects(() => calibrateTuronCandidateFromInterfaceTests(store, {
    modeIRecordId: modeI.record.id,
    modeIIRecordId: modeII.record.id,
    mixedModeRecordIds: [mixed25.record.id, mixed75.record.id],
  }), /same in-plane shear direction/);
});

test("rejects a selected physical test when matching registry records conflict", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-turon-calibration-conflict-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const store = new InterfaceTestStore(root);
  const modeIInput = pureModeInput("normal-tension", "a", [0, 0, 1], 10, 0.2);
  const modeI = await store.record(modeIInput);
  const conflict = pureModeInput("normal-tension", "e", [0, 0, 1], 12, 0.2);
  conflict.testProtocolHash = modeIInput.testProtocolHash;
  conflict.testedAt = "2026-09-25T10:00:00.000Z";
  await store.record(conflict);
  const modeII = await store.record(pureModeInput("interface-shear", "b", [1, 0, 0], 20, 0.4));
  const mixed25 = await store.record(mixedModeInput("c", 0.25, 1.1875, [Math.sin(Math.PI / 6), 0, Math.cos(Math.PI / 6)]));
  const mixed75 = await store.record(mixedModeInput("d", 0.75, 2.6875, [Math.sin(Math.PI / 3), 0, Math.cos(Math.PI / 3)]));
  await assert.rejects(() => calibrateTuronCandidateFromInterfaceTests(store, {
    modeIRecordId: modeI.record.id, modeIIRecordId: modeII.record.id,
    mixedModeRecordIds: [mixed25.record.id, mixed75.record.id],
  }), /conflicting or ambiguous/);
});

function process(materialId: string) {
  return {
    printerId: "creality-k1c-0.4", materialId, profileHash: "b".repeat(64),
    orientationDeg: [0, 0, 0] as [number, number, number], infillPercent: 100, infillPattern: "grid", wallLoops: 2, topShellLayers: 5, bottomShellLayers: 3, nozzleTemperatureC: 220,
    layerHeightMm: 0.2,
  };
}

function baseInput(testMode: InterfaceTestInput["testMode"], source: string, loadDirectionGlobal: [number, number, number]): InterfaceTestInput {
  const sameMaterialProcess = process("pla-brand-a");
  return {
    interfaceKind: "same-material-layer",
    materialAProcess: sameMaterialProcess, materialBProcess: sameMaterialProcess,
    testMode, fractureMethod: testMode === "normal-tension" ? "dcb-mode-i" : testMode === "interface-shear" ? "enf-mode-ii" : "mmb-mixed-mode",
    interfaceNormalGlobal: [0, 0, 1], loadDirectionGlobal,
    testMethod: testMode === "normal-tension" ? "ASTM D5528 DCB" : testMode === "interface-shear" ? "ASTM D7905 ENF" : "ASTM D6671 MMB",
    testProtocolHash: source.repeat(64),
    specimenDescription: "A printed PLA specimen with one measured interlayer interface.",
    fixtureDescription: "A calibrated fixture applies displacement across the printed layer interface.",
    measuredPeakStrengthMPa: 10, failureLocation: "interface",
    evidence: [{ id: `${source}-peak`, label: "Measured peak traction", status: "measured", unit: "MPa", value: 10, sourceHash: "9".repeat(64), sourceLocator: `${source}.csv peak`, dependsOn: [] }],
    specimenCount: 5, testedAt: `2026-09-${source === "e" ? "25" : "24"}T10:00:00.000Z`,
    source: "physical-material-interface-test", callerConfirmsPhysicalTests: true,
  };
}

function pureModeInput(mode: "normal-tension" | "interface-shear", source: string, direction: [number, number, number], peakMPa: number, finalSeparationMm: number): InterfaceTestInput {
  const input = baseInput(mode, source, direction);
  input.measuredPeakStrengthMPa = peakMPa;
  input.evidence[0]!.value = peakMPa;
  input.tractionSeparationCurve = {
    sourceHash: source.repeat(64), sourceLocator: `${source}.csv, compliance-corrected pure-mode curve`,
    points: [
      { separationMm: 0, tractionMPa: 0 },
      { separationMm: finalSeparationMm / 2, tractionMPa: peakMPa },
      { separationMm: finalSeparationMm, tractionMPa: 0 },
    ],
  };
  return input;
}

function mixedModeInput(source: string, tangentialFraction: number, totalEnergy: number, loadDirectionGlobal: [number, number, number]): InterfaceTestInput {
  const input = baseInput("mixed-mode", source, loadDirectionGlobal);
  const normalEnergy = totalEnergy * (1 - tangentialFraction);
  const tangentialEnergy = totalEnergy * tangentialFraction;
  const normalFinal = 2 * normalEnergy / 10;
  const tangentialFinal = 2 * tangentialEnergy / 10;
  const resultantPeak = Math.sqrt(200);
  input.measuredPeakStrengthMPa = resultantPeak;
  input.evidence[0]!.value = resultantPeak;
  input.mixedModeTractionSeparationCurve = {
    sourceHash: source.repeat(64), sourceLocator: `${source}.csv, compliance-corrected MMB vector curve`,
    points: [
      { normalSeparationMm: 0, tangentialSeparationMm: 0, normalTractionMPa: 0, tangentialTractionMPa: 0 },
      { normalSeparationMm: normalFinal / 2, tangentialSeparationMm: tangentialFinal / 2, normalTractionMPa: 10, tangentialTractionMPa: 10 },
      { normalSeparationMm: normalFinal, tangentialSeparationMm: tangentialFinal, normalTractionMPa: 0, tangentialTractionMPa: 0 },
    ],
  };
  return input;
}
