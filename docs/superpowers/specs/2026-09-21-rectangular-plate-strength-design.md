# Rectangular plate under uniform pressure

Status: accepted implementation increment, extended with exact integral-wall
geometry verification on 2026-09-23.

## Purpose

Add a bounded plate-bending passport for flat rectangular lids, covers and
enclosure panels. The method is a screening calculation for one constant solid
or validated-effective plate. It does not replace Plasticity, infer supports
from appearance, or claim whole-enclosure strength.

The separate-plate increment reuses exact rectangular-prism inspection. The
integral-wall increment reads two opposed exact planar faces on the same Solid;
their exact rectangular B-rep boundaries prove the mid-surface spans and wall
thickness. It supports one plain panel only. Walls with ribs, openings, bosses,
curvature or nonuniform thickness remain outside this passport. Geometry
verification does not determine the wall's supports or validate the full
enclosure load path.

## Method passport

The method ID is `simply-supported-plate-uniform-pressure-v1`, version 1.0.0.
It implements the classical Navier solution for a homogeneous isotropic
rectangular Kirchhoff-Love plate with all four edges ideally simply supported
and a static uniform normal pressure.

Required inputs are:

- in-plane spans `lengthMm` and `widthMm`;
- constant thickness `heightMm`;
- nonnegative net pressure `pressureMPa` (`1 MPa = 1 N/mm²`);
- Young's modulus and Poisson ratio;
- tensile and compressive limits for the matching printer, material, profile
  and orientation;
- safety factor and maximum accepted centre deflection;
- confirmations for static uniform pressure, linear elasticity,
  homogeneous-isotropic-equivalent response, thin-plate kinematics and four
  ideal simply supported edges.

The flexural rigidity is

```text
D = E t³ / (12 (1 - ν²)).
```

The implementation evaluates the odd-term Navier double Fourier series for
centre deflection and centre bending moments. Surface stresses follow
`σx = 6 Mx/t²` and `σy = 6 My/t²`; the governing stress magnitude is the larger
of the two. The opposite surfaces exchange tension and compression, so the
governing material allowance is the smaller of the tensile and compressive
limits after the explicit safety factor.

The result records centre deflection, both centre moments per unit length, both
surface stress components, flexural rigidity and the deterministic series
resolution. Results are in millimetres, newtons and megapascals.

## Product applicability gates

The method returns `unsupported` while retaining the calculated values when:

- the shorter clear span divided by thickness is below 10;
- calculated centre deflection exceeds half the thickness;
- Poisson ratio is outside the stable isotropic range `-1 < ν < 0.5`;
- the selected method's geometric or support assumptions are contradicted.

The first two gates keep the result inside a conservative small-deflection
thin-plate product envelope. They do not turn the ratio checks into a design
code. A merely unconfirmed support or material assumption remains
`conditional`; a known mismatch is `unsupported`.

Openings, ribs, bosses, fillets, curvature, varying thickness, concentrated or
partial pressure, edge compliance/fixity, membrane action, buckling, local
contact, joints, fatigue, creep, impact and layer delamination remain listed as
unchecked. Clamped edges are not silently approximated as simply supported.

## MCP and persistence

`plasticity_calculate_strength` accepts the new scenario. For a separate
rectangular plate body, `plasticity_inspect_rectangular_member` and
`plasticity_verify_member_strength` replace all three dimensions with current
native B-rep measurements before storing an immutable CAD-bound report.
`plasticity_size_member` may evaluate a finite explicit list of candidate
thicknesses. Existing report files and method behavior remain readable.

No new mutating CAD command is introduced. Any later thickness change still
requires the normal user-authorized CAD package, after which the report must be
re-read or recalculated because the revision and input hash changed.

## Verification

Pure tests compare the Navier series against the independently published
square-plate coefficients for Poisson ratio 0.3: centre deflection coefficient
approximately 0.00406235 relative to `q a⁴/D`, and maximum surface-stress
coefficient approximately 0.287318 relative to `q a²/t²`. Tests also cover
span symmetry, pressure and thickness scaling, input evidence, failure,
thinness and large-deflection gates, persistence and stale CAD bindings.

Live acceptance creates an 80 × 40 × 2 mm native box in the explicit empty
Plasticity document, verifies its exact dimensions, runs the plate method,
changes thickness, checks stale/Undo/Redo behavior and restores the empty
document.

Primary formula and benchmark sources:

- NASA, *Sonic and Vibration Environments for Ground Facilities*, section
  3.4.5, equations 3.362-3.365 and tables 3.14-3.16:
  https://ntrs.nasa.gov/api/citations/19760066879/downloads/19760066879.pdf
- NASA Technical Reports Server, *Design curves for non-linear analysis of
  simply-supported, uniformly-loaded rectangular plates*:
  https://ntrs.nasa.gov/citations/19790044251
