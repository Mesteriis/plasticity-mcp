import assert from "node:assert/strict";
import test from "node:test";

import { parseReferenceMeshDownloadArgs } from "./verify-reference-mesh-download-live.ts";

const base = [
  "--target", "window-id",
  "--source-url", "https://example.com/model.stl",
  "--format", "stl",
  "--source-unit", "millimeter",
  "--output", "/tmp/acceptance-output",
];

test("parses a direct remote-mesh acceptance request with explicit format and units", () => {
  assert.deepEqual(parseReferenceMeshDownloadArgs([...base, "--source-page-url", "https://example.com/model", "--license", "CC BY 4.0"]), {
    help: false,
    target: "window-id",
    sourceUrl: "https://example.com/model.stl",
    format: "stl",
    sourceUnit: "millimeter",
    output: "/tmp/acceptance-output",
    sourcePageUrl: "https://example.com/model",
    license: "CC BY 4.0",
    confidence: "approximate",
  });
});

test("requires every scene-changing acceptance input and rejects insecure or ambiguous asset inputs", () => {
  assert.throws(() => parseReferenceMeshDownloadArgs([]), /--target/);
  assert.throws(() => parseReferenceMeshDownloadArgs(base.map((value) => value === "https://example.com/model.stl" ? "http://example.com/model.stl" : value)), /must use HTTPS/i);
  assert.throws(() => parseReferenceMeshDownloadArgs(base.map((value) => value === "millimeter" ? "unknown" : value)), /unsupported --source-unit/i);
  assert.throws(() => parseReferenceMeshDownloadArgs(base.map((value) => value === "stl" ? "3mf" : value)), /must be stl or obj/i);
  assert.throws(() => parseReferenceMeshDownloadArgs([...base, "--source-page-url", "http://example.com/page"]), /source-page-url must use HTTPS/i);
  assert.equal(parseReferenceMeshDownloadArgs(["--help"]).help, true);
});
