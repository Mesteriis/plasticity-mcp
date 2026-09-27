# Plasticity MCP for macOS

## Objective

Build a local stdio MCP server that lets an agent create, inspect, modify,
verify, and save editable technical parts in Plasticity 26.1.3 on Apple
Silicon.

## Native-access gate

Before implementing the full server:

1. Start a separate Plasticity process with Electron CDP bound to loopback,
   leaving the user's existing process untouched.
2. Discover renderer targets and inspect the chosen test window without
   modifying the application package.
3. Locate the native editor and geometry factories in the renderer.
4. In a disposable document, create a box through Plasticity's command
   transaction, read the resulting geometry, and verify Undo and Redo.

If this gate fails, stop with the concrete blocker. Do not switch to UI
automation or another Plasticity version automatically.

## MCP v1

- TypeScript on Node.js 24 using the official MCP TypeScript SDK and stdio.
- Separate MCP transport, session state, and the Plasticity 26.1.3 adapter.
- Tools for connection diagnostics; compact scene, body, face, and edge
  inspection; primitives and basic curves; extrusion, profile revolve,
  Sheet thickening, face draft, transforms, booleans, fillets, equal-distance
  chamfers, native linked instances with independent transforms and realization,
  native assembly groups with hierarchy, active creation destination,
  mixed node selection, exact face/edge highlighting, planar face-to-face and
  cylindrical-axis placement of rigid body sets, exact read-only volumetric interference checks,
  exact Solid volume, surface area, and volume centroid,
  visibility, and lock state,
  rename, and delete; camera, screenshot, measurements, Undo/Redo;
  native document save/open and STEP/Parasolid import/export.
- Named-product acquisition uses the isolated Codex live search, then a
  bounded, selected-page asset listing when the search provider names a CAD
  file without exposing its direct URL. The listing is read-only, constrained
  to explicit domains and public DNS, and must precede the separately selected
  download/import tool; it never constructs file URLs.
- Selected direct 3MF references can be downloaded through the same constrained
  acquisition route and imported by Plasticity's native 3MF importer as an
  approximate reference mesh. Embedded units are honored; the result is never
  presented as editable B-Rep or fit-critical dimensions.
- Public lengths and coordinates use millimetres and angles use degrees.
- Geometry references include session, document, and revision identity.
- Writes are serialized. Timeout or disconnect makes the outcome unknown;
  no retry or automatic Undo is performed before reconciliation.
- No public arbitrary JavaScript execution tool.
- Save and export refuse to overwrite existing files by default.

## Acceptance

Unit and integration tests cover validation, MCP calls, CDP failures,
reconnection, stale references, document changes, ownership, and unknown
write outcomes. Live tests cover every advertised operation and an end-to-end
80 x 40 x 8 mm plate with two 6 mm holes and four 2 mm edge fillets, including
Undo/Redo, native save/reopen, and STEP round-trip verification.

Persistent parametric constraints and other platforms remain outside the
current verified scope. Native direct block, rectangle and cylindrical-radius
dimensioning, revision-bound B-Rep vertices and topology measurements,
persistent native vertex-distance annotations, loft, sweep, native surface
operations, linked instances, assembly groups and Plasticity appearance materials were added
after the original v1 boundary and are listed with their live evidence in the
acceptance matrix.
Persistent distance annotations remain inspection objects: they do not turn
Plasticity direct edits into parametric constraints.

## Practical strength boundary

Strength support stays at the practical decision level needed for printed
enclosures, stands, and brackets: establish what the part supports, how it is
mounted and used, the selected single-material printer/process, relevant
geometry, and obvious risks; ask only for missing facts that change the design
decision. A first-pass screen may guide geometry, but it must state its
assumptions and must not claim certification or verified strength without
supporting evidence. Detailed FEA, layer-adhesion characterization, and coupon
programs are optional experimental capabilities, not gates for completing the
functional MCP contour. Do not expand that analysis further unless a concrete
part or user request needs it. Multi-material strength modelling is outside the
scope.

## Manufacturing scope

The active manufacturing scope is the Creality K1C using the locally verified
Creality Print and OrcaSlicer workflows.

- **Bambu Lab: Soon only.** It is outside the current scope and is not a
  committed implementation step. Revisit it only after the Creality K1C
  workflow is complete and the priority is explicitly changed.
