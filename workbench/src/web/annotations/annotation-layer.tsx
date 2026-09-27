import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import type { AnnotationAnchor, AnnotationInput, CameraSnapshot, InkPoint } from "../../shared/contracts.ts";
import { reducePointerEvents, type PointerSample } from "./stroke.ts";

export type AnnotationTool = "navigate" | "pen" | "highlighter" | "arrow" | "marker" | "note" | "dimension" | "eraser";

export function AnnotationLayer({
  tool,
  camera,
  annotations = [],
  pickAnchor,
  requestText = defaultTextRequest,
  onComplete,
}: {
  tool: AnnotationTool;
  camera: CameraSnapshot;
  annotations?: AnnotationInput[];
  pickAnchor?: (clientX: number, clientY: number) => AnnotationAnchor | undefined;
  requestText?: (kind: "note" | "dimension") => string | undefined;
  onComplete(annotation: AnnotationInput): void;
}) {
  const active = useRef<{ pointerId: number; samples: PointerSample[]; anchor: AnnotationAnchor } | undefined>(undefined);
  const [preview, setPreview] = useState<InkPoint[]>([]);
  const enabled = ["pen", "highlighter", "arrow", "marker", "note", "dimension"].includes(tool);
  const sample = (event: ReactPointerEvent<SVGSVGElement>, type: PointerSample["type"]): PointerSample => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { type, x: event.clientX - bounds.left, y: event.clientY - bounds.top, pressure: event.pressure, tiltX: event.tiltX, tiltY: event.tiltY, timestampMs: event.timeStamp };
  };
  const start = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!enabled) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const first = sample(event, "pointerdown");
    const anchor = pickAnchor?.(event.clientX, event.clientY) ?? screenAnchor(camera, first, event.currentTarget);
    if (tool === "note") {
      const text = requestText("note")?.trim();
      if (text) onComplete({ kind: "note", text, anchor, camera: structuredClone(camera) });
      return;
    }
    if (tool === "marker") {
      onComplete({ kind: "marker", anchor, camera: structuredClone(camera) });
      return;
    }
    active.current = { pointerId: event.pointerId, samples: [first], anchor };
    setPreview([{ point: [first.x, first.y], pressure: first.pressure, tilt: [first.tiltX, first.tiltY], timestampMs: first.timestampMs }]);
  };
  const move = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!active.current || active.current.pointerId !== event.pointerId) return;
    const next = sample(event, "pointermove"); active.current.samples.push(next);
    setPreview((current) => [...current, { point: [next.x, next.y], pressure: next.pressure, tilt: [next.tiltX, next.tiltY], timestampMs: next.timestampMs }]);
  };
  const finish = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!active.current || active.current.pointerId !== event.pointerId) return;
    active.current.samples.push(sample(event, "pointerup"));
    const captured = reducePointerEvents(camera, active.current.samples);
    const kind = tool === "highlighter" ? "highlighter" : tool === "arrow" ? "arrow" : tool === "dimension" ? "dimension" : "pen";
    const text = kind === "dimension" ? requestText("dimension")?.trim() : undefined;
    if (kind !== "dimension" || text) {
      onComplete({ kind, ...(text ? { text } : {}), anchor: active.current.anchor, camera: captured.camera, stroke: captured.points });
    }
    active.current = undefined; setPreview([]);
  };
  return <svg aria-label="Слой аннотаций" className={`annotation-layer ${enabled ? "ink-active" : ""}`} viewBox={`0 0 ${camera.viewport[0]} ${camera.viewport[1]}`} preserveAspectRatio="none" onPointerDown={start} onPointerMove={move} onPointerUp={finish}>
    <defs><marker id="annotation-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" /></marker></defs>
    {annotations.map((annotation, index) => <RenderedAnnotation key={index} annotation={annotation} camera={camera} />)}
    {preview.length > 1 ? <polyline points={preview.map((point) => point.point.join(",")).join(" ")} fill="none" stroke={tool === "highlighter" ? "#f8db64" : "#b7f397"} strokeWidth={tool === "highlighter" ? 12 : 3} strokeLinecap="round" strokeLinejoin="round" opacity={tool === "highlighter" ? .45 : 1} /> : null}
  </svg>;
}

