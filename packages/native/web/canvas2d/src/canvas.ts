/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Canvas hosts (C2D-1): the bitmap/context bookkeeping shared by OffscreenCanvas (defined here) and
 * HTMLCanvasElement (the DOM module owns the element; `installCanvasElementSupport` adds the canvas
 * behaviour to its prototype): default 300x150, width/height setters that reset the bitmap, getContext with
 * one context per canvas (same object on repeated calls, null for another type), toDataURL/toBlob/
 * convertToBlob (PNG always, JPEG; others fall back to PNG), transferToImageBitmap.
 *
 * WebGL contexts come from a factory registered with `registerContextFactory`, else from the WebGL prelude's
 * `globalThis.__iwnWebGL.createContext` (web/webgl), else from the getContext the DOM module's HTMLCanvasElement had
 * before this module added canvas behaviour to it.
 *
 * texImage2D(canvas): canvases implement the WebGL module's `Symbol.for('iwn.texImageSource')` protocol
 * (web/webgl/tex-source.ts) while they have a 2D context or none: RGBA8 rows top to bottom, straight alpha (what
 * three.js uploads with its default premultiplyAlpha = false need no per-pixel JS work then). With a WebGL context the
 * protocol is absent and web/webgl reads the drawing buffer itself.
 */

import { createContext2D, type Canvas2DContextBase, type ContextAttributes } from './context2d.ts';
import { domException, unimplemented } from './errors.ts';
import type { Canvas2DNatives, NativeSurface } from './natives.ts';
import { IMAGE_SOURCE_SYMBOL, PIXELS_SYMBOL, type PixelData, SURFACE_SYMBOL } from './sources.ts';

export type ContextFactory = (canvas: object, attrs: unknown) => object | null;
const factories = new Map<string, ContextFactory>();

/** The WebGL module's texImage2D source protocol key (web/webgl/tex-source.ts TEX_SOURCE). */
export const TEX_SOURCE_SYMBOL: unique symbol = Symbol.for('iwn.texImageSource') as never;

type WebGLPrelude = { createContext?: (canvas: object, type: 'webgl2' | 'webgl', attrs?: unknown) => object | null };

function webglFactory(type: 'webgl2' | 'webgl'): ContextFactory | null {
  const f = factories.get(type);
  if (f) return f;
  const prelude = (globalThis as { __iwnWebGL?: WebGLPrelude }).__iwnWebGL;
  const create = prelude?.createContext;
  if (typeof create !== 'function') return null;
  return (canvas, attrs) => create.call(prelude, canvas, type, attrs);
}

// One pixel buffer shared by all canvases for synchronous readbacks (texImage2D, image-source descriptors): the
// consumer reads it during the call (INTEROP.md §2, web/webgl tex-source protocol), so no per-upload allocation.
let readback = new Uint8Array(0);
/** runtime/canvas2d kMaxPixels: a larger bitmap is never allocated (its context draws nothing, reads are blank). */
export const MAX_CANVAS_PIXELS = 16384 * 16384;

function readbackBuffer(bytes: number): Uint8Array {
  if (readback.length < bytes) readback = new Uint8Array(bytes);
  return bytes === readback.length ? readback : readback.subarray(0, bytes);
}

/** The WebGL module registers 'webgl' / 'webgl2' here. */
export function registerContextFactory(type: string, factory: ContextFactory): void {
  factories.set(type, factory);
}

export type ImageBitmapFactory = (pixels: PixelData) => object;
let bitmapFactory: ImageBitmapFactory | null = null;
/** The image module registers its ImageBitmap constructor for transferToImageBitmap. */
export function setImageBitmapFactory(f: ImageBitmapFactory | null): void {
  bitmapFactory = f;
}

let natives: Canvas2DNatives | null = null;
export function setCanvasNatives(n: Canvas2DNatives | null): void {
  natives = n;
}
export function getCanvasNatives(): Canvas2DNatives | null {
  return natives;
}

