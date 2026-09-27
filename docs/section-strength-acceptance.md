# Planar section strength live acceptance

The planar-section workflow was accepted on 2026-09-21 with Plasticity 26.1.3 on an Apple Silicon Mac, Node.js 24 and a real stdio MCP client. The run used an explicitly selected empty disposable document and called only public MCP tools. It did not start or use Workbench.

## Safe invocation

```sh
node scripts/verify-section-strength-live.ts \
  --target EXPLICIT_PLASTICITY_TARGET_ID \
  --allow-disposable-mutations \
  --output .plasticity-mcp/section-strength-live-NEW-RUN
```

No arguments or `--help` perform no connection and no mutation. Live mode requires all three explicit arguments, refuses a nonempty Plasticity document and requires a new output directory. The directory is created with mode `0700`; `evidence.json` or `failure.json` is created exclusively with mode `0600`. Evidence is bounded and excludes credentials, full prompts and native object dumps.

## Verified evidence

The successful run completed from `2026-09-21T10:55:37.587Z` to `2026-09-21T10:55:38.561Z` and proved:

- The installed stdio MCP created a native 20 × 10 × 5 mm Solid and selected one exact planar 20 × 10 mm face.
- Native line boundaries produced area `200 mm²`, centroid `[10, 5, 5] mm`, `Ixx = 1666.666666666667 mm⁴`, `Iyy = 6666.666666666668 mm⁴`, `Ixy = 0`, no inner loops and `rectangular = true`. These values came from native B-rep boundaries, not display bounds or a mesh.
- A synthetic software benchmark produced `100 N` axial force, `2 N` X shear and `-500 N·mm` Y bending. Exact boundary extrema were `-0.25 MPa` and `1.25 MPa`; rectangular direct shear was `0.015 MPa`. The result remained `conditional` because the synthetic material/process was deliberately unconfirmed.
- A second 20 × 10 mm face with a centred Ø4 mm through hole produced area `187.4336293856408 mm²`, `Ixx = 1654.1002960523076 mm⁴`, `Iyy = 6654.100296052307 mm⁴`, one inner loop and line/circle boundaries. The result retained finite nominal normal stress but returned `unsupported` for nonrectangular direct shear and listed local stress concentration as unchecked.
- Scaling the first Solid changed the old face-bound report to `stale` with both `CAD_REVISION_CHANGED` and `CAD_TOPOLOGY_CHANGED`. Undo and Redo re-read the exact face at Z = 5 mm and Z = 4 mm while retaining area `200 mm²`.
- Five confirmed Undo operations removed the scale, Boolean, cutter and both boxes. The original document was empty again, its scene contents matched the initial snapshot, the construction journal was `in-sync`, and it contained no uncertain entry. The history revision changed as expected.

The 1.1.0 shear-family extension was accepted through the same real stdio path
from `2026-09-21T12:30:59.134Z` to `2026-09-21T12:31:00.186Z`:

- A native Ø10 mm Solid face measured `A = 78.53981633974483 mm²` and
  `Ixx = Iyy = 490.8738521234052 mm⁴`. With a centroidal `2 N` transverse
  force, the report selected `shearModel = solid-circle` and returned
  `0.033953054526271 MPa`, matching `4V/(3A)`.
- A native concentric Ø10/Ø6 mm annulus measured
  `A = 50.26548245743669 mm²` and
  `Ixx = Iyy = 427.2566008882119 mm⁴`. The report selected
  `shearModel = concentric-circular-annulus` and returned
  `0.07645678638728305 MPa`, matching the exact annular factor. The result
  stayed conditional because an inner boundary still leaves local stress
  concentration and net-section fracture unchecked.
- The opposite native directions of the inner and outer full-circle edges also
  exercised the orientation-independent containment fix. A rectangular face
  with a centred circular hole remained `unsupported` for direct shear under
  `SECTION_FAMILY_SHEAR_UNSUPPORTED`.
- Cleanup reversed nine confirmed native history steps, restored the original
  empty scene, and left the construction journal `in-sync` with no uncertain
  entry.

The 1.3.0 torsion passport was accepted through native B-rep sections on
2026-09-23:

- A `100 N·mm` torque on the native Ø10 mm solid-circle section selected
  `torsionModel = solid-circle` and returned
  `torsionalShearStressMPa = 0.5092958178940651`, matching `|T|R/J` with
  `J = Ixx + Iyy`.
- The same torque on the native Ø10/Ø6 mm concentric annulus selected
  `torsionModel = concentric-circular-annulus` and returned
  `0.5851284672496152 MPa`.
- The circular reports use method version 1.3.0 and retained separate torsion
  utilization. The synthetic unconfirmed material kept both results
  `conditional`; the annulus also retained its local-stress warning.
- A native box 20 × 10 mm with a uniform 1 mm wall produced exact section area
  56 mm². With `T = 100 N·mm`, the classifier selected
  `thin-walled-rectangular-single-cell`, measured median enclosed area 171 mm²
  and wall thickness 1 mm, then returned `q = 0.2923976608 N/mm` and
  `τ = 0.2923976608 MPa` under the Bredt-Batho idealization. Explicit
  thin-wall applicability was confirmed for this software acceptance; the
  synthetic material remained unconfirmed, so the result stayed `conditional`.
- The real stdio MCP evidence is
  `[local acceptance artifact omitted]`.
  Cleanup restored the exact empty scene and an `in-sync` journal with no
  uncertain entry. Torsional twist, distortion, end restraint, multi-cell or
  nonuniform walls, and combined transverse shear plus torsion remain outside
  the passport.

These checks validate native geometry collection, deterministic nominal formulas, binding freshness and recovery behavior. They are not a physical load test, material certification, structural-code check, whole-part validation or print authorization. Arbitrary-plane geometry inspection is accepted separately; stored strength verification remains face-bound.

## Failure recovery

On failure, the script writes bounded `failure.json` and attempts cleanup only when the same document remains selected and the construction journal contains no manual or uncertain mutation. It undoes confirmed history while bodies remain and stops if those conditions cannot be proven.
