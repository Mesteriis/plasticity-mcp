# Plasticity Workbench Core and 3D Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a persistent local Workbench where the user can continue a Codex task, publish Plasticity model versions, inspect a STEP-derived 3D representation, edit structured dimension tables, and submit stylus annotations from a tablet on the same LAN.

**Architecture:** Add a `workbench/` npm workspace containing a Node.js server, a React browser client, and a small stdio MCP adapter. The server owns SQLite metadata and content-addressed project files, talks to `codex app-server` through its stdio JSON-RPC protocol, and exposes HTTP plus WebSocket only on the selected LAN interface. The browser tessellates immutable STEP versions with OpenCascade WASM for display; exact measurements remain native Plasticity data published through MCP.

**Tech Stack:** Node.js 24, TypeScript 5.9, React 19.3, Vite 8.3, Three.js 0.186, occt-import-js 0.0.23, `node:sqlite`, ws 8.21, zod 4.6, Vitest 5, Testing Library 16, Playwright 1.63

**Spec:** `docs/superpowers/specs/2026-09-20-plasticity-workbench-platform-design.md`

## Global Constraints

- Support macOS on Apple Silicon with Plasticity 26.1.3 and Node.js 24.
- Plasticity and Codex app-server remain loopback-only; only Workbench binds to one private LAN address.
- Exact dimensions come from Plasticity native B-Rep and carry `measurementSource: "native-brep"`.
- STEP tessellation and all browser measurements carry `measurementSource: "display-mesh"` and cannot satisfy exact validation.
- Project mutations use an expected project revision and reject stale clients.
- Model versions and artifact files are immutable and addressed by SHA-256.
- No HTTP request accepts an arbitrary filesystem path.
- Tablet editing requires a short-lived project token with an explicit role.
- This plan does not start slicers or printers.
- `codex app-server` is experimental and all protocol details stay inside `workbench/src/server/codex/`.
- Existing Plasticity MCP behavior, public tool names, native history, and no-overwrite semantics remain compatible.

## Review Focus

- Two browser clients submit against the same project revision: the second stale write must return HTTP 409 and preserve its payload for resubmission; Task 3 tests this.
- A paired tablet requests an asset from another project: the server must return HTTP 403 without revealing whether the hash exists; Task 4 tests this.
- Codex app-server exits during an active turn: the UI must receive a failed turn event and the bridge must not silently submit the same message again; Task 5 tests this.
- A STEP file fails to tessellate or exhausts the configured byte limit: the viewer must keep the previous version visible and show a bounded error; Task 8 tests this.
- Plasticity changes after a model version is captured: annotations stay attached to the immutable captured version and are not applied to the new revision without remapping; Task 9 tests this.

---

## Planned file structure

```text
workbench/
├── package.json                    # Workbench scripts and pinned dependencies
├── tsconfig.server.json            # Node server and MCP compilation
├── tsconfig.web.json               # Browser compilation
├── vite.config.ts                  # Browser build and development proxy
├── playwright.config.ts            # Browser acceptance configuration
├── index.html
├── src/
│   ├── shared/
│   │   ├── contracts.ts            # Stable project, artifact, event, and API types
│   │   └── schemas.ts              # Zod validation for network boundaries
│   ├── server/
│   │   ├── main.ts                 # Workbench process composition and shutdown
│   │   ├── config.ts               # LAN binding and project-root validation
│   │   ├── database.ts             # SQLite migrations and transactions
│   │   ├── project-store.ts        # Projects, revisions, blocks, and versions
│   │   ├── artifact-store.ts       # Content-addressed immutable files
│   │   ├── pairing.ts              # Expiring role tokens
│   │   ├── event-hub.ts            # Project-scoped WebSocket fan-out
│   │   ├── http-server.ts           # HTTP routes and static application
│   │   ├── codex/
│   │   │   ├── protocol.ts         # Narrow app-server request/event types
│   │   │   ├── json-rpc.ts         # Line-framed JSON-RPC transport
│   │   │   └── client.ts           # Process, initialize, thread, turn lifecycle
│   │   └── mcp/
│   │       ├── server.ts           # Workbench MCP tools
│   │       └── client.ts           # HTTP client used by the stdio adapter
│   └── web/
│       ├── main.tsx                # React entry
│       ├── app.tsx                 # Project workspace shell
│       ├── api.ts                  # Typed HTTP/WebSocket client
│       ├── state.ts                # Revision-aware reducer
│       ├── styles.css              # Desktop and tablet layout
│       ├── chat/                    # Codex stream and structured blocks
│       ├── model/                   # STEP worker, Three.js scene, picking
│       └── annotations/             # Stylus capture and batch review
└── test/
    ├── server/                      # Node and SQLite integration tests
    ├── web/                         # Vitest component tests
    └── e2e/                         # Playwright desktop/tablet flows
```

