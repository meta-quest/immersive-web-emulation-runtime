/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// TextEncoder / TextDecoder (Encoding Standard §7-§9, §14.1 windows-1252, §14.3 UTF-16) for NET-16:
// UTF-8 (fatal, ignoreBOM, streaming), UTF-16LE/BE and windows-1252 (which the standard maps the
// latin1 / ascii / iso-8859-1 labels to). Other legacy encodings throw RangeError (documented gap;
// established full-coverage libraries carry hundreds of KB of tables). An optional native UTF-8 path
// (`__iwn.encoding`) handles whole-buffer decodes and encodes.

import type { GlueNatives } from './natives.ts';
// encode/encodeInto take USVString; the UTF-8 encoder replaces lone surrogates itself, so DOMString
// conversion gives the same bytes without a toWellFormed() copy.
import { bytesOf, checkDictionary, enumerable, tag, toDOMString } from './util.ts';

type Enc = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';

const LABELS: Record<string, Enc | 'replacement'> = Object.create(null);
function labels(enc: Enc | 'replacement', names: string[]): void {
  for (const n of names) LABELS[n] = enc;
}
labels('utf-8', [
  'unicode-1-1-utf-8',
  'unicode11utf8',
  'unicode20utf8',
  'utf-8',
  'utf8',
  'x-unicode20utf8',
]);
labels('utf-16le', [
  'csunicode',
  'iso-10646-ucs-2',
  'ucs-2',
  'unicode',
  'unicodefeff',
  'utf-16',
  'utf-16le',
]);
labels('utf-16be', ['unicodefffe', 'utf-16be']);
labels('windows-1252', [
  'ansi_x3.4-1968',
  'ascii',
  'cp1252',
  'cp819',
  'csisolatin1',
  'ibm819',
  'iso-8859-1',
  'iso-ir-100',
  'iso8859-1',
  'iso88591',
  'iso_8859-1',
  'iso_8859-1:1987',
  'l1',
  'latin1',
  'us-ascii',
  'windows-1252',
  'x-cp1252',
]);
labels('replacement', [
  'csiso2022kr',
  'hz-gb-2312',
  'iso-2022-cn',
  'iso-2022-cn-ext',
  'iso-2022-kr',
  'replacement',
]);

/** Encoding Standard "get an encoding": trims ASCII whitespace, lower-cases ASCII. */
export function getEncoding(label: string): Enc | 'replacement' | null {
  const key = label.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '').toLowerCase();
  return LABELS[key] ?? null;
}

// windows-1252 bytes 0x80..0x9F (the index-windows-1252 entries that differ from ISO-8859-1).
const CP1252 = new Uint16Array([
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f, 0x0090, 0x2018, 0x2019, 0x201c,
  0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d,
  0x017e, 0x0178,
]);

const CHUNK = 0x2000;
function unitsToString(units: Uint16Array, length: number): string {
  if (length <= CHUNK) {
    return String.fromCharCode.apply(
      null,
      units.subarray(0, length) as unknown as number[],
    );
  }
  let out = '';
  for (let i = 0; i < length; i += CHUNK) {
    out += String.fromCharCode.apply(
      null,
      units.subarray(i, Math.min(i + CHUNK, length)) as unknown as number[],
    );
  }
  return out;
}

/** Bytes as a string of the same code units (latin1 / isomorphic decode), in chunks. */
export function bytesToLatin1(bytes: Uint8Array): string {
  const n = bytes.length;
  if (n <= CHUNK) return String.fromCharCode.apply(null, bytes as unknown as number[]);
  let out = '';
  for (let i = 0; i < n; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, n)) as unknown as number[]);
  }
  return out;
}

class DecodeError extends Error {}

interface Decoder {
  /** Decodes `bytes`; `flush` ends the stream. Throws DecodeError on error when fatal. */
  decode(bytes: Uint8Array, flush: boolean, fatal: boolean): string;
}

class Utf8Decoder implements Decoder {
  cp = 0;
  seen = 0;
  needed = 0;
  lower = 0x80;
  upper = 0xbf;

