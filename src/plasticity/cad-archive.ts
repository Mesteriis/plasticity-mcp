import { inflateRawSync } from "node:zlib";

export const MAX_CAD_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_CAD_MEMBER_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 4_096;

export type CadReferenceFormat = "step" | "parasolid-text" | "parasolid-binary";

export interface ExtractedCadArchiveMember {
  memberPath: string;
  extension: "step" | "x_t" | "x_b";
  contents: Buffer;
}

interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  centralDirectoryOffset: number;
}

export function isZipArchiveHeader(prefix: Uint8Array): boolean {
  return prefix.length >= 4
    && prefix[0] === 0x50
    && prefix[1] === 0x4b
    && ((prefix[2] === 0x03 && prefix[3] === 0x04) || (prefix[2] === 0x05 && prefix[3] === 0x06));
}

export function extractSingleCadArchiveMember(data: Buffer, format: CadReferenceFormat): ExtractedCadArchiveMember {
  if (data.length === 0 || data.length > MAX_CAD_ARCHIVE_BYTES) {
    throw new Error(`CAD ZIP archive must be nonempty and at most ${MAX_CAD_ARCHIVE_BYTES} bytes`);
  }
  const entries = readCentralDirectory(data);
  const candidates = entries.filter((entry) => !entry.name.endsWith("/") && extensionMatches(entry.name, format));
  if (candidates.length !== 1) {
    const names = candidates.map(({ name }) => name).slice(0, 20);
    throw new Error(candidates.length === 0
      ? `CAD ZIP archive contains no ${formatDescription(format)} member`
      : `CAD ZIP archive has multiple ${formatDescription(format)} members; select a source that contains only one matching CAD file (${names.join(", ")})`);
  }
  const entry = candidates[0]!;
  if ((entry.flags & 0x0001) !== 0) throw new Error(`Encrypted CAD ZIP member is unsupported: ${entry.name}`);
  if (entry.method !== 0 && entry.method !== 8) throw new Error(`Unsupported CAD ZIP compression method ${entry.method}: ${entry.name}`);
  if (entry.uncompressedSize === 0 || entry.uncompressedSize > MAX_CAD_MEMBER_BYTES) {
    throw new Error(`CAD ZIP member is empty or exceeds the ${MAX_CAD_MEMBER_BYTES}-byte limit: ${entry.name}`);
  }

  const contents = readEntry(data, entry);
  validateCadContents(contents, format);
  return {
    memberPath: entry.name,
    extension: format === "step" ? "step" : format === "parasolid-text" ? "x_t" : "x_b",
    contents,
  };
}

function readCentralDirectory(data: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(data);
  const disk = data.readUInt16LE(eocd + 4);
  const centralDisk = data.readUInt16LE(eocd + 6);
  const diskEntries = data.readUInt16LE(eocd + 8);
  const totalEntries = data.readUInt16LE(eocd + 10);
  const centralSize = data.readUInt32LE(eocd + 12);
  const centralOffset = data.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) throw new Error("Multipart CAD ZIP archives are unsupported");
  if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error("ZIP64 CAD archives are unsupported");
  ensureRange(data, centralOffset, centralSize, "central directory");
  if (centralOffset + centralSize !== eocd) throw new Error("Malformed CAD ZIP central directory bounds");
  if (totalEntries === 0 || totalEntries > MAX_ENTRIES) throw new Error(`CAD ZIP archive must contain between 1 and ${MAX_ENTRIES} entries`);

  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let offset = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    ensureRange(data, offset, 46, "central directory entry");
    if (data.readUInt32LE(offset) !== 0x02014b50) throw new Error("Malformed CAD ZIP central directory entry");
    const madeBy = data.readUInt16LE(offset + 4);
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
    if (startDisk !== 0 || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error("Split-disk or ZIP64 CAD ZIP members are unsupported");
    }
    const rawName = data.subarray(offset + 46, offset + 46 + nameLength);
    const name = decodeEntryName(rawName, flags);
    validateEntryName(name);
    if (names.has(name)) throw new Error(`Duplicate CAD ZIP entry: ${name}`);
    names.add(name);
    const hostSystem = madeBy >>> 8;
    const mode = externalAttributes >>> 16;
    const unixType = mode & 0o170000;
    if (hostSystem === 3 && unixType !== 0 && unixType !== 0o100000 && unixType !== 0o040000) {
      throw new Error(`Non-regular CAD ZIP entry is unsupported: ${name}`);
    }
    if ((flags & 0x0040) !== 0 || (flags & 0x2000) !== 0) throw new Error(`Strongly encrypted CAD ZIP entry is unsupported: ${name}`);

    entries.push({ name, flags, method, crc32, compressedSize, uncompressedSize, localOffset, centralDirectoryOffset: centralOffset });
    offset += entryLength;
  }
  if (offset !== centralOffset + centralSize) throw new Error("Malformed CAD ZIP central directory size");
  return entries;
}

