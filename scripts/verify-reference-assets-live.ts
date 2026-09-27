import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

interface Options {
  pageUrl: string;
  allowedDomains: string[];
  expectedAssetUrl?: string;
  output: string;
}

const options = parseArgs(process.argv.slice(2));
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(options.output, { recursive: false, mode: 0o700 });
const client = new Client({ name: "plasticity-reference-assets-acceptance", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(projectRoot, "scripts", "run-server.ts")],
  cwd: projectRoot,
  env: {
    ...selectedEnvironment(process.env),
    PLASTICITY_STRENGTH_ROOT: join(options.output, "strength-store"),
    PLASTICITY_THREAD_QUALIFICATION_ROOT: join(options.output, "thread-qualification-store"),
  },
  stderr: "pipe",
});
transport.stderr?.on("data", () => undefined);

try {
  await client.connect(transport);
  const response = await client.callTool({
    name: "plasticity_list_reference_assets",
    arguments: { sourcePageUrl: options.pageUrl, allowedDomains: options.allowedDomains },
  }, undefined, { timeout: 30_000 });
  const result = parseToolResponse(response) as {
    assets?: Array<{ url: string; format: string; kind: string }>;
    omittedQueryAssetCount?: number;
    truncated?: boolean;
  };
  assert.ok(Array.isArray(result.assets), "MCP should return an asset list");
  assert.equal(typeof result.omittedQueryAssetCount, "number");
  assert.equal(typeof result.truncated, "boolean");
  for (const asset of result.assets) {
    const url = new URL(asset.url);
    assert.equal(url.protocol, "https:");
    assert.equal(url.search, "", "Query-bearing links must not be returned");
    assert.ok(options.allowedDomains.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`)), "Asset links must stay within the explicit domains");
  }
  if (options.expectedAssetUrl) {
    assert.ok(result.assets.some((asset) => asset.url === options.expectedAssetUrl), "Expected direct asset link was not found");
  }
  const report = {
    accepted: true,
    occurredAt: new Date().toISOString(),
    transport: "MCP stdio client -> production run-server process -> public plasticity_list_reference_assets tool",
    plasticityConnected: false,
    cadMutated: false,
    assetDownloaded: false,
    request: { pageUrl: safePublicUrl(options.pageUrl), allowedDomains: options.allowedDomains },
    result,
  };
  await writeFile(resolve(options.output, "evidence.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ accepted: true, output: resolve(options.output, "evidence.json"), assetCount: result.assets.length, omittedQueryAssetCount: result.omittedQueryAssetCount }, null, 2));
} finally {
  await client.close().catch(() => undefined);
}

function parseArgs(argv: string[]): Options {
  let pageUrl = "";
  let expectedAssetUrl: string | undefined;
  let output = "";
  const allowedDomains: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      console.log("Usage: node scripts/verify-reference-assets-live.ts --page-url HTTPS_URL --allow-domain DOMAIN [--allow-domain DOMAIN ...] --output NEW_DIRECTORY [--expect-asset-url HTTPS_URL]");
      process.exit(0);
    }
    if (argument === "--page-url") pageUrl = required(argv, ++index, argument);
    else if (argument === "--allow-domain") allowedDomains.push(required(argv, ++index, argument));
    else if (argument === "--expect-asset-url") expectedAssetUrl = required(argv, ++index, argument);
    else if (argument === "--output") output = required(argv, ++index, argument);
    else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (!pageUrl) throw new Error("--page-url is required");
  if (allowedDomains.length === 0) throw new Error("At least one --allow-domain is required");
  if (!output || !isAbsolute(output)) throw new Error("--output must be an absolute path to a new directory");
  return { pageUrl, allowedDomains, ...(expectedAssetUrl ? { expectedAssetUrl } : {}), output };
}

function required(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function safePublicUrl(value: string): string {
  const url = new URL(value);
  for (const key of url.searchParams.keys()) url.searchParams.set(key, "[redacted]");
  return url.toString();
}

function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL", "PLASTICITY_CODEX_EXECUTABLE"].flatMap((key) =>
    typeof environment[key] === "string" ? [[key, environment[key]!]] : [],
  ));
}

function parseToolResponse(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("content" in value) || !Array.isArray(value.content)) {
    throw new Error("MCP tool returned an unexpected response");
  }
  if ("isError" in value && value.isError === true) throw new Error("MCP tool call failed");
  const textBlock = value.content.find((block) =>
    typeof block === "object" && block !== null && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string",
  );
  if (!textBlock || typeof textBlock !== "object" || !("text" in textBlock) || typeof textBlock.text !== "string") {
    throw new Error("MCP tool returned no text result");
  }
  return JSON.parse(textBlock.text) as unknown;
}
