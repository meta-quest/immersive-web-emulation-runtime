/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Cache API over the SQLite contract and the net layer's fetch/Request/Response.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, test } from 'node:test';

import { installNet } from '../../net/src/install.ts';
import type { NetNatives } from '../../net/src/natives.ts';
import { installIdbAndCaches } from '../src/install-idb.ts';
import { FakeStorageNatives } from './fake-natives.ts';

const files: Record<string, string> = {
  '/data.json': '{"v":1}',
  '/b.txt': 'bee',
};
let assetReads = 0;
const netNatives: NetNatives = {
  config: () => ({
    allow: [],
    debug: false,
    origin: 'https://app.local',
    userAgent: 'test',
    timeoutMs: 1000,
  }),
  readAsset(path, cb) {
    assetReads++;
    const body = files[path];
    setImmediate(() =>
      body === undefined
        ? cb(404, null, '', false)
        : cb(
            200,
            new TextEncoder().encode(body).buffer as ArrayBuffer,
            path.endsWith('.json') ? 'application/json' : 'text/plain',
            false,
          ),
    );
  },
  httpStart: () => 0,
  httpAck() {},
  httpAbort() {},
  wsConnect: () => 0,
  wsSend() {},
  wsClose() {},
};

let caches: CacheStorage;
let fake: FakeStorageNatives;

before(() => {
  installNet(globalThis, { natives: netNatives, mode: 'all' });
  fake = new FakeStorageNatives(mkdtempSync(join(tmpdir(), 'iwn-cache-')));
  installIdbAndCaches(globalThis, { natives: fake });
  caches = (globalThis as unknown as { caches: CacheStorage }).caches;
});

test('open/has/keys/delete on CacheStorage', async () => {
  assert.equal(await caches.has('v1'), false);
  await caches.open('v1');
  await caches.open('v2');
  assert.equal(await caches.has('v1'), true);
  assert.deepEqual(await caches.keys(), ['v1', 'v2']);
  assert.equal(await caches.delete('v2'), true);
  assert.equal(await caches.delete('v2'), false);
  assert.deepEqual(await caches.keys(), ['v1']);
});

test('put/match/matchAll/keys/delete with query options', async () => {
  const c = await caches.open('main');
  await c.put(
    'https://app.local/x?a=1',
    new Response('one', {
      headers: { 'content-type': 'text/plain', 'x-h': 'h' },
    }),
  );
  await c.put(
    new Request('https://app.local/x?a=2'),
    new Response('two', { status: 201, statusText: 'Made' }),
  );
  const m = await c.match('https://app.local/x?a=1');
  assert.ok(m);
  assert.equal(await m.text(), 'one');
  assert.equal(m.headers.get('x-h'), 'h');
  const m2 = (await c.match('https://app.local/x?a=2'))!;
  assert.equal(m2.status, 201);
  assert.equal(m2.statusText, 'Made');
  assert.equal(await c.match('https://app.local/x'), undefined);
  assert.equal(
    (await c.matchAll('https://app.local/x', { ignoreSearch: true })).length,
    2,
  );
  assert.equal(
    await c.match(
      new Request('https://app.local/x?a=1', { method: 'POST', body: 'b' }),
    ),
    undefined,
  );
  assert.ok(
    await c.match(
      new Request('https://app.local/x?a=1', { method: 'POST', body: 'b' }),
      { ignoreMethod: true },
    ),
  );
  assert.deepEqual(
    (await c.keys()).map((r) => r.url),
    ['https://app.local/x?a=1', 'https://app.local/x?a=2'],
  );
  // put() replaces the entry for the same request.
  await c.put('https://app.local/x?a=1', new Response('uno'));
  assert.equal(await (await c.match('https://app.local/x?a=1'))!.text(), 'uno');
  assert.equal((await c.keys()).length, 2);
  assert.equal(
    await c.delete('https://app.local/x', { ignoreSearch: true }),
    true,
  );
  assert.equal((await c.keys()).length, 0);
  assert.equal(await caches.match('https://app.local/x?a=1'), undefined);
});

test('Vary: matching uses the stored request headers; Vary: * is refused', async () => {
  const c = await caches.open('vary');
  await c.put(
    new Request('https://app.local/v', {
      headers: { 'Accept-Language': 'en' },
    }),
    new Response('en', { headers: { vary: 'Accept-Language' } }),
  );
  assert.equal(
    await c.match(
      new Request('https://app.local/v', {
        headers: { 'Accept-Language': 'de' },
      }),
    ),
    undefined,
  );
  assert.equal(
    await (await c.match(
      new Request('https://app.local/v', {
        headers: { 'Accept-Language': 'en' },
      }),
    ))!.text(),
    'en',
  );
  assert.ok(await c.match('https://app.local/v', { ignoreVary: true }));
  await assert.rejects(
    c.put(
      'https://app.local/star',
      new Response('x', { headers: { vary: '*' } }),
    ),
    TypeError,
  );
});

