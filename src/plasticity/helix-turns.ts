/** Fractional native spirals overrun their requested axial end on 26.1/26.2. */
export function requireWholeHelixTurns(turns: number): number {
  const whole = Math.round(turns);
  if (!Number.isFinite(turns) || whole < 1 || Math.abs(turns - whole) > 1e-9) {
    throw new Error("Fractional Helix turns are unsupported; choose dimensions and pitch giving a positive whole number of turns");
  }
  return whole;
}
