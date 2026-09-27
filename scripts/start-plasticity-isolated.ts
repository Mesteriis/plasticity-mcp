import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function main(): Promise<void> {
  if (process.argv.slice(2).some((argument) => argument !== "--help")) {
    throw new Error("Usage: npm run start:plasticity-isolated [-- --help]");
  }
  if (process.argv.includes("--help")) {
    console.log("Launch a separate Plasticity process with a fresh temporary user-data profile and loopback-only CDP.");
    return;
  }
  const userDataDirectory = await mkdtemp(join(tmpdir(), "plasticity-mcp-isolated-profile-"));
  const rendererPort = await freeLoopbackPort(new Set());
  const inspectorPort = await freeLoopbackPort(new Set([rendererPort]));
  const targets = await ensurePlasticityCdp({ rendererPort, inspectorPort, userDataDirectory });
  console.log(JSON.stringify({
    status: "available",
    isolated: true,
    userDataDirectory,
    rendererEndpoint: `http://127.0.0.1:${rendererPort}`,
    inspectorEndpoint: `http://127.0.0.1:${inspectorPort}`,
    targets,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
