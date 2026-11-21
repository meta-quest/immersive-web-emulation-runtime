/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// HTML §12 Web Storage: the Storage interface with named properties, localStorage persisted through the
// native KV log (NET-STORE-1/2: the JS map answers every read; each mutation is mirrored to native code,
// which coalesces writes off the main thread), sessionStorage in memory per launch. Quota: 5 MiB of
// UTF-16 code units (keys + values) per area → QuotaExceededError. `storage` events are not fired (one
// document per app).

import type { StorageNatives } from './natives.ts';

export const DEFAULT_QUOTA_UNITS = 5 * 1024 * 1024;

/**
 * Entries of the runtime's own in an area, stored under this prefix: the page's Storage API does not see them (not in
 * getItem, key, length or the named properties), clear() keeps them, and they do not count against the page's quota.
 * Quest Browser keeps an origin's persistent-anchor list the same way (a localStorage key hidden from the page and kept
 * by clear()). Runtime code uses runtimeItem / setRuntimeItem.
 */
export const RUNTIME_KEY_PREFIX = '\u0000iwn:';

function quotaError(): DOMException {
  const D = (globalThis as { DOMException?: typeof DOMException }).DOMException;
  const message =
    "Failed to execute 'setItem' on 'Storage': Setting the value exceeded the quota.";
  if (D) return new D(message, 'QuotaExceededError');
  const e = new Error(message);
  e.name = 'QuotaExceededError';
  return e as unknown as DOMException;
}

/** Backing store of one area. */
export interface StorageBackend {
  set(key: string, value: string): void;
  remove(key: string): void;
  clear(): void;
}

class Area {
  map = new Map<string, string>();
  runtime = new Map<string, string>();
  used = 0;
  quota: number;
  backend: StorageBackend | null;
  constructor(
    entries: Iterable<[string, string]>,
    backend: StorageBackend | null,
    quota: number,
  ) {
    for (const [k, v] of entries) {
      if (k.startsWith(RUNTIME_KEY_PREFIX)) {
        this.runtime.set(k.slice(RUNTIME_KEY_PREFIX.length), v);
      } else {
        this.map.set(k, v);
        this.used += k.length + v.length;
      }
    }
    this.backend = backend;
    this.quota = quota;
  }
}

const AREAS = new WeakMap<object, Area>();
const ILLEGAL = Symbol('illegal-constructor');

function areaOf(s: unknown): Area {
  const a = AREAS.get(s as object);
  if (!a) throw new TypeError('Illegal invocation');
  return a;
}

export class Storage {
  constructor(token?: unknown) {
    if (token !== ILLEGAL) throw new TypeError('Illegal constructor');
  }
  get length(): number {
    return areaOf(this).map.size;
  }
  key(index: number): string | null {
    const a = areaOf(this);
    const i = Number(index) >>> 0;
    if (i >= a.map.size) return null;
    let n = 0;
    for (const k of a.map.keys()) if (n++ === i) return k;
    return null;
  }
  getItem(key: string): string | null {
    const v = areaOf(this).map.get(String(key));
    return v === undefined ? null : v;
  }
  setItem(key: string, value: string): void {
    const a = areaOf(this);
    key = String(key);
    value = String(value);
    const old = a.map.get(key);
    if (old === value) return;
    const delta =
      old === undefined ? key.length + value.length : value.length - old.length;
    if (a.used + delta > a.quota) throw quotaError();
    a.map.set(key, value);
    a.used += delta;
    a.backend?.set(key, value);
  }
  removeItem(key: string): void {
    const a = areaOf(this);
    key = String(key);
    const old = a.map.get(key);
    if (old === undefined) return;
    a.map.delete(key);
    a.used -= key.length + old.length;
    a.backend?.remove(key);
  }
  clear(): void {
    const a = areaOf(this);
    if (a.map.size === 0) return;
    a.map.clear();
    a.used = 0;
    a.backend?.clear();
    // the runtime's entries are not the page's to clear
    for (const [k, v] of a.runtime) a.backend?.set(RUNTIME_KEY_PREFIX + k, v);
  }
  get [Symbol.toStringTag](): string {
    return 'Storage';
  }
}

