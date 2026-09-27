import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { StructuredBlockInput } from "../../src/shared/contracts.ts";
import { ArtifactStore } from "../../src/server/artifact-store.ts";
import { resolveWorkbenchConfig } from "../../src/server/config.ts";
import { openDatabase } from "../../src/server/database.ts";
import { createWorkbenchServer, isPrivateClientAddress } from "../../src/server/http-server.ts";
import { PairingService } from "../../src/server/pairing.ts";
import { SqliteProjectStore } from "../../src/server/project-store.ts";

const requirementsBlock: StructuredBlockInput = {
  type: "requirements",
  title: "Requirements",
  rows: [{ key: "load", label: "Load", value: "1 kg", status: "verified" }],
};

const assumptionsBlock: StructuredBlockInput = {
  type: "assumptions",
  title: "Assumptions",
  rows: [
    {
      key: "material",
      label: "Material",
      value: "PETG",
      confidence: "assumed",
      status: "assumed",
    },
  ],
};
const ownerToken = "a".repeat(43);

async function createHarness(context: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "plasticity-workbench-http-"));
  const database = openDatabase(join(root, "workbench.sqlite"));
  const projects = new SqliteProjectStore(database);
  const pairing = new PairingService(database);
  const artifacts = new ArtifactStore(join(root, "artifacts"), database);
  const service = createWorkbenchServer({
    projects,
    pairing,
    artifacts,
    ownerToken,
    config: {
      host: "127.0.0.1",
      port: 0,
      projectsRoot: join(root, "projects"),
      maxJsonBytes: 1024 * 1024,
    },
  });
  const address = await service.listen();
  context.after(async () => {
    await service.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  const raw = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const options: RequestInit = { method, headers: { authorization: `Bearer ${ownerToken}`, ...headers } };
    if (body !== undefined) {
      options.body = typeof body === "string" ? body : JSON.stringify(body);
      if (!("content-type" in headers)) (options.headers as Record<string, string>)["content-type"] = "application/json";
    }
    return await fetch(`${address.origin}${path}`, options);
  };
  const createProject = async (name: string) => {
    const response = await raw("POST", "/api/projects", { name });
    assert.equal(response.status, 201);
    return (await response.json()) as { id: string; revision: number };
  };
  return { raw, createProject, pairing, origin: address.origin };
}

test("returns 409 and the current revision for a stale mutation", async (context) => {
  const api = await createHarness(context);
  const project = await api.createProject("Bracket");
  const first = await api.raw("POST", `/api/projects/${project.id}/blocks`, {
    expectedRevision: 0,
    block: requirementsBlock,
  });
  assert.equal(first.status, 201);

  const stale = await api.raw("POST", `/api/projects/${project.id}/blocks`, {
    expectedRevision: 0,
    block: assumptionsBlock,
  });
  assert.equal(stale.status, 409);
  assert.equal(((await stale.json()) as { currentRevision: number }).currentRevision, 1);
});

test("never accepts a caller supplied asset path", async (context) => {
  const api = await createHarness(context);
  const project = await api.createProject("Enclosure");
  const response = await api.raw("POST", `/api/projects/${project.id}/assets`, { path: "/etc/passwd" });
  assert.equal(response.status, 400);
  assert.match(JSON.stringify(await response.json()), /raw artifact bytes/i);
});

test("serves an uploaded artifact only to its project", async (context) => {
  const api = await createHarness(context);
  const owner = await api.createProject("Owner");
  const other = await api.createProject("Other");
  const uploaded = await api.raw(
    "POST",
    `/api/projects/${owner.id}/assets`,
    "ISO-10303-21",
    { "content-type": "model/step", "x-file-name": "part.step" },
  );
  assert.equal(uploaded.status, 201);
  const artifact = (await uploaded.json()) as { hash: string };

  assert.equal((await api.raw("GET", `/api/projects/${owner.id}/assets/${artifact.hash}`)).status, 200);
  assert.equal((await api.raw("GET", `/api/projects/${other.id}/assets/${artifact.hash}`)).status, 403);
  assert.equal((await api.raw("GET", `/api/projects/${other.id}/assets/${"f".repeat(64)}`)).status, 403);
});

