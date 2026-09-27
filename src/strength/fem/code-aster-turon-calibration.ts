import { z } from "zod";

const evidence = z.object({
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceLocator: z.string().trim().min(1).max(2_000),
  fractureEnergyNPerMm: z.number().finite().positive(),
}).strict();

const calibrationInput = z.object({
  modeI: evidence,
  modeII: evidence,
  mixedMode: z.array(evidence.extend({ tangentialEnergyFraction: z.number().finite().gt(0).lt(1) }).strict()).min(2).max(1_000),
}).strict();

export interface TuronBenzeggaghKenaneCalibration {
  etaBk: number;
  pureModeFractureEnergyNPerMm: { modeI: number; modeII: number };
  calibrationEvidence: {
    modeI: { sourceHash: string; sourceLocator: string };
    modeII: { sourceHash: string; sourceLocator: string };
  };
  samples: Array<{
    sourceHash: string;
    sourceLocator: string;
    observedFractureEnergyNPerMm: number;
    tangentialEnergyFraction: number;
    predictedFractureEnergyNPerMm: number;
    relativeEnergyResidual: number;
  }>;
  interpretation: "candidate-calibration-requires-engineering-review";
  limitations: string[];
}

/** Fit the Benzeggagh–Kenane exponent from measured pure-mode and at least two distinct mixed-mode energy ratios. */
export function calibrateBenzeggaghKenaneExponent(rawInput: unknown): TuronBenzeggaghKenaneCalibration {
  const input = calibrationInput.parse(rawInput);
  const { modeI, modeII, mixedMode } = input;
  const pureDifference = modeII.fractureEnergyNPerMm - modeI.fractureEnergyNPerMm;
  if (Math.abs(pureDifference) <= Number.EPSILON * Math.max(modeI.fractureEnergyNPerMm, modeII.fractureEnergyNPerMm)) {
    throw new Error("Mode-I and mode-II pure-mode fracture energies must differ to identify ETA_BK");
  }
  if (new Set(mixedMode.map((sample) => sample.tangentialEnergyFraction)).size < 2) {
    throw new Error("ETA_BK calibration requires at least two distinct mixed-mode ratios");
  }

  const transformed = mixedMode.map((sample) => {
    const normalizedEnergy = (sample.fractureEnergyNPerMm - modeI.fractureEnergyNPerMm) / pureDifference;
    if (!Number.isFinite(normalizedEnergy) || normalizedEnergy <= 0 || normalizedEnergy >= 1) {
      throw new Error("Every measured mixed-mode fracture energy must lie strictly between the pure-mode fracture energies");
    }
    return {
      ...sample,
      normalizedEnergy,
      logMix: Math.log(sample.tangentialEnergyFraction),
      logEnergy: Math.log(normalizedEnergy),
    };
  });
  const denominator = transformed.reduce((sum, sample) => sum + sample.logMix ** 2, 0);
  const etaBk = transformed.reduce((sum, sample) => sum + sample.logMix * sample.logEnergy, 0) / denominator;
  if (!Number.isFinite(etaBk) || etaBk <= 0) throw new Error("Measured mixed-mode energies do not identify a positive ETA_BK exponent");

  return {
    etaBk,
    pureModeFractureEnergyNPerMm: { modeI: modeI.fractureEnergyNPerMm, modeII: modeII.fractureEnergyNPerMm },
    calibrationEvidence: {
      modeI: { sourceHash: modeI.sourceHash, sourceLocator: modeI.sourceLocator },
      modeII: { sourceHash: modeII.sourceHash, sourceLocator: modeII.sourceLocator },
    },
    samples: transformed.map((sample) => {
      const predictedFractureEnergyNPerMm = modeI.fractureEnergyNPerMm
        + pureDifference * sample.tangentialEnergyFraction ** etaBk;
      return {
        sourceHash: sample.sourceHash,
        sourceLocator: sample.sourceLocator,
        observedFractureEnergyNPerMm: sample.fractureEnergyNPerMm,
        tangentialEnergyFraction: sample.tangentialEnergyFraction,
        predictedFractureEnergyNPerMm,
        relativeEnergyResidual: (predictedFractureEnergyNPerMm - sample.fractureEnergyNPerMm)
          / sample.fractureEnergyNPerMm,
      };
    }),
    interpretation: "candidate-calibration-requires-engineering-review",
    limitations: [
      "This is a least-squares fit of the Benzeggagh–Kenane fracture-energy relation; it is not a material qualification or design allowable.",
      "Mixed-mode energy fractions must come from measured normal and tangential traction-separation work, not from the fixture angle alone.",
      "The fitted CZM_TURON law assumes one in-plane tangential response. ENF and MMB shear axes must match, but this does not establish that the physical interface is isotropic within its plane.",
      "The returned residuals must be reviewed against test uncertainty and repeatability; no universal acceptance threshold is assumed.",
      "This fit does not identify the initial cohesive stiffness K or establish that a single BK exponent represents all mode ratios, rates, temperatures or process variation.",
    ],
  };
}
