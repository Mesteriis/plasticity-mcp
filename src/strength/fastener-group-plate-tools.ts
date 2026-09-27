import { z } from "zod";

import type { FastenerGroupGeometryBinding, FastenerGroupGeometryEvidence, FastenerGroupGeometryRequest } from "../plasticity/fastener-group-geometry.ts";
import type { FastenerGroupLayoutEvidence, FastenerGroupLayoutRequest } from "../plasticity/fastener-group-layout.ts";
import { calculateFastenerGroupPlateBearing, hashFastenerGroupPlateBearingBinding, type FastenerGroupPlateBearingInput, type FastenerGroupTestGeometryMatch } from "./fastener-group-plate-calculate.ts";
import { fastenerGroupPlateBearingInputSchema } from "./fastener-group-plate-schemas.ts";
import { sameMaterialCouponProcess } from "./material-qualification.ts";
import type { FastenerGroupTestRecord } from "./fastener-group-test.ts";
import { addFastenerGroupBindingReasons, assertSameFastenerGroupBinding, withMeasuredFastenerGroup } from "./fastener-group-mcp-support.ts";
import type { StrengthStore, StoredFastenerGroupPlateBearingReport } from "./store.ts";

interface StrengthToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
}

interface StrengthToolExtra {
  signal: AbortSignal;
}

type StrengthTool = <T extends z.ZodType>(
  name: string,
  description: string,
  schema: T,
  annotations: StrengthToolAnnotations,
  handler: (input: z.output<T>, extra: StrengthToolExtra) => Promise<unknown>,
) => void;

export interface FastenerGroupPlateStrengthDependencies {
  inspectFastenerGroup(request: FastenerGroupGeometryRequest): Promise<FastenerGroupGeometryEvidence>;
  inspectFastenerGroupLayout(request: FastenerGroupLayoutRequest): Promise<FastenerGroupLayoutEvidence>;
  readFastenerGroupBinding(request: Omit<FastenerGroupGeometryRequest, "revision">): Promise<FastenerGroupGeometryBinding>;
  store: Pick<StrengthStore, "saveFastenerGroupPlateBearingReport" | "readReport" | "fastenerGroupTests">;
}

