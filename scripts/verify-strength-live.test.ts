import assert from "node:assert/strict";
import test from "node:test";

import { hasSceneContentChanges, isDisposableEmptyDocument, LIVE_CODEX_TIMEOUT_MS, parseAcceptanceArgs, strengthSketchPrompt, syntheticEulerBenchmark } from "./verify-strength-live.ts";
import { calculate } from "../src/strength/calculate.ts";
import { strengthInputSchema } from "../src/strength/schemas.ts";

test("help and default modes cannot enable live work", () => {
  assert.deepEqual(parseAcceptanceArgs([]), {
    help: true,
    allowDisposableMutations: false,
    liveCodex: false,
  });
  assert.equal(parseAcceptanceArgs(["--help"]).help, true);
});

test("live acceptance requires every explicit flag and target", () => {
  assert.throws(
    () => parseAcceptanceArgs(["--target", "window", "--allow-disposable-mutations", "--output", "/tmp/new"]),
    /live-codex/i,
  );
  assert.throws(
    () => parseAcceptanceArgs(["--live-codex", "--allow-disposable-mutations", "--output", "/tmp/new"]),
    /target/i,
  );
  assert.deepEqual(
    parseAcceptanceArgs([
      "--target", "window-1",
      "--allow-disposable-mutations",
      "--live-codex",
      "--output", "/tmp/new-output",
    ]),
    {
      help: false,
      target: "window-1",
      allowDisposableMutations: true,
      liveCodex: true,
      output: "/tmp/new-output",
    },
  );
});

test("live acceptance accepts only one explicit absolute image path", () => {
  assert.throws(() => parseAcceptanceArgs(["--image"]), /requires an absolute/u);
  assert.throws(() => parseAcceptanceArgs(["--image", "relative.png"]), /absolute/u);
  assert.throws(() => parseAcceptanceArgs(["--image", "/tmp/a.png", "--image", "/tmp/b.png"]), /only one/iu);
  const parsed = parseAcceptanceArgs([
    "--target", "window-1", "--allow-disposable-mutations", "--live-codex",
    "--output", "/tmp/new-output", "--image", "/tmp/sketch.png",
  ]);
  assert.equal(parsed.image, "/tmp/sketch.png");
});

test("Codex live prompt distinguishes attached images from the text-only case", () => {
  assert.match(strengthSketchPrompt(true), /attached synthetic.*image/is);
  assert.match(strengthSketchPrompt(false), /no image is attached/i);
});

test("unknown and incomplete arguments are rejected", () => {
  assert.throws(() => parseAcceptanceArgs(["--target"]), /requires/i);
  assert.throws(() => parseAcceptanceArgs(["--unknown"]), /unknown/i);
});

test("cleanup distinguishes revision history from remaining scene content", () => {
  const revisionOnly = {
    documentChanged: false,
    added: [],
    removed: [],
    modified: [],
    constructionPlanesAdded: [],
    constructionPlanesRemoved: [],
    constructionPlanesModified: [],
    activeWorkplaneChanged: null,
  };
  assert.equal(hasSceneContentChanges(revisionOnly), false);
  assert.equal(hasSceneContentChanges({ ...revisionOnly, added: [{ id: 1 }] }), true);
  assert.equal(hasSceneContentChanges({ ...revisionOnly, documentChanged: true }), true);
});

test("disposable strength acceptance requires an empty scene and clean native history", () => {
  const empty = {
    undoDepth: 0,
    redoDepth: 0,
    bodies: [],
    regions: [],
    instances: [],
    referenceMeshes: [],
    measurements: [],
    sectionAnalyses: [],
    groups: [{ bodyIds: [], instanceIds: [], referenceMeshIds: [], otherNodeKeys: [], childGroupIds: [] }],
  };
  assert.equal(isDisposableEmptyDocument(empty), true);
  for (const key of ["bodies", "regions", "instances", "referenceMeshes", "measurements", "sectionAnalyses"] as const) {
    assert.equal(isDisposableEmptyDocument({ ...empty, [key]: [{}] }), false, `${key} must be empty`);
  }
  assert.equal(isDisposableEmptyDocument({ ...empty, groups: [{ ...empty.groups[0], otherNodeKeys: [7] }] }), false);
  assert.equal(isDisposableEmptyDocument({ ...empty, undoDepth: 1 }), false);
  assert.equal(isDisposableEmptyDocument({ ...empty, redoDepth: 1 }), false);
  assert.equal(isDisposableEmptyDocument({ ...empty, groups: undefined }), false);
  assert.equal(isDisposableEmptyDocument({ ...empty, measurements: undefined }), false);
});

test("live Codex acceptance allows longer than the MCP default timeout", () => {
  assert.ok(LIVE_CODEX_TIMEOUT_MS > 60_000);
  assert.ok(LIVE_CODEX_TIMEOUT_MS <= 300_000);
});

test("live Euler fixture is a traceable synthetic case with exact elastic column references", () => {
  const input = syntheticEulerBenchmark();
  assert.equal(strengthInputSchema.safeParse(input).success, true);
  const result = calculate(input);
  assert.equal(result.status, "conditional");
  assert.ok(Math.abs(result.buckling!.criticalLoadN - 822.4670334241132) < 1e-9);
  assert.ok(Math.abs(result.buckling!.criticalStressMPa - 4.112335167120566) < 1e-10);
});
