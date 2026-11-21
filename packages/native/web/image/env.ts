/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// What web/image needs from the rest of the runtime, resolved once per global: the native image module, the web
// glue's registry (blob URL store, trusted event dispatch, event handler attributes; web/glue/src/index.ts), fetch,
// the base URL, DOMException and a task queue. Everything is injectable so tests run in plain Node.

import type { ImageNatives, NativeImageHandle, NativeProcessOptions } from './natives.ts';

/** The subset of the glue registry (globalThis[Symbol.for('iwn.glue')]) used here. */
interface GlueRegistryLike {
  blobUrls?: { resolve(url: string): unknown };
  blobBytes?(blob: unknown): Uint8Array;
  navigation?: { current(): { href: string } };
  events?: {
    dispatchTrusted?(target: unknown, event: unknown): boolean;
    defineEventHandler?(proto: object, type: string): void;
    reportException?(error: unknown): void;
  };
}

export interface ResponseLike {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface ImageEnv {
  natives: ImageNatives;
  /** Network / asset fetch (same-origin assets, allowlisted origins; NET rules apply inside it). */
  fetch: ((url: string, init?: { signal?: unknown; credentials?: string }) => Promise<ResponseLike>) | null;
  /** The document base URL relative URLs resolve against. */
  baseURL(): string;
  /** A `blob:` URL's bytes, or null when unknown or revoked (NET-14/15). */
  resolveBlobURL(url: string): { bytes: Uint8Array; type: string } | null;
  /** True for Blob/File instances. */
  isBlob(value: unknown): boolean;
  /** A Blob's bytes (no copy when the glue provides them; do not mutate). */
  blobBytes(blob: unknown): Promise<Uint8Array>;
  EventTarget: { new (): EventTargetLike; prototype: EventTargetLike };
  Event: new (type: string, init?: { bubbles?: boolean; cancelable?: boolean }) => object;
  dispatch(target: EventTargetLike, event: object): void;
  defineEventHandler(proto: object, type: string): void;
  domException(message: string, name: string): Error;
  queueTask(fn: () => void): void;
  reportException(error: unknown): void;
  /** Wraps a native promise so polling-mode natives get poll() calls while it is pending. */
  track<T>(promise: Promise<T>): Promise<T>;
  /** Native calls, routed through track(). */
  decode(bytes: ArrayBuffer | ArrayBufferView, options: NativeProcessOptions): Promise<NativeImageHandle>;
  fromPixels(
    rgba: ArrayBufferView,
    width: number,
    height: number,
    premultiplied: boolean,
    options: NativeProcessOptions,
  ): Promise<NativeImageHandle>;
  transform(handle: NativeImageHandle, options: NativeProcessOptions): Promise<NativeImageHandle>;
  /** data: URL base64 payload decoded natively, or null when the native module predates it (contract version 1). */
  decodeBase64: ((text: string, options: NativeProcessOptions) => Promise<NativeImageHandle>) | null;
  /** Abandons a pending native job (its promise rejects with code 'cancelled'). No-op without native support. */
  cancel(promise: Promise<unknown>): void;
}

export interface EventTargetLike {
  addEventListener(type: string, listener: unknown, options?: unknown): void;
  removeEventListener(type: string, listener: unknown, options?: unknown): void;
  dispatchEvent(event: object): boolean;
}

export type ImageEnvOverrides = Partial<
  Omit<ImageEnv, 'track' | 'decode' | 'fromPixels' | 'transform' | 'decodeBase64' | 'cancel'>
>;

const GLUE_KEY = Symbol.for('iwn.glue');

class FallbackDOMException extends Error {
  constructor(message: string, name: string) {
    super(message);
    Object.defineProperty(this, 'name', { value: name, configurable: true, writable: true });
  }
}

export function createImageEnv(global: typeof globalThis, overrides: ImageEnvOverrides = {}): ImageEnv {
  const g = global as unknown as Record<string | symbol, unknown>;
  const glue = (g[GLUE_KEY] ?? null) as GlueRegistryLike | null;
  const natives = overrides.natives ?? ((g.__iwn as { image?: ImageNatives } | undefined)?.image ?? null);
  if (!natives) throw new Error('[iwer-native] web/image: globalThis.__iwn.image is missing (native image module)');

  const EventTargetCtor = (overrides.EventTarget ?? g.EventTarget) as ImageEnv['EventTarget'];
  const EventCtor = (overrides.Event ?? g.Event) as ImageEnv['Event'];
  if (typeof EventTargetCtor !== 'function' || typeof EventCtor !== 'function') {
    throw new Error('[iwer-native] web/image: EventTarget/Event must be installed first (web/glue)');
  }
  const DOMExceptionCtor = g.DOMException as (new (message: string, name: string) => Error) | undefined;
  const BlobCtor = g.Blob as (abstract new (...args: never[]) => object) | undefined;
  const setTimeoutFn = g.setTimeout as ((fn: () => void, ms: number) => unknown) | undefined;

  const queueTask =
    overrides.queueTask ??
    ((fn: () => void) => {
      if (typeof setTimeoutFn === 'function') setTimeoutFn.call(global, fn, 0);
      else void Promise.resolve().then(fn);
    });

  // Polling mode: poll every few ms while native promises are outstanding.
  let outstanding = 0;
  let polling = false;
  const pollLoop = () => {
    natives.poll();
    if (outstanding > 0 && typeof setTimeoutFn === 'function') setTimeoutFn.call(global, pollLoop, 2);
    else polling = false;
  };
  const track = <T>(promise: Promise<T>): Promise<T> => {
    if (!natives.needsPolling) return promise;
    outstanding++;
    if (!polling) {
      polling = true;
      queueTask(pollLoop);
    }
    const done = () => {
      outstanding--;
    };
    promise.then(done, done);
    return promise;
  };

  const env: ImageEnv = {
    natives,
    fetch:
      overrides.fetch !== undefined
        ? overrides.fetch
        : typeof g.fetch === 'function'
          ? (g.fetch as ImageEnv['fetch'])
          : null,
    baseURL:
      overrides.baseURL ??
      (() => {
        const doc = g.document as { baseURI?: string } | undefined;
        if (doc && typeof doc.baseURI === 'string') return doc.baseURI;
        if (glue?.navigation) return glue.navigation.current().href;
        const loc = g.location as { href?: string } | undefined;
        return loc?.href ?? 'https://app.local/';
      }),
    resolveBlobURL:
      overrides.resolveBlobURL ??
      ((url: string) => {
        const blob = glue?.blobUrls?.resolve(url);
        if (!blob || !glue?.blobBytes) return null;
        return { bytes: glue.blobBytes(blob), type: String((blob as { type?: string }).type ?? '') };
      }),
    isBlob:
      overrides.isBlob ??
      ((v: unknown) => typeof BlobCtor === 'function' && typeof v === 'object' && v !== null && v instanceof BlobCtor),
    blobBytes:
      overrides.blobBytes ??
      (async (blob: unknown) => {
        if (glue?.blobBytes) {
          try {
            return glue.blobBytes(blob);
          } catch {
            // not a glue Blob (e.g. Node's): fall through
          }
        }
        return new Uint8Array(await (blob as { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer());
      }),
    EventTarget: EventTargetCtor,
    Event: EventCtor,
    dispatch:
      overrides.dispatch ??
      ((target, event) => {
        if (glue?.events?.dispatchTrusted) glue.events.dispatchTrusted(target, event);
        else target.dispatchEvent(event);
      }),
    defineEventHandler: overrides.defineEventHandler ?? glue?.events?.defineEventHandler ?? defineEventHandlerFallback,
    domException:
      overrides.domException ??
      ((message, name) =>
        typeof DOMExceptionCtor === 'function'
          ? new DOMExceptionCtor(message, name)
          : new FallbackDOMException(message, name)),
    queueTask,
    reportException:
      overrides.reportException ??
      glue?.events?.reportException ??
      ((e: unknown) => {
        const c = g.console as { error?: (...a: unknown[]) => void } | undefined;
        c?.error?.(e);
      }),
    track,
    decode: (bytes, options) => track(natives.decode(bytes, options)),
    fromPixels: (rgba, w, h, premul, options) => track(natives.fromPixels(rgba, w, h, premul, options)),
    transform: (handle, options) => track(natives.transform(handle, options)),
    decodeBase64:
      typeof natives.decodeBase64 === 'function'
        ? (text, options) => track(natives.decodeBase64!(text, options))
        : null,
    cancel: (promise) => {
      if (typeof natives.cancel === 'function') natives.cancel(promise);
    },
  };
  return env;
}

// `on<type>` IDL attribute (HTML §8.1.8.1) for hosts without the glue: the listener is added on first set and
// keeps its position when the handler changes.
const handlerSlots = new WeakMap<object, Map<string, { value: unknown }>>();
function defineEventHandlerFallback(proto: object, type: string): void {
  Object.defineProperty(proto, `on${type}`, {
    get(this: object) {
      return handlerSlots.get(this)?.get(type)?.value ?? null;
    },
    set(this: EventTargetLike & object, value: unknown) {
      let map = handlerSlots.get(this);
      if (!map) handlerSlots.set(this, (map = new Map()));
      const v = typeof value === 'function' || (typeof value === 'object' && value !== null) ? value : null;
      let slot = map.get(type);
      if (!slot) {
        if (v === null) return;
        slot = { value: v };
        map.set(type, slot);
        const s = slot;
        this.addEventListener(type, function (this: unknown, event: { preventDefault(): void }) {
          const h = s.value;
          if (typeof h === 'function' && h.call(this, event) === false) event.preventDefault();
        });
      } else {
        slot.value = v;
      }
    },
    configurable: true,
    enumerable: true,
  });
}
