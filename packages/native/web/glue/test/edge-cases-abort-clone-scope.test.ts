/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Regression tests: AbortSignal.any() lifetime under GC, the clone
// registry and native clone routing, clone fidelity and speed, worker scope, global setters,
// location/history, FileReader, events, matchMedia ranges, encoding/Blob edge cases, deviceMemory.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import v8 from 'node:v8';
import vm from 'node:vm';
import { both, createGlueContext, fakeNatives } from './harness.ts';

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));
const REG = `globalThis[Symbol.for('iwn.glue')]`;

async function collect(): Promise<void> {
  // WeakRef targets survive until the current job ends; let it end, then collect twice.
  await tick();
  gc();
  await tick();
  gc();
}

describe('AbortSignal.any() and GC (DOM-10)', () => {
  test('dependents with listeners, handlers or algorithms survive GC and still abort', async () => {
    const { run } = await createGlueContext();
    run(`
      globalThis.results = [];
      globalThis.ctrl = new AbortController();
      (() => { const d = AbortSignal.any([ctrl.signal]); d.addEventListener('abort', () => results.push('listener')); })();
      (() => { const d = AbortSignal.any([ctrl.signal]); d.onabort = () => results.push('handler'); })();
      (() => { const d = AbortSignal.any([ctrl.signal]); ${REG}.abort.addAbortAlgorithm(d, () => results.push('algorithm')); })();
      (() => {
        // The fetch pattern: Request follows the passed signal with a listener only (web/net followSignal).
        const parent = AbortSignal.any([ctrl.signal, AbortSignal.timeout(400)]);
        const ac = new AbortController();
        parent.addEventListener('abort', () => ac.abort(parent.reason), { once: true });
        ac.signal.addEventListener('abort', () => results.push('request:' + ac.signal.reason));
      })();
      (() => {
        const d = AbortSignal.any([new AbortController().signal, AbortSignal.timeout(30)]);
        d.addEventListener('abort', () => results.push('timeout:' + d.reason.name));
      })();
    `);
    await collect();
    run(`ctrl.abort('user')`);
    await tick(80);
    assert.deepEqual(Array.from(run<string[]>(`results.slice()`)).sort(), [
      'algorithm',
      'handler',
      'listener',
      'request:user',
      'timeout:TimeoutError',
    ]);
  });

  test('dependents nobody listens to can be collected (removed listener, null handler, none)', async () => {
    const { run } = await createGlueContext();
    run(`
      globalThis.src = new AbortController();
      globalThis.refs = [];
      (() => { refs.push(new WeakRef(AbortSignal.any([src.signal]))); })();
      (() => { const d = AbortSignal.any([src.signal]); const f = () => {}; d.addEventListener('abort', f); d.removeEventListener('abort', f); refs.push(new WeakRef(d)); })();
      (() => { const d = AbortSignal.any([src.signal]); d.onabort = () => {}; d.onabort = null; refs.push(new WeakRef(d)); })();
      (() => { const d = AbortSignal.any([src.signal]); const off = ${REG}.abort.addAbortAlgorithm(d, () => {}); off(); refs.push(new WeakRef(d)); })();
      (() => { const d = AbortSignal.any([src.signal]); d.addEventListener('abort', () => {}, { once: true }); refs.push(new WeakRef(d)); globalThis.keep = new WeakRef(d); })();
    `);
    await collect();
    // The last one still has a listener, so it is held.
    assert.deepEqual(
      Array.from(run<boolean[]>(`refs.map((r) => r.deref() === undefined)`)),
      [true, true, true, true, false],
    );
  });

  test('a throwing abort algorithm does not stop other algorithms or the abort event', async () => {
    const errors: unknown[] = [];
    const { run } = await createGlueContext({
      preset: {
        console: { error: (...a: unknown[]) => errors.push(a), warn() {} },
      },
    });
    const out = run<unknown[]>(`
      const out = [];
      onerror = (msg) => { out.push('onerror:' + msg); return true; };
      const ac = new AbortController();
      ${REG}.abort.addAbortAlgorithm(ac.signal, () => { throw new Error('alg'); });
      ${REG}.abort.addAbortAlgorithm(ac.signal, () => out.push('second'));
      ac.signal.addEventListener('abort', () => out.push('abort-event'));
      try { ac.abort(); out.push('abort() returned'); } catch (e) { out.push('abort() threw ' + e.message); }
      out;
    `);
    assert.deepEqual(Array.from(out), [
      'onerror:Uncaught Error: alg',
      'second',
      'abort-event',
      'abort() returned',
    ]);
  });

  test('timeout() truncates before the range check; any() needs an iterable', async () => {
    // WebIDL [EnforceRange] truncates -0.5 to 0 (Node throws RangeError for it, Chromium accepts it).
    const { run } = await createGlueContext();
    const out = await run<Promise<unknown[]>>(`(async () => {
      const out = [];
      const s = AbortSignal.timeout(-0.5);
      await new Promise((res) => s.addEventListener('abort', res));
      out.push(s.reason.name);
      for (const bad of [-1, NaN, Infinity]) { try { AbortSignal.timeout(bad); out.push('ok'); } catch (e) { out.push(e.name); } }
      return out;
    })()`);
    assert.deepEqual(Array.from(out), [
      'TimeoutError',
      'TypeError',
      'TypeError',
      'TypeError',
    ]);
    const r = await both(`
      const out = [];
      for (const bad of [{ length: 0 }, 5, null]) { try { AbortSignal.any(bad); out.push('ok'); } catch (e) { out.push(e.name); } }
      out.push(AbortSignal.any(new Set([AbortSignal.abort('r')])).reason);
      return out;
    `);
    assert.deepEqual(r.glue, r.node);
  });
});

