# Plasticity 26.2.1 experimental adapter

Validated on macOS Apple Silicon on 2026-10-25, alongside a separate copy of
26.1.3. The installed application was not changed. This is adapter compatibility
for a prepared experimental copy, not support for launching the unmodified
26.2.1 distribution.

## Startup and security prerequisites

The official 26.2.1 Electron Framework disables
`EnableNodeCliInspectArguments`. The launcher still fails its read-only fuse
preflight for that bundle. Neither the server nor either launcher changes fuses,
entitlements, signatures, system security settings, or the installed application.

The separately authorized local experiment enabled only that inspector fuse in
a disposable copy, ad-hoc signed the modified framework and containing bundle,
and supplied `com.apple.security.cs.disable-library-validation` to that copy and
its helper bundles where needed. Vendor native modules and helpers already
carrying that entitlement were preserved. Changing the copy's signature and
library-validation protection is a separate security decision; those changes
are not performed or enabled by an MCP option.

For an already prepared copy:

```sh
npm run start:plasticity-isolated -- --application /absolute/Experimental/Plasticity.app
```

This allocates a fresh temporary profile and distinct loopback inspector/CDP
ports. Set `PLASTICITY_CDP_URL` to the returned renderer endpoint when starting
MCP. Call `plasticity_list_windows` and explicitly select that copy's window.
The default application and 26.1.3 startup remain available.

Electron 42 can begin with an empty main script, without the old entry pause.
The launcher now uses `beforeScriptExecution` instrumentation to find a usable
module before `app.isReady()`. It removes that breakpoint and resumes the app
on both success and rejection. Remote debugging remains bound to loopback.

## Adapter changes

- 26.1.3 retains discovery from command-log closures. When the renderer exposes
  no `[[Scopes]]`, the new route queries live functions and objects, requires a
  unique native Editor and kernel namespace, and retains only resolved bindings.
  Ambiguous constructors are omitted, rather than selected arbitrarily.
- Four UI enums are identified by complete verified scalar contracts. Kernel
  exports come from the actual live namespace; Three.js types come from the
  editor's viewport camera, with a checked Vector2 prototype.
- A call-local API view maps `geo.read.geometryModel`, editor stores, native
  geometry lookups, and generic selection to the legacy access contract.
  Factories and commands receive the real Editor. Its database, geometry,
  prototypes and selection objects are not patched.
- Explicit aliases cover unified primitive, cut, realization, control-point,
  bridge and edge-dissolve factories. Changed control-point selection, slide
  directions and bridge endpoints are adapted separately. Open Wire vertices
  resolve to a unique adjacent native segment, preserving its endpoint parameter.
- Control-point ID zero is accepted by MCP, as returned by 26.2.1. Negative,
  duplicate, unknown and stale references remain rejected.

## Catalog audit follow-up

The subsequent [catalog audit](plasticity-26-2-catalog-audit.md) records every
registered tool with independent per-version evidence and explicit gaps. It
adds deformation, refinement, reference meshes, interference, dimensions,
sections, fastener workflows and SVG checks. The follow-up fixes hollow-shell unjoin and shell-vertex offset, and resolves the
26.1 native-open confirmation timeout. The final six-scenario regression passed
on both versions; the audit does not claim acceptance of all 371 tools.

The next continuation covers patterns, direct rectangle dimensions, Wire
reversal/unjoin and hole recipes. It also corrects whole-body mirror: native
`move` is a numeric mirror offset, so replacement mode uses zero offset and a
source-deletion transaction inside the same command. Copy and replacement are
checked separately for bodies beside and crossing the mirror plane. The audit
records the executed cases and their per-version results.

Nine further Sheet/blend/feature scenarios passed on both copies. Region patch
clears source selection inside its command to prevent an awaiting interactive
move after commit. Face-property validation accepts native periodic curved
faces with equal total/inner loop counts, while retaining planar outer-loop
and native-validity checks. The [audit](plasticity-26-2-catalog-audit.md)
records exact areas, volumes, bore depths, Undo/Redo and remaining gaps.

