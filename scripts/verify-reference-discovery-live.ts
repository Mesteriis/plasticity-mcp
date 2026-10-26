#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { referenceSearchResultSchema } from "../src/codex/reference-search.ts";
import { isolatedAcceptanceEnvironment } from "./verify-native-measure-datum-files-live.ts";
import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CASES = ["status", "assets", "search"] as const;
type Case = typeof CASES[number];
interface Options { help: boolean; target?: string; output?: string; case?: Case; allowLive: boolean }
const PAGE = "https://dl.radxa.com/zero3/docs/hw/3w/";
const DOMAINS = ["radxa.com"];
const QUERY = "Find the official Radxa ZERO 3W CAD download page at https://dl.radxa.com/zero3/docs/hw/3w/ . Return one source page; list only directly evidenced CAD links.";
const CAD_ASSETS = [
  { url: PAGE + "radxa_zero_3w_3d_stp.zip", format: "step-archive" },
  { url: PAGE + "0_zero_3w_pcba_20250213.x_t.zip", format: "parasolid-text" },
];
export function parseReferenceDiscoveryArgs(argv: string[]): Options {
  const options: Options = { help: argv.length === 0, allowLive: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--help") options.help = true;
    else if (flag === "--allow-live") options.allowLive = true;
    else if (["--target", "--output", "--case"].includes(flag ?? "")) {
      const value = argv[++i]; if (!value || value.startsWith("--")) throw Error(`${flag} requires a value`);
      if (flag === "--target") options.target = value;
      else if (flag === "--output") options.output = value;
      else { if (!CASES.includes(value as Case)) throw Error("--case must be status, assets or search"); options.case = value as Case; }
    } else throw Error(`Unknown argument: ${flag}`);
  }
  if (!options.help) {
    if (!options.target) throw Error("--target is required");
    if (!options.allowLive) throw Error("--allow-live is required");
    if (!options.output) throw Error("--output must name a new directory");
    if (!options.case) throw Error("--case is required");
  }
  return options;
}
export function assertAllowedDiscoveryUrl(value: string, domains: string[]): void {
  const url = new URL(value);
  assert.equal(url.protocol, "https:"); assert.equal(url.username, ""); assert.equal(url.password, "");
  assert(!url.port || url.port === "443", "Unexpected discovery port");
  assert(domains.some(domain => url.hostname === domain || url.hostname.endsWith("." + domain)), "Discovery URL escaped explicit domains");
}
export function validateDiscoveryAssets(result: any): void {
  assert(Array.isArray(result.assets) && result.assets.length <= 64);
  assert.equal(result.truncated, false, "Reviewed page asset list is unexpectedly truncated");
  assert(Number.isInteger(result.omittedQueryAssetCount) && result.omittedQueryAssetCount >= 0);
  const unique = new Set<string>();
  for (const asset of result.assets) {
    assertAllowedDiscoveryUrl(asset.url, DOMAINS);
    assert.equal(new URL(asset.url).search, "", "Query-bearing asset was returned");
    assert.equal(new URL(asset.url).hash, "", "Fragment-bearing asset was returned");
    assert(!unique.has(asset.url), "Duplicate discovered asset"); unique.add(asset.url);
  }
  for (const expected of CAD_ASSETS) assert(result.assets.some((asset: any) => asset.url === expected.url && asset.format === expected.format && asset.kind === "editable-cad"), "Reviewed direct CAD link was not discovered: " + expected.format);
  assert(result.assets.some((asset: any) => asset.format === "pdf" && asset.kind === "dimensioned-document"), "Reviewed page did not expose a PDF document");
}
const HELP = `Usage: npm run accept:reference-discovery -- --target ID --allow-live --case status|assets|search --output NEW_DIRECTORY
No args/--help are inert. Read-only production stdio acceptance with isolated
stores and an explicit experimental Plasticity target. Uses a fixed public Radxa
query/page and explicit radxa.com domains. Search uses the product's configured
isolated Codex profile. No CAD data is sent in the query. Assets are listed only:
no asset download/import, page script execution or CAD mutation is authorized.
Search unavailability/failure remains failed; it is never replaced by a mock.`;

