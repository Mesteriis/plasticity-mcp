# Synthetic joint-test registry and interface-curve qualification

Three guarded production stdio cases exercise existing host tools while explicitly
connected to each experimental Plasticity version. All three cases pass on
26.2.1 and 26.1.3. All process IDs, input notes,
evidence labels and source bytes identify synthetic fixtures in separate stores.
No physical tests were performed and no real material, joint or manufactured part
is qualified. Physical-test schema attestations are simulated only inside those
isolated stores. No CAD mutations, downloads, solver runs or Codex analysis turns
are requested.

## Corrected existing public response

`plasticity_calculate_interface_specimen_strengths` previously converted public
`failureLocation: "printed-material"` to the internal `"material-a"` but returned
that internal value in its result. The live modern-version fixture reproduced
the mismatch, as did a new focused MCP regression test before the fix. The public
callback now translates bulk-failure locations back to `"printed-material"`,
consistent with CSV previews and registered interface records. Arithmetic,
internal data contracts and stored records are unchanged. The regression checks
all five public failure locations and unchanged stresses/interface-failure count.
The initial live failure remains a separate unaccepted fixture in the catalog.

## Fastener registry

The synthetic two-hole plate case checks immutable recording, idempotency and
exact matching with reversed hole order. Changed thickness, clamp condition and
layer height produce no match. Overlapping holes and malformed source hashes
are rejected. Registering a conflicting peak load makes the exact configuration
ambiguous, with no selected record. The original two loads (420 N and 450 N) and
failure modes are retained; a second record changes the first load to 410 N.
These are registry observations, not a joint-capacity calculation or allowable.
Both immutable records survive MCP restart exactly.

## Direct interface strength and CSV preview

Three synthetic specimens have force/area values 40/4, 60/4 and 400/4, giving
10, 15 and 100 MPa. The third fails in printed material, so only the first two
enter interface statistics: minimum 10, maximum 15, mean 12.5 MPa and sample
standard deviation √12.5 MPa. Per-specimen failure locations retain public
terminology. A separate all-fixture-failure calculation returns zero interface
failures and null summary values.

A real local CSV preview selects the same peak loads and preserves its source
bytes/hash. Preview does not register tests. A separate explicit recording call
stores the synthetic representative result and all specimens; repeated recording
is idempotent. The exact process matches, a changed layer height does not, and
off-normal tensile loading is rejected. The record survives restart exactly.
Attempting fracture-curve analysis on this unclassified direct-strength record
is rejected.

## Corrected-curve CSV and stored curve summary

The fixed CSV uses micrometers and kPa. After explicit conversion to mm and MPa,
points are (0,0), (0.01,1), (0.02,0.5), (0.03,0). Independent numeric gates check
peak 1 MPa at 0.01 mm, first-segment stiffness 100 MPa/mm, final separation
0.03 mm and trapezoidal work 0.015 N/mm, all with absolute tolerance 1e-10.
The preview retains the exact source hash and leaves bytes/registry unchanged.

An explicit synthetic DCB Mode-I record matches the process and survives
restart; its recomputed summary remains identical. A nonzero terminal traction,
incorrect fracture-method classification and off-normal load direction are
rejected. The output remains `measured-curve-summary-only`; the processing
attestation is simulated, and this does not validate experimental compliance
correction, identify a qualified cohesive law or establish a design allowable.

## Execution and boundaries

```sh
npm run accept:joint-tests -- --target ID --allow-live --case fastener-registry --output NEW_DIRECTORY
npm run accept:joint-tests -- --target ID --allow-live --case interface-strength --output NEW_DIRECTORY
npm run accept:joint-tests -- --target ID --allow-live --case interface-curve --output NEW_DIRECTORY
```

No args/`--help` are inert. Every case requires an explicit target, live opt-in and
new output directory, with isolated stores. Before restart, native document and
revision, Undo/Redo depths and scene snapshot remain unchanged; construction
history and journal remain empty. After restart, native identity/history and
retained scene collections are compared with the original baseline. The catalog
harness saves/opens its own empty document before cases; that setup is outside
the per-case no-mutation assertion. The installed apps/settings/security are not
changed. Host checks do not qualify version-specific geometry, rendered pixels,
physical source authenticity, general assemblies, energy-from-crack-growth
DCB/ENF/MMB tools, mixed-mode calibration or FEM.
