# Plasticity MCP Construction Geometry Design

**Status:** Proposed specification for review

**Date:** 2026-09-20

**Target:** macOS Apple Silicon, Plasticity 26.1.3, Node.js 24

## Purpose

This is the first milestone in the approved Plasticity MCP expansion program.
It gives an agent explicit points, axes, saved construction planes, and an
active workplane so later sketch, hole, direct-edit, sweep, loft, assembly, and
reference-alignment tools do not depend on global XYZ coordinates.

Plasticity remains the source of truth for saved construction planes and exact
B-Rep geometry. Datum points and datum axes are exact MCP references used to
define native operations; they are not advertised as Plasticity scene objects
unless the installed application exposes a verified native persistence path.

## Verified native basis

Read-only inspection of the running Plasticity 26.1.3 renderer confirmed these
bindings and editor surfaces:

- `SaveConstructionPlaneCommand`, with a `constructionPlane` input;
- `RemovePlaneCommand`;
- `ConstructionPlaneDatabase`, available as `editor.planes`, with
  `add`, `remove`, `lookupById`, transaction, snapshot, and validation methods;
- `ConstructionPlaneDatabase.Default`, `Front`, `Back`, `Left`, `Right`,
  `Top`, and `Bottom` identifiers;
- Three.js `Plane` and `Vector3` primitives;
- `CreateViewspaceConstructionPlaneAtOrigin`;
- `editor.snaps.axes`, including the standard coordinate axes.

No verified persistent native point or arbitrary-axis database was found. The
first milestone therefore stores point and axis definitions in the MCP session
as revision-bound datum references. It does not create hidden bodies, patch the
application, or mislabel temporary viewport objects as native CAD entities.

## Scope

The milestone provides:

- exact datum points from coordinates or existing geometry;
- exact datum axes from two points, a linear edge, or a cylindrical face;
- construction planes from an explicit frame, three points, a planar face, an
  offset, or a rotation about a datum axis;
- native saving, listing, activation, and removal of construction planes;
- use of a returned plane frame by existing curve and solid tools;
- revision tracking that includes saved construction-plane state;
- capability reporting, journaling, Undo/Redo, reconciliation, and stale
  reference rejection for the new operations.

Profile projection, trim, extend, region finding, holes, and other later
milestones are outside this specification.

## Architecture

The current `PlasticityOperations` remains the facade used by the MCP server.
Construction geometry is implemented behind that facade rather than adding
more unrelated responsibilities to `operations.ts`.

```text
src/plasticity/
├── construction.ts       # datum definitions and native plane commands
├── references.ts         # document/revision-bound datum registry
├── runtime.ts            # scene state, saved planes, active workplane identity
├── operations.ts         # compatibility facade and existing operations
└── semantic.ts           # geometry-backed point/axis resolution
```

The server registers schemas and public tools, while `construction.ts` owns
all Plasticity-specific command code. `references.ts` owns only typed datum
definitions and their lifecycle. It cannot execute CDP or mutate Plasticity.

This boundary is the template for later milestone modules such as `sketch.ts`,
`direct-edit.ts`, and `analysis.ts`.

## Reference model

Every returned reference includes:

```ts
interface ReferenceIdentity {
  sessionId: string;
  documentToken: string;
  revision: string;
}

interface DatumPointRef extends ReferenceIdentity {
  kind: "datum-point";
  id: string;
  pointMm: [number, number, number];
  definition: PointDefinition;
}

interface DatumAxisRef extends ReferenceIdentity {
  kind: "datum-axis";
  id: string;
  originMm: [number, number, number];
  direction: [number, number, number];
  definition: AxisDefinition;
}

interface ConstructionPlaneRef extends ReferenceIdentity {
  kind: "construction-plane";
  id: string;
  nativeId: string;
  originMm: [number, number, number];
  normal: [number, number, number];
  xDirection: [number, number, number];
  yDirection: [number, number, number];
  definition: PlaneDefinition;
}
```

Directions are normalized. Plane frames are right-handed and orthonormal.
Lengths and coordinates are public millimetres; directions are unitless and
angles are degrees.

Coordinate-defined points and axes are immutable values. Geometry-backed
definitions retain their source body, face, or edge reference and are resolved
again only through an explicit refresh operation. A topology change never
silently retargets a reference.

Standard planes are returned with stable reserved IDs and do not become custom
database entries. Saved custom planes use the native plane ID discovered after
the command commits.

## Public MCP tools

### `plasticity_define_datum_point`

Accepts the current revision and one definition:

- `{ type: "coordinates", pointMm }`;
- `{ type: "face-center", face }`;
- `{ type: "edge-midpoint", edge }`.

It returns a `DatumPointRef`. This is a registry operation and does not add a
Plasticity history entry.

### `plasticity_define_datum_axis`

Accepts the current revision and one definition:

- `{ type: "two-points", first, second }`;
- `{ type: "origin-direction", originMm, direction }`;
- `{ type: "linear-edge", edge }`;
- `{ type: "cylindrical-face", face }`.

It returns a `DatumAxisRef`. Cylindrical-face resolution uses native surface
data, not a mesh fit.

### `plasticity_create_construction_plane`

