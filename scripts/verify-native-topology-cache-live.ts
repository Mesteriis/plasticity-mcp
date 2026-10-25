#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { discoverPlasticityTargets } from "../src/cdp/discovery.ts";
import { nativeFunction } from "../src/plasticity/native-function.ts";
import { acquireWindowOwnership } from "../src/plasticity/ownership.ts";
import { PlasticityOperations } from "../src/plasticity/operations.ts";
import { PlasticityRuntime, type RuntimeState } from "../src/plasticity/runtime.ts";
import { parseNativeSolidPropertiesAcceptanceArgs } from "./verify-native-solid-properties-live.ts";
import { sanitizeEvidence } from "./verify-section-strength-live.ts";

// Compare production cached reads against a fresh native topology walk. Only
// the renderer's disposable MCP cache changes; document geometry stays intact.
export async function verifyCachedTopology(runtime: PlasticityRuntime): Promise<RuntimeState> {
  const cached = await runtime.getState();
  const repeated = await runtime.getState();
  assert.deepEqual(repeated, cached, "repeated cached reads must agree");
  const populated = await runtime.read<boolean>(nativeFunction`function () {
    const cache = globalThis[Symbol.for('plasticity-mcp.body-topology')];
    return Boolean(cache) && [...nativeApi.geo.geometryModel].every(([versionId, item]) =>
      cache.get(item.view)?.versionId === versionId);
  }`);
  assert.equal(populated, true, "every current body must have a topology cache entry");
  await runtime.read(`function () {
    const saved = Symbol.for('plasticity-mcp.body-topology-acceptance.saved');
    if (globalThis[saved]) throw new Error('Another topology acceptance read is active');
    globalThis[saved] = globalThis[Symbol.for('plasticity-mcp.body-topology')];
    globalThis[Symbol.for('plasticity-mcp.body-topology')] = new WeakMap();
  }`);
  try {
    assert.deepEqual(await runtime.getState(), cached, "cached topology must equal a fresh native walk");
  } finally {
    await runtime.read(`function () {
      const saved = Symbol.for('plasticity-mcp.body-topology-acceptance.saved');
      globalThis[Symbol.for('plasticity-mcp.body-topology')] = globalThis[saved];
      delete globalThis[saved];
    }`);
  }
  return cached;
}

