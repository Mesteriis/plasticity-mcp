# Catalog audit on disposable Plasticity copies

Date: 2026-10-25. The starting point is merged PR #12
(`8648937d15620576e36eb6efa25694cd08c8015d`). Both application bundles are
separate experimental copies. The installed application and system security
settings were not changed.

## What the results mean

The [machine-readable matrix](plasticity-26-2-catalog-audit.json) enumerates all
371 tools returned by the production MCP catalog. Each version has an independent
status for each tool:

- `accepted-fixture`: a successful call occurred in a completed passing fixture.
- `negative-only`: only rejection paths were checked in passing fixtures.
- `attempted-unaccepted`: the call appeared only in a failing fixture.
- `not-observed`: no call was recorded in the audited fixtures.

Fixture IDs refer to the per-version fixture lists in that file.
A successful fixture validates its stated inputs and assertions. It does not
establish support for every argument combination. Calls from failed fixtures,
heap metadata probes, schema discovery, and the earlier PR #12 evidence do not
inflate these counts. Direct native-operation fixtures are listed separately
from their public MCP tool coverage, which requires an actual stdio call.
Machine-local endpoints, window identifiers, application profiles, raw arguments,
and raw runtime dumps are excluded from the checked-in matrix.

## Recorded coverage

| Result | 26.1.3 copy | Experimental 26.2.1 copy |
| --- | ---: | ---: |
| Completed passing fixtures | 57 | 65 |
| Failing or blocked fixtures | 6 | 6 |
| Tools with success in a passing fixture | 155 | 193 |
| Tools attempted only in unaccepted fixtures | 7 | 12 |
| Tools without a recorded live call | 209 | 166 |

The different counts reflect the executed scenarios, not a claim that the
remaining tools fail or that 26.1 has lost support.

## Compatibility fixes found by the audit

- Deformation uses native `source`/`target` inputs on 26.2; 26.1 retains
  `sourceFace`/`targetFace`. Knot insertion and segment splitting use the new
  public parameters, preserving the legacy kernel bridges on 26.1.
- Control-point conversion uses a geometry command on 26.2 so its committed
  result participates in native Undo/Redo.
- Reference meshes use the appropriate native object type on each version.
  Group moves install their selection inside the owned command, avoiding a
  second native interactive move command when a mesh is selected.
- Interference reads 26.2 Boolean reports and temporary geometry contracts.
  Overlap, touching, and separated boxes passed, including unchanged persistent
  state and temporary cleanup. The same fixture passed on 26.1.
- Radius dimensions resolve the actual native edge snap. Persistent face-center,
  edge-midpoint, and vertex dimensions use the real 26.2 point batch; 26.1 keeps
  its existing snap cache. Exact values, topology references, Undo/Redo and
  cleanup passed on both versions.
- Surface refinement uses the native face domain as the carrier domain only
  when `IsUntrimmed()` proves equality. Trimmed faces without the native carrier
  domain API retain an unavailable result instead of a guessed domain.
- Arbitrary sections adapt temporary view jobs and geometry insertion. The
  temporary Database refers to the temporary Editor on 26.2. Exact section
  properties and cleanup passed on both versions; section and plate strength
  also passed on 26.2.

## Acceptance harness corrections

Mutation responses contain compact body summaries. Acceptance scripts now read
revision-matched body details and all body pages, rejecting stale pages,
duplicate identities and pagination cycles. This also repairs the pre-existing
20-body fixture failure on 26.1.

STEP and Parasolid imports return import reports. Their scripts now read the
resulting document explicitly and verify the report's document/revision identity.
The rectangle fixture reads `regionCount` from the current diff contract.
The composite SVG fixture verifies the exact cubic representation against native
samples instead of requiring the obsolete chord approximation. The circular
SVG fixture identifies its guarded disposable scene by types and names instead
of assuming globally assigned body IDs.

The topology-distance fixture accepts `--geometry-only`. This preserves all
mutation guards, numerical/topology assertions, Undo/Redo and cleanup, while
recording `viewportValidation: "not-run"`. The default retains its full rendered
annotation assertions. Manual UI edits now reject non-interactive stdin before
creating output or changing CAD.

## Remaining failures and unverified areas

| Area | 26.1.3 | Experimental 26.2.1 | Disposition |
| --- | --- | --- | --- |
| Unjoin faces of the valid hollow-box fixture | Passed | Native `PK_FACE_remove_to_solid_bodies`, `PK_ERROR_general_body (1071)` | Unresolved; no geometry workaround or weaker assertion was introduced |
| Shell-vertex offset fixture | Passed | Native `failed to locate split stations` | Unresolved after resolving real vertex snaps |
| Rendered measurements, section overlays, group screenshots | Current run blocked by hidden renderer / no visible macOS window | Same | Geometry-only measurements passed; current visual evidence is not accepted |
| Manual UI edits | Requires real interactive gesture | Same | Non-interactive execution is rejected before CAD mutation |
| Cached topology, linked source edits and native reopen | Latest rerun timed out during native open; outcome uncertain, subsequent mutations stopped | Passed | Earlier 26.1 pass does not replace the current timeout |
| Rational STEP/SVG fixture | Fresh clean-history precondition not met in the combined run | Passed in a fresh document | 26.1 rerun remains pending |

The official unmodified 26.2.1 distribution still fails the inspector-fuse
preflight. This audit does not change its startup protection. Workbench, external
reference services, FEM engines, slicers and physical manufacturing require
their own live evidence; unit tests and catalog availability do not supply it.
Unobserved tools in the matrix remain explicitly unaccepted, including native
operations without a dedicated completed fixture.

## Automated gates

`npm test`: 1399 passed, 0 failed. `npm run typecheck`: passed.
Workbench: 90 tests passed, typecheck passed, production build passed. The
production build retains its advisory warning about chunks larger than 500 kB.
A focused discovery regression also verifies that 26.2 geometry conversion
resolves to the native history command. These gates are separate from live CAD
acceptance and do not turn unobserved catalog entries into passes.
