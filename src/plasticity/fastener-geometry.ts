import { createHash } from "node:crypto";

import type { FastenerBinding, FastenerPlateGeometry } from "../strength/fastener-contracts.ts";
import type { SectionLoop } from "../strength/section-geometry.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";
import { inspectPlanarSection, type SectionEvidence } from "./section-geometry.ts";

type Vector3 = [number, number, number];

export interface FastenerPlateRequest {
  bodyId: number;
  frontFaceId: string;
  backFaceId: string;
  revision: string;
  loadDirection: Vector3;
}

export interface FastenerPlateEvidence {
  status: "verified" | "unsupported";
  binding: FastenerBinding;
  geometry?: FastenerPlateGeometry;
  loadDirection?: Vector3;
  holeCenterMm?: Vector3;
  source: "native-brep-opposed-faces";
  reasons: string[];
}

export interface FastenerFaceDescriptor {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  holeCenter: [number, number];
  holeRadiusMm: number;
}

export interface RectangularPerforatedFaceDescriptor {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  holes: Array<{ center: [number, number]; radiusMm: number }>;
}

const LENGTH_TOLERANCE_MM = 1e-5;
const ANGULAR_TOLERANCE = 1e-8;

export async function inspectSingleFastenerPlate(
  runtime: PlasticityRuntime,
  request: FastenerPlateRequest,
  sessionId: string,
): Promise<FastenerPlateEvidence> {
  if (!sessionId) throw new Error("MCP session ID is required");
  if (request.frontFaceId === request.backFaceId) throw new Error("Front and back face IDs must be distinct");
  const direction = normalize(request.loadDirection);
  if (!direction) throw new Error("Load direction must be nonzero and finite");
  const before = await runtime.getState();
  const initialBinding = binding(sessionId, before.documentToken, request, "unavailable");
  if (before.revision !== request.revision) return unsupported(initialBinding, ["stale-reference"]);
  const matches = before.bodies.filter((body) => body.id === request.bodyId);
  if (matches.length !== 1) return unsupported(initialBinding, [matches.length === 0 ? "unknown-body" : "duplicate-body"]);
  const body = matches[0]!;
  const reasons = validateBodyTopology(body, request);
  if (reasons.length > 0) return unsupported(initialBinding, reasons);

  const front = await inspectPlanarSection(runtime, {
    bodyId: request.bodyId,
    faceId: request.frontFaceId,
    revision: request.revision,
    xDirection: direction,
  }, sessionId);
  const back = await inspectPlanarSection(runtime, {
    bodyId: request.bodyId,
    faceId: request.backFaceId,
    revision: request.revision,
    xDirection: direction,
  }, sessionId);
  if (front.status !== "verified") return unsupported(initialBinding, front.reasons.map((reason) => `front:${reason}`));
  if (back.status !== "verified") return unsupported(initialBinding, back.reasons.map((reason) => `back:${reason}`));
  if (!front.frame || !back.frame) return unsupported(initialBinding, ["missing-face-frame"]);

  let frontDescriptor: FastenerFaceDescriptor;
  let backDescriptor: FastenerFaceDescriptor;
  try {
    frontDescriptor = describeFastenerFace(front);
    backDescriptor = describeFastenerFace(back);
  } catch (error) {
    return unsupported(initialBinding, [error instanceof Error ? error.message : "invalid-fastener-face"]);
  }
  const frontNormal = normalize(front.frame.normal);
  const backNormal = normalize(back.frame.normal);
  if (!frontNormal || !backNormal || dot(frontNormal, backNormal) > -1 + ANGULAR_TOLERANCE) {
    return unsupported(initialBinding, ["selected-faces-not-opposed"]);
  }
  if (Math.abs(dot(direction, frontNormal)) > ANGULAR_TOLERANCE) {
    return unsupported(initialBinding, ["load-direction-not-in-face-plane"]);
  }
  if (!same(frontDescriptor.maxX - frontDescriptor.minX, backDescriptor.maxX - backDescriptor.minX) ||
      !same(frontDescriptor.maxY - frontDescriptor.minY, backDescriptor.maxY - backDescriptor.minY) ||
      !same(frontDescriptor.holeRadiusMm, backDescriptor.holeRadiusMm)) {
    return unsupported(initialBinding, ["front-back-profiles-differ"]);
  }
  const frontOuterCenter = localToWorld(front, [
    (frontDescriptor.minX + frontDescriptor.maxX) / 2,
    (frontDescriptor.minY + frontDescriptor.maxY) / 2,
  ]);
  const backOuterCenter = localToWorld(back, [
    (backDescriptor.minX + backDescriptor.maxX) / 2,
    (backDescriptor.minY + backDescriptor.maxY) / 2,
  ]);
  const frontHole = localToWorld(front, frontDescriptor.holeCenter);
  const backHole = localToWorld(back, backDescriptor.holeCenter);
  const holeDelta = subtract(backHole, frontHole);
  const thicknessMm = Math.abs(dot(subtract(back.frame.originMm, front.frame.originMm), frontNormal));
  if (!(thicknessMm > LENGTH_TOLERANCE_MM)) return unsupported(initialBinding, ["zero-thickness"]);
  const outerDelta = subtract(backOuterCenter, frontOuterCenter);
  const tangentialOuterOffset = subtract(outerDelta, scale(frontNormal, dot(outerDelta, frontNormal)));
  if (Math.hypot(...tangentialOuterOffset) > LENGTH_TOLERANCE_MM || !same(Math.abs(dot(outerDelta, frontNormal)), thicknessMm)) {
    return unsupported(initialBinding, ["front-back-outlines-not-aligned"]);
  }
  const tangentialHoleOffset = subtract(holeDelta, scale(frontNormal, dot(holeDelta, frontNormal)));
  if (Math.hypot(...tangentialHoleOffset) > LENGTH_TOLERANCE_MM || !same(Math.abs(dot(holeDelta, frontNormal)), thicknessMm)) {
    return unsupported(initialBinding, ["hole-axis-not-normal-to-faces"]);
  }

  const radius = frontDescriptor.holeRadiusMm;
  const cylinder = body.faces.find((face) => !face.planar)!;
  const cylinderAxis = cylinder.axisDirection === null ? null : normalize(cylinder.axisDirection);
  if (!same(cylinder.radiusMm!, radius) || (cylinder.axisDirection !== null && (!cylinderAxis || Math.abs(Math.abs(dot(cylinderAxis, frontNormal)) - 1) > ANGULAR_TOLERANCE))) {
    return unsupported(initialBinding, ["cylindrical-face-does-not-match-hole"]);
  }
  const geometry: FastenerPlateGeometry = {
    thicknessMm,
    holeDiameterMm: 2 * radius,
    loadedEdgeDistanceMm: frontDescriptor.maxX - frontDescriptor.holeCenter[0],
    oppositeEdgeDistanceMm: frontDescriptor.holeCenter[0] - frontDescriptor.minX,
    grossWidthMm: frontDescriptor.maxY - frontDescriptor.minY,
    sideClearancesMm: [
      frontDescriptor.holeCenter[1] - radius - frontDescriptor.minY,
      frontDescriptor.maxY - frontDescriptor.holeCenter[1] - radius,
    ],
  };
  if (Object.values(geometry).flat().some((value) => !Number.isFinite(value))) {
    return unsupported(initialBinding, ["non-finite-geometry"]);
  }
  if (geometry.loadedEdgeDistanceMm <= radius || geometry.oppositeEdgeDistanceMm <= radius || geometry.sideClearancesMm.some((value) => value < -LENGTH_TOLERANCE_MM)) {
    return unsupported(initialBinding, ["hole-not-contained-in-plate"]);
  }
  const after = await runtime.getState();
  if (after.documentToken !== before.documentToken || after.revision !== before.revision) {
    return unsupported(initialBinding, ["stale-reference"]);
  }
  const topologySignature = createHash("sha256").update(JSON.stringify({
    bodyVersionId: body.versionId,
    faceCount: body.faceIds.length,
    edgeCount: body.edgeIds.length,
    front: front.binding.topologySignature,
    back: back.binding.topologySignature,
    geometry,
  })).digest("hex");
  return {
    status: "verified",
    binding: binding(sessionId, before.documentToken, request, topologySignature),
    geometry,
    loadDirection: direction,
    holeCenterMm: midpoint(frontHole, backHole),
    source: "native-brep-opposed-faces",
    reasons: [],
  };
}

