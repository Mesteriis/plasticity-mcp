/** Count distinct knot intervals inside one normalized native curve segment. */
export function countActiveCurveSpans(normalizedKnotParameters: number[]): number {
  const breaks = new Set<string>(["0", "1"]);
  for (const parameter of normalizedKnotParameters) {
    if (!Number.isFinite(parameter) || parameter < -1e-10 || parameter > 1 + 1e-10) continue;
    const clamped = Math.max(0, Math.min(1, parameter));
    breaks.add(Number(clamped.toPrecision(14)).toString());
  }
  return Math.max(0, breaks.size - 1);
}
