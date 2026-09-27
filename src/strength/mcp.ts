import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AnalysisClient } from "../codex/analysis-client.ts";
import type { ReferenceSearchClient } from "../codex/reference-search-client.ts";
import { referenceSearchRequestSchema } from "../codex/reference-search.ts";
import type { ArbitrarySectionEvidence, ArbitrarySectionRequest } from "../plasticity/arbitrary-section.ts";
import type { MemberEvidence, MemberRequest } from "../plasticity/member-geometry.ts";
import type { FastenerPlateEvidence, FastenerPlateRequest } from "../plasticity/fastener-geometry.ts";
import type { IntegralPlateEvidence, IntegralPlateRequest } from "../plasticity/integral-plate-geometry.ts";
import type { FastenerGroupGeometryBinding, FastenerGroupGeometryEvidence, FastenerGroupGeometryRequest } from "../plasticity/fastener-group-geometry.ts";
import type { FastenerGroupLayoutEvidence, FastenerGroupLayoutRequest } from "../plasticity/fastener-group-layout.ts";
import type { SectionEvidence, SectionRequest } from "../plasticity/section-geometry.ts";
import { analyzeRequest } from "./analyze.ts";
import { calculate } from "./calculate.ts";
import type { AnalysisRequest, CadBinding, Calculation, Evidence, StrengthInput } from "./contracts.ts";
import { calculateSection } from "./section-calculate.ts";
import type { SectionBinding, SectionCalculation, SectionScenarioInput } from "./section-contracts.ts";
import type { SectionScanCandidateRecord, SectionStrengthScanRecord } from "./section-scan-contracts.ts";
import {
  designReferencePrompt,
  DESIGN_REFERENCE_WORKFLOW_RESOURCE,
  strengthPrompt,
  STRENGTH_CORE_WORKFLOW,
  STRENGTH_INTERLAYER_BASELINE_RESOURCE,
  STRENGTH_METHODS_RESOURCE,
  STRENGTH_RECOVERY_RESOURCE,
  STRENGTH_WORKFLOW_RESOURCE,
} from "./instructions.ts";
import { listStrengthMethods } from "./methods.ts";
import { analysisRequestSchema, evidenceSchema, strengthInputSchema } from "./schemas.ts";
import { sectionScenarioInputSchema } from "./section-schemas.ts";
import { calculateSingleFastener } from "./fastener-calculate.ts";
import type { FastenerBinding, FastenerScenarioInput } from "./fastener-contracts.ts";
import { fastenerScenarioInputSchema } from "./fastener-schemas.ts";
import { calculateFastenerMember } from "./fastener-member-calculate.ts";
import type { FastenerMemberInput } from "./fastener-member-contracts.ts";
import { fastenerMemberInputSchema } from "./fastener-member-schemas.ts";
import { calculateThreadedReceiver } from "./threaded-receiver-calculate.ts";
import type { ThreadedReceiverInput } from "./threaded-receiver-contracts.ts";
import { threadedReceiverInputSchema } from "./threaded-receiver-schemas.ts";
import { calculateInsertRetention } from "./insert-retention-calculate.ts";
import type { InsertRetentionInput } from "./insert-retention-contracts.ts";
import { insertRetentionInputSchema } from "./insert-retention-schemas.ts";
import { calculateFastenerGroupLoad } from "./fastener-group-calculate.ts";
import type { FastenerGroupBinding, FastenerGroupInput } from "./fastener-group-contracts.ts";
import { fastenerGroupInputSchema } from "./fastener-group-schemas.ts";
import { addFastenerGroupBindingReasons, assertSameFastenerGroupBinding, withMeasuredFastenerGroup } from "./fastener-group-mcp-support.ts";
import { registerFastenerGroupPlateBearingTool } from "./fastener-group-plate-tools.ts";
import { calculateTongueRoot } from "./tongue-root-calculate.ts";
import type { TongueRootBinding, TongueRootInput } from "./tongue-root-contracts.ts";
import { rectangularRootDimensions } from "./tongue-root-geometry.ts";
import { tongueRootInputSchema } from "./tongue-root-schemas.ts";
import {
  exactMaterialCouponProcessSchema,
  type MaterialCouponQualificationMatch,
  type MaterialCouponQualificationRecord,
} from "./material-qualification.ts";
import { registerMaterialCouponTools } from "./material-coupon-mcp.ts";
import { sizeMember } from "./size-member.ts";
import { reportView, StrengthStore, type ReportInput, type ReportView, type StoredReport } from "./store.ts";
import { FemReportStore, type FemReportContent, type FemStaticInput } from "./fem/fem-report-store.ts";
import type { CohesiveAnalysisInput, CohesiveAnalysisResult } from "./fem/cohesive-analysis.ts";
import { CohesiveReportStore } from "./fem/cohesive-report-store.ts";
import { registerStrengthFemTools } from "./fem/register-strength-tools.ts";
import { errorMessage } from "./fem/material-binding.ts";
import { strengthToolResult } from "./mcp-response.ts";
import { materializeRectangularCouponInput, rectangularCouponInputSchema } from "./rectangular-coupon.ts";
import { fastenerGroupTestInputSchema, fastenerGroupTestQuerySchema } from "./fastener-group-test.ts";
import { registerMaterialInterfaceTestTools } from "./interface-test-mcp.ts";
import { registerMaterialTestPlanTool } from "./material-test-plan-mcp.ts";

const referenceSearchMcpRequestSchema = referenceSearchRequestSchema.extend({
  searchTimeoutMs: z.number().int().min(30_000).max(180_000).default(180_000),
});

const vector = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const direction = vector.refine((value) => value.some((component) => component !== 0), "Direction must be nonzero");
const memberRequestSchema = z.object({
  bodyId: z.number().int().positive(),
  revision: z.string().min(1),
  lengthAxis: direction,
  heightAxis: direction,
}).strict();
const verifySchema = z.object({
  input: strengthInputSchema,
  lengthAxis: direction,
  heightAxis: direction,
}).strict();
const integralPlateVerifySchema = z.object({
  input: strengthInputSchema,
  frontFaceId: z.string().min(1),
  backFaceId: z.string().min(1),
  xDirection: direction,
}).strict();
const integralPlateRequestSchema = z.object({
  bodyId: z.number().int().positive(),
  frontFaceId: z.string().min(1),
  backFaceId: z.string().min(1),
  revision: z.string().min(1),
  xDirection: direction,
}).strict();
const sectionRequestSchema = z.object({
  bodyId: z.number().int().nonnegative(),
  faceId: z.string().min(1),
  revision: z.string().min(1),
  xDirection: direction,
}).strict();
const arbitrarySectionRequestSchema = z.object({
  bodyId: z.number().int().positive(),
  revision: z.string().min(1),
  plane: z.object({
    originMm: vector,
    normal: direction,
    xDirection: direction,
  }).strict(),
}).strict();
const tongueRootVerifySchema = z.object({ input: tongueRootInputSchema }).strict().superRefine(({ input }, context) => {
  if (!input.binding) context.addIssue({ code: "custom", message: "A current arbitrary-plane binding from tongue-root section inspection is required" });
});
const tongueRootCouponScenarioSchema = z.object({
  kind: z.literal("tongue-root"),
  goal: z.string().min(1),
  method: z.literal("tongue-root-transverse-v1"),
  geometry: z.object({ rootWidthMm: z.number().finite().positive(), rootThicknessMm: z.number().finite().positive(), leverArmMm: z.number().finite().positive() }).strict(),
  loads: z.object({ transverseForceN: z.number().finite().positive() }).strict(),
  shearCorrectionFactor: z.number().finite().gt(0).max(1),
  safetyFactor: z.number().finite().positive(),
  maxDeflectionMm: z.number().finite().positive(),
  evidence: z.array(evidenceSchema),
  assignments: z.record(z.string(), z.string().min(1)),
  assumptions: z.array(z.object({ code: z.string().min(1), confirmed: z.boolean(), evidenceIds: z.array(z.string().min(1)) }).strict()),
  binding: tongueRootInputSchema.shape.binding,
}).strict();
const tongueRootCouponInputSchema = z.object({
  process: exactMaterialCouponProcessSchema,
  scenario: tongueRootCouponScenarioSchema,
  allowables: z.object({ tensileMPa: z.number().finite().positive(), shearMPa: z.number().finite().positive() }).strict(),
  allowablesBasis: z.string().trim().min(1).max(1000),
  effectiveSection: z.enum(["solid", "validated-effective", "unknown"]),
}).strict().superRefine(({ scenario }, context) => {
  for (const path of ["material.youngModulusMPa", "material.shearModulusMPa"]) {
    if (path in scenario.assignments) context.addIssue({ code: "custom", path: ["scenario", "assignments", path], message: "Coupon-backed modulus assignments are generated from the selected record" });
  }
  for (const path of ["material.tensileAllowableMPa", "material.shearAllowableMPa"]) {
    if (!scenario.assignments[path]) context.addIssue({ code: "custom", path: ["scenario", "assignments", path], message: `${path} needs independent traceable design-allowable evidence` });
  }
});
type TongueRootCouponInput = z.infer<typeof tongueRootCouponInputSchema>;
const tongueRootCouponVerifySchema = tongueRootCouponInputSchema.safeExtend({
  scenario: tongueRootCouponScenarioSchema.extend({ binding: tongueRootInputSchema.shape.binding.unwrap() }),
}).strict();
const arbitrarySectionsRequestSchema = z.object({
  bodyId: z.number().int().positive(),
  revision: z.string().min(1),
  planes: z.array(arbitrarySectionRequestSchema.shape.plane).min(1).max(32),
}).strict();
const arbitrarySectionScanSchema = z.object({
  bodyId: z.number().int().positive(),
  revision: z.string().min(1),
  startPlane: arbitrarySectionRequestSchema.shape.plane,
  fromOffsetMm: z.number().finite(),
  toOffsetMm: z.number().finite(),
  stationCount: z.number().int().min(2).max(32),
}).strict().refine((input) => input.fromOffsetMm < input.toOffsetMm, {
  message: "toOffsetMm must be greater than fromOffsetMm",
}).refine((input) => Number.isFinite(input.toOffsetMm - input.fromOffsetMm), {
  message: "Section scan range must have a finite span",
});
const sectionScanScenarioSchema = z.object({
  goal: z.string().min(1),
  method: z.literal("planar-section-resultants-v1"),
  pointForces: sectionScenarioInputSchema.shape.pointForces,
  freeMoments: sectionScenarioInputSchema.shape.freeMoments,
  material: sectionScenarioInputSchema.shape.material,
  safetyFactor: sectionScenarioInputSchema.shape.safetyFactor,
  evidence: sectionScenarioInputSchema.shape.evidence,
  assignments: sectionScenarioInputSchema.shape.assignments,
  assumptions: sectionScenarioInputSchema.shape.assumptions,
}).strict();
const sectionStrengthScanSchema = z.object({
  bodyId: z.number().int().positive(),
  revision: z.string().min(1),
  startPlane: arbitrarySectionRequestSchema.shape.plane,
  fromOffsetMm: z.number().finite(),
  toOffsetMm: z.number().finite(),
  stationCount: z.number().int().min(2).max(32),
  scenario: sectionScanScenarioSchema,
}).strict().refine((input) => input.fromOffsetMm < input.toOffsetMm, {
  message: "toOffsetMm must be greater than fromOffsetMm",
}).refine((input) => Number.isFinite(input.toOffsetMm - input.fromOffsetMm), {
  message: "Section scan range must have a finite span",
});
const sectionStrengthScanReportSchema = z.object({
  scanReportId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
}).strict();
const fastenerPlateRequestSchema = z.object({
  bodyId: z.number().int().positive(),
  frontFaceId: z.string().min(1),
  backFaceId: z.string().min(1),
  revision: z.string().min(1),
  loadDirection: direction,
}).strict();
const sizeSchema = z.object({
  input: strengthInputSchema,
  heightsMm: z.array(z.number().finite().positive()).min(1).max(200),
}).strict();
const reportSchema = z.object({
  reportId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  current: z.union([sectionScenarioInputSchema, fastenerScenarioInputSchema, fastenerMemberInputSchema, threadedReceiverInputSchema, insertRetentionInputSchema, fastenerGroupInputSchema, tongueRootInputSchema, strengthInputSchema]).optional(),
}).strict();
const designReferenceRequestSchema = analysisRequestSchema.extend({
  analysisMode: z.literal("design-reference").default("design-reference"),
}).strict();