/** Minimal ImageBitmap used when no image module registered one: carries pixels via the pixel protocol. */
export class Canvas2DImageBitmap {
  #px: PixelData | null;
  constructor(px: PixelData) {
    this.#px = px;
  }
  get width(): number {
    return this.#px ? this.#px.width : 0;
  }
  get height(): number {
    return this.#px ? this.#px.height : 0;
  }
  close(): void {
    this.#px = null;
  }
  [PIXELS_SYMBOL](): PixelData | null {
    if (!this.#px) throw domException('The image source is detached (ImageBitmap closed).', 'InvalidStateError');
    return this.#px;
  }
  [IMAGE_SOURCE_SYMBOL](): object {
    const px = this[PIXELS_SYMBOL]()!;
    return { kind: 'pixels', origin: 'bitmap', width: px.width, height: px.height, premultiplied: !!px.premultiplied, data: px.data };
  }
}

/**
 * HTMLCanvasElement.width/height: WebIDL `unsigned long` (wrapping), then the HTML reflection rule for non-negative
 * integers: values above 2^31 - 1 (e.g. -1, which wraps to 2^32 - 1) set the default instead.
 */
function toCanvasDimension(v: unknown, def: number): number {
  const n = Number(v);
  const u = Number.isFinite(n) ? Math.trunc(n) >>> 0 : 0;
  return u > 2147483647 ? def : u;
}

/**
 * OffscreenCanvas width/height: `[EnforceRange] unsigned long long`: non-finite or out-of-range values throw TypeError
 * instead of wrapping. The upper bound is 2^32 - 1, as Chrome enforces for OffscreenCanvas.
 */
export function enforceDimension(v: unknown, what: string): number {
  const n = Number(v);
  const t = Number.isFinite(n) ? Math.trunc(n) : NaN;
  if (!(t >= 0 && t <= 2 ** 32 - 1)) {
    throw new TypeError(`${what}: Value is outside the 'unsigned long long' value range.`);
  }
  return t + 0; // -0 -> 0
}

function base64(bytes: Uint8Array): string {
  const btoa = (globalThis as { btoa?: (s: string) => string }).btoa;
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  if (btoa) return btoa(bin);
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += A[(n >> 18) & 63]! + A[(n >> 12) & 63]! + (i + 1 < bytes.length ? A[(n >> 6) & 63]! : '=') + (i + 2 < bytes.length ? A[n & 63]! : '=');
  }
  return out;
}

/** The part of the WebGL API used to read a WebGL canvas's drawing buffer (any WebGL implementation). */
interface WebGLLike {
  drawingBufferWidth: number;
  drawingBufferHeight: number;
  readPixels(x: number, y: number, w: number, h: number, format: number, type: number, out: ArrayBufferView): void;
  getParameter(p: number): unknown;
  bindFramebuffer(target: number, fb: unknown): void;
  bindBuffer(target: number, buf: unknown): void;
  pixelStorei(p: number, v: number): void;
  getContextAttributes(): { alpha?: boolean; premultipliedAlpha?: boolean } | null;
}
const GL_RGBA = 0x1908;
const GL_UNSIGNED_BYTE = 0x1401;
const GL_FRAMEBUFFER = 0x8d40;
const GL_FRAMEBUFFER_BINDING = 0x8ca6;
const GL_READ_FRAMEBUFFER = 0x8ca8;
const GL_READ_FRAMEBUFFER_BINDING = 0x8caa;
const GL_PACK_ALIGNMENT = 0x0d05;
const GL_PIXEL_PACK_BUFFER = 0x88eb;
const GL_PIXEL_PACK_BUFFER_BINDING = 0x88ed;

/**
 * drawImage / createImageBitmap / texImage2D sources from a WebGL canvas: the drawing buffer read with the context's
 * public API (bindings and pack state restored), rows flipped to top-first, alpha mode from the context attributes.
 */