// A fake __iwn.clone that behaves like core's clone.cc: a ValueSerializer round trip with no host
// object delegate (Node's structuredClone serializes JS class instances as plain objects the same way).
function nativeCloneNatives(): {
  natives: Record<string, unknown>;
  seen: unknown[];
} {
  const seen: unknown[] = [];
  const { natives } = fakeNatives({
    clone: {
      structuredClone(v: unknown, transfer: unknown[]) {
        seen.push(v);
        return structuredClone(v, { transfer: transfer as never });
      },
    },
  });
  return { natives, seen };
}

describe('structuredClone with platform objects (TMR-3, WRK-5)', () => {
  test('the registry is published; registered types and platform objects bypass the native hook', async () => {
    const { natives, seen } = nativeCloneNatives();
    const { run } = await createGlueContext({ natives });
    const out = run<unknown[]>(`
      const out = [typeof ${REG}.cloneRegistry.registerCloneable];
      class Img { constructor(w) { this.w = w; } }
      ${REG}.cloneRegistry.registerCloneable({ is: (v) => v instanceof Img, clone: (v) => new Img(v.w) });
      const c = structuredClone({ list: [new Img(2)] });
      out.push(c.list[0] instanceof Img, c.list[0].w);
      const b = structuredClone(new Blob(['ab'], { type: 'a/b' }));
      out.push(b instanceof Blob, b.type, b.size);
      const f = structuredClone(new File(['xyz'], 'n.txt', { lastModified: 7 }));
      out.push(f instanceof File, f.name, f.lastModified);
      const d = structuredClone(new DOMException('msg', 'AbortError'));
      out.push(d instanceof DOMException, d.name, d.message, d.code);
      for (const v of [new EventTarget(), new AbortController(), navigator, new URL('https://a/'), new URLSearchParams('a=1'), location, new TextDecoder()]) {
        try { structuredClone(v); out.push('cloned'); } catch (e) { out.push(e.name); }
      }
      const ab = new ArrayBuffer(8);
      const t = structuredClone({ ab, n: 1 }, { transfer: [ab] });
      out.push(ab.byteLength, t.ab.byteLength, t.n);
      out.push(structuredClone(Object.assign(Object.create(null), { a: [1, { b: 2 }] })).a[1].b);
      out;
    `);
    assert.deepEqual(Array.from(out), [
      'function',
      true,
      2,
      true,
      'a/b',
      2,
      true,
      'n.txt',
      7,
      true,
      'AbortError',
      'msg',
      20,
      'DataCloneError',
      'DataCloneError',
      'DataCloneError',
      'DataCloneError',
      'DataCloneError',
      'DataCloneError',
      'DataCloneError',
      0,
      8,
      1,
      2,
    ]);
    // Only the plain-data graphs reached the native hook.
    assert.equal(seen.length, 2);
  });

  test('a Proxy goes to the native path, which throws DataCloneError', async () => {
    const { natives } = nativeCloneNatives();
    const { run } = await createGlueContext({ natives });
    assert.throws(() => run(`structuredClone(new Proxy({ a: 1 }, {}))`), {
      name: 'DataCloneError',
    });
  });

  test('accessors keep the JS path, so a getter runs once', async () => {
    const { natives, seen } = nativeCloneNatives();
    const { run } = await createGlueContext({ natives });
    assert.equal(
      run(
        `let n = 0; const c = structuredClone({ get x() { n++; return 5; } }); [n, c.x].join()`,
      ),
      '1,5',
    );
    assert.equal(seen.length, 0);
  });

  test('fidelity of the JS path matches Node: __proto__ keys, slot objects, error-likes, options', async () => {
    const r = await both(`
      const out = [];
      const polluted = JSON.parse('{"__proto__": {"inherited": true}, "a": 1}');
      const c = structuredClone(polluted);
      out.push(Object.keys(c), Object.getPrototypeOf(c) === Object.prototype, c.inherited === undefined, c.__proto__.inherited);
      const arr = JSON.parse('[1]'); Object.defineProperty(arr, '__proto__', { value: { x: 1 }, enumerable: true });
      const ca = structuredClone(arr);
      out.push(Array.isArray(ca), Object.getPrototypeOf(ca) === Array.prototype, Object.keys(ca));
      for (const v of [new Intl.NumberFormat(), [1].values(), new Map().entries(), 'ab'[Symbol.iterator](), Promise.resolve(), new WeakMap()]) {
        try { structuredClone(v); out.push('cloned'); } catch (e) { out.push(e.name); }
      }
      const fake = Object.create(Error.prototype); fake.message = 'm';
      const cf = structuredClone(fake);
      out.push(cf instanceof Error, Object.prototype.toString.call(cf), cf.message);
      out.push(structuredClone(5, function () {}));
      class Sub extends Map {}
      const sm = structuredClone(new Sub([[1, 2]]));
      out.push(sm instanceof Map, sm.get(1));
      const e = structuredClone(new RangeError('r', { cause: { k: 1 } }));
      out.push(e instanceof RangeError, e.message, e.cause.k);
      return out;
    `);
    assert.deepEqual(r.glue, r.node);
  });

  test('a non-detachable buffer in the transfer list is a DataCloneError on the JS path', async () => {
    const { run } = await createGlueContext();
    assert.equal(
      run(
        `const mem = new WebAssembly.Memory({ initial: 1 }); try { structuredClone(1, { transfer: [mem.buffer] }); 'ok' } catch (e) { e.name }`,
      ),
      'DataCloneError',
    );
  });

  test('the JS path clones plain data quickly (no exception per brand check)', async () => {
    const { g, run } = await createGlueContext();
    g.__hostClone = (v: unknown) => structuredClone(v);
    // Relative bound (the suite runs on shared, loaded build machines): the JS path against V8's own
    // serializer on the same data, best of three each. Before the fix it was ~80x (about 85 µs per
    // object); now it is a few times.
    const [jsMs, v8Ms] = run<[number, number]>(`
      const data = Array.from({ length: 20000 }, (_, i) => ({ id: i, name: 'n' + i, pos: [i, i + 1, i + 2], tags: { a: true } }));
      structuredClone(data.slice(0, 100));
      const best = (f) => { let m = Infinity; for (let k = 0; k < 3; k++) { const t0 = Date.now(); f(); m = Math.min(m, Date.now() - t0); } return m; };
      const c = structuredClone(data);
      if (c[19999].pos[2] !== 20001) throw new Error('bad clone');
      [best(() => structuredClone(data)), best(() => __hostClone(data))];
    `);
    assert.ok(
      jsMs <= 25 * Math.max(v8Ms, 2),
      `20,000-object JS clone took ${jsMs} ms vs ${v8Ms} ms in V8`,
    );
  });
});