async function main(): Promise<void> {
  const options = parseNativeSolidPropertiesAcceptanceArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/verify-native-topology-cache-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY\nRequires an empty disposable document. Verifies repeat reads, rename, movement, Undo/Redo, linked-source edits and document reopening against uncached native topology.");
    return;
  }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const endpoint = process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223";
  const target = (await discoverPlasticityTargets(endpoint)).find((candidate) => candidate.id === options.target);
  assert.ok(target, "Explicit Plasticity target was not found");
  const ownership = await acquireWindowOwnership(target.id, undefined, endpoint);
  let runtime: PlasticityRuntime | undefined;
  let operations: PlasticityOperations | undefined;
  let initial: RuntimeState | undefined;
  let emptyCopy: string | undefined;
  let documentReplaced = false;
  const evidence: Record<string, unknown> = { schemaVersion: 1, startedAt: new Date().toISOString() };
  const stages: string[] = [];
  try {
    runtime = await PlasticityRuntime.connect(target);
    operations = new PlasticityOperations(runtime);
    initial = await operations.state();
    requireEmpty(initial);
    emptyCopy = join(output, "initial-empty.plasticity");
    await operations.saveCopy(emptyCopy);
    let state = await operations.createBox([0, 0, 0], [20, 10, 5], "Topology cache fixture", initial.revision);
    const sourceId = state.bodies[0]!.id;
    const check = async (label: string) => { state = await verifyCachedTopology(runtime!); stages.push(label); };
    await check("created-box");
    state = await operations.rename(sourceId, "Renamed cache fixture", state.revision);
    await check("rename");
    assert.equal(state.bodies[0]!.name, "Renamed cache fixture");
    state = await operations.move([sourceId], [7, 3, 2], state.revision);
    await check("move");
    boundsNear(state.bodies[0]!.boundsMm, { min: [7, 3, 2], max: [27, 13, 7] });
    state = await operations.undo(state.revision);
    await check("undo-move");
    boundsNear(state.bodies[0]!.boundsMm, { min: [0, 0, 0], max: [20, 10, 5] });
    state = await operations.redo(state.revision);
    await check("redo-move");
    boundsNear(state.bodies[0]!.boundsMm, { min: [7, 3, 2], max: [27, 13, 7] });
    state = await operations.createInstance(sourceId, [40, 0, 0], state.revision);
    await check("linked-instance");
    assert.equal((state.instances ?? []).length, 1);
    const top = state.bodies[0]!.faces.find((face) => face.planar && face.normal[2]! > 0.999999);
    assert.ok(top, "Top face is unavailable");
    state = await operations.moveFaces([{ bodyId: sourceId, faceId: top.id }], [0, 0, 2], state.revision);
    await check("linked-source-face-edit");
    boundsNear(state.bodies[0]!.boundsMm, { min: [7, 3, 2], max: [27, 13, 9] });
    assert.ok(state.instances![0]!.sourceBodyIds.includes(sourceId));
    const editedCopy = join(output, "edited-fixture.plasticity");
    await operations.saveCopy(editedCopy);
    while (state.undoDepth > initial.undoDepth) state = await operations.undo(state.revision);
    requireEmpty(state);
    documentReplaced = true;
    state = await operations.openDocument(editedCopy, join(output, "before-reopen.plasticity"), state.revision);
    await check("reopened-document");
    assert.equal(state.bodies.length, 1);
    boundsNear(state.bodies[0]!.boundsMm, { min: [7, 3, 2], max: [27, 13, 9] });
    assert.equal((state.instances ?? []).length, 1);
    state = await operations.openDocument(emptyCopy, join(output, "before-restore.plasticity"), state.revision);
    requireEmpty(state);
    evidence.stages = stages;
    evidence.cleanup = { restoredEmptyDocument: true };
    evidence.completedAt = new Date().toISOString();
    await writeFile(join(output, "evidence.json"), JSON.stringify(sanitizeEvidence(evidence), null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ ok: true, stages, restoredEmptyDocument: true }));
  } catch (error) {
    // A lost mutation outcome must be reconciled by the caller, never undone
    // automatically. Known failures can restore only this disposable fixture.
    try {
      if (runtime && operations && initial && !runtime.isUncertain()) {
        let state = await operations.state();
        if (documentReplaced && emptyCopy) {
          state = await operations.openDocument(emptyCopy, join(output, "failure-backup.plasticity"), state.revision);
        } else if (state.documentToken === initial.documentToken) {
          while (state.undoDepth > initial.undoDepth) state = await operations.undo(state.revision);
        }
        evidence.cleanup = { restoredEmptyDocument: state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0 };
      } else {
        evidence.cleanup = { restoredEmptyDocument: false, reason: runtime?.isUncertain() ? "mutation-outcome-uncertain" : "initial-state-unavailable" };
      }
    } catch (cleanupError) {
      evidence.cleanup = { restoredEmptyDocument: false, reason: String(cleanupError).slice(0, 2000) };
    }
    evidence.stages = stages;
    evidence.failure = String(error).slice(0, 2000);
    await writeFile(join(output, "failure.json"), JSON.stringify(sanitizeEvidence(evidence), null, 2) + "\n", { flag: "wx", mode: 0o600 }).catch(() => {});
    throw error;
  } finally {
    runtime?.close();
    await ownership.release();
  }
}

function boundsNear(actual: RuntimeState["bodies"][number]["boundsMm"], expected: { min: number[]; max: number[] }): void {
  assert.ok(actual, "Body bounds are unavailable");
  for (const side of ["min", "max"] as const) expected[side].forEach((value, axis) => {
    assert.ok(Math.abs(actual[side][axis]! - value) <= 1e-8, `Incorrect ${side} bound on axis ${axis}`);
  });
}

function requireEmpty(state: RuntimeState): void {
  assert.equal(state.bodies.length + state.regions.length + (state.instances ?? []).length + (state.referenceMeshes ?? []).length, 0, "Refusing a nonempty document");
  assert.equal((state.groups ?? []).filter((group) => group.id !== 0).length, 0, "Refusing non-root groups");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
