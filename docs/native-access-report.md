# Native access report: Plasticity 26.1.3 on macOS

Date: 2026-09-20

## Result

The native-access gate passed on Apple Silicon with Plasticity 26.1.3 and
Electron 26.6.9. The installed application removes ordinary
`--remote-debugging-port` arguments during startup. A clean launch through the
Node main-process inspector allowed the launcher to preserve an Electron CDP
listener on `127.0.0.1:9223` before renderer creation, then resume startup.

The launcher changes only the running process. The `.app`, packaged bytecode,
metadata, code signature, and user preferences are not changed.

## Gate evidence

The connected renderer exposed the Plasticity editor and native factories in
the closure of its command logger. On the tested build, geometry is stored in
`editor.geo.geometryModel`; the older `editor.db.items` shape used by public
25.3 examples is absent.

A native `ThreePointBoxFactory` command created a B-Rep box. The result was
read from the C3D model with `FindBox()`:

- minimum: `[0, 0, 0]` m
- maximum: `[0.08, 0.04, 0.008]` m
- dimensions: 80 × 40 × 8 mm

The document geometry count changed from 1 to 2 and the database version from
6 to 9. `editor.undo()` removed stable body ID 2; `editor.redo()` restored it
with the same exact B-Rep bounds. This is native geometry evidence, not a mesh
bounding box.

### Exact planar-face boundary probe

On 2026-09-21, `scripts/probe-section-face.ts` passed against the explicit
disposable target `TARGET_ID`. The probe refuses a
nonempty document and requires all three mutation arguments: `--target`,
`--mutate`, and `--allow-disposable-mutations`. Its baseline had zero bodies,
zero regions, and Undo depth 1. Cleanup returned to that same empty baseline.

For the upward face of a native 20 × 10 × 5 mm box, `Face.GetEdges()` returned
four `Edge` records. Each reported `IsLine()=true`, two native vertex IDs, and
different positions from `GetPointAndTangent(0)` and `(1)`. The observed
endpoints exactly formed the four corners at Z=5 mm.

For a second 20 × 10 × 5 mm box with a centred Ø4 mm through-hole, the upward
face contained four line edges plus one exact circular edge. The circular edge
reported:

- `IsLine()=false`, `IsCircle()=true`, no endpoint vertices, and coincident
  parameter-0/1 points, which identifies a full circle rather than an arc;
- native length `12.566370614359172 mm`, equal to `2π × 2 mm`;
- `Circle.GetInfo().radius=0.002` in Plasticity's internal metre units;
- `Basis.Location=[0.04,0.005,0.005] m`, `Basis.Axis=[0,0,1]`, and
  `Basis.Ref=[1,0,0]`;
- start point `[42,5,5] mm` and start tangent `[0,1,0]`.

This record is sufficient to classify lines, circular arcs and full circles.
For a circular arc, distinct parameter endpoints identify the bounded span;
native length divided by radius gives sweep magnitude, while the basis axis,
reference direction and start tangent fix sweep orientation. The production
adapter may therefore integrate supported boundaries from exact C3D curve data
without a display mesh. The probe emits only bounded scalar snapshots and
constructor/identity metadata; it never serializes native objects.

## End-to-end acceptance run

The implementation then created a separate part with:

- plate dimensions 80 × 40 × 8 mm;
- two native cylinders of radius 3 mm and height 8 mm;
- one native Boolean difference using both cylinders;
- four outer vertical edges selected from current topology;
- a native fillet of radius 2 mm on those edges.

The Boolean result had 8 faces and 16 edges. The filleted result had 12 faces
and 28 edges and retained native bounds of 80 × 40 × 8 mm. Undo restored the
8-face pre-fillet body; Redo restored the 12-face filleted body.

Produced and validated artifacts:

- `.plasticity`: `.plasticity-mcp/result/technical-plate-1789894645373.plasticity`, 24,758 bytes
- STEP: `.plasticity-mcp/result/technical-plate-1789894645373.step`, 14,943 bytes with a
  complete ISO-10303-21 header and trailer
- PNG: `.plasticity-mcp/result/technical-plate-final.png`, 346,047 bytes

The saved native document was reopened through Plasticity's native open
command. The clean file contains one body; stable body ID 21 returned with 12
faces, 28 edges, and the expected
80 × 40 × 8 mm B-Rep bounds. The exported STEP was imported through the native
exchange factory and created a new 12-face solid. Its X and Y spans differed
from the source by 0.0001 mm; C3D `FindBox()` expanded the imported Z bounds by
the imported face tolerance, so this box alone is not used as proof of the
original height. The source and reopened native model provide the exact height
check.

Additional live checks passed for sphere, polyline, circle, closed-profile
extrusion, move, rotate, nonuniform scale, rename, delete, STEP import/export,
save-copy, camera, screenshot, and Undo recovery. The initial Wire path through
`ExtrudeFactory.curves` returned a Sheet. The later region adapter now reads
Plasticity's automatic `SketchIsland` regions and passes them through
`ExtrudeFactory.regions`, producing capped Solids. Face extrusion uses the
26.1.3 `ExtrudeFactory` binding because `FaceExtrudeFactory` is not present in
this version.

The collaboration layer was also verified through a real stdio MCP client. A
scene snapshot detected a body rename as a name-only modification, preserved
the selected stable body ID, and reported no document replacement. Undo
restored the original name. A zero-duration wait on an unchanged second
snapshot returned a clean timeout. The server exposes 116 tools plus the
`plasticity_model_from_reference` MCP prompt. Arbitrary-axis cylinder and
arbitrary-plane circle creation were verified from their native B-Rep bounds.

The first recipe-layer operation was verified through a real stdio MCP client
on the disposable Plasticity window. `plasticity_create_counterbore` cut a Ø4
through hole and a Ø8 × 3 mm flat-bottom counterbore into a 40 × 40 × 8 mm
Solid. Exact B-Rep faces reported cylindrical radii 2 and 4 mm with axial spans
Z=0…5 and Z=5…8 mm respectively. Native `Check()` returned no errors and the
body remained a closed printable Solid. Three Undo calls restored the untouched
box, three Redo calls restored the counterbore, and final cleanup returned the
window to its empty baseline at undo depth 1. The MCP result recorded both
temporary cutter IDs, all three confirmed revisions, and `undoSteps: 3`.

The same guarded path now exposes `plasticity_create_counterbore_pattern` for
fixed groups of equal socket-head seats. One stdio MCP call cut two Ø4 mm
through holes with Ø8 × 3 mm flat-bottom recesses at explicit centers in a
separate 40 × 20 × 8 mm Solid. Four native Cylinder steps and one final Boolean
difference produced exact R2 walls over Z=0…5 and R4 walls over Z=5…8 at both
centers. Native `Check()` returned no codes and the body remained closed and
printable. Five Undo calls removed the group, five Redo calls restored it, and
cleanup returned the document to its empty baseline. The designation resolver
routed `крепится на 2 винта DIN 912 M4x16 с гайками` to the grouped tool without
inventing head or clearance dimensions. Sanitized evidence is at
`[local acceptance artifact omitted]`.

Fixed groups of blind tap-drill or modeled minor-diameter holes now use
`plasticity_create_blind_hole_pattern`. One real stdio MCP call cut two Ø4.2 mm
flat-bottom holes to 5 mm depth in a separate 40 × 20 × 8 mm Solid. Two native
Cylinder steps and one Boolean difference produced two exact R2.1 walls, four
Ø4.2 circular edges, and two floors at Z=3 mm. Native `Check()` returned no
codes, three Undo and three Redo steps passed, and cleanup restored the empty
document. The resolver routed a two-fastener ISO 4029 tapped-metal request to
the grouped operation without treating M5 or the 10 mm fastener length as hole
geometry. Sanitized evidence is at
`[local acceptance artifact omitted]`.

Fixed groups of countersunk screws now use
`plasticity_create_countersink_pattern`. One stdio MCP call cut two Ø5.5 mm
through holes with Ø10.4 × 90 degree recesses at explicit centers in a separate
40 × 20 × 8 mm Solid. Two native Cylinder steps, two preserved meridional Wire
profiles, two Revolve steps, and one final Boolean produced two exact Cone
faces, two R2.75 bore walls, and two Ø10.4 entry edges. The derived recess depth
was 2.45 mm. Native `Check()` returned no codes and the body remained closed
and printable. Seven Undo calls removed the group, seven Redo calls restored
it, and cleanup returned the document to its empty baseline. The resolver
routed `крепится на 2 винта ISO 10642 M5x10 с гайками` to the grouped recipe
without treating the nominal M5 diameter as finished bore geometry. Sanitized
evidence is at
`[local acceptance artifact omitted]`.

Captive or recessed nut groups now use
`plasticity_create_hex_nut_pocket_pattern`. One stdio MCP call cut two regular
hex pockets with 8 mm across flats and 4 mm depth at explicit centers in a
separate 40 × 20 × 8 mm Solid. Two preserved Wire profiles, two Extrude steps,
and one final Boolean produced twelve exact planar side faces, twenty-four
edges of length 8/√3 mm, and two floors at the requested depth. Native `Check()`
returned no codes and the body remained closed and printable. Five Undo calls
removed the group, five Redo calls restored it, and cleanup returned the
document to its empty baseline. This run also established that coplanar closed
profiles in Plasticity share their sketch Wire membership across Region
records; both the single and grouped recipes therefore select the one newly
created Region by native Region identity instead of counting records that
mention the new Wire. Sanitized evidence is at
`[local acceptance artifact omitted]`.

`plasticity_create_heat_set_insert_pocket` was then exercised through the same
stdio path on a 40 × 40 × 12 mm Solid. A Ø3 × 8 mm pilot, Ø4.6 × 6 mm insert
bore, and Ø5.4 × 1 mm lead-in produced exact cylindrical B-Rep spans Z=4…6,
6…11, and 11…12 mm. Plasticity reported a closed printable Solid with 12 faces,
18 edges, no boundary edges, and no native `Check()` codes. Four Undo/Redo
calls restored the untouched block and the three-stage pocket; cleanup returned
the disposable document to undo depth 1 with no bodies.

`plasticity_create_heat_set_insert_pocket_pattern` applies the same qualified
three-stage geometry at 2–64 explicit centers and now requires local material
depth for both single and grouped recipes. One real stdio MCP call cut two
pockets into a 40 × 20 × 12 mm Solid with six native Cylinder steps and one
Boolean difference. Exact B-Rep returned two R1.5 spans at Z=4…6 mm, two R2.3
spans at Z=6…11 mm, two R2.7 spans at Z=11…12 mm, twelve circular edges, and two
floors at Z=4 mm. The Solid remained closed and printable with no native check
codes; seven Undo/Redo steps passed and cleanup restored the empty document.
The designation resolver chose this grouped recipe and a grouped mating
clearance-hole recipe for two heat-set inserts. Sanitized evidence is at
`[local acceptance artifact omitted]`.

`plasticity_create_screw_boss` was live-tested on a 40 × 40 × 4 mm support.
The recipe overlapped and united a Ø10 × 10 mm boss, then cut a Ø3 × 8 mm blind
pilot from its top. Exact B-Rep data placed the exposed outer cylinder at
Z=4…14 mm and the pilot wall at Z=6…14 mm; the combined body retained the
support's stable ID and exact overall height 14 mm. Native validation reported
10 faces, 16 edges, no boundary edges or check codes, and a printable closed
Solid. Four Undo/Redo calls restored the support and completed boss, followed
by cleanup to the empty undo-depth-1 baseline.

`plasticity_create_screw_boss_pattern` applies that qualified geometry at 2–64
explicit base centers using N boss cylinders, one union, N pilot cutters, and
one final difference. One real stdio MCP call created two Ø10 × 10 mm bosses
with Ø3 × 8 mm pilots on a 50 × 30 × 4 mm support. Exact B-Rep returned two R5
walls at Z=4…14 mm, two R1.5 pilot walls at Z=6…14 mm, and two pilot floors at
Z=6 mm. The original support ID remained stable; native validation reported a
closed printable Solid with 14 faces, 20 edges, no boundary edges, and no
`Check()` codes. Six Undo/Redo calls passed and cleanup restored the empty
document. The designation resolver selected the grouped recipe for two fixed
self-tapping screws into printed plastic. Sanitized evidence is at
`[local acceptance artifact omitted]`.

`plasticity_create_rib` was tested with a triangular XZ profile overlapping a
40 × 40 × 4 mm support and a signed 4 mm extrusion. The closed Wire remained
editable at Y=18 mm while its extruded Solid was united into the support. Exact
B-Rep bounds became 40 × 40 × 14 mm; native validation reported a closed
printable Solid with 10 faces, 21 edges, no boundary edges, and no check codes.
Three Undo/Redo calls restored the base and completed rib, and final cleanup
again left no bodies at undo depth 1.

`plasticity_create_round_vent_array` created a 3 × 2 grid of Ø3 mm through
vents in a 50 × 40 × 4 mm plate. One seed cylinder and one native rectangular
pattern produced six cutter bodies at exact centers (10/20/30, 10/20) mm; one
Boolean consumed all of them. The resulting B-Rep had six R1.5 cylindrical
walls spanning the complete Z=0…4 mm thickness. Native validation reported a
closed printable Solid with 12 faces, 24 edges, no boundary edges or check
codes. Three Undo/Redo calls restored the plate and vent array, and cleanup
returned the disposable document to its empty baseline.

`plasticity_create_cantilever_snap_fit` was live-tested from the side of a
4 × 20 × 4 mm support with a 20 × 6 × 2 mm beam, 3 mm hook length, 4 mm hook
height, and 0.5 mm attachment overlap. The derived six-point profile remained
as an editable Wire while the extruded feature joined the support. Exact B-Rep
bounds were X=0…24, Y=0…20, Z=0…7 mm; native validation reported a closed
printable Solid with 13 faces, 30 edges, no boundary edges, and no check codes.
Three Undo/Redo calls restored the support and completed snap-fit, followed by
cleanup to the empty undo-depth-1 baseline.

`plasticity_create_hinge_barrel` was live-tested along world +Y on the edge of
a 20 × 4 × 20 mm support. The recipe created a Ø8 × 4 mm knuckle, cut an
overshooting Ø3 pin bore, and united the resulting hollow barrel to the support.
Exact B-Rep faces reported R4 and R1.5 across Y=0…4 mm and an overall X maximum
of 24 mm. Native validation reported a closed printable Solid with 10 faces,
24 edges, no boundary edges, and no check codes. Four Undo/Redo calls restored
the support and hinge, followed by cleanup to undo depth 1 with no bodies.

`plasticity_cut_cable_channel` was live-tested with an editable 30 mm Wire on
the top of a 40 × 20 × 10 mm block. A solid native Pipe cutter produced an open
Ø6 mm channel and was consumed by one Boolean while the source Wire remained.
Plasticity 26.1.3 exposes the trimmed channel wall as a non-planar `BSurf`; its
exact B-Rep bounds were X=5…35, Y=7…13 and Z=7…10 mm. The two circular end
edges were semicircles centered at [5,10,7] and [35,10,7] mm, each with native
length 9.4247779608 mm (π × 3), which provides the exact radius evidence.
Native validation reported a closed printable Solid with 9 faces, 18 edges, no
boundary edges, and no check codes. Two Undo/Redo calls restored the uncut
block and completed channel, and cleanup returned the disposable document to
undo depth 1 with no bodies.

`plasticity_create_connector_opening` was live-tested on a 40 × 30 × 10 mm
block with a centered 14 × 8 mm through-opening and R2 corners. The profile
Wire remained at Z=10.5 mm with exact 14 × 8 mm bounds. After native extrusion,
four longitudinal cutter edges were filleted before the Boolean. The completed
Solid exposed four R2 cylindrical walls spanning Z=0…10 mm with axes at the
derived corner centers [15/25, 13/17] mm. Native validation reported 14 faces,
36 edges, no boundary edges or check codes, and a closed printable Solid. Four
Undo/Redo calls restored the untouched block and completed rounded opening;
cleanup returned the disposable document to undo depth 1 with no bodies.

`plasticity_create_mating_enclosure_joint` was live-tested on two separately
hollowed axis-aligned enclosure halves with a 40 × 30 mm seam. A 1 mm thick,
2 mm high male lip overlapped the lower wall by 0.25 mm and reached Z=12 mm.
The female rabbet boundary was at X/Y=1.5 mm while the corresponding male outer
wall was at 1.75 mm, proving the requested 0.25 mm radial clearance from exact
B-Rep planes; the female shelf lay at Z=12.25 mm. Both stable target IDs were
preserved. Native validation reported closed printable Solids with 21/48 and
16/36 faces/edges, no boundary edges, and no check codes. Eight Undo/Redo calls
restored the unjointed and finished halves, and cleanup of the fourteen setup
and recipe steps returned the document to its empty undo-depth-1 baseline.

`plasticity_create_locating_pin_pair` was live-tested between two 40 × 30 mm
plates sharing a Z=10 mm mating plane. The recipe joined a Ø5 × 6 mm pin to the
male plate and cut a 6.75 mm deep socket into the female plate with 0.25 mm
radial and 0.75 mm axial clearance. Exact cylindrical B-Rep faces reported
R2.5 over Z=10…16 mm and R2.75 over Z=10…16.75 mm, directly proving both fit
allowances. Both stable target IDs remained. Native validation reported each
body as a closed printable Solid with 8 faces, 14 edges, no boundary edges, and
no check codes. Four Undo/Redo calls and full cleanup passed.

