import { z } from "zod";

import {
  analyzeMaterialInterfaceTestCurve,
  analyzeMixedModeMaterialInterfaceTestCurve,
  interfaceTestRecordSchema,
  type InterfaceTestRecord,
  type InterfaceTestStore,
} from "../interface-test.ts";
import { exactMaterialCouponProcessSchema, materialCouponProcessSchema } from "../material-qualification.ts";
import { calibrateBenzeggaghKenaneExponent, type TuronBenzeggaghKenaneCalibration } from "./code-aster-turon-calibration.ts";

export const turonPhysicalCalibrationInputSchema = z.object({
  modeIRecordId: z.string().regex(/^[a-f0-9]{64}$/),
  modeIIRecordId: z.string().regex(/^[a-f0-9]{64}$/),
  mixedModeRecordIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(2).max(10),
}).strict().superRefine((input, context) => {
  const ids = [input.modeIRecordId, input.modeIIRecordId, ...input.mixedModeRecordIds];
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: ["mixedModeRecordIds"], message: "Calibration input must reference distinct immutable physical test records" });
});

export type TuronPhysicalCalibrationInput = z.infer<typeof turonPhysicalCalibrationInputSchema>;

export interface TuronPhysicalCalibrationResult extends TuronBenzeggaghKenaneCalibration {
  source: "immutable-local-physical-material-interface-test-registry";
  pureModePeakTractionMPa: { modeI: number; modeII: number };
  modeIRecordId: string;
  modeIIRecordId: string;
  mixedModeRecordIds: string[];
  materialProcess: InterfaceTestRecord["materialAProcess"];
  interfaceNormalGlobal: InterfaceTestRecord["interfaceNormalGlobal"];
}

const calibrationEvidenceSchema = z.object({ sourceHash: z.string().regex(/^[a-f0-9]{64}$/), sourceLocator: z.string().min(1) }).strict();
export const turonPhysicalCalibrationResultSchema = z.object({
  etaBk: z.number().finite().positive(),
  pureModeFractureEnergyNPerMm: z.object({ modeI: z.number().finite().positive(), modeII: z.number().finite().positive() }).strict(),
  calibrationEvidence: z.object({ modeI: calibrationEvidenceSchema, modeII: calibrationEvidenceSchema }).strict(),
  samples: z.array(z.object({
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/), sourceLocator: z.string().min(1),
    observedFractureEnergyNPerMm: z.number().finite().positive(), tangentialEnergyFraction: z.number().finite().gt(0).lt(1),
    predictedFractureEnergyNPerMm: z.number().finite().positive(), relativeEnergyResidual: z.number().finite(),
  }).strict()).min(2).max(10),
  interpretation: z.literal("candidate-calibration-requires-engineering-review"),
  limitations: z.array(z.string().min(1)).max(100),
  source: z.literal("immutable-local-physical-material-interface-test-registry"),
  pureModePeakTractionMPa: z.object({ modeI: z.number().finite().positive(), modeII: z.number().finite().positive() }).strict(),
  modeIRecordId: z.string().regex(/^[a-f0-9]{64}$/), modeIIRecordId: z.string().regex(/^[a-f0-9]{64}$/),
  mixedModeRecordIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(2).max(10),
  materialProcess: materialCouponProcessSchema,
  interfaceNormalGlobal: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
}).strict();

export const turonStoredPhysicalCalibrationResultSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const legacy = value as Record<string, unknown>;
  if ("materialProcess" in legacy || !legacy.materialPair || typeof legacy.materialPair !== "object" || Array.isArray(legacy.materialPair)) return value;
  const pair = legacy.materialPair as Record<string, unknown>;
  if (pair.interfaceKind !== "same-material-layer") return value;
  const processA = materialCouponProcessSchema.safeParse(pair.materialAProcess);
  const processB = materialCouponProcessSchema.safeParse(pair.materialBProcess);
  if (!processA.success || !processB.success || JSON.stringify(processA.data) !== JSON.stringify(processB.data)) return value;
  const { materialPair: _materialPair, ...rest } = legacy;
  return { ...rest, materialProcess: processA.data, interfaceNormalGlobal: pair.interfaceNormalGlobal };
}, turonPhysicalCalibrationResultSchema);

