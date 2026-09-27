import { orthotropicElasticConstantsError, orthotropicEulerAngles, resolveOrthotropicOrientation, type OrthotropicCaseMaterial, type OrthotropicMaterialOrientation } from "./orthotropic-material.ts";
import { MAX_LAYERWISE_FEA_LAYERS } from "./layer-plane-plan.ts";

export interface CodeAsterCohesiveDeckInput {
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
  modeILaw?: "CZM_EXP_REG" | "CZM_LIN_REG";
  modeI: { peakTractionMPa: number; fractureEnergyNPerMm: number; adherencePenalty: number };
  interfaceNormalGlobal: [number, number, number];
  displacementDirectionGlobal: [number, number, number];
  prescribedDisplacementMm: number;
  increments: number;
}

export interface CodeAsterCohesiveDeck {
  commandFile: string;
  exportFile: string;
  displacementComponent: "DX" | "DY" | "DZ";
  displacementScale: number;
  modeILaw: "CZM_EXP_REG" | "CZM_LIN_REG";
  limitations: string[];
}

export function buildCodeAsterCohesiveDeck(input: CodeAsterCohesiveDeckInput): CodeAsterCohesiveDeck {
  validateInput(input);
  const displacement = input.displacementDirectionGlobal.map((component) => component * input.prescribedDisplacementMm);
  const [dx, dy, dz] = displacement;
  const componentIndex = input.displacementDirectionGlobal.reduce((best, value, index) => Math.abs(value) > Math.abs(input.displacementDirectionGlobal[best]!) ? index : best, 0);
  const displacementComponents = ["DX", "DY", "DZ"] as const;
  const displacementComponent = displacementComponents[componentIndex]!;
  const displacementScale = 1 / input.displacementDirectionGlobal[componentIndex]!;
  const modeILaw = input.modeILaw ?? "CZM_EXP_REG";
  const orientationA = input.orthotropicMaterialA ? orthotropicEulerAngles(input.orthotropicMaterialA.orientation) : undefined;
  const orientationB = input.orthotropicMaterialB ? orthotropicEulerAngles(input.orthotropicMaterialB.orientation) : undefined;
  const materialDefinition = (label: "A" | "B", material: CodeAsterCohesiveDeckInput["materialA"], orthotropic: OrthotropicCaseMaterial | undefined) => orthotropic
    ? `MAT_${label} = DEFI_MATERIAU(ELAS_ORTH=_F(E_L=${material.youngsModulusMPa}, E_T=${orthotropic.youngsModulus2MPa}, E_N=${orthotropic.youngsModulus3MPa}, NU_LT=${material.poissonRatio}, NU_LN=${orthotropic.poissonRatio13}, NU_TN=${orthotropic.poissonRatio23}, G_LT=${orthotropic.shearModulus12MPa}, G_LN=${orthotropic.shearModulus13MPa}, G_TN=${orthotropic.shearModulus23MPa}))`
    : `MAT_${label} = DEFI_MATERIAU(ELAS=_F(E=${material.youngsModulusMPa}, NU=${material.poissonRatio}))`;
  const layerwise = input.layerwiseOrthotropicRegions;
  const caraElem = layerwise
    ? `CARA = AFFE_CARA_ELEM(MODELE=MO, MASSIF=(${layerwise.map((region) => `_F(GROUP_MA='${region.grid}', ANGL_EULER=(${orthotropicEulerAngles(region.orientation).join(",")}))`).join(", ")}))\n`
    : orientationA && orientationB
      ? `CARA = AFFE_CARA_ELEM(MODELE=MO, MASSIF=(_F(GROUP_MA='${input.materialAGrid}', ANGL_EULER=(${orientationA.join(",")})), _F(GROUP_MA='${input.materialBGrid}', ANGL_EULER=(${orientationB.join(",")}))))\n`
      : "";
  const bulkModelAssignment = layerwise
    ? layerwise.map((region) => `_F(GROUP_MA='${region.grid}', PHENOMENE='MECANIQUE', MODELISATION='3D')`).join(", ")
    : `_F(GROUP_MA=('${input.materialAGrid}','${input.materialBGrid}'), PHENOMENE='MECANIQUE', MODELISATION='3D')`;
  const elasticDefinitions = layerwise
    ? `MAT_BULK = DEFI_MATERIAU(ELAS_ORTH=_F(E_L=${input.materialA.youngsModulusMPa}, E_T=${input.orthotropicMaterialA!.youngsModulus2MPa}, E_N=${input.orthotropicMaterialA!.youngsModulus3MPa}, NU_LT=${input.materialA.poissonRatio}, NU_LN=${input.orthotropicMaterialA!.poissonRatio13}, NU_TN=${input.orthotropicMaterialA!.poissonRatio23}, G_LT=${input.orthotropicMaterialA!.shearModulus12MPa}, G_LN=${input.orthotropicMaterialA!.shearModulus13MPa}, G_TN=${input.orthotropicMaterialA!.shearModulus23MPa}))\n`
    : `${materialDefinition("A", input.materialA, input.orthotropicMaterialA)}\n${materialDefinition("B", input.materialB, input.orthotropicMaterialB)}\n`;
  const elasticAssignments = layerwise
    ? `${layerwise.map((region) => `_F(GROUP_MA='${region.grid}', MATER=MAT_BULK)`).join(",\n  ")},`
    : `_F(GROUP_MA='${input.materialAGrid}', MATER=MAT_A),\n  _F(GROUP_MA='${input.materialBGrid}', MATER=MAT_B),`;
  const elasticBehaviors = layerwise
    ? `${layerwise.map((region) => `_F(RELATION='ELAS', GROUP_MA='${region.grid}')`).join(",\n    ")},`
    : `_F(RELATION='ELAS', GROUP_MA='${input.materialAGrid}'),\n    _F(RELATION='ELAS', GROUP_MA='${input.materialBGrid}'),`;
  const commandFile = `DEBUT()
MA = LIRE_MAILLAGE(FORMAT='GMSH', UNITE=19)
MA = MODI_MAILLAGE(reuse=MA, MAILLAGE=MA, ORIE_FISSURE=_F(GROUP_MA='${input.cohesiveElementGroup}'))
MA = DEFI_GROUP(reuse=MA, MAILLAGE=MA, CREA_GROUP_NO=_F(NOM='COHESIVE_SUPPORT_NODES', GROUP_MA='${input.supportFaceGroup}'))
MO = AFFE_MODELE(MAILLAGE=MA, AFFE=(
  ${bulkModelAssignment},
  _F(GROUP_MA='${input.cohesiveElementGroup}', PHENOMENE='MECANIQUE', MODELISATION='3D_JOINT'),
))
${elasticDefinitions}
${caraElem.trimEnd()}
MAT_C = DEFI_MATERIAU(RUPT_FRAG=_F(GC=${input.modeI.fractureEnergyNPerMm}, SIGM_C=${input.modeI.peakTractionMPa}, PENA_ADHERENCE=${input.modeI.adherencePenalty}))
CHMAT = AFFE_MATERIAU(MAILLAGE=MA, AFFE=(
  ${elasticAssignments}
  _F(GROUP_MA='${input.cohesiveElementGroup}', MATER=MAT_C),
))
BC = AFFE_CHAR_MECA(MODELE=MO, DDL_IMPO=_F(GROUP_MA='${input.supportFaceGroup}', DX=0.0, DY=0.0, DZ=0.0))
LOAD = AFFE_CHAR_MECA(MODELE=MO, FACE_IMPO=_F(GROUP_MA='${input.loadedFaceGroup}', DX=${dx}, DY=${dy}, DZ=${dz}))
RAMP = DEFI_FONCTION(NOM_PARA='INST', VALE=(0.0,0.0,1.0,1.0))
INST_BASE = DEFI_LIST_REEL(DEBUT=0.0, INTERVALLE=_F(JUSQU_A=1.0, NOMBRE=${input.increments}))
INST = DEFI_LIST_INST(DEFI_LIST=_F(LIST_INST=INST_BASE), ECHEC=_F(
  SUBD_METHODE='MANUEL', SUBD_PAS=2, SUBD_NIVEAU=2))
RESU = STAT_NON_LINE(MODELE=MO, CHAM_MATER=CHMAT, ${caraElem ? "CARA_ELEM=CARA, " : ""}EXCIT=(_F(CHARGE=BC), _F(CHARGE=LOAD, FONC_MULT=RAMP)),
  COMPORTEMENT=(
    ${elasticBehaviors}
    _F(RELATION='${modeILaw}', GROUP_MA='${input.cohesiveElementGroup}'),
  ), INCREMENT=_F(LIST_INST=INST), NEWTON=_F(REAC_ITER=1), CONVERGENCE=_F(ITER_GLOB_MAXI=50))
RESU = CALC_CHAMP(reuse=RESU, RESULTAT=RESU, FORCE='REAC_NODA')
DEPL = POST_RELEVE_T(ACTION=_F(INTITULE='TOP_DISPLACEMENT', OPERATION='EXTREMA', GROUP_MA='${input.loadedFaceGroup}',
  NOM_CHAM='DEPL', NOM_CMP='${displacementComponent}', RESULTAT=RESU, TOUT_ORDRE='OUI'))
REAC = POST_RELEVE_T(ACTION=_F(INTITULE='BOTTOM_REACTION', OPERATION='EXTRACTION', GROUP_NO='COHESIVE_SUPPORT_NODES',
  NOM_CHAM='REAC_NODA', RESULTANTE=('DX','DY','DZ'), RESULTAT=RESU, TOUT_ORDRE='OUI'))
DAMAGE = CREA_TABLE(RESU=_F(RESULTAT=RESU, GROUP_MA='${input.cohesiveElementGroup}', NOM_CHAM='VARI_ELGA', NOM_CMP=('V3','V7','V8','V9')))
IMPR_TABLE(TABLE=DEPL, UNITE=80)
IMPR_TABLE(TABLE=REAC, UNITE=81)
IMPR_TABLE(TABLE=DAMAGE, UNITE=82)
FIN()
`;
  const exportFile = `P time_limit 600
P memory_limit 2048
P ncpus 1
P mpi_nbcpu 1
P mpi_nbnoeud 1
P testlist ci verification sequential
F comm cohesive.comm D 1
F msh cohesive.msh D 19
F result1 result1.txt R 80
F result2 result2.txt R 81
F result3 result3.txt R 82
`;
  return {
    commandFile,
    exportFile,
    displacementComponent,
    displacementScale,
    modeILaw,
    limitations: [
      `This deck applies a single-mode-I ${modeILaw} law parameterized by the selected measured peak traction and integrated fracture energy; it does not reproduce the full measured curve shape. ${modeILaw === "CZM_LIN_REG" ? "The regularized linear law uses a linear softening envelope." : "The regularized exponential law uses an exponential softening envelope."}`,
      "PENA_ADHERENCE is a numerical penalty parameter and requires a sensitivity study; one run is not a calibrated bond-strength prediction.",
      "Failed load steps can be bisected recursively through two subdivision levels; runs that still do not converge are reported as failed, and post-peak instability may still limit convergence under displacement control.",
      "The indicative process-zone estimate is only a mesh screening heuristic; mesh-convergence studies and validation against representative tests are still required.",
      layerwise
        ? "Every deposition layer uses the same exact-process orthotropic tensor with its supplied layer-specific frame; the frames are derived from dominant G-code directions and do not represent within-layer raster mixtures, road-to-road bonding, or measured spatially varying properties."
        : orientationA && orientationB
        ? "Both bulk regions use one homogeneous orthotropic tensor and confirmed print frame for the single material; individual roads, within-part layer-stack changes, and mixed-mode interaction are not modeled."
        : "Both bulk regions are isotropic elastic continua; individual print roads, layer-by-layer anisotropy, and mixed-mode interaction are not modeled.",
      "Results are solver response only and do not establish a strength pass, design allowable, or print approval.",
    ],
  };
}

