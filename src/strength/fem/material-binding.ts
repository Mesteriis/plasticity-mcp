import {
  orthotropicTsaiWuInteractionTestAxis,
  orthotropicTsaiWuTestMetadata,
  sameMaterialCouponProcess,
  type MaterialCouponQualificationRecord,
  type MaterialCouponQualificationStore,
  type MaterialCouponProcess,
} from "../material-qualification.ts";
import type { FemStaticInput } from "./fem-report-store.ts";
import { resolveOrthotropicOrientation } from "./orthotropic-material.ts";

export async function verifyFemCouponBinding(
  store: MaterialCouponQualificationStore,
  input: Pick<FemStaticInput, "materialCoupon" | "youngsModulusMPa">
    & Partial<Pick<FemStaticInput, "poissonRatio" | "poissonRatioEvidence">>,
): Promise<void> {
  const reference = input.materialCoupon;
  if (!reference) return;
  if (reference.process.layerHeightMm === undefined) {
    throw new Error("FEA physical coupon binding requires the measured slicer layer height");
  }
  const process = reference.process as MaterialCouponProcess & { layerHeightMm: number };
  const match = await store.match({ process });
  if (match.status !== "matched" || match.selected?.id !== reference.recordId) {
    throw new Error("FEA requires the selected physical coupon to be the unique exact-process match; review no-match or ambiguous coupon records first");
  }
  const record = match.selected;
  if (!sameMaterialCouponProcess(record.process, process)) {
    throw new Error("FEA material coupon reference does not match the exact printer, material, profile, orientation, infill percentage and pattern, wall loops, top/bottom shell layers, nozzle temperature and layer height");
  }
  if (input.youngsModulusMPa !== record.properties.youngModulusMPa) {
    throw new Error("FEA Young's modulus does not equal the selected physical coupon record; use the recorded value or omit the coupon reference");
  }
  assertCouponPoissonRatio(record, input.poissonRatio, input.poissonRatioEvidence);
}

export function assertCouponPoissonRatio(
  record: MaterialCouponQualificationRecord,
  value: number | undefined,
  evidence?: {
    id: string; status: string; unit: string; value?: number | undefined; sourceUrl?: string | undefined;
    sourceHash?: string | undefined; sourceLocator?: string | undefined; derivation?: string | undefined; dependsOn: string[];
  },
): void {
  if (record.poissonRatio === undefined) return;
  if (value !== record.poissonRatio) {
    throw new Error("FEA Poisson ratio nu12 does not equal the selected exact-process physical coupon record");
  }
  if (!evidence) throw new Error("FEA Poisson-ratio evidence is required by the selected exact-process physical coupon record");
  const ids = record.poissonRatioEvidence ?? [];
  const stored = record.evidence.find((candidate) => candidate.id === evidence.id);
  if (!ids.includes(evidence.id) || !stored || canonicalEvidence(stored) !== canonicalEvidence(evidence)) {
    throw new Error("FEA Poisson-ratio evidence does not match the selected exact-process physical coupon record");
  }
}

