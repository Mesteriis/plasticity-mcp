# Catalog audit on disposable Plasticity copies

Date: 2026-10-26. The current continuation starts from merged PR #20
(`013d22ab77a0d2477532b7267cb55977eb67452a`); earlier fixtures start from PR #12. Both application bundles are
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
| Completed passing fixtures | 130 | 138 |
| Failing or blocked fixtures | 7 | 7 |
| Tools with success in an application-connected passing fixture | 237 | 279 |
| Tools attempted only in unaccepted fixtures | 10 | 10 |
| Tools without a recorded application-connected live call | 124 | 82 |

The different counts reflect the executed scenarios, not a claim that the
remaining tools fail or that 26.1 has lost support. An additional host-only stdio
fixture passed for three CSV/test-store tools. It uses synthetic tensile and
fracture CSV files, verifies units, provenance and preview isolation, and never
connects to Plasticity; its coverage is recorded separately in the matrix.

## Core-operation continuation

The identical seven-case suite passed **7/7 on each experimental copy**. No
production adapter change was needed for these cases.

`npm run accept:native-core-catalog -- --target ID --allow-disposable-mutations
--case CASE --output NEW_DIRECTORY` selects one guarded scenario:

| Case | Geometry assertions |
| --- | --- |
| `block-dimensions` | Resize a 10 mm cube to 20 × 15 × 12 mm; volume 3600 mm³ |
| `radius-dimension` | Resize an R5, 10 mm cylinder to R3; volume 90π mm³ |
| `offset-face` | Offset the top cube face by 2 mm; volume 1200 mm³ |
| `extrude-face` | Preserve the original cube and create a separate 10 × 10 × 2 mm Solid; volumes 1000 and 200 mm³ |
| `chamfer` | Chamfer one 10 mm edge by 2 mm; volume 980 mm³ |
| `pipe` | Preserve a 20 mm straight Wire; create a solid sweep with exact R2 circular ends and 4 × 4 × 20 mm bounds |
| `helix` | R5, two turns over 10 mm; native segment length √(400π² + 100) and 10 × 10 × 10 mm bounds |

Each case checks one native history step, Undo, Redo with stable result IDs,
and restoration of the empty snapshot. Solid outputs also require native
validation. Analytic solid volumes use a 0.0001 mm³ tolerance; helix length and
bounds use 0.001 mm. The native pipe has a B-Spline swept side, rather than an
analytic Cylinder face. Its volume uses an explicit 0.01 mm³ tolerance against
80π mm³, while exact end circles are checked separately. This does not accept
hollow-pipe offset surfaces or establish analytic-cylinder equivalence.

Initial authored checks incorrectly assumed that face extrusion and pipe
creation replace their sources, used Solid edges to measure a Wire, and treated
the native pipe sweep as an analytic cylinder. Those runs were not accepted;
only corrected, completed passing fixtures contribute to the matrix.

## Patterns, curves and hole recipes

Twelve scenarios completed successfully on each experimental version.

`npm run accept:native-patterns-recipes -- --target ID --allow-disposable-mutations
--case CASE --output NEW_DIRECTORY` selects one of twelve guarded cases:

- `mirror-copy`, `mirror-move`, `mirror-crossing-copy`, `mirror-crossing-move`:
  complete reflected boxes, with separate copy/replacement checks for boxes
  beside or crossing the specified plane; exact volumes and mass centroids.
- `rectangular-pattern`: six boxes at a 3 × 2 grid with 8 and 10 mm spacing.
- `radial-pattern`: four boxes at 90° intervals, including the source position.
- `rename`: same body identity, geometry and new name.
- `rectangle-dimensions`: centered rectangle with 20 and 8 mm native local
  dimensions, four exact Line segments and its updated Region. For this fixture
  native width maps to world Y and length to world X.
- `reverse-curves`: reverse an open two-segment Wire, preserving segment lengths
  and exchanging its exact start/end; verify two native endpoints.
- `unjoin-curves`: four independent open Lines with the original rectangle's
  exact corners and lengths; verify eight native endpoints, their corner coordinates and body ownership.
