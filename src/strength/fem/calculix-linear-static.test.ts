import assert from "node:assert/strict";
import test from "node:test";

import { parseCalculixReport, principalStressEigenvalues, renderCalculixDeck } from "./calculix-linear-static.ts";

const request = {
  jobName: "patch-test",
  prescribedDisplacement: { nodeSetName: "FACE_2", axis: 1 as const, valueMm: 0.5 },
  supports: [{ nodeSetName: "FACE_1", axes: [1, 2, 3] as Array<1 | 2 | 3> }],
};
const mesh = ["*NODE", "11, 0, 1, 0", "12, 1, 0, 0", "21, 0, 0, 1", "31, 0, 0, 1", "*ELEMENT, TYPE=C3D4, ELSET=SOLID", "1, 11, 12, 21, 31"].join("\n");
const meshWithElements = [
  "*NODE", "11, 0, 1, 0", "12, 1, 0, 0", "21, 0, 0, 1", "31, 0, -1, 0", "41, 1, 3, 1",
  "*ELEMENT, TYPE=C3D4, ELSET=SOLID", "1, 11, 12, 21, 31", "2, 12, 21, 31, 41",
].join("\n");

test("computes sorted principal stresses from the CalculiX symmetric stress tensor", () => {
  assertPrincipal(principalStressEigenvalues([100, 0, 0, 0, 0, 0]), [0, 0, 100]);
  assertPrincipal(principalStressEigenvalues([0, 0, 0, 50, 0, 0]), [-50, 0, 50]);
  assertPrincipal(principalStressEigenvalues([-20, -20, -20, 0, 0, 0]), [-20, -20, -20]);
  const values = principalStressEigenvalues([30, -10, 5, 12, -7, 4]);
  assert.ok(values[0] < values[1] && values[1] < values[2]);
  assert.ok(values.every(Number.isFinite));
  assert.ok(Math.abs(values.reduce((sum, value) => sum + value, 0) - 25) < 1e-12);
  assert.ok(Math.abs(values[0] * values[1] + values[1] * values[2] + values[2] * values[0] + 409) < 1e-10);
  assert.ok(Math.abs(values[0] * values[1] * values[2] + 2882) < 1e-9);
});

function assertPrincipal(actual: number[], expected: number[]): void {
  assert.equal(actual.length, 3);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]!) < 1e-12));
}

test("parses CalculiX integration-point stress and prescribed-set displacement", () => {
  const report = [
    "stresses (elem, integ.pnt.,sxx,syy,szz,sxy,sxz,syz)",
    "1 1 80 0 0 0 0 0 PLASTICITY_MATERIAL_",
    "2 1 100 0 0 0 0 0 PLASTICITY_MATERIAL_",
    "forces (fx,fy,fz) for set FACE_1 and time  0.1000000E+01",
    "11 -2000 0 0",
    "displacements (vx,vy,vz)",
    "11 0.5 -0.02 0.01",
    "12 0.49 0 0",
  ].join("\n");

  const result = parseCalculixReport(report, request, "/work/patch-test.inp", "/work/patch-test.dat", meshWithElements);
  assert.equal(result.stressIntegrationPointCount, 2);
  assert.equal(result.stressCoordinateBasis, "global");
  assert.equal(result.minimumSxxMPa, 80);
  assert.equal(result.maximumSxxMPa, 100);
  assert.equal(result.stressTensorComponentExtrema.sxx.minimumMPa, 80);
  assert.equal(result.stressTensorComponentExtrema.sxx.maximumMPa, 100);
  assert.equal(result.stressTensorComponentExtrema.sxx.maximumLocation.elementId, 2);
  assert.equal(result.stressTensorComponentExtrema.sxy.minimumMPa, 0);
  assert.equal(result.maximumVonMisesMPa, 100);
  assert.deepEqual(result.maximumVonMisesLocation, { elementId: 2, integrationPoint: 1, centroidMm: [0.5, 0.5, 0.5] });
  assert.equal(result.displacementObservationAxis, 1);
  assert.equal(result.maximumDisplacementOnSetMm, 0.5);
  assert.deepEqual(result.supportReactionN, [-2000, 0, 0]);
  assert.deepEqual(result.supportReactionMomentNmm, [0, 0, 2000]);
  assert.deepEqual(result.supportReactionsByNodeSet, [{ nodeSetName: "FACE_1", forceN: [-2000, 0, 0], momentNmm: [0, 0, 2000] }]);
  const orthotropic = parseCalculixReport(report, {
    ...request,
    orthotropicMaterial: {
      youngsModulus2MPa: 1500,
      youngsModulus3MPa: 1000,
      poissonRatio13: 0.22,
      poissonRatio23: 0.27,
      shearModulus12MPa: 500,
      shearModulus13MPa: 400,
      shearModulus23MPa: 300,
      orientation: { axis1DirectionGlobal: [0, 1, 0], axis2ReferenceDirectionGlobal: [1, 0, 0], buildDirectionGlobal: [0, 0, 1] },
    },
  }, "/work/patch-test.inp", "/work/patch-test.dat", meshWithElements);
  assert.equal(orthotropic.stressCoordinateBasis, "material-local");
  const layerwise = parseCalculixReport(report, {
    ...request,
    orthotropicMaterial: {
      youngsModulus2MPa: 1500, youngsModulus3MPa: 1000,
      poissonRatio13: 0.22, poissonRatio23: 0.27,
      shearModulus12MPa: 500, shearModulus13MPa: 400, shearModulus23MPa: 300,
      orientation: { axis1DirectionGlobal: [1, 0, 0], axis2ReferenceDirectionGlobal: [0, 1, 0], buildDirectionGlobal: [0, 0, 1] },
    },
    layerwiseOrthotropicRegions: [
      { layerIndex: 1, elsetName: "LAYER_1", orientation: { axis1DirectionGlobal: [1, 0, 0], axis2ReferenceDirectionGlobal: [0, 1, 0], buildDirectionGlobal: [0, 0, 1] } },
      { layerIndex: 2, elsetName: "LAYER_2", orientation: { axis1DirectionGlobal: [0, 1, 0], axis2ReferenceDirectionGlobal: [-1, 0, 0], buildDirectionGlobal: [0, 0, 1] } },
    ],
  }, "/work/patch-test.inp", "/work/patch-test.dat", meshWithElements);
  assert.equal(layerwise.stressCoordinateBasis, "layer-local");
});

