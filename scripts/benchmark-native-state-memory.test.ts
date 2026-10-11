import assert from "node:assert/strict";
import { test } from "node:test";

import { footprintMetrics, parseMemoryBenchmarkArgs } from "./benchmark-native-state-memory.ts";

test("memory benchmark defaults to help and requires an explicit renderer, target and new output", () => {
  assert.equal(parseMemoryBenchmarkArgs([]).help, true);
  assert.throws(() => parseMemoryBenchmarkArgs(["--target", "window", "--output", "/tmp/output"]), /renderer-pid/);
  for (const reads of ["0", "31", "2.5", "NaN"]) {
    assert.throws(() => parseMemoryBenchmarkArgs(["--target", "window", "--output", "/tmp/output", "--renderer-pid", "42", "--verified-target-pid", "--reads", reads]), /--reads/);
  }
  assert.throws(() => parseMemoryBenchmarkArgs(["--output"]), /requires a value/);
  assert.throws(() => parseMemoryBenchmarkArgs(["--unknown"]), /Unknown/);
  assert.throws(() => parseMemoryBenchmarkArgs(["--target", "window", "--output", "/tmp/output", "--renderer-pid", "42"]), /association externally/);
  const options = parseMemoryBenchmarkArgs(["--target", "window", "--output", "/tmp/output", "--renderer-pid", "42", "--verified-target-pid", "--cold-cache"]);
  assert.equal(options.reads, 13);
  assert.equal(options.rendererPid, 42);
  assert.equal(options.verifiedTargetPid, true);
  assert.equal(options.coldCache, true);
});

test("footprint counters preserve compressed memory without counting it twice", () => {
  const report = { unit: "byte", errors: [], processes: [{ pid: 42, name: "Plasticity Helper (Renderer)", footprint: 1000, categories: { "Malloc Small": { dirty: 500, swapped: 300 } } }] };
  assert.deepEqual(footprintMetrics(report, 42), { footprintBytes: 1000, mallocSmallBytes: 500, mallocSmallSwappedBytes: 300 });
  assert.throws(() => footprintMetrics(report, 43), /PID/);
  assert.throws(() => footprintMetrics({ ...report, errors: ["permission denied"] }, 42), /reported errors/);
  assert.throws(() => footprintMetrics({ ...report, unit: "page" }, 42), /byte/);
  assert.throws(() => footprintMetrics({ ...report, processes: [{ ...report.processes[0], categories: {} }] }, 42), /unavailable/);
});
