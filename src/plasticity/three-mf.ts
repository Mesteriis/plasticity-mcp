import { inflateRawSync } from "node:zlib";

export const MAX_THREE_MF_ARCHIVE_BYTES = 1024 * 1024 * 1024;
export const MAX_REFERENCE_THREE_MF_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_MODEL_XML_BYTES = 256 * 1024 * 1024;
const MAX_REFERENCE_THREE_MF_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_REFERENCE_THREE_MF_TOTAL_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_THREE_MF_ENTRIES = 4_096;
const REQUIRED_PARTS = ["[Content_Types].xml", "_rels/.rels", "3D/3dmodel.model"] as const;
const UNIT_TO_MILLIMETERS = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1_000 } as const;
type ThreeMfUnit = keyof typeof UNIT_TO_MILLIMETERS;

export interface ThreeMfValidation {
  modelUnit: ThreeMfUnit;
  objects: number;
  buildItems: number;
  vertices: number;
  triangles: number;
  boundsMm: {
    min: [number, number, number];
    max: [number, number, number];
    size: [number, number, number];
  };
}

interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  externalAttributes: number;
  centralDirectoryOffset: number;
}

export function validateThreeMfArchive(data: Buffer): ThreeMfValidation {
  return validateThreeMf(data, { maxArchiveBytes: MAX_THREE_MF_ARCHIVE_BYTES, requireMeter: true, verifyAllEntries: false });
}

export function validateReferenceThreeMfArchive(data: Buffer): ThreeMfValidation {
  return validateThreeMf(data, {
    maxArchiveBytes: MAX_REFERENCE_THREE_MF_ARCHIVE_BYTES,
    maxEntryBytes: MAX_REFERENCE_THREE_MF_ENTRY_BYTES,
    maxExpandedBytes: MAX_REFERENCE_THREE_MF_TOTAL_EXPANDED_BYTES,
    requireMeter: false,
    verifyAllEntries: true,
  });
}

