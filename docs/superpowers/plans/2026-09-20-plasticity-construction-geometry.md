# Plasticity Construction Geometry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add exact datum points, datum axes, native saved construction planes, an active workplane, and plane-local curve creation to the Plasticity MCP on macOS with Plasticity 26.1.3.

**Architecture:** Keep `PlasticityOperations` as the server-facing facade. Put frame math and native construction-plane commands in `src/plasticity/construction.ts`, and keep document/revision-bound datum lifecycle in `src/plasticity/references.ts`. Extend runtime snapshots with normalized plane state and a separate view-state token so saved-plane changes invalidate geometry references while workplane activation does not.

**Tech Stack:** TypeScript 5.9, Node.js 24, official MCP TypeScript SDK 1.30, Zod 4, Electron CDP, Plasticity 26.1.3 native renderer bindings, Node built-in test runner.

**Spec:** [docs/superpowers/specs/2026-09-20-plasticity-construction-geometry-design.md](../specs/2026-09-20-plasticity-construction-geometry-design.md)

## Global Constraints

- Keep the CDP endpoint on `127.0.0.1`; do not modify Plasticity.app, its bytecode, or its signature.
- Public dimensions and coordinates remain millimetres; directions are unitless; public angles remain degrees.
- Do not expose arbitrary JavaScript or Plasticity object IDs through MCP.
- Use one serialized mutation path and the existing uncertain-outcome rule. Never retry a timed-out native command and never issue an automatic Undo.
- Treat point and axis datums as MCP session references. Claim native persistence only for construction planes actually read from `editor.planes`.
- Do not overwrite existing `.plasticity`, STEP, or diagnostic artifacts.
- Stop the milestone with a concrete native-access report if creation plus Undo/Redo cannot be proved in the disposable document.
- Make each task's commit only after its listed tests pass. Preserve unrelated working-tree changes.

## Review Focus

1. Reopened documents may reuse or reorder native plane IDs. Bind saved planes to the current document and normalized frame; never accept an ID from an earlier document merely because the string matches.
2. Active-workplane changes must update `viewStateToken` and change reporting without changing the B-Rep/saved-plane `revision`.
3. A document switch must clear the datum registry even when the new document contains identical body or plane IDs.
4. Reject zero-length, near-collinear, near-parallel, and non-coplanar inputs before any CDP call, using one documented tolerance.
5. If a plane command times out after commit, preserve the runtime's uncertain state. Reconciliation may report the observed plane, but no automatic retry or Undo is allowed.

---

## File Map

**Create**

- `src/plasticity/construction.ts` — vector/frame math, normalized plane descriptors, and native saved-plane/workplane adapter.
- `src/plasticity/construction.test.ts` — pure frame tests and adapter contract tests with a fake runtime.
- `src/plasticity/references.ts` — typed point/axis/plane definitions and session registry lifecycle.
- `src/plasticity/references.test.ts` — stale reference, refresh, and document replacement tests.
- `scripts/probe-construction.ts` — bounded diagnostic for the verified Plasticity 26.1.3 plane surfaces.
- `docs/construction-geometry-acceptance.md` — live evidence and support matrix for this milestone.

**Modify**

- `src/plasticity/runtime.ts` — read normalized standard/saved planes and active workplane; compute plane and view tokens.
- `src/plasticity/change-tracker.ts` — report saved-plane, active-workplane, and stale-datum changes.
- `src/plasticity/change-tracker.test.ts` — cover the expanded diff semantics.
- `src/plasticity/semantic.ts` — resolve face centers, edge midpoints/directions, planar faces, and cylindrical axes from current native state.
- `src/plasticity/semantic.test.ts` — cover unique, ambiguous, and unresolved resolution.
- `src/plasticity/operations.ts` — compose the construction adapter, expose facade methods, and transform local XY curves.
- `src/plasticity/operations.test.ts` — verify facade validation, conversions, and no-CDP-on-invalid behavior.
- `src/server.ts` — own the per-connection datum registry and register seven MCP tools plus optional curve-plane inputs.
- `src/server.test.ts` — verify MCP discovery, schemas, tool calls, journaling, and serialization.
- `package.json` — add the bounded live probe command.
- `README.md` — document supported commands, recovery, and a local-plane example.