### Task 1: Workspace scaffold and shared contracts

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `workbench/package.json`
- Create: `workbench/tsconfig.server.json`
- Create: `workbench/tsconfig.web.json`
- Create: `workbench/vite.config.ts`
- Create: `workbench/index.html`
- Create: `workbench/src/shared/contracts.ts`
- Create: `workbench/src/shared/schemas.ts`
- Test: `workbench/test/shared/contracts.test.ts`

**Interfaces:**
- Consumes: existing Node.js 24 root project and Zod 4.6 dependency.
- Produces: `Project`, `ModelVersion`, `Artifact`, `StructuredBlock`, `Annotation`, `WorkbenchEvent`, and matching Zod schemas used by every later task.

- [ ] **Step 1: Add a failing schema test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { annotationBatchSchema, modelVersionInputSchema } from "../../src/shared/schemas.ts";

test("rejects an annotation without an immutable model version", () => {
  assert.equal(annotationBatchSchema.safeParse({ projectRevision: 4, annotations: [{ text: "move this" }] }).success, false);
});

test("distinguishes native measurements from display meshes", () => {
  const parsed = modelVersionInputSchema.parse({
    plasticityDocumentToken: "doc-1",
    plasticityRevision: "doc-1|8|3|0|21:55",
    stepArtifactHash: "a".repeat(64),
    measurements: [{ key: "width", label: "Width", value: 80, unit: "mm", source: "native-brep", status: "verified" }],
  });
  assert.equal(parsed.measurements[0]?.source, "native-brep");
});
```

- [ ] **Step 2: Run the focused test and verify the missing-module failure**

Run: `node --test workbench/test/shared/contracts.test.ts`

Expected: FAIL because `workbench/src/shared/schemas.ts` does not exist.

- [ ] **Step 3: Add the npm workspace and pinned dependencies**

Set root `workspaces` to `["workbench"]`. Create `workbench/package.json` with scripts `dev`, `build`, `typecheck`, `test`, `test:e2e`, `start`, and `mcp`, and pin:

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.30.0",
    "occt-import-js": "0.0.23",
    "qrcode": "1.5.4",
    "react": "19.3.0",
    "react-dom": "19.3.0",
    "three": "0.186.0",
    "ws": "8.21.3",
    "zod": "4.6.5"
  },
  "devDependencies": {
    "@testing-library/react": "16.3.3",
    "@types/node": "24.13.6",
    "@types/qrcode": "1.5.6",
    "@types/react": "19.3.0",
    "@types/react-dom": "19.3.0",
    "@types/three": "0.186.0",
    "@types/ws": "8.18.1",
    "@vitejs/plugin-react": "6.1.1",
    "jsdom": "30.1.0",
    "playwright": "1.63.0",
    "typescript": "5.9.3",
    "vite": "8.3.0",
    "vitest": "5.0.1"
  }
}
```

- [ ] **Step 4: Define stable contracts and strict schemas**

Use UUID strings for record IDs, integer monotonic project revisions, SHA-256 lowercase hex strings for artifacts, millimetres for lengths, and ISO timestamps. Define annotation anchors as this discriminated union:

```ts
export type AnnotationAnchor =
  | { kind: "world"; pointMm: [number, number, number] }
  | { kind: "body"; bodyId: number; pointMm: [number, number, number] }
  | { kind: "face"; bodyId: number; faceId: string; pointMm: [number, number, number] }
  | { kind: "edge"; bodyId: number; edgeId: string; pointMm: [number, number, number] }
  | { kind: "screen"; cameraId: string; point: [number, number] };

export type MeasurementSource = "native-brep" | "display-mesh" | "reference-document" | "user" | "assumption";
export type Confidence = "verified" | "probable" | "approximate" | "assumed" | "measurement-required";
```

`StructuredBlock` must be a discriminated union for `dimensions`, `requirements`, `assumptions`, `sources`, `validation`, and `comparison`. Do not use an untyped JSON payload for these blocks.

- [ ] **Step 5: Run contract tests and both type checks**

Run: `node --test workbench/test/shared/contracts.test.ts && npm run typecheck && npm --workspace workbench run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit the scaffold**

```bash
git add package.json package-lock.json workbench
git commit -m "build: scaffold Plasticity Workbench"
```

### Task 2: SQLite project store and immutable artifact store

**Files:**
- Create: `workbench/src/server/database.ts`
- Create: `workbench/src/server/project-store.ts`
- Create: `workbench/src/server/artifact-store.ts`
- Test: `workbench/test/server/project-store.test.ts`
- Test: `workbench/test/server/artifact-store.test.ts`

**Interfaces:**
- Consumes: shared contracts and schemas from Task 1.
- Produces: `openDatabase(path)`, `ProjectStore`, and `ArtifactStore` with restart-safe transactions.

- [ ] **Step 1: Write failing persistence and content-addressing tests**

```ts
test("persists the project and monotonically increments its revision", async () => {
  const first = await harness.createProject("Fold stand");
  const changed = await harness.projects.addStructuredBlock(first.id, 0, dimensionsBlock);
  assert.equal(changed.revision, 1);
  harness.reopen();
  assert.equal((await harness.projects.get(first.id))?.revision, 1);
});