- `counterbore`: a 20 × 20 × 10 mm block with Ø4 through hole and Ø8 recess
  3 mm deep; volume 4000 − 76π mm³, native radii 2/4 mm and shoulder Z=7 mm.
- `connector-opening`: a 30 × 20 × 10 mm block with a 10 × 4 mm through opening
  and R1 corners; volume 6000 − 10(36 + π) mm³, four exact cylindrical corner
  faces and one retained editable profile.

Every case checks the advertised history length, Undo to the source, Redo with
stable result IDs, geometry again after Redo, and restoration of the empty
snapshot. Counterbore and rounded connector recipes expose three and four
history steps respectively; the remaining operations expose one. Solid volume
and centroid tolerances are 0.0001 mm³ and 0.00001 mm. Wire lengths and point
coordinates use 0.00001 mm.

### Whole-body mirror correction

The old adapter treated native `MirrorFactory.move` as a Boolean copy flag.
Both application versions actually expose a numeric mirror-offset distance with
initial value zero. Passing `true` shifted the reflected result by one metre
and left the source in the document. Turning off the separate native cutting
mode alone did not fix that error.

The adapter now sets that distance to zero and explicitly disables native
cutting and union. Replacement mode commits the mirrored bodies, then deletes
only the explicit source views through a native database transaction inside
the same owned command, after verifying one newly committed reflected body
per source. Copy mode retains its sources. Replacement bodies may
have new IDs; Undo restores the original IDs and Redo restores the result IDs.
Unit regressions execute the generated native function, verify distance/flags,
copy versus deletion, stale/duplicate-source rejection and that failed or
missing reflected results never start source deletion. Earlier failed mirror and authored rectangle-axis
checks are superseded only by passing runs of the same case in the matrix.

## Sheets, blends and attached features

All nine scenarios passed on each experimental copy, including the selected
profile patch and complete cylindrical bore measurements after the fixes.

`npm run accept:native-sheets-features -- --target ID --allow-disposable-mutations
--case CASE --output NEW_DIRECTORY` selects nine guarded scenarios:

| Case | Independent geometry assertions |
| --- | --- |
| `patch-region` | Selected R5 circular Wire and Region produce one planar Sheet; area 25π mm², boundary length 10π mm, exact disk bounds and retained Wire |
| `thicken-sheet` | R5 disk thickens 2 mm along its native front normal; volume 50π mm³ and exact directional bounds, retained Wire |
| `reverse-sheet` | Same disk area, boundary and bounds; native face normal is the negative of the source normal |
| `revolve-profile` | Rectangle at radii 2–5 mm, height 10 mm, revolves 360°; volume 210π mm³, exact bounds and retained profile |
| `remove-fillets` | Four R2 vertical blends on a 20 × 20 × 10 mm block are removed; original volume 4000 mm³ and 6-face/12-edge block topology |
| `refillet-faces` | Four recognized R2 blends become R3; volume 3640 + 90π mm³ and unchanged block bounds |
| `screw-boss` | Ø8 boss, height 8 mm, on a 20 × 20 × 4 mm plate; blind Ø3 pilot, depth 6 mm; volume 1600 + 114.5π mm³, pilot floor Z=6 mm and bore area 18π mm² |
| `rib` | Right-triangular 10 × 10 mm profile, thickness 2 mm, embedded 1 mm into a 20 × 20 × 2 mm plate; union volume 881 mm³, exact bounds and retained editable profile |
| `hinge-barrel` | R4 barrel, R1 bore, length 10 mm, axis at X=3 mm, joined to a wall ending at X=0; volume 4000 + 150π − 10[16 acos(3/4) − 3√7] mm³ and complete bore area 20π mm² |

The barrel overlaps only the outer circular cap of the support wall; the pin
bore remains clear. The rib volume subtracts the 19 mm³ overlap with its plate.
Screw-boss and barrel recipes require four confirmed native history steps;
rib requires three; the remaining operations require one. Every case checks
native validation, Undo to the source snapshot, Redo with stable result IDs,
geometry again after Redo, and cleanup to the initial empty snapshot. Source
Solid volumes are also checked after Undo. Volume/area tolerances are
0.0001 mm³/mm²; linear coordinates and radii use 0.00001 mm, and normal components use
0.00001.