## Task 1: Exact Frame Math and Shared Construction Types

**Files:**

- Create: `src/plasticity/construction.ts`
- Create: `src/plasticity/construction.test.ts`

- [ ] **Step 1: Write failing tests for vector normalization and explicit frames**

Add tests that prove:

```ts
const frame = frameFromOriginNormalX([10, 20, 30], [0, 0, 5], [2, 0, 1]);
assert.deepEqual(frame.originMm, [10, 20, 30]);
assertVectorClose(frame.normal, [0, 0, 1]);
assertVectorClose(frame.xDirection, [1, 0, 0]);
assertVectorClose(frame.yDirection, [0, 1, 0]);
assert.ok(dot(cross(frame.xDirection, frame.yDirection), frame.normal) > 0.999999);
```

Cover zero normals, an x direction parallel to the normal, and inputs whose usable cross product is below `1e-9`.

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```bash
node --test src/plasticity/construction.test.ts
```

Expected: FAIL because `construction.ts` and the exported frame functions do not exist.

- [ ] **Step 3: Implement the public types and pure math**

Define these stable shapes:

```ts
export type Vector3 = [number, number, number];

export interface PlaneFrame {
  originMm: Vector3;
  normal: Vector3;
  xDirection: Vector3;
  yDirection: Vector3;
}

export interface ConstructionPlaneDescriptor extends PlaneFrame {
  id: string;
  nativeId: string;
  name: string;
  source: "standard" | "saved";
}

export const GEOMETRY_EPSILON = 1e-9;
```

Implement `normalize`, `dot`, `cross`, `add`, `subtract`, `scale`, `distance`, `frameFromOriginNormalX`, `frameFromThreePoints`, `offsetFrame`, `rotateFrameAboutAxis`, `localPointToWorld`, and `planeToken`. Canonicalize `-0` to `0` and serialize numeric tokens with 12 significant digits so equivalent reads remain stable.

- [ ] **Step 4: Add failing tests for three-point, offset, rotation, and local conversion**

Use a non-axis-aligned frame and verify:

```ts
assertVectorClose(localPointToWorld(frame, [4, -2, 0]), expectedWorldMm);
assert.equal(distance(rotated.originMm, axisOriginMm), distance(frame.originMm, axisOriginMm));
assert.throws(() => frameFromThreePoints(p, p, q), /coincident/i);
assert.throws(() => frameFromThreePoints([0, 0, 0], [1, 0, 0], [2, 1e-12, 0]), /collinear/i);
assert.throws(() => rotateFrameAboutAxis(frame, offPlaneAxis, 30), /coplanar/i);
```

- [ ] **Step 5: Run the focused tests**

Run:

```bash
node --test src/plasticity/construction.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit the pure foundation**

```bash
git add src/plasticity/construction.ts src/plasticity/construction.test.ts
git commit -m "feat: add exact construction frame math"
```

## Task 2: Session-Bound Datum Registry

**Files:**

- Create: `src/plasticity/references.ts`
- Create: `src/plasticity/references.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Test coordinate and geometry-backed records, including:

```ts
const registry = new DatumRegistry("session-a");
registry.sync({ documentToken: "doc-a", revision: "r1" });
const point = registry.addPoint({ type: "coordinates", pointMm: [1, 2, 3] }, [1, 2, 3]);
assert.equal(registry.requireCurrentPoint(point.identity, "doc-a", "r1").id, point.id);
assert.throws(() => registry.requireCurrentPoint(point.identity, "doc-a", "r2"), /stale/i);
registry.sync({ documentToken: "doc-b", revision: "r1" });
assert.throws(() => registry.get(point.id), /unknown/i);
```

Also prove that a new registry with the same document token rejects a previous `sessionId`, and that refresh creates a new ID without mutating the old record.

- [ ] **Step 2: Run the test and confirm failure**

```bash
node --test src/plasticity/references.test.ts
```

Expected: FAIL because the registry does not exist.

- [ ] **Step 3: Implement definitions and identity checks**

Use discriminated unions:

```ts
export type PointDefinition =
  | { type: "coordinates"; pointMm: Vector3 }
  | { type: "face-center"; bodyId: number; faceId: string }
  | { type: "edge-midpoint"; bodyId: number; edgeId: string };

export type AxisDefinition =
  | { type: "two-points"; firstId: string; secondId: string }
  | { type: "origin-direction"; originMm: Vector3; direction: Vector3 }
  | { type: "linear-edge"; bodyId: number; edgeId: string }
  | { type: "cylindrical-face"; bodyId: number; faceId: string };

export type PlaneDefinition =
  | { type: "explicit"; originMm: Vector3; normal: Vector3; xDirection: Vector3 }
  | { type: "three-points"; firstId: string; secondId: string; thirdId: string }
  | { type: "planar-face"; bodyId: number; faceId: string; offsetMm: number }
  | { type: "offset"; planeId: string; offsetMm: number }
  | { type: "rotated"; planeId: string; axisId: string; angleDegrees: number };

export interface ReferenceIdentity {
  id: string;
  sessionId: string;
  documentToken: string;
  revision: string;
}
```

`DatumRegistry.sync` clears all records on a document change. A revision change keeps records for diagnostics but `requireCurrent*` rejects them. `refresh*` returns a new record and records `refreshedFromId`.

- [ ] **Step 4: Cover saved-plane registry records and standard reserved IDs**

Reserve IDs `standard:top`, `standard:bottom`, `standard:left`, `standard:right`, `standard:front`, and `standard:back`. Reject removal or replacement of standard records. Bind custom plane references to `sessionId`, `documentToken`, `revision`, and `nativeId`.

- [ ] **Step 5: Run focused tests and typecheck**

```bash
node --test src/plasticity/references.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/plasticity/references.ts src/plasticity/references.test.ts
git commit -m "feat: add revision-bound datum registry"
```

## Task 3: Bounded Native Plane Probe and Proof Gate

**Files:**

- Create: `scripts/probe-construction.ts`
- Modify: `package.json`
- Create: `docs/construction-geometry-acceptance.md`

- [ ] **Step 1: Implement a read-only diagnostic mode**

Reuse `discoverPlasticityTargets` and `PlasticityRuntime.connect`. Report only sanitized structure:

```ts
interface ProbeReport {
  target: { id: string; title: string };
  requiredBindings: Record<string, boolean>;
  standardPlanes: Array<{ key: string; constructor: string; fields: string[] }>;
  planeDatabase: { constructor: string; methods: string[]; savedCount: number };
  activeCandidates: Array<{ path: string; constructor: string | null; fields: string[] }>;
}
```

Do not print arbitrary document values or object graphs. Add:

```json
"probe:construction": "node scripts/probe-construction.ts"
```

- [ ] **Step 2: Add a guarded `--mutate` mode for the disposable empty document**

Require both `--mutate` and `--target <id>`. Before mutation assert that `state.bodies.length === 0`. Record the before plane snapshot, create one plane with a narrow probe-local helper using the discovered command contract, verify it appears, call Plasticity Undo and Redo once, and verify disappearance/reappearance. Task 5 must replace this helper with the production adapter so the final proof cannot drift from shipped code.

The diagnostic must exit nonzero if:

- any required binding is absent;
- the active target is not the explicitly supplied target;
- the document contains bodies;
- creation is not visible in `editor.planes`;
- Undo or Redo does not change native plane state as expected.

- [ ] **Step 3: Run read-only discovery against 26.1.3**

```bash
npm run probe:construction
```

Expected: `SaveConstructionPlaneCommand`, `RemovePlaneCommand`, `ConstructionPlaneDatabase`, `ConstructionPlaneSnap`, `CreateViewspaceConstructionPlaneAtOrigin`, `Plane`, and `Vector3` are all true; the report identifies `p`, `n`, `x`, and `y` frame fields.

- [ ] **Step 4: Capture the exact constructor and command contract**

In the acceptance document record:

- constructor argument count and required property assignment;
- database read path and native ID type;
- history depth before/create/undo/redo;
- active-workplane getter/setter path, or the exact reason it remains unavailable;
- internal units observed for a 12.5 mm offset.

Do not add a guessed implementation. If creation cannot be made to work through the native command, stop here and write the concrete blocker, as required by the specification.