export async function verifyFemOrthotropicCouponBinding(
  store: MaterialCouponQualificationStore,
  input: FemStaticInput,
): Promise<void> {
  const orthotropic = input.orthotropicMaterial;
  const recordId = orthotropic?.couponRecordId;
  if (!orthotropic || !recordId) return;
  const process = orthotropic.process;
  if (!process || process.layerHeightMm === undefined) {
    throw new Error("Full orthotropic coupon binding requires the exact measured single-material process including slicer layer height");
  }
  if (!input.materialCoupon || input.materialCoupon.recordId !== recordId
    || !sameMaterialCouponProcess(input.materialCoupon.process, process)) {
    throw new Error("Full orthotropic coupon and Young's-modulus bindings must reference the same exact-process record");
  }
  const exactProcess = process as MaterialCouponProcess & { layerHeightMm: number };
  const match = await store.match({ process: exactProcess });
  if (match.status !== "matched" || match.selected?.id !== recordId) {
    throw new Error("Full orthotropic coupon binding requires the selected record to be the unique exact-process match; review no-match or ambiguous coupon records first");
  }
  const record = match.selected;
  if (!sameMaterialCouponProcess(record.process, process)) {
    throw new Error("Full orthotropic coupon record does not match the exact printer, material, profile, orientation, infill percentage and pattern, wall loops, top/bottom shell layers, nozzle temperature and layer height");
  }
  if (input.youngsModulusMPa !== record.properties.youngModulusMPa) {
    throw new Error("FEA E1 does not equal the selected exact-process orthotropic coupon record");
  }
  const recordMaterial = record.orthotropicMaterial;
  if (!recordMaterial) throw new Error("Selected exact-process coupon record has no measured orthotropic elastic tensor");
  if (record.poissonRatio === undefined || !record.poissonRatioEvidence?.length) {
    throw new Error("Full orthotropic coupon record must include measured nu12 and its evidence");
  }
  assertCouponPoissonRatio(record, input.poissonRatio, input.poissonRatioEvidence);

  const properties = [
    "youngsModulus2MPa", "youngsModulus3MPa", "poissonRatio13", "poissonRatio23",
    "shearModulus12MPa", "shearModulus13MPa", "shearModulus23MPa",
  ] as const;
  for (const key of properties) {
    if (orthotropic[key] !== recordMaterial[key]) {
      throw new Error(`FEA ${key} does not equal the selected exact-process orthotropic coupon record`);
    }
    const evidence = orthotropic.evidence[key];
    const ids = recordMaterial.propertyEvidence[key];
    const stored = record.evidence.find((candidate) => candidate.id === evidence.id);
    if (!ids.includes(evidence.id) || !stored || canonicalEvidence(stored) !== canonicalEvidence(evidence)) {
      throw new Error(`FEA ${key} evidence does not match the selected exact-process orthotropic coupon record`);
    }
  }

  const recordAxes = resolveOrthotropicOrientation(recordMaterial.orientation);
  const inputAxes = resolveOrthotropicOrientation(orthotropic.orientation);
  const frameAxes = ["axis1Global", "axis2Global", "axis3Global", "buildDirectionGlobal"] as const;
  if (!frameAxes.every((axis) => sameDirection(inputAxes[axis], recordAxes[axis]))) {
    throw new Error("Orthotropic coupon print axes do not match the FEA material coordinate frame");
  }
  if (canonicalEvidence(orthotropic.orientation.evidence) !== canonicalEvidence(recordMaterial.orientation.evidence)) {
    throw new Error("Orthotropic coupon print-axis evidence does not match the selected exact-process physical coupon record");
  }
}

function canonicalEvidence(evidence: object): string {
  return JSON.stringify(Object.fromEntries(Object.entries(evidence)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))));
}

