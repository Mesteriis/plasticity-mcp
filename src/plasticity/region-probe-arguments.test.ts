import assert from "node:assert/strict";
import { test } from "node:test";

import { parseRegionProbeArguments } from "../../scripts/probe-regions.ts";

test("parses read-only region probe defaults", () => {
  const parsed = parseRegionProbeArguments([]);
  assert.equal(parsed.mutate, false);
  assert.equal(parsed.targetId, undefined);
  assert.match(parsed.endpoint, /^http:\/\/127\.0\.0\.1:/);
});

test("requires an explicit target for region probe mutations", () => {
  assert.throws(() => parseRegionProbeArguments(["--mutate"]), /requires --target/i);
  assert.deepEqual(parseRegionProbeArguments(["--mutate", "--target", "window-1"]), {
    endpoint: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223",
    mutate: true,
    targetId: "window-1",
  });
});

test("rejects incomplete or unknown region probe arguments", () => {
  assert.throws(() => parseRegionProbeArguments(["--target"]), /requires a value/i);
  assert.throws(() => parseRegionProbeArguments(["--unknown"]), /unknown region probe argument/i);
});
