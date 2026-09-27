# Planar Region acceptance

**Date:** 2026-09-20  
**Plasticity:** 26.1.3 on Apple Silicon macOS  
**Native target:** disposable empty window `TARGET_ID`  
**Transport:** loopback CDP; the public-tool check used a real stdio MCP client

Plasticity automatically derives a hidden `SketchIsland` and one or more
`Region` views from closed coplanar Wire bodies. The adapter now exposes those
regions with the current document revision and sends selected regions to
`ExtrudeFactory.regions`. It does not modify Plasticity.app or execute UI
automation.

## Verified results

| Check | Native observation | Status |
| --- | --- | --- |
| Region discovery | Closed 20 × 10 mm Wire returned one Region associated with the Wire stable ID | PASS |
| Closed-profile extrusion | `plasticity_extrude_profile` returned a 6-face, 12-edge Solid with exact B-Rep bounds 20 × 10 × 12 mm | PASS |
| Nested loops | Ø20 and Ø6 concentric circles returned a disc Region and an annular Region | PASS |
| Explicit-region extrusion | The annular Region returned a 4-face, 4-edge Solid with exact B-Rep bounds 20 × 20 × 8 mm and a native cylindrical hole | PASS |
| Multiple regions | Two disjoint 10 × 10 mm Regions extruded in one call returned two Solids with exact 10 × 10 × 5 mm B-Rep bounds | PASS |
| Open profile rejection | An open Wire was rejected before factory commit, did not add a history entry, and did not mark the CDP transport uncertain | PASS |
| Undo/Redo | Undo removed each Solid while preserving source Wires; Redo restored the same exact B-Rep bounds | PASS |
| Cleanup | The reusable mutation probe restored the original empty document and history depth | PASS |
| MCP transport | A spawned stdio client connected, listed the Region, extruded the profile, verified Undo/Redo, and cleaned the document | PASS |

Run the read-only capability check with:

```sh
npm run probe:regions
```

Run the mutation proof only against an explicitly selected empty test window:

```sh
npm run probe:regions -- --mutate --target <target-id>
```

`plasticity_list_regions` returns `displayBoundsMm` with
`measurementSource: "render-mesh"`. These approximate bounds help an agent
choose among regions and are not dimensional proof. All acceptance dimensions
above come from the resulting native body's `FindBox()` B-Rep bounds with a
0.01 mm linear tolerance.

`sketchWireIds` contains every stable Wire on the Region's sketch. It is useful
for grouping coplanar geometry, but it is not an exact ordered boundary-loop
description for one Region.

Region IDs are automatic topology IDs. They are rejected after the document
revision changes. A Wire can be sent directly to `plasticity_extrude_profile`
only when its sketch contains exactly one Region. Nested loops and other
multi-region sketches require `plasticity_list_regions` followed by
`plasticity_extrude_regions`.
