/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The shipped preludes in a bare vm context, in runtime order: glue (when built), net, storage, idb.

import assert from 'node:assert/strict';
import { randomFillSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { build } from 'esbuild';

import { FakeStorageNatives } from './fake-natives.ts';

const here = dirname(fileURLToPath(import.meta.url));
const gluePath = join(here, '..', '..', 'glue', 'dist', 'glue.min.js');
const haveGlue = existsSync(gluePath);
let ctx: vm.Context;

async function bundle(
  entry: string,
  root: string,
  options: Record<string, unknown>,
): Promise<string> {
  const r = await build({
    ...options,
    entryPoints: [entry],
    minify: true,
    write: false,
    outfile: 'x.js',
    absWorkingDir: root,
  } as never);
  return r.outputFiles![0]!.text;
}

before(async () => {
  const natives = new FakeStorageNatives(
    mkdtempSync(join(tmpdir(), 'iwn-bundle-')),
  );
  const netNatives = {
    config: () => ({
      allow: [],
      debug: false,
      origin: 'https://app.local',
      userAgent: 't',
      timeoutMs: 1000,
    }),
    readAsset: (
      _p: string,
      cb: (
        s: number,
        b: ArrayBuffer | null,
        m: string,
        mapped: boolean,
      ) => void,
    ) => setImmediate(() => cb(404, null, '', false)),
  };
  ctx = vm.createContext({
    setTimeout,
    clearTimeout,
    console,
    __iwn: {
      crypto: { random: (u8: Uint8Array) => randomFillSync(u8) },
      storage: natives,
      net: netNatives,
    },
  });
  if (haveGlue) {
    vm.runInContext(readFileSync(gluePath, 'utf8'), ctx);
  } else {
    for (const k of [
      'URL',
      'URLSearchParams',
      'TextEncoder',
      'TextDecoder',
      'EventTarget',
      'Event',
      'DOMException',
      'AbortController',
      'AbortSignal',
      'Blob',
      'queueMicrotask',
    ]) {
      (ctx as Record<string, unknown>)[k] = (
        globalThis as Record<string, unknown>
      )[k];
    }
    vm.runInContext(
      'globalThis.navigator = {}; globalThis.window = globalThis; globalThis.self = globalThis;',
      ctx,
    );
  }
  const netRoot = join(here, '..', '..', 'net');
  const { buildOptions } = (await import(join(netRoot, 'build.mjs'))) as {
    buildOptions: Record<string, unknown>;
  };
  vm.runInContext(
    await bundle(join(netRoot, 'src/entry.ts'), netRoot, buildOptions),
    ctx,
  );
  const { common, entries } = (await import(join(here, '..', 'build.mjs'))) as {
    common: Record<string, unknown>;
    entries: Record<string, string>;
  };
  vm.runInContext(await bundle(entries.storage, join(here, '..'), common), ctx);
  vm.runInContext(await bundle(entries.idb, join(here, '..'), common), ctx);
});

test('globals present in a bare context', () => {
  const t = vm.runInContext(
    `['localStorage','sessionStorage','Storage','indexedDB','IDBKeyRange','caches','CacheStorage'].map((n) => typeof globalThis[n])`,
    ctx,
  ) as string[];
  assert.deepEqual(
    [...t],
    [
      'object',
      'object',
      'function',
      'object',
      'function',
      'object',
      'function',
    ],
  );
});

test('localStorage and IndexedDB work inside the context', async () => {
  const out = await vm.runInContext(
    `(async () => {
      localStorage.setItem('k', 'v');
      const r = indexedDB.open('ctx', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('s');
      const db = await new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const tx = db.transaction('s', 'readwrite');
      tx.objectStore('s').put({ a: [1, 2] }, 'key');
      await new Promise((res) => (tx.oncomplete = res));
      const g = db.transaction('s').objectStore('s').get('key');
      const v = await new Promise((res) => (g.onsuccess = () => res(g.result)));
      db.close();
      const c = await caches.open('c');
      await c.put('https://app.local/z', new Response('cached'));
      const t = await (await caches.match('https://app.local/z')).text();
      return localStorage.getItem('k') + ':' + JSON.stringify(v) + ':' + t;
    })()`,
    ctx,
  );
  assert.equal(out, 'v:{"a":[1,2]}:cached');
});
