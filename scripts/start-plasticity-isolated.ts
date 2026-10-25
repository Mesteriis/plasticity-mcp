import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";

import { ensurePlasticityCdp } from "../src/plasticity/launcher.ts";

async function freeLoopbackPort(excluded: ReadonlySet<number>): Promise<number> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const server = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Could not determine an ephemeral loopback port"));
          return;
        }
        resolve(address.port);
      });
    });
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (!excluded.has(port)) return port;
  }
  throw new Error("Could not allocate distinct loopback ports for isolated Plasticity");
}

export function parseIsolatedLaunchArgs(argv: string[]): { help: boolean; applicationPath?: string } {
  const options: { help: boolean; applicationPath?: string } = { help: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--help") options.help = true;
    else if (argv[index] === "--application") {
      const value = argv[++index];
      if (!value || !isAbsolute(value) || !value.endsWith(".app") || options.applicationPath) {
        throw new Error("--application requires one absolute .app bundle path");
      }
      options.applicationPath = value;
    } else throw new Error("Usage: npm run start:plasticity-isolated [-- --application /absolute/Plasticity.app]");
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseIsolatedLaunchArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Launch a separate Plasticity process with a fresh temporary user-data profile and loopback-only CDP. Use --application /absolute/Plasticity.app to select an already prepared experimental copy. The launcher only reads application security settings.");
    return;
  }
  const userDataDirectory = await mkdtemp(join(tmpdir(), "plasticity-mcp-isolated-profile-"));
  const rendererPort = await freeLoopbackPort(new Set());
  const inspectorPort = await freeLoopbackPort(new Set([rendererPort]));
  const targets = await ensurePlasticityCdp({ rendererPort, inspectorPort, userDataDirectory, ...(options.applicationPath ? { applicationPath: options.applicationPath } : {}) });
  console.log(JSON.stringify({
    status: "available",
    isolated: true,
    userDataDirectory,
    rendererEndpoint: `http://127.0.0.1:${rendererPort}`,
    inspectorEndpoint: `http://127.0.0.1:${inspectorPort}`,
    targets,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