`plasticity_create_tongue_groove_joint` was live-tested between two 40 × 30 mm
plates with a 12 × 4 × 5 mm tongue, 0.25 mm radial clearance, and 0.75 mm axial
clearance. The preserved exact profile bounds were 14…26 × 13…17 mm for the
tongue and 13.75…26.25 × 12.75…17.25 mm for the groove. B-Rep planes placed
the tongue top at Z=15 mm, groove bottom at Z=15.75 mm, and corresponding side
walls at X=14 and X=13.75 mm. Plasticity represented the nested coplanar
profiles as two adjacent Regions sharing both Wire IDs; extruding both Regions
produced one full cutter, and an automated regression covers this behavior.
Both stable target IDs remained and both 11-face/24-edge bodies passed native
validation as closed printable Solids. Six Undo/Redo calls and cleanup passed.

`ProjectCurveBodyFactory` was verified through the public stdio MCP interface.
A 10 mm line at Z=20 mm was projected along −Z onto the top face of a
20 × 20 × 10 mm Solid. Plasticity preserved the source and created a separate
Wire with exact native B-Rep bounds X=5…15, Y=10, Z=10 mm. The adapter
normalizes the projection vector and exposes bidirectional, occlusion and
completion controls. Undo removed only the projected Wire, Redo restored it,
and final cleanup returned the disposable document to its empty baseline.

`ImprintCurveBodyFactory` was verified through the public stdio MCP interface.
A preserved Ø6 mm source Wire projected along world −Z split the top face of a
20 × 20 × 5 mm Solid. Exact topology changed from six faces and twelve edges to
seven faces and thirteen edges; the new closed edge measured 18.851450815 mm,
consistent with the native projected circle. Undo/Redo and cleanup passed.

`ImprintBodyBodyFactory` was verified through the public stdio MCP interface.
A preserved Ø6 cylinder crossing the top of a 20 × 20 × 5 mm box split the
target from six faces/twelve edges to seven faces/thirteen edges. The new exact
intersection edge measured 18.849555922 mm, both bodies kept their stable IDs,
and both passed native `Check()` as closed printable Solids. Undo restored the
target's 6/12 topology, Redo restored 7/13, and cleanup passed.

`ProjectBodyBodyFactory`, `ProjectCurveCurveFactory`, and `IsoparamFactory`
were verified through one guarded public stdio MCP acceptance on 2026-09-22.
`plasticity_create_body_intersection_curves` preserved a 20 × 20 × 5 mm box
and a crossing Ø6 cylinder, then created two independent closed Wires at Z=0
and Z=5 mm. Their exact native bounds were [7,7,Z]…[13,13,Z] mm and each native
curve length was 18.849555922 mm. One Undo removed both result Wires and Redo
restored them.

`plasticity_project_curve_pair` preserved two open orthogonal sketch Wires and
used explicit +Z and +Y projection directions with a 1000 mm bidirectional
depth. Their temporary extrusion surfaces produced one independent two-segment
3D Wire through [30,−5,0], [40,5,5], and [50,−5,0] mm. Native B-Rep endpoints,
bounds, one-step history, Undo, and Redo all matched the public contract.

`plasticity_insert_isoparam_edges` split the cylindrical face of a stable Ø10 ×
20 mm Solid with three V-isoparams. The result had six faces and five edges;
the inserted circles lay at Z=5, 10, and 15 mm and each measured
31.415926235 mm. All four side faces remained analytical R5 Cylinders, bounds
remained [75,−5,0]…[85,5,20] mm, and native `Check()` still reported a closed
printable Solid. Plasticity's native mass-properties call returned
1570.796326795 mm³ before the split and 1570.374188775 mm³ after it. This
0.422138020 mm³ integration change is recorded as a Plasticity 26.1.3
limitation; the adapter does not claim volume invariance from isoparam
insertion. Undo/Redo and complete cleanup passed. Sanitized evidence is at
`[local acceptance artifact omitted]`.

`RebuildFaceFactory` and `RebuildFaceCommand` were verified through the public
stdio MCP on 2026-09-23. Refit mode with projected edges replaced the top Plane
of a 20 × 10 × 5 mm Solid with an untrimmed degree-3/3 BSurf having one span in
each direction and a 4×4 control net. The stable body ID, six-face closed shell,
1,000 mm³ volume, clean native `Check()`, and `printableSolid=true` were
preserved. With a requested 0.01 mm refit tolerance, the maximum exact bounds
change was 0.000005 mm. One-step Undo/Redo restored the analytic Plane and
rebuilt BSurf. The public contract still treats tolerance as an approximation
input and requires post-operation measurement rather than claiming a proven
global deviation bound.

`MatchFaceFactory` and `MatchFaceCommand` were verified through the public
stdio MCP on 2026-09-23. A planar side face of a separate 18 × 10 × 10 mm
Solid was replaced by the exact R20 carrier surface of a cylindrical reference
body. Plasticity extended the four adjacent planar faces to the Cylinder,
preserved the edited body's stable ID, and left the replacement body and its
exact 12,566.370614359173 mm³ volume unchanged. The source volume increased
from 1,800 to 1,978.966857120168 mm³. The result remained a closed native-valid
printable Solid. The operation occupied one history step, Undo/Redo restored the
Plane/Cylinder versions, and cleanup returned the initial empty document. The
public tool invalidates all prior topology references and requires callers to
verify the resulting bounds, mass properties, interference, and validity.

`plasticity_inspect_surface_structure`, `RaiseDegreeFaceFactory`, and
`UntrimFactory` were verified through a guarded public stdio MCP acceptance.
The read-only inspector reported native carrier type, trim state,
face and natural UV ranges, and compact BSurf structure. The constrained source
was degree 3/3 with 3/2 spans and a 6×5 control net. One degree-elevation step
produced degree 4/4, 5/3 spans, and a 9×7 control net with the same stable Sheet
ID; Undo/Redo passed. Its exact bounds changed by 1.685845916 mm, so the public
contract explicitly treats this Plasticity 26.1.3 command as shape-changing.

The same source was split at X=10 mm into two valid trimmed Sheets. Untrimming
one half restored the full natural UV range and the original exact bounds
[-2.180085686, -2.070088988, -0.348472176]…
[22.298409083, 21.241913760, 9.863817222] mm while preserving its stable body
ID. The overlapping second half remained in the scene for validation. One-step
history, Undo/Redo, native `Check()`, journal synchronization, and complete
cleanup passed. Sanitized evidence for the combined face match, face rebuild,
and surface-refinement run is at
`[local acceptance artifact omitted]`.

`CapHolesInSheetFactory` and `PatchHolesInSheetCommand` were verified through
the public stdio MCP interface. After deleting the top face of a
20 × 10 × 5 mm Solid, `plasticity_cap_sheet_holes` filled every planar opening
of the resulting five-face Sheet in one history entry. Plasticity promoted the
same stable body back to a Solid with exact 20 × 10 × 5 mm bounds, six faces,
twelve edges, no boundary edges, and no native `Check()` diagnostics. Undo
restored the open Sheet, Redo restored the Solid, and cleanup returned the
disposable document to its empty baseline.

`RemoveFilletsFromShellFactory` was verified through the public stdio MCP
interface. Four vertical R2 blends changed a 20 × 20 × 10 mm box from six
faces/twelve edges to ten faces/twenty-four edges. `plasticity_remove_fillets`
removed all four recognized cylindrical blend faces in one history entry and
restored the exact original bounds and 6/12 topology. Native `Check()` returned
no diagnostics, the result remained a closed printable Solid, Undo restored
the four R2 faces, Redo removed them again, and cleanup passed.

`SpiralFactory` was verified as Plasticity 26.1.3's native helix constructor.
The public `plasticity_create_helix` tool builds a perpendicular radial frame
from two world-space axis points and a reference direction, then supplies a
constant radius, turn count, and winding sense. Four right- and left-hand turns
at radius 5 mm over a 20 mm axis both produced exact 10 × 10 × 20 mm B-Rep
bounds and 127.245463559 mm curve length. Their starting X tangents had opposite
signs while both advanced along +Z. Undo/Redo and cleanup passed. Variable
radius through the separate native `spiralPitch` parameter remains unexposed
until its full boundary behavior is verified.

`RefilletFaceFactory` was verified through the public stdio MCP interface on
the four recognized R2 blend faces of a 20 × 20 × 10 mm Solid. A +1 mm delta
changed every exact native blend radius to R3, Undo restored R2, Redo restored
R3, and a subsequent −1 mm delta returned all four faces to R2. The body kept
its exact bounds and 10-face/24-edge topology, native `Check()` returned no
diagnostics, and cleanup passed. The adapter rejects ordinary faces, stale or
duplicate references, and deltas that would make any selected radius nonpositive.

`CreateCurveFromEdgesFactory` was verified through the public stdio MCP
interface. `plasticity_extract_edges` copied the four exact top edges of a
20 × 10 × 5 mm Solid into a separate closed Wire with exact 20 × 10 mm B-Rep
bounds at Z=5 mm. Plasticity generated one selectable Region from that contour,
kept the source Solid unchanged, and recorded the extraction as one reversible
history entry. Undo/Redo and final cleanup passed.

Wire and Sheet orientation are now both observable and controllable. The
read-only `plasticity_list_curve_directions` tool evaluates native edges at
normalized parameters 0 and 1 and returns exact start/end points and unit
tangents. On a 10 mm line, `ReverseCurveFactory` changed the direction from
0→10 mm with +X tangent to 10→0 mm with −X tangent while preserving the edge
entity ID. `ReverseSheetFactory` changed a planar Sheet normal from +Z to −Z.
Both mutations were single history entries with verified Undo/Redo, and the
disposable document was cleaned to its empty baseline.

`UnjoinCurvesFactory` and its separately bound command were verified through
stdio MCP on a closed 10 × 5 mm rectangular polyline. Plasticity replaced the
compound Wire with four independent line Wires whose exact B-Rep spans were
10/5/10/5 mm. Undo restored one Wire, Redo restored four, and cleanup passed.
The paired `JoinCurvesFactory` then rebuilt those four segments into one exact
10 × 5 mm closed Wire and one selectable Region. Undo returned four Wires,
Redo restored the compound Wire and Region, and cleanup passed.

The native `CrossPointDatabase` is also exposed through a bounded read-only
tool. On two perpendicular 20 mm Wire bodies, the adapter excluded Plasticity's
standard-axis cross points and returned exactly one user-curve intersection at
[0, 0, 0] mm, together with both stable body IDs, both body version IDs and
both native edge entity IDs. The response carries the current document token
and revision so it cannot be silently reused after manual edits.

`OffsetRegionFactory` was verified separately from Wire offsetting. The adapter
resolves explicit revision-bound Regions from one `SketchIsland`, supplies that
island through the required `factory.sketch` property and supports one or two
signed millimetre offsets per history operation. A live stdio MCP call offset a
20 × 10 mm rectangle outward by 2 mm, preserved the source Wire and created an
exact −2…22 × −2…12 mm Wire. Undo/Redo and cleanup passed; a native two-distance
probe created both requested offset Wires in the same commit.

`SweepFactory` was verified with an explicit Region and Wire spine through the
public stdio MCP tool. Sweeping a circular Ø4 mm Region along a straight 20 mm
path produced one capped native Solid with exact 4 × 4 × 20 mm B-Rep bounds,
3 faces and 2 edges while preserving both construction Wires. The public tool
also binds the native alignment and corner enums and validates twist, terminal
scale and simplification inputs. Undo/Redo and cleanup passed.

`RegionLoftFactory` was verified through the public stdio MCP interface with
two ordered circular Regions on Z=0 and Z=20 mm. Diameters 10 mm and 4 mm
produced one capped native Solid with exact 10 × 10 × 20 mm B-Rep bounds,
3 faces and 6 edges while preserving both profile Wires. The adapter rejects
profiles from the same sketch island and supports native closed-chain and
simplification flags. Undo/Redo and cleanup passed.

The same public loft tool now binds `RegionLoftFactory.guides` to explicit
current Wire bodies and exposes the native `trimGuides` flag. A guarded stdio
run connected Ø10 mm and Ø4 mm circular Regions 20 mm apart while a three-point
NURBS guide bowed outward. The resulting capped Solid had two planar caps, one
`BSurf` side, six edges and an exact maximum X of 12.571977 mm, beyond the
5 mm and 2 mm profile radii; this proves the guide shaped the native result.
Undo removed the Solid, Redo restored it, and cleanup returned the document to
its empty baseline. Guides are required to be distinct current Wires and must
not reuse a profile Wire; profile intersection feasibility remains a native
kernel check.

`CurveLoftFactory` under `LoftEdgeCommand` was verified separately through the
public `plasticity_loft_curves` tool. It accepts ordered current Wire profiles,
optional current Wire guides, native profile and guide trimming, simplification,
open or closed sequencing, the `Natural`, `Unconstrained`, and `Clamped`
curvature enum, and positive dimensionless start/end magnitudes. The adapter
forces `join=false`, preserves every source Wire, and returns one independent
native Sheet. Closed sequencing requires at least three profiles; guide IDs
cannot reuse a profile and native intersection feasibility remains a kernel
check.

The guarded stdio acceptance on 2026-09-23 first lofted two 20 mm Line profiles
through a spatial NURBS guide with clamped curvature and dimensionless start/end
magnitudes 1.5/0.75. Exact B-Rep read-back returned a native-valid
nonplanar one-face/four-edge `BSurf` Sheet bounded by
[0,0,0]–[20,10.179077037396247,20] mm with the guide represented by a boundary
`BCurve`. A second call closed a sequence of three Line profiles and produced a
native-valid one-face/three-edge `BSurf` Sheet with a closed profile sequence bounded by
[50,-3.9180581244561212,-0.69035593728849]–
[70,9.999999999999998,20.69035593728849] mm. Both operations occupied one
history step, preserved every profile and guide, and restored the same result
ID after Undo/Redo. Cleanup matched the initial empty snapshot and the journal
remained in sync. Sanitized evidence is at
`[local acceptance artifact omitted]`.

`FaceLoftFactory` with `LoftSurfaceCommand` was verified through the public
`plasticity_loft_faces` tool. It consumes ordered exact planar face references
from different current Solid or Sheet bodies, preserves every source, and
creates one independent capped Solid. Optional current Wire guides use the same
native loft-guide contract. The public tool exposes native `Natural`,
`Unconstrained`, and `Clamped` end conditions plus positive dimensionless end
magnitudes; those values control shape and are not millimeter distances.

The guarded stdio acceptance on 2026-09-23 connected a 20 × 10 mm face at Z=5
mm to a centered 10 × 5 mm face at Z=20 mm with natural end conditions. Exact
B-Rep read-back returned one native-valid six-face/twelve-edge Solid bounded by
[240,0,5]–[260,10,20] mm, with only Plane faces and Line edges. Native mass
properties returned volume 1750.0000000000014 mm³, area 943.3780142849956 mm²,
and centroid [250,5,12.5] mm. Both source Solids remained unchanged; one-step
Undo/Redo restored the same result ID, the journal stayed in sync, and final
cleanup matched the empty snapshot. Sanitized evidence is at
`[local acceptance artifact omitted]`.

`PipeFactory` was verified for solid and hollow circular sections. Through the
public stdio MCP tool, a 20 mm Wire and 4 mm diameter produced an exact
4 × 4 × 20 mm native Solid with 3 faces and 2 edges; Undo/Redo and cleanup
passed. A direct native hollow probe used the same 4 mm inner diameter and a
1 mm wall. Its end topology reported exact Ø4 and Ø6 circles. The offset outer
surface makes the whole-body `FindBox()` conservative, so hollow-pipe acceptance
must use native end-edge radii or end-face bounds rather than that global box.

The existing `CurveFactory` was also verified in native `CurveType.NURBS`
mode through stdio MCP. Four interpolation points produced one smooth Wire;
the exact native endpoints were [0, 0, 0] and [30, 0, 0] mm, and the measured
curve bounds showed the expected smooth Y overshoot. Undo/Redo and cleanup
passed.

`PatchRegionFactory` was verified through the public stdio MCP interface. A
circular Region of diameter 20 mm produced a separate native Sheet with exact
B-Rep bounds from −10 to 10 mm in X and Y, one planar face and one circular
edge while preserving the source Wire. Undo removed only the Sheet, Redo
restored it, and cleanup returned the document to its empty baseline.

`JoinSheetsFactory` was verified through stdio MCP with two perpendicular
10 × 10 mm planar Sheets sharing one exact edge. One native operation replaced
them with a single Sheet whose exact B-Rep bounds were 10 × 10 × 10 mm and
whose topology contained two planar faces and seven edges. Undo restored two
separate Sheets, Redo restored the joined Sheet, and cleanup passed.

`BridgeSurfaceWithPreviewFactory` was verified through the public stdio MCP
interface with two separate perpendicular planar Sheets. Revision-bound face
references and millimetre pick points selected the intended boundary sides;
the native G2 bridge used a 20 mm width and softness 1, trimmed both source
faces and replaced them with one editable Sheet. Exact B-Rep read-back reported
three faces, ten edges and one non-planar `BSurf` face spanning the transition.
Undo restored the two input Sheets, Redo restored the bridged Sheet, and five
cleanup Undo operations returned the disposable document to its empty baseline.
The native width controls transition extent and feasibility rather than a
single guaranteed output measurement, so callers must inspect the returned
face bounds and topology.

`ConstrainedSurfaceFactory` was verified through stdio MCP with four 3D
millimetre points and four unit-normal constraints. Plasticity created one
native `BSurf` Sheet with one face and four edges; the adapter read its exact
B-Rep bounds back rather than echoing the input points. The tool exposes the
native fitting tolerance, angular tolerance and performance/smoothness mode.
Undo/Redo and cleanup passed.

`CreateSheetFromFacesFactory` was verified through stdio MCP by extracting the
top face of a 20 × 10 × 5 mm Solid. Plasticity preserved the source Solid and
created a separate one-face, four-edge planar Sheet with exact B-Rep bounds
20 × 10 mm at Z=5 mm. Undo removed only the extracted Sheet, Redo restored it,
and cleanup passed.

