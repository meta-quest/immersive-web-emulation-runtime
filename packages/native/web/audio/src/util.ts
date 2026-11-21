/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

export function domError(name: string, message: string): DOMException {
  return new DOMException(message, name);
}

/** WebIDL `float`/`double` conversion: non-finite values throw TypeError. */
export function finite(v: unknown, what: string): number {
  const n = Number(v);
  if (!Number.isFinite(n))
    throw new TypeError(`${what} must be a finite number`);
  return n;
}

export function unsignedLong(v: unknown, what: string): number {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new TypeError(`${what} must be a number`);
  return Math.trunc(n) >>> 0;
}

/** Index of `v` in an enum list, or -1 (WebIDL enum attributes ignore invalid assignments). */
export function enumIndex(list: readonly string[], v: unknown): number {
  return typeof v === 'string' ? list.indexOf(v) : -1;
}

type Handler = ((this: EventTarget, ev: Event) => unknown) | null;

/**
 * Event handler IDL attribute (`onended`, `onstatechange`, `oncomplete`): one listener slot that
 * wraps the current handler.
 */
export class HandlerSlot {
  #target: EventTarget;
  #type: string;
  #handler: Handler = null;
  #listener: ((ev: Event) => void) | null = null;
  constructor(target: EventTarget, type: string) {
    this.#target = target;
    this.#type = type;
  }
  get(): Handler {
    return this.#handler;
  }
  set(v: unknown): void {
    const fn = typeof v === 'function' ? (v as Handler) : null;
    if (fn && !this.#listener) {
      this.#listener = (ev: Event) => {
        const h = this.#handler;
        if (h) h.call(this.#target, ev);
      };
      this.#target.addEventListener(this.#type, this.#listener);
    } else if (!fn && this.#listener) {
      this.#target.removeEventListener(this.#type, this.#listener);
      this.#listener = null;
    }
    this.#handler = fn;
  }
  get active(): boolean {
    return this.#handler !== null;
  }
}

/** Reports an exception thrown by an app callback without breaking the dispatcher. */
export function reportError(e: unknown): void {
  const g = globalThis as { reportError?: (e: unknown) => void };
  if (typeof g.reportError === 'function') g.reportError(e);
  else
    queueMicrotask(() => {
      throw e;
    });
}
