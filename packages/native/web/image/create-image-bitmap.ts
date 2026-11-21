/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// createImageBitmap (HTML §8.10 "ImageBitmap and animation frames", IMG-6). Argument checks follow the spec's
// order; the pixel work (decode, orientation, source rectangle, resize, flipY, premultiply) runs as one native job
// off the JS thread. Sources: Blob, ImageData, ImageBitmap, HTMLImageElement and anything implementing the
// image-source protocol (canvases, OffscreenCanvas: source.ts).
//
// Option semantics (what the bitmap's pixels are):
//  - imageOrientation 'from-image' (default): EXIF orientation applied; 'flipY': applied, then flipped vertically;
//    'none' (legacy value, IMG-1): EXIF ignored for encoded sources (Blob); HTMLImageElement sources are already
//    oriented (as <img>), so 'none' equals 'from-image' for them.
//  - premultiplyAlpha 'default' premultiplies, for every source, as Chromium does (its ParseOptions treats kDefault
//    like kPremultiply); IMG-6 compares against Chrome, and WebGL uploads a bitmap as stored. 'none' keeps or
//    makes straight alpha.
//  - colorSpaceConversion: accepted, no colour management either way (IMG-6, documented).
//  - resizeQuality: 'pixelated' nearest, 'low' bilinear, 'medium' area average, 'high' tent filter (both bilinear
//    when enlarging).

import type { ImageEnv } from './env.ts';
import { bitmapHandle, isImageBitmap, wrapBitmap, type ImageBitmap } from './image-bitmap.ts';
import { imageElementHandle, imageElementState, isImageElement } from './html-image-element.ts';
import { isNativeImageError, type NativeProcessOptions } from './natives.ts';
import { isImageSourceProvider, isVideoLike, IMAGE_SOURCE, type PixelsDescriptor } from './source.ts';

interface ImageBitmapOptions {
  imageOrientation?: string;
  premultiplyAlpha?: string;
  colorSpaceConversion?: string;
  resizeWidth?: number;
  resizeHeight?: number;
  resizeQuality?: string;
}

const ORIENTATION = ['from-image', 'flipY', 'none'] as const;
const PREMULTIPLY = ['default', 'premultiply', 'none'] as const;
const COLORSPACE = ['default', 'none'] as const;
const QUALITY = ['pixelated', 'low', 'medium', 'high'] as const;

const PREFIX = "Failed to execute 'createImageBitmap' on 'Window': ";

function enumValue<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  fallback: T[number],
  type: string,
): T[number] {
  if (value === undefined) return fallback;
  const s = String(value);
  if (!(allowed as readonly string[]).includes(s)) {
    throw new TypeError(`${PREFIX}The provided value '${s}' is not a valid enum value of type ${type}.`);
  }
  return s as T[number];
}

// WebIDL [EnforceRange] unsigned long.
function enforceUnsignedLong(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new TypeError(`${PREFIX}Value is not of type 'unsigned long' (${name}).`);
  const t = Math.trunc(n);
  if (t < 0 || t > 4294967295) {
    throw new TypeError(`${PREFIX}Value is outside the 'unsigned long' value range (${name}).`);
  }
  return t;
}

// WebIDL `long` (no [EnforceRange]): ToInt32.
function toLong(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) | 0 : 0;
}

interface Parsed {
  crop: [number, number, number, number] | null;
  orientation: (typeof ORIENTATION)[number];
  alpha: 0 | 1 | 2;
  resizeWidth?: number;
  resizeHeight?: number;
  quality: 0 | 1 | 2 | 3;
}

