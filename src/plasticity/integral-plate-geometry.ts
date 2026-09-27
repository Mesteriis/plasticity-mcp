import type { CadBinding } from "../strength/contracts.ts";
import type { PlasticityRuntime } from "./runtime.ts";
import { inspectPlanarSection } from "./section-geometry.ts";

type Vector3 = [number, number, number];
const LINEAR_TOLERANCE_MM = 1e-5;
const ANGULAR_TOLERANCE = 1e-8;

export interface IntegralPlateRequest {
  bodyId: number;
  frontFaceId: string;
  backFaceId: string;
  revision: string;
  xDirection: Vector3;
}

export interface IntegralPlateGeometry {
  lengthMm: number;
  widthMm: number;
  thicknessMm: number;
}

export interface IntegralPlateEvidence {
  status: "verified" | "unsupported";
  binding: CadBinding;
  faces: { frontFaceId: string; backFaceId: string };
  geometry?: IntegralPlateGeometry;
  source: "native-brep-opposed-rectangular-faces";
  reasons: string[];
}

interface RectangularFaceSize {
  lengthMm: number;
  widthMm: number;
}

export async function inspectIntegralRectangularPlate(
  runtime: PlasticityRuntime,
  request: IntegralPlateRequest,
  sessionId: string,
): Promise<IntegralPlateEvidence> {
  if (!sessionId) throw new Error("MCP session ID is required");
  if (request.frontFaceId === request.backFaceId) throw new Error("Integral-plate face IDs must be distinct");
  const before = await runtime.getState();
  const binding: CadBinding = {
    sessionId,
    documentToken: before.documentToken,
    revision: request.revision,
    bodyId: request.bodyId,
  };
  if (before.revision !== request.revision) return unsupported(binding, request, ["stale-reference"]);
  const matches = before.bodies.filter((body) => body.id === request.bodyId);
  if (matches.length !== 1) return unsupported(binding, request, [matches.length === 0 ? "unknown-body" : "duplicate-body"]);

  const front = await inspectPlanarSection(runtime, {
    bodyId: request.bodyId,
    faceId: request.frontFaceId,
    revision: request.revision,
    xDirection: request.xDirection,
  }, sessionId);
  const back = await inspectPlanarSection(runtime, {
    bodyId: request.bodyId,
    faceId: request.backFaceId,
    revision: request.revision,
    xDirection: request.xDirection,
  }, sessionId);
  if (front.status !== "verified") return unsupported(binding, request, front.reasons.map((reason) => `front:${reason}`));
  if (back.status !== "verified") return unsupported(binding, request, back.reasons.map((reason) => `back:${reason}`));
  if (!front.frame || !back.frame || !front.properties || !back.properties || !front.loops || !back.loops) {
    return unsupported(binding, request, ["missing-exact-face-evidence"]);
  }

  const reasons = new Set<string>();
  if (dot3(front.frame.normal, back.frame.normal) > -1 + ANGULAR_TOLERANCE) reasons.add("faces-are-not-opposed");
  const frontSize = rectangularFaceSize(front);
  const backSize = rectangularFaceSize(back);
  if (!frontSize || !backSize) reasons.add("faces-are-not-exact-rectangles");
  const centerDelta = subtract3(back.properties.centroidMm, front.properties.centroidMm);
  const signedThickness = dot3(centerDelta, front.frame.normal);
  const inPlaneDelta = subtract3(centerDelta, scale3(front.frame.normal, signedThickness));
  if (Math.hypot(...inPlaneDelta) > LINEAR_TOLERANCE_MM) reasons.add("opposed-face-centroids-are-not-aligned");
  if (!Number.isFinite(signedThickness) || Math.abs(signedThickness) <= LINEAR_TOLERANCE_MM) reasons.add("invalid-wall-thickness");
  if (frontSize && backSize) {
    const thickness = Math.abs(signedThickness);
    const validInset = (frontSpan: number, backSpan: number): boolean => {
      const difference = Math.abs(frontSpan - backSpan);
      return near(difference, 0) || near(difference, 2 * thickness);
    };
    if (!validInset(frontSize.lengthMm, backSize.lengthMm) || !validInset(frontSize.widthMm, backSize.widthMm)) {
      reasons.add("opposed-face-outlines-do-not-match-or-thickness-inset");
    }
  }

  const after = await runtime.getState();
  if (after.documentToken !== before.documentToken || after.revision !== before.revision) reasons.add("stale-reference");
  if (reasons.size > 0 || !frontSize || !backSize) return unsupported(binding, request, [...reasons]);
  return {
    status: "verified",
    binding,
    faces: { frontFaceId: request.frontFaceId, backFaceId: request.backFaceId },
    geometry: {
      lengthMm: (frontSize.lengthMm + backSize.lengthMm) / 2,
      widthMm: (frontSize.widthMm + backSize.widthMm) / 2,
      thicknessMm: Math.abs(signedThickness),
    },
    source: "native-brep-opposed-rectangular-faces",
    reasons: [],
  };
}

function rectangularFaceSize(section: Awaited<ReturnType<typeof inspectPlanarSection>>): RectangularFaceSize | null {
  if (!section.properties?.rectangular || section.properties.innerLoopCount !== 0 || section.loops?.length !== 1) return null;
  const segments = section.loops[0]!.segments;
  if (segments.length !== 4 || segments.some((segment) => segment.kind !== "line")) return null;
  const points = segments.flatMap((segment) => segment.kind === "line" ? [segment.start, segment.end] : []);
  const xs = cluster(points.map((point) => point[0]));
  const ys = cluster(points.map((point) => point[1]));
  if (xs.length !== 2 || ys.length !== 2) return null;
  for (const segment of segments) {
    if (segment.kind !== "line") return null;
    const dx = Math.abs(segment.end[0] - segment.start[0]);
    const dy = Math.abs(segment.end[1] - segment.start[1]);
    if ((dx <= LINEAR_TOLERANCE_MM) === (dy <= LINEAR_TOLERANCE_MM)) return null;
  }
  const lengthMm = xs[1]! - xs[0]!;
  const widthMm = ys[1]! - ys[0]!;
  if (!(lengthMm > 0 && widthMm > 0)) return null;
  return { lengthMm, widthMm };
}

function cluster(values: number[]): number[] {
  const sorted = [...values].sort((left, right) => left - right);
  const output: number[] = [];
  for (const value of sorted) {
    if (output.length === 0 || Math.abs(value - output.at(-1)!) > LINEAR_TOLERANCE_MM) output.push(value);
  }
  return output;
}

function unsupported(binding: CadBinding, request: IntegralPlateRequest, reasons: string[]): IntegralPlateEvidence {
  return {
    status: "unsupported",
    binding,
    faces: { frontFaceId: request.frontFaceId, backFaceId: request.backFaceId },
    source: "native-brep-opposed-rectangular-faces",
    reasons: [...new Set(reasons)],
  };
}

function dot3(left: Vector3, right: Vector3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function subtract3(left: Vector3, right: Vector3): Vector3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function scale3(vector: Vector3, scale: number): Vector3 {
  return [vector[0] * scale, vector[1] * scale, vector[2] * scale];
}

function near(left: number, right: number, tolerance = LINEAR_TOLERANCE_MM): boolean {
  return Math.abs(left - right) <= tolerance;
}
