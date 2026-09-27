# Plasticity MCP

Local stdio MCP server for native CAD modeling in Plasticity 26.1.3 on Apple
Silicon Macs. It drives Plasticity's own command factories and history through
an Electron CDP endpoint bound to loopback. It does not modify the application
bundle, its bytecode, or its signature.

The public MCP interface uses millimeters and degrees. Geometry edits run
through native Plasticity commands, so Undo and Redo remain available. Body,
face, and edge references carry a document revision; mutation tools reject a
stale revision.

Both the Plasticity and optional Workbench MCP servers include concise agent
guidance in the MCP initialize response. Detailed workflows remain available
as named prompts and resources, while the initialize guidance covers safe
revision-bound CAD edits, practical strength checks, optional Workbench use,
and the explicit confirmation required before sending a print job.

## Install

Requirements:

- macOS on Apple Silicon
- Plasticity 26.1.3 in `/Applications/Plasticity.app`
- Node.js 24

```sh
cd .
npm install
npm run start:plasticity
```

`start:plasticity` returns an already enabled window when one exists. If
Plasticity is running without MCP access, it refuses to terminate or restart
it. Save all open work, quit the application, and run the command again. On a
clean start the launcher pauses the Electron main process, preserves the
loopback renderer debugger flags, then resumes startup. No listener is exposed
outside `127.0.0.1`.

For isolated live acceptance, `npm run start:plasticity-isolated` starts a
separate Plasticity process with a new temporary user-data profile and distinct
ephemeral loopback CDP ports. It does not attach to an existing document. Keep
the printed profile directory until the isolated Plasticity process has been
closed; it can then be removed.

Register the stdio server in Codex:

```sh
codex mcp add plasticity -- npm --prefix . start
```

The agent should call `plasticity_list_windows`, then
`plasticity_connect` with an explicit `targetId`. One MCP process owns a window
at a time. Lock files live under `.plasticity-mcp/` and stale process locks are
recovered automatically. Reconnecting to the same window reuses its current
session. Switching windows first acquires and validates the new connection, so
a busy target or failed initial read leaves the existing connection intact.

Some MCP clients expose only a subset of a large server's named tools. In that
case, use `plasticity_call` with `toolName: "catalog"` and a name or description
query to get a bounded page of registered operations and their JSON input
schemas. Pass a returned operation name and its `arguments` object back to
`plasticity_call` to invoke it. The dispatcher only calls tools registered by
this server and applies each operation's original schema and handler; it does
not accept JavaScript or arbitrary method names.

Call `plasticity_status` before editing and pass its `revision` to mutation
tools. It returns compact, paginated body bounds and topology counts (50 bodies
per page by default, at most 200); follow `bodyPagination.nextOffset` to read
the next page and pass the prior page's `revision` as `expectedRevision` so a
manual edit cannot mix pages from different scene states. Use
`plasticity_body_info` for exact face, edge, or vertex IDs and geometry of one
body, or `plasticity_list_bodies` for paginated exact topology details. That
tool returns 10 bodies per page by default (at most 100) and uses the same
revision check when following `bodyPagination.nextOffset`. A document
switch or manual edit changes the revision, so a queued command with an older
revision is rejected before it reaches Plasticity.

Native mutation tools that return a scene state use the same compact body
summary shape, limited to the first 20 bodies, plus a `change` object listing
added, removed, and modified bodies with exact native bounds and topology
counts. Follow `bodyPagination.nextOffset` for more summaries; use
`plasticity_body_info` or `plasticity_list_bodies` when exact face, edge, or
vertex geometry is needed. Non-state operation results keep their own schema.

## Tools

- Connection: diagnose, list windows, connect, status, capabilities, reconcile
- Analysis: list bodies, revision-bound planar regions, exact native curve
  fragments and open-Wire endpoints, editable Wire boundary/control handles, native B-Rep vertices, face normals/surface types/radii, edge
  directions/lengths/adjacency, exact point distance, planar-face separation and angle,
  linear-edge angle and supporting-line clearance, sampled native face-draft classification,
  persistent topology distance and radius annotations, semantic face and edge search, revision-bound
  named selections, exact temporary B-Rep volumetric interference checks,
  exact Solid volume, surface area, and volume centroid, exact selected-face
  area, trimmed boundary length, loop count, and area centroid,
  native body validity, shell closure, printability, and removable viewport section analyses
- Strength: isolated Codex fact extraction, versioned axial, cantilever and
  rectangular-plate methods, deterministic scenario and candidate calculations,
  exact native rectangular-member/plate verification, exact line/circle planar-section properties,
  exact arbitrary-plane sections through native temporary cuts,
  nominal axial/biaxial-bending checks, maximum direct shear for proven solid
  rectangles, solid circles and concentric circular annuli, elastic torsional
  shear for the two circular families, exact single-through-fastener plate
  geometry with bearing/shear-out/net-section checks, one-fastener tension/shear
  and combined-load screening from traceable fastener data, configuration-bound
  heat-set-insert pullout/torque checks, elastic in-plane load distribution over
  a rigid equal-stiffness fastener group, exact rectangular-face group layout
  checks for edge distance, pitch, ligament, and supplied hardware/tool envelopes,
  plus an exact-geometry per-hole local bearing screen for groups (overall plate strength remains conditional),
  immutable reports, and stale detection
  for CAD faces/topology, material, printer profile, and orientation changes
- Collaboration: scene snapshots, change diff, wait for edits, read user-selected
  bodies, linked instances, groups, faces, and edges, and highlight the same
  revision-bound nodes or exact topology in Plasticity
- Measurement: exact revision-bound point, planar-face, and linear-edge queries;
  persistent native vertex distances and circular-edge radius annotations with list and delete
  operations tracked through Plasticity Undo/Redo
- Instances: create and list native linked copies, transform them independently,
  realize selected copies as ordinary B-Rep bodies, and delete them without
  deleting their source geometry
- Creation: box, cylinder, sphere, exact cone or conical frustum and exact ring torus with editable profiles,
  polyline, center-radius, diameter-defined, and three-point circles,
  interpolating NURBS curve, constant-radius helix, exact constant-width slot
  profiles around planar Wire spines,
  constrained B-Surface, planar Region patch, sweep, loft, and solid or hollow pipe
- Recipes: exact round through-holes, explicit multi-center through-hole,
  counterbore, countersink, and flat-bottom blind-hole patterns; through holes with either a flat-bottom counterbore or a
  conical countersink, single or multi-center straight through-slots with semicircular ends, oriented
  single or multi-center hex nut pockets, and single or multi-center
  three-stage heat-set insert pockets, plus single or multi-center attached
  screw bosses with blind pilot holes, matched rounded-print external and
  internal threads, printable hex screws and printable hex nuts,
  profile-driven support ribs, and rectangular arrays of round
  vents, plus cantilever snap-fits with integral hooks; recipes record all
  inputs and return every confirmed native history step; hollow hinge barrels
  can be joined along any world-space axis, circular cable channels can be cut
  along editable Wire paths, rectangular connector openings support exact
  corner radii, two enclosure halves can receive a clearance-matched lip and
  groove joint, paired locating pins expose radial and axial fit clearances,
  oriented tongue-and-groove and dovetail joints keep both construction profiles,
  and split screw/heat-set-insert joints bind the exact insert part number,
  source, thread diameter and pitch to explicit three-stage pocket dimensions
- Construction geometry: coordinate, face-center, and edge-midpoint datum
  points; coordinate, two-point, linear-edge, and cylindrical-face axes;
  explicit, three-point, planar-face, offset, and rotated saved planes;
  list, activate, remove, and refresh tools
- Editing: move, rotate, scale, exact planar face-to-face and cylindrical-axis
  placement of rigid body sets,
  exact native face move, arbitrary-axis rotation, and world-XYZ surface scale with adjacent-face retrimming,
  tolerance-controlled native face refit into a B-Surface,
  independent thickening of selected faces, signed face-loop insertion, and independent Sheet patches from Solid edge loops,
  exact native edge move, signed adjacent-surface edge offset, and compatible split-edge deletion with topology read-back,
  exact native block dimensioning, Boolean, native face-surface cutting, fillet,
  equal-distance chamfer, recognized-fillet removal, closed-profile/explicit-region Solid extrusion,
  signed planar Wire offset, curve-fragment trim, endpoint extension, local Wire control-point transforms and deletion, independent Wire and Region-boundary copies, Wire unjoin, curve imprint, face extrusion, profile revolve, signed
  face offset, Sheet thickening, face draft from a neutral face,
  inward/outward open-face shelling and closed-solid hollowing, exact face deletion/extraction/dissolve, Sheet-edge extension, closed-Sheet solidification,
  Sheet sewing, native G2 Surface Bridge, exact face unjoining, mirror, rectangular, radial, and curve body patterns,
  rename, delete, Undo, Redo
- Intent: a private local construction history records every journaled native
  CAD mutation, exact inputs, before/after revisions, compact geometry diffs
  and uncertain outcomes across MCP restarts; manual edits are reported as a
  divergence
- View: named camera orientations, fit, and a PNG screenshot captured from the
  visible Plasticity renderer through CDP screencast. Hidden windows are
  rejected to avoid stale frames; screenshots support visual review, while exact
  dimensions and geometry validity come from native B-Rep reads
- Documents: save a copy, open with mandatory backup, exact STEP and Parasolid
  (`.x_t`/`.x_b`) import/export, native editable SVG Wire/Region import,
  orthographic hidden-line SVG drawings of Solid B-rep geometry, and
  approximate STL/OBJ reference-mesh import with explicit source units,
  millimeter-scaled binary STL export, validated OBJ export, and validated 3MF
  export with explicit tessellation tolerance and mesh-bound read-back

`plasticity_import_svg` maps SVG coordinate values through an explicit source
unit and creates ordinary editable native Wires. Closed valid contours also
appear as revision-bound Regions, so the agent can inspect their exact B-Rep
segments and use them directly for extrusion or other profile operations. SVG
transforms and path topology still affect placement and region formation, so
the agent must verify the imported geometry rather than trusting file metadata.

`plasticity_export_svg` preserves native Lines, full circles, trimmed circular
arcs, and one closed Ellipse Wire as exact SVG primitives. It approximates
other planar native B-Rep curves with adaptive polylines. The request sets
chord and tangent-angle tolerances; the SVG marks approximated paths, and the
MCP report states the maximum quarter-sample chord deviation observed. This is
an approximation check, not a global mathematical error bound. Noncoplanar
Wires are rejected.

Rational BCurves that fit a stable conic are exported as SVG ellipses or arcs
only after 65 further exact native B-Rep samples agree with the fit. The SVG
labels this finite-sample validation; it is not a proof of global equality.
Repeat the live gate on a separate disposable empty Plasticity document:

```sh
npm run accept:native-svg-rational -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-live \
  --output NEW_EMPTY_DIRECTORY
```

The verifier imports an authored rational STEP fixture, checks the native
degree-2 rational BCurve and generated SVG arc, then undoes the import. The
fixture remains in Redo history, so close the disposable test document after
the acceptance run.
The live NURBS acceptance can be repeated on an empty test window:

```sh
npm run accept:native-svg-approximation -- \
  --target TARGET_ID \
  --allow-live \
  --output /tmp/plasticity-mcp-output
```

`plasticity_export_hiddenline_svg` uses Plasticity's native hidden-line
projector for selected Solid bodies in the current orthographic camera. It
emits vector paths in projected model millimeters, including dashed hidden
edges, without embedding the viewport background. Set the intended front, top,
side, or isometric camera with `plasticity_set_view` first. Perspective views,
Sheets, instances, and non-Solid inputs are not supported by this export path;
the SVG is a derived drawing, while `.plasticity` and STEP remain editable CAD.

The guarded live acceptance can be repeated with:

```sh
npm run accept:native-hiddenline-svg -- \
  --target TARGET_ID \
  --solid-id SOLID_ID \
  --allow-live \
  --output /tmp/plasticity-mcp-output
```

`plasticity_create_slot_profiles` preserves one or more current planar Wire
spines and creates separate closed constant-width Wires around them. The width
is the full finished profile width. The resulting Region can be extruded or
used as a cutter, so this operation is useful for routed cable channels,
gaskets, and curved slots. Plasticity needs the spine itself to determine a
plane; a lone straight segment is ambiguous and should instead use the
dedicated straight slotted-hole recipe or a spine with additional planar
geometry.

The guarded live acceptance can be repeated with:

```sh
npm run accept:native-slot-profiles -- \
  --target TARGET_ID \
  --allow-disposable-mutations \
  --output /tmp/plasticity-mcp-output
```

`plasticity_import_reference_mesh` keeps downloaded or scanned STL/OBJ data in
a separate approximate reference-mesh collection rather than presenting it as
editable B-Rep. `plasticity_list_reference_meshes` reports its source,
world-space mesh bounds, triangle counts, and transform with
`measurementSource: "reference-mesh"`. Dedicated select, rename, move, rotate,
scale, and delete tools let the agent register a reference against qualified
dimensions inside Plasticity. Reference meshes can also be placed in native
groups and controlled through the mixed-node visibility and lock tools. These
bounds can guide placement and visual comparison, but they cannot prove a
manufacturing dimension or replace manufacturer CAD, drawings, or
user-confirmed measurements.

When a product search yields a directly downloadable public STL or OBJ,
`plasticity_download_and_import_reference_mesh` can fetch and import only the
explicitly selected HTTPS asset. The call must name its format and source unit
(STL itself carries no unit metadata); source URL, optional source page, license,
confidence, SHA-256, and observed mesh bounds are recorded separately from exact
CAD imports. Downloads are limited to public IPv4 destinations, bounded to 64
MiB, reject archives, and validate the mesh and finite coordinates before the
native import. Search results are never downloaded automatically, and an
approximate mesh does not become a fit-critical datum without confirmed
measurements.

Plasticity's native 3MF importer is also exposed for reference acquisition.
`plasticity_import_reference_3mf` uses the unit embedded in the 3MF model (the
3MF default is millimetres) and imports tessellated reference geometry, not an
editable B-Rep. A selected direct HTTPS 3MF asset can be downloaded and
imported with `plasticity_download_and_import_reference_3mf`; the bounded ZIP
reader validates package paths, limits expansion, checks CRCs, and records the
artifact hash and redacted source provenance. Its bounds remain approximate
reference-mesh evidence and must not replace fit-critical drawings or
confirmed dimensions.

The live remote-download acceptance can be repeated with a selected direct
asset URL. It temporarily imports the mesh into the explicit Plasticity window
and undoes that operation only if the document revision is still the import
revision; pre-existing scene geometry is preserved.

```sh
npm run accept:reference-mesh-download -- \
  --target TARGET_ID \
  --source-url https://raw.githubusercontent.com/Buildbee/example-stl/main/ascii-cube.stl \
  --source-page-url https://github.com/Buildbee/example-stl \
  --format stl \
  --source-unit millimeter \
  --output /tmp/plasticity-mcp-output
```

The guarded live acceptance can be repeated with:

```sh
npm run accept:native-reference-mesh -- \
  --target TARGET_ID \
  --allow-disposable-mutations \
  --output /tmp/plasticity-mcp-output
```

Files are never overwritten. After a command timeout or lost connection, the
server marks the mutation outcome uncertain and blocks further edits until
`plasticity_reconcile` reads the document. It never retries the command or
automatically undoes it.

