#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Options { help: boolean; target?: string; solidId?: number; allowLive: boolean; output?: string }

export function parseArgs(argv: string[]): Options {
  if (argv.length === 0) return { help: true, allowLive: false };
  const options: Options = { help: false, allowLive: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--allow-live") options.allowLive = true;
    else if (argument === "--target") options.target = requireValue(argv, ++index, "--target");
    else if (argument === "--solid-id") {
      const raw = requireValue(argv, ++index, "--solid-id");
      options.solidId = Number(raw);
      if (!Number.isSafeInteger(options.solidId) || options.solidId <= 0) throw new Error("--solid-id must be a positive integer");
    } else if (argument === "--output") options.output = requireValue(argv, ++index, "--output");
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Native hidden-line SVG acceptance requires an explicit --target Plasticity window ID");
  if (!Number.isInteger(options.solidId)) throw new Error("Native hidden-line SVG acceptance requires --solid-id for a current Solid");
  if (!options.allowLive) throw new Error("Native hidden-line SVG acceptance requires --allow-live");
  if (!options.output) throw new Error("Native hidden-line SVG acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-hiddenline-svg-live.ts --help
  node scripts/verify-native-hiddenline-svg-live.ts --target ID --solid-id ID --allow-live --output NEW_DIRECTORY

Exports one explicitly identified current native Solid through the public
stdio MCP. It does not modify geometry or camera state; it checks vector SVG
content, visible/hidden edge accounting, millimeter units, and unchanged
document revision and history.`;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const svgPath = join(output, "native-hiddenline.svg");
  const evidencePath = join(output, "evidence.json");
  const evidence: Record<string, unknown> = { schemaVersion: 1, startedAt: new Date().toISOString(), targetId: options.target, solidId: options.solidId, workbenchUsed: false };
  let client: Client | undefined;
  try {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(projectRoot, "scripts", "run-server.ts")],
      cwd: projectRoot,
      env: { ...selectedEnvironment(process.env), PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" },
      stderr: "pipe",
    });
    client = new Client({ name: "plasticity-native-hiddenline-svg-live", version: "1.0.0" });
    await client.connect(transport);
    const tools = await client.listTools();
    for (const name of ["plasticity_list_windows", "plasticity_connect", "plasticity_export_hiddenline_svg", "plasticity_status"]) {
      requireCondition(tools.tools.some((tool) => tool.name === name), `MCP did not expose ${name}`);
    }
    const windows = await call(client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    const initial = await call(client, "plasticity_connect", { targetId: options.target });
    const solid = initial.bodies.find((body: { id: number; type: string }) => body.id === options.solidId && body.type === "Solid");
    requireCondition(solid?.boundsMm, `Current native Solid ${options.solidId} was not found with exact bounds`);
    evidence.initial = stateSummary(initial);
    evidence.solid = { id: solid.id, name: solid.name, boundsMm: solid.boundsMm, source: "native Plasticity Solid" };

    const report = await call(client, "plasticity_export_hiddenline_svg", { ids: [solid.id], path: svgPath, revision: initial.revision, curveChordToleranceMm: 0.05, curveChordAngleDegrees: 5, marginMm: 1 });
    const after = await call(client, "plasticity_status", {});
    for (const field of ["targetId", "documentToken", "revision", "undoDepth", "redoDepth"] as const) requireCondition(initial[field] === after[field], `Hidden-line SVG export changed Plasticity ${field}`);
    const svg = await readFile(svgPath, "utf8");
    requireCondition(report.bodies === 1 && report.segments > 0, "Native hidden-line report omitted projected Solid edges");
    requireCondition(report.visibleSegments + report.hiddenSegments === report.segments, "Visible and hidden segment counts do not sum to all projected segments");
    requireCondition(report.sourceUnits === "millimeter" && report.projection === "native-orthographic", "Hidden-line report omitted its projection or source units");
    requireCondition(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>') && /data-units="mm"/u.test(svg), "SVG declaration or millimeter units are missing");
    requireCondition(/<path\b/gu.test(svg) && !/<image\b|<script\b/iu.test(svg), "SVG is not vector-only or contains active/embedded content");
    requireCondition(/stroke-dasharray=/u.test(svg) === (report.hiddenSegments > 0), "Hidden-edge dash styling disagrees with native segment categories");
    requireCondition(report.bytes === Buffer.byteLength(svg), "SVG byte count differs from saved output");
    const width = Number(svg.match(/width="([0-9.]+)mm"/u)?.[1]);
    const height = Number(svg.match(/height="([0-9.]+)mm"/u)?.[1]);
    requireCondition(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0, "SVG physical page dimensions are invalid");
    requireCondition(Math.abs(width - (report.projectedBoundsMm.size[0] + 2)) < 1e-8 && Math.abs(height - (report.projectedBoundsMm.size[1] + 2)) < 1e-8, "SVG page dimensions disagree with projected Solid bounds and 1 mm margins");
    evidence.export = { report, svgSha256: createHash("sha256").update(svg).digest("hex"), vectorOnly: true, unchangedDocumentAndHistory: true };
    evidence.completedAt = new Date().toISOString();
    await writeFile(evidencePath, `${JSON.stringify(sanitizeEvidence(evidence), null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ ok: true, output, svg: svgPath, evidence: evidencePath }, null, 2));
  } catch (error) {
    evidence.failure = boundedError(error);
    await writeFile(join(output, "failure.json"), `${JSON.stringify(sanitizeEvidence(evidence), null, 2)}\n`, { flag: "wx", mode: 0o600 }).catch(() => {});
    throw error;
  } finally { await client?.close().catch(() => {}); }
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await client.callTool({ name, arguments: args });
  const text = toolText(response);
  if ("isError" in response && response.isError) throw new Error(text);
  return JSON.parse(text);
}
function toolText(response: unknown): string {
  if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content");
  const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string");
  if (!item) throw new Error("MCP tool returned no text content");
  return item.text;
}
function stateSummary(state: any): Record<string, unknown> { return { targetId: state.targetId, documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyIds: state.bodies.map((body: { id: number }) => body.id) }; }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function boundedError(error: unknown): string { return error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000); }
function requireValue(argv: string[], index: number, option: string): string { const value = argv[index]; if (!value) throw new Error(`${option} requires a value`); return value; }
function selectedEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv { return Object.fromEntries(Object.entries(environment).filter(([key]) => key.startsWith("PLASTICITY_") || key === "PATH" || key === "HOME" || key === "TMPDIR")); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