export function describeFastenerFace(section: SectionEvidence): FastenerFaceDescriptor {
  const descriptor = describeRectangularPerforatedFace(section);
  if (descriptor.holes.length !== 1) {
    throw new Error("fastener face requires exactly one circular hole");
  }
  const hole = descriptor.holes[0]!;
  return {
    minX: descriptor.minX,
    maxX: descriptor.maxX,
    minY: descriptor.minY,
    maxY: descriptor.maxY,
    holeCenter: hole.center,
    holeRadiusMm: hole.radiusMm,
  };
}

export function describeRectangularPerforatedFace(section: SectionEvidence): RectangularPerforatedFaceDescriptor {
  if (section.status !== "verified" || !section.loops || !section.properties || !section.frame) {
    throw new Error("fastener face is not verified");
  }
  const circles = section.loops.flatMap((loop) => circularLoop(loop) ? [circularLoop(loop)!] : []);
  const rectangles = section.loops.flatMap((loop) => rectangleLoop(loop) ? [rectangleLoop(loop)!] : []);
  if (circles.length < 1 || rectangles.length !== 1 || section.loops.length !== circles.length + 1) {
    throw new Error("fastener face requires one axis-aligned rectangle and circular holes only");
  }
  return {
    ...rectangles[0]!,
    holes: circles.map((circle) => ({ center: circle.center, radiusMm: circle.radius })),
  };
}

