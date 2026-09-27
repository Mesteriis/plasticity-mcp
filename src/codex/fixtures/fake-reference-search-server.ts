#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const options = parseArgs(process.argv.slice(2));
const turnId = "search-turn-1";

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
process.on("exit", () => { if (options.exitRecord) writeFileSync(options.exitRecord, "exited\n", { flag: "a" }); });

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line) as Record<string, unknown>;
  if (typeof message.method === "string" && options.record) appendFileSync(options.record, `${message.method}\n`);
  if (message.method === "initialize") {
    respond(message.id, { userAgent: "fake-reference-search/1" });
    return;
  }
  if (message.method === "thread/start") {
    const params = message.params as { config?: { web_search?: unknown; tools?: { web_search?: { allowed_domains?: string[] } } } };
    if (options.record) appendFileSync(options.record, `thread:${JSON.stringify(message.params)}\n`);
    respond(message.id, { thread: { id: "search-thread-1" } });
    return;
  }
  if (message.method === "turn/start") {
    const params = message.params as { outputSchema?: unknown; input?: { text?: string }[] };
    if (options.record) appendFileSync(options.record, `schema:${JSON.stringify(params.outputSchema)}\n`);
    respond(message.id, { turn: { id: turnId } });
    if (options.mode === "stall") return;
    if (options.mode === "failed-turn") {
      send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "search-thread-1", turn: { id: turnId, status: "failed", error: { message: "unsupported model for current account" } } } });
      return;
    }
    if (options.mode === "forbidden") {
      send({ jsonrpc: "2.0", id: 900, method: "mcpServer/tool/call", params: { name: "plasticity_create_box" } });
      return;
    }
    const prompt = params.input?.[0]?.text ?? "";
    if (options.record) appendFileSync(options.record, `prompt:${prompt}\n`);
    const queryMatch = prompt.match(/"query":"([^"]+)"/);
    const output = JSON.stringify({
      query: queryMatch?.[1] ?? "unknown",
      candidates: [{
        title: "Official product CAD",
        url: options.mode === "unverified-url" ? "https://fake.example/model.step" : "https://vendor.example/support/cad",
        sourceKind: "manufacturer",
        summary: "Official download page links a STEP model.",
        licenseStatus: "requires-review",
        accessStatus: "paid",
        dimensionEvidence: ["Drawing lists overall width 40 mm."],
        assets: [{
          url: options.mode === "unverified-asset" ? "https://fake.example/model.step" : "https://vendor.example/files/model.step",
          format: "step",
          kind: "editable-cad",
          evidence: "Official page labels this link as a STEP model download.",
        }],
      }],
      limitations: ["License terms require review before reuse."],
    });
    const finalText = options.mode === "malformed" ? "{bad-json" : output;
    if (options.mode !== "no-search") {
      send({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "search-thread-1", turnId, item: { id: "search-result", type: "webSearchCall", results: [{ title: "Official support", url: "https://vendor.example/support/cad", links: [{ text: "STEP model", href: "https://vendor.example/files/model.step" }] }] } } });
    }
    send({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "search-thread-1", turnId, item: { id: "message", type: "agentMessage", text: finalText } } });
    send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "search-thread-1", turn: { id: turnId, status: "completed" } } });
    return;
  }
  if (message.method === "turn/interrupt") respond(message.id, {});
});

function parseArgs(argv: string[]): { mode: string; record?: string; exitRecord?: string } {
  const result: { mode: string; record?: string; exitRecord?: string } = { mode: "success" };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--mode") result.mode = argv[++index] ?? "success";
    else if (argv[index] === "--record") {
      const value = argv[++index];
      if (value !== undefined) result.record = value;
    } else if (argv[index] === "--exit-record") {
      const value = argv[++index];
      if (value !== undefined) result.exitRecord = value;
    }
  }
  return result;
}

function respond(id: unknown, result: unknown): void { send({ jsonrpc: "2.0", id, result }); }
function send(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