describe('worker scope (WRK-2)', () => {
  test('no window/history/matchMedia; WorkerLocation of the worker URL; the shared APIs are there', async () => {
    const { run } = await createGlueContext({
      config: { scope: 'worker', url: 'https://app.local/js/worker.js?x=1' },
    });
    const out = run<Record<string, unknown>>(`({
      window: typeof window, document: typeof document, history: typeof history, matchMedia: typeof matchMedia,
      devicePixelRatio: typeof devicePixelRatio, Location: typeof Location, WorkerLocation: typeof WorkerLocation,
      locationTag: Object.prototype.toString.call(location), href: location.href, origin: location.origin, search: location.search,
      self: self === globalThis, onmessage: 'onmessage' in globalThis, onpopstate: 'onpopstate' in globalThis,
      apis: [URL, Blob, FileReader, TextEncoder, TextDecoder, structuredClone, AbortController, DOMException, atob, queueMicrotask].every((f) => typeof f === 'function'),
      crypto: typeof crypto.getRandomValues, performance: typeof performance.now, navigator: typeof navigator.userAgent,
      blob: URL.createObjectURL(new Blob(['x'])).startsWith('blob:https://app.local/'),
      scope: ${REG}.scope, navigation: ${REG}.navigation,
    })`);
    assert.deepEqual(
      { ...out },
      {
        window: 'undefined',
        document: 'undefined',
        history: 'undefined',
        matchMedia: 'undefined',
        devicePixelRatio: 'undefined',
        Location: 'undefined',
        WorkerLocation: 'function',
        locationTag: '[object WorkerLocation]',
        href: 'https://app.local/js/worker.js?x=1',
        origin: 'https://app.local',
        search: '?x=1',
        self: true,
        onmessage: true,
        onpopstate: false,
        apis: true,
        crypto: 'function',
        performance: 'function',
        navigator: 'string',
        blob: true,
        scope: 'worker',
        navigation: null,
      },
    );
  });

  test('a window alias the bootstrap set before the glue is removed in a worker', async () => {
    const { natives } = fakeNatives();
    const ctx = vm.createContext({});
    const g = vm.runInContext('globalThis', ctx) as Record<string, unknown>;
    Object.defineProperty(g, 'window', {
      value: g,
      writable: true,
      configurable: true,
    });
    g.__iwn = {
      ...natives,
      config: { scope: 'worker', url: 'https://app.local/w.js' },
    };
    const { glueScript } = await import('./harness.ts');
    (await glueScript()).runInContext(ctx);
    assert.equal(vm.runInContext(`typeof window`, ctx), 'undefined');
    assert.equal(
      vm.runInContext(`location.href`, ctx),
      'https://app.local/w.js',
    );
  });
});

