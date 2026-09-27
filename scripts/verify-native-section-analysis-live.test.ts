import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNativeSectionAnalysisAcceptanceArgs } from "./verify-native-section-analysis-live.ts";

test("section-analysis acceptance defaults to help and requires explicit live guards", () => {
  assert.deepEqual(parseNativeSectionAnalysisAcceptanceArgs([]), { help: true, allowDisposableMutations: false });
  assert.deepEqual(parseNativeSectionAnalysisAcceptanceArgs(["--help"]), { help: true, allowDisposableMutations: false });
  assert.throws(() => parseNativeSectionAnalysisAcceptanceArgs(["--allow-disposable-mutations", "--output", "/tmp/out"]), /--target/);
  assert.throws(() => parseNativeSectionAnalysisAcceptanceArgs(["--target", "window-1", "--output", "/tmp/out"]), /--allow-disposable-mutations/);
  assert.throws(() => parseNativeSectionAnalysisAcceptanceArgs(["--target", "window-1", "--allow-disposable-mutations"]), /--output/);
  assert.deepEqual(parseNativeSectionAnalysisAcceptanceArgs(["--target", "window-1", "--allow-disposable-mutations", "--output", "/tmp/out"]), {
    help: false, target: "window-1", allowDisposableMutations: true, output: "/tmp/out",
  });
});
