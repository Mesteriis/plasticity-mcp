# Cohesive solver investigation

The current CalculiX 2.20 path handles one homogeneous Solid and cannot model
cohesive interfaces. An experimental Code_Aster path represents a measured
planar interface in a selected Solid. The current public strength-analysis
route is intentionally limited to same-material printed-layer interfaces;
it rejects a dissimilar-material printed bond before meshing or solving. The
underlying mesh/solver feasibility experiments include synthetic dissimilar
bulk regions, but they are not an enabled printed-part calculation. Every new
MCP analysis requires a layer-plane plan bound to an immutable slicer profile
hash and measured layer height. The planner can incorporate selected relative
interface offsets returned from actual G-code; the agent still chooses the
first CAD-space anchor and build axis explicitly. The mesh can repeat one
same-material interface law across the planned parallel planes, but does not
build individual roads or apply the newly exposed per-layer raster summaries
as distinct bulk-material axes in FEA. Code_Aster documents cohesive-zone models
and ships the official SSNV199A–D cohesive-crack regressions, covering
hexahedral/pentahedral joint elements and two regularized laws.

The Plasticity static-analysis mesh path now also writes an optional Gmsh 2.2
mesh alongside the CalculiX input. Selected planar face mappings become
dimension-2 physical groups with unique tags; Code_Aster 15.2 imports these as
`GM1001`, `GM1002`, and so on (its legacy reader uses `GM<tag>` rather than the
Gmsh physical text name). A live import of the generated 10 × 5 × 4 mm box
mesh found `GM1` with 1,117 tetrahedra and `GM1001` with 54 triangles, matching
the selected Plasticity face. That import verifies mesh and boundary-group
transfer only; the separate cohesive path below now connects a current native
Solid to a two-region solver response but does not qualify a printed-layer
material model.

The first cohesive mesh path lives in `scripts/fem/cohesive-mesh.py`. Its CLI
can split one STEP Solid by an explicit point and normal, mesh the two sides as
separate tetrahedral material regions, identify their shared triangles,
duplicate the interface nodes on one side, and emit PENTA6 elements in a new
Code_Aster physical group. It also accepts an already conforming ASCII Gmsh
2.2 mesh. In both modes it verifies that the marked surface exactly equals
the two regions' shared facets, remaps the split-side exterior triangles, and
rejects extra shared nodes, nonmatching facets and group-tag collisions.
Python unit tests cover the connectivity and validation rules.

A live synthetic STEP box (10 × 5 × 4 mm) split by an explicit Z plane and
meshed with Gmsh 4.15.2 produced 170 tetrahedra per region, 38 interface
triangles and 28 duplicated nodes. The transformed mesh imported in Code_Aster
15.2; `AFFE_MODELE` accepted both solid groups as `3D`, the PENTA6 group as
`3D_JOINT`, and an `ELAS` plus `RUPT_FRAG` material assignment. The same test
material was assigned to both solid regions, so this did not exercise a
dissimilar-material bond. This proves geometry-to-mesh conversion and solver
model assembly for one planar two-region interface only. The generator can
map exact native planar face signatures to boundary groups when those faces
remain unsplit after the cut; faces cut into multiple entities are rejected.
On the same synthetic box, bottom and top faces were mapped into `GM4`/`GM5`,
the bottom was fully fixed, and the top received a 0.001 mm prescribed
displacement over 10 increments. Code_Aster completed `STAT_NON_LINE` with
`ELAS` in both regions and `CZM_EXP_REG` on the 38 PENTA6 elements (solver
exit 0). This checks one nonlinear execution path, not a measured material law
or strength prediction: both regions shared one synthetic elastic material
and the cohesive constants were test inputs. The live synthetic exercise is
not a physical strength result.

The TypeScript path now also has a closed Code_Aster deck builder and a
network-disabled pinned-container runner. It accepts two separate isotropic
elastic property sets and one mode-I peak/energy parameter pair, applies a
normal displacement, and parses displacement, support reaction, and `V3`/`V7`/
`V8`/`V9` state-variable ranges only for the declared cohesive elements. A live
run of the generated deck on the two-region synthetic mesh completed with
different bulk moduli (2,000 and 1,000 MPa), 68 cohesive elements, and 11
reported increments. This verifies deck execution and output extraction; the
parameter values were still synthetic. The parser deliberately returns raw
Code_Aster state variables without assigning a failure meaning to them.

