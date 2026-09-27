#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { TongueRootInput } from "../src/strength/tongue-root-contracts.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface ArbitrarySectionAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

export function parseArbitrarySectionAcceptanceArgs(argv: string[]): ArbitrarySectionAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: ArbitrarySectionAcceptanceOptions = { help: false, allowDisposableMutations: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--allow-disposable-mutations") options.allowDisposableMutations = true;
    else if (argument === "--target") options.target = requiredValue(argv, ++index, argument);
    else if (argument === "--output") options.output = requiredValue(argv, ++index, argument);
    else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Live arbitrary-section acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Live arbitrary-section acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live arbitrary-section acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-arbitrary-section-live.ts --help
  node scripts/verify-arbitrary-section-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

Live mode refuses a nonempty Plasticity document, uses the explicitly selected
window through a separate stdio MCP process, restores the empty document and
writes compact evidence to a new directory.`;

async function main(): Promise<void> {
  const options = parseArbitrarySectionAcceptanceArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const evidence: Record<string, unknown> = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    targetId: options.target,
    plasticityVersion: "26.1.3",
    workbenchUsed: false,
  };
  let client: Client | undefined;
  let initial: any;
  try {
    client = await startMcp();
    const windows = await call(client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    initial = await call(client, "plasticity_connect", { targetId: options.target });
    requireCondition(initial.bodies.length === 0, "Refusing disposable mutations in a nonempty Plasticity document");
    evidence.initial = stateSummary(initial);

    const created = await call(client, "plasticity_create_box", {
      originMm: [0, 0, 0],
      sizeMm: [20, 10, 5],
      name: "Disposable arbitrary section acceptance",
      intent: "Approved exact arbitrary-section acceptance",
      revision: initial.revision,
    });
    requireCondition(created.bodies.length === 1, "Disposable box creation did not yield exactly one body");
    const bodyId = created.bodies[0].id;
    const before = await call(client, "plasticity_status", {});

    const horizontal = await inspect(client, bodyId, before.revision, {
      originMm: [0, 0, 2.5], normal: [0, 0, 1], xDirection: [1, 0, 0],
    });
    requireVerified(horizontal);
    near(horizontal.properties.areaMm2, 200, 1e-8, "horizontal area");
    near(horizontal.properties.ixxMm4, 1666.6666666666667, 1e-8, "horizontal Ixx");
    near(horizontal.properties.iyyMm4, 6666.666666666667, 1e-8, "horizontal Iyy");
    const afterHorizontal = await call(client, "plasticity_status", {});
    requireSamePersistentState(before, afterHorizontal, "horizontal section");

    const rootPlane = { originMm: [0.1, 5, 2.5], normal: [1, 0, 0], xDirection: [0, 1, 0] };
    const rootSection = await call(client, "plasticity_inspect_tongue_root_section", {
      bodyId,
      revision: before.revision,
      plane: rootPlane,
    });
    requireCondition(rootSection.status === "verified", `Tongue-root section inspection failed: ${JSON.stringify(rootSection.reasons ?? [])}`);
    near(rootSection.dimensions.rootWidthMm, 10, 1e-8, "tongue-root width");
    near(rootSection.dimensions.rootThicknessMm, 5, 1e-8, "tongue-root thickness");
    const tongueRootInput = tongueRootScenario(rootSection.dimensions, rootSection.binding);
    const tongueRootReport = await call(client, "plasticity_verify_tongue_root_strength", { input: tongueRootInput });
    requireCondition(tongueRootReport.kind === "tongue-root" && tongueRootReport.result.status === "conditional", "Tongue-root verification did not persist a root-only conditional report");
    requireCondition(tongueRootReport.input.geometry.rootWidthMm === 10 && tongueRootReport.input.geometry.rootThicknessMm === 5, "Tongue-root report did not replace scenario dimensions with measured B-rep values");
    const tongueRootCurrent = await call(client, "plasticity_strength_report", { reportId: tongueRootReport.id, current: tongueRootReport.input });
    requireCondition(tongueRootCurrent.freshness === "current", "Tongue-root report did not revalidate against the live exact section");
    const afterTongueRoot = await call(client, "plasticity_status", {});
    requireSamePersistentState(before, afterTongueRoot, "tongue-root inspection and verification");

    const tilted = await inspect(client, bodyId, before.revision, {
      originMm: [10, 5, 2.5], normal: [0, 1, 1], xDirection: [1, 0, 0],
    });
    requireVerified(tilted);
    near(tilted.properties.areaMm2, 100 * Math.SQRT2, 1e-8, "tilted area");
    near(tilted.properties.ixxMm4, 625 * Math.SQRT2 * 2 / 3, 1e-8, "tilted Ixx");
    near(tilted.properties.iyyMm4, 10_000 * Math.SQRT2 / 3, 1e-8, "tilted Iyy");
    const afterTilted = await call(client, "plasticity_status", {});
    requireSamePersistentState(before, afterTilted, "tilted section");

    const cleanup = await call(client, "plasticity_undo", {
      intent: "Cleanup disposable arbitrary-section acceptance",
      revision: afterTilted.revision,
    });
    requireCondition(cleanup.documentToken === initial.documentToken && cleanup.bodies.length === 0, "Cleanup did not restore the empty document");
    evidence.sections = {
      bodyId,
      horizontal: propertySummary(horizontal),
      tilted: propertySummary(tilted),
      persistentStatePreserved: true,
    };
    evidence.tongueRoot = {
      dimensions: rootSection.dimensions,
      resultStatus: tongueRootReport.result.status,
      reportFreshness: tongueRootCurrent.freshness,
      exactBrepSection: true,
    };
    evidence.cleanup = { restoredEmptyDocument: true, state: stateSummary(cleanup) };
    evidence.completedAt = new Date().toISOString();
    await writeFile(join(output, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ ok: true, evidence: join(output, "evidence.json") }, null, 2));
  } catch (error) {
    evidence.failure = boundedError(error);
    if (client && initial) evidence.cleanup = await recover(client, initial).catch((cleanupError) => ({ restoredEmptyDocument: false, reason: boundedError(cleanupError) }));
    await writeFile(join(output, "failure.json"), `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 }).catch(() => {});
    throw error;
  } finally {
    await client?.close().catch(() => {});
  }
}