test('put() refuses non-GET, non-http(s), 206 and used bodies', async () => {
  const c = await caches.open('rules');
  await assert.rejects(
    c.put(
      new Request('https://app.local/p', { method: 'POST', body: 'x' }),
      new Response('x'),
    ),
    TypeError,
  );
  await assert.rejects(
    c.put('data:text/plain,x', new Response('x')),
    TypeError,
  );
  await assert.rejects(
    c.put('https://app.local/r', new Response('x', { status: 206 })),
    TypeError,
  );
  const used = new Response('x');
  await used.text();
  await assert.rejects(c.put('https://app.local/u', used), TypeError);
});

test('add/addAll fetch through the runtime and store the responses; failures store nothing', async () => {
  const c = await caches.open('assets');
  await c.addAll(['/data.json', '/b.txt']);
  assert.deepEqual(
    await (await c.match('https://app.local/data.json'))!.json(),
    { v: 1 },
  );
  const b = (await caches.match('/b.txt', { cacheName: 'assets' }))!;
  assert.equal(b.headers.get('content-type'), 'text/plain');
  assert.equal(b.url, 'https://app.local/b.txt');
  assert.equal(b.type, 'basic');
  const reads = assetReads;
  await assert.rejects(c.addAll(['/b.txt', '/missing']), TypeError);
  assert.ok(assetReads > reads);
  assert.equal((await c.keys()).length, 2);
});

test('cached entries survive a reopen of the CacheStorage (same files)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iwn-cache-persist-'));
  const g1 = {} as Record<string | symbol, unknown>;
  g1[Symbol.for('iwn.net')] = (
    globalThis as unknown as Record<symbol, unknown>
  )[Symbol.for('iwn.net')];
  installIdbAndCaches(g1 as unknown as typeof globalThis, {
    natives: new FakeStorageNatives(dir),
  });
  const c1 = await (g1.caches as CacheStorage).open('p');
  await c1.put(
    'https://app.local/keep',
    new Response(new Uint8Array([1, 2, 3])),
  );
  const natives2 = new FakeStorageNatives(dir);
  const g2 = { [Symbol.for('iwn.net')]: g1[Symbol.for('iwn.net')] } as Record<
    string | symbol,
    unknown
  >;
  installIdbAndCaches(g2 as unknown as typeof globalThis, {
    natives: natives2,
  });
  const got = await (g2.caches as CacheStorage).match('https://app.local/keep');
  assert.deepEqual([...new Uint8Array(await got!.arrayBuffer())], [1, 2, 3]);
});

test('put() and keys() never read cached bodies; match() reads only the returned one', async () => {
  const c = await caches.open('models');
  const big = new Uint8Array(1 << 20);
  for (let i = 0; i < 8; i++)
    await c.put(`https://app.local/model${i}.glb`, new Response(big));
  fake.blobBytesRead = 0;
  await c.put('https://app.local/small.json', new Response('{}'));
  await c.put('https://app.local/model3.glb', new Response(big)); // replaces one entry
  assert.equal((await c.keys()).length, 9);
  assert.equal(fake.blobBytesRead, 0, 'put/keys read bodies');
  const r = await c.match('https://app.local/model5.glb');
  assert.equal((await r!.arrayBuffer()).byteLength, 1 << 20);
  assert.equal(
    fake.blobBytesRead,
    1 << 20,
    'match read more than the matched body',
  );
  await caches.delete('models');
});

test('a put() whose insert fails leaves the old entry in place (atomic)', async () => {
  const c = await caches.open('atomic');
  await c.put('https://app.local/m.bin', new Response('old'));
  fake.failNext = /^\s*INSERT INTO entries/;
  await assert.rejects(
    c.put('https://app.local/m.bin', new Response('new')),
    (e: Error) => e.name === 'UnknownError',
  );
  const r = await c.match('https://app.local/m.bin');
  assert.ok(r, 'old entry deleted by a failed put');
  assert.equal(await r.text(), 'old');
  // The database is usable afterwards (no transaction left open).
  await c.put('https://app.local/m.bin', new Response('newer'));
  assert.equal(
    await (await c.match('https://app.local/m.bin'))!.text(),
    'newer',
  );
});
