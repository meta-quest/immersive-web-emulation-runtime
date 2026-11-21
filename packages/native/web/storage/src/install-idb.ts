/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The opt-in prelude idb.min.js (see install.ts for both): IndexedDB, the Cache API and
// navigator.storage.persist()/persisted() (resolve true: app-private storage is never evicted by the
// browser-style eviction this API describes). Spec NET-STORE-3 keeps all three absent unless an app
// needs them.

import { Cache, CacheStorage, createCacheStorage } from './cache.ts';
import { installIndexedDB } from './indexeddb.ts';
import {
  define,
  installStorageManagerMethods,
  nativesFrom,
  type InstallStorageOptions,
} from './install.ts';

/** IndexedDB + Cache API (the opt-in prelude). */
export function installIdbAndCaches(
  g: typeof globalThis,
  opts: InstallStorageOptions & { origin?: string } = {},
): string[] {
  const natives = nativesFrom(g, opts);
  const warn =
    opts.warn ?? ((m: string) => (g as { console?: Console }).console?.warn(m));
  if (!natives) {
    warn(
      '[iwer-native] IndexedDB/Cache API: no native storage module; not installed',
    );
    return [];
  }
  const installed = installIndexedDB(g, natives, {
    origin:
      opts.origin ?? (g as { location?: { origin?: string } }).location?.origin,
  });
  const net = () => {
    const reg = (g as unknown as Record<symbol, unknown>)[
      Symbol.for('iwn.net')
    ];
    if (!reg) throw new TypeError('Cache API needs the net prelude');
    return reg as Parameters<typeof createCacheStorage>[1] extends () => infer R
      ? R
      : never;
  };
  const caches = createCacheStorage(natives, net);
  define(g, 'caches', caches, true);
  define(g, 'CacheStorage', CacheStorage);
  define(g, 'Cache', Cache);
  installed.push('caches', 'CacheStorage', 'Cache');
  const nav = (g as unknown as { navigator?: Record<string, unknown> })
    .navigator;
  if (nav) {
    installStorageManagerMethods(nav, {
      persist: () => Promise.resolve(true),
      persisted: () => Promise.resolve(true),
    });
    installed.push('navigator.storage.persist');
  }
  return installed;
}