`UnjoinFacesFactory` was verified through stdio MCP on a Sheet made from two
perpendicular 10 × 10 mm faces sharing one edge. Detaching one selected exact
face produced two independent one-face, four-edge Sheets. Undo restored the
two-face, seven-edge joined shell, Redo separated it again, and cleanup passed.

`UnjoinShellsFactory` under `UnjoinShellsCommand` was verified as a complete
body explosion rather than a separation of only disconnected volume shells. A
40 × 30 × 20 mm closed hollow Solid with a 2 mm wall, 12 faces, 24 edges,
exact volume 9024 mm³ and surface area 9056 mm² was replaced by twelve
independent one-face, four-edge Sheets. The returned planes matched the six
outer coordinates X=120/160, Y=0/30, Z=0/20 mm and six inner coordinates
X=122/158, Y=2/28, Z=2/18 mm. Every result passed native `Check()`, had four
boundary edges, and was correctly marked `printableSolid=false`. One result
reused the source stable ID; therefore the public tool invalidates all previous
body and topology references. The operation occupied one history step,
Undo/Redo restored the exact source and the same twelve result IDs, and cleanup
returned the empty scene with an in-sync journal. Evidence is in
`[local acceptance artifact omitted]`.

`CreateSolidFromFacesFactory` was verified on a closed six-face Sheet copied
from a 20 × 10 × 5 mm box. It created a separate native Solid with the same
exact B-Rep bounds, six faces and twelve edges while preserving the source
Sheet. Undo removed the new Solid, Redo restored it, and cleanup passed.

`DeleteFaceFactory` and its native command binding were verified through stdio
MCP by removing the top face from a 20 × 10 × 5 mm Solid. The edited body became
an open native Sheet with five planar faces and twelve edges. Undo restored the
closed Solid, Redo restored the open Sheet, and cleanup passed.

`DissolveFaceFactory` and its separately bound native command were verified by
removing the temporary internal face boundary created by a Ø6 mm circular
imprint on a 20 × 20 × 5 mm Solid. Exact topology returned from seven faces and
thirteen edges to six faces and twelve edges without opening the body. Undo
restored 7/13, Redo restored 6/12, and cleanup passed.

`PatchHoleInSheetFactory` was verified through stdio MCP on the same open box.
The adapter accepted the four exact boundary-edge IDs, filled the missing top
face and returned a closed 20 × 10 × 5 mm Solid with six planar faces and twelve
edges. Undo restored the open Sheet, Redo restored the Solid, and cleanup
passed.

`ExtendSheetFactory` was verified through stdio MCP with its linear,
distance-based mode. Extending the right boundary of a planar 10 × 10 mm Sheet
by 5 mm changed its exact B-Rep bounds to 15 × 10 mm while retaining one face
and four edges. Undo restored 10 × 10 mm, Redo restored 15 × 10 mm, and cleanup
passed.

Native body validation was verified through the public stdio MCP interface.
The C3D `SolidBody.Check()` result for a 20 × 10 × 5 mm box contained no
diagnostic codes, and exact face adjacency found no boundary edges, so the
adapter reported `printableSolid=true`. Deleting the top face kept native
`Check()` clean but produced a Sheet with four exact boundary edges; the adapter
therefore reported `closed=false` and `printableSolid=false`. The acceptance
run restored the disposable document to its original empty history state.

The same validator was exercised on a revolved countersink in Plasticity
26.1.3. Its periodic conical face reports one seam adjacency through the public
topology wrapper even though the body is a native Solid and `SolidBody.Check()`
returns no diagnostic codes. Solid closure therefore follows native body type
plus `Check()`; the boundary-edge heuristic remains limited to Sheets. The
accepted fastener-pocket run produced a printable Solid with an exact Ø10.4 ×
90° countersink, Ø5.5 bore, and an 8 mm across-flats blind hex pocket.

The guarded fastener-pocket run was extended on 2026-09-22 with the dedicated
`plasticity_create_through_hole` recipe. It cut a separate Ø5.5 mm bore through
an 8 mm plate using one native Cylinder and one Boolean difference. Exact B-Rep
read-back found one R2.75 cylindrical face spanning the full plate thickness
and its two Ø5.5 circular edges. Undo removed the hole and Redo restored it.
The same stdio run confirmed that a fixed M5 request excludes a slot while an
explicit adjustable M5 request includes the slot recipe. Full cleanup restored
the empty document. Sanitized evidence is at
`[local acceptance artifact omitted]`.

`plasticity_create_slotted_hole_pattern` extends this to 2–64 equal adjustable
fasteners at explicit centers. One real stdio MCP call cut two 20 × 6 mm slots
through a 50 × 40 × 8 mm plate using two preserved center Wires, two Extrudes,
four R3 cylinders, and one final Boolean. Exact B-Rep returned four R3 end
walls, four straight walls, and eight 14 mm straight edges. Native validation
reported a closed printable Solid with 14 faces, 36 edges, no boundary edges,
and no `Check()` codes. Nine Undo/Redo calls passed and cleanup restored the
empty document. The designation resolver chose this grouped recipe for two
adjustable M5 bolts. A diagnostic run with one semicircular end exactly tangent
to the plate exterior reproduced `PK_BODY_boolean_2` code 21653 even through
the already verified single-slot recipe; moving the centers inward with
positive edge distance removed the degeneracy. Sanitized passing evidence is
at `[local acceptance artifact omitted]`.

The guarded fastener-group run now uses
`plasticity_create_through_hole_pattern` for the resolved phrase
`крепится на 4 болта ISO 4017 M5x10 класса 8.8 с гайками`. One stdio MCP call
created four Ø6 mm holes at explicit entry centers with four native Cylinder
steps and one final Boolean difference. Exact B-Rep read-back confirmed every
center, axis and diameter; the returned faces then drove native fastener-group
inspection and the CAD-bound load-distribution check. Five Undo steps, Redo,
stale-reference rejection, and empty-document cleanup passed. Sanitized
evidence is at
`[local acceptance artifact omitted]`.

The same guarded scenario was repeated with the read-only
`plasticity_measure_fastener_grip_stack` and
`plasticity_check_fastener_stack` MCP tools. The first tool measured the plate
as an exact 8 mm native B-Rep layer from two selected planar faces at the
current revision. For the resolved M5×10 fastener, that layer plus an explicit
4 mm nut and 1.6 mm minimum protrusion produced an exact 13.6 mm minimum
nominal length, a −3.6 mm margin and `FASTENER_TOO_SHORT`. No nut, washer,
engagement or head dimensions came from the M designation. The native
four-hole recipe, group load verification, stale-reference gate and cleanup
then passed unchanged. Sanitized evidence is at
`[local acceptance artifact omitted]`.

The guarded run was extended again with `plasticity_create_blind_hole`. A
qualified Ø4.2 mm cutter produced a 5 mm deep flat-bottom hole in an 8 mm plate
using one native Cylinder and one Boolean difference. Exact B-Rep read-back
found one R2.1 cylindrical wall, two Ø4.2 circular edges, and one planar floor
at the expected 3 mm remaining-wall coordinate. Native body validation, Undo,
Redo, resolver routing for a tapped-metal M5 request, the default combined
strength/geometry intent with a three-question `strength-basis` package, and
empty-scene cleanup all passed. Sanitized evidence is at
`[local acceptance artifact omitted]`.

The same guarded run verified a 20 × 6 mm straight through-slot in an 8 mm
plate. Its exact B-Rep contained two R3 cylindrical end faces centred 14 mm
apart, two planar side walls, and four 14 mm straight boundary edges. The
source Wire remained editable, native `Check()` returned no diagnostics,
Undo/Redo restored the target topology, and cleanup returned the original
empty document. Plasticity's `SlotFactory` was also probed read-only, but a
detached world-space Wire produced `No basis found`; the public recipe therefore
uses explicit native Region extrusion, Cylinder cutters, and one Boolean rather
than relying on undocumented sketch-basis state.

The advanced native probe read face centers, oriented normals, surface classes,
radii and adjacency directly from Parasolid entities. Edge probes returned
native lengths, tangents, curve classes, vertices and adjacent faces. A semantic
query selected the four 40 mm vertical edges of a test box, a saved selection
became unresolved after Undo, and the same query resolved again after Redo.
The construction journal remained synchronized with all three revisions.
Workbench schema 7 adds persistent, revision-checked construction-journal
checkpoints so the exact inputs and uncertain outcomes survive MCP restarts.

Three additional 26.1.3 factories passed live mutation and Undo checks. A
5 mm face offset changed a 40 mm box height to 45 mm. An inward 2 mm
`HollowFacesFactory` operation created an open 11-face shell while preserving
the 100 × 80 × 40 mm outside bounds. `MirrorFactory` copied a body across an
explicit world plane to the calculated 1500–1600 mm X interval. Plasticity's
equal-distance chamfer mode was verified through `FilletShellFactory`: a 2 mm
chamfer on all 12 edges of a disposable 20 mm cube produced a 26-face,
48-edge native solid with unchanged exact 20 × 20 × 20 mm bounds. Two Undo
operations removed the chamfer and its probe body, restoring the original
single-body scene.

The separate native `HollowSolidsFactory` and `HollowSolidsCommand` were
verified through the public `plasticity_hollow_solids` tool on 2026-09-22. An
inward 2 mm operation converted a 100 × 80 × 40 mm box into a fully enclosed
12-face, 24-edge Solid in one history step while preserving the outside bounds.
Exact opposing planar-face measurements returned six 2 mm walls and a
96 × 76 × 36 mm cavity. Native mass properties returned 57,344 mm³ of material,
57,376 mm² of surface, and centroid [50,40,20] mm. Native `Check()` returned no
diagnostics; Undo restored the original 320,000 mm³ six-face box, Redo restored
the closed shell, and cleanup returned the document to its initial empty state.
Sanitized evidence is at
`[local acceptance artifact omitted]`.

## Native body silhouettes on explicit construction planes

Plasticity 26.1.3 exposes separate `CreateOutlineFromShellsFactory` and
`ProjectOutlineFromShellsFactory` entry points. The public
`plasticity_create_body_outlines` tool accepts only current Solid or Sheet IDs,
requires an explicit revision-bound construction plane, preserves every source
body, and groups the operation into one native history step. Source placement
keeps the resulting silhouette at the source geometry; workplane placement
projects it onto the selected plane. The selected plane is activated in the
same native call so the result does not depend on an unreported UI workplane.

The guarded public stdio acceptance on 2026-09-22 created a 20 × 10 × 5 mm
Solid spanning Z=10…15 mm. Source placement returned one closed four-segment
Wire at Z=10 mm; workplane placement returned a second closed Wire at Z=0 on
the explicit Top plane. Exact native curve inspection measured 10/20/10/20 mm
segments for both Wires, and each produced a selectable Region. The original
Solid retained its exact 1,000 mm³ volume and bounds. Both operations occupied
one history step and passed Undo/Redo. Cleanup restored the empty document,
the initial active workplane, and an in-sync construction journal. Sanitized
evidence is at
`[local acceptance artifact omitted]`.

## Native curve pattern

`CurveArrayFactory` was verified through the public
`plasticity_curve_pattern` tool on Plasticity 26.1.3. The tool accepts current
Solid or Sheet source bodies, one current Wire spine, and a total count from 2
to 1000. It preserves the spine, creates independent B-Rep bodies with
`shouldMakeInstances=false`, distributes them over the full path, and commits
the pattern as one native history step. The verified native default rotates
copies along a curved path.

The guarded stdio acceptance created an asymmetric 10 × 4 × 2 mm source Solid
and a NURBS spine through [0,0,0], [50,50,0], and [100,0,0] mm. A count of five
produced five closed, printable native Solids with no linked instances. Exact
mass properties returned 80 mm³ for every body and 400 mm³ total; ordered
centroids included [0,0,1], [49.999975,50,1], and [100,0,1] mm, with the two
inner positions symmetric about X=50 mm. The spine kept its stable body ID,
Undo restored the single source and spine, Redo restored all five bodies, and
cleanup returned the document to its initial empty state with an in-sync
journal. Sanitized evidence is at
`[local acceptance artifact omitted]`.

`RevolveFactory` was then verified with a separate planar Wire profile. A
10 mm thick rectangle, offset 10–20 mm from a world-space Z axis and revolved
through 360 degrees, produced one native 4-face, 8-edge Solid with exact
40 × 40 × 30 mm B-Rep bounds. The public tool accepts an axis origin in
millimetres, a normalized world direction, and a positive angle up to 360
degrees. Undo removed the revolved solid and the disposable profile, again
restoring the original single-body scene.

`DraftFaceFactory` was verified through the public MCP tool with four side
faces of a 20 mm cube and its bottom face as the neutral reference. A positive
5 degree draft preserved the exact 20 mm height and expanded both horizontal
spans to 23.499546541 mm, matching `20 + 2 × 20 × tan(5°)`. The result remained
a native 6-face, 12-edge Solid. Undo removed the draft and disposable cube and
restored the original scene.

`ThickenSheetFactory` was verified on a native Sheet produced by extruding a
closed 10 × 10 mm Wire through 20 mm. Symmetric 1 mm front and back distances
produced a native 16-face, 32-edge Solid with exact 12 × 12 × 20 mm bounds.
The tool also supports one-sided thickening by setting either distance to
zero. Three Undo operations removed the thickening, Sheet extrusion and Wire,
restoring the original single-body scene.

Native rectangular and radial array factories also passed MCP acceptance. A
three-item rectangular pattern produced exact X minima at 4000, 4010 and
4020 mm for a 10 mm pitch. A four-item 360° radial pattern produced four
bodies around the requested Z axis. Each array was one Plasticity history
operation, Undo restored the source body, and the follow-up Undo removed the
probe body; the final scene and construction journal were synchronized.

The native `MultiCutFactory` was then exposed as
`plasticity_cut_with_faces`. A disposable 100 × 80 × 40 mm solid was cut by a
planar face at its 20 mm midpoint. Plasticity produced two exact native solids
of 100 × 80 × 20 mm in one history operation while preserving the cutter
body. MCP Undo removed the cut and both setup bodies, restoring the original
single-body scene.

The same public tool was later accepted through a real stdio MCP client on an
open Sheet. A planar 20 × 10 mm target at Z=0 was cut by a preserved vertical
Sheet face at X=8 mm. Plasticity returned two exact planar Sheets with bounds
0…8 × 0…10 mm and 8…20 × 0…10 mm. Deleting the latter left the requested
8 × 10 mm trimmed Sheet. Undo restored both parts, a second Undo restored the
uncut target, and Redo recreated the two parts. Cut and Delete are deliberately
separate history operations. Final cleanup returned the disposable document to
zero bodies and Regions. The MCP now rejects empty, duplicate, stale,
non-shell, nonplanar, and target-overlapping references before mutation.

Plasticity 26.1.3 also exposes its native `BasicMaterialDatabase` through the
editor. The public MCP appearance tools use the document's default
`PhysicalMaterial` as a base, set only a bounded color, roughness, metalness
and opacity, add the named material to the document, and assign its numeric ID
through `db.nodes.setMaterial`. A real stdio run assigned `Probe blue` with
`#3366cc`, roughness 0.42, metalness 0.1 and opacity 0.8 to a disposable Solid.
The runtime read back material ID 1 and all four values. One Undo removed both
the assignment and catalog entry, and Redo restored both; cleanup returned the
document to zero bodies and Regions. Body material IDs and the catalog now
participate in revision and scene-diff tracking. They remain display metadata
and are explicitly excluded from manufacturing and strength evidence.

Plasticity's native `DimensionBlockCommand` and `DimensionBlockFactory` were
also exercised through the public stdio MCP. The adapter asks Plasticity to
derive a `DimensionCollection` from one selected current Solid and requires
the collection's native `HasBlock()` result before editing. A disposable
10 × 20 × 30 mm block was changed to local dimensions 15 × 25 × 35 mm in one
history operation. Exact B-Rep bounds measured those three sizes without
reusing the inputs. Undo restored 10 × 20 × 30 mm and Redo restored
15 × 25 × 35 mm; final cleanup returned to zero bodies and Regions. The
operation is a centered direct edit of a recognized primitive. It is not stored
as a persistent dimensional constraint, and modified solids that Plasticity no
longer recognizes as blocks are rejected.

The same guarded path was verified for `DimensionRadiusCommand` and
`DimensionRadiusFactory`. A current cylindrical face on an exact R5 × 20 mm
Solid was selected by its revision-bound B-Rep face ID and changed to R7.
Plasticity returned exact bounds −7…7 mm on both radial axes while preserving
the 20 mm height. One Undo restored R5 and Redo restored R7; cleanup again
returned to zero bodies and Regions. The public tool accepts only a current
face reported as `Cylinder`; fillet radii remain under the separate refillet
operation.

`DimensionRectangleCommand` and `DimensionRectangleFactory` were verified on a
closed planar Wire with one Region. Starting from an exact 20 × 10 mm profile,
native width 15 mm and native length 25 mm produced an exact 25 × 15 mm Wire
around the unchanged center, and the Region remained available. Undo restored
20 × 10 mm and Redo restored 25 × 15 mm. The adapter requires a current closed
Wire participating in a Region and then requires native `HasRectangle()`;
arbitrary closed profiles are not coerced into rectangles.

On 2026-09-24 inspection of Plasticity 26.1.3 confirmed that
`DimensionDistanceFactory` and `DimensionDistanceCommand` are exported. The
factory prototype exposes `calculate`, `selection`, and a readable/writable
`distance`; its executable implementation is hidden by the packaged renderer.
The native command was then probed with (1) both endpoints of an open 10 mm
Wire, (2) the two opposite 20 mm segments of a rectangular Wire, and (3) the
two opposed planar X faces of a 20 × 10 × 8 mm Solid. All three returned
`Operation has no effect`; the guarded `DimensionFactory.collection` setter
was not reached, and no probe call changed geometry or history. The document
setup and cleanup ran in a task-owned test profile; after Plasticity restored
the scratch document, its three test bodies were removed through the public
MCP and the active document was verified empty. No public MCP operation is
advertised from this binding until an accepted topology and its exact
geometry read-back and Undo/Redo behavior are proven.