export interface StrengthDependencies {
  store: StrengthStore;
  femReports: FemReportStore;
  cohesiveReports: CohesiveReportStore;
  analyzeCohesive(input: CohesiveAnalysisInput, workspace: string, signal: AbortSignal): Promise<CohesiveAnalysisResult>;
  analysis: AnalysisClient | null;
  analysisUnavailableReason?: string;
  referenceSearch?: ReferenceSearchClient | null;
  referenceSearchUnavailableReason?: string;
  inspectMember(request: MemberRequest): Promise<MemberEvidence>;
  inspectIntegralPlate(request: IntegralPlateRequest): Promise<IntegralPlateEvidence>;
  readCadBinding(bodyId: number): Promise<CadBinding>;
  inspectSection(request: SectionRequest): Promise<SectionEvidence>;
  inspectArbitrarySection(request: ArbitrarySectionRequest): Promise<ArbitrarySectionEvidence>;
  readSectionBinding(request: Omit<SectionRequest, "revision">): Promise<SectionBinding>;
  inspectFastenerPlate(request: FastenerPlateRequest): Promise<FastenerPlateEvidence>;
  readFastenerBinding(request: Omit<FastenerPlateRequest, "revision">): Promise<FastenerBinding>;
  inspectFastenerGroup(request: FastenerGroupGeometryRequest): Promise<FastenerGroupGeometryEvidence>;
  inspectFastenerGroupLayout(request: FastenerGroupLayoutRequest): Promise<FastenerGroupLayoutEvidence>;
  readFastenerGroupBinding(request: Omit<FastenerGroupGeometryRequest, "revision">): Promise<FastenerGroupGeometryBinding>;
  analyzeStaticFem(input: FemStaticInput, workspace: string, signal: AbortSignal): Promise<FemReportContent>;
}

interface ToolExtra {
  signal: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification(notification: {
    method: "notifications/progress";
    params: { progressToken: string | number; progress: number; total?: number; message?: string };
  }): Promise<void>;
}

type ToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
};

type RegisterTool = (
  name: string,
  config: { description: string; inputSchema: z.ZodType; annotations: ToolAnnotations },
  callback: (input: unknown, extra: ToolExtra) => Promise<{ content: [{ type: "text"; text: string }] }>,
) => unknown;

