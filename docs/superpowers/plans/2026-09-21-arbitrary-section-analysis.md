# Exact arbitrary-plane section implementation plan

> Execute this plan test-first in the current isolated worktree. Commit each
> coherent slice and integrate it into `main` after live acceptance passes.

**Goal:** expose an exact, read-only Plasticity MCP tool that measures a Solid's
cross-section on a caller-defined plane without changing the document or its
history.

**Architecture:** reuse the existing line/circle loop integrator by extracting
a shared native-boundary integration helper. A new Plasticity adapter creates
an exact temporary Sheet and runs `CutFactory` in a temporary geometry database,
then verifies persistent state invariants. Operations and MCP layers only expose
strict structured parameters.

**Technology:** TypeScript, Node.js 24, MCP TypeScript SDK, Plasticity 26.1.3
native runtime through loopback CDP.

## Task 1: share exact native-boundary integration

**Files:**

- Modify `src/plasticity/section-geometry.ts`
- Modify `src/plasticity/section-geometry.test.ts`

1. Add a failing test that integrates more than one closed boundary from an
   explicit plane frame without requiring a Plasticity face.
2. Export a focused helper and the minimum shared frame types.
3. Make `inspectPlanarSection` call the helper without changing its behavior.
4. Run `node --test src/plasticity/section-geometry.test.ts`.

## Task 2: implement the temporary native section adapter

**Files:**

- Create `src/plasticity/arbitrary-section.ts`
- Create `src/plasticity/arbitrary-section.test.ts`

1. Add failing tests for an exact rectangle, multiple loops, stale revision,
   invalid frames, missing/non-Solid bodies, native-check errors, no section and
   state changes during collection.
2. Implement request/result contracts and pure validation.
3. Implement the native temporary-Sheet and `CutFactory` collection script with
   cleanup in `finally` and compact serializable output.
4. Compare pre/post document, revision, history depths and body IDs before
   accepting evidence.
5. Run `node --test src/plasticity/arbitrary-section.test.ts` and the existing
   section tests.

## Task 3: expose the MCP operation

**Files:**

- Modify `src/plasticity/operations.ts`
- Modify `src/server.ts`
- Modify relevant MCP/server tests
- Modify `src/strength/instructions.ts`

1. Add failing tests for tool discovery, strict schema validation, delegation
   with the owned session ID and compact verified/unsupported results.
2. Add `PlasticityOperations.inspectArbitrarySection`.
3. Register `plasticity_inspect_arbitrary_section` with a strict schema and no
   arbitrary script or file-path parameters.
4. Update agent instructions to use arbitrary planes when an existing face does
   not represent the critical load path.
5. Run the targeted MCP and server tests.

## Task 4: live acceptance and documentation

**Files:**

- Create or modify the native acceptance script under `scripts/`
- Modify `README.md`
- Modify `docs/strength-operations.md`
- Modify `docs/native-access-report.md` if present

1. Add the guarded disposable-document acceptance sequence for horizontal and
   45-degree sections.
2. Run it against the explicit Plasticity target and record the actual evidence.
3. Document the tool, exactness boundary, unsupported cases and recovery rule.
4. Run `npm test`, `npm run typecheck`, any repository lint/build gate, and
   review the complete diff.
5. Commit the package, merge it into `main`, and re-run the integration gates
   from `main`.
