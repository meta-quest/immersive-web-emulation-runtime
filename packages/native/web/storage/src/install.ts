/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Two preludes:
//   storage.min.js  installStorage(): localStorage, sessionStorage, Storage, navigator.storage.estimate
//                   (from native usage). Always shipped. navigator.storage.persist/persisted stay absent
//                   (spec NET-STORE-3).
//   idb.min.js      installIdbAndCaches(): IndexedDB, the Cache API and navigator.storage.persist/
//                   persisted (resolve true: app-private storage is never evicted the way this API
//                   describes). Opt-in (NET-STORE-3 keeps them absent unless an app needs them).
// localStorage writes are flushed (non-blocking) when the page is hidden; the runtime's shutdown hook
// makes them durable before exit (runtime/storage, iwn_storage_flush_all).

import type { StorageNatives } from './natives.ts';
import { createLocalStorage, createStorage, Storage } from './web-storage.ts';

export interface InstallStorageOptions {
  natives?: StorageNatives | null;
  warn?: (message: string) => void;
}

export function nativesFrom(g: typeof globalThis, opts: InstallStorageOptions): StorageNatives | null {
  if (opts.natives !== undefined) return opts.natives;
  return (g as { __iwn?: { storage?: StorageNatives } }).__iwn?.storage ?? null;
}

export function define(g: object, name: string, value: unknown, getter = false): void {
  Object.defineProperty(g, name, getter ? { get: () => value, configurable: true, enumerable: true } : { value, writable: true, configurable: true, enumerable: false });
}

/**
 * Adds methods to navigator.storage: on the glue's StorageManager prototype when there is one (replacing
 * its placeholders), else on a plain object.
 */
export function installStorageManagerMethods(nav: Record<string, unknown>, methods: Record<string, () => Promise<unknown>>): void {
  const existing = nav.storage as Record<string, unknown> | undefined;
  if (existing && typeof existing === 'object') {
    const proto = Object.getPrototypeOf(existing) as Record<string, unknown>;
    const target = proto && proto !== Object.prototype ? proto : existing;
    for (const [k, fn] of Object.entries(methods)) {
      Object.defineProperty(target, k, { value: fn, writable: true, configurable: true, enumerable: true });
    }
  } else {
    define(nav, 'storage', { ...methods }, true);
  }
}

/** Window globals only (workers have no Web Storage). */
export function installStorage(g: typeof globalThis, opts: InstallStorageOptions = {}): string[] {
  const natives = nativesFrom(g, opts);
  const warn = opts.warn ?? ((m: string) => (g as { console?: Console }).console?.warn(m));
  const installed: string[] = [];
  let local: Storage | null = null;
  let session: Storage | null = null;
  // Created on first access: apps that never touch localStorage never read the file.
  Object.defineProperty(g, 'localStorage', {
    get: () => (local ??= createLocalStorage(natives, warn)),
    configurable: true,
    enumerable: true,
  });
  Object.defineProperty(g, 'sessionStorage', {
    get: () => (session ??= createStorage([], null)),
    configurable: true,
    enumerable: true,
  });
  define(g, 'Storage', Storage);
  installed.push('localStorage', 'sessionStorage', 'Storage');

  const nav = (g as unknown as { navigator?: Record<string, unknown> }).navigator;
  if (nav) {
    const estimate = (): Promise<{ usage: number; quota: number }> => {
      if (!natives) return Promise.resolve({ usage: 0, quota: 5 * 1024 * 1024 });
      try {
        const e = natives.estimate();
        return Promise.resolve({ usage: e.usage, quota: e.quota });
      } catch (err) {
        return Promise.reject(err);
      }
    };
    installStorageManagerMethods(nav, { estimate });
    installed.push('navigator.storage');
  }

  // Flush (non-blocking) when the page goes to the background.
  const doc = (g as { document?: EventTarget }).document;
  const flush = () => natives?.kvFlush();
  if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', flush);
  if (typeof (g as unknown as EventTarget).addEventListener === 'function') {
    (g as unknown as EventTarget).addEventListener('pagehide', flush);
  }
  return installed;
}

