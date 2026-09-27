export interface HiddenLineProjectionSegment {
  bodyIndex: number;
  category: string;
  offset: number;
  count: number;
}

export interface HiddenLineSvgInput {
  positions: readonly number[];
  segments: readonly HiddenLineProjectionSegment[];
  scaleXmmPerPixel: number;
  scaleYmmPerPixel: number;
  marginMm?: number;
}

const MAX_HIDDEN_LINE_POINTS = 2_000_000;
const MAX_HIDDEN_LINE_SEGMENTS = 100_000;
const MAX_HIDDEN_LINE_SVG_BYTES = 16 * 1024 * 1024;

export function serializeHiddenLineSvg(input: HiddenLineSvgInput): string {
  const { positions, segments, scaleXmmPerPixel, scaleYmmPerPixel } = input;
  const marginMm = input.marginMm ?? 1;
  requirePositiveFinite(scaleXmmPerPixel, "Horizontal projection scale");
  requirePositiveFinite(scaleYmmPerPixel, "Vertical projection scale");
  if (!Number.isFinite(marginMm) || marginMm < 0 || marginMm > 1_000) {
    throw new Error("SVG margin must be a finite value between 0 and 1000 mm");
  }
  if (!Array.isArray(positions) || positions.length < 4 || positions.length % 2 !== 0 || positions.length / 2 > MAX_HIDDEN_LINE_POINTS) {
    throw new Error(`Hidden-line projection must contain 2 to ${MAX_HIDDEN_LINE_POINTS.toLocaleString("en-US")} points`);
  }
  if (!Array.isArray(segments) || segments.length === 0 || segments.length > MAX_HIDDEN_LINE_SEGMENTS) {
    throw new Error(`Hidden-line projection must contain 1 to ${MAX_HIDDEN_LINE_SEGMENTS.toLocaleString("en-US")} segments`);
  }
  for (let index = 0; index < positions.length; index += 1) {
    if (!Number.isFinite(positions[index])) throw new Error(`Hidden-line projection contains a non-finite coordinate at index ${index}`);
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const projectedSegments = segments.map((segment, index) => {
    if (!Number.isInteger(segment.bodyIndex) || segment.bodyIndex < 0) throw new Error(`Hidden-line segment ${index} has an invalid body index`);
    if (typeof segment.category !== "string" || segment.category.length === 0 || segment.category.length > 256) {
      throw new Error(`Hidden-line segment ${index} has an invalid category`);
    }
    if (!Number.isInteger(segment.offset) || !Number.isInteger(segment.count) || segment.offset < 0 || segment.count < 2 || segment.count > MAX_HIDDEN_LINE_POINTS) {
      throw new Error(`Hidden-line segment ${index} has an invalid point range`);
    }
    const end = segment.offset + segment.count * 2;
    if (end > positions.length) throw new Error(`Hidden-line segment ${index} point range exceeds the projection data`);

    const points: Array<[number, number]> = [];
    for (let pointIndex = 0; pointIndex < segment.count; pointIndex += 1) {
      const positionIndex = segment.offset + pointIndex * 2;
      const x = positions[positionIndex]! * scaleXmmPerPixel;
      const y = -positions[positionIndex + 1]! * scaleYmmPerPixel;
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`Hidden-line segment ${index} exceeds finite SVG coordinates`);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      points.push([x, y]);
    }
    return { segment, points };
  });

  const widthMm = maxX - minX;
  const heightMm = maxY - minY;
  if (!Number.isFinite(widthMm) || !Number.isFinite(heightMm) || widthMm <= 1e-9 || heightMm <= 1e-9) {
    throw new Error("Hidden-line projection has no measurable width or height in the selected orthographic view");
  }
  const pageWidthMm = widthMm + marginMm * 2;
  const pageHeightMm = heightMm + marginMm * 2;
  const paths = projectedSegments.map(({ segment, points }) => {
    const pathData = points.map(([x, y], index) => `${index === 0 ? "M" : "L"} ${formatNumber(x - minX + marginMm)} ${formatNumber(y - minY + marginMm)}`).join(" ");
    const hidden = segment.category.includes("Hidden");
    const silhouette = segment.category.includes("Silhouette");
    const smooth = segment.category.includes("Smooth");
    const strokeWidthMm = hidden || smooth ? 0.25 : 0.5;
    const dash = hidden ? ' stroke-dasharray="3 1.5"' : "";
    const color = hidden ? "#737b86" : "#20252b";
    return `<path d="${pathData}" fill="none" stroke="${color}" stroke-width="${formatNumber(strokeWidthMm)}" stroke-linecap="round" stroke-linejoin="round"${silhouette ? ' data-silhouette="true"' : ""}${dash} data-body-index="${segment.bodyIndex}" data-category="${escapeXml(segment.category)}"/>`;
  }).join("");
  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${formatNumber(pageWidthMm)}mm" height="${formatNumber(pageHeightMm)}mm" viewBox="0 0 ${formatNumber(pageWidthMm)} ${formatNumber(pageHeightMm)}" data-source="plasticity-native-hidden-line" data-units="mm">\n  <title>Plasticity native hidden-line projection</title>\n  <desc>Orthographic projection of native Plasticity geometry. Dimensions are projected model millimeters.</desc>\n  <g fill="none">${paths}</g>\n</svg>\n`;
  if (Buffer.byteLength(svg, "utf8") > MAX_HIDDEN_LINE_SVG_BYTES) throw new Error("SVG export exceeds the 16 MiB output limit");
  return svg;
}

function requirePositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive finite`);
}

function formatNumber(value: number): string {
  const stable = Math.abs(value) < 1e-12 ? 0 : value;
  return Number(stable.toPrecision(12)).toString();
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("'", "&apos;");
}