export function registerStrengthTools(server: McpServer, deps: StrengthDependencies): void {
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
  const readonly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const persistent = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

  registerStrengthFemTools(server, deps);
  registerMaterialInterfaceTestTools(server, deps.store.materialInterfaceTests, deps.store.dcbModeIEnergyTests, deps.store.enfModeIIEnergyTests, deps.store.mmbModeIEnergyTests);

  registerMaterialTestPlanTool(server);
  registerMaterialCouponTools(server, deps.store.materialQualifications);

  tool(
    "plasticity_record_fastener_group_test",
    "Store immutable caller-attested physical test results for a multi-hole printed plate with the exact printer/material/profile/orientation, measured specimen dimensions and hole layout, load axis, fastener clearance, clamp condition and fixture configuration. Every peak load must link to measured N evidence and the measured geometry/test report must be traceable. This records observations only: it does not derive design allowables, infer a shared-ligament formula, qualify statistical strength or approve a part. Repeating identical data is idempotent.",
    fastenerGroupTestInputSchema,
    persistent,
    async (input) => await deps.store.fastenerGroupTests.record(input),
  );

  tool(
    "plasticity_match_fastener_group_test",
    "Find physical multi-hole joint tests only for an exact print process, rectangular specimen dimensions, hole centers/diameters, fixture configuration, load axis, fastener diameter/clearance and clamp condition. Returns no-match, matched or ambiguous records; reordering hole input does not change the match. A match is test evidence only, not a capacity, design allowable, strength pass or proof that a different part/support setup is equivalent.",
    fastenerGroupTestQuerySchema,
    readonly,
    async (query) => await deps.store.fastenerGroupTests.match(query),
  );

  tool(
    "plasticity_list_fastener_group_tests",
    "List immutable caller-attested physical multi-hole joint test records. The registry preserves measured failure loads and observed modes with exact process/geometry/fixture and report evidence; it does not calculate design allowables or certify a part.",
    z.object({}).strict(),
    readonly,
    async () => ({ source: "immutable-local-physical-fastener-group-test-registry", records: await deps.store.fastenerGroupTests.list() }),
  );

  tool(
    "plasticity_strength_methods",
    `List deterministic member, plate and section methods plus Codex analysis availability. ${STRENGTH_CORE_DESCRIPTION}`,
    z.object({}).strict(),
    readonly,
    async () => ({
      methods: listStrengthMethods(),
      analysis: deps.analysis
        ? { available: true }
        : { available: false, reason: deps.analysisUnavailableReason ?? "Isolated Codex analysis is unavailable" },
    }),
  );

  tool(
    "plasticity_reference_search_status",
    "Report whether isolated Codex live web search for product CAD and dimensional references is available. This capability has no CAD, shell, local-file, or MCP access.",
    z.object({}).strict(),
    readonly,
    async () => deps.referenceSearch
      ? { available: true, transport: "Codex app-server web_search live", autoImport: false }
      : { available: false, reason: deps.referenceSearchUnavailableReason ?? "Isolated Codex reference search is unavailable", autoImport: false },
  );

  tool(
    "plasticity_search_product_references",
    "Search live web sources for candidate CAD models and reliable dimensioned references using an isolated Codex profile. Results are unverified discovery leads only: source-page and direct asset URLs are cross-checked against Codex web-search/open-page results, but licensing, paid/account access, fit, source quality and dimensions still require review. Each candidate reports accessStatus separately from licenseStatus; a paid product page is not a direct asset URL and must not be passed to an importer. It never downloads/imports files or mutates CAD. Prefer manufacturer sources; specify allowedDomains when discovery should be scoped. searchTimeoutMs defaults to 180000 and accepts 30000–180000 ms for slow searches.",
    referenceSearchMcpRequestSchema,
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    async (input, extra) => {
      if (!deps.referenceSearch) throw new Error(deps.referenceSearchUnavailableReason ?? "Isolated Codex reference search is unavailable");
      const progressToken = extra._meta?.progressToken;
      const startedAt = Date.now();
      const { searchTimeoutMs: timeoutMs, ...searchInput } = input;
      const reportProgress = (): void => {
        if (progressToken === undefined) return;
        void extra.sendNotification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress: Math.min(Date.now() - startedAt, timeoutMs),
            total: timeoutMs,
            message: "Codex is searching product CAD and dimensional references.",
          },
        }).catch(() => undefined);
      };
      reportProgress();
      const timer = progressToken === undefined ? undefined : setInterval(reportProgress, 10_000);
      try {
        return await deps.referenceSearch.search(searchInput, { timeoutMs, signal: extra.signal });
      } finally {
        if (timer) clearInterval(timer);
      }
    },
  );

  tool(
    "plasticity_analyze_strength_task",
    `Run one isolated Codex turn for factual extraction and the single next decision-relevant question package. Include each prior full question with its user answer on follow-up turns. This writes a durable request record, contacts Codex, never mutates CAD and never authorizes a print. ${STRENGTH_CORE_DESCRIPTION}`,
    analysisRequestSchema,
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async (input, extra) => {
      if (!deps.analysis) throw new Error(deps.analysisUnavailableReason ?? "Isolated Codex analysis is unavailable");
      return await analyzeRequest(input as unknown as AnalysisRequest, deps.store, deps.analysis, extra.signal);
    },
  );

  tool(
    "plasticity_analyze_design_reference",
    "Use the bounded, action-free Codex API profile to inspect the supplied photo/sketch views and text (up to four PNG/JPEG/HEIC/HEIF images, 20 MiB each; macOS converts HEIC/HEIF locally to JPEG for analysis). Returns structured functional interfaces and candidate features, an explicit scale-confidence status, and at most one next decision-relevant question package. A dimensioned/calibrated result requires traceable positive millimeter scale evidence; unscaled views cannot yield millimeter measurements. It never creates CAD or sends a print. The request is durable and is not retried under the same ID after interruption.",
    designReferenceRequestSchema,
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async (input, extra) => {
      if (!deps.analysis) throw new Error(deps.analysisUnavailableReason ?? "Isolated Codex analysis is unavailable");
      return await analyzeRequest(input as unknown as AnalysisRequest, deps.store, deps.analysis, extra.signal);
    },
  );

  tool(
    "plasticity_design_reference_request",
    "Read a persisted design-reference analysis without starting or retrying a Codex turn.",
    z.object({ requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/) }).strict(),
    readonly,
    async ({ requestId }) => await deps.store.readRequest(requestId),
  );

  tool(
    "plasticity_strength_request",
    "Read one persisted strength-analysis request without starting or retrying Codex.",
    z.object({ requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/) }).strict(),
    readonly,
    async ({ requestId }) => await deps.store.readRequest(requestId),
  );

  tool(
    "plasticity_calculate_strength",
    "Calculate and persist a labelled scenario from caller-supplied dimensions. A supplied CAD binding is not treated as verified geometry.",
    strengthInputSchema,
    persistent,
    async (parsed) => {
      const supplied = parsed as StrengthInput;
      const { binding: _unverifiedBinding, ...scenario } = supplied;
      const input = structuredClone(scenario) as StrengthInput;
      const calculation = cautiousCalculation(input, "Calculation scenario using caller-supplied dimensions. ");
      return await deps.store.saveReport(input, calculation);
    },
  );

  tool(
    "plasticity_calculate_rectangular_strength_from_coupon_data",
    "Calculate axial-tension or rectangular-cantilever scenarios using Young's modulus copied from an exact printer/material/profile/orientation coupon record. Tensile allowable, and for cantilevers compressive allowable, must be separately evidenced. Raw coupon strengths are never mapped to allowables. Process suitability remains unconfirmed; no-match or ambiguity returns without saving a calculation.",
    rectangularCouponInputSchema,
    persistent,
    async (raw) => {
      const resolved = await materializeRectangularCouponInput(deps.store, raw);
      if (!resolved.input) return resolved.match;
      const report = await deps.store.saveReport(
        resolved.input,
        cautiousCalculation(resolved.input, `Exact-process coupon record ${resolved.record.id}; Young's modulus copied from measured coupon data; allowables are separately supplied and material suitability remains unconfirmed. `),
      );
      return { status: "calculated-conditional", couponRecordId: resolved.record.id, report };
    },
  );

  tool(
    "plasticity_size_member",
    "Evaluate an explicit finite list of rectangular-member heights or plate thicknesses. This is a deterministic scenario calculation and does not modify CAD.",
    sizeSchema,
    readonly,
    async ({ input, heightsMm }) => sizeMember({ input: input as StrengthInput, heightsMm }),
  );

  tool(
    "plasticity_inspect_rectangular_member",
    "Read exact native B-rep topology and verify one constant rectangular Solid without using display or mesh bounds.",
    memberRequestSchema,
    readonly,
    async (input) => await deps.inspectMember(input),
  );

  tool(
    "plasticity_inspect_integral_rectangular_plate",
    "Measure one exact rectangular panel wall from opposed native planar faces of the same Solid. Verifies face outlines, opposite normals, coplanar alignment and wall thickness; no display or mesh bounds are used.",
    integralPlateRequestSchema,
    readonly,
    async (input) => await deps.inspectIntegralPlate(input),
  );

  tool(
    "plasticity_inspect_planar_section",
    "Read one exact current planar Solid face from native B-rep line and circular boundaries. Display bounds and render meshes are not measurement evidence.",
    sectionRequestSchema,
    readonly,
    async (input) => await deps.inspectSection(input),
  );

  tool(
    "plasticity_inspect_arbitrary_section",
    "Read the exact native B-rep intersection of one Solid with an arbitrary plane. The temporary Sheet and cut results never enter the persistent document.",
    arbitrarySectionRequestSchema,
    readonly,
    async (input) => await deps.inspectArbitrarySection(input),
  );

  tool(
    "plasticity_inspect_tongue_root_section",
    "Inspect a caller-selected exact native section and derive root width/thickness only when the B-rep boundary is one axis-aligned rectangle with four straight edges and no holes. The returned plane binding can be used by plasticity_verify_tongue_root_strength.",
    arbitrarySectionRequestSchema,
    readonly,
    async (request) => {
      const section = await deps.inspectArbitrarySection(request);
      if (section.status !== "verified" || !section.properties || !section.loops) {
        return { status: "unsupported", binding: section.binding, reasons: section.reasons.length > 0 ? section.reasons : ["section-evidence-unavailable"] };
      }
      try {
        return {
          status: "verified",
          binding: section.binding,
          dimensions: rectangularRootDimensions(section.loops, section.properties),
          source: "native-brep-temporary-section",
          reasons: [],
        };
      } catch (error) {
        return {
          status: "unsupported",
          binding: section.binding,
          reasons: [error instanceof Error ? error.message : "unsupported-root-section"],
        };
      }
    },
  );

  tool(
    "plasticity_inspect_arbitrary_sections",
    "Inspect 1–32 explicitly supplied candidate planes through one Solid. Every exact native section must belong to the same current Plasticity session, document, body and revision; individual planes may be unsupported if they do not cut a supported section.",
    arbitrarySectionsRequestSchema,
    readonly,
    async ({ bodyId, revision, planes }) => await inspectSectionCandidates(deps, bodyId, revision, planes),
  );

  tool(
    "plasticity_scan_arbitrary_sections",
    "Sample 2–32 exact B-rep sections at evenly spaced stations along an explicit plane normal and offset interval. The caller chooses the scan direction and range; this does not identify or rank mechanically critical sections.",
    arbitrarySectionScanSchema,
    readonly,
    async ({ bodyId, revision, startPlane, fromOffsetMm, toOffsetMm, stationCount }) => {
      const { planes, spacingMm } = generateSectionStations(startPlane, fromOffsetMm, toOffsetMm, stationCount);
      const result = await inspectSectionCandidates(deps, bodyId, revision, planes);
      return {
        ...result,
        scan: { fromOffsetMm, toOffsetMm, spacingMm, stationCount },
      };
    },
  );

  tool(
    "plasticity_scan_section_strength",
    "Measure exact B-rep sections and calculate one identical load/material scenario at each explicitly bounded station. It ranks only supported, complete single-mode utilization results; any unsupported or incomplete station suppresses a global governing-station claim. It saves one immutable scan report with every measured input and calculation; report reads re-check the live CAD binding.",
    sectionStrengthScanSchema,
    persistent,
    async ({ bodyId, revision, startPlane, fromOffsetMm, toOffsetMm, stationCount, scenario }) => {
      const { planes, spacingMm } = generateSectionStations(startPlane, fromOffsetMm, toOffsetMm, stationCount);
      const batch = await inspectSectionCandidates(deps, bodyId, revision, planes);
      const persistedCandidates: SectionScanCandidateRecord[] = [];
      const candidates = batch.sections.map((section, stationIndex) => {
        const offsetMm = fromOffsetMm + spacingMm * stationIndex;
        if (section.status !== "verified") {
          persistedCandidates.push({
            stationIndex,
            offsetMm,
            status: "unsupported",
            binding: section.binding,
            reasons: section.reasons,
          });
          return { stationIndex, offsetMm, status: "unsupported" as const, binding: section.binding, reasons: section.reasons };
        }
        const input = withMeasuredSection({ kind: "planar-section", ...scenario } as SectionScenarioSeed, section);
        const calculation = calculateSection(input);
        const utilization = sectionUtilization(calculation);
        persistedCandidates.push({
          stationIndex,
          offsetMm,
          status: calculation.status,
          binding: section.binding,
          reasons: [],
          input,
          calculation,
          ...(utilization ? { maximumSingleModeUtilization: utilization.value, governingComponent: utilization.component } : {}),
        });
        return {
          stationIndex,
          offsetMm,
          status: calculation.status,
          binding: section.binding,
          properties: section.properties,
          inputHash: calculation.inputHash,
          calculation,
          ...(utilization ? { maximumSingleModeUtilization: utilization.value, governingComponent: utilization.component } : {}),
        };
      });
      const ranked = candidates.flatMap((candidate) =>
        "calculation" in candidate && candidate.calculation && candidate.status !== "unsupported" && candidate.status !== "needs-input"
          && candidate.maximumSingleModeUtilization !== undefined
          ? [{ stationIndex: candidate.stationIndex, utilization: candidate.maximumSingleModeUtilization, component: candidate.governingComponent! }]
          : []
      ).sort((left, right) => right.utilization - left.utilization || left.stationIndex - right.stationIndex);
      const excludedStationIndices = candidates.filter((candidate) => !ranked.some((entry) => entry.stationIndex === candidate.stationIndex))
        .map((candidate) => candidate.stationIndex);
      const complete = excludedStationIndices.length === 0;
      const ranking: SectionStrengthScanRecord["ranking"] = {
        status: complete ? "complete" : "incomplete",
        metric: "maximum-single-mode-utilization",
        rankedStations: ranked,
        excludedStationIndices,
        ...(complete && ranked[0] ? { governingStationIndex: ranked[0].stationIndex } : {}),
      };
      const current = await deps.readCadBinding(bodyId);
      assertSameCadContext(current, batch.binding, "Plasticity changed before the section-strength scan could be saved");
      const saved = await deps.store.saveSectionStrengthScan({
        binding: batch.binding,
        scan: { startPlane, fromOffsetMm, toOffsetMm, spacingMm, stationCount },
        ranking,
        candidates: persistedCandidates,
      });
      return {
        status: "complete",
        binding: batch.binding,
        scan: { fromOffsetMm, toOffsetMm, spacingMm, stationCount },
        ranking,
        scanReportId: saved.id,
        createdAt: saved.createdAt,
        candidates,
      };
    },
  );

  tool(
    "plasticity_section_strength_scan_report",
    "Read one immutable section-strength scan, including exact candidate geometry, evidence, calculations and ranking. Re-checks the stored session/document/revision/body against the live Plasticity binding and reports current, stale or unverified.",
    sectionStrengthScanReportSchema,
    readonly,
    async ({ scanReportId }) => {
      const report = await deps.store.readSectionStrengthScan(scanReportId);
      const reasons = new Set<string>();
      try {
        const live = await deps.readCadBinding(report.binding.bodyId);
        addBindingReasons(report.binding, live, reasons);
      } catch {
        reasons.add("CAD_SESSION_UNAVAILABLE");
      }
      const list = [...reasons];
      const stale = list.some((reason) => reason.startsWith("CAD_") && reason !== "CAD_SESSION_UNAVAILABLE");
      const unavailable = reasons.has("CAD_SESSION_UNAVAILABLE");
      return {
        report,
        freshness: stale ? "stale" : unavailable ? "unverified" : "current",
        reasons: list,
      };
    },
  );

  tool(
    "plasticity_inspect_single_fastener_plate",
    "Verify one exact constant-thickness rectangular Solid plate with one cylindrical through-hole. The load direction selects the loaded edge; no display or mesh bounds are used.",
    fastenerPlateRequestSchema,
    readonly,
    async (input) => await deps.inspectFastenerPlate(input),
  );

  tool(
    "plasticity_calculate_section_strength",
    "Calculate and persist a labelled planar-section scenario. Caller-supplied geometry remains unverified and any supplied CAD binding is removed.",
    sectionScenarioInputSchema,
    persistent,
    async (parsed) => {
      const supplied = parsed as SectionScenarioInput;
      const { binding: _unverifiedBinding, ...scenario } = supplied;
      const input = structuredClone(scenario) as SectionScenarioInput;
      const calculation = labelledSectionCalculation(input, "Calculation scenario using caller-supplied section geometry. ");
      return await deps.store.saveSectionReport(input, calculation);
    },
  );

  tool(
    "plasticity_calculate_single_fastener_strength",
    "Calculate and persist bearing, loaded-edge shear-out and net-section tension for one caller-described through fastener. Caller CAD bindings are removed.",
    fastenerScenarioInputSchema,
    persistent,
    async (parsed) => {
      const supplied = parsed as FastenerScenarioInput;
      const { binding: _unverifiedBinding, ...scenario } = supplied;
      const input = structuredClone(scenario) as FastenerScenarioInput;
      return await deps.store.saveFastenerReport(input, labelledFastenerCalculation(input, "Calculation scenario using caller-supplied fastener geometry. "));
    },
  );

  tool(
    "plasticity_calculate_fastener_member_strength",
    "Calculate and persist a screening scenario for one fastener in axial tension, direct shear, and NASA combined tension-shear interaction. Effective areas, plane count, plane location, loads, and material limits must be explicit and traceable.",
    fastenerMemberInputSchema,
    persistent,
    async (parsed) => {
      const input = structuredClone(parsed) as FastenerMemberInput;
      return await deps.store.saveFastenerMemberReport(input, labelledFastenerMemberCalculation(input, "Calculation scenario using caller-supplied fastener data. "));
    },
  );

  tool(
    "plasticity_calculate_tongue_root_strength",
    "Calculate and persist a root-only screening scenario for a rectangular tongue under transverse point load. Requires traceable geometry, load, orientation-matched effective material properties, allowables, shear correction factor, safety factor, and deflection limit. A result never validates the complete tongue-and-groove joint.",
    tongueRootInputSchema,
    persistent,
    async (parsed) => {
      const input = structuredClone(parsed) as TongueRootInput;
      return await deps.store.saveTongueRootReport(input, labelledTongueRootCalculation(input, "Calculation scenario using caller-supplied geometry and properties. "));
    },
  );

  tool(
    "plasticity_calculate_tongue_root_strength_from_coupon_data",
    "Resolve one exact physical coupon record by printer/material/profile hash/orientation/infill percentage and pattern/wall loops/top-bottom shell layers/temperature, copy only its measured Young's and shear moduli plus source evidence, and calculate a labelled tongue-root scenario. Tensile and shear design allowables must still be supplied with independent evidence and an applicability basis. No-match or ambiguity returns without saving a calculation; material suitability remains unconfirmed, so this cannot produce a pass.",
    tongueRootCouponInputSchema,
    persistent,
    async (raw) => {
      const resolved = await materializeTongueRootCouponInput(deps, raw);
      if (!resolved.input) return resolved.match;
      const report = await deps.store.saveTongueRootReport(
        resolved.input,
        labelledTongueRootCalculation(resolved.input, `Exact-process coupon record ${resolved.record.id}; moduli copied from its measured properties; design allowables remain separately supplied and material suitability remains unconfirmed. `),
      );
      return { status: "calculated-conditional", couponRecordId: resolved.record.id, report };
    },
  );

  tool(
    "plasticity_verify_tongue_root_strength",
    "Re-read the bound exact native section, replace root width and thickness with measured B-rep dimensions, calculate and persist a CAD-bound root-only screening report, then recheck the live section before saving. This does not validate the complete tongue-and-groove joint.",
    tongueRootVerifySchema,
    persistent,
    async ({ input: supplied }) => {
      const input = structuredClone(supplied) as TongueRootInput;
      const expected = input.binding!;
      const section = await deps.inspectArbitrarySection({ bodyId: expected.bodyId, revision: expected.revision, plane: expected.plane });
      if (section.status !== "verified" || !section.properties || !section.loops) {
        throw new Error(`Native tongue-root section is unsupported: ${section.reasons.join(", ") || "unknown reason"}`);
      }
      assertSameTongueRootBinding(expected, section.binding, "Tongue-root section binding is stale");
      const verifiedInput = withMeasuredTongueRootGeometry(input, section);
      const calculation = labelledTongueRootCalculation(verifiedInput, "Verified current native B-rep rectangular root section; load, lever arm and material remain scenario inputs. ");
      const after = await deps.inspectArbitrarySection({
        bodyId: section.binding.bodyId,
        revision: section.binding.revision,
        plane: section.binding.plane,
      });
      if (after.status !== "verified") throw new Error("Tongue-root section could not be revalidated before saving");
      assertSameTongueRootBinding(section.binding, after.binding, "Plasticity document changed during tongue-root verification");
      return await deps.store.saveTongueRootReport(verifiedInput, calculation);
    },
  );

  tool(
    "plasticity_verify_tongue_root_strength_from_coupon_data",
    "Use an exact process-matched physical coupon record for the measured moduli, keep separately evidenced design allowables unconfirmed, re-read the bound arbitrary-plane native section, replace root dimensions with exact B-rep measurements, and recheck the same session/document/revision/topology before saving. No-match or ambiguity returns without modifying CAD or saving a calculation. A result never validates the complete tongue-and-groove joint.",
    tongueRootCouponVerifySchema,
    persistent,
    async (raw) => {
      const resolved = await materializeTongueRootCouponInput(deps, raw);
      if (!resolved.input) return resolved.match;
      const input = resolved.input;
      const expected = input.binding!;
      const section = await deps.inspectArbitrarySection({ bodyId: expected.bodyId, revision: expected.revision, plane: expected.plane });
      if (section.status !== "verified" || !section.properties || !section.loops) {
        throw new Error(`Native tongue-root section is unsupported: ${section.reasons.join(", ") || "unknown reason"}`);
      }
      assertSameTongueRootBinding(expected, section.binding, "Tongue-root section binding is stale");
      const verifiedInput = withMeasuredTongueRootGeometry(input, section);
      const calculation = labelledTongueRootCalculation(verifiedInput, `Verified native B-rep section with exact-process coupon record ${resolved.record.id}; design allowables remain separately supplied and material suitability remains unconfirmed. `);
      const after = await deps.inspectArbitrarySection({
        bodyId: section.binding.bodyId,
        revision: section.binding.revision,
        plane: section.binding.plane,
      });
      if (after.status !== "verified") throw new Error("Tongue-root section could not be revalidated before saving");
      assertSameTongueRootBinding(section.binding, after.binding, "Plasticity document changed during tongue-root verification");
      const report = await deps.store.saveTongueRootReport(verifiedInput, calculation);
      return { status: "calculated-conditional", couponRecordId: resolved.record.id, report };
    },
  );

  tool(
    "plasticity_calculate_threaded_receiver_strength",
    "Calculate and persist axial stripping and tensile-failure checks for one tapped hole, nut, or threaded insert. All three allowable loads, engagement, fully formed thread count, load, and evidence must be explicit; nominal M size alone never supplies capacity.",
    threadedReceiverInputSchema,
    persistent,
    async (parsed) => {
      const input = structuredClone(parsed) as ThreadedReceiverInput;
      return await deps.store.saveThreadedReceiverReport(input, labelledThreadedReceiverCalculation(input, "Calculation scenario using caller-supplied threaded-receiver data. "));
    },
  );

  tool(
    "plasticity_calculate_heat_set_insert_retention",
    "Calculate and persist independent pullout and torque-out screening for one installed heat-set insert. Qualification capacities must match the insert, host, print, pocket, and installation process; simultaneous modes remain conditional.",
    insertRetentionInputSchema,
    persistent,
    async (parsed) => {
      const input = structuredClone(parsed) as InsertRetentionInput;
      return await deps.store.saveInsertRetentionReport(input, labelledInsertRetentionCalculation(input, "Calculation scenario using caller-supplied insert qualification data. "));
    },
  );

  tool(
    "plasticity_distribute_fastener_group_load",
    "Calculate and persist elastic in-plane force and moment distribution for a caller-described rigid group of identical-stiffness fasteners. Any supplied CAD binding is removed. Loads are distributed exactly as supplied with no safety factor. Optionally provide a traceable design allowable in N for every exact fastener configuration in shearCapacities; each allowable must already include its required safety factor. This adds an individual fastener shear-only screen, not a joint or plate strength pass. Without these records, the tool reports load demand only.",
    fastenerGroupInputSchema,
    persistent,
    async (parsed) => {
      const supplied = parsed as FastenerGroupInput;
      const { binding: _unverifiedBinding, ...scenario } = supplied;
      const input = structuredClone(scenario) as FastenerGroupInput;
      return await deps.store.saveFastenerGroupReport(input, labelledFastenerGroupCalculation(input, "Calculation scenario using caller-supplied fastener locations and load resultant. "));
    },
  );

  tool(
    "plasticity_verify_fastener_group_load",
    "Re-read exact cylindrical faces from one current Solid, replace caller fastener coordinates with native B-Rep axis centers, calculate the in-plane load distribution and persist a CAD-bound report. Optionally compare each demand with a traceable configuration-matched shear design allowable that already includes the required safety factor. The optional screen covers fastener shear only, never joined-plate or whole-joint strength. It does not mutate CAD.",
    fastenerGroupInputSchema,
    persistent,
    async (parsed) => {
      const input = parsed as FastenerGroupInput;
      if (!input.binding) throw new Error("verify_fastener_group_load requires input.binding");
      const measured = await deps.inspectFastenerGroup({
        bodyId: input.binding.bodyId,
        cylindricalFaceIds: input.binding.cylindricalFaceIds,
        frame: {
          originMm: input.binding.frame.originMm,
          normal: input.binding.frame.normal,
          xDirection: input.binding.frame.xDirection,
        },
        revision: input.binding.revision,
      });
      if (measured.status !== "verified" || !measured.fasteners) {
        throw new Error(`Fastener-group geometry is unsupported: ${measured.reasons.join(", ") || "unknown reason"}`);
      }
      assertSameFastenerGroupBinding(input.binding, measured.binding, "Input fastener-group binding is stale");
      const verifiedInput = withMeasuredFastenerGroup(input, measured);
      const calculation = labelledFastenerGroupCalculation(verifiedInput, "Verified current native B-rep fastener group. ");
      const after = await deps.readFastenerGroupBinding({
        bodyId: measured.binding.bodyId,
        cylindricalFaceIds: measured.binding.cylindricalFaceIds,
        frame: {
          originMm: measured.binding.frame.originMm,
          normal: measured.binding.frame.normal,
          xDirection: measured.binding.frame.xDirection,
        },
      });
      assertSameFastenerGroupBinding(measured.binding, after, "Plasticity document changed during fastener-group verification");
      return await deps.store.saveFastenerGroupReport(verifiedInput, calculation);
    },
  );

  registerFastenerGroupPlateBearingTool(tool, deps, readonly);

  tool(
    "plasticity_verify_member_strength",
    `Verify exact current rectangular B-rep dimensions for a member or separate plate body, append measured evidence, recalculate and persist a CAD-bound report. It does not mutate CAD. ${STRENGTH_CORE_DESCRIPTION}`,
    verifySchema,
    persistent,
    async ({ input: parsed, lengthAxis, heightAxis }) => {
      const input = parsed as StrengthInput;
      if (!input.binding) throw new Error("verify_member_strength requires input.binding");
      const before = await deps.readCadBinding(input.binding.bodyId);
      assertSameBinding(input.binding, before, "Input CAD binding is stale");
      const member = await deps.inspectMember({ bodyId: before.bodyId, revision: before.revision, lengthAxis, heightAxis });
      if (member.status !== "verified" || !member.dimensions) {
        throw new Error(`Rectangular member is unsupported: ${member.reasons.join(", ") || "unknown reason"}`);
      }
      assertSameBinding(before, member.binding, "Geometry evidence binding changed");
      const verifiedInput = withMeasuredDimensions(input, member);
      const calculation = cautiousCalculation(verifiedInput, "Verified current native B-rep rectangular member. ");
      const after = await deps.readCadBinding(before.bodyId);
      assertSameBinding(member.binding, after, "Plasticity document changed during strength verification");
      return await deps.store.saveReport(verifiedInput, calculation);
    },
  );

  tool(
    "plasticity_verify_integral_plate_strength",
    `Re-read exact opposed planar faces of an integral enclosure wall, replace plate dimensions with measured native geometry, calculate the uniform-pressure plate scenario and persist a CAD-bound report. All four simple supports remain an explicit engineering assumption. ${STRENGTH_CORE_DESCRIPTION}`,
    integralPlateVerifySchema,
    persistent,
    async ({ input: parsed, frontFaceId, backFaceId, xDirection }) => {
      const input = parsed as StrengthInput;
      if (input.method !== "simply-supported-plate-uniform-pressure-v1") {
        throw new Error("Integral plate verification requires simply-supported-plate-uniform-pressure-v1");
      }
      if (!input.binding) throw new Error("verify_integral_plate_strength requires input.binding");
      const before = await deps.readCadBinding(input.binding.bodyId);
      assertSameBinding(input.binding, before, "Input CAD binding is stale");
      const request: IntegralPlateRequest = {
        bodyId: before.bodyId,
        frontFaceId,
        backFaceId,
        revision: before.revision,
        xDirection,
      };
      const panel = await deps.inspectIntegralPlate(request);
      if (panel.status !== "verified" || !panel.geometry) {
        throw new Error(`Integral rectangular plate is unsupported: ${panel.reasons.join(", ") || "unknown reason"}`);
      }
      assertSameBinding(before, panel.binding, "Geometry evidence binding changed");
      const measured: MemberEvidence = {
        binding: panel.binding,
        status: "verified",
        dimensions: {
          lengthMm: panel.geometry.lengthMm,
          widthMm: panel.geometry.widthMm,
          heightMm: panel.geometry.thicknessMm,
        },
        source: "native-brep",
        reasons: [],
      };
      const verifiedInput = withMeasuredDimensions(input, measured);
      const calculation = cautiousCalculation(verifiedInput, "Verified current integral native B-rep enclosure wall. ");
      const after = await deps.readCadBinding(before.bodyId);
      assertSameBinding(panel.binding, after, "Plasticity document changed during integral plate verification");
      return await deps.store.saveReport(verifiedInput, calculation);
    },
  );

  tool(
    "plasticity_verify_section_strength",
    `Re-read an exact native planar face or arbitrary plane through a Solid, replace section geometry with measured evidence, calculate and persist a CAD-bound report. It does not mutate persistent CAD geometry. ${STRENGTH_CORE_DESCRIPTION}`,
    sectionScenarioInputSchema,
    persistent,
    async (parsed) => {
      const input = parsed as SectionScenarioInput;
      if (!input.binding) throw new Error("verify_section_strength requires input.binding");
      let section: SectionEvidence | ArbitrarySectionEvidence;
      if (input.binding.faceId) {
        section = await deps.inspectSection({
          bodyId: input.binding.bodyId,
          faceId: input.binding.faceId,
          revision: input.binding.revision,
          xDirection: input.frame.xDirection,
        });
      } else if (input.binding.plane) {
        section = await deps.inspectArbitrarySection({
          bodyId: input.binding.bodyId,
          revision: input.binding.revision,
          plane: input.binding.plane,
        });
      } else {
        throw new Error("Section binding must identify a current face or arbitrary plane");
      }
      if (section.status !== "verified" || !section.frame || !section.properties || !section.loops) {
        throw new Error(`Native section is unsupported: ${section.reasons.join(", ") || "unknown reason"}`);
      }
      assertSameSectionBinding(input.binding, section.binding, "Input section binding is stale");
      const verifiedInput = withMeasuredSection(input, section);
      const calculation = labelledSectionCalculation(verifiedInput, section.binding.faceId
        ? "Verified current native B-rep planar face section. "
        : "Verified current native B-rep arbitrary-plane section. ");
      const after = section.binding.faceId
        ? await deps.readSectionBinding({
          bodyId: section.binding.bodyId,
          faceId: section.binding.faceId,
          xDirection: section.frame.xDirection,
        })
        : await deps.inspectArbitrarySection({
          bodyId: section.binding.bodyId,
          revision: section.binding.revision,
          plane: section.binding.plane!,
        }).then((evidence) => evidence.binding);
      assertSameSectionBinding(section.binding, after, "Plasticity document changed during section verification");
      return await deps.store.saveSectionReport(verifiedInput, calculation);
    },
  );

  tool(
    "plasticity_verify_single_fastener_strength",
    `Re-read exact opposed native faces of one rectangular through-hole plate, replace all caller geometry, calculate three plate failure modes and persist a CAD-bound report. It does not mutate CAD. ${STRENGTH_CORE_DESCRIPTION}`,
    fastenerScenarioInputSchema,
    persistent,
    async (parsed) => {
      const input = parsed as FastenerScenarioInput;
      if (!input.binding) throw new Error("verify_single_fastener_strength requires input.binding");
      const geometry = await deps.inspectFastenerPlate({
        bodyId: input.binding.bodyId,
        frontFaceId: input.binding.frontFaceId,
        backFaceId: input.binding.backFaceId,
        revision: input.binding.revision,
        loadDirection: input.binding.loadDirection,
      });
      if (geometry.status !== "verified" || !geometry.geometry) {
        throw new Error(`Single-fastener plate is unsupported: ${geometry.reasons.join(", ") || "unknown reason"}`);
      }
      assertSameFastenerBinding(input.binding, geometry.binding, "Input fastener binding is stale");
      const verifiedInput = withMeasuredFastenerGeometry(input, geometry);
      const calculation = labelledFastenerCalculation(verifiedInput, "Verified current native B-rep single-fastener plate. ");
      const after = await deps.readFastenerBinding({
        bodyId: geometry.binding.bodyId,
        frontFaceId: geometry.binding.frontFaceId,
        backFaceId: geometry.binding.backFaceId,
        loadDirection: geometry.binding.loadDirection,
      });
      assertSameFastenerBinding(geometry.binding, after, "Plasticity document changed during fastener verification");
      return await deps.store.saveFastenerReport(verifiedInput, calculation);
    },
  );

  tool(
    "plasticity_strength_report",
    "Read an immutable report and evaluate freshness against optional current task/material inputs and live CAD identity for bound reports.",
    reportSchema,
    readonly,
    async ({ reportId, current }) => {
      const report = await deps.store.readReport(reportId);
      return await liveReportView(report, current as ReportInput | undefined, deps);
    },
  );

  server.registerPrompt("plasticity_strength_first", {
    description: "Guide Codex through evidence-first strength analysis before a logical CAD action.",
    argsSchema: { task: z.string().trim().min(1).max(4_000).optional() },
  }, ({ task }) => ({ messages: [{ role: "user", content: { type: "text", text: strengthPrompt(task) } }] }));

  server.registerPrompt("plasticity_design_from_reference", {
    description: "Guide Codex through evidence-first functional CAD intake from a photo or sketch before a logical modeling action.",
    argsSchema: { task: z.string().trim().min(1).max(4_000).optional() },
  }, ({ task }) => ({ messages: [{ role: "user", content: { type: "text", text: designReferencePrompt(task) } }] }));

  registerTextResource(server, "plasticity-design-reference-workflow", "plasticity://design/reference-workflow", "Reference image intake, uncertainty and staged CAD decisions", DESIGN_REFERENCE_WORKFLOW_RESOURCE);
  registerTextResource(server, "plasticity-strength-workflow", "plasticity://strength/workflow", "Strength-first workflow and worked examples", STRENGTH_WORKFLOW_RESOURCE);
  registerTextResource(server, "plasticity-strength-interlayer-literature-baseline", "plasticity://strength/interlayer-literature-baseline", "Separate Creality CR-PLA and Hyper PLA references plus generic-PLA interlayer fracture evidence, with strict qualification limits", STRENGTH_INTERLAYER_BASELINE_RESOURCE);
  registerTextResource(server, "plasticity-strength-methods", "plasticity://strength/methods", "Versioned strength method passports", STRENGTH_METHODS_RESOURCE);
  registerTextResource(server, "plasticity-strength-recovery", "plasticity://strength/recovery", "Recovery after interrupted analysis or stale CAD", STRENGTH_RECOVERY_RESOURCE);
}

