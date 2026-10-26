# STEP and cable geometry with conservative legacy bounds

Plasticity 26.1.3 has no native `Eval.Extremes` capability. Its public
`boundsMethod: native-box` remains conservative. No production adapter code or
bounds values are changed by this qualification. The original strict
`step-provenance` and `cable-channel` cases remain unaccepted on 26.1.3; their
original tolerances are unchanged. The corresponding 26.2.1 strict cases pass
with `native-extrema`.

## STEP geometry and provenance

The explicit `step-provenance-geometry` variant uses the same exported/imported
10 × 20 × 30 mm box at (1,2,3). It independently checks eight unique native
vertices at the nominal corners; twelve unique axial edge endpoint pairs with
matching lengths/tangents; six oriented analytic Plane carriers with four-edge
boundaries; and two nonparallel, consistent supporting planes for each edge.
Linear checks use 0.00001 mm and normal/tangent alignment uses 1e-8.

The imported edge wrappers are SPCurve and native `IsLine` is false on both
versions. The verifier therefore uses the nonparallel plane constraints and
native geometry instead of requiring a Line class name. This is distinct from
assuming that every SPCurve is straight: parallel/missing supports, displaced
corners, invalid tangents/boundaries and inconsistent edge lengths reject.
An initial authored Line-name gate was corrected after inspecting those native
carriers; inputs and coordinate tolerances were not changed.

Native Check passes. Volume is 6000 mm³, surface area 2200 mm² (tolerance
0.0001 mm³/mm²) and volume centroid (6,12,18), checked to 0.00001 mm. Geometry is
checked again after Redo, MCP restart and reconciliation. Stable body identity,
artifact hash, persistent provenance and durable history are checked. Historical
record bounds must exactly preserve the initially observed imported bounds;
no conservative record is relabeled as a tight nominal box. On 26.1.3 these
are (0.99995,1.99995,2.99995)..(11.00005,22.00005,33.00005).

## Cable-channel material envelope

The explicit `cable-channel-geometry` variant keeps the 30 × 20 × 10 mm source,
straight spine at Z=10 and Ø4 channel from the original case. Target volume
remains `6000 - 60π` mm³ with the existing 0.01 mm³ sweep tolerance. Native
validation, retained spine, two recipe history steps and result identities
remain required.

Six external probe Solids start 0.00001 mm beyond the nominal box faces. Native
read-only temporary B-Rep intersections must find no volumetric material in
those probes. The reported conservative box must lie inside the finite probe
domain. A separate ordinary cube extends 0.001 mm into the upper probe; native
intersection must detect that overlap and return a valid Solid. A direct thin
primitive was unsuitable for the native box factory, so this control uses a
1 mm-high cube with a thin overlap rather than a thin primitive.

The positive control verifies 0.001 mm overlap detection; it does not certify
arbitrary sub-kernel deviations or a continuous mathematical bound. These are
native volumetric containment checks with a stated probe offset, not a new
precision claim for `FindBox`. On 26.1.3 its reported max Z remains
10.112742414248142 mm; 26.2.1 native extrema remain Z=10 mm.

All controls and the source Wire must remain unchanged. The recipe Undo restores
the exact source snapshot, Redo restores IDs and repeats the checks, and cleanup
restores empty geometry. Durable history must have all 25 completed events and
an in-sync journal. These checks pass on each experimental version. Test stores
are isolated; installed Plasticity and security settings are unchanged.

```sh
npm run accept:native-measure-datum-files -- --target ID \
  --allow-disposable-mutations --case step-provenance-geometry --output NEW_DIRECTORY
npm run accept:native-joints-vents -- --target ID \
  --allow-disposable-mutations --case cable-channel-geometry --output ANOTHER_NEW_DIRECTORY
```
