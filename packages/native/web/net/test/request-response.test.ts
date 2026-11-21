/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Request / Response / body (NET-9), WPT fetch/api/{request,response}/* style, no server.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Request } from '../src/request.ts';
import { Response } from '../src/response.ts';
import { setReadableStreamForTests } from '../src/streams.ts';
import { setup } from './helpers.ts';

setup(null); // base URL https://app.local/

test('Response constructor checks', () => {
  assert.throws(() => new Response('x', { status: 199 }), RangeError);
  assert.throws(() => new Response('x', { status: 600 }), RangeError);
  assert.throws(() => new Response('x', { status: 204 }), TypeError);
  assert.throws(() => new Response(null, { statusText: 'a\nb' }), TypeError);
  const r = new Response(null, { status: 204 });
  assert.equal(r.body, null);
  assert.equal(r.ok, true);
  assert.equal(r.type, 'default');
  assert.equal(new Response('', { status: 404 }).ok, false);
});

test('Response body consumers and bodyUsed', async () => {
  const r = new Response('héllo');
  assert.equal(r.headers.get('content-type'), 'text/plain;charset=UTF-8');
  assert.equal(r.bodyUsed, false);
  assert.equal(await r.text(), 'héllo');
  assert.equal(r.bodyUsed, true);
  await assert.rejects(r.text(), TypeError);
  assert.deepEqual(await new Response('{"a":1}').json(), { a: 1 });
  const ab = await new Response(new Uint8Array([1, 2, 3])).arrayBuffer();
  assert.deepEqual([...new Uint8Array(ab)], [1, 2, 3]);
  const bytes = await new Response(new Uint8Array([4, 5])).bytes();
  assert.ok(bytes instanceof Uint8Array);
  const blob = await new Response('abc', {
    headers: { 'Content-Type': 'Text/Plain; Charset=UTF-8' },
  }).blob();
  assert.equal(blob.type, 'text/plain;charset=utf-8');
  assert.equal(await blob.text(), 'abc');
  const fd = await new Response(new URLSearchParams('a=1&b=2')).formData();
  assert.equal(fd.get('b'), '2');
});

test('BOM is stripped by text(); invalid UTF-8 becomes U+FFFD', async () => {
  assert.equal(
    await new Response(new Uint8Array([0xef, 0xbb, 0xbf, 0x41, 0xff])).text(),
    'A�',
  );
});

test('buffer bodies are copied at construction', async () => {
  const src = new Uint8Array([1, 2, 3]);
  const r = new Response(src);
  src[0] = 9;
  assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [1, 2, 3]);
});

test('body stream: getReader, async iteration, locked body is unusable', async () => {
  const r = new Response('stream me');
  const reader = r.body!.getReader();
  await assert.rejects(r.text(), TypeError);
  const { value } = await reader.read();
  assert.equal(new TextDecoder().decode(value), 'stream me');
  assert.equal((await reader.read()).done, true);
  const r2 = new Response('it');
  let out = '';
  for await (const chunk of r2.body as unknown as AsyncIterable<Uint8Array>)
    out += new TextDecoder().decode(chunk);
  assert.equal(out, 'it');
  const r3 = new Response('x');
  await r3.body!.cancel();
  assert.equal(r3.bodyUsed, true);
});

test('clone tees: both branches read the same bytes, used body cannot be cloned', async () => {
  const r = new Response('twice');
  const c = r.clone();
  assert.equal(await r.text(), 'twice');
  assert.equal(await c.text(), 'twice');
  assert.throws(() => r.clone(), TypeError);
  const s = new Response(
    new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode('s'));
        ctrl.close();
      },
    }),
  );
  const sc = s.clone();
  assert.equal(await sc.text(), 's');
  assert.equal(await s.text(), 's');
});

test('Response.error / redirect / json', async () => {
  const e = Response.error();
  assert.equal(e.type, 'error');
  assert.equal(e.status, 0);
  assert.throws(() => e.headers.set('a', 'b'), TypeError);
  const r = Response.redirect('/next', 301);
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), 'https://app.local/next');
  assert.throws(() => Response.redirect('/x', 200), RangeError);
  const j = Response.json({ ok: true }, { status: 201 });
  assert.equal(j.status, 201);
  assert.equal(j.headers.get('content-type'), 'application/json');
  assert.deepEqual(await j.json(), { ok: true });
});

test('Request: URL resolution, credentials, methods, GET with body', () => {
  const r = new Request('/a/b?q#frag');
  assert.equal(r.url, 'https://app.local/a/b?q#frag'); // Fetch: request.url keeps the fragment
  assert.equal(r.method, 'GET');
  assert.equal(new Request('/x', { method: 'post' }).method, 'POST');
  assert.equal(new Request('/x', { method: 'patch' }).method, 'patch');
  assert.throws(() => new Request('https://u:p@x.com/'), TypeError);
  assert.throws(() => new Request('/x', { method: 'TRACE' }), TypeError);
  assert.throws(() => new Request('/x', { method: 'bad method' }), TypeError);
  assert.throws(() => new Request('/x', { body: 'a' }), TypeError);
  assert.throws(() => new Request('/x', { mode: 'navigate' }), TypeError);
  assert.throws(() => new Request('/x', { redirect: 'nope' }), TypeError);
  assert.equal(new Request('/x').redirect, 'follow');
  assert.equal(new Request('/x').credentials, 'same-origin');
});

test('Request: headers guard drops forbidden headers, body content-type, clone, re-wrap', async () => {
  const r = new Request('/x', {
    method: 'POST',
    body: 'hi',
    headers: { Host: 'evil', 'X-A': '1' },
  });
  assert.equal(r.headers.get('host'), null);
  assert.equal(r.headers.get('x-a'), '1');
  assert.equal(r.headers.get('content-type'), 'text/plain;charset=UTF-8');
  const c = r.clone();
  assert.equal(await c.text(), 'hi');
  const wrapped = new Request(r);
  assert.equal(r.bodyUsed, true);
  assert.equal(await wrapped.text(), 'hi');
  assert.throws(() => new Request(r), TypeError);
});

test('Request: signal follows the init signal', () => {
  const ac = new AbortController();
  const r = new Request('/x', { signal: ac.signal });
  assert.equal(r.signal.aborted, false);
  ac.abort();
  assert.equal(r.signal.aborted, true);
  assert.equal((r.signal.reason as DOMException).name, 'AbortError');
});

test('streaming request bodies need duplex: half', () => {
  const body = new ReadableStream();
  assert.throws(() => new Request('/x', { method: 'POST', body }), TypeError);
  assert.equal(
    new Request('/x', {
      method: 'POST',
      body: new ReadableStream(),
      duplex: 'half',
    }).duplex,
    'half',
  );
});

test('the streams polyfill works as the body stream implementation', async () => {
  const ponyfill = await import('web-streams-polyfill');
  setReadableStreamForTests(
    ponyfill.ReadableStream as unknown as typeof ReadableStream,
  );
  try {
    const r = new Response('poly');
    const reader = r.body!.getReader();
    const { value } = await reader.read();
    assert.equal(new TextDecoder().decode(value), 'poly');
    const c = new Response('tee').clone();
    assert.equal(await c.text(), 'tee');
  } finally {
    setReadableStreamForTests(null);
  }
});