### Patch after curve selection

The first selected-curve patch timed out after committing its Sheet. Read-only
reconciliation found the expected Wire and planar disk, two history steps and
an awaiting native `MoveItemCommand`. The owned fixture was checkpointed, that
interactive command was cancelled, and its two confirmed changes were undone.
No uncertain mutation was repeated or counted as accepted.

`patch_regions` now clears selection inside the owned patch command before
committing its explicit Regions, preventing the automatic interactive move.
The acceptance deliberately selects the source Wire, verifies the current
selection and unchanged scene revision, then patches it. Unit regressions
execute the generated native function and require selection clearing inside
the command before commit, input rejection before selection changes, and
native error propagation.

### Periodic face-loop validation

The screw-boss and hinge checks initially rejected valid cylindrical bore
measurements. Direct native reads on both versions reported `loopCount=2`,
`innerLoopCount=2`, positive exact areas/boundary lengths, and no face Check
codes. The same native classification occurred on the boss's outer cylinder.
A periodic curved carrier need not have the outer-loop classification required
for a bounded planar face.

Face-property validation now permits equal total/inner counts for nonplanar
faces. Planar faces still require an outer loop; negative, fractional,
out-of-range and zero total counts remain rejected. Identity, finite mass
properties, native Check codes and persistent-state checks are unchanged. The
returned counts remain native values, and the result limitation explains that
inner-loop count on a periodic carrier is not a planar hole count. Unit coverage
checks the valid cylinder and preserves rejection of planar equality and
impossible curved-face counts. This change does not accept zero-boundary closed
faces or claim support for every periodic/degenerate configuration.

## Profiles, lofts and Sheet closure

All ten scenarios passed on each experimental copy. No production adapter
change was required for this group.

`npm run accept:native-profiles-lofts -- --target ID --allow-disposable-mutations
--case CASE --output NEW_DIRECTORY` selects ten guarded scenarios:

| Case | Independent assertions |
| --- | --- |
| `offset-outward` | R5 circular Wire plus a separate R7 result for +2 mm |
| `offset-inward` | R5 circular Wire plus a separate R3 result for −2 mm |
| `region-offsets` | One Region offset by +2 and −1 mm creates R7/R4 Wires and retains the original R5 Wire |
| `extend-endpoints` | Both ends of a 10 mm Line extend by 2 mm; final endpoints X=−2 and 12 mm, total length 14 mm |
| `extract-edges` | Four top edges of a 10 mm cube become a separate closed four-Line Wire at Z=10; source topology and volume 1000 mm³ remain intact |
| `loft-regions` | R5 circles at Z=0/10 loft to one capped Solid of volume 250π mm³; both profiles remain |
| `sweep-regions` | Centered 4 × 3 mm rectangular Region sweeps along a 20 mm straight spine; volume 240 mm³ and exact bounds; profile and spine remain |
| `join-sheets` | Perpendicular 20 × 10 and 20 × 5 mm planar Sheets join into one two-face/seven-edge Sheet; area 300 mm² and summed face boundaries 110 mm; both profiles remain |
| `cap-sheet` | Delete the top cube face to obtain a five-face Sheet, then cap it into a native-valid 1000 mm³ Solid with six faces and twelve edges |
| `solid-from-sheet` | Copy all six cube faces to a closed Sheet, then create a separate 1000 mm³ Solid; original Solid and Sheet remain unchanged |

Each main operation requires one history step, Undo to the complete source
snapshot, stable result IDs after Redo, repeated geometry checks, and cleanup
to the empty initial snapshot. Preparation also exercises public face deletion.
Curve offsets are checked through native circular geometry, center and length;
profiles for lofting are ordered using native Wire bounds and Region ownership,
not their display meshes. Solid/Sheet validation, exact volumes/areas and bounds
are checked where applicable. Linear tolerance is 0.00001 mm and volume/area
tolerance is 0.0001 mm³/mm². Sweep uses an explicit rectangular profile and
simplification; these cases do not accept every curved sweep, loft guide, offset
self-intersection or Sheet closure configuration.

