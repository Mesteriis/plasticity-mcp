import type { TuronPhysicalCalibrationResult } from "./code-aster-turon-physical-calibration.ts";
import { orthotropicElasticConstantsError, orthotropicEulerAngles, resolveOrthotropicOrientation, type OrthotropicCaseMaterial, type OrthotropicMaterialOrientation } from "./orthotropic-material.ts";
import { MAX_LAYERWISE_FEA_LAYERS } from "./layer-plane-plan.ts";

export { orthotropicEulerAngles } from "./orthotropic-material.ts";

export interface CodeAsterTuronDeckInput {
  materialAGrid: string;
  materialBGrid: string;
  supportFaceGroup: string;
  loadedFaceGroup: string;
  cohesiveElementGroup: string;
  materialA: { youngsModulusMPa: number; poissonRatio: number };
  materialB: { youngsModulusMPa: number; poissonRatio: number };
  orthotropicMaterialA?: OrthotropicCaseMaterial;
  orthotropicMaterialB?: OrthotropicCaseMaterial;
  layerwiseOrthotropicRegions?: Array<{ layerIndex: number; grid: string; orientation: OrthotropicMaterialOrientation }>;
  modeI: { peakTractionMPa: number; fractureEnergyNPerMm: number };
  modeII: { peakTractionMPa: number; fractureEnergyNPerMm: number };
  etaBk: number;
  stiffnessMPaPerMm: number;
  residualStiffnessRatio: number;
  interfaceNormalGlobal: [number, number, number];
  prescribedDisplacementGlobalMm: [number, number, number];
  increments: number;
}

export interface CodeAsterTuronDeck {
  commandFile: string;
  exportFile: string;
  solverVersion: "17.4.0";
  limitations: string[];
}

export type CodeAsterTuronDeckCalibration = Pick<
  TuronPhysicalCalibrationResult,
  "etaBk" | "pureModeFractureEnergyNPerMm" | "pureModePeakTractionMPa"
>;

export type CodeAsterTuronDeckCalibrationInput = Omit<CodeAsterTuronDeckInput, "modeI" | "modeII" | "etaBk">;

export function codeAsterTuronDeckInputFromCalibration(
  calibration: CodeAsterTuronDeckCalibration,
  input: CodeAsterTuronDeckCalibrationInput,
): CodeAsterTuronDeckInput {
  return {
    ...input,
    modeI: {
      peakTractionMPa: calibration.pureModePeakTractionMPa.modeI,
      fractureEnergyNPerMm: calibration.pureModeFractureEnergyNPerMm.modeI,
    },
    modeII: {
      peakTractionMPa: calibration.pureModePeakTractionMPa.modeII,
      fractureEnergyNPerMm: calibration.pureModeFractureEnergyNPerMm.modeII,
    },
    etaBk: calibration.etaBk,
  };
}

export function buildCodeAsterTuronDeckFromCalibration(
  calibration: CodeAsterTuronDeckCalibration,
  input: CodeAsterTuronDeckCalibrationInput,
): CodeAsterTuronDeck {
  return buildCodeAsterTuronDeck(codeAsterTuronDeckInputFromCalibration(calibration, input));
}

