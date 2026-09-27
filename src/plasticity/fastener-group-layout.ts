import { createHash } from "node:crypto";

import { describeRectangularPerforatedFace } from "./fastener-geometry.ts";
import {
  inspectFastenerGroupGeometry,
  type FastenerGroupGeometryRequest,
} from "./fastener-group-geometry.ts";
import type { PlasticityRuntime } from "./runtime.ts";
import { inspectPlanarSection } from "./section-geometry.ts";

type Vector3 = [number, number, number];

export interface FastenerGroupLayoutEnvelopeRequirement {
  id: string;
  diameterMm: number;
  minimumBoundaryClearanceMm: number;
  minimumMutualClearanceMm: number;
}

export interface FastenerGroupLayoutRequirements {
  basis: string;
  minimumCenterToEdgeMm?: number | undefined;
  minimumHoleEdgeClearanceMm?: number | undefined;
  minimumCenterSpacingMm?: number | undefined;
  minimumHoleLigamentMm?: number | undefined;
  envelopes?: FastenerGroupLayoutEnvelopeRequirement[] | undefined;
}

export interface FastenerGroupLayoutRequest extends FastenerGroupGeometryRequest {
  boundaryFaceId: string;
  opposedFaceId?: string | undefined;
  requirements?: FastenerGroupLayoutRequirements | undefined;
}

export interface FastenerGroupLayoutBinding {
  sessionId: string;
  documentToken: string;
  revision: string;
  bodyId: number;
  boundaryFaceId: string;
  opposedFaceId?: string | undefined;
  cylindricalFaceIds: string[];
  groupTopologySignature: string;
  frame: {
    originMm: Vector3;
    normal: Vector3;
    xDirection: Vector3;
    yDirection: Vector3;
  };
  topologySignature: string;
}

interface LayoutFailure {
  code: "MINIMUM_CENTER_TO_EDGE" | "MINIMUM_HOLE_EDGE_CLEARANCE" | "MINIMUM_CENTER_SPACING" | "MINIMUM_HOLE_LIGAMENT" | "ENVELOPE_BOUNDARY_CLEARANCE" | "ENVELOPE_MUTUAL_CLEARANCE";
  subjectIds: string[];
  actualMm: number;
  requiredMm: number;
  marginMm: number;
}

export interface FastenerGroupLayoutEvidence {
  status: "verified" | "unsupported";
  binding: FastenerGroupLayoutBinding;
  measurementSource: "native-brep-boundary-and-cylindrical-faces" | "native-brep-opposed-boundaries-and-cylindrical-faces";
  plate?: {
    boundaryFaceId: string;
    opposedFaceId?: string | undefined;
    frame: {
      originMm: Vector3;
      normal: Vector3;
      xDirection: Vector3;
      yDirection: Vector3;
    };
    boundsMm: { minX: number; maxX: number; minY: number; maxY: number };
    sizeMm: { x: number; y: number };
    thicknessMm?: number | undefined;
  };
  fasteners?: Array<{
    id: string;
    faceId: string;
    centerMm: Vector3;
    localCenterMm: { x: number; y: number };
    holeDiameterMm: number;
    centerToEdgesMm: { minX: number; maxX: number; minY: number; maxY: number };
    holeEdgeClearancesMm: { minX: number; maxX: number; minY: number; maxY: number };
    minimumCenterToEdgeMm: number;
    minimumHoleEdgeClearanceMm: number;
  }>;
  pairs?: Array<{
    firstId: string;
    secondId: string;
    centerSpacingMm: number;
    holeLigamentMm: number;
  }>;
  envelopes?: Array<{
    id: string;
    diameterMm: number;
    minimumBoundaryClearanceMm: number;
    minimumMutualClearanceMm: number;
    fasteners: Array<{ fastenerId: string; boundaryClearanceMm: number }>;
    pairs: Array<{ firstId: string; secondId: string; mutualClearanceMm: number }>;
  }>;
  evaluation?: {
    status: "measured" | "pass" | "fail";
    basis?: string;
    failures: LayoutFailure[];
  };
  checkedScope?: string;
  reasons: string[];
}

