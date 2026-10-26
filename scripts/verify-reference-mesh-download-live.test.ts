import assert from "node:assert/strict";
import test from "node:test";

import { parseReferenceMeshDownloadArgs, verifyDownloadedMeshGeometry } from "./verify-reference-mesh-download-live.ts";

const base = [
  "--allow-disposable-mutations",
  "--target", "window-id",
  "--source-url", "https://example.com/model.stl",
  "--format", "stl",
  "--source-unit", "millimeter",
  "--output", "/tmp/acceptance-output",
];

test("parses a direct remote-mesh acceptance request with explicit format and units", () => {
  assert.deepEqual(parseReferenceMeshDownloadArgs([...base, "--source-page-url", "https://example.com/model", "--license", "CC BY 4.0"]), {
    help: false,
    allowDisposableMutations: true,
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
  assert.equal(parseReferenceMeshDownloadArgs([]).help, true);
  assert.throws(() => parseReferenceMeshDownloadArgs(base.filter(x => x !== "--allow-disposable-mutations")), /--allow-disposable-mutations/);
  assert.throws(() => parseReferenceMeshDownloadArgs(base.map((value) => value === "https://example.com/model.stl" ? "http://example.com/model.stl" : value)), /must use HTTPS/i);
  assert.throws(() => parseReferenceMeshDownloadArgs(base.map((value) => value === "millimeter" ? "unknown" : value)), /unsupported --source-unit/i);
  assert.throws(() => parseReferenceMeshDownloadArgs(base.map((value) => value === "stl" ? "3mf" : value)), /must be stl or obj/i);
  assert.throws(() => parseReferenceMeshDownloadArgs([...base, "--source-page-url", "http://example.com/page"]), /source-page-url must use HTTPS/i);
  assert.equal(parseReferenceMeshDownloadArgs(["--help"]).help, true);
});


test("remote mesh verifier rejects embedded credentials and malformed expected hashes", () => {
  for (const url of ["https://user:pass@example.com/model.stl", "https://user@example.com/model.stl"]) {
    assert.throws(() => parseReferenceMeshDownloadArgs(base.map(x => x === "https://example.com/model.stl" ? url : x)), /credentials/);
  }
  assert.throws(() => parseReferenceMeshDownloadArgs([...base, "--source-page-url", "https://user:pass@example.com/page"]), /credentials/);
  assert.throws(() => parseReferenceMeshDownloadArgs([...base, "--expected-sha256", "short"]), /64 lowercase hex/);
  assert.equal(parseReferenceMeshDownloadArgs([...base, "--expected-sha256", "a".repeat(64)]).expectedSha256, "a".repeat(64));
});

test("downloaded mesh checks source triangle totals and unit-scaled native union bounds", () => {
  const obj = Buffer.from("v 0 0 0\nv 1 0 0\nv 1 1 1\nv 0 1 1\nf 1 2 3 4\n");
  const mesh = { triangles: 2, boundsMm: { min: [0, 0, 0], max: [25.4, 25.4, 25.4] } };
  assert.doesNotThrow(() => verifyDownloadedMeshGeometry(obj, "obj", "inch", [mesh]));
  assert.doesNotThrow(() => verifyDownloadedMeshGeometry(obj, "obj", "inch", [{ ...mesh, triangles: 1 }, { ...mesh, triangles: 1 }]));
  assert.throws(() => verifyDownloadedMeshGeometry(obj, "obj", "millimeter", [mesh]), /bounds differ/);
  assert.throws(() => verifyDownloadedMeshGeometry(obj, "obj", "inch", [{ ...mesh, triangles: 1 }]), /triangle total/);
  assert.throws(() => verifyDownloadedMeshGeometry(obj, "obj", "inch", [{ ...mesh, boundsMm: { min: [0, 0, 0], max: [25.41, 25.4, 25.4] } }]), /bounds differ/);
  assert.throws(() => verifyDownloadedMeshGeometry(obj, "obj", "inch", [{ ...mesh, boundsMm: { min: [0, 0, 0], max: [NaN, 25.4, 25.4] } }]), /bounds differ/);
  assert.throws(() => verifyDownloadedMeshGeometry(obj, "obj", "inch", []), /triangle total/);
});
