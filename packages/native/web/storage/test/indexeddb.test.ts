/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// IndexedDB (indexeddbshim over the SQLite driver contract): the API, transactions, persistence across
// app restarts and durability of committed (and only committed) transactions.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { installIndexedDB } from '../src/indexeddb.ts';
import { FakeStorageNatives } from './fake-natives.ts';

const here = dirname(fileURLToPath(import.meta.url));
let idb: IDBFactory;
let natives: FakeStorageNatives;

before(() => {
  natives = new FakeStorageNatives(mkdtempSync(join(tmpdir(), 'iwn-idb-')));
  const installed = installIndexedDB(globalThis, natives);
  assert.ok(installed.includes('indexedDB'));
  idb = (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB;
});

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function txDone(tx: IDBTransaction): Promise<string> {
  return new Promise((resolve) => {
    tx.oncomplete = () => resolve('complete');
    tx.onabort = () => resolve('abort');
  });
}

test('open/upgrade, object stores, indexes, CRUD, cursors, key ranges', async () => {
  const open = idb.open('crud', 2);
  const versions: number[] = [];
  open.onupgradeneeded = (e) => {
    versions.push(
      (e as IDBVersionChangeEvent).oldVersion,
      (e as IDBVersionChangeEvent).newVersion!,
    );
    const db = open.result;
    const s = db.createObjectStore('items', {
      keyPath: 'id',
      autoIncrement: true,
    });
    s.createIndex('byTag', 'tag', { unique: false });
  };
  const db = await req(open);
  assert.deepEqual(versions, [0, 2]);
  assert.deepEqual([...db.objectStoreNames], ['items']);
  const tx = db.transaction('items', 'readwrite');
  const store = tx.objectStore('items');
  const k1 = await req(store.add({ tag: 'a', n: 1 }));
  const k2 = await req(store.add({ tag: 'b', n: 2 }));
  await req(store.add({ tag: 'a', n: 3 }));
  assert.equal(k1, 1);
  assert.equal(k2, 2);
  await req(store.put({ id: 2, tag: 'b', n: 20 }));
  await req(store.delete(1));
  assert.equal(await txDone(tx), 'complete');
  const ro = db.transaction('items', 'readonly').objectStore('items');
  assert.deepEqual(await req(ro.get(2)), { id: 2, tag: 'b', n: 20 });
  assert.equal(await req(ro.count()), 2);
  assert.deepEqual(
    (await req(ro.index('byTag').getAll('a'))).map((r: { n: number }) => r.n),
    [3],
  );
  const seen: number[] = [];
  await new Promise<void>((resolve, reject) => {
    const c = ro.openCursor(IDBKeyRange.bound(1, 10), 'prev');
    c.onsuccess = () => {
      const cur = c.result;
      if (!cur) return resolve();
      seen.push(cur.key as number);
      cur.continue();
    };
    c.onerror = () => reject(c.error);
  });
  assert.deepEqual(seen, [3, 2]);
  db.close();
});

test('aborted transactions roll back; constraint errors abort', async () => {
  const open = idb.open('abort', 1);
  open.onupgradeneeded = () => {
    open.result.createObjectStore('s').createIndex('u', 'u', { unique: true });
  };
  const db = await req(open);
  const t1 = db.transaction('s', 'readwrite');
  t1.objectStore('s').put({ u: 1 }, 'a');
  t1.abort();
  assert.equal(await txDone(t1), 'abort');
  assert.equal(await req(db.transaction('s').objectStore('s').count()), 0);
  const t2 = db.transaction('s', 'readwrite');
  t2.objectStore('s').put({ u: 1 }, 'a');
  const dup = t2.objectStore('s').put({ u: 1 }, 'b'); // violates the unique index
  dup.onerror = () => {}; // let the transaction abort
  assert.equal(await txDone(t2), 'abort');
  assert.equal(await req(db.transaction('s').objectStore('s').count()), 0);
  db.close();
});

test('structured clone of values (Date, typed arrays, Map, nested)', async () => {
  const open = idb.open('clone', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('s');
  const db = await req(open);
  const value = {
    d: new Date(1234),
    u8: new Uint8Array([9, 8]),
    m: new Map([['k', 1]]),
    nested: { arr: [1, 'two', null] },
  };
  const tx = db.transaction('s', 'readwrite');
  tx.objectStore('s').put(value, 'v');
  await txDone(tx);
  const got = (await req(
    db.transaction('s').objectStore('s').get('v'),
  )) as typeof value;
  assert.equal(got.d.getTime(), 1234);
  assert.deepEqual([...got.u8], [9, 8]);
  assert.equal(got.m.get('k'), 1);
  assert.deepEqual(got.nested, { arr: [1, 'two', null] });
  db.close();
});

test('deleteDatabase removes the SQLite file through the native delete', async () => {
  const open = idb.open('gone', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('s');
  const db = await req(open);
  db.close();
  await req(idb.deleteDatabase('gone') as unknown as IDBRequest<undefined>);
  const reopen = idb.open('gone');
  let upgraded = false;
  reopen.onupgradeneeded = () => (upgraded = true);
  const db2 = await req(reopen);
  assert.equal(upgraded, true);
  assert.equal(db2.version, 1);
  db2.close();
});

function child(dir: string, mode: string): unknown {
  const r = spawnSync(
    process.execPath,
    ['--no-warnings', join(here, 'idb-child.ts'), dir, mode],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.trim().split('\n').pop() ?? '';
  return line ? JSON.parse(line) : null;
}

test('data persists across app restarts; only committed transactions survive a force-stop', () => {
  const dir = mkdtempSync(join(tmpdir(), 'iwn-idb-restart-'));
  assert.deepEqual(child(dir, 'write'), { ok: true });
  const read = child(dir, 'read') as {
    ids: string[];
    slot1: Array<{ bytes: number[]; date: number }>;
    highLevel: string[];
  };
  assert.deepEqual(read.ids, ['slot1', 'slot2']);
  assert.deepEqual(read.slot1, [{ bytes: [1, 2, 3], date: 0 }]);
  assert.deepEqual(read.highLevel, ['slot2']);
  const dir2 = mkdtempSync(join(tmpdir(), 'iwn-idb-crash-'));
  child(dir2, 'crash');
  const afterCrash = child(dir2, 'read') as { ids: string[] };
  assert.deepEqual(afterCrash.ids, ['slot1', 'slot2']);
});
