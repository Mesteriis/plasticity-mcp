import assert from "node:assert/strict";
import test from "node:test";

import { combineDetailedBodyPage, parseNativePointPlanarCircularFaceAcceptanceArgs } from "./verify-native-point-planar-circular-face-live.ts";

test("circular planar-face acceptance defaults to inert help", () => {
  assert.deepEqual(parseNativePointPlanarCircularFaceAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
  assert.equal(parseNativePointPlanarCircularFaceAcceptanceArgs(["--help"]).help, true);
});

test("circular planar-face acceptance requires explicit mutation guards", () => {
  assert.throws(() => parseNativePointPlanarCircularFaceAcceptanceArgs(["--target", "target", "--output", "/tmp/output"]), /allow-disposable-mutations/i);
  assert.throws(() => parseNativePointPlanarCircularFaceAcceptanceArgs(["--allow-disposable-mutations", "--output", "/tmp/output"]), /--target/i);
  assert.throws(() => parseNativePointPlanarCircularFaceAcceptanceArgs(["--target", "target", "--allow-disposable-mutations"]), /--output/i);
  assert.throws(() => parseNativePointPlanarCircularFaceAcceptanceArgs(["--typo"]), /unknown argument/i);
  assert.deepEqual(parseNativePointPlanarCircularFaceAcceptanceArgs([
    "--target", "target", "--allow-disposable-mutations", "--output", "/tmp/output",
  ]), { help: false, target: "target", allowDisposableMutations: true, output: "/tmp/output" });
});

test("circular planar-face acceptance joins compact mutations to same-revision detailed bodies", () => {
  const summary = { documentToken: "doc", revision: "r2", undoDepth: 1, bodies: [{ id: 1, faceCount: 6 }] };
  const page = { documentToken: "doc", revision: "r2", bodies: [{ id: 1, faces: [], edges: [] }], bodyPagination: { offset: 0, total: 1, nextOffset: null } };
  assert.deepEqual(combineDetailedBodyPage(summary, page), { ...summary, bodies: page.bodies });
  assert.throws(() => combineDetailedBodyPage(summary, { ...page, revision: "r3" }), /revision changed/u);
  assert.throws(() => combineDetailedBodyPage(summary, { ...page, bodyPagination: { ...page.bodyPagination, nextOffset: 1 } }), /incomplete/u);
});
