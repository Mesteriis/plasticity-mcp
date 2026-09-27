import assert from "node:assert/strict";
import { test } from "node:test";

import { unlockMainProcess, type InspectorClient } from "./launcher.ts";

test("unlocks renderer CDP before resuming Plasticity main", async () => {
  const calls: string[] = [];
  let paused: ((params: unknown) => void) | undefined;
  const client: InspectorClient = {
    on(method, listener) {
      assert.equal(method, "Debugger.paused");
      paused = listener;
      return () => {};
    },
    async send(method) {
      calls.push(method);
      if (method === "Runtime.runIfWaitingForDebugger") {
        paused?.({ callFrames: [{ callFrameId: "frame-1" }] });
      }
      if (method === "Debugger.evaluateOnCallFrame") {
        return { result: { value: { patched: true, port: "9223" } } };
      }
      return {};
    },
  };

  await unlockMainProcess(client, 9223);

  assert.deepEqual(calls, [
    "Runtime.enable",
    "Debugger.enable",
    "Runtime.runIfWaitingForDebugger",
    "Debugger.evaluateOnCallFrame",
    "Debugger.resume",
  ]);
});
