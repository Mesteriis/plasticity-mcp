import assert from "node:assert/strict";
import test from "node:test";

import { buildCodeAsterCohesiveDeckFromTestRecord } from "./code-aster-cohesive-test.ts";
import { interfaceTestHash, type InterfaceTestInput } from "../interface-test.ts";

const hash = "a".repeat(64);
const process = (materialId: string) => ({
  printerId: "creality-k1c",
  materialId,
  profileHash: hash,
  orientationDeg: [0, 0, 0] as [number, number, number],
  infillPercent: 100,
  infillPattern: "grid",
  wallLoops: 2,
  topShellLayers: 5,
  bottomShellLayers: 3,
  nozzleTemperatureC: 220,
  layerHeightMm: 0.2,
});
const testInput: InterfaceTestInput = {
  interfaceKind: "same-material-layer",
  materialAProcess: process("pla-a"),
  materialBProcess: process("pla-a"),
  testMode: "normal-tension",
  fractureMethod: "dcb-mode-i",
  interfaceNormalGlobal: [0, 0, 1],
  loadDirectionGlobal: [0, 0, 1],
  testMethod: "ASTM D5528 DCB",
  testProtocolHash: hash,
  specimenDescription: "Two printed tabs bonded across one planar material interface.",
  fixtureDescription: "Axial grips load both tabs along the marked normal direction.",
  measuredPeakStrengthMPa: 2.4,
  tractionSeparationCurve: {
    sourceHash: "b".repeat(64), sourceLocator: "curve.csv!A2:B5",
    points: [
      { separationMm: 0, tractionMPa: 0 },
      { separationMm: 0.01, tractionMPa: 2.4 },
      { separationMm: 0.04, tractionMPa: 1.2 },
      { separationMm: 0.08, tractionMPa: 0 },
    ],
  },
  failureLocation: "interface",
  evidence: [{ id: "peak", label: "Measured peak", status: "measured", value: 2.4, unit: "MPa", sourceHash: "c".repeat(64), sourceLocator: "test.pdf p.4", dependsOn: [] }],
  specimenCount: 5,
  testedAt: "2026-09-24T10:00:00.000Z",
  source: "physical-material-interface-test",
  callerConfirmsPhysicalTests: true,
};
const recordFor = (overrides: Partial<InterfaceTestInput> = {}) => {
  const input = { ...testInput, ...overrides };
  return { ...input, id: interfaceTestHash(input), createdAt: "2026-09-24T10:01:00.000Z", recordStatus: "caller-attested-physical-material-interface-test" as const };
};
const record = recordFor();
const request = {
  materialAGrid: "GM1", materialBGrid: "GM2", supportFaceGroup: "GM1001", loadedFaceGroup: "GM1002", cohesiveElementGroup: "GM6",
  materialA: { youngsModulusMPa: 2000, poissonRatio: 0.3 },
  materialB: { youngsModulusMPa: 2000, poissonRatio: 0.3 },
  interfaceNormalGlobal: [0, 0, 1] as [number, number, number],
  displacementDirectionGlobal: [0, 0, 1] as [number, number, number], increments: 10, adherencePenalty: 0.00001,
};

test("binds mode-I solver inputs to the exact immutable measured interface curve", () => {
  const result = buildCodeAsterCohesiveDeckFromTestRecord({ ...request, record });
  assert.equal(result.recordId, record.id);
  assert.equal(result.curveSummary.peakStrengthMPa, 2.4);
  assert.equal(result.curveSummary.fractureEnergyNPerMm, 0.09);
  assert.equal(result.deckInput.modeI.peakTractionMPa, 2.4);
  assert.equal(result.deckInput.modeI.fractureEnergyNPerMm, 0.09);
  assert.equal(result.deckInput.prescribedDisplacementMm, 0.08);
});

test("passes an explicitly selected regularized linear law through the measured DCB deck builder", () => {
  const result = buildCodeAsterCohesiveDeckFromTestRecord({ ...request, record, modeILaw: "CZM_LIN_REG" });
  assert.equal(result.deckInput.modeILaw, "CZM_LIN_REG");
  assert.equal(result.deck.modeILaw, "CZM_LIN_REG");
  assert.match(result.deck.commandFile, /RELATION='CZM_LIN_REG'/);
});

test("builds a recorded mode-I deck for a tilted interface in global coordinates", () => {
  const diagonal = Math.SQRT1_2;
  const tiltedInput: InterfaceTestInput = {
    ...testInput,
    interfaceNormalGlobal: [diagonal, 0, diagonal],
    loadDirectionGlobal: [diagonal, 0, diagonal],
  };
  const tiltedRecord = recordFor(tiltedInput);
  const result = buildCodeAsterCohesiveDeckFromTestRecord({
    ...request,
    interfaceNormalGlobal: tiltedInput.interfaceNormalGlobal,
    displacementDirectionGlobal: tiltedInput.interfaceNormalGlobal,
    record: tiltedRecord,
  });
  assert.deepEqual(result.deckInput.displacementDirectionGlobal, [diagonal, 0, diagonal]);
  assert.match(result.deck.commandFile, /DX=0\.0565685424949238\d*, DY=0, DZ=0\.0565685424949238\d*/);
  assert.equal(result.deck.displacementComponent, "DX");
});

test("rejects non-tensile, non-interface, stale-hash, and orientation-mismatched test records", () => {
  assert.throws(() => buildCodeAsterCohesiveDeckFromTestRecord({ ...request, record: recordFor({ testMode: "interface-shear", fractureMethod: "enf-mode-ii", testMethod: "ASTM D7905 ENF", loadDirectionGlobal: [1, 0, 0] }) }), /normal-tension/);
  assert.throws(() => buildCodeAsterCohesiveDeckFromTestRecord({ ...request, record: recordFor({ failureLocation: "material-a", tractionSeparationCurve: undefined }) }), /failure location/);
  assert.throws(() => buildCodeAsterCohesiveDeckFromTestRecord({ ...request, record: { ...record, id: "d".repeat(64) } as typeof record }), /content hash/);
  assert.throws(() => buildCodeAsterCohesiveDeckFromTestRecord({ ...request, record, interfaceNormalGlobal: [0, 0, -1] }), /ordered material orientation/);
  const reversedLoadInput = { ...testInput, loadDirectionGlobal: [0, 0, -1] as [number, number, number] };
  const reversedLoadRecord = { ...reversedLoadInput, id: interfaceTestHash(reversedLoadInput), createdAt: record.createdAt, recordStatus: record.recordStatus };
  assert.throws(() => buildCodeAsterCohesiveDeckFromTestRecord({ ...request, record: reversedLoadRecord }), /load direction must point along/);
});

test("rejects dissimilar-material test records from all cohesive solver calculations", () => {
  const dissimilarInput: InterfaceTestInput = {
    ...testInput, interfaceKind: "dissimilar-material-bond", materialBProcess: process("pla-b"),
  };
  const dissimilarRecord = recordFor(dissimilarInput);
  assert.throws(() => buildCodeAsterCohesiveDeckFromTestRecord({ ...request, record: dissimilarRecord }), /only same-material/);
});
