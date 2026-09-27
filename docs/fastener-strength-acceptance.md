# Fastener plate and threaded-receiver live acceptance

The single-fastener plate workflow was accepted on 2026-09-21 and the
threaded-receiver extension was accepted on 2026-09-22 with Plasticity
26.1.3 on an Apple Silicon Mac, Node.js 24 and a real stdio MCP client. The run
used an explicitly selected empty disposable document and did not use
Workbench.

## Safe invocation

```sh
npm run accept:fastener-strength -- \
  --target EXPLICIT_PLASTICITY_TARGET_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

No arguments or `--help` perform no connection and no mutation. Live mode
requires all three explicit arguments, refuses a nonempty Plasticity document
and requires a new output directory. Evidence and failure files are created
exclusively and contain bounded sanitized data.

## Verified evidence

The latest successful run completed from `2026-09-22T11:18:54.226Z` to
`2026-09-22T11:18:55.018Z` and proved:

- Three native operations created a 40 × 20 × 2 mm rectangular Solid and cut
  one Ø6 mm through-hole centred 10 mm from the loaded +X edge.
- The resulting native body was a valid seven-face, fourteen-edge Solid: six
  planar faces plus one cylindrical R3 face. The selected opposed broad faces
  each had one rectangular outer loop and one circular inner loop.
- `plasticity_inspect_single_fastener_plate` read `t = 2 mm`, `d = 6 mm`,
  loaded edge distance `e = 10 mm`, opposite edge distance `30 mm`, gross width
  `20 mm`, and two `7 mm` side clearances from exact native B-rep boundaries.
  No render mesh or display bounds were used.
- With a synthetic `300 N` software benchmark, deterministic results were
  `25 MPa` projected bearing, `10.714285714285714 MPa` two-plane edge
  shear-out, and `10.714285714285714 MPa` net-section tension. The respective
  utilizations were `0.5`, `0.42857142857142855`, and
  `0.42857142857142855` for the synthetic allowables and safety factor.
- The result was deliberately `conditional`: the synthetic material/process
  was unconfirmed and `e/d = 1.6666666666666667` lies between the method's
  1.5 lower limit and nominal 2D edge practice.
- The designation resolver normalized `DIN 912 M5x10` in tapped metal as
  `M5×0.8×10` and routed it to
  `plasticity_calculate_threaded_receiver_strength`.
- A clearly labelled synthetic software benchmark applied a factor of 2 to a
  `3000 N` axial demand. With explicit synthetic allowables of `12000 N`
  internal strip, `14000 N` external strip, and `10000 N` fastener tension,
  the tool returned utilizations `0.5`, `0.42857142857142855`, and `0.6`.
  Fastener tension governed before thread stripping with a `2000 N` hierarchy
  margin. These synthetic values test software behavior and are not M5 design
  data.
- Changing engagement from `8 mm` and 10 fully formed threads to `8.8 mm` and
  11 threads made the immutable receiver report stale with
  `TASK_OR_MATERIAL_CHANGED`.
- Scaling thickness from 2 mm to 1 mm made the stored report stale with both
  `CAD_REVISION_CHANGED` and `CAD_TOPOLOGY_CHANGED`. Undo/Redo reproduced the
  sequence 2/1/2/1/2 mm.
- Cleanup reversed all three construction steps, restored the original empty
  scene, left the journal `in-sync`, and recorded zero uncertain mutations.

The live evidence is stored at
`[local acceptance artifact omitted]`
on the tested
machine. This proves the current native geometry and deterministic formulas. It
is not material certification, a physical load test, a complete bolted-joint
analysis, structural-code approval or print authorization.

## Method boundary

The exact geometry gate intentionally accepts only one plain rectangular
constant-thickness Solid with one circular through-hole and two explicitly
selected opposed broad faces. Fillets, counterbores, slots, multiple holes,
bosses, nonrectangular outlines and varying thickness require another method.

The plate calculation checks the member around the hole. The separate
threaded-receiver calculation checks axial internal-thread stripping,
external-thread stripping, fastener tension, and the requested failure
hierarchy only from explicit compatible allowable loads. It does not derive
capacity from nominal M size. Preload generation, transverse load, slip,
clearance, group distribution, prying, parent-part pullout, boss splitting,
fatigue, creep, impact, temperature, and printed-layer failure remain unchecked
and are returned in the applicable reports.
