import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { MAX_CAD_ARCHIVE_BYTES } from "./cad-archive.ts";
import { MAX_REFERENCE_PAGE_HTML_BYTES, StepReferenceDownloader } from "./step-reference-downloader.ts";

const step = Buffer.from("ISO-10303-21;\nHEADER;\nENDSEC;\nEND-ISO-10303-21;\n");
const parasolid = Buffer.from(`**PARASOLID MODEL 1\n${"x".repeat(120)}`);
const zippedStep = Buffer.from("UEsDBBQAAAAIAFIuOF0mTop5IwAAADAAAAAKAAAAbW9kZWwuc3RlcPMM9tc1NDA2MNY1MrTm8nB1dHENsuZy9XMJdnUG07qeKCoAUEsBAhQDFAAAAAgAUi44XSZOinkjAAAAMAAAAAoAAAAAAAAAAAAAAIABAAAAAG1vZGVsLnN0ZXBQSwUGAAAAAAEAAQA4AAAASwAAAAAA", "base64");
const zippedParasolid = Buffer.from("UEsDBBQAAAAIAFIuOF2OMCQOGQAAAIwAAAAJAAAAbW9kZWwueF9009IKcAxyDPb38XRR8PV3cfVRMOSqGCAAAFBLAQIUAxQAAAAIAFIuOF2OMCQOGQAAAIwAAAAJAAAAAAAAAAAAAACAAQAAAABtb2RlbC54X3RQSwUGAAAAAAEAAQA3AAAAQAAAAAAA", "base64");

test("downloads a STEP document to a private content-addressed file and preserves redirect provenance", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-step-download-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const requests: Array<{ url: string; address: string }> = [];
  const downloader = new StepReferenceDownloader({
    root: join(root, "artifacts"),
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    async request(url, address) {
      requests.push({ url: url.href, address });
      if (url.pathname === "/part") return { statusCode: 302, headers: { location: "/part.step" }, body: Readable.from([]) };
      return { statusCode: 200, headers: { "content-length": String(step.length) }, body: Readable.from([step.subarray(0, 12), step.subarray(12)]) };
    },
  });

  const result = await downloader.download("https://cad.example/part");
  assert.equal(result.sourceUrl, "https://cad.example/part");
  assert.equal(result.finalUrl, "https://cad.example/part.step");
  assert.equal(result.bytes, step.length);
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
  assert.equal(await readFile(result.path, "utf8"), step.toString("utf8"));
  assert.deepEqual(requests, [
    { url: "https://cad.example/part", address: "93.184.216.34" },
    { url: "https://cad.example/part.step", address: "93.184.216.34" },
  ]);
});

test("downloads a CAD ZIP, imports one validated STEP member, and keeps archive provenance", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-step-archive-download-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const downloader = new StepReferenceDownloader({
    root: join(root, "artifacts"),
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    async request() { return { statusCode: 200, headers: { "content-length": String(zippedStep.length) }, body: Readable.from([zippedStep]) }; },
  });
  const result = await downloader.download("https://cad.example/model.step.zip");
  assert.equal(result.format, "step");
  assert.equal(result.bytes, step.length);
  assert.equal(await readFile(result.path, "utf8"), step.toString("utf8"));
  assert.deepEqual(result.sourceArchive, {
    sha256: createHash("sha256").update(zippedStep).digest("hex"),
    bytes: zippedStep.length,
    memberPath: "model.step",
  });
  assert.deepEqual((await readdir(join(root, "artifacts"))).sort(), [
    `${result.sha256}.step`,
    `${result.sourceArchive.sha256}.zip`,
  ].sort());
});

