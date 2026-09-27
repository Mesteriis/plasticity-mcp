# CAD reference acquisition

For named products, call `plasticity_search_product_references` to search the
live web through a dedicated Codex app-server profile. It can restrict results
to up to 20 explicitly supplied domains. The profile has live web search only:
it has no shell, browser, MCP, CAD, local-file, or print tools, runs with a
read-only sandbox, and never downloads or imports a result. Candidate URLs must
match URLs emitted by Codex web-search result events. Prefer manufacturer CAD
and dimensioned drawings, then qualified distributors and established CAD
libraries. Search results are leads, not verified models; the agent must review
the source, license, access status (free, paid, account-required, or
quote-required), exact file format, fit-critical dimensions, and confidence.
Access and license are separate facts. A paid listing is a candidate source
page, never a direct downloadable asset; present the price and license and ask
before any purchase.
Unverified community models remain approximate references.

Plasticity 26.1.3 can import 3MF through its native importer. Use
`plasticity_import_reference_3mf` for a local file or
`plasticity_download_and_import_reference_3mf` for one selected direct HTTPS
asset. The embedded 3MF model unit controls scale (the format default is
millimetres); do not ask for a separate STL-style unit override. The result is
an approximate reference mesh, not editable B-Rep geometry. The package reader
checks safe paths, bounded entry and total expansion, CRCs, mesh indices, and
finite coordinates before storing the content-addressed artifact. Keep its
reported bounds separate from exact dimensions and preserve source/license
provenance in the construction journal.

The search tool sends a progress update every 10 seconds when the MCP client
provides a progress token. Its `searchTimeoutMs` argument defaults to 180000 and
accepts 30000–180000 ms, so a caller may bound an individual search more tightly.
If a search reaches that deadline, the request is interrupted and is not retried
automatically. MCP clients should still set a tool-call deadline that allows the
requested search timeout to finish.

Choose one candidate explicitly before retrieving a STEP file. The search
returns a candidate source page separately from direct asset URLs exposed in
web-search/open-page results. A user-approved direct public STEP asset URL can
then be passed to `plasticity_download_and_import_step` as `sourceUrl`, with
the candidate page supplied as `sourcePageUrl`;
otherwise the agent should keep the discovered source as a citation and ask
about unresolved fit-critical details.

If the selected manufacturer or CAD catalog page names a model but Codex did
not expose its complete asset URL, call `plasticity_list_reference_assets` with
that exact page and the same explicit `allowedDomains` used for search. This
read-only MCP tool makes one bounded HTTPS GET of the selected page without
running its scripts or downloading an asset. The page, redirects, and returned
asset hosts must remain inside the supplied domains and resolve only to public
IPv4 addresses. HTML is capped at 2 MiB; query-bearing links are omitted so
signed download tokens are not returned to the model. It returns only links
whose path identifies STEP, Parasolid, STL, OBJ, or PDF. Review a returned
asset and its license before invoking the separate downloader/importer. The
asset host must also be included in `allowedDomains`, which is why a catalog
under `docs.radxa.com` and files under `dl.radxa.com` require both domains.

The exact source-page URL must appear in captured Codex web-search/open-page
results. Direct asset URLs returned by search are checked separately against
those same results; page-discovered URLs are verified by the bounded selected-
page tool.
If Codex proposes an asset URL that the events did not expose, MCP removes that
asset from the candidate and adds a limitation; the source candidate itself is
preserved when verified. Do not send an omitted URL to a downloader or describe
it as an available direct download. For example, the live Raspberry Pi 5 search
found the manufacturer's STEP catalogue and an official dimensioned drawing,
but the catalogue's STEP ZIP destinations were not present in returned events.
The drawing remained available as a verified PDF candidate and the unsupported
archive URLs were omitted. See the [acceptance matrix](acceptance-matrix.md).

## Product references are task-specific

Product-name search is a generic MCP capability. No specific phone, accessory,
or other named product is part of the project scope by default. Treat search
results as leads for the user's current request, and proceed to retrieval or
import only for a candidate the user selected and when the requested workflow
calls for it. This project does not develop product-specific CAD models as
examples or acceptance fixtures.