test("stores identical bytes once and rejects an incorrect claimed hash", async () => {
  const a = await harness.artifacts.put(Buffer.from("step"), { mediaType: "model/step", originalName: "a.step" });
  const b = await harness.artifacts.put(Buffer.from("step"), { mediaType: "model/step", originalName: "b.step" });
  assert.equal(a.hash, b.hash);
  await assert.rejects(() => harness.artifacts.open("f".repeat(64)), /not found/i);
});
```

- [ ] **Step 2: Run the tests and verify missing implementations**

Run: `node --test workbench/test/server/project-store.test.ts workbench/test/server/artifact-store.test.ts`

Expected: FAIL because the stores do not exist.

- [ ] **Step 3: Implement forward-only SQLite migrations**

Use `DatabaseSync` from `node:sqlite`, enable WAL and foreign keys, and create tables for `projects`, `artifacts`, `model_versions`, `structured_blocks`, `annotations`, `pairing_tokens`, and `event_log`. Store the schema version in `pragma user_version`. Wrap every project mutation in `BEGIN IMMEDIATE`, compare `expected_revision`, then increment exactly once.

Expose:

```ts
export interface ProjectStore {
  create(name: string, workspacePath: string): Project;
  get(projectId: string): Project | undefined;
  list(): Project[];
  bindCodexThread(projectId: string, expectedRevision: number, threadId: string): Project;
  addModelVersion(projectId: string, expectedRevision: number, input: ModelVersionInput): ModelVersion;
  addStructuredBlock(projectId: string, expectedRevision: number, block: StructuredBlockInput): StructuredBlock;
  addAnnotationBatch(projectId: string, expectedRevision: number, input: AnnotationBatchInput): Annotation[];
  eventsAfter(projectId: string, sequence: number): WorkbenchEvent[];
}
```

- [ ] **Step 4: Implement hash-first atomic artifact writes**

Stream into a file inside the artifact root, calculate SHA-256 while writing, `fsync`, then link or rename to `<root>/<first-two>/<hash>`. If that hash already exists, discard only the private staging file. Validate names for display but never derive storage paths from them. Enforce a configurable 250 MiB upload limit.

- [ ] **Step 5: Run store tests, restart tests, and type checking**

Run: `node --test workbench/test/server/project-store.test.ts workbench/test/server/artifact-store.test.ts && npm --workspace workbench run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit persistent storage**

```bash
git add workbench/src/server workbench/test/server
git commit -m "feat: persist Workbench projects and artifacts"
```

### Task 3: Revision-aware HTTP API

**Files:**
- Create: `workbench/src/server/config.ts`
- Create: `workbench/src/server/http-server.ts`
- Create: `workbench/src/server/main.ts`
- Test: `workbench/test/server/http-server.test.ts`

**Interfaces:**
- Consumes: `ProjectStore`, `ArtifactStore`, and shared schemas.
- Produces: `createWorkbenchServer(dependencies)`, project CRUD, asset upload/download, structured-block, model-version, and annotation routes.

- [ ] **Step 1: Write failing API tests for revision conflict and path isolation**

```ts
test("returns 409 and the current revision for a stale mutation", async () => {
  const project = await api.createProject("Bracket");
  await api.addBlock(project.id, 0, requirementsBlock);
  const response = await api.raw("POST", `/api/projects/${project.id}/blocks`, { expectedRevision: 0, block: assumptionsBlock });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).currentRevision, 1);
});

test("never accepts a caller supplied asset path", async () => {
  const response = await api.raw("POST", "/api/assets", { path: "/etc/passwd" });
  assert.equal(response.status, 400);
});
```

- [ ] **Step 2: Run the focused API test**

Run: `node --test workbench/test/server/http-server.test.ts`

Expected: FAIL because the HTTP server does not exist.

- [ ] **Step 3: Implement JSON and streaming routes**

Implement these routes with Zod validation and a uniform `{ error: { code, message } }` response:

```text
GET    /api/health
GET    /api/projects
POST   /api/projects
GET    /api/projects/:projectId
POST   /api/projects/:projectId/blocks
POST   /api/projects/:projectId/versions
POST   /api/projects/:projectId/annotations
POST   /api/projects/:projectId/assets
GET    /api/projects/:projectId/assets/:hash
GET    /api/projects/:projectId/events?after=<sequence>
```

Asset download first proves that the requested project references the hash.
Return 403 for both an unrelated valid hash and an unknown hash so the route
does not reveal global artifact existence.