export async function calibrateTuronCandidateFromInterfaceTests(
  store: InterfaceTestStore,
  rawInput: TuronPhysicalCalibrationInput,
): Promise<TuronPhysicalCalibrationResult> {
  const input = turonPhysicalCalibrationInputSchema.parse(rawInput);
  const records = await Promise.all([
    store.read(input.modeIRecordId),
    store.read(input.modeIIRecordId),
    ...input.mixedModeRecordIds.map((recordId) => store.read(recordId)),
  ]);
  const [modeIRecord, modeIIRecord, ...mixedModeRecords] = records.map((record) => interfaceTestRecordSchema.parse(record));
  assertCalibrationMode(modeIRecord!, "normal-tension", "DCB", "Mode-I");
  assertCalibrationMode(modeIIRecord!, "interface-shear", "ENF", "Mode-II");
  for (const record of mixedModeRecords) assertCalibrationMode(record, "mixed-mode", "MMB", "mixed-mode");
  for (const record of records) assertSameMaterialInterface(records[0]!, record);
  const modeIITangentDirection = interfaceTangentDirection(modeIIRecord!.interfaceNormalGlobal, modeIIRecord!.loadDirectionGlobal);
  for (const record of mixedModeRecords) {
    const mixedModeTangentDirection = interfaceTangentDirection(record.interfaceNormalGlobal, record.loadDirectionGlobal);
    const alignment = Math.abs(dot(modeIITangentDirection, mixedModeTangentDirection));
    if (alignment < Math.cos(Math.PI / 180)) {
      throw new Error("ENF and MMB calibration records must use the same in-plane shear direction because CZM_TURON has one tangential law");
    }
  }
  for (const record of records) await assertUnambiguousRecord(store, record);

  const modeI = analyzeMaterialInterfaceTestCurve(modeIRecord!);
  const modeII = analyzeMaterialInterfaceTestCurve(modeIIRecord!);
  const mixedMode = mixedModeRecords.map((record) => analyzeMixedModeMaterialInterfaceTestCurve(record));
  const calibration = calibrateBenzeggaghKenaneExponent({
    modeI: {
      sourceHash: modeI.sourceHash,
      sourceLocator: modeI.sourceLocator,
      fractureEnergyNPerMm: modeI.fractureEnergyNPerMm,
    },
    modeII: {
      sourceHash: modeII.sourceHash,
      sourceLocator: modeII.sourceLocator,
      fractureEnergyNPerMm: modeII.fractureEnergyNPerMm,
    },
    mixedMode: mixedMode.map((curve) => ({
      sourceHash: curve.sourceHash,
      sourceLocator: curve.sourceLocator,
      fractureEnergyNPerMm: curve.totalFractureEnergyNPerMm,
      tangentialEnergyFraction: curve.tangentialEnergyFraction,
    })),
  });
  return {
    ...calibration,
    source: "immutable-local-physical-material-interface-test-registry",
    pureModePeakTractionMPa: { modeI: modeI.peakStrengthMPa, modeII: modeII.peakStrengthMPa },
    modeIRecordId: modeIRecord!.id,
    modeIIRecordId: modeIIRecord!.id,
    mixedModeRecordIds: mixedModeRecords.map((record) => record.id),
    materialProcess: modeIRecord!.materialAProcess,
    interfaceNormalGlobal: modeIRecord!.interfaceNormalGlobal,
  };
}

export function assertTuronDisplacementMatchesMeasuredShear(
  displacementGlobalMm: readonly [number, number, number],
  interfaceNormalGlobal: readonly [number, number, number],
  measuredShearLoadDirectionGlobal: readonly [number, number, number],
): void {
  const magnitude = Math.hypot(...displacementGlobalMm);
  if (!Number.isFinite(magnitude) || magnitude <= 1e-12) {
    throw new Error("Mixed-mode Turon displacement must be nonzero");
  }
  const normalComponent = dot(displacementGlobalMm, interfaceNormalGlobal);
  const tangent = displacementGlobalMm.map((component, axis) => component - normalComponent * interfaceNormalGlobal[axis]!) as [number, number, number];
  const tangentMagnitude = Math.hypot(...tangent);
  const minimumComponentFraction = Math.sin(Math.PI / 180);
  if (normalComponent / magnitude <= minimumComponentFraction || tangentMagnitude / magnitude <= minimumComponentFraction) {
    throw new Error("Mixed-mode Turon displacement must contain both opening-normal and in-plane tangential components greater than one degree");
  }

  const testTangent = interfaceTangentDirection(interfaceNormalGlobal, measuredShearLoadDirectionGlobal);
  const displacementTangent = tangent.map((component) => component / tangentMagnitude);
  if (Math.abs(dot(testTangent, displacementTangent)) < Math.cos(Math.PI / 180)) {
    throw new Error("Mixed-mode Turon displacement shear direction must align with the measured ENF/MMB shear direction within one degree; the calibrated law has only one tangential response");
  }
}

