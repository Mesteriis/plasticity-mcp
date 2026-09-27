import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { strengthToolResult } from "./mcp-response.ts";
import { materialTestPlanInputSchema, planSingleMaterialStrengthTests } from "./material-test-plan.ts";

type ToolAnnotations = { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
type RegisterTool = (
  name: string,
  config: { description: string; inputSchema: z.ZodType; annotations: ToolAnnotations },
  callback: (input: unknown) => Promise<{ content: [{ type: "text"; text: string }] }>,
) => unknown;

export function registerMaterialTestPlanTool(server: McpServer): void {
  const registerTool = server.registerTool.bind(server) as unknown as RegisterTool;
  registerTool("plasticity_plan_single_material_strength_tests", {
    description: "Plan physical measurements for one selected single-material print process and solver scope; no multi-material calculation is supported. Returns required directional coupon, biaxial or same-material layer-interface evidence without inventing property values, material properties or allowables. For DCB it includes a clearly labeled generic-PLA literature geometry/acquisition precedent, not a Creality property, normative specimen size, or sample-count requirement; applicability and specimen sizing must be checked for the exact process and fixture. A focused layer-interface-normal-tension scope plans only a direct peak-strength test; it does not replace Mode-I DCB fracture evidence or calibrate a cohesive law. A focused Mode-II scope plans an ENF compliance-calibration initiation-energy estimate only; it does not claim ASTM D7905 conformity for printed PLA or provide a cohesive input curve. Coupon records require measured E1; ask for other properties only when the selected solver scope needs them. Layer-interface tests concern cohesion between layers of that same material. Initial cohesive stiffness K is MPa/mm evidence supplied directly to plasticity_analyze_cohesive_interface, not stored in the MPa interface-peak registry. Requires exact printer/material/profile/orientation/infill-percentage-and-pattern/wall-loops/top-and-bottom-shell-layers/nozzle-temperature/measured-layer-height identity; print-axis mapping and interface directions must be confirmed.",
    inputSchema: materialTestPlanInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async (raw) => strengthToolResult(planSingleMaterialStrengthTests(materialTestPlanInputSchema.parse(raw))));
}
