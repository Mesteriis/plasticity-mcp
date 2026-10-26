# Native bounds and supported Helix parameters

Body `boundsMm` now carries optional `boundsMethod` provenance in status, body
information, mutation summaries and durable construction history. The measurement
tool also returns that field.

| Method | Meaning |
| --- | --- |
| `native-extrema` | Six native support-extrema queries determine Solid/Sheet min/max coordinates. Available in the prepared 26.2.1 kernel. |
| `native-box` | Native `FindBox` provides a conservative box. Used for Wires and kernels without `Eval.Extremes`, including 26.1.3. It may include space outside trimmed material. |

Capability detection selects the method. A failed or malformed extrema result
raises an error; it does not silently fall back to a looser box. Existing 26.1.3
box values remain compatible and are explicitly identified as conservative.
The extrema method uses the native kernel's numerical accuracy; it does not
provide a separately certified mathematical error bound.

The topology cache is now format 3. Opaque revision tokens include the bounds
format/method so stale measurements cannot retain an apparently current revision.
After updating MCP, re-read status and use its new revision. Old construction
history entries without `boundsMethod` remain readable; their bounds provenance
is unknown. Historical records never authorize automatic replay or Undo.

## Whole-turn restriction

Native 2.5-turn spirals were observed to end beyond their requested axial limit
on both 26.1.3 and 26.2.1. Fractional turns are therefore rejected before creating
native geometry, rather than compensated by changing dimensions or pitch.

Supported requests must produce a positive whole number of Helix turns:

- Direct Helix: `turns` is a positive whole number.
- External thread or screw: `threadLengthMm / pitchMm` is whole.
- Internal thread: `(materialDepthMm + 2*cutterOvershootMm) / pitchMm` is whole.
- Hex nut: `(thicknessMm + 2*cutterOvershootMm) / pitchMm` is whole.

Pair and calibration recipes validate all members’ turn constraints before their first geometry
step. Floating-point arithmetic noise within 1e-9 turns is normalized to the
nearest integer; a real fractional request such as 2.5 is never rounded to 3.

For example, a synthetic 8 mm nut with 1.25 mm pitch and 0.5 mm overshoot requests
7.2 cutter turns and is now unsupported. Explicitly requesting 1 mm overshoot
gives eight turns. The qualification fixture uses that explicit input and a
matching 1 mm axial phase translation. This is a CAD test configuration, not a
physical fit recommendation or a printer/material qualification. The calibration
fixture likewise explicitly uses M5x10 and 1 mm overshoot; the original M5x8
fixture is unsupported.

## Verification

The standalone thread suite keeps its original 0.01 mm material-envelope and
0.001 mm Helix tolerances. It checks native extrema when available and, on both
versions, tests six external envelope volumes through read-only native temporary
B-Rep intersections. The latter establishes no volumetric material outside the
specified padded envelope; it does not relabel a conservative legacy box as
an exact one. The probe volumes must contain the reported body box's range.

Qualified whole-turn cases include full native Undo/Redo, stable IDs, restored
source snapshots and durable event-count/synchronization checks. The separate
`fractional-preflight` case verifies rejection of direct Helix and all four
standalone thread tools without changing document revision or Undo/Redo history.

Run one fixture in a new evidence directory against an explicitly selected
empty experimental document:

```sh
npm run accept:native-thread-tools -- --target ID --allow-disposable-mutations \
  --case internal-right-integral --output NEW_DIRECTORY
```

The `-integral` internal/nut cases explicitly use 1 mm overshoot. Their original
0.5 mm overshoot variants remain unsupported. Other cases are `external-right`,
`external-left`, `hex-screw`, and `fractional-preflight`.
