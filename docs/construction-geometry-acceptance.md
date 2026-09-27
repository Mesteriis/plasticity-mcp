# Construction Geometry Acceptance

**Platform:** macOS Apple Silicon  
**Plasticity:** 26.1.3  
**MCP transport:** local stdio with Plasticity CDP on loopback  
**MCP commit under test:** `44806bb65728dec04c2dc4fb6f1b21c776d06163` plus the verified saved-name fix in the final Task 9 commit
**Selected disposable target:** `TARGET_ID`
**Milestone status:** native construction-geometry acceptance passed with the limitations recorded below

The final post-integration mutation probe ran on fresh disposable target
`TARGET_ID` and passed create/read/Undo/Redo,
workplane activation, `12.5 mm` unit conversion, requested-name read-back, and
cleanup through the final adapter.

## Native access proof

The proof ran in a disposable Plasticity window with no bodies. The original
model window remained open and was not modified.

| Check | Observed result | Status |
| --- | --- | --- |
| Required renderer bindings | `SaveConstructionPlaneCommand`, `RemovePlaneCommand`, `ConstructionPlaneDatabase`, `ConstructionPlaneSnap`, `CreateViewspaceConstructionPlaneAtOrigin`, `Plane`, and `Vector3` present | PASS |
| Standard planes | Six `ConstructionPlaneSnap` records expose `p`, `n`, `x`, and `y` | PASS |
| Saved-plane database | `editor.planes.snapshot()` returns `counter`, native-ID mapping, ordered plane records, and version | PASS |
| Native construction | One `SaveConstructionPlaneCommand` adds exactly one saved plane | PASS |
| Undo | Saved plane disappears and plane database version returns from 1 to 0 | PASS |
| Redo | Same saved plane and frame reappear and plane database version returns to 1 | PASS |
| Active workplane | `viewport.constructionPlane` has a getter and setter; setting the saved plane is readable immediately and restoring Top succeeds | PASS |
| Units | Public offset `12.5 mm` is observed as internal point coordinate `0.0125` | PASS |

## Verified native contract

Plasticity 26.1.3 accepts a construction plane as:

```ts
const plane = new ConstructionPlaneSnap(normal, point, xDirection);
const command = new SaveConstructionPlaneCommand(editor, plane);
await editor.exec(command);
```

`normal`, `point`, and `xDirection` are Three.js `Vector3` values. Position
coordinates are metres. Although `ConstructionPlaneSnap.length` is `0`, live
construction proves the argument order above. `ConstructionPlaneDatabase.add`
creates the displayed default name, so the adapter assigns the requested name
to the returned saved record before committing the transaction. A live plane
named `Verified Native Name` survived save and reopen with the same name and
frame.

The plane database snapshot stores saved planes in `planes`; its `ids` entries
map plane-array indexes to native string IDs. The proof created
native ID `"0"` in a previously empty saved-plane database. Production code
must discover the added ID from before/after snapshots rather than assume the
counter value.

The active workplane is read and written through the first viewport's
`constructionPlane` accessor. Standard planes come from
`ConstructionPlaneDatabase.Top`, `.Bottom`, `.Left`, `.Right`, `.Front`, and
`.Back`.

## History evidence

| State | Undo depth | Redo depth | Plane version |
| --- | ---: | ---: | ---: |
| Before save | 1 | 1 | 0 |
| After save | 2 | 0 | 1 |
| After Undo | 1 | 1 | 0 |
| After Redo | 2 | 0 | 1 |
| After proof cleanup | 1 | 1 | 0 |

The extra pre-existing history entry belongs to disposable-window setup. The
save itself adds exactly one Undo entry. Cleanup used an explicit Undo only
after the complete create/read/Undo/Redo proof passed; the probe does not retry
or automatically undo an uncertain command.

## Integrated MCP acceptance