## Alignment, projection and semantic selections

Nine scenarios passed and one strict circular-imprint qualification failed on
each version. No production adapter change was made in this continuation.

`npm run accept:native-align-project -- --target ID --allow-disposable-mutations
--case CASE --output NEW_DIRECTORY` selects ten guarded scenarios:

| Case | Assertions |
| --- | --- |
| `align-vertices` | Move a 2 × 4 × 6 mm box from the origin so its minimum corner reaches a target corner at [20,10,0] plus [1,2,3] mm; keep the target fixed and both 48 mm³ volumes |
| `align-edges` | Align corresponding parallel bottom Line edges by translation; moving bounds become [20,10,0]–[22,14,6] mm and the reference body remains fixed |
| `align-cylinders` | Coaxial alignment with `preserve` axial mode; source R2 cylinder keeps Z=0…6 mm and reaches X/Y=20/10, while the R3 target at Z=4…12 remains fixed; volumes 24π/72π mm³ |
| `project-curve` | Project a Line from Z=15 to the box top at Z=10; exact endpoints [2,5,10]/[8,5,10] mm and length 6 mm; source Wire and 1000 mm³ box remain |
| `imprint-curve` | Strict nominal-box/circle qualification for projecting an R2 circle; retained as an unaccepted case when native measurements miss the gate described below |
| `dissolve-face` | Prepare an analytic circular split with a crossing R2 cylinder and public body-body imprint; dissolve the inner planar disk, restoring 6/12 box topology and 1000 mm³ volume; the cylinder remains unchanged |
| `patch-hole` | Fill the four boundary edges of a five-face open box Sheet, restoring one native-valid 1000 mm³ Solid with 6/12 topology |
| `extend-sheet` | Extend the right edge of a 20 × 10 mm planar Sheet by 5 mm; bounds 25 × 10 mm, one face/four edges, area 250 mm², perimeter 70 mm; original profile remains |
| `draft-faces` | Draft four sides of a 10 mm cube by +5° about its bottom plane; height stays 10 mm, horizontal bounds expand by 10 tan(5°) on each side; volume 1000[1 + 2t + (4/3)t²] mm³, t=tan(5°) |
| `named-selection` | Find four vertical Line edges, save and list a semantic query, move the box by Z=5 mm, re-evaluate fresh edge IDs/centers after move, Undo and Redo, then delete the selection without changing CAD revision |

Positive geometry cases require one native history step, native validity,
volumes/bounds/topology as applicable, an unchanged source snapshot after Undo,
stable Redo IDs, repeated assertions and final empty-scene cleanup. Alignment
coverage here is translational with zero extra rotation, not every rotational
or anti-parallel configuration. Named-selection metadata operations add no
history; the associated native move supplies the checked Undo/Redo step.
Linear tolerance is 0.00001 mm and volume tolerance is 0.0001 mm³. Native
body-body imprint is independently checked as preparation for dissolve.

### Unaccepted circular curve imprint

The R2 source circle at [5,5,15] mm projected along −Z onto a 10 mm cube
committed a native-valid 7-face/13-edge Solid with all seven carriers reported
as Plane. Its new edge was `SPCurve`, with length about 12.567634 mm rather than
an analytic Circle descriptor. Native mass reported about 999.999612 mm³ and
the body bounds reached Z=10.05 mm. Both versions returned the same edge type,
length, bounds and mass values within floating-point rounding. These miss the unchanged nominal-box
qualification; the 0.0001 mm³ and 0.00001 mm gates were not relaxed.

This is recorded as an unaccepted measurement case, not as a native validity
failure or a proven adapter regression. The bounding-box discrepancy alone
does not establish a physical bulge; this pass did not certify a tighter bound
for the SPCurve. No analytic-circle equivalence is claimed. The separate
body-body imprint/dissolve path uses an analytic intersection and does not
establish dissolve acceptance for this SPCurve output.

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

## Measurements, datum refresh and file lifecycle

