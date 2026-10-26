# Read-only reference discovery qualification

The production stdio MCP exercises three guarded cases while explicitly connected
to experimental Plasticity 26.2.1 and 26.1.3: provider status, selected-page asset
listing and isolated live web search. These tools run on the host; connecting to
both versions checks that discovery leaves their native scene and history alone.
All three cases pass on both copies. This is not geometry, rendering, download
or import acceptance.

The fixed public source is the [official Radxa ZERO 3W hardware directory](https://dl.radxa.com/zero3/docs/hw/3w/).
The selected-page case finds the STEP archive `radxa_zero_3w_3d_stp.zip`
(`step-archive`), text Parasolid `0_zero_3w_pcba_20250213.x_t.zip`
(`parasolid-text`) and PDF documents. It checks exact reviewed CAD URLs and
formats, no duplicates, no query/fragment-bearing assets and no truncation.
An off-domain page is rejected before retrieval. Only HTML links are inspected;
no archive or model is downloaded, extracted or imported.

The search case uses the existing restricted Codex profile with only live web
search and an explicit `radxa.com` domain boundary. Its fixed public query asks
for one official source page at the known directory URL, with a 180-second
deadline. No local CAD/source contents are included in the prompt. Returned
candidate and asset URLs must stay within the explicit HTTPS domain boundary.
The production client also requires actual web-search events and cross-checks
exact candidate/asset URLs against those events. Search is discovery of leads:
licensing, access, dimensions and model suitability still require review.

On 26.2.1, the initial broader three-candidate request timed out at 120 seconds.
That real failure remains a separate unaccepted fixture. The narrower request
completed, returning the manufacturer directory, unknown licensing and no
dimension evidence. Its asset array was empty because search/open-page events
did not establish exact direct asset URLs; the separate selected-page listing
then supplies those links. The same narrower search and link-listing cases pass
on 26.1.3 with the same evidence limits. This does not establish general product-name search
reliability or a cure for the earlier timeout. No production adapter or isolation
policy was changed. An initial authored listing check used search-schema format
names instead of listing-schema names; corrected expectations pass without
changing the production classifier.

Each case compares document identity, revision, Undo/Redo depth and scene snapshot
before/after; isolated construction history and durable journal must stay empty.
Failure evidence also attempts the same read-only reconciliation. The suite never
performs recovery mutations or automatically retries search. The outer disposable
catalog harness may save/open its own empty baseline before cases; those setup
operations are outside the per-case no-change assertion.

```sh
npm run accept:reference-discovery -- --target ID --allow-live --case status --output NEW_DIRECTORY
npm run accept:reference-discovery -- --target ID --allow-live --case assets --output NEW_DIRECTORY
npm run accept:reference-discovery -- --target ID --allow-live --case search --output NEW_DIRECTORY
```

No args/`--help` are inert. Explicit target, live authorization, case and a new
output directory are required. Query/page/domain overrides are intentionally not
exposed. All stores are isolated and runtime evidence stays private. Status can
pass with an explicit unavailability reason; search requires a real nonempty
result and never substitutes a mock or another provider. Installed applications,
settings, bundles and security protections are outside the suite's write scope.
