/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The workers prelude over a JS emulation of the native module (harness.ts): WRK-1..9, WRK-12 semantics that live in
// the JS layer. Native behaviour (threads, isolates, ValueSerializer, SharedArrayBuffer, wasm, terminate in a loop)
// is checked on the device (runtime/workers/test/device).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPage, settle, until } from './harness.ts';

const W = (body: string) => body;

test('globals exist in the page and have WebIDL shapes', async () => {
  const { page } = await createPage();
  const r = page.json(`({
    worker: typeof Worker, channel: typeof MessageChannel, port: typeof MessagePort,
    portCtor: (() => { try { new MessagePort(); return 'ok'; } catch (e) { return e.constructor.name; } })(),
    tag: Object.prototype.toString.call(new MessageChannel().port1),
    coi: crossOriginIsolated, hc: navigator.hardwareConcurrency,
    enumerable: Object.keys(globalThis).includes('Worker'),
  })`);
  assert.deepEqual(r, { worker: 'function', channel: 'function', port: 'function', portCtor: 'TypeError', tag: '[object MessagePort]', coi: true, hc: 4, enumerable: false });
});

test('MessageChannel: queued until start, in order, implicit start via onmessage', async () => {
  const { page } = await createPage();
  page.run(`
    globalThis.got = [];
    const ch = new MessageChannel();
    for (let i = 0; i < 5; i++) ch.port1.postMessage(i);
    globalThis.ch = ch;
    ch.port2.addEventListener('message', (e) => got.push('L' + e.data));
  `);
  await settle();
  assert.deepEqual(page.json('got'), [], 'addEventListener alone does not start the port');
  page.run(`ch.port2.onmessage = (e) => got.push(e.data);`);
  await settle();
  assert.deepEqual(page.json('got'), ['L0', 0, 'L1', 1, 'L2', 2, 'L3', 3, 'L4', 4]);
  page.run(`got.length = 0; ch.port2.onmessage = null; ch.port1.postMessage('after');`);
  await settle();
  assert.deepEqual(page.json('got'), ['Lafter'], 'still started after removing the handler');
});

test('MessageEvent is trusted with data, ports and empty origin; each message is its own task', async () => {
  const { page } = await createPage();
  page.run(`
    globalThis.order = [];
    const ch = new MessageChannel();
    ch.port2.onmessage = (e) => {
      order.push([e.isTrusted, e.data, Array.isArray(e.ports), e.origin, e instanceof MessageEvent]);
      Promise.resolve().then(() => order.push('micro ' + e.data));
    };
    ch.port1.postMessage('a'); ch.port1.postMessage('b');
  `);
  await settle();
  assert.deepEqual(page.json('order'), [[true, 'a', true, '', true], 'micro a', [true, 'b', true, '', true], 'micro b']);
});

test('structured clone: values, cycles and platform objects (Blob, File, DOMException)', async () => {
  const { page } = await createPage();
  page.run(`
    globalThis.out = null;
    const ch = new MessageChannel();
    ch.port2.onmessage = async (e) => {
      const d = e.data;
      out = {
        cycle: d.self === d, map: d.map.get('k'), set: [...d.set], date: d.date.getTime(), re: String(d.re),
        err: [d.err.name, d.err.message], big: typeof d.big, u8: Array.from(d.u8),
        blob: [d.blob instanceof Blob, d.blob.type, await d.blob.text()],
        file: [d.file instanceof File, d.file.name, d.file.lastModified, await d.file.text()],
        dex: [d.dex instanceof DOMException, d.dex.name, d.dex.message],
        sameBlob: d.blob === d.blob2,
      };
    };
    const o = { map: new Map([['k', 1]]), set: new Set([1, 2]), date: new Date(5), re: /x/gi, err: new RangeError('r'),
      big: 10n, u8: new Uint8Array([1, 2, 3]), blob: new Blob(['hi'], { type: 'text/plain' }),
      file: new File(['f'], 'a.txt', { lastModified: 7 }), dex: new DOMException('m', 'AbortError') };
    o.self = o; o.blob2 = o.blob;
    ch.port1.postMessage(o);
  `);
  await until(() => page.run('out'));
  await settle();
  assert.deepEqual(page.json('out'), {
    cycle: true, map: 1, set: [1, 2], date: 5, re: '/x/gi', err: ['RangeError', 'r'], big: 'bigint', u8: [1, 2, 3],
    blob: [true, 'text/plain', 'hi'], file: [true, 'a.txt', 7, 'f'], dex: [true, 'AbortError', 'm'], sameBlob: true,
  });
});