- [ ] **Step 4: Validate LAN configuration**

Accept `WORKBENCH_HOST` only when it is loopback or an RFC1918 IPv4 address. Default to loopback until the user explicitly starts with `--lan`. Accept ports 1024 through 65535. Resolve `WORKBENCH_PROJECTS_ROOT` once at startup and refuse a filesystem root or home directory.

- [ ] **Step 5: Run API tests and the complete server test set**

Run: `node --test 'workbench/test/server/*.test.ts' && npm --workspace workbench run typecheck`

Expected: PASS, including the stale-write test from Review Focus.

- [ ] **Step 6: Commit the HTTP boundary**

```bash
git add workbench/src/server workbench/test/server
git commit -m "feat: expose revision-aware Workbench API"
```

### Task 4: LAN pairing and project event stream

**Files:**
- Create: `workbench/src/server/pairing.ts`
- Create: `workbench/src/server/event-hub.ts`
- Modify: `workbench/src/server/http-server.ts`
- Test: `workbench/test/server/pairing.test.ts`
- Test: `workbench/test/server/event-hub.test.ts`

**Interfaces:**
- Consumes: SQLite, project events, and HTTP server from Tasks 2–3.
- Produces: expiring `view | annotate | edit` tokens, QR pairing payloads, and `/api/projects/:id/events/ws`.

- [ ] **Step 1: Write failing token and cross-project authorization tests**

```ts
test("an annotate token cannot mutate structured blocks or read another project", async () => {
  const token = pairing.issue(projectA.id, "annotate", 15 * 60_000);
  assert.equal(pairing.authorize(token.raw, projectA.id, "annotate").role, "annotate");
  assert.throws(() => pairing.authorize(token.raw, projectA.id, "edit"), /permission/i);
  assert.throws(() => pairing.authorize(token.raw, projectB.id, "view"), /permission/i);
});

test("expires and revokes tokens", () => {
  const token = pairing.issue(projectA.id, "view", 1_000, now);
  assert.throws(() => pairing.authorize(token.raw, projectA.id, "view", now + 1_001), /expired/i);
});
```

- [ ] **Step 2: Run pairing tests and verify failure**

Run: `node --test workbench/test/server/pairing.test.ts workbench/test/server/event-hub.test.ts`

Expected: FAIL because pairing and event streaming are absent.

- [ ] **Step 3: Store only token hashes and enforce roles**

Generate 32 random bytes, return base64url to the issuer once, and store only SHA-256 with project ID, role, expiry, and revocation timestamp. Use `timingSafeEqual` on equal-length hash buffers. An `annotate` token can create annotation batches; only `edit` can submit chat, tables, or modeling actions.

- [ ] **Step 4: Implement resumable WebSocket events**

Require project token authentication during upgrade. The first client frame is `{ "type": "resume", "after": number }`. Replay persisted events after that sequence, then subscribe to live events. Send a heartbeat every 20 seconds and close clients that miss two heartbeats. Cap each serialized event at 1 MiB; large data remains an artifact reference.

- [ ] **Step 5: Add QR payload generation**

Return only a plain LAN URL containing the one-time pairing code:

```text
http://192.168.1.25:4317/pair?code=<base64url>
```

After exchange, remove the code from browser history with `history.replaceState` and use an HttpOnly, SameSite=Strict project cookie.

- [ ] **Step 6: Run security and reconnect tests**

Run: `node --test workbench/test/server/pairing.test.ts workbench/test/server/event-hub.test.ts workbench/test/server/http-server.test.ts`

Expected: PASS, including cross-project asset denial and event replay after reconnect.

- [ ] **Step 7: Commit LAN collaboration**

```bash
git add workbench/src/server workbench/test/server
git commit -m "feat: add LAN pairing and project events"
```

### Task 5: Codex app-server bridge

**Files:**
- Create: `workbench/src/server/codex/protocol.ts`
- Create: `workbench/src/server/codex/json-rpc.ts`
- Create: `workbench/src/server/codex/client.ts`
- Create: `workbench/test/fixtures/fake-codex-app-server.ts`
- Test: `workbench/test/server/codex-client.test.ts`

**Interfaces:**
- Consumes: local `codex` executable and Workbench event sink.
- Produces: `CodexClient.start()`, `startThread()`, `resumeThread()`, `startTurn()`, `respondToApproval()`, and streamed normalized `CodexEvent` values.

- [ ] **Step 1: Write a failing process/JSON-RPC lifecycle test**

```ts
test("initializes, starts one turn, and reports a child crash without retry", async () => {
  const client = await CodexClient.start({ executable: process.execPath, args: [fakeServerPath, "--crash-after-turn"] });
  const thread = await client.startThread({ cwd: fixtureWorkspace });
  const turn = await client.startTurn(thread.id, [{ type: "text", text: "build a bracket" }]);
  await assert.rejects(() => turn.completed, /app-server exited/i);
  assert.equal(fakeServer.receivedMethods.filter((name) => name === "turn/start").length, 1);
});
```

