import { z } from "zod";

import { exactMaterialCouponProcessSchema } from "./material-qualification.ts";

const id = z.string().trim().min(1).max(240);
const direction = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]).refine((value) => {
  const magnitude = Math.hypot(...value);
  return Math.abs(magnitude - 1) <= 1e-6;
}, "Interface normal must be a unit vector in the global build frame");

const specimenSchema = z.object({
  specimenId: z.string().trim().min(1).max(240),
  widthMm: z.number().finite().positive(),
  totalLengthMm: z.number().finite().positive(),
  armThicknessMm: z.number().finite().positive(),
  failureLocation: z.enum(["interface", "printed-material", "fixture", "unknown"]),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/i),
  points: z.array(z.object({
    crackLengthMm: z.number().finite().positive(),
    forceN: z.number().finite().positive(),
    loadPointDisplacementMm: z.number().finite().positive(),
    sourceLocator: z.string().trim().min(1).max(500),
  }).strict()).min(3).max(500),
}).strict().superRefine((specimen, context) => {
  for (let index = 0; index < specimen.points.length; index += 1) {
    const point = specimen.points[index]!;
    if (point.crackLengthMm >= specimen.totalLengthMm) {
      context.addIssue({ code: "custom", path: ["points", index, "crackLengthMm"], message: "Observed crack length must remain inside the DCB specimen" });
    }
    if (index > 0 && point.crackLengthMm <= specimen.points[index - 1]!.crackLengthMm) {
      context.addIssue({ code: "custom", path: ["points", index, "crackLengthMm"], message: "DCB crack observations must be strictly increasing and must not contain repeated crack lengths" });
    }
  }
});

export const dcbModeIEnergyInputSchema = z.object({
  materialProcess: exactMaterialCouponProcessSchema,
  interfaceNormalGlobal: direction,
  testProtocolHash: z.string().regex(/^[a-f0-9]{64}$/i),
  testMethod: id.max(200),
  testedAt: z.iso.datetime(),
  displacementEvidence: z.literal("machine-compliance-corrected-load-point-displacement"),
  linearElasticQuasiStaticEvidence: z.literal("confirmed-linear-elastic-quasi-static-test"),
  specimens: z.array(specimenSchema).min(1).max(50),
}).strict().superRefine((input, context) => {
  if (new Set(input.specimens.map(({ specimenId }) => specimenId)).size !== input.specimens.length) {
    context.addIssue({ code: "custom", path: ["specimens"], message: "DCB specimen IDs must be unique" });
  }
});

export type DcbModeIEnergyInput = z.infer<typeof dcbModeIEnergyInputSchema>;

export interface DcbModeIEnergyPoint {
  crackLengthMm: number;
  forceN: number;
  loadPointDisplacementMm: number;
  complianceMmPerN: number;
  energyReleaseRateNPerMm: number;
  energyReleaseRateJPerM2: number;
  sourceLocator: string;
}

