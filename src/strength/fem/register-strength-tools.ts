import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { CadBinding } from "../contracts.ts";
import type { StrengthStore } from "../store.ts";
import type { CohesiveAnalysisRequest, CohesiveAnalysisResult } from "./cohesive-analysis.ts";
import type { CohesiveReportStore } from "./cohesive-report-store.ts";
import type { FemReportContent, FemReportStore, FemStaticInput } from "./fem-report-store.ts";
import { verifyFemCouponBinding } from "./material-binding.ts";
import { registerFemTools } from "./mcp.ts";

export interface StrengthFemToolDependencies {
  store: StrengthStore;
  femReports: FemReportStore;
  cohesiveReports: CohesiveReportStore;
  readCadBinding(bodyId: number): Promise<CadBinding>;
  analyzeStaticFem(input: FemStaticInput, workspace: string, signal: AbortSignal): Promise<FemReportContent>;
  analyzeCohesive(input: CohesiveAnalysisRequest, workspace: string, signal: AbortSignal): Promise<CohesiveAnalysisResult>;
}

export function registerStrengthFemTools(server: McpServer, deps: StrengthFemToolDependencies): void {
  registerFemTools(server, {
    reports: deps.femReports,
    cohesiveReports: deps.cohesiveReports,
    interfaceTests: deps.store.materialInterfaceTests,
    coupons: deps.store.materialQualifications,
    readCadBinding: deps.readCadBinding,
    analyze: deps.analyzeStaticFem,
    analyzeCohesive: deps.analyzeCohesive,
    verifyCoupon: (input) => verifyFemCouponBinding(deps.store.materialQualifications, input),
  });
}
