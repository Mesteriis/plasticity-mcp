import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { JsonRpcProcess } from "./json-rpc.ts";

const execFileAsync = promisify(execFile);

export const SUPPORTED_CODEX_VERSION = "codex-cli 0.153.4";
export const SUPPORTED_CODEX_PROTOCOL_HASH =
  "e5f798fd1343c539f01fedea0e8a84a43c080fcca4615c80eb04a5edab4f7d0a";

export interface AnalysisProfile {
  executableVersion: string;
  protocolHash: string;
  argv: string[];
  threadOverrides: Record<string, unknown>;
}

export interface ReferenceSearchProfile extends AnalysisProfile {
  allowedDomains: string[];
}

export type ProfileResult =
  | { available: true; profile: AnalysisProfile }
  | { available: false; reason: string };

export type ReferenceSearchProfileResult =
  | { available: true; profile: ReferenceSearchProfile }
  | { available: false; reason: string };

const DISABLED_FEATURES = [
  "apps",
  "browser_use",
  "computer_use",
  "current_time_reminder",
  "goals",
  "hooks",
  "image_generation",
  "in_app_browser",
  "memories",
  "multi_agent",
  "plugins",
  "remote_plugin",
  "shell_tool",
  "skill_mcp_dependency_install",
  "skill_search",
  "sleep_tool",
  "tool_suggest",
  "unified_exec",
  "view_image",
  "workspace_dependencies",
] as const;

// The isolated app-server profile must not inherit a desktop model that may be
// unavailable to this ChatGPT account's API route.
const CODEX_APP_SERVER_MODEL = "gpt-6-astra";

export function profileForInstalledProtocol(
  executableVersion: string,
  protocolHash: string,
  mcpServerNames: string[],
): ProfileResult {
  if (executableVersion !== SUPPORTED_CODEX_VERSION) {
    return { available: false, reason: `Unsupported Codex version: ${executableVersion}` };
  }
  if (protocolHash !== SUPPORTED_CODEX_PROTOCOL_HASH) {
    return { available: false, reason: `Unsupported Codex app-server protocol hash: ${protocolHash}` };
  }

  const mcpOverride: Record<string, { enabled: false }> = Object.fromEntries(
    [...new Set(mcpServerNames)].sort().map((name) => [name, { enabled: false as const }]),
  );
  const argv = baseArgv();
  argv.push("-c", `mcp_servers=${toTomlInlineTable(mcpOverride)}`);

  return {
    available: true,
    profile: {
      executableVersion,
      protocolHash,
      argv,
      threadOverrides: {
        model: CODEX_APP_SERVER_MODEL,
        ephemeral: true,
        environments: [],
        selectedCapabilityRoots: [],
        runtimeWorkspaceRoots: [],
        dynamicTools: [],
        sandbox: "read-only",
        approvalPolicy: "never",
        config: {
          agents: { enabled: false },
          apps: { _default: { enabled: false } },
          features: Object.fromEntries(DISABLED_FEATURES.map((feature) => [feature, false])),
          mcp_servers: mcpOverride,
          web_search: "disabled",
        },
      },
    },
  };
}

export function referenceSearchProfileForInstalledProtocol(
  executableVersion: string,
  protocolHash: string,
  mcpServerNames: string[],
  allowedDomains: string[] = [],
): ReferenceSearchProfileResult {
  const analysis = profileForInstalledProtocol(executableVersion, protocolHash, mcpServerNames);
  if (!analysis.available) return analysis;
  const normalizedDomains = normalizeAllowedDomains(allowedDomains);
  const argv = [...analysis.profile.argv];
  const webSearchOverride = argv.indexOf('web_search="disabled"');
  if (webSearchOverride < 0) {
    return { available: false, reason: "The verified Codex profile did not disable inherited web search" };
  }
  argv[webSearchOverride] = 'web_search="live"';
  return {
    available: true,
    profile: {
      ...analysis.profile,
      argv,
      allowedDomains: normalizedDomains,
      threadOverrides: {
        ...analysis.profile.threadOverrides,
        model: CODEX_APP_SERVER_MODEL,
        config: {
          ...(analysis.profile.threadOverrides.config as Record<string, unknown>),
          web_search: "live",
          tools: {
            web_search: {
              ...(normalizedDomains.length ? { allowed_domains: normalizedDomains } : {}),
              context_size: "medium",
            },
          },
        },
      },
    },
  };
}

export function referenceSearchProfileWithDomains(
  profile: ReferenceSearchProfile,
  allowedDomains: string[],
): ReferenceSearchProfile {
  const normalizedDomains = normalizeAllowedDomains(allowedDomains);
  const config = profile.threadOverrides.config as Record<string, unknown>;
  return {
    ...profile,
    allowedDomains: normalizedDomains,
    threadOverrides: {
      ...profile.threadOverrides,
      config: {
        ...config,
        tools: {
          web_search: {
            ...(normalizedDomains.length ? { allowed_domains: normalizedDomains } : {}),
            context_size: "medium",
          },
        },
      },
    },
  };
}

