import assert from "node:assert/strict";
import test from "node:test";

import { parseMultiviewAcceptanceArgs } from "./verify-design-reference-multiview-live.ts";

test("design-reference image acceptance is inert by default and requires explicit live Codex", () => {
  assert.deepEqual(parseMultiviewAcceptanceArgs([]), { help: true, liveCodex: false, images: [] });
  assert.equal(parseMultiviewAcceptanceArgs(["--help"]).help, true);
  assert.throws(() => parseMultiviewAcceptanceArgs(["--output", "/tmp/run", "--image", "/tmp/a.png", "--image", "/tmp/b.png"]), /live-codex/);
});

test("design-reference image acceptance accepts one to four absolute image paths and a new output directory", () => {
  assert.deepEqual(parseMultiviewAcceptanceArgs([
    "--live-codex", "--output", "/tmp/run", "--image", "/tmp/a.jpg",
  ]), {
    help: false,
    liveCodex: true,
    output: "/tmp/run",
    images: ["/tmp/a.jpg"],
  });
  assert.throws(() => parseMultiviewAcceptanceArgs(["--live-codex", "--output", "/tmp/run", "--image", "a.png", "--image", "/tmp/b.png"]), /absolute/);
  assert.throws(() => parseMultiviewAcceptanceArgs([
    "--live-codex", "--output", "/tmp/run",
    "--image", "/tmp/a.png", "--image", "/tmp/b.png", "--image", "/tmp/c.png", "--image", "/tmp/d.png", "--image", "/tmp/e.png",
  ]), /1–4/);
  assert.deepEqual(parseMultiviewAcceptanceArgs([
    "--live-codex", "--output", "/tmp/run", "--image", "/tmp/front.heic", "--image", "/tmp/side.heif",
  ]), {
    help: false,
    liveCodex: true,
    output: "/tmp/run",
    images: ["/tmp/front.heic", "/tmp/side.heif"],
  });
});
