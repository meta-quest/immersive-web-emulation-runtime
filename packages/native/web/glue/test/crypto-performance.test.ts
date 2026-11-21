/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// NET-STORE-4 (crypto) and TMR-4 (performance), conformance against Node's webcrypto and perf_hooks.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { both, createGlueContext, fakeNatives } from './harness.ts';

describe('crypto (NET-STORE-4)', () => {
  test('getRandomValues: types, limits, return value match Node; bytes come from the native hook', async () => {
    const r = await both(
      `
      const out = [];
      for (const C of [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, BigInt64Array, BigUint64Array]) {
        const a = new C(4); out.push(crypto.getRandomValues(a) === a);
      }
      for (const bad of [new Float32Array(1), new Float64Array(1), new DataView(new ArrayBuffer(1))]) {
        try { crypto.getRandomValues(bad); out.push('ok'); } catch (e) { out.push([e.name, e.code]); }
      }
      try { crypto.getRandomValues(new Uint8Array(65537)); } catch (e) { out.push([e.name, e.code]); }
      out.push(crypto.getRandomValues(new Uint8Array(65536)).length, crypto.getRandomValues(new Uint8Array(0)).length);
      const g = crypto.getRandomValues;
      try { g(new Uint8Array(1)); out.push('unbound-ok'); } catch (e) { out.push(e.name); }
      const u = crypto.randomUUID();
      out.push(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(u), crypto.randomUUID() !== u);
      out.push(Object.prototype.toString.call(crypto), typeof crypto.subtle, Object.prototype.toString.call(crypto.subtle));
      try { new Crypto(); } catch (e) { out.push(e.name); }
      return out;
    `,
      { config: { subtle: 'digest' } },
    );
    assert.deepEqual(r.glue, r.node);
    const { natives, calls } = fakeNatives();
    const { run } = await createGlueContext({ natives });
    const sub = Array.from(
      run<number[]>(
        `const a = new Uint8Array(16); crypto.getRandomValues(a.subarray(4, 8)); Array.from(a)`,
      ),
    );
    assert.equal(calls.random, 1);
    // WebIDL: a non-view argument is a TypeError (Node throws TypeMismatchError here; Chromium TypeError).
    assert.throws(() => run(`crypto.getRandomValues([1, 2])`), {
      name: 'TypeError',
    });
    assert.deepEqual(sub.slice(0, 4), [0, 0, 0, 0]);
    assert.deepEqual(sub.slice(8), [0, 0, 0, 0, 0, 0, 0, 0]);
  });

  test('without a native random source getRandomValues throws instead of using Math.random', async () => {
    const { natives } = fakeNatives({ crypto: undefined });
    const { run } = await createGlueContext({ natives });
    assert.throws(() => run(`crypto.getRandomValues(new Uint8Array(4))`), {
      name: 'OperationError',
    });
    assert.throws(() => run(`crypto.randomUUID()`), { name: 'OperationError' });
    // Blob URLs only need ids unique within the store, so they work without the CSPRNG hook.
    const urls = run<string[]>(
      `Array.from({ length: 200 }, () => URL.createObjectURL(new Blob(['x'])))`,
    );
    assert.equal(new Set(urls).size, 200);
    for (const u of urls) {
      assert.match(
        u,
        /^blob:https:\/\/app\.local\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
    assert.equal(run(`URL.createObjectURL(new Blob(['x'])) !== null`), true);
  });

  test('randomUUID sets the version and variant bits on every id', async () => {
    const { run } = await createGlueContext();
    const ids = run<string[]>(
      `Array.from({ length: 2000 }, () => crypto.randomUUID())`,
    );
    assert.equal(new Set(ids).size, ids.length);
    for (const u of ids)
      assert.match(
        u,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    // With 2000 ids every variant nibble (8, 9, a, b) shows up unless the variant code is broken.
    assert.deepEqual([...new Set(ids.map((u) => u[19]))].sort(), [
      '8',
      '9',
      'a',
      'b',
    ]);
  });

  test('subtle.digest matches Node for SHA-1/256/384/512 on random inputs; errors', async () => {
    const r = await both(
      `
      const out = [];
      let seed = 1;
      const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) & 0xff;
      for (const len of [0, 1, 55, 56, 63, 64, 65, 111, 112, 127, 128, 129, 1000, 100000]) {
        const data = new Uint8Array(len).map(rnd);
        for (const alg of ['SHA-1', 'sha-256', { name: 'SHA-384' }, 'SHA-512']) {
          out.push(Array.from(new Uint8Array(await crypto.subtle.digest(alg, data))));
        }
        out.push(Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new DataView(data.buffer)))));
      }
      for (const [alg, data] of [['MD5', new Uint8Array(1)], ['SHA-256', 'str'], [{}, new Uint8Array(1)]]) {
        try { await crypto.subtle.digest(alg, data); out.push('ok'); } catch (e) { out.push(e.name); }
      }
      const buf = new Uint8Array([1, 2, 3]);
      const p = crypto.subtle.digest('SHA-256', buf); buf[0] = 9; // bytes are snapshotted at call time
      out.push(Array.from(new Uint8Array(await p)));
      return out;
    `,
      { config: { subtle: 'digest' } },
    );
    assert.deepEqual(r.glue, r.node);
  });

  test('subtle is absent by default (NET-STORE-4) and opt-in by config; unsupported operations reject NotSupportedError', async () => {
    for (const config of [undefined, { subtle: false }]) {
      const off = await createGlueContext({ config });
      assert.equal(off.run(`'subtle' in crypto`), false);
      assert.equal(off.run(`typeof SubtleCrypto`), 'undefined');
      assert.equal(off.run(`crypto.subtle ? 'has' : 'none'`), 'none');
    }
    const on = await createGlueContext({ config: { subtle: 'digest' } });
    const name = await on.run<Promise<string>>(
      `crypto.subtle.importKey('raw', new Uint8Array(1), 'AES-GCM', false, []).catch((e) => e.name)`,
    );
    assert.equal(name, 'NotSupportedError');
  });
});

describe('performance (TMR-4)', () => {
  test('now() and timeOrigin come from the native clock; monotonic over 10,000 calls', async () => {
    let t = 1000;
    const { natives } = fakeNatives({
      clock: { now: () => (t += 0.0125), timeOrigin: () => 1.7e12 },
    });
    const { run } = await createGlueContext({ natives });
    const ok = run<boolean>(`
      let last = performance.now(), ok = true;
      for (let i = 0; i < 10000; i++) { const n = performance.now(); if (n < last) ok = false; last = n; }
      ok && performance.timeOrigin === 1.7e12 && JSON.stringify(performance.toJSON()) === '{"timeOrigin":1700000000000}';
    `);
    assert.equal(ok, true);
    assert.ok(
      run<number>(`new Event('x').timeStamp`) > 1000,
      'event.timeStamp uses the same clock',
    );
  });

  test('mark / measure / getEntries* / clear* match Node (explicit timestamps)', async () => {
    const r = await both(`
      const out = [];
      performance.clearMarks(); performance.clearMeasures();
      const m1 = performance.mark('a', { startTime: 10, detail: { k: 1 } });
      const m2 = performance.mark('b', { startTime: 30 });
      performance.mark('a', { startTime: 50 });
      out.push(m1.name, m1.entryType, m1.startTime, m1.duration, m1.detail, m2.detail, m1 instanceof PerformanceEntry, m1.toJSON());
      const ms = [
        performance.measure('m1', 'a', 'b'),
        performance.measure('m2', { start: 5, end: 25, detail: 'd' }),
        performance.measure('m3', { start: 'b', duration: 7 }),
        performance.measure('m4', { duration: 4, end: 'b' }),
        performance.measure('m5', { start: 2 }),
      ];
      out.push(ms.map((m) => [m.name, m.entryType, m.startTime, m.name === 'm5' ? 'skip' : m.duration, m.detail]));
      for (const bad of [[{ start: 1 }, 'b'], [{ start: 1, duration: 1, end: 3 }], ['nope']]) {
        try { performance.measure('bad', ...bad); out.push('ok'); } catch (e) { out.push(e.name); }
      }
      try { performance.mark('neg', { startTime: -1 }); } catch (e) { out.push(e.name); }
      out.push(performance.getEntriesByType('mark').map((e) => [e.name, e.startTime]));
      out.push(performance.getEntriesByName('a').map((e) => e.startTime), performance.getEntriesByName('m1', 'measure').length, performance.getEntriesByName('a', 'measure').length);
      out.push(performance.getEntries().filter((e) => e.entryType === 'mark' || e.entryType === 'measure').map((e) => e.name));
      performance.clearMarks('a');
      out.push(performance.getEntriesByType('mark').map((e) => e.name));
      performance.clearMeasures();
      out.push(performance.getEntriesByType('measure').length);
      const pm = new PerformanceMark('ctor', { startTime: 3 }); out.push(pm.startTime, performance.getEntriesByName('ctor').length);
      out.push(typeof performance.now(), typeof performance.timeOrigin, Object.prototype.toString.call(performance));
      return out;
    `);
    assert.deepEqual(r.glue, r.node);
    // User Timing: a negative timestamp, and non-empty options without start/end, are TypeErrors
    // (Node accepts both; Chromium and the spec throw).
    const { run } = await createGlueContext();
    assert.throws(() => run(`performance.measure('x', { start: -1 })`), {
      name: 'TypeError',
    });
    assert.throws(() => run(`performance.measure('x', { detail: 1 })`), {
      name: 'TypeError',
    });
  });
});
