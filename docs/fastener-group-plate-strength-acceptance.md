# Multi-hole plate strength acceptance

The bounded local-bearing screen and optional straight transverse net-tension
screen were exercised through the public stdio MCP on Plasticity 26.1.3 using
one explicitly selected empty document. The native fixture is a 60 × 40 × 8 mm
plate with four exact Ø6 mm through-holes. The test uses synthetic allowables
only to verify calculations; it is not a material qualification or design
recommendation.

## Net-tension model

The caller supplies the external tensile resultant separately from the
per-fastener elastic demands, chooses local X or Y as its axis, supplies a
traceable tensile design allowable that already includes the required safety
factor, and confirms uniform membrane tension, centered loading through the
plate thickness and a straight transverse failure path. The MCP searches all
parallel cuts normal to the selected axis. For each cut it subtracts the exact
circle chord widths from the native rectangular span and uses the minimum
resulting net width:

```text
nominal net-section stress = external tensile demand / (minimum net width × measured plate thickness)
```

The model treats the selected plate as a homogeneous equivalent section. It
does not derive the external force from fastener loads. Angled or staggered
fracture paths, compression-side buckling, tear-out, shared-ligament
interaction, bearing bypass, plate bending, prying and complete-joint behavior
remain unchecked. Even a within-allowable screen remains conditional.

## Live evidence

The real MCP run measured the native plate thickness as 8 mm and found a
minimum straight-cut net width of 28 mm through two Ø6 mm holes in one row,
giving a net area of 224 mm². With a synthetic 100 N external tensile
resultant, the nominal stress was 0.4464286 MPa and utilization against a
synthetic 10 MPa allowable was 0.0446429. The separately calculated local
bearing result remained `conditional`; no overall pass was issued. The stored
report was current before an intentional CAD move and stale afterward. Undo
cleanup restored the original empty document and left the construction
journal in sync.

Evidence: `[local acceptance artifact omitted]`.

## Loaded-edge shear-out

A second live call used four explicitly measured fastener positions and a
centered 100 N load along local +X, giving a 25 N axial demand at each fastener.
The public MCP checked the two-plane loaded-edge screen against a synthetic
5 MPa factored shear allowable. Exact loaded-edge center distances were 50 mm
for two holes and 10 mm for the two holes near the +X edge. With Ø6 mm holes
and 8 mm thickness, nominal stresses were 0.0332447 MPa and 0.2232143 MPa.
The latter holes have e/d=1.667, so their individual results remained
`conditional` under the method's nominal 2d practice; the full result was
conditional and did not pass the plate or joint. A separate automated MCP
test confirms diagonal fastener resultants return unsupported instead of being
rounded to an axis. The report was current before a CAD edit, stale afterward,
and Undo restored the empty document.

Evidence: `[local acceptance artifact omitted]`.