function tongueRootScenario(
  dimensions: { rootWidthMm: number; rootThicknessMm: number },
  binding: NonNullable<TongueRootInput["binding"]>,
): TongueRootInput {
  const values: Record<string, { value: number; unit: "mm" | "N" | "MPa" | "ratio" }> = {
    "geometry.rootWidthMm": { value: dimensions.rootWidthMm, unit: "mm" },
    "geometry.rootThicknessMm": { value: dimensions.rootThicknessMm, unit: "mm" },
    "geometry.leverArmMm": { value: 19.9, unit: "mm" },
    "loads.transverseForceN": { value: 5, unit: "N" },
    "material.youngModulusMPa": { value: 2000, unit: "MPa" },
    "material.shearModulusMPa": { value: 700, unit: "MPa" },
    "material.tensileAllowableMPa": { value: 30, unit: "MPa" },
    "material.shearAllowableMPa": { value: 15, unit: "MPa" },
    shearCorrectionFactor: { value: 5 / 6, unit: "ratio" },
    safetyFactor: { value: 2, unit: "ratio" },
    maxDeflectionMm: { value: 2, unit: "mm" },
  };
  const evidence = Object.entries(values).map(([path, item]) => ({
    id: path,
    label: path,
    status: "measured" as const,
    unit: item.unit,
    value: item.value,
    sourceLocator: path.startsWith("geometry.root")
      ? `plasticity:${binding.documentToken}#body=${binding.bodyId}&section=${binding.topologySignature}@${binding.revision}`
      : `acceptance scenario:${path}`,
    dependsOn: [],
  }));
  return {
    kind: "tongue-root",
    goal: "Live exact rectangular tongue-root acceptance",
    method: "tongue-root-transverse-v1",
    geometry: { ...dimensions, leverArmMm: 19.9 },
    loads: { transverseForceN: 5 },
    material: {
      id: "acceptance-only-profile",
      name: "Synthetic acceptance profile, not production allowables",
      youngModulusMPa: 2000,
      shearModulusMPa: 700,
      tensileAllowableMPa: 30,
      shearAllowableMPa: 15,
      suitability: "matched",
      evidenceIds: ["material.youngModulusMPa", "material.shearModulusMPa", "material.tensileAllowableMPa", "material.shearAllowableMPa"],
      manufacturing: {
        printerId: "acceptance-printer",
        profileHash: "b".repeat(64),
        orientationDeg: [0, 0, 0],
        infillPercent: 100,
        temperatureC: 220,
        effectiveSection: "validated-effective",
      },
    },
    shearCorrectionFactor: 5 / 6,
    safetyFactor: 2,
    maxDeflectionMm: 2,
    evidence,
    assignments: Object.fromEntries(evidence.map((item) => [item.id, item.id])),
    assumptions: [
      "static-load", "ideal-fixed-root", "beam-kinematics-applicable", "point-load-at-known-lever-arm",
      "rectangular-prismatic-root", "linear-elastic-effective-properties", "root-stress-concentration-not-included",
    ].map((code) => ({ code, confirmed: true, evidenceIds: [] })),
    binding,
  };
}

