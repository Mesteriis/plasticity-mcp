# Rectangular plate strength live acceptance

The guarded acceptance command is:

```bash
npm run accept:plate-strength -- \
  --target EXPLICIT_EMPTY_PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_OUTPUT_DIRECTORY
```

With no arguments or `--help`, the script does not connect to Plasticity and
does not mutate a document. Live mode refuses a nonempty document, never
chooses a window automatically and writes sanitized evidence only to a newly
created directory.

## Accepted run

The method was accepted on 2026-09-21 through a real stdio MCP connection to
Plasticity 26.1.3 on macOS Apple Silicon. Evidence is stored at:

```text
[local acceptance artifact omitted]
```

The script created one exact native 80 × 40 × 2 mm Solid and verified all
three dimensions from B-rep topology. With a synthetic uniform pressure of
0.01 MPa, synthetic `E = 2000 MPa`, `ν = 0.35`, and explicit simple supports,
the deterministic result was:

| Quantity | Value |
| --- | ---: |
| Flexural rigidity | 1519.468186 N·mm |
| Centre moment `Mx` per unit length | 0.818772283 N |
| Centre moment `My` per unit length | 1.640859399 N |
| Centre surface stress `σx` | 1.228158424 MPa |
| Centre surface stress `σy` / governing | 2.461289098 MPa |
| Centre deflection | 0.170647715 mm |

The report remained `conditional` because the material was deliberately marked
as an unconfirmed synthetic software fixture. It was not print material data.

Scaling the thickness to 1 mm made the original report stale by exact CAD
revision. The new calculation retained its values but returned `unsupported`
because 1.365181721 mm centre deflection exceeded half the thickness; the
ordinary 0.5 mm displacement limit also failed. Undo/Redo proved the native
2/1/2/1/2 mm thickness history. Final cleanup restored the exact empty scene,
left the construction journal `in-sync`, and left zero uncertain mutations.

The 2026-09-23 run also created a disposable hollow enclosure in Plasticity
26.1.3, selected the exact outer and inner planar faces, and verified the
mid-surface dimensions from their native B-rep topology:

| Quantity | Measured value |
| --- | ---: |
| Mid-surface span X | 78 mm |
| Mid-surface span Z | 22 mm |
| Wall thickness | 2 mm |

`plasticity_verify_integral_plate_strength` replaced the supplied dimensions
and saved a CAD-bound conditional report using the same deterministic plate
method. The synthetic pressure and material fixture left `MATERIAL_UNCONFIRMED`
in the result. Cleanup restored the empty document, left the construction
journal `in-sync`, and recorded zero uncertain mutations. Evidence:

```text
[local acceptance artifact omitted]
```

This acceptance proves the MCP transport, native separate-plate and integral
wall dimensions, deterministic formula, immutable reports, stale detection,
history recovery and cleanup. It does not prove the assumed pressure, material
properties, edge supports, print anisotropy, a structural code or a physical
part. The integral inspector supports only one plain rectangular wall between
opposed planar faces; it is not a general shell method.
