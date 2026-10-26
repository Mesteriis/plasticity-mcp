# Catalog audit on disposable Plasticity copies

Date: 2026-10-26. The current continuation starts from merged PR #30
(`8a771f48a312cb0209ca17b697795078ecddfcb3`); earlier fixtures start from PR #12. Both application bundles are
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
| Completed passing fixtures | 163 | 171 |
| Failing or blocked fixtures | 13 | 14 |
| Tools with success in an application-connected passing fixture | 285 | 321 |
| Tools attempted only in unaccepted fixtures | 0 | 0 |
| Tools without a recorded application-connected live call | 86 | 50 |

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

This initial vector-projection result remains unaccepted. The later normal
projection cases below use an explicitly different method.

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

## Standalone printed-thread qualification

The following initial results are historical; the correction and qualified
inputs are recorded in the next section.

Six standalone public-tool scenarios were executed on each experimental copy.
**0/6 passed on either version.** All six failed the predeclared 0.01 mm nominal
body-envelope check; the internal-thread and nut cases also failed their Helix
length/axial-range checks. Successful calls from these fixtures are excluded
from accepted coverage. The four standalone thread tools move from unobserved
to attempted-unaccepted; accepted counts remain 279/371 and 237/371.

`npm run accept:native-thread-tools -- --target ID
--allow-disposable-mutations --case CASE --output NEW_DIRECTORY` selects one
explicit, isolated fixture. All use synthetic Ø8, pitch 2 mm, radial depth
0.8 mm, axial length/material thickness 4 mm and axis +Z. Female profiles use
0.2 mm clearance and 0.5 mm cutter overshoot. Hex across-flats size is 12 mm;
the screw head is 3 mm high with 0.5 mm junction overlap.

| Case | Confirmed recipe steps | Native body Z bounds, approximately (mm) | Failed gates |
| --- | ---: | --- | --- |
| `external-right` | 6 | −0.426057 … 4.426100 | Expected 0 … 4 |
| `external-left` | 6 | −0.426057 … 4.426100 | Expected 0 … 4 |
| `internal-right` | 4 | −1.285330 … 5.461694 | Expected 0 … 4; fractional Helix length and end |
| `internal-left` | 4 | −1.285330 … 5.461695 | Expected 0 … 4; fractional Helix length and end |
| `hex-nut` | 6 | −1.285330 … 5.461694 | Expected 0 … 4; fractional Helix length and end |
| `hex-screw` | 9 | −3 … 4.425733 | Expected −3 … 4 |

Both versions returned essentially the same deviations. Native Check passed
for all result/control Solids, no temporary cutters remained, and the unrelated
24 mm³ control Solid was unchanged. Volumes fell strictly between independent
core/crest or bore/groove-cylinder bounds; this is a bounded-volume check, not
an exact closed-form prediction of the clipped rounded thread's volume.
Expected native core/bore cylinders and editable hex profiles were present.

The runner samples six native Helix positions and unit tangents. For the +Z
axis, `(x * tangentY - y * tangentX) * tangentZ` was positive for right-hand and
negative for left-hand inputs. The sampled radii and right/left direction checks
passed. This does not qualify physical mating, standard hardware compatibility
or the full continuous profile to a certified error bound.

### Fractional Helix diagnostic

The female cutter requests an extended Helix from Z=−0.5 to Z=4.5 mm: 5 mm at
pitch 2 mm means 2.5 turns and nominal length 56.76928593837475 mm. Both versions
reported native length 59.0401069072201 mm and end Z=4.7 mm instead. The retained
curve therefore fails the 0.001 mm length/end tolerance. Integer two-turn
external Helices passed those particular curve checks.

An independent 26.2 probe read the same Helix descriptor before and after native
Pipe creation; it was unchanged. The overrun is already present before Pipe.
The native Spiral factory's configured length was 0.005 m and turns 2.5, so this
observation is not explained by an incorrectly supplied meter/millimeter length.
This does not establish a 26.2-specific regression: the standalone 26.1 fixtures
show the same measured curve overrun. The body-box discrepancies alone do not
prove physical material outside the clipping envelope; native `FindBox` behavior
for trimmed sweep surfaces needs separate investigation.

