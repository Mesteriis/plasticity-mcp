#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { call, stageImage, startMcp, type LiveMcp } from "./verify-strength-live.ts";

interface Options {
  help: boolean;
  liveCodex: boolean;
  output?: string;
  images: string[];
}

const HELP = `Usage:
  node scripts/verify-design-reference-multiview-live.ts --help
  node scripts/verify-design-reference-multiview-live.ts --live-codex --output NEW_DIRECTORY --image /absolute/photo.jpg [--image ...]

Requires 1–4 absolute PNG/JPEG/HEIC/HEIF paths and a new output directory. This check
uses stdio MCP and the isolated Codex API only; it does not connect to or edit CAD.`;

function parseArgs(argv: string[]): Options {
  const options: Options = { help: argv.length === 0, liveCodex: false, images: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--live-codex") options.liveCodex = true;
    else if (argument === "--output") {
      const value = argv[++index];
      if (!value) throw new Error("--output requires a new directory path");
      options.output = value;
    } else if (argument === "--image") {
      const value = argv[++index];
      if (!value || !value.startsWith("/")) throw new Error("--image requires an absolute PNG, JPEG, HEIC, or HEIF path");
      options.images.push(value);
    } else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (options.help) return options;
  if (!options.liveCodex) throw new Error("Live acceptance requires --live-codex");
  if (!options.output) throw new Error("Live acceptance requires --output with a new directory");
  if (options.images.length < 1 || options.images.length > 4) throw new Error("Live image acceptance requires 1–4 --image paths");
  return options;
}

async function writeExclusive(path: string, value: unknown): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); } finally { await handle.close(); }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const evidence: Record<string, unknown> = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    workbenchUsed: false,
    cadConnected: false,
    inputViews: [],
    result: null,
  };
  let live: LiveMcp | undefined;
  try {
    const staged = [];
    for (const [index, path] of options.images.entries()) {
      staged.push(await stageImage(path, output, `view-${index + 1}`));
    }
    const stagedViews = await Promise.all(staged.map(async ({ path, format, byteSize }, index) => ({
      index: index + 1,
      name: basename(path),
      format,
      byteSize,
      sha256: createHash("sha256").update(await readFile(path)).digest("hex"),
    })));
    assert.equal(new Set(stagedViews.map(({ sha256 }) => sha256)).size, stagedViews.length, "Live multi-view acceptance requires distinct image inputs");
    evidence.inputViews = stagedViews;
    live = await startMcp(join(output, "strength-store"), output);
    const methods = await call(live.client, "plasticity_strength_methods", {});
    assert.equal(methods.analysis?.available, true, `Codex analysis unavailable: ${String(methods.analysis?.reason ?? "unknown")}`);

    const requestId = `multiview-${Date.now()}`;
    const result = await call(live.client, "plasticity_analyze_design_reference", {
      requestId,
      prompt: "Inspect the supplied views as references for one technical part. Separate visible evidence from inference, do not infer millimeters from appearance, and return at most one next decision-relevant question package. Do not create CAD or print.",
      imagePaths: staged.map(({ path }) => path),
      evidence: [],
      answers: [],
    }, 180_000);
    if (result.state !== "completed") {
      const errorCode = typeof result.errorCode === "string" ? result.errorCode.slice(0, 128) : undefined;
      const diagnostics = typeof result.failureDiagnostics === "object" && result.failureDiagnostics !== null
        ? {
          ...(typeof result.failureDiagnostics.category === "string" ? { category: result.failureDiagnostics.category.slice(0, 64) } : {}),
          ...(Number.isInteger(result.failureDiagnostics.httpStatusCode) ? { httpStatusCode: result.failureDiagnostics.httpStatusCode } : {}),
          ...(typeof result.failureDiagnostics.message === "string" ? { message: result.failureDiagnostics.message.slice(0, 240) } : {}),
        }
        : undefined;
      evidence.result = {
        requestId,
        state: result.state,
        ...(errorCode ? { errorCode } : {}),
        ...(diagnostics === undefined || Object.keys(diagnostics).length === 0 ? {} : { failureDiagnostics: diagnostics }),
      };
      throw new Error(`Design-reference image analysis ended as ${result.state}${errorCode ? ` (${errorCode})` : ""}`);
    }
    assert.ok(result.result.designInterpretation, "Multiview analysis must return a structured interpretation");
    assert.ok(["unscaled", "unknown"].includes(result.result.designInterpretation.scaleStatus), "Uncalibrated views must remain unscaled");
    assert.ok(result.result.questions.length <= 1, "A turn may return at most one question package");
    assert.ok(result.result.observations.every((item: { sourceImageIndices?: number[] }) => Array.isArray(item.sourceImageIndices) && item.sourceImageIndices.length > 0), "Every image-derived observation must cite one or more supplied views");
    assert.ok(result.result.observations.every((item: { sourceImageIndices: number[] }) => item.sourceImageIndices.every((index) => Number.isInteger(index) && index >= 1 && index <= staged.length)), "View references must use valid 1-based indexes for this request");
    const citedViewIndices = [...new Set<number>(result.result.observations.flatMap((item: { sourceImageIndices: number[] }) => item.sourceImageIndices))].sort((a, b) => a - b);
    assert.deepEqual(citedViewIndices, staged.map((_, index) => index + 1), "Every distinct input view must be cited by at least one observation");
    assert.ok(result.result.observations.every((item: { unit?: string }) => !["mm", "mm2", "mm4"].includes(item.unit ?? "")), "Uncalibrated images must not produce millimeter measurements");
    evidence.result = {
      requestId,
      state: result.state,
      scaleStatus: result.result.designInterpretation.scaleStatus,
      observationCount: result.result.observations.length,
      attributedObservationCount: result.result.observations.filter((item: { sourceImageIndices?: number[] }) => (item.sourceImageIndices?.length ?? 0) > 0).length,
      viewCitationCoverage: staged.map((_, index) => ({
        index: index + 1,
        observationIds: result.result.observations.filter((item: { sourceImageIndices: number[] }) => item.sourceImageIndices.includes(index + 1)).map((item: { id: string }) => item.id),
      })),
      questionCount: result.result.questions.length,
      measuredMillimeterObservationCount: 0,
    };
    evidence.completedAt = new Date().toISOString();
    await writeExclusive(join(output, "evidence.json"), evidence);
    console.log(JSON.stringify(evidence, null, 2));
  } catch (error) {
    evidence.failedAt = new Date().toISOString();
    evidence.failure = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
    await writeExclusive(join(output, "failure.json"), evidence).catch(() => {});
    throw error;
  } finally {
    await live?.client.close().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ status: "failed", error: message })}\n`);
    process.exitCode = 1;
  });
}

export { parseArgs as parseMultiviewAcceptanceArgs };