/** Builds a v17.4 mixed-mode cohesive deck from traceable pure-mode properties and an externally selected K. */
export function buildCodeAsterTuronDeck(input: CodeAsterTuronDeckInput): CodeAsterTuronDeck {
  validateInput(input);
  const [dx, dy, dz] = input.prescribedDisplacementGlobalMm;
  const orientationA = input.orthotropicMaterialA ? orthotropicEulerAngles(input.orthotropicMaterialA.orientation) : undefined;
  const orientationB = input.orthotropicMaterialB ? orthotropicEulerAngles(input.orthotropicMaterialB.orientation) : undefined;
  const layerwise = input.layerwiseOrthotropicRegions;
  const elasticMaterial = (label: "A" | "B", material: CodeAsterTuronDeckInput["materialA"], orthotropic: OrthotropicCaseMaterial | undefined) => orthotropic
    ? `MAT_${label}=DEFI_MATERIAU(ELAS_ORTH=_F(E_L=${material.youngsModulusMPa},E_T=${orthotropic.youngsModulus2MPa},E_N=${orthotropic.youngsModulus3MPa},NU_LT=${material.poissonRatio},NU_LN=${orthotropic.poissonRatio13},NU_TN=${orthotropic.poissonRatio23},G_LT=${orthotropic.shearModulus12MPa},G_LN=${orthotropic.shearModulus13MPa},G_TN=${orthotropic.shearModulus23MPa}))`
    : `MAT_${label}=DEFI_MATERIAU(ELAS=_F(E=${material.youngsModulusMPa},NU=${material.poissonRatio}))`;
  const caraElem = layerwise
    ? `CARA=AFFE_CARA_ELEM(MODELE=MO,MASSIF=(${layerwise.map((region) => `_F(GROUP_MA='${region.grid}',ANGL_EULER=(${orthotropicEulerAngles(region.orientation).join(",")}))`).join(",")}))\n`
    : orientationA && orientationB
    ? `CARA=AFFE_CARA_ELEM(MODELE=MO,MASSIF=(_F(GROUP_MA='${input.materialAGrid}',ANGL_EULER=(${orientationA.join(",")})),_F(GROUP_MA='${input.materialBGrid}',ANGL_EULER=(${orientationB.join(",")}))))\n`
    : "";
  const bulkGroups = layerwise?.map((region) => region.grid) ?? [input.materialAGrid, input.materialBGrid];
  const bulkModelGroups = layerwise
    ? layerwise.map((region) => `_F(GROUP_MA='${region.grid}',PHENOMENE='MECANIQUE',MODELISATION='3D')`).join(",")
    : `_F(GROUP_MA=('${input.materialAGrid}','${input.materialBGrid}'),PHENOMENE='MECANIQUE',MODELISATION='3D')`;
  const bulkMaterialDefinitions = layerwise
    ? `MAT_BULK=DEFI_MATERIAU(ELAS_ORTH=_F(E_L=${input.materialA.youngsModulusMPa},E_T=${input.orthotropicMaterialA!.youngsModulus2MPa},E_N=${input.orthotropicMaterialA!.youngsModulus3MPa},NU_LT=${input.materialA.poissonRatio},NU_LN=${input.orthotropicMaterialA!.poissonRatio13},NU_TN=${input.orthotropicMaterialA!.poissonRatio23},G_LT=${input.orthotropicMaterialA!.shearModulus12MPa},G_LN=${input.orthotropicMaterialA!.shearModulus13MPa},G_TN=${input.orthotropicMaterialA!.shearModulus23MPa}))\n`
    : `${elasticMaterial("A", input.materialA, input.orthotropicMaterialA)}\n${elasticMaterial("B", input.materialB, input.orthotropicMaterialB)}\n`;
  const bulkAssignments = bulkGroups.map((group) => `_F(GROUP_MA='${group}',MATER=${layerwise ? "MAT_BULK" : group === input.materialAGrid ? "MAT_A" : "MAT_B"})`).join(",");
  const bulkBehaviors = bulkGroups.map((group) => `_F(RELATION='ELAS',GROUP_MA='${group}')`).join(",");
  const commandFile = `DEBUT()
MA=LIRE_MAILLAGE(FORMAT='GMSH',UNITE=19)
MA=MODI_MAILLAGE(reuse=MA,MAILLAGE=MA,ORIE_FISSURE=_F(GROUP_MA='${input.cohesiveElementGroup}'))
MA=DEFI_GROUP(reuse=MA,MAILLAGE=MA,CREA_GROUP_NO=_F(NOM='TURON_SUPPORT_NODES',GROUP_MA='${input.supportFaceGroup}'))
MO=AFFE_MODELE(MAILLAGE=MA,AFFE=(${bulkModelGroups},_F(GROUP_MA='${input.cohesiveElementGroup}',PHENOMENE='MECANIQUE',MODELISATION='3D_JOINT')))
${bulkMaterialDefinitions}
${caraElem.trimEnd()}
MAT_C=DEFI_MATERIAU(RUPT_TURON=_F(GC_N=${input.modeI.fractureEnergyNPerMm},GC_T=${input.modeII.fractureEnergyNPerMm},SIGM_C_N=${input.modeI.peakTractionMPa},SIGM_C_T=${input.modeII.peakTractionMPa},K=${input.stiffnessMPaPerMm},ETA_BK=${input.etaBk},C_RUPT=${input.residualStiffnessRatio},CRIT_INIT='TURON'))
CHMAT=AFFE_MATERIAU(MAILLAGE=MA,AFFE=(${bulkAssignments},_F(GROUP_MA='${input.cohesiveElementGroup}',MATER=MAT_C)))
BC=AFFE_CHAR_MECA(MODELE=MO,DDL_IMPO=_F(GROUP_MA='${input.supportFaceGroup}',DX=0.0,DY=0.0,DZ=0.0))
LOAD=AFFE_CHAR_MECA(MODELE=MO,FACE_IMPO=_F(GROUP_MA='${input.loadedFaceGroup}',DX=${dx},DY=${dy},DZ=${dz}))
INST0=DEFI_LIST_REEL(DEBUT=0.0,INTERVALLE=_F(JUSQU_A=1.0,NOMBRE=${input.increments}))
INST=DEFI_LIST_INST(DEFI_LIST=_F(LIST_INST=INST0),ECHEC=_F(SUBD_METHODE='MANUEL',SUBD_PAS=10))
FCT=DEFI_FONCTION(NOM_PARA='INST',VALE=(0.0,0.0,1.0,1.0))
RESU=STAT_NON_LINE(MODELE=MO,CHAM_MATER=CHMAT,${caraElem ? "CARA_ELEM=CARA," : ""}EXCIT=(_F(CHARGE=BC),_F(CHARGE=LOAD,FONC_MULT=FCT)),COMPORTEMENT=(${bulkBehaviors},_F(RELATION='CZM_TURON',GROUP_MA='${input.cohesiveElementGroup}')),INCREMENT=_F(LIST_INST=INST,INST_FIN=1.0),NEWTON=_F(MATRICE='TANGENTE',REAC_ITER=1),RECH_LINEAIRE=_F(METHODE='MIXTE',ITER_LINE_MAXI=50),CONVERGENCE=_F(RESI_GLOB_RELA=5.0e-5,ITER_GLOB_MAXI=1000),SOLVEUR=_F(METHODE='MUMPS'))
IMPR_RESU(FORMAT='MED',RESU=_F(RESULTAT=RESU),UNITE=80)
FIN()
`;
  const exportFile = `P time_limit 600
P memory_limit 2048
P ncpus 1
P mpi_nbcpu 1
P mpi_nbnoeud 1
P testlist verification sequential
F comm turon3d.comm D 1
F msh cohesive.msh D 19
F result.med result.med R 80
`;
  return {
    commandFile,
    exportFile,
    solverVersion: "17.4.0",
    limitations: [
      "The cohesive law uses measured pure-mode peaks and fracture energies plus a fitted Benzeggagh–Kenane exponent; it does not reproduce the full measured traction-separation curves.",
      "The initial interface stiffness K is supplied explicitly and is not inferred by this deck builder; it requires traceable measurement or a documented sensitivity study.",
      layerwise
        ? "Every deposition layer uses one shared exact-process orthotropic tensor with its supplied layer-specific frame; individual roads, within-layer raster mixtures, directional cohesive adhesion, contact, fatigue and process variation are not represented."
        : input.orthotropicMaterialA && input.orthotropicMaterialB
        ? "The bulk materials use supplied homogeneous orthotropic elastic tensors and local axes; individual roads, discrete print layers, contact, fatigue and process variation are not represented."
        : "The bulk materials are isotropic elastic continua; individual roads, a stack of separate print layers, contact, fatigue and process variation are not represented.",
      "The solver result is a cohesive response only, not a strength pass, design allowable or print approval.",
    ],
  };
}

