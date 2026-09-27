import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir, networkInterfaces } from "node:os";
import { resolve } from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { isPrivateIpv4, resolveWorkbenchConfig } from "../src/server/config.ts";
import { WorkbenchApiClient } from "../src/server/mcp/client.ts";
import { createWorkbenchMcpServer } from "../src/server/mcp/server.ts";
import { readOwnerToken } from "../src/server/owner-auth.ts";

const configuredOrigin = process.env.WORKBENCH_ORIGIN;
let ownedWorkbench: ChildProcess | undefined;
let origin = configuredOrigin ? new URL(configuredOrigin).origin : await discoverOrigin();
if (!origin) {
  const repositoryRoot = resolve(import.meta.dirname, "../..");
  const indexPath = resolve(repositoryRoot, "workbench/dist/index.html");
  if (!await exists(indexPath)) await run("npm", ["--workspace", "workbench", "run", "build"], repositoryRoot);
  ownedWorkbench = spawn(process.execPath, [resolve(repositoryRoot, "workbench/src/server/main.ts"), "--lan"], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "ignore",
  });
  origin = await waitForOrigin(ownedWorkbench, 10_000);
}
if (!origin) throw new Error("Workbench HTTP service is unavailable");
const config = resolveWorkbenchConfig({ env: process.env, args: [], cwd: resolve(import.meta.dirname, "../.."), home: homedir() });
const ownerToken = await readOwnerToken(config.projectsRoot);
const server = createWorkbenchMcpServer(new WorkbenchApiClient(origin, ownerToken));
await server.connect(new StdioServerTransport());

const stop = () => ownedWorkbench?.kill("SIGTERM");
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
process.once("exit", stop);

async function discoverOrigin(): Promise<string | undefined> {
  const port = Number(process.env.WORKBENCH_PORT ?? "4317");
  const hosts = ["127.0.0.1", ...Object.values(networkInterfaces())
    .flatMap((addresses) => addresses ?? [])
    .filter((address) => address.family === "IPv4" && !address.internal && isPrivateIpv4(address.address))
    .map((address) => address.address)];
  for (const host of [...new Set(hosts)]) {
    const candidate = `http://${host}:${port}`;
    try {
      const response = await fetch(`${candidate}/api/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return candidate;
    } catch { /* continue to the next local interface */ }
  }
  return undefined;
}

async function waitForOrigin(child: ChildProcess, timeoutMs: number): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  let spawnError: Error | undefined;
  const onError = (error: Error) => { spawnError = error; };
  child.once("error", onError);
  try {
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`Workbench HTTP service exited with code ${child.exitCode}`);
      const found = await discoverOrigin();
      if (found) return found;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  } finally {
    child.off("error", onError);
  }
  child.kill("SIGTERM");
  throw new Error("Timed out while starting the Workbench HTTP service");
}

async function run(command: string, args: string[], cwd: string): Promise<void> {
  const child = spawn(command, args, { cwd, env: process.env, stdio: "ignore" });
  const code = await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode) => resolveExit(exitCode ?? 1));
  });
  if (code !== 0) throw new Error(`${command} exited with code ${code}`);
}

async function exists(path: string): Promise<boolean> {
  return await access(path).then(() => true, () => false);
}