The strength workflow is documented in
[`docs/strength-operations.md`](./strength-operations.md). It is available
through the `plasticity_strength_first` prompt and the
`plasticity://strength/workflow`, `plasticity://strength/methods`, and
`plasticity://strength/recovery` resources. Codex uses this deeper workflow when
the load, consequences, or a design decision warrant it; ordinary enclosure
and bracket modeling can start with a practical provisional design and basic
functional checks without a coupon campaign or detailed FEA. Numerical
calculations remain available when isolated Codex analysis is unavailable. Native verification
requires an explicit connected Plasticity window. `plasticity_inspect_planar_section`
reads one selected native Solid face. `plasticity_inspect_arbitrary_section`
measures an internal critical plane by cutting a native clone in a temporary
geometry database; the persistent Solid, revision and Undo/Redo history are
checked before the result is accepted. Both tools reject unsupported curves and
never use a render mesh as measurement evidence. Stored strength verification
is still face-bound; arbitrary-plane properties can be used in an unbound
scenario. They do not validate the whole part or approve a print. Workbench is
optional.

When exact-process physical material evidence is missing, the read-only
`plasticity_plan_single_material_strength_tests` MCP tool creates a measurement
matrix for the selected solver scope. It distinguishes road, in-plane
transverse and layer-normal properties, and can plan same-material layer
interface tests. It requires the exact printer/material/profile/orientation,
infill percentage and pattern, wall loops, top/bottom shell layers, nozzle
temperature and measured layer height; it does not invent
material values, design allowables, test standards, specimen dimensions or
sample counts. The active mechanical model remains one material per print
process. Complementary physical coupon records for that same exact process can be consolidated with `plasticity_combine_material_coupon_data` after the unique specimen count is confirmed; values are never averaged.

The static FEA supports the homogeneous-material CalculiX route and an
experimental layerwise orthotropic route. The latter uses one measured tensor
for the selected single material, mapped to each layer only after complete
G-code road-direction evidence and explicit user confirmation of slicer-to-CAD
and coupon-axis mapping. It creates a conformal mesh with shared nodes between
layers and labels solver stresses in each layer's local material frame. The
interfaces are assumed perfectly bonded: this mode does not model delamination,
different materials, or layer-varying properties, and it does not issue a
strength verdict. An
experimental `plasticity_analyze_cohesive_interface` tool can also export one
current Solid to STEP, split it at one or more explicitly supplied parallel
planes, mesh the regions in Gmsh, add PENTA6 cohesive elements, and run pinned
Code_Aster from exact-process interface-test curves and coupon records. The
legacy route uses DCB mode-I data; an experimental mixed-mode route uses matched
DCB/ENF/MMB evidence to fit a Turon cohesive law. The Turon route can use
homogeneous orthotropic bulk tensors and print frames from each immutable
exact-process coupon record. Cohesive analyses require one material process;
multi-plane analyses repeat the same measured interface law at every plane.
Mode-I accepts an explicit `modeILaw` choice of `CZM_EXP_REG` (the compatibility
default) or `CZM_LIN_REG`. Both use measured peak traction and integrated
fracture energy; neither fits arbitrary curve shape, so justify the selected
softening law against the measured curve.
Every new cohesive analysis requires `plasticity_plan_cohesive_layer_planes` to
derive profile-bound split planes; arbitrary unbound planes are rejected. The
planner derives copy-ready split planes from the
selected slicer profile hash, its layer height, a caller-supplied first-interface
anchor (validated against the Solid only when meshing succeeds), a confirmed
global build direction and explicit layer indices. Pass its plan and planes to
the cohesive analysis; the analysis checks the profile hash
against the physical test and, for orthotropic bulk, checks the build axis
against the exact coupon frame. It analyzes the full stack only when all layer
interfaces fit within the 32-plane solver limit. Larger stacks are marked as
selected-interface-only, and omitted layers remain unanalyzed.
New physical coupon records and same-material interface tests require the
measured slicer layer height in their immutable process identity; analysis
rejects legacy evidence without it and any mismatch even when the profile hash
matches.
Interface tests can additionally preserve actual specimen G-code provenance:
profile, model/G-code hashes, sampled per-layer road directions and a
user-confirmed slicer-to-global frame. This helps interpret the tested raster
orientation; it does not supply adhesion strength, qualify a cohesive law, or
feed road-direction data into the current cohesive solver.
When Workbench has a complete deposition-height schedule from the actual G-code,
`workbench_slicer_interface_heights` returns only selected interface heights
and the first-layer reference height. The planner accepts their relative values
as `interfaceOffsetsMm`, so a taller first layer or adaptive layer heights do
not get approximated by the nominal profile height. G-code Z values are in the
slicer's build frame; map only their relative offsets onto a separately
confirmed CAD build axis and anchor.
The same MCP response also reports selected layers' XY deposition-road
direction summaries from extruding linear G-code moves. It reports a dominant
road axis modulo 180 degrees and a directional-concentration value; arc and
spline extrusion moves make that layer's coverage explicitly partial. These
summaries describe the toolpath only and are not material properties or a
validated road-level strength model. The read-only
`workbench_slicer_layer_path_orientations` tool returns selected actual layers,
including the final layer, in bounded batches of 32 with their deposition Z and
the same job/profile/G-code hashes. The cohesive plane planner can preserve the
selected summaries with the exact job, profile, source-artifact, G-code, layer
count and relative-offset identities in an immutable analysis report. To send
layer directions into the solver, the user must additionally confirm that the
exact-process coupon's material axis 1 represents the dominant deposited-road
direction with `roadAxisMapping`, provide complete linear direction evidence
for every layer (up to 256), and explicitly enable the measured orthotropic bulk
tensor. The Mode-I and mixed-mode Turon routes then assign that one shared
measured tensor to each layer's own local frame. This represents orientation
changes only: it does not create different materials or layer properties.
Cohesive analysis still represents specified same-material layer interfaces,
not individual extrusion roads or within-layer raster mixtures. The same
measured, direction-independent cohesive law is repeated at every interface.
ENF and MMB calibration records must use the
same in-plane shear axis. A mixed-mode solver displacement must contain both
opening and shear and use that measured shear axis; other directions are
rejected before meshing because the law has one tangential response. This does
not prove the actual bond is isotropic or identify separate Mode-II/Mode-III
properties. Neither route qualifies part strength. It checks the CAD revision
and reports the raw solver response.
The public path has passed synthetic solver and MCP acceptance, including live
Code_Aster 17.4 runs with three distinct layer frames for both Mode-I and Turon,
but has not yet been run against registered physical coupon and interface-test data. Results are saved
as immutable cohesive reports and can be reread with
`plasticity_cohesive_fem_report`, which rechecks the CAD binding and exact
interface-test/coupon evidence. The Turon route additionally requires traceable
initial stiffness `K`, which is not inferred from a curve. Neither response is
a qualified material law or part-strength result. See
[`docs/cohesive-solver-spike.md`](./cohesive-solver-spike.md) and run
`npm run accept:code-aster-czm` to repeat the solver-only check.

The launcher uses the installed `codex` executable by default. Set
`PLASTICITY_CODEX_EXECUTABLE` to another trusted executable, and
`PLASTICITY_STRENGTH_ASSET_ROOT` to the directory containing explicitly
supplied analysis images. Images in the signed-in Codex user's
`~/.codex/attachments` folder are also accepted directly. Add other trusted
image folders with `PLASTICITY_STRENGTH_IMAGE_ROOTS`, separated by the
platform path separator. Each requested path must resolve inside one of those
roots; symlink targets outside them are rejected. Inputs remain bounded to
four PNG/JPEG/HEIC/HEIF images of at most 20 MiB each. On macOS, HEIC/HEIF
attachments are converted locally to JPEG in a private temporary directory for
Codex analysis; request fingerprints still bind to the original attachment.
Strength records default to
`.plasticity-mcp/strength`; a trusted process may override this with
`PLASTICITY_STRENGTH_ROOT`.

The guarded real-environment acceptance procedure and its measured results are
recorded in [`docs/strength-acceptance.md`](./strength-acceptance.md). It
uses a real stdio client, isolated Codex analysis and a disposable empty
Plasticity document; running the acceptance command without explicit mutation,
live-Codex, target and new-output flags performs no live work.

The exact face-bound section and direct-shear acceptance can be repeated with:

```sh
npm run accept:section-strength -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It creates and removes disposable native rectangle, circle, annulus and
perforated-rectangle bodies. The annulus is recognized from its two exact
concentric circular boundaries; unsupported section families remain explicit.

The exact single-fastener plate acceptance can be repeated with:

```sh
npm run accept:fastener-strength -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It creates a disposable 40 × 20 × 2 mm plate with one Ø6 mm through-hole,
reads thickness and every edge distance from opposed native faces, verifies
bearing, two-plane edge shear-out and net-section tension, checks stale-report
behavior, resolves an M5 tapped-metal request to the threaded-receiver method,
checks a clearly labelled synthetic three-mode capacity scenario and its stale
engagement behavior, then restores the empty document.

The fastener itself is a separate evidence-bound scenario. Call
`plasticity_calculate_fastener_member_strength` with the sourced tensile stress
area, effective shear area at the actual plane, one or two shear planes, axial
tension including applicable preload, transverse shear, and grade-specific
tensile/shear limits. It reports the two stresses, factored load ratios, and the
NASA screening interaction `R_t² + R_s³`. It does not infer a standard fastener
table from nominal diameter alone.

The receiving thread is checked separately with
`plasticity_calculate_threaded_receiver_strength`. For a tapped hole, nut, or
threaded insert it requires actual pitch and engagement, the number of fully
formed engaged threads, the worst-case axial demand, and explicit compatible
allowable loads for internal-thread stripping, external-thread stripping, and
fastener tension. It reports all three utilizations and can require the fastener
to fail in tension before either thread strips. A nominal designation such as
`M5×10` supplies thread metadata only. Procured nuts and inserts require a
specified assembly allowable or matched dedicated test rather than an
unqualified nominal shear-area estimate.

Before creating fastening geometry, call
`plasticity_resolve_fastener_designation` with the user's wording, for example
`винт M5x10`, `крепится на 4 болта M5x10 с гайками` or
`болт ISO 4017 M5×0,8×10 класс 8.8`. The resolver separates nominal thread
diameter, pitch, length, quantity, head/standard, property class, receiving
feature and fixed/adjustable/pivot intent, then lists the compatible CAD and
strength tools. Its default is `analysisIntent=both`; `nextQuestionPackage`
contains only the current logical package, with load path, joined materials and
process, and failure consequence first. Later packages cover joint purpose,
hardware selection, and qualified feature geometry without presenting every
future question at once. Natural phrases can resolve a nut, heat-set insert,
tapped metal, printed plastic, or a fully printed screw with a mating nut or a
generically named mating part without a redundant question. Russian forms such
as `печать винта M6x20 и ответной части` route to the matched custom-thread
tools. The printed-pair route does not import ISO coarse pitch from an M-like
crest diameter. An adjustment slot is routed only when adjustment is explicit.
Repeated fixed fasteners into printed plastic route to one grouped boss recipe;
the agent still must resolve the exact screw family and qualified pilot/boss
dimensions for the selected material, printer, profile, orientation, and reuse.
`decisionMode=agent-may-select-qualified` lets the agent source ordinary
catalog/standard dimensions, while unresolved functional or strength choices
remain with the user. A plain `M5×10`
does not define a clearance hole, tap drill, heat-set-insert pocket, head recess,
nut/washer envelope or allowable load. Those values remain required inputs from
the chosen fit, current standard or exact manufacturer part and qualified
printer/material/profile process. Ambiguous short forms such as `M10×1` are
returned as questions instead of being guessed as pitch or length.

### Matched printable threads

The server can build a complete custom printed pair or add either side to an
existing design:

- `plasticity_create_printed_hex_pair` accepts an M-like diameter-and-length
  shorthand such as `M5x10`, then creates both a hex screw and matching nut
  from one shared custom thread definition. It records the printer, material,
  slicing profile, orientation, clearance basis, and sizing basis with the
  result. An explicit pitch in a three-number designation must match the
  supplied custom profile pitch.
- `plasticity_create_printed_external_thread` creates a standalone threaded
  Solid from an exact cylindrical core, native Helix, swept circular ridge,
  Boolean union, and crest-envelope intersection.
- `plasticity_cut_printed_internal_thread` cuts the matching enlarged bore and
  helical groove into one existing Solid.
- `plasticity_create_printed_hex_screw` adds an overlapping wrenchable hex
  head to the external thread.
- `plasticity_create_printed_hex_nut` extrudes a regular hex blank and cuts the
  matching internal thread while enforcing an explicit minimum wall.
- `plasticity_create_printed_thread_calibration_set` creates one reference
  screw and 2-8 separate nuts with unique candidate clearances. Each sample has
  an explicit ID and position; the result records the exact printer, material,
  slicing profile, orientation, and sizing basis, and remains marked
  `requires-physical-fit-test` until the user prints and tests it.
- `plasticity_record_printed_thread_qualification` stores a user-confirmed
  physical fit result in the core MCP's immutable local registry;
  `plasticity_match_printed_thread_qualification` reuses it only for the exact
  printer, material, slicer profile, nozzle diameter, layer height, orientation,
  rounded thread definition, fit class, and a tested engagement at least as
  long as the requested engagement. Conflicting clearances return `ambiguous`.

The six geometry tools use the one-start `rounded-print-v1` profile. Diameter,
pitch, thread depth, handedness, length, and radial direction are explicit. The
internal side also requires a normal profile clearance; this enlarges both its base bore
and swept groove relative to the male profile. The source Helix and hex profile
Wire remain editable in Plasticity. Every native step is journaled, and a
failed recipe reports its last confirmed revision without retrying.

The process identity also includes `nozzleDiameterMm` and `layerHeightMm`.
Optional `processFingerprintSha256` can bind it to an exact immutable slicer
configuration. A saved qualification is content-addressed, append-only, and
idempotent. It requires `confirmedPhysicalTest=true`, a specimen sample ID,
fit class, tested engagement, completed cycle count, and test time. A viewport
or B-Rep interference result cannot be recorded as a physical qualification.
The default registry is `.plasticity-mcp/thread-qualifications`; set
`PLASTICITY_THREAD_QUALIFICATION_ROOT` to use another local directory.
When Workbench is available, its immutable manufacturing profile remains the
source of printer/material/slicer configuration and hashes; the core registry
stores only the physical thread-fit result keyed to that identity. It therefore
does not make Workbench mandatory or create a second slicer preset format.

This is a custom matched printing profile. It is not an ISO metric thread, and
a 5 mm crest diameter does not make it an M5 fastener. The agent resolves load,
engagement, failure consequence, printer, material, slicing profile,
orientation, pitch, depth, clearance, head envelope, nut dimensions, and
wrench access. If the user delegates ordinary process choices, the agent
proposes them with their basis. Strength still requires configuration-matched
internal-stripping, external-stripping, and screw-tension allowables through
`plasticity_calculate_threaded_receiver_strength`.

