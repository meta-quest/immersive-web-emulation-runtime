/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { MAX_PHASE_MS, originAllowed, phaseMsProblem, runTrace } from '../src/trace-run.ts';
import { directivePrologueLength, isInside, isModuleImport, looksLikeModule, startCompatServer } from '../src/server.ts';
import { tempDir, writeTree } from './helpers.ts';

test('server: module detection does not mistake importScripts or dynamic import for module syntax', () => {
  assert.equal(looksLikeModule('importScripts("a.js");x()'), false);
  assert.equal(looksLikeModule('const m = import("./x.js")'), false);
  assert.equal(looksLikeModule('import x from "y";'), true);
  assert.equal(looksLikeModule('import{a}from"b"'), true);
  assert.equal(looksLikeModule('x=1;export{a}'), true);
  assert.equal(looksLikeModule('console.log(import.meta.url)'), true);
});

test('server: the worker tracer goes after a "use strict" prologue', async () => {
  assert.equal(directivePrologueLength('"use strict";var a'), 13);
  assert.equal(directivePrologueLength('var a = "x";'), 0);
  const dist = writeTree(tempDir(), { 'index.html': '<html><head></head></html>', 'w.js': '"use strict";\nself.onmessage = () => {};' });
  const s = await startCompatServer({ distDir: dist, toolFiles: { 't.js': '' }, injectScripts: [], workerTracer: 't.js', onReport: () => {}, phase: () => 'xr' });
  try {
    const body = await (await fetch(`${s.origin}/w.js`, { headers: { 'sec-fetch-dest': 'worker' } })).text();
    assert.match(body, /^"use strict";\nimportScripts\("\/__iwn_compat\/t\.js"\);/);
    const rep = await fetch(`${s.origin}/__iwn_compat/report`, { method: 'POST', body: '{}' });
    assert.deepEqual(await rep.json(), { phase: 'xr' });
    assert.equal((await fetch(`${s.origin}/..%2f..%2fetc/passwd`)).status, 403);
  } finally {
    await s.close();
  }
  assert.equal(isInside('/a/b', '/a/bc/x'), false);
  assert.equal(isInside('/a/b', '/a/b/x'), true);
});

test('trace run: allowlist matching (exact and wildcard origins)', () => {
  assert.equal(originAllowed('https://cdn.jsdelivr.net/npm/x', ['https://cdn.jsdelivr.net']), true);
  assert.equal(originAllowed('https://cdn.jsdelivr.net/npm/x', ['https://*.jsdelivr.net']), true);
  assert.equal(originAllowed('https://evil.net/?https://cdn.jsdelivr.net', ['https://cdn.jsdelivr.net']), false);
  assert.equal(originAllowed('http://cdn.jsdelivr.net/x', ['https://cdn.jsdelivr.net']), false);
});

function get(url: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get(url, { headers }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(body));
      })
      .on('error', reject);
  });
}

