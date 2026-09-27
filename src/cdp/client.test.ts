import assert from "node:assert/strict";
import { test } from "node:test";

import { CdpClient, type WebSocketLike } from "./client.ts";

class FakeSocket implements WebSocketLike {
  readyState = 1;
  sent: string[] = [];
  private listeners = new Map<string, Array<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {}

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

test("matches CDP responses to requests", async () => {
  const socket = new FakeSocket();
  const client = new CdpClient(socket, 100);

  const pending = client.send("Runtime.evaluate", { expression: "1 + 1" });
  const request = JSON.parse(socket.sent[0] ?? "") as { id: number };
  socket.emit("message", { data: JSON.stringify({ id: request.id, result: { result: { value: 2 } } }) });

  assert.deepEqual(await pending, { result: { value: 2 } });
});

test("rejects a request when CDP returns an error", async () => {
  const socket = new FakeSocket();
  const client = new CdpClient(socket, 100);

  const pending = client.send("Runtime.evaluate");
  const request = JSON.parse(socket.sent[0] ?? "") as { id: number };
  socket.emit("message", { data: JSON.stringify({ id: request.id, error: { code: -1, message: "bad" } }) });

  await assert.rejects(pending, /bad/);
});

test("rejects pending requests when the connection closes", async () => {
  const socket = new FakeSocket();
  const client = new CdpClient(socket, 100);

  const pending = client.send("Runtime.evaluate");
  socket.emit("close", {});

  await assert.rejects(pending, /closed/i);
});

test("supports a shorter request-scoped timeout without changing the client default", async () => {
  const socket = new FakeSocket();
  const client = new CdpClient(socket, 100);

  await assert.rejects(client.send("Runtime.evaluate", {}, 5), /timed out/i);
  await assert.rejects(client.send("Runtime.evaluate", {}, 0), /positive integer/i);
  const pending = client.send("Runtime.evaluate");
  const request = JSON.parse(socket.sent.at(-1) ?? "") as { id: number };
  socket.emit("message", { data: JSON.stringify({ id: request.id, result: { result: { value: 2 } } }) });
  assert.deepEqual(await pending, { result: { value: 2 } });
});

test("captures the current PNG surface without depending on a visible-window screencast", async () => {
  const socket = new FakeSocket();
  const client = new CdpClient(socket, 100);
  const capture = client.captureScreenshot();
  const request = JSON.parse(socket.sent[0] ?? "") as { id: number; method: string; params: { format: string; fromSurface: boolean } };
  assert.equal(request.method, "Page.captureScreenshot");
  assert.deepEqual(request.params, { format: "png", fromSurface: true });
  socket.emit("message", { data: JSON.stringify({ id: request.id, result: { data: "cG5n" } }) });
  assert.equal(await capture, "cG5n");
});

test("times out a page screenshot request", async () => {
  const socket = new FakeSocket();
  const client = new CdpClient(socket, 5);

  await assert.rejects(client.captureScreenshot(), /timed out/i);
  const requests = socket.sent.map((message) => JSON.parse(message) as { method: string });
  assert.deepEqual(requests.map((request) => request.method), ["Page.captureScreenshot"]);
});