const STRENGTH_CORE_DESCRIPTION = STRENGTH_CORE_WORKFLOW;

function withMeasuredDimensions(input: StrengthInput, member: MemberEvidence): StrengthInput {
  if (!member.dimensions || member.status !== "verified") throw new Error("Verified dimensions are required");
  const locator = `plasticity:${member.binding.documentToken}#body=${member.binding.bodyId}@${member.binding.revision}`;
  const records: Array<["lengthMm" | "widthMm" | "heightMm", number]> = [
    ["lengthMm", member.dimensions.lengthMm],
    ["widthMm", member.dimensions.widthMm],
    ["heightMm", member.dimensions.heightMm],
  ];
  const added: Evidence[] = records.map(([path, value]) => ({
    id: `native-${path}-${randomUUID()}`,
    label: `Exact native B-rep ${path} measurement`,
    status: "measured",
    unit: "mm",
    value,
    sourceLocator: locator,
    dependsOn: [],
  }));
  const assignments = { ...input.assignments };
  for (const [index, [path]] of records.entries()) assignments[path] = added[index]!.id;
  return {
    ...structuredClone(input),
    ...member.dimensions,
    binding: { ...member.binding },
    evidence: [...input.evidence.map((item) => ({ ...item, dependsOn: [...item.dependsOn] })), ...added],
    assignments,
  };
}

