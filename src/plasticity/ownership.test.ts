import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { acquireWindowOwnership } from "./ownership.ts";

test("allows only one live MCP owner for a Plasticity window", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plasticity-mcp-owner-"));
  try {
    const owner = await acquireWindowOwnership("window-1", directory);
    await assert.rejects(acquireWindowOwnership("window-1", directory), /already owned/i);
    await owner.release();
    const next = await acquireWindowOwnership("window-1", directory);
    await next.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recovers a stale lock left by an exited process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plasticity-mcp-stale-owner-"));
  try {
    const owner = await acquireWindowOwnership("window-1", directory);
    const [lockName] = await readdir(directory);
    assert.ok(lockName);
    await owner.release();
    await writeFile(join(directory, lockName), JSON.stringify({ pid: 99999999 }));
    const past = new Date(Date.now() - 20_000);
    await utimes(join(directory, lockName), past, past);
    const recovered = await acquireWindowOwnership("window-1", directory);
    await recovered.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("default lock coordinates processes started from different working directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-mcp-cross-cwd-"));
  const firstCwd = join(root, "first");
  const secondCwd = join(root, "second");
  await mkdir(firstCwd);
  await mkdir(secondCwd);
  const moduleUrl = new URL("./ownership.ts", import.meta.url).href;
  const code = `import { acquireWindowOwnership } from ${JSON.stringify(moduleUrl)};
    try {
      const owner = await acquireWindowOwnership("window-1");
      process.stdout.write("acquired\\n");
      await new Promise((resolve) => process.stdin.once("data", resolve));
      await owner.release();
    } catch (error) {
      process.stdout.write("blocked\\n");
      process.exitCode = 1;
    }`;
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, PLASTICITY_CDP_URL: "http://127.0.0.1:9223" };
  delete env.PLASTICITY_MCP_STATE_DIR;
  const start = (cwd: string) => spawn(process.execPath, ["--input-type=module", "--eval", code], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const output = async (child: ReturnType<typeof start>) => await new Promise<string>((resolve, reject) => {
    child.once("error", reject);
    child.stdout.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8").trim()));
    child.once("exit", (code) => reject(new Error(`Ownership child exited before responding: ${code}`)));
  });
  const first = start(firstCwd);
  try {
    assert.equal(await output(first), "acquired");
    const second = start(secondCwd);
    assert.equal(await output(second), "blocked");
    first.stdin.end("release\n");
    await new Promise<void>((resolve) => first.once("exit", () => resolve()));
    const third = start(secondCwd);
    assert.equal(await output(third), "acquired");
    third.stdin.end("release\n");
    await new Promise<void>((resolve) => third.once("exit", () => resolve()));
  } finally {
    first.kill();
    await rm(root, { recursive: true, force: true });
  }
});