describe('global setters (WebIDL readonly / [Replaceable] / [PutForwards])', () => {
  test('location = url navigates; window, navigator, crypto, history are readonly; self, origin are replaceable', async () => {
    const { run } = await createGlueContext({
      config: { url: 'https://app.local/index.html' },
    });
    const out = run<unknown[]>(`
      const out = [];
      location = '#frag';
      out.push(typeof location, location.hash, history.length);
      window = 5; navigator = {}; crypto = 1; history = 2; isSecureContext = false;
      out.push(window === globalThis, typeof navigator.userAgent, typeof crypto.getRandomValues, typeof history.pushState, isSecureContext);
      // Strict-mode assignment throws because these accessors have no setter (a vm context's global
      // interceptor hides the throw, so check the descriptors).
      out.push(['window', 'navigator', 'crypto', 'history', 'isSecureContext', 'crossOriginIsolated'].map((n) => typeof Object.getOwnPropertyDescriptor(globalThis, n).set).join());
      performance = 7; devicePixelRatio = 2;
      out.push(performance, devicePixelRatio);
      out;
    `);
    assert.deepEqual(Array.from(out), [
      'object',
      '#frag',
      2,
      true,
      'string',
      'function',
      'function',
      true,
      'undefined,undefined,undefined,undefined,undefined,undefined',
      7,
      2,
    ]);
  });
});

