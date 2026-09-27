import { inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

export interface PngPixels {
  width: number;
  height: number;
  channels: 3 | 4;
  pixels: Uint8Array;
}

export interface PixelDifference {
  width: number;
  height: number;
  changedPixelCount: number;
  changedPixelRatio: number;
}

export function decodePngPixels(png: Uint8Array): PngPixels {
  const input = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (input.length < PNG_SIGNATURE.length || !input.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("Screenshot is not a PNG image");
  }

  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let sawHeader = false;
  let sawEnd = false;
  const imageData: Buffer[] = [];
  while (offset < input.length) {
    if (offset + 12 > input.length) throw new Error("PNG contains a truncated chunk header");
    const length = input.readUInt32BE(offset);
    const typeOffset = offset + 4;
    const dataOffset = offset + 8;
    const endOffset = dataOffset + length;
    if (endOffset + 4 > input.length) throw new Error("PNG contains a truncated chunk");
    const type = input.toString("ascii", typeOffset, dataOffset);
    const data = input.subarray(dataOffset, endOffset);
    const expectedCrc = input.readUInt32BE(endOffset);
    if (crc32(input.subarray(typeOffset, endOffset)) !== expectedCrc) throw new Error(`PNG ${type} chunk checksum is invalid`);

    if (!sawHeader && type !== "IHDR") throw new Error("PNG must begin with an IHDR chunk");
    if (type === "IHDR") {
      if (sawHeader || length !== 13) throw new Error("PNG has an invalid IHDR chunk");
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      if (data[10] !== 0 || data[11] !== 0 || data[12] !== 0) throw new Error("PNG uses unsupported compression, filtering, or interlacing");
      sawHeader = true;
    } else if (type === "IDAT") imageData.push(data);
    else if (type === "IEND") {
      if (length !== 0) throw new Error("PNG has an invalid IEND chunk");
      sawEnd = true;
      offset = endOffset + 4;
      break;
    } else if ((input[typeOffset]! & 0x20) === 0) {
      throw new Error(`PNG uses an unsupported critical ${type} chunk`);
    }
    offset = endOffset + 4;
  }
  if (!sawHeader || !sawEnd || offset !== input.length || width < 1 || height < 1 || imageData.length === 0) {
    throw new Error("PNG is incomplete or has invalid dimensions");
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`PNG color format is unsupported (bit depth ${bitDepth}, color type ${colorType})`);
  }
  if (width * height > 32_000_000) throw new Error("PNG screenshot exceeds the pixel safety limit");

  const channels = colorType === 6 ? 4 : 3;
  const rowBytes = width * channels;
  const expectedInflatedLength = height * (rowBytes + 1);
  const inflated = inflateSync(Buffer.concat(imageData), { maxOutputLength: expectedInflatedLength });
  if (inflated.length !== expectedInflatedLength) throw new Error("PNG pixel data has an unexpected length");

  const pixels = new Uint8Array(height * rowBytes);
  const previous = new Uint8Array(rowBytes);
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[sourceOffset++]!;
    if (filter > 4) throw new Error(`PNG uses unsupported row filter ${filter}`);
    const targetOffset = y * rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const raw = inflated[sourceOffset++]!;
      const left = x >= channels ? pixels[targetOffset + x - channels]! : 0;
      const up = y > 0 ? previous[x]! : 0;
      const upperLeft = y > 0 && x >= channels ? previous[x - channels]! : 0;
      const predictor = filter === 0 ? 0
        : filter === 1 ? left
          : filter === 2 ? up
            : filter === 3 ? Math.floor((left + up) / 2)
              : paeth(left, up, upperLeft);
      const value = (raw + predictor) & 0xff;
      pixels[targetOffset + x] = value;
    }
    previous.set(pixels.subarray(targetOffset, targetOffset + rowBytes));
  }
  return { width, height, channels, pixels };
}

export function comparePngPixels(firstPng: Uint8Array, secondPng: Uint8Array, channelThreshold = 16): PixelDifference {
  if (!Number.isInteger(channelThreshold) || channelThreshold < 0 || channelThreshold > 255) {
    throw new Error("Pixel comparison threshold must be an integer from 0 to 255");
  }
  const first = decodePngPixels(firstPng);
  const second = decodePngPixels(secondPng);
  if (first.width !== second.width || first.height !== second.height || first.channels !== second.channels) {
    throw new Error("Cannot compare screenshots with different dimensions or color formats");
  }
  let changedPixelCount = 0;
  for (let pixelOffset = 0; pixelOffset < first.pixels.length; pixelOffset += first.channels) {
    for (let channel = 0; channel < first.channels; channel += 1) {
      if (Math.abs(first.pixels[pixelOffset + channel]! - second.pixels[pixelOffset + channel]!) > channelThreshold) {
        changedPixelCount += 1;
        break;
      }
    }
  }
  const pixelCount = first.width * first.height;
  return { width: first.width, height: first.height, changedPixelCount, changedPixelRatio: changedPixelCount / pixelCount };
}

function paeth(left: number, up: number, upperLeft: number): number {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  return leftDistance <= upDistance && leftDistance <= upperLeftDistance ? left : upDistance <= upperLeftDistance ? up : upperLeft;
}

function crc32(data: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of data) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
