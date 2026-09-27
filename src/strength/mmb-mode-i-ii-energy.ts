import { z } from "zod";

import { exactMaterialCouponProcessSchema } from "./material-qualification.ts";

const id = z.string().trim().min(1).max(240);
const hash = z.string().regex(/^[a-f0-9]{64}$/i);
const unitDirection = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]).refine(
  (value) => Math.abs(Math.hypot(...value) - 1) <= 1e-6,
  "Direction must be a unit vector in the global build frame",
);
const sourcedPositiveValueSchema = z.object({
  valueMPa: z.number().finite().positive(),
  sourceHash: hash,
  sourceLocator: id.max(500),
}).strict();

const specimenSchema = z.object({
  specimenId: id,
  widthMm: z.number().finite().positive(),
  totalLengthMm: z.number().finite().positive(),
  armThicknessMm: z.number().finite().positive(),
  halfSpanMm: z.number().finite().positive(),
  leverArmMm: z.number().finite().positive(),
  initialCrackLengthMm: z.number().finite().positive(),
  criticalForceN: z.number().finite().positive(),
  initiationCriterion: z.enum(["visual-crack-initiation", "first-nonlinearity", "five-percent-compliance-change", "maximum-force", "caller-defined"]),
  failureLocation: z.enum(["interface", "printed-material", "fixture", "unknown"]),
  sourceHash: hash,
  sourceLocator: id.max(500),
}).strict().superRefine((specimen, context) => {
  if (specimen.leverArmMm <= specimen.halfSpanMm / 3) {
    context.addIssue({ code: "custom", path: ["leverArmMm"], message: "MMB lever arm must exceed one-third of the MMB half span" });
  }
  if (specimen.initialCrackLengthMm >= specimen.totalLengthMm) {
    context.addIssue({ code: "custom", path: ["initialCrackLengthMm"], message: "Initial crack length must remain inside the specimen" });
  }
});

export const mmbModeIEnergyInputSchema = z.object({
  materialProcess: exactMaterialCouponProcessSchema,
  interfaceNormalGlobal: unitDirection,
  interfaceShearDirectionGlobal: unitDirection,
  testProtocolHash: hash,
  testMethod: id.max(200),
  testedAt: z.iso.datetime(),
  axesMappingConfirmed: z.literal("moduli-axis-1-matches-shear-axis-2-is-in-plane-transverse-3-is-interface-normal"),
  leverWeight: z.literal("measured-negligible-or-counterbalanced"),
  flexuralModulus: sourcedPositiveValueSchema,
  orthotropicModuli: z.object({
    E11MPa: z.number().finite().positive(),
    E22MPa: z.number().finite().positive(),
    G13MPa: z.number().finite().positive(),
    sourceHash: hash,
    sourceLocator: id.max(500),
  }).strict(),
  specimens: z.array(specimenSchema).min(1).max(50),
}).strict().superRefine((input, context) => {
  const dot = input.interfaceNormalGlobal.reduce((sum, value, axis) => sum + value * input.interfaceShearDirectionGlobal[axis]!, 0);
  if (Math.abs(dot) > 1e-6) {
    context.addIssue({ code: "custom", path: ["interfaceShearDirectionGlobal"], message: "MMB shear direction must lie in the measured interface plane" });
  }
  if (new Set(input.specimens.map(({ specimenId }) => specimenId)).size !== input.specimens.length) {
    context.addIssue({ code: "custom", path: ["specimens"], message: "MMB specimen IDs must be unique" });
  }
});

export type MmbModeIEnergyInput = z.infer<typeof mmbModeIEnergyInputSchema>;

