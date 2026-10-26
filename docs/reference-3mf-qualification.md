# Local reference 3MF qualification

Three synthetic local 3MF variants are exercised through production stdio MCP
against separate experimental Plasticity 26.2.1 and 26.1.3 copies:

| Variant | Embedded unit | Expected imported reference meshes |
| --- | --- | --- |
| Default / `millimeter` | millimeter | One 4×4×4 mm cube |
| `meter` | meter | One 4×4×4 mm cube, encoded with 0.004 m edges |
| `two-meshes` | millimeter | Two cubes, bounds (0,0,0)–(4,4,4) and (10,0,0)–(14,4,4) mm |

Each cube has eight vertex entries and twelve triangles. Meshes are matched by
bounds and counts independently of listing order; bounds tolerance is 0.000001
mm. Imported state must contain no editable B-Rep bodies. These are approximate
reference-mesh observations, not B-Rep dimensional or manufacturing proof.

The suite calls the public import, reference-mesh listing and provenance
list/get tools. It verifies embedded-unit provenance, the SHA-256 of the original
local 3MF bytes, historical record identity and bounds, stable mesh IDs through
Undo/Redo, complete source-scene restoration and an in-sync journal. After MCP
restart it reconnects to the same document/revision, verifies the empty scene,
recovers provenance, and requires exactly four completed durable events with
in-sync status. Synthetic source metadata is only a persistence test fixture;
no real manufacturer, license, network download or asset discovery is verified.

## Running

```sh
npm run accept:reference-3mf-import -- --target ID --allow-disposable-mutations --output NEW_DIRECTORY
npm run accept:reference-3mf-import -- --target ID --allow-disposable-mutations --output NEW_DIRECTORY --local-fixture meter
npm run accept:reference-3mf-import -- --target ID --allow-disposable-mutations --output NEW_DIRECTORY --local-fixture two-meshes
```

No arguments/`--help` are inert. Each run requires an empty disposable document,
including no annotations, section analyses or non-root groups. All stores and
artifacts are isolated under the new output directory. Local and remote inputs
cannot be combined. Timeout/uncertain/disconnect outcomes stop recovery
mutations; other recovery requires the original document and last known revision.
Successful cleanup leaves only synthetic redo history; discard that document.
Installed applications, bundles, settings and security protections are unchanged.

All three variants pass on both experimental versions. Unit tests validate ZIP
contents/units/counts using the production archive parser, CLI conflicts,
annotation/group refusal, and uncertain-outcome recovery guards. These tests do
not replace the native live runs. Rendering, remote transport, external services
and solver/physical validation remain separate scopes.

## Full-window capture boundary

A read-only recheck of the default window capture after manual focus still
returns `renderer is hidden` on both experimental versions. Document/revision
and Undo/Redo are unchanged. No guard was bypassed. The separately qualified
foreground CUA HTML-label lifecycle remains valid for its recorded cases; it does
not establish default Chromium full-window MCP capture or background freshness.