- [ ] **Step 2: Run the focused bridge test**

Run: `node --test workbench/test/server/codex-client.test.ts`

Expected: FAIL because the bridge does not exist.

- [ ] **Step 3: Implement strict newline-framed JSON-RPC**

Spawn `codex app-server --stdio` with inherited authentication environment and a minimal environment allowlist. Parse one JSON object per line, bound an unread line to 8 MiB, correlate numeric request IDs, and normalize server notifications. Treat non-JSON stdout, premature exit, duplicate response IDs, and schema mismatch as protocol errors.

Initialize with:

```ts
await rpc.request("initialize", {
  clientInfo: { name: "plasticity-workbench", title: "Plasticity Workbench", version: "0.1.0" },
  capabilities: { experimentalApi: true },
});
rpc.notify("initialized", {});
```

- [ ] **Step 4: Implement only verified thread and turn methods**

Use `thread/start` with the project directory as `cwd`, `thread/resume` with the stored `threadId`, and `turn/start` with typed text and local-image inputs. Keep approval policy controlled by Codex configuration. Forward approval requests to Workbench and send the corresponding protocol response only after a user action.

- [ ] **Step 5: Prevent implicit turn replay**

Assign every submitted UI message a UUID `clientUserMessageId`, persist `turn_requested` before calling app-server, and persist the returned turn ID. On app-server exit, mark the turn failed. A user can explicitly resubmit the message, producing a new UUID; startup recovery never resends it.

- [ ] **Step 6: Run bridge tests and protocol-version failure tests**

Run: `node --test workbench/test/server/codex-client.test.ts && npm --workspace workbench run typecheck`

Expected: PASS, including the no-retry crash case from Review Focus.

- [ ] **Step 7: Commit the isolated Codex adapter**

```bash
git add workbench/src/server/codex workbench/test/fixtures workbench/test/server/codex-client.test.ts
git commit -m "feat: bridge Workbench to Codex app-server"
```

### Task 6: Workbench MCP publishing tools

**Files:**
- Create: `workbench/src/server/mcp/client.ts`
- Create: `workbench/src/server/mcp/server.ts`
- Create: `workbench/scripts/run-mcp.ts`
- Modify: `workbench/package.json`
- Test: `workbench/test/server/mcp-server.test.ts`

**Interfaces:**
- Consumes: Workbench HTTP API.
- Produces: stdio tools `workbench_project_status`, `workbench_publish_model_version`, `workbench_publish_structured_block`, `workbench_publish_status`, `workbench_get_feedback`, and `workbench_wait_for_feedback`.

- [ ] **Step 1: Write failing MCP initialize/list/call tests**

```ts
test("publishes a native-measurement table and returns the new project revision", async () => {
  const response = await mcp.callTool("workbench_publish_structured_block", {
    projectId,
    expectedRevision: 0,
    block: dimensionsBlock,
  });
  assert.match(responseText(response), /"revision": 1/);
});
```

- [ ] **Step 2: Run the MCP test and verify failure**

Run: `node --test workbench/test/server/mcp-server.test.ts`

Expected: FAIL because the Workbench MCP server does not exist.

- [ ] **Step 3: Register narrow schema-driven tools**

All publish tools take `projectId` and `expectedRevision`. `workbench_publish_model_version` accepts only hashes already uploaded into that project plus Plasticity document/revision identity and native measurements. Feedback tools are read-only. `workbench_wait_for_feedback` accepts 0–30 seconds and returns immediately when a pending annotation batch exists.

- [ ] **Step 4: Add an MCP prompt for the review cycle**

Register `plasticity_workbench_review` instructing Codex to export a new STEP file through Plasticity MCP, upload it as a Workbench artifact, publish native measurements and the model version, then wait for a submitted feedback batch before changing geometry.

- [ ] **Step 5: Run MCP protocol and stale-revision tests**

Run: `node --test workbench/test/server/mcp-server.test.ts && npm --workspace workbench run typecheck`

Expected: PASS. A stale publish returns a structured conflict instead of overwriting the project.

- [ ] **Step 6: Commit Workbench MCP tools**

```bash
git add workbench/src/server/mcp workbench/scripts workbench/package.json workbench/test/server/mcp-server.test.ts
git commit -m "feat: publish Workbench review artifacts through MCP"
```

### Task 7: Browser workspace, Codex chat, and structured blocks

**Files:**
- Create: `workbench/src/web/main.tsx`
- Create: `workbench/src/web/app.tsx`
- Create: `workbench/src/web/api.ts`
- Create: `workbench/src/web/state.ts`
- Create: `workbench/src/web/styles.css`
- Create: `workbench/src/web/chat/chat-panel.tsx`
- Create: `workbench/src/web/chat/structured-block.tsx`
- Test: `workbench/test/web/state.test.ts`
- Test: `workbench/test/web/structured-block.test.tsx`

