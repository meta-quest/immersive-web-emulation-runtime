/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

export { installStorage, type InstallStorageOptions } from './install.ts';
export { installIdbAndCaches } from './install-idb.ts';
export { Storage, createStorage, createLocalStorage, DEFAULT_QUOTA_UNITS } from './web-storage.ts';
export { installIndexedDB, IDB_GLOBALS } from './indexeddb.ts';
export { CacheStorage, Cache, createCacheStorage } from './cache.ts';
export { makeOpenDatabase } from './websql.ts';
export type { StorageNatives, SqlResult, SqlValue, SqlArea } from './natives.ts';