test("evaluates the optional orthotropic Tsai-Wu criterion at each local integration-point tensor", () => {
  const report = [
    "stresses (elem, integ.pnt.,sxx,syy,szz,sxy,sxz,syz)",
    "1 1 80 0 0 0 0 0",
    "2 1 100 0 0 0 0 0",
    "forces (fx,fy,fz) for set FACE_1 and time  0.1000000E+01",
    "11 -2000 0 0",
    "displacements (vx,vy,vz)",
    "11 0.5 0 0",
  ].join("\n");
  const criterion = {
    strengths: {
      xTensionMPa: 200, xCompressionMPa: 200,
      yTensionMPa: 200, yCompressionMPa: 200,
      zTensionMPa: 200, zCompressionMPa: 200,
      xyShearMPa: 200, xzShearMPa: 200, yzShearMPa: 200,
    },
    interactions: { xy: 0, xz: 0, yz: 0 },
  };
  const material = {
    youngsModulus2MPa: 1500, youngsModulus3MPa: 1000,
    poissonRatio13: 0.22, poissonRatio23: 0.27,
    shearModulus12MPa: 500, shearModulus13MPa: 400, shearModulus23MPa: 300,
    orientation: { axis1DirectionGlobal: [1, 0, 0], axis2ReferenceDirectionGlobal: [0, 1, 0], buildDirectionGlobal: [0, 0, 1] },
  };
  const parsed = parseCalculixReport(report, {
    ...request,
    orthotropicMaterial: material,
    orthotropicTsaiWuCriterion: criterion,
  } as unknown as Parameters<typeof parseCalculixReport>[1], "/work/patch-test.inp", "/work/patch-test.dat", meshWithElements);

  assert.equal(parsed.orthotropicTsaiWu?.maximumFailureIndex, 0.25);
  assert.equal(parsed.orthotropicTsaiWu?.minimumLoadFactorToIndexOne, 2);
  assert.deepEqual(parsed.orthotropicTsaiWu?.minimumLoadFactorLocation, {
    elementId: 2, integrationPoint: 1, centroidMm: [0.5, 0.5, 0.5],
  });
});