async function startMcp(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(projectRoot, "scripts", "run-server.ts")],
    cwd: projectRoot,
    env: {
      ...selectedEnvironment(process.env),
      PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "plasticity-arbitrary-section-live", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function inspect(client: Client, bodyId: number, revision: string, plane: Record<string, unknown>): Promise<any> {
  return await call(client, "plasticity_inspect_arbitrary_section", { bodyId, revision, plane });
}

async function call(client: Client, name: string, arguments_: Record<string, unknown>): Promise<any> {
  const response = await client.callTool({ name, arguments: arguments_ });
  const text = toolText(response);
  if ("isError" in response && response.isError) throw new Error(text);
  return JSON.parse(text);
}

function toolText(response: unknown): string {
  if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content");
  const item = response.content.find((entry): entry is { type: "text"; text: string } =>
    typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string");
  if (!item) throw new Error("MCP tool returned no text content");
  return item.text;
}

function requireVerified(section: any): void {
  requireCondition(section?.status === "verified", `Section inspection failed: ${JSON.stringify(section?.reasons ?? [])}`);
  requireCondition(section.source === "native-brep-temporary-section", "Section source is not exact temporary native B-rep");
  requireCondition(section.frame && section.properties && Array.isArray(section.loops), "Verified section omitted exact geometry");
}

function requireSamePersistentState(before: any, after: any, label: string): void {
  requireCondition(before.documentToken === after.documentToken, `${label} changed the document`);
  requireCondition(before.revision === after.revision, `${label} changed the revision`);
  requireCondition(before.undoDepth === after.undoDepth && before.redoDepth === after.redoDepth, `${label} changed Undo/Redo history`);
  requireCondition(JSON.stringify(before.bodies) === JSON.stringify(after.bodies), `${label} changed persistent body geometry`);
}

function propertySummary(section: any): Record<string, unknown> {
  return {
    frame: section.frame,
    areaMm2: section.properties.areaMm2,
    centroidMm: section.properties.centroidMm,
    ixxMm4: section.properties.ixxMm4,
    iyyMm4: section.properties.iyyMm4,
    ixyMm4: section.properties.ixyMm4,
    topologySignature: section.properties.topologySignature,
    source: section.properties.source,
  };
}

async function recover(client: Client, initial: any): Promise<Record<string, unknown>> {
  let state = await call(client, "plasticity_status", {});
  if (state.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" };
  let undoCount = 0;
  while (state.bodies.length > 0 && state.undoDepth > initial.undoDepth && undoCount < 8) {
    state = await call(client, "plasticity_undo", { intent: "Arbitrary-section acceptance failure cleanup", revision: state.revision });
    undoCount += 1;
  }
  return { restoredEmptyDocument: state.bodies.length === 0, undoCount };
}

function stateSummary(state: any): Record<string, unknown> {
  return { documentToken: state.documentToken, revision: state.revision, bodyCount: state.bodies.length, undoDepth: state.undoDepth, redoDepth: state.redoDepth };
}

function near(actual: number, expected: number, tolerance: number, label: string): void {
  requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`);
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function requiredValue(argv: string[], index: number, option: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${option} requires a value`);
  return value;
}

function selectedEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ["CODEX_HOME", "PATH", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "SSL_CERT_FILE", "LANG", "LC_ALL"]) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replaceAll(/\s+/g, " ").slice(0, 1_000);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(boundedError(error));
    process.exitCode = 1;
  });
}