const LENGTH_TOLERANCE_MM = 1e-5;

export async function inspectFastenerGroupLayout(
  runtime: PlasticityRuntime,
  request: FastenerGroupLayoutRequest,
  sessionId: string,
): Promise<FastenerGroupLayoutEvidence> {
  validateRequest(request);
  const group = await inspectFastenerGroupGeometry(runtime, request, sessionId);
  const initialBinding = layoutBinding(group.binding, request.boundaryFaceId, request.opposedFaceId, "unavailable");
  if (group.status !== "verified" || !group.frame || !group.fasteners) {
    return unsupported(initialBinding, group.reasons);
  }
  const section = await inspectPlanarSection(runtime, {
    bodyId: request.bodyId,
    faceId: request.boundaryFaceId,
    revision: request.revision,
    xDirection: group.frame.xDirection,
  }, sessionId);
  if (section.status !== "verified" || !section.frame || !section.loops || !section.properties) {
    return unsupported(initialBinding, section.reasons.map((reason) => `boundary:${reason}`));
  }
  if (section.binding.documentToken !== group.binding.documentToken || section.binding.revision !== group.binding.revision) {
    return unsupported(initialBinding, ["stale-reference"]);
  }

  let descriptor: ReturnType<typeof describeRectangularPerforatedFace>;
  try {
    descriptor = describeRectangularPerforatedFace(section);
  } catch (error) {
    return unsupported(initialBinding, [error instanceof Error ? error.message : "unsupported-boundary-profile"]);
  }
  if (descriptor.holes.length !== group.fasteners.length) {
    return unsupported(initialBinding, ["boundary-hole-count-does-not-match-selected-fasteners"]);
  }
  const sectionNormal = normalize(section.frame.normal);
  const sectionX = normalize(section.frame.xDirection);
  if (!sectionNormal || !sectionX) return unsupported(initialBinding, ["invalid-boundary-frame"]);
  const sectionY = normalize(cross(sectionNormal, sectionX));
  if (!sectionY) return unsupported(initialBinding, ["invalid-boundary-frame"]);

  let thicknessMm: number | undefined;
  let opposed: Awaited<ReturnType<typeof inspectPlanarSection>> | undefined;
  if (request.opposedFaceId !== undefined) {
    if (request.opposedFaceId.trim().length === 0 || request.opposedFaceId === request.boundaryFaceId) {
      return unsupported(initialBinding, ["opposed-face-must-be-distinct"]);
    }
    opposed = await inspectPlanarSection(runtime, {
      bodyId: request.bodyId,
      faceId: request.opposedFaceId,
      revision: request.revision,
      xDirection: group.frame.xDirection,
    }, sessionId);
    if (opposed.status !== "verified" || !opposed.frame || !opposed.loops) {
      return unsupported(initialBinding, (opposed.reasons.length ? opposed.reasons : ["missing-opposed-face-evidence"]).map((reason) => `opposed:${reason}`));
    }
    if (opposed.binding.documentToken !== group.binding.documentToken || opposed.binding.revision !== group.binding.revision) {
      return unsupported(initialBinding, ["stale-reference"]);
    }
    let opposedDescriptor: ReturnType<typeof describeRectangularPerforatedFace>;
    try {
      opposedDescriptor = describeRectangularPerforatedFace(opposed);
    } catch (error) {
      return unsupported(initialBinding, [`opposed:${error instanceof Error ? error.message : "invalid-profile"}`]);
    }
    const opposedNormal = normalize(opposed.frame.normal);
    if (!opposedNormal || dot(opposedNormal, sectionNormal) > -1 + 1e-8) {
      return unsupported(initialBinding, ["selected-faces-not-opposed"]);
    }
    const sizeX = descriptor.maxX - descriptor.minX;
    const sizeY = descriptor.maxY - descriptor.minY;
    if (Math.abs(sizeX - (opposedDescriptor.maxX - opposedDescriptor.minX)) > LENGTH_TOLERANCE_MM
        || Math.abs(sizeY - (opposedDescriptor.maxY - opposedDescriptor.minY)) > LENGTH_TOLERANCE_MM
        || descriptor.holes.length !== opposedDescriptor.holes.length) {
      return unsupported(initialBinding, ["opposed-face-profiles-differ"]);
    }
    const frontCenter = pointOnSection(section, [(descriptor.minX + descriptor.maxX) / 2, (descriptor.minY + descriptor.maxY) / 2]);
    const backCenter = pointOnSection(opposed, [(opposedDescriptor.minX + opposedDescriptor.maxX) / 2, (opposedDescriptor.minY + opposedDescriptor.maxY) / 2]);
    const centerDelta = subtract(backCenter, frontCenter);
    const signedThickness = dot(centerDelta, sectionNormal);
    const tangentialDelta = subtract(centerDelta, scale(sectionNormal, signedThickness));
    if (Math.hypot(...tangentialDelta) > LENGTH_TOLERANCE_MM) {
      return unsupported(initialBinding, ["opposed-face-outlines-not-aligned"]);
    }
    if (!(Math.abs(signedThickness) > LENGTH_TOLERANCE_MM)) {
      return unsupported(initialBinding, ["invalid-plate-thickness"]);
    }
    const unmatchedBackHoles = new Set(opposedDescriptor.holes.map((_hole, index) => index));
    for (const frontHole of descriptor.holes) {
      const frontWorld = pointOnSection(section, frontHole.center);
      const world = subtract(frontWorld, scale(sectionNormal, -signedThickness));
      const relative = subtract(world, opposed.frame.originMm);
      if (Math.abs(dot(relative, opposedNormal)) > LENGTH_TOLERANCE_MM) {
        return unsupported(initialBinding, ["opposed-hole-axes-do-not-cross-back-face"]);
      }
      const opposedY = normalize(cross(opposedNormal, normalize(opposed.frame.xDirection)!));
      if (!opposedY) return unsupported(initialBinding, ["invalid-opposed-face-frame"]);
      const local = [dot(relative, opposed.frame.xDirection), dot(relative, opposedY)] as const;
      const match = opposedDescriptor.holes.findIndex((hole, index) => unmatchedBackHoles.has(index)
        && Math.hypot(hole.center[0] - local[0], hole.center[1] - local[1]) <= LENGTH_TOLERANCE_MM
        && Math.abs(hole.radiusMm - frontHole.radiusMm) <= LENGTH_TOLERANCE_MM);
      if (match < 0) return unsupported(initialBinding, ["opposed-face-hole-profiles-differ"]);
      unmatchedBackHoles.delete(match);
    }
    thicknessMm = Math.abs(signedThickness);
  }

  const matchedHoleIndexes = new Set<number>();
  const fasteners: NonNullable<FastenerGroupLayoutEvidence["fasteners"]> = [];
  for (const fastener of group.fasteners) {
    const relative = subtract(fastener.centerMm, section.frame.originMm);
    if (Math.abs(dot(relative, sectionNormal)) > LENGTH_TOLERANCE_MM) {
      return unsupported(initialBinding, [`fastener-${fastener.faceId}-axis-does-not-intersect-boundary-face`]);
    }
    const localCenterMm = { x: dot(relative, sectionX), y: dot(relative, sectionY) };
    const matchIndex = descriptor.holes.findIndex((hole, index) =>
      !matchedHoleIndexes.has(index)
      && Math.hypot(hole.center[0] - localCenterMm.x, hole.center[1] - localCenterMm.y) <= LENGTH_TOLERANCE_MM
      && Math.abs(2 * hole.radiusMm - fastener.diameterMm) <= LENGTH_TOLERANCE_MM
    );
    if (matchIndex < 0) return unsupported(initialBinding, [`fastener-${fastener.faceId}-does-not-match-boundary-hole`]);
    matchedHoleIndexes.add(matchIndex);
    const radius = fastener.diameterMm / 2;
    const centerToEdgesMm = {
      minX: localCenterMm.x - descriptor.minX,
      maxX: descriptor.maxX - localCenterMm.x,
      minY: localCenterMm.y - descriptor.minY,
      maxY: descriptor.maxY - localCenterMm.y,
    };
    const holeEdgeClearancesMm = mapEdges(centerToEdgesMm, (value) => value - radius);
    fasteners.push({
      id: fastener.id,
      faceId: fastener.faceId,
      centerMm: fastener.centerMm,
      localCenterMm,
      holeDiameterMm: fastener.diameterMm,
      centerToEdgesMm,
      holeEdgeClearancesMm,
      minimumCenterToEdgeMm: minimumEdge(centerToEdgesMm),
      minimumHoleEdgeClearanceMm: minimumEdge(holeEdgeClearancesMm),
    });
  }

  const pairs: NonNullable<FastenerGroupLayoutEvidence["pairs"]> = [];
  for (let first = 0; first < fasteners.length; first += 1) {
    for (let second = first + 1; second < fasteners.length; second += 1) {
      const left = fasteners[first]!;
      const right = fasteners[second]!;
      const centerSpacingMm = Math.hypot(
        left.localCenterMm.x - right.localCenterMm.x,
        left.localCenterMm.y - right.localCenterMm.y,
      );
      pairs.push({
        firstId: left.id,
        secondId: right.id,
        centerSpacingMm,
        holeLigamentMm: centerSpacingMm - (left.holeDiameterMm + right.holeDiameterMm) / 2,
      });
    }
  }

  const envelopes = (request.requirements?.envelopes ?? []).map((requirement) => {
    const radius = requirement.diameterMm / 2;
    const envelopeFasteners = fasteners.map((fastener) => ({
      fastenerId: fastener.id,
      boundaryClearanceMm: fastener.minimumCenterToEdgeMm - radius,
    }));
    const envelopePairs = pairs.map((pair) => ({
      firstId: pair.firstId,
      secondId: pair.secondId,
      mutualClearanceMm: pair.centerSpacingMm - requirement.diameterMm,
    }));
    return {
      id: requirement.id,
      diameterMm: requirement.diameterMm,
      minimumBoundaryClearanceMm: Math.min(...envelopeFasteners.map((item) => item.boundaryClearanceMm)),
      minimumMutualClearanceMm: Math.min(...envelopePairs.map((item) => item.mutualClearanceMm)),
      fasteners: envelopeFasteners,
      pairs: envelopePairs,
    };
  });
  const failures = evaluate(request.requirements, fasteners, pairs, envelopes);
  const topologySignature = createHash("sha256").update(JSON.stringify({
    group: group.binding.topologySignature,
    boundary: section.binding.topologySignature,
    opposed: opposed?.binding.topologySignature,
    thicknessMm,
    matchedHoles: fasteners.map((fastener) => ({ id: fastener.id, localCenterMm: fastener.localCenterMm, holeDiameterMm: fastener.holeDiameterMm })),
  })).digest("hex");
  const binding = layoutBinding(group.binding, request.boundaryFaceId, request.opposedFaceId, topologySignature);
  const frame = { ...section.frame, yDirection: sectionY };
  return {
    status: "verified",
    binding,
    measurementSource: thicknessMm === undefined
      ? "native-brep-boundary-and-cylindrical-faces"
      : "native-brep-opposed-boundaries-and-cylindrical-faces",
    plate: {
      boundaryFaceId: request.boundaryFaceId,
      ...(request.opposedFaceId === undefined ? {} : { opposedFaceId: request.opposedFaceId }),
      frame,
      boundsMm: { minX: descriptor.minX, maxX: descriptor.maxX, minY: descriptor.minY, maxY: descriptor.maxY },
      sizeMm: { x: descriptor.maxX - descriptor.minX, y: descriptor.maxY - descriptor.minY },
      ...(thicknessMm === undefined ? {} : { thicknessMm }),
    },
    fasteners,
    pairs,
    envelopes,
    evaluation: {
      status: request.requirements === undefined ? "measured" : failures.length === 0 ? "pass" : "fail",
      ...(request.requirements === undefined ? {} : { basis: request.requirements.basis }),
      failures,
    },
    checkedScope: "Exact rectangular-face fastener layout only: hole placement, edge distance, pitch, ligament, and supplied circular mounting envelopes. This is not a strength, preload, thread, bearing, pullout, fatigue, or tool-motion check.",
    reasons: [],
  };
}

