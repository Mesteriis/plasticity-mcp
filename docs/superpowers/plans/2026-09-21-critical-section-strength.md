# Critical Section Strength Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add exact, revision-bound planar critical-section inspection and nominal axial/biaxial-bending strength calculation to Plasticity MCP, with conservative rectangular shear support.

**Architecture:** A pure section-geometry module integrates exact line and circular boundaries; a pure section-calculation module transforms world-space loads and evaluates nominal stress. A Plasticity adapter collects current native face topology, while the existing immutable store and MCP layer gain a backward-compatible discriminated report union.

**Tech Stack:** TypeScript 5.9, Node.js 24, Zod 4, MCP TypeScript SDK 1.30, Plasticity 26.1.3 Electron/CDP native B-rep adapter.

**Spec:** `docs/superpowers/specs/2026-09-21-critical-section-strength-design.md`

## Global Constraints

- macOS Apple Silicon and Plasticity 26.1.3 remain the only claimed live target.
- Public coordinates are millimetres, forces are newtons, moments are N·mm and stress is MPa.
- Geometry proof uses native B-rep boundaries only; render meshes and display bounds never prove section properties.
- Existing rectangular report JSON remains readable without migration or rewriting.
- New inspection tools are read-only in Plasticity; calculations only append private immutable records.
- Unsupported torsion, arbitrary-section shear and unknown boundary curves remain visible and can never produce an unconditional pass.
- Workbench and HTTP services are not dependencies of this feature.

## Review Focus

- A reversed inner loop must subtract area and inertia exactly instead of becoming a second outer island; Task 2 pins orientation-independent containment.
- A force applied at a large coordinate must form its moment about the measured centroid without unit loss or catastrophic cancellation; Task 3 covers translated and rotated cases.
- A face ID reused after a topology edit must not validate an old report; Tasks 5 and 6 compare revision plus topology signature.
- A legacy rectangular report must parse after the store becomes a report union; Task 4 reads a literal pre-feature JSON fixture.
- A nonzero shear or torsion component must remain visible even when the normal-stress criterion fails first; Task 3 asserts issues are accumulated before status precedence.

---

### Task 1: Prove native face boundary access

**Files:**
- Create: `scripts/probe-section-face.ts`
- Create: `scripts/probe-section-face.test.ts`
- Modify: `docs/native-access-report.md`

**Interfaces:**
- Consumes: existing `PlasticityRuntime`, `PlasticityOperations`, explicit target ownership and native box/cylinder/Boolean operations.
- Produces: a guarded live probe and a documented native edge record sufficient to distinguish line, circular arc and full circle boundaries.

- [ ] **Step 1: Write argument tests before the probe**

```ts
assert.deepEqual(parseSectionProbeArgs([]), { help: true, mutate: false });
assert.throws(() => parseSectionProbeArgs(["--mutate"]), /target/i);
assert.deepEqual(parseSectionProbeArgs([
  "--target", "window-1", "--mutate", "--allow-disposable-mutations",
]), { help: false, targetId: "window-1", mutate: true, allowDisposableMutations: true });
```

- [ ] **Step 2: Run the test and confirm the missing-export failure**

Run: `node --test scripts/probe-section-face.test.ts`

- [ ] **Step 3: Implement the safe probe**

The probe must do nothing with no arguments or `--help`, require the explicit
target and mutation flag, refuse a nonempty document, then create a 20 × 10 × 5
box and a second box with a centred Ø4 through-hole. For selected planar faces,
return only bounded JSON containing native constructor names, edge IDs, vertex
IDs, `IsLine`/`IsCircle`, `GetPointAndTangent(0|1)`, and the serializable scalar
fields returned by `GetCurve().curve.GetInfo?.()`. Do not print native objects.
Undo confirmed steps and assert the initial empty document is restored.

- [ ] **Step 4: Run the probe against the explicit disposable Plasticity window**

Run:

```sh
node scripts/probe-section-face.ts \
  --target TARGET_ID \
  --mutate --allow-disposable-mutations
```

Acceptance: straight edges expose two distinct endpoints; the hole boundary
exposes a native circle or circular arc with centre, radius, basis and sweep
orientation. If those facts are unavailable, stop this implementation with the
captured missing API rather than use a mesh or UI automation.

- [ ] **Step 5: Record verified access and commit**

