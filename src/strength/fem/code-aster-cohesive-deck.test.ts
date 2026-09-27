import assert from "node:assert/strict";
import test from "node:test";

import { buildCodeAsterCohesiveDeck } from "./code-aster-cohesive-deck.ts";

const request = {
  materialAGrid: "GM1",
  materialBGrid: "GM2",
  supportFaceGroup: "GM4",
  loadedFaceGroup: "GM5",
  cohesiveElementGroup: "GM6",
  materialA: { youngsModulusMPa: 2_000, poissonRatio: 0.3 },
  materialB: { youngsModulusMPa: 2_000, poissonRatio: 0.3 },
  modeI: { peakTractionMPa: 2.4, fractureEnergyNPerMm: 0.02, adherencePenalty: 0.00001 },
  interfaceNormalGlobal: [0, 0, 1] as [number, number, number],
  displacementDirectionGlobal: [0, 0, 1] as [number, number, number],
  prescribedDisplacementMm: 0.01,
  increments: 10,
};

test("builds a bounded Code_Aster mode-I deck for one material with measured cohesive parameters", () => {
  const deck = buildCodeAsterCohesiveDeck(request);
  assert.match(deck.commandFile, /^DEBUT\(\)/);
  assert.match(deck.commandFile, /MODI_MAILLAGE\(reuse=MA, MAILLAGE=MA, ORIE_FISSURE=_F\(GROUP_MA='GM6'\)\)/);
  assert.match(deck.commandFile, /_F\(GROUP_MA=\('GM1','GM2'\), PHENOMENE='MECANIQUE', MODELISATION='3D'\)/);
  assert.match(deck.commandFile, /ELAS=_F\(E=2000, NU=0\.3\)/);
  assert.match(deck.commandFile, /ELAS=_F\(E=2000, NU=0\.3\)/);
  assert.match(deck.commandFile, /RUPT_FRAG=_F\(GC=0\.02, SIGM_C=2\.4, PENA_ADHERENCE=0\.00001\)/);
  assert.match(deck.commandFile, /GROUP_MA='GM5', DX=0, DY=0, DZ=0\.01/);
  assert.match(deck.commandFile, /RAMP = DEFI_FONCTION\(NOM_PARA='INST', VALE=\(0\.0,0\.0,1\.0,1\.0\)\)/);
  assert.match(deck.commandFile, /_F\(CHARGE=LOAD, FONC_MULT=RAMP\)/);
  assert.match(deck.commandFile, /INST_BASE = DEFI_LIST_REEL\(DEBUT=0\.0, INTERVALLE=_F\(JUSQU_A=1\.0, NOMBRE=10\)\)/);
  assert.match(deck.commandFile, /INST = DEFI_LIST_INST\(DEFI_LIST=_F\(LIST_INST=INST_BASE\), ECHEC=_F\(/);
  assert.match(deck.commandFile, /SUBD_METHODE='MANUEL', SUBD_PAS=2, SUBD_NIVEAU=2/);
  assert.match(deck.exportFile, /F result3 result3\.txt R 82/);
  assert.match(deck.limitations.join(" "), /single-mode-I/);
  assert.match(deck.limitations.join(" "), /mesh-convergence studies and validation/);
});

test("builds the explicitly selected regularized linear mode-I law while retaining the exponential default", () => {
  const defaultDeck = buildCodeAsterCohesiveDeck(request);
  const linearDeck = buildCodeAsterCohesiveDeck({ ...request, modeILaw: "CZM_LIN_REG" });

  assert.match(defaultDeck.commandFile, /RELATION='CZM_EXP_REG'/);
  assert.match(linearDeck.commandFile, /RELATION='CZM_LIN_REG'/);
  assert.match(linearDeck.limitations.join(" "), /regularized linear/);
  assert.throws(() => buildCodeAsterCohesiveDeck({ ...request, modeILaw: "CZM_TURON" as never }), /unsupported Mode-I law/);
});

test("prescribes and reports mode-I opening normal to an arbitrarily oriented layer plane", () => {
  const diagonal = Math.SQRT1_2;
  const deck = buildCodeAsterCohesiveDeck({
    ...request,
    interfaceNormalGlobal: [diagonal, 0, diagonal],
    displacementDirectionGlobal: [diagonal, 0, diagonal],
  });
  assert.match(deck.commandFile, /GROUP_MA='GM5', DX=0\.0070710678118654\d+, DY=0, DZ=0\.0070710678118654\d+/);
  assert.match(deck.commandFile, /NOM_CMP='DX'/);
  assert.equal(deck.displacementComponent, "DX");
  assert.equal(deck.displacementScale, 1 / diagonal);
});

test("rejects group injection, invalid cohesion values, and unsupported step counts", () => {
  assert.throws(() => buildCodeAsterCohesiveDeck({ ...request, supportFaceGroup: "GM4'); FIN()" }), /physical group/);
  assert.throws(() => buildCodeAsterCohesiveDeck({ ...request, modeI: { ...request.modeI, fractureEnergyNPerMm: 0 } }), /fracture energy/);
  assert.throws(() => buildCodeAsterCohesiveDeck({ ...request, increments: 251 }), /1001-result history limit/);
  assert.throws(() => buildCodeAsterCohesiveDeck({ ...request, interfaceNormalGlobal: [1, 0, 0] }), /align with the declared interface normal/);
  assert.throws(() => buildCodeAsterCohesiveDeck({ ...request, displacementDirectionGlobal: [1, 0, 0] }), /align with the declared interface normal/);
  assert.throws(() => buildCodeAsterCohesiveDeck({ ...request, materialB: { youngsModulusMPa: 1_000, poissonRatio: 0.28 } }), /one printed material/);
});

test("builds the one-material orthotropic Mode-I deck with a confirmed material frame", () => {
  const orthotropicMaterial = {
    youngsModulus2MPa: 1_500, youngsModulus3MPa: 800, poissonRatio13: 0.2, poissonRatio23: 0.25,
    shearModulus12MPa: 600, shearModulus13MPa: 350, shearModulus23MPa: 300,
    orientation: {
      axis1DirectionGlobal: [1, 0, 0] as [number, number, number],
      axis2ReferenceDirectionGlobal: [0, 1, 0] as [number, number, number],
      buildDirectionGlobal: [0, 0, 1] as [number, number, number],
    },
  };
  const deck = buildCodeAsterCohesiveDeck({
    ...request, orthotropicMaterialA: orthotropicMaterial, orthotropicMaterialB: orthotropicMaterial,
  });
  assert.match(deck.commandFile, /ELAS_ORTH=_F\(E_L=2000, E_T=1500, E_N=800, NU_LT=0\.3, NU_LN=0\.2, NU_TN=0\.25, G_LT=600, G_LN=350, G_TN=300\)/);
  assert.match(deck.commandFile, /CARA = AFFE_CARA_ELEM\(MODELE=MO, MASSIF=/);
  assert.match(deck.commandFile, /CARA_ELEM=CARA/);
  assert.match(deck.commandFile, /GROUP_MA='GM6', NOM_CHAM='VARI_ELGA'/);
  assert.match(deck.commandFile, /RELATION='ELAS', GROUP_MA='GM1'/);
  assert.match(deck.limitations.join(" "), /one homogeneous orthotropic tensor/);
  assert.throws(() => buildCodeAsterCohesiveDeck({ ...request, orthotropicMaterialA: orthotropicMaterial }), /both bulk regions/);
  assert.throws(() => buildCodeAsterCohesiveDeck({
    ...request, orthotropicMaterialA: orthotropicMaterial,
    orthotropicMaterialB: { ...orthotropicMaterial, youngsModulus2MPa: 900 },
  }), /tensors must match/);
});

test("assigns one shared orthotropic tensor and separate confirmed axes to ordered layer regions", () => {
  const tensor = {
    youngsModulus2MPa: 1_500, youngsModulus3MPa: 800, poissonRatio13: 0.2, poissonRatio23: 0.25,
    shearModulus12MPa: 600, shearModulus13MPa: 350, shearModulus23MPa: 300,
  };
  const buildDirectionGlobal = [0, 0, 1] as [number, number, number];
  const frames: Array<{
    axis1DirectionGlobal: [number, number, number];
    axis2ReferenceDirectionGlobal: [number, number, number];
  }> = [
    { axis1DirectionGlobal: [1, 0, 0], axis2ReferenceDirectionGlobal: [0, 1, 0] },
    { axis1DirectionGlobal: [0, 1, 0], axis2ReferenceDirectionGlobal: [-1, 0, 0] },
    { axis1DirectionGlobal: [Math.SQRT1_2, Math.SQRT1_2, 0], axis2ReferenceDirectionGlobal: [-Math.SQRT1_2, Math.SQRT1_2, 0] },
  ] as const;
  const regions = frames.map((frame, index) => ({
    layerIndex: index + 1,
    grid: `GM${index + 1}`,
    orientation: { ...frame, buildDirectionGlobal },
  }));
  const material = {
    ...tensor,
    orientation: {
      axis1DirectionGlobal: [1, 0, 0] as [number, number, number],
      axis2ReferenceDirectionGlobal: [0, 1, 0] as [number, number, number],
      buildDirectionGlobal,
    },
  };
  const deck = buildCodeAsterCohesiveDeck({
    ...request,
    orthotropicMaterialA: material,
    orthotropicMaterialB: material,
    layerwiseOrthotropicRegions: regions,
  });

  assert.equal((deck.commandFile.match(/MAT_BULK = DEFI_MATERIAU/g) ?? []).length, 1);
  assert.match(deck.commandFile, /GROUP_MA='GM1', MATER=MAT_BULK/);
  assert.match(deck.commandFile, /GROUP_MA='GM2', MATER=MAT_BULK/);
  assert.match(deck.commandFile, /GROUP_MA='GM3', MATER=MAT_BULK/);
  assert.match(deck.commandFile, /GROUP_MA='GM1', ANGL_EULER=\(0,0,0\)/);
  assert.match(deck.commandFile, /GROUP_MA='GM2', ANGL_EULER=\(90,0,0\)/);
  assert.match(deck.commandFile, /GROUP_MA='GM3', ANGL_EULER=/);
  assert.match(deck.commandFile, /GROUP_MA='GM3', PHENOMENE='MECANIQUE', MODELISATION='3D'/);
  assert.match(deck.commandFile, /RELATION='ELAS', GROUP_MA='GM3'/);
  assert.match(deck.limitations.join(" "), /same exact-process orthotropic tensor/);
  assert.throws(() => buildCodeAsterCohesiveDeck({
    ...request, orthotropicMaterialA: material, orthotropicMaterialB: material,
    layerwiseOrthotropicRegions: [...regions].reverse(),
  }), /ordered generated layer group/);
  assert.throws(() => buildCodeAsterCohesiveDeck({
    ...request, orthotropicMaterialA: material, orthotropicMaterialB: material,
    layerwiseOrthotropicRegions: regions.map((region) => ({
      ...region, orientation: { ...region.orientation, buildDirectionGlobal: [0, 1, 0] as [number, number, number] },
    })),
  }), /build direction/);
});