test('DataCloneError at the sender, synchronously, for functions, symbols, non-serializable platform objects', async () => {
  const { page } = await createPage();
  page.run(`
    globalThis.cloneErrs = (() => {
    const ch = new MessageChannel();
    const tryPost = (v, t) => { try { ch.port1.postMessage(v, t); return 'ok'; } catch (e) { return e.name; } };
    return [tryPost(() => 1), tryPost({ s: Symbol('x') }), tryPost(new EventTarget()), tryPost(new URL('https://a/')),
     tryPost(new AbortController()), tryPost({ p: ch.port2 }), tryPost(1, [1]), tryPost(1, [{}]),
     tryPost(1, [ch.port1]), (() => { const b = new ArrayBuffer(1); return tryPost(1, [b, b]); })(),
     tryPost(1, null), tryPost(1, { transfer: [] }), tryPost(1, undefined)];
    })();
  `);
  const r = page.json('cloneErrs');
  assert.deepEqual(r, ['DataCloneError', 'DataCloneError', 'DataCloneError', 'DataCloneError', 'DataCloneError',
    'DataCloneError', 'TypeError', 'DataCloneError', 'DataCloneError', 'DataCloneError', 'TypeError', 'ok', 'ok']);
});

test('ArrayBuffer transfer detaches the sender; nothing is detached when serialization throws', async () => {
  const { page } = await createPage();
  page.run(`
    globalThis.got = null;
    const ch = new MessageChannel();
    ch.port2.onmessage = (e) => { got = [e.data.buf.byteLength, new Uint8Array(e.data.buf)[3]]; };
    const buf = new ArrayBuffer(8); new Uint8Array(buf)[3] = 42;
    const keep = new ArrayBuffer(4);
    globalThis.thrown = (() => { try { ch.port1.postMessage({ keep, f() {} }, [keep]); } catch (e) { return e.name; } })();
    globalThis.keepLen = keep.byteLength;
    ch.port1.postMessage({ buf }, [buf]);
    globalThis.senderLen = buf.byteLength;
    globalThis.optsForm = (() => { const b = new ArrayBuffer(2); ch.port1.postMessage(b, { transfer: [b] }); return b.byteLength; })();
  `);
  await until(() => page.run('got'));
  assert.deepEqual(page.json('[thrown, keepLen, senderLen, optsForm, got]'), ['DataCloneError', 4, 0, 0, [8, 42]]);
});

test('MessagePort transfer: queue travels, event.ports, sender port inert', async () => {
  const { page } = await createPage();
  page.run(`
    globalThis.log = [];
    const a = new MessageChannel(), b = new MessageChannel();
    a.port1.postMessage('queued before transfer');
    b.port2.onmessage = (e) => {
      const p = e.ports[0];
      log.push([e.ports.length, p === e.data.port, p instanceof MessagePort]);
      p.onmessage = (m) => log.push('via transferred: ' + m.data);
      a.port1.postMessage('after transfer');
    };
    b.port1.postMessage({ port: a.port2 }, [a.port2]);
    a.port2.postMessage('inert');   // a detached port does nothing
    globalThis.a = a;
  `);
  await until(() => page.run('log.length >= 3'));
  assert.deepEqual(page.json('log'), [[1, true, true], 'via transferred: queued before transfer', 'via transferred: after transfer']);
});

