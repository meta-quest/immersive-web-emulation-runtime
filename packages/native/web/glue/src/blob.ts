/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Blob, File, FileReader and the blob URL store (W3C File API §3-§8) for NET-14 / NET-15.
// A Blob holds one immutable byte array; slice() shares it. Other glue (fetch, image decode, module
// and worker loading) reads bytes synchronously with `blobBytes()` and resolves `blob:` URLs through
// the `BlobURLStore` published on the glue registry (see registry.ts).

import { type DOMException, domException } from './dom-exception.ts';
import { base64Encode } from './base64.ts';
import { bytesToLatin1, TextDecoder, getEncoding, utf8Encode } from './encoding.ts';

export { base64Encode };
import {
  defineEventHandler,
  dispatchTrusted,
  EventTarget,
  ProgressEvent,
} from './events.ts';
import type { GlueNatives } from './natives.ts';
import { bytesOf, enumerable, isBufferSource, setLength, tag, toDOMString, toUSVString } from './util.ts';

export interface BlobPropertyBag {
  type?: string;
  endings?: 'transparent' | 'native';
}

export interface FilePropertyBag extends BlobPropertyBag {
  lastModified?: number;
}

const EMPTY = new Uint8Array(0);

function normalizeType(type: unknown): string {
  if (type === undefined) return '';
  const t = toDOMString(type, 'Blob type');
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return '';
  }
  return t.toLowerCase();
}

function convertLineEndingsToNative(s: string): string {
  // Android is POSIX: the native line ending is LF.
  return s.replace(/\r\n?/g, '\n');
}

let blobInternals!: {
  bytes(b: Blob): Uint8Array;
  make(bytes: Uint8Array, type: string): Blob;
};

let readableStreamCtor: () => unknown = () =>
  (globalThis as { ReadableStream?: unknown }).ReadableStream;

export class Blob {
  #bytes: Uint8Array;
  #type: string;

