import assert from "node:assert/strict";
import test from "node:test";

import {
  profileForInstalledProtocol,
  referenceSearchProfileForInstalledProtocol,
  resolveAnalysisProfile,
  mcpNamesFromConfigRead,
  SUPPORTED_CODEX_PROTOCOL_HASH,
  SUPPORTED_CODEX_VERSION,
} from "./analysis-profile.ts";

test("missing Codex executable produces an unavailable capability", async () => {
  const result = await resolveAnalysisProfile("/nonexistent/plasticity-codex");
  assert.equal(result.available, false);
  if (!result.available) assert.match(result.reason, /executable|start/i);
});

test("MCP blocking uses the post-plugin configuration instead of plugin inventory", () => {
  assert.deepEqual(
    mcpNamesFromConfigRead({
      config: {
        mcp_servers: {
          plasticity: { enabled: true, command: "npm" },
          already_off: { enabled: false, command: "off" },
        },
      },
    }),
    ["already_off", "plasticity"],
  );
});

test("the supported protocol creates an action-free analysis profile", () => {
  const result = profileForInstalledProtocol(
    SUPPORTED_CODEX_VERSION,
    SUPPORTED_CODEX_PROTOCOL_HASH,
    ["plasticity", "serena"],
  );
  assert.equal(result.available, true);
  if (!result.available) return;
  assert.equal(result.profile.threadOverrides.model, "gpt-6-astra");
  assert.deepEqual(result.profile.threadOverrides.environments, []);
  assert.deepEqual(result.profile.threadOverrides.dynamicTools, []);
  assert.equal(result.profile.threadOverrides.sandbox, "read-only");
  assert.equal(result.profile.threadOverrides.approvalPolicy, "never");
  assert.ok(result.profile.argv.includes("features.shell_tool=false"));
  assert.ok(result.profile.argv.some((value) => value.includes('"plasticity"={enabled=false}')));
});

test("reference search gets live web search without inheriting CAD, shell, MCP, or workspace access", () => {
  const result = referenceSearchProfileForInstalledProtocol(
    SUPPORTED_CODEX_VERSION,
    SUPPORTED_CODEX_PROTOCOL_HASH,
    ["plasticity"],
    ["cad.example", "cad.example", "vendor.test"],
  );
  assert.equal(result.available, true);
  if (!result.available) return;
  const profile = result.profile;
  assert.equal(profile.threadOverrides.model, "gpt-6-astra");
  assert.equal(profile.threadOverrides.sandbox, "read-only");
  assert.deepEqual(profile.threadOverrides.environments, []);
  assert.deepEqual(profile.threadOverrides.dynamicTools, []);
  assert.ok(profile.argv.includes('web_search="live"'));
  assert.ok(profile.argv.includes("features.shell_tool=false"));
  assert.ok(profile.argv.some((value) => value.includes('"plasticity"={enabled=false}')));
  const config = profile.threadOverrides.config as Record<string, unknown>;
  assert.equal(config.web_search, "live");
  assert.deepEqual((config.tools as { web_search: { allowed_domains: string[] } }).web_search.allowed_domains, ["cad.example", "vendor.test"]);
});

test("reference-search domains reject URL syntax and oversized lists", () => {
  assert.throws(() => referenceSearchProfileForInstalledProtocol(
    SUPPORTED_CODEX_VERSION,
    SUPPORTED_CODEX_PROTOCOL_HASH,
    [],
    ["https://example.com"],
  ), /Invalid web-search domain/);
  assert.throws(() => referenceSearchProfileForInstalledProtocol(
    SUPPORTED_CODEX_VERSION,
    SUPPORTED_CODEX_PROTOCOL_HASH,
    [],
    Array.from({ length: 21 }, (_, index) => `domain${index}.test`),
  ), /At most 20/);
});

test("an unverified protocol is unavailable instead of inheriting tools", () => {
  const result = profileForInstalledProtocol(SUPPORTED_CODEX_VERSION, "different", []);
  assert.deepEqual(result, {
    available: false,
    reason: "Unsupported Codex app-server protocol hash: different",
  });
});
