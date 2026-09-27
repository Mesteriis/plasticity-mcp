import assert from "node:assert/strict";
import test from "node:test";

import { calibrateBenzeggaghKenaneExponent } from "./code-aster-turon-calibration.ts";

const evidence = (sourceHash: string, fractureEnergyNPerMm: number) => ({
  sourceHash: sourceHash.repeat(64), sourceLocator: `${sourceHash}.csv`, fractureEnergyNPerMm,
});

test("fits ETA_BK from multiple measured mode-mix ratios without inventing the interaction exponent", () => {
  const calibration = calibrateBenzeggaghKenaneExponent({
    modeI: evidence("a", 1),
    modeII: evidence("b", 4),
    mixedMode: [
      { ...evidence("c", 1.1875), tangentialEnergyFraction: 0.25 },
      { ...evidence("d", 2.6875), tangentialEnergyFraction: 0.75 },
    ],
  });
  assert.ok(Math.abs(calibration.etaBk - 2) < 1e-12);
  assert.equal(calibration.samples.length, 2);
  assert.ok(calibration.samples.every((sample) => Math.abs(sample.relativeEnergyResidual) < 1e-12));
  assert.equal(calibration.interpretation, "candidate-calibration-requires-engineering-review");
});

test("rejects unidentifiable or physically out-of-range Benzeggagh-Kenane data", () => {
  const base = {
    modeI: evidence("a", 1),
    modeII: evidence("b", 4),
    mixedMode: [
      { ...evidence("c", 1.1875), tangentialEnergyFraction: 0.25 },
      { ...evidence("d", 2.6875), tangentialEnergyFraction: 0.75 },
    ],
  };
  assert.throws(() => calibrateBenzeggaghKenaneExponent({ ...base, modeII: evidence("b", 1) }), /pure-mode fracture energies must differ/);
  assert.throws(() => calibrateBenzeggaghKenaneExponent({
    ...base, mixedMode: [base.mixedMode[0]!, { ...base.mixedMode[1]!, tangentialEnergyFraction: base.mixedMode[0]!.tangentialEnergyFraction }],
  }), /two distinct mixed-mode ratios/);
  assert.throws(() => calibrateBenzeggaghKenaneExponent({ ...base, mixedMode: base.mixedMode.map((sample) => ({ ...sample, tangentialEnergyFraction: 0 })) }), />0/);
  assert.throws(() => calibrateBenzeggaghKenaneExponent({ ...base, mixedMode: base.mixedMode.map((sample) => ({ ...sample, fractureEnergyNPerMm: 5 })) }), /between the pure-mode fracture energies/);
});

test("does not discard fit residuals when mixed-mode measurements disagree", () => {
  const result = calibrateBenzeggaghKenaneExponent({
    modeI: evidence("a", 1), modeII: evidence("b", 4),
    mixedMode: [
      { ...evidence("c", 1.4), tangentialEnergyFraction: 0.25 },
      { ...evidence("d", 2.4), tangentialEnergyFraction: 0.75 },
    ],
  });
  assert.ok(result.samples.some((sample) => Math.abs(sample.relativeEnergyResidual) > 1e-3));
  assert.equal(result.interpretation, "candidate-calibration-requires-engineering-review");
});