The TypeScript STEP mesh wrapper now accepts native planar-face signatures and
checks that Gmsh 4.15 returns two tetrahedral material regions, mapped support
and load faces, and unique cohesive element IDs before a solver run. A separate
deck-binding helper derives the mode-I peak and fracture energy from a
hash-verified immutable interface-test record. It requires normal tension,
observed interface failure and matching directed material orientation; it uses
the measured curve's final separation as the prescribed endpoint. This still
reduces the full measured curve to peak plus integrated energy and is not a
validated curve-fit or production law.

The experimental `plasticity_analyze_cohesive_interface` MCP tool now connects
the live Plasticity Solid and revision to that mesh/deck/solver path. It reads
the immutable interface test, requires unambiguous exact-process coupon records
for both moduli plus directly traced Poisson ratios, checks the selected native
support/load faces and directed negative/positive material assignment, exports
the STEP, generates the mesh and rechecks the CAD revision before and after the
solve. MCP-level tests exercise valid and stale-revision outcomes. A complete
live MCP run with caller-registered physical coupon and interface-test data has
not yet been performed; this feature remains solver-response diagnostics, not
a qualified strength prediction.

The current deck builder maps a mode-I peak traction and integrated fracture
energy into `SIGM_C` and `GC` for `CZM_EXP_REG` by default. An explicit
`modeILaw` can select `CZM_LIN_REG`; the public MCP carries that value into the
generated deck and immutable input report. Both laws reduce the measured curve
to peak traction and integrated energy, rather than fitting its full shape, so
the selected shape must be justified against the test curve. Production-runner
acceptance exposed a load-path bug: the prescribed displacement was constant
at every time step, so Code_Aster attempted the full opening on the first
increment. The deck now multiplies it by a linear `DEFI_FONCTION` ramp from
zero to one over the analyzed interval. On the synthetic single-interface
mesh, both laws completed all 21 records at a final opening of 0.08 mm with
pinned Code_Aster 15.2. `CZM_EXP_REG` reached V3=1 with a final reaction of
−7.20288 N; `CZM_LIN_REG` reached the documented fully-broken V3=2 state and
near-zero final reaction. The ramp and post-peak response are now live-tested,
but the mesh and law parameters are synthetic; this is solver-path acceptance,
not material calibration or a strength prediction. The numerical
`PENA_ADHERENCE` parameter remains explicit and requires sensitivity analysis.
Reproduce the two production-runner cases with `npm run accept:code-aster-mode-i`;
the command generates a temporary synthetic mesh and removes its workspace on
completion.
Evidence: `/var/folders/7z/9z8k42j54vb2zfhzw6nx82g00000gn/T/plasticity-czm-ramped-postpeak-Lv6cve/evidence.json`.
The MCP result is solver response plus mesh screening, not a material-qualified
strength calculation.