- [ ] **Step 5: Run the mutation proof in the disposable document**

```bash
npm run probe:construction -- --mutate --target <target-id>
```

Expected: PASS with one create, one Undo, and one Redo; no body geometry remains.

- [ ] **Step 6: Commit the reusable probe and evidence**

```bash
git add scripts/probe-construction.ts package.json docs/construction-geometry-acceptance.md
git commit -m "test: prove native construction plane access"
```

## Task 4: Runtime Plane State and Change Tracking

**Files:**

- Modify: `src/plasticity/runtime.ts`
- Modify: `src/plasticity/change-tracker.ts`
- Modify: `src/plasticity/change-tracker.test.ts`

- [ ] **Step 1: Add failing diff tests**

Extend the existing state fixture with:

```ts
construction: {
  planes: [],
  activePlaneId: "standard:top",
  planeStateToken: "planes:empty",
  viewStateToken: "workplane:standard:top",
}
```

Prove that adding/removing/changing a saved plane sets `changed`, that active-only changes populate `activeWorkplaneChanged` but leave `fromRevision === toRevision`, and that a document replacement reports all custom planes as removed/added without matching reused native IDs.

- [ ] **Step 2: Run the focused test and confirm failure**

```bash
node --test src/plasticity/change-tracker.test.ts
```

Expected: FAIL on missing construction diff fields.

- [ ] **Step 3: Extend `RuntimeState`**

Add:

```ts
construction: {
  planes: ConstructionPlaneDescriptor[];
  activePlaneId: string | null;
  planeStateToken: string;
  viewStateToken: string;
};
```

Add a read-only binding-aware runtime path:

```ts
async readNative<T>(
  functionDeclaration: string,
  bindingNames: string[],
  values: unknown[] = [],
): Promise<T>;
```

Unlike `mutate`, this method does not set uncertain mutation state. Use it inside the existing serialized queue for `getState()` so `ConstructionPlaneDatabase` can be passed as a remote binding. Read standard planes from verified static descriptors and saved planes from the verified database path captured in Task 3. Convert only `p` from metres to millimetres. Normalize directions and sort by `source`, then `nativeId`, before token generation.

- [ ] **Step 4: Split revision and view tokens correctly**

Build geometry revision as:

```ts
const revision = [
  documentToken,
  dbVersion,
  undoDepth,
  redoDepth,
  bodyToken,
  planeStateToken,
].join("|");
```

Do not include `viewStateToken` in `revision`.

- [ ] **Step 5: Extend `SceneDiff`**

Add `constructionPlanesAdded`, `constructionPlanesRemoved`, `constructionPlanesModified`, and `activeWorkplaneChanged`. Compare custom planes by `documentToken + nativeId`, and compare standard planes by reserved ID. Include view-only changes in `changed` so `plasticity_wait_for_change` can wake without invalidating geometry references.

- [ ] **Step 6: Update all state fixtures and run tests**

```bash
node --test src/plasticity/change-tracker.test.ts src/plasticity/operations.test.ts src/plasticity/semantic.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/plasticity/runtime.ts src/plasticity/change-tracker.ts src/plasticity/change-tracker.test.ts src/plasticity/operations.test.ts src/plasticity/semantic.test.ts
git commit -m "feat: track construction planes in runtime state"
```

## Task 5: Native Construction Plane Adapter

**Files:**

- Modify: `src/plasticity/construction.ts`
- Modify: `src/plasticity/construction.test.ts`

- [ ] **Step 1: Add fake-runtime contract tests**

Use a fake `PlasticityRuntime` that captures `functionDeclaration`, binding names, and values. Verify:

- creation requests only the bindings proved in Task 3;
- millimetre origins become metres exactly once;
- removal refuses standard planes before `runtime.mutate`;
- all write methods require the caller's current revision;
- timeout errors pass through and a second mutation is not attempted;
- a returned state must contain exactly one committed plane matching the observed new native ID and normalized frame.

- [ ] **Step 2: Run the focused test and confirm failure**

```bash
node --test src/plasticity/construction.test.ts
```

- [ ] **Step 3: Implement `ConstructionGeometry`**

Expose this narrow adapter:

```ts
export class ConstructionGeometry {
  constructor(private readonly runtime: PlasticityRuntime) {}

  async createPlane(frame: PlaneFrame, name: string | undefined, revision: string): Promise<{
    plane: ConstructionPlaneDescriptor;
    state: RuntimeState;
  }>;

  async removePlane(nativeId: string, revision: string): Promise<RuntimeState>;
  async setWorkplane(plane: ConstructionPlaneDescriptor): Promise<RuntimeState>;
}
```

Use `SaveConstructionPlaneCommand` and `RemovePlaneCommand` exactly as verified in Task 3. Execute creation/removal through `this.exec(command)` so each is one Plasticity history command. Read the full post-state rather than trusting inputs.

- [ ] **Step 4: Enforce unique read-back and unknown-outcome behavior**

Before creation capture the saved native-ID set. After creation require exactly one new ID and require its origin/axes to match within `0.01 mm` and `1e-6` direction tolerance. If no unique match exists, throw an error containing both observed ID sets. Let `PlasticityRuntime` own the uncertain flag on timeout/connection close.

- [ ] **Step 5: Capability-gate active workplane activation**

Implement only the setter/getter pair proved in Task 3. If no pair was proved, `setWorkplane` throws `Plasticity active workplane control is unavailable in 26.1.3`, and the server capability response reports this operation as unavailable. Do not simulate activation with camera motion.

- [ ] **Step 6: Run unit tests, typecheck, and the live create/undo/redo probe**

```bash
node --test src/plasticity/construction.test.ts
npm run typecheck
npm run probe:construction -- --mutate --target <target-id>
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/plasticity/construction.ts src/plasticity/construction.test.ts scripts/probe-construction.ts
git commit -m "feat: add native construction plane adapter"
```

## Task 6: Geometry-Backed Datum Resolution and Facade Methods

**Files:**

- Modify: `src/plasticity/semantic.ts`
- Modify: `src/plasticity/semantic.test.ts`
- Modify: `src/plasticity/operations.ts`
- Modify: `src/plasticity/operations.test.ts`

- [ ] **Step 1: Add failing semantic resolution tests**

Cover:

- face center from one current planar face;
- edge midpoint and tangent from one current linear edge;
- linear-edge axis direction normalization;
- cylindrical-face axis from exact native surface data;
- wrong body, missing topology ID, non-planar face, non-linear edge, and non-cylindrical face;
- duplicate topology matches returning `ambiguous` rather than picking one.

- [ ] **Step 2: Add exact surface axis data to runtime faces**

Extend face state with `axisOriginMm` and `axisDirection` nullable fields. Populate them only when the native surface exposes a verified cylinder/cone axis. Do not derive a cylinder axis from mesh bounds or face normals.

- [ ] **Step 3: Implement resolvers**

Add pure functions returning explicit result states:

```ts
export type Resolution<T> =
  | { status: "resolved"; value: T }
  | { status: "ambiguous"; matches: number }
  | { status: "unresolved"; reason: string };

export function resolvePoint(state: RuntimeState, definition: PointDefinition): Resolution<Vector3>;
export function resolveAxis(state: RuntimeState, definition: AxisDefinition, registry: DatumRegistry): Resolution<{ originMm: Vector3; direction: Vector3 }>;
export function resolvePlaneFrame(state: RuntimeState, definition: PlaneDefinition, registry: DatumRegistry): Resolution<PlaneFrame>;
```

- [ ] **Step 4: Compose facade methods**

Construct `DatumRegistry` and `ConstructionGeometry` once per `PlasticityOperations`. Add methods for define point/axis, create/list/set/remove plane, and refresh. Every method first syncs the registry against current state. Mutation methods assert revision before calling the adapter.

- [ ] **Step 5: Test invalid input never reaches CDP**

Assert `mutate` remains false for coincident points, collinear plane definitions, stale session/document/revision identity, standard-plane removal, and an off-plane rotation axis.

- [ ] **Step 6: Run focused tests**

```bash
node --test src/plasticity/semantic.test.ts src/plasticity/operations.test.ts src/plasticity/references.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/plasticity/semantic.ts src/plasticity/semantic.test.ts src/plasticity/operations.ts src/plasticity/operations.test.ts src/plasticity/references.ts
git commit -m "feat: resolve construction datums from exact geometry"
```

