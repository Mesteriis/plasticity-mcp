import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CodexClient, type CodexTurnJournal } from "../../src/server/codex/client.ts";
import { openDatabase } from "../../src/server/database.ts";
import { SqliteCodexTurnJournal } from "../../src/server/codex/journal.ts";

const fakeServerPath = fileURLToPath(new URL("../fixtures/fake-codex-app-server.ts", import.meta.url));

class RecordingJournal implements CodexTurnJournal {
  readonly states: string[] = [];
  requested(): void { this.states.push("requested"); }
  started(): void { this.states.push("started"); }
  completed(): void { this.states.push("completed"); }
  failed(): void { this.states.push("failed"); }
}

test("initializes, starts one turn, and reports a child crash without retry", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-codex-crash-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const logPath = join(root, "methods.log");
  const journal = new RecordingJournal();
  const client = await CodexClient.start({
    executable: process.execPath,
    args: [fakeServerPath, "--crash-after-turn", logPath],
    journal,
  });
  context.after(async () => await client.close());
  const thread = await client.startThread({ cwd: root });
  const turn = await client.startTurn(thread.id, [{ type: "text", text: "build a bracket" }]);

  await assert.rejects(turn.completed, /app-server exited/i);
  const methods = (await readFile(logPath, "utf8")).trim().split("\n");
  assert.equal(methods.filter((method) => method === "turn/start").length, 1);
  assert.deepEqual(journal.states, ["requested", "started", "failed"]);
});

test("resumes a thread and completes a streamed turn", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-codex-complete-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const journal = new RecordingJournal();
  const events: string[] = [];
  const client = await CodexClient.start({
    executable: process.execPath,
    args: [fakeServerPath, "--complete-turn", join(root, "methods.log")],
    journal,
    onEvent: (event) => events.push(event.type),
  });
  context.after(async () => await client.close());
  assert.equal((await client.resumeThread("existing-thread")).id, "existing-thread");
  const turn = await client.startTurn("existing-thread", [{ type: "text", text: "continue" }]);
  const completion = await turn.completed;

  assert.equal(completion.turnId, "turn-1");
  assert.deepEqual(journal.states, ["requested", "started", "completed"]);
  assert.ok(events.includes("notification"));
});

test("rejects malformed app-server output", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-codex-malformed-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const client = await CodexClient.start({
    executable: process.execPath,
    args: [fakeServerPath, "--malformed-after-init", join(root, "methods.log")],
  });
  context.after(async () => await client.close());
  await assert.rejects(() => client.startThread({ cwd: root }), /invalid JSON/i);
});

test("persists an interrupted turn as failed instead of replaying it", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-codex-journal-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const path = join(root, "workbench.sqlite");
  let database = openDatabase(path);
  let journal = new SqliteCodexTurnJournal(database);
  journal.requested("message-1", "thread-1", [{ type: "text", text: "build" }]);
  journal.started("message-1", "turn-1");
  database.close();

  database = openDatabase(path);
  journal = new SqliteCodexTurnJournal(database);
  assert.equal(journal.failPending("Workbench restarted"), 1);
  assert.equal(journal.get("message-1")?.state, "failed");
  database.close();
});
