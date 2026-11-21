/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// What the net layer reads from its surroundings: the natives, the glue
// registry (blob URL store, blob bytes) and a few globals the glue installs
// (URL, Blob, DOMException, EventTarget, TextEncoder/TextDecoder, AbortSignal).
// Everything is looked up through one NetEnv so tests can run it in Node and
// in a bare vm context.

import type { NetConfig, NetNatives } from './natives.ts';

/** The subset of the glue registry (`globalThis[Symbol.for('iwn.glue')]`) used here. */
export interface GlueLike {
  blobUrls?: { resolve(url: string): Blob | null };
  blobBytes?(blob: Blob): Uint8Array;
  blobFromBytes?(bytes: Uint8Array, type?: string): Blob;
}

export interface NetEnv {
  natives: NetNatives | null;
  config: NetConfig;
  glue: GlueLike | null;
  /** Base URL for relative request URLs (document URL). */
  baseURL(): string;
  warn(message: string): void;
}

export const DEFAULT_ORIGIN = 'https://app.local';

export function makeEnv(
  g: typeof globalThis,
  natives: NetNatives | null,
  warn?: (m: string) => void,
): NetEnv {
  let config: NetConfig = {
    allow: [],
    debug: false,
    origin: DEFAULT_ORIGIN,
    userAgent: '',
    timeoutMs: 60000,
  };
  if (natives) {
    try {
      config = { ...config, ...natives.config() };
    } catch {
      // keep defaults
    }
  }
  const glue =
    ((g as unknown as Record<symbol, unknown>)[Symbol.for('iwn.glue')] as
      | GlueLike
      | undefined) ?? null;
  return {
    natives,
    config,
    glue,
    baseURL() {
      const loc = (g as { location?: { href?: string } }).location;
      return loc && typeof loc.href === 'string' && loc.href.startsWith('http')
        ? loc.href
        : config.origin + '/';
    },
    warn:
      warn ?? ((m: string) => (g as { console?: Console }).console?.warn(m)),
  };
}

export function domException(message: string, name: string): DOMException {
  const D = (globalThis as { DOMException?: typeof DOMException }).DOMException;
  if (D) return new D(message, name);
  const e = new Error(message) as Error & { code?: number };
  e.name = name;
  return e as unknown as DOMException;
}

export function abortReason(signal: AbortSignal): unknown {
  return signal.reason !== undefined
    ? signal.reason
    : domException('The operation was aborted.', 'AbortError');
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
export function utf8Encode(s: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(s) as Uint8Array<ArrayBuffer>;
}
/** UTF-8 decode with BOM stripping (Encoding "UTF-8 decode"). */
export function utf8Decode(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function isBufferSource(v: unknown): v is ArrayBuffer | ArrayBufferView {
  return (
    v instanceof ArrayBuffer ||
    ArrayBuffer.isView(v) ||
    Object.prototype.toString.call(v) === '[object ArrayBuffer]'
  );
}

export function bytesOf(v: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (ArrayBuffer.isView(v))
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return new Uint8Array(v);
}

/** Copy of a buffer source (Fetch: "a copy of the bytes held by the buffer source"). */
export function copyBytes(
  v: ArrayBuffer | ArrayBufferView,
): Uint8Array<ArrayBuffer> {
  return bytesOf(v).slice();
}

export function concatBytes(
  chunks: Uint8Array[],
  total?: number,
): Uint8Array<ArrayBuffer> {
  if (
    chunks.length === 1 &&
    chunks[0].byteOffset === 0 &&
    chunks[0].byteLength === chunks[0].buffer.byteLength
  ) {
    return chunks[0] as Uint8Array<ArrayBuffer>;
  }
  const n = total ?? chunks.reduce((s, c) => s + c.byteLength, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

/** The bytes of a Blob: the glue's zero-copy accessor when present, else blob.arrayBuffer(). */
export async function blobToBytes(
  env: NetEnv,
  blob: Blob,
): Promise<Uint8Array> {
  if (env.glue?.blobBytes) {
    try {
      return env.glue.blobBytes(blob);
    } catch {
      // not a glue Blob (tests in Node)
    }
  }
  return new Uint8Array(await blob.arrayBuffer());
}

export function makeBlob(env: NetEnv, bytes: Uint8Array, type: string): Blob {
  if (env.glue?.blobFromBytes) return env.glue.blobFromBytes(bytes, type);
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type });
}
