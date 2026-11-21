/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// XMLHttpRequest (NET-11) over fetch, through the real C++ core.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { XMLHttpRequest } from '../src/xhr.ts';
import { bridgeAvailable } from './bridge-natives.ts';
import { makeDist, setupBridge, startHttpServer, type TestHttpServer } from './helpers.ts';

const skip = bridgeAvailable ? false : 'iwn_net_bridge not built (node scripts/build-bridge.mjs)';
let server: TestHttpServer;
let env: Awaited<ReturnType<typeof setupBridge>>;

before(async () => {
  if (skip) return;
  server = await startHttpServer((req, res, body) => {
    if (req.url === '/json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-B', '2');
      res.setHeader('X-A', '1');
      res.end('{"n":42}');
    } else if (req.url === '/echo') {
      res.end(`${req.method} ${req.headers['x-h']} ${body.toString()}`);
    } else if (req.url === '/hang') {
      // never answers
    } else {
      res.statusCode = 404;
      res.end('missing');
    }
  });
  env = await setupBridge({ assets: makeDist(16).dir, allow: [server.origin], debug: true });
});
after(async () => {
  if (skip) return;
  await env.bridge.close();
  await server.close();
});

function run(xhr: XMLHttpRequest, body?: unknown): Promise<string[]> {
  const log: string[] = [];
  return new Promise((resolve) => {
    xhr.onreadystatechange = () => log.push(`rs${xhr.readyState}`);
    for (const t of ['loadstart', 'progress', 'load', 'error', 'abort', 'timeout']) xhr.addEventListener(t, () => log.push(t));
    xhr.onloadend = () => {
      log.push('loadend');
      resolve(log);
    };
    xhr.send(body as XMLHttpRequestBodyInit);
  });
}

test('async GET: readyState sequence, events, text and headers', { skip }, async () => {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', `${server.origin}/json`);
  assert.equal(xhr.readyState, 1);
  const log = await run(xhr);
  assert.deepEqual(log.filter((l) => !l.startsWith('rs3') && l !== 'progress'), ['loadstart', 'rs2', 'rs4', 'load', 'loadend']);
  assert.equal(xhr.status, 200);
  assert.equal(xhr.responseText, '{"n":42}');
  assert.equal(xhr.getResponseHeader('X-A'), '1');
  assert.match(xhr.getAllResponseHeaders(), /x-a: 1\r\nx-b: 2\r\n/);
  assert.equal(xhr.responseURL, `${server.origin}/json`);
});

test('responseType json, arraybuffer, blob', { skip }, async () => {
  for (const [type, check] of [
    ['json', (r: unknown) => assert.deepEqual(r, { n: 42 })],
    ['arraybuffer', (r: unknown) => assert.equal((r as ArrayBuffer).byteLength, 8)],
    ['blob', (r: unknown) => assert.equal((r as Blob).type, 'application/json')],
  ] as const) {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', `${server.origin}/json`);
    xhr.responseType = type;
    await run(xhr);
    check(xhr.response);
    assert.throws(() => xhr.responseText, { name: 'InvalidStateError' });
  }
});

test('POST with headers and body; 404 is a load, not an error', { skip }, async () => {
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `${server.origin}/echo`);
  xhr.setRequestHeader('X-H', 'v');
  xhr.setRequestHeader('Host', 'dropped');
  await run(xhr, 'payload');
  assert.equal(xhr.responseText, 'POST v payload');
  const nf = new XMLHttpRequest();
  nf.open('GET', `${server.origin}/nope`);
  const log = await run(nf);
  assert.equal(nf.status, 404);
  assert.ok(log.includes('load'));
});

test('synchronous requests throw InvalidAccessError on the main thread (documented deviation)', { skip }, () => {
  const xhr = new XMLHttpRequest();
  assert.throws(() => xhr.open('GET', '/x', false), { name: 'InvalidAccessError' });
});

test('abort and timeout', { skip }, async () => {
  const a = new XMLHttpRequest();
  a.open('GET', `${server.origin}/hang`);
  const p = run(a);
  setTimeout(() => a.abort(), 30);
  const la = await p;
  assert.ok(la.includes('abort'));
  assert.equal(a.readyState, 0);
  assert.equal(a.status, 0);
  const t = new XMLHttpRequest();
  t.open('GET', `${server.origin}/hang`);
  t.timeout = 100;
  const lt = await run(t);
  assert.ok(lt.includes('timeout'));
});

test('blocked origins fire error', { skip }, async () => {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', 'https://blocked.example/x');
  const log = await run(xhr);
  assert.ok(log.includes('error'));
  assert.equal(xhr.status, 0);
});

test('same-origin assets through XHR (three FileLoader fallback path)', { skip }, async () => {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', '/_app/x.js');
  await run(xhr);
  assert.equal(xhr.status, 200);
  assert.equal(xhr.responseText, 'export const x = 1;\n');
});