Seven of eight executed scenarios passed on **each version**. The strict STEP
scenario failed on both copies; `construction-plane` was not executed. No
production adapter change was needed. All executed cases restored an empty,
idle native document, including confirmed cleanup after the STEP gate failure.

`npm run accept:native-measure-datum-files -- --target ID
--allow-disposable-mutations --case CASE --output NEW_DIRECTORY` runs one
explicitly guarded scenario through the production stdio server:

| Case | Assertions |
| --- | --- |
| `bounds` | Exact native bounds and dimensions of a 10 × 20 × 30 mm Box |
| `point-distance` | Opposite B-Rep vertices: distance √1400 mm and delta [10, 20, 30] mm |
| `point-edge-interior` | Point-to-Line supporting and finite distances of 5 mm, no endpoint clamp |
| `point-edge-clamped` | Supporting distance 5 mm, finite distance √50 mm, closest point at the endpoint |
| `linear-edges` | Perpendicular skew edges: 90° and 30 mm; parallel edges: 0° and √1300 mm |
| `datum-refresh` | Face-center point and edge axis, source Move, stale-reference handling, exact resolution after Undo |
| `step-provenance` | STEP export/import, native geometry and mass, Undo/Redo, provenance and construction history across MCP restart |
| `save-open` | Save-copy, overwrite rejection, changed-scene backup, saved-document and backup readback, empty baseline restoration |

Measurement reads must preserve native revision and history. Geometry uses
0.00001 mm coordinate/distance tolerance and 0.0001 mm³ volume tolerance.
The source Box must retain six faces, twelve edges, volume 6000 mm³ and pass
native validation. Measurement cases repeat after Redo with current topology
references. A datum refresh never substitutes the nearest face when the
original topology identity no longer exists; it must reject that reference.
The original point and axis are re-resolved after Undo restores their topology.

All acceptance stores are scoped to the new evidence directory, including
reference provenance, downloaded artifacts, construction history and thread
qualifications. The STEP fixture is designed to check its SHA-256, five confirmed geometry
history events before restart, historical provenance after restart, live
geometry after reconciliation, and cleanup through a fresh current revision.
It has not passed that complete sequence: imported native bounds first failed
the strict 0.00001 mm coordinate gate. On both versions the Box imported at minimum
[0.99995, 1.99995, 2.99995] mm and maximum [11.00005, 22.00005, 33.00005] mm,
an expansion of 0.00005 mm per side. This does not by itself prove a physical
shape change or an adapter regression. The tolerance is retained, and provenance
restart/history assertions beyond that gate remain unverified by this fixture.
An initial authored assertion used `afterRevision` instead of the actual import
response field `revision`; that failed run is excluded from accepted coverage.

File open is a native document lifecycle operation that resets Undo/Redo.
The save/open fixture verifies the original file remains unchanged and reads
back the backup of the moved Box before restoring a saved empty document.
It does not claim file open can be undone. Old MCP snapshot IDs are not reused
after server restart, and file reopen is checked against explicit native
geometry and the empty baseline rather than an obsolete document snapshot.

The suite also exposes `construction-plane` for foreground-only saved-plane,
workplane and plane-local profile checks. That case was **not run or accepted**
in this continuation: UI automation could not acquire the experimental window.
No focus guard was bypassed. Existing viewport/manual gaps and the strict
circular-imprint failure remain outside accepted coverage.

Integration validation for the PR #19 continuation: `npm test` passed 1443 tests,
`npm run typecheck` passed, Workbench passed 90 tests, its typecheck and production
build. The build retains the advisory warning about chunks larger than 500 kB.
These checks do not turn the failing or unexecuted live scenarios into passes.

## Joint recipes, vents and cable channels

On 2026-10-26, **7/8 scenarios passed on each experimental copy**. All seven
positive cases completed native geometry validation, the full Undo/Redo cycle
and empty-snapshot cleanup. Pin cases that predated the added concentricity
assertion were repeated successfully; saved successful native reports also
passed completeness/identity checks for mass and validation results. No
production adapter change was needed. The cable case remains a strict failure
as described below.

