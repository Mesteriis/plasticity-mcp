import { randomUUID } from "node:crypto";

import type { FastenerGroupGeometryBinding, FastenerGroupGeometryEvidence } from "../plasticity/fastener-group-geometry.ts";
import type { FastenerGroupInput } from "./fastener-group-contracts.ts";
import type { CadBinding } from "./contracts.ts";

export function withMeasuredFastenerGroup(input: FastenerGroupInput, measured: FastenerGroupGeometryEvidence): FastenerGroupInput {
  if (measured.status !== "verified" || !measured.fasteners) throw new Error("Verified fastener-group geometry is required");
  const evidence = input.evidence.map((item) => ({ ...item, dependsOn: [...item.dependsOn] }));
  const assignments = Object.fromEntries(Object.entries(input.assignments).filter(([path]) => !path.startsWith("fasteners.")));
  const fasteners = measured.fasteners.map((fastener, index) => {
    const locator = `plasticity:${measured.binding.documentToken}#body=${measured.binding.bodyId}&face=${fastener.faceId}@${measured.binding.revision}`;
    const xId = `native-fastener-${index}-x-${randomUUID()}`;
    const yId = `native-fastener-${index}-y-${randomUUID()}`;
    evidence.push(
      { id: xId, label: `Exact native B-rep ${fastener.faceId} axis-center X`, status: "measured", unit: "mm", value: fastener.xMm, sourceLocator: locator, dependsOn: [] },
      { id: yId, label: `Exact native B-rep ${fastener.faceId} axis-center Y`, status: "measured", unit: "mm", value: fastener.yMm, sourceLocator: locator, dependsOn: [] },
    );
    assignments[`fasteners.${index}.xMm`] = xId;
    assignments[`fasteners.${index}.yMm`] = yId;
    return { id: fastener.id, xMm: fastener.xMm, yMm: fastener.yMm };
  });
  return {
    ...structuredClone(input),
    fasteners,
    binding: structuredClone(measured.binding),
    evidence,
    assignments,
  };
}

export function assertSameFastenerGroupBinding(expected: FastenerGroupGeometryBinding, current: FastenerGroupGeometryBinding, message: string): void {
  const reasons = new Set<string>();
  addFastenerGroupBindingReasons(expected, current, reasons);
  if (reasons.size > 0) throw new Error(`${message}: ${[...reasons].join(", ")}`);
}

export function addFastenerGroupBindingReasons(expected: FastenerGroupGeometryBinding, current: FastenerGroupGeometryBinding, reasons: Set<string>): void {
  addBindingReasons(expected, current, reasons);
  if (expected.cylindricalFaceIds.length !== current.cylindricalFaceIds.length || expected.cylindricalFaceIds.some((value, index) => value !== current.cylindricalFaceIds[index])) {
    reasons.add("CAD_FACE_CHANGED");
  }
  if (expected.topologySignature !== current.topologySignature) reasons.add("CAD_TOPOLOGY_CHANGED");
  for (const key of ["originMm", "normal", "xDirection", "yDirection"] as const) {
    if (expected.frame[key].some((value, index) => value !== current.frame[key][index])) reasons.add("CAD_FRAME_CHANGED");
  }
}

function addBindingReasons(expected: CadBinding, current: CadBinding, reasons: Set<string>): void {
  if (expected.sessionId !== current.sessionId) reasons.add("CAD_SESSION_CHANGED");
  if (expected.documentToken !== current.documentToken) reasons.add("CAD_DOCUMENT_CHANGED");
  if (expected.revision !== current.revision) reasons.add("CAD_REVISION_CHANGED");
  if (expected.bodyId !== current.bodyId) reasons.add("CAD_BODY_CHANGED");
}