An exact no-interference result at one aligned phase proves only that indexed
pose. It does not prove continuous helical travel or the fit of real printed
parts. When that process has no qualified thread clearance, create the ladder,
print every sample with the recorded settings and orientation, test full travel
and the intended reuse/load behavior, then store the selected sample ID and
clearance with `plasticity_record_printed_thread_qualification`. Before later
production geometry, query it with
`plasticity_match_printed_thread_qualification`. Passing its immutable ID to
`plasticity_create_printed_hex_pair` binds the generated pair to the exact
physical result; omitting the ID leaves the pair marked
`requires-physical-fit-test`.

The guarded live acceptance is:

```sh
npm run accept:printed-threads -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It refuses a nonempty document, creates a custom 5 mm screw and matching nut
through one `plasticity_create_printed_hex_pair` call, confirms that `M5x8`
supplied only the 5 mm crest diameter and 8 mm length, records the synthetic
K1C/PLA/process qualification context, returns all 15 native Undo steps,
checks exact cylindrical B-Rep radii and native body validity, verifies no
volumetric intersection in one aligned phase, deliberately rotates the nut to
prove that a phase error intersects, restores alignment with Undo, and finally
restores the initial empty scene.

The calibration-set acceptance is separate because it validates a process
qualification artifact rather than one selected fit:

```sh
npm run accept:printed-thread-calibration -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It creates one 5 mm reference screw and two nuts with 0.10 mm and 0.20 mm
normal profile clearances, checks the three exact native Solids and their
distinct bore radii, confirms the result still requires a physical fit test,
and restores the initial empty scene.

The bounded standard catalog classifies ISO 4014/4017 hex fasteners, ISO 4762
and DIN 912 socket-head cap screws, ISO 7380-1/-2 button heads, ISO 7045 and
14583 pan heads, ISO 7046-1, 10642 and 14581 countersunk heads, and ISO
4026/4027/4028/4029 headless set screws. Each current ISO entry returns its
official source URL and selects only the compatible modeling route. The
resolver does not copy a standard's dimensional table into CAD: actual head,
driver, hole, recess, washer, nut, fit, and process dimensions still come from
the exact current product or qualified standard data. The result distinguishes
external hex, hexagon socket, hexalobular socket, and cross-recessed drives.
For ISO 4026–4029 it also returns the flat, truncated-cone, dog, or cup point,
requires the mating contact and driver-access envelope, and reports
`SET_SCREW_TENSION_LIMITATION`, because those families are not intended to
carry tensile load. The agent must resolve the real load path before a strength
decision.

After the designation and joint type are resolved,
`plasticity_check_fastener_stack` checks the stated nominal length against an
explicit list of clamped layers and either a nut envelope or a threaded
receiver. For a nut it checks minimum and optional maximum protrusion. For an
insert, tapped hole, or qualified plastic thread it checks engagement,
available thread length, optional blind depth and tip clearance. Countersunk or
other overall-length products require an explicit head axial length. A passing
result proves only axial stack compatibility; strength, preload, fit, tool
access, thread stripping, and printed-part behavior remain separate checks.
When those layers already exist in Plasticity,
`plasticity_measure_fastener_grip_stack` reads each thickness from an explicit
pair of opposite planar B-Rep faces aligned with the fastener axis. Its
revision-bound `gripItems` feed the length check directly. Duplicate face pairs,
cross-body pairs, nonparallel faces, Sheets, stale revisions, and faces not
normal to the fastener axis are rejected; an unmodeled washer remains an
explicit sourced layer rather than an inferred dimension.

The guarded real-application acceptance for the countersink, trapped-nut
pocket, round through-hole, blind-hole, and adjustment-slot recipes is:

```sh
npm run accept:fastener-pockets -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It resolves fixed, adjustable, and tapped-metal M5 fastening requests, builds a
disposable exact plate, checks a dedicated Ø5.5 through-hole and a flat-bottom
Ø4.2 × 5 mm blind hole, the conical and cylindrical faces of an ISO 10642
countersink, the six hex-pocket planes, and the exact R3 ends and 14 mm straight
sections of a 20 × 6 mm slot from native B-Rep. It runs native body validation,
verifies Undo/Redo, and restores the empty document. No live work occurs unless
the explicit target, mutation flag, and a new output directory are supplied.

`plasticity_calculate_heat_set_insert_retention` checks the installed insert as
a separate qualified component. It needs the worst-case axial and torque demand
on one insert plus measured or sourced pullout and torque-out capacity for the
same insert, host material, K1C/profile, print orientation, pocket dimensions
and installation process. Data for moulded ABS or polycarbonate remains
unconfirmed for printed PLA unless a matching qualification proves otherwise.

`plasticity_distribute_fastener_group_load` resolves a complete in-plane force,
its point of application and any free moment over two or more distinct fastener
points. It returns the direct share, elastic moment share, resultant vector and
magnitude for every fastener plus the governing shear demand. A `calculated`
result proves only equilibrium under the rigid, identical-stiffness model; pass
the governing demand to the separate fastener, plate and insert checks.

Use `plasticity_inspect_fastener_group` before that calculation when the hole
pattern already exists in Plasticity. Supply one Solid, two or more explicit
cylindrical face IDs, the current document revision, and a plane frame. The MCP
intersects each exact cylinder axis with the frame, returns local X/Y centers
and native diameters, and emits measured evidence plus assignment paths for the
load-distribution input. The binding records the session, document, revision,
body, selected faces, frame and a topology signature. Stale revisions, skew
axes and coaxial duplicate faces are rejected rather than silently remapped.
Pass that binding and input fragment to
`plasticity_verify_fastener_group_load` to re-read the faces, replace all
fastener coordinates with current native measurements and save a CAD-bound
distribution report. `plasticity_strength_report` then rechecks the face set,
frame and topology signature and marks the report stale after a manual edit.

Use `plasticity_check_fastener_group_layout` on the same cylindrical faces and
one exact rectangular planar boundary face to measure every center-to-edge and
hole-edge distance, every pair's center spacing and remaining ligament, and
circular mounting envelopes for heads, washers, nuts or driver access. Envelope
diameters and required clearances must come from a named standard, manufacturer
data, a qualified process rule or an explicit user decision recorded in
`requirements.basis`. Without requirements the result is `measured`; only an
explicit comparison can return `pass` or `fail`. That status covers layout
geometry only and does not replace fastener, insert, boss or plate strength.

The guarded real-application acceptance for designation parsing, a native
four-hole plate, exact B-Rep group inspection, load distribution, stale
reference rejection and Undo cleanup is:

```sh
npm run accept:fastener-group -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

Exact arbitrary-plane inspection has its own guarded acceptance command:

```sh
npm run accept:arbitrary-section -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It refuses a nonempty document, checks horizontal and 45-degree sections of a
disposable 20 × 10 × 5 mm Solid through the real stdio MCP, verifies that body
geometry and history remain unchanged, then restores the empty document.

`boundsMm` comes from the native B-Rep model's `FindBox()` result. Semantic
metadata is read from native faces and edges; each body also publishes exact
vertex entity IDs and `Vertex.GetPoint()` coordinates. Vertex, face and edge
references are valid only at the returned revision. `plasticity_measure_point_distance`
resolves exact vertices, edge parameter midpoints, face evaluation points or
explicit millimeter coordinates and reports both XYZ delta and Euclidean distance.
`plasticity_measure_planar_faces` reports the angle between exact face planes and
parallel supporting-plane separation (`separationKind: "supporting-planes"`). It
does not check whether the trimmed faces overlap or measure the actual gap between
their boundaries. `plasticity_measure_parallel_planar_face_clearance` computes
exact minimum clearance between parallel planar faces (within 1e-7 degrees)
with closed polygonal trims, complete circles, and exact trimmed circular
arcs, including nested loops and holes, up to 512 edges per face. It rejects
other curved boundaries, nonparallel faces and incomplete topology.
For nonparallel faces, `plasticity_measure_nonparallel_planar_polygon_clearance`
computes exact distance between simple straight-edged polygonal regions on
each face, including zero distance when the finite regions intersect. Concave
outlines, holes, and multiple nested or disjoint loops are supported. It
limits each face to 512 boundary vertices and 4,096 exact decomposition
triangles, and rejects parallel faces, arcs, and self-intersecting or touching
contours.
Neither face tool checks whole-body clearance or collision.
`plasticity_measure_linear_edges` reports the angle
and shortest distance between the infinite supporting lines; returned edge
lengths still describe the bounded edges. Topology bounds remain viewport
geometry bounds and are mainly for locating entities. Face and edge IDs are
version specific. Named selections store their geometric query, re-evaluate
after a topology change and report `unresolved` or `ambiguous` instead of
guessing.

`plasticity_list_regions` exposes the automatic planar regions generated by
Plasticity for closed coplanar curves. Region IDs are valid only for the
returned document revision. `displayBoundsMm` is explicitly tagged
`measurementSource: "render-mesh"` and is only for choosing a region; dimensions
of the resulting Solid are verified from native B-Rep `boundsMm`.
`plasticity_extrude_profile` creates a Solid only when a Wire resolves to one
unambiguous region. For nested loops or several regions, list them and call
`plasticity_extrude_regions` with the chosen revision-bound IDs.
`plasticity_offset_planar_curves` preserves the source Wires and creates native
offset Wires. Its signed millimeter distance follows each Wire orientation.
`plasticity_offset_regions` accepts explicit current Region IDs from one sketch
and creates one or two signed offsets in one native history step. This is the
preferred path for wall contours, nested loops and clearance boundaries.
For Trim, `plasticity_list_curve_fragments` returns exact native start, midpoint,
end and length data tied to the current revision. Pass chosen IDs to
`plasticity_trim_curve_fragments`; stale fragment IDs are rejected.
`plasticity_list_curve_intersections` filters Plasticity's native cross-point
database to intersections between user Wire bodies and reports their exact
coordinates and participating body versions for the current revision.
`plasticity_list_curve_endpoints` reports exact native endpoint coordinates for
open Wires. `plasticity_extend_curve_endpoints` extends one or several selected
ends by a positive millimeter distance in one history step.
`plasticity_list_curve_vertices` reports every exact native Wire vertex, its
endpoint status, position, and adjacent segment entity IDs.
`plasticity_convert_curve_vertices_to_control_points` converts selected current
interior or closed Wire vertices into editable cubic B-Spline control vertices
in one native history step. Open endpoints are rejected. Conversion replaces
the contributing segments and changes the path, so discard every old vertex and
segment reference, then inspect the returned curve structure and control points.
The guarded live check can be repeated with:

```sh
npm run accept:native-curve-vertex-conversion -- \\
  --target PLASTICITY_WINDOW_ID \\
  --allow-disposable-mutations \\
  --output NEW_EMPTY_DIRECTORY
```

It converts two corners in a disposable polyline, checks exact B-Spline degree,
control-point count, endpoints, length, endpoint rejection and Undo/Redo, then
restores the empty document.
Pass current `bodyId`/`vertexId` pairs to
`plasticity_fillet_curve_vertices` to round one or
several interior or closed profile corners with one positive millimeter radius
in one native history step. Re-read the returned state because Plasticity may
replace a Wire's stable body ID when its topology changes.
`plasticity_list_curve_directions` reports exact native start/end points and
tangents for every Wire segment. `plasticity_reverse_curves` reverses that
orientation explicitly, so signed offsets and path operations do not depend on
guessing. `plasticity_reverse_sheets` likewise reverses Sheet face normals.
`plasticity_create_body_outlines` creates exact native silhouette Wires from
current Solid or Sheet bodies while preserving the source geometry. The caller
must supply a current construction-plane identity and choose whether the
silhouette remains at the source geometry or is projected onto that workplane.
The resulting closed Wires expose Regions for gasket, lid, clearance, and
mating-profile workflows; dimensions are read back from native curve segments.
`plasticity_unjoin_curves` splits compound Wire bodies such as polylines into
separate editable native curve bodies. `plasticity_join_curves` combines two or
more Wire bodies again; connected closed segments produce a selectable Region.
Each operation is one reversible history step.
`plasticity_duplicate_curves` creates independent exact native copies of
current Wire bodies in place. The source and copies keep separate stable body
IDs, so the copies can be moved or edited without changing the originals.
`plasticity_create_curves_from_regions` copies the exact boundaries of current
planar Regions into independent Wire bodies. Because the coincident boundary
changes Plasticity's automatic sketch topology, every earlier Region reference
becomes stale even though the source Wire geometry remains; read the returned
state or call `plasticity_list_regions` before using a Region downstream.
`plasticity_project_curves_onto_body` preserves the source Wires and creates
native projected Wires on a Solid or Sheet. The caller supplies a nonzero
world-space direction and can choose bidirectional projection, visible-surface
occlusion, and Plasticity's none/edge/face-set completion modes.
`plasticity_create_body_intersection_curves` preserves one target and one or
more Solid or Sheet tools, then creates independent native Wires at every exact
body intersection in one history step. Use it when the intersection curve is
needed for construction without splitting either source body.
`plasticity_project_curve_pair` constructs one independent spatial Wire from
two distinct source Wires by intersecting their bidirectional extrusion
surfaces. Each source has an explicit world-space projection direction, and the
caller supplies a millimeter depth large enough for the temporary surfaces to
overlap. This supports a 3D guide defined by two orthogonal sketches while
keeping both sketches editable.
`plasticity_insert_isoparam_edges` inserts native U- or V-isoparametric edges
into one current Solid or Sheet face and splits that face in place. U/V follow
the face's parameterization rather than world axes. Re-read analytic surface
types, radii, topology, dimensions, validation, and mass properties afterward.
On the accepted 26.1.3 cylinder case, all four result faces remained analytical
R5 Cylinders and bounds stayed Ø10 × 20 mm, while the native mass-properties
integrator changed its volume estimate by about 0.422 mm³ after the periodic
surface was split; the MCP reports this result and does not claim numerical
mass-property invariance.
`plasticity_inspect_surface_structure` reads the exact carrier type, trim state,
face and natural UV parameter ranges, and compact B-Surface degree, span,
control-point, and rationality data for current Solid or Sheet faces. UV values
are native parameters rather than millimeter dimensions.
`plasticity_analyze_surface_continuity` runs Plasticity's native continuity
evaluator across current shell edges shared by exactly two faces. For each edge
it reports the maximum sampled G0 position deviation in millimeters, G1
normal-angle deviation in degrees, Plasticity's dimensionless relative G2
curvature deviation, the location of each maximum, and a hierarchical
G0/G1/G2 result against explicit tolerances. Plasticity samples 100 positions;
the result comes from native B-Rep surfaces rather than the display mesh, but it
is not an exact continuous maximum and does not change the document.
`plasticity_analyze_edge_curvature` runs Plasticity's native curvature
evaluator at 100 positions on each selected B-Rep edge. Wire segments use the
numeric `segmentEntityId` returned by `plasticity_list_curve_directions`;
Solid and Sheet edges use the revision-bound string `edgeId` from document
state. The compact result reports minimum, maximum, and mean curvature in
1/mm, locations of both extrema, the maximum curvature vector, finite radii of
curvature in millimeters, and whether any sampled point is straight. A straight
edge returns `null` for both finite-radius fields. This is native sampled
analysis rather than an exact continuous extremum, and it does not change the
document or Undo/Redo history.
`plasticity_raise_surface_degree` raises both native B-Surface directions by one
Plasticity step in one history entry. On the accepted 26.1.3 surface it changed
degree 3/3 to 4/4, spans 3/2 to 5/3, control points 6×5 to 9×7, and altered an
exact bound by 1.685846 mm. Treat it as a shape-changing rebuild and verify all
functional geometry afterward.
`plasticity_rebuild_face` refits one exact current Solid or Sheet face into a
native B-Surface using projected boundary edges and an explicit positive
millimeter tolerance. It preserves the owning body's stable ID and uses one
history step, but invalidates all topology references. The tolerance is a
Plasticity approximation input, so re-read functional dimensions, surface
structure, continuity, mass properties, and native validity afterward.
`plasticity_match_faces` replaces one or more exact current Solid or Sheet face
surfaces with the carrier surface of a separate replacement face. Plasticity
extends or trims the adjacent faces, preserves both edited body IDs and an
external replacement body, and uses one history step. The operation invalidates prior
topology references; re-read bounds, analytic surface types, mass properties,
interference, and native validity before continuing.
`plasticity_untrim_faces` discards the selected trim boundary and restores each
face to the natural UV bounds of its carrier surface. It preserves the body ID,
but changes exact bounds, can overlap adjacent geometry, and invalidates all old
topology references. Read surface structure and validate intersections after
every use.

The guarded surface-refinement acceptance, including face matching and face
refit, can be repeated with:

```sh
npm run accept:native-surface-refinement -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