**Interfaces:**
- Consumes: HTTP API, project events, and shared contracts.
- Produces: responsive project shell, live Codex transcript, editable structured tables, and batched submission.

- [ ] **Step 1: Write reducer and table interaction tests**

```tsx
it("batches edited dimension cells without changing the accepted table", async () => {
  render(<StructuredBlockView block={dimensionsBlock} onSubmit={submit} />);
  await user.clear(screen.getByLabelText("Overall width"));
  await user.type(screen.getByLabelText("Overall width"), "82");
  expect(submit).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Передать изменения агенту" }));
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ changes: [{ key: "width", value: 82 }] }));
});
```

- [ ] **Step 2: Run browser unit tests and verify failure**

Run: `npm --workspace workbench test -- --run workbench/test/web/state.test.ts workbench/test/web/structured-block.test.tsx`

Expected: FAIL because the React application does not exist.

- [ ] **Step 3: Implement the revision-aware client reducer**

The reducer accepts snapshots and strictly increasing event sequences. On a sequence gap it stops applying events and refetches the project. Preserve unsent drafts across refetch. A 409 response displays the changed server values beside the draft and offers resubmission against the new revision.

- [ ] **Step 4: Implement the three-pane responsive shell**

Desktop uses project navigation, model area, and Codex panel. Tablet collapses navigation into a drawer, keeps the model full-width, and presents chat/blocks as a bottom sheet. Touch targets are at least 44 CSS pixels. Use Russian UI copy initially and keep labels in one typed dictionary for later localization.

- [ ] **Step 5: Render streamed Codex activity and structured blocks**

Show user and assistant messages, current turn status, MCP tool name/status, and approval cards. Render each `StructuredBlock` through an exhaustive switch. Tables support row-to-geometry selection events and local cell drafts; only the explicit batch button sends edits.

- [ ] **Step 6: Run component tests and a production build**

Run: `npm --workspace workbench test -- --run && npm --workspace workbench run build`

Expected: PASS and Vite emits the production application without type errors.

- [ ] **Step 7: Commit the browser workspace**

```bash
git add workbench/src/web workbench/test/web workbench/index.html workbench/vite.config.ts
git commit -m "feat: add Workbench chat and structured review UI"
```

### Task 8: STEP-derived interactive 3D viewer

**Files:**
- Create: `workbench/src/web/model/step-worker.ts`
- Create: `workbench/src/web/model/model-viewer.tsx`
- Create: `workbench/src/web/model/model-scene.ts`
- Create: `workbench/src/web/model/picking.ts`
- Create: `workbench/src/web/model/section-plane.ts`
- Test: `workbench/test/web/model-scene.test.ts`
- Test: `workbench/test/web/model-viewer.test.tsx`

**Interfaces:**
- Consumes: immutable STEP artifact and model-version metadata.
- Produces: Three.js scene with bodies, face ranges, selection events, visibility, orthographic views, section plane, and explicit display-mesh labels.

- [ ] **Step 1: Write failing mesh conversion and previous-version retention tests**

```ts
it("maps OpenCascade face triangle ranges into pickable groups", () => {
  const scene = buildSceneFromOcct(occtCubeResult, modelVersion);
  expect(scene.bodies[0]?.mesh.geometry.groups).toEqual([
    expect.objectContaining({ materialIndex: 0 }),
    expect.objectContaining({ materialIndex: 1 }),
  ]);
});

it("keeps the current model when the next STEP conversion fails", async () => {
  render(<ModelViewer initial={goodVersion} importer={rejectingImporter} />);
  await selectVersion(badVersion);
  expect(screen.getByText(/не удалось подготовить 3D-представление/i)).toBeVisible();
  expect(canvasBodyNames()).toContain("Bracket");
});
```

- [ ] **Step 2: Run viewer tests and verify failure**

Run: `npm --workspace workbench test -- --run workbench/test/web/model-scene.test.ts workbench/test/web/model-viewer.test.tsx`

Expected: FAIL because model modules do not exist.

- [ ] **Step 3: Tessellate STEP in a dedicated worker**

Load `occt-import-js.wasm` in a Web Worker. Call `ReadStepFile(bytes, { linearUnit: "millimeter", linearDeflectionType: "absolute_value", linearDeflection: 0.05, angularDeflection: 0.5 })`. Reject input above the server limit, `success: false`, non-finite vertices, invalid indices, or more than ten million triangles. Transfer typed arrays back without cloning.

- [ ] **Step 4: Build the Three.js scene and face groups**

