import assert from "node:assert/strict";
import { test } from "node:test";

import { connectSessionWindow, type SessionConnection } from "./session-lifecycle.ts";

type Runtime = { close(): void; reconnect(): Promise<void> };
type Operations = { state(): Promise<{ revision: string }> };
type Lease = { release(): Promise<void> };

function connection(targetId: string, events: string[]): SessionConnection<{ revision: string }, Runtime, Operations, Lease> {
  return {
    targetId,
    runtime: { close() { events.push(`close:${targetId}`); }, async reconnect() { events.push(`reconnect:${targetId}`); } },
    operations: { async state() { events.push(`state:${targetId}`); return { revision: `revision:${targetId}` }; } },
    ownership: { async release() { events.push(`release:${targetId}`); } },
  };
}

test("reconnecting to the current window reuses its owner and runtime", async () => {
  const events: string[] = [];
  const current = connection("window-a", events);
  let acquired = false;

  const result = await connectSessionWindow({
    targetId: "window-a",
    target: { id: "window-a" },
    current,
    acquireOwnership: async () => { acquired = true; return { async release() {} }; },
    connectRuntime: async () => { throw new Error("must not open a second CDP client"); },
    createOperations: () => { throw new Error("must reuse current operations"); },
  });

  assert.equal(result.connection, current);
  assert.deepEqual(result.state, { revision: "revision:window-a" });
  assert.equal(acquired, false);
  assert.deepEqual(events, ["reconnect:window-a", "state:window-a"]);
});

test("a busy target leaves the current Plasticity connection intact", async () => {
  const events: string[] = [];
  const current = connection("window-a", events);

  await assert.rejects(connectSessionWindow({
    targetId: "window-b",
    target: { id: "window-b" },
    current,
    acquireOwnership: async () => { throw new Error("window-b already owned"); },
    connectRuntime: async () => { throw new Error("must not connect"); },
    createOperations: () => { throw new Error("must not create operations"); },
  }), /already owned/);

  assert.deepEqual(events, []);
});

test("a failed candidate connection releases only its new owner and preserves the current window", async () => {
  const events: string[] = [];
  const current = connection("window-a", events);
  const candidateLease = { async release() { events.push("release:window-b"); } };

  await assert.rejects(connectSessionWindow({
    targetId: "window-b",
    target: { id: "window-b" },
    current,
    acquireOwnership: async () => candidateLease,
    connectRuntime: async () => { throw new Error("CDP unavailable"); },
    createOperations: () => { throw new Error("must not create operations"); },
  }), /CDP unavailable/);

  assert.deepEqual(events, ["release:window-b"]);
});

test("a candidate that cannot read its initial document is closed and released without dropping the current window", async () => {
  const events: string[] = [];
  const current = connection("window-a", events);

  await assert.rejects(connectSessionWindow({
    targetId: "window-b",
    target: { id: "window-b" },
    current,
    acquireOwnership: async () => ({ async release() { events.push("release:window-b"); } }),
    connectRuntime: async () => { events.push("connect:window-b"); return { close() { events.push("close:window-b"); }, async reconnect() {} }; },
    createOperations: () => ({ async state() { events.push("state:window-b"); throw new Error("document state unavailable"); } }),
  }), /document state unavailable/);

  assert.deepEqual(events, ["connect:window-b", "state:window-b", "close:window-b", "release:window-b"]);
});

test("a successful window switch reads the new document before releasing the old connection", async () => {
  const events: string[] = [];
  const current = connection("window-a", events);

  const result = await connectSessionWindow({
    targetId: "window-b",
    target: { id: "window-b" },
    current,
    acquireOwnership: async () => ({ async release() { events.push("release:window-b"); } }),
    connectRuntime: async () => {
      events.push("connect:window-b");
      return { close() { events.push("close:window-b"); }, async reconnect() {} };
    },
    createOperations: () => ({ async state() { events.push("state:window-b"); return { revision: "revision:window-b" }; } }),
  });

  assert.deepEqual(result.state, { revision: "revision:window-b" });
  assert.equal(result.connection.targetId, "window-b");
  assert.deepEqual(events, ["connect:window-b", "state:window-b", "close:window-a", "release:window-a"]);
});

test("a failure to release the previous owner discards the candidate and allows reconnecting to the previous window", async () => {
  const events: string[] = [];
  const current = connection("window-a", events);
  current.ownership.release = async () => { events.push("release:window-a"); throw new Error("old lease release failed"); };

  await assert.rejects(connectSessionWindow({
    targetId: "window-b",
    target: { id: "window-b" },
    current,
    acquireOwnership: async () => ({ async release() { events.push("release:window-b"); } }),
    connectRuntime: async () => { events.push("connect:window-b"); return { close() { events.push("close:window-b"); }, async reconnect() {} }; },
    createOperations: () => ({ async state() { events.push("state:window-b"); return { revision: "revision:window-b" }; } }),
  }), /old lease release failed/);

  const recovered = await connectSessionWindow({
    targetId: "window-a",
    target: { id: "window-a" },
    current,
    acquireOwnership: async () => { throw new Error("the old window is still owned"); },
    connectRuntime: async () => { throw new Error("must reconnect the existing runtime"); },
    createOperations: () => { throw new Error("must reuse existing operations"); },
  });
  assert.equal(recovered.connection, current);
  assert.deepEqual(events, ["connect:window-b", "state:window-b", "close:window-a", "release:window-a", "close:window-b", "release:window-b", "reconnect:window-a", "state:window-a"]);
});