function validateInput(input: CodeAsterCohesiveDeckInput): void {
  if (input.modeILaw !== undefined && input.modeILaw !== "CZM_EXP_REG" && input.modeILaw !== "CZM_LIN_REG") {
    throw new Error("unsupported Mode-I law; expected CZM_EXP_REG or CZM_LIN_REG");
  }
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
    throw new Error("Cohesive analysis requires orthotropic properties for both bulk regions when either side uses them");
  }
  if (input.orthotropicMaterialA && input.orthotropicMaterialB) {
    for (const [label, orthotropic] of [["material A", input.orthotropicMaterialA], ["material B", input.orthotropicMaterialB]] as const) {
      const invalid = orthotropicElasticConstantsError({
        youngsModulusMPa: input.materialA.youngsModulusMPa,
        youngsModulus2MPa: orthotropic.youngsModulus2MPa,
        youngsModulus3MPa: orthotropic.youngsModulus3MPa,
        poissonRatio12: input.materialA.poissonRatio,
        poissonRatio13: orthotropic.poissonRatio13,
        poissonRatio23: orthotropic.poissonRatio23,
        shearModulus12MPa: orthotropic.shearModulus12MPa,
        shearModulus13MPa: orthotropic.shearModulus13MPa,
        shearModulus23MPa: orthotropic.shearModulus23MPa,
      });
      if (invalid) throw new Error(`${label} orthotropic constants are invalid: ${invalid}`);
    }
    const tensorKeys = ["youngsModulus2MPa", "youngsModulus3MPa", "poissonRatio13", "poissonRatio23", "shearModulus12MPa", "shearModulus13MPa", "shearModulus23MPa"] as const;
    if (tensorKeys.some((key) => input.orthotropicMaterialA![key] !== input.orthotropicMaterialB![key])) {
      throw new Error("Cohesive analysis models one printed material; orthotropic tensors must match on both sides");
    }
    const frameA = resolveOrthotropicOrientation(input.orthotropicMaterialA.orientation);
    const frameB = resolveOrthotropicOrientation(input.orthotropicMaterialB.orientation);
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
    if (!input.orthotropicMaterialA || !input.orthotropicMaterialB) {
      throw new Error("Layerwise material orientations require the exact-process one-material orthotropic tensor");
    }
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
  if (!Number.isFinite(input.modeI.peakTractionMPa) || input.modeI.peakTractionMPa <= 0) {
    throw new Error("Measured mode-I peak traction must be positive");
  }
  if (!Number.isFinite(input.modeI.fractureEnergyNPerMm) || input.modeI.fractureEnergyNPerMm <= 0) {
    throw new Error("Measured mode-I fracture energy must be positive");
  }
  if (!Number.isFinite(input.modeI.adherencePenalty) || input.modeI.adherencePenalty <= 0 || input.modeI.adherencePenalty >= 1) {
    throw new Error("Cohesive adherence penalty must be in (0, 1) and must be sensitivity-checked");
  }
  const normalLength = Math.hypot(...input.interfaceNormalGlobal);
  if (!input.interfaceNormalGlobal.every(Number.isFinite) || Math.abs(normalLength - 1) > 1e-6) {
    throw new Error("Cohesive interface normal must be a finite unit vector");
  }
  const displacementLength = Math.hypot(...input.displacementDirectionGlobal);
  if (!input.displacementDirectionGlobal.every(Number.isFinite) || Math.abs(displacementLength - 1) > 1e-6) {
    throw new Error("Mode-I displacement direction must be a finite unit vector");
  }
  const openingAlignment = input.interfaceNormalGlobal.reduce((sum, value, axis) => sum + value * input.displacementDirectionGlobal[axis]!, 0);
  if (openingAlignment < Math.cos(Math.PI / 180)) {
    throw new Error("Mode-I prescribed opening must align with the declared interface normal within one degree");
  }
  if (!Number.isFinite(input.prescribedDisplacementMm) || input.prescribedDisplacementMm <= 0) {
    throw new Error("Prescribed mode-I opening must be positive");
  }
  if (!Number.isSafeInteger(input.increments) || input.increments < 2 || input.increments > 250) {
    throw new Error("Cohesive nonlinear increments must be an integer in [2, 250] so two recursive bisections stay within the 1001-result history limit");
  }
}
