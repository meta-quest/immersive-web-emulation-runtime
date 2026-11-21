/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// What the DOM stand-ins build on: the web glue's EventTarget, Event and DOMException (web/glue, evaluated before
// this prelude), the glue registry (event-path hook, event handler attributes, the URL behind `location`) and the
// core natives (lifecycle state, the entry document's source). Captured once when the prelude is evaluated.

/* eslint-disable @typescript-eslint/no-explicit-any */
export const G = globalThis as any;

export const HTML_NS = 'http://www.w3.org/1999/xhtml';
export const SVG_NS = 'http://www.w3.org/2000/svg';
export const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';
export const XML_NS = 'http://www.w3.org/XML/1998/namespace';
export const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

const glue = G[Symbol.for('iwn.glue')] as any;

/** The glue's EventTarget: DOM nodes subclass it and implement GET_THE_PARENT for capture/bubble paths. */
export const BaseEventTarget: new () => any =
  typeof G.EventTarget === 'function'
    ? G.EventTarget
    : (class EventTarget {} as any);
export const BaseEvent: new (type: string, init?: any) => any =
  typeof G.Event === 'function' ? G.Event : (class Event {} as any);
export const GET_THE_PARENT: symbol =
  glue?.events?.GET_THE_PARENT ?? Symbol.for('iwn.event.getTheParent');

/** HTML event handler IDL attributes (`onclick`, ...) through the glue's implementation (HTML §8.1.8.1). */
export function defineHandler(proto: object, type: string): void {
  const def = glue?.events?.defineEventHandler;
  if (typeof def === 'function') {
    def(proto, type);
    return;
  }
  const slot = Symbol(`on${type}`);
  Object.defineProperty(proto, `on${type}`, {
    get(this: any) {
      return this[slot]?.value ?? null;
    },
    set(this: any, v: unknown) {
      const cur = this[slot];
      if (cur) this.removeEventListener(type, cur.listener);
      if (typeof v !== 'function') {
        this[slot] = undefined;
        return;
      }
      const rec = {
        value: v,
        listener: (e: unknown) =>
          (rec.value as (e: unknown) => unknown).call(this, e),
      };
      this[slot] = rec;
      this.addEventListener(type, rec.listener);
    },
    configurable: true,
    enumerable: true,
  });
}

export function domException(message: string, name: string): Error {
  const D = G.DOMException;
  if (typeof D === 'function') return new D(message, name);
  const e = new Error(message);
  e.name = name;
  return e;
}

export function warn(message: string): void {
  try {
    G.console?.warn?.(`[iwer-native] ${message}`);
  } catch {
    // logging is best effort
  }
}

/** The page config (`__iwn.config`: the runtime config's glue section plus url/scope), parsed. */
export function pageConfig(): Record<string, any> {
  const c = G.__iwn?.config;
  if (typeof c === 'string') {
    try {
      return JSON.parse(c) ?? {};
    } catch {
      return {};
    }
  }
  return c && typeof c === 'object' ? c : {};
}

/** Whether this global is a worker (the DOM exists only on the page). */
export function isWorkerScope(): boolean {
  if (G.__iwn?.core?.isWorker === true) return true;
  if (pageConfig().scope === 'worker') return true;
  return (
    typeof G.importScripts === 'function' ||
    typeof G.WorkerGlobalScope === 'function'
  );
}

/** DOM-3's fixed window size: config `viewport` (the glue's default, 1280x720, when absent). */
export function viewport(): { width: number; height: number } {
  const v = pageConfig().viewport;
  const ok = (n: unknown): n is number =>
    typeof n === 'number' && Number.isFinite(n) && n > 0;
  return ok(v?.width) && ok(v?.height)
    ? { width: Math.floor(v.width), height: Math.floor(v.height) }
    : { width: 1280, height: 720 };
}

/** The document URL: the glue's navigation state (what `location` shows), else the core's, else the default. */
export function documentURL(): string {
  try {
    const nav = glue?.navigation;
    if (nav && typeof nav.current === 'function')
      return String(nav.current().href);
  } catch {
    // fall through
  }
  const href = G.location?.href;
  if (typeof href === 'string') return href;
  return typeof G.__iwn?.core?.documentUrl === 'string'
    ? G.__iwn.core.documentUrl
    : 'https://app.local/';
}

/** `{visibilityState, focused, readyState}` from the core (defaults when absent: tests, other hosts). */
export function lifecycle(): {
  visibilityState: string;
  focused: boolean;
  readyState: string;
} {
  try {
    const s = G.__iwn?.core?.lifecycleState?.();
    if (s && typeof s === 'object') {
      return {
        visibilityState: s.visibilityState === 'hidden' ? 'hidden' : 'visible',
        focused: s.focused !== false,
        readyState:
          typeof s.readyState === 'string' ? s.readyState : 'complete',
      };
    }
  } catch {
    // fall through
  }
  return { visibilityState: 'visible', focused: true, readyState: 'complete' };
}

/** The entry document's HTML (core `documentSource()`), or null. */
export function entryDocumentSource(): string | null {
  try {
    const s = G.__iwn?.core?.documentSource?.();
    return typeof s === 'string' ? s : null;
  } catch {
    return null;
  }
}

export function queueTask(fn: () => void): void {
  if (typeof G.setTimeout === 'function') G.setTimeout(fn, 0);
  else Promise.resolve().then(fn);
}

export function queueMicro(fn: () => void): void {
  if (typeof G.queueMicrotask === 'function') G.queueMicrotask(fn);
  else Promise.resolve().then(fn);
}

/** Reports an exception the way a browser reports one thrown by a callback (window `error`, then the console). */
export function reportException(error: unknown): void {
  const report = glue?.events?.reportException ?? G.reportError;
  if (typeof report === 'function') {
    try {
      report(error);
      return;
    } catch {
      // fall through
    }
  }
  try {
    G.console?.error?.(error);
  } catch {
    // ignore
  }
}

/** WebIDL DOMString conversion (null and undefined stringify, symbols throw). */
export function str(v: unknown): string {
  if (typeof v === 'symbol')
    throw new TypeError('Cannot convert a Symbol value to a string');
  return String(v);
}

/** ASCII lowercase (HTML names are ASCII case-insensitive). */
export function lower(s: string): string {
  return /[A-Z]/.test(s) ? s.replace(/[A-Z]+/g, (m) => m.toLowerCase()) : s;
}
