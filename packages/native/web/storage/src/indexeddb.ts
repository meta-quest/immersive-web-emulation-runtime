/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// IndexedDB = IndexedDBShim (MIT OR Apache-2.0) over the WebSQL-style driver in websql.ts, i.e. over the
// native SQLite service: each IndexedDB database is one SQLite file in the app's private storage
// (<files>/iwn/idb/), so data persists across launches and committed transactions are durable.
//
// Opt-in: spec NET-STORE-3 has indexedDB absent by default; the packer adds this prelude when the app
// enables it (see README.md).

import setGlobalVars from 'indexeddbshim/src/setGlobalVars.js';

import type { StorageNatives } from './natives.ts';
import { makeOpenDatabase } from './websql.ts';

export const IDB_GLOBALS = [
  'indexedDB',
  'IDBFactory',
  'IDBDatabase',
  'IDBObjectStore',
  'IDBIndex',
  'IDBTransaction',
  'IDBCursor',
  'IDBCursorWithValue',
  'IDBKeyRange',
  'IDBRequest',
  'IDBOpenDBRequest',
  'IDBVersionChangeEvent',
  'IDBRecord',
];

export interface InstallIndexedDBOptions {
  /** Origin used for the shim's connection queues (the app origin). */
  origin?: string;
  /** Macrotask scheduler for WebSQL callbacks (default setTimeout 0). */
  delay?: (fn: () => void) => void;
}

export function installIndexedDB(
  g: typeof globalThis,
  natives: StorageNatives,
  options: InstallIndexedDBOptions = {},
): string[] {
  const delay = options.delay ?? ((fn: () => void) => setTimeout(fn, 0));
  const openDatabase = makeOpenDatabase(natives, 'idb', delay);
  // The shim installs into a private namespace object (its `indexedDB` getter insists on being read
  // from the object it was installed on); the globals are then defined on `g` from there.
  const target: Record<string, unknown> = {};
  const shimmed = setGlobalVars(
    target as never,
    {
      win: { openDatabase } as never,
      // Database files live in the area directory; names are relative and escaped by the shim.
      databaseBasePath: '',
      sysDatabaseBasePath: '',
      addSQLiteExtension: true,
      deleteDatabaseFiles: true,
      checkOrigin: false,
      cacheDatabaseInstances: true,
      useSQLiteIndexes: true,
      escapeNFDForDatabaseNames: false,
      fs: {
        unlink(path: string, cb: (err: Error | null) => void) {
          natives.sqlDelete('idb', path.replace(/^.*[\\/]/, ''), (e) =>
            cb(e ? new Error(e) : null),
          );
        },
      } as never,
    } as never,
  ) as {
    shimIndexedDB?: {
      __useShim(): void;
      __setConnectionQueueOrigin(origin?: string): void;
    };
  };
  shimmed.shimIndexedDB?.__useShim();
  patchAbortBeforeStart(target);
  if (options.origin)
    shimmed.shimIndexedDB?.__setConnectionQueueOrigin(options.origin);
  const installed: string[] = [];
  for (const name of IDB_GLOBALS) {
    const value = target[name];
    if (value === undefined) continue;
    Object.defineProperty(g, name, {
      value,
      writable: true,
      configurable: true,
      enumerable: name === 'indexedDB',
    });
    installed.push(name);
  }
  return installed;
}

/**
 * Workaround for an IndexedDBShim 19.0.7 race (to report upstream): a readwrite transaction aborted
 * before its WebSQL transaction starts (abort() in the same task that created it) fires `abort` without
 * a ROLLBACK, then still starts the WebSQL transaction (BEGIN) and never finishes it, so every later
 * transaction on that connection waits forever. An already-aborted transaction has nothing to run, so
 * it must not start a WebSQL transaction at all.
 */
function patchAbortBeforeStart(target: Record<string, unknown>): void {
  const T = (
    target.IDBTransaction as { prototype?: Record<string, unknown> } | undefined
  )?.prototype;
  if (!T || typeof T.__executeRequests !== 'function' || T.__iwnPatched) return;
  const original = T.__executeRequests as (
    this: Record<string, unknown>,
  ) => void;
  T.__executeRequests = function (this: Record<string, unknown>) {
    if (this.__errored) {
      this.__running = true;
      return;
    }
    original.call(this);
  };
  T.__iwnPatched = true;
}
