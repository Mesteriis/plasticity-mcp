# Pinned HTTPS STEP and Parasolid qualification

The production stdio MCP downloaded and imported two small immutable public
fixtures on experimental Plasticity 26.2.1 and 26.1.3. All four runs pass.
There is no substituted network transport and no production adapter change.

| Fixture | Pinned source | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| STEP sample | [sample_part.step at 6f6099b](https://github.com/cemrehancavdar/marimo-cad/blob/6f6099b2186228cd8267045b364715c895169b5a/notebooks/sample_part.step) | 19072 | `51bb4cdaa64a1d3cfb9db093eaa0756921c73c501b14aa7e5ce1595164a35b49` |
| Text Parasolid | [MattFerraro cube Gist](https://gist.github.com/MattFerraro/57e5dc45fa10d71c28eb5078ad65626a), raw revision `0c387fe97ccb5a86cda6c860c78fa486b1a1ea8d` | 6531 | `bb9c15ee54e6ee8e5cd2e9159c00b72d80fe8d0b4165384301354b3e00f4bd70` |

Independent bounded HTTPS preflight confirms the hashes and sizes. The STEP
repository has an [MIT license](https://github.com/cemrehancavdar/marimo-cad/blob/6f6099b2186228cd8267045b364715c895169b5a/LICENSE);
the file header has no separate CAD-license statement. The Gist has no explicit
license statement. Both are temporary qualification inputs, not official
manufacturer models. No source CAD bytes are committed. The verifier removes
its known private artifact only after successful restoration and hash checks;
immutable provenance/history and sanitized numeric evidence remain.

## Verified behavior

Both formats use the actual production download/import tools. The suite verifies
source hash/size/final URL and private artifact bytes, one native Solid (not a
reference mesh), nonempty topology, native validity, positive finite mass/area,
finite centroid and bounds with the reported bounds method. It verifies immutable
historical provenance list/get, stable body IDs and geometric consistency across
Undo/Redo, then MCP restart with the imported body still present. The recovered
provenance is unchanged. Final Undo restores the initial empty scene; four
completed durable import/Undo/Redo/Undo events retain the source hash and remain
in sync. The source snapshot is checked before restart, and a full retained
state baseline is compared after restart; opaque in-memory snapshot IDs are
not assumed to survive MCP restart.

| Native observation | STEP | Parasolid |
| --- | --- | --- |
| Bodies / faces / edges / vertices | 1 / 7 / 15 / 10 | 1 / 6 / 12 / 8 |
| Volume, mm³ | approximately 3214.993883194278 | approximately 8000 |
| Surface area, mm² | approximately 1756.9771502188225 | 2400 |
| 26.2.1 bounds method | native-extrema | native-extrema |
| 26.1.3 bounds method | native-box | native-box |

STEP reported bounds are (-10,-10,-5)–(10,10,5) mm on 26.2.1 and
(-10.00005,-10.00005,-5.096123597983848)–
(10.00005,10.00005,5.0961235979838495) mm on 26.1.3. The conservative legacy
bounds are preserved. STEP observations and lifecycle consistency do not prove
independent nominal dimensions or a tight physical envelope.

The Parasolid fixture additionally passes the existing independent planar-box
verifier: eight nominal corners, twelve uniquely paired edges constrained by
six planar boundaries, at (-10,-20,-10)–(10,0,10) mm. Linear tolerance remains
0.00001 mm. Volume 8000 mm³ and area 2400 mm² are checked to 0.0001; centroid
(0,-10,0) mm to 0.00001 mm. The filename says “1 cm cube”, but the acceptance
uses the actual 20 mm native topology and mass, not the filename as a datum.

Native integrations can differ at floating-point roundoff after Redo. Lifecycle
comparison therefore requires exact identity/topology counts, bounds method and
box-proof metadata, and absolute tolerances of 0.00000001 mm for bounds/centroid
and 0.0000001 for volume mm³/area mm². Evidence retains the initial, Redo and
restart observations. Regression tests reject changed IDs/topology/methods,
non-finite properties and geometric drift beyond those gates.

## Repeatable commands and limits

```sh
npm run accept:native-cad-download -- --target ID --allow-disposable-mutations --fixture sample-step --output NEW_DIRECTORY
npm run accept:native-cad-download -- --target ID --allow-disposable-mutations --fixture cube-parasolid --output NEW_DIRECTORY
```

No args/`--help` are inert. Sources and expected hashes are a fixed reviewed
fixture catalog; arbitrary URL overrides are rejected. Every run uses a new
output directory, isolates all stores, and refuses initial scene content,
annotations, analyses or non-root groups. Recovery after a known failure requires
matching document/revision; timeout/uncertain/disconnect outcomes stop mutations.
Scenes finish empty and idle with synthetic redo history. Installed applications,
settings, bundles and security protections are unchanged.

These direct-file cases do not qualify ZIP archives, binary Parasolid, arbitrary
assemblies, network failures, discovery/search, rendered appearance, physical
accuracy or a manufacturer SKU. Existing unaccepted conservative-bounds and
window cases remain separate. Local exchange and network acquisition are
separate evidence scopes even when they share a parser.
