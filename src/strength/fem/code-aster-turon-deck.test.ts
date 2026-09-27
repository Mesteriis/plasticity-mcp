import assert from "node:assert/strict";
import test from "node:test";

import { buildCodeAsterTuronDeck, buildCodeAsterTuronDeckFromCalibration, type CodeAsterTuronDeckCalibration, type CodeAsterTuronDeckInput } from "./code-aster-turon-deck.ts";

const input: CodeAsterTuronDeckInput = {
  materialAGrid: "GM1",
  materialBGrid: "GM2",
  supportFaceGroup: "GM4",
  loadedFaceGroup: "GM5",
  cohesiveElementGroup: "GM6",
  materialA: { youngsModulusMPa: 2_000, poissonRatio: 0.3 },
  materialB: { youngsModulusMPa: 2_000, poissonRatio: 0.3 },
  modeI: { peakTractionMPa: 2.4, fractureEnergyNPerMm: 0.02 },
  modeII: { peakTractionMPa: 2, fractureEnergyNPerMm: 0.04 },
  etaBk: 2,
  stiffnessMPaPerMm: 100_000,
  residualStiffnessRatio: 0.001,
  interfaceNormalGlobal: [0, 0, 1],
  prescribedDisplacementGlobalMm: [0, 0.01, 0.01],
  increments: 200,
};

test("builds a v17.4 3D mixed-mode Turon deck from pure-mode test parameters", () => {
  const deck = buildCodeAsterTuronDeck(input);
  assert.equal(deck.solverVersion, "17.4.0");
  assert.match(deck.commandFile, /MODELISATION='3D_JOINT'/);
  assert.match(deck.commandFile, /RUPT_TURON=_F\(GC_N=0\.02,GC_T=0\.04,SIGM_C_N=2\.4,SIGM_C_T=2,K=100000,ETA_BK=2,C_RUPT=0\.001,CRIT_INIT='TURON'\)/);
  assert.match(deck.commandFile, /GROUP_MA='GM5',DX=0,DY=0\.01,DZ=0\.01/);
  assert.match(deck.commandFile, /METHODE='MIXTE',ITER_LINE_MAXI=50/);
  assert.match(deck.exportFile, /F result\.med result\.med R 80/);
  assert.match(deck.limitations.join(" "), /supplied explicitly/);
});

test("rejects invalid material groups, unsupported K, and compressive loading", () => {
  assert.throws(() => buildCodeAsterTuronDeck({ ...input, cohesiveElementGroup: "GM6'); FIN()" }), /physical group/);
  assert.throws(() => buildCodeAsterTuronDeck({ ...input, stiffnessMPaPerMm: 0 }), /stiffness K/);
  assert.throws(() => buildCodeAsterTuronDeck({ ...input, prescribedDisplacementGlobalMm: [0, 0, -0.01] }), /must not close/);
  assert.throws(() => buildCodeAsterTuronDeck({ ...input, residualStiffnessRatio: 0.2 }), /C_RUPT/);
  assert.throws(() => buildCodeAsterTuronDeck({ ...input, increments: 1_001 }), /increments/);
});

test("maps the measured physical-calibration output into both pure-mode laws without guessing K", () => {
  const calibration: CodeAsterTuronDeckCalibration = {
    etaBk: 2,
    pureModePeakTractionMPa: { modeI: 2.4, modeII: 2 },
    pureModeFractureEnergyNPerMm: { modeI: 0.02, modeII: 0.04 },
  };
  const deck = buildCodeAsterTuronDeckFromCalibration(calibration, {
    materialAGrid: input.materialAGrid,
    materialBGrid: input.materialBGrid,
    supportFaceGroup: input.supportFaceGroup,
    loadedFaceGroup: input.loadedFaceGroup,
    cohesiveElementGroup: input.cohesiveElementGroup,
    materialA: input.materialA,
    materialB: input.materialB,
    stiffnessMPaPerMm: input.stiffnessMPaPerMm,
    residualStiffnessRatio: input.residualStiffnessRatio,
    interfaceNormalGlobal: input.interfaceNormalGlobal,
    prescribedDisplacementGlobalMm: input.prescribedDisplacementGlobalMm,
    increments: input.increments,
  });
  assert.match(deck.commandFile, /GC_N=0\.02,GC_T=0\.04,SIGM_C_N=2\.4,SIGM_C_T=2,K=100000,ETA_BK=2/);
});

