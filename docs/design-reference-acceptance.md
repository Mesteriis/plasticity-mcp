# Photo/sketch design-reference acceptance

On 2026-09-24, `plasticity_analyze_design_reference` ran through a real
stdio MCP client and the installed Codex API against
[`scripts/fixtures/unscaled-bracket-sketch.png`](../scripts/fixtures/unscaled-bracket-sketch.png).
The MCP server used a separate temporary request store and did not connect to
Plasticity or mutate a CAD document.

The latest result completed with `scaleStatus: unscaled`, `proposedMethod:
null`, nine observations, one next-step question package, and zero observations
measured in millimeters. Every interface and feature claim referenced an
existing observation ID; identifiers stayed out of the natural-language
article name. The returned question asked what the bracket supports and how it
is mounted. On a second real turn, the user answer said the object and mounting
surface were unknown, with stationary indoor use and no impact. The model kept
scale unknown, asked a different next question requesting the supported
product/model or a photo, and added no millimeter measurements. Reading either
completed persisted request returned its stored result without starting a
second Codex turn.

This acceptance verifies image interpretation, explicit scale uncertainty,
evidence links, bounded follow-up questioning, persistence, and no CAD side
effects for one synthetic bracket sketch. It does not verify reconstruction
from arbitrary photographs, product-model search, strength, or engineering
printability.

After adding the explicit Codex attachment-root allowlist, a second live
Codex API check copied this same fixture into a temporary folder under
`~/.codex/attachments` and passed that external path through
`createAnalysisClient` while the project remained its working root. Codex
returned 10 observations, one next question, `scaleStatus: unscaled`, and no
millimeter measurements. The temporary attachment was removed afterward; no
Plasticity window was connected or changed. This verifies direct access to
Codex's attachment location, not arbitrary photographic reconstruction.

The end-to-end acceptance `npm run accept:design-reference-to-native --
--target TARGET_ID --allow-disposable-mutations
--live-codex --output /tmp/plasticity-mcp-output
--image scripts/fixtures/unscaled-bracket-sketch.png` verified the complete
image → one decision question → explicit dimension answer → native CAD route.
Real Codex analysis returned one question and no measured millimeter
observations; after the explicit answer it returned no remaining questions.
Only the answer's stated dimensions (base 80 × 30 × 4 mm, upright 80 × 4 × 40
mm) were used. Plasticity 26.1.3 produced one valid, closed, printable native
Solid with measured B-Rep bounds 80 × 30 × 44 mm. Three Undo operations restored
the empty document. This disposable geometry-only fixture makes no strength or
engineering-printability claim; it does not validate arbitrary photos or
image-derived dimensions. Evidence:
`[local acceptance artifact omitted]`.

On 2026-09-24, `swift scripts/fixtures/generate-design-reference-views.swift`
created four distinct, dimensionless PNG views of one synthetic gusseted
bracket. `npm run accept:design-reference-multiview -- --live-codex` sent the
four views through the production stdio MCP to one real Codex API turn without
connecting to Plasticity. The result completed with nine observations, all
carrying valid one-based `sourceImageIndices`; every image was cited, one next
question was returned, scale remained `unscaled`, and no millimeter dimensions
were inferred. The front view supported the upright plate and its two holes,
the side/detail views supported the right-angle form and gusset, and the top
view supported the two foot holes. The uncertain gusset extent cited the three
views that showed its geometry, while missing dimensions and application
context cited the relevant visual set. This verifies source attribution across
different synthetic views, not reconstruction from arbitrary photographs,
physical product views, exact dimensions, or strength. Evidence:
`[local acceptance artifact omitted]`.

Automated request-lifecycle tests also verify that image identity includes the
SHA-256 content of each trusted image, not only its path. Reusing the same
request ID after changing the bytes at that path returns a conflict; if the
file changes between request fingerprinting and the client's analysis start,
the MCP client rejects the request before opening a Codex turn. Before
analysis, the client copies validated bytes into a private mode-0700 temporary
directory, verifies their hash against the request fingerprint, and gives
Codex only these mode-0400 copies. A fake app-server test hashes the supplied
files to confirm byte identity and checks that the temporary copy is removed
after analysis. This protects a running analysis from later changes to the
original attachment path; it is not protection against a same-user process
that deliberately changes the private temporary file itself.

After adding the private snapshots, the same dimensioned drawing was run again
through the production stdio MCP and real Codex API. The request completed
with `scaleStatus: dimensioned`, five sourced measurements (80 × 40 mm plate,
6 mm thickness, two Ø6 holes, 40 mm hole spacing), each attributed to image
index 1, and one question about the still-unspecified hole offsets. This also
confirms the snapshot path works with the real Codex API, beyond the fake
app-server test. Evidence: `[local acceptance artifact omitted]`.

On 2026-09-27 the reusable live image verifier was broadened to accept one through
four distinct views; `npm run accept:design-reference-images -- --live-codex
--output NEW_DIRECTORY --image /absolute/photo.jpg [--image ...]` runs the actual
stdio MCP and isolated Codex API without connecting to CAD or Workbench. A real
photograph of an installed metal L-bracket was selected from Wikimedia Commons'
[CC0 source page](https://commons.wikimedia.org/wiki/File:Metal_brace_to_support_enclosure.jpg)
(author: Tomwsulcer; direct file SHA-256:
`c0ab6848a5d55e0349a2c397579613b6f497c68492745afca7a2ab6acc71dbf0`). The first
live calls failed because the profile inherited desktop model `gpt-6-sol`, which
the ChatGPT-account Codex API rejected with HTTP 400. The isolated API profile now
pins `gpt-6-astra`, the model already proven by live reference-search acceptance,
and failed turns retain only a bounded, redacted diagnostic category/status/message.
The same real photo then completed through production stdio MCP and Codex API:
seven attributed observations, `scaleStatus: unscaled`, zero measured millimeter
values, and one focused question about the bracket's intended connection. The
observations distinguish visible holes and clipped corners from uncertain
concealed mounting and load path. Evidence: `[local acceptance artifact omitted]`;
persisted result: `[local acceptance artifact omitted]`.
No CAD document or Workbench project was changed.
