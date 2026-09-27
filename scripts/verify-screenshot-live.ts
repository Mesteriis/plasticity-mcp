#!/usr/bin/env node
import { mkdir, open, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { call, startMcp } from "./verify-strength-live.ts";

export interface ScreenshotAcceptanceOptions {
  help: boolean;
  target?: string;
  output?: string;
  testSolid: boolean;
}

export function parseScreenshotAcceptanceArgs(argv: string[]): ScreenshotAcceptanceOptions {
  if (argv.length === 0) return { help: true, testSolid: false };
  const options: ScreenshotAcceptanceOptions = { help: false, testSolid: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--test-solid") options.testSolid = true;
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
  if (!options.target) throw new Error("Live screenshot acceptance requires --target with an explicit Plasticity window ID");
  if (!options.output) throw new Error("Live screenshot acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-screenshot-live.ts --help
  node scripts/verify-screenshot-live.ts --target ID --output NEW_DIRECTORY [--test-solid]

With no arguments or --help, this command performs no connection or UI action.
Live mode connects to the explicit Plasticity window, captures one PNG through
the production MCP screenshot tool, validates the PNG header and dimensions,
and writes bounded local evidence. By default document geometry is not changed.
With --test-solid, it requires an empty document, creates a temporary 20 x 10 x
5 mm Solid, captures it in an isometric fitted view, then undoes the creation
only if the document revision is unchanged. The Plasticity window must be
visible; hidden windows fail without saving a PNG.`;

async function main(): Promise<void> {
  const options = parseScreenshotAcceptanceArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const evidence: Record<string, unknown> = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    targetId: options.target!,
    documentMutated: false,
  };
  let live: Awaited<ReturnType<typeof startMcp>> | undefined;
  let initialState: any;
  let createdState: any;
  try {
    live = await startMcp(join(output, "strength-store"), output);
    const windows = await call(live.client, "plasticity_list_windows", {});
    if (!windows.some((window: { targetId: string }) => window.targetId === options.target)) {
      throw new Error("Explicit Plasticity target was not found");
    }
    initialState = await call(live.client, "plasticity_connect", { targetId: options.target });
    let state = initialState;
    if (options.testSolid) {
      if (state.bodies.length !== 0) throw new Error("--test-solid requires an empty Plasticity document");
      createdState = await call(live.client, "plasticity_create_box", {
        originMm: [0, 0, 0], sizeMm: [20, 10, 5], name: "Screenshot acceptance solid",
        intent: "Temporary live screenshot acceptance geometry", revision: state.revision,
      });
      const body = createdState.bodies.find((candidate: any) => candidate.name === "Screenshot acceptance solid");
      if (!body || !boundsMatch(body.boundsMm, [20, 10, 5])) throw new Error("Created Solid does not have the requested exact 20 x 10 x 5 mm bounds");
      state = createdState;
      evidence.documentMutated = true;
      evidence.testSolidBoundsMm = body.boundsMm;
      await call(live.client, "plasticity_set_view", { view: "isometric", fit: true });
    }
    const screenshotPath = join(output, "plasticity.png");
    const screenshot = await call(live.client, "plasticity_screenshot", { path: screenshotPath });
    const bytes = await readFile(screenshotPath);
    const dimensions = pngDimensions(bytes);
    if (screenshot.bytes !== bytes.length) throw new Error("Screenshot byte count did not match the written PNG");
    evidence.document = { token: state.documentToken, revision: state.revision, bodyCount: state.bodies.length };
    evidence.screenshot = { path: screenshotPath, bytes: bytes.length, width: dimensions.width, height: dimensions.height };
    if (createdState) {
      const current = await call(live.client, "plasticity_status", {});
      if (current.documentToken !== initialState.documentToken || current.revision !== createdState.revision) {
        throw new Error("Document changed during screenshot acceptance; refusing automatic Undo");
      }
      const restored = await call(live.client, "plasticity_undo", {
        intent: "Restore disposable screenshot acceptance document", revision: current.revision,
      });
      if (restored.documentToken !== initialState.documentToken || restored.bodies.length !== 0 || restored.undoDepth !== initialState.undoDepth) {
        throw new Error("Undo did not restore the original empty Plasticity document state");
      }
      evidence.cleanup = { restoredOriginalEmptyDocument: true, undoDepth: restored.undoDepth };
    }
    evidence.completedAt = new Date().toISOString();
    await writeExclusive(join(output, "evidence.json"), evidence);
    console.log(JSON.stringify(evidence, null, 2));
  } catch (error) {
    if (createdState && live) {
      try {
        const current = await call(live.client, "plasticity_status", {});
        if (current.documentToken === initialState.documentToken && current.revision === createdState.revision) {
          const restored = await call(live.client, "plasticity_undo", {
            intent: "Recover failed disposable screenshot acceptance", revision: current.revision,
          });
          evidence.cleanup = { restoredOriginalEmptyDocument: restored.documentToken === initialState.documentToken && restored.bodies.length === 0 && restored.undoDepth === initialState.undoDepth };
        } else evidence.cleanup = { restoredOriginalEmptyDocument: false, reason: "document-changed-during-acceptance; automatic Undo refused" };
      } catch { evidence.cleanup = { restoredOriginalEmptyDocument: false, reason: "cleanup failed; inspect Plasticity document before continuing" }; }
    }
    evidence.failure = boundedError(error);
    await writeExclusive(join(output, "failure.json"), evidence).catch(() => {});
    throw error;
  } finally {
    await live?.client.close().catch(() => {});
  }
}

export function boundsMatch(bounds: { min: number[]; max: number[] }, size: number[]): boolean {
  return bounds.min.length === 3 && bounds.max.length === 3 && size.every((dimension, index) =>
    Math.abs(bounds.min[index] ?? Infinity) <= 0.01 && Math.abs((bounds.max[index] ?? -Infinity) - dimension) <= 0.01);
}

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature) || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("Plasticity screenshot is not a valid PNG with an IHDR header");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width * height > 100_000_000) throw new Error("Screenshot dimensions are invalid or exceed the acceptance limit");
  return { width, height };
}

async function writeExclusive(path: string, value: unknown): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); } finally { await file.close(); }
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