export function registerFastenerGroupPlateBearingTool(
  tool: StrengthTool,
  deps: FastenerGroupPlateStrengthDependencies,
  readonly: StrengthToolAnnotations,
): void {
  tool(
    "plasticity_verify_fastener_group_plate_bearing",
    "Re-read the exact front and opposed native B-rep faces and cylindrical hole faces of one rectangular multi-hole plate, compare each fastener's elastic in-plane demand with a traceable factored bearing allowable, and optionally check straight transverse net tension or local two-plane edge shear-out. A physical-test benchmark requires an immutable record ID, exact print process, an evidence-backed dimensional equivalence tolerance, and explicit confirmation that process and fixture/load path match. Net tension uses an explicitly supplied external tensile resultant along local X or Y and the minimum straight cut across measured circular holes. Local edge shear-out uses each fastener's elastic resultant only when it aligns with a local rectangle axis; diagonal demands and e/d below 1.5 are unsupported. Supply separate traceable factored tensile and shear allowables and confirm the method assumptions. Angled/staggered fracture paths, compression, shared-ligament interaction, bypass and the complete joint remain unchecked; no overall pass is returned.",
    fastenerGroupPlateBearingInputSchema,
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async (raw) => {
      const input = raw as FastenerGroupPlateBearingInput;
      const binding = input.group.binding;
      if (!binding) throw new Error("Fastener-group plate bearing verification requires a revision-bound native group");
      const groupRequest: FastenerGroupGeometryRequest = {
        bodyId: binding.bodyId,
        cylindricalFaceIds: [...binding.cylindricalFaceIds],
        frame: { originMm: binding.frame.originMm, normal: binding.frame.normal, xDirection: binding.frame.xDirection },
        revision: binding.revision,
      };
      const measured = await deps.inspectFastenerGroup(groupRequest);
      if (measured.status !== "verified" || !measured.fasteners) {
        throw new Error(`Fastener-group geometry is unsupported: ${measured.reasons.join(", ") || "unknown reason"}`);
      }
      assertSameFastenerGroupBinding(binding, measured.binding, "Input fastener-group binding is stale");
      const group = withMeasuredFastenerGroup(input.group, measured);
      const layoutRequest: FastenerGroupLayoutRequest = {
        ...groupRequest,
        boundaryFaceId: input.plate.boundaryFaceId,
        opposedFaceId: input.plate.opposedFaceId,
      };
      const geometry = await deps.inspectFastenerGroupLayout(layoutRequest);
      if (geometry.status !== "verified" || !geometry.plate?.thicknessMm || !geometry.fasteners) {
        throw new Error(`Fastener-group plate geometry is unsupported: ${geometry.reasons.join(", ") || "exact thickness unavailable"}`);
      }
      let physicalTestRecord: FastenerGroupTestRecord | undefined;
      let physicalTestGeometryMatch: FastenerGroupTestGeometryMatch | undefined;
      if (input.physicalTest) {
        const selectedRecord = await deps.store.fastenerGroupTests.read(input.physicalTest.recordId);
        physicalTestRecord = selectedRecord;
        if (!sameMaterialCouponProcess(selectedRecord.process, input.physicalTest.process)) {
          throw new Error("Selected physical test record does not match the explicitly selected print process");
        }
        const testMatch = await deps.store.fastenerGroupTests.match({
          process: selectedRecord.process,
          geometry: selectedRecord.geometry,
          fixture: selectedRecord.fixture,
        });
        if (testMatch.status !== "matched" || !testMatch.records.some((record) => record.id === selectedRecord.id)) {
          throw new Error("Physical test configuration is ambiguous in the immutable registry; resolve conflicting records before comparison");
        }
        physicalTestGeometryMatch = assertPhysicalTestGeometryWithinTolerance(selectedRecord.geometry, geometry, input.physicalTest.geometryToleranceMm);
      }
      const result = calculateFastenerGroupPlateBearing({ ...input, group }, geometry, physicalTestRecord, physicalTestGeometryMatch);
      const after = await deps.readFastenerGroupBinding({
        bodyId: binding.bodyId,
        cylindricalFaceIds: binding.cylindricalFaceIds,
        frame: { originMm: binding.frame.originMm, normal: binding.frame.normal, xDirection: binding.frame.xDirection },
      });
      assertSameFastenerGroupBinding(measured.binding, after, "Plasticity document changed during fastener-group plate bearing verification");
      return await deps.store.saveFastenerGroupPlateBearingReport({ ...input, group }, result);
    },
  );

  tool(
    "plasticity_fastener_group_plate_bearing_report",
    "Read an immutable multi-hole local-bearing, optional straight-cut net-tension and edge shear-out report and re-check its group and exact native plate geometry binding against the live Plasticity document.",
    z.object({ reportId: z.string().uuid(), current: fastenerGroupPlateBearingInputSchema.optional() }).strict(),
    readonly,
    async ({ reportId, current }) => {
      const candidate = await deps.store.readReport(reportId);
      if (!("kind" in candidate) || candidate.kind !== "fastener-group-plate-bearing") throw new Error("Report ID is not a fastener-group plate bearing report");
      const report: StoredFastenerGroupPlateBearingReport = candidate;
      const expectedGeometry = report.result.geometryBinding;
      const groupBinding = report.input.group.binding;
      if (!expectedGeometry || !groupBinding) return { report, freshness: "unverified", reasons: ["CAD_BINDING_INVALID"] };
      const reasons = new Set<string>();
      if (report.input.physicalTest) {
        try {
          await deps.store.fastenerGroupTests.read(report.input.physicalTest.recordId);
        } catch {
          reasons.add("PHYSICAL_TEST_RECORD_UNAVAILABLE");
        }
      }
      if (current === undefined) reasons.add("NO_CURRENT_INPUT");
      else if (hashFastenerGroupPlateBearingBinding(current as FastenerGroupPlateBearingInput, expectedGeometry) !== report.result.inputHash) reasons.add("TASK_OR_MATERIAL_CHANGED");
      try {
        const currentGroup = await deps.readFastenerGroupBinding({
          bodyId: groupBinding.bodyId,
          cylindricalFaceIds: groupBinding.cylindricalFaceIds,
          frame: { originMm: groupBinding.frame.originMm, normal: groupBinding.frame.normal, xDirection: groupBinding.frame.xDirection },
        });
        addFastenerGroupBindingReasons(groupBinding, currentGroup, reasons);
        if (expectedGeometry.sessionId !== currentGroup.sessionId) reasons.add("CAD_SESSION_CHANGED");
        if (expectedGeometry.documentToken !== currentGroup.documentToken) reasons.add("CAD_DOCUMENT_CHANGED");
        if (expectedGeometry.revision !== currentGroup.revision) reasons.add("CAD_REVISION_CHANGED");
        if (reasons.size === 0) {
          const currentLayout = await deps.inspectFastenerGroupLayout({
            bodyId: groupBinding.bodyId,
            cylindricalFaceIds: [...groupBinding.cylindricalFaceIds],
            frame: { originMm: groupBinding.frame.originMm, normal: groupBinding.frame.normal, xDirection: groupBinding.frame.xDirection },
            boundaryFaceId: expectedGeometry.boundaryFaceId,
            opposedFaceId: expectedGeometry.opposedFaceId,
            revision: currentGroup.revision,
          });
          if (currentLayout.status !== "verified" || !currentLayout.binding) {
            if (currentLayout.reasons.length === 0) reasons.add("CAD_PLATE_TOPOLOGY_UNAVAILABLE");
            for (const reason of currentLayout.reasons) reasons.add(reason);
          }
          else if (currentLayout.binding.topologySignature !== expectedGeometry.topologySignature) reasons.add("CAD_PLATE_TOPOLOGY_CHANGED");
        }
        const stale = [...reasons].some((reason) => reason.startsWith("CAD_")
          || reason === "TASK_OR_MATERIAL_CHANGED" || reason === "PHYSICAL_TEST_RECORD_UNAVAILABLE");
        return { report, freshness: stale ? "stale" : current === undefined ? "unverified" : "current", reasons: [...reasons] };
      } catch {
        return { report, freshness: "unverified", reasons: ["CAD_SESSION_UNAVAILABLE"] };
      }
    },
  );
}

