/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Textures: binding cache, uploads from typed arrays / unpack buffers / TexImageSource (GL-7, GL-16, GL-17),
// immutable storage, compressed formats (GL-27), zero-initialisation (GL-3), copies from the (emulated)
// default framebuffer.

import type { Ctx } from './core.ts';
import * as E from './gen/enums.gen.ts';
import {
  COMPRESSED_FORMATS,
  SIZED_FORMAT_INFO,
  bytesPerPixel,
  compressedByteSize,
  imageByteSize,
  subFormatError,
  texFormatError,
  viewKind,
  viewMatchesType,
  type PixelStore,
} from './formats.ts';
import { INTERNAL, WebGLTexture } from './objects.ts';
import {
  PS_UNPACK_ALIGNMENT,
  PS_UNPACK_IMAGE_HEIGHT,
  PS_UNPACK_ROW_LENGTH,
  PS_UNPACK_SKIP_IMAGES,
  PS_UNPACK_SKIP_PIXELS,
  PS_UNPACK_SKIP_ROWS,
} from './state.ts';
import { isView, range, viewRange } from './views.ts';
import { convertPixels, domException, getSourcePixels, materializePixels, type SourcePixels } from './tex-source.ts';
import { framebufferVerdict, missingReadImage, readBufferFormat } from './framebuffers.ts';

const ps: PixelStore = { alignment: 4, rowLength: 0, imageHeight: 0, skipPixels: 0, skipRows: 0, skipImages: 0 };
const TIGHT: PixelStore = { alignment: 1, rowLength: 0, imageHeight: 0, skipPixels: 0, skipRows: 0, skipImages: 0 };

function unpackStore(ctx: Ctx): PixelStore {
  const p = ctx._ps;
  ps.alignment = p[PS_UNPACK_ALIGNMENT];
  ps.rowLength = p[PS_UNPACK_ROW_LENGTH];
  ps.imageHeight = p[PS_UNPACK_IMAGE_HEIGHT];
  ps.skipPixels = p[PS_UNPACK_SKIP_PIXELS];
  ps.skipRows = p[PS_UNPACK_SKIP_ROWS];
  ps.skipImages = p[PS_UNPACK_SKIP_IMAGES];
  return ps;
}

function isCubeFace(t: number): boolean {
  return t >= E.TEXTURE_CUBE_MAP_POSITIVE_X && t <= E.TEXTURE_CUBE_MAP_NEGATIVE_Z;
}

/** Texture bound for a texImage2D-style target (2D or cube face) on the active unit, undefined if target is invalid. */
function tex2DTarget(ctx: Ctx, target: number): WebGLTexture | null | undefined {
  if (target === E.TEXTURE_2D) return ctx._tex2D[ctx._activeUnit];
  if (isCubeFace(target)) return ctx._texCube[ctx._activeUnit];
  return undefined;
}
function tex3DTarget(ctx: Ctx, target: number): WebGLTexture | null | undefined {
  if (!ctx._v2) return undefined;
  if (target === E.TEXTURE_3D) return ctx._tex3D[ctx._activeUnit];
  if (target === E.TEXTURE_2D_ARRAY) return ctx._tex2DArray[ctx._activeUnit];
  return undefined;
}
/** Texture bound to a bind target (2D, cube, 3D, 2D array). */
export function boundTexture(ctx: Ctx, target: number): WebGLTexture | null | undefined {
  const u = ctx._activeUnit;
  switch (target) {
    case E.TEXTURE_2D:
      return ctx._tex2D[u];
    case E.TEXTURE_CUBE_MAP:
      return ctx._texCube[u];
  }
  if (!ctx._v2) return undefined;
  if (target === E.TEXTURE_3D) return ctx._tex3D[u];
  if (target === E.TEXTURE_2D_ARRAY) return ctx._tex2DArray[u];
  return undefined;
}

let zeroBuffer = new Uint8Array(0);
function zeros(bytes: number): Uint8Array {
  if (zeroBuffer.length < bytes) zeroBuffer = new Uint8Array(Math.max(bytes, zeroBuffer.length * 2));
  return zeroBuffer;
}

/** Set the unpack state to tight packing for an internal upload; returns a restore function's data. */
function withTightUnpack(ctx: Ctx, fn: () => void): void {
  const n = ctx._n;
  const p = ctx._ps;
  const changed =
    p[PS_UNPACK_ALIGNMENT] !== 1 ||
    p[PS_UNPACK_ROW_LENGTH] !== 0 ||
    p[PS_UNPACK_IMAGE_HEIGHT] !== 0 ||
    p[PS_UNPACK_SKIP_PIXELS] !== 0 ||
    p[PS_UNPACK_SKIP_ROWS] !== 0 ||
    p[PS_UNPACK_SKIP_IMAGES] !== 0;
  const pbo = ctx._pixelUnpack;
  if (changed) {
    n.pixelStorei(E.UNPACK_ALIGNMENT, 1);
    if (ctx._v2) {
      n.pixelStorei(E.UNPACK_ROW_LENGTH, 0);
      n.pixelStorei(E.UNPACK_IMAGE_HEIGHT, 0);
      n.pixelStorei(E.UNPACK_SKIP_PIXELS, 0);
      n.pixelStorei(E.UNPACK_SKIP_ROWS, 0);
      n.pixelStorei(E.UNPACK_SKIP_IMAGES, 0);
    }
  }
  if (pbo) n.bindBuffer(E.PIXEL_UNPACK_BUFFER, 0);
  try {
    fn();
  } finally {
    if (changed) {
      n.pixelStorei(E.UNPACK_ALIGNMENT, p[PS_UNPACK_ALIGNMENT]);
      if (ctx._v2) {
        n.pixelStorei(E.UNPACK_ROW_LENGTH, p[PS_UNPACK_ROW_LENGTH]);
        n.pixelStorei(E.UNPACK_IMAGE_HEIGHT, p[PS_UNPACK_IMAGE_HEIGHT]);
        n.pixelStorei(E.UNPACK_SKIP_PIXELS, p[PS_UNPACK_SKIP_PIXELS]);
        n.pixelStorei(E.UNPACK_SKIP_ROWS, p[PS_UNPACK_SKIP_ROWS]);
        n.pixelStorei(E.UNPACK_SKIP_IMAGES, p[PS_UNPACK_SKIP_IMAGES]);
      }
    }
    if (pbo) n.bindBuffer(E.PIXEL_UNPACK_BUFFER, pbo._name);
  }
}

/**
 * GL-16: flip rows and/or premultiply a client-side ArrayBufferView upload (2D only). Returns a new tightly
 * packed copy (the source is never modified) or null if no transform is needed / supported.
 */
function transformClientPixels(
  ctx: Ctx,
  view: ArrayBufferView,
  byteOff: number,
  width: number,
  height: number,
  format: number,
  type: number,
): Uint8Array | null {
  if (!ctx._flipY && !ctx._premultiply) return null;
  const bpp = bytesPerPixel(format, type);
  const s = unpackStore(ctx);
  const rowPixels = s.rowLength > 0 ? s.rowLength : width;
  const rowBytes = Math.ceil((rowPixels * bpp) / s.alignment) * s.alignment;
  const src = new Uint8Array(view.buffer, view.byteOffset + byteOff);
  const out = new Uint8Array(width * height * bpp);
  const tight = width * bpp;
  for (let y = 0; y < height; y++) {
    const sy = ctx._flipY ? height - 1 - y : y;
    const so = (s.skipRows + sy) * rowBytes + s.skipPixels * bpp;
    out.set(src.subarray(so, so + tight), y * tight);
  }
  if (ctx._premultiply) premultiplyInPlace(out, format, type);
  return out;
}

function premultiplyInPlace(px: Uint8Array, format: number, type: number): void {
  if (type === E.UNSIGNED_BYTE && (format === E.RGBA || format === E.SRGB_ALPHA_EXT)) {
    for (let i = 0; i < px.length; i += 4) {
      const a = px[i + 3];
      px[i] = Math.round((px[i] * a) / 255);
      px[i + 1] = Math.round((px[i + 1] * a) / 255);
      px[i + 2] = Math.round((px[i + 2] * a) / 255);
    }
  } else if (type === E.UNSIGNED_BYTE && format === E.LUMINANCE_ALPHA) {
    for (let i = 0; i < px.length; i += 2) px[i] = Math.round((px[i] * px[i + 1]) / 255);
  } else if (type === E.UNSIGNED_SHORT_4_4_4_4 && format === E.RGBA) {
    const u = new Uint16Array(px.buffer, px.byteOffset, px.length >> 1);
    for (let i = 0; i < u.length; i++) {
      const v = u[i];
      const a = v & 0xf;
      const m = (c: number): number => Math.round((c * a) / 15);
      u[i] = (m((v >> 12) & 0xf) << 12) | (m((v >> 8) & 0xf) << 8) | (m((v >> 4) & 0xf) << 4) | a;
    }
  } else if (type === E.UNSIGNED_SHORT_5_5_5_1 && format === E.RGBA) {
    const u = new Uint16Array(px.buffer, px.byteOffset, px.length >> 1);
    for (let i = 0; i < u.length; i++) if ((u[i] & 1) === 0) u[i] = 0;
  } else if (type === E.FLOAT && format === E.RGBA) {
    const f = new Float32Array(px.buffer, px.byteOffset, px.length >> 2);
    for (let i = 0; i < f.length; i += 4) {
      f[i] *= f[i + 3];
      f[i + 1] *= f[i + 3];
      f[i + 2] *= f[i + 3];
    }
  }
}