describe('location and history details (DOM-5, DOM-3)', () => {
  test('same hash and same URL do not grow history; fragment navigations fire popstate then hashchange', async () => {
    const { run } = await createGlueContext({
      config: { url: 'https://app.local/#a' },
    });
    const out = await run<Promise<unknown[]>>(`(async () => {
      const out = [];
      const ev = [];
      addEventListener('popstate', (e) => ev.push('popstate:' + e.state));
      addEventListener('hashchange', (e) => ev.push('hashchange:' + e.newURL));
      location.hash = 'a'; location.hash = '#a';
      out.push(history.length);
      location.href = location.href;
      out.push(history.length);
      location.hash = 'b';
      out.push(history.length, ev.slice());
      await new Promise((r) => setTimeout(r, 10));
      out.push(ev.slice());
      history.pushState({ s: 1 }, '', '');
      out.push(location.href, history.state.s);
      for (let i = 0; i < 100; i++) history.pushState(i, '', '#p' + i);
      out.push(history.length, location.hash);
      return out;
    })()`);
    assert.deepEqual(JSON.parse(JSON.stringify(out)), [
      1,
      1,
      2,
      ['popstate:null', 'popstate:null'],
      ['popstate:null', 'popstate:null', 'hashchange:https://app.local/#b'],
      'https://app.local/#b',
      1,
      50,
      '#p99',
    ]);
  });
});

describe('FileReader details (NET-14)', () => {
  test('empty blob: no progress; abort() in progress: abort + loadend, no load; charset from the type', async () => {
    const { run } = await createGlueContext();
    const out = await run<Promise<unknown[]>>(`(async () => {
      const read = (blob, setup, method = 'readAsText') => new Promise((resolve) => {
        const fr = new FileReader();
        const ev = [];
        for (const t of ['loadstart', 'progress', 'load', 'abort', 'loadend']) {
          fr.addEventListener(t, () => { ev.push(t + ':' + fr.readyState + ':' + JSON.stringify(fr.result)); if (t === 'loadend') setTimeout(() => resolve(ev), 5); });
        }
        setup?.(fr);
        fr[method](blob);
      });
      return [
        await read(new Blob([])),
        await read(new Blob(['abc']), (fr) => fr.addEventListener('progress', () => fr.abort())),
        await read(new Blob([new Uint8Array([0x41, 0, 0x42, 0])], { type: 'text/plain;charset=utf-16le' })),
        await read(new Blob([new Uint8Array([0xe9])], { type: 'text/plain; charset="windows-1252"' })),
      ];
    })()`);
    assert.deepEqual(JSON.parse(JSON.stringify(out)), [
      ['loadstart:1:null', 'load:2:""', 'loadend:2:""'],
      ['loadstart:1:null', 'progress:1:null', 'abort:2:null', 'loadend:2:null'],
      ['loadstart:1:null', 'progress:1:null', 'load:2:"AB"', 'loadend:2:"AB"'],
      ['loadstart:1:null', 'progress:1:null', 'load:2:"é"', 'loadend:2:"é"'],
    ]);
  });
});

