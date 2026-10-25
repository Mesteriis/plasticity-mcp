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
| Completed passing fixtures | 62 | 70 |
| Failing or blocked fixtures | 4 | 4 |
| Tools with success in an application-connected passing fixture | 161 | 204 |
| Tools attempted only in unaccepted fixtures | 7 | 7 |
| Tools without a recorded application-connected live call | 203 | 160 |

The different counts reflect the executed scenarios, not a claim that the
remaining tools fail or that 26.1 has lost support. An additional host-only stdio
fixture passed for three CSV/test-store tools. It uses synthetic tensile and
fracture CSV files, verifies units, provenance and preview isolation, and never
connects to Plasticity; its coverage is recorded separately in the matrix.

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

## Resolved native failures

The final identical six-scenario regression passed **6/6 on each application
copy**: opposite-corner, adjacent-corner and circular-edge vertex offsets; full
face construction including hollow-shell unjoin; topology caching with native
reopen; and split-solid/print-joint recipes. The 26.1 run used its default
background throttling. No manual confirmation was needed in these final runs.

### Hollow-shell unjoin

The 26.2 shell and face unjoin factories both returned
`PK_FACE_remove_to_solid_bodies` / `PK_ERROR_general_body (1071)` for the valid
closed hollow Solid. The adapter now uses the native face-extraction factory
once per face and replaces all input shells in one native factory commit. The
legacy shell factory remains unchanged. Both versions passed twelve independent
one-face Sheets, exact topology and coordinates, one Undo step, Redo, and cleanup.

### Shell-vertex offset

The 26.2 station walker failed on the branching shell vertices. Its adapter now
enumerates the actual incoming/outgoing native incident-edge collections, uses
native carrier `GetLength` queries to solve each requested arc-length station,
and submits one native `Operation.SplitEdges` report. Existing factory commit,
constraint/remap and result hooks remain in place. The 26.1 calculate path is
unchanged. Incident-edge descriptors now combine both directed collections and
deduplicate their public edge references.

Both versions passed opposite corners, adjacent corners sharing an edge, and a
half-cylinder vertex incident to a circular edge. They preserved stable body ID,
name, volume and centroid, with one history step and correct Undo/Redo. Unit
coverage also checks nonlinear length/parameter inversion, shared stations,
legacy behavior and pre-operation distance rejection. This is not live evidence
for every spline or degenerate-edge configuration.

### Native document-open timeout

Accessibility inspection identified the actual blocker: Plasticity's native
**unsaved changes** confirmation. A raw saver copy did not finish the native
save lifecycle. Window focus was a symptom of that modal prompt, not the cause;
the diagnostic focus guard was removed.

`plasticity_open_document` first writes its validated exclusive backup, then
associates the current document with that explicit backup path and calls native
Editor save before native open. The previous document file is not overwritten.
If native opening fails after saving, the current scene remains associated with
the saved backup. Tests verify ordering, save failure, untouched prior files and
that open is never invoked when backup saving fails. Native cache/reopen and
rational STEP/SVG acceptance subsequently passed on 26.1 without a modal prompt.

## Areas still unverified

| Area | 26.1.3 | Experimental 26.2.1 | Disposition |
| --- | --- | --- | --- |
| Rendered measurements, section overlays, group screenshots | Earlier run blocked by hidden renderer / unavailable visible window | Same | Geometry-only measurements passed; those visual fixtures were not reaccepted |
| Manual UI edits | Requires interactive gesture | Same | Unattended execution is rejected before CAD mutation |

The continued catalog pass also completed the split-solid/print-joint suite on
both versions, including volume conservation, native validation and cleanup.
The rational STEP/SVG fixture now passed on both copies in a fresh document.

The official unmodified 26.2.1 distribution still fails the inspector-fuse
preflight. This audit does not change its startup protection. Workbench, external
reference services, FEM engines, slicers and physical manufacturing require
their own live evidence; unit tests and catalog availability do not supply it.
Unobserved tools in the matrix remain explicitly unaccepted, including native
operations without a dedicated completed fixture.

## Automated gates

`npm test`: 1405 passed, 0 failed. `npm run typecheck`: passed.
Workbench: 90 tests passed, typecheck passed, production build passed. The
production build retains its advisory warning about chunks larger than 500 kB.
Regression tests also cover the native factory adapters, directed vertex
adjacency and save-before-open lifecycle. These gates are separate from live CAD
acceptance and do not turn unobserved catalog entries into passes.