Run `node --test scripts/probe-section-face.test.ts`, `npm run typecheck` and
`git diff --check`, then commit:

```sh
git add scripts/probe-section-face.ts scripts/probe-section-face.test.ts docs/native-access-report.md
git commit -m "test: prove native planar face boundaries"
```

### Task 2: Integrate exact planar boundaries

**Files:**
- Create: `src/strength/section-geometry.ts`
- Create: `src/strength/section-geometry.test.ts`

**Interfaces:**
- Consumes: the native line/circle record proven in Task 1.
- Produces:

```ts
export type SectionSegment =
  | { kind: "line"; start: [number, number]; end: [number, number] }
  | { kind: "arc"; center: [number, number]; radius: number; startRadians: number; sweepRadians: number };
export interface SectionLoop { segments: SectionSegment[] }
export interface LocalSectionProperties {
  areaMm2: number;
  centroidLocalMm: [number, number];
  ixxMm4: number;
  iyyMm4: number;
  ixyMm4: number;
  principal: { majorMm4: number; minorMm4: number; angleDegrees: number };
  innerLoopCount: number;
  boundaryKinds: Array<"line" | "circle">;
  rectangular: boolean;
  topologySignature: string;
}
export interface SectionProperties extends LocalSectionProperties {
  centroidMm: [number, number, number];
  source: "native-brep-boundary";
}
export function integrateSection(loops: SectionLoop[]): LocalSectionProperties;
export function linearStressExtrema(
  loops: SectionLoop[], coefficients: { constant: number; x: number; y: number },
): { minimum: number; maximum: number; minimumAt: [number, number]; maximumAt: [number, number] };
```

- [ ] **Step 1: Add failing independent-reference tests**

Use literal analytical references: rectangle 20 × 10 has `A=200`, centroid
`[10,5]`, `Ixx=1666.6666666667`, `Iyy=6666.6666666667`, `Ixy=0`; subtracting a
centred radius-2 circle gives `A=200-4π` and subtracts `4π` from each centroidal
second moment. Include a semicircle, rounded rectangle, reversed input loop,
self-intersection, open loop, disconnected outer islands and a radius/sweep
overflow.

- [ ] **Step 2: Run and confirm missing implementation**

Run: `node --test src/strength/section-geometry.test.ts`

- [ ] **Step 3: Implement line and circular-arc Green integrals**

Accumulate signed `A`, first moments and origin second moments for every segment,
classify loops by containment instead of trusting caller orientation, normalize
outer/inner signs, shift to the centroid with the parallel-axis theorem, and
derive principal moments from the symmetric inertia tensor. Hash canonical
normalized segments with SHA-256. Reject any non-finite intermediate value,
open loop beyond `1e-5 mm`, self-intersection, more than one outer island,
non-positive area or determinant.

- [ ] **Step 4: Implement exact extrema and rectangle recognition**

For a line, evaluate both endpoints. For an arc, evaluate endpoints and angles
where the linear stress gradient is parallel to the radius when they lie within
the signed sweep. Mark `rectangular=true` only for one loop of four lines,
opposite parallel sides, four right angles and no inner loop.

- [ ] **Step 5: Run focused tests and commit**

```sh
node --test src/strength/section-geometry.test.ts
npm run typecheck
git add src/strength/section-geometry.ts src/strength/section-geometry.test.ts
git commit -m "feat: integrate exact planar section properties"
```

### Task 3: Calculate section resultants and nominal stress

**Files:**
- Create: `src/strength/section-contracts.ts`
- Create: `src/strength/section-schemas.ts`
- Create: `src/strength/section-calculate.ts`
- Create: `src/strength/section-calculate.test.ts`
- Modify: `src/strength/contracts.ts`
- Modify: `src/strength/schemas.ts`
- Modify: `src/strength/schemas.test.ts`
- Modify: `src/strength/units.ts`
- Modify: `src/strength/units.test.ts`
- Modify: `src/strength/provenance.ts`
- Modify: `src/strength/provenance.test.ts`
- Modify: `src/strength/methods.ts`
- Modify: `src/codex/analysis-client.ts`
- Modify: `src/codex/analysis-client.test.ts`

**Interfaces:**
- Consumes: `LocalSectionProperties`, existing `Evidence`, `Material`, `Outcome` and canonical evidence validation.
- Produces:

