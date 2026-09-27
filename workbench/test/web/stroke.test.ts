import { describe, expect, it } from "vitest";

import type { CameraSnapshot } from "../../src/shared/contracts.ts";
import { reducePointerEvents } from "../../src/web/annotations/stroke.ts";

const camera: CameraSnapshot = {
  id: "33333333-3333-4333-8333-333333333333",
  projection: "perspective",
  positionMm: [100, -100, 80],
  targetMm: [0, 0, 0],
  up: [0, 0, 1],
  viewMatrix: Array(16).fill(0),
  projectionMatrix: Array(16).fill(0),
  viewport: [100, 100],
};

describe("stroke capture", () => {
  it("records pressure and preserves the immutable camera", () => {
    const stroke = reducePointerEvents(camera, [
      { type: "pointerdown", x: 10, y: 20, pressure: 0.3, tiltX: 0, tiltY: 0, timestampMs: 1 },
      { type: "pointermove", x: 15, y: 24, pressure: 0.7, tiltX: 2, tiltY: 3, timestampMs: 2 },
      { type: "pointerup", x: 18, y: 30, pressure: 0.5, tiltX: 0, tiltY: 0, timestampMs: 3 },
    ]);
    expect(stroke.points.map((point) => point.pressure)).toEqual([0.3, 0.7, 0.5]);
    expect(stroke.camera).toEqual(camera);
    expect(stroke.camera).not.toBe(camera);
  });
});
