import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createReferenceSearchClient } from "../src/codex/reference-search-client.ts";
import { referenceSearchResultSchema } from "../src/codex/reference-search.ts";
import { resolveReferenceSearchProfile } from "../src/codex/analysis-profile.ts";
import { PlasticitySession, createServer, strengthDependenciesForSession } from "../src/server.ts";

interface Options {
  query: string;
  intendedUse?: string;
  allowedDomains: string[];
  limit: number;
  searchTimeoutMs: number;
  output: string;
}

const options = parseArgs(process.argv.slice(2));
const profile = await resolveReferenceSearchProfile(process.env.PLASTICITY_CODEX_EXECUTABLE ?? "codex");
if (!profile.available) throw new Error(profile.reason);
await mkdir(options.output, { recursive: false, mode: 0o700 });

const referenceSearch = await createReferenceSearchClient(profile.profile, {
  executable: process.env.PLASTICITY_CODEX_EXECUTABLE ?? "codex",
  cwd: process.cwd(),
});
const session = new PlasticitySession();
const server = createServer(session, strengthDependenciesForSession(session, { referenceSearch }));
const client = new Client({ name: "plasticity-reference-search-acceptance", version: "1.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

try {
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const status = await client.callTool({ name: "plasticity_reference_search_status", arguments: {} });
  let progressEventCount = 0;
  const search = await client.callTool({
    name: "plasticity_search_product_references",
    arguments: {
      query: options.query,
      ...(options.intendedUse ? { intendedUse: options.intendedUse } : {}),
      allowedDomains: options.allowedDomains,
      limit: options.limit,
      searchTimeoutMs: options.searchTimeoutMs,
    },
  }, undefined, {
    timeout: options.searchTimeoutMs + 10_000,
    resetTimeoutOnProgress: true,
    onprogress: () => { progressEventCount += 1; },
  });
  if (status.isError || search.isError) throw new Error(JSON.stringify({ status, search }));
  const statusResult = parseToolResponse(status);
  const searchResult = referenceSearchResultSchema.parse(parseToolResponse(search));
  const report = {
    accepted: true,
    occurredAt: new Date().toISOString(),
    codexVersion: profile.profile.executableVersion,
    protocolHash: profile.profile.protocolHash,
    transport: "MCP InMemoryTransport client -> public MCP tools -> isolated Codex app-server",
    plasticityConnected: false,
    cadMutated: false,
    autoImport: false,
    progressEventCount,
    request: options,
    status: statusResult,
    result: searchResult,
  };
  await writeFile(resolve(options.output, "evidence.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ accepted: true, output: resolve(options.output, "evidence.json"), candidateCount: searchResult.candidates.length }, null, 2));
} finally {
  await client.close().catch(() => undefined);
  await server.close();
}

function parseArgs(argv: string[]): Options {
  let query = "";
  let intendedUse: string | undefined;
  let output = "";
  let limit = 5;
  let searchTimeoutMs = 180_000;
  const allowedDomains: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      console.log("Usage: node scripts/verify-reference-search-live.ts --query TEXT --output NEW_DIRECTORY [--use TEXT] [--allow-domain DOMAIN ...] [--limit 1..8] [--search-timeout-ms 30000..180000]");
      process.exit(0);
    }
    if (argument === "--query") query = required(argv, ++index, argument);
    else if (argument === "--use") intendedUse = required(argv, ++index, argument);
    else if (argument === "--output") output = required(argv, ++index, argument);
    else if (argument === "--allow-domain") allowedDomains.push(required(argv, ++index, argument));
    else if (argument === "--limit") {
      const parsed = Number(required(argv, ++index, argument));
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 8) throw new Error("--limit must be an integer from 1 to 8");
      limit = parsed;
    } else if (argument === "--search-timeout-ms") {
      const parsed = Number(required(argv, ++index, argument));
      if (!Number.isInteger(parsed) || parsed < 30_000 || parsed > 180_000) throw new Error("--search-timeout-ms must be an integer from 30000 to 180000");
      searchTimeoutMs = parsed;
    } else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (!query) throw new Error("--query is required");
  if (!output || !isAbsolute(output)) throw new Error("--output must be an absolute path to a new directory");
  return { query, ...(intendedUse ? { intendedUse } : {}), allowedDomains, limit, searchTimeoutMs, output };
}

function required(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function parseToolResponse(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("content" in value) || !Array.isArray(value.content)) {
    throw new Error("MCP tool returned an unexpected response");
  }
  const textBlock = value.content.find((block) =>
    typeof block === "object" && block !== null && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string",
  );
  if (!textBlock || typeof textBlock !== "object" || !("text" in textBlock) || typeof textBlock.text !== "string") {
    throw new Error("MCP tool returned no text result");
  }
  return JSON.parse(textBlock.text) as unknown;
}