```ts
export interface PointForce {
  id: string; forceN: [number, number, number]; pointMm: [number, number, number]; evidenceIds: string[];
}
export interface FreeMoment {
  id: string; momentNmm: [number, number, number]; evidenceIds: string[];
}
export interface SectionBinding {
  sessionId: string;
  documentToken: string;
  revision: string;
  bodyId: number;
  faceId: string;
  topologySignature: string;
}
export interface SectionScenarioInput {
  kind: "planar-section";
  goal: string;
  method: "planar-section-resultants-v1";
  frame: { originMm: [number, number, number]; normal: [number, number, number]; xDirection: [number, number, number] };
  properties: LocalSectionProperties;
  pointForces: PointForce[];
  freeMoments: FreeMoment[];
  material: Material;
  safetyFactor?: number;
  evidence: Evidence[];
  assignments: Record<string, string>;
  assumptions: { code: string; confirmed: boolean; evidenceIds: string[] }[];
  binding?: SectionBinding;
}
export interface SectionCalculation {
  kind: "planar-section";
  status: Outcome;
  method: "planar-section-resultants-v1";
  methodVersion: "1.0.0";
  inputHash: string;
  resultants: { axialN: number; shearXN: number; shearYN: number; bendingXNmm: number; bendingYNmm: number; torsionNmm: number };
  normalStressMPa?: { minimum: number; maximum: number };
  shearStressMPa?: number;
  tensileUtilization?: number;
  compressiveUtilization?: number;
  shearUtilization?: number;
  checkedScope: string;
  issues: { code: string; message: string; evidenceIds: string[] }[];
  unchecked: string[];
}
export function calculateSection(input: SectionScenarioInput): SectionCalculation;
```

- [ ] **Step 1: Add failing schema and calculation tests**

Cover strict unknown-key rejection, duplicate load IDs, missing evidence, zero
force, pure axial load, bending about each axis, combined unsymmetric bending,
translation and rigid-rotation invariance, a force-derived moment, rectangular
shear, missing shear limit, non-rectangular shear, torsion plus a simultaneous
normal failure, unconfirmed process, inner-loop conditional status and numeric
overflow.

- [ ] **Step 2: Run the tests and confirm failure**

Run: `node --test src/strength/section-calculate.test.ts`

- [ ] **Step 3: Implement schemas, frame normalization and resultants**

Add `"Nmm"`, `"mm2"` and `"mm4"` evidence units to the contracts and strict
schemas. Extend `Material` and its schema with optional `shearLimitMPa`. Add a
section-specific provenance validator whose assignment paths cover load-vector
components, application-point components, free-moment components, section
properties, material limits and safety factor. Build the orthonormal frame as
`x=normalize(project(xDirection))`,
`y=normalize(cross(normal,x))`, and use `Σ((p-centroid)×F)+ΣM`. Reject a parallel
X direction and non-finite resultants.

- [ ] **Step 4: Implement stress, utilization and precedence**

Use the general inertia matrix, evaluate the linear field with
`linearStressExtrema`, calculate rectangular shear only for a proven solid
rectangle, accumulate every issue, and then apply the spec's outcome precedence.
Hash the entire canonical section input, including loads and topology signature.

Extend the analysis result and strict Codex JSON schema method enum with
`planar-section-resultants-v1`; all object properties remain required by the
Codex structured-output contract.

- [ ] **Step 5: Register the method passport and commit**

Run focused tests plus `npm run typecheck`, then:

```sh
git add src/strength/contracts.ts src/strength/schemas.ts src/strength/schemas.test.ts \
  src/strength/units.ts src/strength/units.test.ts src/strength/provenance.ts \
  src/strength/provenance.test.ts src/strength/methods.ts \
  src/strength/section-contracts.ts src/strength/section-schemas.ts \
  src/strength/section-calculate.ts src/strength/section-calculate.test.ts \
  src/codex/analysis-client.ts src/codex/analysis-client.test.ts
git commit -m "feat: calculate planar section strength"
```

### Task 4: Preserve both report kinds immutably

**Files:**
- Modify: `src/strength/store.ts`
- Modify: `src/strength/store.test.ts`

**Interfaces:**
- Consumes: existing `StrengthInput`/`Calculation` and new `SectionScenarioInput`/`SectionCalculation`.
- Produces: `StoredReport` as a discriminated union, `saveSectionReport`, and `reportView` freshness for body/face/topology identity.

