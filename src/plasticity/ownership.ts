import { createHash } from "node:crypto";
import { mkdir, open, readFile, stat, unlink, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface WindowOwnership {
  release(): Promise<void>;
}

export async function acquireWindowOwnership(
  targetId: string,
  directory = process.env.PLASTICITY_MCP_STATE_DIR ?? join(homedir(), ".plasticity-mcp", "ownership"),
  endpoint = process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223",
): Promise<WindowOwnership> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const cdp = new URL(endpoint);
  const host = ["localhost", "[::1]"].includes(cdp.hostname) ? "127.0.0.1" : cdp.hostname;
  const key = createHash("sha256").update(JSON.stringify([cdp.protocol, host, cdp.port, targetId])).digest("hex").slice(0, 24);
  const path = join(directory, `window-${key}.lock`);

  for (let attempt = 0; attempt < 2; attempt++) {
    let handle: FileHandle;
    try {
      handle = await open(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await lockOwnerIsAlive(path)) throw new Error(`Plasticity window is already owned by another MCP process: ${targetId}`);
      await unlink(path).catch(() => undefined);
      continue;
    }
    await handle.writeFile(JSON.stringify({ pid: process.pid, targetId, createdAt: new Date().toISOString() }));
    let released = false;
    return {
      async release() {
        if (released) return;
        released = true;
        await handle.close();
        await unlink(path).catch(() => undefined);
      },
    };
  }
  throw new Error(`Could not acquire Plasticity window ownership: ${targetId}`);
}

async function lockOwnerIsAlive(path: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return false;
    process.kill(parsed.pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    try {
      return Date.now() - (await stat(path)).mtimeMs < 10_000;
    } catch {
      return false;
    }
  }
}