Create one `BufferGeometry` per OpenCascade mesh, convert `brep_faces` triangle ranges into geometry groups, preserve body names, compute bounds for camera fitting, and attach `modelVersionId`, body index, and face index to pick results. Label all cursor distances and bounds as approximate display-mesh values.

- [ ] **Step 5: Add review controls**

Implement orbit, pan, orthographic/perspective toggle, standard views, fit all, fit selection, body tree, hide/isolate, opacity, edges, and one draggable section plane. Dispose geometries, materials, and workers when changing project.

- [ ] **Step 6: Run unit tests, build, and a real STEP smoke check**

Run: `npm --workspace workbench test -- --run && npm --workspace workbench run build`

Then export a fresh STEP from the current Plasticity test document, publish it to a temporary Workbench project, and verify in the browser that body count and millimetre bounds agree with the published native metadata. Record both values; do not use the display mesh as the exact acceptance source.

Expected: automated checks PASS; live viewer opens the STEP and shows the same body count with display bounds within 0.1 mm of native bounds.

- [ ] **Step 7: Commit interactive model review**

```bash
git add workbench/src/web/model workbench/test/web
git commit -m "feat: add STEP-based Workbench model viewer"
```

### Task 9: Geometry-linked stylus annotations and batched feedback

**Files:**
- Create: `workbench/src/web/annotations/annotation-layer.tsx`
- Create: `workbench/src/web/annotations/stroke.ts`
- Create: `workbench/src/web/annotations/annotation-panel.tsx`
- Modify: `workbench/src/web/model/model-viewer.tsx`
- Modify: `workbench/src/web/app.tsx`
- Test: `workbench/test/web/stroke.test.ts`
- Test: `workbench/test/web/annotation-layer.test.tsx`
- Test: `workbench/test/server/project-store.test.ts`

**Interfaces:**
- Consumes: model picks, camera state, annotation HTTP route, and project revision.
- Produces: pressure-aware strokes, markers, text/dimension notes, immutable-version anchors, and one submitted feedback batch.

- [ ] **Step 1: Write failing pointer and stale-version tests**

```ts
it("records a pen stroke with pressure and its immutable camera", () => {
  const stroke = reducePointerEvents(camera, [
    pointer("pointerdown", 10, 20, 0.3),
    pointer("pointermove", 15, 24, 0.7),
    pointer("pointerup", 18, 30, 0.5),
  ]);
  expect(stroke.points.map((point) => point.pressure)).toEqual([0.3, 0.7, 0.5]);
  expect(stroke.camera).toEqual(camera);
});

test("keeps stale feedback attached to its captured version", () => {
  const annotations = store.addAnnotationBatch(projectId, revisionAfterV2, {
    modelVersionId: v1.id,
    annotations: [faceNoteV1],
  });
  assert.equal(annotations[0]?.modelVersionId, v1.id);
  assert.equal(annotations[0]?.remapStatus, "required");
});
```

- [ ] **Step 2: Run annotation tests and verify failure**

Run: `npm --workspace workbench test -- --run workbench/test/web/stroke.test.ts workbench/test/web/annotation-layer.test.tsx && node --test workbench/test/server/project-store.test.ts`

Expected: FAIL because annotation capture and remap status are absent.

- [ ] **Step 3: Implement stylus capture without blocking navigation**

Use Pointer Events and enable ink only while the annotation tool is active. Capture pointer ID, pressure, tilt, timestamp, and normalized screen coordinates. Simplify completed strokes with a fixed 0.75 CSS-pixel tolerance while retaining endpoints. Store the exact view/projection matrices and viewport size.

- [ ] **Step 4: Add 3D anchors and explicit ambiguity**

Raycast the first stroke point or marker into the displayed face group and store body/face indices, world-space point in millimetres, and Plasticity body/face IDs when the published mapping provides them. If mapping is unavailable, store `kind: "world"`; never invent a Plasticity face ID.

- [ ] **Step 5: Implement markers, text, dimensions, and batch submission**

Provide pen, highlighter, arrow, marker, eraser, text note, and dimension-request tools. Collect all new annotations and structured-table edits in a review tray. `Передать изменения агенту` posts one batch with the current project revision and target model version.

- [ ] **Step 6: Handle version changes and tablet reconnection**

When a newer model arrives, keep old annotations visible only in version comparison. Mark face/edge annotations `required` until a later semantic mapper resolves them. Persist unsent annotations in IndexedDB using project and model version IDs, and resubmit only after the user presses the batch button.

- [ ] **Step 7: Run annotation, stale-revision, and production-build checks**

Run: `npm --workspace workbench test -- --run && node --test 'workbench/test/server/*.test.ts' && npm --workspace workbench run build`

Expected: PASS, including immutable stale-version behavior from Review Focus.

- [ ] **Step 8: Commit stylus review**

```bash
git add workbench/src/web workbench/test
git commit -m "feat: add geometry-linked Workbench annotations"
```