test('close() disentangles: later posts are dropped on both sides', async () => {
  const { page, world } = await createPage();
  page.run(`
    globalThis.got = [];
    const ch = new MessageChannel();
    ch.port2.onmessage = (e) => got.push(e.data);
    ch.port1.onmessage = (e) => got.push('back ' + e.data);
    ch.port1.postMessage(1);
    globalThis.ch = ch;
  `);
  await settle();
  page.run(`ch.port1.close(); ch.port1.postMessage(2); ch.port2.postMessage(3);`);
  await settle();
  assert.deepEqual(page.json('got'), [1]);
  assert.equal(world.ports.size, 1, 'the closed port is gone, its peer is disentangled');
});

test('Worker: classic script, messages both ways, name, location, self, WorkerGlobalScope chain (WRK-1, WRK-2)', async () => {
  const { page } = await createPage({
    files: {
      'https://app.local/assets/w.js': W(`
        onmessage = (e) => postMessage({
          echo: e.data, name: self.name, href: location.href, wgs: self instanceof WorkerGlobalScope,
          dwgs: self instanceof DedicatedWorkerGlobalScope, et: self instanceof EventTarget,
          types: [typeof window, typeof document, typeof importScripts, typeof close, typeof Worker, typeof fetch === 'function' || typeof fetch],
          hc: navigator.hardwareConcurrency, tag: Object.prototype.toString.call(self), coi: crossOriginIsolated,
        });
      `),
    },
  });
  page.run(`
    globalThis.reply = null;
    const w = new Worker('/assets/w.js', { name: 'echo' });
    w.onmessage = (e) => { reply = e.data; };
    w.postMessage('hi');   // queued until the worker's script ran
  `);
  await until(() => page.run('reply'));
  assert.deepEqual(page.json('reply'), {
    echo: 'hi', name: 'echo', href: 'https://app.local/assets/w.js', wgs: true, dwgs: true, et: true,
    types: ['undefined', 'undefined', 'function', 'function', 'function', 'undefined'], hc: 4,
    tag: '[object DedicatedWorkerGlobalScope]', coi: true,
  });
});

test('Worker URLs: relative to the document, data: and blob:, bad URL SyntaxError, cross-origin SecurityError', async () => {
  const { page } = await createPage();
  page.run(`
    globalThis.got = [];
    const src = 'postMessage(location.protocol + ' + "'|'" + ' + self.origin)';
    const w1 = new Worker('data:text/javascript,' + encodeURIComponent(src));
    w1.onmessage = (e) => got.push('data ' + e.data);
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const w2 = new Worker(url);
    URL.revokeObjectURL(url);   // resolved at construction: revoking now is fine
    w2.onmessage = (e) => got.push('blob ' + e.data);
    globalThis.errs = [
      (() => { try { new Worker('https://cdn.example/w.js'); } catch (e) { return e.name; } })(),
      (() => { try { new Worker('http://[bad'); } catch (e) { return e.name; } })(),
      (() => { try { new Worker('/x.js', { type: 'shared' }); } catch (e) { return e.name; } })(),
    ];
    const dead = new Worker(url);   // revoked: no exception, an error event instead
    dead.onerror = (e) => got.push('revoked ' + e.type + ' ' + (e instanceof ErrorEvent));
  `);
  await until(() => page.run('got.length >= 3'));
  const got = (page.json('got') as string[]).sort();
  assert.deepEqual(got, ['blob blob:|https://app.local', 'data data:|null', 'revoked error false']);
  assert.deepEqual(page.json('errs'), ['SecurityError', 'SyntaxError', 'TypeError']);
});