`plasticity_imprint_curves_on_body` uses the same projection controls but splits
the target's exact faces along the projected Wires. The source Wires remain in
the document; the new face and edge IDs can be selected for deletion,
extraction, offset, or other surface work.
`plasticity_imprint_bodies` splits a Solid or Sheet target along its exact
intersections with one or more Solid or Sheet tools. Tool bodies are preserved,
which supports reusable mating envelopes and selective downstream face edits.
`plasticity_create_through_hole` cuts one exact round hole from an explicit
finished diameter and material depth. `entryCenterMm` lies on the entry surface,
`axis` points into the material, and `overshootMm` extends the temporary cutter
past both tangent boundaries. The recipe creates one native cylinder, consumes
it in one Boolean difference, and returns both confirmed revisions. A thread
designation such as M5×10 is resolved first, but its nominal 5 mm diameter is
never substituted for the selected clearance, pilot, or insert-hole diameter.
`plasticity_create_through_hole_pattern` cuts 2–256 equal round holes at
explicit entry centers in one Solid. It creates one native cylinder for each
center and consumes every cutter in one final Boolean difference, so a pattern
of N holes has N+1 confirmed Undo steps. Use it after a phrase such as
`крепится на 4 болта M5×10` has been resolved and the selected fit has supplied
the finished hole diameter, material depth, and every center. The tool does not
invent spacing, edge distances, fit, or load capacity from the designation.
`plasticity_create_blind_hole` cuts a flat-bottom round hole from an explicit
finished diameter and depth. It also requires the available local material
depth and rejects `holeDepthMm >= materialDepthMm` before mutation. Use it for a
qualified blind tap drill, self-tapping pilot, or a pilot in an existing boss.
The recipe does not infer hole depth from fastener length and does not model or
claim a physical thread.
`plasticity_create_blind_hole_pattern` applies one qualified finished diameter
and depth at 2–256 explicit entry centers. It creates one native cylinder per
center and consumes every cutter in one final Boolean, so N holes have N+1
confirmed Undo steps. Fixed requests for several tapped-metal fasteners route
to this grouped recipe; the agent must still resolve the actual tap-drill or
modeled minor diameter, engagement, local material depth, tip clearance, and
every center.
`plasticity_create_countersink` cuts a finished through hole and concentric
conical head recess from explicit dimensions. `entryCenterMm` lies on the entry
surface, `axis` points into the material, and `radialDirection` fixes the
editable meridional profile plane. The countersink depth is derived from the
finished through diameter, major diameter, and included angle; the recipe
rejects a recess that reaches through the target. It creates a through-cylinder
cutter, preserves an annular Wire profile, revolves the conical cutter, and
consumes both cutters in one Boolean, returning four native Undo steps.
`plasticity_create_countersink_pattern` applies the same finished bore, major
diameter, and included angle at 2–64 explicit entry centers. Each center creates
one through cutter, one preserved editable meridional Wire, and one revolved
conical cutter; a final Boolean consumes all solid cutters. A pattern of N
countersinks therefore has 3N+1 confirmed Undo steps. A fixed request such as
`4 винта ISO 10642 M5×10` routes here, but the agent must still resolve the
selected standard, fit, manufacturing allowance, material depth, and every
center rather than deriving geometry from the nominal thread designation.
`plasticity_create_hex_nut_pocket` cuts a blind regular hexagon from an explicit
across-flats size, pocket depth, and material depth; the pocket depth must stay
below the material depth. `flatNormalDirection` controls the orientation of
one pair of opposite flats. The source Wire remains editable, while its native
Region is extruded and consumed by the Boolean in three Undo steps. None of
these recipes derives head, hole, washer, or nut dimensions from an `M` designation;
the agent must use the selected standard or manufacturer part plus fit and
process clearance.
`plasticity_create_hex_nut_pocket_pattern` applies one qualified across-flats
size, depth, and orientation at 2–128 explicit entry centers. It preserves one
editable Wire per center, extrudes one cutter per pocket, and consumes every
cutter in one final Boolean, for 2N+1 confirmed Undo steps. Region selection is
based on newly created native Region IDs because Plasticity associates every
coplanar closed profile in the shared sketch with each Region. This also keeps
the single-pocket recipe reliable when other coplanar profiles already exist.
`plasticity_create_slotted_hole` cuts a straight through-slot with exact
semicircular ends. `overallLengthMm` includes both round ends, `widthMm` is the
finished slot width, and `slotDirection` sets the adjustment direction in the
entry plane. The recipe preserves its rectangular center Wire, extrudes it,
adds two exact cylindrical end cutters, and consumes all three cutters in one
Boolean, for five native Undo steps. Use a slot only after the required travel,
edge distances, and the washer or fastener-head bearing envelope are known.
`plasticity_create_slotted_hole_pattern` applies the same qualified slot at
2–64 explicit entry centers. It preserves one center Wire and creates three
cutters per slot, then consumes every cutter in one final Boolean, for 4N+1
confirmed Undo steps. A fixed-width multi-bolt adjustment request routes to
this grouped recipe. The caller must prove positive edge distance for every
semicircular end; exact tangency to an exterior boundary is a degenerate
Plasticity Boolean configuration and is rejected before it can be accepted as
a finished design.
`plasticity_create_counterbore` cuts a through hole and a wider flat-bottom
recess into one Solid. `entryCenterMm` lies on the entry surface and `axis`
points into the material. `throughDepthMm` is the material depth along that
axis; `overshootMm` extends temporary cutters beyond tangent boundaries. The
counterbore diameter must exceed the through diameter, and its depth must be
less than the through depth. The recipe uses two native cylinder commands and
one native Boolean command, consumes both temporary cutters, and returns the
three revisions and `undoSteps: 3`. If any step fails or becomes uncertain it
stops immediately, leaves confirmed partial geometry visible, and never retries
or rolls back automatically.
`plasticity_create_counterbore_pattern` applies the same finished through-hole
and head-recess dimensions at 2–128 explicit entry centers. It creates two
native cylinders per center and consumes every cutter in one final Boolean, so
a pattern of N counterbores has 2N+1 confirmed Undo steps. A resolved request
such as `4 винта DIN 912 M5×10` routes here when the mounting is fixed; the
agent must still obtain the selected standard's head envelope, fit, process
clearance, local material depth, and every center before calling the tool. The
nominal thread diameter or screw length is never treated as a finished pocket
dimension.
`plasticity_create_heat_set_insert_pocket` creates a nested pilot, insert bore,
and shallow lead-in from dimensions supplied for the chosen insert, material,
and print profile. The axis points from the entry surface into the target. Its
diameters must increase from pilot to insert to lead-in while depths decrease
in that order. The explicit local material depth must also exceed pilot depth.
Three temporary native cylinders are consumed by one Boolean, so the result is
ordinary editable Plasticity geometry with four explicit Undo steps. Failure
and uncertainty use the same stop-without-retry behavior as the counterbore
recipe.
`plasticity_create_heat_set_insert_pocket_pattern` applies one qualified
pilot/insert/lead-in stack at 2–64 explicit entry centers. It creates three
native cylinders per center and consumes all cutters in one final Boolean, for
3N+1 confirmed Undo steps. A fixed request for several equal heat-set inserts
routes to this tool and routes the mating side to
`plasticity_create_through_hole_pattern`; insert identity, installation process,
print profile, retention evidence, local thickness, and every center remain
explicit.
`plasticity_create_screw_boss` grows a cylindrical boss outward from a point on
an existing Solid. A required base overlap gives the native union real volume;
the recipe then cuts a blind pilot from the boss top without entering the
support body. The hole diameter must be smaller than the boss and its depth
cannot exceed the boss height. The two temporary cylinders are consumed in
four native history steps: create, union, create cutter, difference.
`plasticity_create_screw_boss_pattern` applies the same qualified geometry at
2–64 explicit base centers. It creates all boss cylinders, joins them to the
support in one Boolean, creates all blind-pilot cutters, and consumes those in
one final Boolean, for 2N+2 confirmed Undo steps. A fixed phrase naming several
self-tapping or printed-plastic fasteners routes to this grouped recipe; screw
family, printer/material/profile, orientation, reuse, outer diameter, pilot
diameter, engagement depth, edge distance, and every center remain explicit.
`plasticity_create_rib` accepts three or more coplanar world-space points and a
signed extrusion thickness. It creates a closed profile, resolves its single
native Region, extrudes a Solid, and joins that Solid to the selected target.
The profile Wire remains in the document for inspection and direct editing.
Non-coplanar and degenerate profiles are rejected before the first mutation;
the three successful mutations are returned as separate Undo steps.
`plasticity_create_round_vent_array` cuts a one- or two-dimensional grid of
round through-holes. The first center lies on the entry surface, the hole axis
points into the target, and both grid directions must lie in that surface
plane. Pitch must exceed hole diameter. The recipe creates one cutter, uses
Plasticity's native rectangular pattern for up to 20 × 20 instances, and
consumes all cutters in one Boolean. Thus a multi-hole array needs only three
Undo steps; a single hole needs two.
`plasticity_create_cantilever_snap_fit` builds a beam and integral end hook
from a point on the support. Perpendicular beam and thickness directions define
the profile plane; width is centered across its normal. Length, width,
thickness, hook length, hook height, and support overlap are explicit
millimeter inputs. The profile Wire remains editable, while the extruded body
is joined to the target in three native history steps. Material-specific strain
and clearance remain design inputs for the agent to validate against the active
manufacturing profile.
`plasticity_create_hinge_barrel` creates a cylindrical knuckle, cuts its exact
finished pin-clearance bore, and joins the hollow barrel to an existing Solid.
The caller supplies the barrel axis start and direction, length, outer
diameter, and finished bore diameter. The support must intersect the barrel;
four native steps create the outer cylinder, create the overshooting bore
cutter, subtract it, and unite the barrel with the target.
`plasticity_cut_cable_channel` uses one or more current editable Wire bodies as
centerlines for solid native Pipe cutters, then subtracts those cutters from a
selected Solid. `channelDiameterMm` is the finished cable-clearance diameter.
The source Wires stay in the document for inspection or later adjustment; the
Pipe creation and Boolean difference are returned as two explicit Undo steps.
Each Wire must be current in the supplied document revision and distinct from
the target body.
`plasticity_create_connector_opening` cuts an oriented rectangular or
rounded-rectangular through-opening into a Solid. The entry center lies on the
target surface, `axis` points through the material, and `widthDirection` lies
in the surface plane; height direction is derived as a perpendicular axis.
The exact width, height, through depth, overshoot, and optional corner radius
are journaled. A closed rectangular Wire stays editable outside the target,
while its native extruded cutter is optionally filleted on four longitudinal
edges and consumed by the Boolean difference. Rounded openings use four Undo
steps and sharp openings use three.
`plasticity_create_mating_enclosure_joint` adds a rectangular male lip and its
clearance-matched female rabbet to two existing axis-aligned enclosure halves.
`seamOriginMm` is the lower-left outer corner of the XY mating plane. Outer
width/depth, wall thickness, lip thickness/height, radial fit clearance,
attachment overlap, and cutter overshoot are explicit millimeter inputs. Four
temporary boxes form two exact rings: the male ring overlaps and unites with
one half, while the wider female ring removes material from the other. All
temporary solids are consumed, both stable target IDs remain, and the eight
native history steps are returned. This lets the agent create or modify the
shells independently before applying the joint required by the active printer
and material profile.
`plasticity_create_locating_pin_pair` adds one cylindrical locating pin to a
male Solid and cuts its matching blind socket into a different female Solid.
The base center lies on the mating plane and the axis points from pin to
socket. Pin diameter/height, radial clearance, axial clearance, attachment
overlap, and cutter overshoot are explicit. The socket radius is the pin radius
plus radial clearance; its depth is pin height plus axial clearance. Both
stable target IDs remain and the four native history steps are returned.
`plasticity_create_locating_pin_pair_pattern` performs the same operation for
2–64 explicit locations: it unions all pins in one native operation and cuts
all sockets in one operation. Duplicate centers are rejected before mutation.
Both tools create exact geometric clearances from caller-supplied values; those
values still require a matching printer/material/profile fit test before they
can be treated as production recommendations.
`plasticity_create_tongue_groove_joint` joins an oriented rectangular tongue
to one Solid and cuts its clearance-matched blind groove into another. The
base center lies on the mating plane, `axis` points from tongue to groove, and
`widthDirection` lies in that plane. Tongue width, thickness, height, radial
clearance, axial clearance, attachment overlap, and cutter overshoot are
explicit millimeter inputs. Both profile Wires remain editable; the two
temporary extrusions are consumed. When Plasticity divides nested coplanar
profiles into multiple adjacent Regions, the recipe extrudes all Regions tied
to the groove profile so the cutter stays a single full rectangular Solid.
Six native history steps are returned.
`plasticity_sweep_regions` creates exact capped solids from explicit closed
Regions and a Wire spine. It exposes Plasticity's normal, parallel and transport
alignment, miter/round corners, twist, terminal scale and simplification.
`plasticity_loft_regions` consumes an ordered list of Regions from separate
sketch planes and creates capped loft geometry; open and closed profile chains
and native simplification are supported. Optional `guideIds` reference current
Wire bodies that intersect every profile and shape the loft between them;
`trimGuides` forwards Plasticity's native guide-trimming behavior. Profile
Wires cannot also be used as guides, and the resulting exact B-Rep bounds must
be inspected because a curved guide can extend beyond every profile.
`plasticity_loft_curves` creates an independent native Sheet through ordered
Wire profiles while preserving every profile and guide. Optional Wire guides
must intersect every profile. Open mode builds a transition surface; closed
mode needs at least three profiles and closes the loft sequence. Native
`natural`, `unconstrained`, and `clamped` curvature, profile/guide trimming,
simplification, and positive dimensionless end magnitudes are explicit. The
result never joins source bodies automatically, so inspect its exact B-Rep
topology, direction, bounds, and continuity before sewing or thickening it.
`plasticity_loft_faces` creates an independent capped Solid directly from an
ordered list of exact planar faces on different current Solid or Sheet bodies.
Every source body is preserved. Optional Wire guides must intersect all
profiles. Native `natural`, `unconstrained`, and `clamped` end conditions are
available independently; their positive magnitudes are dimensionless shape
controls, so verify the returned topology, bounds, volume, and end behavior.

