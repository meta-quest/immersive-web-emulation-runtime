/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// TexImageSource uploads (spec GL-16, GL-17). The image / canvas / bitmap implementations (stream M4) expose
// their pixels through one protocol method so this module does not depend on them:
//
//   source[TEX_SOURCE]() -> { width, height, data: Uint8Array | Uint8ClampedArray (RGBA8, rows top to bottom),
//                             premultiplied: boolean, isBitmap?: boolean, closed?: boolean, complete?: boolean }
//
// The image module's protocol (runtime/image/INTEROP.md) is preferred when a source implements it:
//
//   source[IMAGE_SOURCE]() -> { kind: 'pixels', data, origin, width, height, premultiplied }
//                           | { kind: 'handle', handle, origin, width, height, premultiplied }
//
// 'handle' pixels stay native: RGBA/UNSIGNED_BYTE uploads of the whole image go straight from the pixel store
// (__iwn.gl.imageUpload), anything else copies them once (imageRead) and converts here.
//
// ImageData-shaped objects ({ width, height, data: Uint8ClampedArray }) work without the protocol. WebGL
// canvases are read back through their context (readPixels of the drawing buffer, bottom-up -> flipped).
// Video sources throw TypeError (no video yet, documented).

import type { Ctx } from './core.ts';
import * as E from './gen/enums.gen.ts';

export const TEX_SOURCE: unique symbol = Symbol.for('iwn.texImageSource') as never;
/** runtime/image's protocol (web/image/source.ts IMAGE_SOURCE). */
export const IMAGE_SOURCE: unique symbol = Symbol.for('iwn.image.source') as never;

export interface SourcePixels {
  width: number;
  height: number;
  /** Empty for native handles until materializePixels. */
  data: Uint8Array | Uint8ClampedArray;
  premultiplied: boolean;
  isBitmap: boolean;
  /** A runtime/image native handle (ImageBitmap / HTMLImageElement pixels). */
  handle?: object;
}

interface ImageSourceDescriptor {
  kind: 'pixels' | 'handle';
  origin: string;
  width: number;
  height: number;
  premultiplied: boolean;
  data?: Uint8Array | Uint8ClampedArray;
  handle?: object;
}

const EMPTY = new Uint8Array(0);

/** Copy a handle's pixels (tight RGBA8, the store's alpha mode) into JS memory once. */
export function materializePixels(px: SourcePixels, ctx: Ctx, what: string): void {
  if (!px.handle || px.data.byteLength) return;
  const data = new Uint8Array(px.width * px.height * 4);
  void data.buffer; // out-parameter: keep the view off-heap (fast-API GetContents copies small on-heap views)
  if (!ctx._n.imageRead(px.handle, data, 0, data.byteLength, false, -1)) {
    throw domException(`${what}: the source is closed or detached`, 'InvalidStateError');
  }
  px.data = data;
}

export function domException(message: string, name: string): Error {
  const D = (globalThis as { DOMException?: new (m: string, n: string) => Error }).DOMException;
  if (D) return new D(message, name);
  const e = new Error(message);
  e.name = name;
  return e;
}

export function getSourcePixels(source: unknown, ctx: Ctx, what: string): SourcePixels {
  if (source === null || typeof source !== 'object') throw new TypeError(`${what}: source is not a TexImageSource`);
  const ctor = (source as { constructor?: { name?: string } }).constructor?.name ?? '';
  if (ctor === 'HTMLVideoElement' || ctor === 'VideoFrame') {
    throw new TypeError(`${what}: video sources are not supported by this runtime`);
  }
  const image = (source as Record<PropertyKey, unknown>)[IMAGE_SOURCE];
  if (typeof image === 'function') {
    // Throws TypeError / InvalidStateError itself (closed bitmap, broken image, zero-sized canvas).
    const d = (image as () => ImageSourceDescriptor).call(source);
    if (!d) throw domException(`${what}: the source is not usable`, 'InvalidStateError');
    const base = { width: d.width, height: d.height, premultiplied: !!d.premultiplied, isBitmap: d.origin === 'bitmap' };
    if (d.kind === 'handle') return { ...base, data: EMPTY, handle: d.handle };
    return { ...base, data: d.data ?? EMPTY };
  }
  const proto = (source as Record<PropertyKey, unknown>)[TEX_SOURCE];
  if (typeof proto === 'function') {
    const r = (proto as () => SourcePixels & { closed?: boolean; complete?: boolean }).call(source);
    if (!r || r.closed) throw domException(`${what}: the source is closed or detached`, 'InvalidStateError');
    if (r.complete === false) throw domException(`${what}: the image is not loaded`, 'InvalidStateError');
    return { width: r.width, height: r.height, data: r.data, premultiplied: !!r.premultiplied, isBitmap: !!r.isBitmap };
  }
  // A WebGL canvas: read its drawing buffer.
  const webgl = (source as { __iwnWebGLContext?: Ctx }).__iwnWebGLContext;
  if (webgl) return readCanvasPixels(webgl);
  const d = (source as { data?: unknown; width?: unknown; height?: unknown }).data;
  if (d instanceof Uint8ClampedArray && typeof (source as { width: unknown }).width === 'number') {
    const s = source as { width: number; height: number; data: Uint8ClampedArray };
    return { width: s.width, height: s.height, data: s.data, premultiplied: false, isBitmap: false };
  }
  void ctx;
  throw new TypeError(`${what}: source is not a TexImageSource`);
}

