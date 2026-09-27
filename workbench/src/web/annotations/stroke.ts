import type { CameraSnapshot, InkPoint } from "../../shared/contracts.ts";

export interface PointerSample {
  type: "pointerdown" | "pointermove" | "pointerup";
  x: number;
  y: number;
  pressure: number;
  tiltX: number;
  tiltY: number;
  timestampMs: number;
}

export interface CapturedStroke { camera: CameraSnapshot; points: InkPoint[]; }

export function reducePointerEvents(camera: CameraSnapshot, events: PointerSample[]): CapturedStroke {
  if (events.length < 2 || events[0]?.type !== "pointerdown" || events.at(-1)?.type !== "pointerup") throw new Error("A stroke needs pointerdown and pointerup samples");
  const points = events.map((event) => ({
    point: [event.x, event.y] as [number, number],
    pressure: clamp(event.pressure || .5, 0, 1),
    tilt: [clamp(event.tiltX, -90, 90), clamp(event.tiltY, -90, 90)] as [number, number],
    timestampMs: Math.max(0, event.timestampMs),
  }));
  return { camera: structuredClone(camera), points: simplify(points, .75) };
}

function simplify(points: InkPoint[], tolerance: number): InkPoint[] {
  if (points.length <= 2) return points;
  const kept: InkPoint[] = [points[0]!];
  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index]!;
    const last = kept.at(-1)!;
    if (Math.hypot(point.point[0] - last.point[0], point.point[1] - last.point[1]) >= tolerance) kept.push(point);
  }
  kept.push(points.at(-1)!);
  return kept;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : 0));
}