async function main() {
  const options = parseReferenceDiscoveryArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!); await mkdir(output, { mode: 0o700 });
  const evidence: any = { schemaVersion: 1, startedAt: new Date().toISOString(), case: options.case, scope: "read-only-public-reference-discovery", page: PAGE, allowedDomains: DOMAINS };
  let client: Client | undefined; let initial: any; let snapshot: any;
  try {
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts/run-server.ts")], cwd: projectRoot,
      env: { ...isolatedAcceptanceEnvironment(join(output, "stores"), process.env), PLASTICITY_STRENGTH_ASSET_ROOT: output }, stderr: "pipe" });
    client = new Client({ name: "plasticity-reference-discovery-live", version: "1.0.0" }); await client.connect(transport);
    const windows = await call(client, "plasticity_list_windows", {});
    assert(windows.some((w: any) => w.targetId === options.target), "Explicit experimental target missing");
    initial = await call(client, "plasticity_connect", { targetId: options.target });
    snapshot = await call(client, "plasticity_capture_snapshot", { label: "reference-discovery-readonly-baseline" });
    if (options.case === "status" || options.case === "search") {
      const status = await call(client, "plasticity_reference_search_status", {}); evidence.status = status;
      assert.equal(typeof status.available, "boolean"); assert.equal(status.autoImport, false);
      if (!status.available) assert(typeof status.reason === "string" && status.reason.length > 0);
      if (options.case === "search") {
        assert(status.available, "Isolated reference search unavailable: " + status.reason);
        const result = referenceSearchResultSchema.parse(await call(client, "plasticity_search_product_references", {
          query: QUERY, intendedUse: "Read-only source discovery acceptance; no model download or import", allowedDomains: DOMAINS, limit: 1, searchTimeoutMs: 180_000,
        }, 190_000));
        evidence.search = result;
        assert(result.candidates.length > 0 && result.candidates.length <= 1, "Live search did not return bounded candidate pages");
        for (const candidate of result.candidates) {
          assertAllowedDiscoveryUrl(candidate.url, DOMAINS);
          for (const asset of candidate.assets) assertAllowedDiscoveryUrl(asset.url, DOMAINS);
        }
      }
    } else {
      evidence.assets = await call(client, "plasticity_list_reference_assets", { sourcePageUrl: PAGE, allowedDomains: DOMAINS });
      validateDiscoveryAssets(evidence.assets);
      let rejected = false;
      try { await call(client, "plasticity_list_reference_assets", { sourcePageUrl: "https://example.com/product", allowedDomains: DOMAINS }); }
      catch (error) { rejected = /outside the selected domains/i.test(error instanceof Error ? error.message : String(error)); }
      assert(rejected, "Off-domain page was not rejected before retrieval"); evidence.offDomainRejected = true;
    }
    evidence.readOnly = await assertUnchanged(client, initial, snapshot);
    evidence.completedAt = new Date().toISOString(); await writeEvidence(join(output, "evidence.json"), evidence);
    console.log(JSON.stringify({ ok: true, output }));
  } catch (error) {
    evidence.error = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
    if (client && initial && snapshot) evidence.readOnly = await assertUnchanged(client, initial, snapshot).catch(() => ({ verified: false }));
    await writeEvidence(join(output, "failure.json"), evidence).catch(() => {}); throw error;
  } finally { await client?.close().catch(() => {}); }
}
async function assertUnchanged(client: Client, initial: any, snapshot: any) {
  const state = await call(client, "plasticity_status", {});
  assert.equal(state.documentToken, initial.documentToken); assert.equal(state.revision, initial.revision);
  assert.equal(state.undoDepth, initial.undoDepth); assert.equal(state.redoDepth, initial.redoDepth);
  const changes = await call(client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
  assert(!hasSceneContentChanges(changes.diff), "Reference discovery changed the CAD scene");
  const history = await call(client, "plasticity_construction_history", { offset: 0, limit: 100 });
  assert.equal(history.total, 0, "Discovery created mutation history");
  const journal = await call(client, "plasticity_construction_journal", {});
  assert.equal(journal.durableSyncStatus, "empty"); assert.equal(journal.journalPagination.total, 0);
  return { verified: true, sceneAndHistoryUnchanged: true, mutationEvents: 0, assetDownloaded: false, autoImport: false };
}
async function call(client: Client, name: string, args: Record<string, unknown>, timeout = 30_000): Promise<any> {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout });
  const text = (result.content as any[]).find(item => item.type === "text")?.text;
  assert.equal(typeof text, "string"); if (result.isError) throw Error(text); return JSON.parse(text);
}
async function writeEvidence(path: string, value: unknown) { await writeFile(path, JSON.stringify(sanitizeEvidence(value), null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
