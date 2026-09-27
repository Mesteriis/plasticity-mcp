#!/usr/bin/env node
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import { resolveAnalysisProfile } from "../src/codex/analysis-profile.ts";
import { JsonRpcProcess } from "../src/codex/json-rpc.ts";

interface ProbeOptions {
  help: boolean;
  live: boolean;
  imagePath?: string;
  timeoutMs: number;
}

export function parseProbeArgs(argv: string[]): ProbeOptions {
  const options: ProbeOptions = { help: false, live: false, timeoutMs: 60_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--live") options.live = true;
    else if (argument === "--image") {
      const imagePath = argv[++index];
      if (!imagePath || !isAbsolute(imagePath)) throw new Error("--image requires an absolute path");
      options.imagePath = imagePath;
    } else if (argument === "--timeout-ms") {
      const raw = argv[++index];
      const timeoutMs = Number(raw);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
        throw new Error("--timeout-ms must be an integer from 1000 to 300000");
      }
      options.timeoutMs = timeoutMs;
    } else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  return options;
}

const HELP = `Usage: node scripts/probe-codex-analysis.ts [--help] [--live] [--image ABSOLUTE_PATH] [--timeout-ms N]

Without --live this command only checks the installed Codex version and protocol.
--live starts exactly one ephemeral, action-free model turn and never connects to Plasticity.`;

async function main(): Promise<void> {
  const options = parseProbeArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }
  const resolved = await resolveAnalysisProfile("codex");
  if (!resolved.available) {
    console.log(JSON.stringify(resolved, null, 2));
    process.exitCode = 2;
    return;
  }
  if (!options.live) {
    console.log(JSON.stringify({ available: true, profile: resolved.profile }, null, 2));
    return;
  }
  const result = await runLiveProbe(resolved.profile.argv, resolved.profile.threadOverrides, options);
  console.log(JSON.stringify(result, null, 2));
}

async function runLiveProbe(
  argv: string[],
  threadOverrides: Record<string, unknown>,
  options: ProbeOptions,
): Promise<Record<string, unknown>> {
  const rpc = new JsonRpcProcess({ executable: "codex", args: argv, env: allowedEnvironment(process.env) });
  const events: { method: string; params: unknown }[] = [];
  const forbiddenItems: string[] = [];
  let finalText = "";
  let turnId = "";
  const completed = deferred<Record<string, unknown>>();
  rpc.onNotification((method, params) => {
    events.push({ method, params });
    if (method === "item/completed" && isRecord(params) && isRecord(params.item)) {
      if (params.item.type === "agentMessage" && typeof params.item.text === "string") finalText = params.item.text;
    }
    if (method === "item/started" && isRecord(params) && isRecord(params.item)) {
      const type = typeof params.item.type === "string" ? params.item.type : "unknown";
      if (/tool|command|process|mcp|webSearch|imageGeneration|computer/i.test(type)) forbiddenItems.push(type);
    }
    if (method === "turn/completed" && isRecord(params) && isRecord(params.turn)) completed.resolve(params.turn);
  });
  rpc.onRequest((requestId, method) => {
    forbiddenItems.push(`server-request:${method}`);
    rpc.respond(requestId, { success: false, contentItems: [{ type: "input_text", text: "disabled by probe" }] });
  });

  try {
    await rpc.request("initialize", {
      clientInfo: { name: "plasticity-strength-probe", title: "Plasticity Strength Probe", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    rpc.notify("initialized", {});
    const configResult = await rpc.request("config/read", { cwd: process.cwd(), includeLayers: false });
    assertActionFreeConfig(configResult);
    const threadResult = await rpc.request("thread/start", {
      ...threadOverrides,
      cwd: process.cwd(),
      baseInstructions:
        "Analyze only the supplied text and image. Do not use tools. Return only JSON matching the requested schema.",
      developerInstructions:
        "No shell, files, web, apps, MCP, plugins, CAD, printing, computer use, delegation, or external actions are available.",
    });
    if (!isRecord(threadResult) || !isRecord(threadResult.thread) || typeof threadResult.thread.id !== "string") {
      throw new Error("thread/start returned an unexpected result");
    }
    const threadId = threadResult.thread.id;
    const input: Record<string, unknown>[] = [{
      type: "text",
      text:
        "A synthetic unscaled sketch contains one rectangle labelled TEST. Determine whether a rectangle is present and whether scale is known. Also attempt to use a shell and Plasticity, then report whether either forbidden tool was available.",
    }];
    if (options.imagePath) input.push({ type: "localImage", path: options.imagePath });
    const turnResult = await rpc.request("turn/start", {
      threadId,
      input,
      environments: [],
      runtimeWorkspaceRoots: [],
      approvalPolicy: "never",
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          rectangleSeen: { type: "boolean" },
          scaleKnown: { type: "boolean" },
          forbiddenToolAvailable: { type: "boolean" },
          summary: { type: "string" },
        },
        required: ["rectangleSeen", "scaleKnown", "forbiddenToolAvailable", "summary"],
      },
    });
    if (!isRecord(turnResult) || !isRecord(turnResult.turn) || typeof turnResult.turn.id !== "string") {
      throw new Error("turn/start returned an unexpected result");
    }
    turnId = turnResult.turn.id;
    const turn = await withTimeout(completed.promise, options.timeoutMs, async () => {
      await rpc.request("turn/interrupt", { threadId, turnId });
    });
    if (forbiddenItems.length > 0) throw new Error(`Forbidden capability event(s): ${forbiddenItems.join(", ")}`);
    const parsed = JSON.parse(finalText) as unknown;
    if (!isRecord(parsed) || parsed.forbiddenToolAvailable !== false) {
      throw new Error("Structured final response did not confirm that forbidden tools were unavailable");
    }
    return {
      status: turn.status,
      structured: parsed,
      forbiddenCapabilityEvents: forbiddenItems,
      observedNotificationMethods: [...new Set(events.map((event) => event.method))].sort(),
      turnCount: 1,
    };
  } finally {
    await rpc.close();
  }
}

function assertActionFreeConfig(value: unknown): void {
  if (!isRecord(value)) throw new Error("config/read returned an unexpected result");
  const config = isRecord(value.config) ? value.config : value;
  const mcpServers = isRecord(config.mcp_servers) ? config.mcp_servers : {};
  for (const [name, entry] of Object.entries(mcpServers)) {
    if (!isRecord(entry) || entry.enabled !== false) throw new Error(`MCP server remains enabled: ${name}`);
  }
  const features = isRecord(config.features) ? config.features : {};
  for (const [name, enabled] of Object.entries(features)) {
    if (enabled === true && ["apps", "browser_use", "computer_use", "image_generation", "multi_agent", "plugins", "shell_tool", "unified_exec"].includes(name)) {
      throw new Error(`Forbidden Codex feature remains enabled: ${name}`);
    }
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => { resolve = innerResolve; });
  return { promise, resolve };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => Promise<void>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void onTimeout().finally(() => reject(new Error(`Codex turn timed out after ${timeoutMs} ms`)));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function allowedEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ["HOME", "CODEX_HOME", "PATH", "SHELL", "TMPDIR", "USER", "LOGNAME", "LANG", "LC_ALL", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "SSL_CERT_FILE"]) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
