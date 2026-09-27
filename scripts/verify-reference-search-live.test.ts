import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./verify-reference-search-live.ts", import.meta.url));

test("reference-search acceptance accepts a bounded custom timeout", () => {
  const result = spawnSync(process.execPath, [
    script,
    "--query", "Example device",
    "--output", "/tmp/plasticity-reference-search-unused",
    "--search-timeout-ms", "170000",
    "--test-stop-after-parse",
  ], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown argument: --test-stop-after-parse/);
  assert.doesNotMatch(result.stderr, /Unknown argument: --search-timeout-ms/);
});