test('server: a module worker\'s static imports are served as they are (no importScripts in a module worker)', async () => {
  const dist = writeTree(tempDir(), { 'index.html': '<html><head></head></html>', 'w.js': "import './side.js';", 'side.js': 'self.sideLoaded = true;', 'c.js': 'self.x = 1;' });
  const s = await startCompatServer({ distDir: dist, toolFiles: { 't.js': '' }, injectScripts: [], workerTracer: 't.js', onReport: () => {} });
  try {
    // the page registers its worker entry before fetching it
    await fetch(`${s.origin}/__iwn_compat/worker-type?type=module&url=${encodeURIComponent(`${s.origin}/w.js`)}`);
    const entry = await get(`${s.origin}/w.js`, { 'sec-fetch-dest': 'worker', referer: `${s.origin}/` });
    assert.match(entry, /^import "\/__iwn_compat\/t\.js";/);
    const side = await get(`${s.origin}/side.js`, { 'sec-fetch-dest': 'worker', referer: `${s.origin}/w.js` });
    assert.equal(side, 'self.sideLoaded = true;');
    // an unregistered classic worker started by the page still gets the tracer
    const classic = await get(`${s.origin}/c.js`, { 'sec-fetch-dest': 'worker', referer: `${s.origin}/index.html` });
    assert.match(classic, /^importScripts\(/);
  } finally {
    await s.close();
  }
  assert.equal(isModuleImport('http://o/a/w.js', 'http://o'), true);
  assert.equal(isModuleImport('http://o/', 'http://o'), false);
  assert.equal(isModuleImport('http://other/w.js', 'http://o'), false);
});

// a regression of the hard cap must fail this test, not hang the suite
test('trace run: a page whose main thread never yields does not hang the run', { timeout: 20_000 }, async () => {
  const dist = writeTree(tempDir(), { 'index.html': '<html><head></head></html>' });
  let closed = false;
  const page = {
    on() {},
    async goto() {},
    evaluate: () => new Promise(() => {}), // never answers
    waitForTimeout: (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
  };
  const fake = {
    chromium: {
      launch: async () => ({
        newContext: async () => ({ route: async () => {}, newPage: async () => page, close: async () => {} }),
        close: async () => {
          closed = true;
        },
      }),
    },
  };
  const t0 = Date.now();
  const r = await runTrace({ distDir: dist, iwerSource: '', playwright: fake, evalTimeoutMs: 200, bootTimeoutMs: 1000 });
  assert.ok(Date.now() - t0 < 5000);
  assert.match(r.hung ?? '', /did not answer within 200 ms/);
  assert.equal(r.reachedXR, false);
  assert.ok(closed);
  // the hard cap covers everything else (e.g. a goto that never settles)
  page.goto = () => new Promise(() => {});
  const r2 = await runTrace({ distDir: dist, iwerSource: '', playwright: fake, hardCapMs: 300 });
  assert.match(r2.hung ?? '', /hard cap of 300 ms/);
  // a load that never finishes (a script looping before the load event) is a hang too: the run returns with `hung`
  page.goto = async () => {
    const e = new Error('page.goto: Timeout 200ms exceeded.');
    e.name = 'TimeoutError';
    throw e;
  };
  const r3 = await runTrace({ distDir: dist, iwerSource: '', playwright: fake, evalTimeoutMs: 200 });
  assert.match(r3.hung ?? '', /did not finish loading within 200 ms/);
  // other goto failures still throw
  page.goto = async () => {
    throw new Error('net::ERR_FAILED');
  };
  await assert.rejects(runTrace({ distDir: dist, iwerSource: '', playwright: fake, evalTimeoutMs: 200 }), /ERR_FAILED/);
});

test('trace run: concurrent runs keep their own evaluate timeouts', { timeout: 20_000 }, async () => {
  const dist = writeTree(tempDir(), { 'index.html': '<html><head></head></html>' });
  const fake = {
    chromium: {
      launch: async () => ({
        newContext: async () => ({
          route: async () => {},
          newPage: async () => ({ on() {}, async goto() {}, evaluate: () => new Promise(() => {}), waitForTimeout: (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 20))) }),
          close: async () => {},
        }),
        close: async () => {},
      }),
    },
  };
  const [a, b] = await Promise.all([
    runTrace({ distDir: dist, iwerSource: '', playwright: fake, evalTimeoutMs: 1500, bootTimeoutMs: 1000 }),
    runTrace({ distDir: dist, iwerSource: '', playwright: fake, evalTimeoutMs: 100, bootTimeoutMs: 1000 }),
  ]);
  assert.match(a.hung ?? '', /within 1500 ms/);
  assert.match(b.hung ?? '', /within 100 ms/);
});

test('server: an unreadable dist file is a 500 for that request, not a crash', { skip: process.getuid?.() === 0 ? 'root reads mode-000 files' : false }, async () => {
  const dist = writeTree(tempDir(), { 'index.html': '<html><head></head></html>', 'secret.png': 'x', 'ok.png': 'y' });
  chmodSync(path.join(dist, 'secret.png'), 0o000);
  const s = await startCompatServer({ distDir: dist, toolFiles: {}, injectScripts: [], workerTracer: 'w.js', onReport: () => {} });
  try {
    const bad = await fetch(`${s.origin}/secret.png`);
    assert.equal(bad.status, 500);
    assert.match([...s.unreadable.keys()].join(), /secret\.png/);
    const ok = await fetch(`${s.origin}/ok.png`);
    assert.equal(await ok.text(), 'y');
  } finally {
    chmodSync(path.join(dist, 'secret.png'), 0o600);
    await s.close();
  }
});

