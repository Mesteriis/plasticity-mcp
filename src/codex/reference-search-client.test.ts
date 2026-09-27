import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { ReferenceSearchProfile } from "./analysis-profile.ts";
import { createReferenceSearchClient, referenceSearchOutputJsonSchema } from "./reference-search-client.ts";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-reference-search-server.ts");

test("Codex reference search returns only a URL from live web-search results", async (context) => {
  const harness = await createHarness(context, "success");
  const client = await createReferenceSearchClient(harness.profile, { executable: process.execPath, cwd: harness.root });
  const result = await client.search({
    query: "Example device",
    intendedUse: "Design a fitted cradle",
    allowedDomains: ["vendor.example"],
    limit: 4,
  }, { timeoutMs: 5_000 });
  assert.equal(result.query, "Example device");
  assert.equal(result.candidates[0]?.url, "https://vendor.example/support/cad");
  assert.equal(result.candidates[0]?.assets[0]?.url, "https://vendor.example/files/model.step");
  assert.equal(result.candidates[0]?.assets[0]?.kind, "editable-cad");
  assert.equal(result.candidates[0]?.licenseStatus, "requires-review");
  assert.equal(result.candidates[0]?.accessStatus, "paid");
  const record = await readFile(harness.record, "utf8");
  assert.match(record, /"web_search":"live"/);
  assert.match(record, /"allowed_domains":\["vendor.example"\]/);
  assert.match(record, /"approvalPolicy":"never"/);
  assert.match(record, /"model":"gpt-6-astra"/);
  assert.match(record, /one additional web search/i);
  assert.match(record, /"type":"object","additionalProperties":false/);
  await client.close();
  await waitForFile(harness.exitRecord);
});

test("candidate URLs not present in web-search result events are rejected", async (context) => {
  const harness = await createHarness(context, "unverified-url");
  const client = await createReferenceSearchClient(harness.profile, { executable: process.execPath, cwd: harness.root });
  await assert.rejects(() => client.search(searchInput(), { timeoutMs: 5_000 }), (error: unknown) => hasCode(error, "UNVERIFIED_SEARCH_URL"));
  await client.close();
});

test("unverified direct assets are omitted while the verified source candidate remains usable", async (context) => {
  const harness = await createHarness(context, "unverified-asset");
  const client = await createReferenceSearchClient(harness.profile, { executable: process.execPath, cwd: harness.root });
  const result = await client.search(searchInput(), { timeoutMs: 5_000 });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.url, "https://vendor.example/support/cad");
  assert.deepEqual(result.candidates[0]?.assets, []);
  assert.ok(result.limitations.some((limitation) => /unverified direct asset URL/i.test(limitation)));
  await client.close();
});

test("Codex final text is rejected when no live web-search event occurred", async (context) => {
  const harness = await createHarness(context, "no-search");
  const client = await createReferenceSearchClient(harness.profile, { executable: process.execPath, cwd: harness.root });
  await assert.rejects(() => client.search(searchInput(), { timeoutMs: 5_000 }), (error: unknown) => hasCode(error, "SEARCH_NOT_PERFORMED"));
  await client.close();
});

test("failed app-server turns retain their bounded provider error for diagnosis", async (context) => {
  const harness = await createHarness(context, "failed-turn");
  const client = await createReferenceSearchClient(harness.profile, { executable: process.execPath, cwd: harness.root });
  await assert.rejects(() => client.search(searchInput(), { timeoutMs: 5_000 }), (error: unknown) =>
    hasCode(error, "CODEX_TURN_FAILED") && error instanceof Error && /unsupported model/i.test(error.message));
  await client.close();
});

test("malformed output and forbidden app-server requests fail closed", async (context) => {
  for (const [mode, code] of [["malformed", "INVALID_SEARCH_RESULT"], ["forbidden", "FORBIDDEN_CAPABILITY_REQUEST"]] as const) {
    const harness = await createHarness(context, mode);
    const client = await createReferenceSearchClient(harness.profile, { executable: process.execPath, cwd: harness.root });
    await assert.rejects(() => client.search(searchInput(), { timeoutMs: 5_000 }), (error: unknown) => hasCode(error, code));
    await client.close();
  }
});

test("search timeout terminates its owned app-server process without retry", async (context) => {
  const harness = await createHarness(context, "stall");
  const client = await createReferenceSearchClient(harness.profile, { executable: process.execPath, cwd: harness.root });
  await assert.rejects(() => client.search(searchInput(), { timeoutMs: 1_000 }), (error: unknown) => hasCode(error, "SEARCH_TIMEOUT"));
  assert.equal((await readFile(harness.record, "utf8")).split("turn/start").length - 1, 1);
  await waitForFile(harness.exitRecord);
  await client.close();
});

test("search output schema rejects undeclared fields and bounds candidate count", () => {
  const schema = referenceSearchOutputJsonSchema();
  assert.equal((schema as { additionalProperties?: boolean }).additionalProperties, false);
  const candidateSchema = ((schema as { properties: { candidates: { maxItems: number; items: { required: string[]; properties: { assets: { maxItems: number }; accessStatus: { enum: string[] } } } } } }).properties.candidates);
  assert.equal(candidateSchema.maxItems, 8);
  assert.ok(candidateSchema.items.required.includes("assets"));
  assert.ok(candidateSchema.items.required.includes("accessStatus"));
  assert.deepEqual(candidateSchema.items.properties.accessStatus.enum, ["free", "paid", "account-required", "quote-required", "unknown"]);
  assert.equal(candidateSchema.items.properties.assets.maxItems, 8);
});

function searchInput() {
  return { query: "Example device", intendedUse: "Fitted cradle", allowedDomains: [], limit: 5 };
}

async function createHarness(context: test.TestContext, mode: string): Promise<{ profile: ReferenceSearchProfile; root: string; record: string; exitRecord: string }> {
  const root = await mkdtemp(join(tmpdir(), "plasticity-reference-search-"));
  context.after(async () => (await import("node:fs/promises")).rm(root, { recursive: true, force: true }));
  const record = join(root, "methods.log");
  const exitRecord = join(root, "exit.log");
  return {
    root,
    record,
    exitRecord,
    profile: {
      executableVersion: "fake",
      protocolHash: "fake",
      allowedDomains: [],
      argv: [fixture, "--mode", mode, "--record", record, "--exit-record", exitRecord],
      threadOverrides: {
        model: "gpt-6-astra",
        ephemeral: true, environments: [], dynamicTools: [], runtimeWorkspaceRoots: [], approvalPolicy: "never", sandbox: "read-only",
        config: { web_search: "live", tools: { web_search: { context_size: "medium" } } },
      },
    },
  };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try { await readFile(path); return; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  throw new Error(`File not observed: ${path}`);
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