Exact topology measurements were then verified through the public stdio MCP.
The runtime collects unique native vertices from each body's edges and reads
their positions through `Vertex.GetPoint()`; vertex entity IDs are exposed only
with their body and current document revision. On a disposable 20 × 10 × 5 mm
Solid, the adapter returned eight vertices and measured the opposite-corner
distance as 22.9128784747792 mm. Two opposite planar faces returned 20 mm
separation and 0° plane angle. Two parallel X edges at opposite corners of the
Y/Z section returned 11.180339887498949 mm between their infinite supporting
lines and 0° line angle. These results were calculated from native B-Rep points,
normals and tangents rather than viewport bounds. Final Undo cleanup returned
the document to zero bodies and Regions.

Persistent point-to-point dimensions were verified separately through the
public stdio MCP on 2026-09-22. The adapter resolves two current B-Rep vertex
IDs to Plasticity `Snaps_ShellVertexSnap` objects, builds a native
`DistanceMeasurement`, and commits it within `MeasureDistanceCommand`. On a
20 × 10 × 5 mm Solid, the stored `Box diagonal` measurement was read back from
Plasticity's measurement repository as 22.9128784747792 mm with the original
body and topology targets. Creation occupied one history step; Undo removed it
and Redo restored it. Deletion delegates to Plasticity's native
`RemoveMeasurementCommand` after selecting the exact measurement; that action
also passed Undo/Redo as one history step. The final cleanup returned to zero
bodies, Regions, and measurements. The macOS session was locked during this
run, so Chromium `Page.captureScreenshot` did not return even for an empty
document; visual rendering of the label is therefore not claimed by this
evidence.

The persistent distance path was extended on 2026-09-23 to exact edge
midpoints and face centers through the same native `PointToPointMeasurementFactory`.
On a disposable 20 × 10 × 5 mm Solid, Plasticity stored 5 mm between the
centers of the two Z faces and 7.0710678118654755 mm between the bottom-face
center and the midpoint of a top edge. The runtime resolved native landmark
targets back to their current public `faceId` and `edgeId`; one Undo removed
only the second measurement and Redo restored its stable ID. Final cleanup
returned to zero bodies, Regions, and measurements. Evidence is stored at
`[local acceptance artifact omitted]`.

The read-only `plasticity_measure_linear_edges` tool now also reports the
closest points and minimum distance between the two finite straight-edge
centerline segments, while preserving `supportingLineDistanceMm` for their
infinite extensions. It derives each segment from Plasticity's native B-Rep
midpoint, tangent and exact edge length, then solves the clamped segment-to-
segment problem (including parallel and endpoint cases). Synthetic unit cases
cover intersecting supporting lines whose finite segments are separated. A
read-only public stdio MCP call on the active Plasticity 26.1.3 Solid returned
the same exact shared endpoint for two intersecting edges and left document
revision and Undo/Redo unchanged. This is edge-centerline distance only; it is
not a minimum distance between the owning faces or solids. Evidence:
`[local acceptance artifact omitted]`.

The new read-only `plasticity_measure_point_to_linear_edge` operation measures
a supplied coordinate or current B-Rep vertex against a finite linear edge
centerline. It returns both the unbounded supporting-line projection and the
clamped closest point on the segment, with each distance and the normalized
unclamped edge parameter. The operation rejects non-linear edges and stale
revisions. Unit tests cover interior projection, endpoint clamping, B-Rep
vertices, arcs and stale references. Live public MCP returned a 2 mm offset
from a 10 mm native line edge and left the active document/history unchanged.
This is not clearance to the owning Solid's surface. Evidence:
`[local acceptance artifact omitted]`.

The read-only `plasticity_measure_point_to_planar_face` tool measures a point
against the actual trim of a planar face bounded by polygonal loops and
complete circular loops, including holes. It projects the point into the face
plane, applies an even-odd fill rule across those exact boundaries, and
otherwise returns the nearest finite line or circular boundary point. Circle
metadata and coplanarity are validated from native B-Rep data. Other curved
boundaries, malformed arcs, incomplete endpoint topology, non-coplanar boundary
geometry, non-planar faces and stale revisions are rejected rather than
approximated. Unit tests cover face interior, exterior, polygon and circular
holes, valid and invalid partial circular boundaries and an open polygon loop; MCP forwarding
tests verify the public tool contract. Live public stdio MCP on Plasticity
26.1.3 measured 3 mm from [5,5,13] to a four-edge planar B-Rep face at
[5,5,10]. A live circular-trim face is not available in the current document,
so that case is unit-tested only. A second state read confirmed that the live
operation left revision, Undo/Redo and the body set unchanged. This is
point-to-trimmed-face distance, not pairwise body clearance. Evidence:
`[local acceptance artifact omitted]`.

The same measurement was subsequently exercised on a live native circular
trim through the production stdio MCP. Plasticity reported the full circular
edge with exact radius 2 mm, length `4π` mm and no endpoint vertices; the
adapter accepts this native `vertexIds=[]` topology. For a 20 × 20 × 5 mm
plate with a centered Ø4 mm through-hole, a point 2 mm above the hole center
was 2.828427 mm from the trimmed face, with closest point [12,10,5] mm on the
circular B-Rep edge. A point 2 mm above the face interior measured 2 mm. Reads
left revision and Undo depth unchanged, Boolean Undo/Redo restored the stable
Solid ID, and cleanup returned the new test window to its empty scene
snapshot. Repeatable acceptance:
`npm run accept:native-point-planar-circular-face -- --target ID --allow-disposable-mutations --output NEW_DIRECTORY`.
Evidence: `[local acceptance artifact omitted]`.

The face-boundary implementation also supports mixed loops of straight edges
and exact trimmed circular arcs. It reconstructs the closed loop from native
endpoint topology, validates each arc against the circle's start/mid/end data,
and evaluates ray crossings on the analytic arc rather than a tessellated
polygon. Unit coverage includes a rounded-square contour and an outside point
whose closest point lies on a quarter-circle. Production stdio MCP acceptance
on Plasticity 26.1.3 built a 20 × 20 × 5 mm plate with four R2 vertical-edge
fillets. Plasticity returned four exact top-face lines and four trimmed Circle
edges (each radius 2 mm and length π mm). The point [0,0,5] measured
0.828427 mm to the exact rounded boundary at [0.585786,0.585786,5]. Undo
cleanup restored the isolated test window to its empty baseline. Evidence:
`[local acceptance artifact omitted]`.

The read-only `plasticity_measure_point_to_circular_edge` operation measures a
point against full analytic circles or finite circular trims. Solid/Sheet
boundaries use current `edgeId`; Wire circles/arcs use the current
`segmentEntityId` from `plasticity_list_curve_directions`. The runtime reads
the native circle basis and exact start/mid/end samples, verifies them against
the circle, and uses the midpoint to distinguish minor from major arcs and
clockwise from counterclockwise trims. It returns support-circle and
finite-trim distances, the closest point and a normalized trim parameter only
when radial projection falls within that trim. Unit tests cover a semicircle,
a 270° clockwise arc, a full circle, endpoint clamping, missing native circle
data and stale revision; MCP tests verify both reference forms. Production
stdio MCP acceptance on Plasticity 26.1.3 created an R10 native Wire circle.
For point [10,0,2], it returned 2 mm to both the supporting circle and finite
circle, with closest point [10,0,0], full-circle semantics and no endpoint
clamp. It also analyzed that same segment's curvature as 0.1 1/mm. Read-only
measurements preserved revision and history; Undo/Redo and cleanup restored
the test document's empty snapshot. Evidence:
`[local acceptance artifact omitted]`.

Native viewport sectioning was verified on 2026-09-23 through
`SectionDatabase.add(ConstructionPlaneSnap)`. A plane at Z=5 mm with +Z as the
clipped half-space received stable analysis ID 3 and was read back with the
same origin and normal. Creation and removal left the B-Rep revision and Undo
depth unchanged, while scene snapshots reported the section state separately
from geometry. Removing the ID restored the prior view state and final cleanup
returned to an empty document. Chromium screenshot capture timed out in the
locked macOS session and is explicitly recorded as unavailable rather than as
visual evidence. The remaining native proof is stored at
`[local acceptance artifact omitted]`.

On 2026-09-24, the production `plasticity_screenshot` path was changed to use
CDP `Page.startScreencast` because `Page.captureScreenshot` still timed out.
The first MCP attempt wrote a 2800 × 2048 PNG, but byte-identical frames before
and after test geometry plus `document.hidden=true` showed it was stale. That
artifact is not visual evidence. Production now rejects hidden renderers before
saving a frame. The live acceptance correctly produced no PNG and recorded
`Plasticity window is hidden` at
`[local acceptance artifact omitted]`.
Successful capture of a visible window and rendering MCP-created geometry
remain unverified until the Plasticity window is active.

The manufacturing end-to-end run exposed and fixed a real adapter mismatch:
Creality Print 7.2.1 rejects STEP on its CLI even though STEP is a valid
editable Workbench model. Plasticity's native `STLExportFactory` now writes a
separate millimeter-scaled binary STL, validates its triangle table, and never
overwrites a file. The verified plate produced 476 triangles at 0.05 mm chord
tolerance. Creality Print then produced a ready 40-layer G-code job with exact
80 × 40 × 8 mm toolpath bounds, 11.64 g filament estimate and 1116 s time
estimate. It remained local until the user approved the exact immutable job in
the browser; slicing alone did not upload or start anything.

The user then approved that exact immutable job in the Workbench. A live K1C
submission exposed a stock-firmware incompatibility: Creality's `nexusp`
service returned HTTP 500 for otherwise valid multipart uploads to
`/server/files/upload`. Each uncertain attempt was reconciled read-only; the
printer remained in `standby` and the exact file was absent before another
attempt was allowed. Inspection of the installed Creality Print 7.2.1 client
showed that K1-family devices use the vendor endpoint
`http://<printer>/upload/<filename>` with a single
`application/octet-stream` file part, then start that filename through
Moonraker. The adapter now follows that contract and uses a short deterministic
ASCII filename for localized project titles.

The approved G-code with SHA-256
`9c113a5c8615e340e825a4e23e9072cded11c81512149f163d772762a354ae09`
was uploaded as `80-40-8-e815d11e-9c113a5c8615.gcode`. The K1C file list
reported 425,768 bytes and `print_stats` reported that exact filename in
`printing` state. Moonraker history subsequently recorded job `000005` with
status `completed`, the same filename, 40 layers, 8 mm object height,
1169.37 s print duration, 1359.88 s total duration and 3915.11 mm of filament.
The printer then returned to `standby` with both heater targets at zero. This
verifies the complete approval, upload, start and terminal-success path. Visual
surface and dimensional inspection of the cooled physical part remains an
operator check.

## Safety and recovery

- Discovery and WebSocket connections accept only unauthenticated loopback URLs.
- A per-window process lock rejects competing MCP owners.
- Mutations are serialized.
- Document revision tokens include document identity, database version,
  history depth, and stable/version ID pairs.
- Mutations reject stale revisions.
- A timeout or connection loss marks the result uncertain. No retry or
  automatic Undo occurs before reconciliation.
- Save, export, backup, and screenshots refuse to overwrite existing files.
- No public tool accepts arbitrary JavaScript.

## Workbench evidence

The companion Workbench now persists projects and immutable STEP versions in
SQLite, exposes revision-checked HTTP and MCP publication APIs, serves one
responsive desktop/tablet application, and converts STEP display meshes in a
dedicated browser worker. Automated checks cover process crashes without turn
replay, revision conflicts, project isolation, pairing expiry, event replay,
invalid STEP meshes, previous-version retention, pressure-aware ink, and stale
annotation attachment.

The production build includes `occt-import-js` 0.0.23 and its 7.6 MB WASM
asset. This mesh is explicitly labeled approximate; native Plasticity B-Rep
measurements remain the acceptance source. A one-command loopback smoke run
returned HTTP 200 for `/api/health` and `/`, created a project, and issued a
one-time annotate pairing URL. The previously exported real 80 × 40 × 8 mm
two-hole plate was uploaded as a Workbench version. Chromium loaded the emitted
OCCT worker and WASM, rendered the `Technical plate` body without console or
page errors, and captured
`.plasticity-mcp/result/workbench-live-step.png`. The one-time URL was then
opened on the user's physical tablet over the same Wi-Fi network. The server
observed its exchange for a project-scoped `annotate` session, and the user
confirmed the tablet mechanism. A real pen stroke was submitted back to the
project with its sampled points, pressure, camera matrices, viewport and world
anchor; it persisted as an exact annotation on model version 1 and advanced the
project revision from 3 to 4. Cosmetic tablet layout work is intentionally
deferred to the final UI/UX pass.

The LGPL-2.1 dependency review is also complete. Vite copies
`workbench/public/THIRD_PARTY_NOTICES.txt` into every production build, and the
running LAN service returned that notice at `/THIRD_PARTY_NOTICES.txt`. It
identifies `occt-import-js` 0.0.23, the included Open CASCADE code, their
licenses, the pinned upstream source locations, and the replacement-compatible
WebAssembly boundary. `npm audit` with production dependencies and again with
development dependencies both reported zero vulnerabilities.

A later live browser audit found that `crypto.randomUUID()` is unavailable in
the non-secure private-IP browser context. Camera and worker correlation IDs
now use a local RFC 4122 UUID generator, after which the same STEP loaded in
the Codex browser. Named perspective/orthographic views, fit, Z section,
visibility and transparency controls were exercised against that model. The
Workbench service was then terminated and restarted; project revision 3, the
model version, exact measurement table, failed diagnostic slice and ready
G-code job all reloaded from SQLite unchanged.

Reference records now persist their source class, URL, artifact hash, license,
scene role and per-dimension confidence. The browser renders these records as
tables and highlights critical `measurement-required` rows. Manufacturing
profiles can be copied into an immutable registry with hashes of the machine,
process and filament JSON files. A live loopback run migrated a fresh database,
discovered the installed Creality K1C preset, registered a draft alternate
profile, and returned the copied paths and all three SHA-256 values. OrcaSlicer
and Bambu Studio were not present on this Mac and remain unavailable rather
than being advertised without a live probe.

A named-product workflow was previously used as an exploratory smoke test. It
is not a project CAD target or an acceptance criterion; product-specific
geometry and its local artifact are outside the MCP implementation scope.

## Exact arbitrary-plane sections

Plasticity 26.1.3 exposes `CutFactory`, `kernel_Sheet`, `kernel_Solid`,
`cplane2basis` and `Vector3` in the renderer's native command scope. The MCP
uses them to measure a section without adding a command to document history:

1. clone the selected checked `SolidBody`;
2. create a rectangular native Sheet on the normalized requested plane;
3. build both objects with fresh temporary version and stable IDs;
4. add them to `TemporaryGeometryDatabase` and call
   `CutFactory.calculate(factory.partition)`;
5. collect exact line/circle edges from one oriented set of coplanar cut faces;
6. cancel the factory, remove temporary views, then remove only the cloned
   Solid and Sheet from their kernel collections.

Using the persistent Solid by reference was rejected during live development:
the first cut could change its native object without changing the document
revision or history. Reusing temporary view identities was also rejected
because the renderer could return a previous cutting-plane view. The released
path therefore clones the body, assigns fresh identities on every call and
compares the complete persistent body descriptors before and after collection.

The guarded stdio acceptance on 2026-09-21 measured a 20 × 10 × 5 mm box. At
z=2.5 mm it returned A=200 mm², Ixx=1666.666666666667 mm⁴ and
Iyy=6666.666666666668 mm⁴. A plane through [10,5,2.5] with normal [0,1,1]
returned A=141.4213562373095 mm², Ixx=589.25565098879 mm⁴ and
Iyy=4714.045207910318 mm⁴. Document token, revision, undo/redo depths and the
full body descriptors were identical after each read. The disposable Solid was
then undone and the document was empty.

## Native linked instances

Plasticity 26.1.3 exposes `CreateInstanceFactory`,
`MoveItemAndEmptyFactory`, `RotateItemAndEmptyFactory`,
`ProjectingScaleItemAndEmptyFactory`, and `RealizeInstanceFactory`. Instances
live in the native empty database rather than the geometry model. The adapter
reads the empty snapshot, resolves its `targetKey` back to current stable body
IDs, and returns the complete world matrix with millimetre translation
components plus its translation, quaternion, and scale decomposition. Instance
IDs start at zero and remain bound to the
current document revision.

Transform factories mutate an `InstanceEmpty` in place. Calling them directly
inside a normal command advances Plasticity's history but leaves the before
memento pointing at the same mutated object, so Undo changes stack depth
without restoring the matrix. The accepted path obtains the empty database's
copy-on-write state, clones the selected native empty while preserving its
version ID, target key, and kind, replaces that entry, and transforms the copy.
The previous and next history mementos then hold distinct objects, and native
Undo/Redo restores the expected matrices.

A direct `DuplicateCommand` is not exposed for ordinary body copying. A guarded
probe created the expected duplicate but then waited for interactive placement
until the CDP request timed out, making the write outcome uncertain. The public
`plasticity_duplicate_bodies` path instead groups `CreateInstanceFactory`, an
optional `MoveItemAndEmptyFactory`, and `RealizeInstanceFactory` inside one
`GroupSelectedCommand`. It therefore accepts explicit world-space placement,
preserves every source, produces ordinary independent Solid/Sheet B-Reps, leaves
no instance records, and occupies one native history entry.