function RenderedAnnotation({ annotation, camera }: { annotation: AnnotationInput; camera: CameraSnapshot }) {
  const points = annotation.stroke?.map((point) => point.point) ?? [];
  const anchor = annotationPoint(annotation.anchor, camera);
  if ((annotation.kind === "pen" || annotation.kind === "highlighter") && points.length > 1) {
    return <polyline data-annotation-kind={annotation.kind} points={points.map((point) => point.join(",")).join(" ")} fill="none" stroke={annotation.kind === "highlighter" ? "#f8db64" : "#b7f397"} strokeWidth={annotation.kind === "highlighter" ? 12 : 3} strokeLinecap="round" strokeLinejoin="round" opacity={annotation.kind === "highlighter" ? .45 : 1} />;
  }
  if ((annotation.kind === "arrow" || annotation.kind === "dimension") && points.length > 1) {
    const start = points[0]!;
    const end = points.at(-1)!;
    const middle: [number, number] = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
    return <g data-annotation-kind={annotation.kind}><line x1={start[0]} y1={start[1]} x2={end[0]} y2={end[1]} markerEnd={annotation.kind === "arrow" ? "url(#annotation-arrow)" : undefined} />{annotation.kind === "dimension" && annotation.text ? <AnnotationLabel point={middle} text={annotation.text} /> : null}</g>;
  }
  if (annotation.kind === "marker" && anchor) return <circle data-annotation-kind="marker" cx={anchor[0]} cy={anchor[1]} r="7" />;
  if (annotation.kind === "note" && anchor && annotation.text) return <AnnotationLabel point={anchor} text={annotation.text} />;
  return null;
}

function AnnotationLabel({ point, text }: { point: [number, number]; text: string }) {
  const width = Math.min(260, Math.max(64, text.length * 7 + 18));
  return <g className="annotation-label"><rect x={point[0] + 8} y={point[1] - 25} width={width} height="28" rx="5" /><text x={point[0] + 16} y={point[1] - 7}>{text}</text></g>;
}

function annotationPoint(anchor: AnnotationAnchor, camera: CameraSnapshot): [number, number] | undefined {
  if (anchor.kind === "screen") return [anchor.point[0] * camera.viewport[0], anchor.point[1] * camera.viewport[1]];
  return projectWorldPoint(anchor.pointMm, camera);
}

export function projectWorldPoint(point: [number, number, number], camera: CameraSnapshot): [number, number] | undefined {
  const view = transform(camera.viewMatrix, [point[0], point[1], point[2], 1]);
  const clip = transform(camera.projectionMatrix, view);
  if (!Number.isFinite(clip[3]) || Math.abs(clip[3]) < 1e-9) return undefined;
  const x = clip[0] / clip[3];
  const y = clip[1] / clip[3];
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return [(x + 1) * camera.viewport[0] / 2, (1 - y) * camera.viewport[1] / 2];
}

function transform(matrix: number[], vector: [number, number, number, number]): [number, number, number, number] {
  return [
    matrix[0]! * vector[0] + matrix[4]! * vector[1] + matrix[8]! * vector[2] + matrix[12]! * vector[3],
    matrix[1]! * vector[0] + matrix[5]! * vector[1] + matrix[9]! * vector[2] + matrix[13]! * vector[3],
    matrix[2]! * vector[0] + matrix[6]! * vector[1] + matrix[10]! * vector[2] + matrix[14]! * vector[3],
    matrix[3]! * vector[0] + matrix[7]! * vector[1] + matrix[11]! * vector[2] + matrix[15]! * vector[3],
  ];
}

function defaultTextRequest(kind: "note" | "dimension"): string | undefined {
  const value = window.prompt(kind === "note" ? "Текст заметки" : "Размер и единица, например 12,5 мм")?.trim();
  if (!value) return undefined;
  if (value.length > 4000) {
    window.alert("Аннотация должна быть не длиннее 4000 символов");
    return undefined;
  }
  if (kind === "dimension" && !/^[+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)\s*(?:мм|mm|°|deg|град|шт|pcs)$/iu.test(value)) {
    window.alert("Введите число и единицу: мм, mm, °, deg, град, шт или pcs");
    return undefined;
  }
  return value;
}

function screenAnchor(camera: CameraSnapshot, sample: PointerSample, element: SVGSVGElement): AnnotationAnchor {
  const bounds = element.getBoundingClientRect();
  return {
    kind: "screen",
    cameraId: camera.id,
    point: [sample.x / Math.max(bounds.width, 1), sample.y / Math.max(bounds.height, 1)],
  };
}