The initial envelope failures halted qualification before curve diagnostics.
The revised runner retains every gate, collects independent read-only results
before reporting their combined failures, and writes those results as failure
evidence. No tolerance was increased after the runs. Full recipe Undo/Redo
qualification was **not reached**, so it is not claimed. Confirmed owned recovery
Undo restored an empty document after every failed run; final read-only
reconciliation found both copies empty and idle. No production adapter or
application/security configuration was changed in this continuation. Earlier
STEP, circular-imprint, cable-channel and rendering gaps remain open; earlier
printed-pair scenarios remain separate evidence for their different inputs.

Automated checks: `npm test` passed 1458 tests, `npm run typecheck` passed,
Workbench passed 90 tests, its typecheck and production build. The build retains
the advisory warning about chunks larger than 500 kB. These green automated
checks do not qualify any of the six failing live scenarios.


## Bounds and whole-turn thread correction

Native `FindBox` includes empty space around trimmed spline surfaces. The
26.2.1 adapter now uses native `Eval.Extremes` for Solid/Sheet bounds, with
`boundsMethod: native-extrema`. The 26.1.3 kernel has no such capability and
retains conservative `native-box` bounds. Failed extrema evaluations raise an
error. Optional provenance survives compact summaries and durable history;
old history remains readable. See [the API and input constraints](native-bounds-and-helix.md).

Fractional Helix turns are rejected before geometry creation on both versions.
No pitch, length or overshoot is silently adjusted. All composed recipes check
members' turn constraints before their first geometry step.

Seven scenarios now pass on **both copies (7/7 each)**: external right/left,
internal right/left with explicit 1 mm overshoot, hex nut with explicit 1 mm
overshoot, hex screw, and fractional preflight. Native extrema where available
and six temporary B-Rep envelope intersections distinguish actual material from
conservative boxes. The original 0.01 mm envelope and 0.001 mm Helix tolerances
remain. The supported recipes pass native checks, sampled curve length/end and
handedness, full Undo/Redo with stable IDs, source restoration and exact durable
history counts/synchronization. Fractional preflight rejects direct Helix and
all four standalone tools without changing revision or native history.

The M5 pair also passes on each version using **explicit 1 mm cutter overshoot**
and matching axial phase translation: no interference aligned, interference at
90 degrees, and Undo restores alignment. The original 8 mm nut / 1.25 mm pitch /
0.5 mm overshoot requests 7.2 turns and is retained as
`unsupported-fractional-turns`, not accepted with altered inputs.

The two-nut calibration set passes on both copies with explicit M5x10 screw
length and 1 mm cutter overshoot (eight turns each). The original M5x8 /
0.5 mm overshoot fixture rejects before geometry and remains unsupported; its
previous successful call is not retained as current acceptance. This calibration
fixture checks native validity, clearance-dependent volume and cleanup Undo;
full Redo is covered by the standalone fixtures rather than this set.

On 26.2.1, strict STEP provenance and cable-channel bounds now pass, and Surface
Bridge passes again with Sheet extrema (3/3). Legacy strict STEP/cable box gates
remain unaccepted; no exact legacy box claim is made. Circular-imprint and
rendering gaps remain. The matrix preserves unsupported original fractional
fixtures and separates them from the explicit supported variants.

Final automated checks: 1466 root tests and 90 Workbench tests pass; both
typechecks and the Workbench build pass. The build retains its advisory warning
about chunks larger than 500 kB. Both experimental documents were restored empty
and idle; installed application and security settings were unchanged.


## Native group hierarchy continuation

The explicit `--native-state-only` variant of the existing group runner passes
on both experimental versions. The default runner still requires its original
PNG pixel-difference checks; its historical viewport failures are retained under
the original fixture IDs. Native visibility flags are not rendered-pixel proof.
No production adapter change was needed in this continuation.

```sh
npm run accept:groups -- --target ID --allow-disposable-mutations \
  --native-state-only --output NEW_DIRECTORY
```