`npm run accept:native-joints-vents -- --target ID
--allow-disposable-mutations --case CASE --output NEW_DIRECTORY` selects a
synthetic, explicitly disposable native recipe fixture. It uses the existing
isolated-store environment helper and never selects a window automatically.

| Case | Recipe history steps | Nominal native assertions |
| --- | ---: | --- |
| `vent-array` | 3 | Six Ø3 through-holes at explicit 3 × 2 centers; 30 × 20 × 5 mm block volume 3000 − 67.5π mm³ |
| `heat-set-pocket` | 4 | Three-stage Ø3/5/7 pocket, depths 9/6/1 mm in a 20 × 20 × 12 mm block; volume 4800 − 50.25π mm³ |
| `pin-pair` | 4 | Ø4 pin, height 4 mm, Ø4.4 socket with 0.3 mm axial gap; male/female volumes 3000 + 16π and 6000 − 2.2² × 4.3π mm³ |
| `pin-pattern` | 6 | Two pins/sockets at explicit centers; double the single-pair volume changes |
| `snap-fit` | 3 | 10 × 4 × 2 mm beam with 2 × 4 × 1 mm hook, retained editable profile; support plus beam/hook volume 1088 mm³ |
| `dovetail` | 6 | 6 mm root, 8 mm tip, 4 mm thickness/height, 0.2 mm radial and 0.3 mm axial clearance, two retained profiles; volumes 3112 and 6000 − 7.4 × 4.4 × 4.3 mm³ |
| `enclosure` | 8 | Rectangular lip/groove on 30 × 20 mm halves, wall 2 mm, lip 1 × 3 mm, clearance 0.2 mm; volumes 3303.75 and 5565.6375 mm³ |
| `cable-channel` | 2 | Ø4 half-round channel across a 30 × 20 × 10 mm block; nominal volume 6000 − 60π mm³; source Wire retained |

The enclosure groove reaches 3.25 mm above the seam: the explicit 0.25 mm
cutter overshoot extends past the nominal 3 mm lip height. The fixture checks
that actual recipe geometry rather than assuming a 3 mm-deep groove.

The runner requires recipe reports to agree with the current document/revision,
expected history counts, consumed cutters and retained target/profile IDs.
Solid outputs must pass native validation, measured bounds and mass properties.
Paired joints must also pass native temporary-body volumetric-interference
checks. Pin/socket radii, concentric centers and socket bottoms verify the explicit
geometric clearance. A no-volumetric-interference result alone cannot distinguish
contact from separation or qualify a physical print fit.

Every passing fixture must Undo the complete recipe to the source snapshot,
Redo with stable output IDs and recheck geometry, then restore the initial empty
snapshot. Coordinates/radii use 0.00001 mm and analytic volume uses 0.0001 mm³.
The cable-channel Boolean uses a native Pipe cutter and an explicit 0.01 mm³
nominal-volume tolerance. The earlier Pipe fixture returned a B-Spline side,
so this case is not qualified as an analytic cylindrical surface. These synthetic recipes
do not prove snap strength, insertion retention, production tolerances or fit.
The earlier strict STEP and circular-imprint failures retain their tolerances
and acceptance status; neither is rerun or relabeled by these recipe fixtures.

The cable-channel fixture is **unaccepted on both versions**. Native Check and
the 0.01 mm³ nominal-volume check passed, but `FindBox` reported a maximum Z of
10.112742414248142 mm instead of 10 mm on each version, exceeding the retained
0.00001 mm bounds tolerance. This matches neither a proven physical shape growth
nor a demonstrated 26.2 adapter regression: native bounding-box behavior for the
trimmed Pipe surface needs separate investigation. Calls from this failed case
are excluded from accepted tool coverage. Confirmed recovery restored the empty
fixture after each failure; no failed or uncertain mutation was resubmitted.

Integration validation for the PR #20 continuation: `npm test` passed 1447 tests,
`npm run typecheck` passed, Workbench passed 90 tests, its typecheck and production
build. The build retains its advisory warning about chunks larger than 500 kB.
Final read-only reconciliation found both experimental documents empty and idle.

