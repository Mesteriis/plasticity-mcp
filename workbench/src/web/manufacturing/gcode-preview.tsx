import { useEffect, useMemo, useState } from "react";

interface Segment { x1: number; y1: number; x2: number; y2: number }

export function GcodePreview({ projectId, hash }: { projectId: string; hash: string }) {
  const [layers, setLayers] = useState<Segment[][]>([]);
  const [layer, setLayer] = useState(0);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    void fetch(`/api/projects/${encodeURIComponent(projectId)}/assets/${hash}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`G-code: HTTP ${response.status}`);
        return await response.text();
      })
      .then((text) => { if (active) { const parsed = parseLayers(text); setLayers(parsed); setLayer(Math.max(0, parsed.length - 1)); } })
      .catch((cause: unknown) => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [projectId, hash]);
  const geometry = useMemo(() => fitSegments(layers[layer] ?? []), [layers, layer]);
  if (error) return <div className="gcode-error">{error}</div>;
  if (!layers.length) return <div className="gcode-loading">Чтение слоёв…</div>;
  return <div className="gcode-preview">
    <svg viewBox="0 0 320 320" aria-label={`Траектория слоя ${layer + 1}`}>
      <rect x="0" y="0" width="320" height="320" />
      {geometry.map((segment, index) => <line key={index} {...segment} />)}
    </svg>
    <label>Слой {layer + 1} / {layers.length}<input type="range" min="0" max={layers.length - 1} value={layer} onChange={(event) => setLayer(Number(event.target.value))} /></label>
  </div>;
}

export function parseLayers(gcode: string): Segment[][] {
  const layers: Segment[][] = [];
  let current: Segment[] | undefined;
  let x = 0; let y = 0;
  for (const line of gcode.split(/\r?\n/)) {
    if (line.startsWith(";LAYER_CHANGE")) { current = []; layers.push(current); continue; }
    if (!current || !/^G[01]\s/.test(line)) continue;
    const nextX = value(line, "X") ?? x;
    const nextY = value(line, "Y") ?? y;
    const extrusion = value(line, "E");
    if (extrusion !== undefined && extrusion > 0 && (nextX !== x || nextY !== y)) current.push({ x1: x, y1: y, x2: nextX, y2: nextY });
    x = nextX; y = nextY;
  }
  return layers.filter((segments) => segments.length > 0);
}

function value(line: string, key: string): number | undefined {
  const match = new RegExp(`(?:^|\\s)${key}(-?(?:\\d+(?:\\.\\d*)?|\\.\\d+))`).exec(line);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function fitSegments(segments: Segment[]) {
  if (!segments.length) return [];
  const xs = segments.flatMap((segment) => [segment.x1, segment.x2]);
  const ys = segments.flatMap((segment) => [segment.y1, segment.y2]);
  const minX = Math.min(...xs); const maxX = Math.max(...xs);
  const minY = Math.min(...ys); const maxY = Math.max(...ys);
  const scale = Math.min(290 / Math.max(1, maxX - minX), 290 / Math.max(1, maxY - minY));
  return segments.map((segment) => ({
    x1: 15 + (segment.x1 - minX) * scale,
    y1: 305 - (segment.y1 - minY) * scale,
    x2: 15 + (segment.x2 - minX) * scale,
    y2: 305 - (segment.y2 - minY) * scale,
  }));
}
