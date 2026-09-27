export interface StraightNetSectionHole {
  id: string;
  centerOffsetMm: number;
  diameterMm: number;
}

export interface StraightNetSectionInput {
  grossWidthMm: number;
  holes: StraightNetSectionHole[];
}

export interface StraightNetSectionResult {
  minimumNetWidthMm: number;
  criticalOffsetMm: number;
  intersectedHoles: Array<{ id: string; chordWidthMm: number }>;
}

const GEOMETRY_TOLERANCE_MM = 1e-9;

/** Finds the least net width among all straight cuts normal to the applied tensile axis. */
export function calculateMinimumStraightNetWidth(input: StraightNetSectionInput): StraightNetSectionResult {
  const { grossWidthMm, holes } = input;
  if (!Number.isFinite(grossWidthMm) || grossWidthMm <= 0) throw new Error("Gross width must be finite and positive");
  if (!Array.isArray(holes)) throw new Error("Holes must be an array");
  if (new Set(holes.map((hole) => hole.id)).size !== holes.length) throw new Error("Hole IDs must be unique");

  for (const hole of holes) {
    if (!hole.id.trim() || !Number.isFinite(hole.centerOffsetMm) || !Number.isFinite(hole.diameterMm) || hole.diameterMm <= 0) {
      throw new Error("Every hole needs an ID, finite center offset, and finite positive diameter");
    }
    const radius = hole.diameterMm / 2;
    if (hole.centerOffsetMm - radius < -GEOMETRY_TOLERANCE_MM
        || hole.centerOffsetMm + radius > grossWidthMm + GEOMETRY_TOLERANCE_MM) {
      throw new Error(`Hole ${hole.id} extends outside the plate boundary`);
    }
  }

  const events = [...new Set([
    0,
    grossWidthMm,
    ...holes.flatMap((hole) => [hole.centerOffsetMm - hole.diameterMm / 2, hole.centerOffsetMm + hole.diameterMm / 2]),
  ])].sort((a, b) => a - b);
  let maximumRemovedWidth = 0;
  let criticalOffsetMm = 0;

  const consider = (offsetMm: number): void => {
    const removedWidth = totalChordWidth(holes, offsetMm);
    if (removedWidth > maximumRemovedWidth) {
      maximumRemovedWidth = removedWidth;
      criticalOffsetMm = offsetMm;
    }
  };

  for (const event of events) consider(event);
  for (let index = 0; index < events.length - 1; index += 1) {
    let low = events[index]!;
    let high = events[index + 1]!;
    if (high - low <= GEOMETRY_TOLERANCE_MM) continue;
    const midpoint = (low + high) / 2;
    const active = holes.filter((hole) => Math.abs(midpoint - hole.centerOffsetMm) < hole.diameterMm / 2);
    if (active.length === 0) continue;

    const leftDerivative = chordDerivative(active, low);
    const rightDerivative = chordDerivative(active, high);
    if (leftDerivative <= 0) continue;
    if (rightDerivative >= 0) continue;
    for (let iteration = 0; iteration < 80; iteration += 1) {
      const middle = (low + high) / 2;
      if (chordDerivative(active, middle) > 0) low = middle;
      else high = middle;
    }
    consider((low + high) / 2);
  }

  const intersectedHoles = holes.flatMap((hole) => {
    const chordWidthMm = chordWidth(hole, criticalOffsetMm);
    return chordWidthMm > GEOMETRY_TOLERANCE_MM ? [{ id: hole.id, chordWidthMm }] : [];
  });
  const minimumNetWidthMm = grossWidthMm - maximumRemovedWidth;
  if (!Number.isFinite(minimumNetWidthMm) || minimumNetWidthMm <= GEOMETRY_TOLERANCE_MM) {
    throw new Error("Net section has no positive finite width");
  }
  return { minimumNetWidthMm, criticalOffsetMm, intersectedHoles };
}

function totalChordWidth(holes: StraightNetSectionHole[], offsetMm: number): number {
  return holes.reduce((total, hole) => total + chordWidth(hole, offsetMm), 0);
}

function chordWidth(hole: StraightNetSectionHole, offsetMm: number): number {
  const radius = hole.diameterMm / 2;
  const delta = offsetMm - hole.centerOffsetMm;
  const radicand = radius * radius - delta * delta;
  return radicand <= 0 ? 0 : 2 * Math.sqrt(radicand);
}

function chordDerivative(holes: StraightNetSectionHole[], offsetMm: number): number {
  let derivative = 0;
  for (const hole of holes) {
    const radius = hole.diameterMm / 2;
    const delta = offsetMm - hole.centerOffsetMm;
    const radicand = radius * radius - delta * delta;
    if (radicand <= 0) {
      derivative += delta < 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
    } else derivative -= 2 * delta / Math.sqrt(radicand);
  }
  return derivative;
}