function evaluate(
  requirements: FastenerGroupLayoutRequirements | undefined,
  fasteners: NonNullable<FastenerGroupLayoutEvidence["fasteners"]>,
  pairs: NonNullable<FastenerGroupLayoutEvidence["pairs"]>,
  envelopes: NonNullable<FastenerGroupLayoutEvidence["envelopes"]>,
): LayoutFailure[] {
  if (!requirements) return [];
  const failures: LayoutFailure[] = [];
  const check = (code: LayoutFailure["code"], subjectIds: string[], actualMm: number, requiredMm: number) => {
    if (actualMm + LENGTH_TOLERANCE_MM < requiredMm) failures.push({ code, subjectIds, actualMm, requiredMm, marginMm: actualMm - requiredMm });
  };
  for (const fastener of fasteners) {
    if (requirements.minimumCenterToEdgeMm !== undefined) check("MINIMUM_CENTER_TO_EDGE", [fastener.id], fastener.minimumCenterToEdgeMm, requirements.minimumCenterToEdgeMm);
    if (requirements.minimumHoleEdgeClearanceMm !== undefined) check("MINIMUM_HOLE_EDGE_CLEARANCE", [fastener.id], fastener.minimumHoleEdgeClearanceMm, requirements.minimumHoleEdgeClearanceMm);
  }
  for (const pair of pairs) {
    if (requirements.minimumCenterSpacingMm !== undefined) check("MINIMUM_CENTER_SPACING", [pair.firstId, pair.secondId], pair.centerSpacingMm, requirements.minimumCenterSpacingMm);
    if (requirements.minimumHoleLigamentMm !== undefined) check("MINIMUM_HOLE_LIGAMENT", [pair.firstId, pair.secondId], pair.holeLigamentMm, requirements.minimumHoleLigamentMm);
  }
  for (const envelope of envelopes) {
    const requirement = requirements.envelopes!.find((candidate) => candidate.id === envelope.id)!;
    for (const fastener of envelope.fasteners) check("ENVELOPE_BOUNDARY_CLEARANCE", [envelope.id, fastener.fastenerId], fastener.boundaryClearanceMm, requirement.minimumBoundaryClearanceMm);
    for (const pair of envelope.pairs) check("ENVELOPE_MUTUAL_CLEARANCE", [envelope.id, pair.firstId, pair.secondId], pair.mutualClearanceMm, requirement.minimumMutualClearanceMm);
  }
  return failures;
}

