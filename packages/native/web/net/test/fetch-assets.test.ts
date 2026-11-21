/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// fetch over the app's dist through the real C++ asset core (NET-1..4), plus data: and blob: URLs
// (NET-12, NET-14).

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { bridgeAvailable } from './bridge-natives.ts';
import { makeDist, setupBridge, sha256 } from './helpers.ts';

const skip = bridgeAvailable
  ? false
  : 'iwn_net_bridge not built (node scripts/build-bridge.mjs)';
let env: Awaited<ReturnType<typeof setupBridge>>;
const dist = makeDist();

before(async () => {
  if (skip) return;
  const blobs = new Map<string, Blob>();
  blobs.set(
    'blob:https://app.local/1234',
    new Blob(['blob body'], { type: 'text/x-test' }),
  );
  env = await setupBridge(
    { assets: dist.dir },
    { blobUrls: { resolve: (u: string) => blobs.get(u) ?? null } },
  );
});
after(async () => {
  if (!skip) await env.bridge.close();
});

test(
  'every dist file by its same-origin URL, byte for byte (NET-1)',
  { skip },
  async () => {
    const js = await env.fetch('https://app.local/_app/x.js');
    assert.equal(js.status, 200);
    assert.equal(js.type, 'basic');
    assert.equal(js.headers.get('content-type'), 'text/javascript');
    assert.equal(await js.text(), 'export const x = 1;\n');
    assert.deepEqual(await (await env.fetch('/.well-known/y.json')).json(), {
      y: 2,
    });
    assert.equal(await (await env.fetch('/%C3%BC.txt')).text(), 'umlaut');
    assert.equal(await (await env.fetch('./ü.txt')).text(), 'umlaut');
    const big = await env.fetch('/assets/model.glb?cache=1');
    assert.equal(big.headers.get('content-type'), 'model/gltf-binary');
    assert.equal(big.headers.get('content-length'), String(dist.big.length));
    assert.equal(sha256(await big.arrayBuffer()), dist.sha);
    const index = await env.fetch('/');
    assert.equal(index.headers.get('content-type'), 'text/html');
  },
);

test(
  'missing files and paths outside the dist are 404 responses, not rejections (NET-4)',
  { skip },
  async () => {
    const r = await env.fetch('/nope.js');
    assert.equal(r.status, 404);
    assert.equal(r.ok, false);
    const traversal = await env.fetch('/assets/%2e%2e/%2e%2e/etc/passwd');
    assert.equal(traversal.status, 404);
    const encodedSlash = await env.fetch('/assets%2Fmodel.glb');
    assert.equal(encodedSlash.status, 404);
  },
);

test('HEAD has no body; other methods get 405', { skip }, async () => {
  const head = await env.fetch('/_app/x.js', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
  const post = await env.fetch('/_app/x.js', { method: 'POST', body: 'x' });
  assert.equal(post.status, 405);
});

test('asset bodies stream as a ReadableStream too', { skip }, async () => {
  const r = await env.fetch('/assets/model.glb');
  const reader = r.body!.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
  }
  assert.equal(total, dist.big.length);
  assert.equal(r.bodyUsed, true);
});

test('an aborted asset fetch rejects with AbortError', { skip }, async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(env.fetch('/assets/model.glb', { signal: ac.signal }), {
    name: 'AbortError',
  });
  const ac2 = new AbortController();
  const p = env.fetch('/assets/model.glb', { signal: ac2.signal });
  ac2.abort();
  await assert.rejects(p, { name: 'AbortError' });
});

test('data: URLs, base64 and percent-encoded (NET-12)', { skip }, async () => {
  const a = await env.fetch('data:text/plain;base64,SGVsbG8=');
  assert.equal(a.headers.get('content-type'), 'text/plain');
  assert.equal(await a.text(), 'Hello');
  const b = await env.fetch('data:,a%20b%E2%82%AC');
  assert.equal(b.headers.get('content-type'), 'text/plain;charset=us-ascii');
  assert.equal(await b.text(), 'a b€');
  const c = await env.fetch('data:application/octet-stream;BASE64 , AAEC');
  assert.deepEqual([...new Uint8Array(await c.arrayBuffer())], [0, 1, 2]);
  await assert.rejects(env.fetch('data:text/plain;base64,%%%'), TypeError);
  await assert.rejects(env.fetch('data:nocomma'), TypeError);
});

test(
  'blob: URLs resolve through the glue store; unknown ones reject (NET-14)',
  { skip },
  async () => {
    const r = await env.fetch('blob:https://app.local/1234');
    assert.equal(r.headers.get('content-type'), 'text/x-test');
    assert.equal(r.headers.get('content-length'), '9');
    assert.equal(await r.text(), 'blob body');
    await assert.rejects(
      env.fetch('blob:https://app.local/revoked'),
      TypeError,
    );
    await assert.rejects(
      env.fetch('blob:https://app.local/1234', { method: 'POST', body: 'x' }),
      TypeError,
    );
  },
);

test('unsupported schemes reject with TypeError', { skip }, async () => {
  await assert.rejects(env.fetch('ftp://example.com/x'), TypeError);
  await assert.rejects(env.fetch('about:blank'), TypeError);
});
