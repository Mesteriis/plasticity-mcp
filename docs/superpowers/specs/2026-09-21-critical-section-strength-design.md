# Plasticity MCP: strength at an exact critical section

Status: design for review, 2026-09-21.

Implementation note: the original 1.0.0 rectangle-only direct-shear scope below
is retained as the historical baseline. Version 1.1.0 adds exact solid-circle
and concentric-circular-annulus families as specified in
`2026-09-21-circular-section-shear-design.md`.

Roadmap note: circular torsion is complete in version 1.2.0. The next accepted
increment is the separate `simply-supported-plate-uniform-pressure-v1`
passport described in `2026-09-21-rectangular-plate-strength-design.md`.

## 1. Purpose

Extend the existing strength-first workflow from whole constant rectangular
members to a selected critical section of a mechanical part. The intended
parts are brackets, plates, bosses and enclosure features whose load path can
be reduced to section resultants at one existing planar face.

The MCP will read the face from Plasticity's native B-rep, calculate nominal
section properties, transform explicit point forces and free moments into that
section frame, and evaluate axial plus biaxial-bending normal stress. It will
also evaluate direct transverse shear only when the section is proven to be a
solid rectangle. The result remains bounded engineering evidence rather than a
claim that the entire part, attachment or print has passed.

This is the next ordered increment toward broader Plasticity automation. It
does not add another CAD system, browser service or Workbench dependency.

## 2. Selected approach

The first version uses an existing planar B-rep face as the section. This path
is read-only, revision-bound and inspectable through the same native geometry
adapter already used by the rectangular-member verifier.

Two alternatives are deferred:

- Plasticity's section-analysis command can expose an arbitrary cutting plane,
  but it creates temporary application state and has not yet been proven safe
  through the public MCP lifecycle.
- A render-mesh section is easier to obtain, but it cannot provide the exact
  geometric evidence required by this project.

The face-bound method deliberately returns `unsupported` when it cannot prove
the face topology. It never falls back to display bounds or a mesh.

## 3. Scope and applicability

The new versioned method passport is `planar-section-resultants-v1`.

Supported inputs are:

- one exact planar face on a current Solid;
- a caller-supplied in-plane X direction; the face normal and X direction form
  a right-handed orthonormal section frame;
- one or more point forces in world coordinates, each with a world-space point
  of application;
- zero or more free moments in world coordinates;
- tensile and compressive material limits, safety factor and evidence;
- an optional shear limit when a supported rectangular shear check is needed.

The method calculates:

- section area and centroid;
- centroidal `Ixx`, `Iyy` and `Ixy`;
- principal moments and principal-axis angle;
- resultant axial force, two transverse forces, two bending moments and
  torsional moment at the section centroid;
- nominal normal-stress extrema from combined axial force and biaxial bending;
- maximum direct shear for a proven solid rectangle;
- utilization against tensile, compressive and, when applicable, shear limits.

The following stay explicitly outside the first section method:

- torsional stress or twist;
- direct-shear distribution for a holed or otherwise arbitrary section;
- deflection of an arbitrary member;
- local stress concentration, bearing, tear-out and net-section fracture
  factors around holes and notches;
- welds, screws, inserts, contact, attachment pull-out and support compliance;
- buckling, fatigue, creep, impact, thermal effects, layer delamination and a
  structural design code.

A nonzero unsupported resultant does not disappear from the report. Torsion,
or transverse shear on a non-rectangular section, makes the overall result
`unsupported` while retaining the verified geometry and any calculated nominal
normal-stress values. Inner loops or concave boundaries keep a normal-stress
result at most `conditional` because local stress concentration is unchecked.

## 4. Exact section geometry

The public reference contains `sessionId`, `documentToken`, `revision`,
`bodyId` and `faceId`. A different session, document, revision, body version or
face identity invalidates the reference.

The native adapter must prove all of the following before returning a verified
section:

1. The selected stable body exists once and is a Solid whose native `Check()`
   result is clean.
2. The selected topology ID resolves to exactly one face of that body.
3. The face is planar and its native normal is finite.
4. Its boundary can be reconstructed into closed, non-self-intersecting loops
   with consistent edge/vertex incidence.
5. Every boundary edge is a native line or circular arc/full circle. Ellipses,
   NURBS and unknown curves return `unsupported` in this version.
6. Loop containment yields one outer loop and zero or more inner loops. An
   ambiguous or disconnected face is rejected.
7. The document and revision are unchanged after topology collection.

Coordinates are projected from native world-space millimetres into the section
frame. Pure functions integrate line and circular-arc boundary contributions
with Green's theorem. No render tessellation participates. Inner loops subtract
area and moments. Results include:

```ts
interface SectionProperties {
  areaMm2: number;
  centroidMm: [number, number, number];
  centroidLocalMm: [number, number];
  ixxMm4: number;
  iyyMm4: number;
  ixyMm4: number;
  principal: {
    majorMm4: number;
    minorMm4: number;
    angleDegrees: number;
  };
  outerLoopCount: 1;
  innerLoopCount: number;
  boundaryKinds: Array<"line" | "circle">;
  rectangular: boolean;
  topologySignature: string;
  source: "native-brep-boundary";
}
```

The implementation tolerance for native coincidence and loop closure remains
far below the public 0.01 mm dimensional acceptance tolerance. Degenerate area,
a non-positive principal moment or a near-singular inertia tensor is rejected.

## 5. Loads and sign conventions

Loads are physical inputs with evidence, not values inferred from an image.
Each point force has a finite world-space vector in newtons and a finite
world-space point in millimetres. Each free moment is a finite vector in N·mm.
The calculation sums them deterministically at the measured section centroid:

```text
F = Σ Fi
M = Σ ((pi - centroid) × Fi) + Σ Mi
```

The result is projected onto the section basis `(x, y, n)`. Positive axial
force along `n` is tension. `Vx` and `Vy` are transverse resultants. `Mx` and
`My` are bending moments. `T = M·n` is torsion and is unsupported when nonzero
beyond a small absolute numerical tolerance.

Input evidence assignments cover every force vector, application point, free
moment, material property and safety factor. Derived resultants cite their load
records. A mass becomes a force only through the existing explicit-gravity
derivation.

## 6. Stress calculation and outcomes

Normal stress is evaluated from the general unsymmetric-bending relation using
`A`, `Ixx`, `Iyy`, `Ixy`, `N`, `Mx` and `My`. The inertia determinant must be
positive. Because the stress field is linear in section coordinates, its exact
minimum and maximum occur on the boundary. Lines use their endpoints; circular
arcs additionally test any stationary directions lying on the arc.

The report preserves signed minimum and maximum normal stress and separately
compares tension and compression magnitudes with their allowed values divided
by the safety factor.

For a section proven to be a solid rectangle, direct transverse shear is
checked at the centroid using:

```text
tau_max = 1.5 * hypot(Vx, Vy) / A
```

This check requires a sourced shear limit for the same material, printer
profile and orientation. It is not used for a face with holes, concavity or a
non-rectangular outer loop. Normal and shear utilization are reported
separately; no von Mises, maximum-strain or other interaction criterion is
invented without a matching material failure model.

Outcome precedence remains consistent with the existing engine:

1. unsupported nonzero resultant or geometry → `unsupported`;
2. missing required numeric/evidence input → `needs-input`;
3. any evaluated utilization above one → `fail`;
4. unconfirmed material/process/assumption or stress-concentration scope →
   `conditional`;
5. otherwise → `pass` within the listed checked scope.

Failed checks and unsupported or unknown conditions remain visible together.
A partial normal-stress number is never promoted into an overall pass when a
materially relevant load component is unsupported.

## 7. Contracts, storage and freshness

Section inputs and results form a separate discriminated contract rather than
making rectangular-member fields optional. The immutable store will accept a
versioned union of rectangular and planar-section reports. Existing report
files remain readable without migration.

An unbound calculation is labelled a scenario. Only native verification may
store a `SectionBinding`. The verification tool replaces any caller-supplied
section properties and centroid with freshly measured values, appends measured
evidence and recalculates.

A section report becomes stale when any of these change:

- load or material input hash;
- printer, profile or orientation evidence;
- MCP session, Plasticity document or revision;
- body or face identity;
- native topology signature.

After restart, a stored face-bound report is `unverified` until the server
connects to Plasticity and re-reads its identity. No record is overwritten and
no analysis or CAD action is retried automatically.

## 8. MCP interface

The following tools are added:

| Tool | Role |
| --- | --- |
| `plasticity_inspect_planar_section` | Read and verify exact current native section properties from `bodyId`, `faceId`, `revision` and `xDirection`. |
| `plasticity_calculate_section_strength` | Calculate and persist an unbound scenario from explicit section properties and loads. It never treats caller geometry as independently verified. |
| `plasticity_verify_section_strength` | Re-read the face, replace scenario properties with native measurements, calculate and store a bound report. |

`plasticity_strength_methods` lists the new passport.
`plasticity_strength_report` reads either report kind and performs the
appropriate freshness check. Existing rectangular tools keep their current
schemas and behavior.