  get idle(): boolean {
    return this.needed === 0;
  }

  decode(bytes: Uint8Array, flush: boolean, fatal: boolean): string {
    // ASCII fast path: a leading run of bytes < 0x80 decodes to the same code units.
    if (this.needed === 0) {
      const n = bytes.length;
      let k = 0;
      while (k < n && bytes[k]! < 0x80) k++;
      if (k === n) return bytesToLatin1(bytes);
      if (k >= 64) return bytesToLatin1(bytes.subarray(0, k)) + this.decodeFrom(bytes.subarray(k), flush, fatal);
    }
    return this.decodeFrom(bytes, flush, fatal);
  }

  private decodeFrom(bytes: Uint8Array, flush: boolean, fatal: boolean): string {
    const n = bytes.length;
    const out = new Uint16Array(n + 2);
    let o = 0;
    let { cp, seen, needed, lower, upper } = this;
    let i = 0;
    while (i < n) {
      const b = bytes[i]!;
      if (needed === 0) {
        i++;
        if (b < 0x80) {
          out[o++] = b;
        } else if (b >= 0xc2 && b <= 0xdf) {
          needed = 1;
          cp = b & 0x1f;
        } else if (b >= 0xe0 && b <= 0xef) {
          if (b === 0xe0) lower = 0xa0;
          else if (b === 0xed) upper = 0x9f;
          needed = 2;
          cp = b & 0xf;
        } else if (b >= 0xf0 && b <= 0xf4) {
          if (b === 0xf0) lower = 0x90;
          else if (b === 0xf4) upper = 0x8f;
          needed = 3;
          cp = b & 0x7;
        } else {
          if (fatal) throw new DecodeError();
          out[o++] = 0xfffd;
        }
        continue;
      }
      if (b < lower || b > upper) {
        // Not consumed: the byte is processed again as the start of a new sequence.
        cp = seen = needed = 0;
        lower = 0x80;
        upper = 0xbf;
        if (fatal) throw new DecodeError();
        out[o++] = 0xfffd;
        continue;
      }
      i++;
      lower = 0x80;
      upper = 0xbf;
      cp = (cp << 6) | (b & 0x3f);
      if (++seen === needed) {
        if (cp > 0xffff) {
          cp -= 0x10000;
          out[o++] = 0xd800 | (cp >> 10);
          out[o++] = 0xdc00 | (cp & 0x3ff);
        } else {
          out[o++] = cp;
        }
        cp = seen = needed = 0;
      }
    }
    if (flush && needed !== 0) {
      cp = seen = needed = 0;
      lower = 0x80;
      upper = 0xbf;
      if (fatal) throw new DecodeError();
      out[o++] = 0xfffd;
    }
    this.cp = cp;
    this.seen = seen;
    this.needed = needed;
    this.lower = lower;
    this.upper = upper;
    return unitsToString(out, o);
  }
}

class Utf16Decoder implements Decoder {
  leadByte = -1;
  leadSurrogate = -1;
  readonly be: boolean;
  constructor(be: boolean) {
    this.be = be;
  }

  decode(bytes: Uint8Array, flush: boolean, fatal: boolean): string {
    const out = new Uint16Array(((bytes.length + 1) >> 1) + 2);
    let o = 0;
    let { leadByte, leadSurrogate } = this;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]!;
      if (leadByte < 0) {
        leadByte = b;
        continue;
      }
      const cu = this.be ? (leadByte << 8) | b : leadByte | (b << 8);
      leadByte = -1;
      if (leadSurrogate >= 0) {
        const lead = leadSurrogate;
        leadSurrogate = -1;
        if (cu >= 0xdc00 && cu <= 0xdfff) {
          out[o++] = lead;
          out[o++] = cu;
          continue;
        }
        if (fatal) throw new DecodeError();
        out[o++] = 0xfffd;
        // The code unit is processed again below.
      }
      if (cu >= 0xd800 && cu <= 0xdbff) {
        leadSurrogate = cu;
      } else if (cu >= 0xdc00 && cu <= 0xdfff) {
        if (fatal) throw new DecodeError();
        out[o++] = 0xfffd;
      } else {
        out[o++] = cu;
      }
    }
    if (flush && (leadByte >= 0 || leadSurrogate >= 0)) {
      leadByte = leadSurrogate = -1;
      if (fatal) throw new DecodeError();
      out[o++] = 0xfffd;
    }
    this.leadByte = leadByte;
    this.leadSurrogate = leadSurrogate;
    return unitsToString(out, o);
  }
}

