import { z } from "zod";

import { exactMaterialCouponProcessSchema } from "./material-qualification.ts";

const id = z.string().trim().min(1).max(240);
const direction = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]).refine((value) => {
  return Math.abs(Math.hypot(...value) - 1) <= 1e-6;
}, "Interface normal must be a unit vector in the global build frame");

const calibrationPointSchema = z.object({
  crackLengthMm: z.number().finite().positive(),
  complianceMmPerN: z.number().finite().positive(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/i),
  sourceLocator: z.string().trim().min(1).max(500),
}).strict();

const specimenSchema = z.object({
  specimenId: id,
  widthMm: z.number().finite().positive(),
  totalLengthMm: z.number().finite().positive(),
  armThicknessMm: z.number().finite().positive(),
  failureLocation: z.enum(["interface", "printed-material", "fixture", "unknown"]),
  calibration: z.array(calibrationPointSchema).min(3).max(100),
  fracture: z.object({
    initialCrackLengthMm: z.number().finite().positive(),
    peakForceN: z.number().finite().positive(),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/i),
    sourceLocator: z.string().trim().min(1).max(500),
  }).strict(),
}).strict().superRefine((specimen, context) => {
  const cracks = specimen.calibration.map(({ crackLengthMm }) => crackLengthMm);
  if (new Set(cracks).size !== cracks.length) {
    context.addIssue({ code: "custom", path: ["calibration"], message: "ENF compliance calibration crack lengths must be unique" });
  }
  specimen.calibration.forEach((point, index) => {
    if (point.crackLengthMm >= specimen.totalLengthMm) {
      context.addIssue({ code: "custom", path: ["calibration", index, "crackLengthMm"], message: "ENF calibration crack length must remain inside the specimen" });
    }
  });
  if (specimen.fracture.initialCrackLengthMm >= specimen.totalLengthMm) {
    context.addIssue({ code: "custom", path: ["fracture", "initialCrackLengthMm"], message: "ENF fracture crack length must remain inside the specimen" });
  }
});

export const enfModeIIEnergyInputSchema = z.object({
  materialProcess: exactMaterialCouponProcessSchema,
  interfaceNormalGlobal: direction,
  interfaceShearDirectionGlobal: direction,
  testProtocolHash: z.string().regex(/^[a-f0-9]{64}$/i),
  testMethod: id.max(200),
  testedAt: z.iso.datetime(),
  complianceEvidence: z.literal("inverse-initial-linear-force-displacement-slope-same-fixture"),
  linearElasticQuasiStaticEvidence: z.literal("confirmed-linear-elastic-quasi-static-test"),
  specimens: z.array(specimenSchema).min(1).max(50),
}).strict().superRefine((input, context) => {
  const normalShearDot = input.interfaceNormalGlobal.reduce((sum, value, axis) => sum + value * input.interfaceShearDirectionGlobal[axis]!, 0);
  if (Math.abs(normalShearDot) > 1e-6) {
    context.addIssue({ code: "custom", path: ["interfaceShearDirectionGlobal"], message: "ENF Mode-II shear direction must lie in the measured interface plane" });
  }
  if (new Set(input.specimens.map(({ specimenId }) => specimenId)).size !== input.specimens.length) {
    context.addIssue({ code: "custom", path: ["specimens"], message: "ENF specimen IDs must be unique" });
  }
});

export type EnfModeIIEnergyInput = z.infer<typeof enfModeIIEnergyInputSchema>;

