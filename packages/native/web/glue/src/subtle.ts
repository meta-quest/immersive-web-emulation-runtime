/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Digest-only SubtleCrypto (W3C Web Cryptography API §14.3.5 digest; SHA-1/256/384/512 from
// @noble/hashes), NET-STORE-4. Shipped as its own prelude (dist/glue-subtle.min.js, entry
// subtle-entry.ts) so apps that do not enable it do not carry the hash code. It uses the main glue's
// DOMException through the global, so errors are instances of the one global DOMException.

import { sha1 } from '@noble/hashes/legacy.js';
import { sha256, sha384, sha512 } from '@noble/hashes/sha2.js';
import {
  bytesOf,
  enumerable,
  illegalConstructor,
  INTERNAL,
  tag,
} from './util.ts';

function domException(message: string, name: string): Error {
  const D = (
    globalThis as unknown as {
      DOMException: new (m: string, n: string) => Error;
    }
  ).DOMException;
  return new D(message, name);
}

const DIGESTS: Record<string, (data: Uint8Array) => Uint8Array> = {
  'SHA-1': sha1,
  'SHA-256': sha256,
  'SHA-384': sha384,
  'SHA-512': sha512,
};

function normalizeDigestAlgorithm(algorithm: unknown): string {
  let name: unknown = algorithm;
  if (algorithm !== null && typeof algorithm === 'object') {
    name = (algorithm as { name?: unknown }).name;
    if (name === undefined) {
      throw new TypeError(
        "Failed to execute 'digest' on 'SubtleCrypto': Algorithm: name: Missing or not a string",
      );
    }
  }
  const upper = String(name).toUpperCase();
  if (!(upper in DIGESTS)) {
    throw domException(
      "Failed to execute 'digest' on 'SubtleCrypto': Algorithm: Unrecognized name",
      'NotSupportedError',
    );
  }
  return upper;
}

export class SubtleCrypto {
  constructor(token?: unknown) {
    if (token !== INTERNAL) throw illegalConstructor();
  }
  digest(algorithm: unknown, data: unknown): Promise<ArrayBuffer> {
    try {
      if (arguments.length < 2) {
        throw new TypeError(
          `Failed to execute 'digest' on 'SubtleCrypto': 2 arguments required, but only ${arguments.length} present.`,
        );
      }
      const name = normalizeDigestAlgorithm(algorithm);
      // Copy first: the spec snapshots the bytes before the promise is returned.
      const bytes = bytesOf(
        data,
        "Failed to execute 'digest' on 'SubtleCrypto'",
      ).slice();
      const out = DIGESTS[name]!(bytes);
      return Promise.resolve(out.slice().buffer as ArrayBuffer);
    } catch (e) {
      return Promise.reject(e);
    }
  }
}
tag(SubtleCrypto, 'SubtleCrypto');
enumerable(SubtleCrypto, ['digest']);
// The other operations exist on browsers' SubtleCrypto; here they reject so feature detection that
// only checks `crypto.subtle` gets a clear error instead of a TypeError on an undefined member.
for (const op of [
  'encrypt',
  'decrypt',
  'sign',
  'verify',
  'generateKey',
  'deriveKey',
  'deriveBits',
  'importKey',
  'exportKey',
  'wrapKey',
  'unwrapKey',
]) {
  Object.defineProperty(SubtleCrypto.prototype, op, {
    value: function (): Promise<never> {
      return Promise.reject(
        domException(
          `SubtleCrypto.${op} is not supported by this runtime (digest only)`,
          'NotSupportedError',
        ),
      );
    },
    writable: true,
    configurable: true,
    enumerable: true,
  });
}

export function createSubtle(): SubtleCrypto {
  return new SubtleCrypto(INTERNAL);
}
