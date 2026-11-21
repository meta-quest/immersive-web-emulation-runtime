/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// ImageBitmap (HTML §8.10, IMG-6, IMG-7): a JS wrapper over a native pixel handle. The pixels live outside the JS
// heap and are reported to V8 as external memory by the native module; close() frees them at once.

import type { ImageNatives, NativeImageHandle } from './natives.ts';
import { type HandleDescriptor, IMAGE_SOURCE } from './source.ts';

const CREATE = Symbol('iwn.image.bitmap.create');

interface Slot {
  handle: NativeImageHandle | null;
  natives: ImageNatives;
}
const slots = new WeakMap<object, Slot>();

let domException: (message: string, name: string) => Error = (m, n) => {
  const e = new Error(m);
  e.name = n;
  return e;
};
export function setImageBitmapErrors(make: (message: string, name: string) => Error): void {
  domException = make;
}

export class ImageBitmap {
  constructor(token?: unknown) {
    if (token !== CREATE) throw new TypeError('Illegal constructor');
  }

  get width(): number {
    const slot = slots.get(this);
    if (!slot) throw new TypeError('Illegal invocation');
    return slot.handle ? slot.handle.width : 0;
  }

  get height(): number {
    const slot = slots.get(this);
    if (!slot) throw new TypeError('Illegal invocation');
    return slot.handle ? slot.handle.height : 0;
  }

  close(): void {
    const slot = slots.get(this);
    if (!slot) throw new TypeError('Illegal invocation');
    if (slot.handle) {
      slot.natives.close(slot.handle);
      slot.handle = null;
    }
  }

  /** The image-source protocol (source.ts). Uploading a closed bitmap throws InvalidStateError (IMG-6, GL-17). */
  [IMAGE_SOURCE](): HandleDescriptor {
    const slot = slots.get(this);
    if (!slot) throw new TypeError('Illegal invocation');
    const h = slot.handle;
    if (!h || h.width === 0) throw domException('The image source is detached (the ImageBitmap was closed).', 'InvalidStateError');
    return { kind: 'handle', origin: 'bitmap', width: h.width, height: h.height, premultiplied: h.premultiplied, handle: h };
  }

  static {
    Object.defineProperty(this.prototype, Symbol.toStringTag, { value: 'ImageBitmap', configurable: true });
    for (const name of ['width', 'height', 'close']) {
      const d = Object.getOwnPropertyDescriptor(this.prototype, name);
      if (d) Object.defineProperty(this.prototype, name, { ...d, enumerable: true });
    }
  }
}

/** Wraps a native handle (the bitmap owns it from now on). */
export function wrapBitmap(handle: NativeImageHandle, natives: ImageNatives): ImageBitmap {
  const bitmap = new ImageBitmap(CREATE);
  slots.set(bitmap, { handle, natives });
  return bitmap;
}

/** The live handle behind a bitmap, or null when closed / not a bitmap. */
export function bitmapHandle(value: unknown): NativeImageHandle | null {
  if (typeof value !== 'object' || value === null) return null;
  const h = slots.get(value)?.handle ?? null;
  return h && h.width > 0 ? h : null;
}

export function isImageBitmap(value: unknown): value is ImageBitmap {
  return typeof value === 'object' && value !== null && slots.has(value);
}

// --- structured clone / transfer (WRK-5) ---------------------------------------------------------------------------
// Registered with the glue's clone registry by install.ts when available, and used by the worker stream's
// serializer for cross-isolate transfer.

/** structuredClone(bitmap): a new bitmap on the same pixels (serializable, HTML §8.10). */
export function cloneBitmap(value: ImageBitmap): ImageBitmap {
  const slot = slots.get(value);
  if (!slot?.handle || slot.handle.width === 0) {
    throw domException('An ImageBitmap is detached and could not be cloned.', 'DataCloneError');
  }
  return wrapBitmap(slot.natives.share(slot.handle), slot.natives);
}

/** Same-realm transfer: the original is detached (width/height 0), the result owns the pixels. */
export function transferBitmap(value: ImageBitmap): ImageBitmap {
  const slot = slots.get(value);
  if (!slot?.handle || slot.handle.width === 0) {
    throw domException('An ImageBitmap is detached and could not be transferred.', 'DataCloneError');
  }
  const handle = slot.handle;
  slot.handle = null;
  return wrapBitmap(handle, slot.natives);
}

/** Cross-isolate transfer, sender side: detaches and returns a token for importBitmap() in the receiving isolate. */
export function exportBitmap(value: ImageBitmap): { iwnImageBitmap: number } {
  const slot = slots.get(value);
  if (!slot?.handle || slot.handle.width === 0) {
    throw domException('An ImageBitmap is detached and could not be transferred.', 'DataCloneError');
  }
  const id = slot.natives.exportTransfer(slot.handle);
  slot.handle = null;
  return { iwnImageBitmap: id };
}

/** Cross-isolate transfer, receiver side. */
export function importBitmap(token: { iwnImageBitmap: number }, natives: ImageNatives): ImageBitmap {
  const handle = natives.importTransfer(token.iwnImageBitmap);
  if (!handle) throw domException('The transferred ImageBitmap is no longer available.', 'DataCloneError');
  return wrapBitmap(handle, natives);
}