The guarded native Wire-loft acceptance can be repeated with:

```sh
npm run accept:native-curve-loft -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It creates one guide-shaped open B-Surface and one closed-sequence B-Surface,
verifies exact native topology and bounds, exercises Undo/Redo, and restores
the initial empty document.
`plasticity_patch_regions` fills explicit current Regions with native Sheet
bodies while preserving the source profile curves. The resulting faces and
bounds are read back from the exact B-Rep model.
`plasticity_patch_closed_wires` fills current closed Wire bodies with
independent native Sheets while preserving every source Wire. It accepts
spatial boundaries that cannot form planar Regions and can therefore produce a
nonplanar B-Surface. The native fill defaults do not establish a requested
continuity or engineering surface: inspect the exact boundary, surface
structure, face properties, and validity before joining or thickening it.

The guarded nonplanar-Wire acceptance patches two independent spatial Wires in
one native history step, verifies both resulting Sheets through exact B-Rep
read-back and native validation, exercises Undo/Redo, and restores the empty
document. Repeat it with:

```sh
npm run accept:native-closed-wire-patch -- \
  --target TARGET_ID \
  --allow-disposable-mutations \
  --output /tmp/plasticity-mcp-output
```

`plasticity_join_sheets` sews two or more current Sheet bodies along coincident
edges in one native history step. Inputs must all be revision-current Sheets.
`plasticity_bridge_surface` creates a native G2 transition between two current
Sheet faces. Each face carries a world-space millimeter pick point on the
intended boundary edge; `widthMm` controls the native transition extent and
`softness` defaults to 1. Plasticity trims both source faces and replaces the
two Sheets with one editable Sheet containing a `BSurf` face. Inspect the
returned B-Rep because infeasible widths are rejected by the native kernel and
the transition width is not a promise of one final linear dimension.
`plasticity_cut_with_faces` splits current Solid or Sheet bodies with current
planar cutter faces and preserves the cutter bodies. For an open-Sheet trim,
inspect the exact parts returned after Cut and call `plasticity_delete` only on
the unwanted part using that new revision. Cut and Delete are two explicit
Undo steps. `plasticity_trim_curve_fragments` applies only to Wire fragments
and must not be used as a Sheet-trimming substitute.
`plasticity_list_appearance_materials` reads the document's native Plasticity
appearance catalog and the material ID assigned to each body.
`plasticity_set_appearance_material` can assign an existing ID, create a named
`#RRGGBB` appearance with bounded roughness, metalness and opacity, or clear an
assignment with ID 0. Creation plus assignment is one native Undo step and is
tracked by scene snapshots. These values control Plasticity display only; they
are never accepted as evidence for filament, density, strength or print
process.
`plasticity_set_block_dimensions` applies Plasticity's native direct-dimension
command to one Solid that the application still recognizes as a block. Width,
length, and height use the block's local primitive axes; the edit keeps the
existing center and occupies one Undo step. It is not a persistent constraint
or feature-history parameter. Modified or booleaned solids that no longer pass
Plasticity's native `HasBlock` check are rejected, and callers must read the
resulting B-Rep dimensions back instead of assuming the requested values were
applied.
`plasticity_set_radius_dimension` applies the corresponding native direct edit
to one current cylindrical B-Rep face. It changes the recognized cylinder or
hole radius in one Undo step and rejects noncylindrical or stale face IDs. It
does not edit fillets; use `plasticity_refillet_faces` for recognized blend
faces. Read the new cylindrical radius from the returned B-Rep state.
`plasticity_set_rectangle_dimensions` changes the native local width and
length of one closed planar Wire that Plasticity recognizes as a rectangle.
The profile stays centered, remains an editable Wire, and its Region is updated
in the same Undo step. Native width/length follow Plasticity's rectangle axes;
inspect the returned exact Wire bounds before using the Region downstream.
`plasticity_create_vertex_distance_measurement` adds a persistent native
Plasticity distance-measurement object between two current exact B-Rep
vertices. The measurement and its optional name are stored in the document,
occupy one Undo step, and are returned by `plasticity_list_measurements` with
their stable ID, topology targets, exact read-back positions, and distance in
millimetres.
`plasticity_create_topology_distance_measurement` extends the same native
measurement object to any pair of current Solid or Sheet vertices, edge
midpoints, and face centers. The list result resolves Plasticity's native
target back to the current public `vertexId`, `edgeId`, or `faceId`, identifies
each topology type, and recomputes the exact distance from the attached B-Rep
points. This is useful for persistent thickness, gap, diagonal, and inspection
dimensions; it measures the selected topology points and does not claim a
minimum distance between surfaces.
The saved measurement remains the native Plasticity document object. The MCP
rebuilds a viewport-only annotation from its exact endpoints: an offset
dimension line, extension lines, and a millimetre label. Zero-offset vertex
dimensions are placed outside the referenced body's B-Rep bounds where the
native axis-aligned path allows it. These helpers do not add model geometry or
change the exact stored measurement. Live Plasticity 26.1.3 acceptance verified
visible labels and nonzero line segments, pixel changes in the viewport,
Undo/Redo, and cleanup back to an empty test document; see the evidence path in
the [acceptance matrix](./acceptance-matrix.md).
`plasticity_create_radius_measurement` adds the corresponding persistent native
radius-measurement object to one exact circular edge. Wire segments use the
numeric `segmentEntityId` from `plasticity_list_curve_directions`; Solid and
Sheet edges use the current string `edgeId`. List results include the native
topology target, exact radius, and derived diameter in millimeters. It is a
radius measurement even when a downstream table presents its derived diameter.
`plasticity_delete_measurement` selects that native measurement and delegates
removal to Plasticity's own removal command, also as one Undo step. Body topology
and measurement IDs are valid only for the current document revision; use the
read-only topology measurement tools when an annotation does not need to stay
in the document. These annotations are dimensions for inspection, not
parametric constraints that drive model geometry.
`plasticity_create_section_analysis` adds a native viewport section through an
explicit world-space origin and normal. The normal points toward the clipped
half-space; the optional `xDirection` fixes the in-plane frame, while omission
uses a deterministic perpendicular axis. `plasticity_list_section_analyses`
returns session-stable analysis IDs and exact plane read-back, and
`plasticity_delete_section_analysis` clears the active section. Plasticity
supports one active viewport section plane at a time. These operations use
Plasticity's native shading state, change the MCP revision and scene snapshots,
and leave B-Rep geometry and Undo history unchanged. They are for
inspection and demonstration, not for creating section geometry; use the exact
section-strength tools when area properties or load checks are required.
`plasticity_analyze_face_draft` evaluates oriented native B-Rep normals on a
finite interior grid of each selected Solid or Sheet face. Relative to the
normalized pull direction, signed draft is `asin(normal · pull)`: a wall
parallel to pull is 0°, a normal toward pull is positive, and a normal away
from pull is negative. The explicit minimum angle groups samples into positive,
negative, and neutral bands; a face spanning more than one band is `mixed`.
The result returns compact signed extrema, their exact evaluated positions and
normals, counts, surface type, and body version without changing document
history. It is a sampled check: it does not prove extrema between grid points,
a workable parting line, mold release, or FDM support requirements.
`plasticity_duplicate_bodies` creates independent exact B-Rep copies of one or
more current Solid or Sheet bodies, preserves the sources, and translates the
whole copied set by an explicit world-space millimetre delta. The grouped native
CreateInstance/Move/Realize transaction occupies one Undo step and leaves no
linked instance behind. Returned copy IDs are revision-bound; read their exact
bounds before editing them. A zero delta is allowed only when coincident geometry
is intentional.
`plasticity_create_instance` creates one native Plasticity linked instance of
a current body and can place it with an initial millimetre translation.
`plasticity_list_instances` returns its revision-bound ID, source-body IDs,
world matrix with millimetre translation components, rotation quaternion, and
decomposed local scale. Move, rotate, and scale inputs use world-space axes and
each occupy one Undo step. Because Plasticity stores instance transforms in mutable display
objects, the adapter first enters the native empty database's copy-on-write
state; this is required for Undo/Redo to restore the matrix rather than only
move the history cursor. `plasticity_realize_instances` converts selected
copies into independent exact B-Rep bodies before Boolean or per-copy geometry
editing. `plasticity_delete_instances` removes only the selected copies. Source
edits continue to propagate until realization, and every instance ID is valid
only at the returned document revision.
`plasticity_create_group` organizes current bodies, linked instances, and
existing child groups in Plasticity's native scene hierarchy. The returned
group descriptors include parent and child group IDs, direct body and instance
members, visibility, lock state, and unclassified native node keys.
`plasticity_move_to_group` reparents mixed selections while rejecting hierarchy
cycles. `plasticity_rename_group` and `plasticity_dissolve_groups` preserve
Plasticity Undo/Redo; dissolving promotes contents into the parent instead of
deleting geometry. `plasticity_activate_group` selects where Plasticity places
new objects; group ID 0 restores the root `Scene` destination.
`plasticity_set_visibility` and `plasticity_set_locked` apply exact native node
state to bodies, instances, or groups. All IDs are
revision-bound, the root `Scene` group is protected from rename, nesting, and
dissolve, and each write occupies one native history step.
`plasticity_current_selection` also returns selected instance and group IDs and
revision-bound Wire boundary/control handles, so a user's manual assembly or
curve-editing selection can be read without guessing from geometry.
`plasticity_select_nodes` performs the reverse operation for a mixed
set of bodies, instances, and groups without adding a document history entry.
`plasticity_select_faces` and `plasticity_select_edges` likewise highlight
exact revision-bound B-Rep surfaces and boundaries in Plasticity. This lets the
agent point at the topology it is discussing while the user stays in the CAD
window. `plasticity_select_curve_control_points` highlights an exact mix of
current boundary vertices and interior B-Spline handles without adding an Undo
entry.
`plasticity_align_planar_faces` rotates and translates one or more bodies as a
rigid set so an exact source-face center and normal meet a fixed target face.
The `opposed` relation seats outward normals against each other; `same` keeps
them parallel. A positive gap follows the target's outward normal. The shortest
normal-to-normal rotation does not independently align in-plane edges. Plasticity
records the combined rotation and translation as one Undo step. This is a
direct placement operation rather than a persistent assembly constraint, and
the agent must read the resulting face positions back from B-Rep.
`plasticity_align_vertices` translates a rigid set of bodies so one exact
source vertex reaches a fixed target vertex plus an explicit world-space
offset. `plasticity_align_linear_edges` rotates and translates a rigid set so
the midpoint and tangent of one exact native Line meet a fixed Line, with an
optional signed offset along the target tangent and an explicit roll around
the target line. Each logical placement occupies one native Undo step. Both
are direct placements rather than persistent assembly constraints. Re-read
the returned topology before the next operation: Plasticity can assign a new
edge ID after a rigid rotation even when the body ID is unchanged.
`plasticity_align_cylindrical_faces` performs the corresponding placement for
exact native Cylinder faces. `preserve` removes the transverse offset between
the axes while retaining the moving cluster's axial position, which supports a
planar-seat followed by hole alignment. `anchor` places the source native axis
origin at the target origin plus a signed target-axis offset. Axis direction
can be `same` or `opposed`, and `rotationAroundAxisDeg` fixes the remaining
roll. Rotation, translation, and roll share one native Undo step and preserve
the relative placement of every supplied moving body. This is also a direct
placement rather than a persistent concentric constraint.
`plasticity_check_interference` then checks explicit Solid pairs by intersecting
native clones in a temporary geometry database. An `interfere` result includes
the exact B-Rep bounds, face count, and kernel validation codes for every
intersection Solid. `no-volumetric-interference` proves only that the
intersection has no volume: touching and separated bodies deliberately share
that result, and the tool does not report minimum clearance. Use exact
face/edge measurements when a known mating gap must be verified. The check is
revision-bound and rejects its evidence if the persistent document, history,
or body descriptors change while it runs.
`plasticity_curve_pattern` distributes one or more current Solid or Sheet
bodies over the full length of an explicit native Wire. Its count includes the
source position; the spine remains editable, and the result consists of
independent native bodies rather than linked instances. Plasticity's verified
26.1.3 default rotates copies along the path. Use linked instances instead when
later source edits must propagate to every copy.
`plasticity_measure_solid_properties` reads each requested current Solid through
Plasticity's native `BodyCollection.EvaluateMassProperties()` and returns exact
B-Rep volume in mm³, surface area in mm², and volume centroid in millimetres.
For multiple bodies it also returns total volume, total area, and the
volume-weighted centroid. The tool does not infer physical mass: callers must
provide a qualified density for the selected material and print profile. The
volume centroid is a center of mass only for uniform density.
`plasticity_measure_face_properties` applies the corresponding native
`FaceCollection.EvaluateMassProperties()` to exact revision-bound Solid or
Sheet faces. Each result includes trimmed area, the full outer-plus-inner
boundary length, area centroid, surface type, planarity, outer/inner loop
counts, body version, and native face validation. Totals contain selected area,
area-weighted centroid, and the sum of each selected face's boundary. That last
sum is deliberately not unique model-edge length: an edge shared by two
selected faces is counted once for each face. Use these values for contact,
gasket, bearing, coating, and selected-surface evidence without using the
display mesh.
`plasticity_create_constrained_surface` fits a native B-Surface through paired
3D points and normal constraints. It exposes native linear/angular tolerances
and performance/smoothness optimization; the fitted surface may extend beyond
the control points, so inspect its returned exact B-Rep bounds.
`plasticity_extract_faces` copies selected current B-Rep faces into independent
native Sheet bodies and preserves the source body. This provides editable
surface references for repair, thickening, sewing, and downstream construction.
`plasticity_unwrap_face` develops one current analytic Cylinder face into an
independent planar native Sheet while preserving the source body. For a full
cylinder the exact rectangle is the axial length by `2πR`; Plasticity chooses
the seam and planar placement. The tool is intentionally limited to Cylinder
faces and does not calculate thickness, bend allowance, neutral axis,
springback, kerf, or any other manufacturing compensation. A live Cone probe
in Plasticity 26.1.3 did not produce an area-preserving frustum development, so
Cone faces are rejected rather than presented as exact flat patterns.
`plasticity_deform_bodies_between_faces` maps all faces of selected Solid or
Sheet bodies from one exact source face onto a different exact target face. It
preserves the selected bodies and both reference-face bodies, then creates
independent native copies. This supports details such as raised marks, ribs, or
surface features designed against an unwrapped Cylinder and mapped back onto
the curved face. The public contract exposes the verified dimensionless U, V,
and normal scales plus UV swap, normal flip, and mirror controls. Native U/V
offsets remain internal until their physical unit semantics are independently
verified. Deformation changes shape and can change volume, so inspect the
result's exact bounds, topology, mass properties, and native validity.

The guarded live acceptance can be repeated with:

```sh
npm run accept:native-face-deformation -- \
  --target TARGET_ID \
  --allow-disposable-mutations \
  --output /tmp/plasticity-mcp-output
```

