/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// `crypto` (W3C Web Cryptography API §10-§14): getRandomValues over the native CSPRNG hook and
// randomUUID (RFC 9562 v4). The optional digest-only SubtleCrypto is a separate prelude
// (subtle.ts, dist/glue-subtle.min.js), so @noble/hashes is not in the main bundle. NET-STORE-4.

import { domException } from './dom-exception.ts';
import type { GlueNatives } from './natives.ts';
import { enumerable, illegalConstructor, INTERNAL, tag } from './util.ts';

const MAX_RANDOM_BYTES = 65536;

let fill: ((bytes: Uint8Array) => void) | null = null;
export function setRandomSource(n: GlueNatives['crypto'] | undefined): void {
  fill = n ? (b) => n.random(b) : null;
}

function isIntegerTypedArray(v: unknown): v is ArrayBufferView {
  return (
    v instanceof Int8Array ||
    v instanceof Uint8Array ||
    v instanceof Uint8ClampedArray ||
    v instanceof Int16Array ||
    v instanceof Uint16Array ||
    v instanceof Int32Array ||
    v instanceof Uint32Array ||
    v instanceof BigInt64Array ||
    v instanceof BigUint64Array
  );
}

/** Whether the native CSPRNG hook is present. */
export function hasRandomSource(): boolean {
  return fill !== null;
}

export function getRandomValues<T extends ArrayBufferView | null>(array: T): T {
  if (!isIntegerTypedArray(array)) {
    if (ArrayBuffer.isView(array)) {
      throw domException(
        "Failed to execute 'getRandomValues' on 'Crypto': The provided ArrayBufferView is of type '" +
          (array as object).constructor.name +
          "', which is not an integer array type.",
        'TypeMismatchError',
      );
    }
    throw new TypeError(
      "Failed to execute 'getRandomValues' on 'Crypto': parameter 1 is not of type 'ArrayBufferView'.",
    );
  }
  if (array.byteLength > MAX_RANDOM_BYTES) {
    throw domException(
      `Failed to execute 'getRandomValues' on 'Crypto': The ArrayBufferView's byte length (${array.byteLength}) exceeds the number of bytes of entropy available via this API (${MAX_RANDOM_BYTES}).`,
      'QuotaExceededError',
    );
  }
  if (!fill) {
    // Never fall back to Math.random: callers rely on this being a CSPRNG.
    throw domException(
      'crypto.getRandomValues: no native random source (__iwn.crypto.random) in this runtime',
      'OperationError',
    );
  }
  if (array.byteLength > 0) {
    fill(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
  }
  return array;
}

const HEX: string[] = [];
for (let i = 0; i < 256; i++) HEX.push((i + 0x100).toString(16).slice(1));

export function randomUUID(): string {
  const b = getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  return (
    HEX[b[0]!]! +
    HEX[b[1]!]! +
    HEX[b[2]!]! +
    HEX[b[3]!]! +
    '-' +
    HEX[b[4]!]! +
    HEX[b[5]!]! +
    '-' +
    HEX[b[6]!]! +
    HEX[b[7]!]! +
    '-' +
    HEX[b[8]!]! +
    HEX[b[9]!]! +
    '-' +
    HEX[b[10]!]! +
    HEX[b[11]!]! +
    HEX[b[12]!]! +
    HEX[b[13]!]! +
    HEX[b[14]!]! +
    HEX[b[15]!]!
  );
}

let setSubtleOf: (c: Crypto, s: object) => void;
let subtleOf: (c: Crypto) => object | undefined;

export class Crypto {
  #subtle: object | undefined;
  constructor(token?: unknown) {
    if (token !== INTERNAL) throw illegalConstructor();
  }
  static {
    setSubtleOf = (c, s) => {
      c.#subtle = s;
    };
    subtleOf = (c) => c.#subtle;
  }
  getRandomValues<T extends ArrayBufferView | null>(array: T): T {
    if (!(this instanceof Crypto)) throw new TypeError('Illegal invocation');
    return getRandomValues(array);
  }
  randomUUID(): string {
    if (!(this instanceof Crypto)) throw new TypeError('Illegal invocation');
    return randomUUID();
  }
}
tag(Crypto, 'Crypto');
enumerable(Crypto, ['getRandomValues', 'randomUUID']);

export function createCrypto(): Crypto {
  // NET-STORE-4: without SubtleCrypto, `'subtle' in crypto` is false, as feature detection expects.
  return new Crypto(INTERNAL);
}

/** Gives `crypto` a `subtle` attribute (called by the glue-subtle prelude through the registry). */
export function attachSubtle(crypto: Crypto, subtle: object): void {
  setSubtleOf(crypto, subtle);
  if (!Object.getOwnPropertyDescriptor(Crypto.prototype, 'subtle')) {
    Object.defineProperty(Crypto.prototype, 'subtle', {
      get(this: Crypto) {
        if (!(this instanceof Crypto))
          throw new TypeError('Illegal invocation');
        return subtleOf(this);
      },
      enumerable: true,
      configurable: true,
    });
  }
}
