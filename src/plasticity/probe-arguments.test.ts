import assert from "node:assert/strict";
import { test } from "node:test";

import { parseProbeArguments } from "../../scripts/probe-construction.ts";

test("parses read-only construction probe defaults", () => {
  assert.deepEqual(parseProbeArguments([]), {
    endpoint: "http://127.0.0.1:9223",
    mutate: false,
    targetId: undefined,
  });
});

test("requires an explicit target for construction probe mutations", () => {
  assert.throws(() => parseProbeArguments(["--mutate"]), /requires --target/i);
  assert.deepEqual(parseProbeArguments(["--mutate", "--target", "window-1"]), {
    endpoint: "http://127.0.0.1:9223",
    mutate: true,
    targetId: "window-1",
  });
});

test("rejects incomplete or unknown construction probe arguments", () => {
  assert.throws(() => parseProbeArguments(["--target"]), /value/i);
  assert.throws(() => parseProbeArguments(["--endpoint"]), /value/i);
  assert.throws(() => parseProbeArguments(["--unknown"]), /unknown/i);
});
