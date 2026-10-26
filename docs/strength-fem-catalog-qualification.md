# Strength and FEM catalog qualification

These checks use only the two approved experimental Plasticity copies, isolated
stores, and owned synthetic geometry/data. They qualify software paths for the
stated fixtures; they do not qualify a printed part, material, physical test,
thread fit, or strength/print approval.

## Calculation and registry scenarios

Run `npm run accept:strength-catalog -- --target ID
--allow-disposable-mutations --case CASE --output NEW_DIRECTORY`.

The same three cases passed on 26.2.1 and 26.1.3:

- `scenarios`: independent numerical checks for single-fastener bearing/shear-out/
  net-section stress, fastener-member interaction, insert pullout, tongue-root
  bending/shear/deflection, and fastener-group forces/moment equilibrium.
- `coupon-root`: a synthetic coupon provides E=2000 MPa and G=740 MPa. Formula
  and native-section verification agree for a 30 × 10 × 5 mm box, section at
  X=5 mm and 20 mm lever arm. Independent design allowables remain separate from
  coupon peaks. Undo restores the scene and makes the bound report stale;
  restart preserves exact saved reports and native state.
- `thread-registry`: synthetic physical-test-schema attestations exercise
  immutable registration/idempotency, exact matching, layer-height/engagement
  rejection, conflicting-clearance ambiguity and restart persistence. These
  attestations are explicitly synthetic, stored only in disposable roots.

## Actual solver paths

`npm run accept:fem-static-patch -- --target ID --allow-disposable-mutations
--output NEW_DIRECTORY` uses actual Gmsh/CalculiX. Its base patch, two named load
cases, four mesh levels, orthotropic/layerwise inputs, selective global supports,
principal-stress/element-location diagnostics, reaction equilibrium and report
freshness checks passed on both versions. A continuation adds a second report
with overlapping mesh levels and checks public report comparison without
changing shared mesh hashes or solver values, then checks staleness after Undo.
The continuation passed on both versions and is recorded in the catalog matrix.

`npm run accept:cohesive-mixed-mode -- --target ID --allow-disposable-mutations
--output NEW_DIRECTORY` passed on both versions with actual Code_Aster 17.4.
Synthetic DCB/ENF/MMB records recover the prescribed BK exponent eta=2; an explicit
complete one-interface layer plan drives the solve. Damage is extracted from
MED output. A successful single-interface fixture does not qualify a more complex
two-interface bracket. Reports retain `strengthPass=false` and
`printApproved=false`.

### Retained two-interface failure

The updated `accept:fem-bracket` fixture first corrected obsolete test-axis,
material-process and layer-plan inputs to the current public contracts. Its
300-layer fixture explicitly samples interfaces 100 and 200, so layer coverage
is incomplete. This does not relax the all-interfaces requirement for small
stacks.

The valid-input two-interface orthotropic bracket failed in Code_Aster on both versions.
A separate diagnostic replay used byte-identical generated mesh, command and
export files with the same pinned image, CPU/memory/network limits and solver
settings. It reproduced exit 1: `TimeLimitError / MECANONLINE9_1`, repeated Newton
oscillation and subdivision near pseudo-time 0.97, without a result MED file.
This is an unresolved nonlinear solver limitation for that input. The full
bracket fixture remains unaccepted; earlier successful calls inside it do not
contribute tool coverage. The full 26.1.3 run independently reports the same CPU limit at instant 97. Its
new persisted solver log retains the primary cause. Guarded cleanup undoes its
four owned native steps; read-only reconciliation confirms an empty idle scene.
No convergence tolerance, load, physical parameter or resource cap was weakened.

The runner now saves its bounded captured output to `solver-output.log` in the
owned job directory (exclusive creation, mode 0600). Failure summaries preserve
an early severe diagnostic and the shutdown tail. Cancellation/timeouts also
preserve captured output before rethrowing. This improves diagnosis; it does not
resolve nonlinear convergence. Logs retain the existing capture bound of 8 × 1024 × 1024 characters.

## Live analysis

The text-only unscaled strength interview passed on both versions using the
actual configured Codex analysis service, followed by analytical/native strength
benchmarks, cancellation, CAD-bound report staleness and restart persistence.
The verifier checks structural invariants: no adopted dimensional method,
no fabricated millimeter measurements, unscaled/unknown interpretation and one
next question. A sourced observation that dimensions were not supplied is valid;
acceptance does not depend on a particular English phrase or evidence status.

The design-reference scenario passed on both versions using two repository-owned
unscaled synthetic PNG views. `accept:design-reference-multiview` accepts optional `--target ID` for a
read-only native binding. It checks attribution to both views, no millimeter
measurements, at most one question, exact saved request after restart, and
unchanged native scene/revision/history. These PNGs are input fixtures, not
Plasticity viewport or full-window rendering evidence.

## Safety and evidence boundaries

All updated native verifiers use isolated stores and reject nonempty scenes or
dirty native history. Uncertain timeout/transport/cancellation outcomes suppress
automatic Undo and require read-only reconciliation. Numerical evidence,
physical qualification and rendered pixels remain separate. The full goal stays
active until retained failures and missing workflows have explicit dispositions.

Direct mouse-edit acceptance is still pending accessible foreground windows.
Its verifier now limits cleanup to the exact owned document/revision/Solid and
a maximum two-step history. Regression tests require zero mutations on foreign
ownership or excess history and verify sequential revisions for valid cleanup.
Final local gates: 1520 root tests and typecheck pass.