function cautiousCalculation(input: StrengthInput, label: string): Calculation {
  const calculated = calculate(input);
  const materialRecords = input.material.evidenceIds.map((id) => input.evidence.find((item) => item.id === id));
  const materialSupportVerified = materialRecords.length > 0 && materialRecords.every((item) =>
    item !== undefined && (item.status === "sourced" || item.status === "measured") && item.sourceUrl !== undefined && item.sourceHash !== undefined
  );
  const needsCaution = input.material.suitability === "matched" && !materialSupportVerified;
  return {
    ...calculated,
    status: needsCaution && calculated.status === "pass" ? "conditional" : calculated.status,
    checkedScope: `${label}${calculated.checkedScope}`,
    issues: needsCaution
      ? [...calculated.issues, {
        code: "MATERIAL_MATCH_UNVERIFIED",
        message: "Matched material properties are caller-supplied claims without independently recorded source hashes.",
        evidenceIds: [...input.material.evidenceIds],
      }]
      : calculated.issues,
  };
}

function labelledSectionCalculation(input: SectionScenarioInput, label: string): SectionCalculation {
  const calculated = calculateSection(input);
  return { ...calculated, checkedScope: `${label}${calculated.checkedScope}` };
}

function labelledFastenerCalculation(input: FastenerScenarioInput, label: string): ReturnType<typeof calculateSingleFastener> {
  const calculated = calculateSingleFastener(input);
  return { ...calculated, checkedScope: `${label}${calculated.checkedScope}` };
}