function validateRequest(request: FastenerGroupLayoutRequest): void {
  if (!request.boundaryFaceId.trim()) throw new Error("Boundary face ID is required");
  const requirements = request.requirements;
  if (!requirements) return;
  if (!requirements.basis.trim()) throw new Error("Fastener layout requirements require a basis");
  const optionalValues = [requirements.minimumCenterToEdgeMm, requirements.minimumHoleEdgeClearanceMm, requirements.minimumCenterSpacingMm, requirements.minimumHoleLigamentMm];
  if (optionalValues.every((value) => value === undefined) && (requirements.envelopes?.length ?? 0) === 0) {
    throw new Error("At least one fastener layout requirement is required");
  }
  for (const value of optionalValues) if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error("Fastener layout requirements must be finite and nonnegative");
  const ids = new Set<string>();
  for (const envelope of requirements.envelopes ?? []) {
    if (!envelope.id.trim() || ids.has(envelope.id)) throw new Error("Fastener layout envelope IDs must be nonempty and unique");
    ids.add(envelope.id);
    if (!Number.isFinite(envelope.diameterMm) || envelope.diameterMm <= 0) throw new Error("Fastener layout envelope diameter must be positive");
    if (![envelope.minimumBoundaryClearanceMm, envelope.minimumMutualClearanceMm].every((value) => Number.isFinite(value) && value >= 0)) {
      throw new Error("Fastener layout envelope clearances must be finite and nonnegative");
    }
  }
}

