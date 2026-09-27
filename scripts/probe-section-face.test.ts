import assert from "node:assert/strict";
import test from "node:test";

import { parseSectionProbeArgs } from "./probe-section-face.ts";

test("defaults to help without enabling mutations", () => {
  assert.deepEqual(parseSectionProbeArgs([]), { help: true, mutate: false });
});

test("requires an explicit target before enabling mutations", () => {
  assert.throws(() => parseSectionProbeArgs(["--mutate"]), /target/i);
});

test("accepts the explicit disposable mutation guard", () => {
  assert.deepEqual(
    parseSectionProbeArgs([
      "--target",
      "window-1",
      "--mutate",
      "--allow-disposable-mutations",
    ]),
    {
      help: false,
      targetId: "window-1",
      mutate: true,
      allowDisposableMutations: true,
    },
  );
});