The public stdio acceptance created a linked instance of a 20 × 10 × 5 mm
Solid at X=30 mm, moved it to X=35 mm, rotated it 90 degrees around Z, and
applied a world-X scale of two. Create, Move, Rotate, Scale, Delete, and Realize
each occupied one history entry. Undo/Redo passed for Scale, Delete, and
Realize. Realizing the restored X=30 mm instance produced an independent exact
B-Rep Solid bounded by X=30…50, Y=0…10, and Z=0…5 mm while preserving the
source. Final cleanup returned the disposable document to zero bodies,
instances, Regions, and measurements.

The same guarded stdio run then duplicated both independent 20 × 10 × 5 mm
Solids together by [0,30,0] mm. Plasticity returned new stable IDs 1154 and
1155 with exact bounds [0,30,0]…[20,40,5] and
[30,30,0]…[50,40,5]. Both passed native `Check()` as closed printable
Solids, no linked instance remained, the operation used one Undo step, and
Undo/Redo restored the same IDs. The run also copied an extracted one-face native
Sheet from Z=5 mm to Z=25 mm. Source ID 1156 and copy ID 1157 both had
one face, four boundary edges, clean native `Check()` results, and
`printableSolid=false`; Sheet-copy Undo/Redo restored ID 1157. Evidence is in
`[local acceptance artifact omitted]`.

## Native assembly groups and node state

Plasticity 26.1.3 exposes `GroupSelectedCommand`,
`MoveSelectionToGroupCommand`, and `DissolveGroupCommand` through its renderer.
The native group database supplies a stable group ID, current active group,
parent lookup, and a snapshot whose group IDs and direct child node keys form
the scene tree. Geometry bodies and `InstanceEmpty` records are mapped back
from those node keys to their public revision-bound IDs. The root group has ID
0 and is returned as `Scene`; it is readable and may receive moved children,
but the MCP refuses to rename, nest, or dissolve it.

Group creation and every hierarchy edit run inside Plasticity's command
history. Names must be assigned inside the same command transaction: assigning
them after `exec()` advances the document outside the stored memento and can
lose the name on Undo. Visibility and lock state use the native node database
inside the same transaction. Runtime state includes these flags for bodies,
instances, and groups, and group hierarchy contributes to the document
revision so stale references are rejected after manual or agent changes.
`ActivateGroupCommand` changes the native active creation destination in one
history step; ID 0 restores the root `Scene` group.
The selection database exposes bodies, `InstanceEmpty` records, groups, faces,
and edges as separate collections. The MCP maps those values to stable body,
instance, group, and revision-bound topology IDs in both directions. An agent
can therefore read a user's manual selection and highlight the same assembly
nodes, exact surfaces, or exact boundaries without changing document history.
Plasticity leaves a `GroupSelectedCommand` promise unresolved if a face or edge
remains selected while a custom node-only history transaction runs. The
adapter resolves all target nodes first, clears the topology selection, and
then starts rename, visibility, lock, or appearance transactions. This avoids
an uncertain timeout after Plasticity has already applied the edit.

Exact planar placement uses the source and target B-Rep face centers and
oriented normals already exposed by the adapter. `RotateItemAndEmptyFactory`
and `MoveItemAndEmptyFactory` share one `GroupSelectedCommand` resource, so a
set of bodies receives one rigid rotation and translation in a single history
step. The target body is excluded from the moving set. `opposed` maps the
source outward normal to the negative target normal; `same` maps it to the
target normal. A signed gap offsets the destination center along the target's
outward normal. The shortest normal-to-normal rotation does not independently
constrain in-plane roll. This is a direct placement and does not create a
persistent mate or constraint.

Exact vertex placement uses a source and target B-Rep vertex already exposed
by the adapter and applies one `MoveItemAndEmptyFactory` translation to the
complete moving body set. An explicit world-space offset remains visible in
the public request instead of being inferred from a view or selection.

Exact straight-edge placement uses the midpoint and tangent of two native
`Line` edges. `RotateItemAndEmptyFactory` maps the source tangent to the same
or opposed target tangent, `MoveItemAndEmptyFactory` maps its midpoint to the
target midpoint plus a signed target-tangent offset, and an optional final
rotation sets roll around the fixed line. These factories share one
`GroupSelectedCommand`, so the placement occupies one history step. The
renderer also exposes classes named `AlignEdgeFactory` and
`AlignVertexFactory`, but read-only inspection showed surface/curve
continuity machinery with additional hidden state; those names alone were
not treated as a verified rigid-assembly contract.

Exact cylindrical placement reads the native origin and direction published by
each `Cylinder` face. It uses the same grouped rotate/move factories as planar
placement and may add a final rotation around the fixed target axis within the
same command transaction. `preserve` projects the origin-to-origin vector onto
the plane normal to the target axis and translates by that transverse component
only. `anchor` instead moves the source axis origin to the target origin plus a
signed axial offset. These modes let an agent seat a part on a plane and then
make its hole coaxial without losing the seating depth, or deliberately place a
bolt, pin, bushing, or hinge barrel at a known axial datum. The operation does
not create a persistent concentric constraint.

The guarded public stdio acceptance created a 20 × 10 × 5 mm bracket, a linked
copy, and a 30 × 20 × 8 mm housing body. It grouped the bracket and instance,
created a separate housing group, round-tripped a mixed node selection and an
exact face and edge, aligned a vertical bracket face to the horizontal housing
face with a 2 mm gap while moving a companion body rigidly, nested and renamed
the bracket group, hid the housing body, locked the instance, and dissolved the nested group so its
contents were promoted to the housing. Create Group, Move to Group, Rename,
Alignment, Visibility, Lock, and Dissolve each occupied one native history step. Activating
the housing also occupied one step, passed Undo/Redo, and caused a subsequently
created Solid to become its direct member. Undo and Redo passed for nesting,
rename, visibility, lock, and dissolve. Exact B-Rep bounds remained unchanged,
and cleanup restored the original empty document with only the root `Scene`
group. The same run also aligned a cylinder and a rigid companion body in
`preserve` mode, then aligned the cylinder in `anchor` mode with a 2 mm offset.
Each call occupied one history step and passed Undo/Redo. Sanitized evidence is
at `[local acceptance artifact omitted]`.
The same run placed a source vertex at [130, 20, 7] mm from a target vertex at
[130, 20, 5] mm plus a 2 mm Z offset. It then mapped a 20 mm source Line to a
fixed 30 mm Line with a 3 mm signed axial offset and 30° roll; exact B-Rep read
back the source midpoint [220, 42, 10] mm and tangent −Y. Both calls occupied
one history step, passed Undo/Redo, and left their fixed bodies unchanged.
Plasticity changed the moved edge ID from `2327e216785` to `2331e216785`,
which confirms that clients must discard revision-bound topology references
after a geometric mutation and use the returned state.

## Exact volumetric interference

The native binary contains `BodyCollection::Clash`, `ClashOptions`, and
`Eval::Collisions`, but Plasticity 26.1.3 does not export their constructors in
the renderer scope used by this adapter. The renderer does expose
`BooleanFactory` and `kernel_Solid`. The implemented read path therefore clones
each explicit pair of current Solid bodies, gives the clones fresh version and
stable IDs, adds them to a separate `TemporaryGeometryDatabase`, and evaluates
native Boolean intersection with `keepTools=false`. It never executes a
Plasticity document command or commits the temporary result.

A successful nonempty intersection returns its exact `SolidBody.FindBox()`
bounds in millimetres, face count, and `SolidBody.Check()` codes. Plasticity
reports `Operation has no effect` both when bodies only touch and when they are
separated, so the public result is deliberately named
`no-volumetric-interference`. It does not claim positive clearance or minimum
distance. Exact face and edge measurements remain necessary for a specified
mating gap. Other native failures and invalid intersection bodies return a
bounded `unsupported` result instead of geometry evidence.

A read-only live API inventory on Plasticity 26.1.3 (2026-09-25) confirmed the
renderer-bound `Face`, `Edge`, and `Surface` prototypes expose point evaluation
and `FindPointNear`, but no direct face-to-face or body-to-body minimum-distance
method. The renderer also exposes a native `sourceTargetClosestApproach`
binding, but its contract is not discoverable from the exported function and
calling it with two adjacent Face objects returned no candidates. This is not
evidence of minimum-clearance behavior, so the binding is not used by the MCP.
The adapter also exposes `plasticity_measure_parallel_planar_face_clearance`
for strictly parallel planar faces with closed polygonal trims, complete
circles, and exact trimmed circular arcs (including nested loops and holes). It
derives exact finite-region overlap or boundary distance from current native
B-Rep vertices, edges and circle geometry, then combines that in-plane distance
with the plane gap. Unit cases cover line-line, line-arc and arc-arc minimum
distances, arc tangency, containment, and circular holes. Live checks returned
1000 mm between the parallel top and bottom faces of the disposable startup
cube, then measured the same pair after cutting a circular through-hole; Undo
restored the original Solid and bounds. Other curved boundaries, nonparallel
faces and incomplete topology remain explicitly unsupported. This is not a
general curved-surface or body-to-body clearance algorithm. Sanitized evidence:
`[local acceptance artifact omitted]` and
`[local acceptance artifact omitted]`.
The production stdio acceptance also filleted two disposable 20 × 20 × 5 mm
plates to R2 and measured their exact mixed line/arc top-face trims. The native
minimum in-plane clearance was 4.4852813742 mm, with both closest points on
native trimmed circular arcs; read-only revision stability and Undo/Redo were
verified. Evidence:
`[local acceptance artifact omitted]`.

Nonparallel planar face clearance is a separate public tool,
`plasticity_measure_nonparallel_planar_polygon_clearance`. It triangulates the
exact native straight-edged loops of each planar face using even-odd filling;
concave outlines, holes and multiple disjoint regions are supported. It checks
triangle intersections, vertex-to-face projections, and finite edge pairs,
with a limit of 512 boundary vertices and 4,096 decomposition triangles per
face. A
Real stdio MCP acceptance on Plasticity 26.1.3 returned zero for intersecting
oblique face regions, 4.3397459622 mm for a separated rotated pair, and 0.5 mm
for a vertical face crossing a square through-hole. The first two matched the
analytical closest points within 0.01 mm; the live through-hole was made by a
native Boolean subtraction. It rejects parallel planes, circular or curved
boundaries, self-intersecting or touching loops, and incomplete topology. This
remains a selected-face measurement, not a whole-body clearance or collision
check.
Evidence:
`[local acceptance artifact omitted]` and
`[local acceptance artifact omitted]`.

The guarded stdio acceptance on 2026-09-22 used four disposable 10 mm cubes.
The overlapping pair produced one valid six-face intersection Solid bounded by
[5,0,0]…[10,10,10] mm. A face-touching pair and a separated pair both produced
`no-volumetric-interference`. Document token, revision, undo/redo depths, and
the complete persistent body descriptors were identical before and after the
three checks. Undo cleanup restored the original empty document. Sanitized
evidence is at
`[local acceptance artifact omitted]`.

## Exact Solid volume, area, and centroid

Plasticity 26.1.3 exposes a unique native `BodyCollection` for a current Solid
through the renderer database. `BodyCollection.EvaluateMassProperties()`
returns the body's volume in m³ and surface area in m²; `GetCentroid()` returns
the volume centroid in model metres. The adapter converts those results once to
mm³, mm², and millimetres, checks `SolidBody.Check()`, and rejects the result if
the document, revision, history, or persistent body descriptors change while
the read is in progress. It does not use the render mesh or a bounding box.

The guarded public stdio acceptance on 2026-09-22 created a disposable
20 × 10 × 5 mm Solid at [10,20,30] mm. The MCP returned 1000 mm³, 700 mm²,
and volume centroid [20,25,32.5] mm with an empty native check-code list.
Document token, revision, Undo/Redo depth, and body descriptors remained
unchanged during measurement; Undo cleanup restored the original empty
document. No mass was returned because no physical density was supplied.
Sanitized evidence is at
`[local acceptance artifact omitted]`.

## Matched printable rounded threads

Plasticity 26.1.3 does not expose a `ThreadFactory` in the renderer used by the
adapter. It does expose native `SpiralFactory`, `PipeFactory`, and Boolean
operations. The implemented `rounded-print-v1` recipe therefore builds a
one-start exact B-Rep profile from a cylindrical core or bore, a native Helix,
a circular Pipe ridge or groove, and native Booleans. An external thread is
intersected with an exact crest cylinder so its requested diameter and length
remain explicit. The internal side enlarges the base bore and circular groove
by a supplied normal profile clearance. Source Helices and hex-profile Wires
remain in the document.

The guarded stdio acceptance on 2026-09-22 called
`plasticity_create_printed_hex_pair` once with the phrase `M5x8`, an explicit
custom 1.25 mm pitch, 0.6 mm thread depth, and 0.15 mm normal clearance. The
tool used the designation only for the 5 mm crest diameter and 8 mm thread
length, created a hex screw with a 9 mm across-flats and 3 mm high head, and
created a matching 9 mm-across-flats, 8 mm-thick nut. The returned result
recorded the synthetic K1C, PLA, slicing-profile, orientation, clearance, and
sizing basis and contained all 15 confirmed native history steps. Exact B-Rep
inspection found screw Cylinder radii 1.9 and 2.5 mm and the nut bore radius
2.05 mm. The
screw had 15 faces and 36 edges; the nut had 10 faces and 24 edges. Both were
closed printable Solids with empty native `Check()` code lists.

After an explicit 0.5 mm axial phase alignment, native temporary Boolean
intersection returned `no-volumetric-interference`. Rotating the nut 90 degrees
around the common axis produced exact volumetric interference; Undo restored
the interference-free indexed pose. The journal remained in sync and cleanup
restored the initial empty scene. Sanitized evidence for the single-call pair
is at `[local acceptance artifact omitted]`.

This evidence validates the native construction and one indexed assembly pose.
It does not prove continuous screw travel, torque, strength, wear, or the
clearance achieved by a physical printer/material/profile/orientation. The
profile is deliberately identified as a custom matched rounded print profile,
not ISO metric hardware. Physical use requires a qualified clearance or a
calibration specimen plus configuration-matched stripping and screw-tension
capacity evidence.

## Exact native rectangle creation

Plasticity 26.1.3 exposes `ThreePointRectangleFactory` and
`ThreePointRectangleCommand` in the renderer used by the adapter. The public
`plasticity_create_rectangle` tool derives three exact corner points from a
center, width, height, plane frame, and optional in-plane angle. It accepts a
world-space normal plus X direction or a revision-bound saved construction
plane. Parallel world axes and mixed coordinate forms are rejected before the
native transaction.

The guarded public stdio acceptance on 2026-09-22 created a 40 × 20 mm
rectangle centered at [10,20,30] mm on a plane normal to [1,1,1], with a 30°
in-plane rotation. Native B-Rep curve inspection returned one closed Wire with
four line lengths 20/40/20/40 mm and one associated Region. Creation occupied
one history step; Undo removed both objects, Redo restored the exact curve, and
final Undo returned the document to its initial empty state. Sanitized evidence
is at `[local acceptance artifact omitted]`.

## Native curve-vertex filleting

Plasticity 26.1.3 exposes `FilletVertexFactory` and
`FilletVertexCommand`. The public `plasticity_list_curve_vertices` tool reads
each exact Wire vertex from native B-Rep and returns its native vertex ID,
position, endpoint flag, adjacent edge entity IDs, and revision-bound body
reference. `plasticity_fillet_curve_vertices` rejects open endpoints and
vertices without exactly two adjacent segments before starting the native
transaction. It converts the requested radius from millimetres to model metres
and applies every selected corner in one Plasticity history command.

The guarded public stdio acceptance on 2026-09-22 selected all four vertices of
a 40 × 20 mm rectangle and filleted them with R3. Exact B-Rep inspection after
the command returned eight vertices, four straight segments of 34/34/14/14 mm,
and four quarter-circle arcs of 4.71238898038469 mm. The Wire remained closed,
its Region remained available, and the edit occupied one history step. Undo
restored four segments, Redo restored eight, and cleanup returned the document
to its initial empty state. Sanitized evidence is at
`[local acceptance artifact omitted]`.

## Native text outlines

Plasticity 26.1.3 exposes `TextFactory`, the Inter font, and the native body
transform factories. `plasticity_create_text` commits the text outlines, applies
their planar orientation and baseline translation, and assigns optional names
inside one Plasticity command. The public size is converted once from
millimetres to model metres. It remains a nominal font size: glyph bounds are
measured from the resulting native curves.

The guarded public stdio acceptance on 2026-09-22 created `M5` at baseline
[20,30,40] mm on the plane X=20 mm. Plasticity returned two named closed Wires,
two associated Regions, and 45 exact B-Rep segments. Their combined measured
envelope was Y=31.22…49.89 mm and Z=39.86…50.10 mm, or 18.67 × 10.24 mm, for a
nominal 10 mm font size. Creation and placement occupied one history step; Undo
removed the outlines, Redo restored their identities and geometry, and final
Undo restored the initial empty document. Sanitized evidence is at
`[local acceptance artifact omitted]`.

## Native circle and circular-arc construction

Plasticity 26.1.3 exposes `KnifeTwoPointCircleFactory` for diameter-defined
circles, `KnifeThreePointCircleFactory` for circles through three points,
`KnifeCenterPointArcFactory` for center-defined and ordered three-point arcs,
`TangentArcFactory` for continuing an existing native Wire segment, and
`TangentCircleFactory` for a fixed-radius circle tangent to two exact native
segments. The public tools accept millimetres, bind plane-local inputs to current
construction-plane identities, reject degenerate or stale inputs before a
mutation, and keep arbitrary JavaScript outside the MCP interface.
`plasticity_create_tangent_arc` uses the exact segment entity returned by
`plasticity_list_curve_directions`; `startAt` selects its native start or end,
and `flipTangent` selects the other tangent sense.
`plasticity_create_tangent_circle` likewise resolves two revision-bound segment
entities, preserves both source Wires, and uses a solution point only to choose
among possible center neighborhoods. Its public radius is converted from
millimetres once, and stale or duplicate segment references are rejected before
the native command starts.