  constructor(blobParts?: Iterable<unknown> | null, options?: BlobPropertyBag | null) {
    this.#type = '';
    this.#bytes = EMPTY;
    if (blobParts === (MAKE as unknown)) return;
    if (options != null && typeof options !== 'object' && typeof options !== 'function') {
      throw new TypeError(
        "Failed to construct 'Blob': The provided value is not of type 'BlobPropertyBag'.",
      );
    }
    const endings = options?.endings === undefined ? 'transparent' : toDOMString(options.endings, "Failed to construct 'Blob'");
    if (endings !== 'transparent' && endings !== 'native') {
      throw new TypeError(
        `Failed to construct 'Blob': The provided value '${endings}' is not a valid enum value of type EndingType.`,
      );
    }
    this.#type = normalizeType(options?.type);
    if (blobParts === undefined || blobParts === null) {
      if (blobParts === null) {
        throw new TypeError(
          "Failed to construct 'Blob': The provided value cannot be converted to a sequence.",
        );
      }
      return;
    }
    if (
      typeof blobParts !== 'object' ||
      typeof (blobParts as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== 'function'
    ) {
      throw new TypeError(
        "Failed to construct 'Blob': The provided value cannot be converted to a sequence.",
      );
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (const part of blobParts) {
      let bytes: Uint8Array;
      if (part instanceof Blob) {
        bytes = part.#bytes;
      } else if (isBufferSource(part)) {
        bytes = bytesOf(part, "Failed to construct 'Blob'").slice();
      } else {
        let s = toDOMString(part, "Failed to construct 'Blob'"); // USVString: utf8Encode replaces lone surrogates
        if (endings === 'native') s = convertLineEndingsToNative(s);
        bytes = utf8Encode(s);
      }
      chunks.push(bytes);
      total += bytes.length;
    }
    if (chunks.length === 1) {
      // One part: a Blob part can be shared (immutable); buffer parts were already copied.
      this.#bytes = chunks[0]!;
    } else if (total > 0) {
      const all = new Uint8Array(total);
      let o = 0;
      for (const c of chunks) {
        all.set(c, o);
        o += c.length;
      }
      this.#bytes = all;
    }
  }

  static {
    blobInternals = {
      bytes: (b) => b.#bytes,
      make: (bytes, type) => {
        const b = new Blob(MAKE as unknown as Iterable<unknown>);
        b.#bytes = bytes;
        b.#type = type;
        return b;
      },
    };
  }

  get size(): number {
    return this.#bytes.length;
  }
  get type(): string {
    return this.#type;
  }

  slice(start?: number, end?: number, contentType?: string): Blob {
    const size = this.#bytes.length;
    const rel = (v: number | undefined, dflt: number): number => {
      if (v === undefined) return dflt;
      const n = clampLongLong(v);
      return n < 0 ? Math.max(size + n, 0) : Math.min(n, size);
    };
    const from = rel(start, 0);
    const to = rel(end, size);
    const span = Math.max(to - from, 0);
    return blobInternals.make(
      this.#bytes.subarray(from, from + span),
      normalizeType(contentType),
    );
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    return Promise.resolve(this.#bytes.slice().buffer);
  }
  bytes(): Promise<Uint8Array> {
    return Promise.resolve(this.#bytes.slice());
  }
  text(): Promise<string> {
    return Promise.resolve(new TextDecoder().decode(this.#bytes));
  }
  stream(): unknown {
    const RS = readableStreamCtor() as
      | (new (source: object) => unknown)
      | undefined;
    if (typeof RS !== 'function') {
      throw domException(
        'Blob.stream() needs ReadableStream, which this runtime does not provide yet',
        'NotSupportedError',
      );
    }
    const bytes = this.#bytes;
    return new RS({
      type: 'bytes',
      start(controller: { enqueue(c: Uint8Array): void; close(): void }) {
        if (bytes.length > 0) controller.enqueue(bytes.slice());
        controller.close();
      },
    });
  }
}
const MAKE = Symbol('iwn.blob.make');
setLength(Blob, 0);

/** WebIDL [Clamp] long long: NaN is 0, clamp to range, round to nearest with ties to even. */
function clampLongLong(v: unknown): number {
  let x = Number(v);
  if (Number.isNaN(x)) return 0;
  x = Math.min(Math.max(x, -(2 ** 63)), 2 ** 63 - 1);
  const f = Math.floor(x);
  const d = x - f;
  const r = d < 0.5 ? f : d > 0.5 ? f + 1 : f % 2 === 0 ? f : f + 1;
  return r === 0 ? 0 : r;
}

/** WebIDL long long (no [Clamp]/[EnforceRange]): non-finite is 0, truncate, wrap modulo 2^64. */
function toLongLong(v: unknown): number {
  const x = Number(v);
  if (!Number.isFinite(x)) return 0;
  const t = Math.trunc(x);
  if (Math.abs(t) <= Number.MAX_SAFE_INTEGER) return t === 0 ? 0 : t;
  return Number(BigInt.asIntN(64, BigInt(t)));
}
tag(Blob, 'Blob');
enumerable(Blob, ['size', 'type', 'slice', 'arrayBuffer', 'bytes', 'text', 'stream']);

/** The bytes of a Blob, without copying. Do not mutate. */
export function blobBytes(blob: Blob): Uint8Array {
  return blobInternals.bytes(blob);
}

/** Wraps bytes (not copied; the caller gives up ownership) in a Blob. */
export function blobFromBytes(bytes: Uint8Array, type = ''): Blob {
  return blobInternals.make(bytes, normalizeType(type));
}

export class File extends Blob {
  #name: string;
  #lastModified: number;
  constructor(fileBits: Iterable<unknown>, fileName: string, options?: FilePropertyBag | null) {
    if (arguments.length < 2) {
      throw new TypeError(
        `Failed to construct 'File': 2 arguments required, but only ${arguments.length} present.`,
      );
    }
    super(fileBits, options);
    this.#name = toUSVString(fileName, "Failed to construct 'File'");
    this.#lastModified = options?.lastModified === undefined ? Date.now() : toLongLong(options.lastModified);
  }
  get name(): string {
    return this.#name;
  }
  get lastModified(): number {
    return this.#lastModified;
  }
  get webkitRelativePath(): string {
    return '';
  }
}
tag(File, 'File');
setLength(File, 2);
enumerable(File, ['name', 'lastModified', 'webkitRelativePath']);

// ---------------------------------------------------------------------------------------------------
// FileReader (File API §7)

function queueTask(fn: () => void): void {
  const st = (globalThis as { setTimeout?: (cb: () => void, ms: number) => unknown }).setTimeout;
  if (typeof st === 'function') st(fn, 0);
  else Promise.resolve().then(fn);
}

type ReadKind = 'arraybuffer' | 'binary' | 'text' | 'dataurl';

export class FileReader extends EventTarget {
  // Defined below as non-writable, non-configurable constants (WebIDL), not as class fields.
  declare static readonly EMPTY: 0;
  declare static readonly LOADING: 1;
  declare static readonly DONE: 2;
  declare readonly EMPTY: 0;
  declare readonly LOADING: 1;
  declare readonly DONE: 2;

  #state = 0;
  #result: string | ArrayBuffer | null = null;
  #error: DOMException | null = null;
  #generation = 0;

  get readyState(): number {
    return this.#state;
  }
  get result(): string | ArrayBuffer | null {
    return this.#result;
  }
  get error(): DOMException | null {
    return this.#error;
  }

  readAsArrayBuffer(blob: Blob): void {
    this.#read(blob, 'arraybuffer', 'readAsArrayBuffer');
  }
  readAsBinaryString(blob: Blob): void {
    this.#read(blob, 'binary', 'readAsBinaryString');
  }
  readAsText(blob: Blob, encoding?: string): void {
    this.#read(blob, 'text', 'readAsText', encoding);
  }
  readAsDataURL(blob: Blob): void {
    this.#read(blob, 'dataurl', 'readAsDataURL');
  }

  abort(): void {
    if (this.#state === 0 || this.#state === 2) {
      this.#result = null;
      return;
    }
    this.#state = 2;
    this.#result = null;
    this.#generation++;
    this.#fire('abort');
    if (this.#state !== 1) this.#fire('loadend');
  }

  #fire(type: string, loaded = 0, total = 0): void {
    dispatchTrusted(
      this,
      new ProgressEvent(type, { lengthComputable: true, loaded, total }),
    );
  }

  #read(blob: Blob, kind: ReadKind, method: string, encoding?: string): void {
    if (!(blob instanceof Blob)) {
      throw new TypeError(
        `Failed to execute '${method}' on 'FileReader': parameter 1 is not of type 'Blob'.`,
      );
    }
    if (this.#state === 1) {
      throw domException(
        `Failed to execute '${method}' on 'FileReader': The object is already busy reading Blobs.`,
        'InvalidStateError',
      );
    }
    this.#state = 1;
    this.#result = null;
    this.#error = null;
    const gen = ++this.#generation;
    const bytes = blobBytes(blob);
    const type = blob.type;
    // File API "read operation": loadstart, then one progress per chunk while LOADING (the whole blob
    // is one chunk here; an empty blob has none), then DONE + result and load/loadend. abort() from
    // any of these handlers bumps the generation, which stops the remaining steps.
    queueTask(() => {
      if (gen !== this.#generation) return;
      this.#fire('loadstart', 0, bytes.length);
      queueTask(() => {
        if (gen !== this.#generation) return;
        if (bytes.length > 0) {
          this.#fire('progress', bytes.length, bytes.length);
          if (gen !== this.#generation) return;
        }
        let result: string | ArrayBuffer;
        try {
          result = packageData(bytes, kind, type, encoding);
        } catch (e) {
          this.#state = 2;
          this.#error = domException(String((e as Error)?.message ?? e), 'NotReadableError');
          this.#fire('error');
          if (this.#state !== 1) this.#fire('loadend');
          return;
        }
        this.#state = 2;
        this.#result = result;
        this.#fire('load', bytes.length, bytes.length);
        if (this.#state !== 1) this.#fire('loadend', bytes.length, bytes.length);
      });
    });
  }
}
for (const [k, v] of [
  ['EMPTY', 0],
  ['LOADING', 1],
  ['DONE', 2],
] as const) {
  Object.defineProperty(FileReader.prototype, k, { value: v, enumerable: true, writable: false, configurable: false });
  Object.defineProperty(FileReader, k, { value: v, enumerable: true, writable: false, configurable: false });
}
tag(FileReader, 'FileReader');
enumerable(FileReader, [
  'readyState',
  'result',
  'error',
  'readAsArrayBuffer',
  'readAsBinaryString',
  'readAsText',
  'readAsDataURL',
  'abort',
]);
for (const t of ['loadstart', 'progress', 'load', 'abort', 'error', 'loadend']) {
  defineEventHandler(FileReader.prototype, t);
}

function packageData(
  bytes: Uint8Array,
  kind: ReadKind,
  type: string,
  encoding?: string,
): string | ArrayBuffer {
  switch (kind) {
    case 'arraybuffer':
      return bytes.slice().buffer;
    case 'binary':
      return bytesToLatin1(bytes);
    case 'dataurl':
      return `data:${type || 'application/octet-stream'};base64,${base64Encode(bytes)}`;
    case 'text': {
      // File API "package data" for text: BOM sniff, then the given label, then the blob type's
      // charset parameter, then UTF-8.
      let label = 'utf-8';
      let e: string | null = null;
      if (encoding !== undefined) e = getEncoding(toDOMString(encoding, "Failed to execute 'readAsText' on 'FileReader'"));
      if (e === null) {
        const charset = /;\s*charset\s*=\s*(?:"([^"]*)"|([^;\s]*))/i.exec(type);
        if (charset) e = getEncoding(charset[1] ?? charset[2] ?? '');
      }
      if (e !== null) label = e;
      if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) label = 'utf-8';
      else if (bytes[0] === 0xfe && bytes[1] === 0xff) label = 'utf-16be';
      else if (bytes[0] === 0xff && bytes[1] === 0xfe) label = 'utf-16le';
      // Encoding §14.1: the replacement decoder emits one U+FFFD for non-empty input, then stops
      // (TextDecoder refuses the label, FileReader does not).
      if (label === 'replacement') return bytes.length > 0 ? '\uFFFD' : '';
      return new TextDecoder(label).decode(bytes);
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// Blob URL store (File API §8)

/**
 * The `blob:` URL store. `fetch`, image loading, module/worker loading and XHR resolve URLs through
 * `resolve()`. It is published as `globalThis[Symbol.for('iwn.glue')].blobUrls`.
 */
export interface BlobURLStore {
  /** Registers a blob and returns `blob:<origin>/<uuid>`. */
  create(blob: Blob): string;
  /** Removes an entry; unknown URLs are ignored. */
  revoke(url: string): void;
  /** The blob for a URL (fragment ignored), or null if unknown or revoked. */
  resolve(url: string): Blob | null;
}

export function createBlobURLStore(
  origin: () => string,
  randomUUID: () => string,
  native?: GlueNatives['blobUrls'],
): BlobURLStore {
  const local = new Map<string, Blob>();
  const strip = (url: string): string => {
    const h = url.indexOf('#');
    return h < 0 ? url : url.slice(0, h);
  };
  return {
    create(blob) {
      const o = origin();
      const url = `blob:${o === 'null' ? 'null' : o}/${randomUUID()}`;
      local.set(url, blob);
      native?.register(url, blobBytes(blob), blob.type);
      return url;
    },
    revoke(url) {
      const key = strip(String(url));
      local.delete(key);
      native?.revoke(key);
    },
    resolve(url) {
      const key = strip(String(url));
      const hit = local.get(key);
      if (native) {
        // The process-wide store is the source of truth (NET-15): a revoke in another global (a
        // worker) removes the entry for every global, so a local hit counts only while it is there.
        const r = native.resolve(key);
        if (!r) {
          if (hit) local.delete(key);
          return null;
        }
        return hit ?? blobFromBytes(r.bytes, r.type);
      }
      return hit ?? null;
    },
  };
}

/** For tests: swap how Blob.stream() finds ReadableStream. */
export function setReadableStreamLookup(fn: () => unknown): void {
  readableStreamCtor = fn;
}
