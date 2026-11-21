/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The shipped prelude (minified net bundle) in a bare vm context, after the glue bundle when it is
// built (web/glue/dist/glue.min.js): the same starting point and order as a runtime isolate.

import assert from 'node:assert/strict';
import { randomFillSync } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { build } from 'esbuild';

import { BridgeNatives, bridgeAvailable } from './bridge-natives.ts';
import { makeDist } from './helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const gluePath = join(here, '..', '..', 'glue', 'dist', 'glue.min.js');
const haveGlue = existsSync(gluePath);
let bridge: BridgeNatives | null = null;
let ctx: vm.Context;

async function netBundle(): Promise<string> {
  const { buildOptions } = (await import(join(here, '..', 'build.mjs'))) as { buildOptions: Record<string, unknown> };
  const r = await build({ ...buildOptions, minify: true, write: false, outfile: 'net.min.js' } as never);
  return r.outputFiles![0]!.text;
}

before(async () => {
  if (bridgeAvailable) {
    bridge = new BridgeNatives({ assets: makeDist(16).dir });
    await bridge.ready;
  }
  const natives: Record<string, unknown> = {
    crypto: { random: (u8: Uint8Array) => randomFillSync(u8) },
  };
  // As shipped: the native module has no WebSocket transport unless the app opts in.
  if (bridge) {
    const b = bridge;
    natives.net = new Proxy(b, {
      get: (t, k) => {
        if (k === 'wsConnect' || k === 'wsSend' || k === 'wsClose') return undefined;
        const v = (t as unknown as Record<string | symbol, unknown>)[k];
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
  }
  ctx = vm.createContext({ setTimeout, clearTimeout, console, __iwn: natives });
  if (haveGlue) vm.runInContext(readFileSync(gluePath, 'utf8'), ctx, { filename: 'glue.min.js' });
  else {
    // Without the glue, borrow the host's web globals the net layer needs.
    for (const k of ['URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'EventTarget', 'Event', 'DOMException', 'AbortController', 'AbortSignal', 'Blob', 'queueMicrotask']) {
      (ctx as Record<string, unknown>)[k] = (globalThis as Record<string, unknown>)[k];
    }
  }
  vm.runInContext(await netBundle(), ctx, { filename: 'net.min.js' });
});

after(async () => {
  await bridge?.close();
});

test('the prelude installs the network globals in a bare context; WebSocket stays absent (not opted in)', () => {
  const types = vm.runInContext(
    `['fetch','Headers','Request','Response','XMLHttpRequest','ReadableStream','WritableStream','TransformStream','WebSocket'].map((n) => typeof globalThis[n])`,
    ctx,
  ) as string[];
  assert.deepEqual([...types], ['function', 'function', 'function', 'function', 'function', 'function', 'function', 'function', 'undefined']);
});

test('data: fetch and Response streams work inside the context', async () => {
  const text = await vm.runInContext(`fetch('data:text/plain,inside').then((r) => r.text())`, ctx);
  assert.equal(text, 'inside');
  const streamed = await vm.runInContext(
    `(async () => { const r = new Response('abc'); const rd = r.body.getReader(); const { value } = await rd.read(); return value.length + ':' + r.bodyUsed; })()`,
    ctx,
  );
  assert.equal(streamed, '3:true');
});

test('blob URLs from the glue resolve in fetch', { skip: haveGlue ? false : 'glue bundle not built' }, async () => {
  const text = await vm.runInContext(
    `(async () => { const u = URL.createObjectURL(new Blob(['from glue'], { type: 'text/x' })); const r = await fetch(u); const t = r.headers.get('content-type') + '|' + await r.text(); URL.revokeObjectURL(u); let failed = false; try { await fetch(u); } catch (e) { failed = e instanceof TypeError; } return t + '|' + failed; })()`,
    ctx,
  );
  assert.equal(text, 'text/x|from glue|true');
});

test('assets through the real core from inside the context', { skip: bridgeAvailable ? false : 'bridge not built' }, async () => {
  const out = await vm.runInContext(
    `(async () => { const r = await fetch('/_app/x.js'); const b = await r.blob(); return r.status + ':' + b.size + ':' + b.type + ':' + (await fetch('/missing')).status; })()`,
    ctx,
  );
  assert.equal(out, '200:20:text/javascript:404');
});
