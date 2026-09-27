# Codex app-server compatibility

Verified on 2026-09-21 for `codex-cli 0.153.4` on macOS arm64.

The analysis integration is version-gated. It accepts the generated experimental
v2 app-server protocol only when
`codex_app_server_protocol.v2.schemas.json` has SHA-256
`e5f798fd1343c539f01fedea0e8a84a43c080fcca4615c80eb04a5edab4f7d0a`.
A different executable version or protocol hash returns an unavailable capability.

## Isolation recipe

The server reuses the user's existing Codex authentication through the normal
`HOME`/`CODEX_HOME` lookup; it never reads, copies or stores credentials. Before
starting a model turn it starts app-server only to read the effective
configuration after plugins are disabled. It then starts a fresh process with:

- `app-server --stdio --strict-config`;
- every configured MCP server set to `enabled=false`;
- apps, plugins, shell/unified exec, browser, computer use, web search, image
  generation, delegation, skills, hooks and related tool features disabled;
- an ephemeral thread with `dynamicTools: []`, no environment, no capability
  roots, no runtime workspace roots, `sandbox: read-only` and
  `approvalPolicy: never`.

The empty environment and read-only sandbox are defense in depth. They are not
treated as proof that tools are absent. The analysis probe reads the effective
config and fails before the turn if a configured MCP server or forbidden
feature remains enabled. Its event monitor also fails if a tool, command,
process, MCP, web, image-generation or computer-use item/request appears.

## Product reference search

`plasticity_search_product_references` uses the same pinned executable and
protocol but a separate profile that enables only `web_search: live`. It
continues to disable shell, browser, MCP servers, apps, plugins, dynamic tools,
environments and workspace roots, and it retains the read-only sandbox and
`approvalPolicy: never`. Optional allowed domains are validated, bounded to 20,
and passed to the built-in search configuration. The result URL for every
candidate must match a URL in an app-server web-search result event. A missing
search event or an unmatched URL rejects the response. This profile never
downloads files or mutates Plasticity; a selected STEP still goes through the
separate guarded importer.

The app-server search profile has been exercised with a public product query.
This is a transport smoke test only; no particular product is a project target.
The generated MCP acceptance command below runs the generic
`plasticity_search_product_references` tool and writes a private evidence JSON
into a new directory.

Relevant installed contracts are `thread/start.ephemeral`, `environments`,
`dynamicTools`, `runtimeWorkspaceRoots`, `selectedCapabilityRoots`, `sandbox`,
`approvalPolicy`, `config`, and `turn/start.outputSchema`. The official Codex
configuration reference documents `features.shell_tool`, app defaults and
per-server `mcp_servers.<id>.enabled`:
<https://developers.openai.com/codex/config-reference>.

## Reproduction

The unpaid check performs no model turn:

```sh
node scripts/probe-codex-analysis.ts
```

The live check performs exactly one turn and owns/terminates its app-server:

```sh
node scripts/probe-codex-analysis.ts --live --timeout-ms 60000
node scripts/probe-codex-analysis.ts --live --image /absolute/sketch.png --timeout-ms 60000
```

The product-reference acceptance performs one live, read-only web search through
the MCP tool and writes `evidence.json` in a required new output directory:

```sh
npm run accept:reference-search -- --query "<product> CAD STEP" \
  --search-timeout-ms 180000 \
  --output /tmp/plasticity-mcp-output
```

Observed on 2026-09-21:

- two independent text-only invocations completed with one structured turn each;
- a generated rectangle image was accepted and identified while scale remained
  unknown;
- all three successful invocations reported zero forbidden capability events;
- an explicit 1000 ms timeout interrupted the turn, returned an error and did
  not retry;
- every probe closed its owned app-server in `finally`.

On 2026-09-25, a fresh public-MCP call with `searchTimeoutMs=180000` returned
five candidates after 16 progress notifications. The listing exposed no direct
asset URL, so the search returned no downloadable assets and did not claim an
import or dimensional verification. This is generic transport evidence; the
specific query is outside project scope.

The probe output contains only the structured answer, status and notification
method names. It excludes credentials, raw prompts from user work and account
logs. This compatibility record does not authorize CAD changes and does not
prove engineering calculations.