export async function resolveAnalysisProfile(executable: string): Promise<ProfileResult> {
  const inspected = await inspectInstalledProtocol(executable);
  if (!inspected.available) return inspected;
  return profileForInstalledProtocol(inspected.executableVersion, inspected.protocolHash, inspected.mcpServerNames);
}

export async function resolveReferenceSearchProfile(executable: string): Promise<ReferenceSearchProfileResult> {
  const inspected = await inspectInstalledProtocol(executable);
  if (!inspected.available) return inspected;
  return referenceSearchProfileForInstalledProtocol(
    inspected.executableVersion,
    inspected.protocolHash,
    inspected.mcpServerNames,
  );
}

async function inspectInstalledProtocol(
  executable: string,
): Promise<{ available: true; executableVersion: string; protocolHash: string; mcpServerNames: string[] } | { available: false; reason: string }> {
  try {
    const { stdout: versionOutput } = await execFileAsync(executable, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    const executableVersion = versionOutput.trim();
    if (executableVersion !== SUPPORTED_CODEX_VERSION) {
      return { available: false, reason: `Unsupported Codex version: ${executableVersion}` };
    }

    const schemaDirectory = await mkdtemp(join(tmpdir(), "plasticity-strength-protocol-"));
    let protocolHash: string;
    try {
      await execFileAsync(
        executable,
        ["app-server", "generate-json-schema", "--experimental", "--out", schemaDirectory],
        { encoding: "utf8", timeout: 15_000 },
      );
      const protocol = await readFile(
        join(schemaDirectory, "codex_app_server_protocol.v2.schemas.json"),
      );
      protocolHash = createHash("sha256").update(protocol).digest("hex");
    } finally {
      await rm(schemaDirectory, { recursive: true, force: true });
    }

    const mcpServerNames = await inspectConfiguredMcpServers(executable);
    return { available: true, executableVersion, protocolHash, mcpServerNames };
  } catch (error) {
    return {
      available: false,
      reason: `Unable to inspect Codex executable: ${asError(error).message}`,
    };
  }
}

export function mcpNamesFromConfigRead(value: unknown): string[] {
  if (!isRecord(value)) throw new Error("config/read returned an unexpected result");
  const config = isRecord(value.config) ? value.config : value;
  const mcpServers = config.mcp_servers;
  if (mcpServers === undefined || mcpServers === null) return [];
  if (!isRecord(mcpServers)) throw new Error("config/read returned an invalid MCP server table");
  return Object.keys(mcpServers).sort();
}

async function inspectConfiguredMcpServers(executable: string): Promise<string[]> {
  const rpc = new JsonRpcProcess({
    executable,
    args: [...baseArgv(), "-c", "mcp_servers={}"],
    env: allowedEnvironment(process.env),
  });
  try {
    await rpc.request("initialize", {
      clientInfo: { name: "plasticity-strength-profile", title: "Plasticity Strength Profile", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    rpc.notify("initialized", {});
    return mcpNamesFromConfigRead(await rpc.request("config/read", { includeLayers: false }));
  } finally {
    await rpc.close();
  }
}

function baseArgv(): string[] {
  const argv = ["app-server", "--stdio", "--strict-config"];
  for (const feature of DISABLED_FEATURES) argv.push("-c", `features.${feature}=false`);
  argv.push("-c", 'web_search="disabled"');
  argv.push("-c", "agents.enabled=false");
  argv.push("-c", "apps._default.enabled=false");
  return argv;
}

function normalizeAllowedDomains(domains: string[]): string[] {
  const normalized = new Set<string>();
  for (const entry of domains) {
    const domain = entry.trim().toLowerCase().replace(/\.$/, "");
    if (!domain || domain.length > 253 || domain.includes(":") || domain.includes("/") || domain.includes("@")) {
      throw new Error(`Invalid web-search domain: ${entry}`);
    }
    const labels = domain.split(".");
    if (labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
      throw new Error(`Invalid web-search domain: ${entry}`);
    }
    normalized.add(domain);
  }
  if (normalized.size > 20) throw new Error("At most 20 allowed web-search domains are supported");
  return [...normalized].sort();
}

function toTomlInlineTable(value: Record<string, { enabled: false }>): string {
  return `{${Object.entries(value)
    .map(([name]) => `${JSON.stringify(name)}={enabled=false}`)
    .join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function allowedEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ["HOME", "CODEX_HOME", "PATH", "SHELL", "TMPDIR", "USER", "LOGNAME", "LANG", "LC_ALL", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "SSL_CERT_FILE"]) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}
