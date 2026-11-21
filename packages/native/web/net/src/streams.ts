/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// WHATWG Streams for response bodies (NET-9). V8 has no Streams implementation and the glue does not
// ship one, so the net prelude installs web-streams-polyfill (MIT) when the global is missing; a native
// or future glue implementation is used as is.

import * as ponyfill from 'web-streams-polyfill';

const NAMES = [
  'ReadableStream',
  'ReadableStreamDefaultReader',
  'ReadableStreamBYOBReader',
  'ReadableStreamDefaultController',
  'ReadableByteStreamController',
  'ReadableStreamBYOBRequest',
  'WritableStream',
  'WritableStreamDefaultWriter',
  'WritableStreamDefaultController',
  'TransformStream',
  'TransformStreamDefaultController',
  'ByteLengthQueuingStrategy',
  'CountQueuingStrategy',
] as const;

let override: typeof ReadableStream | null = null;

export function getReadableStream(): typeof ReadableStream {
  if (override) return override;
  const g = (globalThis as { ReadableStream?: typeof ReadableStream })
    .ReadableStream;
  return g ?? (ponyfill.ReadableStream as unknown as typeof ReadableStream);
}

/** Tests: force the polyfill (or another implementation). */
export function setReadableStreamForTests(
  rs: typeof ReadableStream | null,
): void {
  override = rs;
}

/** Installs the polyfill's classes that the global lacks. Returns the names installed. */
export function installStreams(g: typeof globalThis): string[] {
  const installed: string[] = [];
  const target = g as unknown as Record<string, unknown>;
  if (typeof target.ReadableStream === 'function') return installed;
  const src = ponyfill as unknown as Record<string, unknown>;
  for (const name of NAMES) {
    if (typeof target[name] !== 'function' && typeof src[name] === 'function') {
      Object.defineProperty(g, name, {
        value: src[name],
        writable: true,
        configurable: true,
        enumerable: false,
      });
      installed.push(name);
    }
  }
  return installed;
}
