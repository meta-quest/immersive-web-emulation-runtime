/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The image-source protocol shared by everything that consumes pixels from a "CanvasImageSource" / "TexImageSource":
// WebGL texImage2D/texSubImage2D (web/webgl), Canvas 2D drawImage/createPattern (canvas stream) and
// createImageBitmap (here). Producers (ImageBitmap, HTMLImageElement, ImageData here; canvases and OffscreenCanvas in
// the canvas / WebGL streams) implement a method under IMAGE_SOURCE that returns a descriptor. The protocol uses a
// registered symbol so other streams need not import this module. Details: runtime/image/INTEROP.md.

import type { NativeImageHandle } from './natives.ts';

export const IMAGE_SOURCE: unique symbol = Symbol.for('iwn.image.source') as never;

export type ImageSourceOrigin = 'bitmap' | 'image' | 'imagedata' | 'canvas' | 'webgl-canvas';

interface DescriptorBase {
  /** What produced it. WebGL ignores UNPACK_FLIP_Y_WEBGL / UNPACK_PREMULTIPLY_ALPHA_WEBGL for 'bitmap' (GL-16). */
  origin: ImageSourceOrigin;
  width: number;
  height: number;
  /** Colour is premultiplied by alpha. */
  premultiplied: boolean;
}

/** Pixels behind a native handle (decoded images, bitmaps, natively backed canvases). Zero copy for consumers. */
export interface HandleDescriptor extends DescriptorBase {
  kind: 'handle';
  handle: NativeImageHandle;
}

/** Pixels in JS memory: RGBA8, tightly packed, top row first. Consumers must not keep or modify `data`. */
export interface PixelsDescriptor extends DescriptorBase {
  kind: 'pixels';
  data: Uint8ClampedArray | Uint8Array;
}

export type ImageSourceDescriptor = HandleDescriptor | PixelsDescriptor;

export interface ImageSourceProvider {
  /**
   * Returns the current pixels. Throws a DOMException InvalidStateError when the source cannot be used (closed
   * bitmap, image not loaded or broken, zero-sized canvas).
   */
  [IMAGE_SOURCE](): ImageSourceDescriptor;
}

export function isImageSourceProvider(value: unknown): value is ImageSourceProvider {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { [IMAGE_SOURCE]?: unknown })[IMAGE_SOURCE] === 'function'
  );
}

/** HTMLVideoElement / VideoFrame look-alikes (no video support yet: GL-17 wants a TypeError). */
export function isVideoLike(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const name = (value as { constructor?: { name?: string } }).constructor?.name;
  return name === 'HTMLVideoElement' || name === 'VideoFrame' || 'videoWidth' in value;
}
