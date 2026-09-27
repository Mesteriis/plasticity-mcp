#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Options { help: boolean; target?: string; allowDisposableMutations: boolean; output?: string }
interface LiveMcp { client: Client; stderr: string[] }

export function parseNativeUiEditArgs(argv: string[]): Options {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: Options = { help: false, allowDisposableMutations: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--allow-disposable-mutations") options.allowDisposableMutations = true;
    else if (argument === "--target") {
      const value = argv[++index];
      if (!value) throw new Error("--target requires an explicit Plasticity window ID");
      options.target = value;
    } else if (argument === "--output") {
      const value = argv[++index];
      if (!value) throw new Error("--output requires a new directory path");
      options.output = value;
    } else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Live UI-edit acceptance requires --target with an explicit Plasticity window ID");
  if (!options.allowDisposableMutations) throw new Error("Live UI-edit acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live UI-edit acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-ui-edits-live.ts --help
  node scripts/verify-native-ui-edits-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode requires an empty document, creates and selects one temporary Solid,
then waits for a direct mouse edit in the Plasticity UI. It checks the scene diff,
native bounds, Undo/Redo and recovery to the original empty document.`;

async function main(): Promise<void> {
  const options = parseNativeUiEditArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const evidence: Record<string, unknown> = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    targetId: options.target!,
    directUiEditTest: true,
    workbenchUsed: false,
  };
  let live: LiveMcp | undefined;
  let initialState: any;
  let baselineState: any;
  let diff: any;
  try {
    live = await startMcp(join(output, "strength-store"));
    const windows = await call(live.client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    initialState = await call(live.client, "plasticity_connect", { targetId: options.target });
    requireEmpty(initialState);
    evidence.initial = stateSummary(initialState);

    let state = await call(live.client, "plasticity_create_box", {
      originMm: [0, 0, 0], sizeMm: [20, 20, 10], name: "Direct UI edit acceptance",
      intent: "Create one disposable Solid for direct Plasticity UI-edit verification", revision: initialState.revision,
    });
    const body = onlyNamedBody(state, "Direct UI edit acceptance");
    await call(live.client, "plasticity_select_bodies", { ids: [body.id], revision: state.revision });
    await call(live.client, "plasticity_set_view", { view: "isometric", fit: true });
    baselineState = await call(live.client, "plasticity_status", {});
    requireCondition(baselineState.bodies.length === 1 && baselineState.bodies[0]?.id === body.id, "Disposable test Solid was not selected and readable before the manual edit");
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-ui-edit-live-before-manual-move" });
    evidence.baseline = { ...stateSummary(baselineState), body: compactBody(baselineState.bodies[0]!) };

    console.log(`Selected temporary Solid ${body.id} in Plasticity window ${options.target}.`);
    console.log("In Plasticity, drag the selected Solid a visible distance with the mouse, then press Enter here to verify the live scene diff.");
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try { await terminal.question("> "); } finally { terminal.close(); }

    const waited = await call(live.client, "plasticity_wait_for_change", { snapshotId: snapshot.snapshotId, timeoutMs: 30_000 });
    diff = waited.diff;
    requireCondition(diff.sceneChanged === true, "Manual UI action did not produce a reportable scene diff");
    requireCondition(diff.added.length === 0 && diff.removed.length === 0, "Direct edit unexpectedly added or removed bodies");
    requireCondition(diff.modified.length === 1 && diff.modified[0]?.id === body.id && diff.modified[0]?.geometryChanged === true,
      "Direct UI edit was not reported as a geometric modification of the selected Solid");
    const editedState = await call(live.client, "plasticity_status", {});
    const editedBody = editedState.bodies.find((candidate: any) => candidate.id === body.id);
    requireCondition(editedBody && JSON.stringify(editedBody.boundsMm) !== JSON.stringify(baselineState.bodies[0].boundsMm),
      "The direct UI gesture did not change the native Solid bounds");
    evidence.uiEdit = {
      sceneChanged: diff.sceneChanged,
      revisionChanged: diff.revisionChanged,
      modified: diff.modified.map((item: any) => ({ id: item.id, geometryChanged: item.geometryChanged, before: compactBody(item.before), after: compactBody(item.after) })),
      current: stateSummary(editedState),
    };

    const undone = await call(live.client, "plasticity_undo", { intent: "Verify Undo of the direct Plasticity UI edit", revision: editedState.revision });
    requireCondition(JSON.stringify(undone.bodies.find((candidate: any) => candidate.id === body.id)?.boundsMm) === JSON.stringify(baselineState.bodies[0].boundsMm),
      "Undo did not restore the exact pre-edit Solid bounds");
    const redone = await call(live.client, "plasticity_redo", { intent: "Verify Redo of the direct Plasticity UI edit", revision: undone.revision });
    requireCondition(JSON.stringify(redone.bodies.find((candidate: any) => candidate.id === body.id)?.boundsMm) === JSON.stringify(editedBody.boundsMm),
      "Redo did not restore the exact directly edited Solid bounds");
    evidence.undoRedo = { verified: true, afterUndo: compactBody(undone.bodies[0]!), afterRedo: compactBody(redone.bodies[0]!) };

    const cleanup = await recover(live.client, initialState);
    evidence.cleanup = cleanup;
    requireCondition(cleanup.restoredEmptyDocument === true, "Recovery did not restore the original empty document");
    const finalState = await call(live.client, "plasticity_status", {});
    evidence.final = stateSummary(finalState);
    evidence.completedAt = new Date().toISOString();
    console.log(JSON.stringify({ ok: true, directUiGeometryChangeDetected: true, modifiedBodyId: body.id, undoRedo: true, restoredEmptyDocument: true }));
  } catch (error) {
    evidence.error = boundedError(error);
    if (live && initialState) {
      const cleanup = await recover(live.client, initialState).catch((cleanupError) => ({ restoredEmptyDocument: false, reason: boundedError(cleanupError) }));
      evidence.cleanup = cleanup;
    }
    throw error;
  } finally {
    evidence.stderr = live?.stderr.join("").slice(-8000) ?? "";
    await writeExclusive(join(output, "evidence.json"), evidence);
    await live?.client.close().catch(() => {});
  }
}

function requireEmpty(state: any): void {
  requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0,
    "Live UI-edit acceptance refuses a nonempty Plasticity document");
}
function onlyNamedBody(state: any, name: string): any {
  const matches = state.bodies.filter((body: any) => body.name === name);
  requireCondition(matches.length === 1, `Expected one body named ${name}`);
  return matches[0];
}
function compactBody(body: any): Record<string, unknown> {
  return { id: body.id, versionId: body.versionId, boundsMm: body.boundsMm, faceCount: body.faces.length, edgeCount: body.edges.length, vertices: body.vertices };
}
function stateSummary(state: any): Record<string, unknown> {
  return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, regionCount: state.regions.length };
}
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

async function startMcp(storeRoot: string): Promise<LiveMcp> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(projectRoot, "scripts", "run-server.ts")],
    cwd: projectRoot,
    env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" },
    stderr: "pipe",
  });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); });
  const client = new Client({ name: "plasticity-native-ui-edits-live", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr };
}
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await client.callTool({ name, arguments: args });
  const content = Array.isArray(response.content) ? response.content : [];
  const text = content.find((item: unknown): item is { type: "text"; text: string } =>
    typeof item === "object" && item !== null && "type" in item && item.type === "text" && "text" in item && typeof item.text === "string")?.text;
  if (!text || response.isError) throw new Error(text ?? `MCP tool ${name} returned no text`);
  return JSON.parse(text);
}
async function recover(client: Client, initial: any): Promise<Record<string, unknown>> {
  for (let count = 0; count < 24; count += 1) {
    const status = await call(client, "plasticity_status", {});
    if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" };
    if (status.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: status.bodies.length === 0 && status.regions.length === 0 };
    await call(client, "plasticity_undo", { intent: "Recover disposable direct UI-edit acceptance", revision: status.revision });
  }
  return { restoredEmptyDocument: false, reason: "undo-limit" };
}
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : []));
}
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
}