export function calculateMmbModeIEnergy(rawInput: unknown) {
  const input = mmbModeIEnergyInputSchema.parse(rawInput);
  const axis1 = input.interfaceShearDirectionGlobal;
  const axis3 = input.interfaceNormalGlobal;
  const axis2 = normalize(cross(axis3, axis1));
  return {
    method: "reeder-crews-mmb-beam-theory" as const,
    calculationVersion: 1 as const,
    methodReference: "Reeder-Crews MMB beam-theory partition using measured flexural and orthotropic moduli",
    materialProcess: input.materialProcess,
    interfaceNormalGlobal: axis3,
    interfaceShearDirectionGlobal: axis1,
    materialAxis1Global: axis1,
    materialAxis2Global: axis2,
    materialAxis3Global: axis3,
    testProtocolHash: input.testProtocolHash,
    testMethod: input.testMethod,
    testedAt: input.testedAt,
    axesMappingConfirmed: input.axesMappingConfirmed,
    flexuralModulus: input.flexuralModulus,
    orthotropicModuli: input.orthotropicModuli,
    specimens: input.specimens.map((specimen) => {
      const h = specimen.armThicknessMm / 2;
      const gamma = 1.18 * Math.sqrt(input.orthotropicModuli.E11MPa * input.orthotropicModuli.E22MPa) / input.orthotropicModuli.G13MPa;
      const chi = Math.sqrt((input.orthotropicModuli.E11MPa / (11 * input.orthotropicModuli.G13MPa))
        * (3 - 2 * (gamma / (1 + gamma)) ** 2));
      const common = (specimen.criticalForceN ** 2)
        / (16 * specimen.widthMm ** 2 * h ** 3 * specimen.halfSpanMm ** 2 * input.flexuralModulus.valueMPa);
      const modeINPerMm = common * 12 * (3 * specimen.leverArmMm - specimen.halfSpanMm) ** 2
        * (specimen.initialCrackLengthMm + chi * h) ** 2;
      const modeIINPerMm = common * 9 * (specimen.leverArmMm + specimen.halfSpanMm) ** 2
        * (specimen.initialCrackLengthMm + 0.42 * chi * h) ** 2;
      const totalNPerMm = modeINPerMm + modeIINPerMm;
      const modeIEnergyReleaseRateJPerM2 = modeINPerMm * 1000;
      const modeIIEnergyReleaseRateJPerM2 = modeIINPerMm * 1000;
      const totalEnergyReleaseRateJPerM2 = totalNPerMm * 1000;
      const modeIIModeMixFraction = modeIINPerMm / totalNPerMm;
      if (![gamma, chi, modeIEnergyReleaseRateJPerM2, modeIIEnergyReleaseRateJPerM2, totalEnergyReleaseRateJPerM2, modeIIModeMixFraction]
        .every(Number.isFinite) || chi <= 0 || modeIEnergyReleaseRateJPerM2 <= 0 || modeIIEnergyReleaseRateJPerM2 <= 0) {
        throw new Error(`MMB energy release rate is outside the supported numeric range for specimen ${specimen.specimenId}`);
      }
      return {
        specimenId: specimen.specimenId,
        widthMm: specimen.widthMm,
        totalLengthMm: specimen.totalLengthMm,
        armThicknessMm: specimen.armThicknessMm,
        halfSpanMm: specimen.halfSpanMm,
        leverArmMm: specimen.leverArmMm,
        initialCrackLengthMm: specimen.initialCrackLengthMm,
        criticalForceN: specimen.criticalForceN,
        initiationCriterion: specimen.initiationCriterion,
        failureLocation: specimen.failureLocation,
        eligibleForLayerInterfaceEvidence: specimen.failureLocation === "interface",
        sourceHash: specimen.sourceHash,
        sourceLocator: specimen.sourceLocator,
        gamma,
        chi,
        modeIEnergyReleaseRateJPerM2,
        modeIIEnergyReleaseRateJPerM2,
        totalEnergyReleaseRateJPerM2,
        modeIIModeMixFraction,
      };
    }),
    limitations: [
      "This exploratory Reeder-Crews MMB beam-theory partition is not a determination of ASTM D6671 conformity. ASTM D6671/D6671M scope is unidirectional fiber-reinforced composite laminates; printed PLA is outside that validated scope.",
      "The caller must supply measured critical initiation force, geometry, flexural modulus, and orthotropic E11/E22/G13 values from the same material process with the confirmed axis mapping. The calculator cannot verify the physical measurements, crack initiation criterion, or that the interface was the failure plane.",
      "The calculation assumes a linear-elastic beam response, the stated MMB fixture geometry, negligible or counterbalanced lever self-weight, and no unentered fixture or machine-compliance corrections. It does not generate an R-curve or validate specimen size, crack-front straightness, or standard acceptance criteria.",
      "The returned values are exploratory fracture-energy partition estimates only. They are not local peak interface traction or cohesive stiffness, are not a traction-separation curve, and are not a design allowable, material qualification, or print approval.",
      "Do not use this MMB estimate as a substitute for full exact-process interface traction-separation data required by the calibrated cohesive solver.",
    ],
  };
}

function cross(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [
    a[1]! * b[2]! - a[2]! * b[1]!,
    a[2]! * b[0]! - a[0]! * b[2]!,
    a[0]! * b[1]! - a[1]! * b[0]!,
  ];
}

function normalize(value: [number, number, number]): [number, number, number] {
  const magnitude = Math.hypot(...value);
  if (!Number.isFinite(magnitude) || magnitude <= 0) throw new Error("MMB axis frame is degenerate");
  return value.map((component) => component / magnitude) as [number, number, number];
}