function recordLevel(ctx: Ctx, tex: WebGLTexture, level: number, internalformat: number, w: number, h: number, d: number): void {
  const info = { internalformat, width: w, height: h, depth: d };
  ctx._texDirty = true;
  if (!ctx._texRiskSeen && (textureKind(internalformat) !== TK_FLOAT || isFloat32Format(internalformat) || (!ctx._v2 && ((w & (w - 1)) !== 0 || (h & (h - 1)) !== 0)))) {
    ctx._texRiskSeen = true;
  }
  tex._levels.set(level, info);
  if (level === 0) tex._level0 = info;
  if (tex._attachCount > 0) ctx._fbEpoch++; // an attached image changed: completeness may have too
}

function recordStorage(ctx: Ctx, tex: WebGLTexture, target: number, levels: number, internalformat: number, w: number, h: number, d: number): void {
  for (let l = 0; l < levels; l++) {
    recordLevel(ctx, tex, l, internalformat, Math.max(1, w >> l), Math.max(1, h >> l), target === E.TEXTURE_3D ? Math.max(1, d >> l) : d);
  }
}

function markAttachmentsDirty(ctx: Ctx, tex: WebGLTexture): void {
  if (tex._attachCount > 0) {
    ctx._feedbackDirty = true; ctx._texDirty = true;
    ctx._fbEpoch++; // an attached image changed: framebuffer completeness may have too
  }
}

