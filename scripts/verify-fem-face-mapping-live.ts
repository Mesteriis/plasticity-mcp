#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { mapNativePlanarFacesToStep } from "../src/strength/fem/step-face-mapping.ts";
import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
interface Options { help: boolean; target?: string; allowMutations: boolean; output?: string }

function parseArgs(argv: string[]): Options {
  if (argv.length === 0) return { help: true, allowMutations: false };
  const options: Options = { help: false, allowMutations: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--allow-disposable-mutations") options.allowMutations = true;
    else if (argument === "--target" || argument === "--output") {
      const value = argv[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      if (argument === "--target") options.target = value;
      else options.output = value;
    } else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Pass --target with an explicit Plasticity window ID");
  if (!options.allowMutations) throw new Error("Pass --allow-disposable-mutations to authorize the disposable box test");
  if (!options.output) throw new Error("Pass --output with a new evidence directory");
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: npm run accept:fem-face-mapping -- --target WINDOW_ID --allow-disposable-mutations --output NEW_DIRECTORY");
    return;
  }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const evidence: Record<string, unknown> = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    targetId: options.target,
    plasticityVersion: "26.1.3",
  };
  const store = join(output, "strength-store");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(projectRoot, "scripts", "run-server.ts")],
    cwd: projectRoot,
    env: {
      ...selectedEnvironment(process.env),
      PLASTICITY_STRENGTH_ROOT: store,
      PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "plasticity-fem-face-map-acceptance", version: "1.0.0" });
  let initial: any;
  let disposableBodyId: number | undefined;
  try {
    await client.connect(transport);
    const windows = await call(client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    initial = await call(client, "plasticity_connect", { targetId: options.target });
    requireCondition(initial.bodies.length === 0, "Refusing the face-mapping test in a nonempty document");
    const snapshot = await call(client, "plasticity_capture_snapshot", { label: "fem-face-map-before" });

    const created = await call(client, "plasticity_create_box", {
      originMm: [0, 0, 0],
      sizeMm: [10, 5, 4],
      name: "Disposable FEA face-mapping probe",
      intent: "Authorized mesh face-mapping feasibility acceptance",
      revision: initial.revision,
    });
    requireCondition(created.bodies.length === 1, "Native probe did not produce exactly one Solid");
    const body = created.bodies[0];
    disposableBodyId = body.id;
    requireCondition(body.faces.length === 6, `Expected 6 native box faces, found ${body.faces.length}`);
    const stepPath = join(output, "probe.step");
    const exported = await call(client, "plasticity_export_step", { ids: [body.id], path: stepPath, revision: created.revision });
    const afterExport = await call(client, "plasticity_status", {});
    requireCondition(afterExport.bodies.length === 1 && afterExport.bodies[0].id === body.id, "STEP export changed native scene contents");

    const mapping = await mapNativePlanarFacesToStep(stepPath, body.faces.map((face: any) => ({
      faceId: face.id,
      surfaceType: face.surfaceType,
      centerMm: face.centerMm,
      normal: face.normal,
      boundsMm: face.boundsMm,
    })));
    requireCondition(mapping.volumeCount === 1 && mapping.mappings.length === 6, "Gmsh did not map all faces of exactly one Solid");
    requireCondition(new Set(mapping.mappings.map((item) => item.surfaceEntityTag)).size === 6, "Gmsh surface mapping is not bijective");
    requireCondition(mapping.mappings.every((item) => item.maxSignatureErrorMm <= mapping.toleranceMm && item.normalDot >= 0.99999), "Mapped face signature exceeded its strict tolerance");
    near(mapping.mappings.reduce((total, item) => total + item.areaMm2, 0), 220, 0.001, "sum of six mapped face areas");

    const journal = await call(client, "plasticity_construction_journal", {});
    requireCondition(journal.syncStatus === "in-sync" && !journal.entries.some((entry: { status: string }) => entry.status === "unknown"), "Construction journal is not clean before cleanup");
    const cleaned = await call(client, "plasticity_undo", { intent: "Cleanup disposable FEA face-mapping probe", revision: afterExport.revision });
    requireCondition(cleaned.documentToken === initial.documentToken && cleaned.bodies.length === 0, "Undo did not restore the empty document");
    disposableBodyId = undefined;
    const changes = await call(client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(changes.diff), "Scene contents differ from the original empty snapshot");

    evidence.completedAt = new Date().toISOString();
    evidence.nativeBodyId = body.id;
    evidence.stepBytes = exported.bytes;
    evidence.meshAdapter = mapping;
    evidence.cleanup = { restoredEmptyDocument: true, sceneContentsRestored: true, revisionChanged: true };
    await writeFile(join(output, "evidence.json"), JSON.stringify(sanitizeEvidence(evidence), null, 2), { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ ok: true, evidence: join(output, "evidence.json") }, null, 2));
  } catch (error) {
    evidence.failure = error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
    if (initial && disposableBodyId !== undefined) {
      try {
        const current = await call(client, "plasticity_status", {});
        if (current.bodies.length === 1 && current.bodies[0].id === disposableBodyId) {
          const cleaned = await call(client, "plasticity_undo", { intent: "Failure cleanup of disposable FEA probe", revision: current.revision });
          evidence.cleanup = { restoredEmptyDocument: cleaned.bodies.length === 0 };
        } else {
          evidence.cleanup = { restoredEmptyDocument: false, reason: "Scene changed independently; no automatic Undo was attempted" };
        }
      } catch (cleanupError) {
        evidence.cleanup = { restoredEmptyDocument: false, reason: cleanupError instanceof Error ? cleanupError.message.slice(0, 1_000) : String(cleanupError) };
      }
    }
    await writeFile(join(output, "failure.json"), JSON.stringify(sanitizeEvidence(evidence), null, 2), { flag: "wx", mode: 0o600 });
    throw error;
  } finally {
    await client.close().catch(() => {});
  }
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await client.callTool({ name, arguments: args }) as {
    isError?: boolean;
    content: Array<{ type: string; text?: string }>;
  };
  const item = response.content.find((entry) => entry.type === "text");
  if (response.isError || !item || item.type !== "text" || typeof item.text !== "string") throw new Error(`${name} failed: ${JSON.stringify(response.content)}`);
  return JSON.parse(item.text);
}

function selectedEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([key, value]) => value !== undefined && /^(PATH|HOME|TMPDIR|TMP|TEMP|LANG|LC_[A-Z_]+|CODEX_HOME|CODEX_CLI_PATH|OPENAI_API_KEY|PLASTICITY_[A-Z0-9_]+|PLASTICITY_MCP_[A-Z0-9_]+)$/.test(key)));
}

function near(actual: number, expected: number, tolerance: number, label: string): void {
  requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`);
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