/** Drawing buffer of another (or the same) WebGL context, as top-down RGBA8. */
function readCanvasPixels(src: Ctx): SourcePixels {
  src._skip();
  src._ensureDefaultFramebuffer();
  const w = src._dfbWidth;
  const h = src._dfbHeight;
  const data = new Uint8Array(w * h * 4);
  const n = src._n;
  const restore = src._prepareDefaultRead();
  if (!restore) n.bindFramebuffer(E.READ_FRAMEBUFFER, src._dfbName);
  const pa = src._ps[0];
  if (pa !== 4) n.pixelStorei(E.PACK_ALIGNMENT, 4);
  if (src._pixelPack) n.bindBuffer(E.PIXEL_PACK_BUFFER, 0);
  n.readPixels(0, 0, w, h, E.RGBA, E.UNSIGNED_BYTE, data, 0, data.byteLength);
  if (src._pixelPack) n.bindBuffer(E.PIXEL_PACK_BUFFER, src._pixelPack._name);
  if (pa !== 4) n.pixelStorei(E.PACK_ALIGNMENT, pa);
  src._restoreFramebufferBindings();
  // GL rows are bottom-up; TexImageSource rows are top-down.
  const row = w * 4;
  const tmp = new Uint8Array(row);
  for (let y = 0; y < h >> 1; y++) {
    const a = y * row;
    const b = (h - 1 - y) * row;
    tmp.set(data.subarray(a, a + row));
    data.copyWithin(a, b, b + row);
    data.set(tmp, b);
  }
  return { width: w, height: h, data, premultiplied: src._attrs.premultipliedAlpha, isBitmap: false };
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
function toHalf(v: number): number {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  let e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    let h = mant >> shift;
    if ((mant >> (shift - 1)) & 1) h++;
    return sign | h;
  }
  let h = sign | (e << 10) | (mant >> 13);
  if (mant & 0x1000) h++;
  return h;
}

/**
 * Convert source RGBA8 (top-down) into tightly packed (format, type) pixels for GL (rows bottom-up in GL
 * terms = first row uploaded is row 0, so WebGL's "top row first" order is kept unless flipY).
 * `premultiply`: true = premultiply, false = un-premultiply if the source is premultiplied, null = leave.
 * Returns null for unsupported (format, type) combinations.
 */