The run started by undoing the two setup bodies and verifying that the selected
document contained zero bodies. It then defined a coordinate datum, redid the
box and cylinder, and continued through an in-memory official MCP client. The
original model window `TARGET_ID` was not changed.

| Operation | Native observation | Tolerance/evidence | Status |
| --- | --- | --- | --- |
| Structured capabilities | `constructionPlanes.available=true`, `activeWorkplane.available=true` | Direct adapter and MCP response | PASS |
| Coordinate point | `[1,2,3] mm` | Exact registry value | PASS |
| Face-center point | Planar box face center returned from `FindMidpoint()` | Native B-Rep, not mesh bounds | PASS |
| Edge-midpoint point | Linear box edge midpoint returned from `GetPointAndTangent(0.5)` | Native B-Rep | PASS |
| Origin-direction axis | `[0,0,5]` normalized to `[0,0,1]` | Direction error below `1e-12` | PASS |
| Two-point axis | Points `[0,0,0]` and `[10,0,0]` produced `[1,0,0]` | Direction error below `1e-12` | PASS |
| Linear-edge axis | Exact edge midpoint and tangent | Native curve data | PASS |
| Cylindrical-face axis | Cylinder radius `5 mm`, origin `[100,0,0]`, axis `[0,0,1]` | `Cylinder.GetInfo().basis`; exact radius read-back | PASS |
| Explicit plane | Origin `[0,0,20]`, normal `[0,0,1]` | Frame read back from saved plane | PASS |
| Three-point plane | Origin `[0,0,25]`, normal `[0,0,1]` | Frame read back from saved plane | PASS |
| Planar-face plane | Box face center plus `1 mm`; observed Z `9 mm` | Difference below `1e-12 mm` | PASS |
| Offset plane | `12.5 mm` from the explicit plane; observed Z `32.5 mm` | Difference below `1e-12 mm` | PASS |
| Rotated plane | Top rotated `30°` around X; normal `[0,-0.5,0.8660254038]` | Direction error below `1e-12` | PASS |
| Workplane activation | `activePlaneId=plane:5` immediately after assignment | Runtime descriptor read-back | PASS |
| Plane-local circle | Local center `[20,10]`, radius `4 mm` on rotated plane | Wire bounds and subsequent native cylinder radius `4 mm` | PASS |
| Profile extrusion | `12 mm` along rotated normal; result is a native cylindrical **Sheet** with axis `[0,-0.5,0.8660254038]` | Radius `4 mm`; B-Rep surface read-back | PASS with limitation |
| Plane Undo/Redo | Saved-plane count `5 → 6 → 5 → 6`; Undo/Redo depths changed by one | Direct state after every command | PASS |
| External saved-plane edit | `changes_since` reported exactly one `constructionPlanesAdded` record | Revision changed; no body false positives | PASS |
| Stale datum after edit | Old two-point datum rejected with old/current revisions in the error | No mutation dispatched | PASS |
| Save/reopen | Nine saved planes and four model items reopened | Native `.plasticity` header and state read-back | PASS |
| Saved plane name | `Verified Native Name` retained after reopen | Exact string and frame read-back | PASS |
| STEP export | Exact B-Rep export, `11,436` bytes, valid ISO-10303 envelope | Export validation in adapter | PASS |
| Timeout recovery | Automated MCP test records `unknown`; reconcile reads once and does not resubmit | Live disconnect injection was not run | PASS (automated) |

The Sheet result recorded during this acceptance run was produced by the old
`ExtrudeFactory.curves` path. It is superseded by the verified native region
adapter documented in [planar-regions-acceptance.md](planar-regions-acceptance.md):
`plasticity_extrude_profile` now resolves one unambiguous automatic Region and
creates a capped Solid, while nested loops use explicit revision-bound Region
IDs.

The reopened acceptance document was
`[local acceptance artifact omitted]`. The earlier exact
STEP artifact was `[local acceptance artifact omitted]`. These are
temporary local evidence files and are not repository fixtures.
