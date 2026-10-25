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
      if (method === "Debugger.setInstrumentationBreakpoint") return { breakpointId: "startup" };
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
    "Debugger.setInstrumentationBreakpoint",
    "Runtime.runIfWaitingForDebugger",
    "Debugger.evaluateOnCallFrame",
    "Debugger.removeBreakpoint",
    "Debugger.resume",
  ]);
});

test("waits through an empty Electron main before a usable instrumented module", async () => {
  let listener: ((params: unknown) => void) | undefined;
  let evaluations = 0;
  const calls: string[] = [];
  const client: InspectorClient = {
    on(_method, callback) { listener = callback; return () => { listener = undefined; }; },
    async send(method, params) {
      calls.push(method);
      if (method === "Debugger.setInstrumentationBreakpoint") return { breakpointId: "startup" };
      if (method === "Runtime.runIfWaitingForDebugger" || (method === "Debugger.resume" && evaluations === 1)) {
        listener?.({ callFrames: [{ callFrameId: `module-${evaluations}` }] });
      }
      if (method === "Debugger.evaluateOnCallFrame") {
        assert.equal(params?.callFrameId, `module-${evaluations}`);
        evaluations += 1;
        return { result: { value: { patched: evaluations === 2, port: "9223" } } };
      }
      return {};
    },
  };
  await unlockMainProcess(client, 9223);
  assert.equal(evaluations, 2);
  assert.deepEqual(calls.slice(-2), ["Debugger.removeBreakpoint", "Debugger.resume"]);
  assert.equal(listener, undefined);
});

test("a rejected startup hook removes instrumentation and resumes the paused app", async () => {
  let listener: ((params: unknown) => void) | undefined;
  const calls: string[] = [];
  const client: InspectorClient = {
    on(_method, callback) { listener = callback; return () => { listener = undefined; }; },
    async send(method) {
      calls.push(method);
      if (method === "Debugger.setInstrumentationBreakpoint") return { breakpointId: "startup" };
      if (method === "Runtime.runIfWaitingForDebugger") listener?.({ callFrames: [{ callFrameId: "late" }] });
      if (method === "Debugger.evaluateOnCallFrame") return { result: { value: { patched: false, tooLate: true } } };
      return {};
    },
  };
  await assert.rejects(unlockMainProcess(client, 9223), /rejected the loopback/);
  assert.deepEqual(calls.slice(-2), ["Debugger.removeBreakpoint", "Debugger.resume"]);
  assert.equal(listener, undefined);
});
