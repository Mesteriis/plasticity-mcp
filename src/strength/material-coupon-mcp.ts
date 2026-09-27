import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  materialCouponRecordInputSchema,
  materialCouponQualificationQuerySchema,
  MATCH_MATERIAL_COUPON_DESCRIPTION,
  RECORD_MATERIAL_COUPON_DESCRIPTION,
} from "./material-qualification.ts";
import type { MaterialCouponQualificationStore } from "./material-qualification.ts";
import { strengthToolResult } from "./mcp-response.ts";

type ToolAnnotations = { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
type RegisterTool = (
  name: string,
  config: { description: string; inputSchema: z.ZodType; annotations: ToolAnnotations },
  callback: (input: unknown) => Promise<{ content: [{ type: "text"; text: string }] }>,
) => unknown;

export function registerMaterialCouponTools(server: McpServer, store: MaterialCouponQualificationStore): void {
  const registerTool = server.registerTool.bind(server) as unknown as RegisterTool;
  const register = <T extends z.ZodType>(
    name: string,
    description: string,
    schema: T,
    readOnly: boolean,
    handler: (input: z.output<T>) => Promise<unknown>,
  ) => registerTool(name, {
    description,
    inputSchema: schema,
    annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false },
  }, async (raw) => strengthToolResult(await handler(schema.parse(raw) as z.output<T>)));

  register(
    "plasticity_record_material_coupon_data",
    RECORD_MATERIAL_COUPON_DESCRIPTION,
    materialCouponRecordInputSchema,
    false,
    async (input) => await store.record(input),
  );

  register(
    "plasticity_combine_material_coupon_data",
    "Explicitly consolidate 2–8 compatible immutable physical coupon records for one exact single-material print process. It combines only non-conflicting measured properties and their source evidence; it never averages or infers values. Supply specimenCount as the caller-confirmed number of unique physical specimens across all source records. The result is a new immutable record with composedFromRecordIds, and can be used for exact-process matching and FEA binding. Different processes, conflicting values or print frames are rejected.",
    z.object({
      recordIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(2).max(8)
        .refine((ids) => new Set(ids).size === ids.length, "Coupon record IDs must be unique"),
      specimenCount: z.number().int().positive().max(1000),
    }).strict(),
    false,
    async ({ recordIds, specimenCount }) => await store.combine(recordIds, specimenCount),
  );

  register(
    "plasticity_match_material_coupon_data",
    MATCH_MATERIAL_COUPON_DESCRIPTION,
    materialCouponQualificationQuerySchema,
    true,
    async (query) => await store.match(query),
  );

  register(
    "plasticity_list_material_coupon_data",
    "List immutable caller-attested material coupon records with their source evidence, exact process identity and any composedFromRecordIds. This physical-test registry is separate from slicer material names, densities and temperatures.",
    z.object({}).strict(),
    true,
    async () => ({ source: "immutable-local-physical-coupon-registry", records: await store.list() }),
  );
}