The native variant exercises group creation around bodies and linked instances,
activation with subsequent geometry membership, nesting, rename, dissolve and
promotion; exact node/face/edge selection; opposed planar-face alignment of a
rigid body cluster; cylindrical, vertex and linear-edge alignment; visibility
and lock flags. Applicable mutations check one history step and Undo/Redo.
Body bounds, membership and active-group read-back are checked independently.
The public group listing must match native status. Read-only diagnosis must
include the selected window; filtered native binding pages must advance and
cover all matching unique bindings. Only bounded discovery counts are kept in
evidence, excluding the diagnostic endpoint/window dump.

Both runs restore an empty document without groups or linked instances. Their
stdio stores are scoped to new evidence directories. The explicit native-only
scope is written to evidence; no screenshots are taken and rendering remains
unaccepted. Together with the saved-plane fixture below, accepted coverage is now
301/371 tools on 26.2.1 and 259/371 on 26.1.3.

### Saved construction planes

After manual focus preparation, the `saved-plane-frames` case passed on **both
experimental versions**. Its initial 26.2.1 foreground rejection is superseded
by a completed passing run of the same fixture, not treated as a successful call.
The adapter's actual focus guard remains unchanged.

```sh
npm run accept:native-measure-datum-files -- --target ID \
  --allow-disposable-mutations --case saved-plane-frames --output NEW_DIRECTORY
```

Five definitions are checked: an explicit oblique plane at (2,3,4) with normal
(0,−1/√2,1/√2); the top face of a 10 × 20 × 30 mm box offset by 2 mm to
(5,10,32); the same oblique plane through three points; a standard XY plane
offset by 7 mm; and XY rotated 90° about world X, normal (0,−1,0).
Origin tolerance is 0.00001 mm, normal/X-direction tolerance is 1e-8.
Each saved plane is checked after creation and creation Undo/Redo, then activated
without adding a native Undo step. A local 4 × 6 mm rectangular Wire/Region has
its world bounds independently calculated from the checked frame; its Undo
removes the profile and Redo restores the same Wire ID. The initial workplane
is explicitly restored before plane deletion. Removal Undo restores the same
plane/frame and Redo removes it again. The source body remains unchanged.

Standard-plane deletion rejects without a revision/history change. Cleanup Undo
restores the empty scene, exact initial saved/standard-plane descriptors and
initial active workplane. Both versions also pass bounded diagnosis and complete
filtered capability pagination. No production adapter change was required.

A subsequent retry of the original full group fixture on manually focused
26.1.3 still failed at screenshot: Electron reported `renderer is hidden`.
This remains `viewport-unavailable`; native focus success does not establish
rendered visibility. No pixel threshold or renderer/focus guard was relaxed.
Circle-imprint, legacy strict bounds and other viewport/manual gaps remain open.

Automated checks: 1467 root tests and typecheck pass; catalog counts, fixture
references and `git diff --check` pass. Both experimental documents finish
empty and idle. Installed application and security settings were unchanged.


## Explicit normal projection for circular imprint

The vector failure reproduces on both copies: volume 999.9996120023484 mm³,
SPCurve edge, native validity success. Current 26.2.1 native-extrema body bounds
are exactly 0..10 mm, while 26.1.3 FindBox still reaches Z=10.05 mm. Thus the
new bounds method resolves the conservative box discrepancy on 26.2.1, but does
not fix the vector path's curve representation or mass-property gate. A separate
temporary native diagnostic on each version sampled 65 parameters and found
maximum radial deviation 0.0004144400782291058 mm from R2 (sampled Z=10 mm).
This is sampled evidence, not a continuous error certificate or accepted MCP
coverage.

The adapter now exposes explicit `projectionMethod: normal` for curve imprint.
Existing calls retain default `vector` and their required nonzero direction.
Normal projection requires direction to be omitted; contradictory/missing
inputs reject before mutation. Native normal projection preserved analytic
circles in the aligned and 30-degree rotated planar fixtures: **2/2 passed on
each version**. There is no automatic method substitution or general claim
that normal and vector projection have identical semantics.