function circularLoop(loop: SectionLoop): { center: [number, number]; radius: number } | null {
  if (loop.segments.length === 0 || loop.segments.some((segment) => segment.kind !== "arc")) return null;
  const arcs = loop.segments.filter((segment) => segment.kind === "arc");
  const first = arcs[0]!;
  if (arcs.some((arc) => !same(arc.radius, first.radius) || !same(arc.center[0], first.center[0]) || !same(arc.center[1], first.center[1]))) return null;
  const sweep = arcs.reduce((sum, arc) => sum + arc.sweepRadians, 0);
  if (!same(Math.abs(sweep), 2 * Math.PI, ANGULAR_TOLERANCE)) return null;
  return { center: [...first.center], radius: first.radius };
}

function rectangleLoop(loop: SectionLoop): Omit<FastenerFaceDescriptor, "holeCenter" | "holeRadiusMm"> | null {
  if (loop.segments.length !== 4 || loop.segments.some((segment) => segment.kind !== "line")) return null;
  const lines = loop.segments.filter((segment) => segment.kind === "line");
  const points = lines.flatMap((line) => [line.start, line.end]);
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  if (!(maxX - minX > LENGTH_TOLERANCE_MM && maxY - minY > LENGTH_TOLERANCE_MM)) return null;
  for (const line of lines) {
    const horizontal = same(line.start[1], line.end[1]) && (same(line.start[1], minY) || same(line.start[1], maxY));
    const vertical = same(line.start[0], line.end[0]) && (same(line.start[0], minX) || same(line.start[0], maxX));
    if (!horizontal && !vertical) return null;
  }
  const corners = [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]] as const;
  if (corners.some((corner) => !points.some((point) => same(point[0], corner[0]) && same(point[1], corner[1])))) return null;
  return { minX, maxX, minY, maxY };
}

function validateBodyTopology(body: RuntimeState["bodies"][number], request: FastenerPlateRequest): string[] {
  const reasons: string[] = [];
  if (body.type !== "Solid") reasons.push("non-solid");
  // A rectangular prism has 6 faces/12 unique edges. One through-hole adds one
  // cylindrical face and one circular edge on each opposed planar face.
  if (body.faceIds.length !== 7 || body.edgeIds.length !== 14) reasons.push("unsupported-body-topology");
  const front = body.faces.find((face) => face.id === request.frontFaceId);
  const back = body.faces.find((face) => face.id === request.backFaceId);
  if (!front) reasons.push("missing-front-face");
  else if (!front.planar) reasons.push("nonplanar-front-face");
  if (!back) reasons.push("missing-back-face");
  else if (!back.planar) reasons.push("nonplanar-back-face");
  const nonplanar = body.faces.filter((face) => !face.planar);
  if (nonplanar.length !== 1 || nonplanar[0]?.surfaceType !== "Cylinder" || !(nonplanar[0].radiusMm && nonplanar[0].radiusMm > 0)) {
    reasons.push("missing-single-cylindrical-hole-face");
  }
  return [...new Set(reasons)];
}

function localToWorld(section: SectionEvidence, point: [number, number]): Vector3 {
  const frame = section.frame!;
  const normal = normalize(frame.normal)!;
  const x = normalize(subtract(frame.xDirection, scale(normal, dot(frame.xDirection, normal))))!;
  const y = normalize(cross(normal, x))!;
  return add(frame.originMm, add(scale(x, point[0]), scale(y, point[1])));
}

function binding(sessionId: string, documentToken: string, request: FastenerPlateRequest, topologySignature: string): FastenerBinding {
  return {
    sessionId,
    documentToken,
    revision: request.revision,
    bodyId: request.bodyId,
    frontFaceId: request.frontFaceId,
    backFaceId: request.backFaceId,
    loadDirection: normalize(request.loadDirection) ?? [...request.loadDirection],
    topologySignature,
  };
}

function unsupported(bindingValue: FastenerBinding, reasons: string[]): FastenerPlateEvidence {
  return { status: "unsupported", binding: bindingValue, source: "native-brep-opposed-faces", reasons: [...new Set(reasons)] };
}

function same(left: number, right: number, tolerance = LENGTH_TOLERANCE_MM): boolean {
  return Math.abs(left - right) <= tolerance;
}

function normalize(value: Vector3): Vector3 | null {
  const length = Math.hypot(...value);
  return Number.isFinite(length) && length > ANGULAR_TOLERANCE ? scale(value, 1 / length) : null;
}

function add(left: Vector3, right: Vector3): Vector3 {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}

function subtract(left: Vector3, right: Vector3): Vector3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function scale(value: Vector3, factor: number): Vector3 {
  return [value[0] * factor, value[1] * factor, value[2] * factor];
}

function dot(left: Vector3, right: Vector3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function cross(left: Vector3, right: Vector3): Vector3 {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function midpoint(left: Vector3, right: Vector3): Vector3 {
  return scale(add(left, right), 0.5);
}
