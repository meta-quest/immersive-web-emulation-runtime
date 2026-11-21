/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// StorageNatives for Node tests: the same contract as runtime/storage/binding/storage_binding.cc, over
// node:sqlite (files in a temp dir, so "restarts" can reopen them) and a JSON file for the KV log.
// Completions are asynchronous (setImmediate), as native completions are tasks.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { SqlArea, SqlResult, SqlValue, StorageNatives } from '../src/natives.ts';

export class FakeStorageNatives implements StorageNatives {
  readonly dir: string;
  kvWrites = 0;
  kvFlushes = 0;
  /** BLOB bytes handed to JS by sqlExec (memory probe for the Cache API). */
  blobBytesRead = 0;
  /** Fail the next statement whose SQL matches (simulates SQLITE_FULL & co.). */
  failNext: RegExp | null = null;
  #kv = new Map<string, string>();
  #handles = new Map<number, { db: DatabaseSync; area: SqlArea; name: string }>();
  #next = 1;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(join(dir, 'idb'), { recursive: true });
    mkdirSync(join(dir, 'cache'), { recursive: true });
  }

  #kvPath(): string {
    return join(this.dir, 'local-storage.json');
  }

  kvOpen() {
    if (existsSync(this.#kvPath())) {
      this.#kv = new Map(JSON.parse(readFileSync(this.#kvPath(), 'utf8')) as Array<[string, string]>);
    }
    return { entries: [...this.#kv].flat(), warning: '', persistent: true };
  }
  #persist(): void {
    this.kvWrites++;
    writeFileSync(this.#kvPath(), JSON.stringify([...this.#kv]));
  }
  kvSet(k: string, v: string): void {
    this.#kv.set(k, v);
    this.#persist();
  }
  kvRemove(k: string): void {
    this.#kv.delete(k);
    this.#persist();
  }
  kvClear(): void {
    this.#kv.clear();
    this.#persist();
  }
  kvFlush(): void {
    this.kvFlushes++;
  }

  sqlOpen(area: SqlArea, name: string): number {
    if (!name || name.includes('/') || name.includes('\\') || name.startsWith('..')) throw new TypeError('sqlOpen: invalid database name');
    const db = new DatabaseSync(join(this.dir, area, name));
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    const h = this.#next++;
    this.#handles.set(h, { db, area, name });
    return h;
  }

  sqlExec(
    handle: number,
    sql: string[],
    args: SqlValue[][],
    readOnly: boolean,
    cb: (results: SqlResult[]) => void,
    atomic = false,
  ): void {
    const entry = this.#handles.get(handle);
    if (atomic && !readOnly && entry) {
      // Same contract as SqlDatabase::ExecAtomic.
      const results: SqlResult[] = [];
      entry.db.exec('BEGIN IMMEDIATE');
      let failed = false;
      for (let i = 0; i < sql.length; i++) {
        if (failed) {
          results.push({ error: 'not executed: transaction rolled back' });
          continue;
        }
        const r = this.#one(entry, sql[i], args[i] ?? [], false);
        results.push(r);
        if (r.error !== undefined) {
          failed = true;
          entry.db.exec('ROLLBACK');
        }
      }
      if (!failed) entry.db.exec('COMMIT');
      setImmediate(() => cb(results));
      return;
    }
    const results: SqlResult[] = sql.map((s, i) => (entry ? this.#one(entry, s, args[i] ?? [], readOnly) : { error: 'database is closed' }));
    setImmediate(() => cb(results));
  }

  #one(entry: { db: DatabaseSync }, s: string, args: SqlValue[], readOnly: boolean): SqlResult {
    {
      try {
        if (this.failNext && this.failNext.test(s)) {
          this.failNext = null;
          throw new Error('13 database or disk is full');
        }
        const stmt = entry.db.prepare(s);
        const bound = args.map((v) => {
          if (v === null || v === undefined) return null;
          if (typeof v === 'boolean') return v ? 1 : 0;
          if (v instanceof ArrayBuffer) return new Uint8Array(v);
          if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
          return v as string | number | bigint;
        });
        const returnsRows = stmt.columns().length > 0;
        if (readOnly && !/^\s*(SELECT|PRAGMA|WITH)\b/i.test(s)) return { error: 'could not prepare statement (23 not authorized)' };
        if (returnsRows) {
          const rows = (stmt.all(...bound) as Array<Record<string, unknown>>).map((row) => {
            const out: Record<string, number | string | ArrayBuffer | null> = {};
            for (const [k, v] of Object.entries(row)) {
              if (v instanceof Uint8Array) this.blobBytesRead += v.byteLength;
              out[k] = v instanceof Uint8Array ? v.slice().buffer : typeof v === 'bigint' ? Number(v) : (v as number | string | null);
            }
            return out;
          });
          return { insertId: 0, rowsAffected: 0, rows };
        }
        const r = stmt.run(...bound);
        return { insertId: Number(r.lastInsertRowid), rowsAffected: Number(r.changes), rows: [] };
      } catch (e) {
        return { error: `could not execute statement (${(e as Error).message})` };
      }
    }
  }

  sqlClose(handle: number, cb: (error: string | null) => void): void {
    const entry = this.#handles.get(handle);
    this.#handles.delete(handle);
    try {
      if (entry?.db.isTransaction) entry.db.exec('ROLLBACK');
      entry?.db.close();
    } catch {
      // ignore
    }
    setImmediate(() => cb(null));
  }

  sqlDelete(area: SqlArea, name: string, cb: (error: string | null) => void): void {
    for (const e of this.#handles.values()) {
      if (e.area === area && e.name === name) {
        setImmediate(() => cb('database is open'));
        return;
      }
    }
    for (const suffix of ['', '-wal', '-shm']) rmSync(join(this.dir, area, name + suffix), { force: true });
    setImmediate(() => cb(null));
  }

  estimate() {
    return { usage: 1234, quota: 512 * 1024 * 1024 };
  }

  /** Simulates an app exit: closes every connection (uncommitted transactions roll back). */
  shutdown(): void {
    for (const [h] of this.#handles) this.sqlClose(h, () => {});
  }
}
