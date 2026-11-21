/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// fetch to allowlisted origins through the real C++ HTTP client (NET-5..7, NET-9) against a Node
// loopback server. Cleartext loopback is allowed because the bridge runs as a debug build.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { gzipSync } from 'node:zlib';

import { bridgeAvailable } from './bridge-natives.ts';
import { exposeGc, makeDist, setupBridge, sleep, startHttpServer, type TestHttpServer } from './helpers.ts';

const skip = bridgeAvailable ? false : 'iwn_net_bridge not built (node scripts/build-bridge.mjs)';
let server: TestHttpServer;
let env: Awaited<ReturnType<typeof setupBridge>>;
const big = Buffer.alloc(4 * 1024 * 1024, 7);

before(async () => {
  if (skip) return;
  server = await startHttpServer((req, res, body) => {
    const u = new URL(req.url ?? '/', 'http://x');
    switch (u.pathname) {
      case '/hello':
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Set-Cookie', 'session=1');
        res.setHeader('X-Multi', ['a', 'b']);
        res.end('hello');
        return;
      case '/echo':
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ method: req.method, headers: req.headers, body: body.toString('base64') }));
        return;
      case '/redirect':
        res.statusCode = 302;
        res.setHeader('Location', '/hello');
        res.end();
        return;
      case '/redirect-303':
        res.statusCode = 303;
        res.setHeader('Location', '/echo');
        res.end();
        return;
      case '/away':
        res.statusCode = 302;
        res.setHeader('Location', 'https://not-allowed.example/x');
        res.end();
        return;
      case '/gzip':
        res.setHeader('Content-Encoding', 'gzip');
        res.end(gzipSync(Buffer.from('compressed '.repeat(1000))));
        return;
      case '/big':
        res.setHeader('Content-Length', String(big.length));
        res.end(big);
        return;
      case '/slow':
        res.setHeader('Content-Type', 'text/plain');
        res.write('first ');
        setTimeout(() => res.end('second'), 300);
        return;
      case '/hang':
        return; // never answers
      case '/status':
        res.statusCode = Number(u.searchParams.get('code'));
        res.statusMessage = 'Custom Reason';
        res.end();
        return;
      default:
        res.statusCode = 404;
        res.end('nf');
    }
  });
  env = await setupBridge({ assets: makeDist(16).dir, allow: [server.origin], debug: true, timeoutMs: 2000 });
});

after(async () => {
  if (skip) return;
  await env.bridge.close();
  await server.close();
});

test('allowlisted origin: status, lower-cased headers, Set-Cookie dropped, type cors', { skip }, async () => {
  const r = await env.fetch(`${server.origin}/hello`);
  assert.equal(r.status, 200);
  assert.equal(r.statusText, 'OK');
  assert.equal(r.type, 'cors');
  assert.equal(r.url, `${server.origin}/hello`);
  assert.equal(r.redirected, false);
  assert.equal(r.headers.get('content-type'), 'text/plain');
  assert.equal(r.headers.get('x-multi'), 'a, b');
  assert.equal(r.headers.get('set-cookie'), null);
  for (const [name] of r.headers) assert.equal(name, name.toLowerCase());
  assert.equal(await r.text(), 'hello');
  assert.throws(() => r.headers.set('x', 'y'), TypeError);
});

test('request method, headers and bodies reach the server', { skip }, async () => {
  const cases: Array<[unknown, string, string | undefined]> = [
    ['text body', 'text body', 'text/plain;charset=UTF-8'],
    [new Uint8Array([1, 2, 3]), '\u0001\u0002\u0003', undefined],
    [new Blob(['blob'], { type: 'x/y' }), 'blob', 'x/y'],
    [new URLSearchParams('a=1&b=%20'), 'a=1&b=+', 'application/x-www-form-urlencoded;charset=UTF-8'],
  ];
  for (const [body, expected, type] of cases) {
    const r = await env.fetch(`${server.origin}/echo`, { method: 'PUT', body: body as BodyInit, headers: { 'X-Custom': 'v' } });
    const j = (await r.json()) as { method: string; headers: Record<string, string>; body: string };
    assert.equal(j.method, 'PUT');
    assert.equal(Buffer.from(j.body, 'base64').toString('latin1'), expected);
    assert.equal(j.headers['x-custom'], 'v');
    assert.equal(j.headers['content-type'], type);
    assert.equal(j.headers['accept-encoding'], 'gzip, deflate');
    assert.equal(j.headers['user-agent'], 'iwer-native-test');
  }
  const form = new FormData();
  form.append('field', 'value');
  form.append('file', new Blob(['filedata'], { type: 'text/plain' }), 'f.txt');
  const r = await env.fetch(`${server.origin}/echo`, { method: 'POST', body: form });
  const j = (await r.json()) as { headers: Record<string, string>; body: string };
  assert.match(j.headers['content-type'], /^multipart\/form-data; boundary=/);
  const text = Buffer.from(j.body, 'base64').toString();
  assert.match(text, /name="field"\r\n\r\nvalue\r\n/);
  assert.match(text, /filename="f.txt"\r\nContent-Type: text\/plain\r\n\r\nfiledata\r\n/);
});

test('redirects: follow (with 303 → GET), manual (opaqueredirect), error', { skip }, async () => {
  const r = await env.fetch(`${server.origin}/redirect`);
  assert.equal(r.redirected, true);
  assert.equal(r.url, `${server.origin}/hello`);
  assert.equal(await r.text(), 'hello');
  const p = await env.fetch(`${server.origin}/redirect-303`, { method: 'POST', body: 'x' });
  assert.equal(((await p.json()) as { method: string }).method, 'GET');
  const m = await env.fetch(`${server.origin}/redirect`, { redirect: 'manual' });
  assert.equal(m.type, 'opaqueredirect');
  assert.equal(m.status, 0);
  assert.equal(m.body, null);
  await assert.rejects(env.fetch(`${server.origin}/redirect`, { redirect: 'error' }), TypeError);
  await assert.rejects(env.fetch(`${server.origin}/away`), TypeError);
});

