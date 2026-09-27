import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";

import { discoverPlasticityTargets } from "./discovery.ts";

const servers: Array<ReturnType<typeof createServer>> = [];

after(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

async function serveJson(value: unknown): Promise<string> {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(value));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

test("discovers only inspectable Plasticity app windows", async () => {
  const endpoint = await serveJson([
    {
      id: "window-1",
      type: "page",
      title: "Untitled — Plasticity",
      url: "file:///Applications/Plasticity.app/Contents/Resources/app/.webpack/renderer/app_window/index.html",
      webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/window-1",
    },
    {
      id: "license",
      type: "page",
      title: "License",
      url: "file:///Applications/Plasticity.app/Contents/Resources/app/.webpack/renderer/license_window/index.html",
      webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/license",
    },
    {
      id: "worker",
      type: "worker",
      title: "Plasticity worker",
      url: "file:///worker.js",
      webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/worker",
    },
  ]);

  const targets = await discoverPlasticityTargets(endpoint);

  assert.deepEqual(targets, [
    {
      id: "window-1",
      title: "Untitled — Plasticity",
      url: "file:///Applications/Plasticity.app/Contents/Resources/app/.webpack/renderer/app_window/index.html",
      webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/window-1",
    },
  ]);
});

test("refuses non-loopback CDP endpoints", async () => {
  await assert.rejects(
    discoverPlasticityTargets("http://192.0.2.10:9223"),
    /loopback/i,
  );
});

test("rejects malformed target data", async () => {
  const endpoint = await serveJson([{ id: "window-1", type: "page" }]);

  await assert.rejects(discoverPlasticityTargets(endpoint), /malformed/i);
});

test("refuses redirects during CDP discovery", async () => {
  const destination = await serveJson([]);
  const redirector = createServer((_request, response) => {
    response.statusCode = 302;
    response.setHeader("location", `${destination}/json/list`);
    response.end();
  });
  servers.push(redirector);
  await new Promise<void>((resolve) => redirector.listen(0, "127.0.0.1", resolve));
  const address = redirector.address();
  assert(address && typeof address === "object");

  await assert.rejects(
    discoverPlasticityTargets(`http://127.0.0.1:${address.port}`),
    /redirect/i,
  );
});
