# Strength method passports

All public lengths are millimetres, forces are newtons and stresses/moduli are
megapascals (`1 MPa = 1 N/mm²`). Local `x` follows member length `L`, local `y`
follows section height `h`, and local `z` follows section width `b`.

These are product method limits for Plasticity MCP v1, not universal design-code
limits. These methods do not verify attachments, local stress concentrations, shear
strength, impacts, fatigue, creep, temperature effects or the whole bracket.

## `axial-rectangle-v1` 1.0.0

Scope: a straight, constant, solid-equivalent rectangular member under static
axial tension. Area `A = b h`, nominal stress `σ = F/A`, and elastic extension
`δ = F L/(E A)`. Nominal stress is compared with
`tensileLimit/safetyFactor`; extension is compared with the explicit displacement
limit. Compression, buckling, holes, variable sections and local load transfer
are unsupported.

Required confirmations: static loading, small-strain linear elasticity and a
homogeneous-equivalent constant rectangular section. Printed-material values
must match the printer profile, orientation and effective section to produce a
non-conditional pass.

Formula sources: [TU Delft axial loaded members](https://ocw.tudelft.nl/course-readings/axial-loaded-members-summary-key-formulas-2/)
and [MIT 2.002 Mechanics and Materials II](https://ocw.mit.edu/courses/2-002-mechanics-and-materials-ii-spring-2004/9aebe9fc6669d928aa716a5033cc9c9f_lab_1_s04.pdf).

## `cantilever-tip-rectangle-v1` 1.0.0

Scope: a straight, constant, solid-equivalent rectangular cantilever with an
ideal fixed end and one static transverse force at the free end. Second moment
`I = b h³/12`, peak surface stress `σ = 6 |F| L/(b h²)`, and Euler-Bernoulli tip
deflection `δ = |F| L³/(3 E I)`. Equal tensile/compressive surface magnitudes are
checked against the smaller of their two allowable limits after the explicit
safety factor. Force sign is retained in the input while peak outputs are
magnitudes.

The v1 product gate requires `L/h >= 20` and calculated `δ/L <= 0.01`.
Required confirmations add ideal support, negligible shear deformation and no
lateral instability within the idealization. Distributed or multiple loads,
holes, variable sections, torsion and local load transfer are unsupported.

Formula sources: [MIT 2.002 Mechanics and Materials II](https://ocw.mit.edu/courses/2-002-mechanics-and-materials-ii-spring-2004/9aebe9fc6669d928aa716a5033cc9c9f_lab_1_s04.pdf)
and [Purdue ME323 cantilever table](https://www.purdue.edu/freeform/me323/wp-content/uploads/sites/2/2018/10/ME323_F18_Hw7_final.pdf).

## `simply-supported-plate-uniform-pressure-v1` 1.0.0

Scope: one flat homogeneous-isotropic-equivalent rectangular plate of constant
thickness, under static uniform pressure normal to its plane, with all four
edges explicitly confirmed as ideal simple supports. The implementation sums
the odd-term Navier double Fourier series through index 401. It reports centre
deflection, both centre bending moments per unit length, both surface stress
components and the governing stress magnitude.

Flexural rigidity is `D = E t³/[12(1−ν²)]`; surface stresses are
`σx = 6Mx/t²` and `σy = 6My/t²`. Because opposite surfaces exchange tension
and compression, the governing stress is checked against the smaller allowable
tensile or compressive limit. The shorter clear span must be at least ten times
the thickness and calculated centre deflection must not exceed half the
thickness. These are explicit product applicability gates, not a design code.

The method requires measured or sourced Poisson-ratio evidence for the selected
material/process. It excludes clamped, free or compliant edges; openings, ribs,
bosses, fillets, curvature and varying thickness; partial or concentrated
pressure; large-deflection membrane action; local support transfer; buckling,
fatigue, creep, impact, layer delamination and whole-enclosure validation. A
separate native rectangular prism or one plain integral rectangular enclosure
wall can be geometry-verified. The wall inspector requires exact opposed planar
faces on one Solid, opposing normals, aligned centroids and rectangular line
loops. Opposed outlines must match or differ by exactly one measured wall
thickness on every inset span; the reported panel spans are the mean of the two
face spans. No support, load, material, opening, rib or whole-enclosure behavior
is inferred from geometry. This is not a general shell method.

Formula and benchmark sources: [NASA forced response of beams and plates](https://ntrs.nasa.gov/api/citations/19760066879/downloads/19760066879.pdf)
and [NASA nonlinear uniformly loaded rectangular-plate design curves](https://ntrs.nasa.gov/citations/19790044251).

## `euler-column-buckling-v1` 1.0.0

Scope: one straight, prismatic, solid-equivalent rectangular column under
centred static axial compression. The force input is negative for compression.
The method selects the smaller centroidal second moment of area,
`Imin = min(b h³, h b³)/12`, computes `A = b h`, `r = sqrt(Imin/A)`,
`Le = K L`, `λ = Le/r`, and the ideal elastic critical load
`Pcr = π² E Imin/Le²`. The reported outputs include Euler buckling utilization
and nominal crushing utilization independently, each with the explicit safety
factor applied. The larger utilization is the governing strength utilization.

The supplied elastic limit is an applicability boundary, not a substitute for
the compressive allowable: Euler is rejected as `unsupported` if its critical
stress exceeds that elastic limit. The required effective-length factor `K`
must represent the actual end restraints and requires evidence; it is never
inferred from the shape. The calculation assumes a perfectly straight member,
centred loading, ideal restraints represented by `K`, linear elasticity and a
homogeneous-equivalent rectangular section. It excludes eccentricity,
initial curvature, transition/inelastic buckling, local plate or shell modes,
torsional modes, intermediate restraints, joints, print anisotropy, creep,
fatigue, impact and structural-code compliance. This is an ideal column check,
not a whole-part validation.

Formula and applicability sources: [NASA Column Buckling, Structures Manual](https://ntrs.nasa.gov/api/citations/19930013915/downloads/19930013915.pdf)
and [MIT Euler Column Buckling lecture](https://ocw.mit.edu/courses/2-002-mechanics-and-materials-ii-spring-2004/bc25a56b5a91ad29ca5c7419616686f7_lec2.pdf).

## `single-fastener-plate-v1` 1.0.0

Scope: one static in-plane load transferred by one through fastener in a flat,
constant-thickness rectangular plate. Exact opposed native faces must prove one
rectangular outer boundary and one circular through-hole. The load direction
selects the loaded edge. The inspector measures thickness `t`, hole diameter
`d`, centre-to-loaded-edge distance `e`, gross transverse width `w`, the
opposite edge distance and both side clearances without display or mesh bounds.

The method checks projected bearing `σb = F/(dt)`, conservative two-plane
edge shear-out `τ = F/[2t(e−d/2)]`, and nominal net-section tension
`σn = F/[t(w−d)]`. Each is compared with its own sourced or measured
material/process allowable after the explicit safety factor. Bearing is never
silently substituted from compressive strength. NASA identifies `e/d = 2` as
common nominal practice and advises against `e/d < 1.5`; this passport marks
`1.5 ≤ e/d < 2` conditional and rejects the simpler model below 1.5.

Required confirmations: static in-plane load, one-fastener load path, load
centred through thickness, homogeneous-equivalent plate behavior and nominal
bearing contact. Fastener strength, preload, clearance, joint slip, fatigue,
creep, impact, plate bending, prying, pull-through, washers, inserts, threads,
multiple-fastener interaction, printed-layer failure and structural-code
compliance remain unchecked.

Formula sources: [NASA Fastener Design Manual](https://ntrs.nasa.gov/citations/19900009424)
and [NASA Preloaded Joint Analysis Methodology](https://ntrs.nasa.gov/citations/19960012183).

## `fastener-group-plate-bearing-v1` 1.0.0

Scope: a statically loaded group of at least two through-fasteners in one exact,
constant-thickness rectangular plate. The native inspector requires matching
opposed planar faces, through-holes, and the same revision-bound cylindrical
hole identities as the elastic in-plane group-load result. Exact B-rep geometry
supplies plate thickness `t`, each hole diameter `dᵢ`, and rectangular edge and
pair clearances. The load-distribution model separately requires a rigid
attachment and equal in-plane fastener stiffness; it does not model slip or
clearance take-up.

The local projected-bearing screen calculates `σᵢ = |Fᵢ|/(dᵢ t)` for each
elastic per-fastener resultant. Its bearing design allowable must be separately
traceable, already factored, and matched to the exact plate material and print
configuration. Bearing is not inferred from tensile or compressive strength.

Optional `netTension` requires a separate external plate tensile resultant,
local X or Y load axis, exact traceable tensile design allowable, and explicit
confirmation of uniform membrane tension, centered through-thickness loading,
and a straight transverse failure path. The implementation minimizes net width
across all parallel cuts normal to the selected axis by subtracting exact
circular-hole chord widths. It calculates `Aₙ = t bₙ` and `σₙ = P/Aₙ`. The
plate resultant is never inferred from the fastener-group demands.

Optional `edgeShearOut` applies the single-fastener nominal two-plane expression
`τᵢ = |Fᵢ|/[2t(eᵢ − dᵢ/2)]` independently to each fastener only when its
in-plane resultant aligns with local X or Y and the exact loaded rectangular
edge is measured. Vectors outside those axes and `e/d < 1.5` are unsupported;
`1.5 ≤ e/d < 2` remains conditional. Each check needs its own traceable,
already-factored shear allowable matched to the plate configuration.

Every reported ratio is a bounded local screen, not a complete plate or joint
pass. Angled or staggered net-section paths, compression-side buckling,
shared-ligament interaction between nearby holes, bearing-bypass interaction,
load redistribution, plate bending, out-of-plane forces, prying, fastener
strength, inserts, threads, fatigue, creep, impact, temperature, print-layer
failure and structural-code compliance remain unchecked. If the straight-cut
net-section screen is not explicitly requested, multi-hole net tension also
remains unchecked. NASA's fastener-group guidance notes that clearance and hole
position tolerances prevent equal load sharing in general and describes metal
practice; it does not qualify a printed-polymer strength model. Live acceptance
uses synthetic allowables solely to verify tool behavior, never as material data.

For user-run physical tests, `plasticity_record_fastener_group_test` stores the
exact printer/material/profile identity, rectangular specimen dimensions,
measured hole coordinates and diameters, fixture, fastener clearance, load
axis, individual peak loads, observed failure modes and traceable report
locators. `plasticity_match_fastener_group_test` requires an exact match of the
entire recorded geometry and fixture; input ordering of holes is normalized.
Conflicting outcomes return `ambiguous`. This is an immutable evidence
registry, not a method for extrapolating a test to a different part. The
CAD-bound group-plate report can compare a selected record only after the exact
print process and an evidence-backed dimensional tolerance are supplied, plate
dimensions and every hole uniquely match the live B-rep within that tolerance,
and the caller confirms the fixture/load path. The report preserves signed
specimen-minus-CAD plate-dimension deltas plus maximum hole-center and
diameter deviations. Conflicting records for one
exact configuration are rejected. The report compares factored external
tension demand with the lowest observed specimen peak load. That is a
conditional test benchmark only: it does not derive a statistical design value
or allowable, does not establish a strength pass/fail and must not be used as
one. Physical specimen acceptance remains unverified until real test records
and the intended CAD workflow are exercised.

This strict scope reflects experimental findings: FDM PLA/ABS pin-bearing
specimens show failure mode and measured strength changing with width-to-hole
and edge-distance ratios, while a multi-hole PLA study reports effects from
hole spacing, plate width, raster angle and infill. These studies motivate
recording exact configuration; their measured values are not transferable to
another printer, profile, material or fixture. See [On the Pin-Bearing
Strength of Additively Manufactured Polymer Parts](https://pmc.ncbi.nlm.nih.gov/articles/PMC10097255/)
and [Experimental and numerical studies on 3D printed PLA pin
joints](https://doi.org/10.1007/s40430-025-05690-y).

Reference: [NASA Fastener Design Manual](https://ntrs.nasa.gov/citations/19900009424).

## `fastener-member-v1` 1.0.0

Scope: one physical bolt, screw or pin with an explicitly established axial
tension and transverse shear load. Inputs include nominal diameter, tensile
stress area `A_t`, effective shear area per plane `A_s`, one or two equal shear
planes, and whether the shear plane crosses the smooth shank or threads.

The method calculates `σ = F_t/A_t` and `τ = F_s/(n A_s)`. Separate sourced or
measured tensile and shear limits for the actual fastener grade and condition
produce factored load ratios `R_t = F_t SF/(A_t S_t)` and
`R_s = F_s SF/(n A_s S_s)`. Simultaneous nonzero loads also use the NASA
screening relation `R_t² + R_s³ ≤ 1`. The interaction criterion must be
explicitly accepted for the task; NASA cautions that the proper equation still
needs checking for critical applications.

Effective areas need traceable evidence and may not exceed the nominal circular
shank area. The MCP does not infer thread stress area, shear area or material
grade from nominal diameter. Required confirmations cover static loading,
known one-fastener loads, negligible bolt bending, collinear axial load, known
shear-plane count/location and inclusion of applicable preload in the axial
load.

Excluded: bending from gaps, shims, eccentricity or flange rotation; slip,
friction, clamp loss and redistribution; thread stripping, tapped-hole or
insert pull-out and head pull-through; failure of joined members; fatigue,
vibration, creep, impact, temperature, corrosion, multiple-fastener groups and
structural-code compliance. Sources: [NASA Fastener Design
Manual](https://ntrs.nasa.gov/citations/19900009424), [NASA Preloaded Joint
Analysis Methodology](https://ntrs.nasa.gov/citations/19960012183), and [NASA
interaction-equation derivation](https://ntrs.nasa.gov/citations/20150002750).

## `tongue-root-transverse-v1` 1.0.0

Scope: root-only screening of a rectangular prismatic tongue idealized as a
cantilever under one transverse point load at a known lever arm. The input
records root width and bending thickness, load, effective Young's and shear
moduli, tensile and shear allowables, shear correction factor, safety factor,
displacement limit, printer ID, immutable printer/process/filament profile
hash, print orientation, infill, temperature and effective-section
qualification. Geometry, load, properties and correction factor require
traceable evidence tied to the current print orientation and process. A
profile or orientation change makes the stored report stale.

The method calculates root bending stress `6 F L/(b h²)`, maximum rectangular
transverse shear `3 F/(2 b h)`, and tip deflection as Euler-Bernoulli bending
`F L³/(3 E I)` plus Timoshenko shear `F L/(κ G A)`, with `I = b h³/12`. It
checks these against the supplied factored material allowables and displacement
limit. Even when all ratios are at or below one, the result is `conditional`:
it only screens this idealized root and never passes the complete
tongue-and-groove joint.

Groove-wall bearing or splitting, contact-pressure distribution, root stress
concentration and notch sensitivity, three-dimensional load introduction,
combined stress interaction, mating-part strength, print defects, fatigue,
creep, impact and whole-joint safety are excluded. The beam idealization and
effective material properties must be appropriate for the actual geometry and
print orientation. The coefficient `κ` is not assigned a universal default;
different derivations produce different shear factors, as discussed in
[Cowper's derivation for Timoshenko beam theory](https://doi.org/10.1115/1.3625046).
Formula references: [MIT OCW, transverse loading of
slender structural elements](https://ocw.mit.edu/courses/16-001-unified-engineering-materials-and-structures-fall-2021/mit16_001_f21_lec22lec23lec24.pdf)
and [MIT OCW, stresses in beams](https://ocw.mit.edu/courses/3-11-mechanics-of-materials-fall-1999/96d839b02e4a6c63cf8031800e89cccd_MIT3_11F99_bstress.pdf).

The exact B-rep acceptance also checks that a live rectangular section can
replace scenario width and thickness, that the report remains bound to its
section plane/topology, and that report freshness re-reads the live section.
Its mechanical properties and load are synthetic acceptance inputs, not
physical material qualification. The live acceptance was run on Plasticity
26.1.3; it restored the initially empty document after the disposable test.

## `heat-set-insert-retention-v1` 1.0.0

Scope: one installed heat-set insert with the worst-case axial pullout and
torque demand already resolved to that insert. The immutable configuration
records insert ID and thread, insert length and pitch, hole diameter and depth,
host material, printer/profile, orientation, heat or ultrasonic installation,
and installation process ID.

The method compares factored per-insert demand with explicit pullout and
torque-out capacities. Capacities require measured evidence or a sourced record
with URL and hash. `matched` means the qualification covers the complete
configuration. Manufacturer data for another resin, moulding process, print
profile, orientation, hole or installation process stays `unconfirmed` or
`mismatch`; the MCP does not transfer it silently.

Pullout and torque are checked independently. When both demands are nonzero,
the result stays conditional because this passport has no validated interaction
equation. Hole depth below `insert length + 2 × thread pitch` also stays
conditional. This guidance and the need for a flush installation without screw
bottoming follow the manufacturer's heat/ultrasonic hole recommendations.

Excluded: combined pullout/torque interaction; transverse shear, bearing,
prying and host-part bending; boss splitting, local cracking and layer
delamination; thread stripping and screw failure; installation defects,
fatigue, vibration, creep, impact, thermal cycling, aging, multiple-insert load
distribution and structural-code compliance. Sources: [SPIROL Inserts for
Plastics Design Guide](https://www.spirol.com/assets/files/ins-threaded-inserts-design-guide-us.pdf)
and [SPIROL heat/ultrasonic hole design
guidance](https://www.spirol.com/resources/white-papers/how-to-design-the-proper-hole-for-heat-ultrasonic-inserts/).

## `fastener-group-elastic-in-plane-v1` 1.0.0

Scope: two or more distinct in-plane fastener transfer points on a rigid
attachment, with identical in-plane fastener stiffness. The input supplies all
point coordinates, an in-plane force, its point of application and a free
moment in one common frame. The method finds the group centroid and the total
moment about it.

Each fastener receives the direct share `[Fx/n, Fy/n]`. With centroid offsets
`[xᵢ, yᵢ]`, polar sum `Jg = Σ(xᵢ² + yᵢ²)` and total in-plane moment `M`, its
moment share is `[-M yᵢ/Jg, M xᵢ/Jg]`. The report gives both shares, the
resultant vector and magnitude for every fastener, the governing shear demand,
and numerical force/moment equilibrium residuals. It distributes the supplied
load without a safety factor; the downstream capacity check applies that factor
exactly once. Coincident transfer points are unsupported.

The result status is `calculated`, not `pass`: this passport distributes load
but contains no capacity. Feed the per-fastener demand into the separate
fastener-member, plate-around-hole and insert checks. Required confirmations
cover static in-plane loading, a rigid attachment member, identical fastener
stiffness, no slip/clearance redistribution, correct transfer centres and a
complete load resultant.

Excluded: every component capacity; out-of-plane load, prying, flange and
fastener bending; preload, friction, slip and clearance; unequal stiffness,
compliant members and nonlinear redistribution; fatigue, vibration, creep,
impact and structural-code compliance. Source: [NASA Fastener Design
Manual](https://ntrs.nasa.gov/citations/19900009424).

## `planar-section-resultants-v1` 1.3.0

Scope: one exact planar Solid face bounded by native straight lines and circular arcs. The method resolves point forces and free moments at the measured section centroid, then calculates nominal axial and biaxial-bending normal stress from the full centroidal inertia matrix. Linear stress extrema are evaluated on the exact boundary. Public units are mm, N, N·mm and MPa.

Maximum direct shear is available only when exact topology proves one of three families and the matching material/process has a sourced or measured shear limit: `1.5 V/A` for a solid rectangle, `4 V/(3 A)` for a solid circle, or `4 V/(3 A) · (R² + Rr + r²)/(R² + r²)` for a concentric circular annulus. The result records `shearModel`. A perforated rectangle, eccentric circular hole or other section remains unsupported. An annulus retains the existing conditional warning for local stress concentration and net-section fracture at an inner boundary.

Maximum elastic torsional shear remains available for a proven solid circle or concentric circular annulus as `|T|R/J`, where `J = Ixx + Iyy`. Version 1.3.0 also supports an exact, uniform-thickness, axis-aligned rectangular single-cell wall with one centered rectangular void. It uses the Bredt-Batho thin-wall idealization: `q = |T|/(2 A_m)` and `τ = q/t`, where `A_m` is the area enclosed by the wall median line and `t` is the measured uniform thickness. The result records the median area, thickness, shear flow and nominal wall shear, and requires explicit confirmation that the wall is thin relative to the cell dimensions, the applied torque does not distort the cell, and end restraints do not govern. It does not calculate twist because no configuration-matched shear modulus and member length are part of this section input. Other box shapes, multiple cells, nonuniform or eccentric walls, openings along the member, distortion, warping restraint and combined transverse shear remain unsupported. See [MIT 16.20 thin-walled closed-section notes](https://ocw.mit.edu/courses/16-20-structural-mechanics-fall-2002/a58ea050460c29f7389ff55e084521ed_ho3.pdf).

Inner loops retain nominal normal stress but make the result conditional because local stress concentration and net-section fracture are unchecked. Concave outer boundaries are also conditional. Deflection, support compliance, buckling, fatigue, creep, impact, joints, bearing, tear-out, layer delamination and structural-code compliance remain unchecked. A face-bound result proves only the current section geometry; it is not whole-part validation.

Required confirmations: static loading, a homogeneous-equivalent section, and that the selected section resultants represent the real load path. Formula sources: [MIT 2.002 Mechanics and Materials II](https://ocw.mit.edu/courses/2-002-mechanics-and-materials-ii-spring-2004/9aebe9fc6669d928aa716a5033cc9c9f_lab_1_s04.pdf), [Purdue ME323](https://www.purdue.edu/freeform/me323/wp-content/uploads/sites/2/2020/03/HW5solution.pdf), [University of Washington ME354](https://courses.washington.edu/me354a/salient.pdf), [Missouri S&T circular-section torsion notes](https://web.mst.edu/jthomas/classes/2210/fe_review/guides/2013.07.26.pdf) and [UAH mechanics of materials](https://www.uah.edu/images/administrative/student-success-center/resources/handouts/handouts_2019/mechanics_of_materials_axial_loads_and_torsion.pdf).