test('importScripts: same-origin, data:, worker-made blob:, in order, NetworkError, SyntaxError (WRK-4, REG-12)', async () => {
  const { page } = await createPage({
    files: {
      'https://app.local/lib/a.js': 'self.order = (self.order || []).concat("a");',
      'https://app.local/lib/b.js': 'self.order = (self.order || []).concat("b");',
      'https://app.local/w.js': W(`
        importScripts('lib/a.js', '/lib/b.js', 'data:text/javascript,self.order.push("data")');
        const u = URL.createObjectURL(new Blob(['self.order.push("blob")']));
        importScripts(u);
        const errs = [];
        try { importScripts('missing.js'); } catch (e) { errs.push(e.name); }
        try { importScripts('http://[bad'); } catch (e) { errs.push(e.name); }
        try { importScripts('data:text/javascript,throw new RangeError("boom")'); } catch (e) { errs.push(e.name); }
        postMessage({ order: self.order, errs });
      `),
    },
  });
  page.run(`globalThis.r = null; new Worker('/w.js').onmessage = (e) => { r = e.data; };`);
  await until(() => page.run('r'));
  assert.deepEqual(page.json('r'), { order: ['a', 'b', 'data', 'blob'], errs: ['NetworkError', 'SyntaxError', 'RangeError'] });
});

test('importScripts in a module worker throws TypeError', async () => {
  const { page } = await createPage({
    files: {
      'https://app.local/m.js': W(`try { importScripts('x.js'); postMessage('no'); } catch (e) { postMessage(e.name); }`),
    },
  });
  page.run(`globalThis.r = null; new Worker('/m.js', { type: 'module' }).onmessage = (e) => { r = e.data; };`);
  await until(() => page.run('r'));
  assert.equal(page.run('r'), 'TypeError');
});

test('errors: worker global first, then the Worker (ErrorEvent), preventDefault suppresses the log (WRK-7)', async () => {
  const { page, world } = await createPage({
    files: {
      'https://app.local/throws.js': 'setTimeout(() => { throw new TypeError("bad thing"); }, 0);',
      'https://app.local/handled.js': 'self.addEventListener("error", (e) => { e.preventDefault(); postMessage("seen " + e.message); }); setTimeout(() => { throw new Error("x"); });',
    },
  });
  page.run(`
    globalThis.ev = [];
    const w = new Worker('/throws.js', { name: 'thrower' });
    w.onerror = (e) => { ev.push([e instanceof ErrorEvent, e.message, e.filename !== undefined, e.cancelable]); };
    const w2 = new Worker('/throws.js', { name: 'quiet' });
    w2.addEventListener('error', (e) => { e.preventDefault(); ev.push('prevented'); });
    const w3 = new Worker('/handled.js');
    w3.onmessage = (e) => ev.push(e.data);
    w3.onerror = () => ev.push('should not reach the Worker');
    globalThis.onerror = () => { ev.push('window saw it'); return true; };
  `);
  await until(() => (page.run('ev') as unknown[]).length >= 4);
  await settle();
  const ev = page.run('ev') as unknown[];
  assert.ok(ev.some((e) => Array.isArray(e) && e[0] === true && /bad thing/.test(e[1] as string) && e[3] === true));
  assert.ok(ev.includes('prevented'));
  assert.ok(ev.includes('seen Uncaught Error: x') || ev.some((e) => typeof e === 'string' && e.startsWith('seen')));
  assert.ok(!ev.includes('should not reach the Worker'));
  assert.ok(ev.includes('window saw it'), 'not cancelled at the Worker: reported one level up (HTML §10.2.5)');
  page.run(`globalThis.onerror = null;`);
  // Without a window handler the page logs it with the worker's name.
  page.run(`new Worker('/throws.js', { name: 'logged' });`);
  await until(() => world.logs.some((l) => l.realm === 'main' && /\[worker \d+ 'logged'\] Uncaught/.test(l.text)));
});

test('a script that fails to load fires a plain error event (WRK-7)', async () => {
  const { page } = await createPage();
  page.run(`globalThis.e = null; const w = new Worker('/nope.js'); w.onerror = (x) => { e = [x.type, x instanceof ErrorEvent]; };`);
  await until(() => page.run('e'));
  assert.deepEqual(page.json('e'), ['error', false]);
});