function layoutBinding(
  group: { sessionId: string; documentToken: string; revision: string; bodyId: number; cylindricalFaceIds: string[]; frame: FastenerGroupLayoutBinding["frame"]; topologySignature: string },
  boundaryFaceId: string,
  opposedFaceId: string | undefined,
  topologySignature: string,
): FastenerGroupLayoutBinding {
  return {
    ...group,
    boundaryFaceId,
    ...(opposedFaceId === undefined ? {} : { opposedFaceId }),
    cylindricalFaceIds: [...group.cylindricalFaceIds],
    groupTopologySignature: group.topologySignature,
    topologySignature,
  };
}

function pointOnSection(section: { frame?: { originMm: Vector3; normal: Vector3; xDirection: Vector3 } }, local: [number, number]): Vector3 {
  if (!section.frame) throw new Error("Section frame is required");
  const normal = normalize(section.frame.normal);
  const xDirection = normalize(section.frame.xDirection);
  if (!normal || !xDirection) throw new Error("Section frame directions must be nonzero");
  const yDirection = normalize(cross(normal, xDirection));
  if (!yDirection) throw new Error("Section frame directions must not be parallel");
  return [0, 1, 2].map((axis) => section.frame!.originMm[axis]!
    + xDirection[axis]! * local[0]
    + yDirection[axis]! * local[1]) as Vector3;
}

