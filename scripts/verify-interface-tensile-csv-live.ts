#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Options { help: boolean; allowLive: boolean; output?: string }

export function parseArgs(argv: string[]): Options {
  if (argv.length === 0) return { help: true, allowLive: false };
  const options: Options = { help: false, allowLive: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--allow-live") options.allowLive = true;
    else if (argument === "--output") options.output = requireValue(argv, ++index, "--output");
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.help) return options;
  if (!options.allowLive) throw new Error("Interface tensile CSV stdio acceptance requires --allow-live to start the production MCP process");
  if (!options.output) throw new Error("Interface tensile CSV stdio acceptance requires --output with a new directory");
  if (!isAbsolute(options.output)) throw new Error("--output must be an absolute path");
  return options;
}

const HELP = `Usage:
  node scripts/verify-interface-tensile-csv-live.ts --help
  node scripts/verify-interface-tensile-csv-live.ts --allow-live --output NEW_DIRECTORY

Starts a separate production stdio MCP server and previews synthetic, explicitly
mapped tensile-coupon and DCB traction-separation CSV files. It verifies unit
conversion, curve summaries, source provenance and that previews do not register
tests. It does not connect to Plasticity or read a user's physical test data.`;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const csvPath = join(output, "synthetic-interface-tensile.csv");
  const evidencePath = join(output, "evidence.json");
  const storeRoot = join(output, "strength-store");
  const csv = "specimen;load [kgf]\r\nA;-1,0\r\nA;-3,0\r\nB;-2,0\r\nB;-4,0\r\n";
  await writeFile(csvPath, csv, { flag: "wx", mode: 0o600 });
  const fractureCsvPath = join(output, "synthetic-interface-dcb.csv");
  const fractureCsv = "specimen,opening_um,traction_kPa\nA,0,0\nA,10,1000\nA,20,500\nA,30,0\n";
  await writeFile(fractureCsvPath, fractureCsv, { flag: "wx", mode: 0o600 });
  const evidence: Record<string, unknown> = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    kind: "synthetic-physical-interface-test-csv-previews",
    sourceSha256: createHash("sha256").update(csv).digest("hex"),
    fractureSourceSha256: createHash("sha256").update(fractureCsv).digest("hex"),
    productionStdioMcp: true,
    plasticityConnected: false,
  };
  let client: Client | undefined;
  try {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(projectRoot, "scripts", "run-server.ts")],
      cwd: projectRoot,
      env: {
        ...selectedEnvironment(process.env),
        PLASTICITY_CODEX_EXECUTABLE: "/__codex_disabled_for_synthetic_acceptance__",
        PLASTICITY_STRENGTH_ROOT: storeRoot,
        PLASTICITY_CDP_URL: "http://127.0.0.1:1",
      },
      stderr: "pipe",
    });
    client = new Client({ name: "plasticity-interface-tensile-csv-acceptance", version: "1.0.0" });
    await client.connect(transport);
    const tools = await client.listTools();
    const csvTool = tools.tools.find((tool) => tool.name === "plasticity_import_interface_tensile_csv");
    requireCondition(csvTool, "Production stdio MCP did not expose plasticity_import_interface_tensile_csv");
    requireCondition(csvTool.annotations?.readOnlyHint === true, "CSV preview must be advertised as read-only");
    const fractureCsvTool = tools.tools.find((tool) => tool.name === "plasticity_import_interface_fracture_csv");
    requireCondition(fractureCsvTool, "Production stdio MCP did not expose plasticity_import_interface_fracture_csv");
    requireCondition(fractureCsvTool.annotations?.readOnlyHint === true, "Fracture curve CSV preview must be advertised as read-only");
    const preview = await call(client, "plasticity_import_interface_tensile_csv", {
      path: csvPath,
      specimenIdColumn: "specimen",
      forceColumn: "load [kgf]",
      forceUnit: "kgf",
      forceSign: "negative",
      delimiter: "semicolon",
      decimalSeparator: "comma",
      specimens: [
        { specimenId: "A", netCrossSectionMm2: 4, failureLocation: "interface" },
        { specimenId: "B", netCrossSectionMm2: 5, failureLocation: "fixture" },
      ],
    });
    requireCondition(preview.sourceHash === evidence.sourceSha256, "Preview source SHA-256 does not match the synthetic CSV bytes");
    requireCondition(preview.specimens.length === 2, "Preview omitted one of the explicit specimens");
    requireCondition(Math.abs(preview.specimens[0].peakForceN - 3 * 9.80665) < 1e-10, "kgf peak or negative tensile-sign normalization is incorrect");
    requireCondition(Math.abs(preview.specimens[0].nominalPeakStrengthMPa - (3 * 9.80665) / 4) < 1e-10, "First specimen force/area preview is incorrect");
    requireCondition(preview.specimens[1].failureLocation === "fixture", "Caller-supplied fixture failure location was not preserved");
    requireCondition(preview.summary.interfaceFailureCount === 1, "Only confirmed interface failures should enter descriptive statistics");
    requireCondition(preview.interpretation === "nominal-interface-coupon-strength-screen-only", "Preview did not state its limited interpretation");
    const fracturePreview = await call(client, "plasticity_import_interface_fracture_csv", {
      path: fractureCsvPath,
      fractureMethod: "dcb-mode-i",
      processingAttestation: "already-compliance-corrected-traction-separation",
      specimenIdColumn: "specimen",
      separationColumn: "opening_um",
      tractionColumn: "traction_kPa",
      separationUnit: "um",
      tractionUnit: "kPa",
      delimiter: "comma",
      decimalSeparator: "period",
    });
    requireCondition(fracturePreview.sourceHash === evidence.fractureSourceSha256, "Fracture preview source SHA-256 does not match the synthetic CSV bytes");
    requireCondition(fracturePreview.specimens.length === 1, "Fracture preview omitted the synthetic DCB specimen");
    requireCondition(Math.abs(fracturePreview.specimens[0].measuredPeakStrengthMPa - 1) < 1e-12, "Fracture preview peak or unit conversion is incorrect");
    requireCondition(Math.abs(fracturePreview.specimens[0].analysis.fractureEnergyNPerMm - 0.015) < 1e-12, "Fracture preview integrated work is incorrect");
    requireCondition(fracturePreview.interpretation === "processed-physical-fracture-curve-preview-only", "Fracture preview did not state its limited interpretation");
    const registry = await call(client, "plasticity_list_material_interface_tests", {});
    requireCondition(Array.isArray(registry.records) && registry.records.length === 0, "CSV previews unexpectedly persisted a physical test");
    evidence.preview = preview;
    evidence.fracturePreview = fracturePreview;
    evidence.registryRecordCountAfterPreview = registry.records.length;
    evidence.completedAt = new Date().toISOString();
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ ok: true, output, evidence: evidencePath, plasticityConnected: false }, null, 2));
  } catch (error) {
    evidence.failure = boundedError(error);
    await writeFile(join(output, "failure.json"), `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 }).catch(() => {});
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

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function requireValue(argv: string[], index: number, option: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${option} requires a value`);
  return value;
}

function boundedError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000);
}

function selectedEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => key === "PATH" || key === "HOME" || key === "TMPDIR"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
