#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { discoverPlasticityTargets } from "../src/cdp/discovery.ts";
import { acquireWindowOwnership } from "../src/plasticity/ownership.ts";
import { PlasticityOperations } from "../src/plasticity/operations.ts";
import { PlasticityRuntime, type RuntimeState } from "../src/plasticity/runtime.ts";
import { comparePngPixels } from "./png-pixels.ts";
import { parseNativeSolidPropertiesAcceptanceArgs } from "./verify-native-solid-properties-live.ts";
import { sanitizeEvidence } from "./verify-section-strength-live.ts";

// Bodies that are hidden when a document loads get no GPU meshes. Showing them must build the
// meshes like the outliner does, so the check reopens a saved copy and compares rendered frames.
async function main(): Promise<void> {
  const options = parseNativeSolidPropertiesAcceptanceArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/verify-visibility-after-load-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY\nRequires an empty disposable document. Saves and reopens a fixture with a hidden body and a hidden group, shows them through set_visibility and checks the rendered viewport, Undo/Redo and lock flags.");
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
  try {
    runtime = await PlasticityRuntime.connect(target);
    operations = new PlasticityOperations(runtime);
    initial = await operations.state();
    requireEmpty(initial);
    emptyCopy = join(output, "initial-empty.plasticity");
    await operations.saveCopy(emptyCopy);

    let state = await operations.createBox([0, 0, 0], [20, 10, 5], "Visible fixture", initial.revision);
    state = await operations.createBox([40, 0, 0], [30, 20, 8], "Hidden body fixture", state.revision);
    state = await operations.createBox([0, 30, 0], [25, 15, 10], "Hidden group fixture", state.revision);
    state = await operations.createGroup([bodyNamed(state, "Hidden group fixture").id], [], [], [], "Hidden group", state.revision);
    state = await operations.setNodeVisibility([bodyNamed(state, "Hidden body fixture").id], [], [], [groupNamed(state, "Hidden group").id], false, state.revision);
    const fixture = join(output, "hidden-at-load.plasticity");
    await operations.saveCopy(fixture);
    while (state.undoDepth > initial.undoDepth) state = await operations.undo(state.revision);
    requireEmpty(state);

    documentReplaced = true;
    state = await operations.openDocument(fixture, join(output, "before-reopen.plasticity"), state.revision);
    const hiddenBody = bodyNamed(state, "Hidden body fixture");
    const hiddenGroup = groupNamed(state, "Hidden group");
    assert.equal(hiddenBody.visible, false, "Reopened body is not hidden");
    assert.equal(hiddenGroup.visible, false, "Reopened group is not hidden");

    await operations.setView("isometric", true);
    const hiddenFrame = await viewportFrame(operations, runtime, join(output, "hidden-at-load.png"));
    const priorDepth = state.undoDepth;
    state = await operations.setNodeVisibility([hiddenBody.id], [], [], [hiddenGroup.id], true, state.revision);
    assert.equal(state.undoDepth, priorDepth + 1, "Showing did not add exactly one history step");
    assert.equal(bodyNamed(state, "Hidden body fixture").visible, true, "Body flag remains hidden");
    assert.equal(groupNamed(state, "Hidden group").visible, true, "Group flag remains hidden");
    const shownFrame = await viewportFrame(operations, runtime, join(output, "shown.png"));
    // Two boxes cover several percent of the window; a stale viewport changes only outliner icons.
    const shown = comparePngPixels(hiddenFrame, shownFrame);
    assert.ok(shown.changedPixelRatio >= 0.01, `Viewport does not render the bodies hidden since load (changed ${shown.changedPixelRatio})`);

    state = await operations.undo(state.revision);
    assert.equal(bodyNamed(state, "Hidden body fixture").visible, false, "Undo did not hide the body");
    const undo = comparePngPixels(hiddenFrame, await viewportFrame(operations, runtime, join(output, "undo.png")));
    assert.ok(undo.changedPixelRatio <= 0.0001, `Undo did not restore the hidden viewport (changed ${undo.changedPixelRatio})`);
    state = await operations.redo(state.revision);
    assert.equal(bodyNamed(state, "Hidden body fixture").visible, true, "Redo did not show the body");
    const redo = comparePngPixels(shownFrame, await viewportFrame(operations, runtime, join(output, "redo.png")));
    assert.ok(redo.changedPixelRatio <= 0.0001, `Redo did not restore the shown viewport (changed ${redo.changedPixelRatio})`);
    state = await operations.setNodeVisibility([hiddenBody.id], [], [], [hiddenGroup.id], false, state.revision);
    assert.equal(bodyNamed(state, "Hidden body fixture").visible, false, "Body flag remains visible");
    const hidden = comparePngPixels(hiddenFrame, await viewportFrame(operations, runtime, join(output, "hidden-again.png")));
    assert.ok(hidden.changedPixelRatio <= 0.0001, `Viewport still renders the hidden bodies (changed ${hidden.changedPixelRatio})`);

    state = await operations.setNodeLocked([hiddenBody.id], [], [], [hiddenGroup.id], true, state.revision);
    assert.equal(bodyNamed(state, "Hidden body fixture").locked, true, "Body remains unlocked");
    assert.equal(groupNamed(state, "Hidden group").locked, true, "Group remains unlocked");
    state = await operations.undo(state.revision);
    assert.equal(bodyNamed(state, "Hidden body fixture").locked, false, "Lock Undo did not unlock the body");

    state = await operations.openDocument(emptyCopy, join(output, "before-restore.plasticity"), state.revision);
    requireEmpty(state);
    evidence.frames = { shown, undo, redo, hidden };
    evidence.cleanup = { restoredEmptyDocument: true };
    evidence.completedAt = new Date().toISOString();
    await writeFile(join(output, "evidence.json"), JSON.stringify(sanitizeEvidence(evidence), null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ ok: true, frames: evidence.frames, restoredEmptyDocument: true }));
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
    evidence.failure = String(error).slice(0, 2000);
    await writeFile(join(output, "failure.json"), JSON.stringify(sanitizeEvidence(evidence), null, 2) + "\n", { flag: "wx", mode: 0o600 }).catch(() => {});
    throw error;
  } finally {
    runtime?.close();
    await ownership.release();
  }
}

async function viewportFrame(operations: PlasticityOperations, runtime: PlasticityRuntime, path: string): Promise<Buffer> {
  // Hover outlines depend on the pointer position and are cleared by Undo/Redo.
  // Compare the geometry in the same unhovered state before and after each edit.
  await runtime.read(`function () {
    this.selection.hovered.removeAll();
    for (const viewport of this.viewports) viewport.setNeedsRender();
  }`);
  // The viewport redraws on the next animation frame after a scene change.
  await new Promise((resolve) => setTimeout(resolve, 500));
  await operations.screenshot(path);
  return await readFile(path);
}

function bodyNamed(state: RuntimeState, name: string): RuntimeState["bodies"][number] {
  const body = state.bodies.find((candidate) => candidate.name === name);
  assert.ok(body, `Body ${name} is missing`);
  return body;
}

function groupNamed(state: RuntimeState, name: string): NonNullable<RuntimeState["groups"]>[number] {
  const group = (state.groups ?? []).find((candidate) => candidate.name === name);
  assert.ok(group, `Group ${name} is missing`);
  return group;
}

function requireEmpty(state: RuntimeState): void {
  assert.equal(state.bodies.length + state.regions.length + (state.instances ?? []).length + (state.referenceMeshes ?? []).length, 0, "Refusing a nonempty document");
  assert.equal((state.groups ?? []).filter((group) => group.id !== 0).length, 0, "Refusing non-root groups");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