test("lists exact CAD asset links from a selected public product page without downloading them", async () => {
  const html = Buffer.from(`<!doctype html><html><body>
    <a href="../3d/radxa_zero_3w_3d_stp.zip">3D STEP archive</a>
    <a href="https://dl.radxa.com/zero3/docs/hw/3w/board.x_t">Parasolid board</a>
    <a href="https://dl.radxa.com/zero3/docs/hw/3w/reference.3mf">Printable reference</a>
    <a href="./drawing.pdf">Mechanical drawing</a>
    <a href="https://evil.example/model.step">Untrusted external file</a>
    <a href="https://dl.radxa.com/zero3/docs/hw/3w/private_stp.zip?token=secret">Signed file</a>
    <a href="/article">No asset</a>
  </body></html>`);
  const requests: string[] = [];
  const downloader = new StepReferenceDownloader({
    lookup: async (hostname) => [{ address: hostname === "docs.radxa.com" ? "93.184.216.34" : "1.1.1.1", family: 4 }],
    async request(url) {
      requests.push(url.href);
      return { statusCode: 200, headers: { "content-type": "text/html; charset=utf-8", "content-length": String(html.length) }, body: Readable.from([html]) };
    },
  });

  const result = await downloader.listReferenceAssets("https://docs.radxa.com/zero/zero3/download?session=hidden", ["docs.radxa.com", "dl.radxa.com"]);

  assert.deepEqual(requests, ["https://docs.radxa.com/zero/zero3/download?session=hidden"]);
  assert.deepEqual(result.assets, [
    { url: "https://docs.radxa.com/zero/3d/radxa_zero_3w_3d_stp.zip", label: "3D STEP archive", format: "step-archive", kind: "editable-cad" },
    { url: "https://dl.radxa.com/zero3/docs/hw/3w/board.x_t", label: "Parasolid board", format: "parasolid-text", kind: "editable-cad" },
    { url: "https://dl.radxa.com/zero3/docs/hw/3w/reference.3mf", label: "Printable reference", format: "3mf", kind: "reference-mesh" },
    { url: "https://docs.radxa.com/zero/zero3/drawing.pdf", label: "Mechanical drawing", format: "pdf", kind: "dimensioned-document" },
  ]);
  assert.equal(result.omittedQueryAssetCount, 1);
  assert.equal(result.truncated, false);
});

test("reference-page asset listing enforces the explicit domain boundary across redirects and links", async () => {
  let requests = 0;
  const downloader = new StepReferenceDownloader({
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    async request(url) {
      requests += 1;
      if (url.hostname === "docs.radxa.com") return { statusCode: 302, headers: { location: "https://outside.example/catalog" }, body: Readable.from([]) };
      return { statusCode: 200, headers: { "content-type": "text/html" }, body: Readable.from([Buffer.from('<a href="https://fake-docs.radxa.com/model.step">CAD</a>')]) };
    },
  });
  await assert.rejects(downloader.listReferenceAssets("https://docs.radxa.com/catalog", ["docs.radxa.com"]), /redirected to a host outside the selected domains/i);
  assert.equal(requests, 1);
  await assert.rejects(downloader.listReferenceAssets("https://docs.radxa.com/catalog", ["127.0.0.1"]), /invalid selected reference domain/i);
  assert.equal(requests, 1);
});

test("reference-page asset listing rejects non-HTML, oversized, and private-DNS responses", async () => {
  let nonHtmlRequested = false;
  const nonHtml = new StepReferenceDownloader({
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    async request() { nonHtmlRequested = true; return { statusCode: 200, headers: { "content-type": "application/zip" }, body: Readable.from([zippedStep]) }; },
  });
  await assert.rejects(nonHtml.listReferenceAssets("https://docs.radxa.com/catalog", ["docs.radxa.com"]), /must return an HTML page/i);
  assert.equal(nonHtmlRequested, true);
  const oversized = new StepReferenceDownloader({
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    async request() {
      return { statusCode: 200, headers: { "content-type": "text/html" }, body: Readable.from([Buffer.alloc(MAX_REFERENCE_PAGE_HTML_BYTES + 1, 0x61)]) };
    },
  });
  await assert.rejects(oversized.listReferenceAssets("https://docs.radxa.com/catalog", ["docs.radxa.com"]), /2 MiB size limit/i);
  let privateDnsRequested = false;
  const privateDns = new StepReferenceDownloader({
    lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    async request() { privateDnsRequested = true; return { statusCode: 200, headers: { "content-type": "text/html" }, body: Readable.from([]) }; },
  });
  await assert.rejects(privateDns.listReferenceAssets("https://docs.radxa.com/catalog", ["docs.radxa.com"]), /public IPv4/i);
  assert.equal(privateDnsRequested, false, "private DNS answers must be rejected before a request");
});

