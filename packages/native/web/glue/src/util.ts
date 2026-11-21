/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/** Install mode: only fill in globals the engine lacks, or replace them all (fidelity runs). */
export type InstallMode = 'missing' | 'all';

/**
 * Defines a global the way WebIDL does for interface objects and operations: writable, configurable,
 * not enumerable. Returns false when the global already exists and `mode` is `missing`.
 */
export function defineGlobal(
  target: object,
  name: string,
  value: unknown,
  mode: InstallMode,
): boolean {
  if (mode === 'missing' && name in target) return false;
  Object.defineProperty(target, name, {
    value,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  return true;
}

/**
 * How assignment to a global attribute behaves (WebIDL §3.7.6):
 * - `readonly`: no setter; assignment is ignored in sloppy code and throws in strict code (window,
 *   navigator, crypto, history, isSecureContext, crossOriginIsolated, WorkerGlobalScope.self/location).
 * - `replaceable`: [Replaceable]; assignment shadows the attribute with a data property (self,
 *   origin, performance, devicePixelRatio on Window).
 * - a function: [PutForwards]; assignment calls it (Window.location forwards to location.href).
 */
export type GlobalSetter =
  | 'readonly'
  | 'replaceable'
  | ((value: unknown) => void);

/** Defines a WebIDL-style accessor attribute on the global. */
export function defineGlobalGetter(
  target: object,
  name: string,
  get: () => unknown,
  mode: InstallMode,
  setter: GlobalSetter = 'readonly',
): boolean {
  if (mode === 'missing' && name in target) return false;
  let set: ((v: unknown) => void) | undefined;
  if (setter === 'replaceable') {
    set = function (v: unknown): void {
      Object.defineProperty(target, name, {
        value: v,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    };
  } else if (typeof setter === 'function') {
    set = setter;
  }
  Object.defineProperty(target, name, {
    get,
    set,
    configurable: true,
    enumerable: true,
  });
  return true;
}

/** Sets `Symbol.toStringTag` on a class prototype as WebIDL does. */
export function tag(ctor: { prototype: object }, name: string): void {
  Object.defineProperty(ctor.prototype, Symbol.toStringTag, {
    value: name,
    configurable: true,
  });
}

/** Makes the listed prototype members enumerable, as WebIDL attributes and operations are. */
export function enumerable(ctor: { prototype: object }, names: string[]): void {
  for (const n of names) {
    const d = Object.getOwnPropertyDescriptor(ctor.prototype, n);
    if (d) {
      d.enumerable = true;
      Object.defineProperty(ctor.prototype, n, d);
    }
  }
}

/** A token constructors check so "illegal constructor" interfaces can still be built internally. */
export const INTERNAL: unique symbol = Symbol('iwn.internal');

export function illegalConstructor(): TypeError {
  return new TypeError('Illegal constructor');
}

/** Returns the bytes of a BufferSource (AllowShared) as a Uint8Array view, without copying. */
export function bytesOf(source: unknown, what: string): Uint8Array {
  // WebIDL "get a copy of the bytes held by the buffer source": a detached buffer holds no bytes.
  if (ArrayBuffer.isView(source)) {
    if ((source.buffer as { detached?: boolean }).detached)
      return new Uint8Array(0);
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  }
  if (
    source instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== 'undefined' &&
      source instanceof SharedArrayBuffer)
  ) {
    if ((source as { detached?: boolean }).detached) return new Uint8Array(0);
    return new Uint8Array(source);
  }
  throw new TypeError(
    `${what}: The provided value is not of type '(ArrayBuffer or ArrayBufferView)'`,
  );
}

export function isBufferSource(source: unknown): boolean {
  return (
    ArrayBuffer.isView(source) ||
    source instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== 'undefined' &&
      source instanceof SharedArrayBuffer)
  );
}

/** WebIDL dictionary argument check: undefined, null or an object (functions are objects). */
export function checkDictionary(v: unknown, message: string): void {
  if (
    v !== undefined &&
    v !== null &&
    typeof v !== 'object' &&
    typeof v !== 'function'
  ) {
    throw new TypeError(message);
  }
}

/** WebIDL DOMString conversion: ToString, except that Symbols throw TypeError. */
export function toDOMString(v: unknown, what: string): string {
  if (typeof v === 'symbol')
    throw new TypeError(`${what}: Cannot convert a Symbol value to a string`);
  return String(v);
}

/** WebIDL USVString conversion: DOMString, then lone surrogates become U+FFFD. */
export function toUSVString(v: unknown, what: string): string {
  const s = toDOMString(v, what);
  return typeof s.toWellFormed === 'function' ? s.toWellFormed() : s;
}

/** WebIDL `unsigned long long` (no [EnforceRange]/[Clamp]): ToNumber, truncate, modulo 2^64. */
export function toUnsignedLongLong(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  let x = Math.trunc(n) % 2 ** 64;
  if (x < 0) x += 2 ** 64;
  return x === 0 ? 0 : x;
}

/** Sets a constructor's `length` to its WebIDL required-argument count. */
export function setLength(fn: Function, n: number): void {
  Object.defineProperty(fn, 'length', {
    value: n,
    writable: false,
    enumerable: false,
    configurable: true,
  });
}