function parseArgs(env: ImageEnv, args: unknown[]): Parsed {
  let crop: [number, number, number, number] | null = null;
  let optionsArg: unknown;
  if (args.length >= 5) {
    // (image, sx, sy, sw, sh, options?)
    const sx = toLong(args[1]);
    const sy = toLong(args[2]);
    let sw = toLong(args[3]);
    let sh = toLong(args[4]);
    optionsArg = args[5];
    if (sw === 0) throw new RangeError(`${PREFIX}The crop rect width is 0.`);
    if (sh === 0) throw new RangeError(`${PREFIX}The crop rect height is 0.`);
    let x = sx;
    let y = sy;
    if (sw < 0) {
      x += sw;
      sw = -sw;
    }
    if (sh < 0) {
      y += sh;
      sh = -sh;
    }
    crop = [x, y, sw, sh];
  } else if (args.length >= 3) {
    throw new TypeError(`${PREFIX}Valid arities are: [1, 2, 5, 6], but ${args.length} arguments provided.`);
  } else {
    optionsArg = args[1];
  }
  let options: ImageBitmapOptions = {};
  if (optionsArg !== undefined && optionsArg !== null) {
    if (typeof optionsArg !== 'object' && typeof optionsArg !== 'function') {
      throw new TypeError(`${PREFIX}The provided value is not of type 'ImageBitmapOptions'.`);
    }
    options = optionsArg as ImageBitmapOptions;
  }
  // Dictionary members are read in lexicographic order (WebIDL).
  enumValue(options.colorSpaceConversion, COLORSPACE, 'default', 'ColorSpaceConversion');
  const orientation = enumValue(options.imageOrientation, ORIENTATION, 'from-image', 'ImageOrientation');
  const premultiply = enumValue(options.premultiplyAlpha, PREMULTIPLY, 'default', 'PremultiplyAlpha');
  const resizeHeight =
    options.resizeHeight === undefined ? undefined : enforceUnsignedLong(options.resizeHeight, 'resizeHeight');
  const quality = enumValue(options.resizeQuality, QUALITY, 'low', 'ResizeQuality');
  const resizeWidth =
    options.resizeWidth === undefined ? undefined : enforceUnsignedLong(options.resizeWidth, 'resizeWidth');
  if (resizeWidth === 0 || resizeHeight === 0) {
    throw env.domException(`${PREFIX}The resize width or height is 0.`, 'InvalidStateError');
  }
  return {
    crop,
    orientation,
    alpha: premultiply === 'none' ? 2 : 1,
    resizeWidth,
    resizeHeight,
    quality: QUALITY.indexOf(quality) as 0 | 1 | 2 | 3,
  };
}

/** Output size when only one of resizeWidth/resizeHeight is given (HTML: ceil of the proportional size). */
function resolveSize(p: Parsed, srcW: number, srcH: number): { w?: number; h?: number } {
  const sw = p.crop ? p.crop[2] : srcW;
  const sh = p.crop ? p.crop[3] : srcH;
  if (p.resizeWidth !== undefined && p.resizeHeight !== undefined) return { w: p.resizeWidth, h: p.resizeHeight };
  if (p.resizeWidth !== undefined) return { w: p.resizeWidth, h: Math.max(1, Math.ceil((sh * p.resizeWidth) / sw)) };
  if (p.resizeHeight !== undefined) return { w: Math.max(1, Math.ceil((sw * p.resizeHeight) / sh)), h: p.resizeHeight };
  return {};
}

function processOptions(p: Parsed, srcW: number, srcH: number, encoded: boolean): NativeProcessOptions {
  const o: NativeProcessOptions = {
    applyExif: !(encoded && p.orientation === 'none'),
    flipY: p.orientation === 'flipY',
    alpha: p.alpha,
    quality: p.quality,
  };
  if (p.crop) o.crop = p.crop;
  if (p.resizeWidth !== undefined && p.resizeHeight !== undefined) {
    o.resizeWidth = p.resizeWidth;
    o.resizeHeight = p.resizeHeight;
  } else if (srcW > 0 && srcH > 0) {
    const { w, h } = resolveSize(p, srcW, srcH);
    if (w !== undefined) o.resizeWidth = w;
    if (h !== undefined) o.resizeHeight = h;
  }
  return o;
}

// Pixel sources come from any object implementing IMAGE_SOURCE, so their numbers are checked here before they reach
// native code (which checks again): integer sides 1..32768, at most 2^28 pixels (the native cap), and a byte view of
// exactly width * height * 4 bytes.
const MAX_SIDE = 32768;
const MAX_PIXELS = 2 ** 28;
function checkPixelsDescriptor(d: PixelsDescriptor, invalid: (msg: string) => unknown): void {
  const { width: w, height: h, data } = d;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > MAX_SIDE || h > MAX_SIDE || w * h > MAX_PIXELS) {
    throw invalid(`The source image size ${String(w)}x${String(h)} is outside 1..${MAX_SIDE} per side or ${MAX_PIXELS} pixels.`);
  }
  if (!ArrayBuffer.isView(data) || data.byteLength !== w * h * 4) {
    throw invalid('The source pixel data length does not match width * height * 4.');
  }
}

