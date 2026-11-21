/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// A TypeScript implementation of the native image contract (natives.ts) for Node: unit tests and the headless
// runner. Node-only (node:zlib); never part of the device bundle.
//
// Decodes PNG (colour types 0/2/3/4/6, 8 and 16 bit, not interlaced) and a raw test format ("IWNRAW1\0", u32le
// width, u32le height, RGBA bytes). Applies the same pipeline as runtime/image/src/transform.cc for crop, flipY,
// alpha and resize (nearest for 'pixelated', bilinear otherwise; the native 'medium'/'high' filters are not
// reproduced). EXIF orientation is not read here. Results are delivered as tasks (setTimeout 0), like the native
// module's completions.

import { inflateSync } from 'node:zlib';
import { forgivingBase64 } from './load.ts';
import type { ImageNatives, NativeImageErrorCode, NativeImageHandle, NativeProcessOptions } from './natives.ts';

interface Pixels {
  width: number;
  height: number;
  data: Uint8Array; // RGBA, tightly packed
  premultiplied: boolean;
}

class FakeHandle implements NativeImageHandle {
  width = 0;
  height = 0;
  premultiplied = false;
  opaque = false;
}

const MAX_DIMENSION = 16384;

function fail(code: NativeImageErrorCode, message: string): Error & { code: NativeImageErrorCode } {
  return Object.assign(new Error(`image: ${code}: ${message}`), { code });
}

function u32be(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
}

export function decodePng(bytes: Uint8Array): Pixels {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 8 || sig.some((v, i) => bytes[i] !== v)) throw fail('unsupported', 'not a PNG');
  let pos = 8;
  let width = 0, height = 0, depth = 0, type = 0, interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (pos + 12 <= bytes.length) {
    const len = u32be(bytes, pos);
    const kind = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    if (pos + 12 + len > bytes.length) throw fail('corrupt', 'truncated chunk');
    const body = bytes.subarray(pos + 8, pos + 8 + len);
    if (kind === 'IHDR') {
      width = u32be(body, 0);
      height = u32be(body, 4);
      depth = body[8]!;
      type = body[9]!;
      interlace = body[12]!;
      if (width === 0 || height === 0) throw fail('corrupt', 'zero size');
      if (width > MAX_DIMENSION || height > MAX_DIMENSION) throw fail('too-large', `${width}x${height}`);
    } else if (kind === 'PLTE') palette = body;
    else if (kind === 'tRNS') trns = body;
    else if (kind === 'IDAT') idat.push(body);
    else if (kind === 'IEND') break;
    pos += 12 + len;
  }
  if (!width || idat.length === 0) throw fail('corrupt', 'missing IHDR/IDAT');
  if (interlace) throw fail('unsupported', 'interlaced PNG (fake natives)');
  if (depth !== 8 && depth !== 16) throw fail('unsupported', `bit depth ${depth} (fake natives)`);
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type];
  if (!channels) throw fail('corrupt', `colour type ${type}`);
  let raw: Uint8Array;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    throw fail('corrupt', 'bad zlib stream');
  }
  const bpp = (channels * depth) / 8;
  const stride = width * bpp;
  if (raw.length < (stride + 1) * height) throw fail('corrupt', 'short image data');
  const cur = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      let v = line[i]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw fail('corrupt', `filter ${filter}`);
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const s = (k: number) => cur[(x * channels + k) * (depth / 8)]!; // high byte for 16-bit
      const o = (y * width + x) * 4;
      if (type === 0) { out[o] = out[o + 1] = out[o + 2] = s(0); out[o + 3] = 255; }
      else if (type === 2) { out[o] = s(0); out[o + 1] = s(1); out[o + 2] = s(2); out[o + 3] = 255; }
      else if (type === 3) {
        const idx = s(0);
        if (!palette || idx * 3 + 2 >= palette.length) throw fail('corrupt', 'palette index');
        out[o] = palette[idx * 3]!; out[o + 1] = palette[idx * 3 + 1]!; out[o + 2] = palette[idx * 3 + 2]!;
        out[o + 3] = trns && idx < trns.length ? trns[idx]! : 255;
      } else if (type === 4) { out[o] = out[o + 1] = out[o + 2] = s(0); out[o + 3] = s(1); }
      else { out[o] = s(0); out[o + 1] = s(1); out[o + 2] = s(2); out[o + 3] = s(3); }
    }
    prev.set(cur);
  }
  return { width, height, data: out, premultiplied: false };
}

const RAW_MAGIC = 'IWNRAW1\0';

