#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const options = parseArgs(process.argv.slice(2));
let turnId = "turn-1";

process.on("SIGTERM", () => finish(0));
process.on("SIGINT", () => finish(0));
process.on("exit", () => {
  if (options.exitRecord) writeFileSync(options.exitRecord, "exited\n", { flag: "a" });
});

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line) as Record<string, unknown>;
  if (typeof message.method === "string") record(message.method);
  if (message.method === "initialize") {
    if (options.mode === "stall-init") return;
    if (options.mode === "crash") return finish(17);
    respond(message.id, { userAgent: "fake-analysis/1", codexHome: "/tmp/fake", platformFamily: "unix", platformOs: "test" });
    return;
  }
  if (message.method === "thread/start") {
    respond(message.id, { thread: { id: "thread-1" } });
    return;
  }
  if (message.method === "turn/start") {
    const params = message.params as { input?: { type?: string; text?: string }[] };
    const designReference = (params.input?.[0]?.text ?? "").includes('"analysisMode":"design-reference"');
    record(`turn/start prompt=${JSON.stringify(params.input?.[0]?.text ?? "")}`);
    const imagePaths = (params.input ?? []).filter((item) => item.type === "localImage").map((item) => (item as { path?: string }).path ?? "");
    const imageHashes = imagePaths.map((path) => createHash("sha256").update(readFileSync(path)).digest("hex"));
    const imageSignatures = imagePaths.map((path) => readFileSync(path).subarray(0, 3).toString("hex"));
    record(`turn/start images=${imagePaths.length} imagePaths=${JSON.stringify(imagePaths)} imageHashes=${JSON.stringify(imageHashes)} imageSignatures=${JSON.stringify(imageSignatures)}`);
    const output = outputForMode(options.mode, designReference);
    if (options.mode === "early") {
      notify("item/completed", { threadId: "thread-1", turnId, item: { id: "item-1", type: "agentMessage", text: output } });
      notify("turn/completed", { threadId: "thread-1", turn: { id: turnId, status: "completed" } });
      respond(message.id, { turn: { id: turnId } });
      return;
    }
    respond(message.id, { turn: { id: turnId } });
    if (options.mode === "stall-turn") return;
    if (options.mode === "child-crash") return finish(19);
    if (options.mode === "forbidden") {
      send({ jsonrpc: "2.0", id: 900, method: "mcpServer/tool/call", params: { name: "plasticity_create_box" } });
      return;
    }
    if (output) notify("item/completed", { threadId: "thread-1", turnId, item: { id: "item-1", type: "agentMessage", text: output } });
    notify("turn/completed", {
      threadId: "thread-1",
      turn: options.mode === "failure" || options.mode === "failure-json"
        ? {
          id: turnId,
          status: "failed",
          error: options.mode === "failure-json"
            ? {
              message: JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error", message: "Unsupported model /Users/example api_key=secret" } }),
              codexErrorInfo: "other",
            }
            : { message: "Synthetic provider failure /Users/example token=sensitive", codexErrorInfo: { rateLimitExceeded: { httpStatusCode: 429 } } },
        }
        : { id: turnId, status: "completed" },
    });
    return;
  }
  if (message.method === "turn/interrupt") {
    respond(message.id, {});
    notify("turn/completed", { threadId: "thread-1", turn: { id: turnId, status: "interrupted" } });
    return;
  }
  if ("id" in message && message.method === undefined) return;
});

function outputForMode(mode: string, designReference: boolean): string {
  if (mode === "malformed") return "{not-json";
  if (mode === "refusal") return "I cannot help with this request.";
  if (mode === "unknown-field") return JSON.stringify({ observations: [], proposedMethod: null, questions: [], unsupportedConditions: [], createBox: {} });
  if (mode === "dimensioned") return JSON.stringify({
    observations: [{
      id: "plate-width", label: "Plate width dimension printed on drawing", status: "measured",
      sourceImageIndices: [1], dependsOn: [], unit: "mm", value: 80,
      range: null, sourceUrl: null, sourceHash: null, sourceLocator: "front view, overall width dimension line", derivation: null,
    }],
    proposedMethod: null, questions: [], unsupportedConditions: [],
    designInterpretation: {
      articleType: "plate", functionalIntent: "Mounts to a mating part", scaleStatus: "dimensioned",
      interfaces: [], featureCandidates: [],
    },
  });
  if (mode === "failure" || mode === "failure-json" || mode === "forbidden" || mode === "stall-turn" || mode === "child-crash") return "";
  if (designReference) return JSON.stringify({
    observations: [{ id: "obs-1", label: "No reliable scale marker was supplied", status: "unknown", dependsOn: [] }],
    proposedMethod: null,
    questions: [{ id: "q-1", question: "What will this bracket support, and how is it mounted?", resolves: ["functionalIntent", "mounting"], reason: "The supported object and attachment determine the load path." }],
    unsupportedConditions: [],
    designInterpretation: {
      articleType: "bracket", functionalIntent: "Supports an unknown object", scaleStatus: "unscaled",
      interfaces: [{ id: "mount", kind: "mounting", description: "Two visible mounting points", confidence: "probable", evidenceIds: ["obs-1"] }],
      featureCandidates: [{ id: "holes", type: "hole", description: "Possible mounting holes", confidence: "probable", evidenceIds: ["obs-1"] }],
    },
  });
  return JSON.stringify({
    observations: [{ id: "obs-1", label: "Rectangle visible; scale unknown", status: "unknown", dependsOn: [] }],
    proposedMethod: "cantilever-tip-rectangle-v1",
    questions: [{ id: "q-1", question: "What is the attachment distance in mm?", resolves: ["lengthMm"], reason: "The image has no scale." }],
    unsupportedConditions: [],
    designInterpretation: null,
  });
}

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

function record(method: string): void {
  if (options.record) appendFileSync(options.record, `${method}\n`);
}

function respond(id: unknown, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function notify(method: string, params: unknown): void {
  send({ jsonrpc: "2.0", method, params });
}

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function finish(code: number): never {
  process.exit(code);
}