async function assertUnambiguousRecord(store: InterfaceTestStore, record: InterfaceTestRecord): Promise<void> {
  const materialAProcess = exactMaterialCouponProcessSchema.parse(record.materialAProcess);
  const materialBProcess = exactMaterialCouponProcessSchema.parse(record.materialBProcess);
  const match = await store.match({
    interfaceKind: record.interfaceKind,
    materialAProcess,
    materialBProcess,
    testMode: record.testMode,
    interfaceNormalGlobal: record.interfaceNormalGlobal,
    loadDirectionGlobal: record.loadDirectionGlobal,
    testProtocolHash: record.testProtocolHash,
  });
  if (match.status !== "matched" || !match.records.some((candidate) => candidate.id === record.id)) {
    throw new Error(`Calibration test ${record.id} is missing, conflicting or ambiguous for its exact interface setup`);
  }
}

function assertCalibrationMode(
  record: InterfaceTestRecord,
  mode: InterfaceTestRecord["testMode"],
  protocol: "DCB" | "ENF" | "MMB",
  label: string,
): void {
  if (record.testMode !== mode) throw new Error(`${label} calibration requires a ${mode} physical interface-test record`);
  if (!new RegExp(`\\b${protocol}\\b`, "i").test(record.testMethod)) {
    throw new Error(`${label} calibration record must identify the ${protocol} protocol in its testMethod`);
  }
  const fractureMethod = protocol === "DCB" ? "dcb-mode-i" : protocol === "ENF" ? "enf-mode-ii" : "mmb-mixed-mode";
  if (record.fractureMethod !== fractureMethod) {
    throw new Error(`${label} calibration record must be explicitly classified as ${fractureMethod}`);
  }
  if (record.failureLocation !== "interface") throw new Error(`${label} calibration requires observed failure at the tested interface`);
}

function assertSameMaterialInterface(reference: InterfaceTestRecord, candidate: InterfaceTestRecord): void {
  if (reference.interfaceKind !== "same-material-layer" || candidate.interfaceKind !== "same-material-layer") {
    throw new Error("Turon physical calibration supports only same-material printed-layer interfaces");
  }
  if (JSON.stringify(reference.materialAProcess) !== JSON.stringify(reference.materialBProcess)
    || JSON.stringify(candidate.materialAProcess) !== JSON.stringify(candidate.materialBProcess)) {
    throw new Error("Turon physical calibration requires one identical material and print process on both sides of each interface");
  }
  if (JSON.stringify(reference.materialAProcess) !== JSON.stringify(candidate.materialAProcess)
    || JSON.stringify(reference.interfaceNormalGlobal) !== JSON.stringify(candidate.interfaceNormalGlobal)) {
    throw new Error("DCB, ENF and MMB calibration records must describe the same single-material print process and interface normal");
  }
}

function interfaceTangentDirection(
  normal: readonly [number, number, number],
  load: readonly [number, number, number],
): [number, number, number] {
  const normalComponent = dot(normal, load);
  const tangent = load.map((component, axis) => component - normalComponent * normal[axis]!) as [number, number, number];
  const magnitude = Math.hypot(...tangent);
  if (!Number.isFinite(magnitude) || magnitude <= 1e-9) {
    throw new Error("Interface shear calibration requires a measurable in-plane loading direction");
  }
  return tangent.map((component) => component / magnitude) as [number, number, number];
}

function dot(left: readonly number[], right: readonly number[]): number {
  return left.reduce((sum, value, axis) => sum + value * right[axis]!, 0);
}