`plasticity_deform_curves_between_faces` applies the same verified native
surface mapping to one or more Wire bodies. It preserves the input Wires and
both reference-face bodies, creates independent mapped Wires, and supports open
and closed curves in one history step. Use it for surface markings, trim
guides, projected construction paths, and later imprint workflows. Re-read
exact segment points, tangents, lengths, bounds, open/closed state, and
planarity; a closed planar source mapped to a curved face does not retain its
planar Region.

The guarded curve-deformation acceptance can be repeated with:

```sh
npm run accept:native-curve-deformation -- \
  --target TARGET_ID \
  --allow-disposable-mutations \
  --output /tmp/plasticity-mcp-output
```

`plasticity_unjoin_faces` detaches selected exact faces from their current
shells. Plasticity creates separate editable Sheet bodies and keeps the action
as one Undo/Redo history entry, which makes joined surface repairs reversible.
`plasticity_insert_sheet` performs the complementary reconstruction when an
explicit separate Sheet must be inserted into selected boundary edges of an
open target Sheet. Plasticity consumes both inputs and returns one rebuilt
Sheet or Solid; in the verified closed-box case the fill Sheet stable ID became
the result ID. All earlier body, face, and edge references must be discarded.
The agent must inspect the returned topology and run native validation instead
of assuming that matching-looking boundaries produced a closed body.

The guarded live acceptance can be repeated with:

```sh
npm run accept:native-sheet-insertion -- \
  --target TARGET_ID \
  --allow-disposable-mutations \
  --output /tmp/plasticity-mcp-output
```

`plasticity_unjoin_shells` completely disassembles each selected multi-face
Solid or Sheet into independent one-face Sheets in one native history step. The
source bodies are replaced, Plasticity may reuse a source stable ID for one
result, and every prior body and topology reference becomes stale. Use this for
full surface-level reconstruction; use `plasticity_unjoin_faces` for selective
detachment.
`plasticity_extract_edges` copies selected exact B-Rep edges into native Wire
curves while preserving the source body. Connected planar edges can form a
closed Wire and Region for downstream extrusion, sweep, or offset operations.
`plasticity_create_solid_from_sheet` converts a closed Sheet shell into a new
native Solid while preserving the source Sheet for inspection and recovery.
`plasticity_hollow_solids` offsets every face of one or more current Solids to
create a fully enclosed cavity in one native history step. Inward mode preserves
the exact outside envelope; outward mode preserves the original interior
envelope. Use `plasticity_hollow_faces` when the result needs explicit opening
faces instead of a sealed cavity. Both tools require an explicit positive wall
thickness in millimeters.
`plasticity_delete_faces` removes explicit revision-current B-Rep faces. For a
Solid this can create an open Sheet shell that can then be patched, joined,
thickened, or solidified again.
`plasticity_dissolve_faces` removes compatible internal face boundaries and
merges the selected faces into adjacent native surfaces. This reverses
temporary imprint splits without opening the body.
`plasticity_patch_sheet_hole` fills a closed boundary loop selected by current
Sheet edge IDs. If the patch closes the shell, Plasticity promotes it back to a
Solid in the same native history step.
`plasticity_cap_sheet_holes` fills every planar open boundary on one or more
current Sheet bodies in one native history step. Use it when all compatible
openings should be closed; Plasticity promotes a fully closed shell to a Solid.
`plasticity_extend_sheet_edges` linearly extends selected boundary edges on one
current Sheet by an exact positive millimeter distance. It modifies the Sheet
in one native history step for later trimming, joining, or solidification.
`plasticity_validate_bodies` runs the native C3D `Check()` method and reports
its diagnostic codes together with exact topology-derived Sheet boundary
edges. A native Solid is marked `printableSolid` when `Check()` reports no
errors. Solid periodic faces can expose a single seam adjacency even though the
kernel body is closed, so Solid closure follows native type plus `Check()`;
open Sheets still use their exact boundary edges and remain non-printable.
`plasticity_remove_fillets` detects and removes native blend faces from current
Solid or Sheet bodies in one history step. It is useful for restoring sharp
editable geometry in imported STEP models before applying a different radius.
`plasticity_refillet_faces` changes selected recognized blend faces by a signed
millimeter radius delta. Current exact face IDs and the resulting positive
radius are required, so imported blends can be enlarged or reduced safely.
`plasticity_create_pipes` creates solid circular pipes from Wire spines or
hollow pipes when wall thickness is nonzero. For hollow pipes, use the exact
end-edge diameters when the offset surface produces a conservative body box.
`plasticity_create_helix` creates a constant-radius native Wire around any
world-space axis. It accepts a radius, turn count, radial reference direction,
and right- or left-hand winding for spring, thread, and cable-path construction.
`plasticity_create_cone` creates either a pointed cone (`topRadiusMm=0`) or an
unequal-radius conical frustum around any world-space axis. It preserves the
closed meridional Wire and revolves its automatic native Region into an exact
Solid in the same Plasticity history step. Equal radii are rejected and should
use `plasticity_create_cylinder`.

The guarded cone and frustum acceptance can be repeated with:

```sh
npm run accept:native-cone -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It refuses a nonempty document, verifies analytic Cone and Plane faces, native
validity, exact bounds and volumes for both forms, exercises one-step Undo/Redo,
and restores the initial empty scene.
`plasticity_create_nurbs_curve` creates a native interpolating NURBS Wire
through three or more 3D millimeter points for smooth outlines and sweep paths.
`plasticity_inspect_curve_structure` reads a compact exact B-Rep description of
selected Wires, including segment type and length and, for native B-Splines,
degree, control-point count, spans, normalized knot parameters with
multiplicities, rationality, and periodicity. Knot parameters are carrier-curve
parameters mapped into the selected segment's normalized coordinates;
`withinSegment` distinguishes active knots from carrier knots outside a trimmed
segment.
`plasticity_rebuild_curves` exposes Plasticity's three verified rebuild modes:
fit to a millimeter tolerance, set the control-point count, or set NURBS degree
and span count. It preserves the requested chain/corner behavior in one native
history step. The requested fit setting remains an input; compare exact curve
evidence and functional clearances after rebuilding rather than treating that
setting as an independently measured maximum deviation.

`plasticity_raise_curve_degree` elevates every native B-Spline segment in the
selected Wires by one degree without intentionally changing its path.
`plasticity_subdivide_curves` inserts native knots while preserving the current
degree and path, adding local edit points. Each call is one history step. Read
the exact curve structure before and after because both operations increase
representation complexity and are useful for different editing goals.

`plasticity_insert_curve_knot` refines one exact B-Spline segment at one
dimensionless parameter strictly between 0 and 1. Obtain the current segment ID
and its start-to-end direction from `plasticity_list_curve_directions`; the
parameter is measured in that direction. The adapter converts it to the native
curve interval and keeps Plasticity's native transaction and history behavior.
Read back the knot list to verify the requested parameter and multiplicity.

`plasticity_evaluate_curve_segments` reads an exact B-Rep position and unit
tangent at any normalized parameter from 0 to 1 on a current Wire segment.
`plasticity_split_curve_segment` uses the same start-to-end parameter convention
to turn one nonperiodic segment into two consecutive selectable segments without
changing the Wire path. It preserves the Wire body but invalidates every old
segment reference. A full periodic circle is rejected because one split point
would only relocate its seam.

The guarded native curve-refinement acceptance can be repeated with:

```sh
npm run accept:native-curve-refinement -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It elevates one seven-control-point cubic B-Spline, subdivides an identical one,
and inserts one knot at normalized parameter 0.5 in a third. Exact native
read-back checks the resulting degree, control points, spans, knot parameters
and multiplicities, endpoints, tangents, and length, then exercises Undo, Redo,
and cleanup.

The guarded native curve-segment split acceptance can be repeated with:

```sh
npm run accept:native-curve-segment-split -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It evaluates and splits a B-Spline and a Line at normalized parameter 0.5,
checks exact split positions, tangents, and preserved total lengths, verifies a
periodic Circle rejection, then exercises Undo, Redo, and cleanup.

The guarded native surface-continuity acceptance can be repeated with:

```sh
npm run accept:native-surface-continuity -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It checks a sharp box edge as G0 with a 90° normal-angle deviation and a
plane-to-fillet boundary as G1 with relative curvature deviation 1. Both
analyses preserve revision and Undo/Redo history; the script then verifies the
fillet's Undo/Redo and restores the empty document.

`plasticity_list_curve_control_points` returns every editable native handle for
selected Wires: boundary vertices separately from interior B-Spline control
points. Each handle includes Plasticity's local positive-U and negative-U unit
directions. Each reference is tied to the current body and document revision.
`plasticity_select_curve_control_points` replaces Plasticity's current selection
with those exact handles, while `plasticity_current_selection` reads a manual or
agent-made handle selection back. Selection does not change the document or its
Undo history.
`plasticity_move_curve_control_points` moves any selected mix by one shared
world-space millimeter delta. `plasticity_slide_curve_control_points` moves the
selected handles by one positive distance along each handle's chosen local U
direction, which lets the agent edit along the control polygon without deriving
that direction from display geometry.
`plasticity_rotate_curve_control_points` rotates handles around an explicit
world pivot and axis, while
`plasticity_scale_curve_control_points` applies positive XYZ factors around an
explicit pivot. Each transform occupies one Plasticity history step. Handle
positions are edit coordinates from Plasticity's native editor representation;
validate the resulting endpoints, tangents, lengths, and dimensions from exact
B-Rep evidence.
`plasticity_delete_curve_control_points` removes one or more selected interior
B-Spline points from one Wire. Deletion changes the path and reindexes the
remaining control-point IDs, so every old handle reference must be discarded
and the curve must be listed again.

The guarded native control-point acceptance can be repeated with:

```sh
npm run accept:native-curve-control-points -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It first selects one boundary vertex and one interior control point of a cubic
B-Spline and reads the same selection back without changing history. It slides
another point 5 mm along its returned positive-U direction, moves two handles
together, rotates another control point 90°, and scales a fourth about the world
origin. It then deletes one interior point and verifies the reduction
from seven to six B-Spline control points, every native handle position, and the
exact B-Rep endpoints and structure, then exercises Undo, Redo, and full cleanup.

`plasticity_move_faces`, `plasticity_rotate_faces`, and
`plasticity_scale_faces` directly transform current revision-bound B-Rep faces.
Plasticity extends and retrims their adjacent surfaces, so every prior face and
edge reference must be discarded after each edit. Move deltas and pivots are in
millimeters, rotations use a world-space axis and degrees, and scale uses
positive world-XYZ factors. Scaling changes the underlying surface: a Cylinder
scaled equally across its radial world axes changes exact radius, while scaling
a Plane only inside the same infinite plane can correctly be a no-op. Always
re-read exact normals, radii, edges, dimensions, and native body validity.

The guarded face-transform acceptance can be repeated with:

```sh
npm run accept:native-face-transforms -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It moves a box face by 5 mm and measures an exact 15 mm height, rotates another
box face by 10° and reads the exact plane normal and angle, then scales a
cylindrical face from R5 to R10. Each transform occupies one native history
step; all three Solids pass native `Check()`, Undo/Redo restores both source and
result geometry, and cleanup returns the document to its initial empty state.

`plasticity_thicken_faces` copies a current face set into a new independent
native body using explicit nonnegative front and back thicknesses. The source
Solid or Sheet remains unchanged; front follows the selected face normals and
back goes against them. `plasticity_offset_face_loops` inserts signed native
loops without intentionally changing volume. Its sign follows Plasticity's
oriented face adjacency, so the new loop may lie on the selected face or
propagate over neighboring faces. `plasticity_patch_solid_edge_loops` creates
independent Sheet patches from edge loops on a Solid. It preserves the source
and does not by itself fill a hole or heal the Solid.

The guarded native face-construction acceptance can be repeated with:

```sh
npm run accept:native-face-construction -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It thickens a 20 × 10 mm face by 2 mm front and 1 mm back into an exact
600 mm³ Solid, inserts a 2 mm rectangular loop with exact 16/6/16/6 mm edges
while preserving 1000 mm³ source volume, and constructs an independent planar
R3 Sheet patch over one rim of a through-hole without changing the holed Solid.
It also completely separates a twelve-face hollow Solid and unwraps an R10 ×
30 mm Cylinder face into a planar 30 × 62.831853 mm Sheet. Each operation uses
one history step, passes native validation, exercises Undo/Redo, and cleans back
to the initial empty document.

`plasticity_rectangular_face_pattern` and
`plasticity_radial_face_pattern` repeat a complete current feature-face set on
one Solid or Sheet. This is the preferred route for an existing boss, pocket,
hole, rib, or other feature recognized by Plasticity: select every connected
face that belongs to the feature, then supply linear counts and center spacing
or a world-space radial center, axis, count, and total sweep. Counts include the
source feature. Both operations replace topology in one native history step,
so discard every old face, edge, and vertex reference and verify all resulting
feature centers, dimensions, add/cut direction, and body validity.

The guarded native face-pattern acceptance can be repeated with:

```sh
npm run accept:native-face-patterns -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It repeats an R3 × 5 mm boss three times at 15 mm linear spacing and four times
around a 360° radial array. Exact B-Rep read-back checks every cylinder axis,
topology, volume, stable body ID and name. Both Solids pass native `Check()`,
Undo/Redo restores source and patterned geometry, and cleanup returns the
document to its initial empty state.

`plasticity_move_edges` moves one or more current B-Rep edges from the same
Solid or Sheet by a world-space millimeter vector. `plasticity_offset_edges`
adds native parallel edges on one adjacent surface at a signed millimeter
distance. `plasticity_delete_edges` removes selected split or seam edges and
asks Plasticity to heal compatible adjacent surfaces; the native kernel can
reject structural edges that cannot be removed. Plasticity interprets the
offset sign using the edge orientation, so the agent must inspect the resulting
strip instead of mapping the sign to a fixed world direction. All three
operations rebuild the body and invalidate every prior face and edge reference.

The guarded native edge-edit acceptance can be repeated with:

```sh
npm run accept:native-edge-edits -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It moves the top-front edge of a 20 × 10 × 10 mm box upward by 5 mm and reads
the exact moved edge, tilted face normal, and two √125 mm connecting edges.
It then offsets the equivalent edge on two more boxes by +2 mm and −2 mm,
proving that the native signs select different adjacent surfaces and create
exact 2 mm strips. A fourth box receives the same +2 mm split, then
`plasticity_delete_edges` heals it back from 7 faces/15 edges to the exact
6-face/12-edge box topology. Each edit occupies one native history step; all
four Solids pass native `Check()`, Undo/Redo restores both source and result
geometry, and cleanup returns the document to its initial empty state.

`plasticity_offset_vertices` inserts exact native split vertices at one positive
millimeter distance along every edge incident to selected current Solid or Sheet
vertices. All selected vertices must belong to one body. Plasticity preserves
the original corners, outer shape, volume, stable body ID, and name while
rebuilding the body's topology. This operation does not move a corner and is
not a chamfer or fillet; discard every prior face, edge, and vertex reference
after it succeeds.

The guarded native vertex-offset acceptance can be repeated with:

```sh
npm run accept:native-vertex-offset -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It offsets two opposite vertices of a 20 × 10 × 10 mm box by 2 mm in one
history step. Exact B-Rep read-back finds six new vertices at the expected
positions and a topology change from 6 faces/12 edges/8 vertices to
6 faces/18 edges/14 vertices. Native mass properties remain 2000 mm³ with
centroid [10,5,5] mm, the Solid passes native `Check()`, Undo/Redo restores both
topologies, and cleanup returns the document to its initial empty state.