test('trace run: a page error with an empty stack keeps its name and message; a busy boot is marked still loading', { timeout: 20_000 }, async () => {
  const dist = writeTree(tempDir(), { 'index.html': '<html><head></head></html>' });
  const handlers: Record<string, (e: unknown) => void> = {};
  const page = {
    on(ev: string, fn: (e: unknown) => void) {
      handlers[ev] = fn;
    },
    async goto() {
      const e = Object.assign(new Error('The requested XRSession mode is not supported.'), { name: 'NotSupportedError', stack: '' });
      handlers.pageerror?.(e);
    },
    // every poll is slow: the main thread is busy
    evaluate: () => new Promise((r) => setTimeout(() => r({ state: 'waiting' }), 1_100)),
    waitForTimeout: (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
  };
  const fake = { chromium: { launch: async () => ({ newContext: async () => ({ route: async () => {}, newPage: async () => page, close: async () => {} }), close: async () => {} }) } };
  const r = await runTrace({ distDir: dist, iwerSource: '', playwright: fake, bootTimeoutMs: 1_500, xrMs: 10 });
  assert.deepEqual(r.pageErrors, ['NotSupportedError: The requested XRSession mode is not supported.']);
  assert.equal(r.reachedXR, false);
  assert.match(r.stillLoading ?? '', /poll took \d+ ms/);
});

test('server: WebSocket upgrades are refused, and blocked ones the tracer redirects are reported', async () => {
  const dist = writeTree(tempDir(), { 'index.html': '<html><head></head></html>' });
  const seen: string[] = [];
  const s = await startCompatServer({ distDir: dist, toolFiles: {}, injectScripts: [], workerTracer: 't.js', onReport: () => {}, onWebSocketBlocked: (u) => seen.push(u) });
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(`${s.origin}/__iwn_compat/ws-blocked?u=${encodeURIComponent('wss://game.example-mp.net/room')}`, { headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
      req.on('response', (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('upgrade', () => reject(new Error('upgraded')));
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
    assert.deepEqual(seen, ['wss://game.example-mp.net/room']);
  } finally {
    await s.close();
  }
});

test('trace run: boot/XR times must be usable timer delays (no 1 ms hard cap, no run left behind)', async () => {
  assert.equal(phaseMsProblem('--boot-ms', '25000'), undefined);
  for (const bad of ['3000000000', 'NaN', '0', '-5', '', 'abc', String(MAX_PHASE_MS + 1)]) assert.ok(phaseMsProblem('--boot-ms', bad), bad);
  const dist = writeTree(tempDir(), { 'index.html': '<html><head></head></html>' });
  let launched = 0;
  const playwright = { chromium: { launch: async () => { launched++; throw new Error('not reached'); } } };
  await assert.rejects(runTrace({ distDir: dist, iwerSource: '', playwright, bootTimeoutMs: 3_000_000_000 }), RangeError);
  await assert.rejects(runTrace({ distDir: dist, iwerSource: '', playwright, bootTimeoutMs: Number.NaN }), RangeError);
  assert.equal(launched, 0);
  // the cap fires while Chromium launches: the browser that comes up afterwards is closed, and nothing else runs
  let closed = 0;
  let pages = 0;
  const slow = { chromium: { launch: () => new Promise((resolve) => setTimeout(() => resolve({ close: async () => { closed++; }, newContext: async () => { pages++; throw new Error('should not run'); } }), 300)) } };
  const r = await runTrace({ distDir: dist, iwerSource: '', playwright: slow, hardCapMs: 50 });
  assert.match(r.hung ?? '', /hard cap of 50 ms/);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(closed, 1);
  assert.equal(pages, 0);
});

test('trace run: ws(s) URLs are matched against the http(s) origin; ws(s) entries cover nothing', () => {
  assert.equal(originAllowed('wss://game.example-mp.net/room', ['https://game.example-mp.net']), true);
  assert.equal(originAllowed('ws://game.example-mp.net/room', ['http://game.example-mp.net']), true);
  assert.equal(originAllowed('wss://eu.game.net/room', ['https://*.game.net']), true);
  assert.equal(originAllowed('ws://game.example-mp.net/room', ['https://game.example-mp.net']), false);
  assert.equal(originAllowed('wss://game.example-mp.net/room', ['wss://game.example-mp.net']), false);
});