function unsupported(binding: FastenerGroupLayoutBinding, reasons: string[]): FastenerGroupLayoutEvidence {
  return {
    status: "unsupported",
    binding,
    measurementSource: "native-brep-boundary-and-cylindrical-faces",
    reasons: [...new Set(reasons)],
  };
}

function mapEdges<T extends { minX: number; maxX: number; minY: number; maxY: number }>(edges: T, map: (value: number) => number): T {
  return { minX: map(edges.minX), maxX: map(edges.maxX), minY: map(edges.minY), maxY: map(edges.maxY) } as T;
}

function minimumEdge(edges: { minX: number; maxX: number; minY: number; maxY: number }): number {
  return Math.min(edges.minX, edges.maxX, edges.minY, edges.maxY);
}

function subtract(left: Vector3, right: Vector3): Vector3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function scale(vector: Vector3, amount: number): Vector3 {
  return [vector[0] * amount, vector[1] * amount, vector[2] * amount];
}

function dot(left: Vector3, right: Vector3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function cross(left: Vector3, right: Vector3): Vector3 {
  return [left[1] * right[2] - left[2] * right[1], left[2] * right[0] - left[0] * right[2], left[0] * right[1] - left[1] * right[0]];
}

function normalize(value: Vector3): Vector3 | null {
  const magnitude = Math.hypot(...value);
  return Number.isFinite(magnitude) && magnitude > 0 ? [value[0] / magnitude, value[1] / magnitude, value[2] / magnitude] : null;
}
