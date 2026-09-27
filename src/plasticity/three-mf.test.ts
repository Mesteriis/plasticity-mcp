import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { test } from "node:test";

import { validateReferenceThreeMfArchive, validateThreeMfArchive } from "./three-mf.ts";

test("validates a meter-based 3MF package and reports millimeter mesh bounds", () => {
  const archive = sampleThreeMf();

  assert.deepEqual(validateThreeMfArchive(archive), {
    modelUnit: "meter",
    objects: 1,
    buildItems: 1,
    vertices: 8,
    triangles: 12,
    boundsMm: { min: [0, 0, 0], max: [20, 10, 5], size: [20, 10, 5] },
  });
});

test("rejects 3MF packages without required OPC parts", () => {
  const archive = storedZip([
    ["[Content_Types].xml", Buffer.from("<Types/>")],
    ["3D/3dmodel.model", Buffer.from(modelXml())],
  ]);

  assert.throws(() => validateThreeMfArchive(archive), /_rels\/.rels/u);
});

test("rejects a Plasticity 3MF whose declared unit would break millimeter scale", () => {
  const archive = sampleThreeMf(modelXml().replace('unit="meter"', 'unit="millimeter"'));

  assert.throws(() => validateThreeMfArchive(archive), /unit.*meter/u);
});

test("rejects malformed mesh coordinates and ZIP entry paths", () => {
  const malformed = sampleThreeMf(modelXml().replace('x="0.02"', 'x="NaN"'));
  assert.throws(() => validateThreeMfArchive(malformed), /finite vertex/u);

  const traversal = storedZip([
    ["[Content_Types].xml", Buffer.from("<Types/>")],
    ["_rels/.rels", Buffer.from("<Relationships/>")],
    ["../3D/3dmodel.model", Buffer.from(modelXml())],
  ]);
  assert.throws(() => validateThreeMfArchive(traversal), /unsafe ZIP entry/u);
});

test("rejects triangles and build items that reference missing mesh objects", () => {
  const badTriangle = sampleThreeMf(modelXml().replace('v3="2"', 'v3="99"'));
  assert.throws(() => validateThreeMfArchive(badTriangle), /triangle.*vertex/u);

  const badBuild = sampleThreeMf(modelXml().replace('objectid="1"', 'objectid="2"'));
  assert.throws(() => validateThreeMfArchive(badBuild), /build item.*object/u);
});

test("validates reference 3MF with embedded units and converts source coordinates to millimeters", () => {
  const millimeterXml = modelXml()
    .replace('unit="meter"', 'unit="millimeter"')
    .replaceAll('x="0.02"', 'x="20"')
    .replaceAll('y="0.01"', 'y="10"')
    .replaceAll('z="0.005"', 'z="5"');
  const result = validateReferenceThreeMfArchive(sampleThreeMf(millimeterXml));
  assert.equal(result.modelUnit, "millimeter");
  assert.deepEqual(result.boundsMm.size, [20, 10, 5]);
  assert.equal(result.triangles, 12);
});

test("defaults a missing reference 3MF unit to millimeters and supports inch coordinates", () => {
  const noUnit = modelXml().replace(' unit="meter"', "")
    .replaceAll('x="0.02"', 'x="20"')
    .replaceAll('y="0.01"', 'y="10"')
    .replaceAll('z="0.005"', 'z="5"');
  assert.equal(validateReferenceThreeMfArchive(sampleThreeMf(noUnit)).modelUnit, "millimeter");
  const inches = modelXml().replace('unit="meter"', 'unit="inch"')
    .replaceAll('x="0.02"', 'x="2"')
    .replaceAll('y="0.01"', 'y="1"')
    .replaceAll('z="0.005"', 'z="0.5"');
  const inchResult = validateReferenceThreeMfArchive(sampleThreeMf(inches));
  assert.deepEqual(inchResult.boundsMm.size, [50.8, 25.4, 12.7]);
});

test("validates CRCs and bounds for deflated 3MF ZIP entries", () => {
  const result = validateReferenceThreeMfArchive(sampleThreeMf(modelXml(), 8));
  assert.deepEqual(result.boundsMm.size, [20, 10, 5]);
  assert.equal(result.triangles, 12);
});

test("reference 3MF validation checks CRCs and rejects oversized package members", () => {
  const archive = sampleThreeMf();
  const payloadOffset = archive.indexOf(Buffer.from("<Types>"));
  archive[payloadOffset] = 0x21;
  assert.throws(() => validateReferenceThreeMfArchive(archive), /CRC-32 mismatch/u);

  const oversized = sampleThreeMf();
  const centralDirectory = oversized.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  oversized.writeUInt32LE(128 * 1024 * 1024 + 1, centralDirectory + 24);
  assert.throws(() => validateReferenceThreeMfArchive(oversized), /entry is excessively large/u);
});

test("rejects inconsistent local ZIP metadata and XML entity declarations", () => {
  const inconsistent = sampleThreeMf();
  inconsistent.writeUInt32LE(123, 14);
  assert.throws(() => validateReferenceThreeMfArchive(inconsistent), /inconsistent ZIP sizes or checksum/iu);

  const entityPackage = storedZip([
    ["[Content_Types].xml", Buffer.from('<!DOCTYPE Types [<!ENTITY x "bad">]><Types><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>')],
    ["_rels/.rels", Buffer.from('<Relationships><Relationship Target="/3D/3dmodel.model"/></Relationships>')],
    ["3D/3dmodel.model", Buffer.from(modelXml())],
  ]);
  assert.throws(() => validateReferenceThreeMfArchive(entityPackage), /unsupported declarations/u);
});

function sampleThreeMf(model = modelXml(), method: 0 | 8 = 0): Buffer {
  return storedZip([
    ["[Content_Types].xml", Buffer.from('<Types><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>')],
    ["_rels/.rels", Buffer.from('<Relationships><Relationship Target="/3D/3dmodel.model"/></Relationships>')],
    ["3D/3dmodel.model", Buffer.from(model)],
  ], method);
}

function modelXml(): string {
  const vertices = [
    [0, 0, 0], [0.02, 0, 0], [0.02, 0.01, 0], [0, 0.01, 0],
    [0, 0, 0.005], [0.02, 0, 0.005], [0.02, 0.01, 0.005], [0, 0.01, 0.005],
  ].map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join("");
  const triangles = [
    [0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6],
    [0, 4, 5], [0, 5, 1], [1, 5, 6], [1, 6, 2],
    [2, 6, 7], [2, 7, 3], [3, 7, 4], [3, 4, 0],
  ].map(([v1, v2, v3]) => `<triangle v1="${v1}" v2="${v2}" v3="${v3}"/>`).join("");
  return `<model unit="meter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices>${vertices}</vertices><triangles>${triangles}</triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;
}

function storedZip(entries: Array<readonly [string, Buffer]>, method: 0 | 8 = 0): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const [name, data] of entries) {
    const filename = Buffer.from(name);
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    localParts.push(local, filename, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, filename);
    localOffset += local.length + filename.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