test("downloads one compatible Parasolid ZIP member to the native import extension", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-parasolid-archive-download-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const downloader = new StepReferenceDownloader({
    root: join(root, "artifacts"),
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    async request() { return { statusCode: 200, headers: {}, body: Readable.from([zippedParasolid]) }; },
  });
  const result = await downloader.downloadParasolid("https://cad.example/model.x_t.zip", "x_t");
  assert.equal(result.format, "parasolid-text");
  assert.match(result.path, /[a-f0-9]{64}\.x_t$/u);
  assert.equal(result.sourceArchive?.memberPath, "model.x_t");
  assert.deepEqual(await readFile(result.path), parasolid);
});

test("downloads validated STL and OBJ files as bounded approximate reference-mesh artifacts", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-reference-mesh-download-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const stl = Buffer.from("solid sample\n facet normal 0 0 1\n outer loop\n vertex 0 0 0\n vertex 2 0 0\n vertex 0 3 0\n endloop\n endfacet\nendsolid sample\n");
  const obj = Buffer.from("o sample\nv 0 0 0\nv 2 0 0\nv 0 3 0\nf 1 2 3\n");
  const downloader = new StepReferenceDownloader({
    root: join(root, "artifacts"),
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    async request(url) {
      const body = url.pathname.endsWith(".stl") ? stl : obj;
      return { statusCode: 200, headers: { "content-length": String(body.length) }, body: Readable.from([body]) };
    },
  });
  const downloadedStl = await downloader.downloadReferenceMesh("https://cad.example/phone.stl", "stl");
  const downloadedObj = await downloader.downloadReferenceMesh("https://cad.example/phone.obj", "obj");
  assert.equal(downloadedStl.format, "reference-mesh-stl");
  assert.equal(downloadedObj.format, "reference-mesh-obj");
  assert.match(downloadedStl.path, /[a-f0-9]{64}\.stl$/u);
  assert.match(downloadedObj.path, /[a-f0-9]{64}\.obj$/u);
  assert.deepEqual(await readFile(downloadedStl.path), stl);
  assert.deepEqual(await readFile(downloadedObj.path), obj);
});

test("downloads and validates a direct unit-aware 3MF reference mesh", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-3mf-reference-download-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const archive = referenceThreeMf();
  const downloader = new StepReferenceDownloader({
    root: join(root, "artifacts"),
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    async request(url) {
      if (url.pathname.endsWith("not-a-model.3mf")) return { statusCode: 200, headers: {}, body: Readable.from([Buffer.from("not a 3MF")]) };
      assert.equal(url.href, "https://cad.example/reference.3mf");
      return { statusCode: 200, headers: { "content-type": "model/3mf", "content-length": String(archive.length) }, body: Readable.from([archive]) };
    },
  });
  const result = await downloader.downloadReferenceThreeMf("https://cad.example/reference.3mf");
  assert.equal(result.format, "reference-mesh-3mf");
  assert.equal(result.bytes, archive.length);
  assert.match(result.path, /[a-f0-9]{64}\.3mf$/u);
  assert.deepEqual(await readFile(result.path), archive);
  await assert.rejects(downloader.downloadReferenceThreeMf("https://cad.example/not-a-model.3mf"), /valid 3MF|ZIP package/u);
});

