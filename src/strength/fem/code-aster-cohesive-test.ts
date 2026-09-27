import { analyzeMaterialInterfaceTestCurve, interfaceTestHash, interfaceTestRecordSchema, type InterfaceTestRecord } from "../interface-test.ts";
import { buildCodeAsterCohesiveDeck, type CodeAsterCohesiveDeck, type CodeAsterCohesiveDeckInput } from "./code-aster-cohesive-deck.ts";

export type CodeAsterCohesiveTestInput = Omit<CodeAsterCohesiveDeckInput, "modeI" | "prescribedDisplacementMm"> & {
  record: InterfaceTestRecord;
  adherencePenalty: number;
};

export interface CodeAsterCohesiveTestDeck {
  recordId: string;
  sourceHash: string;
  sourceLocator: string;
  curveSummary: ReturnType<typeof analyzeMaterialInterfaceTestCurve>;
  deckInput: CodeAsterCohesiveDeckInput;
  deck: CodeAsterCohesiveDeck;
}

export function buildCodeAsterCohesiveDeckFromTestRecord(request: CodeAsterCohesiveTestInput): CodeAsterCohesiveTestDeck {
  const record = interfaceTestRecordSchema.parse(request.record);
  if (record.interfaceKind !== "same-material-layer") {
    throw new Error("Code_Aster cohesive calculations accept only same-material printed-layer tests");
  }
  const { id: recordId, createdAt: _createdAt, recordStatus: _recordStatus, ...testInput } = record;
  if (interfaceTestHash(testInput) !== recordId) throw new Error("Interface test record content hash does not match its ID");
  if (record.testMode !== "normal-tension") throw new Error("Code_Aster prototype currently requires a normal-tension interface test");
  if (record.fractureMethod !== "dcb-mode-i") {
    throw new Error("Code_Aster Mode-I cohesive calculations require an explicitly classified DCB Mode-I physical fracture test");
  }
  if (record.failureLocation !== "interface") throw new Error("Code_Aster cohesive input requires an observed interface failure location");
  const normalDot = request.interfaceNormalGlobal.reduce((sum, value, axis) => sum + value * record.interfaceNormalGlobal[axis]!, 0);
  if (!Number.isFinite(normalDot) || normalDot < Math.cos(Math.PI / 180)) {
    throw new Error("Split-plane normal must align with the ordered material orientation in the physical test record");
  }
  const openingDot = request.interfaceNormalGlobal.reduce((sum, value, axis) => sum + value * record.loadDirectionGlobal[axis]!, 0);
  if (openingDot < Math.cos(Math.PI / 180)) {
    throw new Error("Physical normal-tension test load direction must point along the recorded interface normal for this solver prototype");
  }
  const curveSummary = analyzeMaterialInterfaceTestCurve(record);
  const deckInput: CodeAsterCohesiveDeckInput = {
    materialAGrid: request.materialAGrid,
    materialBGrid: request.materialBGrid,
    supportFaceGroup: request.supportFaceGroup,
    loadedFaceGroup: request.loadedFaceGroup,
    cohesiveElementGroup: request.cohesiveElementGroup,
    materialA: request.materialA,
    materialB: request.materialB,
    ...(request.orthotropicMaterialA ? { orthotropicMaterialA: request.orthotropicMaterialA } : {}),
    ...(request.orthotropicMaterialB ? { orthotropicMaterialB: request.orthotropicMaterialB } : {}),
    ...(request.layerwiseOrthotropicRegions ? { layerwiseOrthotropicRegions: request.layerwiseOrthotropicRegions } : {}),
    ...(request.modeILaw ? { modeILaw: request.modeILaw } : {}),
    modeI: {
      peakTractionMPa: curveSummary.peakStrengthMPa,
      fractureEnergyNPerMm: curveSummary.fractureEnergyNPerMm,
      adherencePenalty: request.adherencePenalty,
    },
    interfaceNormalGlobal: request.interfaceNormalGlobal,
    displacementDirectionGlobal: request.displacementDirectionGlobal,
    prescribedDisplacementMm: curveSummary.finalSeparationMm,
    increments: request.increments,
  };
  const deck = buildCodeAsterCohesiveDeck(deckInput);
  return {
    recordId,
    sourceHash: record.tractionSeparationCurve!.sourceHash,
    sourceLocator: record.tractionSeparationCurve!.sourceLocator,
    curveSummary,
    deckInput,
    deck,
  };
}
