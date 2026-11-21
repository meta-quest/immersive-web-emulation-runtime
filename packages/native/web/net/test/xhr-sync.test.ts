/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Synchronous XMLHttpRequest in a worker (NET-11): the natives of a worker isolate have blocking
// httpSync/readAssetSync; here they are the real C++ FetchBlocking path (bridge --once). The HTTP server
// runs in a worker_thread because a synchronous request blocks this thread's event loop.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Worker } from 'node:worker_threads';

import { XMLHttpRequest } from '../src/xhr.ts';
import { bridgeAvailable } from './bridge-natives.ts';
import { makeDist, setupBridge } from './helpers.ts';

const skip = bridgeAvailable ? false : 'iwn_net_bridge not built (node scripts/build-bridge.mjs)';
let server: Worker;
let origin = '';
let env: Awaited<ReturnType<typeof setupBridge>>;

const SERVER = `
const { createServer } = require('node:http');
const { gzipSync } = require('node:zlib');
const { parentPort } = require('node:worker_threads');
const s = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    if (req.url === '/json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-A', '1');
      res.end('{"n":42}');
    } else if (req.url === '/echo') {
      res.end(req.method + ' ' + req.headers['x-h'] + ' ' + req.headers['content-type'] + ' ' + body);
    } else if (req.url === '/gzip') {
      res.setHeader('Content-Encoding', 'gzip');
      res.end(gzipSync(Buffer.from('z'.repeat(3 * 1024 * 1024))));
    } else if (req.url === '/redirect') {
      res.statusCode = 302;
      res.setHeader('Location', '/json');
      res.end();
    } else if (req.url === '/hang') {
      // never answers
    } else {
      res.statusCode = 404;
      res.end('missing');
    }
  });
});
s.listen(0, '127.0.0.1', () => parentPort.postMessage(s.address().port));
`;

before(async () => {
  if (skip) return;
  server = new Worker(SERVER, { eval: true });
  const port = await new Promise<number>((r) => server.once('message', r));
  origin = `http://127.0.0.1:${port}`;
  env = await setupBridge({ assets: makeDist(16).dir, allow: [origin], debug: true, worker: true, timeoutMs: 5000 });
});
after(async () => {
  if (skip) return;
  await env.bridge.close();
  await server.terminate();
});

function events(xhr: XMLHttpRequest): string[] {
  const log: string[] = [];
  xhr.onreadystatechange = () => log.push(`rs${xhr.readyState}`);
  for (const t of ['loadstart', 'progress', 'load', 'error', 'abort', 'timeout', 'loadend']) xhr.addEventListener(t, () => log.push(t));
  return log;
}

test('synchronous GET in a worker: blocks, then readyState 4, load, loadend (no progress events)', { skip }, () => {
  const xhr = new XMLHttpRequest();
  const log = events(xhr);
  xhr.open('GET', `${origin}/json`, false);
  xhr.send();
  assert.equal(xhr.readyState, 4);
  assert.equal(xhr.status, 200);
  assert.equal(xhr.responseText, '{"n":42}');
  assert.equal(xhr.getResponseHeader('x-a'), '1');
  assert.equal(xhr.getResponseHeader('content-type'), 'application/json');
  assert.deepEqual(log, ['rs1', 'rs4', 'load', 'loadend']);
});

test('synchronous POST with headers and body; redirects; gzip', { skip }, () => {
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `${origin}/echo`, false);
  xhr.setRequestHeader('X-H', 'v');
  xhr.send('payload');
  assert.equal(xhr.responseText, 'POST v text/plain;charset=UTF-8 payload');
  const r = new XMLHttpRequest();
  r.open('GET', `${origin}/redirect`, false);
  r.send();
  assert.equal(r.status, 200);
  assert.equal(r.responseURL, `${origin}/json`);
  const g = new XMLHttpRequest();
  g.open('GET', `${origin}/gzip`, false);
  g.responseType = 'arraybuffer';
  g.send();
  assert.equal((g.response as ArrayBuffer).byteLength, 3 * 1024 * 1024);
});

test('synchronous same-origin asset reads, 404, HEAD and data: URLs', { skip }, () => {
  const a = new XMLHttpRequest();
  a.open('GET', '/_app/x.js', false);
  a.send();
  assert.equal(a.status, 200);
  assert.equal(a.responseText, 'export const x = 1;\n');
  assert.equal(a.getResponseHeader('content-type'), 'text/javascript');
  const m = new XMLHttpRequest();
  m.open('GET', '/missing.txt', false);
  m.send();
  assert.equal(m.status, 404);
  const d = new XMLHttpRequest();
  d.open('GET', 'data:text/plain;base64,aGk=', false);
  d.send();
  assert.equal(d.responseText, 'hi');
});

test('synchronous errors throw after readystatechange: NetworkError, TimeoutError', { skip }, () => {
  const b = new XMLHttpRequest();
  const log = events(b);
  b.open('GET', 'https://blocked.example/x', false);
  assert.throws(() => b.send(), { name: 'NetworkError' });
  assert.equal(b.readyState, 4);
  assert.equal(b.status, 0);
  assert.deepEqual(log, ['rs1', 'rs4']); // no error/loadend events for synchronous requests
  assert.ok(env.warnings.some((w) => w.includes('blocked.example')));
  const t = new XMLHttpRequest();
  t.open('GET', `${origin}/hang`, false);
  t.timeout = 300;
  const t0 = Date.now();
  assert.throws(() => t.send(), { name: 'TimeoutError' });
  const ms = Date.now() - t0;
  assert.ok(ms >= 250 && ms < 3000, `timeout took ${ms} ms`);
  const n = new XMLHttpRequest();
  n.open('GET', `http://127.0.0.1:1/`, false);
  assert.throws(() => n.send(), { name: 'NetworkError' });
});

test('asynchronous requests still work in the worker', { skip }, async () => {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', '/_app/x.js');
  await new Promise<void>((resolve) => {
    xhr.onloadend = () => resolve();
    xhr.send();
  });
  assert.equal(xhr.status, 200);
});
