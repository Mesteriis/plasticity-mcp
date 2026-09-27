import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../../src/server/artifact-store.ts";
import { openDatabase } from "../../src/server/database.ts";

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test("stores identical bytes once and opens them by hash", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-workbench-artifacts-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const database = openDatabase(join(root, "project.sqlite"));
  context.after(() => database.close());
  const artifacts = new ArtifactStore(join(root, "objects"), database);

  const first = await artifacts.put(Buffer.from("step"), {
    mediaType: "model/step",
    originalName: "a.step",
  });
  const second = await artifacts.put(Buffer.from("step"), {
    mediaType: "model/step",
    originalName: "b.step",
  });

  assert.equal(first.hash, second.hash);
  assert.equal((await readAll(await artifacts.open(first.hash))).toString("utf8"), "step");
  const count = database.prepare("SELECT count(*) AS count FROM artifacts").get() as { count: number };
  assert.equal(count.count, 1);
  await assert.rejects(() => artifacts.open("f".repeat(64)), /not found/i);
});

test("rejects unsafe display names and oversized content", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-workbench-limits-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const database = openDatabase(join(root, "project.sqlite"));
  context.after(() => database.close());
  const artifacts = new ArtifactStore(join(root, "objects"), database, { maxBytes: 3 });

  await assert.rejects(
    () => artifacts.put(Buffer.from("ok"), { mediaType: "model/step", originalName: "../part.step" }),
    /file name/i,
  );
  await assert.rejects(
    () => artifacts.put(Buffer.from("four"), { mediaType: "model/step", originalName: "part.step" }),
    /exceeds/i,
  );
  const count = database.prepare("SELECT count(*) AS count FROM artifacts").get() as { count: number };
  assert.equal(count.count, 0);
});