- [ ] **Step 1: Add failing compatibility and freshness tests**

Write a literal legacy report JSON containing no `kind`, read it through
`readReport`, and assert it remains the rectangular report type. Add a section
round trip and stale reasons for session, document, revision, body, face,
topology signature, material, printer profile, orientation and load changes.

- [ ] **Step 2: Run the store tests and confirm failure**

Run: `node --test src/strength/store.test.ts`

- [ ] **Step 3: Implement the report union without rewriting old files**

Keep the existing rectangular schema as one union arm. Add a strict section
arm and `saveSectionReport(input, result)`. Dispatch hashing and `withoutBinding`
by the report kind. Return stable reasons `CAD_FACE_CHANGED` and
`CAD_TOPOLOGY_CHANGED` in addition to existing CAD reasons.

- [ ] **Step 4: Run tests, inspect file modes and commit**

```sh
node --test src/strength/store.test.ts
npm run typecheck
git add src/strength/store.ts src/strength/store.test.ts
git commit -m "feat: store planar section reports"
```

### Task 5: Read an exact Plasticity planar face

**Files:**
- Create: `src/plasticity/section-geometry.ts`
- Create: `src/plasticity/section-geometry.test.ts`
- Modify: `src/plasticity/operations.ts`
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: native API proven by Task 1 and `integrateSection` from Task 2.
- Produces:

```ts
export interface SectionRequest { bodyId: number; faceId: string; revision: string; xDirection: [number, number, number] }
export interface SectionEvidence {
  status: "verified" | "unsupported";
  binding: SectionBinding;
  frame?: SectionScenarioInput["frame"];
  properties?: SectionProperties;
  loops?: SectionLoop[];
  source: "native-brep-boundary";
  reasons: string[];
}
export async function inspectPlanarSection(runtime: PlasticityRuntime, request: SectionRequest, sessionId: string): Promise<SectionEvidence>;
```

- [ ] **Step 1: Add pure runtime fixture tests first**

Test unique current face, stale revision, missing/duplicate face ID, non-Solid,
native `Check()` failure, nonplanar face, line/circle extraction, unsupported
curve, open incidence and a document/revision change after collection. Assert
the adapter never reads `boundsMm` for section properties.

- [ ] **Step 2: Run and confirm failure**

Run: `node --test src/plasticity/section-geometry.test.ts`

- [ ] **Step 3: Implement bounded native collection and projection**

Resolve the stable body and topology maps exactly once, read only the selected
face's edges and vertices, convert metres to millimetres once, reconstruct
cycles and circle sweeps, and pass local loops to `integrateSection`. Re-read
state before returning. Include face ID and topology signature in the binding.

- [ ] **Step 4: Expose through operations/session dependencies and commit**

Add `PlasticityOperations.inspectPlanarSection`. Extend
`strengthDependenciesForSession` with `inspectSection` and
`readSectionBinding`; the latter must resolve the current face and signature,
not merely echo an ID. Run tests/typecheck and commit:

```sh
git add src/plasticity/section-geometry.ts src/plasticity/section-geometry.test.ts \
  src/plasticity/operations.ts src/server.ts
git commit -m "feat: inspect native planar sections"
```

### Task 6: Expose the section workflow through MCP

**Files:**
- Modify: `src/strength/mcp.ts`
- Modify: `src/strength/mcp.test.ts`
- Modify: `src/strength/instructions.ts`
- Modify: `src/strength/instructions.test.ts`
- Modify: `docs/strength-operations.md`
- Modify: `docs/strength/methods.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: Tasks 3–5.
- Produces: the three public tools specified in the design and union-aware `plasticity_strength_report`.

- [ ] **Step 1: Add failing in-memory MCP tests**

Initialize a real SDK client, list the three tools, call scenario calculation,
inspect a fake exact section and verify a bound report. Assert strict input,
missing CAD session, stale-before-store race, unsupported topology, caller
binding removal from scenarios, bounded response size, accurate annotations,
no Workbench imports and no HTTP dependency.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `node --test src/strength/mcp.test.ts src/strength/instructions.test.ts src/server.test.ts`

- [ ] **Step 3: Register tools and measured-evidence replacement**

`plasticity_inspect_planar_section` is read-only. Calculation and verification
are persistent but non-destructive. Verification must inspect, replace every
geometry property with measured records, calculate, re-read the current section
binding and only then store. A revision change during this sequence returns an
error and stores nothing.

- [ ] **Step 4: Update prompt, resources and docs**

Add an original worked rectangle, holed conditional section, unsupported
torsion and stale-face example. State that the agent proposes calculations and
CAD changes in Codex chat, Workbench is optional, and section stress does not
approve a print or whole part.

- [ ] **Step 5: Run focused gates and commit**

```sh
node --test src/strength/mcp.test.ts src/strength/instructions.test.ts src/server.test.ts
npm run typecheck
git add src/strength/mcp.ts src/strength/mcp.test.ts src/strength/instructions.ts \
  src/strength/instructions.test.ts docs/strength-operations.md \
  docs/strength/methods.md README.md