function labelledFastenerMemberCalculation(input: FastenerMemberInput, label: string): ReturnType<typeof calculateFastenerMember> {
  const calculated = calculateFastenerMember(input);
  return { ...calculated, checkedScope: `${label}${calculated.checkedScope}` };
}

function labelledTongueRootCalculation(input: TongueRootInput, label: string): ReturnType<typeof calculateTongueRoot> {
  const calculated = calculateTongueRoot(input);
  return { ...calculated, checkedScope: `${label}${calculated.checkedScope}` };
}

async function materializeTongueRootCouponInput(
  deps: StrengthDependencies,
  raw: TongueRootCouponInput,
): Promise<
  | { match: MaterialCouponQualificationMatch; record: null; input: null }
  | { match: MaterialCouponQualificationMatch; record: MaterialCouponQualificationRecord; input: TongueRootInput }
> {
  const match = await deps.store.materialQualifications.match({ process: raw.process });
  if (match.status !== "matched" || !match.selected) return { match, record: null, input: null };
  const record = match.selected;
  if (record.properties.shearModulusMPa === undefined || !record.propertyEvidence.shearModulusMPa) {
    throw new Error("Tongue-root needs measured coupon shear modulus and evidence");
  }
  const scenarioEvidenceIds = new Set(raw.scenario.evidence.map((item) => item.id));
  const duplicateIds = record.evidence.filter((item) => scenarioEvidenceIds.has(item.id)).map((item) => item.id);
  if (duplicateIds.length > 0) throw new Error(`Coupon and scenario evidence IDs overlap: ${duplicateIds.join(", ")}`);
  const youngEvidenceId = record.propertyEvidence.youngModulusMPa[0]!;
  const shearEvidenceId = record.propertyEvidence.shearModulusMPa[0]!;
  const assignments = {
    ...raw.scenario.assignments,
    "material.youngModulusMPa": youngEvidenceId,
    "material.shearModulusMPa": shearEvidenceId,
  };
  const allowanceEvidenceIds = [
    raw.scenario.assignments["material.tensileAllowableMPa"],
    raw.scenario.assignments["material.shearAllowableMPa"],
  ].filter((id): id is string => id !== undefined);
  const couponEvidenceIds = Object.values(record.propertyEvidence).flatMap((ids) => ids ?? []);
  const input = tongueRootInputSchema.parse({
    ...raw.scenario,
    material: {
      id: raw.process.materialId,
      name: raw.process.materialId,
      youngModulusMPa: record.properties.youngModulusMPa,
      shearModulusMPa: record.properties.shearModulusMPa,
      tensileAllowableMPa: raw.allowables.tensileMPa,
      shearAllowableMPa: raw.allowables.shearMPa,
      suitability: "unconfirmed",
      evidenceIds: [...new Set([...couponEvidenceIds, ...allowanceEvidenceIds])],
      couponRecordId: record.id,
      allowablesBasis: raw.allowablesBasis,
      manufacturing: {
        printerId: raw.process.printerId,
        profileHash: raw.process.profileHash,
        orientationDeg: raw.process.orientationDeg,
        infillPercent: raw.process.infillPercent,
        temperatureC: raw.process.nozzleTemperatureC,
        effectiveSection: raw.effectiveSection,
      },
    },
    evidence: [...raw.scenario.evidence, ...record.evidence],
    assignments,
  }) as TongueRootInput;
  return { match, record, input };
}