/** Encodes the fake natives' raw test format. */
export function encodeRawTestImage(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const out = new Uint8Array(16 + rgba.length);
  for (let i = 0; i < 8; i++) out[i] = RAW_MAGIC.charCodeAt(i);
  const dv = new DataView(out.buffer);
  dv.setUint32(8, width, true);
  dv.setUint32(12, height, true);
  out.set(rgba, 16);
  return out;
}

function decodeAny(bytes: Uint8Array): Pixels {
  if (bytes.length >= 16 && String.fromCharCode(...bytes.subarray(0, 8)) === RAW_MAGIC) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = dv.getUint32(8, true), height = dv.getUint32(12, true);
    if (width === 0 || height === 0) throw fail('corrupt', 'zero size');
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) throw fail('too-large', `${width}x${height}`);
    if (bytes.length < 16 + width * height * 4) throw fail('corrupt', 'short raw image');
    return { width, height, data: bytes.slice(16, 16 + width * height * 4), premultiplied: false };
  }
  return decodePng(bytes);
}

function premul(c: number, a: number): number {
  return Math.round((c * a) / 255);
}
function unpremul(c: number, a: number): number {
  return a === 0 ? 0 : Math.min(255, Math.round((c * 255) / a));
}

function convertAlpha(p: Pixels, want: 0 | 1 | 2): Pixels {
  const toPre = want === 1 && !p.premultiplied;
  const toStraight = want === 2 && p.premultiplied;
  if (!toPre && !toStraight) return p;
  const d = new Uint8Array(p.data);
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3]!;
    if (a === 255) continue;
    for (let c = 0; c < 3; c++) d[i + c] = toPre ? premul(d[i + c]!, a) : unpremul(d[i + c]!, a);
  }
  return { ...p, data: d, premultiplied: toPre };
}

export function processPixels(src: Pixels, o: NativeProcessOptions): Pixels {
  let p = src;
  if (o.crop) {
    const [cx, cy, cw, ch] = o.crop;
    const d = new Uint8Array(cw * ch * 4);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const sx = cx + x, sy = cy + y;
        if (sx < 0 || sy < 0 || sx >= p.width || sy >= p.height) continue;
        d.set(p.data.subarray((sy * p.width + sx) * 4, (sy * p.width + sx) * 4 + 4), (y * cw + x) * 4);
      }
    }
    p = { ...p, width: cw, height: ch, data: d };
  }
  const rw = o.resizeWidth || p.width;
  const rh = o.resizeHeight || p.height;
  if (rw !== p.width || rh !== p.height) {
    const wasStraight = !p.premultiplied;
    const pre = convertAlpha(p, 1);
    const d = new Uint8Array(rw * rh * 4);
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        for (let c = 0; c < 4; c++) {
          let v: number;
          if (o.quality === 0) {
            const sx = Math.min(pre.width - 1, Math.floor(((x + 0.5) * pre.width) / rw));
            const sy = Math.min(pre.height - 1, Math.floor(((y + 0.5) * pre.height) / rh));
            v = pre.data[(sy * pre.width + sx) * 4 + c]!;
          } else {
            const fx = Math.max(0, ((x + 0.5) * pre.width) / rw - 0.5);
            const fy = Math.max(0, ((y + 0.5) * pre.height) / rh - 0.5);
            const x0 = Math.min(pre.width - 1, Math.floor(fx)), y0 = Math.min(pre.height - 1, Math.floor(fy));
            const x1 = Math.min(pre.width - 1, x0 + 1), y1 = Math.min(pre.height - 1, y0 + 1);
            const tx = fx - x0, ty = fy - y0;
            const at = (xx: number, yy: number) => pre.data[(yy * pre.width + xx) * 4 + c]!;
            v = (at(x0, y0) * (1 - tx) + at(x1, y0) * tx) * (1 - ty) + (at(x0, y1) * (1 - tx) + at(x1, y1) * tx) * ty;
          }
          d[(y * rw + x) * 4 + c] = Math.round(v);
        }
      }
    }
    p = { width: rw, height: rh, data: d, premultiplied: true };
    if (wasStraight && o.alpha !== 1) p = convertAlpha(p, 2);
  }
  if (o.flipY) {
    const d = new Uint8Array(p.data.length);
    const row = p.width * 4;
    for (let y = 0; y < p.height; y++) d.set(p.data.subarray((p.height - 1 - y) * row, (p.height - y) * row), y * row);
    p = { ...p, data: d };
  }
  return convertAlpha(p, o.alpha ?? 0);
}