class Cp1252Decoder implements Decoder {
  decode(bytes: Uint8Array): string {
    const out = new Uint16Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]!;
      out[i] = b >= 0x80 && b <= 0x9f ? CP1252[b - 0x80]! : b;
    }
    return unitsToString(out, bytes.length);
  }
}

function newDecoder(enc: Enc): Decoder {
  switch (enc) {
    case 'utf-8':
      return new Utf8Decoder();
    case 'utf-16le':
      return new Utf16Decoder(false);
    case 'utf-16be':
      return new Utf16Decoder(true);
    case 'windows-1252':
      return new Cp1252Decoder();
  }
}

let nativeEncoding: GlueNatives['encoding'] | undefined;
/** Wired by the installer. */
export function setNativeEncoding(n: GlueNatives['encoding'] | undefined): void {
  nativeEncoding = n;
}

export interface TextDecoderOptions {
  fatal?: boolean;
  ignoreBOM?: boolean;
}

export class TextDecoder {
  #encoding: Enc;
  #fatal: boolean;
  #ignoreBOM: boolean;
  #decoder: Decoder;
  #doNotFlush = false;
  #bomSeen = false;

  constructor(label: string = 'utf-8', options?: TextDecoderOptions | null) {
    checkDictionary(options, "Failed to construct 'TextDecoder': The provided value is not of type 'TextDecoderOptions'.");
    const enc = getEncoding(toDOMString(label, "Failed to construct 'TextDecoder'"));
    if (enc === null || enc === 'replacement') {
      throw new RangeError(
        `Failed to construct 'TextDecoder': The encoding label provided ('${String(label)}') is invalid.`,
      );
    }
    this.#encoding = enc;
    this.#fatal = !!options?.fatal;
    this.#ignoreBOM = !!options?.ignoreBOM;
    this.#decoder = newDecoder(enc);
  }

  get encoding(): string {
    return this.#encoding;
  }
  get fatal(): boolean {
    return this.#fatal;
  }
  get ignoreBOM(): boolean {
    return this.#ignoreBOM;
  }