## Task 7: MCP Tools, Schemas, Capabilities, and Journal

**Files:**

- Modify: `src/server.ts`
- Modify: `src/server.test.ts`

- [ ] **Step 1: Add failing MCP discovery and validation tests**

Require these tools:

```ts
const expected = [
  "plasticity_define_datum_point",
  "plasticity_define_datum_axis",
  "plasticity_create_construction_plane",
  "plasticity_list_construction_geometry",
  "plasticity_set_workplane",
  "plasticity_remove_construction_plane",
  "plasticity_refresh_datum",
];
```

Call invalid cases through `Client.callTool`: zero direction, identical point IDs, missing reference identity, invalid plane union, and standard-plane removal. Assert MCP error results and zero fake mutations.

- [ ] **Step 2: Define strict reusable Zod schemas**

Use `.strict()` on every object. Reference inputs include `id`, `sessionId`, `documentToken`, and `revision`. Model definitions as discriminated unions matching the spec. Limit names to 120 trimmed characters and finite numeric values.

- [ ] **Step 3: Register the seven tools**

Extend the `tool` helper with an optional annotation override rather than duplicating registration logic. Mark list as read-only. Datum definition and refresh modify only MCP session state and receive `destructiveHint: false`; native plane create/remove/set use existing exclusive serialization. Journal create/remove as native mutations. Journal datum definitions as registry events without pretending they changed Plasticity history. Update `SessionLike.capabilities()` to the structured return type while retaining the existing `bindings` array.

- [ ] **Step 4: Return structured capability status**

Change `plasticity_capabilities` from a bare binding list to:

```ts
{
  bindings: string[],
  operations: {
    constructionPlanes: { available: boolean; reason: string | null },
    activeWorkplane: { available: boolean; reason: string | null },
  },
}
```

Retain `bindings` for compatibility.

- [ ] **Step 5: Test document switching and uncertain outcomes through MCP**

Use a fake session to prove:

- reconnect creates a new session ID and clears datum refs;
- a manual revision change rejects an old datum;
- a manual saved-plane change appears in `plasticity_changes_since`;
- a timeout creates an `unknown` journal entry;
- reconcile reports observed state without resubmitting the command.

- [ ] **Step 6: Run server tests and typecheck**

```bash
node --test src/server.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts src/server.test.ts
git commit -m "feat: expose construction geometry MCP tools"
```

## Task 8: Plane-Local Curves and Compatible Existing Inputs

**Files:**

- Modify: `src/plasticity/operations.ts`
- Modify: `src/plasticity/operations.test.ts`
- Modify: `src/server.ts`
- Modify: `src/server.test.ts`

- [ ] **Step 1: Add failing transformation tests**

For `createPolyline` and `createCircle`, prove a plane-local input is transformed before native conversion:

```ts
const plane = {
  originMm: [10, 20, 30],
  xDirection: [0, 1, 0],
  yDirection: [0, 0, 1],
  normal: [1, 0, 0],
};
// local [5, 7] -> world [10, 25, 37] mm -> [0.01, 0.025, 0.037] m
```

Assert the existing world-space 3D request produces byte-for-byte identical runtime arguments.

- [ ] **Step 2: Add optional plane input schemas**

For polylines accept either existing `pointsMm: Vector3[]` or `{ pointsMm: [number, number][]; plane: ReferenceIdentity }`. For circles accept existing `centerMm + normal` or `{ centerMm: [number, number]; plane: ReferenceIdentity }`. Reject mixed forms.

- [ ] **Step 3: Resolve and transform before CDP**

Require the plane reference to match session, document, and revision. Transform all local inputs in Node, then call the unchanged native factory path. This preserves one unit-conversion boundary and keeps arbitrary plane state out of renderer code.

- [ ] **Step 4: Verify a local circle can feed existing extrusion**

Unit-test tool serialization and then live-create a circle on a 30-degree rotated plane. Use the existing region/profile path to extrude it. Read the resulting native B-Rep axis/dimensions rather than echoing requested values.

- [ ] **Step 5: Run focused and MCP tests**