function validateInput(input: CodeAsterTuronDeckInput): void {
  const groups = [input.materialAGrid, input.materialBGrid, input.supportFaceGroup, input.loadedFaceGroup, input.cohesiveElementGroup];
  if (groups.some((group) => !/^GM[1-9]\d{0,5}$/.test(group)) || new Set(groups).size !== groups.length) {
    throw new Error("Code_Aster physical group names must be distinct generated GM groups");
  }
  for (const [label, material] of [["material A", input.materialA], ["material B", input.materialB]] as const) {
    if (!Number.isFinite(material.youngsModulusMPa) || material.youngsModulusMPa <= 0
      || !Number.isFinite(material.poissonRatio) || material.poissonRatio <= -1 || material.poissonRatio >= 0.5) {
      throw new Error(`${label} elastic constants are outside the supported isotropic range`);
    }
  }
  if (input.materialA.youngsModulusMPa !== input.materialB.youngsModulusMPa
    || input.materialA.poissonRatio !== input.materialB.poissonRatio) {
    throw new Error("Cohesive analysis models one printed material; bulk elastic properties must match on both sides");
  }
  if (Boolean(input.orthotropicMaterialA) !== Boolean(input.orthotropicMaterialB)) {
    throw new Error("Code_Aster Turon requires both bulk regions to use orthotropic properties when either side does");
  }
  if (input.orthotropicMaterialA && input.orthotropicMaterialB) {
    for (const [label, material, constants] of [
      ["material A", input.materialA, input.orthotropicMaterialA], ["material B", input.materialB, input.orthotropicMaterialB],
    ] as const) {
      const invalid = orthotropicElasticConstantsError({
        youngsModulusMPa: material.youngsModulusMPa,
        youngsModulus2MPa: constants.youngsModulus2MPa,
        youngsModulus3MPa: constants.youngsModulus3MPa,
        poissonRatio12: material.poissonRatio,
        poissonRatio13: constants.poissonRatio13,
        poissonRatio23: constants.poissonRatio23,
        shearModulus12MPa: constants.shearModulus12MPa,
        shearModulus13MPa: constants.shearModulus13MPa,
        shearModulus23MPa: constants.shearModulus23MPa,
      });
      if (invalid) throw new Error(`${label} orthotropic constants are invalid: ${invalid}`);
      resolveOrthotropicOrientation(constants.orientation);
    }
    const orthotropicA = input.orthotropicMaterialA;
    const orthotropicB = input.orthotropicMaterialB;
    const tensorKeys = ["youngsModulus2MPa", "youngsModulus3MPa", "poissonRatio13", "poissonRatio23", "shearModulus12MPa", "shearModulus13MPa", "shearModulus23MPa"] as const;
    if (tensorKeys.some((key) => orthotropicA[key] !== orthotropicB[key])) {
      throw new Error("Cohesive analysis models one printed material; orthotropic tensors must match on both sides");
    }
    const frameA = resolveOrthotropicOrientation(orthotropicA.orientation);
    const frameB = resolveOrthotropicOrientation(orthotropicB.orientation);
    const frameAxes = ["axis1Global", "axis2Global", "axis3Global", "buildDirectionGlobal"] as const;
    if (frameAxes.some((axis) => frameA[axis].some((component, index) => Math.abs(component - frameB[axis][index]!) > 1e-6))) {
      throw new Error("Cohesive analysis models one printed material; orthotropic print axes must match on both sides");
    }
  }
  if (input.layerwiseOrthotropicRegions) {
    const regions = input.layerwiseOrthotropicRegions;
    if (regions.length < 2 || regions.length > MAX_LAYERWISE_FEA_LAYERS || regions.some((region, index) => region.layerIndex !== index + 1 || region.grid !== `GM${index + 1}`)
      || new Set(regions.map((region) => region.grid)).size !== regions.length) {
      throw new Error(`Layerwise orthotropic regions must contain every ordered generated layer group from GM1 through GM${MAX_LAYERWISE_FEA_LAYERS}`);
    }
    if (!input.orthotropicMaterialA || !input.orthotropicMaterialB) throw new Error("Layerwise material orientations require the exact-process one-material orthotropic tensor");
    if (regions.some((region) => [input.supportFaceGroup, input.loadedFaceGroup, input.cohesiveElementGroup].includes(region.grid))) {
      throw new Error("Layerwise bulk groups must be distinct from cohesive and boundary groups");
    }
    const build = resolveOrthotropicOrientation(input.orthotropicMaterialA.orientation).buildDirectionGlobal;
    for (const region of regions) {
      const frame = resolveOrthotropicOrientation(region.orientation);
      if (frame.buildDirectionGlobal.some((component, axis) => Math.abs(component - build[axis]!) > 1e-6)) {
        throw new Error("Every layerwise material frame must use the measured single-material coupon build direction");
      }
    }
  }
  for (const [label, mode] of [["Mode-I", input.modeI], ["Mode-II", input.modeII]] as const) {
    if (!Number.isFinite(mode.peakTractionMPa) || mode.peakTractionMPa <= 0) throw new Error(`${label} measured peak traction must be positive`);
    if (!Number.isFinite(mode.fractureEnergyNPerMm) || mode.fractureEnergyNPerMm <= 0) throw new Error(`${label} fracture energy must be positive`);
  }
  if (!Number.isFinite(input.etaBk) || input.etaBk <= 0) throw new Error("Fitted ETA_BK must be positive");
  if (!Number.isFinite(input.stiffnessMPaPerMm) || input.stiffnessMPaPerMm <= 0) throw new Error("Cohesive initial stiffness K must be explicitly positive");
  if (!Number.isFinite(input.residualStiffnessRatio) || input.residualStiffnessRatio <= 0 || input.residualStiffnessRatio > 0.1) {
    throw new Error("C_RUPT must be in (0, 0.1]");
  }
  const normalLength = Math.hypot(...input.interfaceNormalGlobal);
  if (!input.interfaceNormalGlobal.every(Number.isFinite) || Math.abs(normalLength - 1) > 1e-6) {
    throw new Error("Cohesive interface normal must be a finite unit vector");
  }
  if (!input.prescribedDisplacementGlobalMm.every(Number.isFinite)
    || Math.hypot(...input.prescribedDisplacementGlobalMm) <= 0) {
    throw new Error("Prescribed displacement vector must contain finite values and have positive magnitude");
  }
  const normalDisplacement = input.interfaceNormalGlobal.reduce((sum, value, axis) => sum + value * input.prescribedDisplacementGlobalMm[axis]!, 0);
  if (normalDisplacement < -1e-9) throw new Error("Prescribed displacement must not close the ordered cohesive interface");
  if (!Number.isSafeInteger(input.increments) || input.increments < 10 || input.increments > 1_000) {
    throw new Error("Cohesive nonlinear increments must be an integer in [10, 1000]");
  }
}
