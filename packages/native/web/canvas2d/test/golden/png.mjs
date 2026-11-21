/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Minimal PNG encode/decode for the golden images (RGBA8, non-interlaced), over node:zlib. Written from the PNG
// specification (chunk layout, CRC-32, filter types 0-4).

import { deflateSync, inflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Encodes unpremultiplied RGBA8 pixels. */
export function encodePng(rgba, width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Decodes an 8-bit RGBA or RGB, non-interlaced PNG into { width, height, data: Uint8Array RGBA }. */
export function decodePng(buf) {
  const b = Buffer.from(buf);
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8;
  let width = 0;
  let height = 0;
  let colorType = 6;
  const idat = [];
  while (off < b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString('ascii', off + 4, off + 8);
    const data = b.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported PNG (bit depth / interlace)');
      colorType = data[9];
      if (colorType !== 6 && colorType !== 2) throw new Error('unsupported PNG colour type');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const cur = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const up = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (ft === 1) v += a;
      else if (ft === 2) v += up;
      else if (ft === 3) v += (a + up) >> 1;
      else if (ft === 4) {
        const p = a + up - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      cur[i] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      out[(y * width + x) * 4] = cur[x * bpp];
      out[(y * width + x) * 4 + 1] = cur[x * bpp + 1];
      out[(y * width + x) * 4 + 2] = cur[x * bpp + 2];
      out[(y * width + x) * 4 + 3] = bpp === 4 ? cur[x * bpp + 3] : 255;
    }
    prev.set(cur);
  }
  return { width, height, data: out };
}

/**
 * C2D-11 comparison: fraction of pixels whose premultiplied channels differ by more than `threshold` (0..255).
 * Premultiplied values are compared so near-transparent pixels do not exaggerate colour noise.
 */
export function comparePixels(a, b, width, height, threshold = 16) {
  let bad = 0;
  let maxDiff = 0;
  for (let i = 0; i < width * height; i++) {
    const aa = a[4 * i + 3];
    const ba = b[4 * i + 3];
    let worst = Math.abs(aa - ba);
    for (let c = 0; c < 3; c++) {
      const pa = (a[4 * i + c] * aa) / 255;
      const pb = (b[4 * i + c] * ba) / 255;
      worst = Math.max(worst, Math.abs(pa - pb));
    }
    if (worst > threshold) bad++;
    if (worst > maxDiff) maxDiff = worst;
  }
  return { fraction: bad / (width * height), bad, maxDiff };
}

/** A visual diff: red where pixels differ beyond the threshold, grey copy of `a` elsewhere. */
export function diffImage(a, b, width, height, threshold = 16) {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    let worst = Math.abs(a[4 * i + 3] - b[4 * i + 3]);
    for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs((a[4 * i + c] * a[4 * i + 3]) / 255 - (b[4 * i + c] * b[4 * i + 3]) / 255));
    if (worst > threshold) {
      out.set([255, 0, 0, 255], 4 * i);
    } else {
      const g = Math.round((a[4 * i] + a[4 * i + 1] + a[4 * i + 2]) / 3);
      out.set([g, g, g, Math.max(40, a[4 * i + 3])], 4 * i);
    }
  }
  return out;
}
