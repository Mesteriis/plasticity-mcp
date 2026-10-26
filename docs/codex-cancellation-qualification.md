# Codex process failure before a turn ID

The first PR #36 pull-request check failed in the existing AbortSignal test with
an unhandled `CODEX_PROCESS_FAILED: app-server closed` rejection. The parallel
push check and one rerun passed. The [original failed job](https://github.com/Mesteriis/plasticity-mcp/actions/runs/40399206270/job/121840230112)
is retained; rerun success alone was not treated as a fix.

A deterministic local process fixture reproduces the same failure: it records
`turn/start` but withholds its response, the caller aborts, and the child flushes
the late response when SIGTERM begins owned-process shutdown. The run correctly
normalizes cancellation, but a separate process-failure deferred could reject
before the turn-completion race had been created. Its unobserved rejection then
failed the test process. A real child crash during initialization exposed the same
unobserved-deferred problem.

The client now observes the cached process-failure rejection immediately. Pending
RPC requests and the later completion race still receive the original failure;
protocol checks, timeout limits, cancellation boundaries, permissions and cleanup
are unchanged. This is a host-side lifecycle correction, not a native CAD change.

Two new regressions failed before the patch and pass afterwards. They require:

- cancellation before an ID returns `ANALYSIS_CANCELLED`, no retry or invalid
  `turn/interrupt`, an actually flushed late response, and owned-child exit;
- a child crash before a turn starts still reaches the caller as
  `CODEX_PROCESS_FAILED`, with no turn started and an exit record.

The existing active-turn interrupt, timeout, failure, forbidden-request and image
snapshot cleanup checks also pass. Local validation: 15 analysis-client/RPC tests,
1522 full root tests and typecheck pass. No native geometry or rendering result is
inferred from these process tests; direct mouse-edit acceptance on the two
experimental copies remains pending.
