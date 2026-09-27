import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const root = await realpath(resolve(import.meta.dirname, ".."));
const home = join(homedir(), ".plasticity-mcp");
const marketplace = "plasticity";
const pluginId = `plasticity-mcp@${marketplace}`;
const pluginRoot = join(root, "plugins", "plasticity-mcp");

if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Node.js 24 or newer is required");
await mkdir(home, { recursive: true, mode: 0o700 });
await chmod(home, 0o700);
await writePrivate("codex-repository", `${root}\n`);

const sources = codexJson<{ marketplaces: Array<{ name: string; root: string }> }>(["plugin", "marketplace", "list", "--json"]);
const existing = sources.marketplaces.find((entry) => entry.name === marketplace);
if (existing?.root === root) throw new Error(`Marketplace ${marketplace} uses a local path; remove it before installing from Git`);
if (!existing) codex(["plugin", "marketplace", "add", "Mesteriis/plasticity-mcp", "--ref", "main"]);

const manifest = JSON.parse(await readFile(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8")) as { version: string };
const plugins = codexJson<{ installed: Array<{ pluginId: string; version: string; installed: boolean }> }>(["plugin", "list", "--json"]);
const installed = plugins.installed.find((entry) => entry.pluginId === pluginId && entry.installed);
if (installed?.version !== manifest.version) codex(["plugin", "add", pluginId]);

process.stdout.write(`Plasticity MCP ${manifest.version} is ready in Codex. Open a new Codex chat to load its MCP tools.\n`);

async function writePrivate(name: string, value: string): Promise<void> {
  const destination = join(home, name);
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, value, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, destination);
}

function codex(args: string[]): string {
  return execFileSync("codex", args, { cwd: root, encoding: "utf8" });
}

function codexJson<T>(args: string[]): T {
  return JSON.parse(codex(args)) as T;
}