```bash
node --test src/plasticity/operations.test.ts src/server.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/plasticity/operations.ts src/plasticity/operations.test.ts src/server.ts src/server.test.ts
git commit -m "feat: create curves in construction plane coordinates"
```

## Task 9: Live Plasticity Acceptance

**Files:**

- Modify: `docs/construction-geometry-acceptance.md`
- Modify: `README.md`

- [ ] **Step 1: Start from an explicitly selected disposable window**

```bash
npm run probe:targets
```

Record Plasticity version, target ID, MCP commit, initial document token, initial revision, and initial undo/redo depths. Assert the document has no bodies before continuing.

- [ ] **Step 2: Exercise every datum definition**

Through an MCP client:

1. define a coordinate point;
2. create a box and define face-center and edge-midpoint points;
3. define origin-direction, two-point, linear-edge, and cylindrical-face axes;
4. verify returned values against native geometry within `0.01 mm` for positions and `1e-6` for directions.

- [ ] **Step 3: Exercise every plane definition**

Create and read back:

1. explicit frame;
2. three-point plane;
3. planar-face plane;
4. `12.5 mm` signed offset;
5. plane rotated `30°` around a coplanar datum axis.

For each, record native ID, normalized frame, before/after revision, and undo-depth delta.

- [ ] **Step 4: Exercise activation and local modeling**

If capability reports active workplane available, activate the rotated plane and verify the runtime active descriptor. Create a local circle and extrude it. Verify the resulting B-Rep orientation and measured size. If unavailable, record the exact verified limitation and ensure the tool/capability response is consistent.

- [ ] **Step 5: Exercise Undo/Redo, manual edits, and reconciliation**

Undo and redo a saved plane; verify plane state and revisions. Manually add or remove a saved plane in Plasticity, then prove `changes_since` reports it and old datums are rejected. Simulate one CDP disconnect after dispatch only if the existing test harness can do it without corrupting the document; otherwise rely on the automated transport test and state that live disconnect injection was not run.

- [ ] **Step 6: Save and reopen**

Save a new `.plasticity` file, close/reopen via the existing document tools, and verify saved custom planes persist with valid frames. Confirm old session references are rejected even if native IDs are reused.

- [ ] **Step 7: Document actual evidence**

Add a table with operation, input, observed native result, tolerance, Undo/Redo result, and status. Never mark an unrun check PASS.

- [ ] **Step 8: Update README**

Document tool names, reference identity, plane-local coordinates, capability diagnostics, uncertain-outcome recovery, and the save/reopen limitation discovered in live testing.

- [ ] **Step 9: Commit acceptance evidence**

```bash
git add docs/construction-geometry-acceptance.md README.md
git commit -m "docs: record construction geometry acceptance"
```

## Task 10: Full Verification and Scope Review

**Files:**

- Review all files changed in Tasks 1-9.

- [ ] **Step 1: Run the complete automated gates**

```bash
npm test
npm run typecheck
```

Expected: all tests PASS with exit code 0; coverage collection completes.

- [ ] **Step 2: Re-run the native proof after all integration changes**

```bash
npm run probe:construction -- --mutate --target <target-id>
```

Expected: create/read/Undo/Redo all PASS through the final adapter.

- [ ] **Step 3: Review the final diff against the specification**

```bash
git diff 264440b..HEAD --stat
git diff 264440b..HEAD -- src scripts package.json README.md docs/construction-geometry-acceptance.md
```

Check specifically:

- no arbitrary JavaScript tool;
- no hidden body used as a datum;
- no mesh-derived exact measurement;
- no overwrite behavior added;
- no plane/view token mix-up;
- no automatic retry or Undo on uncertain mutation;
- every public tool has input validation and a test;
- every capability claim matches live evidence.

- [ ] **Step 4: Inspect for unfinished implementation**

```bash
rg -n "TODO|FIXME|placeholder|not implemented|throw new Error\(\"TBD" src scripts README.md docs/construction-geometry-acceptance.md
```

Expected: no implementation placeholders. A capability-gated, documented unsupported active-workplane path is allowed only if Task 3 proved no safe native setter.

- [ ] **Step 5: Report exact results**

Report the commit range, automated test counts and exit codes, live Plasticity operations that passed, output artifact paths, and any operation left unavailable with its verified reason.