`plasticity_inspect_curve_planarity` asks the native kernel whether selected
Wires are exactly planar and returns the detected plane. When a spatial path
must lie on a known plane, `plasticity_planarize_curves` orthogonally projects
it onto an explicit world-space origin and normal. Projection changes the path
and Plasticity may reverse its parameter direction, so always re-read
planarity, endpoints, direction, and functional dimensions afterward.

The guarded native planarization acceptance can be repeated with:

```sh
npm run accept:native-curve-planarize -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It projects a non-planar cubic B-Spline onto Z=5 mm, checks the native plane,
curve structure, projected endpoint pair and direction, then exercises Undo,
Redo, and full cleanup.

`plasticity_bridge_curves` creates an independent native B-Spline between two
exact endpoints selected from current Wire segments. Obtain `bodyId`,
`segmentEntityId`, endpoint positions, and directions from
`plasticity_list_curve_directions` immediately before the mutation. Each end
accepts G0 positional, G1 tangent, G2 curvature, or G3 third-order geometric
continuity. The source Wires are preserved, so inspect the returned bridge and
use `plasticity_join_curves` separately only when one combined Wire is needed.

`plasticity_bridge_curve_vertices` provides the same independent transition
from two exact open Wire vertices. Read the current numeric `vertexId` values
with `plasticity_list_curve_vertices`; internal, stale, coincident, or non-Wire
references are rejected before mutation. This is the preferred form when the
agent already selected explicit sketch endpoints rather than segment senses.

`plasticity_bridge_shell_edges` starts the same native transition from exact
Solid or Sheet topology. Each endpoint reference combines a current `bodyId`,
`edgeId`, and one `vertexId` listed for that edge. G0 through G3 are selected
independently at both ends. The operation creates an independent Wire and
preserves both source bodies; read the returned Wire's exact endpoints and
tangents before using it as a downstream Sweep or surface guide.

The guarded native Curve Bridge acceptance can be repeated with:

```sh
npm run accept:native-curve-bridge -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It creates G0 through G3 transitions between four pairs of straight source
Wires, one G2 transition selected by exact open Wire vertices, and one G2
transition between explicitly selected vertical edges of two Solids. Exact
native read-back checks endpoints, tangent directions, lengths, B-Spline degree
and control-point count, then verifies source preservation, Undo, Redo, and full
cleanup.

The guarded native curve-rebuild acceptance can be repeated with:

```sh
npm run accept:native-curve-rebuild -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It rebuilds three identical seven-control-point cubic curves by a 0.1 mm fit
tolerance, nine control points, and degree 5 with three spans. Native read-back
checks the resulting B-Spline structure and endpoints, then exercises Undo,
Redo, and full cleanup.

`plasticity_capabilities` pages through native renderer bindings (100 by
default, up to 250 per call); use case-insensitive `query`, `offset`, and
`limit` to inspect a focused slice without flooding MCP context. Its response
includes total/matching counts, `nextOffset`, and structured availability for
saved construction planes and active workplane control. Construction
references always contain `id`, `sessionId`,
`documentToken`, and `revision`. Pass the whole identity object back to plane
activation/removal and plane-local curve tools. References from another MCP
connection, document, or revision are rejected rather than rebound silently.

`plasticity_create_polyline`, `plasticity_create_circle`,
`plasticity_create_two_point_circle`, `plasticity_create_three_point_circle`,
`plasticity_create_tangent_circle`,
`plasticity_create_center_arc`, `plasticity_create_three_point_arc`,
`plasticity_create_tangent_arc`, `plasticity_create_ellipse`,
`plasticity_create_regular_polygon`, and `plasticity_create_rectangle` accept
world-space 3D inputs or 2D millimeter coordinates plus a current plane
identity. Center arcs take a start angle and a signed sweep below 360 degrees;
positive sweep is counterclockwise around the selected plane normal and the
native curve direction is preserved from the requested start to end.
Three-point arcs instead take exact start, through, and end points; their order
selects the minor or major arc and preserves the requested start-to-end
direction. Tangent arcs continue an exact current Wire segment at its selected
start or end; the opposite tangent sense can select the major arc. Obtain the
revision-bound segment entity and endpoint geometry from
`plasticity_list_curve_directions` immediately before creating the arc or a
tangent circle. A tangent circle takes two distinct current Wire segment
references, one positive radius, and a solution point that chooses the intended
center neighborhood when several geometric solutions exist. The point is not a
third tangency constraint. Both source Wires remain unchanged, and the caller
must re-read the returned state because the new circle can change automatic
Region subdivision. Ellipses take explicit major/minor radii and an in-plane
major-axis angle. Regular polygons take 3–256 vertices and distinguish a center-to-vertex
circumradius from a center-to-edge inradius. Closed ellipses and polygons
create associated Regions for later extrusion or cutting. A rectangle is
created through Plasticity's native three-point rectangle command, takes exact
width and height, and can rotate its width axis by a signed angle around the
plane normal. In world space its normal and in-plane X direction are explicit;
parallel axes are rejected before CDP mutation. The server transforms local
X/Y through the saved orthonormal frame before the single millimeter-to-metre
conversion. Mixed 2D, 3D, orientation, and plane forms are rejected by strict
schemas.

The guarded native sketch-primitives acceptance can be repeated with:

```sh
npm run accept:native-sketch-primitives -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It creates positive and negative center-defined circular arcs, a three-point
major arc, minor and major tangent arcs from a preserved source line, a
fixed-radius circle tangent to two preserved exact line segments, a
20 × 10 mm-radius ellipse, and a regular hexagon from a 10 mm inradius. It reads
endpoints, tangents, arc lengths and major-arc bounds, tangent-circle bounds,
circumference and both exact tangency intersections, ellipse bounds and
perimeter, polygon side lengths, and Region associations from native B-Rep
evidence. Thirteen Undo/Redo operations restore all Wires and seven Regions;
final cleanup restores the empty document.

The guarded native-rectangle acceptance can be repeated with:

```sh
npm run accept:native-rectangle -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It creates a 40 × 20 mm rectangle on an inclined plane, reads all four segment
lengths from exact native B-Rep, verifies its associated Region and one-step
history behavior, exercises Undo/Redo, and restores the empty document.

The guarded native curve-fillet acceptance can be repeated with:

```sh
npm run accept:native-curve-fillet -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It selects all four exact vertices of a 40 × 20 mm rectangle, applies R3 in one
native command, verifies eight B-Rep segments and the retained Region, checks
the four trimmed lines at 34/34/14/14 mm and four quarter arcs at
4.71238898 mm, exercises Undo/Redo, and restores the empty document.

The guarded closed-solid hollowing acceptance can be repeated with:

```sh
npm run accept:native-hollow-solids -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It hollows a 100 × 80 × 40 mm Solid inward by 2 mm in one native command,
measures the sealed cavity as 96 × 76 × 36 mm from exact opposing B-Rep faces,
checks the exact 57,344 mm³ material volume, validates the closed Solid, exercises
Undo/Redo, and restores the empty document.

The guarded native body-outline acceptance can be repeated with:

```sh
npm run accept:native-body-outlines -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It preserves a 20 × 10 × 5 mm Solid, creates one exact 20 × 10 mm silhouette
at the source Z=10 mm plane and another on the explicit Top workplane at Z=0,
verifies all eight native line lengths and both Regions, exercises Undo/Redo
for each operation, restores the initial workplane, and returns the document to
its empty state.

The guarded native curve-pattern acceptance can be repeated with:

```sh
npm run accept:native-curve-pattern -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It distributes one 10 × 4 × 2 mm Solid into five independent native Solids
over a three-point NURBS path, verifies exact 80 mm³ volume for every copy and
400 mm³ total volume, checks the endpoint and midpoint centroids, tangent-following
orientation, one-step history, Undo/Redo, spine preservation, and full cleanup.

`plasticity_create_text` creates closed native Wire outlines using Plasticity's
verified `inter` font. It accepts a nominal font size, baseline origin, and the
same world or construction-plane placement model. A string can produce several
Wires and Regions, and its actual glyph envelope is deliberately read back from
the native curves rather than inferred from the nominal font size. The outlines
can then be extruded or used as cutters for embossed and engraved labels.

The guarded native-text acceptance can be repeated with:

```sh
npm run accept:native-text -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It creates and places the `M5` outlines on a vertical plane in one history
step, checks two closed Wires, two Regions, 45 exact native curve segments and
their measured envelope, exercises Undo/Redo, and restores the empty document.

`plasticity_list_construction_geometry` returns the active plane ID and full
current plane reference alongside all points, axes, and planes. Snapshots also
capture current datum identities; `plasticity_changes_since` reports them in
`diff.staleDatums` when a revision or document change invalidates them.

The construction tools are:

- `plasticity_define_datum_point`
- `plasticity_define_datum_axis`
- `plasticity_create_construction_plane`
- `plasticity_list_construction_geometry`
- `plasticity_set_workplane`
- `plasticity_remove_construction_plane`
- `plasticity_refresh_datum`

Saved plane creation/removal uses one native Plasticity history entry. Datum
definitions live only for the current MCP session. A body edit or manual saved
plane edit makes geometry-backed datum identities stale; call
`plasticity_refresh_datum` for a resolvable topology-backed datum or define a
new immutable coordinate datum at the new revision.

## Development and verification

```sh
npm test
npm run typecheck
npm run probe:targets
npm run probe:regions
# destructive proof, only in an explicitly chosen empty test window:
npm run probe:regions -- --mutate --target <target-id>
npm run accept:instances -- --target <target-id> --allow-disposable-mutations --output <new-directory>
npm run accept:groups -- --target <target-id> --allow-disposable-mutations --output <new-directory>
npm run accept:interference -- --target <target-id> --allow-disposable-mutations --output <new-directory>
npm run accept:solid-properties -- --target <target-id> --allow-disposable-mutations --output <new-directory>
npm run accept:native-parasolid -- --target <target-id> --allow-disposable-mutations --output <new-directory>
```

The live acceptance run created an 80 × 40 × 8 mm plate with two Ø6 mm
through-holes and four R2 outer vertical fillets. It verified Undo/Redo,
saved `.plasticity` and STEP files, reopened the native document, imported the
STEP, and captured a screenshot. Evidence and exact artifact paths are in
[the native-access report](./native-access-report.md). Текущее состояние
каждого требования и проверки, которым ещё нужно внешнее устройство, сведены
в [матрицу готовности](./acceptance-matrix.md).

This adapter is pinned to Plasticity 26.1.3. Plasticity's internal interfaces
are undocumented and may change in another release.

## Photo or sketch workflow

The MCP exposes the `plasticity_model_from_reference` prompt for agents that
support MCP prompts, plus `plasticity_analyze_design_reference` for bounded,
structured photo/sketch interpretation through the isolated Codex API. Codex
remains the conversation partner; Workbench is optional. The intended workflow
is:

1. Attach up to four PNG/JPEG/HEIC/HEIF views of the part, a hand sketch, or a
   dimensioned drawing to the agent (20 MiB per image).
2. The agent passes all supplied views and the task to the design-reference tool
   in one Codex request. It records
   visible facts separately from inference, binds claims to evidence IDs, and
   reports whether scale is dimensioned, calibrated, unscaled, or unknown.
   An unscaled image never yields millimeter measurements.
3. The agent asks only the next decision-relevant question package. For a
   bracket, this starts with what it supports and how it is mounted; strength
   and load path come before wall thickness. It explains why the missing fact
   matters. If the user does not know, it asks for one useful contextual clue
   such as the supported object or a product photo, rather than repeating the
   same unknowns. The user may delegate the assigned choice while the agent
   keeps its assumptions visible.
   Optional refinements do not delay a sufficiently specified task. Before
   changing the model based on a consequential choice that was not delegated,
   the agent gives its recommendation and trade-offs and asks the user to
   accept, reject, or delegate.
4. For a named product, call `plasticity_search_product_references` to use an
   isolated Codex live-web profile to search manufacturer CAD and drawings
   first. It returns candidate source links and cited dimension evidence; the
   agent reviews source, license, file format, and fit-critical dimensions.
   Search never downloads or imports a model. Select a candidate explicitly
   before passing its public STEP URL to the guarded importer.
5. Once the question is resolved and the modeling action is authorized, the
   agent connects to an explicit Plasticity window, reads status, and captures
   a scene snapshot. For one chosen public STEP URL, it supplies the HTTPS
   source, source category, known license, and confidence to
   `plasticity_download_and_import_step`; the MCP pins public DNS results,
   bounds redirects and file size, validates the STEP envelope, and imports a
   private hash-addressed copy. For a STEP already downloaded locally, it can
   use `plasticity_import_step`. The import response stays compact: it returns
   document identity/revision, changed body IDs/count, artifact SHA-256, and a
   durable local CAD-reference provenance ID. Read exact geometry only for
   selected IDs with `plasticity_body_info`; the historical import record can
   be recovered through `plasticity_list_cad_reference_imports` and
   `plasticity_get_cad_reference_import` after restart.
6. The agent compares before/after scene snapshots, checks exact B-Rep bounds,
   groups and locks reference bodies, then builds native functional geometry
   separately. It reads dimensions back from Plasticity and presents an
   isometric screenshot for review.
7. Before manual work, it captures another compact snapshot (ID, revision and
   object counts; the B-Rep baseline remains private to the MCP process). After
   the user edits or selects geometry in Plasticity, `plasticity_changes_since` and
   `plasticity_current_selection` return a compact, revision-bound, paginated
   summary of changed bodies plus the selected face/edge IDs. Follow
   `bodyPagination.nextOffset` with `expectedRevision=current.revision`; use
   `plasticity_body_info` to read exact topology for a selected body. The agent
   continues from the new revision.

To verify the read-only scene-observation path against a live window, run
`npm run accept:compact-observation -- --target PLASTICITY_WINDOW_ID --output NEW_DIRECTORY`.
It uses the production stdio MCP server, checks connect/status and body-list
pagination, captures an in-memory snapshot, reads the unchanged diff and
journal, and refuses to overwrite evidence. It performs no CAD mutation.

To validate a paginated scene diff against live Plasticity, use a separate
disposable test document and explicitly opt into disposable mutations:

```sh
npm run accept:compact-diff-live -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EVIDENCE_DIRECTORY
```

This verifier creates 201 temporary boxes through the production stdio MCP
server, checks that `plasticity_changes_since` and the construction journal
paginate as 100, 100, and 1 without duplicates or detailed B-Rep topology. It
also checks every mutation response for its total body count, a compact page
of at most 20 summaries, and exactly one compact added-body summary. It records
the maximum and mean serialized mutation-response sizes in `evidence.json`. It
captures the initial scene and refuses documents with redo history,
non-root groups, regions, or instances. It uses native Undo only while the
selected document and revision still match the verifier's last confirmed state;
an uncertain command outcome stops automatic cleanup. Undo restores the
initial scene but leaves the temporary operations in the document's redo
history, so use a disposable document and discard it after the run. Keep other
editors and agents out of the document during the acceptance. Help/no-argument
mode is inert and evidence directories are never overwritten.

The direct-UI geometry-change acceptance is available for an explicit empty
test document:

```sh
npm run accept:native-ui-edits -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It creates one temporary Solid, waits for a visible mouse move in Plasticity,
then checks the reported scene diff, exact native bounds, Undo/Redo and cleanup
to the original empty document. Live UI gesture verification still needs to be
completed on this host.

Workbench can persist the original artifact and reference record when it is
enabled. Without Workbench, the MCP reference store keeps the STEP hash, source
metadata and import-time B-Rep snapshot locally; current-process journal
entries remain session-only, while compact mutation history survives MCP
restarts. The original STEP remains at its source path. The agent should
include source and measurement details in the Codex conversation for project
portability.

The image-backed tool path passed a real Codex API call through stdio MCP on
2026-09-24. Its synthetic bracket sketch stayed unscaled, returned nine
observations and one question package, contained no millimeter measurements,
and every interface/feature claim resolved to an observation ID. A separate
live acceptance carried that sketch through one clarification, explicit
dimensions and native CAD creation, then verified exact B-Rep bounds and Undo.
These synthetic checks do not establish arbitrary-photo reconstruction or
general design inference; see [design-reference acceptance](./design-reference-acceptance.md).
To verify several supplied images in one live Codex turn without touching CAD,
repeat `--image` two to four times with `npm run accept:design-reference-multiview`.
Image-derived observations include one-based `sourceImageIndices` into that
request's image list; invalid or out-of-range indexes are rejected. Live
acceptance verifies attribution across four distinct synthetic bracket views.
Regenerate those fixtures with `swift
scripts/fixtures/generate-design-reference-views.swift`; see
[design-reference acceptance](./design-reference-acceptance.md) for evidence
and the remaining limits of synthetic inputs.

Cylinders accept an arbitrary world-space axis and circles accept an arbitrary
plane normal. Circles and polylines can instead use a current construction-plane
identity and 2D coordinates. Closed curves generate revision-bound regions;
extruding an unambiguous profile or an explicit region creates a capped Solid.

## Workbench: модель, таблицы и планшет

Workbench объединяет проекты, интерактивный STEP-просмотрщик, валидируемые
таблицы размеров, аннотации стилусом и проверку подготовки к печати. Общение с
агентом остаётся в Codex; веб-интерфейс не содержит отдельного чата. Запуск в
локальной сети:

```sh
npm run start:workbench -- --lan
```

Откройте напечатанный адрес на Mac. В проекте нажмите **Поделиться**, перенесите
одноразовую ссылку на планшет и рисуйте поверх зафиксированной версии модели.
Аннотации отправляются агенту одним пакетом только после явной кнопки. Поля
размеров проверяют числовой тип, диапазон, шаг и целочисленные значения до
записи и повторно на сервере. Просмотрщик предоставляет изометрический,
фронтальный и верхний ракурсы, ортографические виды, Z-сечение, вписывание,
выбор, скрытие, изоляцию и прозрачность тел. Попавшая в модель стилусная
отметка сохраняет 3D-точку и, при наличии сопоставления, ID тела и грани.
Точный порядок запуска, MCP-регистрация и восстановление
описаны в [руководстве Workbench](./workbench-operations.md).

Workbench MCP публикует версии модели, точные B-Rep измерения, таблицы и статусы:

```sh
codex mcp add plasticity-workbench -- npm --prefix ./workbench run mcp
```

MCP сначала ищет уже работающий Workbench на loopback и локальных приватных
IPv4. Если сервис не найден, он запускает его сам с `--lan`. Через
`workbench_list_projects` и `workbench_create_project` агент подготавливает
проект и получает его отдельный `workspacePath` без текстового чата в браузере.

Для публикации файла агент сохраняет его внутри `workspacePath` проекта и
вызывает `workbench_upload_project_artifact` с относительным путём. Реальный
путь повторно проверяется после разрешения симлинков; выход за каталог проекта,
неподдерживаемое расширение, каталог вместо файла и размер свыше 250 MiB
отклоняются.

`workbench_register_reference` сохраняет источник, URL, SHA-256 загруженного
файла, лицензию, тип источника, роль в сцене и уверенность каждого размера.
Критичные неизвестные размеры выводятся отдельной таблицей. Сам Workbench не
скачивает произвольные URL: агент сначала проверяет источник, загружает файл как
артефакт и затем регистрирует его происхождение.

`plasticity_construction_history` читает локальную историю команд, а
`plasticity_construction_journal` дополнительно сравнивает живую сцену с
последним записанным событием и сообщает о неизвестном исходе или ручной
правке. История хранится в `.plasticity-mcp/construction-history`; для другого
пути задайте `PLASTICITY_CONSTRUCTION_HISTORY_ROOT`. Агент публикует контрольные
снимки через
`workbench_publish_construction_journal`; Workbench сохраняет их в SQLite с
ревизией проекта. Таким образом MCP сохраняет историю без Workbench; Workbench
привязывает опубликованные снимки к проектной ревизии. Снимки журнала содержат
компактные B-Rep bounds и топологические количества, а не полные face/edge
данные. Текущий журнал также отдаёт записи страницами (`offset`/`limit`) и
хранит только компактные изменения тел в памяти процесса. После перезапуска вызовите `plasticity_construction_history`, затем
подключитесь к явному окну и вызовите `plasticity_construction_journal`, чтобы
проверить `durableSyncStatus`. История — диагностическая, старые операции не
переигрываются и не отменяются автоматически. См. [construction history](./construction-history.md)
для статусов и восстановления. STEP-происхождение хранится отдельно в
`.plasticity-mcp/references`; его записи также являются историческими и не
служат текущими ссылками на тела после правок. Полученные STEP-файлы по умолчанию
остаются в `.plasticity-mcp/reference-artifacts`; путь настраивается через
`PLASTICITY_REFERENCE_ARTIFACT_ROOT`. См. [reference acquisition](./reference-acquisition.md)
для сетевых ограничений и происхождения загрузок.

При установленном Creality Print Workbench находит штатные профили K1C,
проверяет габариты детали, запускает CLI-нарезку в отдельном неизменяемом
каталоге и показывает G-code по слоям. Отправка на принтер возможна только после
подтверждения в браузере, привязанного к SHA-256 G-code, профилю, принтеру и
ревизии проекта, а также точному набору DFM-предупреждений и оценок. Любая
последующая правка аннулирует возможность отправки.
Для K1C 0.4 мм каталог Workbench публикует все найденные filament-профили,
совместимые с этой машиной, для штатного процесса 0.20 mm Standard, а не только
Generic PLA. На этом Mac живое чтение Creality Print обнаружило отдельные
профили Creality CR-PLA и Hyper PLA; это профили слайсера, а не подтверждение
свойств конкретной катушки или испытаний прочности.
Для штатного K1/K1C Workbench загружает один бинарный файл через тот же
`/upload/<filename>` endpoint, который использует установленный Creality Print,
а затем запускает точное ASCII-имя через Moonraker. На текущем K1C этот путь
проверен живой отправкой и состоянием `print_stats=printing`.
Если ответ принтера потерян, `workbench_reconcile_print_submission` сверяет
текущий `print_stats` и хранилище G-code. Он не загружает и не запускает файл:
точно отсутствующий файл можно отправить отдельной командой, а найденный без
подтверждённого запуска остаётся в состоянии `unknown`.
Найденный установленный профиль можно зарегистрировать через
`workbench_register_manufacturing_profile`, передав его `printer.id`,
`material.id` и `slicer.id` из каталога. Workbench разрешает профиль локально и
копирует три JSON-конфигурации в неизменяемый реестр с отдельными SHA-256; агенту
не нужно видеть локальные пути. Пользовательский или импортированный профиль
можно передать полным объектом через локальный MCP. Статусы `draft`, `imported`,
`official` и `user-verified` остаются различимы. Для DFM и нарезки используется
возвращённый `profileHash`.

Creality Print 7.2 CLI принимает STL, OBJ и AMF, но отклоняет STEP. На
Plasticity 26.1.3 + Creality Print 7.2.2.5483 для контрольного Solid 20 × 10 ×
5 мм живой маршрут `plasticity_export_stl` → Workbench slicing вернул 25 слоёв
и реальные границы траекторий 20 × 10 × 5 мм. Слайсерский `--datadir` и
профили изолированы внутри задания. Экспортированный Plasticity 3MF импортируется
для просмотра размеров, но в этой версии не даёт пригодного результата
`--slice`; поэтому для Creality Print выбирается STL. Редактируемым источником
остаётся `.plasticity` или STEP, а Workbench привязывает нарезку к SHA-256
производного STL. Допуск хорды и угловой допуск записываются в результат экспорта.

OrcaSlicer 2.4.2 также прошёл живой Workbench MCP acceptance на K1C: из
установленных machine/process/filament пресетов получен профиль Generic PLA,
20 × 10 × 5 мм STL дал 25 слоёв и job остался `ready`; принтер не подключался.
Для Orca Workbench читает модельный габарит из `EXCLUDE_OBJECT_DEFINE` metadata
в G-code и отдельно сохраняет меньший bbox траектории экструдера. Если G-code
даёт только приблизительные границы траектории, они не считаются доказательством,
что сама модель помещается на столе.

На Apple Silicon Workbench предпочитает
`/Applications/Creality Print (Apple Silicon).app`, если в нём найдены CLI и
штатные профили K1C; исходное `/Applications/Creality Print.app` не заменяется.
Для нестандартного расположения задайте `CREALITY_PRINT_EXECUTABLE` и
`CREALITY_PRINT_RESOURCES_ROOT` (путь к `Contents/Resources`) процессу
Workbench. Живой slicer acceptance запускается командой
`npm run accept:creality-print -- --input /path/to/model.stl --output /new/evidence --executable /path/to/CrealityPrint --resources-root /path/to/Contents/Resources`;
он не связывается с принтером и не начинает печать.
Полный stdio MCP-конвейер — создание проекта, загрузка STL, выбор профиля,
`workbench_slice_model`, чтение preview asset и отказ отправки до подтверждения —
проверяется командой `npm run accept:workbench-creality-mcp` с теми же аргументами.
Для комплектов из нескольких частей предусмотрен `workbench_slice_parts`: он
проверяет весь пакет STL до нарезки, создаёт отдельный G-code job на каждую
часть и сохраняет отдельное подтверждение перед отправкой каждого задания.
Живая batch-проверка на K1C запускается тем же acceptance с `--batch-parts 2`.
MCP также предоставляет `plasticity_export_3mf` для слайсеров, которые
принимают 3MF. Plasticity 26.1.3 всегда объявляет координаты такого файла в
метрах, поэтому адаптер задаёт проверенный масштаб `0.001` для исходной
миллиметровой модели, проверяет обязательные OPC-части архива и читает реальные
границы сетки обратно из `3D/3dmodel.model`. `.plasticity` или STEP остаётся
редактируемым источником; 3MF, как и STL, является производной сеткой.
Creality Print/K1C по-прежнему использует STL, поскольку его CLI не выдаёт
пригодный G-code из Plasticity 3MF.

`plasticity_export_obj` создаёт производную Wavefront-сетку выбранных Solid и
Sheet через нативный `OBJExportFactory`. Координаты записываются в миллиметрах
с осью Z вверх. Адаптер перечитывает сохранённый файл, проверяет индексы граней,
конечность координат и возвращает число объектов, вершин, нормалей, UV, граней,
треугольников и фактические bounds. Файл не перезаписывается, а экспорт не
меняет документ или историю Plasticity. Повторяемая живая проверка:

```sh
npm run accept:native-obj-export -- \
  --target TARGET_ID \
  --allow-disposable-mutations \
  --output /tmp/plasticity-mcp-output
```

Если габарит не помещается на стол, `workbench_assess_printability` сначала
проверяет шесть осевых ориентаций и диагональную раскладку с шагом 0,1°.
Для большой детали он возвращает расчётную сетку частей, смещения разрезов и
варианты соединений. Сам расчётный план CAD не изменяет. После выбора
ориентации и выравнивания детали вдоль мировых осей принтера агент передаёт
полезный объём профиля в `plasticity_split_solid_to_build_volume`: MCP читает
точные B-Rep bounds, вычисляет число равных сегментов и координаты плоскостей,
затем проверяет фактические bounds каждого результата. Для одного выбранного
плоского разреза MCP предоставляет
`plasticity_split_solid_by_plane`, а `plasticity_split_solid_by_planes` принимает
упорядоченный список плоскостей и последовательно режет только пересекаемые
ими текущие части. Оба инструмента строят временные поверхности по точным
B-Rep границам, требуют ровно два Solid на каждый нативный разрез, проверяют
сохранение точного общего объёма и удаляют временные резаки. Агент пока сам
выбирает и применяет ориентацию детали по DFM `splitPlan`; MCP пока не
оптимизирует швы под прочность, поддержки или сборку.
Соединение создаётся отдельной операцией и требует согласованного типа и
проверенного зазора. Получившиеся части нужно повторно проверить относительно
стола. Перед созданием задания Workbench независимо проверяет реальные границы
траекторий из G-code относительно объёма выбранного принтера.
После ориентации агент может повторно вызвать `workbench_assess_printability`
с `split.protectedZones`, указав источник, ось и точный интервал зоны в
ориентированных координатах. DFM помечает пересечение предложенных швов с
этими областями и проверяет полный явный набор альтернативных
`split.cutOffsetsMm` на размер каждого сегмента. Ссылки на расчёт и сами зоны
передаёт вызывающий агент; Workbench не проверяет актуальность расчёта и не
выводит структурную безопасность. Для применения смещённых плоскостей агент
передаёт их из ответа в `plasticity_split_solid_by_planes`; автоматическая
оптимизация расположения швов по прочности или поддержкам пока не выполняется.

Нативный сценарий можно повторить на явно выбранном пустом окне Plasticity:

```sh
npm run accept:native-solid-split -- --target TARGET_ID --allow-disposable-mutations --output /tmp/plasticity-mcp-output
```

Проверка создаёт временный куб 20 × 20 × 20 мм, делит его пополам и строит
шип-паз с тестовым зазором 0,25 мм. Затем она делит куб 40 × 20 × 20 мм двумя
плоскостями на четыре части. Оба сценария сверяют точные B-Rep bounds и объём,
проверяют нативную валидность частей, для шип-паза также проверяют отсутствие
объёмной коллизии, выполняют Undo/Redo и возвращают документ к исходному
пустому состоянию. Тестовый зазор подтверждает CAD-геометрию, но не заменяет
калибровку печати. Та же проверка отдельно моделирует пару «винт + термовставка»
по публичному MCP-рецепту и проверяет резьбу M5×0,8, измеренное зацепление,
валидность Solid, отсутствие пересечения и Undo/Redo. Размеры термовставки в
этом fixture синтетические и не подтверждают установку конкретного изделия.
Проверка откажется работать с непустым документом или уже существующим
каталогом evidence.

Сквозной маршрут двух частей с этим соединением и Creality Print/K1C проверяется
командой `npm run accept:workbench-creality-mcp -- --plasticity-target TARGET_ID
--split-native --split-joint screws-and-inserts --output NEW_DIRECTORY --executable
"/Applications/Creality Print (Apple Silicon).app/Contents/MacOS/CrealityPrint"
--resources-root "/Applications/Creality Print (Apple Silicon).app/Contents/Resources"`.
Это малый синтетический шовный fixture, не рекомендация для реального изделия;
оба задания остаются `ready`, а отправка без подтверждения блокируется.