The raw `V3` output is accompanied by a law-specific interpretation label.
`CZM_EXP_REG` exposes its normalized damage variable, while the official
[`Code_Aster nonlinear behavior manual U4.51.11`](https://code-aster.org/V2/doc/default/en/man_u/u4/u4.51.11.pdf)
defines `V3=2` as fully broken for `CZM_LIN_REG`. Parsing preserves the raw
range and never coerces the linear-law state to a 0–1 fraction. This semantic
label is based on the solver documentation and a live synthetic run that
reached V3=2; it is not a physical failure test of printed material.

The runner now measures the largest triangular edge across the PENTA6 interface
and reports a per-material screening estimate `E / (1 - nu²) × Gc / sigma_c²`
against a five-element target, using the two adjoining isotropic materials
separately. A coarse mesh is surfaced as a result limitation. This is only an
indicative heuristic from the Code_Aster guidance: it is not a bimaterial
process-zone solution or proof of convergence, and geometry and constitutive
details can change the required resolution. On the existing synthetic mesh the
largest interface edge is 1.502 mm; the two material estimates give 5.08 and
2.51 elements, so the runner marks it below the screen while Code_Aster still
completes all 11 response increments. This checks that the advisory is carried
through a real solve; the synthetic mesh is not evidence of material strength
or mesh adequacy.

The MCP's interface-test registry now accepts an optional full, monotonically
sampled traction-separation curve for the exact printer/material/profile pair.
`plasticity_analyze_material_interface_test_curve` returns its measured peak,
first-segment stiffness and trapezoidal area (`MPa × mm = N/mm`) only when the
reported failure location is the tested interface. Matching
records treat conflicting curves as ambiguous. These are measured-curve
summaries only: the stiffness can include fixture-compliance and sampling
effects, and the results are not automatically converted into Code_Aster
`RUPT_FRAG` inputs or a mixed-mode failure law. Code_Aster's official manuals
document cohesive laws and prescribe resolving the cohesive process zone with
the mesh; solver support and a bundled crack test alone do not qualify a
printed part.

The registry also stores full vector traction-separation curves from mixed-mode
tests as separate normal/tangential separation and traction components. The
curve analyzer integrates componentwise work and reports tangential energy
fraction, preserving the raw evidence hash and locator. The read-only
`plasticity_calibrate_turon_mixed_mode_law` tool fits a candidate `ETA_BK` from
same single-material print process on both sides, same-interface-normal DCB/ENF and at least two MMB records
with distinct measured energy fractions. It returns per-sample residuals and
source record IDs; it does not choose a fit-quality threshold or infer the
initial penalty stiffness `K`. The fit is a calibration candidate requiring
engineering review against measurement uncertainty, not a qualified material
law or strength result. The public cohesive FEA tool now has an experimental
mixed-mode Turon route that recalibrates the same immutable records and takes
an explicit, traceable `K`; no live MCP run with registered physical records
has yet been performed.

On the target Apple Silicon Mac, Docker successfully ran `linux/amd64` under
emulation. The Code_Aster 15.2 image used for this feasibility check is pinned
to digest `sha256:b4a2bf82ef4c52a719187bb6b3c7f6d0ac512da7a66a8bada4bf0c857b104810`.
Its public build recipe identifies the upstream Code_Aster 15.2 source archive;
the container is not published by the Code_Aster project. Treat it as an
experimental acceptance dependency, not yet as the production solver backend.

Run the isolated, network-disabled official regression family with:

```sh
npm run accept:code-aster-czm
```

The command runs the bundled `SSNV199A` through `SSNV199D` tests and `SSNP118S`
on Code_Aster 15.2, plus cohesive regressions on 17.4; each runs in a fresh
pinned container. It requires successful solver exits plus the reference-check
counts expected for each official case. SSNV199A–D exercise 3D cohesive-zone
joint elements and regularized laws. SSNP118S exercises the prismatic
`3D_INTERFACE_S` formulation with `CZM_EXP_MIX`; its bundled reference checks
pass with Code_Aster 15.2. This establishes that the pinned solver can run that
mixed-interface formulation on the target host. It does not validate this
MCP's quadratic Plasticity CAD-to-mesh path, calibrated mode-II or mixed-mode
properties, or a strength prediction for a printed part.

On 2026-09-24, the complete command passed with SSNV199A–D at 8/6/6/6
reference checks and SSNP118S at 8. The runner used the pinned image digest
above, `linux/amd64`, disabled networking, and separate containers per test.

The `SSNP118S` case is a solver capability regression, not a mode-II
qualification: its bundled loading is mode I and it checks the tangential
response remains zero for that case. The v15 `RUPT_FRAG` material interface
exposes one `GC` and one `SIGM_C`; `RIGI_GLIS` is documented as slip-mode
stiffness, not as independent measured mode-II strength or fracture energy.
Therefore, do not substitute the stored interface-shear curve into this law
or describe `CZM_EXP_MIX` acceptance as a validated shear-strength model. The
new v17.4 Turon deck builder maps the calibrated mode-I/mode-II peaks, fracture
energies and BK exponent into `CZM_TURON`, while requiring the initial stiffness
K to be supplied separately. Its nonlinear 3D response is exercised below;
this does not qualify the law or establish part strength.

The v17.4 bundled regressions now run in the same isolated acceptance command
using the pinned `simvia/code_aster` image digest
`sha256:d8d19ea91989eac0d38195bc5795c54c69f530f7196f53d67697ffa57c9106d5`.
`SSNV110D` exercises mixed-mode MMB loading and `SSNV110E` exercises pure
Mode II ENF loading for `CZM_TURON`; both passed their bundled reference checks
on 2026-09-24. These are 2D `D_PLAN` / `PLAN_JOINT` solver regressions. They
prove the selected solver has laws and formulations suitable for further
investigation, not a physical qualification of cohesive properties. The public
cohesive analysis can run its experimental Turon route from measured
DCB/ENF/MMB records, and can opt into separate bulk tensors stored on the
exact-process coupon records. It still models one planar interface only. It
does not resolve individual printed layers or roads, or direction-dependent
interface behavior. The orthotropic bulk model is homogeneous and is not a
layer-by-layer delamination calculation.

The same acceptance command also runs official v17.4 `SSNP118H/I` and
`SSNS110A/B`. H/I exercise 3D quadratic `3D_INTERFACE_S` cohesive formulations
with `CZM_TAC_MIX`; each passed 20 reference checks. A/B exercise
`3D_INTERFACE` with `CZM_LAB_MIX` and `CINEMATIQUE='GLIS_1D'`; they passed 2
and 6 reference checks. `GLIS_1D` restricts interface slip to one local axis,
but these A/B tests describe a steel-concrete bond and do not define a general
polymer cohesive law or independent Mode-II/Mode-III allowables. The current
Plasticity MCP does not use these formulations; adopting a 3D mixed-interface
law would require a quadratic, conforming interface-mesh path and a separate
material calibration/acceptance design.

The full acceptance command `npm run accept:code-aster-czm` also builds a
synthetic 3D mesh with 48 tetrahedra
on each side of one interface and eight linear PENTA6 `3D_JOINT` elements. It
assigns different isotropic elastic materials to the two solids, then applies a
gradual combined normal/tangential displacement using mixed line search. The
MED output is read back and the acceptance fails unless `CZM_TURON` reports a
non-zero damage variable (`V3`) and a damaged interface state (`V5`) at the
final step. This exercises an actual mixed-mode damage response on the current
linear 3D joint-element topology. The properties and coupon geometry remain
synthetic; this is a solver acceptance check, not a benchmark against a
physical specimen or material qualification. The focused solver check is
`npm run accept:code-aster-turon-3d`. `scripts/verify-code-aster-czm.ts` builds
the job through `buildCodeAsterTuronDeckFromCalibration`; `scripts/fem/` holds
the mesh fixture and MED damage verifier.

A focused acceptance sends separate `ELAS_ORTH` bulk tensors and confirmed
local frames to the two 3D regions. The same mapping is now exercised by the
public mixed-mode MCP route using immutable exact-process coupon records; an
in-memory MCP test confirms side assignment and report persistence. The focused
`npm run accept:code-aster-turon-orthotropic` job completed on the same pinned
v17.4 solver and read back non-zero cohesive damage. Its synthetic acceptance
uses a lower interface peak to exercise damage with the softer orthotropic
bulk fixture; it is not a physical comparison or validation of Euler-axis
mapping. Live MCP operation against the user's registered physical coupon and
interface records remains untested. The homogenized model will not represent
individual roads or separate layer interfaces.

## Current multi-plane layer-stack support (2026-09-24)

The cohesive MCP input now accepts 1..32 ordered parallel split planes with
arbitrary global normals. Gmsh fragments the current STEP Solid into one
volume band per interval, alternates only the solver's region group labels A/B, and creates a separate
physical interface-surface group at every requested plane. The converter
duplicates the interface nodes and inserts PENTA6 elements across all declared
groups. The A/B labels never represent different materials: the route binds the
same process, coupon, bulk constants and material axes on both sides. Reports
preserve each plane's physical tag, native surface entities and interface
triangle count.

Multiple planes are limited to one measured `same-material-layer` process; the
same measured cohesive law is repeated at each cut. The public analysis route
rejects all `dissimilar-material-bond` records, including a single interface,
before meshing. It does not infer layer locations from a print profile or infer
anisotropic directions from the CAD shape. Test-interface normals must align
with the requested plane normal within one degree. The material-side region
labels alternate between intervals, so this repeated-layer assumption is
meaningful only when both sides resolve to the same exact process and coupon
evidence.

The acceptance command `npm run accept:cohesive-layer-stack` runs Gmsh 4.15.2
and both supported Mode-I solver routes on a synthetic 10 mm cube with two
internal planes. The TypeScript mesh wrapper produced three tetrahedral
regions, two separate interface groups and 28 PENTA6 elements; bottom and top
face signatures mapped successfully. The default isotropic run used Code_Aster
15.2.0; the optional homogeneous orthotropic run used the pinned Code_Aster
17.4.0 image, with identical tensor and confirmed frame assigned on both sides
of each interface. Both returned all 28 cohesive-element states over 101
increments. The 17.4 result path filters state output to the cohesive group and
accepts Code_Aster's renumbered mesh-cell IDs. This verifies STEP
fragmentation, group assignment, mesh conversion, solver execution and result
parsing for the two one-material routes. The test coupon and loading values are
synthetic; the initial solver-only acceptance is not a live Plasticity session
and does not use registered physical records. The solver acceptance now rotates
the cube 45° around global Y, meshes two tilted interfaces with normal
[0.7071, 0, 0.7071], and completes both isotropic 15.2 and same-material
orthotropic 17.4 routes. The prescribed 0.001 mm normal opening is recovered
from the dominant global displacement component after projection. This remains
software integration evidence only. The public Plasticity MCP acceptance now
also rotates a native bracket 45° about global Y, records same-process coupon
and layer-test fixtures for the matching `[0, 45, 0]` process orientation, and
completes the orthotropic 17.4 cohesive analysis across two oblique interfaces.
It restores the empty document with four Undo steps. Evidence:
`[local acceptance artifact omitted]`.

Sources:

- [Code_Aster v17 R7.02.21: CZM_TURON cohesive behavior](https://docaster-en-codeaster-doc-4113bb35b8213385c636b94f1536856d7f617.gitlab.io/manuals/man_r/r7/r7.02.21/index.html) — documents one normal and one tangential law parameter; Mode II and Mode III use the same tangential properties.
- [Code_Aster v15 U3.13.14: joint and interface finite-element models](https://code-aster.org/doc/v15/man_u/u3/u3.13.14.pdf)
- [Code_Aster v15 U2.05.07: cohesive-zone modeling guidance](https://code-aster.org/doc/v15/man_u/u2/u2.05.07.pdf)
- [Code_Aster v15 U4.43.01: material definitions including RUPT_FRAG](https://code-aster.org/doc/v15/man_u/u4/u4.43.01.pdf)
- [Code_Aster U2.05.07: cohesive-zone model guidance](https://code-aster.org/doc/v17/manuals/man_u/u2/u2.05.07/index.html)
- [Code_Aster U4.51.11: cohesive behavior relations](https://code-aster.org/doc/default/en/man_u/u4/u4.51.11.pdf)
- [Code_Aster v17 U4.43.01: cohesive laws and GLIS_1D kinematics](https://code-aster.org/doc/v17/manuals/man_u/u4/u4.43.01/Comportements_li_s___l_endommagement_et_la_rupture.html)
- [Code_Aster v17 U2.03.07: behavior/model compatibility](https://code-aster.org/doc/v17/manuals/man_u/u2/u2.03.07/Lois_de_comportement_possibles_pour_les_calculs_mecaniques_statiques_ou_dynamiques.html)
- [Code_Aster R7.02.19: cohesive-element modeling and mesh guidance](https://code-aster.org/V2/doc/v13/fr/man_r/r7/r7.02.19.pdf)
- [scimulate/code_aster image recipe and license](https://github.com/scimulate/code_aster)
- [scimulate/code_aster 15.2 image tag](https://hub.docker.com/r/scimulate/code_aster/tags)
