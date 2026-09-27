#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface NativeSvgExportAcceptanceOptions {
  help: boolean;
  target?: string;
  wireId?: number;
  allowLive: boolean;
  output?: string;
}

export function parseNativeSvgExportAcceptanceArgs(argv: string[]): NativeSvgExportAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowLive: false };
  const options: NativeSvgExportAcceptanceOptions = { help: false, allowLive: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--allow-live") options.allowLive = true;
    else if (argument === "--target") options.target = requireValue(argv, ++index, "--target");
    else if (argument === "--wire-id") {
      const raw = requireValue(argv, ++index, "--wire-id");
      options.wireId = Number(raw);
      if (!Number.isSafeInteger(options.wireId) || options.wireId <= 0) throw new Error("--wire-id must be a positive integer");
    } else if (argument === "--output") options.output = requireValue(argv, ++index, "--output");
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Native SVG export acceptance requires --target with an explicit Plasticity window ID");
  if (!Number.isInteger(options.wireId)) throw new Error("Native SVG export acceptance requires --wire-id for an exact current Wire");
  if (!options.allowLive) throw new Error("Native SVG export acceptance requires --allow-live");
  if (!options.output) throw new Error("Native SVG export acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-svg-export-live.ts --help
  node scripts/verify-native-svg-export-live.ts --target ID --wire-id ID --allow-live --output NEW_DIRECTORY

With no arguments or --help, this script does not connect to Plasticity.
Live mode exports one explicitly selected current planar line Wire through
the public stdio MCP, checks exact native dimensions, and verifies that the
document revision and Undo/Redo history remain unchanged.`;

async function main(): Promise<void> {
  const options = parseNativeSvgExportAcceptanceArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const svgPath = join(output, "native-wire.svg");
  const evidencePath = join(output, "evidence.json");
  const evidence: Record<string, unknown> = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    targetId: options.target!,
    wireId: options.wireId!,
    workbenchUsed: false,
  };
  let client: Client | undefined;
  try {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(projectRoot, "scripts", "run-server.ts")],
      cwd: projectRoot,
      env: { ...selectedEnvironment(process.env), PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" },
      stderr: "pipe",
    });
    client = new Client({ name: "plasticity-native-svg-export-live", version: "1.0.0" });
    await client.connect(transport);
    const tools = await client.listTools();
    for (const name of ["plasticity_list_windows", "plasticity_connect", "plasticity_list_curve_directions", "plasticity_export_svg", "plasticity_status"]) {
      requireCondition(tools.tools.some((tool) => tool.name === name), `MCP did not expose ${name}`);
    }
    const windows = await call(client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    const initial = await call(client, "plasticity_connect", { targetId: options.target });
    const wire = initial.bodies.find((body: { id: number; type: string }) => body.id === options.wireId && body.type === "Wire");
    requireCondition(wire, `Current native Wire ${options.wireId} was not found`);
    requireCondition(wire.boundsMm, "Exact native Wire bounds are unavailable");
    const curves = await call(client, "plasticity_list_curve_directions", {});
    const curve = curves.curves.find((candidate: { id: number }) => candidate.id === options.wireId);
    requireCondition(curve?.measurementSource === "native-brep" && curve.closed === true && curve.segments.length === 4, "Expected one closed, four-segment native Wire");
    requireCondition(curve.segments.every((segment: { lengthMm: number }) => Number.isFinite(segment.lengthMm) && segment.lengthMm > 0), "Wire contains an invalid exact segment length");
    const nativeLengths = curve.segments.map((segment: { lengthMm: number }) => segment.lengthMm).toSorted((a: number, b: number) => a - b);
    vectorNear(nativeLengths, [10, 10, 20, 20], 1e-6, "fixture native Wire segment lengths");
    evidence.initial = stateSummary(initial);
    evidence.nativeWire = {
      id: wire.id,
      name: wire.name,
      boundsMm: wire.boundsMm,
      segmentLengthsMm: curve.segments.map((segment: { lengthMm: number }) => segment.lengthMm),
      segmentCount: curve.segments.length,
    };

    const report = await call(client, "plasticity_export_svg", { ids: [wire.id], path: svgPath, revision: initial.revision });
    const after = await call(client, "plasticity_status", {});
    for (const field of ["targetId", "documentToken", "revision", "undoDepth", "redoDepth"] as const) {
      requireCondition(initial[field] === after[field], `SVG export changed Plasticity ${field}`);
    }
    const svg = await readFile(svgPath, "utf8");
    const size = wire.boundsMm.max.map((value: number, index: number) => value - wire.boundsMm.min[index]).toSorted((a: number, b: number) => a - b);
    vectorNear(size, [0, 10, 20], 1e-6, "fixture native Wire bounds");
    const reportSize = [...report.boundsMm.size].toSorted((a: number, b: number) => a - b);
    vectorNear(reportSize, size.slice(1), 1e-6, "SVG planar B-Rep bounds");
    requireCondition(report.bodies === 1 && report.lineSegments === curve.segments.length, "SVG does not report the expected exact Wire and line count");
    requireCondition(report.sourceUnits === "millimeter", "SVG export did not declare millimeter source units");
    requireCondition(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), "SVG output does not start with the expected XML declaration");
    const projectedPaths = [...svg.matchAll(/<path d="M ([^ ]+) ([^ ]+) L ([^ ]+) ([^ ]+)"\/>/gu)].map((match) => match.slice(1).map(Number));
    requireCondition(projectedPaths.length === curve.segments.length, "SVG path count differs from exact native Wire segments");
    const projectedLengths = projectedPaths.map(([x1, y1, x2, y2]) => Math.hypot(x2! - x1!, y2! - y1!)).toSorted((a, b) => a - b);
    vectorNear(projectedLengths, nativeLengths, 1e-6, "SVG segment lengths versus native B-Rep");
    const projectedBounds = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x1, y1, x2, y2] of projectedPaths) {
      projectedBounds[0] = Math.min(projectedBounds[0]!, x1!);
      projectedBounds[1] = Math.min(projectedBounds[1]!, y1!);
      projectedBounds[2] = Math.max(projectedBounds[2]!, x2!);
      projectedBounds[3] = Math.max(projectedBounds[3]!, y2!);
    }
    vectorNear(
      projectedBounds,
      [...report.boundsMm.min, ...report.boundsMm.max], 1e-6, "SVG coordinates versus reported exact bounds",
    );
    requireCondition(new RegExp(`width="${formatNumber(report.pageSizeMm[0])}mm" height="${formatNumber(report.pageSizeMm[1])}mm"`).test(svg), "SVG page dimensions do not match the MCP report");
    requireCondition(report.bytes === Buffer.byteLength(svg) && svg.length > 0, "SVG byte count does not match the saved file");
    evidence.export = {
      report,
      sha256: createHash("sha256").update(svg).digest("hex"),
      exactNativeWireCompared: true,
      exactProjectedCoordinatesComparedToNative: true,
      persistentDocumentUnchanged: true,
    };
    evidence.completedAt = new Date().toISOString();
    await writeFile(evidencePath, `${JSON.stringify(sanitizeEvidence(evidence), null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ ok: true, output, svg: svgPath, evidence: evidencePath }, null, 2));
  } catch (error) {
    evidence.failure = boundedError(error);
    await writeFile(join(output, "failure.json"), `${JSON.stringify(sanitizeEvidence(evidence), null, 2)}\n`, { flag: "wx", mode: 0o600 }).catch(() => {});
    throw error;
  } finally {
    await client?.close().catch(() => {});
  }
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

function stateSummary(state: any): Record<string, unknown> {
  return {
    targetId: state.targetId,
    documentToken: state.documentToken,
    revision: state.revision,
    undoDepth: state.undoDepth,
    redoDepth: state.redoDepth,
    bodyIds: state.bodies.map((body: { id: number }) => body.id),
  };
}

function vectorNear(actual: number[], expected: number[], tolerance: number, label: string): void {
  requireCondition(actual.length === expected.length, `${label} has the wrong number of values`);
  actual.forEach((value, index) => {
    const expectedValue = expected[index];
    requireCondition(expectedValue !== undefined && Number.isFinite(value) && Math.abs(value - expectedValue) <= tolerance, `${label}[${index}] expected ${String(expectedValue)} ± ${tolerance}, got ${value}`);
  });
}

function formatNumber(value: number): string { return Number(value.toFixed(12)).toString(); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function boundedError(error: unknown): string { return error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000); }
function requireValue(argv: string[], index: number, option: string): string { const value = argv[index]; if (!value) throw new Error(`${option} requires a value`); return value; }
function selectedEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv { return Object.fromEntries(Object.entries(environment).filter(([key]) => key.startsWith("PLASTICITY_") || key === "PATH" || key === "HOME" || key === "TMPDIR")); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