export async function resolveFemTsaiWuQualification(
  store: MaterialCouponQualificationStore,
  input: FemStaticInput,
): Promise<FemStaticInput> {
  const orthotropic = "orthotropicMaterial" in input ? input.orthotropicMaterial : undefined;
  if (!orthotropic) return input;
  const recordId = orthotropic.tsaiWuQualificationRecordId ?? orthotropic.tsaiWuCriterion?.qualificationRecordId;
  if (!recordId) return input;
  const process = orthotropic.process;
  if (!process) throw new Error("An exact single-material print process is required to bind Tsai-Wu coupon data");
  if (process.layerHeightMm === undefined) throw new Error("Tsai-Wu FEA binding requires the measured slicer layer height");
  const exactProcess = process as MaterialCouponProcess & { layerHeightMm: number };
  const match = await store.match({ process: exactProcess });
  if (match.status !== "matched" || match.selected?.id !== recordId) {
    throw new Error("Tsai-Wu data requires the selected record to be the unique exact-process match; review no-match or ambiguous records first");
  }
  const record = await store.read(recordId);
  if (!sameMaterialCouponProcess(record.process, exactProcess)) {
    throw new Error("Tsai-Wu qualification record does not match the exact printer, material, profile, orientation, infill percentage and pattern, wall loops, top/bottom shell layers, nozzle temperature and layer height");
  }
  assertCouponPoissonRatio(record, input.poissonRatio, input.poissonRatioEvidence);
  const recordMaterial = record.orthotropicMaterial;
  const qualification = recordMaterial?.tsaiWuCriterion;
  if (!recordMaterial || !qualification) throw new Error("Selected exact-process coupon record has no measured orthotropic Tsai-Wu test data");
  const inputFrame = resolveOrthotropicOrientation(orthotropic.orientation);
  const recordFrame = resolveOrthotropicOrientation(recordMaterial.orientation);
  const frameAxes = ["axis1Global", "axis2Global", "axis3Global", "buildDirectionGlobal"] as const;
  if (!frameAxes.every((axis) => sameDirection(inputFrame[axis], recordFrame[axis]))) {
    throw new Error("Tsai-Wu coupon print axes do not match the FEA material coordinate frame");
  }
  const existing = orthotropic.tsaiWuCriterion;
  if (existing && (
    !sameNumericValues(existing.strengths, qualification.strengths)
    || !sameNumericValues(existing.interactions, qualification.interactions)
  )) {
    throw new Error("Inline Tsai-Wu values conflict with the referenced immutable qualification record");
  }
  const evidenceById = new Map(record.evidence.map((item) => [item.id, item]));
  for (const [key, ids] of Object.entries(qualification.strengthEvidence)) {
    const evidence = evidenceById.get(ids[0]!);
    const expected = orthotropicTsaiWuTestMetadata[key as keyof typeof orthotropicTsaiWuTestMetadata];
    if (!expected || evidence?.testAxis !== expected.testAxis || evidence.testMode !== expected.testMode) {
      throw new Error(`Tsai-Wu qualification record lacks declared ${key} loading-axis metadata; re-record the physical test direction before FEA`);
    }
  }
  for (const [key, id] of Object.entries(qualification.interactionEvidence)) {
    const expectedAxis = orthotropicTsaiWuInteractionTestAxis[key as keyof typeof orthotropicTsaiWuInteractionTestAxis];
    const interaction = evidenceById.get(id);
    if (!expectedAxis || interaction?.testAxis !== expectedAxis || interaction.testMode !== "biaxial") {
      throw new Error(`Tsai-Wu qualification record lacks declared ${key} biaxial-axis metadata; re-record the physical test direction before FEA`);
    }
    for (const dependencyId of interaction.dependsOn) {
      const dependency = evidenceById.get(dependencyId);
      if (dependency?.testAxis !== expectedAxis || dependency.testMode !== "biaxial") {
        throw new Error(`Tsai-Wu biaxial evidence ${dependencyId} lacks declared ${expectedAxis} loading-axis metadata; re-record the physical test direction before FEA`);
      }
    }
  }
  const withProcess = (id: string) => {
    const evidence = evidenceById.get(id);
    if (!evidence) throw new Error(`Tsai-Wu qualification record is missing evidence ${id}`);
    return { ...evidence, process: exactProcess };
  };
  const strengthEvidence = Object.fromEntries(Object.entries(qualification.strengthEvidence).map(([key, ids]) => [key, withProcess(ids[0]!)])) as NonNullable<NonNullable<FemStaticInput["orthotropicMaterial"]>["tsaiWuCriterion"]>["strengthEvidence"];
  const interactionEvidence = Object.fromEntries(Object.entries(qualification.interactionEvidence).map(([key, id]) => [key, withProcess(id)])) as NonNullable<NonNullable<FemStaticInput["orthotropicMaterial"]>["tsaiWuCriterion"]>["interactionEvidence"];
  const { tsaiWuQualificationRecordId: _referenceId, ...resolvedOrthotropic } = orthotropic;
  return {
    ...input,
    orthotropicMaterial: {
      ...resolvedOrthotropic,
      tsaiWuCriterion: {
        qualificationRecordId: record.id,
        strengths: qualification.strengths,
        interactions: qualification.interactions,
        strengthEvidence,
        interactionEvidence,
        basis: `Immutable exact-process physical test record ${record.id}; values are raw measured/derived inputs, not design allowables.`,
      },
    },
  };
}

function sameDirection(a: [number, number, number], b: [number, number, number]): boolean {
  return a.every((value, axis) => Math.abs(value - b[axis]!) <= 1e-6);
}

function sameNumericValues(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