function validateThreeMf(data: Buffer, options: {
  maxArchiveBytes: number;
  maxEntryBytes?: number;
  maxExpandedBytes?: number;
  requireMeter: boolean;
  verifyAllEntries: boolean;
}): ThreeMfValidation {
  if (data.length === 0 || data.length > options.maxArchiveBytes) {
    throw new Error(`3MF archive must be nonempty and at most ${options.maxArchiveBytes} bytes`);
  }
  const entries = readCentralDirectory(data, options);
  if (options.verifyAllEntries) {
    for (const entry of entries.values()) readZipEntry(data, entry, options.maxEntryBytes ?? MAX_REFERENCE_THREE_MF_ENTRY_BYTES);
  }
  for (const name of REQUIRED_PARTS) {
    if (!entries.has(name)) throw new Error(`Plasticity 3MF is missing required OPC part ${name}`);
  }

  const contentTypes = extractXmlEntry(data, entries.get("[Content_Types].xml")!, 1024 * 1024, options.verifyAllEntries);
  if (!contentTypes.includes("application/vnd.ms-package.3dmanufacturing-3dmodel+xml")) {
    throw new Error("Plasticity 3MF has no model content type");
  }
  const relationships = extractXmlEntry(data, entries.get("_rels/.rels")!, 1024 * 1024, options.verifyAllEntries);
  if (!/Target\s*=\s*["']\/?3D\/3dmodel\.model["']/iu.test(relationships)) {
    throw new Error("Plasticity 3MF package relationship does not target 3D/3dmodel.model");
  }

  const model = extractXmlEntry(data, entries.get("3D/3dmodel.model")!, MAX_MODEL_XML_BYTES, options.verifyAllEntries);
  const modelTag = model.match(/<model\b[^>]*>/iu)?.[0];
  if (!modelTag) throw new Error("Plasticity 3MF model has no model element");
  const unit = attribute(modelTag, "unit");
  const modelUnit = unit === undefined ? "millimeter" : unit as ThreeMfUnit;
  if (!Object.hasOwn(UNIT_TO_MILLIMETERS, modelUnit) || (options.requireMeter && modelUnit !== "meter")) {
    throw new Error(options.requireMeter
      ? `Plasticity 3MF model unit must be meter after the verified 0.001 millimeter export scale; got ${unit ?? "missing"}`
      : `Reference 3MF model has an unsupported unit: ${unit ?? "missing"}`);
  }
  if (!/<mesh\b/iu.test(model) || !/<build\b/iu.test(model)) {
    throw new Error("Plasticity 3MF model must contain a mesh and build section");
  }

  const objectIds = new Set<number>();
  for (const match of model.matchAll(/<object\b[^>]*>/giu)) {
    const id = Number(attribute(match[0], "id"));
    if (!Number.isSafeInteger(id) || id < 0 || objectIds.has(id)) throw new Error("Plasticity 3MF contains an invalid or duplicate object ID");
    objectIds.add(id);
  }
  const buildMatches = [...model.matchAll(/<item\b[^>]*\/?\s*>/giu)];
  for (const match of buildMatches) {
    const objectId = Number(attribute(match[0], "objectid"));
    if (!Number.isSafeInteger(objectId) || !objectIds.has(objectId)) throw new Error("Plasticity 3MF build item references an unknown object");
  }

  const coordinates: Array<[number, number, number]> = [];
  let triangles = 0;
  for (const mesh of model.matchAll(/<mesh\b[^>]*>([\s\S]*?)<\/mesh>/giu)) {
    const meshXml = mesh[1]!;
    const meshCoordinates: Array<[number, number, number]> = [];
    for (const match of meshXml.matchAll(/<vertex\b[^>]*\/?\s*>/giu)) {
      const x = Number(attribute(match[0], "x"));
      const y = Number(attribute(match[0], "y"));
      const z = Number(attribute(match[0], "z"));
      if (![x, y, z].every(Number.isFinite)) throw new Error("Plasticity 3MF contains a non-finite vertex coordinate");
      meshCoordinates.push([x, y, z]);
      coordinates.push([x, y, z]);
    }
    for (const match of meshXml.matchAll(/<triangle\b[^>]*\/?\s*>/giu)) {
      const indices = ["v1", "v2", "v3"].map((name) => Number(attribute(match[0], name)));
      if (indices.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= meshCoordinates.length)) {
        throw new Error("Plasticity 3MF triangle references an unavailable mesh vertex");
      }
      if (new Set(indices).size !== 3) throw new Error("Plasticity 3MF contains a degenerate triangle index set");
      triangles += 1;
    }
  }
  const objects = objectIds.size;
  const buildItems = buildMatches.length;
  if (coordinates.length === 0 || triangles === 0 || objects === 0 || buildItems === 0) {
    throw new Error("Plasticity 3MF contains no complete printable mesh build");
  }

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const point of coordinates) {
    for (let axis = 0; axis < 3; axis += 1) {
      const millimeters = point[axis]! * UNIT_TO_MILLIMETERS[modelUnit];
      min[axis] = Math.min(min[axis]!, millimeters);
      max[axis] = Math.max(max[axis]!, millimeters);
    }
  }
  const size: [number, number, number] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  return { modelUnit, objects, buildItems, vertices: coordinates.length, triangles, boundsMm: { min, max, size } };
}

