/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// HTMLImageElement and the Image() named constructor (HTML §4.8.3-4.8.4.3, IMG-4), without layout: setting `src`
// fetches (load.ts) and decodes off the JS thread (native module), then fires `load` or `error` as a task. Only the
// newest src fires (a pending load is cancelled when src changes, its native decode too). While a new src loads,
// the previous image stays the current request (naturalWidth, drawImage/texImage2D, createImageBitmap use it) until
// the new one replaces it or fails (HTML "pending request"). `crossOrigin` is stored and ignored (NET-7: the
// network allowlist is the only gate). EXIF orientation is applied, as browsers do for <img>.

import type { ImageEnv } from './env.ts';
import { loadImageBytes, resolveImageURL } from './load.ts';
import type { NativeImageHandle } from './natives.ts';
import { type HandleDescriptor, IMAGE_SOURCE } from './source.ts';

const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const CREATE = Symbol('iwn.image.element.create');

type State = 'unavailable' | 'loading' | 'available' | 'broken';

interface ImageSlot {
  env: ImageEnv;
  attrs: Map<string, string>;
  /** The current request's state ('loading': no usable image yet). */
  state: State;
  handle: NativeImageHandle | null;
  currentSrc: string;
  generation: number;
  /** A newer src is loading while the current request stays available (HTML's pending request). */
  pendingLoad: boolean;
  /** The native decode of the newest load, cancelled when src changes again. */
  inflight: Promise<unknown> | null;
  /** decode() promises waiting for the current request. */
  waiters: { resolve(): void; reject(e: unknown): void }[];
}

const slots = new WeakMap<object, ImageSlot>();

function slotOf(self: object): ImageSlot {
  const s = slots.get(self);
  if (!s) throw new TypeError('Illegal invocation');
  return s;
}

/** The live decoded handle behind an <img>, or null (not loaded, broken, not an image element). */
export function imageElementHandle(value: unknown): NativeImageHandle | null {
  if (typeof value !== 'object' || value === null) return null;
  const s = slots.get(value);
  return s && s.state === 'available' ? s.handle : null;
}

export function isImageElement(value: unknown): boolean {
  return typeof value === 'object' && value !== null && slots.has(value);
}

/** Whether the element has a usable image ("fully decodable", HTML §4.8.4.3). */
export function imageElementState(value: unknown): State | null {
  if (typeof value !== 'object' || value === null) return null;
  return slots.get(value)?.state ?? null;
}

// Reflected attributes: [property, attribute, kind].
const STRING_ATTRS: [string, string][] = [
  ['alt', 'alt'],
  ['srcset', 'srcset'],
  ['sizes', 'sizes'],
  ['useMap', 'usemap'],
  ['name', 'name'],
  ['lowsrc', 'lowsrc'],
  ['align', 'align'],
  ['border', 'border'],
  ['longDesc', 'longdesc'],
];

export interface ImageElementClasses {
  HTMLImageElement: new (...args: never[]) => object;
  Image: new (width?: number, height?: number) => object;
  /** document.createElement('img') / createElementNS(xhtml|svg, 'img'). */
  createImageElement(): object;
}

/**
 * Defines HTMLImageElement on top of `Base` (the DOM stream's HTMLElement when it exists, else EventTarget). `Base`
 * is constructed with no arguments.
 */