function readWebGLCanvas(gl: WebGLLike): PixelData {
  const w = gl.drawingBufferWidth | 0;
  const h = gl.drawingBufferHeight | 0;
  const data = new Uint8Array(w * h * 4);
  if (w === 0 || h === 0) return { data, width: w, height: h, premultiplied: true };
  const webgl2 = gl.getParameter(GL_READ_FRAMEBUFFER_BINDING) !== undefined && typeof (gl as { blitFramebuffer?: unknown }).blitFramebuffer === 'function';
  const target = webgl2 ? GL_READ_FRAMEBUFFER : GL_FRAMEBUFFER;
  const prevFb = gl.getParameter(webgl2 ? GL_READ_FRAMEBUFFER_BINDING : GL_FRAMEBUFFER_BINDING);
  const prevAlign = gl.getParameter(GL_PACK_ALIGNMENT) as number;
  const prevPack = webgl2 ? gl.getParameter(GL_PIXEL_PACK_BUFFER_BINDING) : null;
  gl.bindFramebuffer(target, null);
  if (prevAlign !== 4) gl.pixelStorei(GL_PACK_ALIGNMENT, 4);
  if (prevPack) gl.bindBuffer(GL_PIXEL_PACK_BUFFER, null);
  gl.readPixels(0, 0, w, h, GL_RGBA, GL_UNSIGNED_BYTE, data);
  if (prevPack) gl.bindBuffer(GL_PIXEL_PACK_BUFFER, prevPack);
  if (prevAlign !== 4) gl.pixelStorei(GL_PACK_ALIGNMENT, prevAlign);
  gl.bindFramebuffer(target, prevFb ?? null);
  const row = w * 4;
  const tmp = new Uint8Array(row);
  for (let y = 0; y < h >> 1; y++) {
    const a = y * row;
    const b = (h - 1 - y) * row;
    tmp.set(data.subarray(a, a + row));
    data.copyWithin(a, b, b + row);
    data.set(tmp, b);
  }
  const attrs = gl.getContextAttributes();
  const premultiplied = attrs ? attrs.premultipliedAlpha !== false || attrs.alpha === false : true;
  return { data, width: w, height: h, premultiplied };
}

/** Bitmap + context state for one canvas object. */
export class CanvasHost {
  readonly owner: object;
  readonly kind: 'element' | 'offscreen';
  #width: number;
  #height: number;
  #type: string | null = null;
  #ctx: object | null = null;
  #surfaceInfo: { surface: NativeSurface; width: number; height: number } | null = null;
  /** getContext of the element's original implementation (DOM module), used for types this module does not own. */
  fallbackGetContext: ((type: string, attrs?: unknown) => object | null) | null = null;

  constructor(owner: object, kind: 'element' | 'offscreen', width = 300, height = 150) {
    this.owner = owner;
    this.kind = kind;
    this.#width = width;
    this.#height = height;
  }

  get width(): number {
    return this.#width;
  }
  set width(v: number) {
    this.#width = this.kind === 'offscreen' ? enforceDimension(v, "Failed to set the 'width' property on 'OffscreenCanvas'") : toCanvasDimension(v, 300);
    this.#resized();
  }
  get height(): number {
    return this.#height;
  }
  set height(v: number) {
    this.#height = this.kind === 'offscreen' ? enforceDimension(v, "Failed to set the 'height' property on 'OffscreenCanvas'") : toCanvasDimension(v, 150);
    this.#resized();
  }

  #resized(): void {
    if (this.#type === '2d') (this.#ctx as Canvas2DContextBase)._resize(this.#width, this.#height);
  }

  get contextType(): string | null {
    return this.#type;
  }
  get context(): object | null {
    return this.#ctx;
  }

  getContext(type: string, attrs?: unknown): object | null {
    type = String(type);
    if (this.#type !== null) return this.#type === type ? this.#ctx : null;
    if (type === '2d') {
      const n = natives;
      if (!n) throw new TypeError("getContext('2d'): the Canvas 2D natives are not installed.");
      const a = (attrs && typeof attrs === 'object' ? attrs : {}) as Partial<ContextAttributes>;
      this.#ctx = createContext2D(this.kind, n, this.owner as never, a);
      this.#type = '2d';
      return this.#ctx;
    }
    if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') {
      const f = webglFactory(type === 'webgl2' ? 'webgl2' : 'webgl');
      const ctx = f ? f(this.owner, attrs) : this.#fallback(type, attrs);
      if (ctx) {
        this.#ctx = ctx;
        this.#type = type;
      }
      return ctx ?? null;
    }
    const other = this.#fallback(type, attrs);
    if (other) {
      this.#ctx = other;
      this.#type = type;
      return other;
    }
    if (type === 'bitmaprenderer') unimplemented("getContext('bitmaprenderer')");
    return null;
  }