test("rejects invalid and archived reference meshes before storing them", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-reference-mesh-invalid-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const downloader = new StepReferenceDownloader({
    root: join(root, "artifacts"),
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    async request(url) {
      const body = url.pathname.endsWith(".zip") ? zippedStep : Buffer.from("not a mesh");
      return { statusCode: 200, headers: {}, body: Readable.from([body]) };
    },
  });
  await assert.rejects(downloader.downloadReferenceMesh("https://cad.example/bad.obj", "obj"), /OBJ file without mesh vertices and faces/i);
  await assert.rejects(downloader.downloadReferenceMesh("https://cad.example/model.zip", "stl"), /must be direct STL or OBJ/i);
  assert.deepEqual(await readdir(join(root, "artifacts")), []);
});

test("stops an oversized ZIP while streaming and removes its partial artifact", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-step-archive-download-limit-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  let chunksConsumed = 0;
  const body = async function* () {
    yield Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    const chunk = Buffer.alloc(8 * 1024 * 1024, 0x78);
    while (true) {
      chunksConsumed += 1;
      yield chunk;
    }
  };
  const downloader = new StepReferenceDownloader({
    root: join(root, "artifacts"),
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    async request() { return { statusCode: 200, headers: {}, body: body() }; },
  });

  await assert.rejects(
    downloader.download("https://cad.example/oversized.zip"),
    new RegExp(`CAD ZIP archive exceeds the ${MAX_CAD_ARCHIVE_BYTES}-byte size limit`),
  );
  assert.ok(chunksConsumed <= MAX_CAD_ARCHIVE_BYTES / (8 * 1024 * 1024) + 1);
  assert.deepEqual(await readdir(join(root, "artifacts")), []);
});

test("rejects unsafe source URLs before DNS or network access", async () => {
  let called = false;
  const downloader = new StepReferenceDownloader({
    root: join(tmpdir(), "plasticity-step-download-invalid"),
    lookup: async () => { called = true; return [{ address: "93.184.216.34", family: 4 }]; },
    async request() { called = true; return { statusCode: 200, headers: {}, body: Readable.from([step]) }; },
  });
  for (const url of [
    "http://cad.example/part.step",
    "https://user:secret@cad.example/part.step",
    "https://127.0.0.1/part.step",
    "https://cad.example:8443/part.step",
    "https://cad.example/part.step#fragment",
    "https://localhost/part.step",
  ]) {
    await assert.rejects(downloader.download(url));
  }
  assert.equal(called, false);
});

test("rejects any private DNS answer and does not connect", async () => {
  let connected = false;
  const downloader = new StepReferenceDownloader({
    root: join(tmpdir(), "plasticity-step-download-private-dns"),
    lookup: async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ],
    async request() { connected = true; return { statusCode: 200, headers: {}, body: Readable.from([step]) }; },
  });
  await assert.rejects(downloader.download("https://cad.example/part.step"), /public IPv4/);
  assert.equal(connected, false);
});

test("refuses redirects that leave the permitted HTTPS route", async () => {
  let requests = 0;
  const downloader = new StepReferenceDownloader({
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    async request() {
      requests += 1;
      return { statusCode: 302, headers: { location: "http://cad.example/part.step" }, body: Readable.from([]) };
    },
  });
  await assert.rejects(downloader.download("https://cad.example/start"), /outside the permitted HTTPS route/i);
  assert.equal(requests, 1);
});

test("rejects non-STEP, truncated and oversized responses without retaining files", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-step-download-reject-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const downloader = (body: Buffer, maxBytes = 1_000) => new StepReferenceDownloader({
    root: join(root, "artifacts"),
    maxBytes,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    async request() { return { statusCode: 200, headers: {}, body: Readable.from([body]) }; },
  });
  await assert.rejects(downloader(Buffer.from("not a STEP document")).download("https://cad.example/bad"), /not a valid/i);
  await assert.rejects(downloader(Buffer.from("ISO-10303-21; incomplete")).download("https://cad.example/truncated"), /incomplete/i);
  await assert.rejects(downloader(step, step.length - 1).download("https://cad.example/large"), /size limit/i);
  assert.deepEqual(await readdir(join(root, "artifacts")), [], "Rejected downloads must remove partial files");
});

