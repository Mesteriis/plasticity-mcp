import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { parseNativeUiEditArgs } from "./verify-native-ui-edits-live.ts";

test("native UI edit acceptance defaults to inert help", () => {
  assert.deepEqual(parseNativeUiEditArgs([]), { help: true, allowDisposableMutations: false });
  assert.equal(parseNativeUiEditArgs(["--help"]).help, true);
});

test("live native UI edit acceptance requires an explicit target, disposable-mutation guard, and output", () => {
  assert.throws(() => parseNativeUiEditArgs(["--target", "window"]), /allow-disposable-mutations/);
  assert.throws(() => parseNativeUiEditArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/);
  assert.deepEqual(parseNativeUiEditArgs([
    "--target", "window", "--allow-disposable-mutations", "--output", "/tmp/evidence",
  ]), { help: false, target: "window", allowDisposableMutations: true, output: "/tmp/evidence" });
});

test("native UI edit acceptance rejects unknown and incomplete arguments", () => {
  assert.throws(() => parseNativeUiEditArgs(["--unexpected"]), /Unknown argument/);
  assert.throws(() => parseNativeUiEditArgs(["--target"]), /requires an explicit Plasticity/);
  assert.throws(() => parseNativeUiEditArgs(["--output"]), /requires a new directory/);
});


test("manual UI acceptance refuses unattended mutation before creating evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-ui-guard-"));
  const output = join(root, "evidence");
  try {
    await assert.rejects(promisify(execFile)(process.execPath, [
      "scripts/verify-native-ui-edits-live.ts", "--target", "unattended", "--allow-disposable-mutations", "--output", output,
    ]), /requires an interactive terminal/);
    await assert.rejects(access(output));
  } finally { await rm(root, { recursive: true, force: true }); }
});
