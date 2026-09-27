// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CameraSnapshot } from "../../src/shared/contracts.ts";
import { AnnotationLayer, projectWorldPoint } from "../../src/web/annotations/annotation-layer.tsx";

const camera: CameraSnapshot = {
  id: "33333333-3333-4333-8333-333333333333",
  projection: "perspective",
  positionMm: [0, 0, 10], targetMm: [0, 0, 0], up: [0, 1, 0],
  viewMatrix: Array(16).fill(0), projectionMatrix: Array(16).fill(0), viewport: [200, 100],
};

afterEach(cleanup);

describe("AnnotationLayer", () => {
  it("captures a pressure-aware stroke only when ink is active", () => {
    const complete = vi.fn();
    render(<AnnotationLayer tool="pen" camera={camera} onComplete={complete} />);
    const layer = screen.getByLabelText("Слой аннотаций");
    Object.defineProperty(layer, "getBoundingClientRect", { value: () => ({ left: 0, top: 0, width: 200, height: 100 }) });
    fireEvent.pointerDown(layer, { pointerId: 1, clientX: 20, clientY: 20, pressure: .4 });
    fireEvent.pointerMove(layer, { pointerId: 1, clientX: 40, clientY: 30, pressure: .8 });
    fireEvent.pointerUp(layer, { pointerId: 1, clientX: 60, clientY: 40, pressure: .5 });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]?.[0].kind).toBe("pen");
    expect(complete.mock.calls[0]?.[0].stroke).toHaveLength(3);
  });

  it("anchors a stylus stroke to picked B-Rep geometry when available", () => {
    const complete = vi.fn();
    const pickAnchor = vi.fn(() => ({ kind: "face" as const, bodyId: 7, faceId: "face-3", pointMm: [10, 20, 30] as [number, number, number] }));
    render(<AnnotationLayer tool="pen" camera={camera} pickAnchor={pickAnchor} onComplete={complete} />);
    const layer = screen.getByLabelText("Слой аннотаций");
    Object.defineProperty(layer, "getBoundingClientRect", { value: () => ({ left: 0, top: 0, width: 200, height: 100 }) });
    fireEvent.pointerDown(layer, { pointerId: 2, clientX: 25, clientY: 30, pressure: .5 });
    fireEvent.pointerUp(layer, { pointerId: 2, clientX: 30, clientY: 35, pressure: .5 });
    expect(pickAnchor).toHaveBeenCalledWith(25, 30);
    expect(complete.mock.calls[0]?.[0].anchor).toEqual({ kind: "face", bodyId: 7, faceId: "face-3", pointMm: [10, 20, 30] });
  });

  it("keeps completed strokes visible and captures validated note text", () => {
    const complete = vi.fn();
    const { rerender } = render(<AnnotationLayer tool="navigate" camera={camera} annotations={[{
      kind: "pen",
      anchor: { kind: "screen", cameraId: camera.id, point: [.1, .2] },
      stroke: [{ point: [10, 20], pressure: .5, tilt: [0, 0], timestampMs: 1 }, { point: [30, 40], pressure: .5, tilt: [0, 0], timestampMs: 2 }],
    }]} onComplete={complete} />);
    expect(document.querySelector('[data-annotation-kind="pen"]')).not.toBeNull();

    rerender(<AnnotationLayer tool="note" camera={camera} requestText={() => "  увеличить радиус  "} onComplete={complete} />);
    const layer = screen.getByLabelText("Слой аннотаций");
    Object.defineProperty(layer, "getBoundingClientRect", { value: () => ({ left: 0, top: 0, width: 200, height: 100 }) });
    fireEvent.pointerDown(layer, { pointerId: 3, clientX: 40, clientY: 30, pressure: .5 });
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ kind: "note", text: "увеличить радиус" }));
  });

  it("projects a world anchor with column-major camera matrices", () => {
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(projectWorldPoint([0, 0, 0], { ...camera, viewMatrix: identity, projectionMatrix: identity })).toEqual([100, 50]);
  });
});
