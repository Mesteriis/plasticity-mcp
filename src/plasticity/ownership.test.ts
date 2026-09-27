import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
