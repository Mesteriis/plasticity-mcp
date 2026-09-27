# Finite-element runtime acceptance

The local CalculiX backend is exposed through a deliberately bounded static-FEA
MCP workflow. It does not claim that arbitrary geometry has passed a strength
check.

Build the arm64 CalculiX container and run its analytical patch test:

```bash
npm run build:fem-solver
npm run accept:fem-solver
```

The image pins the Debian 12 arm64 base by digest and CalculiX to package
version 2.20-1. The runtime test disables container networking, uses a
read-only root filesystem, applies memory/CPU/process limits and mounts only a
temporary working directory as writable. A one-element C3D8 uniaxial
extension must return 100 MPa and 0.5 mm, matching the closed-form solution.
An 8-element affine pure-shear C3D8 patch also checks all 64 integration
points against the analytical 15.384615 MPa shear stress, verifies the other
stress components are zero, and checks the free centre node displacement
`[0.005, 0.005, 0]` mm. The stress comparison accounts for CalculiX's
five-decimal report precision. These solver patches validate the executable
and element response; they do not establish convergence or physical validity
for a part model.
An additional rotated orthotropic C3D8 patch supplies all nine engineering
constants and a rectangular local material frame. With material axis 1 aligned
to global Y, the fixture returns 20 MPa along local axis 1 and 0.1 mm axial
displacement at all four loaded-face nodes. This verifies the pinned solver's
orthotropic deck syntax and frame handling. The public MCP static-FEA input
also supports the explicitly evidenced orthotropic model, while the solver
patch remains its independent analytical check. CalculiX 2.20 defines
`TYPE=ENGINEERING CONSTANTS` with E1/E2/E3, three Poisson ratios and G12/G13/G23,
and `*ORIENTATION` defines the local axes used by a solid section
([CalculiX 2.20 manual](https://www.dhondt.de/ccx_2.20.pdf)).

The public MCP path was exercised against Plasticity 26.1.3 with two named load
cases and four meshes at 2/1/0.5/0.25 mm. The report retained all nine elastic
constants, evidence for each input and the confirmed global material axes;
every case and refinement level identified its stress components as
`material-local`. The empty native document was restored with two Undo steps.
This verifies material input, orientation, solve, report persistence and mesh
refinement wiring. A separate optional 3D Tsai-Wu diagnostic now evaluates each
CalculiX material-local integration-point tensor and records the maximum failure
index and proportional load factor to index one, with mesh locations. It is
available only when all nine directional un-factored strengths are entered with
exact traceable physical-test records and the three normalized XY/XZ/YZ
interaction coefficients are derived from traceable biaxial tests for the same
single-material print process. Every strength and interaction evidence record
also carries its process identity; validation rejects a mismatch in printer,
filament, profile hash, orientation, infill or nozzle temperature. The normalized interaction matrix must be
positive definite. MCP and pure-formula tests exercise this path with explicitly
synthetic fixtures. A separate live public-stdio-MCP acceptance recorded an isolated
synthetic single-process coupon, passed only its immutable ID into FEA for a
disposable native Solid in Plasticity 26.1.3, received the CalculiX Tsai-Wu
screen, confirmed a current report, then restored the empty document and observed
the report become stale. This proves integration plumbing only: no real physical
coupon values or user-material run have been verified. The acceptance returned
maximumFailureIndex=0.0102619 for explicitly synthetic values, kept
strengthPass=false and printApproved=false, restored the empty CAD document,
and the saved report then became stale. Evidence:
`[local acceptance artifact omitted]`.
The output is a diagnostic, not a strength pass:
the linear homogeneous continuum does not resolve individual roads or discrete
layer delamination, and its proportional load factor is not a safety factor.
Evidence for the underlying live orthotropic solver wiring:
`[local acceptance artifact omitted]`.

### Single-material, layerwise static response

A guarded public-stdio-MCP acceptance on Plasticity 26.1.3 exercised the
optional layerwise static path using a disposable 10 × 5 × 4 mm Solid, a
synthetic exact-process orthotropic tensor, and a complete four-layer G-code
direction fixture. Gmsh fragmented the exported B-rep at the three confirmed
interlayer planes and produced four conformal C3D4 regions with 162 elements
each. CalculiX 2.20 used the same tensor with the confirmed frame for each
layer; the report identified its stress basis as `layer-local` and remained
current against the CAD revision. The test also exercised the homogeneous
single-material route, support/load transfer, reports, and Undo cleanup; it
restored the empty test document and confirmed that removing the Solid made
its reports stale. The material and process values were synthetic software
fixtures, not physical qualification or strength evidence. This path assumes
perfectly bonded layers and does not model multiple materials, layer-varying
properties, individual roads, or delamination. Evidence:
`[local acceptance artifact omitted]`.

The live STEP-to-mesh check used a disposable 10 × 5 × 4 mm native Plasticity
box. Gmsh 4.15.2 imported one solid with the same bounds, mapped all six planar
faces and produced a first-order tetrahedral mesh. Gmsh was installed with
`brew install gmsh`; on this host the Python API is available at
`/opt/homebrew/opt/gmsh/lib`.

The face-map acceptance uses the same empty-document guard:

```bash
npm run accept:fem-face-mapping -- \
  --target EXPLICIT_EMPTY_PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_OUTPUT_DIRECTORY
```

It exports a disposable native box, maps all six revision-current planar face
IDs to Gmsh surfaces by exact surface type, oriented normal, centre and bounds,
checks one-to-one mapping and total surface area, then undoes the box. The
mapper refuses nonplanar faces, non-unique signatures, split faces, non-single
Solid STEP files, or signatures outside 0.0001 mm. It currently requires Gmsh
4.15.x and intentionally does not guess a match.

These checks validate the solver executable, exact planar face mapping, and a
basic CAD exchange/meshing path. They do not prove curved/split face mapping,
mesh convergence for real parts, contact, multi-body assemblies, nonlinear
material behavior or general whole-part strength.

### Representative rounded bracket mesh trend

Run the public MCP acceptance against an explicitly selected empty Plasticity
document:

```bash
npm run accept:fem-bracket -- \
  --target EXPLICIT_EMPTY_PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_OUTPUT_DIRECTORY
```

The guarded live run creates a single-piece L-bracket with a 4 mm rounded
profile root, measures its load face from native B-Rep, applies a synthetic
uniform traction, and solves two public MCP FEA reports. Their byte-identical
overlapping meshes are combined into four exact mesh levels from 6 mm to
0.75 mm (669 to 57,361 C3D4 elements). Force/moment balance, report freshness,
and undo cleanup are checked. On the 30 × 25 × 15 mm fixture the maximum raw
von Mises integration-point stress changed 1.390 → 1.733 → 2.703 → 3.455 MPa;
the last refinement still changes it by 27.8%, so this acceptance explicitly
does not pass a convergence threshold or establish the physical validity of
its synthetic material/support assumptions. The shifting peak locator also
means raw peak stress is not a stable whole-part design metric for this
fixture. Evidence from the 2026-09-23 Plasticity 26.1.3 run is recorded in
`[local acceptance artifact omitted]`.

## Static FEA MCP tool

`plasticity_analyze_static_fem` accepts a current Solid ID and revision,
either 1–8 distinct planar support face IDs (legacy behavior: all three global
translation directions are fixed on each face) or 1–8 `supportConditions`
with one or more explicitly fixed global translation axes (`x`, `y`, `z`) per
face. The two support forms are mutually exclusive. A partial condition applies
zero displacement on the selected global axis at every node in that face's node
set. It is not surface-normal support on a tilted face, contact, friction, a
rotational restraint, or a physically inferred bearing condition. Confirm each
condition with the user; insufficient restraints may leave rigid-body modes
and cause the solver to fail without saving a report. After supports, either the original single-case
`faceLoads`/`resultantLoads` fields or up to eight named, independent
`loadCases`. Each case is kept separate; its loads are never silently added to
another case. Optionally, set `meshRefinementSteps` to 1–3 to repeat the
cases at successively halved element-size targets, up to four mesh levels. The complete run is
limited to 12 solver jobs. Each load may specify a
uniform traction vector in N/mm² or a resultant force in N, application point
in mm and free moment in N·mm. A resultant-load point must lie on its selected
planar face. The tool also requires mesh size in mm, Young's modulus in MPa and
Poisson ratio. Legacy `supportFaceIds` fix X/Y/Z on each selected face;
explicit `supportConditions` constrain only the chosen global translation
axes. Codex must confirm that support model with the user. It exports the current Solid to STEP, maps the exact
selected native face signatures, generates a first-order C3D4 mesh, integrates
each uniform face traction and resultant force/moment into equivalent nodal
loads that preserve total force and moment, then runs CalculiX. For named load
cases, it remaps the same exported STEP once per case and accepts comparisons
only when the generated mesh files are byte-identical; otherwise it stops
instead of comparing results on different discretizations. A free moment
is represented by a balanced equivalent nodal couple over the selected face;
its local stress field therefore depends on that explicit load-distribution model. It reports reactions and
force/moment equilibrium residuals without issuing a strength verdict. The immutable
report records geometry, the first case in the legacy summary fields, and all
named case loads, resultants, maximum stress, displacement component on each
case's first loaded face along the largest component of its first load vector,
total and per-support-set reaction forces/moments, force/moment equilibrium residuals and CAD binding. The per-support resultants are summed from CalculiX's nodal RF output for each generated support NSET and are retained separately in every named case and mesh level. Each
calculation also records the maximum raw C3D4 integration-point stress element,
integration point and that tetrahedron's centroid in millimetres. The centroid
is a mesh-bound locator for the reported stress value, not an averaged field or
a resolved critical-region boundary. The report also derives maximum and
minimum principal stress from each sampled symmetric integration-point tensor
and stores each extremum's element, integration point and centroid. These
signed tensor extrema help review tensile and compressive behavior; they are
not allowable comparisons and do not establish a material failure criterion
or strength pass. Their trend across mesh refinement levels and signed
relative change from the previous mesh are retained as sampled evidence only;
for a negative minimum principal stress, a negative relative change means the
signed value became more compressive. When refinement is requested, it stores
each mesh hash, element/node counts and relative change in maximum von Mises
stress, both principal-stress extrema and observed displacement from the
previous level. It also measures how far the raw peak-stress tetrahedron's
centroid moved between adjacent mesh levels. A large shift can reveal an
unstable or mesh-sensitive peak locator; the distance does not track a
continuous stress field and no convergence threshold or pass is inferred.
Each Gmsh mesh summary also retains the minimum, nearest-rank fifth percentile
and median of the sampled `minSICN` value over all C3D4 tetrahedra. Gmsh defines
`minSICN` as the sampled minimal signed inverted condition number
([Gmsh 4.15.2 reference](https://gmsh.info/doc/texinfo/#gmsh_002fmodel_002fmesh_002fgetElementQualities)).
The minimum exposes the worst element while P05 and median show whether low
values extend beyond one outlier. These are mesh-shape descriptors only; this
backend defines no universal acceptable cutoff and makes no strength claim
from them. The three values are retained at each refinement level and checked
for reproducibility when mesh reports are merged. The summary also identifies
the minimum-SICN element and its centroid, cross-checking that locator against
the written CalculiX connectivity. Each case reports whether the raw peak
stress element is that same element; this is an identity comparison, not a
stress correction or a quality threshold. It also records the Gmsh SICN for
the stress-peak element itself, looked up by the solver's element ID in a
validated sidecar table. This contextualizes the peak's element shape without
claiming that a high SICN makes the stress accurate or mesh-converged. Gmsh's
floating-point overshoot up to 1e-12 above SICN's upper bound is clamped to 1;
larger overshoots are rejected.
`plasticity_static_fem_report`
re-reads that binding and labels the report `current` or `stale`. When a report
references a physical coupon, freshness also revalidates its content hash,
process identity, unique registry match and Young's modulus; a corrupted,
missing or newly ambiguous record makes the result stale.
Before each CalculiX job, the MCP parses the generated mesh deck's actual node
coordinates and support node sets, builds the six-column rigid-body constraint
matrix for each specified global translation, and requires rank six. The
immutable report records `supportRigidBodyConstraintRank: 6`. This preflight
rejects an under-constrained model before CalculiX runs; full rank removes only
global rigid translation/rotation and does not prove physical support validity,
elastic stability, absence of local mechanisms or strength.
New analyses also persist exact-value evidence for Young's modulus and Poisson
ratio. Young's modulus may bind to an unambiguous process-matched coupon record
or a sourced/measured property record; Poisson ratio always needs separate
evidence because the coupon registry does not measure it. Explicit assumptions
are retained as scenario-only inputs. Older saved reports without these fields
remain readable, but new MCP calls require them.

An optional `factoredVonMisesAllowableMPa` may be supplied with directly
measured/sourced `factoredVonMisesAllowableEvidence` and a non-empty
`factoredVonMisesAllowableBasis`. The evidence value must exactly match the
allowable and include URL, source SHA-256 and locator. Assumed allowables are
rejected; a generic tensile strength or raw coupon peak is not promoted to a
design allowable. When present, the MCP reports raw maximum von Mises divided
by that factored allowable for every named case and every stored mesh level.
This is an exceedance screen over the sampled raw peaks only. Even if all
samples are below one, the result does not prove strength or convergence and
does not change `strengthPass: false` or `printApproved: false`. The screen is
covered by schema, persistence and MCP tests; no physical process-specific
factored allowable was available for live Plasticity acceptance.

Reports are stored under `$PLASTICITY_STRENGTH_ROOT/fem-reports` when that
variable is configured, or `.plasticity-mcp/strength/fem-reports` in the
project by default. Each report points to its retained STEP, mesh, load deck,
CalculiX input and result artifacts under the adjacent `jobs` directory.

The supported problem is one isotropic, linear-elastic Solid with 1–8 planar
support faces using either fully fixed legacy restraints or explicitly selected
global translation axes, and planar support/load faces with uniform tractions and/or face-based
resultant forces and moments. In named-case mode, the union of selected loaded
faces and support faces must not share mesh nodes; each case is solved
independently on a byte-identical mesh. Support reactions are reported both per support NSET and as a total; each per-support force and moment is recombined and checked against the total before the report is accepted. The tool does not compare results with allowable stress,
calculate a safety factor, infer support conditions, or approve a print. Contacts,
non-fixed support types, body assemblies, forces applied away from selected faces,
spatially varying pressure,
nonlinear materials, buckling, fatigue and general FEA remain out of scope. A normal pressure on a
planar face can be expressed as a uniform traction vector after confirming its
direction and units.

### Live guarded acceptance

Run only against an explicitly selected empty Plasticity document. The check
creates one disposable box, exports STEP, maps opposing native faces, meshes
them, solves in the isolated CalculiX container, then uses Plasticity Undo and
checks that the original empty scene was restored:

```bash
npm run accept:fem-static-patch -- \
  --target EXPLICIT_EMPTY_PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_OUTPUT_DIRECTORY
```

The live acceptance on Plasticity 26.1.3 calls the public MCP analysis and report
tools on a disposable Solid. The report was `current` while the Solid existed
and `stale` after Undo removed it; the original empty scene was restored. With
E=2,000 MPa, ν=0.3 and 100 N/mm² on a 20 mm² face, the tool transferred 2,000 N
and returned a balanced −2,000 N reaction. The fully fixed face changes the
uniform axial patch solution: on a 1 mm / 1,118 C3D4 mesh the public tool
returned 103.8887 MPa maximum von Mises stress and 0.4901 mm loaded-face
displacement. Separately, the displacement-controlled affine patch test
returned exactly 100 MPa and 0.5 mm on both 923-element and 1,118-element
meshes. These are software and adapter checks, not a claim of general mesh
convergence or component safety. Evidence and solver artifacts are written to
the requested output directory.

The same guarded acceptance also hollows the disposable box by 1 mm and submits
a public MCP solve with two separated support faces: the outer end face fixes
global X/Y, while an internal cavity end face fixes global Z. A traction load is
applied on the opposite outer end face. The saved CalculiX deck contains
`FACE_1, 1, 1, 0.`, `FACE_1, 2, 2, 0.` and `FACE_2, 3, 3, 0.` and omits a Z
restraint on `FACE_1`; the solver completed with force and moment equilibrium
residuals below 0.000001 in their respective units. The public report was
`current`, became `stale` after both disposable history steps were undone, and
the document returned to its original empty scene. This verifies the public
per-axis restraint path on a synthetic hollow test body; it does not validate
support assumptions. The separate representative-bracket trend above now
exercises the public MCP on actual native bracket geometry, but it still does
not demonstrate mesh convergence or component safety.

### Same-material layer-interface MCP acceptance

The guarded public MCP acceptance also records an explicitly synthetic,
single-process normal-tension layer coupon and analyzes two parallel layer
interfaces on a disposable native L-bracket in Plasticity 26.1.3. The route
used the same exact-process coupon, orthotropic tensor and print axes in every
bulk region, generated three volume regions and two cohesive interfaces, and
completed with Code_Aster 17.4. The report was `current` before cleanup and
`stale` after Undo restored the empty scene. This exposed a face-mapping defect:
Plasticity's reported center of a concave planar face differed from the STEP
area centroid, so mapping now relies on the oriented normal and exact bounds;
multiple candidates still fail closed. A synthetic 0.06 mm terminal opening
also caused a singular matrix at step 16; the software fixture was reduced
to 0.001 mm to test integration without treating a failed solve as a strength
result. The completed run has `strengthPass=false` and
`printApproved=false`; it does not validate physical adhesion or part strength.
The follow-up oblique live MCP evidence is `[local acceptance artifact omitted]`.

The separate `npm run accept:cohesive-layer-stack` solver acceptance now builds
a synthetic box rotated 45° about global Y, splits it at two parallel tilted
planes, and applies displacement along their [0.7071, 0, 0.7071] normal. Both
isotropic Code_Aster 15.2 and single-material orthotropic Code_Aster 17.4
completed 101 result increments for three bulk regions and 28 cohesive
elements. The orthotropic print frame was rotated with the build direction, and
the dominant output component was scaled back to the prescribed 0.001 mm
normal opening. This verifies the mesh/deck/result adapter for an oblique build
orientation; it is not a physical material test or strength validation.

The mesh-only acceptance `npm run accept:cohesive-layer-stack-mesh` exercises
the real Gmsh STEP fragmentation and cohesive insertion path without opening
Plasticity or starting Code_Aster. On Gmsh 4.15.2, the default 34-layer case
produced 34 ordered tetrahedral volume groups, all 33 interface groups, and
462 PENTA6 cohesive elements. Repeating it with
`PLASTICITY_COHESIVE_LAYER_COUNT=256` produced 256 volume groups, 255
interface groups and 3,570 cohesive elements, including ordered endpoint
groups `GM1`/`GM256` and interface tags 257–511. This proves mesh generation
at the configured limit; it does not prove a full 256-layer Code_Aster solve,
convergence, or physical strength. Evidence can be regenerated with:

```bash
npm run accept:cohesive-layer-stack-mesh
PLASTICITY_COHESIVE_LAYER_COUNT=256 npm run accept:cohesive-layer-stack-mesh
```

The public MCP acceptance was then extended to rotate its disposable native bracket 45° about global Y, record an exact-process coupon and same-material layer-test fixture for orientation `[0, 45, 0]`, and run the cohesive tool across two oblique interfaces. The Code_Aster 17.4 report used identical orthotropic constants and a build axis aligned with `[0.7071, 0, 0.7071]`; the empty document was restored with four Undo steps. This verifies the public adapter as well as the solver projection. The fixture values remain synthetic. Evidence: `[local acceptance artifact omitted]`.
