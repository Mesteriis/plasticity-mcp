import { analyzeMaterialInterfaceTestCurve, type InterfaceTestStore } from "../interface-test.ts";
import type { MaterialCouponQualificationStore } from "../material-qualification.ts";
import type { StoredCohesiveReport } from "./cohesive-report-store.ts";
import { calibrateTuronCandidateFromInterfaceTests } from "./code-aster-turon-physical-calibration.ts";
import { assertCouponPoissonRatio } from "./material-binding.ts";
import { exactMaterialCouponProcessSchema, sameMaterialCouponProcess } from "../material-qualification.ts";

export async function verifyCohesiveReportEvidence(
  report: StoredCohesiveReport,
  interfaceTests: InterfaceTestStore,
  coupons: MaterialCouponQualificationStore,
): Promise<void> {
  if (report.physicalTest.materialAProcess.layerHeightMm === undefined || report.physicalTest.materialBProcess.layerHeightMm === undefined) {
    throw new Error("Saved cohesive report has no measured slicer layer height and cannot be matched to an exact coupon process");
  }
  const processA = exactMaterialCouponProcessSchema.parse(report.physicalTest.materialAProcess);
  const processB = exactMaterialCouponProcessSchema.parse(report.physicalTest.materialBProcess);
  if (report.input.interfaceTestRecordId !== report.physicalTest.recordId) {
    throw new Error("Saved interface-test reference does not match the analysis input");
  }
  if (report.turonCalibration) {
    if (!report.input.modeIIRecordId || !report.input.mixedModeRecordIds
      || report.input.initialStiffnessMPaPerMm !== report.turonCalibration.initialStiffnessMPaPerMm
      || report.turonCalibration.initialStiffnessEvidence.value !== report.turonCalibration.initialStiffnessMPaPerMm
      || JSON.stringify(report.input.initialStiffnessEvidence) !== JSON.stringify(report.turonCalibration.initialStiffnessEvidence)
      || !report.turonCalibration.initialStiffnessEvidence.materialProcess
      || !sameMaterialCouponProcess(report.turonCalibration.initialStiffnessEvidence.materialProcess, processA)
      || report.turonCalibration.calibration.modeIRecordId !== report.input.interfaceTestRecordId
      || report.turonCalibration.calibration.modeIIRecordId !== report.input.modeIIRecordId
      || JSON.stringify(report.turonCalibration.calibration.mixedModeRecordIds) !== JSON.stringify(report.input.mixedModeRecordIds)) {
      throw new Error("Saved Turon K/process evidence or calibration references do not match the analysis input and exact measured process");
    }
    const currentCalibration = await calibrateTuronCandidateFromInterfaceTests(interfaceTests, {
      modeIRecordId: report.input.interfaceTestRecordId,
      modeIIRecordId: report.input.modeIIRecordId,
      mixedModeRecordIds: report.input.mixedModeRecordIds,
    });
    if (JSON.stringify(currentCalibration) !== JSON.stringify(report.turonCalibration.calibration)) {
      throw new Error("Saved DCB/ENF/MMB calibration no longer matches the immutable physical interface evidence");
    }
  }
  const interfaceTest = await interfaceTests.read(report.physicalTest.recordId);
  const interfaceProcessA = exactMaterialCouponProcessSchema.parse(interfaceTest.materialAProcess);
  const interfaceProcessB = exactMaterialCouponProcessSchema.parse(interfaceTest.materialBProcess);
  if (interfaceTest.interfaceKind !== report.physicalTest.interfaceKind
    || interfaceTest.fractureMethod !== "dcb-mode-i"
    || JSON.stringify(interfaceTest.materialAProcess) !== JSON.stringify(report.physicalTest.materialAProcess)
    || JSON.stringify(interfaceTest.materialBProcess) !== JSON.stringify(report.physicalTest.materialBProcess)) {
    throw new Error("Saved interface-test record no longer matches the report process assignment");
  }
  const interfaceMatch = await interfaceTests.match({
    interfaceKind: interfaceTest.interfaceKind,
    materialAProcess: interfaceProcessA,
    materialBProcess: interfaceProcessB,
    testMode: interfaceTest.testMode,
    interfaceNormalGlobal: interfaceTest.interfaceNormalGlobal,
    loadDirectionGlobal: interfaceTest.loadDirectionGlobal,
    testProtocolHash: interfaceTest.testProtocolHash,
  });
  if (interfaceMatch.status !== "matched" || interfaceMatch.selected?.id !== report.physicalTest.recordId) {
    throw new Error("The saved physical interface test no longer has a unique exact match");
  }
  const measuredCurve = analyzeMaterialInterfaceTestCurve(interfaceTest);
  if (interfaceTest.tractionSeparationCurve?.sourceHash !== report.physicalTest.curveSourceHash
    || interfaceTest.tractionSeparationCurve.sourceLocator !== report.physicalTest.curveSourceLocator
    || measuredCurve.peakStrengthMPa !== report.physicalTest.measuredCurveSummary.peakStrengthMPa
    || measuredCurve.fractureEnergyNPerMm !== report.physicalTest.measuredCurveSummary.fractureEnergyNPerMm) {
    throw new Error("Saved measured interface curve no longer matches the analysis report");
  }
  const [matchA, matchB] = await Promise.all([
    coupons.match({ process: processA }),
    coupons.match({ process: processB }),
  ]);
  if (matchA.status !== "matched" || !matchA.selected || matchA.selected.id !== report.couponRecordIds.materialA
    || matchB.status !== "matched" || !matchB.selected || matchB.selected.id !== report.couponRecordIds.materialB) {
    throw new Error("Exact-process coupon data are missing, conflicting or no longer match the saved records");
  }
  assertCouponPoissonRatio(matchA.selected, report.input.poissonRatio, report.input.poissonRatioEvidence);
  assertCouponPoissonRatio(matchB.selected, report.input.poissonRatio, report.input.poissonRatioEvidence);
  const assignmentA = report.materialAssignment.negativeSide.testMaterial === "A"
    ? report.materialAssignment.negativeSide : report.materialAssignment.positiveSide;
  const assignmentB = report.materialAssignment.negativeSide.testMaterial === "B"
    ? report.materialAssignment.negativeSide : report.materialAssignment.positiveSide;
  const usesOrthotropicBulk = Boolean(report.input.useOrthotropicBulkProperties);
  if (usesOrthotropicBulk && (!matchA.selected.orthotropicMaterial || !matchB.selected.orthotropicMaterial)) {
    throw new Error("Saved orthotropic analysis no longer has both exact-process material tensors");
  }
  if (assignmentA.couponRecordId !== matchA.selected.id || assignmentB.couponRecordId !== matchB.selected.id
    || JSON.stringify(assignmentA.process) !== JSON.stringify(interfaceTest.materialAProcess)
    || JSON.stringify(assignmentB.process) !== JSON.stringify(interfaceTest.materialBProcess)
    || assignmentA.youngsModulusMPa !== matchA.selected.properties.youngModulusMPa
    || assignmentB.youngsModulusMPa !== matchB.selected.properties.youngModulusMPa
    || JSON.stringify(assignmentA.orthotropicMaterial ?? null) !== JSON.stringify(usesOrthotropicBulk ? matchA.selected.orthotropicMaterial : null)
    || JSON.stringify(assignmentB.orthotropicMaterial ?? null) !== JSON.stringify(usesOrthotropicBulk ? matchB.selected.orthotropicMaterial : null)) {
    throw new Error("Saved material-side modulus or orthotropic tensor assignment no longer matches the exact-process coupon records");
  }
}