git commit -m "feat: expose planar section strength tools"
```

### Task 7: Run live stdio and Plasticity acceptance

**Files:**
- Create: `scripts/verify-section-strength-live.ts`
- Create: `scripts/verify-section-strength-live.test.ts`
- Create: `docs/section-strength-acceptance.md`
- Modify: `docs/acceptance-matrix.md`

**Interfaces:**
- Consumes: public stdio MCP only; no direct product-module shortcuts.
- Produces: guarded, sanitized evidence for Plasticity 26.1.3 and the installed MCP launcher.

- [ ] **Step 1: Test safe CLI defaults**

Require `--target`, `--allow-disposable-mutations` and a new `--output`
directory. No arguments/`--help` perform no connection or mutation. Evidence
files use `0600`, exclude credentials/native dumps/full prompts and are never
overwritten.

- [ ] **Step 2: Implement the end-to-end scenario**

Use `StdioClientTransport` and `scripts/run-server.ts`. Refuse a nonempty
document. Create a 20 × 10 × 5 box, locate its 20 × 10 planar end face, verify
`A=200`, `Ixx=1666.6666666667`, `Iyy=6666.6666666667`, then calculate an explicit
synthetic axial/bending/shear benchmark that remains conditional. Build a second body with a centred Ø4
through-hole and verify `A=200-4π` plus the analytical moments. Its nonzero
shear result must be unsupported while nominal normal values remain visible.

- [ ] **Step 3: Verify staleness and recovery**

Modify one confirmed disposable body, prove the bound report stale, perform
Undo/Redo and re-read. Undo only confirmed journal steps, require the same
document and clean journal, and prove the scene contents are empty afterward;
record the expected history revision change separately.

- [ ] **Step 4: Run live acceptance and document actual evidence**

Use a new output directory for every attempt. Update documentation only with
values returned by the successful run. Do not claim physical strength or
arbitrary-plane support.

- [ ] **Step 5: Run final gates and commit**

```sh
node --test scripts/verify-section-strength-live.test.ts
npm test
npm run typecheck
npm --workspace workbench test
npm --workspace workbench run typecheck
npm --workspace workbench run build
git diff --check
git add scripts/verify-section-strength-live.ts scripts/verify-section-strength-live.test.ts \
  docs/section-strength-acceptance.md docs/acceptance-matrix.md
git commit -m "test: accept live planar section strength"
```

### Task 8: Review and integrate

**Files:** Review every file changed from the plan's base commit; no new product scope.

**Interfaces:**
- Consumes: all earlier task commits and live evidence.
- Produces: a reviewed, clean branch merged into `main` under the user's standing integration instruction.

- [ ] **Step 1: Audit against the specification**

Check every supported/unsupported boundary, unit, sign convention, status
precedence, exact-geometry claim, stale condition, storage compatibility,
process cleanup and documentation statement against source and tests.

- [ ] **Step 2: Run fresh completion gates**

```sh
node --test scripts/probe-section-face.test.ts scripts/verify-section-strength-live.test.ts
npm test
npm run typecheck
npm --workspace workbench test
npm --workspace workbench run typecheck
npm --workspace workbench run build
git diff --check main..HEAD
test -z "$(git status --porcelain)"
```

- [ ] **Step 3: Fast-forward merge and verify the merged checkout**

Confirm `git merge-base main HEAD` equals the recorded base, confirm the main
checkout is clean, then fast-forward merge. Run the same automated gates from
the main checkout. Keep the Codex-managed worktree unless its owner explicitly
removes it.
