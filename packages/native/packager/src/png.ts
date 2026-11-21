/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PNG decode/encode and an area-averaging resize, for launcher icons in the
 * template's densities. Written from the W3C PNG specification (2nd/3rd
 * edition): chunks, IHDR, PLTE, tRNS, IDAT, filters 0-4, Adam7.
 */

import { crc32, deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class PngError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PngError';
  }
}

/** 8-bit RGBA, row-major, non-premultiplied. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export function isPng(buf: Buffer): boolean {
  return buf.length >= 8 && buf.subarray(0, 8).equals(SIGNATURE);
}

export function isWebp(buf: Buffer): boolean {
  return (
    buf.length >= 12 &&
    buf.toString('latin1', 0, 4) === 'RIFF' &&
    buf.toString('latin1', 8, 12) === 'WEBP'
  );
}

/** Width and height from the header (PNG IHDR or WebP VP8/VP8L/VP8X). */
export function imageSize(
  buf: Buffer,
): { width: number; height: number } | null {
  if (isPng(buf) && buf.length >= 24)
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (isWebp(buf) && buf.length >= 30) {
    const kind = buf.toString('latin1', 12, 16);
    if (kind === 'VP8X')
      return {
        width: 1 + buf.readUIntLE(24, 3),
        height: 1 + buf.readUIntLE(27, 3),
      };
    if (kind === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (kind === 'VP8 ')
      return {
        width: buf.readUInt16LE(26) & 0x3fff,
        height: buf.readUInt16LE(28) & 0x3fff,
      };
  }
  return null;
}

export function decodePng(buf: Buffer): RgbaImage {
  if (!isPng(buf)) throw new PngError('not a PNG file');
  let p = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (p + 12 + len > buf.length) throw new PngError('truncated PNG');
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[10] !== 0 || data[11] !== 0)
        throw new PngError('unsupported PNG compression/filter method');
      interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (!width || !height) throw new PngError('PNG has no IHDR');
  if (width * height > 64 * 1024 * 1024)
    throw new PngError('PNG too large for an icon');
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[
    colorType
  ];
  if (!channels) throw new PngError(`bad PNG color type ${colorType}`);
  if (colorType === 3 && !palette)
    throw new PngError('palette PNG without PLTE');
  const bpp = Math.max(1, (channels * bitDepth) >> 3); // bytes per complete pixel for filtering
  const raw = inflateSync(Buffer.concat(idat));
  const out = new Uint8Array(width * height * 4);

  const sample = (row: Uint8Array, x: number, c: number): number => {
    // Returns the sample scaled to 8 bits.
    if (bitDepth === 8) return row[x * channels + c];
    if (bitDepth === 16) return row[(x * channels + c) * 2];
    const perByte = 8 / bitDepth;
    const idx = x * channels + c;
    const byte = row[Math.floor(idx / perByte)];
    const shift = 8 - bitDepth * ((idx % perByte) + 1);
    const v = (byte >> shift) & ((1 << bitDepth) - 1);
    return colorType === 3 ? v : Math.round((v * 255) / ((1 << bitDepth) - 1));
  };
  const rawSample16 = (row: Uint8Array, x: number, c: number) =>
    bitDepth === 16
      ? (row[(x * channels + c) * 2] << 8) | row[(x * channels + c) * 2 + 1]
      : -1;
  const put = (row: Uint8Array, x: number, ox: number, oy: number) => {
    const o = (oy * width + ox) * 4;
    let r: number,
      g: number,
      b: number,
      a = 255;
    if (colorType === 3) {
      const i = sample(row, x, 0);
      r = palette![i * 3];
      g = palette![i * 3 + 1];
      b = palette![i * 3 + 2];
      if (trns && i < trns.length) a = trns[i];
    } else if (colorType === 0 || colorType === 4) {
      r = g = b = sample(row, x, 0);
      if (colorType === 4) a = sample(row, x, 1);
      else if (trns) {
        const key = trns.readUInt16BE(0);
        const v =
          bitDepth === 16
            ? rawSample16(row, x, 0)
            : bitDepth === 8
              ? row[x]
              : (sample(row, x, 0) * ((1 << bitDepth) - 1)) / 255;
        if (v === key) a = 0;
      }
    } else {
      r = sample(row, x, 0);
      g = sample(row, x, 1);
      b = sample(row, x, 2);
      if (colorType === 6) a = sample(row, x, 3);
      else if (trns) {
        const keys = [
          trns.readUInt16BE(0),
          trns.readUInt16BE(2),
          trns.readUInt16BE(4),
        ];
        const vs =
          bitDepth === 16
            ? [0, 1, 2].map((c) => rawSample16(row, x, c))
            : [r, g, b];
        if (vs.every((v, i) => v === keys[i])) a = 0;
      }
    }
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = a;
  };

  let offset = 0;
  const pass = (
    w: number,
    h: number,
    map: (x: number, y: number) => [number, number],
  ) => {
    if (w === 0 || h === 0) return;
    const stride = Math.ceil((w * channels * bitDepth) / 8);
    let prev = new Uint8Array(stride);
    for (let y = 0; y < h; y++) {
      if (offset + 1 + stride > raw.length)
        throw new PngError('PNG image data too short');
      const filter = raw[offset];
      const row = new Uint8Array(raw.subarray(offset + 1, offset + 1 + stride));
      offset += 1 + stride;
      unfilter(filter, row, prev, bpp);
      for (let x = 0; x < w; x++) {
        const [ox, oy] = map(x, y);
        put(row, x, ox, oy);
      }
      prev = row;
    }
  };
  if (interlace === 0) pass(width, height, (x, y) => [x, y]);
  else {
    const passes = [
      [0, 0, 8, 8],
      [4, 0, 8, 8],
      [0, 4, 4, 8],
      [2, 0, 4, 4],
      [0, 2, 2, 4],
      [1, 0, 2, 2],
      [0, 1, 1, 2],
    ];
    for (const [x0, y0, dx, dy] of passes) {
      const w = Math.ceil((width - x0) / dx);
      const h = Math.ceil((height - y0) / dy);
      pass(Math.max(0, w), Math.max(0, h), (x, y) => [
        x0 + x * dx,
        y0 + y * dy,
      ]);
    }
  }
  return { width, height, data: out };
}