test("sums reactions reported for multiple fully fixed support faces", () => {
  const report = [
    "stresses (elem, integ.pnt.,sxx,syy,szz,sxy,sxz,syz)",
    "1 1 100 0 0 0 0 0",
    "forces (fx,fy,fz) for set SUPPORT_A and time  0.1000000E+01",
    "11 -1200 0 0",
    "forces (fx,fy,fz) for set SUPPORT_B and time  0.1000000E+01",
    "21 -800 0 0",
    "displacements (vx,vy,vz)",
    "31 0.5 0 0",
  ].join("\n");

  const result = parseCalculixReport(report, { ...request, supports: [
    { nodeSetName: "SUPPORT_A", axes: [1, 2, 3] },
    { nodeSetName: "SUPPORT_B", axes: [1, 2, 3] },
  ] }, "/work/patch-test.inp", "/work/patch-test.dat", mesh);
  assert.deepEqual(result.supportReactionN, [-2000, 0, 0]);
  assert.deepEqual(result.supportReactionMomentNmm, [0, -800, 1200]);
  assert.deepEqual(result.supportReactionsByNodeSet, [
    { nodeSetName: "SUPPORT_A", forceN: [-1200, 0, 0], momentNmm: [0, 0, 1200] },
    { nodeSetName: "SUPPORT_B", forceN: [-800, 0, 0], momentNmm: [0, -800, 0] },
  ]);
});

test("writes only the explicitly constrained translation axes for each support face", () => {
  const deck = renderCalculixDeck({
    workspacePath: "/work",
    meshPath: "/work/mesh.inp",
    jobName: "selective-supports",
    youngsModulusMPa: 2000,
    poissonRatio: 0.3,
    supports: [
      { nodeSetName: "BASE", axes: [1, 2, 3] },
      { nodeSetName: "ROLLER", axes: [3] },
    ],
    displacementObservation: { nodeSetName: "LOAD", axis: 1 },
    anchors: [],
  }, "mesh.inp", "loads.inp", { nodeSetName: "LOAD", axis: 1 });

  assert.match(deck, /BASE, 1, 1, 0\./);
  assert.match(deck, /BASE, 2, 2, 0\./);
  assert.match(deck, /BASE, 3, 3, 0\./);
  assert.match(deck, /ROLLER, 3, 3, 0\./);
  assert.doesNotMatch(deck, /ROLLER, [12], [12], 0\./);
});

test("renders engineering constants in the explicitly oriented material frame", () => {
  const deck = renderCalculixDeck({
    workspacePath: "/work",
    meshPath: "/work/mesh.inp",
    jobName: "orthotropic-patch",
    youngsModulusMPa: 2000,
    poissonRatio: 0.3,
    orthotropicMaterial: {
      youngsModulus2MPa: 1500,
      youngsModulus3MPa: 1000,
      poissonRatio13: 0.22,
      poissonRatio23: 0.27,
      shearModulus12MPa: 500,
      shearModulus13MPa: 400,
      shearModulus23MPa: 300,
      orientation: { axis1DirectionGlobal: [0, 3, 0], axis2ReferenceDirectionGlobal: [4, 5, 0], buildDirectionGlobal: [0, 0, 1] },
    },
    supports: [{ nodeSetName: "BASE", axes: [1, 2, 3] }],
    displacementObservation: { nodeSetName: "LOAD", axis: 2 },
    anchors: [],
  }, "mesh.inp", undefined, { nodeSetName: "LOAD", axis: 2 });

  assert.match(deck, /\*ORIENTATION, NAME=PLASTICITY_MATERIAL_AXES, SYSTEM=RECTANGULAR\n0, 1, 0, 1, 1, 0/);
  assert.match(deck, /\*ELASTIC, TYPE=ENGINEERING CONSTANTS\n2000, 1500, 1000, 0\.3, 0\.22, 0\.27, 500, 400\n300/);
  assert.match(deck, /\*SOLID SECTION, ELSET=SOLID, MATERIAL=PLASTICITY_MATERIAL, ORIENTATION=PLASTICITY_MATERIAL_AXES/);
});