export function defineImageElement(
  env: ImageEnv,
  Base: new () => object = env.EventTarget as unknown as new () => object,
): ImageElementClasses {
  const baseProto = Base.prototype as Record<string, unknown>;
  const baseSet = typeof baseProto.setAttribute === 'function' ? (baseProto.setAttribute as Function) : null;
  const baseGet = typeof baseProto.getAttribute === 'function' ? (baseProto.getAttribute as Function) : null;
  const baseRemove = typeof baseProto.removeAttribute === 'function' ? (baseProto.removeAttribute as Function) : null;
  const baseHas = typeof baseProto.hasAttribute === 'function' ? (baseProto.hasAttribute as Function) : null;

  const OWN = new Set(['src', 'width', 'height', 'crossorigin', 'decoding', 'loading', 'referrerpolicy',
    'fetchpriority', 'ismap', ...STRING_ATTRS.map(([, a]) => a)]);

  const settleWaiters = (s: ImageSlot, error: unknown | null) => {
    const waiters = s.waiters;
    s.waiters = [];
    for (const w of waiters) {
      if (error) w.reject(error);
      else w.resolve();
    }
  };

  const fire = (el: object, type: 'load' | 'error' | 'loadend') => {
    const s = slotOf(el);
    s.env.dispatch(el as never, new s.env.Event(type));
  };

  // HTML "update the image data", simplified for a host without layout or srcset selection.
  const update = (el: object) => {
    const s = slotOf(el);
    const generation = ++s.generation;
    // A pending decode() rejects when the request is replaced.
    settleWaiters(s, s.env.domException('The source image cannot be decoded (src changed).', 'EncodingError'));
    if (s.inflight) {
      s.env.cancel(s.inflight);
      s.inflight = null;
    }
    const src = s.attrs.get('src');
    if (src === undefined) {
      release(s);
      s.state = 'unavailable';
      s.pendingLoad = false;
      s.currentSrc = '';
      return;
    }
    if (src === '') {
      release(s);
      s.state = 'broken';
      s.pendingLoad = false;
      s.currentSrc = '';
      s.env.queueTask(() => {
        if (s.generation === generation) fire(el, 'error');
      });
      return;
    }
    // An available image stays current until the new one is ready; otherwise the current request is this load.
    if (s.state === 'available' && s.handle) {
      s.pendingLoad = true;
    } else {
      release(s);
      s.state = 'loading';
      s.pendingLoad = false;
    }
    const crossOrigin = s.attrs.get('crossorigin') ?? null;
    const env = s.env;
    const options = { applyExif: true, alpha: 0 as const };
    (async () => {
      await null;  // HTML awaits a stable state: no fetch or parse work inside the src setter
      if (s.generation !== generation) return null;
      const loaded = await loadImageBytes(src, env, crossOrigin, { allowBase64: true });
      if (s.generation !== generation) return null;
      const job = 'base64' in loaded ? env.decodeBase64!(loaded.base64, options) : env.decode(loaded.bytes, options);
      s.inflight = job;
      const handle = await job;
      return { handle, url: loaded.url };
    })().then(
      (result) => {
        if (!result) return;
        if (s.generation !== generation) {
          env.natives.close(result.handle);
          return;
        }
        s.inflight = null;
        release(s);
        s.handle = result.handle;
        s.currentSrc = result.url;
        s.state = 'available';
        s.pendingLoad = false;
        env.queueTask(() => {
          if (s.generation !== generation) return;
          settleWaiters(s, null);
          fire(el, 'load');
        });
      },
      (error) => {
        if (s.generation !== generation) return;
        s.inflight = null;
        // The failed request becomes the current one, broken (HTML: abort both, upgrade pending, broken).
        release(s);
        s.state = 'broken';
        s.pendingLoad = false;
        try {
          s.currentSrc = resolveImageURL(src, env.baseURL());
        } catch {
          s.currentSrc = '';
        }
        env.queueTask(() => {
          if (s.generation !== generation) return;
          settleWaiters(s, env.domException(`The source image cannot be decoded: ${String((error as Error)?.message ?? error)}`, 'EncodingError'));
          fire(el, 'error');
        });
      },
    );
  };

  const release = (s: ImageSlot) => {
    if (s.handle) {
      s.env.natives.close(s.handle);
      s.handle = null;
    }
  };

  const setAttr = (el: object, name: string, value: string | null) => {
    const s = slotOf(el);
    if (value === null) s.attrs.delete(name);
    else s.attrs.set(name, value);
    if (name === 'src' || (name === 'crossorigin' && s.attrs.has('src'))) update(el);
  };

  class HTMLImageElement extends (Base as new () => object) {
    constructor(token?: unknown) {
      if (token !== CREATE) throw new TypeError('Illegal constructor');
      super();
      slots.set(this, {
        env,
        attrs: new Map(),
        state: 'unavailable',
        handle: null,
        currentSrc: '',
        generation: 0,
        pendingLoad: false,
        inflight: null,
        waiters: [],
      });
    }

    get src(): string {
      const v = slotOf(this).attrs.get('src');
      if (v === undefined) return '';
      try {
        return resolveImageURL(v, slotOf(this).env.baseURL());
      } catch {
        return v;
      }
    }
    set src(value: string) {
      setAttr(this, 'src', String(value));
    }
    get currentSrc(): string {
      return slotOf(this).currentSrc;
    }
    get crossOrigin(): string | null {
      const v = slotOf(this).attrs.get('crossorigin');
      if (v === undefined) return null;
      return v.toLowerCase() === 'use-credentials' ? 'use-credentials' : 'anonymous';
    }
    set crossOrigin(value: string | null) {
      setAttr(this, 'crossorigin', value === null ? null : String(value));
    }
    get decoding(): string {
      const v = (slotOf(this).attrs.get('decoding') ?? '').toLowerCase();
      return v === 'sync' || v === 'async' ? v : 'auto';
    }
    set decoding(value: string) {
      setAttr(this, 'decoding', String(value));
    }
    get loading(): string {
      return (slotOf(this).attrs.get('loading') ?? '').toLowerCase() === 'lazy' ? 'lazy' : 'eager';
    }
    set loading(value: string) {
      setAttr(this, 'loading', String(value));
    }
    get referrerPolicy(): string {
      return slotOf(this).attrs.get('referrerpolicy') ?? '';
    }
    set referrerPolicy(value: string) {
      setAttr(this, 'referrerpolicy', String(value));
    }
    get fetchPriority(): string {
      const v = (slotOf(this).attrs.get('fetchpriority') ?? '').toLowerCase();
      return v === 'high' || v === 'low' ? v : 'auto';
    }
    set fetchPriority(value: string) {
      setAttr(this, 'fetchpriority', String(value));
    }
    get isMap(): boolean {
      return slotOf(this).attrs.has('ismap');
    }
    set isMap(value: boolean) {
      setAttr(this, 'ismap', value ? '' : null);
    }
    get width(): number {
      const s = slotOf(this);
      const a = parseDimension(s.attrs.get('width'));
      return a ?? (s.state === 'available' && s.handle ? s.handle.width : 0);
    }
    set width(value: number) {
      setAttr(this, 'width', String(toUnsigned(value)));
    }
    get height(): number {
      const s = slotOf(this);
      const a = parseDimension(s.attrs.get('height'));
      return a ?? (s.state === 'available' && s.handle ? s.handle.height : 0);
    }
    set height(value: number) {
      setAttr(this, 'height', String(toUnsigned(value)));
    }
    get naturalWidth(): number {
      const s = slotOf(this);
      return s.state === 'available' && s.handle ? s.handle.width : 0;
    }
    get naturalHeight(): number {
      const s = slotOf(this);
      return s.state === 'available' && s.handle ? s.handle.height : 0;
    }
    /** True when there is no src, or the image is available or broken and no newer src is loading (`complete`). */
    get complete(): boolean {
      const s = slotOf(this);
      return s.state !== 'loading' && !s.pendingLoad;
    }
    get x(): number {
      return 0;
    }
    get y(): number {
      return 0;
    }

    decode(): Promise<void> {
      const s = slotOf(this);
      if (s.state === 'available' && !s.pendingLoad) return Promise.resolve();
      if (s.state === 'loading' || s.pendingLoad) {
        return new Promise<void>((resolve, reject) => s.waiters.push({ resolve, reject }));
      }
      return Promise.reject(s.env.domException('The source image cannot be decoded.', 'EncodingError'));
    }

    // Attribute API: the reflected names are kept here; others go to the base element if it has an attribute API.
    setAttribute(name: string, value: string): void {
      const n = String(name).toLowerCase();
      if (OWN.has(n)) setAttr(this, n, String(value));
      else if (baseSet) baseSet.call(this, name, value);
      else slotOf(this).attrs.set(n, String(value));
    }
    getAttribute(name: string): string | null {
      const n = String(name).toLowerCase();
      if (OWN.has(n) || !baseGet) return slotOf(this).attrs.get(n) ?? null;
      return baseGet.call(this, name) as string | null;
    }
    removeAttribute(name: string): void {
      const n = String(name).toLowerCase();
      if (OWN.has(n)) setAttr(this, n, null);
      else if (baseRemove) baseRemove.call(this, name);
      else slotOf(this).attrs.delete(n);
    }
    hasAttribute(name: string): boolean {
      const n = String(name).toLowerCase();
      if (OWN.has(n) || !baseHas) return slotOf(this).attrs.has(n);
      return baseHas.call(this, name) as boolean;
    }

    /** The image-source protocol (source.ts): an unloaded or broken image throws InvalidStateError (GL-17). */
    [IMAGE_SOURCE](): HandleDescriptor {
      const s = slotOf(this);
      if (s.state !== 'available' || !s.handle || s.handle.width === 0) {
        throw s.env.domException(
          s.state === 'broken'
            ? 'The HTMLImageElement provided is in the \'broken\' state.'
            : 'The HTMLImageElement provided is not fully loaded.',
          'InvalidStateError',
        );
      }
      const h = s.handle;
      return { kind: 'handle', origin: 'image', width: h.width, height: h.height, premultiplied: h.premultiplied, handle: h };
    }
  }

  for (const [prop, attr] of STRING_ATTRS) {
    Object.defineProperty(HTMLImageElement.prototype, prop, {
      get(this: object) {
        return slotOf(this).attrs.get(attr) ?? '';
      },
      set(this: object, v: unknown) {
        setAttr(this, attr, String(v));
      },
      configurable: true,
      enumerable: true,
    });
  }
  env.defineEventHandler(HTMLImageElement.prototype, 'load');
  env.defineEventHandler(HTMLImageElement.prototype, 'error');
  env.defineEventHandler(HTMLImageElement.prototype, 'abort');
  // Element identity, unless the base element already provides it.
  const defineIfMissing = (name: string, value: unknown) => {
    if (!(name in baseProto)) {
      Object.defineProperty(HTMLImageElement.prototype, name, { get: () => value, configurable: true, enumerable: true });
    }
  };
  defineIfMissing('tagName', 'IMG');
  defineIfMissing('nodeName', 'IMG');
  defineIfMissing('localName', 'img');
  defineIfMissing('namespaceURI', XHTML_NS);
  defineIfMissing('nodeType', 1);
  defineIfMissing('style', {});
  Object.defineProperty(HTMLImageElement.prototype, Symbol.toStringTag, {
    value: 'HTMLImageElement',
    configurable: true,
  });

  // Image(): a named constructor whose prototype is HTMLImageElement.prototype (new Image() instanceof
  // HTMLImageElement, Image.prototype === HTMLImageElement.prototype).
  const Image = function Image(this: unknown, width?: number, height?: number) {
    if (!new.target) throw new TypeError("Failed to construct 'Image': Please use the 'new' operator.");
    const el = new HTMLImageElement(CREATE);
    if (width !== undefined) (el as unknown as { width: number }).width = width;
    if (height !== undefined) (el as unknown as { height: number }).height = height;
    return el;
  } as unknown as new (width?: number, height?: number) => object;
  Object.defineProperty(Image, 'prototype', { value: HTMLImageElement.prototype, writable: false });

  return {
    HTMLImageElement,
    Image,
    createImageElement: () => new HTMLImageElement(CREATE),
  };
}

function parseDimension(v: string | undefined): number | null {
  if (v === undefined) return null;
  const m = /^[\t\n\f\r ]*(\d+)/.exec(v);
  return m ? Math.min(Number(m[1]), 2147483647) : null;
}

function toUnsigned(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) >>> 0 : 0;
}