  decode(input?: ArrayBufferView | ArrayBuffer, options?: { stream?: boolean }): string {
    checkDictionary(options, "Failed to execute 'decode' on 'TextDecoder': The provided value is not of type 'TextDecodeOptions'.");
    if (!this.#doNotFlush) {
      this.#decoder = newDecoder(this.#encoding);
      this.#bomSeen = false;
    }
    const stream = !!options?.stream;
    this.#doNotFlush = stream;
    const bytes =
      input === undefined ? new Uint8Array(0) : bytesOf(input, "Failed to execute 'decode' on 'TextDecoder'");
    let out: string;
    const dec = this.#decoder;
    if (
      nativeEncoding &&
      !stream &&
      dec instanceof Utf8Decoder &&
      dec.idle &&
      bytes.length >= 256
    ) {
      const s = nativeEncoding.decodeUtf8(bytes, this.#fatal);
      if (s === null) throw this.#error();
      out = s;
    } else {
      try {
        out = dec.decode(bytes, !stream, this.#fatal);
      } catch (e) {
        if (e instanceof DecodeError) {
          this.#decoder = newDecoder(this.#encoding);
          this.#doNotFlush = false;
          throw this.#error();
        }
        throw e;
      }
    }
    if (
      !this.#ignoreBOM &&
      !this.#bomSeen &&
      out.length > 0 &&
      this.#encoding !== 'windows-1252'
    ) {
      this.#bomSeen = true;
      if (out.charCodeAt(0) === 0xfeff) out = out.slice(1);
    }
    return out;
  }

  #error(): TypeError {
    return new TypeError(
      `Failed to execute 'decode' on 'TextDecoder': The encoded data was not valid for encoding ${this.#encoding}`,
    );
  }
}
tag(TextDecoder, 'TextDecoder');
enumerable(TextDecoder, ['encoding', 'fatal', 'ignoreBOM', 'decode']);

/** UTF-8 encode of a string (lone surrogates become U+FFFD), in JS. */
export function utf8Encode(input: string): Uint8Array {
  const n = input.length;
  // ASCII fast path.
  let i = 0;
  for (; i < n; i++) if (input.charCodeAt(i) > 0x7f) break;
  if (i === n) {
    const out = new Uint8Array(n);
    for (let j = 0; j < n; j++) out[j] = input.charCodeAt(j);
    return out;
  }
  const out = new Uint8Array(n * 3);
  for (let j = 0; j < i; j++) out[j] = input.charCodeAt(j);
  const r = encodeIntoImpl(input, i, out, i);
  return out.slice(0, i + r.written);
}

function encodeIntoImpl(
  s: string,
  start: number,
  dest: Uint8Array,
  destStart: number,
): { read: number; written: number } {
  const n = s.length;
  const cap = dest.length;
  let i = start;
  let o = destStart;
  while (i < n) {
    let c = s.charCodeAt(i);
    let units = 1;
    if (c >= 0xd800 && c <= 0xdfff) {
      if (c <= 0xdbff && i + 1 < n) {
        const d = s.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) {
          c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
          units = 2;
        } else {
          c = 0xfffd;
        }
      } else {
        c = 0xfffd;
      }
    }
    if (c < 0x80) {
      if (o + 1 > cap) break;
      dest[o++] = c;
    } else if (c < 0x800) {
      if (o + 2 > cap) break;
      dest[o++] = 0xc0 | (c >> 6);
      dest[o++] = 0x80 | (c & 0x3f);
    } else if (c < 0x10000) {
      if (o + 3 > cap) break;
      dest[o++] = 0xe0 | (c >> 12);
      dest[o++] = 0x80 | ((c >> 6) & 0x3f);
      dest[o++] = 0x80 | (c & 0x3f);
    } else {
      if (o + 4 > cap) break;
      dest[o++] = 0xf0 | (c >> 18);
      dest[o++] = 0x80 | ((c >> 12) & 0x3f);
      dest[o++] = 0x80 | ((c >> 6) & 0x3f);
      dest[o++] = 0x80 | (c & 0x3f);
    }
    i += units;
  }
  return { read: i - start, written: o - destStart };
}

export class TextEncoder {
  get encoding(): string {
    return 'utf-8';
  }
  encode(input: string = ''): Uint8Array {
    const s = toDOMString(input, "Failed to execute 'encode' on 'TextEncoder'");
    if (nativeEncoding && s.length >= 256) return nativeEncoding.encodeUtf8(s);
    return utf8Encode(s);
  }
  encodeInto(source: string, destination: Uint8Array): { read: number; written: number } {
    if (arguments.length < 2) {
      throw new TypeError(
        `Failed to execute 'encodeInto' on 'TextEncoder': 2 arguments required, but only ${arguments.length} present.`,
      );
    }
    if (!(destination instanceof Uint8Array)) {
      throw new TypeError(
        "Failed to execute 'encodeInto' on 'TextEncoder': parameter 2 is not of type 'Uint8Array'.",
      );
    }
    return encodeIntoImpl(toDOMString(source, "Failed to execute 'encodeInto' on 'TextEncoder'"), 0, destination, 0);
  }
}
tag(TextEncoder, 'TextEncoder');
enumerable(TextEncoder, ['encoding', 'encode', 'encodeInto']);
