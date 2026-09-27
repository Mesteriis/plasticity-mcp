import assert from "node:assert/strict";
import test from "node:test";

import { serializeHiddenLineSvg, type HiddenLineProjectionSegment } from "./hiddenline-svg.ts";

test("serializes native orthographic segments in millimeter-scaled SVG coordinates", () => {
  const svg = serializeHiddenLineSvg({
    positions: [10, 20, 20, 30],
    segments: [{ bodyIndex: 0, category: "Edge-Visible-NotSmooth", offset: 0, count: 2 }],
    scaleXmmPerPixel: 2,
    scaleYmmPerPixel: 3,
    marginMm: 1,
  });

  assert.match(svg, /width="22mm" height="32mm" viewBox="0 0 22 32"/);
  assert.match(svg, /d="M 1 31 L 21 1"/);
  assert.match(svg, /data-source="plasticity-native-hidden-line"/);
});

test("marks native hidden edges with a dashed stroke", () => {
  const svg = serializeHiddenLineSvg({
    positions: [0, 0, 1, 1],
    segments: [{ bodyIndex: 0, category: "Edge-Hidden-NotSmooth", offset: 0, count: 2 }],
    scaleXmmPerPixel: 1,
    scaleYmmPerPixel: 1,
  });

  assert.match(svg, /stroke-dasharray="3 1\.5"/);
});

test("rejects invalid projection scales and segment ranges", () => {
  const input: {
    positions: number[];
    segments: HiddenLineProjectionSegment[];
    scaleXmmPerPixel: number;
    scaleYmmPerPixel: number;
  } = {
    positions: [0, 0, 1, 1],
    segments: [{ bodyIndex: 0, category: "Edge-Visible", offset: 0, count: 2 }],
    scaleXmmPerPixel: 1,
    scaleYmmPerPixel: 1,
  };

  const segment = input.segments[0]!;
  assert.throws(() => serializeHiddenLineSvg({ ...input, scaleXmmPerPixel: 0 }), /positive finite/);
  assert.throws(() => serializeHiddenLineSvg({ ...input, segments: [{ ...segment, offset: 2 }] }), /range/);
  assert.throws(() => serializeHiddenLineSvg({ ...input, positions: [0, 0, Number.NaN, 1] }), /finite/);
});

test("escapes category metadata instead of allowing SVG markup injection", () => {
  const svg = serializeHiddenLineSvg({
    positions: [0, 0, 1, 1],
    segments: [{ bodyIndex: 0, category: 'Edge-Visible" onload="alert(1)', offset: 0, count: 2 }],
    scaleXmmPerPixel: 1,
    scaleYmmPerPixel: 1,
  });

  assert.match(svg, /data-category="Edge-Visible&quot; onload=&quot;alert\(1\)"/);
  assert.doesNotMatch(svg, /data-category="Edge-Visible" onload=/);
});
