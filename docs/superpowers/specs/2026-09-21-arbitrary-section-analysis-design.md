# Plasticity MCP: exact arbitrary-plane sections

Status: approved continuation of the critical-section roadmap, 2026-09-21.

Implementation status: exact inspection and CAD-bound arbitrary-plane strength
reports are implemented and live-verified against Plasticity 26.1.3. The
backward-compatible report-binding extension was completed on 2026-09-23; see
the `CAD-привязка расчёта к внутренней критической плоскости` acceptance row.

## Purpose

Add a read-only MCP operation that measures the exact intersection of a Solid
with an arbitrary plane. This removes the current requirement that an existing
planar face must coincide with the critical section. It supports section checks
through the middle of brackets, bosses, ribs and enclosure features while
keeping Plasticity as the CAD system of record.

## Public contract

`plasticity_inspect_arbitrary_section` accepts a current `bodyId`, document
`revision`, and a plane frame:

```ts
{
  bodyId: number;
  revision: string;
  plane: {
    originMm: [number, number, number];
    normal: [number, number, number];
    xDirection: [number, number, number];
  };
}
```

The normal and X direction are normalized into a right-handed frame. Parallel,
zero-length or non-finite directions are rejected. The result contains exact
closed loops and the same area, centroid and inertia properties returned by
the face-bound section inspector. Its source is
`native-brep-temporary-section`. A plane binding includes the MCP session,
document, revision, body, normalized plane and topology signature.

The operation returns `unsupported` for a missing or duplicate body, a
non-Solid, a failed native body check, a plane that does not produce a proper
cross-section, disconnected or open topology, and curve kinds outside the
existing exact line/circle integrator. It never falls back to a mesh.

The inspection increment exposes exact section evidence for inspection and
unbound section calculations. A later backward-compatible extension also lets
`plasticity_verify_section_strength` accept this plane binding, repeat the
native cut before persisting the report, and re-inspect the plane when checking
report freshness. Both paths retain the exact body, session, document,
revision, plane and section-topology identity.

## Native implementation

The adapter uses the path proven against Plasticity 26.1.3 on macOS:

1. Resolve the current stable body once and require a checked native Solid.
2. Create a temporary geometry database containing the current geometry by
   reference.
3. Create a native rectangular Sheet on the requested plane. Its centre is the
   body bounding-box centre projected onto the plane; its size safely covers
   the body's projected diagonal.
4. Build the Sheet's visual view inside the temporary database.
5. Run native `CutFactory.calculate(factory.partition)` against the Solid and
   Sheet face.
6. Read exact line and circle edges from coplanar cut faces on one side of the
   partition, then integrate their loops.
7. Call `factory.cancel()` and remove only the explicitly created Sheet.

Factory-owned cut results are never manually removed. The implementation uses
Plasticity's temporary database, so the persistent scene and history should not
change.

## Invariants and failure handling

The adapter snapshots the document token, revision, undo depth, redo depth and
stable body identities before native collection and reads them again afterward.
Any difference discards the result. A timeout or lost CDP connection keeps the
operation outcome uncertain and is handled by the existing session policy; the
command is not retried.

The temporary native objects are cleaned in `finally`. Cleanup failure is an
operation failure, because returning measurements without proving isolation
would make the evidence unsafe.

## Acceptance

Automated tests cover input validation, stale references, native failures,
multiple loops, exact integration, session delegation and strict MCP schemas.
The live acceptance script starts from an empty disposable document, creates a
20 × 10 × 5 mm box, measures:

- the horizontal mid-plane at z = 2.5 mm, area 200 mm²;
- a 45-degree plane through the centre, area `100√2` mm².

Each measurement must preserve document identity, revision, undo/redo depths
and body identities. The script then undoes the disposable box and confirms the
document is empty.