export interface FakeImageNatives extends ImageNatives {
  /** The pixels behind a handle (tests). */
  pixelsOf(handle: NativeImageHandle): Pixels | null;
  /** Every options object passed to decode/fromPixels/transform, in call order (tests). */
  calls: { op: string; options: NativeProcessOptions }[];
  /** Promises rejected through cancel() (tests). */
  cancelled: number;
}

export function createFakeImageNatives(): FakeImageNatives {
  const store = new WeakMap<NativeImageHandle, Pixels>();
  const parked = new Map<number, Pixels>();
  let nextId = 1;
  let pending = 0;
  let live = 0;
  const calls: FakeImageNatives['calls'] = [];

  const make = (p: Pixels): NativeImageHandle => {
    const h = new FakeHandle();
    h.width = p.width;
    h.height = p.height;
    h.premultiplied = p.premultiplied;
    let opaque = true;
    for (let i = 3; i < p.data.length; i += 4) if (p.data[i] !== 255) { opaque = false; break; }
    h.opaque = opaque;
    store.set(h, p);
    live++;
    return h;
  };
  // Pending jobs by promise, for cancel(): settling removes the entry; a cancelled job never runs.
  const jobs = new Map<Promise<unknown>, { reject(e: unknown): void; timer: ReturnType<typeof setTimeout> }>();
  const later = <T>(fn: () => T): Promise<T> => {
    pending++;
    let settle!: { resolve(v: T): void; reject(e: unknown): void };
    const promise = new Promise<T>((resolve, reject) => {
      settle = { resolve, reject };
    });
    const timer = setTimeout(() => {
      pending--;
      jobs.delete(promise);
      try {
        settle.resolve(fn());
      } catch (e) {
        settle.reject(e);
      }
    }, 0);
    jobs.set(promise, { reject: settle.reject, timer });
    return promise;
  };
  const live_ = (h: NativeImageHandle, op: string): Pixels => {
    const p = store.get(h);
    if (!p || h.width === 0) throw new TypeError(`image.${op}: not a live image handle`);
    return p;
  };
  const detach = (h: NativeImageHandle) => {
    if (store.delete(h)) live--;
    (h as FakeHandle).width = 0;
    (h as FakeHandle).height = 0;
  };
  const bytesOf = (v: ArrayBuffer | ArrayBufferView): Uint8Array =>
    v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);

  const natives: FakeImageNatives = {
    version: 2,
    needsPolling: false,
    calls,
    cancelled: 0,
    decode(bytes, options) {
      calls.push({ op: 'decode', options });
      const b = bytesOf(bytes);
      return later(() => make(processPixels(decodeAny(b), options)));
    },
    decodeBase64(text, options) {
      calls.push({ op: 'decodeBase64', options });
      return later(() => {
        const b = forgivingBase64(text);
        if (!b) throw fail('corrupt', 'invalid base64 in data: URL');
        return make(processPixels(decodeAny(b), options));
      });
    },
    cancel(promise) {
      const job = jobs.get(promise);
      if (!job) return false;
      clearTimeout(job.timer);
      jobs.delete(promise);
      pending--;
      natives.cancelled++;
      job.reject(fail('cancelled', ''));
      return true;
    },
    fromPixels(rgba, width, height, premultiplied, options) {
      calls.push({ op: 'fromPixels', options });
      const b = bytesOf(rgba);
      if (b.length !== width * height * 4) throw new TypeError('image.fromPixels: pixel buffer size does not match');
      const snap: Pixels = { width, height, data: b.slice(), premultiplied };
      return later(() => make(processPixels(snap, options)));
    },
    transform(handle, options) {
      calls.push({ op: 'transform', options });
      const src = live_(handle, 'transform');
      return later(() => make(processPixels(src, options)));
    },
    share(handle) {
      return make(live_(handle, 'share'));
    },
    readPixels(handle, premultiplied) {
      const p = convertAlpha(live_(handle, 'readPixels'), premultiplied ? 1 : 2);
      return new Uint8ClampedArray(p.data);
    },
    close(handle) {
      detach(handle);
    },
    exportTransfer(handle) {
      const p = live_(handle, 'exportTransfer');
      const id = nextId++;
      parked.set(id, p);
      detach(handle);
      return id;
    },
    importTransfer(id) {
      const p = parked.get(id);
      if (!p) return null;
      parked.delete(id);
      return make(p);
    },
    discardTransfer(id) {
      parked.delete(id);
    },
    poll() {
      return 0;
    },
    stats() {
      return { pending, queued: 0, threads: 1, handles: live, bytes: 0, parked: parked.size, backends: ['fake'] };
    },
    pixelsOf(handle) {
      return store.get(handle) ?? null;
    },
  };
  return natives;
}
