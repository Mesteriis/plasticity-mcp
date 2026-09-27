import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "../../src/server/database.ts";
import { PairingService } from "../../src/server/pairing.ts";
import { SqliteProjectStore } from "../../src/server/project-store.ts";

test("an annotate token cannot edit or access another project", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-pairing-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const database = openDatabase(join(root, "workbench.sqlite"));
  context.after(() => database.close());
  const projects = new SqliteProjectStore(database);
  const projectA = projects.create("A", join(root, "a"));
  const projectB = projects.create("B", join(root, "b"));
  const pairing = new PairingService(database);
  const token = pairing.issue(projectA.id, "annotate", 15 * 60_000, 1_000);

  assert.equal(pairing.authorize(token.raw, projectA.id, "annotate", 1_001).role, "annotate");
  assert.equal(pairing.authorize(token.raw, projectA.id, "view", 1_001).role, "annotate");
  assert.throws(() => pairing.authorize(token.raw, projectA.id, "edit", 1_001), /permission/i);
  assert.throws(() => pairing.authorize(token.raw, projectB.id, "view", 1_001), /permission/i);
  const stored = database.prepare("SELECT token_hash FROM pairing_tokens").get() as { token_hash: string };
  assert.notEqual(stored.token_hash, token.raw);
});

test("expires, revokes, and rotates pairing codes into sessions", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-pairing-expiry-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const database = openDatabase(join(root, "workbench.sqlite"));
  context.after(() => database.close());
  const projects = new SqliteProjectStore(database);
  const project = projects.create("A", join(root, "a"));
  const pairing = new PairingService(database);
  const expired = pairing.issue(project.id, "view", 1_000, 10_000);
  assert.throws(() => pairing.authorize(expired.raw, project.id, "view", 11_001), /expired/i);

  const code = pairing.issue(project.id, "edit", 10_000, 20_000);
  const session = pairing.exchange(code.raw, 20_100);
  assert.notEqual(session.raw, code.raw);
  assert.throws(() => pairing.authorize(code.raw, project.id, "view", 20_101), /revoked/i);
  assert.equal(pairing.authorize(session.raw, project.id, "edit", 20_101).role, "edit");
  pairing.revoke(session.raw, 20_102);
  assert.throws(() => pairing.authorize(session.raw, project.id, "view", 20_103), /revoked/i);
});

test("builds a LAN pairing URL without changing its token", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-pairing-url-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const database = openDatabase(join(root, "workbench.sqlite"));
  context.after(() => database.close());
  const project = new SqliteProjectStore(database).create("A", join(root, "a"));
  const pairing = new PairingService(database);
  const token = pairing.issue(project.id, "annotate", 10_000, 1_000);
  assert.equal(pairing.url("http://192.168.1.20:4317", token), `http://192.168.1.20:4317/pair?code=${token.raw}`);
});

test("lists and revokes project pairings without exposing raw tokens", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-pairing-list-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const database = openDatabase(join(root, "workbench.sqlite"));
  context.after(() => database.close());
  const projects = new SqliteProjectStore(database);
  const project = projects.create("A", join(root, "a"));
  const other = projects.create("B", join(root, "b"));
  const pairing = new PairingService(database);
  const link = pairing.issue(project.id, "annotate", 10_000, 1_000);
  const session = pairing.exchange(link.raw, 1_100);
  pairing.issue(other.id, "view", 10_000, 1_200);

  const grants = pairing.list(project.id, 1_300);
  assert.equal(grants.length, 1);
  assert.equal(grants[0]?.kind, "session");
  assert.equal(grants[0]?.role, "annotate");
  assert.equal(JSON.stringify(grants).includes(session.raw), false);
  assert.equal(pairing.revokeById(other.id, grants[0]!.id, 1_400), false);
  assert.equal(pairing.revokeById(project.id, grants[0]!.id, 1_400), true);
  assert.equal(pairing.list(project.id, 1_500).length, 0);
  assert.throws(() => pairing.authorize(session.raw, project.id, "view", 1_500), /revoked/i);
});