function labelledThreadedReceiverCalculation(input: ThreadedReceiverInput, label: string): ReturnType<typeof calculateThreadedReceiver> {
  const calculated = calculateThreadedReceiver(input);
  return { ...calculated, checkedScope: `${label}${calculated.checkedScope}` };
}

function labelledInsertRetentionCalculation(input: InsertRetentionInput, label: string): ReturnType<typeof calculateInsertRetention> {
  const calculated = calculateInsertRetention(input);
  return { ...calculated, checkedScope: `${label}${calculated.checkedScope}` };
}

function labelledFastenerGroupCalculation(input: FastenerGroupInput, label: string): ReturnType<typeof calculateFastenerGroupLoad> {
  const calculated = calculateFastenerGroupLoad(input);
  return { ...calculated, checkedScope: `${label}${calculated.checkedScope}` };
}

type SectionScenarioSeed = Pick<SectionScenarioInput,
  "kind" | "goal" | "method" | "pointForces" | "freeMoments" | "material" | "safetyFactor" | "evidence" | "assignments" | "assumptions"
>;

function withMeasuredSection(input: SectionScenarioSeed | SectionScenarioInput, section: SectionEvidence | ArbitrarySectionEvidence): SectionScenarioInput {
  if (section.status !== "verified" || !section.frame || !section.properties || !section.loops) {
    throw new Error("Verified section geometry is required");
  }
  const { centroidMm: _centroidMm, source: _source, ...properties } = section.properties;
  const sectionLocator = section.binding.faceId
    ? `face=${section.binding.faceId}`
    : `section=${section.binding.topologySignature}`;
  const locator = `plasticity:${section.binding.documentToken}#body=${section.binding.bodyId}&${sectionLocator}@${section.binding.revision}`;
  const records: Array<[string, number, NonNullable<Evidence["unit"]>]> = [
    ["properties.areaMm2", properties.areaMm2, "mm2"],
    ["properties.centroidLocalMm.x", properties.centroidLocalMm[0], "mm"],
    ["properties.centroidLocalMm.y", properties.centroidLocalMm[1], "mm"],
    ["properties.ixxMm4", properties.ixxMm4, "mm4"],
    ["properties.iyyMm4", properties.iyyMm4, "mm4"],
    ["properties.ixyMm4", properties.ixyMm4, "mm4"],
  ];
  const measured: Evidence[] = records.map(([path, value, unit]) => ({
    id: `native-${path.replaceAll(/[^A-Za-z0-9]+/g, "-")}-${randomUUID()}`,
    label: `Exact native B-rep ${path} measurement`,
    status: "measured",
    unit,
    value,
    sourceLocator: locator,
    dependsOn: [],
  }));
  const assignments = { ...input.assignments };
  for (const [index, [path]] of records.entries()) assignments[path] = measured[index]!.id;
  const { safetyFactor, ...base } = structuredClone(input);
  return {
    ...base,
    ...(safetyFactor === undefined ? {} : { safetyFactor }),
    frame: structuredClone(section.frame),
    loops: structuredClone(section.loops),
    properties: structuredClone(properties),
    binding: { ...section.binding },
    evidence: [...input.evidence.map((item) => ({ ...item, dependsOn: [...item.dependsOn] })), ...measured],
    assignments,
  };
}

function withMeasuredTongueRootGeometry(input: TongueRootInput, section: ArbitrarySectionEvidence): TongueRootInput {
  if (section.status !== "verified" || !section.properties || !section.loops) throw new Error("Verified native section geometry is required");
  const dimensions = rectangularRootDimensions(section.loops, section.properties);
  const locator = `plasticity:${section.binding.documentToken}#body=${section.binding.bodyId}&section=${section.binding.topologySignature}@${section.binding.revision}`;
  const records: Array<[string, number]> = [
    ["geometry.rootWidthMm", dimensions.rootWidthMm],
    ["geometry.rootThicknessMm", dimensions.rootThicknessMm],
  ];
  const evidence: Evidence[] = records.map(([path, value]) => ({
    id: `native-${path.replaceAll(/[^A-Za-z0-9]+/g, "-")}-${randomUUID()}`,
    label: `Exact native B-rep ${path} measurement`,
    status: "measured",
    unit: "mm",
    value,
    sourceLocator: locator,
    dependsOn: [],
  }));
  const assignments = { ...input.assignments };
  records.forEach(([path], index) => { assignments[path] = evidence[index]!.id; });
  return {
    ...structuredClone(input),
    geometry: { ...input.geometry, ...dimensions },
    binding: structuredClone(section.binding) as TongueRootBinding,
    evidence: [...input.evidence.map((item) => ({ ...item, dependsOn: [...item.dependsOn] })), ...evidence],
    assignments,
  };
}

function withMeasuredFastenerGeometry(input: FastenerScenarioInput, measured: FastenerPlateEvidence): FastenerScenarioInput {
  if (measured.status !== "verified" || !measured.geometry) throw new Error("Verified fastener geometry is required");
  const locator = `plasticity:${measured.binding.documentToken}#body=${measured.binding.bodyId}&front=${measured.binding.frontFaceId}&back=${measured.binding.backFaceId}@${measured.binding.revision}`;
  const records: Array<[string, number]> = [
    ["geometry.thicknessMm", measured.geometry.thicknessMm],
    ["geometry.holeDiameterMm", measured.geometry.holeDiameterMm],
    ["geometry.loadedEdgeDistanceMm", measured.geometry.loadedEdgeDistanceMm],
    ["geometry.oppositeEdgeDistanceMm", measured.geometry.oppositeEdgeDistanceMm],
    ["geometry.grossWidthMm", measured.geometry.grossWidthMm],
    ["geometry.sideClearancesMm.0", measured.geometry.sideClearancesMm[0]],
    ["geometry.sideClearancesMm.1", measured.geometry.sideClearancesMm[1]],
  ];
  const evidence: Evidence[] = records.map(([path, value]) => ({
    id: `native-${path.replaceAll(/[^A-Za-z0-9]+/g, "-")}-${randomUUID()}`,
    label: `Exact native B-rep ${path} measurement`,
    status: "measured",
    unit: "mm",
    value,
    sourceLocator: locator,
    dependsOn: [],
  }));
  const assignments = { ...input.assignments };
  records.forEach(([path], index) => { assignments[path] = evidence[index]!.id; });
  return {
    ...structuredClone(input),
    geometry: structuredClone(measured.geometry),
    binding: structuredClone(measured.binding),
    evidence: [...input.evidence.map((item) => ({ ...item, dependsOn: [...item.dependsOn] })), ...evidence],
    assignments,
  };
}

