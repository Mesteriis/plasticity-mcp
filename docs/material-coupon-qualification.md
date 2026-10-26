# Synthetic material-coupon registry and scenario qualification

The guarded production stdio suite connects explicitly to each experimental
Plasticity version and exercises local material-data tools. Its fixtures simulate
physical-coupon schema inputs in a new isolated store. **No physical tests were
performed**, and none of these values qualifies a real material or printed part.
All process IDs, evidence labels, source bytes and input notes identify the
synthetic fixture. The schema's physical-test attestation fields are populated
only to exercise that contract in the isolated store; they are not real evidence.
Both cases pass on experimental 26.2.1 and 26.1.3. The suite performs no CAD
mutation, network request or Codex analysis turn.

## Registry case

Two immutable partial records share a simulated Young's modulus of 2000 MPa.
One also contains shear modulus 740 MPa; the other contains peak tensile strength
31 MPa. Each evidence hash is calculated from the actual synthetic source bytes.
Repeated recording returns the same record and `alreadyExisted: true`.
Matching initially returns `ambiguous`: neither partial record covers all data.
Explicit combination with a simulated six-specimen count produces a new record
that retains both original IDs and the exact properties, without averaging or
inferring other properties. The combined record becomes the exact-process match.

Changed orientation, layer height, profile hash, infill percentage or wall count
returns `no-match`. Duplicate IDs and malformed source hashes are rejected. A
conflicting simulated modulus of 2200 MPa makes the process ambiguous and cannot
be combined with the original. Four immutable records remain; rejected inputs
create no extra coupon records. The full registry is identical after MCP restart.

## Calculation case

The same compatible combination supplies only measured-schema Young's modulus
to two caller-dimension scenarios. Tensile and compressive design allowables are
separately supplied synthetic assumptions, 15 MPa and 20 MPa. The peak coupon
strength of 31 MPa is never promoted to a design allowable. Material suitability
remains `unconfirmed`, results remain `conditional`, and no CAD binding appears.
These are arithmetic scenarios rather than checks of native geometry.

| Scenario | Length × width × height, mm | Force, N | Stress, MPa | Displacement, mm |
| --- | --- | ---: | ---: | ---: |
| Axial tension | 100 × 10 × 5 | 1 | 0.02 | 0.001 |
| Cantilever tip bending | 100 × 10 × 5 | 0.1 | 0.24 | 0.16 |

Independent gates use axial stress `F/(b h)`, extension `F L/(E b h)`, cantilever
stress `6 F L/(b h²)` and tip deflection `4 F L³/(E b h³)`, with absolute tolerance
1e-10. Safety factor 2 and displacement limit 2 mm are independently checked in
utilizations. Discrete sizing evaluates axial heights 5, 8, 10 mm and cantilever
heights 4, 4.5, 5 mm in sorted order, checks every candidate against the same
formulae and selects the smallest conditional candidate. No sizing modifies CAD.

Missing independent compression allowable is rejected. An unmatched process
returns no calculation report. A cantilever load of 1 N gives 1.6 mm deflection,
exceeding the method's L/100 limit, and is explicitly `unsupported`. A 10 mm
cantilever height violates L/h ≥ 20; sizing returns no recommendation. The first
live run incorrectly expected the 1 N case to be conditional and remains a
separate unaccepted fixture. Its refusal is preserved; the product limits were
not relaxed. Positive fixtures use the smaller load and valid height range.

The test planner returns bulk elastic and directional-strength tasks with the
exact synthetic process and required axis confirmation. Registry contents and
both positive reports survive MCP restart with exact deep equality.

## Execution and limits

```sh
npm run accept:material-coupon -- --target ID --allow-live --case registry --output NEW_DIRECTORY
npm run accept:material-coupon -- --target ID --allow-live --case calculation --output NEW_DIRECTORY
```

No args/`--help` are inert. Each run requires an explicit experimental target,
live authorization, case and new output directory. Stores are isolated. Before
restart, document identity/revision, Undo/Redo depths, native scene snapshot,
construction history and durable journal must stay unchanged/empty. After
restart, native identity/history and retained scene collections are compared to
the original baseline. Opaque snapshot IDs are not reused across MCP processes.
The outer disposable catalog harness saves/opens its own empty baseline before
each case; those setup operations are outside the per-case no-mutation claim.

These tools run on the host. Application-connected runs check coexistence with
both experimental versions, not version-specific geometry or physical strength.
Installed applications, settings and security protections remain unchanged.
Orthotropic calibration, physical source authenticity, FEM, manufactured-part
qualification, creep, fatigue, fracture and print authorization are outside this
slice. No production adapter or calculation algorithm is changed.
