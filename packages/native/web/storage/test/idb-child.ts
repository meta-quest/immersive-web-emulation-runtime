/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// One "app launch" for the IndexedDB persistence test: `node idb-child.ts <dir> write|read|crash`.
// write: creates a database and commits records; crash: commits one transaction, leaves a second one
// in flight and exits without closing; read: prints what survived as JSON.

import { installIndexedDB } from '../src/indexeddb.ts';
import { FakeStorageNatives } from './fake-natives.ts';

const [dir, mode] = process.argv.slice(2);
const natives = new FakeStorageNatives(dir);
const g = globalThis as unknown as Record<string, unknown>;
installIndexedDB(globalThis, natives);
const idb = g.indexedDB as IDBFactory;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function open(): Promise<IDBDatabase> {
  const r = idb.open('game', 1);
  r.onupgradeneeded = () => {
    const db = r.result;
    const store = db.createObjectStore('saves', { keyPath: 'id' });
    store.createIndex('byLevel', 'level');
  };
  return req(r);
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('aborted'));
  });
}

const db = await open();
if (mode === 'write' || mode === 'crash') {
  const tx = db.transaction('saves', 'readwrite');
  tx.objectStore('saves').put({
    id: 'slot1',
    level: 3,
    data: new Uint8Array([1, 2, 3]),
    at: new Date(0),
  });
  tx.objectStore('saves').put({ id: 'slot2', level: 7, data: 'text' });
  await done(tx);
  if (mode === 'crash') {
    const tx2 = db.transaction('saves', 'readwrite');
    tx2.objectStore('saves').put({ id: 'uncommitted', level: 1 });
    // Exit before the transaction can commit (simulated force-stop).
    setTimeout(() => process.exit(0), 0);
  } else {
    db.close();
    console.log(JSON.stringify({ ok: true }));
  }
} else {
  const tx = db.transaction('saves', 'readonly');
  const all = await req(tx.objectStore('saves').getAll());
  const byLevel = await req(
    tx.objectStore('saves').index('byLevel').getAll(IDBKeyRange.lowerBound(5)),
  );
  console.log(
    JSON.stringify({
      ids: (all as Array<{ id: string }>).map((r) => r.id),
      slot1: (all as Array<{ id: string; data: unknown; at: unknown }>)
        .filter((r) => r.id === 'slot1')
        .map((r) => ({
          bytes: [...(r.data as Uint8Array)],
          date: (r.at as Date).getTime?.(),
        })),
      highLevel: (byLevel as Array<{ id: string }>).map((r) => r.id),
    }),
  );
  db.close();
}
