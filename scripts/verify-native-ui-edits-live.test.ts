import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { parseNativeUiEditArgs, recoverNativeUiFixture } from "./verify-native-ui-edits-live.ts";

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


test("UI cleanup refuses foreign ownership and excess history, and undoes only its two owned steps", async () => {
  const initial = { documentToken: "owned", undoDepth: 0 };
  const baseline = { documentToken: "owned", revision: "r2", undoDepth: 2, bodies: [{ id: 7, faces: [] }], regions: [] };
  for (const changed of [{ documentToken: "foreign" }, { revision: "foreign" }, { bodies: [{ id: 99, faces: [] }] }, { undoDepth: 3 }]) {
    const calls: string[] = [];
    const client = { callTool: async ({ name }: { name: string }) => {
      calls.push(name); return { content: [{ type: "text", text: JSON.stringify({ ...baseline, ...changed }) }] };
    } } as unknown as Client;
    assert.equal((await recoverNativeUiFixture(client, initial, "r2", 7)).restoredEmptyDocument, false);
    assert.deepEqual(calls, ["plasticity_status"]);
  }
  const revisions: string[] = [];
  const client = { callTool: async ({ name, arguments: args }: { name: string; arguments: { revision?: string } }) => {
    if (name === "plasticity_status") return { content: [{ type: "text", text: JSON.stringify(baseline) }] };
    assert.equal(name, "plasticity_undo"); revisions.push(args.revision!);
    return { content: [{ type: "text", text: JSON.stringify({ ...baseline, revision: `r${2-revisions.length}`, undoDepth: 2-revisions.length, bodies: revisions.length === 2 ? [] : baseline.bodies }) }] };
  } } as unknown as Client;
  assert.deepEqual(await recoverNativeUiFixture(client, initial, "r2", 7), { restoredEmptyDocument: true, undoSteps: 2 });
  assert.deepEqual(revisions, ["r2", "r1"]);
});