test('terminate(): no more events, pending messages dropped, slot released (WRK-8, WRK-9)', async () => {
  const { page, world } = await createPage({
    maxWorkers: 2,
    files: { 'https://app.local/tick.js': 'setInterval(() => postMessage("tick"), 1); onmessage = (e) => postMessage(e.data);' },
  });
  page.run(`
    globalThis.ticks = 0;
    globalThis.w = new Worker('/tick.js');
    w.onmessage = () => ticks++;
    globalThis.w2 = new Worker('/tick.js');
    globalThis.third = (() => { try { new Worker('/tick.js'); return 'ok'; } catch (e) { return e.name + ': ' + /at most 2/.test(e.message); } })();
  `);
  assert.equal(page.run('third'), 'NotSupportedError: true');
  await until(() => page.run('ticks') > 3);
  page.run(`w.terminate(); w.postMessage('dropped'); globalThis.at = ticks;`);
  await settle(50);
  assert.ok((page.run('ticks') as number) <= (page.run('at') as number) + 1);
  assert.equal(world.live, 1);
  assert.equal(page.run(`(() => { try { new Worker('/tick.js'); return 'ok'; } catch (e) { return e.name; } })()`), 'ok');
  page.run('w2.terminate()');
});

test('self.close() ends the worker; the creator drops it', async () => {
  const { page, world } = await createPage({
    files: { 'https://app.local/c.js': 'postMessage("bye"); close();' },
  });
  page.run(`globalThis.m = []; const w = new Worker('/c.js'); w.onmessage = (e) => m.push(e.data);`);
  await until(() => world.live === 0 && (page.run('m') as string[]).length === 1);
  assert.deepEqual(page.json('m'), ['bye']);
});

test('nested workers and a port handed through the page (comlink-style round trip, WRK-6)', async () => {
  const { page } = await createPage({
    files: {
      'https://app.local/outer.js': W(`
        const inner = new Worker('/inner.js');
        inner.onmessage = (e) => postMessage('inner said ' + e.data);
        onmessage = (e) => { if (e.ports[0]) { const p = e.ports[0]; p.onmessage = (m) => p.postMessage(m.data * 2); } else inner.postMessage(e.data); };
      `),
      'https://app.local/inner.js': 'onmessage = (e) => postMessage(e.data + "!");',
    },
  });
  page.run(`
    globalThis.got = [];
    const w = new Worker('/outer.js');
    w.onmessage = (e) => got.push(e.data);
    w.postMessage('ping');
    const ch = new MessageChannel();
    w.postMessage(null, [ch.port2]);
    ch.port1.onmessage = (e) => got.push('doubled ' + e.data);
    ch.port1.postMessage(21);
  `);
  await until(() => (page.run('got') as string[]).length >= 2);
  assert.deepEqual((page.json('got') as string[]).sort(), ['doubled 42', 'inner said ping!']);
});

test('messages posted before the worker ran are delivered after its script, in order', async () => {
  const { page } = await createPage({
    files: { 'https://app.local/o.js': 'const got = []; onmessage = (e) => { got.push(e.data); if (got.length === 100) postMessage(got); };' },
  });
  page.run(`
    globalThis.r = null;
    const w = new Worker('/o.js');
    w.onmessage = (e) => { r = e.data; };
    for (let i = 0; i < 100; i++) w.postMessage(i);
  `);
  await until(() => page.run('r'));
  assert.deepEqual(page.json('r'), Array.from({ length: 100 }, (_, i) => i));
});

test('crossOriginIsolated follows the policy and navigator.hardwareConcurrency is capped in both globals (WRK-12)', async () => {
  const { page } = await createPage({ files: { 'https://app.local/h.js': 'postMessage([navigator.hardwareConcurrency, crossOriginIsolated])' } });
  page.run(`globalThis.r = null; new Worker('/h.js').onmessage = (e) => { r = e.data; };`);
  await until(() => page.run('r'));
  assert.deepEqual(page.json('[navigator.hardwareConcurrency, r]'), [4, [4, true]]);
});