The guarded public stdio acceptance on 2026-09-22 first created a Ø20 mm circle
from diameter endpoints [110,0,0] and [130,0,0], then a second Ø20 mm circle
through [160,0,0], [150,10,0], and [140,0,0]. Exact B-Rep reported 20 × 20 mm
bounds and circumference 62.83185307179587/62.83185307179583 mm; each was one
closed curve with a native Region. The same run verified a three-point major
arc of R10 and 270° from [90,0,0] through [80,-10,0] to [80,10,0], with length
47.12388980384687 mm and bounds [70,-10,0]–[90,10,0]. From a preserved 20 mm
straight Wire, the tangent factory produced a 90° minor arc of length
15.707963267948978 mm with start tangent +X and the complementary 270° arc of
length 47.12388980384687 mm with start tangent −X. Their closed pair produced a
native Region. A follow-up guarded stdio run on 2026-09-23 used perpendicular
40 mm line segments and created an R5 circle in their positive-X/positive-Y
quadrant. Exact B-Rep returned bounds [100,100,0]–[110,110,0] mm and
circumference 31.415926535897935 mm. Plasticity's native intersection database
reported the two tangencies at [105,100,0] and [100,105,0] mm while preserving
the source Wires. Thirteen Undo and Redo operations restored the empty scene and
all 13 Wires/seven Regions respectively; final cleanup matched the initial
snapshot. Sanitized evidence is at
`[local acceptance artifact omitted]`.

## Native Curve Bridge continuity

Plasticity 26.1.3 exposes `BridgeCurveFactory`, `BridgeCurveCommand`, and the
native `ContinuityType` values used for G0 through G3. The public
`plasticity_bridge_curves` tool resolves both exact Wire segment entities at the
current revision, selects either native parameter endpoint, disables source
trimming, and creates one independent B-Spline in one history operation. The
source Wires remain available for inspection, later joining, or recovery.

The guarded public stdio acceptance on 2026-09-22 created four transitions
between pairs of straight source Wires. Exact B-Rep inspection returned degree
1/3/5/7 and 2/4/6/8 control points for G0/G1/G2/G3 respectively. Every curve
had one span and exact requested endpoints. G1 through G3 matched the +X source
tangent at both ends; G0 was the direct diagonal. Four Undo operations removed
only the bridges while preserving all eight sources, four Redo operations
restored their native structures, and final cleanup matched the initial empty
snapshot. Sanitized evidence is at
`[local acceptance artifact omitted]`.

`BridgeVertexFactory` and `BridgeVertexCommand` provide the endpoint-specific
Wire form. `plasticity_bridge_curve_vertices` accepts two exact numeric
`vertexId` values returned by `plasticity_list_curve_vertices`, requires both to
be current open endpoints, and rejects internal, stale, coincident, or non-Wire
references before mutation. It preserves both source Wires and creates one
independent B-Spline in one history operation.

The guarded public stdio acceptance on 2026-09-23 selected endpoints at
[10,120,0] and [20,130,0] mm. A G2/G2 call returned one degree-5 BCurve with six
control points, one span, length 16.419665974002182 mm, and +X tangents at both
ends. Exact native B-Rep read-back, one-step Undo/Redo, source preservation, and
full cleanup passed.

Plasticity 26.1.3 also exposes `BridgeEdgeFactory` and `BridgeEdgeCommand` for
starting a transition from Solid or Sheet edges. The public
`plasticity_bridge_shell_edges` tool requires each revision-current edge plus
one of its exact endpoint vertex IDs. It validates those document identities
before mutation, then maps the selected endpoints onto the transient topology
owned by the native factory by position; the factory deliberately assigns new
vertex IDs to those internal copies. Both source bodies are preserved and the
result is one independent Wire in one history operation.

The guarded public stdio acceptance on 2026-09-23 selected two vertical Solid
edges and their explicit endpoints at [10,160,10] and [30,170,20] mm. A G2/G2
call created one degree-5 BCurve with six control points, one span, length
33.59680690035187 mm, and +Z tangents at both ends. Exact native B-Rep read-back
confirmed the endpoint coordinates within 0.01 mm. Undo removed only the
bridge, Redo restored its structure, and cleanup restored the empty snapshot.
Sanitized evidence for both endpoint-specific Wire and Solid-edge bridges is at
`[local acceptance artifact omitted]`.

## Native B-Spline degree elevation and subdivision

Plasticity 26.1.3 exposes `RaiseDegreeCurveFactory` with
`RaiseDegreeCurveCommand` and `SubdivideCurveFactory` with
`SubdivideCurveCommand`. Both accept current native Wire views and replace them
under stable body identities in one history operation. Degree elevation raises
the polynomial degree by one. Subdivision inserts knots while retaining the
existing degree; neither public tool accepts a target count because the native
commands apply one deterministic refinement step per call.

The guarded public stdio acceptance on 2026-09-22 started with two identical
degree-3, seven-control-point, four-span BCurves. Degree elevation produced
degree 4, 11 control points, seven spans, and retained five distinct knots.
Subdivision produced degree 3, 11 control points, eight spans, and nine distinct
knots. Exact native endpoint, tangent, and length read-back remained within
0.01 mm of each source. Two Undo operations restored both original structures,
two Redo operations restored both refinements, and cleanup matched the initial
empty snapshot. Sanitized evidence is at
`[local acceptance artifact omitted]`.

## Native B-Spline control-point editing

Plasticity 26.1.3 represents the editable poles of an open native B-Spline in
two view collections. The end poles are `CurveVertex` objects in
`Wire.vertices`; the interior poles are `CurveCV` objects in `Wire.cvs`. This
explains why a seven-control-point cubic BCurve exposes two boundary vertices
and five CVs. The public `plasticity_list_curve_control_points` tool preserves
that distinction and returns revision-bound references. Positions are labeled
`native-control-handle` because they come from Plasticity's editor handles;
functional dimensions still require exact B-Rep read-back.
Each handle also exposes the unit `posU` and `negU` directions calculated by a
read-only `MultiSlideControlPointFactory`; for an open control polygon these
represent its local positive and negative parametric directions.

Plasticity's native `Selection` accepts the same objects through `addVertex`
and `addCurveCV`. The public `plasticity_select_curve_control_points` clears the
previous selection and highlights an exact mixed set, while
`plasticity_current_selection` maps a user or agent selection back to the same
revision-bound references. Live read-back of one boundary vertex and one
interior CV matched the requested references and left the document revision and
Undo depth unchanged.

`plasticity_move_curve_control_points`,
`plasticity_slide_curve_control_points`,
`plasticity_rotate_curve_control_points`, and
`plasticity_scale_curve_control_points` resolve those current handles and use
the native `MultiMoveControlPointFactory`, `MultiSlideControlPointFactory`,
`MultiRotateControlPointFactory`, and `MultiScaleControlPointFactory` under
their matching control-point commands. A guarded public stdio acceptance on
2026-09-22 slid the second interior point 5 mm along its returned positive-U
unit vector, then moved the first boundary vertex
and the third interior control point together by [0,10,5] mm, rotated the first
interior point 90° around world Z, and scaled the fifth around the world origin
by [2,0.5,1]. Unselected handle positions were unchanged within 0.01 mm after
each operation. `plasticity_delete_curve_control_points` then used
`DeleteControlPointFactory` under `DeleteControlPointCommand` to remove one
interior point from the current Wire. The remaining CV IDs were reindexed, so
the public contract invalidates every prior handle reference after deletion.
Exact B-Rep read-back moved the curve start from [0,0,0] to [0,10,5] mm,
preserved the end at [60,0,0] mm and both end tangents, and changed the structure
from degree 3 / seven control points / four spans / five distinct knots to degree
3 / six control points / three spans / four knots. Each edit occupied one
history step; five Undo and Redo operations restored the complete initial and
final handle sets and structure, and cleanup matched the initial empty snapshot.
Sanitized evidence is at
`[local acceptance artifact omitted]`.

## Native face transforms

Plasticity 26.1.3 exposes direct multi-face factories for translation,
arbitrary-axis rotation, and basic world-axis surface scaling. The adapter binds
them to `MoveFaceCommand`, `RotateFaceCommand`, and `ScaleFaceCommand` and
resolves every input through the current body and face version IDs before the
native command starts. The public tools never accept arbitrary JavaScript.

A guarded public stdio acceptance on 2026-09-22 moved the top face of a
20 × 10 × 10 mm Solid by [0,0,5] mm. Exact opposed-plane measurement returned
15.000000000000002 mm and the four vertical native edges became 15 mm. A second
Solid had its top face rotated −10° about world Y around [40,0,10] mm. Exact
B-Rep read-back returned normal
[−0.17364817766693033,0,0.984807753012208] and a 9.999999999999972° plane
angle. A third Solid had its cylindrical R5 face scaled by [2,2,1] around its
axis origin; the exact native Cylinder radius and circular-edge length became
10.000000000000009 mm and 62.831853071795926 mm.

Each face edit occupied one Plasticity history step. All three results remained
closed, printable Solids with empty native `Check()` results. Undo and Redo
restored the exact source and result geometry for every transform, and cleanup
matched the initial empty snapshot. Scaling works on the underlying supporting
surface, so an in-plane scale of a Plane that leaves its infinite plane
unchanged may be a no-op; the public prompt requires exact geometry read-back
instead of trusting requested factors. Sanitized evidence is at
`[local acceptance artifact omitted]`.

## Native face-derived construction

Plasticity 26.1.3 exposes three separate surface-construction mechanisms now
kept distinct in the public MCP. `ThickenFaceFactory` under
`ThickenFaceCommand` creates an independent body from selected current faces.
`OffsetFaceLoopFactory` under `OffsetFaceLoopCommand` inserts signed loops into
the existing shell. `PatchHoleInSolidFactory` under
`PatchHoleInSolidCommand` constructs independent Sheet patches from selected
Solid edge loops. The last operation does not alter or fill the source Solid.
Every public input is revision-bound to one source body and accepts no arbitrary
JavaScript or native enum values.

A guarded public stdio acceptance on 2026-09-22 thickened the top face of a
20 × 10 × 5 mm Solid by 2 mm along its normal and 1 mm against it. The source
remained at Z=0…5 mm, while the new six-face, twelve-edge Solid occupied
Z=4…7 mm. Exact native mass properties returned 600.0000000000001 mm³,
580 mm², centroid [10,5,5.5] mm, and no `Check()` errors.

A +2 mm individual face-loop offset on a second 20 × 10 × 5 mm Solid changed
topology from 6 faces/12 edges to 7/16. Exact B-Rep vertices formed the inner
rectangle [42,2,5]…[58,8,5] mm and its edge lengths were 6/6/16/16 mm. Native
volume remained 1000 mm³ and the stable body ID was preserved. A separate
read-only probe also established that −2 mm on the same topological case puts
the split 2 mm down the four adjacent side faces rather than creating the same
inset in the opposite world direction. The public contract therefore requires
topology read-back after either sign.

Finally, one R3 circular rim of a through-hole in a 20 × 20 × 5 mm Solid drove
an independent one-face, one-edge planar Sheet at Z=5 mm. Its exact edge length
was 18.84955592153876 mm. The source retained 7 faces, 14 edges, and exact
volume 1858.6283305884613 mm³ before and after patch creation, proving that the
hole was not silently filled. The source remained a closed printable Solid and
the patch a valid open Sheet with one boundary edge. Each operation occupied
one history step, passed Undo/Redo, and cleanup restored the empty document and
in-sync journal. Sanitized evidence is at
`[local acceptance artifact omitted]`.

The same guarded suite now verifies native analytic-cylinder development through
`UnwrapFactory`. An R10 × 30 mm Cylinder face produced one planar Sheet with
exact B-Rep size 30.00000000005798 × 62.83185307179587 mm and four Line edges
of 30.00000000005798/30.00000000005798/62.83185307179587/62.83185307179587 mm.
The source Solid retained exact volume 9424.77796076938 mm³ and area
2513.2741228718346 mm² before and after the operation. Both bodies returned no
native `Check()` codes; the Solid remained printable and the Sheet remained an
open four-boundary-edge surface. One Undo removed only the Sheet, Redo restored
its stable ID, and cleanup restored the initial empty scene with an in-sync
journal. Sanitized evidence is at
`[local acceptance artifact omitted]`.

The public tool accepts only exact analytic `Cylinder` faces. A separate live
probe of a `Cone` face returned a rectangle based on the smaller circumference,
not an area-preserving development of the conical frustum. Plasticity 26.1.3
therefore has no verified exact conical-flat-pattern contract here, and the MCP
rejects Plane, Cone, BSurf, and other surface types before mutation. The result
is geometric surface unwrapping only; sheet thickness, neutral axis, bend
allowance, springback, kerf, and other manufacturing compensation remain
outside this operation.

As a separate read capability, Plasticity's exact `Cone.GetInfo()` now feeds the
public face descriptor with the native basis origin, normalized axis direction,
and semi-angle in radians. A live stdio MCP acceptance on an R12/R6 × 18 mm
frustum read `[40,0,0]` mm, `[0,0,-1]`, and `0.3217505543966422` rad, matching
`atan((12-6)/18)`. The run exercised Undo/Redo and restored the explicitly
selected empty document. `plasticity_analyze_cone_development` uses that basis
plus the two full native circular boundary edges and straight seam to
calculate an annular sector. For the R12/R6 × 18 mm frustum, the live tool
returned slant length 18.9736659610 mm, inner/outer sector radii
18.9736659610/37.9473319220 mm, and included angle 1.9869176532 rad; the
resulting arc lengths match both native circle circumferences. It is read-only
and does not yet create the planar profile. Pointed cones, partial trims and
extra boundaries remain unsupported. Sanitized evidence:
`[local acceptance artifact omitted]`.

## Native feature-face patterns

Plasticity 26.1.3 exposes `RectangularArrayFacesFactory` with
`RectangularArrayFacesCommand` and `RadialArrayFacesFactory` with
`RadialArrayFacesCommand`. Unlike the existing body-array tools, these factories
repeat a selected feature within the same Solid or Sheet. The public adapter
accepts only current revision-bound faces from one body, normalizes directions,
converts millimeters and degrees once, and commits the whole pattern in one
Plasticity history step. Counts include the source feature. The agent must select
the complete connected feature-face set and re-read all topology after success.

A guarded public stdio acceptance on 2026-09-22 selected the cylindrical wall
and top cap of an R3 × 5 mm boss unioned to a 60 × 30 × 5 mm plate. A three-item
linear pattern at 15 mm spacing produced exact cylinder axes at [10,15,5],
[25,15,5], and [40,15,5] mm. Topology changed from 8 faces/14 edges to 12/18,
and native mass properties returned 9424.11500823462 mm³.

A second R3 × 5 mm boss on a 60 × 60 × 5 mm plate was repeated four times
through 360° around [30,90,0] mm and world Z. Exact axes were [45,90,5],
[30,105,5], [15,90,5], and [30,75,5] mm. Topology changed from 8/14 to 14/20,
and native volume was 18565.48667764616 mm³. Both operations preserved stable
body IDs and names, occupied one history step each, passed `Check()` as closed
printable Solids, passed Undo/Redo, and cleaned back to the initial empty scene
with an in-sync journal. Sanitized evidence is at
`[local acceptance artifact omitted]`.

## Native edge edits

Plasticity 26.1.3 exposes `MoveEdgeFactory`, `OffsetEdgeFactory`, and
`DeleteEdgeFactory`. Their history commands are separate bindings,
`MoveEdgeCommand`, `OffsetEdgeCommand`, and `DeleteEdgeCommand`; they are not
members of `editor.commands`. The adapter therefore resolves all selected edges
from one current shell and instantiates the matching native command directly.
Public MCP callers supply only exact revision-bound edge references and
millimeter values.

A guarded public stdio acceptance on 2026-09-22 moved the top-front edge of a
20 × 10 × 10 mm Solid by [0,0,5] mm. Exact B-Rep read-back returned the moved
20 mm edge at [10,0,15] mm, a tilted top-face normal of
[0,0.44721359549995787,0.8944271909999159], and two connecting edges of
11.180339887498954 mm. The body remained a six-face, twelve-edge closed Solid.

Two more Solids proved signed native edge offset. A +2 mm offset created a
parallel BCurve edge at [50,0,8] mm on the front Y=0 surface; a −2 mm offset
created it at [90,2,10] mm on the top Z=10 surface. Each added two exact 2 mm
fragments and changed topology to seven faces and fifteen edges. The sign is
therefore defined by Plasticity's oriented edge and selected adjacent surface,
not a fixed world axis; the public contract requires exact result read-back.

A fourth Solid received the same +2 mm offset. Deleting its added BCurve split
edge through `DeleteEdgeFactory` healed the two compatible planar faces and
returned the exact six-face, twelve-edge box topology. Undo restored the split
with seven faces and fifteen edges, and Redo healed it again. The tool is
described as removal of compatible split or seam edges because the native
kernel can reject a structural edge rather than silently changing the body.

Each edit occupied one Plasticity history step. All four results were closed,
printable Solids with empty native `Check()` results. Undo and Redo restored the
exact source and result topology for every operation, and cleanup matched the
initial empty snapshot. Sanitized evidence is at
`[local acceptance artifact omitted]`.

## Native shell-vertex offset

Plasticity 26.1.3 exposes `OffsetVertexFactory` and `OffsetVertexCommand`. Its
operation is a topology edit: a positive distance inserts a new native vertex
that far along every edge incident to each selected shell corner. The original
corner and outer geometry remain in place. This is not free vertex movement,
chamfering, or filleting.

