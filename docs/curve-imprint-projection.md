# Curve imprint projection methods

`plasticity_imprint_curves_on_body` splits a Solid or Sheet using preserved
source Wires. Choose the native projection method explicitly when needed:

| `projectionMethod` | Direction | Behavior |
| --- | --- | --- |
| `vector` (default) | Required, nonzero | Projects along the normalized supplied vector. Existing calls keep this behavior. Native projection may approximate analytic curves as SPCurve edges. |
| `normal` | Must be omitted | Uses native surface-normal projection. It preserves analytic circles in the qualified planar cases below. |

Supplying both normal projection and a direction rejects before mutation. So do
missing vector directions and unknown methods. No method is selected as a silent
fallback. Normal and vector projection are different geometric operations on
general surfaces; the planar circle results do not establish equivalence or
analytic output on every surface. The existing `bidirectional`, `occlude` and
`completion` options are unchanged (defaults false, true and none).

A normal call has the same target, source IDs and current revision as other
mutations, with `projectionMethod: "normal"` and no `direction`. The chosen
method is recorded in the construction journal and durable history. Geometry,
source preservation and native Undo/Redo still use the existing owned command.

## Qualified fixtures

On each experimental Plasticity 26.2.1 and 26.1.3 copy, an R2 circle at (5,5,15)
is imprinted onto the top face of a 10 mm cube using normal projection. A second
case rotates the cube 30 degrees about world Y through (5,5,5) and places the
source circle along its rotated top normal. The expected imprinted center is
(7.5,5,5+2.5√3), with normal parallel to (0.5,0,√3/2).

Both cases require native-valid Solids, 7 faces/13 edges, an analytic Circle of
radius 2 and circumference 4π, unchanged source Wire bounds, volume 1000 mm³,
known body bounds and native Undo/Redo with stable IDs. Volume tolerance remains
0.0001 mm³; radius, center, circumference and bounds tolerance remains
0.00001 mm; normal alignment uses 1e-8. History must contain the exact expected
number of completed events, one normal-imprint input without direction, and
an in-sync durable journal. All persistent test stores are isolated.

```sh
npm run accept:native-align-project -- --target ID --allow-disposable-mutations \
  --case imprint-curve-normal --output NEW_DIRECTORY
```

Use `imprint-curve-normal-oblique` for the rotated case. The original
`imprint-curve` still checks vector projection against its unchanged strict
analytic gates and remains unaccepted: both kernels return volume
999.9996120023484 mm³ and an SPCurve edge. This native vector-projection limitation
was not repaired or relabeled as an analytic pass. Native-extrema bounds on
26.2.1 now read 0..10 mm; legacy FindBox still reports max Z=10.05 mm for that
SPCurve result. Neither a valid native check nor a loose box alone proves
analytic-circle equivalence or a physical bulge.
