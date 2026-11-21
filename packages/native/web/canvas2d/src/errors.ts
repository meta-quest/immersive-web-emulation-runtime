/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/** DOMException from the global (the web glue installs it); a named Error when it is absent (bare tests). */
export function domException(message: string, name: string): Error {
  const D = (globalThis as { DOMException?: new (m: string, n: string) => Error }).DOMException;
  if (typeof D === 'function') return new D(message, name);
  const e = new Error(message);
  e.name = name;
  return e;
}

/** C2D-13: an unimplemented method throws a TypeError that names it, never a silent no-op. */
export function unimplemented(what: string): never {
  throw new TypeError(`${what} is not implemented by the @iwer/native runtime.`);
}

const warned = new Set<string>();
export function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  (globalThis as { console?: { warn(...a: unknown[]): void } }).console?.warn(`[canvas2d] ${message}`);
}
