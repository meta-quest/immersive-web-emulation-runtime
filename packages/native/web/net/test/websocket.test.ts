/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// WebSocket (WHATWG) over the real C++ RFC 6455 client, against the `ws` server package.

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

import { WebSocketServer } from 'ws';

import { WebSocket } from '../src/websocket.ts';
import { bridgeAvailable } from './bridge-natives.ts';
import { makeDist, setupBridge } from './helpers.ts';

const skip = bridgeAvailable
  ? false
  : 'iwn_net_bridge not built (node scripts/build-bridge.mjs)';
let wss: WebSocketServer;
let port = 0;
let env: Awaited<ReturnType<typeof setupBridge>>;

function events(ws: WebSocket): { log: string[]; done: Promise<CloseEvent> } {
  const log: string[] = [];
  const done = new Promise<CloseEvent>((resolve) => {
    ws.addEventListener('open', () => log.push('open'));
    ws.addEventListener('error', () => log.push('error'));
    ws.addEventListener('message', (e) => {
      const d = (e as MessageEvent).data;
      log.push(
        'message:' +
          (typeof d === 'string'
            ? d
            : d instanceof ArrayBuffer
              ? `ab${d.byteLength}`
              : `blob${(d as Blob).size}`),
      );
    });
    ws.addEventListener('close', (e) => {
      const ce = e as CloseEvent;
      log.push(`close:${ce.code}:${ce.reason}:${ce.wasClean}`);
      resolve(ce);
    });
  });
  return { log, done };
}

before(async () => {
  if (skip) return;
  wss = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    handleProtocols: (protocols) => (protocols.has('chat') ? 'chat' : false),
  });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  port = (wss.address() as AddressInfo).port;
  wss.on('connection', (sock, req) => {
    sock.on('message', (data, isBinary) => {
      const text = isBinary ? null : data.toString();
      if (text === 'close-me') return sock.close(4001, 'server says bye');
      if (text === 'drop') return sock.terminate();
      if (text === 'origin') return sock.send(String(req.headers.origin));
      sock.send(data, { binary: isBinary });
    });
  });
  env = await setupBridge({
    assets: makeDist(16).dir,
    allow: [`http://127.0.0.1:${port}`],
    debug: true,
  });
});

after(async () => {
  if (skip) return;
  await env.bridge.close();
  await new Promise<void>((r) => wss.close(() => r()));
});

test(
  'open, subprotocol, text + binary echo, bufferedAmount, clean close',
  { skip },
  async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/path`, ['chat', 'other']);
    assert.equal(ws.readyState, WebSocket.CONNECTING);
    assert.throws(() => ws.send('too early'), { name: 'InvalidStateError' });
    const { log, done } = events(ws);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    assert.equal(ws.protocol, 'chat');
    assert.equal(ws.readyState, WebSocket.OPEN);
    ws.binaryType = 'arraybuffer';
    ws.send('héllo');
    ws.send(new Uint8Array(70000));
    assert.ok(ws.bufferedAmount >= 70000 + 6);
    ws.send(new Blob(['blobby']));
    ws.send('origin');
    await new Promise<void>((resolve) => {
      const check = () =>
        log.filter((l) => l.startsWith('message')).length >= 4
          ? resolve()
          : setTimeout(check, 10);
      check();
    });
    assert.deepEqual(log.slice(1, 5), [
      'message:héllo',
      'message:ab70000',
      'message:ab6',
      'message:https://app.local',
    ]);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(ws.bufferedAmount, 0);
    ws.close(1000, 'done');
    assert.equal(ws.readyState, WebSocket.CLOSING);
    const ce = await done;
    assert.equal(ce.code, 1000);
    assert.equal(ce.reason, 'done');
    assert.equal(ce.wasClean, true);
    assert.equal(ws.readyState, WebSocket.CLOSED);
    ws.send('after close'); // ignored, but counted
    assert.ok(ws.bufferedAmount > 0);
  },
);

test('blob binaryType (default) and on* handlers', { skip }, async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const got = await new Promise<unknown>((resolve) => {
    ws.onopen = () => ws.send(new Uint8Array([1, 2, 3]));
    ws.onmessage = (e) => resolve((e as MessageEvent).data);
  });
  assert.ok(got instanceof Blob);
  assert.equal((got as Blob).size, 3);
  ws.close();
  await new Promise((r) => (ws.onclose = r));
});

test('server-initiated close and abrupt drop', { skip }, async () => {
  const a = new WebSocket(`ws://127.0.0.1:${port}`);
  const ea = events(a);
  a.onopen = () => a.send('close-me');
  const ca = await ea.done;
  assert.equal(ca.code, 4001);
  assert.equal(ca.reason, 'server says bye');
  assert.equal(ca.wasClean, true);
  const b = new WebSocket(`ws://127.0.0.1:${port}`);
  const eb = events(b);
  b.onopen = () => b.send('drop');
  const cb = await eb.done;
  assert.equal(cb.code, 1006);
  assert.equal(cb.wasClean, false);
  assert.ok(eb.log.includes('error'));
});

test('constructor and close() validation', { skip }, () => {
  assert.throws(() => new WebSocket('ftp://x'), { name: 'SyntaxError' });
  assert.throws(() => new WebSocket('ws://x/#frag'), { name: 'SyntaxError' });
  assert.throws(() => new WebSocket('ws://x/', ['a', 'a']), {
    name: 'SyntaxError',
  });
  assert.throws(() => new WebSocket('ws://x/', ['bad token']), {
    name: 'SyntaxError',
  });
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  assert.throws(() => ws.close(1001), { name: 'InvalidAccessError' });
  assert.throws(() => ws.close(1000, 'x'.repeat(124)), { name: 'SyntaxError' });
  assert.equal(
    new WebSocket(`http://127.0.0.1:${port}`).url,
    `ws://127.0.0.1:${port}/`,
  );
  ws.close();
});

test(
  'close() while connecting fails the connection (error + 1006)',
  { skip },
  async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const { log, done } = events(ws);
    ws.close();
    const ce = await done;
    assert.equal(ce.code, 1006);
    assert.ok(!log.includes('open'));
  },
);

test(
  'a blocked origin errors and closes asynchronously (NET-5), logs once',
  { skip },
  async () => {
    env.warnings.length = 0;
    const ws = new WebSocket('wss://socket.not-listed.example/live');
    assert.equal(ws.readyState, WebSocket.CONNECTING);
    const { log, done } = events(ws);
    const ce = await done;
    assert.equal(ce.code, 1006);
    assert.deepEqual(log, ['error', 'close:1006::false']);
    new WebSocket('wss://socket.not-listed.example/again');
    assert.equal(
      env.warnings.filter((w) => w.includes('socket.not-listed.example'))
        .length,
      1,
    );
  },
);