export function makeCreateImageBitmap(env: ImageEnv): (...args: unknown[]) => Promise<ImageBitmap> {
  const invalid = (msg: string) => env.domException(PREFIX + msg, 'InvalidStateError');
  const mapNativeError = (e: unknown): unknown =>
    isNativeImageError(e)
      ? invalid(
          e.code === 'too-large'
            ? 'The image is too large to decode.'
            : e.code === 'out-of-memory'
              ? 'Out of memory while decoding the image.'
              : 'The source image could not be decoded.',
        )
      : e;

  const run = async (args: unknown[]): Promise<ImageBitmap> => {
    if (args.length < 1) {
      throw new TypeError(`${PREFIX}1 argument required, but only 0 present.`);
    }
    const source = args[0];
    const p = parseArgs(env, args);

    // Blob: decode with the options in one job. A Blob's size is unknown until decoded, so a resize with only one
    // dimension is resolved natively from the crop/decoded size: decode first, then transform.
    if (env.isBlob(source)) {
      const bytes = await env.blobBytes(source);
      const oneSided = (p.resizeWidth === undefined) !== (p.resizeHeight === undefined);
      try {
        if (!oneSided) {
          return wrapBitmap(await env.decode(bytes, processOptions(p, 0, 0, true)), env.natives);
        }
        const first: NativeProcessOptions = { applyExif: p.orientation !== 'none', alpha: 0 };
        const decoded = await env.decode(bytes, first);
        try {
          return wrapBitmap(
            await env.transform(decoded, { ...processOptions(p, decoded.width, decoded.height, false), applyExif: true }),
            env.natives,
          );
        } finally {
          env.natives.close(decoded);
        }
      } catch (e) {
        throw mapNativeError(e);
      }
    }

    if (isVideoLike(source)) {
      throw new TypeError(`${PREFIX}Video sources are not supported by this runtime.`);
    }

    if (isImageBitmap(source)) {
      const h = bitmapHandle(source);
      if (!h) throw invalid('The image source is detached.');
      return wrapBitmap(await env.transform(h, processOptions(p, h.width, h.height, false)), env.natives);
    }

    if (isImageElement(source)) {
      const state = imageElementState(source);
      const h = imageElementHandle(source);
      if (!h) {
        throw invalid(
          state === 'broken'
            ? "The HTMLImageElement provided is in the 'broken' state."
            : 'The HTMLImageElement provided is not fully loaded.',
        );
      }
      return wrapBitmap(await env.transform(h, processOptions(p, h.width, h.height, false)), env.natives);
    }

    if (isImageSourceProvider(source)) {
      const d = source[IMAGE_SOURCE]();
      if (d.width === 0 || d.height === 0) throw invalid('The source image width or height is 0.');
      if (d.kind !== 'handle') checkPixelsDescriptor(d, invalid);
      const o = processOptions(p, d.width, d.height, false);
      if (d.kind === 'handle') return wrapBitmap(await env.transform(d.handle, o), env.natives);
      return wrapBitmap(await env.fromPixels(d.data, d.width, d.height, d.premultiplied, o), env.natives);
    }

    throw new TypeError(
      `${PREFIX}The provided value is not of type '(Blob or HTMLCanvasElement or HTMLImageElement or HTMLVideoElement or ImageBitmap or ImageData or OffscreenCanvas or SVGImageElement or VideoFrame)'.`,
    );
  };

  return function createImageBitmap(...args: unknown[]): Promise<ImageBitmap> {
    // A promise-returning operation turns every exception into a rejection (WebIDL).
    try {
      return run(args).catch((e: unknown) => Promise.reject(mapNativeError(e)));
    } catch (e) {
      return Promise.reject(e);
    }
  };
}