Shell vertices differ from persistent face and edge views in this version.
Plasticity's database rejects a synthetic topology lookup with
`shell vertices are yet not supported`, while the native factory needs both the
kernel `Vertex` models and their source-body ownership to replace the original
body. The version-pinned adapter therefore resolves only current
`Snaps_ShellVertexSnap` records, assigns their kernel models through the public
factory setter, and restores the matching `{ parentItem, position }` ownership
records in the factory's private `_vertices.views` collection. The adapter
checks that this 26.1.3 bridge exists before mutation. Arbitrary JavaScript and
these internal objects are never exposed through the MCP schema.

A guarded public stdio acceptance on 2026-09-22 selected opposite corners
[20,10,10] and [0,0,0] of one 20 × 10 × 10 mm Solid and applied a 2 mm native
offset in one history step. Exact B-Rep read-back found the six inserted
vertices [18,10,10], [20,8,10], [20,10,8], [2,0,0], [0,2,0], and [0,0,2] mm.
The original corners remained, topology changed from 6 faces/12 edges/8
vertices to 6 faces/18 edges/14 vertices, and the stable body ID and name were
preserved. Exact native mass properties remained 2000.0000000000002 mm³,
1000 mm², and centroid [10,5,5] mm. The result was a closed printable Solid with
an empty native `Check()` result. Undo and Redo restored both exact topologies,
and cleanup matched the initial empty snapshot. Sanitized evidence is at
`[local acceptance artifact omitted]`.

## Native curve and Region-boundary copies

Plasticity 26.1.3 exposes `CurveDuplicateFactory` and
`CreateCurvesFromRegionsFactory`. Both commit under the native
`DuplicateCommand`; the public adapter keeps the factory objects private and
accepts only current revision-bound Wire or Region IDs.

A guarded stdio acceptance duplicated one cubic BCurve as a separate Wire. The
source stable body ID 1108 remained, the copy received ID 1109, and both had
exact bounds [0,−5.494481585,0]…[40,14.650663482,0] mm. Native inspection
matched degree 3, five control points, two spans, three distinct knots, and
length 64.4311827156 mm. The operation occupied one history step and passed
Undo/Redo.

The same acceptance copied the boundary of a 30 × 20 mm rectangular Region.
The new Wire received its own stable body ID and retained four exact Line
segments of 30/20/30/20 mm, although Plasticity chose a different cyclic start
segment. The source Wire remained intact. The coincident copy caused
Plasticity's automatic Region to be recomputed: source Region ID
`2102r198821` became stale and the current ID was `2106r199108`. The public
tool therefore requires callers to read the returned state or list Regions
again before any downstream operation. Undo restored the prior Region identity,
Redo restored the recomputed identity, and final cleanup matched the initial
empty snapshot with an in-sync journal. Sanitized evidence is at
`[local acceptance artifact omitted]`.

## Native curve planarity and planarization

Plasticity 26.1.3 exposes `WireBody.FindPlanarBasis()` for exact native
planarity classification and `PlanarizeCurveFactory` for orthogonal projection
onto an explicit plane. The factory has no separately exported planarize
command, but commits under Plasticity's native `DeformCurveCommand` and one
history operation. The adapter normalizes the supplied plane normal and keeps
the factory and command fixed behind the public MCP schema.

The guarded public stdio acceptance on 2026-09-22 started with a spatial cubic
BCurve spanning Z=−8.455…12.629 mm. Native planarity was false. Projection onto
the plane through [0,0,5] mm with supplied normal [0,0,2] produced exact bounds
Z=5…5 mm; `FindPlanarBasis()` returned origin Z=5 mm and normal approximately
+Z. Degree 3, seven control points, four spans, and five distinct knots were
preserved while length changed from 170.894768 to 144.218356 mm. Plasticity
reversed the parameter direction but preserved the projected endpoint pair, so
the public contract requires direction read-back. Undo restored the spatial
curve, Redo restored native planarity, and cleanup matched the initial empty
snapshot. Sanitized evidence is at
`[local acceptance artifact omitted]`.

## Native 3MF export

Plasticity 26.1.3 exposes `ThreeMfExportFactory` with the same native B-Rep
tessellation tolerances as its STL exporter. A read-only descriptor probe and
two disposable exports found that assigning `factory.unit = 'millimeter'` does
not change the writer's declared unit: the resulting model still uses
`unit="meter"`. Without a scale, a 20 mm coordinate is therefore serialized as
20 meters. The version-pinned adapter explicitly assigns `factory.scale =
0.001`, passes chord tolerance to both curve and surface tessellation, and
validates the saved package rather than trusting the requested settings.

The validator accepts only bounded, single-disk ZIP packages with safe entry
paths and stored or deflated data. It requires `[Content_Types].xml`,
`_rels/.rels`, and `3D/3dmodel.model`, checks the model relationship and meter
unit, rejects non-finite vertex coordinates, and reports object, build-item,
vertex, triangle, and millimeter-bound counts. Files are copied to the requested
path only after validation and existing paths are never overwritten.

A guarded public stdio acceptance on 2026-09-22 exported one exact native Solid
20 × 10 × 5 mm at 0.05 mm chord and 15 degree angular tolerance. The 1123-byte
3MF contained one build object, eight vertices, and twelve triangles. Its XML
coordinates measured 19.999999552965164 × 9.999999776482582 ×
4.999999888241291 mm, within 0.01 mm of the exact B-Rep. Export left the
document token, revision, body identity, and Undo/Redo depths unchanged. Native
Undo then removed the disposable source body and the final snapshot matched the
initial empty scene. Sanitized evidence is at
`[local acceptance artifact omitted]`.

## Native Parasolid exchange

Plasticity 26.1.3 exposes `ExportCadFactory` for native Parasolid text and
binary export and a separate `ParasolidImportFactory` under `ImportCommand` for
round-trip import. The public tools accept only `.x_t` and `.x_b`, validate the
Parasolid header, resolve current stable body IDs, reject stale revisions, and
never overwrite an existing output file. Export does not enter document
history; import is one native Plasticity history operation.

A guarded public stdio acceptance on 2026-09-23 exported one exact Solid
20 × 10 × 5 mm to a 4,161-byte `.x_t` and a 4,584-byte `.x_b`. Importing each
file produced one exact Solid with the same bounds, six faces, twelve edges, no
native `Check()` codes, `nativeValid=true`, and `printableSolid=true`. Undo
removed the text import, Redo restored the same stable body ID, and final
cleanup restored the initial empty scene. The same live probe found that the
generic export factory rejected IGES and SAT in this installed build, so the
MCP does not advertise those formats. Sanitized evidence is at
`[local acceptance artifact omitted]`.

## Native cone and conical-frustum construction

Plasticity 26.1.3 exposes no separate cone primitive factory. The adapter uses
`CurveFactory` to create a closed meridional triangle or quadrilateral, then
passes the automatically generated `SketchIsland` Region to `RevolveFactory`
for a full turn. The profile Wire and exact capped Solid share one
`RevolveCommand` resource and therefore one history step. Passing the Wire
itself fails when one profile edge lies on the axis with
`PK_ERROR_impossible_spin`; the Region input is the verified native path.

A guarded public stdio acceptance on 2026-09-23 created a pointed cone with
bottom radius 10 mm and height 20 mm, and a separate frustum with radii 12/6 mm
and height 18 mm. Exact B-Rep read-back found `Cone + Plane` and
`Cone + 2 Plane` surfaces, bounds 20 × 20 × 20 mm and 24 × 24 × 18 mm, and
volumes 2,094.3951023931963 mm³ and 4,750.088092227763 mm³. Both bodies were
closed, had no native `Check()` codes, and reported `printableSolid=true`.
Undo/Redo removed and restored each profile/Solid pair as one step with stable
IDs, and final cleanup matched the initial empty snapshot. Sanitized evidence
is at `[local acceptance artifact omitted]`.

For a complete frustum, `plasticity_analyze_cone_development` reads the exact
Cone basis, two full circular B-Rep boundaries, and straight seam. The new
`plasticity_create_cone_development` tool builds the annular sector as an
editable Wire and planar Sheet with two native center arcs, two radial Lines,
one join, and one closed-Wire patch. It compares exact arc and radial edge
lengths, source and Sheet face areas, and native Sheet validity. A guarded MCP
acceptance for R12/R6 × 18 mm returned slant length 18.9736659610 mm, sector
radii 18.9736659610/37.9473319220 mm, included angle 1.9869176532 rad, and
source/Sheet area 1072.935532706 mm². The area difference was approximately
4.6e-13 mm². The source frustum was unchanged; six Undo steps removed the
development and six Redo steps restored the same profile and Sheet IDs and
geometry. Cleanup returned the document to its initially empty scene. The
tool places the inner-arc start at the requested world-XY origin and does not
add sheet-metal bend or fabrication allowances. Evidence:
`[local acceptance artifact omitted]`.

## Native ring-torus construction

Plasticity 26.1.3 does not expose a dedicated CAD `TorusFactory`, but its native
`CenterCircleFactory` and `RevolveFactory` can share one
`RevolveCommand` resource. The adapter creates a circular meridional Wire in
the plane defined by the normalized symmetry axis and projected radial
direction, then revolves it 360 degrees. Both the editable profile and exact
Solid therefore belong to one Plasticity history step. The public contract is
limited to a ring torus: the major radius to the tube centerline must be greater
than the minor tube radius.

A guarded public stdio acceptance on 2026-09-22 created a torus centered at
[10,20,30] mm with major radius 30 mm and minor radius 5 mm. Exact B-Rep
read-back found one `Torus` face and bounds 70 × 70 × 10 mm. Native mass
properties were 14,804.406601634022 mm³ volume, 5,921.762640653611 mm² surface
area, and centroid [10.000000000000002,19.999999999999996,30] mm, matching the
analytical ring-torus values. `SolidBody.Check()` returned no errors and the
body was a closed printable Solid. Profile and Solid were removed and restored
together by one Undo/Redo step with stable IDs; final cleanup matched the
initial empty snapshot. Sanitized evidence is at
`[local acceptance artifact omitted]`.

## Native face-draft analysis

Plasticity 26.1.3 exposes trimmed-face interior sampling through
`Face.EvalGrid`. Each returned native point can be mapped back to the current
face with `Face.FindPointNear`, then evaluated with `Face.EvalNormal`. The
adapter uses the oriented B-Rep normal and defines signed draft relative to an
explicit normalized pull direction as `asin(normal dot pull)`. It does not use
the display mesh.

A guarded public stdio acceptance on 2026-09-23 sampled every face of a native
20 × 10 × 5 mm box and an R5 × 10 mm cylinder with an 8 × 8 request and +Z
pull. At a 2 degree threshold, the box returned one positive cap at +90
degrees, one negative cap at -90 degrees, and four neutral walls at 0 degrees.
The cylinder returned the same two cap classes and its Cylinder wall returned
56 neutral samples at 0 degrees. The read-only analysis left document token,
revision, and Undo/Redo depths unchanged, and final cleanup restored the empty
snapshot. The public result states that a finite normal grid cannot prove
continuous extrema, a mold parting strategy, release, or print support needs.
Sanitized evidence is at
`[local acceptance artifact omitted]`.

## Native selected-face properties

Plasticity 26.1.3 resolves a public revision-bound face ID to a one-item native
`FaceCollection` through `Database.lookupFaceCollection`. Its
`EvaluateMassProperties()` result contains the exact trimmed area and full
boundary length, while `GetCentroid()` returns the area centroid. `Face.Check`,
`GetLoops`, and `GetInnerLoops` supply native validity and explicit trim-loop
counts. This path does not use display-mesh triangles or bounds.

A guarded public stdio acceptance on 2026-09-23 created a 20 × 10 × 5 mm box
and cut a centered 4 mm diameter through-hole. The selected top Plane face
measured `200 - 4π` = 187.43362938564084 mm², boundary length `60 + 4π` =
72.56637061435917 mm, and area centroid [10,5,5] mm. It contained two loops,
including one inner loop, and `Face.Check()` returned no errors. The read-only
call preserved document token, revision, and Undo/Redo depths; native Undo then
restored the initial empty scene. Aggregate boundary length is documented as a
per-face sum, so shared boundaries are deliberately counted once per selected
face. Sanitized evidence is at
`[local acceptance artifact omitted]`.

## Native STL/OBJ reference-mesh import

Plasticity 26.1.3 exposes `MeshImportFactory` under `ImportCommand`. Unlike STEP
and Parasolid import, its result is an `Empties_ObjectEmpty` backed by a Three.js
mesh rather than an editable native B-Rep body. The public MCP therefore keeps
these objects in a separate `referenceMeshes` collection and labels their bounds
and buffer counts with `measurementSource: "reference-mesh"`. Imported meshes
never appear in the exact `bodies` collection and cannot be used as native CAD
measurement or strength evidence.

The source unit is mandatory because STL carries no unit metadata and community
OBJ scale is often ambiguous. The public source-unit enum follows
Plasticity's native length aliases: millimeter, centimeter, meter, inch, and
foot; the live acceptance below covers millimeter and inch conversion. The runtime reads the imported object's
world-space bounding box after its Plasticity transform, exposes stable empty
IDs and selection, and tracks manual or MCP changes separately in scene diffs.
Dedicated Rename, Move, Rotate, Scale, and Delete tools use Plasticity's native
node or empty factories and document history. Reference meshes also participate
in mixed-node selection, native groups, visibility, and lock operations through
their stable IDs; group listings expose them separately as `referenceMeshIds`
rather than opaque `otherNodeKeys`.

A guarded public stdio acceptance on 2026-09-23 imported a millimeter STL box
with approximate bounds 20 × 10 × 5 mm, 36 buffer vertex entries, and 12
triangles. It passed stable-ID selection, native rename, native group creation
and membership read-back, lock/unlock, hide/show, translation by [10,20,30]
mm, a 90° world-Z rotation, nonuniform [2,0.5,1] scaling, deletion, and delete
Undo/Redo. A separate OBJ triangle whose file coordinates span 20 × 10
imported with an explicit inch source unit and produced 508 × 254 × 0 mm
bounds, three vertex entries, and one triangle. A second reference mesh was
then moved into the OBJ's existing group, and both stable IDs were read back in
`referenceMeshIds`. All meshes remained outside the B-Rep body list. Full Undo
cleanup restored the empty scene, the reference-mesh snapshot matched, and the
construction journal was in sync. Sanitized evidence is at
`[local acceptance artifact omitted]`.

## Native SVG profile import

Plasticity 26.1.3 exposes `VectorImportFactory` under `ImportCommand`. The MCP
requires an explicit native length unit because SVG coordinate values alone do
not establish a manufacturing scale. The verified values are millimeter,
centimeter, meter, inch, and foot. The adapter accepts only a nonempty local
`.svg` file and requires the complete native result to consist of editable
`Wire` objects. It does not classify the result as a reference mesh.

A guarded public stdio acceptance on 2026-09-23 imported a closed rectangular
path with coordinate bounds 20 × 10 using `sourceUnit=millimeter`. Exact native
B-Rep read-back found one closed Wire with four segments measuring
10/10/20/20 mm and one revision-bound Region. Extruding that Region by 8 mm
produced a closed, native-valid, printable Solid with exact bounds 20 × 10 × 8
mm, six faces, twelve edges, and no boundary edges or `Check()` codes. Undo
restored the imported Wire; Redo restored the same stable Solid ID. A second
import with `sourceUnit=inch` produced exact Wire bounds 508 × 254 mm, proving
the 25.4 conversion rather than repeating input metadata. Separate imports also
verified `centimeter` at 200 × 100 mm, `meter` at 20000 × 10000 mm, and `foot`
at 6096 × 3048 mm. Full Undo cleanup after every unit restored the empty scene
and left the construction journal in sync. Sanitized evidence is at
`[local acceptance artifact omitted]`.

## Native SVG export discovery

Plasticity 26.1.3 exposes `ExportSvgCommand`, `ExportHiddenLineFactory`,
`ExportHiddenLineDialog`, `HiddenLineSvgWriter`, and `SvgWriter` in the
renderer. A live UI export from a selected native rectangular Wire succeeded
through File → Export… → SVG. The exact source bounds were 20 × 10 mm, with
four native line segments of 10/20/10/20 mm. The saved 794-byte SVG declares
`width=22mm`, `height=11mm`, and `viewBox="0 0 22 11"`, then writes four exact
line paths in millimeter coordinates with a 1 mm stroke. It recenters the
profile into the SVG viewport and adds stroke/padding extents, so its page
bounds intentionally differ from the source Wire's 20 × 10 mm geometry.
Evidence, including the saved-file SHA-256 and path data, is at
`[local acceptance artifact omitted]`.

The public stdio MCP exposes `plasticity_export_svg` for coplanar Wire profiles
containing native `Line`, analytic `Circle`, and native `Ellipse` segments when
Plasticity exposes the exact carrier interval. It reads native endpoints,
exact planar bases, circle centers/radii/normals and edge lengths; circular
primitives are emitted only when native samples and analytic lengths agree
with the SVG representation. For a full Ellipse Wire, five equally spaced
native samples establish the center, axes, radii and projected exact bounds;
the samples must form two diameter pairs and lie on one analytic ellipse
before `<ellipse>` is emitted. For trimmed ellipses, the exporter reads the
carrier's full parameter period and trimmed endpoint parameters, verifies that
the native endpoints and oriented tangent agree with the fitted analytic
ellipse, then emits an exact SVG `A` arc and computes its analytic projected
bounds. Curves whose native analytic data cannot be verified and other planar
B-Rep curves remain marked adaptive approximations. It writes new millimeter
SVG files without the native Save Panel or overwriting existing files.
Plasticity 26.1.3 live acceptance exported the 20 × 10 mm rectangle as four
exact Line paths, a full 5 mm circle, a 220-degree 5 mm trimmed circle arc, and
a 12 × 5 mm Ellipse rotated 35 degrees. The closed Ellipse SVG and six
independent native evaluations agreed to normalized radial error 2.22e-16;
calculated bounds matched the analytic rotated ellipse. A separate live
acceptance cut a rotated native ellipse with a line and exported both the
retained major arc (33.170330 mm) and minor arc (22.525619 mm) as exact SVG
arcs, with large-arc flags 1 and 0. Six exact native evaluations per arc
matched the reconstructed SVG to maximum positional errors 1.92e-12 mm and
4.05e-13 mm; the source scene and undo depth were restored. Evidence is at
`[local acceptance artifact omitted]`. Circle evidence is at
`[local acceptance artifact omitted]`; Ellipse
evidence is at `[local acceptance artifact omitted]`;
the line acceptance is at
`[local acceptance artifact omitted]`.