export const textureMethods = {
  createTexture(this: Ctx): WebGLTexture | null {
    if (this._skip()) return null;
    const t = new WebGLTexture(INTERNAL, this, this._n.genTexture());
    this._track(t);
    return t;
  },
  isTexture(this: Ctx, texture: unknown): boolean {
    if (this._lost || texture === null || texture === undefined) return false;
    if (!(texture instanceof WebGLTexture)) throw new TypeError('isTexture: argument is not a WebGLTexture');
    return texture._ctx === this && texture._gen === this._gen && !texture._deleted && texture._bound;
  },
  deleteTexture(this: Ctx, texture: unknown): void {
    if (this._skip()) return;
    if (!this._owned(texture, WebGLTexture, 'deleteTexture')) return;
    const t = texture as WebGLTexture;
    if (t._deleted) return;
    t._deleted = true;
    for (const list of [this._tex2D, this._texCube, this._tex3D, this._tex2DArray]) {
      for (let i = 0; i < list.length; i++) if (list[i] === t) list[i] = null;
    }
    // GLES: detached from the currently bound framebuffers
    this._detachFromBound(t);
    this._untrack(t);
    if (!t._external) this._n.deleteTexture(t._name);
    this._hostHooks?.onDelete?.(t);
  },
  bindTexture(this: Ctx, target: number, texture: WebGLTexture | null): void {
    if (this._skip()) return;
    target >>>= 0;
    if (!this._ok(texture, WebGLTexture, true, 'bindTexture')) return;
    const u = this._activeUnit;
    let list: (WebGLTexture | null)[];
    switch (target) {
      case E.TEXTURE_2D:
        list = this._tex2D;
        break;
      case E.TEXTURE_CUBE_MAP:
        list = this._texCube;
        break;
      case E.TEXTURE_3D:
        if (!this._v2) return this._e(E.INVALID_ENUM, 'bindTexture');
        list = this._tex3D;
        break;
      case E.TEXTURE_2D_ARRAY:
        if (!this._v2) return this._e(E.INVALID_ENUM, 'bindTexture');
        list = this._tex2DArray;
        break;
      default:
        return this._e(E.INVALID_ENUM, 'bindTexture');
    }
    const t = texture ?? null;
    const prev = list[u];
    if (prev === t) return;
    if (t !== null) {
      if (t._target !== 0 && t._target !== target) return this._e(E.INVALID_OPERATION, 'bindTexture');
      t._target = target;
      t._bound = true;
      if (t._attachCount > 0) this._feedbackDirty = true; this._texDirty = true;
    }
    if (prev !== null && prev._attachCount > 0) this._feedbackDirty = true; this._texDirty = true;
    list[u] = t;
    this._texDirty = true;
    this._n.bindTexture(target, t ? t._name : 0);
  },
  texParameterf(this: Ctx, target: number, pname: number, param: number): void {
    texParameter(this, target >>> 0, pname >>> 0, +param, true);
  },
  texParameteri(this: Ctx, target: number, pname: number, param: number): void {
    texParameter(this, target >>> 0, pname >>> 0, param | 0, false);
  },
  getTexParameter(this: Ctx, target: number, pname: number): unknown {
    if (this._skip()) return null;
    target >>>= 0;
    pname >>>= 0;
    const t = boundTexture(this, target);
    if (t === undefined) {
      this._e(E.INVALID_ENUM, 'getTexParameter');
      return null;
    }
    if (t === null) {
      this._e(E.INVALID_OPERATION, 'getTexParameter');
      return null;
    }
    switch (pname) {
      case E.TEXTURE_MAG_FILTER:
      case E.TEXTURE_MIN_FILTER:
      case E.TEXTURE_WRAP_S:
      case E.TEXTURE_WRAP_T:
        break;
      case E.TEXTURE_MAX_ANISOTROPY_EXT:
        if (!this._extensions.has('EXT_texture_filter_anisotropic')) {
          this._e(E.INVALID_ENUM, 'getTexParameter');
          return null;
        }
        this._n.getTexParameterfv(target, pname, this._f32, 0, 4);
        return this._f32[0];
      case E.TEXTURE_IMMUTABLE_FORMAT:
        if (!this._v2) break;
        return t._immutable;
      case E.TEXTURE_IMMUTABLE_LEVELS:
        if (!this._v2) break;
        return t._immutable ? t._immutableLevels : 0;
      case E.TEXTURE_BASE_LEVEL:
        if (!this._v2) break;
        return t._baseLevel;
      case E.TEXTURE_MAX_LEVEL:
        if (!this._v2) break;
        return t._maxLevel;
      case E.TEXTURE_MIN_LOD:
      case E.TEXTURE_MAX_LOD:
        if (!this._v2) break;
        this._n.getTexParameterfv(target, pname, this._f32, 0, 4);
        return this._f32[0];
      case E.TEXTURE_WRAP_R:
      case E.TEXTURE_COMPARE_FUNC:
      case E.TEXTURE_COMPARE_MODE:
        if (!this._v2) break;
        break;
      default:
        this._e(E.INVALID_ENUM, 'getTexParameter');
        return null;
    }
    if (!this._v2 && (pname === E.TEXTURE_IMMUTABLE_FORMAT || pname === E.TEXTURE_BASE_LEVEL || pname === E.TEXTURE_MAX_LEVEL || pname === E.TEXTURE_MIN_LOD || pname === E.TEXTURE_MAX_LOD || pname === E.TEXTURE_IMMUTABLE_LEVELS || pname === E.TEXTURE_WRAP_R || pname === E.TEXTURE_COMPARE_FUNC || pname === E.TEXTURE_COMPARE_MODE)) {
      this._e(E.INVALID_ENUM, 'getTexParameter');
      return null;
    }
    this._n.getTexParameteriv(target, pname, this._i32, 0, 4);
    return this._i32[0];
  },
  generateMipmap(this: Ctx, target: number): void {
    if (this._skip()) return;
    target >>>= 0;
    const t = boundTexture(this, target);
    if (t === undefined) return this._e(E.INVALID_ENUM, 'generateMipmap');
    if (t === null) return this._e(E.INVALID_OPERATION, 'generateMipmap');
    // GLES 3.0 §3.8.10 + WebGL: level 0 must exist, be non-empty, and be colour-renderable and filterable.
    // WebGL 2 builds from TEXTURE_BASE_LEVEL (clamped to the immutable levels, GLES 3.0 §3.8.10)
    const base = !this._v2 ? 0 : t._immutable ? Math.min(t._baseLevel, t._immutableLevels - 1) : t._baseLevel;
    const l0 = t._levels.get(base) ?? null;
    const pow2 = (v: number): boolean => (v & (v - 1)) === 0;
    if (!l0 || l0.width === 0 || l0.height === 0 || !mipmappable(this, l0.internalformat) || (!this._v2 && (!pow2(l0.width) || !pow2(l0.height)))) {
      return this._e(E.INVALID_OPERATION, 'generateMipmap');
    }
    this._n.generateMipmap(target);
    // Record the levels it defined (base+1 .. min(q, MAX_LEVEL)), so framebuffer completeness and sampling
    // checks see them; attached levels changed, so cached completeness is stale.
    if (!t._immutable) {
      const is3D = target === E.TEXTURE_3D;
      const top = base + Math.floor(Math.log2(Math.max(l0.width, l0.height, is3D ? l0.depth : 1)));
      const last = Math.min(top, t._maxLevel);
      for (let l = base + 1; l <= last; l++) {
        const k = l - base;
        recordLevel(this, t, l, l0.internalformat, Math.max(1, l0.width >> k), Math.max(1, l0.height >> k), is3D ? Math.max(1, l0.depth >> k) : l0.depth);
      }
    }
    markAttachmentsDirty(this, t);
  },

  texImage2D(this: Ctx, ...a: unknown[]): void {
    if (a.length < 6) throw new TypeError('texImage2D: not enough arguments');
    if (this._skip()) return;
    const target = (a[0] as number) >>> 0;
    const level = (a[1] as number) | 0;
    const internalformat = (a[2] as number) | 0;
    if (a.length === 6) {
      // (target, level, internalformat, format, type, source)
      return texFromSource(this, false, target, level, internalformat, 0, 0, 0, -1, -1, 1, (a[3] as number) >>> 0, (a[4] as number) >>> 0, a[5], 'texImage2D');
    }
    if (a.length < 9) throw new TypeError(`texImage2D: ${a.length} arguments is not a valid overload`);
    const width = (a[3] as number) | 0;
    const height = (a[4] as number) | 0;
    const border = (a[5] as number) | 0;
    const format = (a[6] as number) >>> 0;
    const type = (a[7] as number) >>> 0;
    const data = a[8];
    const tex = tex2DTarget(this, target);
    if (tex === undefined) return this._e(E.INVALID_ENUM, 'texImage2D');
    if (tex === null) return this._e(E.INVALID_OPERATION, 'texImage2D');
    if (tex._immutable) return this._e(E.INVALID_OPERATION, 'texImage2D');
    if (level < 0 || width < 0 || height < 0 || border !== 0) return this._e(E.INVALID_VALUE, 'texImage2D');
    if (isCubeFace(target) && width !== height) return this._e(E.INVALID_VALUE, 'texImage2D');
    if (typeof data === 'number' || (this._v2 && offsetOverload(data))) {
      // PIXEL_UNPACK_BUFFER offset
      if (!this._v2) throw new TypeError('texImage2D: invalid overload');
      return uploadFromPbo(this, tex, target, level, internalformat, width, height, 1, border, format, type, pboOffset(data), false, false, 'texImage2D');
    }
    if (data !== null && data !== undefined && !isView(data)) {
      if (!this._v2) throw new TypeError('texImage2D: pixels is not an ArrayBufferView');
      return texFromSource(this, false, target, level, internalformat, 0, 0, 0, width, height, 1, format, type, data, 'texImage2D');
    }
    const srcOffset = a.length > 9 ? (a[9] as number) >>> 0 : 0;
    uploadFromView(this, tex, target, level, internalformat, 0, 0, 0, width, height, 1, format, type, (data as ArrayBufferView | null) ?? null, srcOffset, false, false, 'texImage2D');
  },
  texSubImage2D(this: Ctx, ...a: unknown[]): void {
    if (a.length < 7) throw new TypeError('texSubImage2D: not enough arguments');
    if (this._skip()) return;
    const target = (a[0] as number) >>> 0;
    const level = (a[1] as number) | 0;
    const xoff = (a[2] as number) | 0;
    const yoff = (a[3] as number) | 0;
    if (a.length === 7) {
      return texFromSource(this, true, target, level, 0, xoff, yoff, 0, -1, -1, 1, (a[4] as number) >>> 0, (a[5] as number) >>> 0, a[6], 'texSubImage2D');
    }
    if (a.length < 9) throw new TypeError(`texSubImage2D: ${a.length} arguments is not a valid overload`);
    const width = (a[4] as number) | 0;
    const height = (a[5] as number) | 0;
    const format = (a[6] as number) >>> 0;
    const type = (a[7] as number) >>> 0;
    const data = a[8];
    const tex = tex2DTarget(this, target);
    if (tex === undefined) return this._e(E.INVALID_ENUM, 'texSubImage2D');
    if (tex === null) return this._e(E.INVALID_OPERATION, 'texSubImage2D');
    if (level < 0 || width < 0 || height < 0 || xoff < 0 || yoff < 0) return this._e(E.INVALID_VALUE, 'texSubImage2D');
    if (typeof data === 'number' || (this._v2 && offsetOverload(data))) {
      if (!this._v2) throw new TypeError('texSubImage2D: invalid overload');
      return uploadFromPbo(this, tex, target, level, 0, width, height, 1, 0, format, type, pboOffset(data), true, false, 'texSubImage2D', xoff, yoff, 0);
    }
    if (data === null || data === undefined) {
      if (!this._v2) return this._e(E.INVALID_VALUE, 'texSubImage2D');
      throw new TypeError('texSubImage2D: pixels is null');
    }
    if (!isView(data)) {
      if (!this._v2) throw new TypeError('texSubImage2D: pixels is not an ArrayBufferView');
      return texFromSource(this, true, target, level, 0, xoff, yoff, 0, width, height, 1, format, type, data, 'texSubImage2D');
    }
    const srcOffset = a.length > 9 ? (a[9] as number) >>> 0 : 0;
    uploadFromView(this, tex, target, level, 0, xoff, yoff, 0, width, height, 1, format, type, data, srcOffset, true, false, 'texSubImage2D');
  },
  texImage3D(this: Ctx, ...a: unknown[]): void {
    if (this._skip()) return;
    if (a.length < 10) throw new TypeError(`texImage3D: ${a.length} arguments is not a valid overload`);
    const target = (a[0] as number) >>> 0;
    const level = (a[1] as number) | 0;
    const internalformat = (a[2] as number) | 0;
    const width = (a[3] as number) | 0;
    const height = (a[4] as number) | 0;
    const depth = (a[5] as number) | 0;
    const border = (a[6] as number) | 0;
    const format = (a[7] as number) >>> 0;
    const type = (a[8] as number) >>> 0;
    const data = a[9];
    const tex = tex3DTarget(this, target);
    if (tex === undefined) return this._e(E.INVALID_ENUM, 'texImage3D');
    if (tex === null) return this._e(E.INVALID_OPERATION, 'texImage3D');
    if (tex._immutable) return this._e(E.INVALID_OPERATION, 'texImage3D');
    if (level < 0 || width < 0 || height < 0 || depth < 0 || border !== 0) return this._e(E.INVALID_VALUE, 'texImage3D');
    if (typeof data === 'number' || offsetOverload(data)) {
      return uploadFromPbo(this, tex, target, level, internalformat, width, height, depth, border, format, type, pboOffset(data), false, true, 'texImage3D');
    }
    if (data !== null && data !== undefined && !isView(data)) {
      return texFromSource(this, false, target, level, internalformat, 0, 0, 0, width, height, depth, format, type, data, 'texImage3D');
    }
    const srcOffset = a.length > 10 ? (a[10] as number) >>> 0 : 0;
    uploadFromView(this, tex, target, level, internalformat, 0, 0, 0, width, height, depth, format, type, (data as ArrayBufferView | null) ?? null, srcOffset, false, true, 'texImage3D');
  },
  texSubImage3D(this: Ctx, ...a: unknown[]): void {
    if (this._skip()) return;
    if (a.length < 11) throw new TypeError(`texSubImage3D: ${a.length} arguments is not a valid overload`);
    const target = (a[0] as number) >>> 0;
    const level = (a[1] as number) | 0;
    const xoff = (a[2] as number) | 0;
    const yoff = (a[3] as number) | 0;
    const zoff = (a[4] as number) | 0;
    const width = (a[5] as number) | 0;
    const height = (a[6] as number) | 0;
    const depth = (a[7] as number) | 0;
    const format = (a[8] as number) >>> 0;
    const type = (a[9] as number) >>> 0;
    const data = a[10];
    const tex = tex3DTarget(this, target);
    if (tex === undefined) return this._e(E.INVALID_ENUM, 'texSubImage3D');
    if (tex === null) return this._e(E.INVALID_OPERATION, 'texSubImage3D');
    if (level < 0 || width < 0 || height < 0 || depth < 0 || xoff < 0 || yoff < 0 || zoff < 0) {
      return this._e(E.INVALID_VALUE, 'texSubImage3D');
    }
    if (typeof data === 'number' || offsetOverload(data)) {
      return uploadFromPbo(this, tex, target, level, 0, width, height, depth, 0, format, type, pboOffset(data), true, true, 'texSubImage3D', xoff, yoff, zoff);
    }
    if (data === null || data === undefined) throw new TypeError('texSubImage3D: pixels is null');
    if (!isView(data)) {
      return texFromSource(this, true, target, level, 0, xoff, yoff, zoff, width, height, depth, format, type, data, 'texSubImage3D');
    }
    const srcOffset = a.length > 11 ? (a[11] as number) >>> 0 : 0;
    uploadFromView(this, tex, target, level, 0, xoff, yoff, zoff, width, height, depth, format, type, data, srcOffset, true, true, 'texSubImage3D');
  },
  texStorage2D(this: Ctx, target: number, levels: number, internalformat: number, width: number, height: number): void {
    if (this._skip()) return;
    target >>>= 0;
    levels |= 0;
    internalformat >>>= 0;
    width |= 0;
    height |= 0;
    if (target !== E.TEXTURE_2D && target !== E.TEXTURE_CUBE_MAP) return this._e(E.INVALID_ENUM, 'texStorage2D');
    const tex = boundTexture(this, target) ?? null;
    if (tex === null) return this._e(E.INVALID_OPERATION, 'texStorage2D');
    if (tex._immutable) return this._e(E.INVALID_OPERATION, 'texStorage2D');
    if (levels < 1 || width < 1 || height < 1) return this._e(E.INVALID_VALUE, 'texStorage2D');
    if (levels > Math.floor(Math.log2(Math.max(width, height))) + 1) return this._e(E.INVALID_OPERATION, 'texStorage2D');
    if (!storageFormatOk(this, internalformat)) return this._e(E.INVALID_ENUM, 'texStorage2D');
    this._n.texStorage2D(target, levels, internalformat, width, height);
    tex._immutable = true;
    tex._immutableLevels = levels;
    recordStorage(this, tex, target, levels, internalformat, width, height, 1);
    zeroStorage(this, tex, target, levels, internalformat, width, height, 1);
  },
  texStorage3D(this: Ctx, target: number, levels: number, internalformat: number, width: number, height: number, depth: number): void {
    if (this._skip()) return;
    target >>>= 0;
    levels |= 0;
    internalformat >>>= 0;
    width |= 0;
    height |= 0;
    depth |= 0;
    if (target !== E.TEXTURE_3D && target !== E.TEXTURE_2D_ARRAY) return this._e(E.INVALID_ENUM, 'texStorage3D');
    const tex = boundTexture(this, target) ?? null;
    if (tex === null) return this._e(E.INVALID_OPERATION, 'texStorage3D');
    if (tex._immutable) return this._e(E.INVALID_OPERATION, 'texStorage3D');
    if (levels < 1 || width < 1 || height < 1 || depth < 1) return this._e(E.INVALID_VALUE, 'texStorage3D');
    const maxDim = target === E.TEXTURE_3D ? Math.max(width, height, depth) : Math.max(width, height);
    if (levels > Math.floor(Math.log2(maxDim)) + 1) return this._e(E.INVALID_OPERATION, 'texStorage3D');
    if (!storageFormatOk(this, internalformat)) return this._e(E.INVALID_ENUM, 'texStorage3D');
    // compressed 3D textures: ASTC only (sliced 3D / HDR); ETC2, S3TC, RGTC, BPTC are 2D-array only
    const cf = COMPRESSED_FORMATS[internalformat];
    if (cf && target === E.TEXTURE_3D && cf[3] !== 'WEBGL_compressed_texture_astc') return this._e(E.INVALID_OPERATION, 'texStorage3D');
    this._n.texStorage3D(target, levels, internalformat, width, height, depth);
    tex._immutable = true;
    tex._immutableLevels = levels;
    recordStorage(this, tex, target, levels, internalformat, width, height, depth);
    zeroStorage(this, tex, target, levels, internalformat, width, height, depth);
  },
  compressedTexImage2D(this: Ctx, ...a: unknown[]): void {
    if (a.length < 7) throw new TypeError('compressedTexImage2D: not enough arguments');
    if (this._skip()) return;
    const target = (a[0] as number) >>> 0;
    const level = (a[1] as number) | 0;
    const internalformat = (a[2] as number) >>> 0;
    const width = (a[3] as number) | 0;
    const height = (a[4] as number) | 0;
    const border = (a[5] as number) | 0;
    const tex = tex2DTarget(this, target);
    if (tex === undefined) return this._e(E.INVALID_ENUM, 'compressedTexImage2D');
    if (tex === null || tex._immutable) return this._e(E.INVALID_OPERATION, 'compressedTexImage2D');
    if (!compressedOk(this, internalformat)) return this._e(E.INVALID_ENUM, 'compressedTexImage2D');
    if (level < 0 || width < 0 || height < 0 || border !== 0) return this._e(E.INVALID_VALUE, 'compressedTexImage2D');
    const expected = compressedByteSize(internalformat, width, height, 1);
    if (typeof a[6] === 'number' && typeof a[7] === 'number' && this._v2) {
      // (imageSize, offset) from PIXEL_UNPACK_BUFFER
      if (!this._pixelUnpack) return this._e(E.INVALID_OPERATION, 'compressedTexImage2D');
      const imageSize = (a[6] as number) | 0;
      if (imageSize !== expected) return this._e(E.INVALID_VALUE, 'compressedTexImage2D');
      this._n.compressedTexImage2DOffset(target, level, internalformat, width, height, 0, imageSize, a[7] as number);
      recordLevel(this, tex, level, internalformat, width, height, 1);
      return;
    }
    if (this._pixelUnpack) return this._e(E.INVALID_OPERATION, 'compressedTexImage2D');
    const view = a[6];
    if (!isView(view)) throw new TypeError('compressedTexImage2D: data is not an ArrayBufferView');
    if (!viewRange(this, view, a.length > 7 ? (a[7] as number) >>> 0 : 0, a.length > 8 ? (a[8] as number) >>> 0 : 0, 'compressedTexImage2D')) return;
    if (range.bytes !== expected) return this._e(E.INVALID_VALUE, 'compressedTexImage2D');
    this._n.compressedTexImage2D(target, level, internalformat, width, height, 0, range.bytes, view, range.off, range.bytes);
    recordLevel(this, tex, level, internalformat, width, height, 1);
  },
  compressedTexSubImage2D(this: Ctx, ...a: unknown[]): void {
    if (a.length < 8) throw new TypeError('compressedTexSubImage2D: not enough arguments');
    if (this._skip()) return;
    const target = (a[0] as number) >>> 0;
    const level = (a[1] as number) | 0;
    const xoff = (a[2] as number) | 0;
    const yoff = (a[3] as number) | 0;
    const width = (a[4] as number) | 0;
    const height = (a[5] as number) | 0;
    const format = (a[6] as number) >>> 0;
    const tex = tex2DTarget(this, target);
    if (tex === undefined) return this._e(E.INVALID_ENUM, 'compressedTexSubImage2D');
    if (tex === null) return this._e(E.INVALID_OPERATION, 'compressedTexSubImage2D');
    if (!compressedOk(this, format)) return this._e(E.INVALID_ENUM, 'compressedTexSubImage2D');
    if (format === E.COMPRESSED_RGB_ETC1_WEBGL) return this._e(E.INVALID_OPERATION, 'compressedTexSubImage2D'); // no sub-images
    if (level < 0 || width < 0 || height < 0 || xoff < 0 || yoff < 0) return this._e(E.INVALID_VALUE, 'compressedTexSubImage2D');
    const expected = compressedByteSize(format, width, height, 1);
    if (typeof a[7] === 'number' && typeof a[8] === 'number' && this._v2) {
      if (!this._pixelUnpack) return this._e(E.INVALID_OPERATION, 'compressedTexSubImage2D');
      const imageSize = (a[7] as number) | 0;
      if (imageSize !== expected) return this._e(E.INVALID_VALUE, 'compressedTexSubImage2D');
      this._n.compressedTexSubImage2DOffset(target, level, xoff, yoff, width, height, format, imageSize, a[8] as number);
      return;
    }
    if (this._pixelUnpack) return this._e(E.INVALID_OPERATION, 'compressedTexSubImage2D');
    const view = a[7];
    if (!isView(view)) throw new TypeError('compressedTexSubImage2D: data is not an ArrayBufferView');
    if (!viewRange(this, view, a.length > 8 ? (a[8] as number) >>> 0 : 0, a.length > 9 ? (a[9] as number) >>> 0 : 0, 'compressedTexSubImage2D')) return;
    if (range.bytes !== expected) return this._e(E.INVALID_VALUE, 'compressedTexSubImage2D');
    this._n.compressedTexSubImage2D(target, level, xoff, yoff, width, height, format, range.bytes, view, range.off, range.bytes);
  },
  compressedTexImage3D(this: Ctx, ...a: unknown[]): void {
    if (a.length < 8) throw new TypeError('compressedTexImage3D: not enough arguments');
    if (this._skip()) return;
    const target = (a[0] as number) >>> 0;
    const level = (a[1] as number) | 0;
    const internalformat = (a[2] as number) >>> 0;
    const width = (a[3] as number) | 0;
    const height = (a[4] as number) | 0;
    const depth = (a[5] as number) | 0;
    const border = (a[6] as number) | 0;
    const tex = tex3DTarget(this, target);
    if (tex === undefined) return this._e(E.INVALID_ENUM, 'compressedTexImage3D');
    if (tex === null || tex._immutable) return this._e(E.INVALID_OPERATION, 'compressedTexImage3D');
    if (!compressedOk(this, internalformat)) return this._e(E.INVALID_ENUM, 'compressedTexImage3D');
    if (level < 0 || width < 0 || height < 0 || depth < 0 || border !== 0) return this._e(E.INVALID_VALUE, 'compressedTexImage3D');
    const expected = compressedByteSize(internalformat, width, height, depth);
    if (typeof a[7] === 'number' && typeof a[8] === 'number') {
      if (!this._pixelUnpack) return this._e(E.INVALID_OPERATION, 'compressedTexImage3D');
      const imageSize = (a[7] as number) | 0;
      if (imageSize !== expected) return this._e(E.INVALID_VALUE, 'compressedTexImage3D');
      this._n.compressedTexImage3DOffset(target, level, internalformat, width, height, depth, 0, imageSize, a[8] as number);
      recordLevel(this, tex, level, internalformat, width, height, depth);
      return;
    }
    if (this._pixelUnpack) return this._e(E.INVALID_OPERATION, 'compressedTexImage3D');
    const view = a[7];
    if (!isView(view)) throw new TypeError('compressedTexImage3D: data is not an ArrayBufferView');
    if (!viewRange(this, view, a.length > 8 ? (a[8] as number) >>> 0 : 0, a.length > 9 ? (a[9] as number) >>> 0 : 0, 'compressedTexImage3D')) return;
    if (range.bytes !== expected) return this._e(E.INVALID_VALUE, 'compressedTexImage3D');
    this._n.compressedTexImage3D(target, level, internalformat, width, height, depth, 0, range.bytes, view, range.off, range.bytes);
    recordLevel(this, tex, level, internalformat, width, height, depth);
  },
  compressedTexSubImage3D(this: Ctx, ...a: unknown[]): void {
    if (a.length < 10) throw new TypeError('compressedTexSubImage3D: not enough arguments');
    if (this._skip()) return;
    const target = (a[0] as number) >>> 0;
    const level = (a[1] as number) | 0;
    const xoff = (a[2] as number) | 0;
    const yoff = (a[3] as number) | 0;
    const zoff = (a[4] as number) | 0;
    const width = (a[5] as number) | 0;
    const height = (a[6] as number) | 0;
    const depth = (a[7] as number) | 0;
    const format = (a[8] as number) >>> 0;
    const tex = tex3DTarget(this, target);
    if (tex === undefined) return this._e(E.INVALID_ENUM, 'compressedTexSubImage3D');
    if (tex === null) return this._e(E.INVALID_OPERATION, 'compressedTexSubImage3D');
    if (!compressedOk(this, format)) return this._e(E.INVALID_ENUM, 'compressedTexSubImage3D');
    if (level < 0 || width < 0 || height < 0 || depth < 0 || xoff < 0 || yoff < 0 || zoff < 0) {
      return this._e(E.INVALID_VALUE, 'compressedTexSubImage3D');
    }
    const expected = compressedByteSize(format, width, height, depth);
    if (typeof a[9] === 'number' && typeof a[10] === 'number') {
      if (!this._pixelUnpack) return this._e(E.INVALID_OPERATION, 'compressedTexSubImage3D');
      const imageSize = (a[9] as number) | 0;
      if (imageSize !== expected) return this._e(E.INVALID_VALUE, 'compressedTexSubImage3D');
      this._n.compressedTexSubImage3DOffset(target, level, xoff, yoff, zoff, width, height, depth, format, imageSize, a[10] as number);
      return;
    }
    if (this._pixelUnpack) return this._e(E.INVALID_OPERATION, 'compressedTexSubImage3D');
    const view = a[9];
    if (!isView(view)) throw new TypeError('compressedTexSubImage3D: data is not an ArrayBufferView');
    if (!viewRange(this, view, a.length > 10 ? (a[10] as number) >>> 0 : 0, a.length > 11 ? (a[11] as number) >>> 0 : 0, 'compressedTexSubImage3D')) return;
    if (range.bytes !== expected) return this._e(E.INVALID_VALUE, 'compressedTexSubImage3D');
    this._n.compressedTexSubImage3D(target, level, xoff, yoff, zoff, width, height, depth, format, range.bytes, view, range.off, range.bytes);
  },
  copyTexImage2D(this: Ctx, target: number, level: number, internalformat: number, x: number, y: number, width: number, height: number, border: number): void {
    if (this._skip()) return;
    target >>>= 0;
    level |= 0;
    internalformat >>>= 0;
    x |= 0;
    y |= 0;
    width |= 0;
    height |= 0;
    border |= 0;
    const tex = tex2DTarget(this, target);
    if (tex === undefined) return this._e(E.INVALID_ENUM, 'copyTexImage2D');
    if (tex === null || tex._immutable) return this._e(E.INVALID_OPERATION, 'copyTexImage2D');
    if (level < 0 || width < 0 || height < 0 || border !== 0) return this._e(E.INVALID_VALUE, 'copyTexImage2D');
    if (this._readFbo && framebufferVerdict(this, this._readFbo, E.READ_FRAMEBUFFER)) return this._e(E.INVALID_FRAMEBUFFER_OPERATION, 'copyTexImage2D');
    const cerr = copyFormatError(this, internalformat);
    if (cerr) return this._e(cerr, 'copyTexImage2D');
    if (this._readFeedback(tex, level) || missingReadImage(this)) return this._e(E.INVALID_OPERATION, 'copyTexImage2D');
    const restore = this._prepareDefaultRead();
    const [rw, rh] = this._readSize();
    if (x >= 0 && y >= 0 && x + width <= rw && y + height <= rh) {
      this._n.copyTexImage2D(target, level, internalformat, x, y, width, height, 0);
    } else {
      // Pixels outside the read framebuffer are zero (WebGL 1.0 §5.13.?): allocate cleared, copy the overlap.
      this._n.copyTexImage2D(target, level, internalformat, 0, 0, width, height, 0);
      this._n.clearTextureImage(target, tex._name, level, 1, internalformat, width, height, 1);
      copyOverlap(this, target, level, 0, 0, 0, x, y, width, height, rw, rh, false);
    }
    if (restore) this._restoreFramebufferBindings();
    recordLevel(this, tex, level, internalformat, width, height, 1);
  },
  copyTexSubImage2D(this: Ctx, target: number, level: number, xoffset: number, yoffset: number, x: number, y: number, width: number, height: number): void {
    if (this._skip()) return;
    target >>>= 0;
    level |= 0;
    const tex = tex2DTarget(this, target);
    if (tex === undefined) return this._e(E.INVALID_ENUM, 'copyTexSubImage2D');
    if (tex === null) return this._e(E.INVALID_OPERATION, 'copyTexSubImage2D');
    if ((width | 0) < 0 || (height | 0) < 0) return this._e(E.INVALID_VALUE, 'copyTexSubImage2D');
    if (this._readFbo && framebufferVerdict(this, this._readFbo, E.READ_FRAMEBUFFER)) return this._e(E.INVALID_FRAMEBUFFER_OPERATION, 'copyTexSubImage2D');
    if (this._readFeedback(tex, level) || missingReadImage(this)) return this._e(E.INVALID_OPERATION, 'copyTexSubImage2D');
    const dst = tex._levels.get(level);
    if (dst && HAS_ALPHA.has(dst.internalformat) && !READ_HAS_ALPHA.has(readBufferFormat(this))) return this._e(E.INVALID_OPERATION, 'copyTexSubImage2D');
    const restore = this._prepareDefaultRead();
    const [rw, rh] = this._readSize();
    copyOverlap(this, target, level, xoffset | 0, yoffset | 0, 0, x | 0, y | 0, width | 0, height | 0, rw, rh, false);
    if (restore) this._restoreFramebufferBindings();
  },
  copyTexSubImage3D(this: Ctx, target: number, level: number, xoffset: number, yoffset: number, zoffset: number, x: number, y: number, width: number, height: number): void {
    if (this._skip()) return;
    target >>>= 0;
    level |= 0;
    const tex = tex3DTarget(this, target);
    if (tex === undefined) return this._e(E.INVALID_ENUM, 'copyTexSubImage3D');
    if (tex === null) return this._e(E.INVALID_OPERATION, 'copyTexSubImage3D');
    if ((width | 0) < 0 || (height | 0) < 0) return this._e(E.INVALID_VALUE, 'copyTexSubImage3D');
    if (this._readFbo && framebufferVerdict(this, this._readFbo, E.READ_FRAMEBUFFER)) return this._e(E.INVALID_FRAMEBUFFER_OPERATION, 'copyTexSubImage3D');
    if (this._readFeedback(tex, level) || missingReadImage(this)) return this._e(E.INVALID_OPERATION, 'copyTexSubImage3D');
    const dst = tex._levels.get(level);
    if (dst && HAS_ALPHA.has(dst.internalformat) && !READ_HAS_ALPHA.has(readBufferFormat(this))) return this._e(E.INVALID_OPERATION, 'copyTexSubImage3D');
    const restore = this._prepareDefaultRead();
    const [rw, rh] = this._readSize();
    copyOverlap(this, target, level, xoffset | 0, yoffset | 0, zoffset | 0, x | 0, y | 0, width | 0, height | 0, rw, rh, true);
    if (restore) this._restoreFramebufferBindings();
  },
};

