# Plasticity Strength Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Preserve the user's previously selected Native execution method; implementation waits for review of this written plan.

**Goal:** Provide reproducible static member sizing and verification through Plasticity MCP, with bounded Codex API analysis and a complete chat-only workflow.

**Architecture:** Codex proposes a mechanical interpretation; deterministic methods calculate results; a read-only Plasticity adapter verifies the actual member geometry. Immutable calculation records live independently of Workbench. Existing native CAD tools perform separately approved geometry changes.

**Tech Stack:** Existing Node.js 24, TypeScript, Zod 4, MCP TypeScript SDK 1.30.0, node:test, local Codex App Server stdio API, Plasticity 26.1.3 CDP.

**Spec:** `docs/superpowers/specs/2026-09-21-plasticity-strength-design.md` — approved by the user on 2026-09-21. The two initial methods are axial tension and a rectangular cantilever under a transverse tip force. This plan does not implement the subsequent photo-reconstruction, semantic-editing, or surface-modeling projects.

## Global Constraints

- «Plasticity остаётся единственным CAD и источником фактической геометрии.»
- «Основной интерфейс — чат Codex.»
- «Workbench опционален: его отсутствие не блокирует вопросы, расчёт, согласование, построение или получение отчёта.»
- «Первый выпуск не включает FEM, расчёт крепежа, потерю устойчивости, удар, усталость, ползучесть и термомеханический анализ.»
- «Масса не принимается за силу без явного преобразования.»
- «Универсальный скрытый коэффициент запаса не используется.»
- «Аналитический вызов не получает инструментов изменения Plasticity, печати или повторного вызова самого себя.»
- «Ошибка или тайм-аут возвращаются основному агенту; автоматического повторного платного запуска нет.»
- «Mesh-bbox допустим только для ориентирования.»
- «Пакет может состоять из нескольких нативных шагов истории.»
- «После перезапуска оно [делегирование] не восстанавливается автоматически.»
- Node.js >=24; retain existing dependencies and native transport; no new solver or UI dependency.
- Public units are mm, N, kg, MPa, degrees and Celsius. Calculations use the coherent N/mm/MPa system (MPa = N/mm²).
- Do not alter saved user documents, restart Plasticity automatically, send prints, or inherit a broad automation authorization for a new production part.

## Review Focus

1. Changing printer orientation without changing CAD must invalidate material applicability and prior report freshness (Tasks 2, 5, 8).
2. A successful Codex turn containing a refusal, incomplete JSON, or a proposed CAD command must not be accepted as a calculation result (Task 6).
3. A hollow or tapered member with the same bbox as the accepted solid must not pass the rectangular-member geometry gate (Task 7).
4. A failed strength criterion combined with uncertain material data must remain visibly failing, not be hidden by a generic conditional status (Tasks 3, 8).
5. Restart, duplicate concurrent requests, and user edits during analysis must not replay paid calls, overwrite reports, or authorize stale CAD operations (Tasks 5, 6, 8).

## Evidence and starting state

Base at planning: `main`, clean at `3e7b48f`. Last recorded gates: 167 root tests, 22 Workbench web tests, 46 server tests and 6 E2E. These counts are historical, not new execution results.

Verified local protocol generation exposes `ThreadStartParams.ephemeral`, `environments`, `sandbox`, `approvalPolicy`, `config`, and `TurnStartParams.outputSchema`; local-image input is present. This proves schema availability only. Empty dynamicTools is not proof that built-in or configured MCP tools are disabled. Task 1 is a mandatory compatibility gate.

Primary mathematical references checked during planning:

- [MIT 2.002 laboratory module, sections 4–5](https://ocw.mit.edu/courses/2-002-mechanics-and-materials-ii-spring-2004/9aebe9fc6669d928aa716a5033cc9c9f_lab_1_s04.pdf): idealized elastic member relations and rectangular beam bending.
- [TU Delft axial loaded members](https://ocw.tudelft.nl/course-readings/axial-loaded-members-summary-key-formulas-2/): uniform-member extension PL/EA.
- [Purdue ME323 beam-deflection table](https://www.purdue.edu/freeform/me323/wp-content/uploads/sites/2/2018/10/ME323_F18_Hw7_final.pdf): independent cantilever deflection relation.

Use original implementation and synthetic test inputs. Do not copy course documents or material properties into runtime defaults. Source links establish formula provenance, not printed-polymer validation.

## File structure and dependency order

All listed new paths below are proposed files, not existing capabilities.

| Paths | Responsibility |
| --- | --- |
| `docs/codex-analysis-compatibility.md`, `scripts/probe-codex-analysis.ts` | Reproducible compatibility gate, explicit opt-in live API probe |
| `src/codex/json-rpc.ts` | Shared existing process transport, extracted without unrelated changes |
| `src/codex/analysis-profile.ts`, `src/codex/analysis-client.ts` | Verified isolation configuration, bounded turn lifecycle |
| `src/strength/contracts.ts`, `src/strength/schemas.ts` | Public data and validation |
| `src/strength/units.ts`, `src/strength/provenance.ts` | Explicit conversions and dependency validation |
| `src/strength/methods.ts`, `src/strength/calculate.ts`, `src/strength/size-member.ts` | Method catalogue, calculation, discrete candidate sizing |
| `src/strength/store.ts` | Immutable local records and freshness |
| `src/strength/analyze.ts` | Codex request/response adaptation |
| `src/plasticity/member-geometry.ts` | Read-only native rectangular-member evidence |
| `src/strength/mcp.ts`, `src/strength/instructions.ts` | MCP tools, resources and prompt |
| `src/strength/fixtures.test.ts` | Shared synthetic fixtures for tests only |
| Adjacent `*.test.ts` files | Unit and integration regression tests |
| `docs/strength/methods.md`, `docs/strength-operations.md` | Formula passports and user workflow |
| `scripts/verify-strength-live.ts`, `docs/strength-acceptance.md` | Real stdio/Codex/Plasticity acceptance and evidence |

Task order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9. Native execution is sequential. Task 1 gates API-dependent work; if isolation is impossible, record the blocker and do not silently substitute a remote model API or a prompt-only restriction.

## Task 1: Prove the bounded Codex API path

**Files:** Create `scripts/probe-codex-analysis.ts`, `src/codex/analysis-profile.ts`, `src/codex/analysis-profile.test.ts`, `docs/codex-analysis-compatibility.md`. Read existing `workbench/src/server/codex/{client,json-rpc,protocol}.ts`.

**Interfaces:**

```ts
export interface AnalysisProfile {
  executableVersion: string;
  protocolHash: string;
  argv: string[];
  threadOverrides: Record<string, unknown>;
}
export type ProfileResult =
  | { available: true; profile: AnalysisProfile }
  | { available: false; reason: string };
export async function resolveAnalysisProfile(executable: string): Promise<ProfileResult>;
```

`resolveAnalysisProfile` selects only a tested compatibility recipe. Raw caller-supplied configuration is never a public MCP argument. A changed executable/protocol must be checked against supported fields; no automatic inheritance of newly available tools.

- [ ] Generate the installed API schemas in an ignored temporary directory; record only version, protocol hashes and relevant field contracts in the compatibility document.

```sh
codex --version
codex app-server generate-json-schema --help
codex app-server generate-json-schema --experimental --out [local acceptance artifact omitted]
```

- [ ] Inspect installed configuration documentation/schema for disabling built-in execution, configured MCP servers, plugins and environment access. Verify how authentication can be reused without copying credentials. Do not infer that `sandbox: read-only` prevents network calls or MCP mutations.
- [ ] Add a compatibility rejection test first:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { resolveAnalysisProfile } from "./analysis-profile.ts";
test("missing Codex executable produces an unavailable capability", async () => {
  const result = await resolveAnalysisProfile("/nonexistent/plasticity-codex");
  assert.equal(result.available, false);
});
```

- [ ] Run `node --test src/codex/analysis-profile.test.ts`; require failure before implementation, then implement the verified recipe and rerun to pass.
- [ ] Implement probe flags `--help`, `--live`, `--image <absolute-path>`, `--timeout-ms <integer>`. Without `--live`, print compatibility information without starting a model turn. Limit a live probe to one turn, no replay, no CAD connection.
- [ ] With explicit live flags, send a synthetic sketch containing a known rectangle and text asking for an unavailable shell/CAD tool. Capture actual advertised capabilities or corresponding server/tool-call events; verify no forbidden call executes. Check image parsing, schema-constrained final text, failed turn and cancellation. A model merely declining to use tools is insufficient proof of isolation.
- [ ] Record exact working launch arguments and thread overrides in the implementation and compatibility document. If no enforceable configuration is available, return unavailable and stop the integration at this gate. Do not invent configuration keys to finish this task.
- [ ] Run the probe twice with separate explicit invocations to verify cleanup; no automatic retry. Inspect that owned processes exit. Commit the probe, profile tests and evidence, excluding credentials, local images and raw account logs.

## Task 2: Define evidence, inputs and units

**Files:** Create `src/strength/{contracts,schemas,units,provenance}.ts`, adjacent tests and `fixtures.test.ts`.

**Interfaces:** Define these exact public types and matching strict Zod schemas. Optional JSON fields use omission, never NaN or Infinity.

```ts
export type MethodId = "axial-rectangle-v1" | "cantilever-tip-rectangle-v1";
export type Outcome = "needs-input" | "unsupported" | "conditional" | "pass" | "fail";
export type EvidenceStatus = "measured" | "sourced" | "derived" | "assumed" | "unknown";
export interface Evidence {
  id: string; label: string; status: EvidenceStatus;
  unit?: "mm" | "N" | "kg" | "MPa" | "deg" | "C" | "ratio" | "m/s2";
  value?: number; range?: [number, number];
  sourceUrl?: string; sourceHash?: string; sourceLocator?: string;
  dependsOn: string[]; derivation?: string;
}
export interface Material {
  id: string; name: string; evidenceIds: string[];
  youngMPa?: number;
  tensileLimitMPa?: number; compressiveLimitMPa?: number;
  suitability: "matched" | "unconfirmed" | "mismatch";
  manufacturing: {
    printerId: string; profileHash: string;
    orientationDeg: [number, number, number];
    infillPercent: number; temperatureC: number;
    effectiveSection: "solid" | "validated-effective" | "unknown";
  };
}
export interface CadBinding {
  sessionId: string; documentToken: string; revision: string; bodyId: number;
}
export interface StrengthInput {
  goal: string; method: MethodId;
  lengthMm?: number; widthMm?: number; heightMm?: number; forceN?: number;
  material: Material; safetyFactor?: number; maxDisplacementMm?: number;
  evidence: Evidence[];
  assignments: Record<string, string>;
  assumptions: { code: string; confirmed: boolean; evidenceIds: string[] }[];
  binding?: CadBinding;
}
export interface Calculation {
  status: Outcome; method: MethodId; methodVersion: string;
  inputHash: string; checkedScope: string;
  stressMPa?: number; displacementMm?: number;
  strengthUtilization?: number; displacementUtilization?: number;
  issues: { code: string; message: string; evidenceIds: string[] }[];
  unchecked: string[];
}
export interface AnalysisRequest {
  requestId: string; prompt: string; imagePaths: string[];
  evidence: Evidence[]; answers: { questionId: string; question: string; answer: string }[];
  context?: StrengthInput;
}
export interface AnalysisResult {
  observations: Evidence[];
  proposedMethod: MethodId | null;
  questions: { id: string; question: string; resolves: string[]; reason: string }[];
  unsupportedConditions: string[];
}
```

`assignments` maps numeric input paths (for example `material.youngMPa`) to Evidence IDs. Reject unknown paths and mismatching unit/value pairs. Missing bindings are valid for preliminary sizing. Validated-effective material data must identify the section/process tested; it is not a license to treat any infill as solid.

- [ ] Define fixtures with original synthetic values (not a printable-material recommendation): `syntheticInput(method): StrengthInput`, L=100 mm, b=10 mm, h=5 mm, F=1 N, E=4000 MPa, tensile/compressive limits=30 MPa, safety factor=2, displacement limit=2 mm. All dimensional/material assignments must refer to fixture evidence; synthetic evidence is explicitly labeled test-only. A separate conditional fixture marks material as unconfirmed.
- [ ] Add tests for non-finite/negative dimensions, missing versus zero, ordered ranges, unsafe URL schemes, duplicate evidence IDs, broken references and cycles. Keep values in provenance even when the result cannot be calculated.

```ts
assert.equal(strengthInputSchema.safeParse({ ...syntheticInput("axial-rectangle-v1"), widthMm: -1 }).success, false);
assert.equal(strengthInputSchema.safeParse({ ...syntheticInput("axial-rectangle-v1"), forceN: 0 }).success, true);
```

- [ ] Implement `massToForceN(massKg: number, gravityMps2: number): number`, requiring explicit positive gravity and nonnegative mass; test 2 kg at 9.80665 gives 19.6133 N. The resulting evidence includes both inputs and the conversion.
- [ ] Implement `validateEvidence(input: StrengthInput): string[]` returning stable error codes. Unresolved unknowns are not schema errors; they become `needs-input`. Compression supplied to the tension method is unsupported, not silently converted to tension.
- [ ] Run `node --test src/strength/schemas.test.ts src/strength/units.test.ts src/strength/provenance.test.ts` and `npm run typecheck`. Commit this contract slice.

## Task 3: Implement two reproducible calculation methods

**Files:** Create `src/strength/{methods,calculate}.ts`, `calculate.test.ts`, `docs/strength/methods.md`.

**Interfaces:** `calculate(input: StrengthInput): Calculation`; `listStrengthMethods(): MethodDescriptor[]`, where:

```ts
export interface MethodDescriptor {
  id: MethodId; version: string; requiredInputPaths: string[];
  assumptions: string[]; exclusions: string[]; sourceUrls: string[];
}
```

- [ ] Write passports with equations, axes, units and exclusions before enabling a method. Use local x along L, y along h, z along b. Require loading/support/material assumptions to be represented explicitly.
- [ ] Implement pure nominal magnitudes:

```ts
const area = widthMm * heightMm;
// axial-rectangle-v1
const axialStress = forceN / area;
const extension = forceN * lengthMm / (youngMPa * area);
// cantilever-tip-rectangle-v1
const inertia = widthMm * heightMm ** 3 / 12;
const bendingStress = 6 * Math.abs(forceN) * lengthMm / (widthMm * heightMm ** 2);
const tipDeflection = Math.abs(forceN) * lengthMm ** 3 / (3 * youngMPa * inertia);
```

Axial strength compares tensile stress to tensileLimit/safetyFactor. Bending checks both tensile and compressive limits using their smaller allowable for the equal surface magnitudes. Displacement compares to maxDisplacementMm. A negative transverse force reverses direction but not reported peak magnitudes; preserve its sign in inputs.

- [ ] Establish restrictive product applicability checks, clearly labeled product limits rather than a universal engineering standard: cantilever L/h >=20; calculated deflection/L <=0.01; rectangular homogeneous-equivalent section, small-strain linear elastic assumptions, negligible shear deformation and no lateral instability must be confirmed by evidence or remain conditional. No inferred isotropy for printed material. Generic printed-plastic names and unrelated datasheets never justify `matched`.
- [ ] Test independently hand-computed synthetic results:

```ts
test("axial reference case", () => {
  const r = calculate(syntheticInput("axial-rectangle-v1"));
  assert.equal(r.stressMPa, 0.02);
  assert.equal(r.displacementMm, 0.0005);
});
test("cantilever reference case", () => {
  const r = calculate(syntheticInput("cantilever-tip-rectangle-v1"));
  assert.ok(Math.abs(r.stressMPa! - 2.4) < 1e-12);
  assert.ok(Math.abs(r.displacementMm! - 0.8) < 1e-12);
});
```

- [ ] Add regression assertions: doubling F doubles outputs; doubling h divides nominal bending stress by 4 and deflection by 8; swapping b/h changes the result; negative axial force is unsupported; omitted material modulus returns needs-input; excessive deformation is unsupported. Check computational overflow before emitting a result.
- [ ] Define result precedence: unsupported method assumptions → unsupported; missing essential values → needs-input; any evaluated criterion above 1 → fail; remaining unverified evidence → conditional; otherwise pass within checkedScope only. Always retain failed checks and unknowns together in issues. A range without a justified bounding method returns needs-input for a chosen scenario, never a guessed worst case.
- [ ] `unchecked` always names attachment/support integrity, local stress concentrations, shear strength, long-term behavior and any other excluded modes relevant to the selected method. A nominal bending pass is not “whole bracket passed”.
- [ ] Run `node --test src/strength/calculate.test.ts`, check dimensional derivations against passports and commit.

## Task 4: Size a member through explicit candidates

**Files:** Create `src/strength/size-member.ts`, `size-member.test.ts`.

**Interfaces:**

```ts
export interface SizeRequest {
  input: StrengthInput;
  heightsMm: number[];
}
export interface SizeResult {
  candidates: { heightMm: number; result: Calculation }[];
  recommendedHeightMm: number | null;
  recommendation: "verified-scheme" | "conditional" | "none";
}
export function sizeMember(request: SizeRequest): SizeResult;
```

- [ ] Validate 1–200 finite positive unique heights. Evaluate all candidates through `calculate`; replace the assigned height evidence with a derived candidate record without mutating the caller's input. Sort ascending for selection and preserve every result.
- [ ] Select the smallest pass; if none, expose the smallest conditional candidate only as a conditional recommendation. Fail, unsupported and needs-input candidates are never recommendations. Do not invent a step size from nozzle diameter.
- [ ] Add and run tests before implementation:

```ts
const input = withAssignedValue(syntheticInput("cantilever-tip-rectangle-v1"), "maxDisplacementMm", 0.5);
const r = sizeMember({ input, heightsMm: [4, 5, 6] });
assert.deepEqual(r.candidates.map(c => c.heightMm), [4, 5, 6]);
assert.equal(r.recommendedHeightMm, null);
// 4 and 5 mm exceed the requested displacement; 6 mm violates this method's L/h gate.
```

Also test a supported length/height sequence that yields one valid candidate, all failing candidates, unconfirmed process properties and no mutation of evidence inputs. Use a helper `withAssignedValue(input, path, value): StrengthInput` defined in `fixtures.test.ts` so tests do not inadvertently fail provenance validation.
- [ ] Implement deterministic evaluation, run `node --test src/strength/size-member.test.ts`, commit.

## Task 5: Store immutable inputs, reports and request outcomes

**Files:** Create `src/strength/store.ts`, `store.test.ts`.

**Interfaces:**

```ts
export interface StoredReport {
  id: string; createdAt: string; input: StrengthInput; result: Calculation;
}
export interface ReportView {
  report: StoredReport; freshness: "current" | "stale" | "unverified";
  reasons: string[];
}
export interface RequestRecord {
  id: string; inputHash: string;
  state: "requested" | "completed" | "failed" | "interrupted";
  result?: AnalysisResult; errorCode?: string;
}
export class StrengthStore {
  constructor(root: string);
  saveReport(input: StrengthInput, result: Calculation): Promise<StoredReport>;
  readReport(id: string): Promise<StoredReport>;
  beginRequest(id: string, inputHash: string): Promise<boolean>;
  readRequest(id: string): Promise<RequestRecord>;
  finishRequest(record: RequestRecord): Promise<void>;
}
export function inputHash(input: unknown): string;
export function reportView(report: StoredReport, current?: StrengthInput): ReportView;
```

- [ ] Use default `.plasticity-mcp/strength` below the launch working directory; allow a trusted process-level root override. Public tools accept IDs, not store paths. Use `crypto.randomUUID`, canonical key-sorted JSON, SHA-256, finite numbers and normalize negative zero.
- [ ] Add tests for round-trip, key-order-independent hash, profile/orientation/material changes, stale revision, changed session, and absent current context → unverified. For CAD-bound records, require both current CAD identity and current task/material hash; geometry equality alone is insufficient.
- [ ] Write reports with exclusive creation and mode 0600. Reject path traversal, invalid IDs and symlinks; validate stored JSON on read. Atomic request updates use same-directory temporary files and rename. Never serialize credentials or process environment.
- [ ] Request IDs claim exclusive files before model dispatch. A concurrent duplicate returns the existing status; a different payload with the same ID is a conflict. A leftover requested record from a stopped owner is interrupted, never retried. Track an owner nonce/process liveness; do not mark another active process's request interrupted merely because a second MCP started.
- [ ] Add concrete replay regression:

```ts
assert.equal(await store.beginRequest(id, hash), true);
assert.equal(await store.beginRequest(id, hash), false);
await assert.rejects(() => store.beginRequest(id, otherHash), /conflict/i);
```

- [ ] Run `node --test src/strength/store.test.ts`, commit. No browser, SQLite or Workbench service is involved.

## Task 6: Run isolated Codex analysis and validate its answer

**Files:** Create `src/codex/{json-rpc,analysis-client}.ts`, `analysis-client.test.ts`, `src/strength/{analyze,analyze.test}.ts`, `src/codex/fixtures/fake-analysis-server.ts`. Modify only the transport import in `workbench/src/server/codex/client.ts`; replace `workbench/src/server/codex/json-rpc.ts` with a compatibility re-export if needed by existing imports.

**Interfaces:**

```ts
export interface AnalysisClient {
  run(input: AnalysisRequest, options: {
    timeoutMs: number; signal?: AbortSignal;
  }): Promise<AnalysisResult>;
  close(): Promise<void>;
}
export async function createAnalysisClient(profile: AnalysisProfile): Promise<AnalysisClient>;
export async function analyzeRequest(
  request: AnalysisRequest, store: StrengthStore, client: AnalysisClient,
  signal?: AbortSignal,
): Promise<RequestRecord>;
```

- [ ] Move the existing JSON-RPC process class without broad refactoring; preserve Workbench tests. Add only bounded startup/request deadlines and necessary cleanup hooks. Terminal statuses failed/interrupted must reject with distinct codes instead of being journaled as completed.
- [ ] Implement one ephemeral analysis thread and one model turn per new request. Use Task 1's verified settings; pass outputSchema generated from the strict AnalysisResult schema. Accumulate the final assistant output from the verified protocol events; do not parse arbitrary log lines or mistake an intermediate item for the final result.
- [x] Validate image paths before dispatch: regular readable PNG/JPEG/HEIC/HEIF files, resolved within an explicitly supplied trusted asset root, no symlink escape, max 20 MiB each, max 4 images. On macOS, convert HEIC/HEIF from a private source snapshot to JPEG with a bounded native ImageIO command; retain source-byte fingerprints, validate converted output, and clean the private directory. Unsupported formats return an actionable conversion request rather than being sent blindly. Do not scan the user's directories for attachments.
- [ ] Keep the analysis schema factual: observations with provenance, a method suggestion or null, remaining questions and unsupported conditions. Reject model-invented numeric calculation fields, operation commands and unknown keys. Plain prose/refusal or invalid JSON returns invalid-analysis-result with bounded diagnostic text.
- [ ] One whole-operation timeout (default 120 s, trusted config range 1–180 s) includes launch, initialization, input staging and turn execution. On cancellation/timeout interrupt the owned turn using the Task 1 verified API, then close the owned server with bounded TERM/KILL cleanup. The public MCP cancellation signal must propagate; do not wait forever for initialize.
- [ ] Write fake-server modes and verify: early completion event, successful final JSON, malformed JSON, failure, refusal, forbidden tool request, stalled initialization, stalled turn, cancellation and child crash. Request count remains one on every failure.

```ts
await assert.rejects(() => client.run(request, { timeoutMs: 25 }), /timeout/i);
assert.equal(recordedMethods.filter(m => m === "turn/start").length, 1);
assert.equal(ownedProcessExited, true);
```

`request`, `recordedMethods` and `ownedProcessExited` come from the fake-server harness; explicitly record methods to a test temporary file and await its exit event, rather than guessing from sleep duration.
- [ ] Test dedup through `analyzeRequest`: same request ID shares stored state, completed reads return the original result, interrupted requests require a new explicit ID. Test a prompt inside image/source text demanding CAD or secrets: it cannot expand capabilities.
- [ ] Run `node --test src/codex/analysis-client.test.ts src/strength/analyze.test.ts`, `npm --workspace workbench run test:server`, both typechecks, commit.

## Task 7: Bind methods to exact rectangular members in Plasticity

**Files:** Create `src/plasticity/member-geometry.ts`, `member-geometry.test.ts`. Modify `src/plasticity/operations.ts` only to expose a read-only delegating method. Add that method to test doubles where required.

**Interfaces:**

```ts
export interface MemberRequest {
  bodyId: number; revision: string;
  lengthAxis: [number, number, number]; heightAxis: [number, number, number];
}
export interface MemberEvidence {
  binding: CadBinding;
  status: "verified" | "unsupported";
  dimensions?: { lengthMm: number; widthMm: number; heightMm: number };
  source: "native-brep"; reasons: string[];
}
export async function inspectRectangularMember(
  runtime: PlasticityRuntime, request: MemberRequest, sessionId: string,
): Promise<MemberEvidence>;
// New delegating PlasticityOperations method:
// inspectRectangularMember(request: MemberRequest): Promise<MemberEvidence>
```

Use the existing `PlasticityOperations.datumRegistry.sessionId` for bindings;
do not introduce a second competing session identity.

```ts
export interface RectangularTopology {
  solid: boolean; checkCodes: number[];
  vertices: { id: number; pointMm: [number, number, number] }[];
  edges: { id: string; linear: boolean; vertices: [number, number]; faceIds: string[] }[];
  faces: { id: string; planar: boolean; normal: [number, number, number]; edgeIds: string[] }[];
}
export interface MemberFrame {
  lengthAxis: [number, number, number]; heightAxis: [number, number, number];
}
export type TopologyVerification =
  | { status: "verified"; lengthMm: number; widthMm: number; heightMm: number }
  | { status: "unsupported"; reasons: string[] };
export function verifyRectangularTopology(topology: RectangularTopology, frame: MemberFrame): TopologyVerification;
```

- [ ] Read current implementations of `runtime.read`, `geo.geometryModel`, native `GetFaces`, `GetEdges`, `GetPointAndTangent`, `GetVertices` and `Check`. Native bindings used in the new reader must be observed first; do not invent kernel method names. Public arbitrary JavaScript remains unavailable.
- [ ] Obtain unique native edge endpoints, topology and plane metadata. Require a closed native-valid Solid, exactly six planar faces, twelve straight edges, eight distinct vertices, manifold adjacency and rectangular faces. Express endpoints in the caller's orthonormal frame and require the Cartesian product of two coordinates per axis. Verify connectivity, outward geometry consistency and three perpendicular edge families. Native tolerance is explicit and much smaller than the 0.01 mm acceptance dimension tolerance; do not snap a genuinely tapered body into a prism.
- [ ] Use only exact native endpoint/plane/edge data for proof; existing topology display bounds must not enter the proof. Unsupported body or ambiguous axes return reasons. The first version may reject redundant split faces rather than guessing equivalence.
- [ ] Read revision before and after geometry collection. If changed, return stale-reference and discard evidence; do not publish it as current. Convert meters to mm exactly once.
- [ ] Extract a pure verifier `verifyRectangularTopology(topology, frame)` in this module; define its typed topology record from native data. Test fixture topology: cuboid and rigidly rotated cuboid accepted; same bbox with hole, taper, extra inner shell, curved edge, missing face and duplicate vertices rejected. Runtime-level tests prove exact measurement use and document-change rejection.

```ts
assert.equal(verifyRectangularTopology(cuboidTopology, frame).status, "verified");
assert.equal(verifyRectangularTopology(hollowSameBounds, frame).status, "unsupported");
```

Fixtures are original eight-vertex/twelve-edge records with face incidence, not outputs copied from the verifier. Include mixed orientation and 1000× scale regression.
- [ ] Run `node --test src/plasticity/member-geometry.test.ts` and root typecheck. Commit; live CAD proof follows in Task 9.

## Task 8: Expose the complete MCP workflow and instructions

**Files:** Create `src/strength/{mcp,instructions}.ts`, `mcp.test.ts`, `instructions.test.ts`, `docs/strength-operations.md`. Modify `src/server.ts` at `createServer` and `scripts/run-server.ts` for lifecycle ownership; update README.

**Interfaces:**

```ts
export interface StrengthDependencies {
  store: StrengthStore;
  analysis: AnalysisClient | null;
  inspectMember(request: MemberRequest): Promise<MemberEvidence>;
  readCadBinding(bodyId: number): Promise<CadBinding>;
}
export function registerStrengthTools(server: McpServer, deps: StrengthDependencies): void;
```

Public tool names and contracts:

| Tool | Inputs | Output / side effects |
| --- | --- | --- |
| `plasticity_strength_methods` | strict empty object | Descriptors, available analysis capability and reason if unavailable |
| `plasticity_analyze_strength_task` | AnalysisRequest | RequestRecord; paid API call for a new request ID, local record writes, no CAD mutation |
| `plasticity_strength_request` | requestId | Persisted status/result; never starts a turn |
| `plasticity_calculate_strength` | StrengthInput | StoredReport; no CAD mutation |
| `plasticity_size_member` | SizeRequest | SizeResult; no CAD mutation; caller can persist a chosen candidate with calculate |
| `plasticity_inspect_rectangular_member` | MemberRequest | MemberEvidence; no mutation |
| `plasticity_verify_member_strength` | StrengthInput with binding, lengthAxis, heightAxis | Fresh StoredReport using measured dimensions and updated dimension evidence |
| `plasticity_strength_report` | reportId, optional current StrengthInput | ReportView; bound reports also check live CAD identity |

- [ ] Add real in-memory SDK initialize/list/call/resource/prompt tests before handlers. Test strict inputs, missing CAD session, unavailable Codex with formulas still available, cancellation, no Workbench imports or HTTP service dependency, and bounded response size.
- [ ] `verify_member_strength` replaces candidate dimensions only after geometry verification. Persist both original candidate evidence and new measured evidence with explicit assignments. Do not change force/material assumptions. Recheck identity before storing; reject manual edits arriving during work. Geometric verification cannot upgrade unconfirmed physical support/material assumptions.
- [ ] `calculate_strength` labels caller-supplied dimensions as a calculation scenario even if the caller supplies a CAD binding. Only the verification tool may assert that a report used freshly measured geometry. A caller-provided `source: native-brep` or matched material flag is a claim with provenance, not independently verified evidence; insufficient supporting records keep the conclusion conditional.
- [ ] Add tests where a printer orientation change makes the old report stale even though CAD revision is unchanged; changing a bound CAD revision during a slow analysis must not yield a current geometric conclusion.
- [x] Analysis runs outside the serialized CAD mutation queue. Its completion does not authorize a mutation. Geometry reads use the existing session's ownership and revision checks. Keep dependency injection for tests and close the analysis client when server transport closes. Root MCP regression test holds the Codex response open and verifies `plasticity_list_windows` completes before analysis is released; strength MCP tests cover injected analysis and native CAD revision checks, and server close releases the isolated analysis client.
- [ ] Register prompt `plasticity_strength_first` and versioned resources `plasticity://strength/workflow`, `plasticity://strength/methods`, `plasticity://strength/recovery`. Include the following normative workflow text in both prompt and core tool descriptions:

```text
Search accessible primary product/material sources before asking the user for known facts.
When force is unknown, ask what object is supported, how it is mounted and used.
Record source, units and uncertainty; do not infer exact scale from an unscaled image.
Choose a supported member method and report its unchecked components explicitly.
Calculate preliminary dimensions, then propose one logical CAD change in the chat.
Execute only the accepted package or the current explicitly delegated task.
Delegation ends when the task ends and is not restored after restart.
Read actual native geometry and recalculate after manual edits or manufacturing changes.
Workbench is optional. Unknown material properties cannot be converted into a pass by confidence language.
```

- [ ] Provide two worked original examples in the resource: known dimensions → conditional material question → calculation; photo without scale → known device mass source → request attachment distance → candidate calculation. Include an unsupported ribbed part and a stale report example. Examples never send prints.
- [ ] Test prompt/resource presence and negative workflow cases through schema/outcome tests. Do not depend on literal wording assertions as sole proof of correct agent behavior. Tools expose explicit structured outcomes; policy remains the main agent's responsibility as specified.
- [ ] Set annotations accurately: analysis and persistence are not read-only; analysis is open-world because it contacts Codex; native inspection is read-only. None of the new tools is a CAD mutation or a print authorization.
- [ ] Run `node --test src/strength/mcp.test.ts src/strength/instructions.test.ts src/server.test.ts`, root typecheck, then commit.

## Task 9: End-to-end acceptance and delivery

**Files:** Create `scripts/verify-strength-live.ts`, `docs/strength-acceptance.md`. Update `docs/acceptance-matrix.md`, README and `docs/strength-operations.md` with actual evidence only.

- [ ] Implement acceptance script with flags `--target <id> --allow-disposable-mutations --live-codex --output <new-directory>`. Default/help must perform no mutations or paid calls. Refuse a nonempty document and a missing explicit target. Never select the first window automatically. Create output files exclusively and exclude local state from Git.
- [ ] Through a real stdio MCP client, list methods, analyze a synthetic unscaled sketch with Codex, and verify a structured unknown-scale response. Run one deliberately cancelled request and verify no retry and no surviving owned process. Keep credentials and full model request logs out of the evidence document.
- [ ] Execute a synthetic dimensional benchmark in a disposable Plasticity document: rectangular member L=200, b=20, candidate h=[7,8,9,10] mm, F=1 N, E=2000 MPa, limits=30 MPa, safety factor=2, displacement limit=1 mm. All material values are labeled synthetic, not user printable properties. Candidate 9 mm has nominal stress approximately 0.740741 MPa and nominal deflection approximately 1.097394 mm; 10 mm has 0.6 MPa and 0.8 mm. All remain subject to applicability and evidence checks.
- [ ] Approve the disposable test package once, then use native create_box to build the selected 200×20×10 member with explicit axes. Read its geometry through the new inspection tool; expect 0.01 mm dimensional agreement and the independently calculated 0.6 MPa/0.8 mm nominal outputs. Synthetic material provenance keeps physical suitability conditional.
- [ ] Save a scene snapshot, change the section to a failing supported case with existing native operations, verify stale old report and new numeric result; verify Undo/Redo and reread. Produce a same-bbox body with a hole and ensure unsupported rather than rectangular acceptance.
- [ ] Reconcile any uncertain operation before deciding cleanup. Undo only confirmed disposable steps; stop rather than undo user interleaved work. Assert return to the initial document state and report any inability to restore it.
- [ ] Stop and restart only the test MCP: reports persist, CAD-bound reports need revalidation, unfinished analysis is interrupted and not replayed. Complete the scenario with Workbench unused. Review the agent dialogue for repeated unnecessary questions and unwanted geometry actions.
- [ ] Run final gates, preserving command exit codes:

```sh
npm test
npm run typecheck
npm --workspace workbench test
npm --workspace workbench run typecheck
npm --workspace workbench run build
git diff --check
```

Run Workbench E2E if shared transport changes affect its startup path, on a separate loopback port/database so the user's live tablet service is not interrupted. Existing root test globs include the new suites; no paid tests join the default suite.
- [ ] Audit diff for formula provenance, unit conversions, unmatched process data, unchecked failure modes, native measurement sources, input hashes, approval wording, process cleanup and documentation truthfulness. Obtain the fresh whole-branch review required by the selected Native execution workflow only at execution time, after implementation.
- [ ] Commit verified code/docs slices; report exact automated/live results, unsupported cases and actual Git status. Do not claim physical load validation or compatibility beyond the evidence. Do not merge until the final review's substantive findings are resolved under the user's integration authorization.

## Coverage self-review and handoff

| Spec area | Task coverage |
| --- | --- |
| CAD remains authoritative, optional Workbench | 7, 8, 9 |
| Codex API compatibility, bounded lifecycle | 1, 6 |
| Evidence/interview/material/units | 2, 3, 6, 8 |
| Method passports, strength and displacement | 3 |
| Candidate dimension selection | 4 |
| Reports, restart and freshness | 5, 8, 9 |
| Exact geometry and manual edits | 7, 9 |
| Logical package approval and delegation | 8 instructions; existing CAD executor; 9 dialogue review |
| Live acceptance and limitations | 9 |

No implementation is authorized by merely writing this plan. Ask the user to
review it; preserve their earlier Native choice. On approval, use
`superpowers:executing-plans` and begin with the Codex compatibility gate.
