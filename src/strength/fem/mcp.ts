import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { CadBinding } from "../contracts.ts";
import { strengthToolResult } from "../mcp-response.ts";
import { femStaticInputSchema, type FemReportContent, type FemReportStore, type FemStaticInput, type StoredFemReport } from "./fem-report-store.ts";
import { STATIC_FEM_REPORT_TOOL_DESCRIPTION, STATIC_FEM_TOOL_DESCRIPTION } from "./fem-tool-description.ts";
import { errorMessage, resolveFemTsaiWuQualification, verifyFemOrthotropicCouponBinding } from "./material-binding.ts";
import { compareFemRefinementReports } from "./refinement-comparison.ts";
import { buildStaticOrthotropicStressScreen, buildStaticOrthotropicTsaiWuScreen, buildStaticStressAllowableScreen, buildStressAllowableScreen, buildOrthotropicMaximumStressScreen } from "./static-stress-screen.ts";
import { cohesiveAnalysisRequestSchema, type CohesiveAnalysisRequest, type CohesiveAnalysisResult } from "./cohesive-analysis.ts";
import { CohesiveReportStore } from "./cohesive-report-store.ts";
import { verifyCohesiveReportEvidence } from "./cohesive-report-evidence.ts";
import type { InterfaceTestStore } from "../interface-test.ts";
import type { MaterialCouponQualificationStore } from "../material-qualification.ts";
import { MAX_LAYER_INTERFACE_PLANES, MAX_LAYERWISE_FEA_LAYERS, cohesiveLayerPlanePlanInputSchema, createCohesiveLayerPlanePlan } from "./layer-plane-plan.ts";

interface ToolExtra {
  signal: AbortSignal;
}

type ToolAnnotations = { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };

type RegisterTool = (
  name: string,
  config: { description: string; inputSchema: z.ZodType; annotations: ToolAnnotations },
  callback: (input: unknown, extra: ToolExtra) => Promise<{ content: [{ type: "text"; text: string }] }>,
) => unknown;

export interface FemToolDependencies {
  reports: FemReportStore;
  cohesiveReports: CohesiveReportStore;
  interfaceTests: InterfaceTestStore;
  coupons: MaterialCouponQualificationStore;
  readCadBinding(bodyId: number): Promise<CadBinding>;
  analyze(input: FemStaticInput, workspace: string, signal: AbortSignal): Promise<FemReportContent>;
  analyzeCohesive(input: CohesiveAnalysisRequest, workspace: string, signal: AbortSignal): Promise<CohesiveAnalysisResult>;
  verifyCoupon(input: Pick<FemStaticInput, "materialCoupon" | "youngsModulusMPa">
    & Partial<Pick<FemStaticInput, "poissonRatio" | "poissonRatioEvidence">>): Promise<void>;
}