/** A runtime entry of `storage` (see RUNTIME_KEY_PREFIX), null when absent. */
export function runtimeItem(storage: Storage, key: string): string | null {
  return areaOf(storage).runtime.get(key) ?? null;
}

/** Sets (null: removes) a runtime entry of `storage`, persisted with the area. */
export function setRuntimeItem(
  storage: Storage,
  key: string,
  value: string | null,
): void {
  const a = areaOf(storage);
  if (value === null) {
    if (a.runtime.delete(key)) a.backend?.remove(RUNTIME_KEY_PREFIX + key);
    return;
  }
  if (a.runtime.get(key) === value) return;
  a.runtime.set(key, value);
  a.backend?.set(RUNTIME_KEY_PREFIX + key, value);
}

const PROTO_KEYS = new Set<string | symbol>();
for (
  let p: object | null = Storage.prototype;
  p;
  p = Object.getPrototypeOf(p)
) {
  for (const k of Reflect.ownKeys(p)) PROTO_KEYS.add(k);
}

/**
 * A Storage object with WebIDL named-property behaviour: `s.foo` reads item "foo" unless "foo" is on the
 * prototype chain, `s.foo = 1` stores "1", `delete s.foo` removes it, `Object.keys(s)` lists the keys.
 */
export function createStorage(
  entries: Iterable<[string, string]>,
  backend: StorageBackend | null,
  quota = DEFAULT_QUOTA_UNITS,
): Storage {
  const target = new Storage(ILLEGAL);
  const area = new Area(entries, backend, quota);
  AREAS.set(target, area);
  const proxy = new Proxy(target, {
    get(t, prop, receiver) {
      if (
        typeof prop === 'symbol' ||
        PROTO_KEYS.has(prop) ||
        !area.map.has(prop)
      ) {
        return Reflect.get(t, prop, receiver === proxy ? t : receiver);
      }
      return area.map.get(prop);
    },
    set(t, prop, value) {
      if (typeof prop === 'symbol') return Reflect.set(t, prop, value);
      Storage.prototype.setItem.call(t, prop, value);
      return true;
    },
    has(t, prop) {
      if (typeof prop === 'string' && area.map.has(prop)) return true;
      return Reflect.has(t, prop);
    },
    deleteProperty(t, prop) {
      if (typeof prop === 'string' && area.map.has(prop)) {
        Storage.prototype.removeItem.call(t, prop);
        return true;
      }
      return Reflect.deleteProperty(t, prop);
    },
    ownKeys(t) {
      return [...area.map.keys(), ...Reflect.ownKeys(t)];
    },
    getOwnPropertyDescriptor(t, prop) {
      if (
        typeof prop === 'string' &&
        area.map.has(prop) &&
        !PROTO_KEYS.has(prop)
      ) {
        return {
          value: area.map.get(prop),
          writable: true,
          enumerable: true,
          configurable: true,
        };
      }
      return Reflect.getOwnPropertyDescriptor(t, prop);
    },
    defineProperty(t, prop, desc) {
      if (typeof prop === 'symbol')
        return Reflect.defineProperty(t, prop, desc);
      if ('value' in desc) {
        Storage.prototype.setItem.call(t, prop, desc.value);
        return true;
      }
      return false;
    },
  });
  // Methods called on the proxy must find the area.
  AREAS.set(proxy, area);
  return proxy;
}

/** localStorage over the native KV log. */
export function createLocalStorage(
  natives: StorageNatives | null,
  warn: (m: string) => void,
): Storage {
  if (!natives) return createStorage([], null);
  let opened: ReturnType<StorageNatives['kvOpen']>;
  try {
    opened = natives.kvOpen();
  } catch (e) {
    warn(
      `[iwer-native] localStorage: native store unavailable (${String(e)}); using memory only`,
    );
    return createStorage([], null);
  }
  if (opened.warning) warn(`[iwer-native] localStorage: ${opened.warning}`);
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i + 1 < opened.entries.length; i += 2)
    pairs.push([opened.entries[i], opened.entries[i + 1]]);
  return createStorage(
    pairs,
    opened.persistent
      ? {
          set: (k, v) => natives.kvSet(k, v),
          remove: (k) => natives.kvRemove(k),
          clear: () => natives.kvClear(),
        }
      : null,
  );
}