test("uses one homogeneous orthotropic tensor and print frame on both sides of the same-material interface", () => {
  const bulk = {
    youngsModulus2MPa: 1_500, youngsModulus3MPa: 800, poissonRatio13: 0.2, poissonRatio23: 0.25,
    shearModulus12MPa: 600, shearModulus13MPa: 350, shearModulus23MPa: 300,
    orientation: { axis1DirectionGlobal: [1, 0, 0] as [number, number, number], axis2ReferenceDirectionGlobal: [0, 1, 0] as [number, number, number], buildDirectionGlobal: [0, 0, 1] as [number, number, number] },
  };
  const deck = buildCodeAsterTuronDeck({ ...input, orthotropicMaterialA: bulk, orthotropicMaterialB: bulk });
  assert.match(deck.commandFile, /MAT_A=DEFI_MATERIAU\(ELAS_ORTH=_F\(E_L=2000,E_T=1500,E_N=800,NU_LT=0\.3,NU_LN=0\.2,NU_TN=0\.25,G_LT=600,G_LN=350,G_TN=300\)\)/);
  assert.match(deck.commandFile, /AFFE_CARA_ELEM\(MODELE=MO,MASSIF=\(_F\(GROUP_MA='GM1',ANGL_EULER=\(0,0,0\)\),_F\(GROUP_MA='GM2',ANGL_EULER=\(0,0,0\)\)\)\)/);
  assert.ok(deck.limitations.some((limitation) => limitation.includes("homogeneous orthotropic elastic tensors")));
  assert.throws(() => buildCodeAsterTuronDeck({ ...input, orthotropicMaterialA: bulk }), /both bulk regions/);
  assert.throws(() => buildCodeAsterTuronDeck({ ...input, materialB: { ...input.materialB, youngsModulusMPa: 1_000 }, orthotropicMaterialA: bulk, orthotropicMaterialB: bulk }), /one printed material/);
  assert.throws(() => buildCodeAsterTuronDeck({ ...input, orthotropicMaterialA: bulk, orthotropicMaterialB: { ...bulk, youngsModulus2MPa: 900 } }), /tensors must match/);
});

test("maps a user-confirmed in-plane orthotropic frame to Code_Aster Euler angles", () => {
  const bulk = {
    youngsModulus2MPa: 1_500, youngsModulus3MPa: 800, poissonRatio13: 0.2, poissonRatio23: 0.25,
    shearModulus12MPa: 600, shearModulus13MPa: 350, shearModulus23MPa: 300,
    orientation: { axis1DirectionGlobal: [0, 1, 0] as [number, number, number], axis2ReferenceDirectionGlobal: [-1, 0, 0] as [number, number, number], buildDirectionGlobal: [0, 0, 1] as [number, number, number] },
  };
  const deck = buildCodeAsterTuronDeck({ ...input, orthotropicMaterialA: bulk, orthotropicMaterialB: bulk });
  assert.match(deck.commandFile, /GROUP_MA='GM1',ANGL_EULER=\(90,0,0\)/);
});

test("assigns one measured tensor to every layer while rotating layer-local frames", () => {
  const bulk = {
    youngsModulus2MPa: 1_500, youngsModulus3MPa: 800, poissonRatio13: 0.2, poissonRatio23: 0.25,
    shearModulus12MPa: 600, shearModulus13MPa: 350, shearModulus23MPa: 300,
    orientation: { axis1DirectionGlobal: [1, 0, 0] as [number, number, number], axis2ReferenceDirectionGlobal: [0, 1, 0] as [number, number, number], buildDirectionGlobal: [0, 0, 1] as [number, number, number] },
  };
  const layers = Array.from({ length: 256 }, (_, index) => {
    const degrees = [0, 90, 45][index % 3]!;
    const angle = degrees * Math.PI / 180;
    return {
      layerIndex: index + 1,
      grid: `GM${index + 1}`,
      orientation: {
        axis1DirectionGlobal: [Math.cos(angle), Math.sin(angle), 0] as [number, number, number],
        axis2ReferenceDirectionGlobal: [-Math.sin(angle), Math.cos(angle), 0] as [number, number, number],
        buildDirectionGlobal: [0, 0, 1] as [number, number, number],
      },
    };
  });
  const deck = buildCodeAsterTuronDeck({
    ...input, supportFaceGroup: "GM1001", loadedFaceGroup: "GM1002", cohesiveElementGroup: "GM1003",
    orthotropicMaterialA: bulk, orthotropicMaterialB: bulk, layerwiseOrthotropicRegions: layers,
  });
  assert.equal((deck.commandFile.match(/MATER=MAT_BULK/g) ?? []).length, 256);
  assert.match(deck.commandFile, /GROUP_MA='GM1',ANGL_EULER=\(0,0,0\)/);
  assert.match(deck.commandFile, /GROUP_MA='GM2',ANGL_EULER=\(90,0,0\)/);
  assert.match(deck.commandFile, /GROUP_MA='GM3',ANGL_EULER=\(45,0,0\)/);
  assert.match(deck.commandFile, /GROUP_MA='GM256',ANGL_EULER=\(0,0,0\)/);
  assert.match(deck.commandFile, /GROUP_MA='GM256',PHENOMENE='MECANIQUE',MODELISATION='3D'/);
  assert.ok(deck.limitations.some((limitation) => limitation.includes("directional cohesive adhesion")));
  assert.throws(() => buildCodeAsterTuronDeck({
    ...input, supportFaceGroup: "GM1001", loadedFaceGroup: "GM1002", cohesiveElementGroup: "GM1003",
    orthotropicMaterialA: bulk, orthotropicMaterialB: bulk,
    layerwiseOrthotropicRegions: layers.slice(1),
  }), /GM1 through GM256/);
});
