import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";

import { ArtifactStore } from "../../src/server/artifact-store.ts";
import { openDatabase } from "../../src/server/database.ts";
import { ProjectEventHub } from "../../src/server/event-hub.ts";
import { createWorkbenchServer } from "../../src/server/http-server.ts";
import { PairingService } from "../../src/server/pairing.ts";
import { SqliteProjectStore } from "../../src/server/project-store.ts";

function onceOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function nextJson(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for WebSocket event")), 2_000);
    socket.once("message", (data) => {
      clearTimeout(timeout);
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    socket.once("error", reject);
  });
}

test("replays persisted events and then streams new project events", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-events-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const database = openDatabase(join(root, "workbench.sqlite"));
  context.after(() => database.close());
  const projects = new SqliteProjectStore(database);
  const artifacts = new ArtifactStore(join(root, "artifacts"), database);
  const pairing = new PairingService(database);
  const service = createWorkbenchServer({
    ownerToken: "a".repeat(43),
    projects,
    artifacts,
    pairing,
    config: { host: "127.0.0.1", port: 0, projectsRoot: join(root, "projects"), maxJsonBytes: 1024 * 1024 },
  });
  const hub = new ProjectEventHub(service.server, projects, pairing, { heartbeatMs: 5_000 });
  const address = await service.listen();
  context.after(async () => {
    await hub.close();
    await service.close();
  });
  const project = projects.create("Bracket", join(root, "project"));
  const token = pairing.issue(project.id, "view", 60_000);
  const foreignSocket = new WebSocket(`${address.origin.replace("http", "ws")}/api/projects/${project.id}/events/ws?token=${token.raw}`, { origin: "https://example.org" });
  const foreignStatus = await new Promise<number>((resolve, reject) => {
    foreignSocket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
    foreignSocket.once("open", () => reject(new Error("Cross-origin socket unexpectedly opened")));
    foreignSocket.once("error", () => undefined);
  });
  assert.equal(foreignStatus, 403);
  const socket = new WebSocket(`${address.origin.replace("http", "ws")}/api/projects/${project.id}/events/ws?token=${token.raw}`);
  context.after(() => socket.close());
  await onceOpen(socket);
  const replayPromise = nextJson(socket);
  socket.send(JSON.stringify({ type: "resume", after: 0 }));
  const replay = await replayPromise;
  assert.equal(replay.type, "event");
  const replayEvent = replay.event as { sequence: number };

  const changed = projects.addStructuredBlock(project.id, 0, {
    type: "requirements",
    title: "Requirements",
    rows: [{ key: "load", label: "Load", value: "1 kg", status: "verified" }],
  });
  const liveEvent = projects.eventsAfter(project.id, replayEvent.sequence)[0];
  assert.ok(liveEvent);
  const livePromise = nextJson(socket);
  const live = await livePromise;
  assert.equal((live.event as { sequence: number }).sequence > replayEvent.sequence, true);
  assert.equal(changed.project.revision, 1);
});

test("rejects a token issued for another project", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-events-auth-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const database = openDatabase(join(root, "workbench.sqlite"));
  context.after(() => database.close());
  const projects = new SqliteProjectStore(database);
  const artifacts = new ArtifactStore(join(root, "artifacts"), database);
  const pairing = new PairingService(database);
  const service = createWorkbenchServer({
    ownerToken: "a".repeat(43),
    projects,
    artifacts,
    pairing,
    config: { host: "127.0.0.1", port: 0, projectsRoot: join(root, "projects"), maxJsonBytes: 1024 * 1024 },
  });
  const hub = new ProjectEventHub(service.server, projects, pairing);
  const address = await service.listen();
  context.after(async () => {
    await hub.close();
    await service.close();
  });
  const projectA = projects.create("A", join(root, "a"));
  const projectB = projects.create("B", join(root, "b"));
  const token = pairing.issue(projectA.id, "view", 60_000);
  const socket = new WebSocket(`${address.origin.replace("http", "ws")}/api/projects/${projectB.id}/events/ws?token=${token.raw}`);
  const status = await new Promise<number>((resolve, reject) => {
    socket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
    socket.once("open", () => reject(new Error("Cross-project socket unexpectedly opened")));
    socket.once("error", () => undefined);
  });
  assert.equal(status, 403);
});
