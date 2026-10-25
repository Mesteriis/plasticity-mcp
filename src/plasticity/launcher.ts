import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

import { CdpClient } from "../cdp/client.ts";
import { discoverPlasticityTargets, type PlasticityTarget } from "../cdp/discovery.ts";
import { assertNodeInspectorEnabled } from "./electron-fuses.ts";

const execFileAsync = promisify(execFile);

export interface InspectorClient {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(method: string, listener: (params: unknown) => void): () => void;
}

export async function unlockMainProcess(client: InspectorClient, rendererPort: number): Promise<void> {
  const pauses: unknown[] = [];
  let receivePause: (() => void) | undefined;
  const unsubscribe = client.on("Debugger.paused", (params) => {
    pauses.push(params);
    receivePause?.();
  });
  let breakpointId: string | undefined;
  let isPaused = false;
  const deadline = Date.now() + 10_000;
  try {
    await client.send("Runtime.enable");
    await client.send("Debugger.enable");
    // Electron 42 may start with an empty main script and never emit the old
    // entry pause. Instrumentation also stops before the first usable module.
    const breakpoint = await client.send("Debugger.setInstrumentationBreakpoint", {
      instrumentation: "beforeScriptExecution",
    }) as { breakpointId?: string };
    breakpointId = breakpoint.breakpointId;
    if (!breakpointId) throw new Error("Plasticity startup instrumentation is unavailable");
    await client.send("Runtime.runIfWaitingForDebugger");
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (pauses.length === 0) {
        await withTimeout(new Promise<void>((resolve) => { receivePause = resolve; }),
          Math.max(1, deadline - Date.now()), "Plasticity main process did not pause at startup");
      }
      const pause = pauses.shift() as { callFrames?: Array<{ callFrameId?: string }> };
      isPaused = true;
      const callFrameId = pause.callFrames?.[0]?.callFrameId;
      if (!callFrameId) throw new Error("Plasticity startup call frame is unavailable");
      const expression = `(() => {
        if (typeof process === 'undefined') return { patched: false };
        let electron;
        try { if (typeof require === 'function') electron = require('electron'); } catch {}
        if (!electron?.app) try { electron = process.mainModule?.require('electron'); } catch {}
        if (!electron?.app) try {
          electron = process.getBuiltinModule?.('module')?.createRequire(process.execPath)('electron');
        } catch {}
        if (!electron?.app) return { patched: false };
        const { app } = electron;
        if (app.isReady()) return { patched: false, tooLate: true };
        const commandLine = app.commandLine;
        const originalRemoveSwitch = commandLine.removeSwitch.bind(commandLine);
        commandLine.removeSwitch = name => {
          if (name === 'remote-debugging-port' || name === 'remote-debugging-pipe') return;
          return originalRemoveSwitch(name);
        };
        commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
        commandLine.appendSwitch('remote-debugging-port', '${rendererPort}');
        return { patched: true, port: commandLine.getSwitchValue('remote-debugging-port') };
      })()`;
      const evaluation = await client.send("Debugger.evaluateOnCallFrame", {
        callFrameId, expression, returnByValue: true,
      }) as { result?: { value?: { patched?: boolean; port?: string; tooLate?: boolean } }; exceptionDetails?: unknown };
      if (evaluation.exceptionDetails || evaluation.result?.value?.tooLate) {
        throw new Error("Plasticity rejected the loopback CDP startup hook");
      }
      if (evaluation.result?.value?.patched === true) return;
      if (Date.now() >= deadline) throw new Error("No usable Plasticity startup module was found");
      await client.send("Debugger.resume");
      isPaused = false;
    }
    throw new Error("No usable Plasticity startup module was found");
  } finally {
    unsubscribe();
    try {
      if (breakpointId) await client.send("Debugger.removeBreakpoint", { breakpointId });
    } finally {
      if (isPaused) await client.send("Debugger.resume");
    }
  }
}

export async function ensurePlasticityCdp(options: {
  rendererPort?: number;
  inspectorPort?: number;
  applicationPath?: string;
  userDataDirectory?: string;
} = {}): Promise<PlasticityTarget[]> {
  if (options.userDataDirectory && !isAbsolute(options.userDataDirectory)) {
    throw new Error("An isolated Plasticity user-data directory must be an absolute path");
  }
  const rendererPort = options.rendererPort ?? 9223;
  const inspectorPort = options.inspectorPort ?? 9229;
  const endpoint = `http://127.0.0.1:${rendererPort}`;
  const current = await tryDiscover(endpoint);
  if (current.length > 0) {
    if (options.userDataDirectory) throw new Error("The isolated Plasticity CDP port is already in use; refusing to attach to another session");
    return current;
  }

  const running = options.userDataDirectory ? false : await isPlasticityRunning();
  if (running) {
    throw new Error("Plasticity is running without MCP access. The launcher will not close or restart it. Save your work, quit Plasticity, then run the launcher again to enable loopback debugging.");
  }

  const applicationPath = options.applicationPath ?? "/Applications/Plasticity.app";
  await assertNodeInspectorEnabled(applicationPath);
  const launchArguments = [`--inspect-brk=127.0.0.1:${inspectorPort}`];
  if (options.userDataDirectory) launchArguments.push(`--user-data-dir=${options.userDataDirectory}`);
  await execFileAsync("open", ["-na", applicationPath, "--args", ...launchArguments]);
  const inspectorTarget = await waitForInspector(inspectorPort);
  const client = await CdpClient.connect(inspectorTarget.webSocketDebuggerUrl);
  try {
    await unlockMainProcess(client, rendererPort);
  } finally {
    client.close();
  }

  return await waitForTargets(endpoint);
}

async function isPlasticityRunning(): Promise<boolean> {
  try {
    await execFileAsync("pgrep", ["-x", "Plasticity"]);
    return true;
  } catch {
    return false;
  }
}

async function waitForInspector(port: number): Promise<{ webSocketDebuggerUrl: string }> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { redirect: "manual" });
      const payload = await response.json() as Array<{ webSocketDebuggerUrl?: string }>;
      const target = payload.find((item) => typeof item.webSocketDebuggerUrl === "string");
      if (target?.webSocketDebuggerUrl) return { webSocketDebuggerUrl: target.webSocketDebuggerUrl };
    } catch {}
    await delay(100);
  }
  throw new Error("Timed out waiting for the Plasticity main-process inspector");
}

async function waitForTargets(endpoint: string): Promise<PlasticityTarget[]> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const targets = await tryDiscover(endpoint);
    if (targets.length > 0) return targets;
    await delay(100);
  }
  throw new Error("Timed out waiting for the Plasticity renderer CDP endpoint");
}

async function tryDiscover(endpoint: string): Promise<PlasticityTarget[]> {
  try {
    return await discoverPlasticityTargets(endpoint);
  } catch {
    return [];
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
