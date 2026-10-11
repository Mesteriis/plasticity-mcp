#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { discoverPlasticityTargets } from "../src/cdp/discovery.ts";
import { acquireWindowOwnership } from "../src/plasticity/ownership.ts";
import { PlasticityRuntime, type RuntimeState } from "../src/plasticity/runtime.ts";

const execFileAsync = promisify(execFile);
const GiB = 1024 ** 3;

interface Options { help: boolean; target?: string; rendererPid?: number; output?: string; reads: number; label: string; coldCache: boolean; verifiedTargetPid: boolean }
export function parseMemoryBenchmarkArgs(argv: string[]): Options {
  const options: Options = { help: argv.length === 0, reads: 13, label: "current", coldCache: false, verifiedTargetPid: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === "--help") { options.help = true; continue; }
    if (flag === "--cold-cache") { options.coldCache = true; continue; }
    if (flag === "--verified-target-pid") { options.verifiedTargetPid = true; continue; }
    assert.ok(["--target", "--renderer-pid", "--output", "--reads", "--label"].includes(flag), `Unknown argument: ${flag}`);
    const value = argv[++index];
    assert.ok(value && !value.startsWith("--"), `${flag} requires a value`);
    if (flag === "--target") options.target = value;
    if (flag === "--output") options.output = value;
    if (flag === "--label") options.label = value;
    if (flag === "--renderer-pid") options.rendererPid = Number(value);
    if (flag === "--reads") options.reads = Number(value);
  }
  if (options.help) return options;
  assert.ok(options.target && options.output, "--target and --output are required");
  assert.ok(Number.isSafeInteger(options.rendererPid) && options.rendererPid! > 0, "--renderer-pid must identify this window's renderer process");
  assert.ok(options.verifiedTargetPid, "Verify the target-to-renderer PID association externally, then pass --verified-target-pid; a renderer process name alone is insufficient");
  assert.ok(Number.isSafeInteger(options.reads) && options.reads >= 2 && options.reads <= 30, "--reads must be an integer from 2 to 30");
  assert.match(options.label, /^[a-zA-Z0-9_-]{1,40}$/);
  return options;
}

export function footprintMetrics(raw: unknown, pid: number) {
  const report = raw as { unit?: string; errors?: unknown[]; processes?: Array<{ pid: number; name: string; footprint: number; categories?: Record<string, { dirty?: number; swapped?: number }> }> };
  assert.equal(report.unit, "byte", "footprint must report byte units");
  assert.ok(Array.isArray(report.errors) && report.errors.length === 0, "footprint reported errors");
  const process = report.processes?.find((item) => item.pid === pid);
  assert.ok(process && /Plasticity.*Renderer/.test(process.name), "PID is not a Plasticity renderer");
  const small = process.categories?.["Malloc Small"];
  assert.ok(small && Number.isFinite(small.dirty) && Number.isFinite(small.swapped), "Malloc Small counters are unavailable");
  assert.ok(Number.isFinite(process.footprint) && process.footprint > 0, "Invalid renderer footprint");
  // footprint's dirty count already includes its parenthesized swapped part.
  // Do not add swapped again: doing so double-counts compressed memory.
  return { footprintBytes: process.footprint, mallocSmallBytes: small.dirty!, mallocSmallSwappedBytes: small.swapped! };
}

async function main(): Promise<void> {
  const options = parseMemoryBenchmarkArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/benchmark-native-state-memory.ts --target ID --renderer-pid PID --verified-target-pid --output NEW_DIRECTORY [--reads 13] [--label current] [--cold-cache]\nRead-only macOS benchmark. First load a disposable fixture; externally verify its target-to-renderer PID association via BrowserWindow.webContents.getOSProcessId() and explicitly attest with --verified-target-pid. This script cannot infer that association. Each sample forces renderer GC and records footprint (including compressed memory), Malloc Small, JS heap and getState time. --cold-cache discards only the MCP topology cache before the first sample. Stops before another read at 6 GiB footprint.");
    return;
  }
  assert.equal(process.platform, "darwin", "This benchmark requires macOS footprint");
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const endpoint = process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223";
  const target = (await discoverPlasticityTargets(endpoint)).find((item) => item.id === options.target);
  assert.ok(target, "Explicit target was not found");
  const ownership = await acquireWindowOwnership(target.id, undefined, endpoint);
  let runtime: PlasticityRuntime | undefined;
  const samples: Array<Record<string, number>> = [];
  const report: Record<string, unknown> = {
    schemaVersion: 1, label: options.label, requestedReads: options.reads,
    runtimeSourceSha256: createHash("sha256").update(await readFile(new URL("../src/plasticity/runtime.ts", import.meta.url))).digest("hex"),
    gcBeforeEveryFootprintSample: true, coldCacheAtStart: options.coldCache, startedAt: new Date().toISOString(), samples,
    targetPidAssociation: "externally-verified-by-operator",
  };
  const persist = async () => writeFile(join(output, "summary.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  try {
    runtime = await PlasticityRuntime.connect(target);
    if (options.coldCache) await runtime.read("function () { delete globalThis[Symbol.for('plasticity-mcp.body-topology')]; }");
    const sample = async (read: number, readMs: number) => {
      await runtime!.cdp("HeapProfiler.collectGarbage");
      const heap = await runtime!.cdp("Runtime.getHeapUsage") as { usedSize: number };
      const rawPath = join(output, `footprint-${read}.json`);
      await execFileAsync("/usr/bin/footprint", ["-p", String(options.rendererPid), "-f", "bytes", "-j", rawPath], { timeout: 30_000 });
      const metrics = footprintMetrics(JSON.parse(await readFile(rawPath, "utf8")), options.rendererPid!);
      const row = { read, readMs, jsHeapUsedBytes: heap.usedSize, ...metrics };
      samples.push(row);
      await persist();
      console.log(JSON.stringify(row));
      assert.ok(metrics.footprintBytes < 6 * GiB, "Footprint safety limit reached; no further state reads will run");
    };
    await sample(0, 0);
    let expectedHash: string | undefined;
    for (let read = 1; read <= options.reads; read += 1) {
      const start = performance.now();
      const state: RuntimeState = await runtime.getState();
      const readMs = performance.now() - start;
      const hash: string = createHash("sha256").update(JSON.stringify(state)).digest("hex");
      if (expectedHash) assert.equal(hash, expectedHash, "Document state changed during benchmark");
      else {
        expectedHash = hash;
        report.topology = {
          bodies: state.bodies.length,
          faces: state.bodies.reduce((sum, body) => sum + body.faces.length, 0),
          edges: state.bodies.reduce((sum, body) => sum + body.edges.length, 0),
          vertices: state.bodies.reduce((sum, body) => sum + (body.vertices?.length ?? 0), 0),
        };
        report.stateSha256 = hash;
      }
      await sample(read, readMs);
    }
    report.completed = true;
    report.completedAt = new Date().toISOString();
    await persist();
  } catch (error) {
    report.completed = false;
    report.failure = String(error).slice(0, 2000);
    await persist().catch(() => {});
    throw error;
  } finally {
    runtime?.close();
    await ownership.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