### Task 10: End-to-end desktop/tablet workflow and operating documentation

**Files:**
- Create: `workbench/playwright.config.ts`
- Create: `workbench/test/e2e/workbench-review.spec.ts`
- Create: `scripts/start-workbench.ts`
- Modify: `package.json`
- Modify: `README.md`
- Create: `docs/workbench-operations.md`
- Modify: `docs/native-access-report.md`

**Interfaces:**
- Consumes: all previous Workbench components and the existing Plasticity MCP.
- Produces: supported startup commands, Codex MCP registration instructions, browser acceptance evidence, and recovery procedures.

- [ ] **Step 1: Write the failing browser acceptance test**

```ts
test("reviews one model from desktop and tablet viewports", async ({ browser }) => {
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const tablet = await browser.newPage({ viewport: { width: 1024, height: 1366 }, hasTouch: true });
  const project = await createProjectThroughUi(desktop, "K1C bracket");
  await publishFixtureVersion(project.id);
  await expect(desktop.getByText("80,00 мм")).toBeVisible();
  const pairingUrl = await issuePairingUrl(desktop, "annotate");
  await tablet.goto(pairingUrl);
  await addMarkerAndComment(tablet, "Увеличить радиус здесь");
  await tablet.getByRole("button", { name: "Передать изменения агенту" }).click();
  await expect(desktop.getByText("Увеличить радиус здесь")).toBeVisible();
});
```

- [ ] **Step 2: Run Playwright and verify the missing-flow failure**

Run: `npm --workspace workbench run test:e2e`

Expected: FAIL until the composed start script and browser flow are complete.

- [ ] **Step 3: Add one-command startup and clean shutdown**

`npm run start:workbench -- --lan` selects the first active private IPv4 interface, starts Workbench, spawns Codex app-server on stdio, prints the URL, and writes a QR PNG under the runtime directory. SIGINT and SIGTERM stop accepting requests, close WebSockets, interrupt the active Codex child once, checkpoint SQLite, and remove only the current runtime marker.

- [ ] **Step 4: Document installation and recovery**

Document:

```sh
npm install
npm run start:plasticity
npm run start:workbench -- --lan
codex mcp add plasticity-workbench -- npm --prefix ./workbench run mcp
```

Explain pairing roles, project locations, Codex thread binding, STEP display limitations, stale edits, app-server restart, Plasticity reconciliation, database backup, and how to revoke a tablet.

- [ ] **Step 5: Run automated completion gates**

Run:

```sh
npm test
npm run typecheck
npm --workspace workbench test -- --run
npm --workspace workbench run typecheck
npm --workspace workbench run build
npm --workspace workbench run test:e2e
npm audit --omit=dev
```

Expected: every command exits 0; report the exact test counts and audit result.

- [ ] **Step 6: Run live Plasticity and LAN acceptance**

Use the current 80 × 40 × 8 mm plate or create a fresh disposable part. Export STEP and publish one version with native dimensions. Verify on the Mac and a tablet connected to the same Wi-Fi:

1. Both clients open the same project by IP and port.
2. The tablet has annotate permission and cannot edit project settings.
3. Both clients see the model and native dimension table.
4. A tablet marker appears on the Mac without reload.
5. A submitted annotation reaches the project-bound Codex task.
6. Codex publishes a second version after a Plasticity edit.
7. The first annotation remains on version one and is marked for remapping.
8. Restarting Workbench restores both versions and the feedback batch.

Expected: all eight checks pass. Record the URL with its token removed, software versions, model version IDs, Plasticity revision IDs, and screenshots in `docs/native-access-report.md`.

- [ ] **Step 7: Review dependency licenses**

Record that `occt-import-js` is LGPL-2.1 and preserve its license and replacement mechanism in any distributed bundle. Confirm that browser assets include the required notices. Run `npm audit` with development dependencies as an additional informational check and triage any finding before release.

- [ ] **Step 8: Commit the first Workbench release**

```bash
git add package.json package-lock.json scripts/start-workbench.ts workbench README.md docs
git commit -m "feat: deliver Plasticity Workbench review workflow"
```

## Self-review results

- Spec coverage: this plan covers Workbench Core, Codex chat, structured blocks, STEP review, annotations, LAN tablet access, persistence, and recovery. Advanced Plasticity operations, reference search, manufacturing profiles, slicers, and printer control remain explicitly separate subproject plans.
- Placeholder scan: the plan contains no deferred implementation markers; every task names its files, interfaces, tests, commands, and expected behavior.
- Type consistency: project mutations consistently use `expectedRevision`; immutable files use `Artifact.hash`; annotations consistently target `modelVersionId`; Codex submission uses `clientUserMessageId`.
- Review Focus: revision conflicts map to Task 3, project isolation to Task 4, app-server failure to Task 5, STEP conversion failure to Task 8, and stale annotations to Task 9.