const COPY_FORMATS_UNSIZED = new Set([E.RGB, E.RGBA, E.LUMINANCE_ALPHA, E.LUMINANCE, E.ALPHA]);
const COPY_FORMATS_SIZED = new Set([
  E.R8, E.RG8, E.RGB565, E.RGB8, E.RGBA4, E.RGB5_A1, E.RGBA8, E.RGB10_A2, E.SRGB8, E.SRGB8_ALPHA8,
  E.R8I, E.R8UI, E.R16I, E.R16UI, E.R32I, E.R32UI, E.RG8I, E.RG8UI, E.RG16I, E.RG16UI, E.RG32I, E.RG32UI,
  E.RGBA8I, E.RGBA8UI, E.RGBA16I, E.RGBA16UI, E.RGBA32I, E.RGBA32UI, E.RGB10_A2UI,
  E.R16F, E.RG16F, E.RGB16F, E.RGBA16F, E.R32F, E.RG32F, E.RGB32F, E.RGBA32F, E.R11F_G11F_B10F,
]);
const HAS_ALPHA = new Set([E.RGBA, E.LUMINANCE_ALPHA, E.ALPHA, E.RGBA4, E.RGB5_A1, E.RGBA8, E.RGB10_A2, E.SRGB8_ALPHA8, E.RGBA16F, E.RGBA32F]);
const READ_HAS_ALPHA = new Set([E.RGBA, E.RGBA4, E.RGB5_A1, E.RGBA8, E.RGB10_A2, E.SRGB8_ALPHA8, E.RGBA16F, E.RGBA32F, E.RGBA8UI, E.RGBA8I, E.RGBA16UI, E.RGBA16I, E.RGBA32UI, E.RGBA32I, E.RGB10_A2UI]);