function readCentralDirectory(data: Buffer, options: { maxEntryBytes?: number; maxExpandedBytes?: number }): Map<string, ZipEntry> {
  const eocd = findEndOfCentralDirectory(data);
  const disk = data.readUInt16LE(eocd + 4);
  const centralDisk = data.readUInt16LE(eocd + 6);
  const diskEntries = data.readUInt16LE(eocd + 8);
  const totalEntries = data.readUInt16LE(eocd + 10);
  const centralSize = data.readUInt32LE(eocd + 12);
  const centralOffset = data.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) throw new Error("Multipart 3MF ZIP archives are unsupported");
  if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error("ZIP64 3MF archives are unsupported");
  ensureRange(data, centralOffset, centralSize, "central directory");
  if (centralOffset + centralSize !== eocd) throw new Error("Malformed 3MF central directory bounds");
  if (totalEntries === 0 || totalEntries > MAX_THREE_MF_ENTRIES) throw new Error(`3MF package must contain between 1 and ${MAX_THREE_MF_ENTRIES} entries`);

  const entries = new Map<string, ZipEntry>();
  let offset = centralOffset;
  let totalExpandedBytes = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    ensureRange(data, offset, 46, "central directory entry");
    if (data.readUInt32LE(offset) !== 0x02014b50) throw new Error("Malformed 3MF central directory entry");
    const flags = data.readUInt16LE(offset + 8);
    const method = data.readUInt16LE(offset + 10);
    const crc32 = data.readUInt32LE(offset + 16);
    const compressedSize = data.readUInt32LE(offset + 20);
    const uncompressedSize = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const startDisk = data.readUInt16LE(offset + 34);
    const externalAttributes = data.readUInt32LE(offset + 38);
    const localOffset = data.readUInt32LE(offset + 42);
    const entryLength = 46 + nameLength + extraLength + commentLength;
    ensureRange(data, offset, entryLength, "central directory entry");
    if (startDisk !== 0 || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) throw new Error("Split-disk or ZIP64 3MF archives are unsupported");
    const rawName = data.subarray(offset + 46, offset + 46 + nameLength);
    if ((flags & 0x0800) === 0 && [...rawName].some((value) => value > 0x7f)) throw new Error("Non-ASCII 3MF ZIP paths must declare UTF-8 encoding");
    const name = rawName.toString("utf8");
    if (name.includes("\uFFFD") || name.includes("\0") || /[\u0001-\u001f\u007f]/u.test(name)) throw new Error("Invalid 3MF ZIP path encoding");
    assertSafeEntryName(name);
    if ((flags & (1 | 0x0040 | 0x2000)) !== 0) throw new Error(`Encrypted 3MF ZIP entry is unsupported: ${name}`);
    if (method !== 0 && method !== 8) throw new Error(`Unsupported 3MF ZIP compression method ${method}: ${name}`);
    const maximumEntryBytes = options.maxEntryBytes ?? MAX_MODEL_XML_BYTES;
    if (uncompressedSize > maximumEntryBytes) throw new Error(`3MF ZIP entry is excessively large: ${name}`);
    totalExpandedBytes += uncompressedSize;
    if (options.maxExpandedBytes !== undefined && totalExpandedBytes > options.maxExpandedBytes) throw new Error("Reference 3MF package expands beyond its total size limit");
    if (uncompressedSize > MAX_MODEL_XML_BYTES && name === "3D/3dmodel.model") throw new Error("Plasticity 3MF model XML is excessively large");
    const hostSystem = data.readUInt16LE(offset + 4) >>> 8;
    const unixType = (externalAttributes >>> 16) & 0o170000;
    if (hostSystem === 3 && unixType !== 0 && unixType !== 0o100000 && unixType !== 0o040000) throw new Error(`Non-regular 3MF ZIP entry is unsupported: ${name}`);
    if (entries.has(name)) throw new Error(`Duplicate 3MF ZIP entry: ${name}`);
    entries.set(name, { name, flags, method, crc32, compressedSize, uncompressedSize, localOffset, externalAttributes, centralDirectoryOffset: centralOffset });
    offset += entryLength;
  }
  if (offset !== centralOffset + centralSize) throw new Error("Malformed 3MF central directory size");
  return entries;
}

function extractUtf8Entry(data: Buffer, entry: ZipEntry, maximumBytes: number, verifyCrc = false): string {
  if (entry.uncompressedSize > maximumBytes) throw new Error(`3MF ZIP entry is excessively large: ${entry.name}`);
  return readZipEntry(data, entry, maximumBytes, verifyCrc).toString("utf8");
}