  #fallback(type: string, attrs: unknown): object | null {
    const g = this.fallbackGetContext;
    if (!g) return null;
    const r = g.call(this.owner, type, attrs);
    return r && typeof r === 'object' ? r : null;
  }

  /** The 2D surface (for drawImage, createPattern, and zero-copy uploads through SurfaceFromValue). */
  surface(): { surface: NativeSurface; width: number; height: number } | null {
    if (this.#type !== '2d') return null;
    const c = this.#ctx as Canvas2DContextBase;
    // Reused object (drawImage of a canvas every frame allocates nothing here).
    let info = this.#surfaceInfo;
    if (!info) info = this.#surfaceInfo = { surface: c._surface, width: 0, height: 0 };
    info.surface = c._surface;
    info.width = this.#width;
    info.height = this.#height;
    return info;
  }

  /** True while texImage2D should use the tex-source protocol (2D context or none; WebGL canvases are read by web/webgl). */
  hasTexSource(): boolean {
    return this.#type === null || this.#type === '2d';
  }

  /** web/webgl TEX_SOURCE protocol: straight-alpha RGBA8, top row first, in the shared readback buffer. */
  texSource(): { width: number; height: number; data: Uint8Array; premultiplied: boolean; isBitmap: boolean } {
    let w = this.#width;
    let h = this.#height;
    // A bitmap too large to exist uploads as 0x0 (no multi-GB buffer for pixels that were never stored).
    if (w * h > MAX_CANVAS_PIXELS) w = h = 0;
    const data = readbackBuffer(w * h * 4);
    if (this.#type === '2d') natives!.readPixels((this.#ctx as Canvas2DContextBase)._surface, data, false, false);
    else data.fill(0);
    return { width: w, height: h, data, premultiplied: false, isBitmap: false };
  }

  /** Pixels of the canvas (2D: read back; WebGL: the drawing buffer through the context's own API). */
  pixels(premultiplied = false): PixelData | null {
    if (this.#width * this.#height > MAX_CANVAS_PIXELS && (this.#type === '2d' || this.#type === null)) {
      return { data: new Uint8Array(0), width: 0, height: 0, premultiplied };
    }
    if (this.#type === '2d') {
      const n = natives!;
      const data = new Uint8Array(this.#width * this.#height * 4);
      n.readPixels((this.#ctx as Canvas2DContextBase)._surface, data, premultiplied, false);
      return { data, width: this.#width, height: this.#height, premultiplied };
    }
    const fn = this.#ctx && (this.#ctx as Record<symbol, unknown>)[PIXELS_SYMBOL];
    if (typeof fn === 'function') return (fn as () => PixelData | null).call(this.#ctx);
    if (this.#ctx && typeof (this.#ctx as WebGLLike).readPixels === 'function') return readWebGLCanvas(this.#ctx as WebGLLike);
    // No context yet: a transparent black bitmap.
    return { data: new Uint8Array(this.#width * this.#height * 4), width: this.#width, height: this.#height, premultiplied: true };
  }

  /** The image-source protocol (runtime/image/INTEROP.md §2/§4): upright pixels, premultiplied for 2D. */
  imageSource(): object {
    if (this.#width === 0 || this.#height === 0) {
      throw domException('The canvas has a width or height of 0.', 'InvalidStateError');
    }
    if (this.#width * this.#height > MAX_CANVAS_PIXELS && (this.#type === '2d' || this.#type === null)) {
      throw domException('The canvas is too large to have a bitmap.', 'InvalidStateError');
    }
    if (this.#type !== '2d' && this.#type !== null) {
      const fn = (this.#ctx as Record<symbol, unknown>)[IMAGE_SOURCE_SYMBOL];
      if (typeof fn === 'function') return (fn as () => object).call(this.#ctx);
      const px = this.pixels(false)!;
      return { kind: 'pixels', origin: 'webgl-canvas', width: px.width, height: px.height, premultiplied: !!px.premultiplied, data: px.data };
    }
    const w = this.#width;
    const h = this.#height;
    const data = readbackBuffer(w * h * 4);
    if (this.#type === '2d') natives!.readPixels((this.#ctx as Canvas2DContextBase)._surface, data, true, false);
    else data.fill(0);
    return { kind: 'pixels', origin: 'canvas', width: w, height: h, premultiplied: true, data };
  }

  #encode(type: unknown, quality: unknown): { bytes: Uint8Array; mime: string } | null {
    if (this.#width === 0 || this.#height === 0) return null;
    const n = natives;
    if (!n) return null;
    const mime = typeof type === 'string' ? type.toLowerCase() : 'image/png';
    const q = typeof quality === 'number' && quality >= 0 && quality <= 1 ? quality : -1;
    let surface: NativeSurface | null = null;
    let temp = false;
    if (this.#type === '2d') {
      surface = (this.#ctx as Canvas2DContextBase)._surface;
    } else {
      const px = this.pixels(false);
      if (!px) return null;
      surface = n.createSurface(px.width, px.height);
      temp = true;
      const st = new Float64Array(32);
      st[0] = 1;
      st[3] = 1;
      st[6] = 1;
      st[7] = 9; // copy
      n.drawPixels(surface, st, px.data, px.width, px.height, !!px.premultiplied, 0, 0, px.width, px.height, 0, 0, px.width, px.height, null);
    }
    const r = n.encode(surface, mime === 'image/jpeg' ? 'image/jpeg' : 'image/png', q);
    if (temp) n.resize(surface, 0, 0);
    if (!r) return null;
    return { bytes: new Uint8Array(r[0]), mime: r[1] };
  }

  toDataURL(type?: unknown, quality?: unknown): string {
    const e = this.#encode(type, quality);
    if (!e) return 'data:,';
    return `data:${e.mime};base64,${base64(e.bytes)}`;
  }

  #blob(e: { bytes: Uint8Array; mime: string }): object {
    const B = (globalThis as { Blob?: new (parts: unknown[], opts: { type: string }) => object }).Blob;
    if (!B) throw domException('Blob is not available in this context.', 'NotSupportedError');
    return new B([e.bytes], { type: e.mime });
  }

  toBlob(callback: (b: object | null) => void, type?: unknown, quality?: unknown): void {
    if (typeof callback !== 'function') throw new TypeError("Failed to execute 'toBlob': parameter 1 is not a function.");
    const e = this.#encode(type, quality);
    const blob = e ? this.#blob(e) : null;
    const schedule = (globalThis as { setTimeout?: (f: () => void, ms: number) => unknown }).setTimeout;
    if (schedule) schedule(() => callback(blob), 0);
    else void Promise.resolve().then(() => callback(blob));
  }

  convertToBlob(options?: { type?: string; quality?: number }): Promise<object> {
    if (this.#width === 0 || this.#height === 0) {
      return Promise.reject(domException('The canvas has no pixels (width or height is 0).', 'IndexSizeError'));
    }
    const e = this.#encode(options?.type, options?.quality);
    if (!e) return Promise.reject(domException('Encoding failed.', 'EncodingError'));
    try {
      return Promise.resolve(this.#blob(e));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  transferToImageBitmap(): object {
    if (this.#type === null) throw domException('The canvas has no rendering context.', 'InvalidStateError');
    const px = this.pixels(true);
    if (!px) throw domException('The canvas has no pixels.', 'InvalidStateError');
    if (this.#type === '2d') {
      const old = (this.#ctx as Canvas2DContextBase)._takeSurface();
      natives!.resize(old, 0, 0);
    }
    return bitmapFactory ? bitmapFactory(px) : new Canvas2DImageBitmap(px);
  }
}

const hosts = new WeakMap<object, CanvasHost>();

export function hostOf(canvas: object): CanvasHost | undefined {
  return hosts.get(canvas);
}

/** Simple event support for OffscreenCanvas (contextlost/contextrestored are never fired here). */
export class OffscreenCanvas {
  oncontextlost: ((e: unknown) => void) | null = null;
  oncontextrestored: ((e: unknown) => void) | null = null;
  #listeners = new Map<string, Set<(e: unknown) => void>>();

  constructor(width: number, height: number) {
    if (arguments.length < 2) throw new TypeError("Failed to construct 'OffscreenCanvas': 2 arguments required.");
    const w = enforceDimension(width, "Failed to construct 'OffscreenCanvas'");
    const h = enforceDimension(height, "Failed to construct 'OffscreenCanvas'");
    hosts.set(this, new CanvasHost(this, 'offscreen', w, h));
  }
  get width(): number {
    return hosts.get(this)!.width;
  }
  set width(v: number) {
    hosts.get(this)!.width = v;
  }
  get height(): number {
    return hosts.get(this)!.height;
  }
  set height(v: number) {
    hosts.get(this)!.height = v;
  }
  getContext(type: string, options?: unknown): object | null {
    return hosts.get(this)!.getContext(type, options);
  }
  convertToBlob(options?: { type?: string; quality?: number }): Promise<object> {
    return hosts.get(this)!.convertToBlob(options);
  }
  transferToImageBitmap(): object {
    return hosts.get(this)!.transferToImageBitmap();
  }
  addEventListener(type: string, cb: ((e: unknown) => void) | null): void {
    if (!cb) return;
    let s = this.#listeners.get(type);
    if (!s) this.#listeners.set(type, (s = new Set()));
    s.add(cb);
  }
  removeEventListener(type: string, cb: ((e: unknown) => void) | null): void {
    if (cb) this.#listeners.get(type)?.delete(cb);
  }
  dispatchEvent(e: { type: string }): boolean {
    const h = (this as unknown as Record<string, unknown>)[`on${e.type}`];
    if (typeof h === 'function') (h as (e: unknown) => void).call(this, e);
    for (const cb of this.#listeners.get(e.type) ?? []) cb.call(this, e);
    return true;
  }
  [SURFACE_SYMBOL](): { surface: NativeSurface; width: number; height: number } | null {
    return hosts.get(this)!.surface();
  }
  [PIXELS_SYMBOL](): PixelData | null {
    return hosts.get(this)!.pixels(false);
  }
  [IMAGE_SOURCE_SYMBOL](): object {
    return hosts.get(this)!.imageSource();
  }
}

function texSourceMethod(this: object): ReturnType<CanvasHost['texSource']> {
  const h = hosts.get(this);
  if (!h) throw new TypeError('texImage2D: source is not a canvas');
  return h.texSource();
}

/** TEX_SOURCE as an accessor: the protocol method while the canvas is 2D (or has no context), absent for WebGL. */
function defineTexSource(proto: object, get: (o: object) => CanvasHost | undefined): void {
  Object.defineProperty(proto, TEX_SOURCE_SYMBOL, {
    configurable: true,
    enumerable: false,
    get(this: object) {
      const h = get(this);
      return h && h.hasTexSource() ? texSourceMethod : undefined;
    },
  });
}
defineTexSource(OffscreenCanvas.prototype, (o) => hosts.get(o));

/**
 * Adds canvas behaviour to an HTMLCanvasElement implementation owned by the DOM module: width/height (default
 * 300x150, reflected to the `width`/`height` attributes when `setAttribute` exists), getContext, toDataURL,
 * toBlob, and the drawable-source protocols. `transferControlToOffscreen` and `captureStream` stay absent
 * (C2D-1).
 */
export function installCanvasElementSupport(proto: object): void {
  // Keep the DOM module's own getContext (if any) for context types this module does not create.
  const previous = (proto as { getContext?: unknown }).getContext;
  const fallback = typeof previous === 'function' ? (previous as (type: string, attrs?: unknown) => object | null) : null;
  const get = (el: object): CanvasHost => {
    let h = hosts.get(el);
    if (!h) {
      h = new CanvasHost(el, 'element');
      h.fallbackGetContext = fallback;
      hosts.set(el, h);
    }
    return h;
  };
  const define = (name: PropertyKey, desc: PropertyDescriptor) =>
    Object.defineProperty(proto, name, { configurable: true, enumerable: typeof name === 'string', ...desc });
  for (const dim of ['width', 'height'] as const) {
    define(dim, {
      get(this: object) {
        return get(this)[dim];
      },
      set(this: object, v: number) {
        get(this)[dim] = v;
        const setAttr = (this as { setAttribute?: (k: string, v: string) => void }).setAttribute;
        if (typeof setAttr === 'function') {
          try {
            setAttr.call(this, dim, String(get(this)[dim]));
          } catch {
            // attribute reflection is best effort
          }
        }
      },
    });
  }
  define('getContext', {
    writable: true,
    value: function getContext(this: object, type: string, options?: unknown) {
      return get(this).getContext(type, options);
    },
  });
  define('toDataURL', {
    writable: true,
    value: function toDataURL(this: object, type?: string, quality?: number) {
      return get(this).toDataURL(type, quality);
    },
  });
  define('toBlob', {
    writable: true,
    value: function toBlob(this: object, cb: (b: object | null) => void, type?: string, quality?: number) {
      get(this).toBlob(cb, type, quality);
    },
  });
  define(SURFACE_SYMBOL, {
    writable: true,
    value: function (this: object) {
      return get(this).surface();
    },
  });
  define(PIXELS_SYMBOL, {
    writable: true,
    value: function (this: object) {
      return get(this).pixels(false);
    },
  });
  define(IMAGE_SOURCE_SYMBOL, {
    writable: true,
    value: function (this: object) {
      return get(this).imageSource();
    },
  });
  defineTexSource(proto, get);
}