Accepts the current revision, an optional name, and one definition:

- explicit origin, normal, and x direction;
- three non-collinear datum points;
- planar face with optional signed offset in millimetres;
- existing construction plane with signed offset;
- existing plane rotated by degrees about a coplanar datum axis.

The tool normalizes the frame, executes one native
`SaveConstructionPlaneCommand`, reads the committed plane back from
`editor.planes`, and returns a `ConstructionPlaneRef` plus the new scene state.

### `plasticity_list_construction_geometry`

Returns standard and saved planes, the active workplane, and all datum point
and axis references valid for the current document. Native and MCP-only items
are labelled separately.

### `plasticity_set_workplane`

Activates a standard or saved plane through a capability-gated viewport/grid
adapter. The exact native setter must pass the live probe before this tool is
reported as supported. The tool returns the active frame. Activation is
serialized but is not reported as a B-Rep mutation or a history entry.

### `plasticity_remove_construction_plane`

Removes one saved custom plane through `RemovePlaneCommand`. Standard planes
cannot be removed. References to the removed plane become stale immediately.

### `plasticity_refresh_datum`

Explicitly re-evaluates a geometry-backed point or axis after a topology
revision. It returns a new reference ID and reports `resolved`, `ambiguous`, or
`unresolved`. It never changes an old reference in place.

Existing curve tools gain an optional `plane` input. When supplied, 2D point
coordinates are expressed in that plane's local XY frame and converted to
world millimetres before the native command. Existing 3D inputs remain
compatible.

## Runtime state and revision

`RuntimeState` gains a compact `construction` member containing:

- normalized descriptors for standard and saved planes;
- the active workplane ID and frame;
- a deterministic plane-state token.

The document revision incorporates the plane-state token. Saving, removing,
or manually changing a construction plane therefore invalidates queued
references even when no B-Rep body changed. Merely switching the active
workplane produces a separate view-state token and does not invalidate body,
face, or edge references.

The session clears datum registries when it connects to another window or
detects a replacement document. A normal B-Rep revision keeps old datum
records for diagnostics but rejects their use until explicitly refreshed.

## Command and error semantics

- All inputs are validated before CDP execution.
- Coincident points, collinear plane points, zero directions, parallel normal
  and x direction, and non-coplanar rotation axes are rejected.
- Face and edge inputs carry the same document and revision identity as
  existing topology references.
- Native plane creation and removal are single Plasticity history commands.
- A timeout or lost CDP connection produces an unknown result. The command is
  not repeated and no automatic Undo occurs.
- Reconciliation reads the construction-plane database as well as B-Rep state.
- If a command returns but the requested plane cannot be read back uniquely,
  the operation fails with its observed before/after plane sets and blocks
  dependent work until reconciliation.
- Unavailable native bindings are reported by capability diagnostics; their
  public mutation tools are not advertised as supported.

The public interface never accepts arbitrary JavaScript or raw Plasticity
object IDs.

## Journal and change tracking

Construction mutations use the existing journal wrapper. Completed entries
record the normalized definition, native ID, before/after revisions, and plane
diff. Failed and unknown entries retain the same status semantics as body
operations.

Scene snapshots and `plasticity_changes_since` add:

- saved planes added, removed, or changed;
- active workplane changes;
- datum definitions that became stale because their source topology changed.

## Verification

Automated checks cover:

- normalization and right-handed plane frames;
- rejection of degenerate points, axes, and planes;
- millimetre and degree conversion;
- registry lifecycle across revisions and document replacement;
- standard-plane protection;
- stale face, edge, datum, and plane references;
- MCP initialization, list, validation, journal, and serialization;
- native binding errors, disconnects, timeouts, and reconciliation;
- construction-plane changes in scene diffs;
- backward compatibility of current 3D curve inputs.

Live acceptance uses a disposable empty Plasticity document and verifies:

1. The seven standard plane identifiers and exact frames are readable.
2. A custom plane created from three points is saved and listed natively.
3. A plane offset 12.5 mm from a box face reads back at 12.5 mm.
4. A plane rotated 30 degrees about a verified linear edge reads back with the
   expected normal within 0.01 degrees.
5. Setting a saved plane changes the active workplane without changing B-Rep.
6. A circle defined in local plane coordinates lies on the plane, and its
   extrusion has native bounds consistent with the plane normal.
7. Undo and Redo remove and restore the saved plane through Plasticity history.
8. A manual plane edit or removal is reported by change tracking and makes the
   old reference stale.
9. Save and reopen retain saved custom planes and their frames.

The milestone is complete only after every advertised definition mode passes a
live check in Plasticity 26.1.3. Mock tests alone are insufficient.

## Delivery sequence

1. Extend state and change tracking with read-only construction-plane data.
2. Add typed datum references and pure geometry validation.
3. Implement and live-probe native plane creation, activation, removal, and
   Undo/Redo.
4. Register public tools and journal integration.
5. Add optional plane-local coordinates to curve creation.
6. Run automated checks and the complete live acceptance sequence.
7. Update the capability matrix and operating documentation.

Only after this milestone is accepted does work start on planar profile
projection, intersection, trim, extend, offset, and region detection.