describe('events: handler attributes and WebIDL conversions (DOM-2)', () => {
  test('null deactivates a handler; re-setting appends it after later listeners', async () => {
    const { run } = await createGlueContext();
    // HTML §8.1.8.1 (Node keeps the handler's first position, Chromium follows the spec).
    const out = run<string[]>(`
      const out = [];
      const t = new AbortController().signal;
      const et = new EventTarget();
      ${REG}.events.defineEventHandler(et, 'x');
      et.onx = () => out.push('handler1');
      et.onx = null;
      et.addEventListener('x', () => out.push('listener'));
      et.onx = () => out.push('handler2');
      et.dispatchEvent(new Event('x'));
      out.push(String(et.onx === null));
      out;
    `);
    assert.deepEqual(Array.from(out), ['listener', 'handler2', 'false']);
  });

  test('options are converted with ToBoolean (capture)', async () => {
    // WebIDL (AddEventListenerOptions or boolean): a non-object is a boolean. Node throws for numbers.
    const { run } = await createGlueContext();
    const out = run<string[]>(`
      const out = [];
      const et = new EventTarget();
      const f = () => out.push('f');
      et.addEventListener('x', f, 1);
      et.removeEventListener('x', f, true);
      et.dispatchEvent(new Event('x'));
      et.addEventListener('y', f, 0); et.removeEventListener('y', f, '');
      et.dispatchEvent(new Event('y'));
      et.addEventListener('z', f, 'yes'); et.removeEventListener('z', f, false);
      et.dispatchEvent(new Event('z'));
      out;
    `);
    assert.deepEqual(Array.from(out), ['f']);
  });

  test('Symbol types, constants, lengths, initEvent arity match Node', async () => {
    const r = await both(`
      const out = [];
      const et = new EventTarget();
      const f = () => {};
      try { new Event(Symbol()); out.push('ok'); } catch (e) { out.push(e.name); }
      try { et.addEventListener(Symbol(), f); out.push('ok'); } catch (e) { out.push(e.name); }
      try { (() => { 'use strict'; Event.NONE = 5; })(); out.push('ok'); } catch (e) { out.push(e.name); }
      out.push(Object.getOwnPropertyDescriptor(Event, 'BUBBLING_PHASE').configurable, Object.getOwnPropertyDescriptor(Event, 'NONE').writable);
      out.push(DOMException.length, Blob.length, File.length, Event.length, CustomEvent.length, MessageEvent.length, EventTarget.length);
      try { new Event('a').initEvent(); out.push('ok'); } catch (e) { out.push(e.name); }
      return out;
    `);
    assert.deepEqual(r.glue, r.node);
    // The prototype constants too (Node leaves Event.prototype's writable).
    const { run } = await createGlueContext();
    assert.equal(
      run(
        `[Event.prototype, FileReader, FileReader.prototype].every((o) => Object.entries(Object.getOwnPropertyDescriptors(o)).filter(([k]) => /^[A-Z_]+$/.test(k)).every(([, d]) => !d.writable && !d.configurable && d.enumerable))`,
      ),
      true,
    );
  });
});

describe('matchMedia Media Queries 4 (DOM-3)', () => {
  test('range syntax and unknown features under not()', async () => {
    const { run } = await createGlueContext({
      config: { viewport: { width: 1280, height: 720 } },
    });
    const out = run<unknown[]>(`[
      '(width >= 600px)', '(width > 1279.5px)', '(width < 1280px)', '(400px <= width <= 2000px)', '(1280px = width)',
      '(1300px > width > 1000px)', '(aspect-ratio > 1)', '(height <= 719px)', '(resolution >= 1dppx)', '(400px < width > 300px)',
      'not (bogus-feature)', '(bogus-feature) or (width >= 1px)', 'not ((bogus) and (width < 1px))', 'screen and (bogus)',
    ].map((q) => { const m = matchMedia(q); return [m.matches, m.media === 'not all']; })`);
    assert.deepEqual(JSON.parse(JSON.stringify(out)), [
      [true, false],
      [true, false],
      [false, false],
      [true, false],
      [true, false],
      [true, false],
      [true, false],
      [false, false],
      [true, false],
      [false, false],
      [false, false],
      [true, false],
      [true, false],
      [false, false],
    ]);
  });
});