test("assigns the same measured orthotropic tensor to separate layer element sets with confirmed frames", () => {
  const tensor = {
    youngsModulus2MPa: 1500, youngsModulus3MPa: 1000,
    poissonRatio13: 0.22, poissonRatio23: 0.27,
    shearModulus12MPa: 500, shearModulus13MPa: 400, shearModulus23MPa: 300,
  };
  const layerwiseOrthotropicRegions = [
    { layerIndex: 1, elsetName: "LAYER_1", orientation: { axis1DirectionGlobal: [1, 0, 0] as [number, number, number], axis2ReferenceDirectionGlobal: [0, 1, 0] as [number, number, number], buildDirectionGlobal: [0, 0, 1] as [number, number, number] } },
    { layerIndex: 2, elsetName: "LAYER_2", orientation: { axis1DirectionGlobal: [0, 1, 0] as [number, number, number], axis2ReferenceDirectionGlobal: [-1, 0, 0] as [number, number, number], buildDirectionGlobal: [0, 0, 1] as [number, number, number] } },
  ];
  const deck = renderCalculixDeck({
    workspacePath: "/work", meshPath: "/work/mesh.inp", jobName: "layerwise-orthotropic",
    youngsModulusMPa: 2000, poissonRatio: 0.3,
    orthotropicMaterial: { ...tensor, orientation: layerwiseOrthotropicRegions[0]!.orientation },
    layerwiseOrthotropicRegions,
    supports: [{ nodeSetName: "BASE", axes: [1, 2, 3] }],
    displacementObservation: { nodeSetName: "LOAD", axis: 2 }, anchors: [],
  }, "mesh.inp", undefined, { nodeSetName: "LOAD", axis: 2 });

  assert.equal((deck.match(/\*MATERIAL, NAME=PLASTICITY_MATERIAL\n/g) ?? []).length, 1);
  assert.equal((deck.match(/\*ELASTIC, TYPE=ENGINEERING CONSTANTS/g) ?? []).length, 1);
  assert.match(deck, /\*ORIENTATION, NAME=LAYER_1_AXES, SYSTEM=RECTANGULAR\n1, 0, 0, 1, 1, 0/);
  assert.match(deck, /\*ORIENTATION, NAME=LAYER_2_AXES, SYSTEM=RECTANGULAR\n0, 1, 0, -1, 1, 0/);
  assert.match(deck, /\*SOLID SECTION, ELSET=LAYER_1, MATERIAL=PLASTICITY_MATERIAL, ORIENTATION=LAYER_1_AXES/);
  assert.match(deck, /\*SOLID SECTION, ELSET=LAYER_2, MATERIAL=PLASTICITY_MATERIAL, ORIENTATION=LAYER_2_AXES/);
  assert.doesNotMatch(deck, /\*SOLID SECTION, ELSET=SOLID,/);
});

test("renders layer-local orthotropic sections for the maximum supported layer count", () => {
  const tensor = {
    youngsModulus2MPa: 1500, youngsModulus3MPa: 1000,
    poissonRatio13: 0.22, poissonRatio23: 0.27,
    shearModulus12MPa: 500, shearModulus13MPa: 400, shearModulus23MPa: 300,
  };
  const layerwiseOrthotropicRegions = Array.from({ length: 256 }, (_, index) => {
    const angle = (index % 2) * Math.PI / 2;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    return {
      layerIndex: index + 1,
      elsetName: `LAYER_${index + 1}`,
      orientation: {
        axis1DirectionGlobal: [cosine, sine, 0] as [number, number, number],
        axis2ReferenceDirectionGlobal: [-sine, cosine, 0] as [number, number, number],
        buildDirectionGlobal: [0, 0, 1] as [number, number, number],
      },
    };
  });
  const deck = renderCalculixDeck({
    workspacePath: "/work", meshPath: "/work/mesh.inp", jobName: "layerwise-256",
    youngsModulusMPa: 2000, poissonRatio: 0.3,
    orthotropicMaterial: { ...tensor, orientation: layerwiseOrthotropicRegions[0]!.orientation },
    layerwiseOrthotropicRegions,
    supports: [{ nodeSetName: "BASE", axes: [1, 2, 3] }],
    displacementObservation: { nodeSetName: "LOAD", axis: 2 }, anchors: [],
  }, "mesh.inp", undefined, { nodeSetName: "LOAD", axis: 2 });

  assert.equal((deck.match(/\*SOLID SECTION, ELSET=LAYER_/g) ?? []).length, 256);
  assert.match(deck, /\*SOLID SECTION, ELSET=LAYER_256, MATERIAL=PLASTICITY_MATERIAL, ORIENTATION=LAYER_256_AXES/);
});

test("rejects a CalculiX report without complete stress and displacement evidence", () => {
  assert.throws(() => parseCalculixReport("stresses (elem)\n", request, "input", "report", mesh), /missing stress, support-reaction or displacement/);
  assert.throws(() => parseCalculixReport([
    "stresses (elem, integ.pnt.,sxx,syy,szz,sxy,sxz,syz)",
    "forces (fx,fy,fz)",
    "displacements (vx,vy,vz)",
    "11 0.5 0 0",
  ].join("\n"), request, "input", "report", mesh), /no integration-point stresses/);
});

test("rejects a stress result whose tetrahedron is absent from the exact mesh", () => {
  const report = [
    "stresses (elem, integ.pnt.,sxx,syy,szz,sxy,sxz,syz)",
    "99 1 100 0 0 0 0 0",
    "forces (fx,fy,fz) for set FACE_1 and time  0.1000000E+01",
    "11 -2000 0 0",
    "displacements (vx,vy,vz)",
    "11 0.5 0 0",
  ].join("\n");
  assert.throws(() => parseCalculixReport(report, request, "input", "report", meshWithElements), /stress element 99 is missing from the mesh/);
});
