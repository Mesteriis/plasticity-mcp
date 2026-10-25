import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { assertNodeInspectorEnabled } from "./electron-fuses.ts";
import { ensurePlasticityCdp } from "./launcher.ts";

const sentinel = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");
function wire(states: string, version = 1): Buffer {
  return Buffer.concat([sentinel, Buffer.from([version, states.length]), Buffer.from(states)]);
}

async function bundle(data: Buffer) {
  const root = await mkdtemp(join(tmpdir(), "plasticity-fuses-test-"));
  const app = join(root, "Plasticity.app");
  const binary = join(app, "Contents", "Frameworks", "Electron Framework.framework", "Electron Framework");
  await mkdir(dirname(binary), { recursive: true });
  await writeFile(binary, data);
  return { app, binary, async close() { await rm(root, { recursive: true, force: true }); } };
}

test("reads enabled v1 inspector fuses without modifying the framework", async () => {
  const data = Buffer.concat([Buffer.alloc(123), wire("1011000")]);
  const fixture = await bundle(data);
  try {
    await assertNodeInspectorEnabled(fixture.app);
    assert.deepEqual(await readFile(fixture.binary), data);
  } finally { await fixture.close(); }
});

test("rejects the disabled inspector wire reported for Plasticity 26.2.1 and removed inspector fuses", async () => {
  for (const states of ["000011011", "101r000"]) {
    const fixture = await bundle(wire(states));
    try { await assert.rejects(assertNodeInspectorEnabled(fixture.app), /EnableNodeCliInspectArguments.*26\.1\.3/s); }
    finally { await fixture.close(); }
  }
});

test("checks every universal-binary slice and finds sentinels across read boundaries", async () => {
  for (const second of ["1011000", "000011011"]) {
    const fixture = await bundle(Buffer.concat([wire("1011000"), Buffer.alloc(1024 * 1024 - 10 - wire("1011000").length), wire(second)]));
    try {
      if (second === "1011000") await assertNodeInspectorEnabled(fixture.app);
      else await assert.rejects(assertNodeInspectorEnabled(fixture.app), /EnableNodeCliInspectArguments/);
    } finally { await fixture.close(); }
  }
});

test("unknown, missing and truncated fuse formats produce a verification error", async () => {
  for (const data of [Buffer.alloc(100), wire("1011000", 2), wire("1011000", 49), wire("101"), wire("101x000"), wire("1011000").subarray(0, -1), sentinel]) {
    const fixture = await bundle(data);
    try { await assert.rejects(assertNodeInspectorEnabled(fixture.app), /Cannot verify.*fuse wire/); }
    finally { await fixture.close(); }
  }
});

test("launcher rejects a disabled build before trying to launch its incomplete app bundle", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("No existing endpoint"); });
  const fixture = await bundle(wire("000011011"));
  try {
    await assert.rejects(ensurePlasticityCdp({ applicationPath: fixture.app, userDataDirectory: join(fixture.app, "profile") }), /EnableNodeCliInspectArguments/);
  } finally { await fixture.close(); }
});

test("launcher can reuse an existing CDP target without requiring an installed app", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify([{
    id: "window", type: "page", title: "Plasticity", url: "file:///app/.webpack/renderer/app_window/index.html",
    webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/window",
  }])));
  const targets = await ensurePlasticityCdp({ applicationPath: "/nonexistent/Plasticity.app" });
  assert.equal(targets[0]?.id, "window");
});