export function convertPixels(
  src: SourcePixels,
  skipX: number,
  skipY: number,
  w: number,
  rows: number,
  sliceRows: number,
  depth: number,
  format: number,
  type: number,
  flipY: boolean,
  premultiply: boolean | null,
): ArrayBufferView | null {
  const comps = formatComps(format);
  if (comps === 0) return null;
  const packed = type === E.UNSIGNED_SHORT_5_6_5 || type === E.UNSIGNED_SHORT_4_4_4_4 || type === E.UNSIGNED_SHORT_5_5_5_1;
  // WebGL 2 TexImageSource formats packed in 32 bits: R11F_G11F_B10F and RGB10_A2
  const packed32 = (type === E.UNSIGNED_INT_10F_11F_11F_REV && format === E.RGB) || (type === E.UNSIGNED_INT_2_10_10_10_REV && format === E.RGBA);
  if (!(type === E.UNSIGNED_BYTE || type === E.HALF_FLOAT || type === E.HALF_FLOAT_OES || type === E.FLOAT || packed || packed32)) return null;
  const h = depth > 1 ? rows / depth : rows;
  const count = w * h * depth;
  let out8: Uint8Array | null = null;
  let out16: Uint16Array | null = null;
  let out32: Float32Array | null = null;
  let outU32: Uint32Array | null = null;
  if (type === E.UNSIGNED_BYTE) out8 = new Uint8Array(count * comps);
  else if (packed32) outU32 = new Uint32Array(count);
  else if (packed || type === E.HALF_FLOAT || type === E.HALF_FLOAT_OES) out16 = new Uint16Array(count * (packed ? 1 : comps));
  else out32 = new Float32Array(count * comps);
  const sw = src.width;
  const sh = src.height;
  const s = src.data;
  let o = 0;
  for (let z = 0; z < depth; z++) {
    for (let y = 0; y < h; y++) {
      // WebGL 2.0 §5.35: UNPACK_FLIP_Y_WEBGL applies to the whole source first; UNPACK_SKIP_* / IMAGE_HEIGHT then
      // select rows of the flipped image.
      const fy = skipY + z * sliceRows + y;
      const sy = flipY ? sh - 1 - fy : fy;
      for (let x = 0; x < w; x++) {
        const sx = skipX + x;
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 255;
        if (sx < sw && sy < sh && sx >= 0 && sy >= 0) {
          const i = (sy * sw + sx) * 4;
          r = s[i];
          g = s[i + 1];
          b = s[i + 2];
          a = s[i + 3];
        } else {
          a = 0;
        }
        if (premultiply === true && !src.premultiplied && a !== 255) {
          r = Math.round((r * a) / 255);
          g = Math.round((g * a) / 255);
          b = Math.round((b * a) / 255);
        } else if (premultiply === false && src.premultiplied && a !== 0 && a !== 255) {
          r = Math.min(255, Math.round((r * 255) / a));
          g = Math.min(255, Math.round((g * 255) / a));
          b = Math.min(255, Math.round((b * 255) / a));
        }
        if (out8) {
          o = writeComps8(out8, o, format, r, g, b, a);
        } else if (outU32) {
          outU32[o++] =
            type === E.UNSIGNED_INT_2_10_10_10_REV
              ? (Math.round((r * 1023) / 255) | (Math.round((g * 1023) / 255) << 10) | (Math.round((b * 1023) / 255) << 20) | (Math.round((a * 3) / 255) << 30)) >>> 0
              : ((toHalf(r / 255) + 8) >> 4) | (((toHalf(g / 255) + 8) >> 4) << 11) | ((((toHalf(b / 255) + 16) >> 5) << 22) >>> 0);
        } else if (packed && out16) {
          let v = 0;
          if (type === E.UNSIGNED_SHORT_5_6_5) v = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
          else if (type === E.UNSIGNED_SHORT_4_4_4_4) v = ((r >> 4) << 12) | ((g >> 4) << 8) | ((b >> 4) << 4) | (a >> 4);
          else v = ((r >> 3) << 11) | ((g >> 3) << 6) | ((b >> 3) << 1) | (a >> 7);
          out16[o++] = v;
        } else if (out16) {
          o = writeCompsF(out16, o, format, r / 255, g / 255, b / 255, a / 255, true);
        } else if (out32) {
          o = writeCompsF(out32, o, format, r / 255, g / 255, b / 255, a / 255, false);
        }
      }
    }
  }
  return out8 ?? out16 ?? out32 ?? outU32;
}

function formatComps(format: number): number {
  switch (format) {
    case E.RGBA:
    case E.SRGB_ALPHA_EXT:
    case E.RGBA_INTEGER:
      return 4;
    case E.RGB:
    case E.SRGB_EXT:
    case E.RGB_INTEGER:
      return 3;
    case E.RG:
    case E.LUMINANCE_ALPHA:
    case E.RG_INTEGER:
      return 2;
    case E.RED_INTEGER:
    case E.RED:
    case E.LUMINANCE:
    case E.ALPHA:
      return 1;
    default:
      return 0;
  }
}

function writeComps8(o8: Uint8Array, o: number, format: number, r: number, g: number, b: number, a: number): number {
  switch (format) {
    case E.RGBA:
    case E.SRGB_ALPHA_EXT:
    case E.RGBA_INTEGER:
      o8[o] = r;
      o8[o + 1] = g;
      o8[o + 2] = b;
      o8[o + 3] = a;
      return o + 4;
    case E.RGB:
    case E.SRGB_EXT:
    case E.RGB_INTEGER:
      o8[o] = r;
      o8[o + 1] = g;
      o8[o + 2] = b;
      return o + 3;
    case E.RG:
    case E.RG_INTEGER:
      o8[o] = r;
      o8[o + 1] = g;
      return o + 2;
    case E.LUMINANCE_ALPHA:
      o8[o] = r;
      o8[o + 1] = a;
      return o + 2;
    case E.ALPHA:
      o8[o] = a;
      return o + 1;
    default:
      o8[o] = r; // RED, LUMINANCE
      return o + 1;
  }
}

function writeCompsF(out: Uint16Array | Float32Array, o: number, format: number, r: number, g: number, b: number, a: number, half: boolean): number {
  const put = (v: number): void => {
    out[o++] = half ? toHalf(v) : v;
  };
  switch (format) {
    case E.RGBA:
      put(r), put(g), put(b), put(a);
      break;
    case E.RGB:
      put(r), put(g), put(b);
      break;
    case E.RG:
      put(r), put(g);
      break;
    case E.LUMINANCE_ALPHA:
      put(r), put(a);
      break;
    case E.ALPHA:
      put(a);
      break;
    default:
      put(r);
  }
  return o;
}
