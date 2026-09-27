import assert from "node:assert/strict";
import { test } from "node:test";

import { mutationOutcomeIsUncertain, PlasticityRuntime } from "./runtime.ts";
import type { CdpClient } from "../cdp/client.ts";

test("does not classify native validation text containing closed as a transport failure", () => {
  assert.equal(mutationOutcomeIsUncertain(new Error("Plasticity command failed: Profile must be a closed Wire")), false);
});

test("classifies CDP timeout and closed-connection failures as uncertain", () => {
  assert.equal(mutationOutcomeIsUncertain(new Error("CDP request timed out: Runtime.callFunctionOn")), true);
  assert.equal(mutationOutcomeIsUncertain(new Error("CDP connection is closed")), true);
  assert.equal(mutationOutcomeIsUncertain(new Error("CDP connection closed before the request completed")), true);
});

test("reconnects to Plasticity and reacquires its live editor and native bindings", async () => {
  let generation = 0;
  const editorIds: string[] = [];
  const constructorIds: string[] = [];
  const closed: number[] = [];
  const failMethod: string[] = [];
  const makeClient = (failedMethod?: string): CdpClient => {
    const index = closed.length;
    closed.push(0);
    return {
      async send(method: string, params: Record<string, unknown> = {}) {
        if (method === "Runtime.enable") {
          if (method === failedMethod) throw new Error(`Replacement ${method} failed`);
          return {};
        }
        if (method === "Runtime.evaluate") {
          if (method === failedMethod) throw new Error(`Replacement ${method} failed`);
          generation += 1;
          return { result: { objectId: `handler-${generation}` } };
        }
        if (method === "Runtime.getProperties") {
          const objectId = params.objectId;
          const current = generation;
          if (objectId === `handler-${current}`) return { result: [], internalProperties: [{ name: "[[Scopes]]", value: { objectId: `scopes-${current}` } }] };
          if (objectId === `scopes-${current}`) return { result: [
            { name: "0", value: { objectId: `closure-${current}` } },
            { name: "1", value: { objectId: `native-${current}` } },
          ] };
          if (objectId === `closure-${current}`) return { result: [{ name: "editor", value: { objectId: `editor-${current}` } }] };
          if (objectId === `native-${current}`) return { result: [{ name: "Vector3", value: { objectId: `Vector3-${current}` } }] };
          throw new Error(`Unexpected object: ${String(objectId)}`);
        }
        if (method === "Runtime.releaseObject") return {};
        if (method === "Runtime.callFunctionOn") {
          editorIds.push(String(params.objectId));
          const args = params.arguments as Array<{ objectId?: string }>;
          constructorIds.push(String(args[0]?.objectId));
          return { result: { value: "read-result" } };
        }
        throw new Error(`Unexpected CDP method: ${method}`);
      },
      close() { closed[index] = (closed[index] ?? 0) + 1; },
    } as unknown as CdpClient;
  };
  const client = makeClient();
  const RuntimeConstructor = PlasticityRuntime as unknown as new (client: CdpClient, target: { id: string; title: string; webSocketDebuggerUrl: string }, editorId: string, connectClient: (url: string) => Promise<CdpClient>) => PlasticityRuntime;
  const runtime = new RuntimeConstructor(client, { id: "window-1", title: "Part", webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/1" }, "stale-editor", async () => makeClient(failMethod.shift()));

  await runtime.reconnect();
  assert.equal(await runtime.readNative("function (Vector3) { return 'ok'; }", ["Vector3"]), "read-result");
  assert.equal(await runtime.readNative("function (Vector3) { return 'ok'; }", ["Vector3"]), "read-result");
  failMethod.push("Runtime.evaluate");
  await assert.rejects(runtime.reconnect(), /Replacement Runtime.evaluate failed/);
  assert.equal(await runtime.readNative("function (Vector3) { return 'ok'; }", ["Vector3"]), "read-result");
  await runtime.reconnect();
  assert.equal(await runtime.readNative("function (Vector3) { return 'ok'; }", ["Vector3"]), "read-result");

  assert.deepEqual(editorIds, ["editor-1", "editor-1", "editor-1", "editor-2"]);
  assert.deepEqual(constructorIds, ["Vector3-1", "Vector3-1", "Vector3-1", "Vector3-2"]);
  assert.equal(closed[2], 1, "failed replacement client should close once");
});