## Appearance, annotation and native lifecycle continuation

After the corrections below, all **7/7 scenarios passed on each experimental
version**. Earlier material and authored bridge failures are superseded only
by completed passing reruns of the same scenarios. Both documents finished empty
and idle. The eight newly accepted tools increase cumulative coverage to
279/371 on 26.2.1 and 237/371 on 26.1.3; existing seven failing/blocked fixtures
per version remain unaccepted.

`npm run accept:native-lifecycle -- --target ID --allow-disposable-mutations
--case CASE --output NEW_DIRECTORY` runs one guarded scenario with isolated
persistent stores:

| Case | Native operation history | Assertions |
| --- | ---: | --- |
| `appearance` | 3 steps | Create/assign #336699, roughness 0.25, metalness 0.4, opacity 0.8; reuse on a second Solid and clear the first assignment; geometry unchanged |
| `section-oblique` | 0 steps | Origin [5, 10, 15] mm, normalized clipped-half-space normal [1/√2, 0, 1/√2], stable ID, registered viewport, repeated-create rejection, explicit deletion |
| `delete-distance` | 2 steps | Create and delete opposite-vertex annotation √1400 mm; Undo/Redo restores its stable ID, body and topology references |
| `delete-radius` | 2 steps | Create and delete native cylinder-edge radius annotation R3/Ø6; Undo/Redo restores its stable ID and edge reference |
| `split-parallel` | 8 steps | 10 × 20 × 30 mm source, cuts X=3/7 mm, volumes 1800/2400/1800 mm³; unrelated 24 mm³ Solid unchanged |
| `split-grid` | 12 steps | Cuts X=5 and Y=10 mm require three binary cuts, four 1500 mm³ parts; unrelated Solid unchanged |
| `surface-bridge` | 1 step | Public stdio G2 Surface Bridge joins two Sheet faces into one native-valid Sheet with three faces, ten edges, two planar walls and one B-Surface |

Appearance and section checks validate native state read-back, revision/history
behavior and B-Rep preservation. They **do not validate rendered pixels** or
replace the existing screenshot/manual fixtures. The section is explicitly
removed, rather than undone. Creating a second section, deleting an absent
section/measurement, and selecting an unknown material must reject without
changing revision or history.

Split outputs must pass native Solid validation, exact per-part bounds and
0.0001 mm³ volume checks. Source/part coordinates use 0.00001 mm tolerance.
Every history-bearing case checks the source snapshot after full Undo, stable
output IDs and geometry after Redo, then restoration of the initial empty
snapshot. Surface Bridge deliberately trims its source walls (`trimWalls=true`):
their centroids can move, so the fixture checks their original support planes,
not unchanged face centers. The initial authored centroid assertion failed and
was corrected against that verified command contract.

### Appearance adapter corrections

The 26.2 material list contains material-info objects with `id`, whereas the
legacy reader expected `[id, info]` pairs. After adding a material, state reads
failed before the command result could be confirmed. The reader now normalizes
both layouts, preserves the public material fields and revision fingerprint,
and rejects malformed entries instead of silently dropping them. Tests execute
the generated state-reader function for both layouts and verify revision change
on a native appearance edit.

Public `materialId: 0` now maps to the native unset value `undefined` when
calling node-state `setMaterial`; on 26.2, passing literal zero caused
`invalid material id`. Existing-material assignment and clearing remain within one owned native
command each. Regression tests execute both legacy and modern API views, verify
only the requested body is changed, and require native failures to propagate.
The first failed live run was stopped; read-only reconciliation confirmed the
completed assignment and idle executor, an owned backup was saved, and three
confirmed Undo steps restored the empty fixture before rerunning.

The strict STEP, circular-imprint and cable-channel bounds failures retain their
previous tolerances and unaccepted status. No application bundle, signature,
fuse, entitlement or system security setting was changed.

Integration validation for the PR #21 continuation: `npm test` passed 1454 tests,
`npm run typecheck` passed, Workbench passed 90 tests, its typecheck and production
build. The build retains the advisory warning about chunks larger than 500 kB.
