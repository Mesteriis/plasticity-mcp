#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Options { help: boolean; target?: string; output?: string; allowDisposableMutations: boolean }

export function parseNativeSphereAcceptanceArgs(argv: string[]): Options {
  const options: Options = { help: argv.length === 0, allowDisposableMutations: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--allow-disposable-mutations") options.allowDisposableMutations = true;
    else if (argument === "--target" || argument === "--output") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      if (argument === "--target") options.target = value;
      else options.output = value;
    } else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Live native-sphere acceptance requires --target with an explicit Plasticity window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native-sphere acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native-sphere acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-sphere-live.ts --help
  node scripts/verify-native-sphere-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

No-argument and --help modes do not connect to Plasticity. Live mode requires
an explicit empty disposable document, verifies the exact native sphere and
mass properties through stdio MCP, checks Undo/Redo, restores the scene, and
writes sanitized evidence.`;

async function main(): Promise<void> {
  const options = parseNativeSphereAcceptanceArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  await mkdir(output, { recursive: false, mode: 0o700 });
  const evidence: Record<string, unknown> = { schemaVersion: 1, startedAt: new Date().toISOString(), targetId: options.target, workbenchUsed: false };
  let client: Client | undefined;
  let initial: any;
  let state: any;
  try {
    client = await startMcp(join(output, "strength-store"));
    const windows = await call(client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    initial = await call(client, "plasticity_connect", { targetId: options.target });
    requireEmpty(initial);
    evidence.initial = summary(initial);
    const snapshot = await call(client, "plasticity_capture_snapshot", { label: "native-sphere-acceptance-initial-empty" });

    const centerMm = [12, -4, 8];
    const radiusMm = 6.5;
    state = await call(client, "plasticity_create_sphere", { centerMm, radiusMm, name: "Acceptance sphere", intent: "Verify native sphere primitive", revision: initial.revision });
    requireCondition(state.bodies.length === 1 && state.bodies[0].type === "Solid", "Sphere creation did not return one Solid");
    const sphereId = state.bodies[0].id;
    const sphere = (await call(client, "plasticity_body_info", { id: sphereId })).body;
    requireCondition(sphere?.id === sphereId, "Exact sphere B-Rep details were not returned");
    requireCondition(sphere.faces.length === 1 && sphere.faces[0].surfaceType === "Sphere", "Native B-Rep is not one analytic Sphere face");
    vectorNear(sphere.boundsMm.min, centerMm.map((value) => value - radiusMm), 0.00001, "sphere bounds minimum");
    vectorNear(sphere.boundsMm.max, centerMm.map((value) => value + radiusMm), 0.00001, "sphere bounds maximum");
    const validation = await call(client, "plasticity_validate_bodies", { ids: [sphere.id], revision: state.revision });
    requireCondition(validation.bodies.length === 1 && validation.bodies[0].nativeValid && validation.bodies[0].printableSolid, "Sphere failed native Solid validation");
    const properties = await call(client, "plasticity_measure_solid_properties", { ids: [sphere.id], revision: state.revision });
    near(properties.bodies[0].volumeMm3, 4 * Math.PI * radiusMm ** 3 / 3, 0.00001, "sphere volume");
    near(properties.bodies[0].surfaceAreaMm2, 4 * Math.PI * radiusMm ** 2, 0.00001, "sphere surface area");
    vectorNear(properties.bodies[0].volumeCentroidMm, centerMm, 0.00001, "sphere volume centroid");
    evidence.sphere = { bodyId: sphere.id, centerMm, radiusMm, surfaceType: sphere.faces[0].surfaceType, boundsMm: sphere.boundsMm, validation: validation.bodies[0], massProperties: properties.bodies[0] };

    state = await call(client, "plasticity_undo", { intent: "Verify native sphere Undo", revision: state.revision });
    requireEmpty(state);
    state = await call(client, "plasticity_redo", { intent: "Verify native sphere Redo", revision: state.revision });
    requireCondition(state.bodies.length === 1 && state.bodies[0].id === sphere.id, "Redo did not restore the same sphere body ID");
    vectorNear(state.bodies[0].boundsMm.max, centerMm.map((value) => value + radiusMm), 0.00001, "redone sphere bounds");
    state = await call(client, "plasticity_undo", { intent: "Restore initial empty scene after sphere acceptance", revision: state.revision });
    requireEmpty(state);
    const changes = await call(client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(changes.diff), "Scene content differs from the initial empty snapshot after cleanup");
    evidence.undoRedo = true;
    evidence.cleanup = { restoredEmptyDocument: true, sceneContentsRestored: true };
    evidence.completedAt = new Date().toISOString();
    await writeExclusive(join(output, "evidence.json"), sanitizeEvidence(evidence));
    console.log(JSON.stringify({ ok: true, output, evidence: join(output, "evidence.json"), sphere: evidence.sphere }));
  } catch (error) {
    evidence.error = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
    if (client && initial && state && state.documentToken === initial.documentToken) {
      try {
        const current = await call(client, "plasticity_status", {});
        if (current.documentToken === initial.documentToken && current.revision === state.revision && current.undoDepth > initial.undoDepth) {
          let status = current;
          for (let attempt = 0; attempt < 8 && status.undoDepth > initial.undoDepth; attempt += 1) {
            status = await call(client, "plasticity_undo", { intent: "Recover disposable sphere acceptance", revision: status.revision });
          }
          evidence.recovery = { restoredEmptyDocument: status.bodies.length === 0 && status.regions.length === 0 };
        }
      } catch { /* Preserve the primary failure; inspect the disposable scene manually if recovery reads fail. */ }
    }
    await writeExclusive(join(output, "failure.json"), sanitizeEvidence(evidence)).catch(() => {});
    throw error;
  } finally { await client?.close().catch(() => {}); }
}

async function startMcp(storeRoot: string): Promise<Client> {
  const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof process.env[key] === "string" ? [[key, process.env[key]!]] : []));
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: { ...env, PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" }, stderr: "pipe" });
  const client = new Client({ name: "plasticity-native-sphere-live", version: "1.0.0" });
  await client.connect(transport);
  return client;
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
  if (!item) throw new Error("MCP tool returned no text result");
  return item.text;
}
function requireEmpty(state: any): void {
  requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0 && (state.referenceMeshes ?? []).length === 0, "Refusing sphere acceptance in a nonempty Plasticity document");
  requireCondition((state.measurements ?? []).length === 0 && (state.sectionAnalyses ?? []).length === 0, "Refusing sphere acceptance while document annotations or section analyses exist");
  requireCondition((state.groups ?? []).every((group: { id: number }) => group.id === 0), "Refusing sphere acceptance while non-root groups exist");
}
function summary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length }; }
function near(actual: number, expected: number, tolerance: number, label: string): void { requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`); }
function vectorNear(actual: unknown, expected: number[], tolerance: number, label: string): void { requireCondition(Array.isArray(actual) && actual.length === expected.length, `${label}: vector length mismatch`); actual.forEach((value, index) => near(value, expected[index]!, tolerance, `${label}[${index}]`)); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
