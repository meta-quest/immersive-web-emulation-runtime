/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// A WebSQL `openDatabase` over the native SQLite service, built from websql-configurable (Apache-2.0):
// its WebSQLDatabase/WebSQLTransaction give the WebSQL transaction semantics IndexedDBShim relies on;
// this file supplies the driver (`exec(queries, readOnly, cb)`) that runs each batch on the database's
// native worker thread (never on the JS thread). Write transactions are BEGIN … END on one connection
// opened WAL + synchronous=FULL, so a committed IndexedDB transaction is durable.

import customOpenDatabase from 'websql-configurable/custom/index.js';

import type { SqlArea, SqlResult, StorageNatives } from './natives.ts';

interface Query {
  sql: string;
  args: unknown[];
}

interface DriverResult {
  error: Error | null;
  insertId?: number;
  rowsAffected?: number;
  rows?: unknown[];
}

/** Names reach native code relative to the area directory (IsSafeDatabaseName there). */
function fileName(name: string): string {
  return name.replace(/^.*[\\/]/, '');
}

export function makeOpenDatabase(natives: StorageNatives, area: SqlArea, delay: (fn: () => void) => void) {
  class NativeSqlDriver {
    #handle: number;
    #closed = false;
    constructor(name: string) {
      this.#handle = natives.sqlOpen(area, fileName(name));
    }
    exec(queries: Query[], readOnly: boolean, callback: (err: Error | null, results?: DriverResult[]) => void): void {
      if (this.#closed) {
        callback(null, queries.map(() => ({ error: new Error('database is closed') })));
        return;
      }
      natives.sqlExec(
        this.#handle,
        queries.map((q) => q.sql),
        queries.map((q) => q.args as never[]),
        readOnly,
        (results: SqlResult[]) => {
          callback(
            null,
            results.map((r) =>
              r.error !== undefined
                ? { error: new Error(r.error) }
                : { error: null, insertId: r.insertId, rowsAffected: r.rowsAffected, rows: r.rows ?? [] },
            ),
          );
        },
      );
    }
    close(cb?: (err: Error | null) => void): void {
      if (this.#closed) return cb?.(null);
      this.#closed = true;
      natives.sqlClose(this.#handle, (e) => cb?.(e ? new Error(e) : null));
    }
  }
  return customOpenDatabase(NativeSqlDriver as never, {
    websql: {
      // Same reasoning as IndexedDBShim's Node driver: concurrent read-only transactions must not
      // deadlock each other.
      concurrentReaders: true,
      openDelay: delay,
      transactionDelay: delay,
      executeDelay: delay,
    },
  } as never) as (name: string, version: string, description: string, size: number, cb?: unknown) => unknown;
}