/** copyTexImage2D internal format (GLES 3.0 §3.8.5 / WebGL 1): known format, and alpha only from an alpha buffer. */
function copyFormatError(ctx: Ctx, f: number): number {
  if (!COPY_FORMATS_UNSIZED.has(f) && !(ctx._v2 && COPY_FORMATS_SIZED.has(f))) return E.INVALID_ENUM;
  if (HAS_ALPHA.has(f)) {
    const rf = readBufferFormat(ctx);
    if (rf && !READ_HAS_ALPHA.has(rf)) return E.INVALID_OPERATION;
  }
  return 0;
}

function copyOverlap(
  ctx: Ctx,
  target: number,
  level: number,
  xo: number,
  yo: number,
  zo: number,
  x: number,
  y: number,
  w: number,
  h: number,
  rw: number,
  rh: number,
  is3D: boolean,
): void {
  const x0 = Math.max(x, 0);
  const y0 = Math.max(y, 0);
  const x1 = Math.min(x + w, rw);
  const y1 = Math.min(y + h, rh);
  if (x1 <= x0 || y1 <= y0) return;
  if (is3D) ctx._n.copyTexSubImage3D(target, level, xo + (x0 - x), yo + (y0 - y), zo, x0, y0, x1 - x0, y1 - y0);
  else ctx._n.copyTexSubImage2D(target, level, xo + (x0 - x), yo + (y0 - y), x0, y0, x1 - x0, y1 - y0);
}

