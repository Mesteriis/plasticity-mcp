# Synthetic DCB, ENF and MMB energy qualification

Three production stdio cases pass on experimental Plasticity 26.2.1 and 26.1.3.
They exercise calculation, local CSV preview, immutable recording, list/read,
exact-process matching, mismatches/conflicts and restart persistence. Each run
uses new isolated stores and fixed synthetic inputs, with explicit application
connection and native no-change checks. Physical-test attestations are simulated
schema fixtures only: no real physical tests, standards conformity, material
qualification, cohesive calibration or design allowables are established.

## MMB thickness correction and old records

The MMB calculation erroneously divided `armThicknessMm` by two before using it
as `h`. [Reeder and Crews, NASA/AIAA 1990](https://ntrs.nasa.gov/api/citations/20040161459/downloads/20040161459.pdf)
define `h` as specimen half-thickness: for the symmetric split specimen this is
one arm's thickness. The API's per-arm input must therefore be used directly.
Schema descriptions now make that meaning explicit for direct and CSV calls.

New calculations report `calculationVersion: 2`. Version 1 is reconstructed only
to validate the exact stored historical calculation before returning corrected
version 2 results. Legacy read results explicitly carry
`recalculatedFromVersion: 1` and
`recalculationReason: "MMB_V1_ARM_THICKNESS_HALVED"`; list and match summaries also
expose this metadata and the current calculation version. The immutable input,
record ID, timestamp and file bytes are preserved. Repeating the same registration
returns the existing record with the corrected view. Unknown versions and altered
historical calculations are rejected rather than silently trusted. This is a
corrected read view, not an on-disk migration or deletion of old evidence.

A checked-in, explicitly synthetic version-1 record authenticates the old
behavior. Store regression and production MCP checks verify corrected read,
annotated list/match, idempotency, restart and unchanged source bytes on both
experimental versions. Tampering with either the historical energy or version
is rejected by store regression tests. The initial real modern-version failure
against the corrected numeric oracle remains in the catalog audit.

## Independent numerical gates

DCB uses three observations `(a mm, P N, displacement mm)`:
`(40,10,2.16)`, `(50,8,2.744)`, `(60,6,3.072)`, width 25 mm. The MBT compliance
fit gives crack correction 20 mm; `3 P displacement / (2 b (a + correction))`
gives 21.6, 18.816 and 13.824 J/m² after conversion from N/mm.

ENF uses `C = 0.001 + 0.000001 a³` mm/N at crack lengths 20, 30, 40 mm.
The slope is 1e-6, R² is 1, and `3 m P² a² / (2 b)` at 100 N, 30 mm crack and
20 mm width gives 675 J/m². CSV calibrations explicitly select three linear
samples from each of three named runs and the fracture observation.

MMB uses width 25 mm, one-arm thickness 2.5 mm, half-span 50 mm, lever 100 mm,
crack 50 mm, force 120 N, flexural modulus 1800 MPa and orthotropic moduli
E11=2000, E22=1500, G13=500 MPa. Independent Decimal-60 evaluation of the
existing beam partition with the corrected thickness gives:

| Quantity | Corrected oracle |
| --- | ---: |
| Mode I, J/m² | 41486.7787876807657 |
| Mode II, J/m² | 10714.1168920638601 |
| Total, J/m² | 52200.8956797446258 |
| Mode-II energy fraction | 0.20524775968971027 |

The previous erroneous Mode-I result was 319427.79925766407 J/m². Synthetic
large energy values are arithmetic fixtures, not evidence of elastic behavior
or an achievable material property. Numeric gates are fixed independently of
product outputs (1e-10 absolute in the live verifier, 1e-9 for the MMB regression).

All CSV cases explicitly map kN to N; DCB/ENF also map µm to mm, with selected
row/specimen/run IDs. Preview preserves exact source bytes and SHA-256 and leaves
the test registry empty. Registration is a separate explicit call. Identical
registration is idempotent. Changed layer height does not match; changed force
creates ambiguous exact-process records. Missing physical confirmation and zero
width are rejected. List and both full records remain identical after restart.

## Commands and boundaries

```sh
npm run accept:fracture-energy -- --target ID --allow-live --case dcb --output NEW_DIRECTORY
npm run accept:fracture-energy -- --target ID --allow-live --case enf --output NEW_DIRECTORY
npm run accept:fracture-energy -- --target ID --allow-live --case mmb --output NEW_DIRECTORY
```

No args/`--help` are inert. Each run requires an explicit experimental target,
live opt-in and new output directory. Native identity, revision, Undo/Redo,
snapshot, construction history and journal are checked before restart, with
retained scene/identity/history checked afterwards. The outer catalog harness's
owned baseline save/open is outside the per-case no-mutation assertion.
Installed apps/settings/security are unchanged. These host checks do not qualify
rendering, arbitrary geometry, actual experimental processing or any FEM result.
