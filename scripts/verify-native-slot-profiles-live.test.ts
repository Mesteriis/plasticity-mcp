import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeSlotProfilesAcceptanceArgs } from "./verify-native-slot-profiles-live.ts";

test("slot-profile live acceptance parser requires explicit target, mutation opt-in, and output", () => {
  assert.deepEqual(parseNativeSlotProfilesAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
  assert.throws(() => parseNativeSlotProfilesAcceptanceArgs(["--target", "window-1", "--output", "/tmp/evidence"]), /allow-disposable-mutations/u);
  assert.throws(() => parseNativeSlotProfilesAcceptanceArgs(["--allow-disposable-mutations", "--output", "/tmp/evidence"]), /--target/u);
  assert.throws(() => parseNativeSlotProfilesAcceptanceArgs(["--target", "window-1", "--allow-disposable-mutations"]), /--output/u);
  assert.deepEqual(parseNativeSlotProfilesAcceptanceArgs(["--target", "window-1", "--allow-disposable-mutations", "--output", "/tmp/evidence"]), {
    help: false, target: "window-1", allowDisposableMutations: true, output: "/tmp/evidence",
  });
});