test("downloads a validated Parasolid asset to a private content-addressed .x_t file", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-parasolid-download-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const downloader = new StepReferenceDownloader({
    root: join(root, "artifacts"),
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    async request() { return { statusCode: 200, headers: { "content-length": String(parasolid.length) }, body: Readable.from([parasolid]) }; },
  });
  const result = await downloader.downloadParasolid("https://cad.example/part.x_t", "x_t");
  assert.equal(result.format, "parasolid-text");
  assert.match(result.path, /[a-f0-9]{64}\.x_t$/u);
  assert.equal(result.bytes, parasolid.length);
  assert.deepEqual(await readFile(result.path), parasolid);
});

test("downloads a validated Parasolid asset to a private content-addressed .x_b file", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-parasolid-binary-download-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const downloader = new StepReferenceDownloader({
    root: join(root, "artifacts"),
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    async request() { return { statusCode: 200, headers: { "content-length": String(parasolid.length) }, body: Readable.from([parasolid]) }; },
  });
  const result = await downloader.downloadParasolid("https://cad.example/part.x_b", "x_b");
  assert.equal(result.format, "parasolid-binary");
  assert.match(result.path, /[a-f0-9]{64}\.x_b$/u);
  assert.equal(result.bytes, parasolid.length);
  assert.deepEqual(await readFile(result.path), parasolid);
});

test("normalizes explicit .xmt Parasolid aliases to Plasticity import extensions", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-parasolid-xmt-download-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const downloader = new StepReferenceDownloader({
    root: join(root, "artifacts"),
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    async request() {
      return { statusCode: 200, headers: {}, body: Readable.from([parasolid]) };
    },
  });
  const textResult = await downloader.downloadParasolid("https://cad.example/model.xmt_txt", "xmt_txt");
  const binaryResult = await downloader.downloadParasolid("https://cad.example/model.xmt_bin", "xmt_bin");
  assert.equal(textResult.format, "parasolid-text");
  assert.equal(binaryResult.format, "parasolid-binary");
  assert.match(textResult.path, /[a-f0-9]{64}\.x_t$/u);
  assert.match(binaryResult.path, /[a-f0-9]{64}\.x_b$/u);
});

test("rejects malformed Parasolid assets and removes the partial download", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-parasolid-download-reject-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const downloader = new StepReferenceDownloader({
    root: join(root, "artifacts"),
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    async request() { return { statusCode: 200, headers: {}, body: Readable.from([Buffer.alloc(160, 0x78)]) }; },
  });
  await assert.rejects(downloader.downloadParasolid("https://cad.example/part.x_b", "x_b"), /valid Parasolid/i);
  assert.deepEqual(await readdir(join(root, "artifacts")), []);
});

function referenceThreeMf(): Buffer {
  const model = '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="4" y="0" z="0"/><vertex x="0" y="4" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>';
  return storedZip([
    ["[Content_Types].xml", Buffer.from('<Types><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>')],
    ["_rels/.rels", Buffer.from('<Relationships><Relationship Target="/3D/3dmodel.model"/></Relationships>')],
    ["3D/3dmodel.model", Buffer.from(model)],
  ]);
}

function storedZip(entries: Array<readonly [string, Buffer]>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const [name, contents] of entries) {
    const filename = Buffer.from(name);
    const checksum = crc32(contents);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(contents.length, 18); local.writeUInt32LE(contents.length, 22); local.writeUInt16LE(filename.length, 26);
    localParts.push(local, filename, contents);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(contents.length, 20); central.writeUInt32LE(contents.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, filename);
    localOffset += local.length + filename.length + contents.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12); eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const value of data) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