A follow-up native-command probe on 2026-09-25 confirmed that
`ExportHiddenLineCommand` can be constructed and launched through the renderer
executor for a selected Solid. Plasticity opens its native save panel, then its
hidden-line options dialog; the latter generates preview geometry and offers
standard views, stroke styles, tolerances, and an optional raster background.
A test export from the 20 × 10 × 5 mm box produced valid SVG and native
visible/hidden edge groups, but the default viewport-sized output was
1575 × 1091 SVG millimeters and included an embedded PNG. The projected vector
spanned only a few SVG units because the test camera was zoomed far out. This
confirms the UI command is available, but does not establish a stable
programmatic view-descriptor contract or model-scale drawing output. The
probe's document bodies and history were unchanged; the SVG is at
`/tmp/plasticity_hiddenline_solid_probe_20260925.svg`.

Plasticity 26.1.3 live acceptance also exported a native `Ellipse` and a native
`BCurve` through the adaptive polyline path. For a 12 × 6 mm ellipse at a
0.02 mm requested chord tolerance, 65 points were emitted and the maximum
quarter-sample deviation was 0.014403 mm; the saved SVG carried the explicit
`adaptive-chord` approximation marker and millimeter page dimensions. The
ellipse Wire was undone and the test scene's original body set was restored.
Evidence is at `[local acceptance artifact omitted]`.
The first live ellipse attempt exposed an undeclared total-point counter in the
renderer-side curve reader; the counter was initialized and a regression test
now protects that injected source. The post-fix live export passed. These
sample checks are not a certified global geometric error bound. Other native
curve classes, non-coplanar profiles, and hidden-line projection from Solid
bodies remain unverified. This tool does not replace the editable
`.plasticity` or STEP source.

This does not call Plasticity's `ExportHiddenLineFactory`: its installed
implementation still has no verified direct-path contract, and the UI route
uses a native Save Panel. Solid-to-SVG hidden-line output, projection/orientation
controls, other non-analytic Wire curve classes, and native export style parity
remain unverified. Keep the broader SVG capability open until those parts are
implemented and checked against analytic geometry.

The disposable test was performed in a separately created Plasticity window;
the two windows open before the test were left unchanged. The temporary fixture
contains a 20 × 10 × 5 mm Solid and a 20 × 10 mm rectangular Wire. The test
window should be discarded after acceptance rather than treated as a user
document.

## Native slot profiles from planar Wire spines

Plasticity 26.1.3 exposes `SlotFactory` under `SlotCommand`. The public
`plasticity_create_slot_profiles` tool accepts one or more current planar Wire
spines and an explicit full width in millimeters. It preserves every source
Wire and commits the resulting closed editable Wires as one native history
step. A single straight segment is intentionally documented as unsupported by
this factory because it does not supply a unique planar basis; the dedicated
straight slotted-hole recipe covers that case.

A guarded public stdio acceptance on 2026-09-23 created an open L-shaped spine
through [0,0,0], [20,0,0], and [20,10,0] mm, then created a 6 mm wide slot
profile. Exact native read-back found one additional closed Wire with bounds
[-3,-3,0] to [23,13,0] mm and seven line/arc segments measuring
4.712388980, 7, 9.424777961, 9.424777961, 10, 17, and 20 mm. Its automatic
Region extruded by 4 mm into a closed native-valid printable Solid with bounds
[-3,-3,0] to [23,13,4] mm, nine faces, twenty-one edges, no boundary edges,
and no native `Check()` codes. Undo removed the extrusion and then only the slot
result while retaining the source spine; Redo restored the same stable slot
Wire ID. Full cleanup restored the empty scene and synchronized construction
journal. Sanitized evidence is at
`[local acceptance artifact omitted]`.

## Native Wavefront OBJ export

Plasticity 26.1.3 exposes `OBJExportFactory` with the same native tessellation
controls used by its other mesh exporters. The public `plasticity_export_obj`
tool accepts only current Solid or Sheet IDs, writes into a private staging
directory, refuses to overwrite the destination, sets `unit=millimeter`,
`scale=1`, and `upAxis=z`, and supplies explicit chord and angular tolerances.
It disables wireframe output and retains full tessellation rather than silently
simplifying the mesh.

The adapter parses the completed OBJ before copying it to the requested path.
It rejects empty or oversized data, invalid UTF-8, nonfinite vertices,
malformed texture coordinates or normals, faces with fewer than three vertices,
and positive or negative indices outside the records written so far. Its result
reports actual saved vertex, UV, normal, face, and triangulated counts plus the
coordinate bounds read from the file.

A guarded public stdio acceptance on 2026-09-23 exported an exact native Solid
20 × 10 × 5 mm. The saved OBJ contained one object, eight vertices, twenty-four
texture coordinates, twenty-four normals, and twelve triangular faces. Parsed
bounds were exactly [0,0,0] to [20,10,5] mm. File bytes and SHA-256 were
recorded, while document token, revision, Undo depth, Redo depth, body identity,
and exact B-Rep geometry remained unchanged. Native Undo then removed the
disposable source and restored the empty scene. Sanitized evidence is at
`[local acceptance artifact omitted]`.

## Native Sheet insertion

Plasticity 26.1.3 exposes `InsertSheetFactory` under the separately bound
`InsertSheetCommand`. Its public adapter accepts two different current Sheet
bodies: an open target shell with a nonempty explicit set of its boundary edges,
and one fill Sheet. It rejects stale revisions, duplicate or internal target
edges, non-Sheet inputs, and using one body in both roles before starting a
Plasticity command. The native operation consumes both inputs, may produce a
Sheet or a Solid, and invalidates every earlier topology reference.

A guarded public stdio acceptance on 2026-09-23 created a native Solid 20 × 10
× 5 mm, detached its top face into a separate one-face Sheet, and passed that
Sheet together with the four exact open-shell boundary edges to
`plasticity_insert_sheet`. One native history step returned one closed Solid
with the fill Sheet stable ID, six faces, twelve edges, no boundary edges, no
native `Check()` codes, and `printableSolid=true`. Exact mass properties before
detachment and after insertion agreed at 1000 mm³ volume, 700 mm² surface area,
and centroid [10,5,2.5] mm. Undo restored both Sheet inputs; Redo restored the
same Solid ID. Full cleanup returned the empty scene and an in-sync journal.
Sanitized evidence is at
`[local acceptance artifact omitted]`.

## Native body deformation between faces

Plasticity 26.1.3 exposes `DeformFaceFactory` under the separately bound
`DeformFaceCommand`. Assigning complete current face collections to
`factory.faces`, plus exact source and target faces, creates mapped native body
copies. Setting `keepTools=true` preserves every selected body and both
reference-face bodies. The public adapter therefore requires separate
deformation and reference bodies, rejects stale or duplicate identities, and
always preserves all inputs. It exposes the verified dimensionless U, V, and
normal scale controls together with UV swap, normal flip, and mirror flags.
Factory offsets remain zero because their physical unit and parameter-space
semantics have not yet been proved.

A guarded public stdio acceptance on 2026-09-23 created a native Cylinder with
R10 × 30 mm, unwrapped its cylindrical face into a planar Sheet measuring
62.831853 × 30 mm, and placed a separate 10 × 4 × 2 mm Solid on the source
plane. `plasticity_deform_bodies_between_faces` preserved all three inputs and
created a fourth independent Solid in one native history step. Exact B-Rep
bounds were [-12.513330756, -5.753106463, 13] to [-8.215206034,
5.753106463, 17] mm. The result contained six faces and twelve edges: two
BSurf faces and four Plane faces. Native mass properties measured
88.004130704 mm³ volume, 148.002572870 mm² area, and centroid
[-10.364268395, 0, 15] mm. All four bodies passed native `Check()`; the new
Solid was closed and `printableSolid=true`. Undo removed only the mapped copy,
Redo restored its stable ID. A second public call set U/V/normal scales to
1.25/0.75/0.5 and enabled UV swap, normal flip, and mirror together. It
created another closed valid Solid with exact bounds [-10.457035182,
-3.090169944, 12.015844817] to [-8.131711285, 3.090169944,
17.984155183] mm and 35.625965087 mm³ volume; one Undo removed only that
variant. Full cleanup returned the empty scene with an in-sync journal.
Sanitized evidence is at
`[local acceptance artifact omitted]`.

## Native patches from closed spatial Wires

Plasticity 26.1.3 exposes `PatchHoleInWireFactory` under the separately bound
`PatchHoleInCurveCommand`. The public `plasticity_patch_closed_wires` adapter
accepts current unique Wire IDs, reads their native `IsClosed()` state before
mutation, repeats the identity and closure checks inside the command, and
preserves every source. This differs from `plasticity_patch_regions`: a spatial
closed Wire has no planar Region but can still bound a native B-Surface. Native
fill-preference, smoothness, continuity, topology, and tolerance defaults stay
internal because their enum meanings and geometric guarantees have not been
qualified as a public contract.

A guarded public stdio acceptance on 2026-09-23 created two closed spatial
Wires, one through [0,0,0], [20,0,0], [20,10,5], and [0,10,0] mm and one
translated 40 mm in X with the opposite Z deflection. Neither had a Region.
The first had exact native segment lengths 10, 11.180339887, 20, and
20.615528128 mm. One public patch call preserved both Wires and added two
independent one-face Sheets in one history step. Both faces were nonplanar
BSurfs with exact bounds [0,0,0]…[20,10,5] mm and [40,0,-5]…[60,10,0] mm.
The first Sheet's four B-Rep edge lengths matched its Wire. Native face mass
properties measured 210.033727398 mm² area, 61.795868016 mm boundary length,
one outer loop, no inner loop, and centroid [10,5,2.5] mm. Both Sheets passed
native `Check()`, had four expected boundary edges, and correctly remained
`printableSolid=false`. One Undo removed both Sheets while preserving both
Wires, Redo restored both stable IDs, and full cleanup returned the empty scene
with an in-sync journal. Sanitized evidence is at
`[local acceptance artifact omitted]`.

## Native curve deformation between faces

Plasticity 26.1.3 exposes `DeformCurveFactory` under
`DeformCurveCommand`. The public `plasticity_deform_curves_between_faces`
adapter accepts current unique Wire IDs plus separate exact source and target
faces. It preserves all Wires and both reference bodies, forces unverified
U/V/normal offsets to zero, and exposes the same verified dimensionless U, V,
and normal scales plus UV swap, normal flip, and mirror controls as body
deformation.

A guarded public stdio acceptance on 2026-09-23 created a Cylinder R10 × 30 mm,
unwrapped its curved face to the exact 62.831853 × 30 mm planar source, and
placed an open two-segment polyline plus a closed R3 circle on that source. One
public call preserved all four inputs and added two independent Wires in one
history step. The open source and result lengths were 15.620499352 and
15.620508095 mm; the closed source and result lengths were 18.849555922 and
18.848787842 mm. Both results were natively nonplanar. Fifteen exact B-Rep
point-and-tangent evaluations at segment parameters 0, 0.25, 0.5, 0.75, and 1
all lay on the target radius of 10 mm within 0.01 mm. Exact result bounds were
[-10.004999776,-4.799255365,12.995000268]…[-8.770825612,4.799255365,
19.004999389] mm and [-6.276707563,-9.979563022,11.921897807]…
[-0.629405712,-7.784007440,18.078102193] mm.

A second public call applied U/V/normal scales 1.25/0.75/0.5 and enabled UV
swap, normal flip, and mirror together. It produced an independent open Wire
with different exact bounds and length 19.772172071 mm while exact samples
remained on the R10 target. One Undo removed only that variant. The next Undo
removed both baseline mapped Wires, Redo restored both stable IDs, and full
cleanup returned the empty scene with an in-sync journal. Sanitized evidence is
at `[local acceptance artifact omitted]`.

## Native conversion of Wire vertices to B-Spline control vertices

Plasticity 26.1.3 exposes `ConvertVertexFactory` under `ConvertCommand`. The
public `plasticity_convert_curve_vertices_to_control_points` adapter accepts
current revision-bound native Wire vertices, rejects open endpoints and
non-degree-two references before mutation, resolves the selected current vertex
views again inside the native command, and lets Plasticity rebuild the Wire.
The operation changes the path and replaces segment topology, so every prior
vertex and segment reference must be discarded.

A guarded public stdio acceptance on 2026-09-23 created an open polyline through
[0,0,0], [10,0,0], [10,10,0], and [20,10,0] mm. The three original native Line
segments had a combined exact B-Rep length of 30 mm. One public conversion call
selected both interior vertices and retained the same Wire stable ID and exact
endpoints and bounds. Plasticity rebuilt it as one open cubic `BCurve`, degree
3, seven control points, four spans and length 26.829080099 mm. The editor
exposed five interior control points. An attempted conversion of an open
endpoint returned a validation error without changing the document or history.
One Undo restored the three original Lines and exact 30 mm length; Redo restored
the B-Spline structure and stable ID. Full cleanup returned the empty scene
with an in-sync journal. Sanitized evidence is at
`[local acceptance artifact omitted]`.

## Exact polynomial BCurve SVG export

Plasticity exposes BCurve degree, rational/periodic flags, and native distinct
knot parameters on each edge. For non-rational polynomial curves of degree
1–3, including periodic curves, the SVG exporter splits the normalized edge
interval at every native knot and reconstructs an SVG cubic Bezier span from
exact B-Rep evaluations at 0, 1/3, 2/3, and 1. Degree-1 and degree-2
polynomial spans are represented exactly by degree-elevated cubic commands.
Five additional exact evaluations per span gate the representation;
when the residual or span continuity fails, export falls back to the existing
explicitly marked adaptive polyline. SVG view bounds use analytic extrema of
the recovered cubic.

Unit tests cover the exact degree elevation for linear and quadratic
polynomials and check that the native extractor enables this path only for
non-rational integer degrees 1–3. No live Plasticity fixture for non-rational
degree-1 or degree-2 curves has been exercised yet; retain that as a live
acceptance item before treating those native curve types as verified.

The live acceptance on Plasticity 26.1.3 created a native single-span cubic
BCurve through the stdio MCP and exported one SVG `C` command. Seven further
native B-Rep evaluations matched the SVG with maximum error
3.084934028563056e-13 mm; the exact 30 mm endpoint delta and analytic page
bounds were checked, and the export left scene revision and history unchanged.
Undo/Redo checks restored the original scene and body IDs. Evidence:
`[local acceptance artifact omitted]`.

The follow-up live acceptance created an open degree-3 BCurve with four native
knot spans. The exporter emitted four SVG `C` spans and twelve additional exact
B-Rep evaluations (three in each span) matched with maximum error
6.040391992554319e-13 mm. Both the single-span and multi-span live runs restored
the original scene through Plasticity Undo. Evidence:
`[local acceptance artifact omitted]`.

The live acceptance also created a native G2 bridge of degree 5. The exporter
kept the explicitly marked adaptive fallback; 21 additional exact native
samples deviated from the exported polyline by at most 0.018515202816910794 mm
under the requested 0.02 mm tolerance. The three disposable bridge fixtures
were removed with three Undo operations, restoring the initial body IDs and
Undo depth. Evidence:
`[local acceptance artifact omitted]`.

The production extractor now also admits non-rational periodic cubic BCurves,
with the same per-span exact B-Rep validation gate. A live Plasticity 26.1.3
acceptance created a closed periodic degree-3 Wire through the stdio MCP and
exported six exact SVG cubic commands (no adaptive approximation); 251 native
curve samples were within 0.00035200374460659035 mm of a dense polyline sampled
from those SVG commands. Plasticity reports raw `numSpans=9` because its
periodic knot vector includes wrapped extension knots. The curve-structure MCP
now reports both that native field and `activeSpanCount=6`, which matches the
intervals on the normalized edge and the SVG command count. Undo restored the
original Solid and history depth. Evidence:
`[local acceptance artifact omitted]`.

For a rational conic, the extractor fits an ellipse from five exact B-Rep
samples and validates it against 65 additional native samples. Plasticity
26.1.3 imported the authored rational quadratic quarter-circle STEP wireframe
as one planar degree-2 rational BCurve; production stdio MCP exported one SVG
elliptical arc marked `ellipse-fit` / `65-native-brep-samples`, with no cubic or
adaptive segments. One Undo restored the original scene. This verifies native
curve extraction and the conic export path for this fixture; finite samples do
not prove global equality for every rational BCurve. The reusable gate is
`npm run accept:native-svg-rational -- --target ID --allow-live --output
NEW_EMPTY_DIRECTORY`. It requires a disposable empty document and leaves one
fixture Redo entry, so close that test document afterward.
Live evidence: `[local acceptance artifact omitted]`; SVG: `[local acceptance artifact omitted]`.

Curves that do not pass the conic fit and sample checks retain the explicitly
marked adaptive fallback. Its checked chord error is not a proof of global
maximum error.