All three new tools are non-mutating with respect to Plasticity. Scenario and
verification tools write immutable local records. None authorizes a CAD change
or print. Public tools accept IDs and structured values, never store paths or
arbitrary JavaScript.

The strength prompt and resources tell the agent to:

1. establish the real load path and ask only for unresolved physical facts;
2. select an existing critical planar face or explain why no supported section
   exists;
3. show the selected face, loads, unchecked scopes and proposed calculation in
   Codex chat;
4. calculate without changing CAD;
5. after an accepted CAD edit or manual user edit, re-read the exact face and
   recalculate;
6. avoid presenting nominal section stress as whole-part validation.

Workbench remains optional.

## 9. Failure handling

Geometry is collected under the current owned Plasticity session. A stale
revision before the read is rejected. A revision or document change during the
read discards all collected evidence. No retry occurs automatically.

Unknown topology, unsupported curves, invalid loops, singular properties,
non-finite loads and invalid provenance return stable structured issue codes.
Errors are bounded and never include native object dumps, credentials or full
Codex prompts.

The operation has no native transaction because it is read-only. It does not
create a section plane, measurement object or construction body and therefore
adds no Undo step.

## 10. Verification

Pure geometry tests cover independently derived values for:

- a 20 × 10 mm rectangle;
- the same rectangle rigidly rotated in 3D;
- a 20 × 10 mm rectangle with a centred Ø4 mm hole;
- a semicircular and a rounded boundary assembled from lines and arcs;
- reversed loop orientation;
- open, self-intersecting, disconnected and degenerate loops;
- unsupported spline/ellipse boundaries.

Calculation tests cover axial load, both bending axes, unsymmetric bending,
force-to-moment transformation, rotational invariance, tension/compression
limits, rectangular transverse shear, torsion rejection, non-rectangular shear
rejection, missing shear evidence and computational overflow.

MCP tests cover strict schemas, scenario labelling, exact verification,
immutable persistence, old-report compatibility, stale face references,
document changes during inspection, restart behavior, and the absence of
Workbench/HTTP/CAD-mutation dependencies.

Live acceptance uses a real stdio MCP client and a disposable Plasticity
document. It creates a rectangular solid and a solid with a circular through
hole using already verified native operations, then:

- reads exact face properties and compares them with independent analytical
  references within declared tolerances;
- calculates known axial/bending and rectangular-shear cases;
- verifies that the holed section retains nominal normal results but rejects
  unsupported direct shear and cannot become an unconditional pass;
- changes the body, proves the old report stale, exercises Undo/Redo and
  re-reads the section;
- removes only confirmed disposable history steps and restores the empty
  document.

The final gate includes the root test/typecheck suite, Workbench tests,
typechecks and production build, `git diff --check`, plus the guarded live
acceptance. No physical load, material certification or printer compatibility
claim is made from these software checks.

## 11. Deferred sequence

After this face-bound package was accepted, the ordered follow-up became:

1. prove Plasticity's arbitrary section-analysis path without persistent scene
   mutations and bind verified reports to its exact body, plane, revision and
   section topology — completed and live-verified on 2026-09-23;
2. support exact direct shear for additional section families — implemented in
   `planar-section-resultants-v1` 1.1.0 for solid circles and concentric circular
   annuli;
3. add torsion passports for supported closed and circular sections — circular
   solid and annular sections implemented in 1.2.0; noncircular closed-section
   torsion now has a bounded uniform-thickness rectangular single-cell method
   in 1.3.0; multi-cell and general closed profiles remain deferred;
4. add plate/shell methods for enclosure walls — the bounded Navier plate
   method supports separate plates and one plain rectangular integral wall
   whose exact opposed B-rep faces prove its mid-surface spans and thickness;
   other edge conditions and general shells remain deferred;
5. add bearing, tear-out, fastener, insert and attachment checks — implemented
   as separate bounded passports, with remaining parent-part pullout and
   general attachment behavior explicitly unsupported;
6. add solver-backed whole-part analysis only behind a separately verified,
   reproducible adapter with explicit mesh and boundary-condition evidence —
   CalculiX runtime, exact planar face-to-mesh node mapping, uniform
   traction-to-nodal-load transfer with balanced reactions, an axial patch
   checked at two mesh sizes, and a public-MCP synthetic L-bracket run over
   four byte-identical mesh levels are accepted prerequisites. The bracket
   peak stress still changes 27.8% at the finest level, so representative-part
   mesh convergence, physically justified supports/materials and full MCP
   strength verification remain deferred.

Each later method remains versioned and conservative; unsupported physics is
never silently delegated to a language model.
