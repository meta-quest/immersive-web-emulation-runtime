/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * CanvasImageSource resolution for drawImage / createPattern (C2D-5) without a dependency on the modules that
 * own the other source types. A source is drawable when it is, in this order:
 *
 *  1. a canvas whose 2D context belongs to this module (`[SURFACE_SYMBOL]()` returns its native surface: no copy);
 *  2. an image-source provider (`Symbol.for('iwn.image.source')`, runtime/image/INTEROP.md): ImageBitmap,
 *     HTMLImageElement (web/image), WebGL canvases. 'handle' descriptors are drawn natively from the image
 *     module's PixelStore; 'pixels' descriptors from their typed array. An HTMLImageElement that is still loading
 *     draws nothing; a broken one throws InvalidStateError (the provider's error);
 *  3. resolved by a registered resolver (`registerImageSourceResolver`);
 *  4. any object implementing the pixel protocol `[PIXELS_SYMBOL](): PixelData | null`
 *     (`Symbol.for('iwn.pixels')`): RGBA8 rows, top row first. Return null while not ready (nothing is drawn);
 *     throw an InvalidStateError DOMException when broken/closed.
 *
 * ImageData is not a CanvasImageSource: TypeError, as in browsers.
 */

import { domException } from './errors.ts';
import type { Canvas2DNatives, NativeSurface } from './natives.ts';

export const PIXELS_SYMBOL: unique symbol = Symbol.for('iwn.pixels') as never;
export const SURFACE_SYMBOL: unique symbol = Symbol.for('iwn.canvas2d.surface') as never;
/** The image module's source protocol (web/image/source.ts IMAGE_SOURCE). */
export const IMAGE_SOURCE_SYMBOL: unique symbol = Symbol.for('iwn.image.source') as never;
const IMAGE_REGISTRY = Symbol.for('iwn.image');

interface ImageSourceDescriptor {
  kind: 'handle' | 'pixels';
  origin: string;
  width: number;
  height: number;
  premultiplied: boolean;
  handle?: object;
  data?: Uint8Array | Uint8ClampedArray;
}

export interface PixelData {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  premultiplied?: boolean;
}

export interface ResolvedImage {
  width: number;
  height: number;
  surface?: NativeSurface;
  data?: Uint8Array | Uint8ClampedArray;
  premultiplied?: boolean;
  /** A native handle another module understands (drawn through natives.drawExternal). */
  external?: object;
}

/** Returns a ResolvedImage, null for "not ready: draw nothing", or undefined when the resolver does not know the object. */
export type ImageSourceResolver = (source: unknown) => ResolvedImage | null | undefined;

const resolvers: ImageSourceResolver[] = [];

export function registerImageSourceResolver(fn: ImageSourceResolver): void {
  resolvers.unshift(fn);
}

// One reused result object for descriptor-based sources (C2D-12: drawImage of an ImageBitmap / HTMLImageElement
// allocates nothing here). Callers consume the result before the next resolveImageSource call.
const SCRATCH: ResolvedImage = { width: 0, height: 0, surface: undefined, data: undefined, premultiplied: false, external: undefined };
function scratchResult(
  surface: NativeSurface | undefined,
  data: Uint8Array | Uint8ClampedArray | undefined,
  external: object | undefined,
  width: number,
  height: number,
  premultiplied: boolean,
): ResolvedImage {
  SCRATCH.surface = surface;
  SCRATCH.data = data;
  SCRATCH.external = external;
  SCRATCH.width = width;
  SCRATCH.height = height;
  SCRATCH.premultiplied = premultiplied;
  return SCRATCH;
}

export function resolveImageSource(source: unknown, _n: Canvas2DNatives, method: string): ResolvedImage | null {
  if (source === null || source === undefined || (typeof source !== 'object' && typeof source !== 'function')) {
    throw new TypeError(`Failed to execute '${method}': The provided value is not of type 'CanvasImageSource'.`);
  }
  const o = source as Record<symbol, unknown>;
  const surf = o[SURFACE_SYMBOL];
  if (typeof surf === 'function') {
    const dims = source as { width?: number; height?: number };
    if (dims.width === 0 || dims.height === 0) {
      throw domException(`Failed to execute '${method}': The image argument is a canvas element with a width or height of 0.`, 'InvalidStateError');
    }
    // The host's reused descriptor object: no allocation per drawImage of a canvas (C2D-12).
    const info = (surf as () => { surface: NativeSurface; width: number; height: number } | null).call(source);
    if (info) return checkSize(info, method, true);
  }
  const provider = o[IMAGE_SOURCE_SYMBOL];
  if (typeof provider === 'function') {
    const reg = (globalThis as Record<symbol, unknown>)[IMAGE_REGISTRY] as { isImageElement?(v: unknown): boolean } | undefined;
    if (reg?.isImageElement?.(source) && (source as { complete?: boolean }).complete === false) return null;
    const d = (provider as () => ImageSourceDescriptor).call(source);
    if (d.origin === 'imagedata') {
      throw new TypeError(`Failed to execute '${method}': The provided value is not of type 'CanvasImageSource' (ImageData is not drawable; use putImageData).`);
    }
    if (d.width === 0 || d.height === 0) return null;
    if (d.kind === 'pixels' && d.data) return scratchResult(undefined, d.data, undefined, d.width, d.height, d.premultiplied);
    if (d.kind === 'handle' && d.handle) return scratchResult(undefined, undefined, d.handle, d.width, d.height, d.premultiplied);
    return null;
  }
  for (const r of resolvers) {
    const v = r(source);
    if (v !== undefined) return checkSize(v, method, true);
  }
  const px = o[PIXELS_SYMBOL];
  if (typeof px === 'function') {
    const d = (px as () => PixelData | null).call(source);
    if (!d) return null;
    return checkSize(scratchResult(undefined, d.data, undefined, d.width, d.height, !!d.premultiplied), method, false);
  }
  const ctor = (source as { constructor?: { name?: string } }).constructor?.name;
  if (ctor === 'ImageData') {
    throw new TypeError(`Failed to execute '${method}': The provided value is not of type 'CanvasImageSource' (ImageData is not drawable; use putImageData).`);
  }
  throw new TypeError(`Failed to execute '${method}': The provided value is not of type 'CanvasImageSource'.`);
}

function checkSize(v: ResolvedImage | null, method: string, isCanvas: boolean): ResolvedImage | null {
  if (!v) return null;
  if (v.width === 0 || v.height === 0) {
    if (isCanvas) throw domException(`Failed to execute '${method}': The image argument is a canvas element with a width or height of 0.`, 'InvalidStateError');
    return null;
  }
  return v;
}