The normal cases retain the original 0.0001 mm³ volume and 0.00001 mm linear
gates. They check native validation, 7-face/13-edge topology, exact Circle
radius/center/circumference and normal, known world bounds, source preservation,
Undo to the source snapshot, Redo with stable result IDs and geometry checked
again, empty-scene restoration, and exact durable-history counts/synchronization
including the selected projection method. Test stores are isolated. See
[the method contract and repeatable cases](curve-imprint-projection.md).

The original failed vector fixture remains in the matrix; the two new normal
variants qualify their explicit inputs. Accepted coverage becomes 302/371 tools
on 26.2.1 and 260/371 on 26.1.3. Rendered-viewport, manual gesture and legacy
strict STEP/channel bounds gaps remain unaccepted. Both experimental scenes
finish empty and idle, with installed Plasticity and security settings unchanged.

Validation: 1468 root tests, 23 Workbench web tests and 90 Workbench server tests
pass; both typechecks pass,
and Workbench builds. Its existing advisory about chunks larger than 500 kB
remains. Catalog consistency and `git diff --check` pass.


## Verified native viewport capture

`plasticity_screenshot` now has explicit `captureMode: viewport`: it uses the
existing native render handler and immediately encodes the WebGL canvas only
after verified draw-counter/timestamp advancement, a cleared dirty flag and a
live context. Busy, missing, ambiguous, stale or lost-context rendering rejects.
PNG dimensions must match the native canvas; existing no-overwrite behavior
remains. Freshness, hidden-document provenance and dimensions are returned.

Default `window` behavior retains its visibility guard and full HTML content.
There is no automatic fallback, visibility emulation, prototype replacement or
background-throttling change. Viewport mode excludes HTML labels/panels and CSS
backgrounds, preserving canvas alpha; it is not proof of OS window visibility.
See [the capture contract and commands](viewport-screenshots.md).

The `native-viewport` group and section variants pass **2/2 on each copy**:

| Rendered assertion | 26.1.3 | 26.2.1 |
| --- | ---: | ---: |
| Group hide changed-pixel ratio | 0.032557511610325086 | 0.032557511610325086 |
| Group Undo/Redo restoration differences | 0 / 0 | 0 / 0 |
| Section changed-pixel ratio | 0.14702948482557512 | 0.14702235662598553 |
| Section removal restoration difference | 0 | 0 |

Original change/restoration thresholds were not relaxed. Native state/history,
source snapshot restoration and empty-scene cleanup also pass. Each captured
image reports verified freshness and `rendererHidden=true`; representative PNGs
were visually inspected in addition to decoded pixel comparisons. Final live
capture with the context-loss guard left CAD revision/Undo/Redo unchanged on
both versions. The test stores are isolated, and unknown timeout outcomes stop
recovery mutations.

The original full-window fixtures remain failed; new native-viewport fixture
IDs carry this separate scope. HTML annotation/manual/window checks, legacy
strict STEP/channel bounds and known vector-imprint/fractional-Helix inputs
remain outside acceptance. Coverage is 303/371 on 26.2.1 and 261/371 on 26.1.3;
no failed fixture contributes accepted tool coverage. Both scenes finish empty
and idle; installed application and security settings were unchanged.

Validation: 1475 root tests, 23 Workbench web tests and 90 Workbench server tests
pass. Both typechecks and Workbench build pass; the existing >500 kB advisory
remains. Matrix consistency and `git diff --check` pass.


## Legacy STEP and channel geometry qualification

The original strict fixtures were rerun: both fail their unchanged nominal-box
checks on 26.1.3, while both pass on 26.2.1. Legacy STEP bounds are expanded by
0.00005 mm per side; channel max Z is 10.112742414248142 mm instead of 10 mm.
The conservative API bounds are preserved and those strict failures remain
separate fixture IDs.

Two explicit geometry variants pass **2/2 on each experimental copy**:

- `step-provenance-geometry`: eight nominal native corners, twelve unique axial
  endpoint pairs constrained by nonparallel analytic Plane faces, consistent
  lengths/tangents and six oriented four-edge Plane boundaries; native validity,
  volume 6000 mm³, area 2200 mm² and centroid (6,12,18). Imported edge wrappers
  are SPCurve with IsLine=false, so the verifier uses checked plane constraints
  rather than assuming a Line class name. Invalid supports/corners/boundaries
  reject in regressions. Linear gates remain 0.00001 mm. Redo, MCP restart,
  reconciliation, artifact hash and provenance/history persistence pass; immutable
  historical bounds preserve the actually observed imported bounds.
- `cable-channel-geometry`: original source/spine/diameter and volume tolerance,
  six read-only temporary intersections beyond a box padded by 0.00001 mm,
  and a positive 0.001 mm overlap control. No target material intersects external
  probes, while the positive control returns a valid intersection Solid.
  Controls/source are unchanged; Undo/Redo, IDs, full source snapshot restoration
  and all 25 completed durable events with in-sync status pass.

These native geometry/containment checks do not turn conservative legacy boxes
into tight measurements or certify arbitrary sub-kernel deviations. See
[the contracts, limits and repeatable commands](legacy-bounds-qualification.md).
There is no production adapter change in this continuation. Native planar
metadata and mass checks remain distinct from rendered or manufacturing proof.
Accepted coverage becomes 303/371 on 26.2.1 and 266/371 on 26.1.3. Both scenes
finish empty and idle; installed application and security settings were unchanged.

Validation: 1478 root tests and typecheck pass, including three regressions for
the independent box verifier. Catalog counts/references and `git diff --check`
pass. Original legacy strict bounds and other parameter/window/manual gaps remain.


## HTML measurement label lifecycle

PR #26 is merged. The next continuation fixes stale HTML distance-label anchors
when the renderer suspends RAF. Camera changes and native viewport rendering now
refresh labels synchronously without duplicating animation loops. Both experimental
versions pass nine native/HTML-layout phases: creation, camera, move, move Undo/Redo,
delete, delete Undo/Redo and deletion of all dimensions. Empty scene/snapshot and
in-sync durable journal cleanup pass. The original stale-camera failure was
reproduced on both versions before the patch.

[Commands, assertions and limitations](html-measurement-labels.md) distinguish
DOM/layout evidence from rasterized HTML glyphs and full-window pixels. Native
measurement names are lost after a transform on both versions; stable-ID and
numeric lifecycle checks pass, while name persistence remains unresolved.
Coverage remains 303/371 on 26.2.1 and 266/371 on 26.1.3; this continuation
qualifies an additional workflow without claiming new tool names. Existing
parameter/window/manual failures remain. Installed applications and security
settings were unchanged.

Validation: 1480 root tests and typecheck pass, including executed callback and
capture-order regressions plus live-runner guards.


## Measurement names and external window review

The measurement label fixture now passes thirteen phases on each experimental
version, requiring exact names through item rotation/scale Undo, move Undo/Redo
and measurement delete Undo/Redo. Item transform commands preserve missing names
on surviving stable IDs inside the command, before history captures the result.
No cache/prototype patch is installed; other command families and file
serialization remain outside this name qualification.

External CUA window images were collected at three paused checkpoints. Manual
review fails overall on both versions: modern capture retains 10.00 mm after a
native/DOM update to 15 mm and retains labels after deletion; legacy creation
capture is stale/empty, although its 15.00 mm update and deletion images are
correct. Captures remain separate from passing native/DOM evidence. The runner
records artifact hashes without calling image presence a glyph pass. Manual
review retains the native/layout exit code separately and fails window acceptance.
See [the full contract and review table](html-measurement-labels.md).

1482 root tests and typecheck pass. Accepted tool counts are 303/371 on 26.2.1
and 267/371 on 26.1.3; the scale call adds legacy acceptance for that fixture. Failed external window review adds one failed fixture on
each version; existing failures remain. Both CAD scenes finish empty and idle.


## Foreground external-window review on 26.1.3