export function calculateEnfModeIIEnergy(rawInput: unknown) {
  const input = enfModeIIEnergyInputSchema.parse(rawInput);
  return {
    method: "end-notched-flexure-compliance-calibration" as const,
    calculationVersion: 1 as const,
    methodReference: "ASTM D7905/D7905M-19 compliance-calibration reduction; GIIc = 3 m Pc² a0² / (2 b)",
    materialProcess: input.materialProcess,
    interfaceNormalGlobal: input.interfaceNormalGlobal,
    interfaceShearDirectionGlobal: input.interfaceShearDirectionGlobal,
    testProtocolHash: input.testProtocolHash,
    testMethod: input.testMethod,
    testedAt: input.testedAt,
    specimens: input.specimens.map((specimen) => {
      const sorted = [...specimen.calibration].sort((left, right) => left.crackLengthMm - right.crackLengthMm);
      const fit = fitComplianceAgainstCrackCubed(specimen.specimenId, sorted);
      if (fit.slope <= 0) throw new Error(`ENF compliance must increase with the cube of crack length for specimen ${specimen.specimenId}`);
      const minimumCrack = sorted[0]!.crackLengthMm;
      const maximumCrack = sorted.at(-1)!.crackLengthMm;
      if (specimen.fracture.initialCrackLengthMm < minimumCrack || specimen.fracture.initialCrackLengthMm > maximumCrack) {
        throw new Error(`ENF specimen ${specimen.specimenId} initial crack length must be inside the calibrated crack-length interval`);
      }
      const energyReleaseRateNPerMm = (3 * fit.slope * specimen.fracture.peakForceN ** 2 * specimen.fracture.initialCrackLengthMm ** 2)
        / (2 * specimen.widthMm);
      const energyReleaseRateJPerM2 = energyReleaseRateNPerMm * 1000;
      if (!Number.isFinite(energyReleaseRateNPerMm) || energyReleaseRateNPerMm <= 0 || !Number.isFinite(energyReleaseRateJPerM2)) {
        throw new Error(`ENF Mode-II energy-release rate is outside the supported numeric range for specimen ${specimen.specimenId}`);
      }
      return {
        specimenId: specimen.specimenId,
        widthMm: specimen.widthMm,
        totalLengthMm: specimen.totalLengthMm,
        armThicknessMm: specimen.armThicknessMm,
        failureLocation: specimen.failureLocation,
        eligibleForLayerInterfaceEvidence: specimen.failureLocation === "interface",
        fractureSourceHash: specimen.fracture.sourceHash,
        calibration: sorted,
        complianceFitSlopeMmPerNPerMm3: fit.slope,
        complianceFitInterceptMmPerN: fit.intercept,
        complianceFitRSquared: fit.rSquared,
        fractureInitialCrackLengthMm: specimen.fracture.initialCrackLengthMm,
        peakForceN: specimen.fracture.peakForceN,
        fractureSourceLocator: specimen.fracture.sourceLocator,
        energyReleaseRateNPerMm,
        energyReleaseRateJPerM2,
      };
    }),
    limitations: [
      "This is an exploratory ENF compliance-calibration estimate of Mode-II initiation energy, not a determination of compliance with ASTM D7905/D7905M. ASTM states its scope is unidirectional carbon- and glass-fiber-reinforced laminates; printed PLA is outside that validated scope.",
      "The caller supplies compliance values taken from the inverse slope of the initial linear force-displacement response at each calibration crack length and attests that the same fixture, load point, and machine-compliance correction were used. The calculator cannot verify those physical conditions.",
      "The fitted compliance-versus-crack-length-cubed relation is extrapolation-limited to the supplied crack-length interval. Review its R-squared and calibration spread; the calculator imposes no universal fit threshold and does not discard observations.",
      "The initiation estimate uses caller-supplied peak force and initial crack length. It does not track unstable ENF propagation, produce an R-curve, apply a standard validity/Q check, or account for specimen/fixture corrections beyond the supplied compliance calibration.",
      "The returned G_IIc is fracture energy, not a traction-separation curve, local peak interface strength, cohesive stiffness, design allowable, or material qualification. Only caller-confirmed interface failures are eligible as same-material layer-fracture evidence.",
    ],
  };
}

function fitComplianceAgainstCrackCubed(specimenId: string, points: Array<z.infer<typeof calibrationPointSchema>>) {
  const x = points.map(({ crackLengthMm }) => crackLengthMm ** 3);
  const y = points.map(({ complianceMmPerN }) => complianceMmPerN);
  if (![...x, ...y].every(Number.isFinite)) throw new Error(`ENF compliance calibration is outside the supported numeric range for specimen ${specimenId}`);
  const meanX = average(x);
  const meanY = average(y);
  const sxx = x.reduce((sum, value) => sum + (value - meanX) ** 2, 0);
  const syy = y.reduce((sum, value) => sum + (value - meanY) ** 2, 0);
  if (!(sxx > 0) || !(syy > 0) || !Number.isFinite(sxx) || !Number.isFinite(syy)) {
    throw new Error(`ENF compliance must vary and increase with the cube of crack length for specimen ${specimenId}`);
  }
  const slope = x.reduce((sum, value, index) => sum + (value - meanX) * (y[index]! - meanY), 0) / sxx;
  const intercept = meanY - slope * meanX;
  const residual = y.reduce((sum, value, index) => sum + (value - (slope * x[index]! + intercept)) ** 2, 0);
  const rSquared = 1 - residual / syy;
  if (![slope, intercept, rSquared].every(Number.isFinite)) throw new Error(`ENF compliance fit is outside the supported numeric range for specimen ${specimenId}`);
  return { slope, intercept, rSquared };
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
