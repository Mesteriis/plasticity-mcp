import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./verify-reference-assets-live.ts", import.meta.url));

test("reference-asset acceptance exposes its bounded selected-page workflow", () => {
  const help = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--page-url HTTPS_URL --allow-domain DOMAIN/);

  const missingDomain = spawnSync(process.execPath, [
    script,
    "--page-url", "https://docs.example/product",
    "--output", "/tmp/plasticity-reference-assets-unused",
  ], { encoding: "utf8" });
  assert.equal(missingDomain.status, 1);
  assert.match(missingDomain.stderr, /At least one --allow-domain is required/);
});