async function liveReportView(
  report: StoredReport,
  current: ReportInput | undefined,
  deps: StrengthDependencies,
): Promise<ReportView> {
  if ("kind" in report && report.kind === "fastener-group-plate-bearing") {
    return { report: structuredClone(report), freshness: "unverified", reasons: ["USE_FASTENER_GROUP_PLATE_BEARING_REPORT_TOOL"] };
  }
  const view = reportView(report, current);
  if (!report.input.binding) return view;
  const reasons = new Set(view.reasons);
  try {
    if (isSectionInput(report.input)) {
      if (report.input.binding.faceId) {
        const live = await deps.readSectionBinding({
          bodyId: report.input.binding.bodyId,
          faceId: report.input.binding.faceId,
          xDirection: report.input.frame.xDirection,
        });
        addSectionBindingReasons(report.input.binding, live, reasons);
      } else if (report.input.binding.plane) {
        const live = await deps.inspectArbitrarySection({
          bodyId: report.input.binding.bodyId,
          revision: report.input.binding.revision,
          plane: report.input.binding.plane,
        });
        addSectionBindingReasons(report.input.binding, live.binding, reasons);
      } else reasons.add("CAD_BINDING_INVALID");
    } else if (isFastenerInput(report.input)) {
      const live = await deps.readFastenerBinding({
        bodyId: report.input.binding.bodyId,
        frontFaceId: report.input.binding.frontFaceId,
        backFaceId: report.input.binding.backFaceId,
        loadDirection: report.input.binding.loadDirection,
      });
      addFastenerBindingReasons(report.input.binding, live, reasons);
    } else if (isFastenerGroupInput(report.input)) {
      const live = await deps.readFastenerGroupBinding({
        bodyId: report.input.binding.bodyId,
        cylindricalFaceIds: report.input.binding.cylindricalFaceIds,
        frame: {
          originMm: report.input.binding.frame.originMm,
          normal: report.input.binding.frame.normal,
          xDirection: report.input.binding.frame.xDirection,
        },
      });
      addFastenerGroupBindingReasons(report.input.binding, live, reasons);
    } else if (isTongueRootInput(report.input)) {
      if (!report.input.binding.plane) reasons.add("CAD_BINDING_INVALID");
      else {
        const live = await deps.inspectArbitrarySection({
          bodyId: report.input.binding.bodyId,
          revision: report.input.binding.revision,
          plane: report.input.binding.plane,
        });
        if (live.status !== "verified") reasons.add("CAD_TOPOLOGY_CHANGED");
        addTongueRootBindingReasons(report.input.binding, live.binding, reasons);
      }
    } else {
      const live = await deps.readCadBinding(report.input.binding.bodyId);
      addBindingReasons(report.input.binding, live, reasons);
    }
  } catch {
    reasons.add("CAD_SESSION_UNAVAILABLE");
  }
  const list = [...reasons];
  const cadStale = list.some((reason) => reason.startsWith("CAD_") && reason !== "CAD_SESSION_UNAVAILABLE");
  const cadUnavailable = reasons.has("CAD_SESSION_UNAVAILABLE");
  return {
    report: view.report,
    freshness: cadStale || view.freshness === "stale"
      ? "stale"
      : cadUnavailable
        ? "unverified"
        : view.freshness,
    reasons: list,
  };
}

async function inspectSectionCandidates(
  deps: StrengthDependencies,
  bodyId: number,
  revision: string,
  planes: ArbitrarySectionRequest["plane"][],
): Promise<{ status: "complete"; binding: CadBinding; sections: ArbitrarySectionEvidence[] }> {
  const initial = await deps.readCadBinding(bodyId);
  const expected = { ...initial, bodyId, revision };
  assertSameCadContext({ ...initial, bodyId }, expected, "Requested section revision is stale");
  const sections: ArbitrarySectionEvidence[] = [];
  for (const plane of planes) {
    const section = await deps.inspectArbitrarySection({ bodyId, revision, plane });
    assertSameCadContext(section.binding, expected, "Plasticity changed during candidate section inspection");
    sections.push(section);
  }
  const final = await deps.readCadBinding(bodyId);
  assertSameCadContext({ ...final, bodyId }, expected, "Plasticity changed during candidate section inspection");
  return { status: "complete", binding: { ...initial, bodyId }, sections };
}

function generateSectionStations(
  startPlane: ArbitrarySectionRequest["plane"],
  fromOffsetMm: number,
  toOffsetMm: number,
  stationCount: number,
): { planes: ArbitrarySectionRequest["plane"][]; spacingMm: number } {
  const normalLength = Math.hypot(...startPlane.normal);
  if (!Number.isFinite(normalLength) || normalLength <= 1e-9) throw new Error("Section scan normal must have a usable finite length");
  const normal = startPlane.normal.map((component) => component / normalLength) as [number, number, number];
  const spacingMm = (toOffsetMm - fromOffsetMm) / (stationCount - 1);
  if (!Number.isFinite(spacingMm) || spacingMm <= 0) throw new Error("Section scan spacing must be finite and positive");
  const planes = Array.from({ length: stationCount }, (_, index) => {
    const offset = fromOffsetMm + spacingMm * index;
    return {
      ...startPlane,
      originMm: startPlane.originMm.map((component, axis) => component + normal[axis]! * offset) as [number, number, number],
    };
  });
  return { planes, spacingMm };
}

function sectionUtilization(calculation: SectionCalculation): { value: number; component: string } | undefined {
  const available: Array<{ component: string; value: number }> = [];
  for (const [component, value] of [
    ["tension", calculation.tensileUtilization],
    ["compression", calculation.compressiveUtilization],
    ["direct-shear", calculation.shearUtilization],
    ["torsion", calculation.torsionUtilization],
  ] as const) {
    if (value !== undefined && Number.isFinite(value) && value >= 0) available.push({ component, value });
  }
  available.sort((left, right) => right.value - left.value);
  return available[0];
}

function assertSameBinding(expected: CadBinding, current: CadBinding, message: string): void {
  const reasons = new Set<string>();
  addBindingReasons(expected, current, reasons);
  if (reasons.size > 0) throw new Error(`${message}: ${[...reasons].join(", ")}`);
}

function assertSameCadContext(
  current: Pick<CadBinding, "sessionId" | "documentToken" | "revision" | "bodyId">,
  expected: Pick<CadBinding, "sessionId" | "documentToken" | "revision" | "bodyId">,
  message: string,
): void {
  const reasons: string[] = [];
  if (current.sessionId !== expected.sessionId) reasons.push("CAD_SESSION_CHANGED");
  if (current.documentToken !== expected.documentToken) reasons.push("CAD_DOCUMENT_CHANGED");
  if (current.revision !== expected.revision) reasons.push("CAD_REVISION_CHANGED");
  if (current.bodyId !== expected.bodyId) reasons.push("CAD_BODY_CHANGED");
  if (reasons.length > 0) throw new Error(`${message}: ${reasons.join(", ")}`);
}

function assertSameSectionBinding(expected: SectionBinding, current: SectionBinding, message: string): void {
  const reasons = new Set<string>();
  addSectionBindingReasons(expected, current, reasons);
  if (reasons.size > 0) throw new Error(`${message}: ${[...reasons].join(", ")}`);
}

function assertSameTongueRootBinding(expected: TongueRootBinding, current: TongueRootBinding, message: string): void {
  const reasons = new Set<string>();
  addTongueRootBindingReasons(expected, current, reasons);
  if (reasons.size > 0) throw new Error(`${message}: ${[...reasons].join(", ")}`);
}

function addTongueRootBindingReasons(expected: TongueRootBinding, current: TongueRootBinding, reasons: Set<string>): void {
  addBindingReasons(expected, current, reasons);
  if (expected.topologySignature !== current.topologySignature) reasons.add("CAD_TOPOLOGY_CHANGED");
  for (const key of ["originMm", "normal", "xDirection"] as const) {
    if (expected.plane[key].some((value, index) => value !== current.plane[key][index])) reasons.add("CAD_SECTION_PLANE_CHANGED");
  }
}

function addBindingReasons(expected: CadBinding, current: CadBinding, reasons: Set<string>): void {
  if (expected.sessionId !== current.sessionId) reasons.add("CAD_SESSION_CHANGED");
  if (expected.documentToken !== current.documentToken) reasons.add("CAD_DOCUMENT_CHANGED");
  if (expected.revision !== current.revision) reasons.add("CAD_REVISION_CHANGED");
  if (expected.bodyId !== current.bodyId) reasons.add("CAD_BODY_CHANGED");
}

function addSectionBindingReasons(expected: SectionBinding, current: SectionBinding, reasons: Set<string>): void {
  addBindingReasons(expected, current, reasons);
  if (expected.faceId !== current.faceId) reasons.add("CAD_FACE_CHANGED");
  if ((expected.plane === undefined) !== (current.plane === undefined)) reasons.add("CAD_SECTION_SOURCE_CHANGED");
  if (expected.plane && current.plane) {
    for (const key of ["originMm", "normal", "xDirection"] as const) {
      if (expected.plane[key].some((value, index) => value !== current.plane![key][index])) reasons.add("CAD_PLANE_CHANGED");
    }
  }
  if (expected.topologySignature !== current.topologySignature) reasons.add("CAD_TOPOLOGY_CHANGED");
}

function assertSameFastenerBinding(expected: FastenerBinding, current: FastenerBinding, message: string): void {
  const reasons = new Set<string>();
  addFastenerBindingReasons(expected, current, reasons);
  if (reasons.size > 0) throw new Error(`${message}: ${[...reasons].join(", ")}`);
}

function addFastenerBindingReasons(expected: FastenerBinding, current: FastenerBinding, reasons: Set<string>): void {
  addBindingReasons(expected, current, reasons);
  if (expected.frontFaceId !== current.frontFaceId || expected.backFaceId !== current.backFaceId) reasons.add("CAD_FACE_CHANGED");
  if (expected.topologySignature !== current.topologySignature) reasons.add("CAD_TOPOLOGY_CHANGED");
  if (expected.loadDirection.some((value, index) => value !== current.loadDirection[index])) reasons.add("CAD_LOAD_DIRECTION_CHANGED");
}

function isSectionInput(input: ReportInput): input is SectionScenarioInput {
  return "kind" in input && input.kind === "planar-section";
}

function isFastenerInput(input: ReportInput): input is FastenerScenarioInput {
  return "kind" in input && input.kind === "single-fastener-plate";
}

function isFastenerGroupInput(input: ReportInput): input is FastenerGroupInput {
  return "kind" in input && input.kind === "fastener-group-load";
}

function isTongueRootInput(input: ReportInput): input is TongueRootInput {
  return "kind" in input && input.kind === "tongue-root";
}

function registerTextResource(server: McpServer, name: string, uri: string, description: string, text: string): void {
  server.registerResource(name, uri, { description, mimeType: "text/markdown" }, async () => ({
    contents: [{ uri, mimeType: "text/markdown", text }],
  }));
}
