import { createHash } from "node:crypto";

import type { Evidence } from "../strength/contracts.ts";
import type { FastenerGroupBinding } from "../strength/fastener-group-contracts.ts";
import {
  add,
  dot,
  frameFromOriginNormalX,
  normalize,
  scale,
  subtract,
  type PlaneFrame,
  type Vector3,
} from "./construction.ts";
import type { PlasticityRuntime } from "./runtime.ts";

export interface FastenerGroupGeometryRequest {
  bodyId: number;
  cylindricalFaceIds: string[];
  frame: {
    originMm: Vector3;
    normal: Vector3;
    xDirection: Vector3;
  };
  revision: string;
}

export type FastenerGroupGeometryBinding = FastenerGroupBinding;

export interface FastenerGroupGeometryEvidence {
  status: "verified" | "unsupported";
  binding: FastenerGroupGeometryBinding;
  frame?: PlaneFrame;
  fasteners?: Array<{
    id: string;
    faceId: string;
    centerMm: Vector3;
    xMm: number;
    yMm: number;
    diameterMm: number;
    axisDirection: Vector3;
  }>;
  evidence?: Evidence[];
  assignments?: Record<string, string>;
  loadDistributionGeometry?: {
    fasteners: Array<{ id: string; xMm: number; yMm: number }>;
    evidence: Evidence[];
    assignments: Record<string, string>;
    binding: FastenerGroupBinding;
  };
  source: "native-brep-cylindrical-faces";
  reasons: string[];
}

const ANGULAR_TOLERANCE = 1e-8;
const LENGTH_TOLERANCE_MM = 1e-5;

