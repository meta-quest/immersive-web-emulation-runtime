/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// atob / btoa (HTML §8.3 "Base64 utility methods", Infra "forgiving-base64 decode"), NET-16.

import { type DOMException, domException } from './dom-exception.ts';
import { bytesToLatin1 } from './encoding.ts';
import { toDOMString } from './util.ts';

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DECODE = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) DECODE[ALPHABET.charCodeAt(i)] = i;

function invalid(op: 'atob' | 'btoa'): DOMException {
  return domException(
    op === 'atob'
      ? "Failed to execute 'atob' on 'Window': The string to be decoded is not correctly encoded."
      : "Failed to execute 'btoa' on 'Window': The string to be encoded contains characters outside of the Latin1 range.",
    'InvalidCharacterError',
  );
}

// 12-bit index -> two base64 characters as char codes (hi << 8 | lo).
const PAIRS = new Uint16Array(4096);
for (let i = 0; i < 4096; i++)
  PAIRS[i] = (ALPHABET.charCodeAt(i >> 6) << 8) | ALPHABET.charCodeAt(i & 63);

/**
 * Standard base64 (RFC 4648 §4, padded) of `n` code units read by `at` (each 0..255). Writes ASCII
 * codes into a byte buffer and converts it in chunks: building the string four characters at a time
 * was ~7x slower on large inputs.
 */
function encodeUnits(n: number, at: (i: number) => number): string {
  const out = new Uint8Array(Math.ceil(n / 3) * 4);
  let o = 0;
  let i = 0;
  for (; i + 2 < n; i += 3) {
    const v = (at(i) << 16) | (at(i + 1) << 8) | at(i + 2);
    const a = PAIRS[v >> 12]!;
    const b = PAIRS[v & 0xfff]!;
    out[o++] = a >> 8;
    out[o++] = a & 0xff;
    out[o++] = b >> 8;
    out[o++] = b & 0xff;
  }
  if (i < n) {
    const v = (at(i) << 16) | (i + 1 < n ? at(i + 1) << 8 : 0);
    out[o++] = ALPHABET.charCodeAt(v >> 18);
    out[o++] = ALPHABET.charCodeAt((v >> 12) & 63);
    out[o++] = i + 1 < n ? ALPHABET.charCodeAt((v >> 6) & 63) : 61;
    out[o++] = 61;
  }
  return bytesToLatin1(out);
}

/** Standard base64 of bytes (readAsDataURL, the glue registry's base64Encode). */
export function base64Encode(bytes: Uint8Array): string {
  return encodeUnits(bytes.length, (i) => bytes[i]!);
}

export function btoa(data: string): string {
  if (arguments.length === 0) {
    throw new TypeError(
      "Failed to execute 'btoa' on 'Window': 1 argument required, but only 0 present.",
    );
  }
  const s = toDOMString(data, "Failed to execute 'btoa' on 'Window'");
  return encodeUnits(s.length, (k) => {
    const c = s.charCodeAt(k);
    if (c > 0xff) throw invalid('btoa');
    return c;
  });
}

export function atob(data: string): string {
  if (arguments.length === 0) {
    throw new TypeError(
      "Failed to execute 'atob' on 'Window': 1 argument required, but only 0 present.",
    );
  }
  // Forgiving-base64 decode: strip ASCII whitespace, drop up to two trailing '=' when the length is a
  // multiple of 4, reject length % 4 == 1 and any non-alphabet code point.
  let s = toDOMString(data, "Failed to execute 'atob' on 'Window'").replace(
    /[\t\n\f\r ]+/g,
    '',
  );
  if (s.length % 4 === 0) {
    if (s.endsWith('==')) s = s.slice(0, -2);
    else if (s.endsWith('=')) s = s.slice(0, -1);
  }
  const n = s.length;
  if (n % 4 === 1) throw invalid('atob');
  const out = new Uint8Array((n * 3) >> 2);
  let o = 0;
  let i = 0;
  const val = (k: number): number => {
    const c = s.charCodeAt(k);
    const v = c < 128 ? DECODE[c]! : -1;
    if (v < 0) throw invalid('atob');
    return v;
  };
  for (; i + 3 < n; i += 4) {
    const v =
      (val(i) << 18) | (val(i + 1) << 12) | (val(i + 2) << 6) | val(i + 3);
    out[o++] = v >> 16;
    out[o++] = (v >> 8) & 0xff;
    out[o++] = v & 0xff;
  }
  const rest = n - i;
  if (rest >= 2) {
    // Discard the bits that do not make a whole byte (forgiving-base64 step 8).
    const v =
      (val(i) << 18) | (val(i + 1) << 12) | (rest === 3 ? val(i + 2) << 6 : 0);
    out[o++] = v >> 16;
    if (rest === 3) out[o++] = (v >> 8) & 0xff;
  }
  return bytesToLatin1(out.subarray(0, o));
}