test('blocked origins reject with TypeError and log once per origin (NET-5)', { skip }, async () => {
  env.warnings.length = 0;
  for (let i = 0; i < 100; i++) {
    await assert.rejects(env.fetch('https://cdn.not-listed.example/model.glb'), TypeError);
  }
  await assert.rejects(env.fetch('http://example.com/'), TypeError); // cleartext to a non-loopback host
  const lines = env.warnings.filter((w) => w.includes('cdn.not-listed.example'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /native\.network\.allow/);
  assert.ok(env.registry.blockedOrigins().includes('https://cdn.not-listed.example'));
  // The native layer never saw the blocked requests.
  assert.ok(!env.bridge.sent.some((l) => l.startsWith('H') && Buffer.from(l.split(' ')[2], 'base64').toString().includes('not-listed')));
});

test('gzip bodies are decoded; large bodies arrive intact with flow control', { skip }, async () => {
  assert.equal(await (await env.fetch(`${server.origin}/gzip`)).text(), 'compressed '.repeat(1000));
  const r = await env.fetch(`${server.origin}/big`);
  const buf = new Uint8Array(await r.arrayBuffer());
  assert.equal(buf.length, big.length);
  assert.ok(buf.every((b) => b === 7));
});

test('body streams deliver data as it arrives', { skip }, async () => {
  const r = await env.fetch(`${server.origin}/slow`);
  const reader = r.body!.getReader();
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), 'first ');
  let rest = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    rest += new TextDecoder().decode(value);
  }
  assert.equal(rest, 'second');
});

test('abort before and during the response rejects with AbortError', { skip }, async () => {
  const ac = new AbortController();
  const p = env.fetch(`${server.origin}/hang`, { signal: ac.signal });
  await sleep(50);
  ac.abort();
  await assert.rejects(p, { name: 'AbortError' });
  const ac2 = new AbortController();
  const r = await env.fetch(`${server.origin}/slow`, { signal: ac2.signal });
  ac2.abort();
  await assert.rejects(r.text(), { name: 'AbortError' });
  const custom = new AbortController();
  custom.abort(new Error('mine'));
  await assert.rejects(env.fetch(`${server.origin}/hello`, { signal: custom.signal }), /mine/);
});

test('timeouts surface as TypeError (configured 2 s in this suite)', { skip }, async () => {
  await assert.rejects(env.fetch(`${server.origin}/hang`), (e: Error) => e instanceof TypeError && /timed out|timeout|no response/.test(e.message));
});

test('status and reason phrase pass through; null-body statuses have no body', { skip }, async () => {
  const r = await env.fetch(`${server.origin}/status?code=418`);
  assert.equal(r.status, 418);
  assert.equal(r.statusText, 'Custom Reason');
  assert.equal(r.ok, false);
  const n = await env.fetch(`${server.origin}/status?code=204`);
  assert.equal(n.body, null);
});

test('connection refused rejects with TypeError', { skip }, async () => {
  const dead = await startHttpServer(() => {});
  const origin = dead.origin;
  await dead.close();
  const env2 = await setupBridge({ assets: makeDist(16).dir, allow: [origin], debug: true });
  try {
    await assert.rejects(env2.fetch(`${origin}/x`), TypeError);
  } finally {
    await env2.bridge.close();
  }
});

test('unread bodies are released when garbage-collected, so an origin cannot wedge (6 per origin)', { skip }, async () => {
  const gc = exposeGc();
  const abortsBefore = env.bridge.sent.filter((l) => l.startsWith('X ')).length;
  // 9 responses of 4 MiB, more than the per-origin limit, each dropped without reading its body.
  let heads = 0;
  for (let i = 0; i < 9; i++) {
    void env.fetch(`${server.origin}/big?unread=${i}`).then((r) => {
      heads += r.status === 200 ? 1 : 0;
    });
  }
  const deadline = Date.now() + 15000;
  while (heads < 9 && Date.now() < deadline) {
    gc();
    await sleep(50);
  }
  assert.equal(heads, 9, 'queued requests never started: unread bodies kept their slots');
  for (let i = 0; i < 5; i++) {
    gc();
    await sleep(20);
  }
  const aborts = env.bridge.sent.filter((l) => l.startsWith('X ')).length - abortsBefore;
  assert.ok(aborts >= 3, `expected collected bodies to abort their requests, saw ${aborts}`);
  const r = await env.fetch(`${server.origin}/hello`);
  assert.equal(await r.text(), 'hello');
});

test('a body that is being read is never collected', { skip }, async () => {
  const gc = exposeGc();
  // Only a pending arrayBuffer() promise references the response.
  const p = env.fetch(`${server.origin}/big?reading=1`).then((r) => r.arrayBuffer());
  for (let i = 0; i < 10; i++) {
    gc();
    await sleep(10);
  }
  assert.equal((await p).byteLength, big.length);
});

test('Request keeps the URL fragment; it is not sent', { skip }, async () => {
  const before = server.requests.length;
  const r = await env.fetch(`${server.origin}/echo#frag`);
  await r.text();
  assert.equal(server.requests[before].url, '/echo');
  const { Request: R } = env.global as unknown as { Request: typeof Request };
  assert.equal(new R(`${server.origin}/a#x`).url, `${server.origin}/a#x`);
});