function readEntry(data: Buffer, entry: ZipEntry): Buffer {
  ensureRange(data, entry.localOffset, 30, `local ZIP header for ${entry.name}`);
  if (data.readUInt32LE(entry.localOffset) !== 0x04034b50) throw new Error(`Malformed local CAD ZIP header for ${entry.name}`);
  const flags = data.readUInt16LE(entry.localOffset + 6);
  const method = data.readUInt16LE(entry.localOffset + 8);
  const nameLength = data.readUInt16LE(entry.localOffset + 26);
  const extraLength = data.readUInt16LE(entry.localOffset + 28);
  const payloadOffset = entry.localOffset + 30 + nameLength + extraLength;
  ensureRange(data, payloadOffset, entry.compressedSize, `ZIP payload for ${entry.name}`);
  if (payloadOffset + entry.compressedSize > entry.centralDirectoryOffset) throw new Error(`CAD ZIP payload overlaps its central directory: ${entry.name}`);
  const localName = decodeEntryName(data.subarray(entry.localOffset + 30, entry.localOffset + 30 + nameLength), flags);
  if (localName !== entry.name || flags !== entry.flags || method !== entry.method) {
    throw new Error(`Inconsistent CAD ZIP headers for ${entry.name}`);
  }
  const compressed = data.subarray(payloadOffset, payloadOffset + entry.compressedSize);
  let contents: Buffer;
  try {
    contents = entry.method === 0
      ? Buffer.from(compressed)
      : inflateRawSync(compressed, { maxOutputLength: MAX_CAD_MEMBER_BYTES });
  } catch (error) {
    throw new Error(`Cannot decompress CAD ZIP member ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (contents.length !== entry.uncompressedSize) throw new Error(`Truncated CAD ZIP member: ${entry.name}`);
  if (crc32(contents) !== entry.crc32) throw new Error(`CAD ZIP member CRC-32 mismatch: ${entry.name}`);
  return contents;
}

function validateCadContents(contents: Buffer, format: CadReferenceFormat): void {
  if (format === "step") {
    if (!contents.subarray(0, STEP_HEADER.length).equals(STEP_HEADER) || !contents.includes(STEP_TRAILER)) {
      throw new Error("CAD ZIP member is not a complete ISO-10303-21 STEP document");
    }
    return;
  }
  const header = contents.subarray(0, 512).toString("latin1");
  if (contents.length < 96 || !header.startsWith("**") || !header.includes("PARASOLID")) {
    throw new Error("CAD ZIP member is not a valid Parasolid exchange document");
  }
}

function extensionMatches(name: string, format: CadReferenceFormat): boolean {
  const lower = name.toLowerCase();
  if (format === "step") return lower.endsWith(".step") || lower.endsWith(".stp");
  if (format === "parasolid-text") return lower.endsWith(".x_t") || lower.endsWith(".xmt_txt");
  return lower.endsWith(".x_b") || lower.endsWith(".xmt_bin");
}

function formatDescription(format: CadReferenceFormat): string {
  if (format === "step") return "STEP (.step/.stp)";
  return format === "parasolid-text" ? "text Parasolid (.x_t/.xmt_txt)" : "binary Parasolid (.x_b/.xmt_bin)";
}

function decodeEntryName(name: Buffer, flags: number): string {
  if ((flags & 0x0800) === 0 && [...name].some((value) => value > 0x7f)) {
    throw new Error("Non-ASCII CAD ZIP names must declare UTF-8 encoding");
  }
  const decoded = name.toString("utf8");
  if (decoded.includes("\uFFFD") || decoded.includes("\0")) throw new Error("Invalid CAD ZIP entry name encoding");
  return decoded;
}

function validateEntryName(name: string): void {
  if (!name || name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/u.test(name)
    || /[\u0000-\u001f\u007f]/u.test(name) || name.split("/").some((part) => part === "..")) {
    throw new Error(`Unsafe CAD ZIP entry path: ${name}`);
  }
}

function findEndOfCentralDirectory(data: Buffer): number {
  const minimum = Math.max(0, data.length - 65_557);
  for (let offset = data.length - 22; offset >= minimum; offset -= 1) {
    if (data.readUInt32LE(offset) === 0x06054b50) {
      const commentLength = data.readUInt16LE(offset + 20);
      if (offset + 22 + commentLength === data.length) return offset;
    }
  }
  throw new Error("Downloaded CAD ZIP archive has no valid end-of-central-directory record");
}

function ensureRange(data: Buffer, offset: number, length: number, label: string): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > data.length) {
    throw new Error(`Malformed CAD ZIP ${label}`);
  }
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

const STEP_HEADER = Buffer.from("ISO-10303-21;");
const STEP_TRAILER = Buffer.from("END-ISO-10303-21;");
