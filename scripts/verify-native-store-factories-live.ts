#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { discoverPlasticityTargets } from "../src/cdp/discovery.ts";
import { acquireWindowOwnership } from "../src/plasticity/ownership.ts";
import { PlasticityOperations } from "../src/plasticity/operations.ts";
import { PlasticityRuntime, type RuntimeState } from "../src/plasticity/runtime.ts";
import { parseNativeSolidPropertiesAcceptanceArgs } from "./verify-native-solid-properties-live.ts";
import { sanitizeEvidence } from "./verify-section-strength-live.ts";

async function main(): Promise<void> {
  const options = parseNativeSolidPropertiesAcceptanceArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/verify-native-store-factories-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY\nRequires an explicitly selected empty disposable document. Tests native face cutting and G2 surface bridge on either adapter version, checks B-Rep and volume, then undoes its fixtures.");
    return;
  }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const endpoint = process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223";
  const target = (await discoverPlasticityTargets(endpoint)).find(candidate => candidate.id === options.target);
  assert.ok(target, "Explicit Plasticity target was not found");
  const ownership = await acquireWindowOwnership(target.id, undefined, endpoint);
  let runtime: PlasticityRuntime | undefined, operations: PlasticityOperations | undefined, initial: RuntimeState | undefined;
  const evidence: Record<string, unknown> = { schemaVersion: 1, startedAt: new Date().toISOString() };
  try {
    runtime = await PlasticityRuntime.connect(target);
    operations = new PlasticityOperations(runtime);
    initial = await operations.state();
    requireEmpty(initial);
    await operations.saveCopy(join(output, "initial-empty.plasticity"));
    let state = await operations.createBox([100, 0, 0], [20, 10, 5], "Cut target", initial.revision);
    const targetId = named(state, "Cut target").id;
    state = await operations.createBox([110, -10, -10], [1, 30, 30], "Cutter", state.revision);
    const cutter = named(state, "Cutter");
    const cutterFace = cutter.faces.find(face => face.planar && face.normal[0] < -0.99)!;
    assert.ok(cutterFace, "Cutter has no exact planar X face");
    const priorDepth = state.undoDepth;
    state = await operations.cutWithFaces([targetId], [{ bodyId: cutter.id, faceId: cutterFace.id }], state.revision);
    assert.equal(state.undoDepth, priorDepth + 1);
    const parts = state.bodies.filter(body => body.id !== cutter.id);
    assert.equal(parts.length, 2, "Face cut did not create two parts");
    const validation = await operations.validateBodies(parts.map(body => body.id), state.revision);
    assert.ok(validation.bodies.every(body => body.nativeValid && body.printableSolid));
    const mass = await operations.measureSolidProperties(parts.map(body => body.id), state.revision);
    for (const body of mass.bodies) assert.ok(Math.abs(body.volumeMm3 - 500) < 1e-5);
    evidence.cut = { oneHistoryStep: true, validation, mass };
    state = await operations.undo(state.revision);
    assert.ok(state.bodies.some(body => body.id === targetId));
    state = await operations.redo(state.revision);
    assert.equal(state.bodies.length, 3);
    while (state.undoDepth > initial.undoDepth) state = await operations.undo(state.revision);
    requireEmpty(state);

    state = await operations.createBox([0, 0, -1], [10, 10, 1], "First source", state.revision);
    const firstSource = named(state, "First source");
    const firstFace = firstSource.faces.find(face => face.planar && face.normal[2] > 0.99)!;
    state = await operations.extractFaces([{ bodyId: firstSource.id, faceId: firstFace.id }], state.revision);
    const first = state.bodies.find(body => body.type === "Sheet")!;
    state = await operations.createBox([20, 0, 5], [1, 10, 10], "Second source", state.revision);
    const secondSource = named(state, "Second source");
    const secondFace = secondSource.faces.find(face => face.planar && face.normal[0] < -0.99)!;
    state = await operations.extractFaces([{ bodyId: secondSource.id, faceId: secondFace.id }], state.revision);
    const second = state.bodies.find(body => body.type === "Sheet" && body.id !== first.id)!;
    state = await operations.remove([firstSource.id, secondSource.id], state.revision);
    const bridgeDepth = state.undoDepth;
    state = await operations.bridgeSurface(
      { bodyId: first.id, faceId: first.faceIds[0]!, pickPointMm: [10, 5, 0] },
      { bodyId: second.id, faceId: second.faceIds[0]!, pickPointMm: [20, 5, 5] }, 20, 1, state.revision,
    );
    assert.equal(state.undoDepth, bridgeDepth + 1);
    assert.equal(state.bodies.length, 1);
    const bridge = state.bodies[0]!;
    assert.equal(bridge.type, "Sheet");
    assert.equal(bridge.faces.length, 3);
    assert.equal(bridge.edges.length, 10);
    assert.ok(bridge.faces.some(face => face.surfaceType === "BSurf" && !face.planar));
    const bridgeValidation = await operations.validateBodies([bridge.id], state.revision);
    assert.ok(bridgeValidation.bodies[0]!.nativeValid);
    evidence.surfaceBridge = { oneHistoryStep: true, faces: 3, edges: 10, validation: bridgeValidation };
    state = await operations.undo(state.revision);
    assert.equal(state.bodies.length, 2);
    state = await operations.redo(state.revision);
    assert.equal(state.bodies.length, 1);
    evidence.undoRedo = true;
  } catch (error) {
    evidence.error = String(error).slice(0, 2_000);
    throw error;
  } finally {
    try {
      if (operations && runtime && initial && !runtime.isUncertain()) {
        let state = await operations.state();
        assert.equal(state.documentToken, initial.documentToken, "Document was replaced during acceptance");
        for (let attempt = 0; attempt < 24 && state.undoDepth > initial.undoDepth; attempt += 1) state = await operations.undo(state.revision);
        requireEmpty(state);
        evidence.cleanup = { restoredEmptyDocument: true };
      }
    } catch (error) {
      evidence.cleanup = { error: String(error).slice(0, 2_000) };
      evidence.error ??= "Acceptance cleanup failed";
    }
    try {
      await writeFile(join(output, "error" in evidence ? "failure.json" : "evidence.json"), JSON.stringify(sanitizeEvidence(evidence), null, 2) + "\n", { flag: "wx", mode: 0o600 });
    } finally {
      runtime?.close();
      await ownership.release();
    }
  }
  assert.equal((evidence.cleanup as { restoredEmptyDocument?: boolean })?.restoredEmptyDocument, true);
  console.log(JSON.stringify({ ok: true, evidence: join(output, "evidence.json") }));
}

function named(state: RuntimeState, name: string) {
  const body = state.bodies.find(body => body.name === name);
  assert.ok(body, `Missing fixture: ${name}`);
  return body;
}
function requireEmpty(state: RuntimeState): void {
  assert.equal(state.bodies.length, 0, "Acceptance requires an empty disposable document");
  for (const key of ["regions", "instances", "referenceMeshes", "measurements", "sectionAnalyses"] as const) assert.equal(state[key]?.length ?? 0, 0);
  assert.ok(state.groups?.every(group => group.id === 0));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
