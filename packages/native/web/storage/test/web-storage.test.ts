/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// localStorage / sessionStorage (NET-STORE-1/2), navigator.storage (NET-STORE-3).

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { installStorage } from '../src/install.ts';
import { installIdbAndCaches } from '../src/install-idb.ts';
import { createStorage, Storage } from '../src/web-storage.ts';
import { FakeStorageNatives } from './fake-natives.ts';

function freshGlobal(natives: FakeStorageNatives | null) {
  const g = new EventTarget() as unknown as Record<string, unknown>;
  g.navigator = {};
  const warnings: string[] = [];
  installStorage(g as unknown as typeof globalThis, { natives, warn: (m) => warnings.push(m) });
  return { g, warnings, local: g.localStorage as Storage, session: g.sessionStorage as Storage };
}

test('Storage API: getItem/setItem/removeItem/clear/key/length, String conversion', () => {
  const s = createStorage([], null);
  s.setItem('a', 1 as unknown as string);
  s.setItem('b', 'two');
  assert.equal(s.getItem('a'), '1');
  assert.equal(s.getItem('missing'), null);
  assert.equal(s.length, 2);
  assert.equal(s.key(0), 'a');
  assert.equal(s.key(1), 'b');
  assert.equal(s.key(2), null);
  s.removeItem('a');
  assert.equal(s.length, 1);
  s.clear();
  assert.equal(s.length, 0);
  assert.throws(() => new (Storage as unknown as new () => Storage)(), TypeError);
  assert.equal(Object.prototype.toString.call(s), '[object Storage]');
});

test('named properties: get, set, delete, in, Object.keys; prototype members win on get', () => {
  const s = createStorage([], null) as Storage & Record<string, unknown>;
  s.foo = 'bar';
  assert.equal(s.getItem('foo'), 'bar');
  assert.equal(s.foo, 'bar');
  assert.ok('foo' in s);
  assert.deepEqual(Object.keys(s), ['foo']);
  assert.deepEqual(JSON.parse(JSON.stringify(s)), { foo: 'bar' });
  delete s.foo;
  assert.equal(s.getItem('foo'), null);
  s.setItem('getItem', 'shadow?');
  assert.equal(typeof s.getItem, 'function');
  assert.equal(s.getItem('getItem'), 'shadow?');
  (s as unknown as Record<string, unknown>).length = 5;
  assert.equal(s.getItem('length'), '5');
  assert.equal(s.length, 2);
});

test('quota: 5 Mi code units per area → QuotaExceededError, nothing stored', () => {
  const s = createStorage([], null);
  const big = 'x'.repeat(5 * 1024 * 1024 - 10);
  s.setItem('k', big);
  assert.throws(() => s.setItem('k2', 'y'.repeat(20)), { name: 'QuotaExceededError' });
  assert.equal(s.getItem('k2'), null);
  s.setItem('k', 'small');
  s.setItem('k2', 'y'.repeat(20));
});

test('localStorage persists through the native KV (boot counter over 3 launches)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'iwn-ls-'));
  for (let launch = 1; launch <= 3; launch++) {
    const natives = new FakeStorageNatives(dir);
    const { local } = freshGlobal(natives);
    const n = Number(local.getItem('boots') ?? '0') + 1;
    local.setItem('boots', String(n));
    assert.equal(n, launch);
  }
});

test('localStorage mirrors every mutation; unchanged values are not re-sent; sessionStorage stays in memory', () => {
  const natives = new FakeStorageNatives(mkdtempSync(join(tmpdir(), 'iwn-ls-')));
  const { local, session } = freshGlobal(natives);
  local.setItem('a', '1');
  local.setItem('a', '1');
  local.removeItem('a');
  local.removeItem('a');
  local.clear();
  assert.equal(natives.kvWrites, 2);
  session.setItem('s', '1');
  assert.equal(natives.kvWrites, 2);
  assert.equal(session.getItem('s'), '1');
});

test('lone surrogates survive the round trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'iwn-ls-'));
  freshGlobal(new FakeStorageNatives(dir)).local.setItem('s', 'a\uD800b');
  assert.equal(freshGlobal(new FakeStorageNatives(dir)).local.getItem('s'), 'a\uD800b');
});

test('pagehide flushes the KV log without blocking', () => {
  const natives = new FakeStorageNatives(mkdtempSync(join(tmpdir(), 'iwn-ls-')));
  const { g } = freshGlobal(natives);
  (g as unknown as EventTarget).dispatchEvent(new Event('pagehide'));
  assert.equal(natives.kvFlushes, 1);
});

test('navigator.storage: estimate only; persist/persisted come with the opt-in idb prelude (NET-STORE-3)', async () => {
  const natives = new FakeStorageNatives(mkdtempSync(join(tmpdir(), 'iwn-ls-')));
  const { g } = freshGlobal(natives);
  const storage = (g.navigator as { storage: StorageManager }).storage;
  assert.deepEqual(await storage.estimate(), { usage: 1234, quota: 512 * 1024 * 1024 });
  assert.equal((storage as { persist?: unknown }).persist, undefined);
  assert.equal((storage as { persisted?: unknown }).persisted, undefined);
  installIdbAndCaches(g as unknown as typeof globalThis, { natives, origin: 'https://app.local' });
  assert.equal(await storage.persist(), true);
  assert.equal(await storage.persisted(), true);
  assert.deepEqual(await storage.estimate(), { usage: 1234, quota: 512 * 1024 * 1024 });
});

test('without natives localStorage works in memory', () => {
  const { local } = freshGlobal(null);
  local.setItem('x', 'y');
  assert.equal(local.getItem('x'), 'y');
});