export async function inspectFastenerGroupGeometry(
  runtime: PlasticityRuntime,
  request: FastenerGroupGeometryRequest,
  sessionId: string,
): Promise<FastenerGroupGeometryEvidence> {
  if (!sessionId) throw new Error("MCP session ID is required");
  if (request.cylindricalFaceIds.length < 2) throw new Error("At least two cylindrical face IDs are required");
  if (new Set(request.cylindricalFaceIds).size !== request.cylindricalFaceIds.length) {
    throw new Error("Cylindrical face IDs must be unique");
  }
  const frame = frameFromOriginNormalX(request.frame.originMm, request.frame.normal, request.frame.xDirection);
  const before = await runtime.getState();
  const initialBinding = binding(sessionId, before.documentToken, request, frame, "unavailable");
  if (before.revision !== request.revision) return unsupported(initialBinding, ["stale-reference"]);
  const bodyMatches = before.bodies.filter((candidate) => candidate.id === request.bodyId);
  if (bodyMatches.length !== 1) return unsupported(initialBinding, [bodyMatches.length === 0 ? "unknown-body" : "duplicate-body"]);
  const body = bodyMatches[0]!;
  if (body.type !== "Solid") return unsupported(initialBinding, ["non-solid"]);

  const fasteners: NonNullable<FastenerGroupGeometryEvidence["fasteners"]> = [];
  for (const faceId of request.cylindricalFaceIds) {
    const matches = body.faces.filter((candidate) => candidate.id === faceId);
    if (matches.length !== 1) return unsupported(initialBinding, [`face-${faceId}-${matches.length === 0 ? "missing" : "ambiguous"}`]);
    const face = matches[0]!;
    if (face.surfaceType !== "Cylinder" || face.planar) {
      return unsupported(initialBinding, [`face-${faceId}-not-cylindrical`]);
    }
    if (face.radiusMm === null || !Number.isFinite(face.radiusMm) || face.radiusMm <= 0) {
      return unsupported(initialBinding, [`face-${faceId}-invalid-radius`]);
    }
    if (face.axisOriginMm === null || face.axisDirection === null) {
      return unsupported(initialBinding, [`face-${faceId}-missing-axis`]);
    }
    let axis: Vector3;
    try {
      axis = normalize(face.axisDirection, `Face ${faceId} axis`);
    } catch {
      return unsupported(initialBinding, [`face-${faceId}-invalid-axis`]);
    }
    const alignment = dot(axis, frame.normal);
    if (Math.abs(Math.abs(alignment) - 1) > ANGULAR_TOLERANCE) {
      return unsupported(initialBinding, [`face-${faceId}-axis-not-normal-to-frame`]);
    }
    const parameter = dot(subtract(frame.originMm, face.axisOriginMm), frame.normal) / alignment;
    const centerMm = add(face.axisOriginMm, scale(axis, parameter));
    const relative = subtract(centerMm, frame.originMm);
    const fastener = {
      id: faceId,
      faceId,
      centerMm,
      xMm: dot(relative, frame.xDirection),
      yMm: dot(relative, frame.yDirection),
      diameterMm: 2 * face.radiusMm,
      axisDirection: axis,
    };
    const duplicate = fasteners.find((candidate) =>
      Math.hypot(candidate.xMm - fastener.xMm, candidate.yMm - fastener.yMm) <= LENGTH_TOLERANCE_MM
    );
    if (duplicate) return unsupported(initialBinding, [`duplicate-projected-center:${duplicate.faceId}:${faceId}`]);
    fasteners.push(fastener);
  }

  const after = await runtime.getState();
  if (after.documentToken !== before.documentToken || after.revision !== before.revision) {
    return unsupported(initialBinding, ["stale-reference"]);
  }
  const topologySignature = createHash("sha256").update(JSON.stringify({
    bodyId: body.id,
    bodyVersionId: body.versionId,
    frame,
    faces: fasteners.map((fastener) => ({
      faceId: fastener.faceId,
      centerMm: fastener.centerMm,
      diameterMm: fastener.diameterMm,
      axisDirection: fastener.axisDirection,
    })),
  })).digest("hex");
  const evidence: Evidence[] = [];
  const assignments: Record<string, string> = {};
  for (const [index, fastener] of fasteners.entries()) {
    const locator = `document=${before.documentToken};revision=${before.revision};body=${body.id};face=${fastener.faceId}`;
    const xId = `fastener-${fastener.faceId}-x`;
    const yId = `fastener-${fastener.faceId}-y`;
    evidence.push(
      { id: xId, label: `${fastener.faceId} center X in group frame`, status: "measured", unit: "mm", value: fastener.xMm, sourceLocator: `${locator};field=axis-center-x`, dependsOn: [] },
      { id: yId, label: `${fastener.faceId} center Y in group frame`, status: "measured", unit: "mm", value: fastener.yMm, sourceLocator: `${locator};field=axis-center-y`, dependsOn: [] },
      { id: `fastener-${fastener.faceId}-diameter`, label: `${fastener.faceId} cylindrical face diameter`, status: "measured", unit: "mm", value: fastener.diameterMm, sourceLocator: `${locator};field=cylinder-radius`, dependsOn: [] },
    );
    assignments[`fasteners.${index}.xMm`] = xId;
    assignments[`fasteners.${index}.yMm`] = yId;
  }
  const verifiedBinding = binding(sessionId, before.documentToken, request, frame, topologySignature);
  return {
    status: "verified",
    binding: verifiedBinding,
    frame,
    fasteners,
    evidence,
    assignments,
    loadDistributionGeometry: {
      fasteners: fasteners.map(({ id, xMm, yMm }) => ({ id, xMm, yMm })),
      evidence,
      assignments,
      binding: verifiedBinding,
    },
    source: "native-brep-cylindrical-faces",
    reasons: [],
  };
}

function binding(
  sessionId: string,
  documentToken: string,
  request: FastenerGroupGeometryRequest,
  frame: PlaneFrame,
  topologySignature: string,
): FastenerGroupGeometryBinding {
  return {
    sessionId,
    documentToken,
    revision: request.revision,
    bodyId: request.bodyId,
    cylindricalFaceIds: [...request.cylindricalFaceIds],
    frame,
    topologySignature,
  };
}

function unsupported(bindingValue: FastenerGroupGeometryBinding, reasons: string[]): FastenerGroupGeometryEvidence {
  return {
    status: "unsupported",
    binding: bindingValue,
    source: "native-brep-cylindrical-faces",
    reasons: [...new Set(reasons)],
  };
}
