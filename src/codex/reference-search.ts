import { z } from "zod";

const nonempty = z.string().trim().min(1);
const referenceAssetSchema = z.object({
  url: z.url().refine((value) => value.startsWith("https://"), "Asset URLs must use HTTPS").max(4_096),
  format: z.enum(["step", "iges", "parasolid", "sat", "stl", "3mf", "obj", "pdf", "other", "unknown"]),
  kind: z.enum(["editable-cad", "reference-mesh", "dimensioned-document", "unknown"]),
  evidence: nonempty.max(500),
}).strict();

export const referenceSearchRequestSchema = z.object({
  query: nonempty.max(500),
  intendedUse: z.string().trim().max(1_000).optional(),
  allowedDomains: z.array(z.string().trim().min(1).max(253)).max(20).default([]),
  limit: z.number().int().min(1).max(8).default(5),
}).strict();

export const referenceSearchResultSchema = z.object({
  query: nonempty.max(500),
  candidates: z.array(z.object({
    title: nonempty.max(500),
    url: z.url().refine((value) => value.startsWith("https://"), "Candidate URLs must use HTTPS").max(4_096),
    sourceKind: z.enum(["manufacturer", "distributor", "cad-library", "community", "unknown"]),
    summary: nonempty.max(1_500),
    licenseStatus: z.enum(["stated", "unknown", "restricted", "requires-review"]),
    accessStatus: z.enum(["free", "paid", "account-required", "quote-required", "unknown"]),
    dimensionEvidence: z.array(nonempty.max(300)).max(12),
    assets: z.array(referenceAssetSchema).max(8),
  }).strict()).max(8),
  limitations: z.array(nonempty.max(500)).max(8),
}).strict();

export type ReferenceSearchRequest = z.input<typeof referenceSearchRequestSchema>;
export type ReferenceSearchInput = z.output<typeof referenceSearchRequestSchema>;
export type ReferenceSearchResult = z.output<typeof referenceSearchResultSchema>;