const MIN_FILTERS = new Set([E.NEAREST, E.LINEAR, E.NEAREST_MIPMAP_NEAREST, E.LINEAR_MIPMAP_NEAREST, E.NEAREST_MIPMAP_LINEAR, E.LINEAR_MIPMAP_LINEAR]);
const COMPARE_FUNCS = new Set([E.LEQUAL, E.GEQUAL, E.LESS, E.GREATER, E.EQUAL, E.NOTEQUAL, E.ALWAYS, E.NEVER]);

/**
 * WebGL texture / sampler parameter validation (WebGL 2.0 §5.? texParameter, samplerParameter): GLES 3.2
 * accepts more (CLAMP_TO_BORDER, TEXTURE_BORDER_COLOR, DEPTH_STENCIL_TEXTURE_MODE, swizzles) than WebGL, so
 * pnames and enum values are checked here. Returns 0 if valid, else the error to record.
 */
export function texParamError(ctx: Ctx, pname: number, param: number, sampler: boolean): number {
  const v = Math.trunc(param);
  switch (pname) {
    case E.TEXTURE_MAG_FILTER:
      return v === E.NEAREST || v === E.LINEAR ? 0 : E.INVALID_ENUM;
    case E.TEXTURE_MIN_FILTER:
      return MIN_FILTERS.has(v) ? 0 : E.INVALID_ENUM;
    case E.TEXTURE_WRAP_S:
    case E.TEXTURE_WRAP_T:
    case E.TEXTURE_WRAP_R:
      if (pname === E.TEXTURE_WRAP_R && !ctx._v2) return E.INVALID_ENUM;
      if (v === E.REPEAT || v === E.CLAMP_TO_EDGE || v === E.MIRRORED_REPEAT) return 0;
      return v === E.MIRROR_CLAMP_TO_EDGE_EXT && ctx._extensions.has('EXT_texture_mirror_clamp_to_edge') ? 0 : E.INVALID_ENUM;
    case E.TEXTURE_MAX_ANISOTROPY_EXT:
      if (!ctx._extensions.has('EXT_texture_filter_anisotropic')) return E.INVALID_ENUM;
      return param >= 1 ? 0 : E.INVALID_VALUE;
  }
  if (!ctx._v2) return E.INVALID_ENUM;
  switch (pname) {
    case E.TEXTURE_COMPARE_MODE:
      return v === E.NONE || v === E.COMPARE_REF_TO_TEXTURE ? 0 : E.INVALID_ENUM;
    case E.TEXTURE_COMPARE_FUNC:
      return COMPARE_FUNCS.has(v) ? 0 : E.INVALID_ENUM;
    case E.TEXTURE_MIN_LOD:
    case E.TEXTURE_MAX_LOD:
      return 0;
    case E.TEXTURE_BASE_LEVEL:
    case E.TEXTURE_MAX_LEVEL:
      if (sampler) return E.INVALID_ENUM;
      return v >= 0 ? 0 : E.INVALID_VALUE;
  }
  return E.INVALID_ENUM;
}

function texParameter(ctx: Ctx, target: number, pname: number, param: number, isFloat: boolean): void {
  if (ctx._skip()) return;
  const t = boundTexture(ctx, target);
  const what = isFloat ? 'texParameterf' : 'texParameteri';
  if (t === undefined) return ctx._e(E.INVALID_ENUM, what);
  if (t === null) return ctx._e(E.INVALID_OPERATION, what);
  const err = texParamError(ctx, pname, param, false);
  if (err) return ctx._e(err, what);
  recordSamplingParam(ctx, t, pname, param);
  if (pname === E.TEXTURE_BASE_LEVEL) {
    t._baseLevel = param | 0;
    markAttachmentsDirty(ctx, t);
  } else if (pname === E.TEXTURE_MAX_LEVEL) {
    t._maxLevel = param | 0;
    markAttachmentsDirty(ctx, t);
  }
  if (isFloat) ctx._n.texParameterf(target, pname, param);
  else ctx._n.texParameteri(target, pname, param);
}

/** Texture kinds for sampler compatibility (WebGL 2.0 §5.?, draw-time). */
export const TK_FLOAT = 0;
export const TK_INT = 1;
export const TK_UINT = 2;
export const TK_DEPTH = 3;
const INT_FORMATS = new Set([E.R8I, E.R16I, E.R32I, E.RG8I, E.RG16I, E.RG32I, E.RGB8I, E.RGB16I, E.RGB32I, E.RGBA8I, E.RGBA16I, E.RGBA32I]);
const UINT_FORMATS = new Set([
  E.R8UI, E.R16UI, E.R32UI, E.RG8UI, E.RG16UI, E.RG32UI, E.RGB8UI, E.RGB16UI, E.RGB32UI, E.RGBA8UI, E.RGBA16UI,
  E.RGBA32UI, E.RGB10_A2UI,
]);
const DEPTH_FORMATS = new Set([
  E.DEPTH_COMPONENT16, E.DEPTH_COMPONENT24, E.DEPTH_COMPONENT32F, E.DEPTH24_STENCIL8, E.DEPTH32F_STENCIL8,
  E.DEPTH_COMPONENT, E.DEPTH_STENCIL,
]);
export function textureKind(internalformat: number): number {
  if (INT_FORMATS.has(internalformat)) return TK_INT;
  if (UINT_FORMATS.has(internalformat)) return TK_UINT;
  if (DEPTH_FORMATS.has(internalformat)) return TK_DEPTH;
  return TK_FLOAT;
}
/** 32-bit float colour formats: LINEAR filtering needs OES_texture_float_linear. */
export function isFloat32Format(internalformat: number): boolean {
  return internalformat === E.R32F || internalformat === E.RG32F || internalformat === E.RGB32F || internalformat === E.RGBA32F;
}

/** Track the sampling parameters the draw-time texture checks read (textures and sampler objects). */
export function recordSamplingParam(ctx: Ctx, o: { _minFilter: number; _magFilter: number; _wrapS: number; _wrapT: number; _compareMode: number }, pname: number, param: number): void {
  const v = Math.trunc(param);
  switch (pname) {
    case E.TEXTURE_MIN_FILTER:
      o._minFilter = v;
      break;
    case E.TEXTURE_MAG_FILTER:
      o._magFilter = v;
      break;
    case E.TEXTURE_WRAP_S:
      o._wrapS = v;
      break;
    case E.TEXTURE_WRAP_T:
      o._wrapT = v;
      break;
    case E.TEXTURE_COMPARE_MODE:
      o._compareMode = v;
      break;
    default:
      return;
  }
  ctx._texDirty = true;
}

/** Formats generateMipmap accepts: unsized / normalized colour formats that are renderable and filterable. */
function mipmappable(ctx: Ctx, f: number): boolean {
  if (COMPRESSED_FORMATS[f]) return false;
  switch (f) {
    case E.RGBA: case E.RGB: case E.LUMINANCE: case E.LUMINANCE_ALPHA: case E.ALPHA:
    case E.R8: case E.RG8: case E.RGB8: case E.RGBA8: case E.SRGB8_ALPHA8: case E.RGB565: case E.RGBA4:
    case E.RGB5_A1: case E.RGB10_A2:
    case E.SRGB_EXT: case E.SRGB_ALPHA_EXT:
      return true;
    case E.R16F: case E.RG16F: case E.RGBA16F: case E.R11F_G11F_B10F:
      return ctx._extensions.has('EXT_color_buffer_float') || ctx._extensions.has('EXT_color_buffer_half_float');
    case E.R32F: case E.RG32F: case E.RGBA32F:
      return ctx._extensions.has('EXT_color_buffer_float') && ctx._extensions.has('OES_texture_float_linear');
    default:
      return false; // integer, depth, SRGB8, RGB9_E5, snorm, RGB16F/32F
  }
}

function compressedOk(ctx: Ctx, format: number): boolean {
  const f = COMPRESSED_FORMATS[format];
  return !!f && ctx._enabledCompressed.has(format);
}

