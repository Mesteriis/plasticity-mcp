# STEP and Parasolid reference provenance

`plasticity_import_step` and `plasticity_import_parasolid` compute SHA-256 from
each local source file and return it as `importedArtifactHash`. Durable records
identify the source format (`step` or `parasolid`). For ZIP-based acquisition,
the record also stores the source archive hash, bounded archive size, and exact
member path, while `artifactHash` continues to identify the extracted CAD file.
Optional source metadata adds an HTTPS
direct asset URL, optional candidate page URL, source category, known license
and confidence; MCP attaches the same hash as `sourceReference.artifactHash`. The construction journal records
the hash and optional metadata with the import's before/after revision and
scene diff. Successful imports are also stored as immutable local records in
`.plasticity-mcp/references`; set `PLASTICITY_REFERENCE_ROOT` to choose another
directory. Each record includes the canonical source path, artifact hash,
optional provenance, Plasticity document token/title and import revision, plus
the compact exact B-Rep bounds and face/edge counts of bodies changed by the
import. The directory is created with mode `0700` and records with mode `0600`.

Use `plasticity_list_cad_reference_imports` to page through STEP and Parasolid
record summaries and `plasticity_get_cad_reference_import` to read one record.
The older `plasticity_list_step_imports` and `plasticity_get_step_import` names
remain aliases. Both identify their results as
historical. Body IDs and revisions in stored records are evidence from the
import snapshot; they are not valid current-scene references after subsequent
edits or document changes. Re-read the current Plasticity scene before using
any body ID. If Plasticity import succeeds but writing the local record fails,
the import tool still reports its completed CAD result and returns
`provenancePersisted: false` with `persistenceError`; the construction journal
remains the source for reconciling that completed operation.

After import, the agent must compare scene snapshots, inspect the newly added
bodies with native B-Rep bounds and solid-property tools, then group and lock
reference bodies before creating separate functional geometry. Mesh bounds
remain approximate and do not gain dimensional authority from a source hash.

`plasticity_search_product_references` performs read-only source discovery
through a dedicated live-web Codex app-server profile. It returns candidate
page and direct asset URLs only when present in web-search/open-page results
and has no file, browser, CAD, MCP, or print access. It never downloads or
imports. The Codex agent still reviews the candidate and chooses one source
before calling a retrieval or import tool; it must not invent an asset URL when
the source page does not expose one. When Workbench is active, the source file must be uploaded into
the project before registering the artifact hash and reference record. The
construction journal remains session-only, while CAD-reference provenance records
survive an MCP restart locally.

Automated MCP coverage verifies local hashing, HTTPS validation, persistent
record reads after store recreation, historical labeling, and journal entry
against a temporary synthetic STEP file. On 2026-09-24, the full persistent
path was also checked against Plasticity 26.1.3 through MCP: a disposable
10 × 20 × 30 mm Solid was exported to STEP, undone, re-imported, and measured
from the native B-Rep; all dimensions were within 0.01 mm. The import record
was read after closing and recreating the MCP server, with the same hash and
body bounds. A final Undo restored the initially empty document. The live
acceptance command is `npm run accept:step-reference-store -- <target-id>`;
it refuses to run unless the explicitly selected document is empty and uses a
temporary STEP file and isolated provenance store. This proves local durable
fingerprinting, not retrieval from manufacturer sites.
