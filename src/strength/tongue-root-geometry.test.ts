import assert from "node:assert/strict";
import test from "node:test";

import { rectangularRootDimensions } from "./tongue-root-geometry.ts";
import { integrateSection, type SectionLoop } from "./section-geometry.ts";

function rectangle(width: number, thickness: number): SectionLoop[] {
  return [{ segments: [
    { kind: "line", start: [0, 0], end: [width, 0] },
    { kind: "line", start: [width, 0], end: [width, thickness] },
    { kind: "line", start: [width, thickness], end: [0, thickness] },
    { kind: "line", start: [0, thickness], end: [0, 0] },
  ] }];
}

test("root dimensions preserve the requested section-plane axes", () => {
  const loops = rectangle(10, 4);
  assert.deepEqual(rectangularRootDimensions(loops, integrateSection(loops)), { rootWidthMm: 10, rootThicknessMm: 4 });
});

test("root dimension extraction rejects rotated, nonrectangular and perforated sections", () => {
  const axisRotated = [{ segments: [
    { kind: "line" as const, start: [0, 0] as [number, number], end: [7, 7] as [number, number] },
    { kind: "line" as const, start: [7, 7] as [number, number], end: [10, 4] as [number, number] },
    { kind: "line" as const, start: [10, 4] as [number, number], end: [3, -3] as [number, number] },
    { kind: "line" as const, start: [3, -3] as [number, number], end: [0, 0] as [number, number] },
  ] }];
  assert.throws(() => rectangularRootDimensions(axisRotated, integrateSection(axisRotated)), /rectangular|axes/i);

  const trapezoid = [{ segments: [
    { kind: "line" as const, start: [0, 0] as [number, number], end: [10, 0] as [number, number] },
    { kind: "line" as const, start: [10, 0] as [number, number], end: [8, 4] as [number, number] },
    { kind: "line" as const, start: [8, 4] as [number, number], end: [2, 4] as [number, number] },
    { kind: "line" as const, start: [2, 4] as [number, number], end: [0, 0] as [number, number] },
  ] }];
  assert.throws(() => rectangularRootDimensions(trapezoid, integrateSection(trapezoid)), /rectangular|corner/i);

  const outer = rectangle(10, 4);
  const hole: SectionLoop = { segments: [
    { kind: "line", start: [4, 1], end: [6, 1] },
    { kind: "line", start: [6, 1], end: [6, 3] },
    { kind: "line", start: [6, 3], end: [4, 3] },
    { kind: "line", start: [4, 3], end: [4, 1] },
  ] };
  const perforated = [...outer, hole];
  assert.throws(() => rectangularRootDimensions(perforated, integrateSection(perforated)), /without holes/i);
});
