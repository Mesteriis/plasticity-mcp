#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface CompactObservationAcceptanceOptions {
  help: boolean;
  target?: string;
  output?: string;
}

interface LiveMcp {
  client: Client;
  stderr: string[];
}

export function parseCompactObservationAcceptanceArgs(argv: string[]): CompactObservationAcceptanceOptions {
  if (argv.length === 0) return { help: true };
  const options: CompactObservationAcceptanceOptions = { help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--target") {
      const value = argv[++index];
      if (!value) throw new Error("--target requires an explicit Plasticity window ID");
      options.target = value;
    } else if (argument === "--output") {
      const value = argv[++index];
      if (!value) throw new Error("--output requires a new directory path");
      options.output = value;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Compact-observation acceptance requires --target with an explicit window ID");
  if (!options.output) throw new Error("Compact-observation acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-compact-observation-live.ts --help
  node scripts/verify-compact-observation-live.ts --target ID --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection or mutation.
Live mode uses the production stdio MCP server and an explicitly selected
Plasticity window. It only reads document state, exercises compact pagination,
captures an in-memory snapshot and reads the unchanged diff/journal. It refuses
to overwrite an existing evidence directory and does not alter the CAD scene.`;

async function main(): Promise<void> {
  const options = parseCompactObservationAcceptanceArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const evidence: Record<string, unknown> = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    explicitlySelectedTarget: true,
    documentMutated: false,
  };
  let live: LiveMcp | undefined;
  try {
    live = await startMcp(output);
    const windows = await call(live.client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");

    const connected = await call(live.client, "plasticity_connect", { targetId: options.target });
    requireCondition(connected.bodyPagination?.offset === 0 && connected.bodyPagination?.limit === 50, "Connect did not return the first compact body-summary page");
    requireCondition(connected.bodies.every((body: Record<string, unknown>) => !("faces" in body) && !("edges" in body) && !("vertices" in body)), "Connect response included detailed B-Rep topology");
    const status = await call(live.client, "plasticity_status", {});
    requireSameDocumentRevision(connected, status);
    requireCondition(status.bodyPagination.total === connected.bodyPagination.total, "Status body count differs from connect summary");
    requireCondition(JSON.stringify(bodySummaries(status.bodies)) === JSON.stringify(bodySummaries(connected.bodies)), "Status and connect body summaries differ");

    const detailsFirstPage = await call(live.client, "plasticity_list_bodies", { bodyOffset: 0, bodyLimit: 1 });
    requireSameDocumentRevision(connected, detailsFirstPage);
    requireCondition(detailsFirstPage.bodyPagination.total === connected.bodyPagination.total, "Detailed body count differs from compact scene summary");
    requireCondition(detailsFirstPage.bodies.length === Math.min(1, detailsFirstPage.bodyPagination.total), "Detailed first page has an unexpected body count");
    let detailedPageCount = 1;
    if (detailsFirstPage.bodyPagination.nextOffset !== null) {
      const detailsSecondPage = await call(live.client, "plasticity_list_bodies", {
        bodyOffset: detailsFirstPage.bodyPagination.nextOffset,
        bodyLimit: 1,
        expectedRevision: connected.revision,
      });
      requireSameDocumentRevision(connected, detailsSecondPage);
      const ids = new Set<number>(detailsFirstPage.bodies.map((body: { id: number }) => body.id));
      requireCondition(detailsSecondPage.bodies.every((body: { id: number }) => !ids.has(body.id)), "Detailed body pages repeated an ID");
      detailedPageCount += 1;
    }

    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "compact-observation-live-read-only" });
    requireSameDocumentRevision(connected, snapshot);
    requireCondition(!("bodies" in snapshot) && !("state" in snapshot), "Snapshot response included a full scene state");
    const changes = await call(live.client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireSameDocumentRevision(connected, changes.current);
    requireCondition(changes.diff.sceneChanged === false && changes.bodyPagination.total === 0, "Read-only observation changed the captured scene");
    requireCondition(!("bodies" in changes.current), "Change response included a full current scene state");
    requireCondition(changes.diff.added.every((body: Record<string, unknown>) => !("faces" in body)), "Change response included full B-Rep faces");

    const journal = await call(live.client, "plasticity_construction_journal", { limit: 20 });
    requireCondition(journal.journalPagination.total === 0, "Read-only acceptance unexpectedly journaled a mutation");
    const finalStatus = await call(live.client, "plasticity_status", {});
    requireSameDocumentRevision(connected, finalStatus);
    requireCondition(JSON.stringify(bodySummaries(finalStatus.bodies)) === JSON.stringify(bodySummaries(status.bodies)), "Document body summaries changed during read-only acceptance");

    evidence.document = { bodyCount: status.bodyPagination.total, revisionUnchanged: true, documentUnchanged: true };
    evidence.responses = {
      connectBytes: byteCount(connected),
      statusBytes: byteCount(status),
      detailedBodyPageCount: detailedPageCount,
      firstDetailedPageBodies: detailsFirstPage.bodies.length,
      snapshotBytes: byteCount(snapshot),
      snapshotContainsBRep: false,
      unchangedDiffBytes: byteCount(changes),
      unchangedDiffBodyChanges: changes.bodyPagination.total,
      journalBytes: byteCount(journal),
      journalEntries: journal.journalPagination.total,
    };
    evidence.completedAt = new Date().toISOString();
    await writeExclusive(join(output, "evidence.json"), sanitizeEvidence(evidence));
    console.log(JSON.stringify({ ok: true, output, evidence: join(output, "evidence.json"), documentMutated: false }, null, 2));
  } catch (error) {
    evidence.failure = boundedError(error);
    await writeExclusive(join(output, "failure.json"), sanitizeEvidence(evidence)).catch(() => {});
    throw error;
  } finally {
    await live?.client.close().catch(() => {});
  }
}

async function startMcp(output: string): Promise<LiveMcp> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(projectRoot, "scripts", "run-server.ts")],
    cwd: projectRoot,
    env: {
      ...selectedEnvironment(process.env),
      PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223",
      PLASTICITY_STRENGTH_ROOT: join(output, "strength"),
      PLASTICITY_CONSTRUCTION_HISTORY_ROOT: join(output, "history"),
      PLASTICITY_REFERENCE_ROOT: join(output, "references"),
      PLASTICITY_REFERENCE_ARTIFACT_ROOT: join(output, "artifacts"),
    },
    stderr: "pipe",
  });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk) => {
    stderr.push(String(chunk).slice(-4096));
    while (stderr.join("").length > 16384) stderr.shift();
  });
  const client = new Client({ name: "plasticity-compact-observation-live", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await client.callTool({ name, arguments: args });
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

function bodySummaries(bodies: any[]): unknown[] {
  return bodies.map(({ id, versionId, type, name, boundsMm, faceCount, edgeCount, vertexCount }) => ({
    id, versionId, type, name, boundsMm, faceCount, edgeCount, vertexCount,
  }));
}

function requireSameDocumentRevision(expected: any, actual: any): void {
  requireCondition(actual.documentToken === expected.documentToken, "Read-only observation changed or switched documents");
  requireCondition(actual.revision === expected.revision, "Read-only observation changed the Plasticity revision");
}

function byteCount(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : []));
}
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4_000); }
async function writeExclusive(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
}