function storageFormatOk(ctx: Ctx, f: number): boolean {
  if (SIZED_FORMAT_INFO[f]) return true;
  return compressedOk(ctx, f);
}

/** GL-3 for immutable storage: GPU clear for renderable formats, zero upload otherwise. */
function zeroStorage(ctx: Ctx, tex: WebGLTexture, target: number, levels: number, internalformat: number, w: number, h: number, d: number): void {
  const n = ctx._n;
  for (let level = 0; level < levels; level++) {
    const lw = Math.max(1, w >> level);
    const lh = Math.max(1, h >> level);
    const ld = target === E.TEXTURE_3D ? Math.max(1, d >> level) : d;
    if (n.clearTextureImage(target, tex._name, level, ld, internalformat, lw, lh, ld)) continue;
    const info = SIZED_FORMAT_INFO[internalformat];
    if (info) {
      const bytes = lw * lh * ld * bytesPerPixel(info[0], info[1]);
      withTightUnpack(ctx, () => {
        const z = zeros(bytes);
        if (target === E.TEXTURE_CUBE_MAP) {
          for (let face = 0; face < 6; face++) {
            n.texSubImage2D(E.TEXTURE_CUBE_MAP_POSITIVE_X + face, level, 0, 0, lw, lh, info[0], info[1], z, 0, bytes);
          }
        } else if (target === E.TEXTURE_2D) {
          n.texSubImage2D(target, level, 0, 0, lw, lh, info[0], info[1], z, 0, bytes);
        } else {
          n.texSubImage3D(target, level, 0, 0, 0, lw, lh, ld, info[0], info[1], z, 0, bytes);
        }
      });
    } else if (COMPRESSED_FORMATS[internalformat]) {
      // Compressed immutable storage is overwritten by compressedTexSubImage* right away in practice
      // (KTX2/Basis loaders); zero blocks are not a defined colour for every format, so leave it to the app.
    }
  }
}

