# Durable Plasticity construction history

Every public native mutation that uses the server's `journaled` boundary writes
an immutable local event to `.plasticity-mcp/construction-history`. Set
`PLASTICITY_CONSTRUCTION_HISTORY_ROOT` to move the store. The directory is
created privately and each event file uses mode `0600`. Records are written to
a private temporary file and linked into place only after the complete JSON
payload is flushed.

Events retain the exact MCP operation input, intent, timestamp, document token,
before/after revisions, completed/failed/unknown status and a compact scene
diff. Added, removed and modified bodies retain native bounds plus face/edge
counts; full B-Rep topology is not copied into the history. Inputs can contain
local source paths or dimensions, so the store remains local diagnostic data.
The history is evidence for reconciliation, never permission to replay or
undo an old operation.

`plasticity_construction_history` reads the history without a connected CAD
window and supports offset/limit pagination. After connecting to an explicit
Plasticity window, `plasticity_construction_journal` compares the live document
with the newest durable event and reports `durableSyncStatus`:

- `empty`: no durable events exist.
- `in-sync`: the latest event's after-document and revision match the live
  document.
- `document-changed`: Plasticity is showing another document.
- `manual-edit-detected`: the document matches but its revision differs from
  the last durable event.
- `unknown-outcome-requires-inspection`: the latest event timed out, failed
  after a scene change, or lacks an after-state.
- `history-unavailable`: the local history could not be read, so the live
  document cannot be reconciled with its durable event.

When saving an event fails after a CAD operation, that MCP call still reports
the CAD result rather than pretending it failed. The current-process journal
exposes the persistence warning, pages entries with `offset`/`limit`, and keeps
compact body measurements in memory; detailed B-Rep arrays remain available
through `plasticity_body_info`. Inspect the live scene and the latest durable
event before continuing; never infer that an unrecorded operation did not run.

The live acceptance is
`npm run accept:step-reference-store -- <explicit-empty-target-id>`. It checks
creation, Undo, STEP import, MCP restart, history readback, final Undo, and
empty-scene recovery against Plasticity 26.1.3 using isolated temporary files
and stores.
