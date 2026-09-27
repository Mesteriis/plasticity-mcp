import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadOrCreateOwnerToken, ownerTokenMatches, readOwnerToken } from "../../src/server/owner-auth.ts";

test("owner token is private, stable across starts, and rejects a readable secret file", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-owner-auth-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const token = await loadOrCreateOwnerToken(root);
  assert.equal(token.length, 43);
  assert.equal(ownerTokenMatches(token, token), true);
  assert.equal(ownerTokenMatches(token, "wrong"), false);
  assert.equal(await loadOrCreateOwnerToken(root), token);
  assert.equal(await readOwnerToken(root), token);
  const path = join(root, "owner-token");
  assert.equal((await stat(path)).mode & 0o077, 0);
  await chmod(path, 0o644);
  await assert.rejects(readOwnerToken(root), /private regular file/);
});
