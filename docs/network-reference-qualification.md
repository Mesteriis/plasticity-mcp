# HTTPS reference import qualification

Four immutable public assets are downloaded through production stdio MCP and
imported into each experimental Plasticity copy, 26.2.1 and 26.1.3. All eight
runs pass. These are real HTTPS requests through the production public-DNS,
address-pinning and payload-validation path, without a substituted transport.

Source: [SlicerTestModels at e1bbc8eec047c2fb604b71f7e4793c3e0189fd6d](https://github.com/Ghostkeeper/SlicerTestModels/tree/e1bbc8eec047c2fb604b71f7e4793c3e0189fd6d).
The pinned [README](https://github.com/Ghostkeeper/SlicerTestModels/blob/e1bbc8eec047c2fb604b71f7e4793c3e0189fd6d/README.md)
and [license](https://github.com/Ghostkeeper/SlicerTestModels/blob/e1bbc8eec047c2fb604b71f7e4793c3e0189fd6d/LICENSE.md)
identify the models as CC0. The assets are small slicer test models, not
manufacturer geometry or evidence of physical dimensions.

| Repository path | Bytes | SHA-256 | Observed native result |
| --- | ---: | --- | --- |
| `3mf/unit_meters.3mf` | 1441 | `7134f74a27a3b143095dc7f8ba12786cb9d7222d04d6e3f7165f8fac9d05a2f3` | One 10×20×30 mm reference mesh, 8 vertices / 12 triangles; embedded meter units |
| `3mf/everything.3mf` | 10977 | `20a4a4569a6f6dd11c1d520d9e297fa80a6a556bf839f9d9d04d1022f41a408c` | Two material partitions, 4+8 triangles; both bounds (0,0,0)–(20,10,10) mm after source build transform |
| `obj/vertex_indexed.obj` | 136 | `3f752091a4d1824a7dd89fa12cf8530c0446edb1bfa31f7044a90d0895d0b26b` | One reference mesh, 12 triangles, (0,0,0)–(10,10,10) mm with explicitly selected millimeter units |
| `stl/multiple_solids.stl` | 1351 | `ffef73ff1be8a0d51e903c54e8ec13e6d6b7391adbf13659cbf3c89ca016f637` | One reference mesh containing both tetrahedra, 8 triangles, union bounds approximately (-12.2474,-21.2132,0)–(104.495,21.2132,32.6599) mm |

Independent bounded HTTPS preflight produced these hashes. Every live import
matches the expected hash; STL/OBJ private artifact bytes are also rehashed and
compared with acquisition size. The source files are not modified to make
native import pass.

## ASCII STL fix

The original validator allowed one `solid` block and rejected the second block
before CAD import. It now accepts sequential complete solid blocks, validates
every facet as before, and rejects nested/unmatched/unfinished/empty blocks and
facets outside a block. Existing finite-coordinate, normal and exactly-three-
vertices checks remain. The binary STL path is unchanged. The original modern
network rejection remains a separate failed reproduction fixture.

This matches the multiple-solid ASCII behavior documented by the
[Three.js STL loader](https://threejs.org/docs/pages/STLLoader.html). Native
qualification verifies that this particular source reaches Plasticity intact;
it does not certify arbitrary STL topology, closure or orientation.

## Evidence and repeatable commands

The 3MF runner accepts `master` or a full commit SHA only for its reviewed
fixtures; the source page must use the same revision. Credentials, alternate
ports, query strings and fragments are rejected by that fixture-source check.
An optional `--expected-sha256` binds the result to independent review.

```sh
npm run accept:reference-3mf-import -- \
  --target ID --allow-disposable-mutations --output NEW_DIRECTORY \
  --source-fixture unit-meters \
  --source-url https://raw.githubusercontent.com/Ghostkeeper/SlicerTestModels/e1bbc8eec047c2fb604b71f7e4793c3e0189fd6d/3mf/unit_meters.3mf \
  --source-page-url https://github.com/Ghostkeeper/SlicerTestModels/tree/e1bbc8eec047c2fb604b71f7e4793c3e0189fd6d/3mf \
  --license CC0-1.0 \
  --expected-sha256 7134f74a27a3b143095dc7f8ba12786cb9d7222d04d6e3f7165f8fac9d05a2f3

npm run accept:reference-mesh-download -- \
  --target ID --allow-disposable-mutations --output NEW_DIRECTORY \
  --source-url REVIEWED_DIRECT_HTTPS_ASSET --source-page-url REVIEWED_HTTPS_PAGE \
  --format stl --source-unit millimeter --license CC0-1.0 \
  --expected-sha256 REVIEWED_HASH
```

For the second 3MF use `--source-fixture multi-mesh` and its matching pinned file
and hash. For OBJ select `--format obj`; it has no embedded unit, so the chosen
unit is an explicit test interpretation. No args/`--help` are inert. Both runners
require an empty disposable scene and isolate every persistent store. Unknown
timeout/disconnect outcomes stop recovery mutations; known-result recovery
requires matching document and revision.

Each run checks source triangle counts/bounds, approximate-reference labeling,
no B-Rep bodies, stable IDs across Undo/Redo, full initial snapshot restoration,
and four completed durable events with in-sync status after MCP restart.
The 3MF runs additionally recover immutable provenance list/get records with
embedded-unit metadata. STL/OBJ source provenance is bound to durable history;
these cases do not claim a 3MF-style import registry record.

3MF bounds tolerance remains 0.000001 mm. STL/OBJ union-bound tolerance is
max(0.000001 mm, abs(expected coordinate) × 2^-22), allowing binary32 storage and
unit conversion. Triangle totals are exact. Grouping/appearance, rendered
pixels, physical accuracy, arbitrary network failure scenarios, STEP/Parasolid
and asset search/discovery remain outside this qualification. No application
bundle, installed settings or security protections were changed. Scenes finish
empty and idle with synthetic redo history only.