function extractXmlEntry(data: Buffer, entry: ZipEntry, maximumBytes: number, verifyCrc = false): string {
  const xml = extractUtf8Entry(data, entry, maximumBytes, verifyCrc);
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) throw new Error(`3MF XML part contains unsupported declarations: ${entry.name}`);
  return xml;
}

function readZipEntry(data: Buffer, entry: ZipEntry, maximumBytes: number, verifyCrc = true): Buffer {
  if (entry.uncompressedSize > maximumBytes) throw new Error(`3MF ZIP entry is excessively large: ${entry.name}`);
  ensureRange(data, entry.localOffset, 30, `local ZIP header for ${entry.name}`);
  if (data.readUInt32LE(entry.localOffset) !== 0x04034b50) throw new Error(`Malformed local ZIP header for ${entry.name}`);
  const method = data.readUInt16LE(entry.localOffset + 8);
  const flags = data.readUInt16LE(entry.localOffset + 6);
  const localCrc = data.readUInt32LE(entry.localOffset + 14);
  const localCompressedSize = data.readUInt32LE(entry.localOffset + 18);
  const localUncompressedSize = data.readUInt32LE(entry.localOffset + 22);
  const nameLength = data.readUInt16LE(entry.localOffset + 26);
  const extraLength = data.readUInt16LE(entry.localOffset + 28);
  const payloadOffset = entry.localOffset + 30 + nameLength + extraLength;
  ensureRange(data, payloadOffset, entry.compressedSize, `ZIP payload for ${entry.name}`);
  if (payloadOffset + entry.compressedSize > entry.centralDirectoryOffset) throw new Error(`3MF ZIP payload overlaps its central directory: ${entry.name}`);
  const localName = data.subarray(entry.localOffset + 30, entry.localOffset + 30 + nameLength).toString("utf8");
  if (localName !== entry.name || method !== entry.method || flags !== entry.flags) throw new Error(`Inconsistent ZIP headers for ${entry.name}`);
  if ((flags & 0x0008) === 0 && (localCrc !== entry.crc32 || localCompressedSize !== entry.compressedSize || localUncompressedSize !== entry.uncompressedSize)) {
    throw new Error(`Inconsistent ZIP sizes or checksum for ${entry.name}`);
  }
  const compressed = data.subarray(payloadOffset, payloadOffset + entry.compressedSize);
  let contents: Buffer;
  try {
    contents = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: Math.max(1, Math.min(maximumBytes, entry.uncompressedSize)) });
  } catch (error) {
    throw new Error(`Cannot decompress 3MF ZIP entry ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (contents.length !== entry.uncompressedSize) throw new Error(`Truncated 3MF ZIP entry: ${entry.name}`);
  if (verifyCrc && crc32(contents) !== entry.crc32) throw new Error(`3MF ZIP entry CRC-32 mismatch: ${entry.name}`);
  return contents;
}

function findEndOfCentralDirectory(data: Buffer): number {
  const minimum = Math.max(0, data.length - 65_557);
  for (let offset = data.length - 22; offset >= minimum; offset -= 1) {
    if (data.readUInt32LE(offset) === 0x06054b50) {
      const commentLength = data.readUInt16LE(offset + 20);
      if (offset + 22 + commentLength === data.length) return offset;
    }
  }
  throw new Error("Plasticity produced an invalid 3MF ZIP archive");
}

function assertSafeEntryName(name: string): void {
  if (!name || name.includes("\\") || name.startsWith("/") || name.split("/").some((part) => part === "..")) {
    throw new Error(`Plasticity 3MF contains an unsafe ZIP entry path: ${name}`);
  }
}

function ensureRange(data: Buffer, offset: number, length: number, label: string): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > data.length) {
    throw new Error(`Malformed 3MF ${label}`);
  }
}

function attribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "iu"));
  return match?.[2];
}

const CRC32_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const value of data) crc = CRC32_TABLE[(crc ^ value) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
