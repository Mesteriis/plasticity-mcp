import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { test } from "node:test";

import { comparePngPixels, decodePngPixels } from "./png-pixels.ts";

test("decodes all PNG row filters and compares the reconstructed pixels", () => {
  const pixels = Uint8Array.from({ length: 3 * 5 * 4 }, (_, index) => (index * 47 + 23) & 0xff);
  const png = encodePng(3, 5, 6, pixels, [0, 1, 2, 3, 4]);

  const decoded = decodePngPixels(png);
  assert.deepEqual({ width: decoded.width, height: decoded.height, channels: decoded.channels }, { width: 3, height: 5, channels: 4 });
  assert.deepEqual(decoded.pixels, pixels);
  assert.deepEqual(comparePngPixels(png, encodePng(3, 5, 6, pixels, [4, 3, 2, 1, 0])), {
    width: 3, height: 5, changedPixelCount: 0, changedPixelRatio: 0,
  });
});

test("counts affected pixels, applies the channel threshold, and rejects incompatible screenshots", () => {
  const baseline = Uint8Array.from([0, 0, 0, 255, 20, 20, 20, 255, 40, 40, 40, 255, 60, 60, 60, 255]);
  const changed = Uint8Array.from([0, 0, 0, 255, 20, 20, 20, 255, 80, 40, 40, 255, 60, 60, 60, 255]);
  const first = encodePng(2, 2, 6, baseline, [0, 1]);
  const second = encodePng(2, 2, 6, changed, [0, 2]);

  assert.deepEqual(comparePngPixels(first, second), { width: 2, height: 2, changedPixelCount: 1, changedPixelRatio: 0.25 });
  assert.throws(() => comparePngPixels(first, encodePng(1, 4, 6, baseline, [0, 0, 0, 0])), /different dimensions/i);
  assert.throws(() => comparePngPixels(first, second, -1), /threshold/i);
});

test("rejects corrupt checksums, unsupported color formats, and truncated PNGs", () => {
  const pixels = Uint8Array.from([12, 34, 56, 255]);
  const valid = encodePng(1, 1, 6, pixels, [0]);
  const corrupt = Buffer.from(valid);
  corrupt[29] = corrupt[29]! ^ 0xff;

  assert.throws(() => decodePngPixels(corrupt), /checksum/i);
  assert.throws(() => decodePngPixels(encodePng(1, 1, 0, Uint8Array.from([127]), [0])), /unsupported/i);
  assert.throws(() => decodePngPixels(valid.subarray(0, valid.length - 5)), /truncated|incomplete/i);
});

function encodePng(width: number, height: number, colorType: 0 | 2 | 6, pixels: Uint8Array, filters: number[]): Buffer {
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  assert.equal(pixels.length, width * height * channels);
  assert.equal(filters.length, height);
  const scanlines: number[] = [];
  for (let y = 0; y < height; y += 1) {
    const filter = filters[y]!;
    const rowOffset = y * width * channels;
    const priorOffset = rowOffset - width * channels;
    scanlines.push(filter);
    for (let x = 0; x < width * channels; x += 1) {
      const raw = pixels[rowOffset + x]!;
      const left = x >= channels ? pixels[rowOffset + x - channels]! : 0;
      const up = y > 0 ? pixels[priorOffset + x]! : 0;
      const upperLeft = y > 0 && x >= channels ? pixels[priorOffset + x - channels]! : 0;
      const predictor = filter === 0 ? 0
        : filter === 1 ? left
          : filter === 2 ? up
            : filter === 3 ? Math.floor((left + up) / 2)
              : paeth(left, up, upperLeft);
      scanlines.push((raw - predictor + 256) & 0xff);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = colorType;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    makeChunk("IHDR", header),
    makeChunk("IDAT", deflateSync(Buffer.from(scanlines))),
    makeChunk("IEND", Buffer.alloc(0)),
  ]);
}

function makeChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([header, name, data, checksum]);
}

function crc32(data: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of data) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}

function paeth(left: number, up: number, upperLeft: number): number {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  return leftDistance <= upDistance && leftDistance <= upperLeftDistance ? left : upDistance <= upperLeftDistance ? up : upperLeft;
}