describe('encoding and Blob edge cases (NET-14, NET-16)', () => {
  test('detached buffers hold no bytes; option dictionaries are validated', async () => {
    // WebIDL "get a copy of the bytes": detached is empty (Node's Blob throws for it). TextDecodeOptions is
    // a dictionary, so a primitive is a TypeError (Node does not validate decode()'s options).
    const { run } = await createGlueContext();
    const out = run<unknown[]>(`
      const out = [];
      const ab = new ArrayBuffer(4); new Uint8Array(ab).set([0x61, 0x62, 0x63, 0x64]); const view = new Uint8Array(ab); structuredClone(ab, { transfer: [ab] });
      out.push(new TextDecoder().decode(ab), new TextDecoder().decode(view));
      out.push(new Blob([view, ab, 'x']).size);
      for (const bad of [5, 'x', true]) {
        try { new TextDecoder('utf-8', bad); out.push('ok'); } catch (e) { out.push(e.name); }
        try { new TextDecoder().decode(new Uint8Array(1), bad); out.push('ok'); } catch (e) { out.push(e.name); }
      }
      out;
    `);
    assert.deepEqual(Array.from(out), [
      '',
      '',
      1,
      'TypeError',
      'TypeError',
      'TypeError',
      'TypeError',
      'TypeError',
      'TypeError',
    ]);
  });

  test('one TextDecoder reused across decode() calls resets its BOM state (matches Node)', async () => {
    const r = await both(`
      const out = [];
      const d = new TextDecoder();
      const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x61]);
      out.push(d.decode(bom), d.decode(bom), d.decode(new Uint8Array([0xef, 0xbb]), { stream: true }), d.decode(new Uint8Array([0xbf, 0x62])), d.decode(bom));
      const d16 = new TextDecoder('utf-16le');
      out.push(d16.decode(new Uint8Array([0xff, 0xfe, 0x41, 0])), d16.decode(new Uint8Array([0xff, 0xfe, 0x42, 0])));
      return out;
    `);
    assert.deepEqual(r.glue, r.node);
  });

  test('Blob.slice uses [Clamp] (round half to even); File lastModified is a long long', async () => {
    const { run } = await createGlueContext();
    const out = await run<Promise<unknown[]>>(`(async () => [
      await new Blob(['abcd']).slice(1.7, 3.2).text(),
      await new Blob(['abcdef']).slice(0.5, 2.5).text(),
      await new Blob(['abcdef']).slice(1.5, 3.5).text(),
      await new Blob(['abcdef']).slice(-2.5).text(),
      new File([], 'n', { lastModified: Infinity }).lastModified,
      new File([], 'n', { lastModified: NaN }).lastModified,
      new File([], 'n', { lastModified: -1.9 }).lastModified,
      new File([], 'n', { lastModified: 2 ** 64 + 4096 }).lastModified,
    ])()`);
    assert.deepEqual(Array.from(out), ['c', 'ab', 'cd', 'ef', 0, 0, -1, 4096]);
  });
});

describe('navigator.deviceMemory (DOM-4)', () => {
  test('rounds to the nearest power of two and clamps to [0.25, 8]', async () => {
    const got: unknown[] = [];
    for (const gib of [7.5, 6, 5.9, 3, 1.4, 0.3, 0.1, 16, 12]) {
      const { natives } = fakeNatives({
        device: { info: () => ({ deviceMemory: gib }) },
      });
      const { run } = await createGlueContext({ natives });
      got.push(run(`navigator.deviceMemory`));
    }
    assert.deepEqual(got, [8, 4, 4, 2, 1, 0.25, 0.25, 8, 8]);
  });
});

describe('install details', () => {
  test("the glue replaces the bootstrap's minimal structuredClone and performance even in missing mode", async () => {
    const { run } = await createGlueContext({
      preset: {
        structuredClone: () => 'bootstrap',
        performance: { now: () => 0 },
      },
    });
    assert.equal(run(`structuredClone(new Blob(['a'])) instanceof Blob`), true);
    assert.equal(run(`typeof performance.mark`), 'function');
  });

  test('a malformed JSON config warns and falls back to defaults', async () => {
    const warnings: string[] = [];
    const { run } = await createGlueContext({
      config: '{not json',
      preset: { console: { warn: (m: string) => warnings.push(m) } },
    });
    assert.equal(run(`location.href`), 'https://app.local/');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /glue config is not valid JSON/);
  });
});

describe('IDNA shim (NET-13)', () => {
  test('capital sigma maps to σ (not final ς); a compatibility form of a separator is disallowed', async () => {
    const { run } = await createGlueContext();
    assert.equal(run(`new URL('https://ΒΌΛΟΣ/').host`), 'xn--nxasmq6b');
    assert.equal(
      run(`try { new URL('https://a︒b/'); 'parsed' } catch (e) { e.name }`),
      'TypeError',
    );
  });
});