function uploadFromView(
  ctx: Ctx,
  tex: WebGLTexture,
  target: number,
  level: number,
  internalformat: number,
  xoff: number,
  yoff: number,
  zoff: number,
  width: number,
  height: number,
  depth: number,
  format: number,
  type: number,
  view: ArrayBufferView | null,
  srcOffset: number,
  sub: boolean,
  is3D: boolean,
  what: string,
): void {
  const n = ctx._n;
  const ferr = formatError(ctx, sub, internalformat, format, type);
  if (ferr) return ctx._e(ferr, what);
  if (!ctx._v2) [internalformat, format, type] = webgl1Formats(internalformat, format, type);
  if (ctx._pixelUnpack) return ctx._e(E.INVALID_OPERATION, what);
  if (view !== null && unpackParamsInvalid(ctx, width, height, is3D)) return ctx._e(E.INVALID_OPERATION, what);
  const bpp = bytesPerPixel(format, type);
  if (bpp === 0) return ctx._e(E.INVALID_ENUM, what);
  if (view === null) {
    if (sub) throw new TypeError(`${what}: pixels is null`);
    // unpack parameter constraints do not apply when no data is uploaded
    // allocate, then zero (GL-3)
    if (is3D) n.texImage3D(target, level, internalformat, width, height, depth, 0, format, type, null, 0, 0);
    else n.texImage2D(target, level, internalformat, width, height, 0, format, type, null, 0, 0);
    recordLevel(ctx, tex, level, internalformat, width, height, depth);
    if (width && height && depth) zeroLevel(ctx, tex, target, level, internalformat, width, height, depth, format, type, is3D);
    markAttachmentsDirty(ctx, tex);
    return;
  }
  if (!viewMatchesType(viewKind(view), type)) return ctx._e(E.INVALID_OPERATION, what);
  const bpe = (view as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1;
  const elems = view.byteLength / bpe;
  if (srcOffset > elems) return ctx._e(E.INVALID_VALUE, what);
  const avail = view.byteLength - srcOffset * bpe;
  const need = imageByteSize(width, height, depth, format, type, unpackStore(ctx), is3D);
  if (need < 0) return ctx._e(E.INVALID_VALUE, what);
  if (need > avail) return ctx._e(E.INVALID_OPERATION, what);
  if ((ctx._flipY || ctx._premultiply) && is3D) return ctx._e(E.INVALID_OPERATION, what);
  let off = srcOffset * bpe;
  let data: ArrayBufferView = view;
  let bytes = need;
  const transformed = is3D ? null : transformClientPixels(ctx, view, off, width, height, format, type);
  if (transformed) {
    data = transformed;
    off = 0;
    bytes = transformed.byteLength;
    withTightUnpack(ctx, () => {
      if (sub) n.texSubImage2D(target, level, xoff, yoff, width, height, format, type, data, 0, bytes);
      else n.texImage2D(target, level, internalformat, width, height, 0, format, type, data, 0, bytes);
    });
  } else if (is3D) {
    if (sub) n.texSubImage3D(target, level, xoff, yoff, zoff, width, height, depth, format, type, data, off, bytes);
    else n.texImage3D(target, level, internalformat, width, height, depth, 0, format, type, data, off, bytes);
  } else {
    if (sub) n.texSubImage2D(target, level, xoff, yoff, width, height, format, type, data, off, bytes);
    else n.texImage2D(target, level, internalformat, width, height, 0, format, type, data, off, bytes);
  }
  if (!sub) recordLevel(ctx, tex, level, internalformat, width, height, depth);
  markAttachmentsDirty(ctx, tex);
}

function uploadFromPbo(
  ctx: Ctx,
  tex: WebGLTexture,
  target: number,
  level: number,
  internalformat: number,
  width: number,
  height: number,
  depth: number,
  border: number,
  format: number,
  type: number,
  offset: number,
  sub: boolean,
  is3D: boolean,
  what: string,
  xoff = 0,
  yoff = 0,
  zoff = 0,
): void {
  const ferr = formatError(ctx, sub, internalformat, format, type);
  if (ferr) return ctx._e(ferr, what);
  const pbo = ctx._pixelUnpack;
  if (!pbo) return ctx._e(E.INVALID_OPERATION, what);
  if (ctx._flipY || ctx._premultiply) return ctx._e(E.INVALID_OPERATION, what);
  if (unpackParamsInvalid(ctx, width, height, is3D)) return ctx._e(E.INVALID_OPERATION, what);
  if (offset < 0) return ctx._e(E.INVALID_VALUE, what);
  const need = imageByteSize(width, height, depth, format, type, unpackStore(ctx), is3D);
  if (need < 0) return ctx._e(E.INVALID_ENUM, what);
  const bpp = bytesPerPixel(format, type);
  const typeBytes = bpp && type !== E.UNSIGNED_BYTE && type !== E.BYTE ? componentBytes(type) : 1;
  if (offset % typeBytes !== 0) return ctx._e(E.INVALID_OPERATION, what);
  if (offset + need > pbo._size) return ctx._e(E.INVALID_OPERATION, what);
  const n = ctx._n;
  if (is3D) {
    if (sub) n.texSubImage3DOffset(target, level, xoff, yoff, zoff, width, height, depth, format, type, offset);
    else n.texImage3DOffset(target, level, internalformat, width, height, depth, border, format, type, offset);
  } else {
    if (sub) n.texSubImage2DOffset(target, level, xoff, yoff, width, height, format, type, offset);
    else n.texImage2DOffset(target, level, internalformat, width, height, border, format, type, offset);
  }
  if (!sub) recordLevel(ctx, tex, level, internalformat, width, height, depth);
  markAttachmentsDirty(ctx, tex);
}


function formatError(ctx: Ctx, sub: boolean, internalformat: number, format: number, type: number): number {
  const ext = { has: (n: string) => ctx._extensions.has(n) };

  return sub ? subFormatError(ctx._v2, ext, format, type) : texFormatError(ctx._v2, ext, internalformat, format, type);
}

/**
 * WebGL 2.0 §5.?: unpack parameters must describe a sub-rectangle inside each row / image:
 * SKIP_PIXELS + width <= ROW_LENGTH and SKIP_ROWS + height <= IMAGE_HEIGHT (when those are set).
 */
function unpackParamsInvalid(ctx: Ctx, width: number, height: number, is3D: boolean): boolean {
  const p = ctx._ps;
  const rowLength = p[PS_UNPACK_ROW_LENGTH] > 0 ? p[PS_UNPACK_ROW_LENGTH] : width;
  if (p[PS_UNPACK_SKIP_PIXELS] + width > rowLength) return true;
  if (!is3D) return false;
  const imageHeight = p[PS_UNPACK_IMAGE_HEIGHT] > 0 ? p[PS_UNPACK_IMAGE_HEIGHT] : height;
  return p[PS_UNPACK_SKIP_ROWS] + height > imageHeight;
}

/**
 * WebGL 1 over an ES 3 driver: float / half-float colour textures and sRGB need sized internal formats to be
 * renderable and filterable there (what ANGLE does): RGBA/FLOAT -> RGBA32F, RGBA/HALF_FLOAT_OES -> RGBA16F +
 * HALF_FLOAT, SRGB_ALPHA_EXT -> SRGB8_ALPHA8 / RGBA, ...
 */
function webgl1Formats(internalformat: number, format: number, type: number): [number, number, number] {
  if (type === E.FLOAT) {
    if (internalformat === E.RGBA) return [E.RGBA32F, format, type];
    if (internalformat === E.RGB) return [E.RGB32F, format, type];
  } else if (type === E.HALF_FLOAT_OES) {
    if (internalformat === E.RGBA) return [E.RGBA16F, format, E.HALF_FLOAT];
    if (internalformat === E.RGB) return [E.RGB16F, format, E.HALF_FLOAT];
    return [internalformat, format, type];
  }
  if (internalformat === E.SRGB_ALPHA_EXT) return [E.SRGB8_ALPHA8, E.RGBA, type];
  if (internalformat === E.SRGB_EXT) return [E.SRGB8, E.RGB, type];
  if (format === E.SRGB_ALPHA_EXT) return [internalformat, E.RGBA, type];
  if (format === E.SRGB_EXT) return [internalformat, E.RGB, type];
  return [internalformat, format, type];
}

function componentBytes(type: number): number {
  switch (type) {
    case E.UNSIGNED_SHORT:
    case E.SHORT:
    case E.HALF_FLOAT:
    case E.HALF_FLOAT_OES:
    case E.UNSIGNED_SHORT_5_6_5:
    case E.UNSIGNED_SHORT_4_4_4_4:
    case E.UNSIGNED_SHORT_5_5_5_1:
      return 2;
    case E.FLOAT_32_UNSIGNED_INT_24_8_REV:
      return 4;
    default:
      return 4;
  }
}

function zeroLevel(
  ctx: Ctx,
  tex: WebGLTexture,
  target: number,
  level: number,
  internalformat: number,
  w: number,
  h: number,
  d: number,
  format: number,
  type: number,
  is3D: boolean,
): void {
  const n = ctx._n;
  if (n.clearTextureImage(target, tex._name, level, d, internalformat, w, h, d)) return;
  const bytes = imageByteSize(w, h, d, format, type, TIGHT, is3D);
  if (bytes <= 0) return;
  withTightUnpack(ctx, () => {
    const z = zeros(bytes);
    if (is3D) n.texSubImage3D(target, level, 0, 0, 0, w, h, d, format, type, z, 0, bytes);
    else n.texSubImage2D(target, level, 0, 0, w, h, format, type, z, 0, bytes);
  });
}

/**
 * RGBA8 sources uploaded as RGBA / UNSIGNED_BYTE (ImageData, Canvas 2D pixels, three's CanvasTexture, IWSDK
 * text labels): the source itself when nothing changes, else one native pass (flip / alpha conversion), never
 * a per-pixel JS loop (C2D-3, C2D-12). null: take the generic conversion.
 */
function rgba8Fast(
  ctx: Ctx,
  px: SourcePixels,
  x: number,
  y: number,
  w: number,
  h: number,
  d: number,
  format: number,
  type: number,
  flipY: boolean,
  premultiply: boolean | null,
): Uint8Array | null {
  if (d !== 1 || type !== E.UNSIGNED_BYTE || (format !== E.RGBA && format !== E.SRGB_ALPHA_EXT)) return null;
  if (w <= 0 || h <= 0 || x < 0 || y < 0 || x + w > px.width || y + h > px.height) return null;
  const src = px.data;
  if (src.byteLength < px.width * px.height * 4) return null;
  const alphaOp = premultiply === true && !px.premultiplied ? 1 : premultiply === false && px.premultiplied ? 2 : 0;
  const whole = x === 0 && w === px.width;
  if (alphaOp === 0 && !flipY && whole) {
    const start = src.byteOffset + y * w * 4;
    return new Uint8Array(src.buffer, start, w * h * 4);
  }
  const out = new Uint8Array(w * h * 4);
  void out.buffer; // out-parameter: off-heap backing store for the fast-API call
  // FLIP_Y applies to the whole source before UNPACK_SKIP_ROWS selects rows (WebGL 2.0 §5.35): rows y..y+h-1 of the
  // flipped image are source rows H-y-h..H-y-1, read bottom-up.
  const sy = flipY ? px.height - y - h : y;
  if (!ctx._n.convertRgba8(src, 0, src.byteLength, px.width, x, sy, w, h, out, 0, out.byteLength, flipY, alphaOp)) return null;
  return out;
}

/**
 * WebGL 2 overload resolution (WebIDL): a pixels argument that is neither an object nor null/undefined (a
 * string, boolean, bigint, ...) selects the GLintptr pboOffset overload, not ArrayBufferView / TexImageSource.
 */
function offsetOverload(data: unknown): boolean {
  return data !== null && data !== undefined && typeof data !== 'object' && typeof data !== 'function';
}
/** WebIDL `long long` conversion of a pboOffset argument (NaN / non-numeric strings become 0). */
function pboOffset(data: unknown): number {
  const v = Math.trunc(Number(data));
  return Number.isFinite(v) ? v : 0;
}

/** GL-17: uploads from ImageData / ImageBitmap / images / canvases. */
function texFromSource(
  ctx: Ctx,
  sub: boolean,
  target: number,
  level: number,
  internalformat: number,
  xoff: number,
  yoff: number,
  zoff: number,
  width: number,
  height: number,
  depth: number,
  format: number,
  type: number,
  source: unknown,
  what: string,
): void {
  const is3D = target === E.TEXTURE_3D || target === E.TEXTURE_2D_ARRAY;
  const tex = is3D ? tex3DTarget(ctx, target) : tex2DTarget(ctx, target);
  if (tex === undefined) return ctx._e(E.INVALID_ENUM, what);
  if (tex === null) return ctx._e(E.INVALID_OPERATION, what);
  if (!sub && tex._immutable) return ctx._e(E.INVALID_OPERATION, what);
  const ferr = formatError(ctx, sub, internalformat, format, type);
  if (ferr) return ctx._e(ferr, what);
  // (WebGL 1 float/sRGB remapping happens after conversion below: convertPixels needs the WebGL enums)
  if (ctx._pixelUnpack) return ctx._e(E.INVALID_OPERATION, what);
  const px: SourcePixels = getSourcePixels(source, ctx, what); // throws TypeError / InvalidStateError
  ctx._skip(); // reading another WebGL canvas made that context current
  const w = width < 0 ? px.width : width;
  const h = height < 0 ? px.height : height;
  const d = is3D ? depth : 1;
  if (level < 0 || w < 0 || h < 0) return ctx._e(E.INVALID_VALUE, what);
  if (isCubeFace(target) && !sub && w !== h) return ctx._e(E.INVALID_VALUE, what);
  const p = ctx._ps;
  // WebGL 2.0 §5.35: UNPACK_SKIP_PIXELS / SKIP_ROWS select a sub-rectangle of the source; for 3D uploads the
  // source holds `depth` slices of IMAGE_HEIGHT (or height) rows stacked vertically.
  const skipX = ctx._v2 ? p[PS_UNPACK_SKIP_PIXELS] : 0;
  const skipY = ctx._v2 ? p[PS_UNPACK_SKIP_ROWS] : 0;
  const sliceRows = is3D ? (p[PS_UNPACK_IMAGE_HEIGHT] > 0 ? p[PS_UNPACK_IMAGE_HEIGHT] : h) : h;
  const skipImages = is3D ? p[PS_UNPACK_SKIP_IMAGES] : 0;
  const isBitmap = px.isBitmap;
  const flipY = !isBitmap && ctx._flipY;
  const premultiply = isBitmap ? null : ctx._premultiply;
  const n = ctx._n;
  if (px.handle) {
    // Native pixels: whole-image RGBA8 uploads go straight from the store (INTEROP.md §3 step 4).
    const direct =
      format === E.RGBA && type === E.UNSIGNED_BYTE && skipX === 0 && skipY === 0 && skipImages === 0 &&
      w === px.width && h === px.height && d === 1 && (!is3D || sub) && px.width > 0 && px.height > 0;
    if (direct) {
      const alphaMode = premultiply === null ? -1 : premultiply ? 1 : 0;
      let ok = false;
      withTightUnpack(ctx, () => {
        ok = n.imageUpload(px.handle, target, level, internalformat, xoff, yoff, zoff, is3D ? 2 : sub ? 1 : 0, flipY, alphaMode);
      });
      if (!ok) throw domException(`${what}: the source is closed or detached`, 'InvalidStateError');
      if (!sub) recordLevel(ctx, tex, level, internalformat, w, h, d);
      markAttachmentsDirty(ctx, tex);
      return;
    }
    materializePixels(px, ctx, what);
  }
  const converted =
    rgba8Fast(ctx, px, skipX, skipY + skipImages * sliceRows, w, h, d, format, type, flipY, premultiply) ??
    convertPixels(px, skipX, skipY + skipImages * sliceRows, w, h * d, sliceRows, d, format, type, flipY, premultiply);
  if (!converted) return ctx._e(E.INVALID_OPERATION, what);
  if (!ctx._v2) [internalformat, format, type] = webgl1Formats(internalformat, format, type);
  withTightUnpack(ctx, () => {
    const bytes = converted.byteLength;
    if (is3D) {
      if (sub) n.texSubImage3D(target, level, xoff, yoff, zoff, w, h, d, format, type, converted, 0, bytes);
      else n.texImage3D(target, level, internalformat, w, h, d, 0, format, type, converted, 0, bytes);
    } else if (sub) {
      n.texSubImage2D(target, level, xoff, yoff, w, h, format, type, converted, 0, bytes);
    } else {
      n.texImage2D(target, level, internalformat, w, h, 0, format, type, converted, 0, bytes);
    }
  });
  if (!sub) recordLevel(ctx, tex, level, internalformat, w, h, d);
  markAttachmentsDirty(ctx, tex);
}