const readonly: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const persistent: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
export function registerFemTools(server: McpServer, deps: FemToolDependencies): void {
  const registerTool = server.registerTool.bind(server) as unknown as RegisterTool;
  const tool = <T extends z.ZodType>(
    name: string,
    description: string,
    schema: T,
    annotations: ToolAnnotations,
    handler: (input: z.output<T>, extra: ToolExtra) => Promise<unknown>,
  ): void => {
    registerTool(name, { description, inputSchema: schema, annotations }, async (raw, extra) =>
      strengthToolResult(await handler(schema.parse(raw) as z.output<T>, extra)));
  };

  tool(
    "plasticity_plan_cohesive_layer_planes",
    `Generate ordered cohesive split planes from the selected exact slicer profile hash, its layer height, the caller-supplied first interlayer plane anchor in current CAD millimeters, and a confirmed global print build direction. The profile hash, layer height, layer count, build direction and anchor are caller-supplied; this helper does not fetch or authenticate a Workbench job, read CAD placement, or prove the anchor lies on the Solid. For a completed Workbench slice, call workbench_slicer_interface_heights with every selected interfaceLayerIndex; copy each returned relativeOffsetMm into interfaceOffsetsMm in the same order. You may also pass the complete selected response metadata and interfaces as depositionPathEvidence; the planner checks job/profile/G-code hashes, selected layers, layer count and relative offsets, then preserves each road-direction summary in the analysis record as provenance. To receive candidate material frames for every deposited layer, call workbench_slicer_layer_path_orientations in batches of up to 32 and combine the selected results, including the final layer, as layerPathEvidence with matching job/profile/source/G-code hashes. For solver-mapped frames, retrieve complete coverage evidence (linear moves and XY G2/G3 circular arcs using I/J offsets or signed R radius; up to ${MAX_LAYERWISE_FEA_LAYERS} layers), provide user-confirmed pathFrameMapping.slicerXDirectionGlobal, and explicitly confirm with roadAxisMapping that the exact-process coupon axis 1 represents the dominant deposited-road direction. P multi-turn arcs, malformed or mixed I/J-and-R arcs, non-XY arc planes, absolute I/J center mode, and G5/G5.1 splines or G5.2/G5.3 NURBS blocks remain partial and cannot qualify this solver mapping. The cohesive analysis additionally requires useOrthotropicBulkProperties and the measured single-material tensor. It then applies that one shared tensor with a per-layer local frame in both Mode-I and Turon; it does not create multiple materials or layer-varying property values. Without roadAxisMapping, returned frames remain candidates and do not affect solver input. The same measured, direction-independent cohesive law is repeated at each interface; individual roads, within-layer raster mixtures and direction-dependent adhesion are not modeled. Interface and per-layer evidence, when both supplied, must refer to the same job and artifacts. These relative offsets are in the slicer's build frame; map only their distances onto the confirmed CAD build axis, and do not assume that absolute slicer coordinates equal CAD coordinates. Before cohesive analysis, record both the immutable Workbench profile hash and its layerHeightMm in the measured interface-test process; the analysis rejects absent or mismatched layer heights. Exact plane intersections are checked only when meshing succeeds. A complete stack up to ${MAX_LAYER_INTERFACE_PLANES} interfaces is fully analyzed; larger stacks may select up to ${MAX_LAYER_INTERFACE_PLANES} explicitly chosen interfaces and are marked incomplete. Omitted interfaces are not analyzed and no full-stack delamination conclusion is valid. Pass the returned plan as layerPlanePlan and the returned planes as splitPlanes to plasticity_analyze_cohesive_interface; that tool checks the profile hash and layer height against the measured test record and, for orthotropic bulk, checks the direction against the exact coupon frame.`,
    cohesiveLayerPlanePlanInputSchema,
    readonly,
    async (input) => createCohesiveLayerPlanePlan(input),
  );

  tool(
    "plasticity_analyze_cohesive_interface",
    `Run an experimental cohesive solver response for one current native Solid split by 1..${MAX_LAYER_INTERFACE_PLANES} ordered parallel planes into bulk regions representing the same single printed material. Every new analysis requires a profile-bound layerPlanePlan created by plasticity_plan_cohesive_layer_planes; arbitrary unbound split planes are rejected. The plan profile hash and nominal layer height must match the measured same-material interface-test process, actual G-code relative layer offsets should be copied when available, and orthotropic bulk requires its build axis to match the coupon frame. This tool rejects dissimilar-material bond records before meshing or solving and does not calculate multi-material prints. The default Mode-I route requires a stored same-material layer-failure DCB curve and uses isotropic bulk response with pinned Code_Aster 15.2; modeILaw defaults to CZM_EXP_REG for compatibility, while CZM_LIN_REG must be explicitly selected. This option applies only to Mode-I; mixed-mode requests use the calibrated Turon law. Both Mode-I choices use measured peak traction and integrated fracture energy, and neither reproduces arbitrary measured curve shape. When useOrthotropicBulkProperties is explicitly enabled, Mode-I uses Code_Aster 17.4 and one exact-process coupon's homogeneous orthotropic tensor and confirmed print frame identically on both sides. The mixed-mode Turon route additionally requires same-process ENF and at least two MMB records plus traceable initial cohesive stiffness K in MPa/mm with the exact process identity inside initialStiffnessEvidence.materialProcess, and an explicit displacement vector with both opening and shear components. Its shear component must align within one degree with the shared measured ENF/MMB in-plane axis; unsupported directions are rejected before meshing because CZM_TURON has one tangential law. It may use the same orthotropic single-material tensor. Both require one unambiguous exact-process coupon, one directly evidenced Poisson ratio, and current planar support/load faces. The input carries one material process and one Poisson ratio; solver region labels A and B only identify the two sides of the same material. Multi-plane coverage is complete only when every interface is represented (up to ${MAX_LAYER_INTERFACE_PLANES}); selected planes from taller stacks remain explicitly incomplete. The same measured same-material layer law is repeated at every plane; individual roads and layer-by-layer raster directions are not resolved. Turon interface adhesion is direction-independent in its tangent plane. The tool exports STEP, creates a conforming cohesive mesh with a repeated measured layer law at each requested plane, runs a pinned network-disabled Code_Aster solver, checks the Plasticity revision before and after solving, and saves an immutable report. Code_Aster Mode-I results label V3 semantics explicitly: CZM_EXP_REG reports a damage variable, while CZM_LIN_REG uses V3=2 for a fully broken element; do not read V3 as the same normalized damage fraction for both laws. The response does not establish strength, design adequacy or print approval.`,
    cohesiveAnalysisRequestSchema,
    persistent,
    async (input, extra) => {
      const workspace = await deps.reports.createWorkspace();
      const result = await deps.analyzeCohesive(input, workspace, extra.signal);
      if (extra.signal.aborted) throw new Error("Cohesive FEA analysis was cancelled before returning its result");
      const current = await deps.readCadBinding(result.binding.bodyId);
      if (!sameBinding(current, result.binding)) throw new Error("CAD changed before the cohesive solver response could be returned");
      return await deps.cohesiveReports.save(result);
    },
  );

  tool(
    "plasticity_cohesive_fem_report",
    "Read a persisted cohesive-interface solver report by ID and report whether its saved CAD session, document, body, revision, immutable interface test, and exact-process coupon records still match current evidence. The saved output remains a raw solver response with mesh-screening diagnostics; it never establishes strength or print approval.",
    z.object({ reportId: z.string().uuid() }).strict(),
    readonly,
    async ({ reportId }) => {
      const report = await deps.cohesiveReports.read(reportId);
      const freshnessReasons: string[] = [];
      try {
        const current = await deps.readCadBinding(report.binding.bodyId);
        if (!sameBinding(current, report.binding)) freshnessReasons.push("CAD session, document, body, or revision has changed");
      } catch (error) {
        freshnessReasons.push(`CAD binding could not be checked: ${errorMessage(error)}`);
      }
      try {
        await verifyCohesiveReportEvidence(report, deps.interfaceTests, deps.coupons);
      } catch (error) {
        freshnessReasons.push(`Physical interface/coupon evidence could not be verified: ${errorMessage(error)}`);
      }
      const freshness = freshnessReasons.length
        ? { status: "stale" as const, reason: freshnessReasons.join("; ") }
        : { status: "current" as const, reason: "CAD session, document, body, and revision match the saved cohesive analysis" };
      return { ...report, freshness };
    },
  );

  tool(
    "plasticity_analyze_static_fem",
    STATIC_FEM_TOOL_DESCRIPTION,
    femStaticInputSchema,
    persistent,
    async (input, extra) => {
      const resolvedInput = await resolveFemTsaiWuQualification(deps.coupons, femStaticInputSchema.parse(input));
      await verifyFemOrthotropicCouponBinding(deps.coupons, resolvedInput);
      if (resolvedInput.materialCoupon) await deps.verifyCoupon(resolvedInput);
      const workspace = await deps.reports.createWorkspace();
      const content = await deps.analyze(resolvedInput, workspace, extra.signal);
      if (extra.signal.aborted) throw new Error("Static FEA analysis was cancelled before saving the report");
      const current = await deps.readCadBinding(content.binding.bodyId);
      if (!sameBinding(current, content.binding)) {
        throw new Error("CAD changed before the FEA report could be saved; solver output was not bound to the current model");
      }
      if (extra.signal.aborted) throw new Error("Static FEA analysis was cancelled before saving the report");
      const report = await deps.reports.save(content);
      return { ...report, stressAllowableScreen: buildStaticStressAllowableScreen(report), orthotropicStressScreen: buildStaticOrthotropicStressScreen(report), orthotropicTsaiWuScreen: buildStaticOrthotropicTsaiWuScreen(report), interpretation: "linear-static-solver-result-only", strengthPass: false, printApproved: false };
    },
  );

  tool(
    "plasticity_static_fem_report",
    STATIC_FEM_REPORT_TOOL_DESCRIPTION,
    z.object({ reportId: z.string().regex(/^[A-Za-z0-9-]{36}$/) }).strict(),
    readonly,
    async ({ reportId }) => {
      const report = await deps.reports.read(reportId);
      const freshnessReasons: string[] = [];
      try {
        const current = await deps.readCadBinding(report.binding.bodyId);
        if (!sameBinding(current, report.binding)) freshnessReasons.push("CAD session, document, body, or revision has changed");
      } catch (error) {
        freshnessReasons.push(`CAD binding could not be checked: ${errorMessage(error)}`);
      }
      if (report.input.materialCoupon) {
        try {
          await deps.verifyCoupon(report.input);
        } catch (error) {
          freshnessReasons.push(`Material coupon binding could not be verified: ${errorMessage(error)}`);
        }
      }
      if ("orthotropicMaterial" in report.input && report.input.orthotropicMaterial?.tsaiWuCriterion?.qualificationRecordId) {
        try {
          await resolveFemTsaiWuQualification(deps.coupons, report.input);
        } catch (error) {
          freshnessReasons.push(`Orthotropic Tsai-Wu qualification record could not be verified: ${errorMessage(error)}`);
        }
      }
      if ("orthotropicMaterial" in report.input && report.input.orthotropicMaterial?.couponRecordId) {
        try {
          await verifyFemOrthotropicCouponBinding(deps.coupons, report.input);
        } catch (error) {
          freshnessReasons.push(`Full orthotropic coupon record could not be verified: ${errorMessage(error)}`);
        }
      }
      const freshness = freshnessResult(freshnessReasons);
      return { ...report, freshness, stressAllowableScreen: buildStaticStressAllowableScreen(report), orthotropicStressScreen: buildStaticOrthotropicStressScreen(report), orthotropicTsaiWuScreen: buildStaticOrthotropicTsaiWuScreen(report), interpretation: "linear-static-solver-result-only", strengthPass: false, printApproved: false };
    },
  );

  tool(
    "plasticity_compare_static_fem_refinement_reports",
    "Compare 2–4 saved static FEA reports from the same CAD revision, body, supports, loads, material evidence and native geometry. It merges only byte-identical repeated mesh hashes with matching solver results, then reports sampled stress/displacement trends across the combined levels. If all inputs share a directly traceable factored von Mises allowable, returns its raw peak screen; if they share all nine orthotropic factored directional allowables, returns the material-local componentwise maximum-stress screen. The orthotropic screen assumes one homogeneous continuum; it does not model layer interfaces, delamination or different-material joints. Both omit unresolved failure modes and are diagnostic only, not convergence estimates, strength verdicts or print approval. CAD or material evidence freshness is reported separately.",
    z.object({
      reportIds: z.array(z.string().regex(/^[A-Za-z0-9-]{36}$/)).min(2).max(4)
        .refine((ids) => new Set(ids).size === ids.length, "FEA report IDs must be unique"),
    }).strict(),
    readonly,
    async ({ reportIds }) => {
      const reports = await Promise.all(reportIds.map((reportId) => deps.reports.read(reportId)));
      const comparison = compareFemRefinementReports(reports);
      const allowableInput = reports[0]!.input;
      const stressAllowableScreen = buildStressAllowableScreen(
        allowableInput.factoredVonMisesAllowableMPa,
        allowableInput.factoredVonMisesAllowableEvidence,
        allowableInput.factoredVonMisesAllowableBasis,
        comparison.cases.map((loadCase) => ({
          name: loadCase.name,
          samples: loadCase.meshLevels.map((level) => ({
            meshSizeMm: level.meshSizeMm,
            meshSha256: level.meshSha256,
            maximumVonMisesMPa: level.maximumVonMisesMPa,
          })),
        })),
      );
      const orthotropicAllowables = "orthotropicMaterial" in allowableInput ? allowableInput.orthotropicMaterial?.factoredAllowables : undefined;
      const orthotropicStressScreen = orthotropicAllowables ? (() => {
        const { evidence, basis, ...allowableValues } = orthotropicAllowables;
        return buildOrthotropicMaximumStressScreen(
          allowableValues,
          evidence,
          basis,
          comparison.cases.map((loadCase) => ({
            name: loadCase.name,
            samples: loadCase.meshLevels.map((level) => {
              if (!level.stressTensorComponentExtrema) throw new Error("Orthotropic refinement result is missing local stress tensor component extrema");
              if (level.stressCoordinateBasis !== "material-local") throw new Error("Directional maximum-stress screening requires one homogeneous material-local frame; per-layer frame results need a layer-aware criterion");
              return { meshSizeMm: level.meshSizeMm, meshSha256: level.meshSha256, components: level.stressTensorComponentExtrema };
            }),
          })),
        );
      })() : null;
      const freshnessReasons: string[] = [];
      try {
        const current = await deps.readCadBinding(comparison.binding.bodyId);
        if (!sameBinding(current, comparison.binding)) freshnessReasons.push("CAD session, document, body, or revision has changed");
      } catch (error) {
        freshnessReasons.push(`CAD binding could not be checked: ${errorMessage(error)}`);
      }
      if (reports[0]!.input.materialCoupon) {
        try {
          await deps.verifyCoupon(reports[0]!.input);
        } catch (error) {
          freshnessReasons.push(`Material coupon binding could not be verified: ${errorMessage(error)}`);
        }
      }
      return {
        ...comparison,
        freshness: freshnessResult(freshnessReasons),
        stressAllowableScreen,
        orthotropicStressScreen,
        strengthPass: false,
        printApproved: false,
      };
    },
  );
}

function sameBinding(current: CadBinding, expected: StoredFemReport["binding"] | FemReportContent["binding"]): boolean {
  return current.sessionId === expected.sessionId && current.documentToken === expected.documentToken
    && current.revision === expected.revision && current.bodyId === expected.bodyId;
}

function freshnessResult(reasons: string[]): { status: "current" | "stale"; reason: string } {
  return reasons.length === 0
    ? { status: "current", reason: "CAD and referenced material evidence still match the analyzed reports" }
    : { status: "stale", reason: reasons.join("; ") };
}
