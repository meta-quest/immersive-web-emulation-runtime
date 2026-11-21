/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The contract between web/image and the native image module (runtime/image, globalThis.__iwn.image). The native
// side is runtime/image/v8/binding.cc; fake-natives.ts implements the same contract in TS for Node tests and the
// headless runner.

/**
 * An opaque native object owning decoded pixels (RGBA8, top row first, already oriented). `width`/`height` are 0
 * once closed or transferred. Never handed to app code: ImageBitmap / HTMLImageElement wrap it.
 */
export interface NativeImageHandle {
  readonly width: number;
  readonly height: number;
  /** Colour channels are premultiplied by alpha. */
  readonly premultiplied: boolean;
  /** Every alpha byte is 255. */
  readonly opaque: boolean;
}

/** Pixel-pipeline options, already validated and resolved by the JS layer (createImageBitmap's options). */
export interface NativeProcessOptions {
  /** Apply the EXIF orientation stored in the file (decode only). Default true. */
  applyExif?: boolean;
  /** Flip vertically after everything else (imageOrientation: 'flipY'). */
  flipY?: boolean;
  /** 0 keep the source's alpha mode, 1 premultiply, 2 unpremultiply. */
  alpha?: 0 | 1 | 2;
  /** Source rectangle [x, y, width, height] in oriented coordinates; outside the image is transparent black. */
  crop?: [number, number, number, number];
  resizeWidth?: number;
  resizeHeight?: number;
  /** 0 pixelated, 1 low, 2 medium, 3 high. */
  quality?: 0 | 1 | 2 | 3;
}

/** A rejected decode carries `code`. */
export type NativeImageErrorCode =
  | 'unsupported'
  | 'corrupt'
  | 'too-large'
  | 'out-of-memory'
  | 'invalid-argument'
  | 'cancelled';

export interface ImageNatives {
  /** Contract version (2: adds decodeBase64 and cancel; 1 lacks them). */
  readonly version: number;
  /**
   * True when finished jobs are only delivered by poll() (no event-loop hook configured natively). The JS layer
   * then polls on a timer while promises are pending.
   */
  readonly needsPolling: boolean;
  /**
   * Decodes encoded bytes (PNG, JPEG, WebP, GIF first frame, BMP; more where the OS decoder has them) off the JS
   * thread and applies `options` in the same job. The caller must not modify `bytes` until the promise settles.
   */
  decode(bytes: ArrayBuffer | ArrayBufferView, options: NativeProcessOptions): Promise<NativeImageHandle>;
  /**
   * A data: URL's base64 payload: forgiving-base64 (WHATWG Infra) and the image decode both run off the JS thread;
   * the JS thread only copies the characters (REG-16). Invalid base64 rejects with code 'corrupt'. Version >= 2.
   */
  decodeBase64?(text: string, options: NativeProcessOptions): Promise<NativeImageHandle>;
  /**
   * Rejects a pending promise returned by decode/decodeBase64/fromPixels/transform with code 'cancelled' and stops
   * its job (a queued job never starts). Returns false when the promise is not pending. Version >= 2.
   */
  cancel?(promise: Promise<unknown>): boolean;
  /** Snapshots `rgba` (width*height*4 bytes) now, processes it off the JS thread. */
  fromPixels(
    rgba: ArrayBufferView,
    width: number,
    height: number,
    premultiplied: boolean,
    options: NativeProcessOptions,
  ): Promise<NativeImageHandle>;
  /** A new handle from an existing one (the source stays valid). */
  transform(handle: NativeImageHandle, options: NativeProcessOptions): Promise<NativeImageHandle>;
  /** A second handle on the same pixels (closing one leaves the other). */
  share(handle: NativeImageHandle): NativeImageHandle;
  /** A tightly packed copy of the pixels in the requested alpha mode. Throws if closed. */
  readPixels(handle: NativeImageHandle, premultiplied: boolean): Uint8ClampedArray;
  /** Frees the pixels now. Idempotent. */
  close(handle: NativeImageHandle): void;
  /** Detaches the handle and parks its pixels process-wide; another isolate takes them with importTransfer. */
  exportTransfer(handle: NativeImageHandle): number;
  importTransfer(id: number): NativeImageHandle | null;
  discardTransfer(id: number): void;
  /** Delivers finished jobs (polling mode); returns how many. */
  poll(): number;
  stats(): {
    pending: number;
    queued: number;
    threads: number;
    handles: number;
    bytes: number;
    parked: number;
    backends: string[];
    budgetBytes?: number;
    budgetInFlight?: number;
    mode?: string;
  };
}

export function isNativeImageError(e: unknown): e is Error & { code: NativeImageErrorCode } {
  return typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string';
}