test("owner access requires a secret independently of loopback and rejects browser cross-origin requests", async (context) => {
  const api = await createHarness(context);
  assert.equal((await api.raw("GET", "/api/projects", undefined, { authorization: "" })).status, 403);
  assert.equal((await api.raw("POST", "/api/projects", { name: "Forbidden" }, { authorization: "" })).status, 403);
  const project = await api.createProject("Authorized");
  for (const path of [
    `/api/projects/${project.id}`,
    `/api/projects/${project.id}/manufacturing/jobs/job/approve`,
    `/api/projects/${project.id}/manufacturing/jobs/job/submit`,
  ]) {
    assert.equal((await api.raw(path.endsWith(project.id) ? "GET" : "POST", path, undefined, { authorization: "" })).status, 403);
  }
  assert.equal((await api.raw("POST", "/api/projects", { name: "Forbidden" }, { origin: "https://example.org" })).status, 403);
  const unknownHostStatus = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(`${api.origin}/api/projects`, { headers: { host: "example.org", authorization: `Bearer ${ownerToken}` } }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.once("error", reject);
    request.end();
  });
  assert.equal(unknownHostStatus, 403);
  assert.equal((await api.raw("POST", "/api/projects", '{"name":"Forbidden"}', { "content-type": "text/plain" })).status, 415);
  assert.equal((await api.raw("GET", "/api/projects")).status, 200);
});

test("owner browser session is scoped to the service origin", async (context) => {
  const api = await createHarness(context);
  const exchange = await api.raw("POST", "/api/owner/session", { token: ownerToken }, { authorization: "", origin: api.origin });
  assert.equal(exchange.status, 200);
  const cookie = exchange.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  assert.equal((await api.raw("GET", "/api/projects", undefined, { authorization: "", cookie })).status, 200);
  assert.equal((await api.raw("POST", "/api/projects", { name: "No origin" }, { authorization: "", cookie })).status, 403);
  assert.equal((await api.raw("POST", "/api/projects", { name: "Owner" }, { authorization: "", cookie, origin: api.origin })).status, 201);
});

test("an edit pairing cannot approve or submit a print job", async (context) => {
  const api = await createHarness(context);
  const project = await api.createProject("Paired");
  const token = api.pairing.issue(project.id, "edit", 60_000);
  const headers = { authorization: "", cookie: `workbench_session=${token.raw}`, origin: api.origin };
  for (const action of ["approve", "submit"]) {
    const response = await api.raw("POST", `/api/projects/${project.id}/manufacturing/jobs/job/${action}`, {}, headers);
    assert.equal(response.status, 403);
  }
});

test("accepts only loopback and private IPv4 client addresses", () => {
  assert.equal(isPrivateClientAddress("127.0.0.1"), true);
  assert.equal(isPrivateClientAddress("::1"), true);
  assert.equal(isPrivateClientAddress("::ffff:10.34.10.22"), true);
  assert.equal(isPrivateClientAddress("192.168.1.25"), true);
  assert.equal(isPrivateClientAddress("8.8.8.8"), false);
  assert.equal(isPrivateClientAddress("2001:4860:4860::8888"), false);
});

test("validates private binding and a safe projects root", () => {
  assert.throws(
    () => resolveWorkbenchConfig({ env: { WORKBENCH_HOST: "8.8.8.8" }, args: [], cwd: tmpdir(), home: homedir() }),
    /private IPv4/i,
  );
  assert.throws(
    () => resolveWorkbenchConfig({ env: { WORKBENCH_PROJECTS_ROOT: homedir() }, args: [], cwd: tmpdir(), home: homedir() }),
    /projects root/i,
  );
  const config = resolveWorkbenchConfig({
    env: { WORKBENCH_HOST: "192.168.1.20", WORKBENCH_PORT: "4317" },
    args: [],
    cwd: tmpdir(),
    home: homedir(),
  });
  assert.equal(config.host, "192.168.1.20");
  assert.equal(config.port, 4317);
});