The profile/closure continuation adds signed Wire and Region offsets, endpoint
extension, edge extraction, Region loft/sweep, Sheet joining/capping and
separate Solid creation from a closed Sheet. Its guarded cases check source
preservation, native geometry, one history step, Undo/Redo and cleanup. No
production adapter change was required for this group; the audit records each
version's completed fixtures.

The alignment/projection continuation passed nine scenarios on both versions,
including translational vertex/edge/cylinder alignment, Line projection,
analytic body-imprint/dissolve, Sheet edits, draft and semantic-selection
rebinding through move/Undo/Redo. Its strict circular curve-imprint case remains
unaccepted on both versions: native Check passes, but SPCurve length and nominal
mass/bounds do not meet the stated qualification. This was not classified as a
26.2 adapter regression; tolerances were retained and the matrix records the
failed case separately.

## Initial live coverage

The same checkout and production adapter were used against both disposable
application copies. Every listed final run passed; fixtures were undone or the
saved baseline was reopened.

| Scenario | 26.1.3 copy | Experimental 26.2.1 copy | Entry point |
| --- | --- | --- | --- |
| Fresh isolated startup, renderer discovery | Passed | Passed | `ensurePlasticityCdp` |
| Box, sphere, cylinder, exact volumes, native Check | Passed | Passed | Production operations |
| Move, Undo/Redo, STEP, groups, native save/open | Passed | Passed | Production operations |
| Curve selection, slide, move, rotate, scale, delete, exact B-Rep, Undo/Redo | Passed | Passed | `accept:native-curve-control-points`, stdio MCP |
| G0–G3 curve bridge, vertex bridge, shell-edge bridge | Passed | Passed | `accept:native-curve-bridge`, stdio MCP |
| Linked instances, transforms, realization, independent Solid/Sheet duplication | Passed | Passed | `accept:instances`, stdio MCP |
| Group hierarchy, activation, placement, selection, visibility, locks, viewport checks | Passed | Passed | `accept:groups`, stdio MCP |
| Move, extend, offset, dissolve edges, exact topology, Undo/Redo | Passed | Passed | `accept:native-edge-edits`, stdio MCP |
| Hidden bodies/groups after native reopen, viewport pixel comparison, locks and Undo/Redo | Passed | Passed | `accept:visibility-after-load` |
| Face cut: two valid 500 mm³ solids; G2 surface bridge: valid Sheet, 3 faces/10 edges | Passed | Passed | `accept:native-store-factories` |

The sphere additionally passed its standalone stdio acceptance on 26.2.1.
Discovery resolved all 212 literal native bindings requested by the adapter.
That binding count does not establish live acceptance for the entire tool
catalog. Existing historical 26.1.3 acceptance entries retain their version and
scope; unrelated CAD tools, all import/export formats, Workbench integrations,
slicers and physical manufacturing were not reaccepted on 26.2.1.

Run a suite against an explicitly selected **empty disposable document**, with
a new output directory:

```sh
PLASTICITY_CDP_URL=http://127.0.0.1:PORT npm run accept:native-store-factories -- \
  --target WINDOW_ID --allow-disposable-mutations --output /absolute/new-evidence
```

The acceptance scripts for groups, instances, curve bridges and edge edits now
fetch revision-matched `plasticity_body_info` when mutation results contain
compact summaries. The helper leaves validation/measurement responses intact
and rejects document, revision or body-ID mismatches.

## Initial automated checks (PR #12)

On PR #12, `npm test` passed 1390 tests, and `npm run typecheck` passed.
Workbench passed 90 tests, its typecheck, and its production build. The build
retains its advisory warning about chunks larger than 500 kB. These checks do
not run Plasticity or replace the live evidence above.