After explicit manual viewport focus, a separate focused fixture passes all three
real CUA window images: four original labels, the 10→15 mm update, then no labels
or helpers after deletion. The exact saved JPEG bytes were visually reviewed and
hashes match the native/DOM evidence. All thirteen native/DOM phases, names,
source snapshot restoration and empty/idle cleanup pass. The earlier failed
window fixture is preserved; this does not accept background freshness or the
default full-window MCP capture. Focused 26.2.1 review remains pending.

No code changed in this continuation. Catalog counts/references and diff checks
pass; tool coverage stays 303/371 modern and 267/371 legacy.


## Foreground external-window review on 26.2.1

Explicit manual viewport focus also permits the modern focused fixture to pass
all three real CUA images: initial four labels, the 15.00 mm update and deletion
of all labels/helpers. The same saved JPEG bytes were manually reviewed and
hashes match evidence. All thirteen native/DOM phases, exact names, source
restoration and empty/idle cleanup pass. This completes the bounded foreground
external-window lifecycle on both versions. Earlier stale-window failures remain
separate; background freshness and default full-window MCP capture stay outside
acceptance. No code changed; catalog counts/references and diff checks pass.

## Local reference 3MF units, multi-mesh and provenance

Three synthetic local 3MF variants pass on each experimental version: a 4 mm
millimeter cube, the same cube encoded in meters, and two independently placed
meshes. The strengthened verifier isolates every store, refuses annotations,
section analyses/non-root groups, and stops recovery on unknown timeout or
connection outcomes. It verifies public mesh/provenance listing, exact source
artifact SHA-256, embedded-unit provenance, per-mesh bounds/counts, stable IDs
through Undo/Redo, complete source restoration, and four completed durable events
with in-sync status after MCP restart. All scenes finish empty and idle.

[Commands and limits](reference-3mf-qualification.md) keep approximate reference
meshes separate from exact B-Rep, rendered pixels and manufacturing acceptance.
No network source, license or asset discovery is qualified by synthetic metadata.
There is no production adapter change. A read-only default-window capture recheck
still rejects hidden renderers on both versions without changing CAD/history.

Tool coverage becomes 307/371 on 26.2.1 and 271/371 on 26.1.3, adding local 3MF
import, reference mesh listing and provenance list/get. Existing failed fixtures
remain. 1485 root tests, typecheck, catalog consistency and diff checks pass.

## Pinned HTTPS 3MF, OBJ and multi-solid STL

Four real production HTTPS imports pass on each experimental version: meter-unit
3MF, a scaled/material-partitioned 3MF, indexed OBJ and a two-solid ASCII STL.
The source revision, reviewed CC0 terms, independent SHA-256 preflight and
observed native geometry are recorded in [the network contract](network-reference-qualification.md).
No mocked transport or altered source is used.

The initial STL run was rejected before CAD import because the validator did
not accept sequential solid blocks. A focused parser fix now accepts complete
blocks and rejects nested/unmatched/unfinished/empty blocks and facets outside
blocks. Finite-coordinate and facet checks remain. Both native versions import
the unchanged pinned file as one reference mesh with eight triangles. The
original modern rejection remains a separate failed fixture.

The remote STL/OBJ verifier now requires an empty disposable scene and explicit
mutation consent, isolates every store, refuses embedded URL credentials,
checks private artifact bytes/size/hash and source geometry, and verifies
Undo/Redo, source snapshot restoration and four completed durable events after
MCP restart. Source-unit interpretation is explicit for STL/OBJ. The 3MF verifier
accepts matching full-commit URL/page pins and an optional reviewed hash while
preserving the existing master-source path.

Coverage is 309/371 on 26.2.1 and 273/371 on 26.1.3. 1490 root tests, typecheck,
catalog consistency and diff checks pass. Scenes finish empty and idle. Rendered
pixels, physical accuracy, arbitrary transport failures, asset discovery and
STEP/Parasolid network imports remain outside this slice.

## Pinned HTTPS STEP and Parasolid native B-Rep

PR #27 and #28 were merged into main. This continuation starts at
`1e775ead2b86f292ed0f86848b5ce35d3da15748` and adds a guarded production stdio
verifier for two immutable public direct-file CAD inputs. Both STEP and text
Parasolid pass on experimental 26.2.1 and 26.1.3, including hash/size/private-byte
identity, native Solid validity/mass/topology, historical provenance list/get,
stable IDs and numerical geometry across Undo/Redo and MCP restart, complete
source restoration and four completed durable events with in-sync status.

