#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { comparePngPixels } from "./png-pixels.ts";
import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export interface NativeSectionAnalysisAcceptanceOptions { help: boolean; target?: string; allowDisposableMutations: boolean; output?: string }
interface LiveMcp { client: Client; stderr: string[] }

export function parseNativeSectionAnalysisAcceptanceArgs(argv: string[]): NativeSectionAnalysisAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: NativeSectionAnalysisAcceptanceOptions = { help: false, allowDisposableMutations: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--allow-disposable-mutations") options.allowDisposableMutations = true;
    else if (argument === "--target") { const value = argv[++index]; if (!value) throw new Error("--target requires an explicit Plasticity window ID"); options.target = value; }
    else if (argument === "--output") { const value = argv[++index]; if (!value) throw new Error("--output requires a new directory path"); options.output = value; }
    else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Live native section-analysis acceptance requires --target with an explicit Plasticity window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native section-analysis acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native section-analysis acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-section-analysis-live.ts --help
  node scripts/verify-native-section-analysis-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

Live mode refuses nonempty geometry or existing sections, creates a disposable
Solid and native section analysis, verifies stable read-back, viewport-only
history behavior, rendered clipping by comparing screenshot pixels, deletion,
visual restoration, and cleanup.`;

async function main(): Promise<void> {
  const options = parseNativeSectionAnalysisAcceptanceArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!); await mkdir(output, { mode: 0o700 });
  const evidence: Record<string, unknown> = { schemaVersion: 1, startedAt: new Date().toISOString(), targetId: options.target!, workbenchUsed: false };
  let live: LiveMcp | undefined; let initialState: any;
  try {
    live = await startMcp(join(output, "strength-store"));
    const windows = await call(live.client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    initialState = await call(live.client, "plasticity_connect", { targetId: options.target });
    requireEmpty(initialState, "initial document"); requireCondition((initialState.sectionAnalyses ?? []).length === 0, "Initial document has section analyses");
    evidence.initial = summary(initialState);
    const initialSnapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-section-analysis-live-initial-empty" });

    let state = await call(live.client, "plasticity_create_box", { originMm: [0, 0, 0], sizeMm: [20, 10, 10], intent: "Approved disposable native section source", revision: initialState.revision });
    const solidRevision = state.revision; const solidUndoDepth = state.undoDepth;
    await call(live.client, "plasticity_set_view", { view: "isometric", fit: true });
    const solidSnapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-section-analysis-live-solid" });
    const solidScreenshot = await captureScreenshot(live.client, join(output, "solid-before-section.png"));
    state = await call(live.client, "plasticity_create_section_analysis", { originMm: [0, 0, 5], normal: [0, 0, 1], name: "Mid section", intent: "Show the lower half of the disposable Solid", revision: solidRevision });
    requireCondition(state.revision !== solidRevision, "Section analysis change was not included in the MCP revision");
    requireCondition(state.undoDepth === solidUndoDepth, "Section analysis added an Undo history entry");
    const section = onlySection(state, "Mid section"); verifySection(section);
    const listed = await call(live.client, "plasticity_list_section_analyses", {}); const listedSection = onlySection(listed, "Mid section");
    requireCondition(listedSection.id === section.id, "Section analysis stable ID changed on read-back"); verifySection(listedSection);
    const sectionChanges = await call(live.client, "plasticity_changes_since", { snapshotId: solidSnapshot.snapshotId });
    requireCondition(sectionChanges.diff.sectionAnalysesChanged === true, "Section analysis change was not detected");
    requireCondition((sectionChanges.diff.added ?? []).length === 0 && (sectionChanges.diff.modified ?? []).length === 0, "Section analysis was misclassified as B-Rep geometry change");
    const sectionScreenshot = await captureScreenshot(live.client, join(output, "section-analysis.png"));
    const renderedDifference = comparePngPixels(solidScreenshot.png, sectionScreenshot.png);
    requireCondition(renderedDifference.changedPixelRatio >= 0.01, `Section plane did not visibly change at least 1% of viewport pixels (changed ${renderedDifference.changedPixelRatio})`);
    evidence.section = {
      ...listedSection,
      revisionChanged: true,
      undoDepthUnchanged: true,
      screenshots: { before: solidScreenshot.summary, section: sectionScreenshot.summary },
      renderedDifference,
    };

    state = await call(live.client, "plasticity_delete_section_analysis", { id: section.id, intent: "Remove disposable native section analysis", revision: state.revision });
    requireCondition((state.sectionAnalyses ?? []).length === 0, "Section analysis deletion did not clear the view");
    requireCondition(state.revision === solidRevision && state.undoDepth === solidUndoDepth, "Section deletion changed B-Rep revision or Undo history");
    const cleanupScreenshot = await captureScreenshot(live.client, join(output, "section-cleanup.png"));
    const cleanupDifference = comparePngPixels(solidScreenshot.png, cleanupScreenshot.png);
    requireCondition(cleanupDifference.changedPixelRatio <= 0.01, `Deleting the section did not visually restore the prior viewport (changed ${cleanupDifference.changedPixelRatio})`);
    const afterDeleteChanges = await call(live.client, "plasticity_changes_since", { snapshotId: solidSnapshot.snapshotId });
    requireCondition(afterDeleteChanges.diff.changed === false, "Create/delete section round-trip did not restore the prior view state");
    evidence.cleanupScreenshots = { restored: cleanupScreenshot.summary, differenceFromSolid: cleanupDifference };

    while (state.undoDepth > initialState.undoDepth) state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable native section-analysis acceptance", revision: state.revision });
    requireEmpty(state, "cleaned document"); requireCondition((state.sectionAnalyses ?? []).length === 0, "Cleanup left section analyses");
    const changes = await call(live.client, "plasticity_changes_since", { snapshotId: initialSnapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(changes.diff), "Scene content differs from the initial empty snapshot after cleanup");
    evidence.cleanup = { restoredEmptyDocument: true, sectionAnalysesRemoved: true, sceneContentsRestored: true };
    evidence.completedAt = new Date().toISOString(); await writeExclusive(join(output, "evidence.json"), sanitizeEvidence(evidence));
    console.log(JSON.stringify({ ok: true, output, evidence: join(output, "evidence.json") }, null, 2));
  } catch (error) {
    evidence.failure = boundedError(error);
    if (live && initialState && !evidence.cleanup) evidence.cleanup = await recover(live.client, initialState).catch((cleanupError) => ({ restoredEmptyDocument: false, reason: boundedError(cleanupError) }));
    await writeExclusive(join(output, "failure.json"), sanitizeEvidence(evidence)).catch(() => {}); throw error;
  } finally { await live?.client.close().catch(() => {}); }
}

function onlySection(state: any, name: string): any { const sections = (state.sectionAnalyses ?? []).filter((section: any) => section.name === name); requireCondition(sections.length === 1, `Expected one section named ${name}`); return sections[0]; }
function verifySection(section: any): void { requireCondition(section.visible === true, "Section is not visible"); requireCondition(section.registeredViewportCount > 0, "Section is not registered with any viewport clipping pass"); nearVector(section.originMm, [0, 0, 5], 1e-6, "section origin"); nearVector(section.normal, [0, 0, 1], 1e-9, "section normal"); }
function requireEmpty(state: any, label: string): void { requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0, `${label} is not empty`); requireCondition((state.groups ?? []).filter((group: { id: number }) => group.id !== 0).length === 0, `${label} contains non-root groups`); }
async function startMcp(storeRoot: string): Promise<LiveMcp> { const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" }, stderr: "pipe" }); const stderr: string[] = []; transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); }); const client = new Client({ name: "plasticity-native-section-analysis-live", version: "1.0.0" }); await client.connect(transport); return { client, stderr }; }
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> { const response = await client.callTool({ name, arguments: args }); const text = toolText(response); if ("isError" in response && response.isError) throw new Error(text); return JSON.parse(text); }
function toolText(response: unknown): string { if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content"); const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string"); if (!item) throw new Error("MCP tool returned no text content"); return item.text; }
async function recover(client: Client, initial: any): Promise<Record<string, unknown>> { for (let count = 0; count < 24; count += 1) { const status = await call(client, "plasticity_status", {}); if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" }; for (const section of status.sectionAnalyses ?? []) await call(client, "plasticity_delete_section_analysis", { id: section.id, intent: "Recover disposable native section analysis", revision: status.revision }); const current = await call(client, "plasticity_status", {}); if (current.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: current.bodies.length === 0 && current.regions.length === 0 && (current.sectionAnalyses ?? []).length === 0 }; await call(client, "plasticity_undo", { intent: "Recover disposable native section-analysis acceptance", revision: current.revision }); } return { restoredEmptyDocument: false, reason: "undo-limit" }; }
function summary(state: any): Record<string, any> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, regionCount: state.regions.length, sectionAnalysisCount: (state.sectionAnalyses ?? []).length }; }
function nearVector(actual: number[], expected: number[], tolerance: number, label: string): void { requireCondition(Array.isArray(actual) && actual.length === expected.length && actual.every((value, index) => Number.isFinite(value) && Math.abs(value - expected[index]!) <= tolerance), `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
async function captureScreenshot(client: Client, path: string): Promise<{ summary: Record<string, unknown>; png: Buffer }> {
  const result = await call(client, "plasticity_screenshot", { path });
  requireCondition(Number.isInteger(result.bytes) && result.bytes > 1000, "Plasticity screenshot is unexpectedly small");
  const png = await readFile(path);
  requireCondition(png.length === result.bytes, "Saved screenshot size differs from the MCP result");
  return { summary: { path, bytes: png.length }, png };
}
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
