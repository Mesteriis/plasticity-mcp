import assert from "node:assert/strict";
import test from "node:test";

import { parseCodeAsterCohesiveResults } from "./code-aster-cohesive-results.ts";

const displacement = `#ASTER 15.02.00
INTITULE RESU NOM_CHAM NUME_ORDRE INST EXTREMA NOEUD CMP VALE
TOP_DISPLACEMENT 0000000a DEPL 0 0.00000E+00 MIN N1 DZ -1.00000E-03
TOP_DISPLACEMENT 0000000a DEPL 0 0.00000E+00 MAX N1 DZ 2.00000E-03
TOP_DISPLACEMENT 0000000a DEPL 1 1.00000E+00 MIN N1 DZ 8.00000E-03
TOP_DISPLACEMENT 0000000a DEPL 1 1.00000E+00 MAX N1 DZ 1.00000E-02`;

const reaction = `#ASTER 15.02.00
INTITULE RESU NOM_CHAM NUME_ORDRE INST DX DY DZ
BOTTOM_REACTION 0000000a REAC_NODA 0 0.00000E+00 0 0 0
BOTTOM_REACTION 0000000a REAC_NODA 1 1.00000E+00 1.5 -2.5 -46.7309`;

const state = `#ASTER 15.02.00
RESULTAT NOM_CHAM INST NUME_ORDRE MAILLE POINT SOUS_POINT COOR_X COOR_Y COOR_Z V3 V7 V8 V9
0000000a VARI_ELGA 0.00000E+00 0 M40 1 1 0 0 2 0.0 0.0 0.0 0.0
0000000a VARI_ELGA 0.00000E+00 0 M41 1 1 1 0 2 0.0 0.0 0.0 0.0
0000000a VARI_ELGA 1.00000E+00 1 M40 1 1 0 0 2 0.75 0.006 0.001 -0.002
0000000a VARI_ELGA 1.00000E+00 1 M41 1 1 1 0 2 0.25 0.003 -0.002 0.001
0000000a VARI_ELGA 1.00000E+00 1 M99 1 1 1 1 1 99 99 99 99`;

test("parses response histories and only states for the declared cohesive interface elements", () => {
  const result = parseCodeAsterCohesiveResults({
    displacementTable: displacement,
    reactionTable: reaction,
    stateVariableTable: state,
    cohesiveElementIds: [40, 41],
  });

  assert.equal(result.solverVersion, "15.02.00");
  assert.equal(result.v3Interpretation, "damage-variable-0-to-1");
  assert.deepEqual(result.displacementHistory, [
    { order: 0, time: 0, minMm: -0.001, maxMm: 0.002 },
    { order: 1, time: 1, minMm: 0.008, maxMm: 0.01 },
  ]);
  assert.deepEqual(result.reactionHistory.at(-1), { order: 1, time: 1, xN: 1.5, yN: -2.5, zN: -46.7309 });
  assert.deepEqual(result.interfaceStateHistory, [
    { order: 0, time: 0, elementCount: 2, variables: { V3: { min: 0, max: 0 }, V7: { min: 0, max: 0 }, V8: { min: 0, max: 0 }, V9: { min: 0, max: 0 } } },
    { order: 1, time: 1, elementCount: 2, variables: { V3: { min: 0.25, max: 0.75 }, V7: { min: 0.003, max: 0.006 }, V8: { min: -0.002, max: 0.001 }, V9: { min: -0.002, max: 0.001 } } },
  ]);
  assert.equal(result.interpretation, "raw-cohesive-solver-response");
});

test("labels CZM_LIN_REG V3 as a rupture state and preserves the documented broken value", () => {
  const linearState = state.replaceAll("0.75", "2.0").replaceAll("0.25", "2.0");
  const result = parseCodeAsterCohesiveResults({
    displacementTable: displacement,
    reactionTable: reaction,
    stateVariableTable: linearState,
    cohesiveElementIds: [40, 41],
    modeILaw: "CZM_LIN_REG",
  });

  assert.equal(result.v3Interpretation, "state-variable-2-means-fully-broken");
  assert.equal(result.interfaceStateHistory.at(-1)?.variables.V3.max, 2);
});

test("projects the prescribed dominant-axis displacement back onto an oblique interface normal", () => {
  const oblique = displacement.replaceAll("DZ", "DX");
  const result = parseCodeAsterCohesiveResults({
    displacementTable: oblique,
    reactionTable: reaction,
    stateVariableTable: state,
    cohesiveElementIds: [40, 41],
    displacementComponent: "DX",
    displacementScale: Math.SQRT2,
  });
  assert.deepEqual(result.displacementHistory, [
    { order: 0, time: 0, minMm: -0.0014142135623730952, maxMm: 0.0028284271247461905 },
    { order: 1, time: 1, minMm: 0.011313708498984762, maxMm: 0.014142135623730952 },
  ]);
});

test("orders projected displacement extrema when the dominant normal component is negative", () => {
  const result = parseCodeAsterCohesiveResults({
    displacementTable: displacement.replaceAll("DZ", "DX"),
    reactionTable: reaction,
    stateVariableTable: state,
    cohesiveElementIds: [40, 41],
    displacementComponent: "DX",
    displacementScale: -Math.SQRT2,
  });
  assert.deepEqual(result.displacementHistory[0], {
    order: 0, time: 0, minMm: -0.0028284271247461905, maxMm: 0.0014142135623730952,
  });
});

test("rejects output that omits declared cohesive elements or mixes solver versions", () => {
  assert.throws(() => parseCodeAsterCohesiveResults({
    displacementTable: displacement,
    reactionTable: reaction,
    stateVariableTable: state.replace(" M41 1 1", " M99 1 1"),
    cohesiveElementIds: [40, 41],
  }), /does not contain every declared cohesive element/);

  assert.throws(() => parseCodeAsterCohesiveResults({
    displacementTable: displacement,
    reactionTable: reaction.replace("15.02.00", "14.06.00"),
    stateVariableTable: state,
    cohesiveElementIds: [40, 41],
  }), /same Code_Aster version/);
});

test("rejects empty tables instead of reporting an empty successful analysis", () => {
  const empty = "#ASTER 15.02.00\nheader only";
  assert.throws(() => parseCodeAsterCohesiveResults({
    displacementTable: empty,
    reactionTable: empty,
    stateVariableTable: empty,
    cohesiveElementIds: [40],
  }), /contain no parsed result increments/);
});

test("parses Code_Aster 17.4 mesh-cell IDs without the 15.2 M prefix", () => {
  const state17 = state.split("\n").filter((line) => !line.includes(" M99 "))
    .join("\n").replaceAll(" M40 ", " 40 ").replaceAll(" M41 ", " 41 ");
  const result = parseCodeAsterCohesiveResults({
    displacementTable: displacement.replace("15.02.00", "17.04.00"),
    reactionTable: reaction.replace("15.02.00", "17.04.00"),
    stateVariableTable: state17.replace("15.02.00", "17.04.00"),
    cohesiveElementIds: [140, 141],
    allowSolverRenumberedElementIds: true,
  });
  assert.equal(result.solverVersion, "17.04.00");
  assert.equal(result.interfaceStateHistory.at(-1)?.elementCount, 2);
});
