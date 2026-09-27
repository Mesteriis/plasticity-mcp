import type { LinearStaticCaseResult } from "./calculix-linear-static.ts";

export type RefinementTrend = "increasing" | "decreasing" | "unchanged" | "non-monotonic" | "insufficient-levels";

export function classifyRefinementTrend(values: readonly number[]): RefinementTrend {
  if (values.length < 2) return "insufficient-levels";
  if (values.some((value) => !Number.isFinite(value))) throw new TypeError("Refinement metrics must be finite");

  let increased = false;
  let decreased = false;
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1]!;
    const current = values[index]!;
    const tolerance = Math.max(1e-15, Math.max(Math.abs(previous), Math.abs(current)) * 1e-12);
    if (current - previous > tolerance) increased = true;
    else if (previous - current > tolerance) decreased = true;
    if (increased && decreased) return "non-monotonic";
  }
  if (increased) return "increasing";
  if (decreased) return "decreasing";
  return "unchanged";
}

export function maximumStressLocationShiftMm(
  previous: LinearStaticCaseResult["maximumVonMisesLocation"] | undefined,
  current: LinearStaticCaseResult["maximumVonMisesLocation"] | undefined,
): number | null {
  if (!previous || !current) return null;
  return Math.hypot(...current.centroidMm.map((coordinate, axis) => coordinate - previous.centroidMm[axis]!));
}