function assertPhysicalTestGeometryWithinTolerance(
  test: { widthMm: number; heightMm: number; thicknessMm: number; holes: Array<{ xMm: number; yMm: number; diameterMm: number }> },
  live: FastenerGroupLayoutEvidence,
  toleranceMm: number,
): FastenerGroupTestGeometryMatch {
  if (!live.plate || !live.fasteners) throw new Error("Exact native plate geometry is required for physical test comparison");
  const dimensions = [
    ["width", live.plate.sizeMm.x, test.widthMm],
    ["height", live.plate.sizeMm.y, test.heightMm],
    ["thickness", live.plate.thicknessMm, test.thicknessMm],
  ] as const;
  const mismatch = dimensions.find(([, actual, expected]) => actual === undefined || Math.abs(actual - expected) > toleranceMm);
  if (mismatch) throw new Error(`Physical test plate ${mismatch[0]} differs from the live CAD plate by more than the evidence-backed ${toleranceMm} mm tolerance`);
  if (test.holes.length !== live.fasteners.length) throw new Error("Physical test and live CAD plate have different hole counts");
  const remaining = [...test.holes];
  let maximumHoleCenterOffsetMm = 0;
  let maximumHoleDiameterDeltaMm = 0;
  for (const fastener of live.fasteners) {
    const xMm = fastener.localCenterMm.x - live.plate.boundsMm.minX;
    const yMm = fastener.localCenterMm.y - live.plate.boundsMm.minY;
    const candidates = remaining.filter((hole) => Math.hypot(hole.xMm - xMm, hole.yMm - yMm) <= toleranceMm
      && Math.abs(hole.diameterMm - fastener.holeDiameterMm) <= toleranceMm);
    if (candidates.length !== 1) throw new Error("Physical test hole layout does not uniquely match the live CAD plate within the evidence-backed tolerance");
    const [matchedHole] = remaining.splice(remaining.indexOf(candidates[0]!), 1);
    maximumHoleCenterOffsetMm = Math.max(maximumHoleCenterOffsetMm, Math.hypot(matchedHole!.xMm - xMm, matchedHole!.yMm - yMm));
    maximumHoleDiameterDeltaMm = Math.max(maximumHoleDiameterDeltaMm, Math.abs(matchedHole!.diameterMm - fastener.holeDiameterMm));
  }
  if (remaining.length !== 0) throw new Error("Physical test includes holes absent from the live CAD plate");
  return {
    plateDeltaMm: {
      width: test.widthMm - live.plate.sizeMm.x,
      height: test.heightMm - live.plate.sizeMm.y,
      thickness: test.thicknessMm - live.plate.thicknessMm!,
    },
    maximumHoleCenterOffsetMm,
    maximumHoleDiameterDeltaMm,
    matchedHoleCount: live.fasteners.length,
  };
}
