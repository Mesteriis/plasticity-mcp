# Full catalog completion audit

Objective: finish all checks for the existing 371-tool catalog on experimental
Plasticity 26.2.1 while preserving 26.1.3 compatibility. This objective is active.
A completed slice, green unit tests or a catalog count is not full completion.

## Required evidence

- Every tool/version needs a meaningful current production-path scenario.
  Metadata discovery, arbitrary invalid-input rejection and successes inside failed
  fixtures do not establish working support.
- Corresponding native scenarios must use the two approved experimental copies.
  Host-only calculations are labelled separately from geometry/rendering proof.
- Known failures need a current disposition: reproduced and fixed with regression,
  confirmed supported rejection, or an explicitly unresolved limitation/blocker.
  Historical failed evidence must be retained, including after fixes.
- Relevant local test/typecheck, native numerical and persistence checks, final CI
  and PR review must cover the resulting changes. Unrun gates remain unverified.
- Installed app bundles/settings/security and user CAD/data must remain untouched.
  Synthetic stores and owned disposable scenes are used for qualification.

## Current tool evidence

Source: [machine-readable catalog audit](plasticity-26-2-catalog-audit.json).
Current successful coverage is **371/371 on both 26.2.1 and 26.1.3**.
Every entry has at least one successful production stdio call in a completed
passing application-connected fixture. This is fixture coverage, not universal
argument/workflow acceptance or physical manufacturing qualification.

The [strength/FEM continuation](strength-fem-catalog-qualification.md) closes the
remaining calculation, registry, actual solver/report-comparison and live
Codex analysis/design-reference tool scenarios. The full two-interface bracket
is separate and remains unaccepted. The same nonlinear CPU-limit failure is confirmed on both versions.
Catalog coverage alone does not complete the goal.

## Retained failures and current dispositions

These are historical failed fixtures, not all necessarily current product defects.
Counts below preserve the evidence; fixes do not delete their original failures.
Current dispositions are linked below; unresolved numerical/UI limits remain explicit.

| Failure category | 26.2.1 retained cases | 26.1.3 retained cases |
| --- | ---: | ---: |
| `ascii-stl-multiple-solids-rejected` | 1 | 0 |
| `authored-fixture-contract-mismatch` | 1 | 0 |
| `cantilever-method-deflection-limit` | 1 | 0 |
| `circular-imprint-nominal-measurement-gate` | 1 | 1 |
| `cohesive-two-interface-nonlinear-cpu-limit` | 1 | 1 |
| `interactive-gesture-required` | 1 | 1 |
| `mmb-arm-thickness-halved` | 1 | 0 |
| `pipe-channel-nominal-bounds-gate` | 0 | 1 |
| `public-interface-failure-location-mapping` | 1 | 0 |
| `reference-search-timeout` | 1 | 0 |
| `stale-window-html-pixels` | 1 | 1 |
| `step-import-nominal-bounds-gate` | 0 | 1 |
| `thread-envelope-and-fractional-helix-gate` | 3 | 3 |
| `ui-fixture-interrupted-user-edits` | 1 | 0 |
| `ui-move-not-committed` | 2 | 0 |
| `unsupported-fractional-turns` | 2 | 2 |
| `viewport-unavailable` | 3 | 3 |

## Remaining completion gates

The [failure disposition audit](catalog-failure-dispositions.md) now reconciles
all retained categories. The valid-input two-interface bracket fails on both
versions at instant 97 with a nonlinear CPU-limit error. The final legacy run
also verifies persisted primary solver diagnostics and guarded four-step cleanup;
read-only reconciliation confirms both native scenes empty and idle.

1. Complete direct mouse-edit acceptance on both experimental copies. The
   [direct UI qualification](direct-ui-edit-qualification.md) records the current
   state: exact focus/return is now automated and verified, but an observed CUA
   drag delivered motion with `buttons=0`. It is not held-button mouse evidence.
   A clean manual one-move fixture on 26.2.1 is waiting for a human gesture;
   the corresponding 26.1.3 fixture follows only after it completes.
2. PR #35 review and both checks on head
   `2e1ad0b33734bdcdf08ef6ce85a56831f68cce2e` passed; it is merged as
   `d93130396a5c22aa787127be9ea02e183b4b3861`. Its local 1520 root tests and
   typecheck passed. PR #36 is also merged as
   `168a16a3c63895b7fd9fc32e3ece410c2010eb85`: its first PR check failed in
   the existing AbortSignal case, and one rerun passed. The deterministic
   [cancellation regression](codex-cancellation-qualification.md) fixes that
   independently reproduced race; 1522 local tests and typecheck pass. Its final
   review/CI is pending. No unrun or failed workflow becomes a pass.
3. Keep the two-interface nonlinear limitation explicit. Catalog coverage is
   complete, but the full goal remains active; new solver physics or universal
   background-window freshness are not implied by fixture coverage.