function unfilter(
  filter: number,
  row: Uint8Array,
  prev: Uint8Array,
  bpp: number,
): void {
  for (let i = 0; i < row.length; i++) {
    const a = i >= bpp ? row[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;
    let v = row[i];
    switch (filter) {
      case 0:
        break;
      case 1:
        v += a;
        break;
      case 2:
        v += b;
        break;
      case 3:
        v += (a + b) >> 1;
        break;
      case 4: {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        break;
      }
      default:
        throw new PngError(`bad PNG filter type ${filter}`);
    }
    row[i] = v & 0xff;
  }
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** Encode 8-bit RGBA (filter 0 rows, zlib level 9: deterministic). */
export function encodePng(img: RgbaImage): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = img.width * 4;
  const raw = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    // Filter 1 (Sub) compresses icons better than none and is cheap.
    const o = y * (stride + 1);
    raw[o] = 1;
    for (let i = 0; i < stride; i++) {
      const cur = img.data[y * stride + i];
      const left = i >= 4 ? img.data[y * stride + i - 4] : 0;
      raw[o + 1 + i] = (cur - left) & 0xff;
    }
  }
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Resize with alpha-weighted area averaging (downscale) or bilinear
 * interpolation (upscale). Colour is averaged premultiplied so transparent
 * pixels do not bleed dark fringes into the edges.
 */
export function resize(
  img: RgbaImage,
  width: number,
  height: number,
): RgbaImage {
  if (img.width === width && img.height === height) return img;
  const out = new Uint8Array(width * height * 4);
  if (width <= img.width && height <= img.height) {
    const sx = img.width / width;
    const sy = img.height / height;
    for (let y = 0; y < height; y++) {
      const y0 = y * sy;
      const y1 = y0 + sy;
      for (let x = 0; x < width; x++) {
        const x0 = x * sx;
        const x1 = x0 + sx;
        let r = 0,
          g = 0,
          b = 0,
          a = 0,
          area = 0;
        for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
          const wy = Math.min(y1, yy + 1) - Math.max(y0, yy);
          for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
            const wx = Math.min(x1, xx + 1) - Math.max(x0, xx);
            const w = wx * wy;
            const i = (yy * img.width + xx) * 4;
            const al = img.data[i + 3] * w;
            r += img.data[i] * al;
            g += img.data[i + 1] * al;
            b += img.data[i + 2] * al;
            a += al;
            area += w;
          }
        }
        const o = (y * width + x) * 4;
        if (a > 0) {
          out[o] = Math.round(r / a);
          out[o + 1] = Math.round(g / a);
          out[o + 2] = Math.round(b / a);
        }
        out[o + 3] = Math.round(a / area);
      }
    }
    return { width, height, data: out };
  }
  for (let y = 0; y < height; y++) {
    const fy = Math.max(
      0,
      Math.min(img.height - 1, ((y + 0.5) * img.height) / height - 0.5),
    );
    const y0 = Math.floor(fy);
    const y1 = Math.min(img.height - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.max(
        0,
        Math.min(img.width - 1, ((x + 0.5) * img.width) / width - 0.5),
      );
      const x0 = Math.floor(fx);
      const x1 = Math.min(img.width - 1, x0 + 1);
      const tx = fx - x0;
      const px = (xx: number, yy: number) => (yy * img.width + xx) * 4;
      const corners: [number, number][] = [
        [px(x0, y0), (1 - tx) * (1 - ty)],
        [px(x1, y0), tx * (1 - ty)],
        [px(x0, y1), (1 - tx) * ty],
        [px(x1, y1), tx * ty],
      ];
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (const [i, w] of corners) {
        const al = img.data[i + 3] * w;
        r += img.data[i] * al;
        g += img.data[i + 1] * al;
        b += img.data[i + 2] * al;
        a += al;
      }
      const o = (y * width + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round(a);
    }
  }
  return { width, height, data: out };
}

/** A simple generated placeholder icon (rounded square with a ring). */
export function placeholderIcon(
  size: number,
  rgb: [number, number, number] = [0x1d, 0x65, 0xc1],
): RgbaImage {
  const data = new Uint8Array(size * size * 4);
  const r = size * 0.18;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = Math.min(Math.max(x + 0.5, r), size - r);
      const cy = Math.min(Math.max(y + 0.5, r), size - r);
      const inside = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r;
      const o = (y * size + x) * 4;
      if (!inside) continue;
      const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / size;
      const ring = d > 0.22 && d < 0.32;
      data[o] = ring ? 255 : rgb[0];
      data[o + 1] = ring ? 255 : rgb[1];
      data[o + 2] = ring ? 255 : rgb[2];
      data[o + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}
