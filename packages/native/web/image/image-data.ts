/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// ImageData (HTML §4.12.5.1.15 "Pixel manipulation", IMG-5). Pure JS: the pixels live in the Uint8ClampedArray the
// app sees.

import { IMAGE_SOURCE, type PixelsDescriptor } from './source.ts';

type ColorSpace = 'srgb' | 'display-p3';

interface ImageDataSettings {
  colorSpace?: ColorSpace;
  pixelFormat?: 'rgba-unorm8';
}

let domException: (message: string, name: string) => Error = (m, n) => {
  const e = new Error(m);
  e.name = n;
  return e;
};

/** Lets the installer supply the global DOMException. */
export function setImageDataErrors(
  make: (message: string, name: string) => Error,
): void {
  domException = make;
}

// WebIDL `unsigned long` conversion (no [EnforceRange]): ToNumber, truncate, modulo 2^32.
function toUnsignedLong(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.trunc(n) >>> 0;
}

function parseSettings(settings: unknown): ColorSpace {
  if (settings === undefined || settings === null) return 'srgb';
  if (typeof settings !== 'object' && typeof settings !== 'function') {
    throw new TypeError(
      "Failed to construct 'ImageData': The provided value is not of type 'ImageDataSettings'.",
    );
  }
  const cs = (settings as ImageDataSettings).colorSpace;
  if (cs === undefined) return 'srgb';
  const s = String(cs);
  if (s !== 'srgb' && s !== 'display-p3') {
    throw new TypeError(
      `Failed to construct 'ImageData': The provided value '${s}' is not a valid enum value of type PredefinedColorSpace.`,
    );
  }
  const pf = (settings as ImageDataSettings).pixelFormat;
  if (pf !== undefined && String(pf) !== 'rgba-unorm8') {
    throw new TypeError(
      `Failed to construct 'ImageData': The provided value '${String(pf)}' is not a valid enum value of type ImageDataPixelFormat.`,
    );
  }
  return s;
}

const MAX_BYTES = 2 ** 31 - 1;

// Intrinsics captured at load, so later page changes to the prototypes cannot fake the checks below.
const typedArrayBuffer = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'buffer',
)!.get as (this: ArrayBufferView) => ArrayBufferLike;
const arrayBufferResizable = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'resizable',
)?.get as ((this: ArrayBuffer) => boolean) | undefined;
const SAB: SharedArrayBufferConstructor | undefined =
  typeof SharedArrayBuffer === 'function' ? SharedArrayBuffer : undefined;
const sabByteLength = SAB
  ? (Object.getOwnPropertyDescriptor(SAB.prototype, 'byteLength')?.get as
      | ((this: SharedArrayBuffer) => number)
      | undefined)
  : undefined;

// WebIDL: a buffer-source argument without [AllowShared] / [AllowResizable] (ImageData's constructor has neither)
// rejects views on SharedArrayBuffers and on resizable ArrayBuffers with a TypeError.
function checkBufferKind(view: Uint8ClampedArray): void {
  const buffer = typedArrayBuffer.call(view);
  let shared = false;
  if (sabByteLength) {
    try {
      sabByteLength.call(buffer as SharedArrayBuffer); // throws unless a SharedArrayBuffer
      shared = true;
    } catch {
      shared = false;
    }
  }
  if (shared) {
    throw new TypeError(
      "Failed to construct 'ImageData': The provided ArrayBufferView value must not be shared.",
    );
  }
  if (
    arrayBufferResizable &&
    arrayBufferResizable.call(buffer as ArrayBuffer)
  ) {
    throw new TypeError(
      "Failed to construct 'ImageData': The provided ArrayBufferView value must not be resizable.",
    );
  }
}

export class ImageData {
  #width: number;
  #height: number;
  #data: Uint8ClampedArray;
  #colorSpace: ColorSpace;

  constructor(sw: number, sh: number, settings?: ImageDataSettings);
  constructor(
    data: Uint8ClampedArray,
    sw: number,
    sh?: number,
    settings?: ImageDataSettings,
  );
  constructor(a: unknown, b: unknown, c?: unknown, d?: unknown) {
    if (arguments.length < 2) {
      throw new TypeError(
        `Failed to construct 'ImageData': 2 arguments required, but only ${arguments.length} present.`,
      );
    }
    if (a instanceof Uint8ClampedArray) {
      // constructor(data, sw, optional sh, optional settings)
      checkBufferKind(a);
      const sw = toUnsignedLong(b);
      const length = a.length;
      if (length === 0 || length % 4 !== 0) {
        throw domException(
          "Failed to construct 'ImageData': The input data length is not a multiple of 4.",
          'InvalidStateError',
        );
      }
      if (sw === 0) {
        throw domException(
          "Failed to construct 'ImageData': The source width is zero or not a number.",
          'IndexSizeError',
        );
      }
      const pixels = length / 4;
      if (pixels % sw !== 0) {
        throw domException(
          "Failed to construct 'ImageData': The input data length is not a multiple of (4 * width).",
          'IndexSizeError',
        );
      }
      const height = pixels / sw;
      if (c !== undefined && toUnsignedLong(c) !== height) {
        throw domException(
          "Failed to construct 'ImageData': The input data length is not equal to (4 * width * height).",
          'IndexSizeError',
        );
      }
      this.#colorSpace = parseSettings(d);
      this.#width = sw;
      this.#height = height;
      this.#data = a;
      return;
    }
    if (ArrayBuffer.isView(a) && !(a instanceof DataView)) {
      throw new TypeError(
        "Failed to construct 'ImageData': The provided ArrayBufferView value must be a Uint8ClampedArray.",
      );
    }
    const sw = toUnsignedLong(a);
    const sh = toUnsignedLong(b);
    if (sw === 0) {
      throw domException(
        "Failed to construct 'ImageData': The source width is zero or not a number.",
        'IndexSizeError',
      );
    }
    if (sh === 0) {
      throw domException(
        "Failed to construct 'ImageData': The source height is zero or not a number.",
        'IndexSizeError',
      );
    }
    const bytes = sw * sh * 4;
    if (bytes > MAX_BYTES) {
      throw new RangeError(
        "Failed to construct 'ImageData': Out of memory at ImageData creation.",
      );
    }
    this.#colorSpace = parseSettings(c);
    this.#width = sw;
    this.#height = sh;
    this.#data = new Uint8ClampedArray(bytes);
  }

  get width(): number {
    return this.#width;
  }
  get height(): number {
    return this.#height;
  }
  get data(): Uint8ClampedArray {
    return this.#data;
  }
  get colorSpace(): ColorSpace {
    return this.#colorSpace;
  }
  get pixelFormat(): 'rgba-unorm8' {
    return 'rgba-unorm8';
  }

  /** The image-source protocol (source.ts). A detached buffer cannot be used. */
  [IMAGE_SOURCE](): PixelsDescriptor {
    if (this.#data.buffer.byteLength === 0 && this.#data.length === 0) {
      throw domException(
        'The ImageData has been detached.',
        'InvalidStateError',
      );
    }
    return {
      kind: 'pixels',
      origin: 'imagedata',
      width: this.#width,
      height: this.#height,
      premultiplied: false,
      data: this.#data,
    };
  }

  static {
    Object.defineProperty(this.prototype, Symbol.toStringTag, {
      value: 'ImageData',
      configurable: true,
    });
  }
}

/** For structuredClone (WRK-5): ImageData is serializable (copy). */
export function cloneImageData(value: ImageData): ImageData {
  return new ImageData(
    new Uint8ClampedArray(value.data),
    value.width,
    value.height,
    {
      colorSpace: value.colorSpace,
    },
  );
}