export function calculateDcbModeIEnergy(rawInput: unknown) {
  const input = dcbModeIEnergyInputSchema.parse(rawInput);
  return {
    method: "modified-beam-theory" as const,
    calculationVersion: 1 as const,
    methodReference: "Lambiase et al., Influence of the deposition pattern on the interlayer fracture toughness of FDM components, DOI 10.1007/s00170-023-12223-1",
    materialProcess: input.materialProcess,
    interfaceNormalGlobal: input.interfaceNormalGlobal,
    testProtocolHash: input.testProtocolHash,
    testMethod: input.testMethod,
    testedAt: input.testedAt,
    specimens: input.specimens.map((specimen) => {
      const compliances = specimen.points.map((point) => point.loadPointDisplacementMm / point.forceN);
      if (compliances.some((value) => !Number.isFinite(value) || value <= 0)) {
        throw new Error(`DCB compliance is outside the supported numeric range for specimen ${specimen.specimenId}`);
      }
      const transformed = compliances.map((compliance) => Math.cbrt(compliance));
      const { slope, intercept, rSquared } = fitLine(specimen.points.map((point) => point.crackLengthMm), transformed);
      if (!(slope > 0)) throw new Error(`DCB compliance must increase with crack length for specimen ${specimen.specimenId}`);
      const crackLengthCorrectionMm = Math.abs(-intercept / slope);
      if (!Number.isFinite(crackLengthCorrectionMm)) throw new Error(`DCB crack-length correction is invalid for specimen ${specimen.specimenId}`);

      const points: DcbModeIEnergyPoint[] = specimen.points.map((point, index) => {
        const deltaOverCrack = point.loadPointDisplacementMm / point.crackLengthMm;
        if (deltaOverCrack > 0.4) {
          throw new Error(`DCB specimen ${specimen.specimenId} requires a large-displacement correction that this MBT calculator does not apply`);
        }
        const energyReleaseRateNPerMm = (3 * point.forceN * point.loadPointDisplacementMm)
          / (2 * specimen.widthMm * (point.crackLengthMm + crackLengthCorrectionMm));
        if (!Number.isFinite(energyReleaseRateNPerMm) || energyReleaseRateNPerMm <= 0) {
          throw new Error(`DCB energy-release rate is outside the supported numeric range for specimen ${specimen.specimenId}`);
        }
        return {
          crackLengthMm: point.crackLengthMm,
          forceN: point.forceN,
          loadPointDisplacementMm: point.loadPointDisplacementMm,
          complianceMmPerN: compliances[index]!,
          energyReleaseRateNPerMm,
          energyReleaseRateJPerM2: energyReleaseRateNPerMm * 1000,
          sourceLocator: point.sourceLocator,
        };
      });
      return {
        specimenId: specimen.specimenId,
        widthMm: specimen.widthMm,
        totalLengthMm: specimen.totalLengthMm,
        armThicknessMm: specimen.armThicknessMm,
        failureLocation: specimen.failureLocation,
        eligibleForLayerInterfaceEvidence: specimen.failureLocation === "interface",
        sourceHash: specimen.sourceHash,
        crackLengthCorrectionMm,
        complianceFitRSquared: rSquared,
        points,
      };
    }),
    limitations: [
      "This is an exploratory MBT Mode-I energy-release-rate reduction for caller-selected crack-growth observations, not a determination of compliance with ASTM D5528 or another standard; that standard's stated scope is unidirectional fiber-reinforced polymer composites.",
      "The caller attests that displacement is load-point displacement corrected for machine compliance and that the response is quasi-static and linear elastic; the calculator cannot verify these physical conditions.",
      "Rows with displacement/crack-length ratio above 0.4 are rejected because a large-displacement correction is not implemented; other fixture, width, and load-block corrections are also not calculated.",
      "Review complianceFitRSquared and the underlying observations; the calculator does not impose a universal fit-quality cutoff or discard observations.",
      "The returned G_I versus crack-length points are not a traction-separation curve, local peak interface strength, cohesive stiffness, design allowable, or material qualification.",
      "Failure location and source locators are caller-supplied observations. Only specimens marked as confirmed interface failure are eligible for same-material layer-fracture evidence.",
    ],
  };
}

function fitLine(x: number[], y: number[]) {
  const meanX = x.reduce((sum, value) => sum + value, 0) / x.length;
  const meanY = y.reduce((sum, value) => sum + value, 0) / y.length;
  const sxx = x.reduce((sum, value) => sum + (value - meanX) ** 2, 0);
  const syy = y.reduce((sum, value) => sum + (value - meanY) ** 2, 0);
  if (!(sxx > 0) || !(syy > 0) || !Number.isFinite(sxx) || !Number.isFinite(syy)) {
    throw new Error("DCB compliance calibration requires varying crack-length and compliance observations within the supported numeric range");
  }
  const slope = x.reduce((sum, value, index) => sum + (value - meanX) * (y[index]! - meanY), 0) / sxx;
  const intercept = meanY - slope * meanX;
  const residual = y.reduce((sum, value, index) => sum + (value - (slope * x[index]! + intercept)) ** 2, 0);
  const rSquared = 1 - residual / syy;
  if (![slope, intercept, rSquared].every(Number.isFinite)) throw new Error("DCB compliance calibration fit is outside the supported numeric range");
  return { slope, intercept, rSquared };
}