For an explicitly selected direct Parasolid file or ZIP archive, use
`plasticity_download_and_import_parasolid` with `representation` set to `x_t`,
`x_b`, `xmt_txt`, or `xmt_bin` only when the source identifies that exact file
representation. `.xmt_txt` is the text form and `.xmt_bin` is the binary form,
as documented by [SOLIDWORKS Parasolid file support](https://help.solidworks.com/2026/english/SolidWorks/sldworks/c_parasolid_files.htm?id=18.18.20). The downloader stores
them with the `.x_t` or `.x_b` extension required by Plasticity's native
importer. A ZIP must contain exactly one member matching the explicitly chosen
text/binary representation. It uses the same pinned-public-IPv4, bounded HTTPS acquisition path
as STEP, checks the Parasolid header, validates the imported artifact hash, and
records the source, format, document revision, and exact B-Rep measurements.
If a source page says only “Parasolid” without identifying text or binary
representation, keep it as a candidate and do not guess the representation.

For a selected public STEP URL or ZIP archive,
`plasticity_download_and_import_step` retrieves the file and imports it into the
explicitly selected Plasticity document. A
ZIP must contain exactly one `.step` or `.stp` member; ambiguous archives are
rejected rather than guessed. The importer checks ZIP structure and CRC, caps
archives at 128 MiB and expanded CAD members at 256 MiB, and stores the source
ZIP by its own hash alongside the extracted content-addressed STEP. Durable
provenance records the archive hash and selected member path. The tool accepts
HTTPS on the default port only, rejects credentials and IP-literal
hosts, resolves and pins public IPv4 addresses for each request, rejects any
private or reserved DNS answer, allows at most four HTTPS redirects, uses one
120-second deadline for DNS, redirects and the streamed response, limits each
response to 512 MiB, and requires a complete STEP text envelope. It stores
files under `.plasticity-mcp/reference-artifacts` by SHA-256
with private file permissions. Set `PLASTICITY_REFERENCE_ARTIFACT_ROOT` to
choose another local artifact directory.

The direct asset URL and optional source-page URL have query values redacted
in the returned provenance to avoid persisting signed-download tokens; the
content hash identifies the exact artifact. The final redirect URL is reported
with the same redaction.
Existing local files can still be imported with `plasticity_import_step`.
Both routes use the normal revision guard, native import, durable reference
provenance, and construction journal. After import, inspect the current B-Rep
and lock reference bodies before creating functional geometry.

Large STEP/Parasolid imports and full scene read-backs allow up to five minutes
for Plasticity's native CAD work. MCP clients should request progress
notifications and set a suitable tool-call timeout; this server sends a
progress update every 10 seconds when the request includes a progress token.
Scene revisions hash the complete per-body identity/material/visibility/lock
signature into a fixed-size token, so large imported assemblies still fit the
durable provenance record limits while manual edits remain detectable.

Automated tests cover URL validation, private-address rejection, redirects,
response limits, STEP completeness, query redaction, stale revision rejection
before network access, and MCP provenance. Live acceptance downloaded a public
community STEP sample from
[`marimo-cad/notebooks/sample_part.step`](https://github.com/cemrehancavdar/marimo-cad/blob/main/notebooks/sample_part.step),
imported one native B-Rep body into Plasticity 26.1.3, read its exact bounds
and provenance, then used Undo to restore the empty test document. The tested
artifact SHA-256 was
`51bb4cdaa64a1d3cfb9db093eaa0756921c73c501b14aa7e5ce1595164a35b49`; imported
bounds were approximately 20.0001 × 20.0001 × 10.19225 mm. The sample's
embedded license is unknown and its geometry was not treated as verified
product dimensions. The isolated live search workflow is available; live
retrieval of a user-selected official product model remains a separate
acceptance step.

The live Parasolid acceptance packages a Plasticity-exported `.x_t` in a
single-member ZIP and sends it through the production downloader and native MCP
import. Exact 30 × 20 × 8 mm B-Rep bounds, archive hash/member provenance, and
Undo cleanup passed on Plasticity 26.1.3 using a deterministic HTTPS fixture.
Live external acquisition and native import are also verified for two official
Radxa ZIPs: a STEP model and a Parasolid `.x_t` PCBA assembly. The Parasolid
acceptance imported 543 B-Rep bodies from a 106,791,584-byte member, stopped
the test MCP and reconnected with new session/store instances, verified the
same native scene plus recovered reference provenance and construction
history, then undid back to an empty document. Archive/member and extracted
file hashes are recorded in the
[acceptance matrix](acceptance-matrix.md). Neither Radxa CAD archive states an
explicit reuse license; the imported bounds and component set are not
qualified for a different hardware SKU.

Run the live acceptance against an explicit empty Plasticity target with a
public STEP URL:

```sh
npm run accept:step-reference-download -- <target-id> <https-step-url>
```

For a manufacturer Parasolid file or single-member ZIP with a known `.x_t`
representation:

```sh
npm run accept:parasolid-reference-download -- <target-id> <https-parasolid-or-zip-url> [source-page-url]
```

The acceptance undoes only the import it successfully completed at the same
revision; it leaves an uncertain or subsequently edited scene untouched.