[The pinned sources, numeric gates and scope](network-cad-qualification.md)
distinguish observed STEP properties from independent Parasolid planar-box proof.
Legacy STEP native-box bounds remain conservative and are not replaced by modern
native-extrema bounds. Native integration roundoff is checked with explicit
absolute tolerances; identity/topology counts and method tags remain exact.
An in-process snapshot is checked before restart; the retained full source-state
baseline is checked afterwards. Downloaded CAD bytes are removed only after
successful cleanup and hash verification. All test stores are isolated; unknown
timeout/disconnect outcomes stop recovery mutations.

There is no production adapter change in this continuation. Coverage becomes
311/371 modern and 275/371 legacy. Existing failed fixtures remain. 1494 root
tests, typecheck, matrix consistency and diff checks pass. Both scenes finish
empty and idle; installed apps/settings/security are unchanged. Direct-file
acceptance does not qualify ZIPs, binary Parasolid, arbitrary assemblies,
asset discovery, rendering or manufacturing accuracy.

## Read-only reference discovery

PR #29 is merged. Three guarded production stdio cases pass on each experimental
version: search-provider status, the selected official Radxa hardware page's
asset listing and a fixed known-page live search. The host tools are qualified
with explicit application connections and native scene/history no-change checks,
not CAD geometry or download assertions. Both copies finish empty and idle.

[Discovery scope, source and repeatable commands](reference-discovery-qualification.md)
explain the exact HTTPS domain/format/link gates and isolation. Search returns
one manufacturer page with unknown licensing, no dimensional evidence and no
verified direct asset URLs; the separate HTML listing exposes STEP-archive,
text-Parasolid and PDF links. No archive/model is downloaded or imported. An
off-domain page is rejected. The initial broad 120-second search timeout remains
a separate failed fixture; the narrower 180-second request passes on both versions
and does not prove the cause of the first timeout or general search reliability.
An authored format-name mismatch was corrected in the verifier, without changing
the production classifier or security profile.

Coverage is 314/371 modern and 278/371 legacy, with three additional passing
fixtures per version and the additional modern timeout retained. 1498 root
tests, typecheck, catalog count/reference consistency and diff checks pass.
The installed applications, settings and security protections are unchanged.

## Synthetic material coupons and rectangular scenarios

PR #30 is merged. A guarded production stdio verifier adds two passing cases
per experimental version: immutable material-coupon registry and coupon-backed
rectangular scenarios. [Synthetic inputs, numerical gates and limits](material-coupon-qualification.md)
make clear that no physical tests were performed. Host records simulate the
physical-coupon schema in isolated stores; no real material is qualified.

Recording is idempotent; compatible partial records require explicit consolidation
before exact-process matching. Five process changes yield no match. Malformed
source hashes, duplicate IDs and conflicting properties are rejected; conflict
records stay ambiguous. Independent design allowables remain separate from
coupon peak strengths. Axial/bending stresses, displacement and utilizations,
and every explicit size candidate are checked with independent arithmetic.
Scenarios stay conditional and unbound. A test plan retains exact process identity
and required axis confirmation. Registry and positive reports survive MCP restart
with exact equality, while native scene/history remain unchanged.

The first modern run expected conditional acceptance outside the cantilever
deflection limit. That real refusal remains an unaccepted fixture. Corrected
positive fixtures use a smaller load and heights within L/h ≥ 20. Explicit
negative checks retain the deflection/slenderness guards; calculation algorithms
and product limits are unchanged. No production adapter change was needed.

Coverage is 321/371 on 26.2.1 and 285/371 on 26.1.3. 1502 root tests, typecheck,
catalog count/reference consistency and diff checks pass. Both copies finish
empty and idle. No installed application, settings or security configuration was
changed. This slice does not qualify FEM, physical coupon authenticity, actual
printed strength, manufacturing or rendered pixels.
