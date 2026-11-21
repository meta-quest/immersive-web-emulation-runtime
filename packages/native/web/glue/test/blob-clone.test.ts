/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// NET-14 / NET-15 (Blob, File, FileReader, blob URL store) and TMR-3 / WRK-5's value set
// (structuredClone), conformance against Node's Blob/File/structuredClone.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { both, compareMessages, createGlueContext, fakeNatives } from './harness.ts';

describe('Blob / File (NET-14)', () => {
  test('construction, type, slice and readers match Node', async () => {
    const r = await both(`
      const out = [];
      const b = new Blob(['héllo', new Uint8Array([1, 2, 3]), new Uint16Array([0x4142]).buffer, new Blob(['x\\r\\ny'])], { type: 'Text/Plain' });
      out.push(b.size, b.type, Array.from(new Uint8Array(await b.arrayBuffer())));
      out.push(await b.text(), Array.from(await b.bytes()));
      for (const [s, e] of [[0, 3], [-3], [2, -2], [5, 2], [undefined, undefined], [-100, 100]]) {
        const sl = b.slice(s, e, 'A/B');
        out.push([sl.size, sl.type, Array.from(new Uint8Array(await sl.arrayBuffer()))]);
      }
      out.push(new Blob([], { type: 'bad\\u0001type' }).type, new Blob().size, new Blob(['a'], { type: 'ü' }).type);
      out.push(await new Blob(['a\\r\\nb\\nc'], { endings: 'native' }).text(), await new Blob(['a\\r\\nb'], { endings: 'transparent' }).text());
      try { new Blob('abc'); } catch (e) { out.push(e.name); }
      try { new Blob([], { endings: 'nope' }); } catch (e) { out.push(e.name); }
      try { new Blob(null); } catch (e) { out.push(e.name); }
      out.push(await new Blob([{ toString() { return 'obj'; } }, 42, null]).text());
      const view = new Uint8Array([9, 9, 9]);
      const copied = new Blob([view]); view[0] = 0;
      out.push(Array.from(await copied.bytes()));
      const f = new File(['abc'], 'name.txt', { type: 'text/plain', lastModified: 1234 });
      out.push(f.name, f.size, f.type, f.lastModified, f instanceof Blob, Object.prototype.toString.call(f));
      out.push(typeof new File([], 'n').lastModified);
      try { new File(['x']); } catch (e) { out.push(e.name); }
      out.push(Object.prototype.toString.call(b), await new Blob([new Blob(['\\uFEFFbom'])]).text());
      return out;
    `);
    assert.deepEqual(r.glue, r.node);
  });

  // Node converts only CRLF for endings:'native'; the File API converts lone CR too.
  test("endings: 'native' converts CRLF and lone CR to LF; File.webkitRelativePath", async () => {
    const { run } = await createGlueContext();
    assert.equal(await run<Promise<string>>(`new Blob(['a\\r\\nb\\rc\\n'], { endings: 'native' }).text()`), 'a\nb\nc\n');
    assert.equal(run(`new File([], 'x').webkitRelativePath`), '');
  });

  test('FileReader: event order, results and abort', async () => {
    const { run } = await createGlueContext();
    const out = await run<Promise<unknown[]>>(`
      (async () => {
        const out = [];
        const read = (method, blob, ...args) => new Promise((resolve) => {
          const fr = new FileReader();
          const events = [];
          for (const t of ['loadstart', 'progress', 'load', 'error', 'abort', 'loadend']) {
            fr.addEventListener(t, (e) => events.push(t + ':' + fr.readyState + ':' + e.loaded + '/' + e.total));
          }
          fr.onloadend = () => resolve([events, fr.result instanceof ArrayBuffer ? Array.from(new Uint8Array(fr.result)) : fr.result]);
          fr[method](blob, ...args);
          out.push(method + ' sync state ' + fr.readyState);
        });
        const blob = new Blob(['h\\u00e9'], { type: 'text/plain' });
        out.push(await read('readAsArrayBuffer', blob));
        out.push(await read('readAsText', blob));
        out.push(await read('readAsText', new Blob([new Uint8Array([0xff, 0xfe, 0x41, 0x00])])));
        out.push(await read('readAsText', new Blob([new Uint8Array([0xe9])]), 'latin1'));
        out.push(await read('readAsDataURL', blob));
        out.push(await read('readAsDataURL', new Blob([new Uint8Array([0, 1, 2, 3, 255])])));
        out.push(await read('readAsBinaryString', blob));
        const fr = new FileReader();
        fr.readAsText(blob);
        try { fr.readAsText(blob); } catch (e) { out.push(e.name); }
        const ev = [];
        fr.onabort = () => ev.push('abort');
        fr.onloadend = () => ev.push('loadend');
        fr.onload = () => ev.push('load');
        fr.abort();
        await new Promise((r) => setTimeout(r, 20));
        out.push(ev, fr.readyState, fr.result, FileReader.DONE, fr.EMPTY);
        try { new FileReader().readAsText('x'); } catch (e) { out.push(e.name); }
        return out;
      })()
    `);
    // File API: progress fires while readyState is LOADING (1) with result still null; DONE and the
    // result come right before load (Node reports DONE during progress).
    assert.deepEqual(JSON.parse(JSON.stringify(out)), [
      'readAsArrayBuffer sync state 1',
      [['loadstart:1:0/3', 'progress:1:3/3', 'load:2:3/3', 'loadend:2:3/3'], [104, 195, 169]],
      'readAsText sync state 1',
      [['loadstart:1:0/3', 'progress:1:3/3', 'load:2:3/3', 'loadend:2:3/3'], 'hé'],
      'readAsText sync state 1',
      [['loadstart:1:0/4', 'progress:1:4/4', 'load:2:4/4', 'loadend:2:4/4'], 'A'],
      'readAsText sync state 1',
      [['loadstart:1:0/1', 'progress:1:1/1', 'load:2:1/1', 'loadend:2:1/1'], 'é'],
      'readAsDataURL sync state 1',
      [['loadstart:1:0/3', 'progress:1:3/3', 'load:2:3/3', 'loadend:2:3/3'], 'data:text/plain;base64,aMOp'],
      'readAsDataURL sync state 1',
      [['loadstart:1:0/5', 'progress:1:5/5', 'load:2:5/5', 'loadend:2:5/5'], 'data:application/octet-stream;base64,AAECA/8='],
      'readAsBinaryString sync state 1',
      [['loadstart:1:0/3', 'progress:1:3/3', 'load:2:3/3', 'loadend:2:3/3'], 'hÃ©'],
      'InvalidStateError',
      ['abort', 'loadend'],
      2,
      null,
      2,
      0,
      'TypeError',
    ]);
  });

  test('blob URL store: create, resolve (fragment ignored), revoke (NET-14)', async () => {
    const { run, g } = await createGlueContext({ config: { url: 'https://app.local/index.html?a=1' } });
    const reg = g[Symbol.for('iwn.glue') as unknown as string] as {
      blobUrls: { resolve(u: string): unknown };
      blobBytes(b: unknown): Uint8Array;
    };
    const url = run<string>(`globalThis.u = URL.createObjectURL(new Blob(['abc'], { type: 'text/x' })); u`);
    const hit = reg.blobUrls.resolve(url + '#frag') as { type: string; size: number };
    assert.equal(hit.type, 'text/x');
    assert.deepEqual(Array.from(reg.blobBytes(hit)), [97, 98, 99]);
    run(`URL.revokeObjectURL(u)`);
    assert.equal(reg.blobUrls.resolve(url), null);
    run(`URL.revokeObjectURL('blob:https://app.local/unknown')`);
  });

  test('blob URL store delegates to the native process-wide store when present (NET-15)', async () => {
    const store = new Map<string, { bytes: Uint8Array; type: string }>();
    const { natives } = fakeNatives({
      blobUrls: {
        register: (url: string, bytes: Uint8Array, type: string) => store.set(url, { bytes, type }),
        revoke: (url: string) => store.delete(url),
        resolve: (url: string) => store.get(url) ?? null,
      },
    });
    const a = await createGlueContext({ natives });
    const b = await createGlueContext({ natives });
    const url = a.run<string>(`URL.createObjectURL(new Blob(['shared'], { type: 'text/plain' }))`);
    assert.equal(store.size, 1);
    // Another global (a worker, on device) resolves the URL through the native store.
    b.g.u = url;
    const text = await b.run<Promise<string>>(`globalThis[Symbol.for('iwn.glue')].blobUrls.resolve(u).text()`);
    assert.equal(text, 'shared');
    a.g.u = url;
    a.run(`URL.revokeObjectURL(u)`);
    assert.equal(b.run(`globalThis[Symbol.for('iwn.glue')].blobUrls.resolve(u)`), null);
  });
});

describe('structuredClone (TMR-3, WRK-5 value set)', () => {
  test('values match Node', async () => {
    compareMessages(true);
    const r = await both(`
      const out = [];
      const cyc = { name: 'c' }; cyc.self = cyc;
      const shared = { s: 1 };
      const sparse = [1, , 3]; sparse.extra = 'x';
      const ab = new ArrayBuffer(8); new Uint8Array(ab).set([1, 2, 3, 4, 5, 6, 7, 8]);
      const values = [
        undefined, null, true, 0, -0, NaN, 1n, 'str',
        Object(false), Object(1), Object('s'), Object(2n),
        new Date(5), /a+b/gi, new Map([[1, { a: 1 }], ['k', shared]]), new Set([1, 'a', shared]),
        [shared, shared], sparse, cyc, { a: { b: [1, 2, { c: 3 }] } },
        ab, new Uint8Array(ab, 2, 3), new Float64Array([1.5, -2]), new DataView(ab, 1, 4), new BigInt64Array([-1n]),
        new Int16Array(ab, 2), new Uint8ClampedArray([300 & 255]),
        new RangeError('r'), new TypeError('t', { cause: { why: 1 } }), Object.assign(new Error('e'), { name: 'Custom' }),
        new DOMException('d', 'DataCloneError'),
      ];
      for (const v of values) {
        const c = structuredClone(v);
        const isObj = v !== null && typeof v === 'object';
        out.push([c, isObj ? c !== v : true, isObj ? Object.getPrototypeOf(c) === Object.getPrototypeOf(v) : true]);
      }
      const c = structuredClone(cyc); out.push(c.self === c);
      const pair = structuredClone([shared, shared]); out.push(pair[0] === pair[1]);
      const sp = structuredClone(sparse); out.push(1 in sp, sp.length, sp.extra);
      const views = structuredClone([ab, new Uint8Array(ab, 4, 2)]); out.push(views[1].buffer === views[0]);
      const errs = [new TypeError('t', { cause: 'why' }), new DOMException('m', 'AbortError')].map((e) => structuredClone(e));
      out.push(errs.map((e) => [e.name, e.message, e.cause, e.constructor.name, typeof e.stack]));
      const rx = /x/y; rx.lastIndex = 3; out.push(structuredClone(rx).lastIndex);
      const getter = { get g() { return 'computed'; }, [Symbol('s')]: 1 }; out.push(structuredClone(getter));
      class K { constructor() { this.v = 1; } } out.push(Object.getPrototypeOf(structuredClone(new K())) === Object.prototype);
      for (const bad of [() => 1, Symbol('x'), { f() {} }, Promise.resolve(), new WeakMap(), Object(Symbol('y')), [function () {}]]) {
        try { structuredClone(bad); out.push('cloned'); } catch (e) { out.push([e.name, e.code]); }
      }
      try { structuredClone(); } catch (e) { out.push(e.name); }
      return out;
    `).finally(() => compareMessages(false));
    // DataCloneError wording differs between engines; compare everything else including clone messages.
    const strip = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (k, x) => (k === 'message' && typeof x === 'string' && /could not be cloned|Uncloneable|cannot be cloned|Symbol\(|is not a function/i.test(x) ? '<engine>' : x)));
    assert.deepEqual(strip(r.glue), strip(r.node));
  });

  test('transfer detaches, shares memory, validates the list, and is atomic on failure', async () => {
    const r = await both(`
      const out = [];
      const ab = new ArrayBuffer(4); new Uint8Array(ab).set([1, 2, 3, 4]);
      const view = new Uint8Array(ab, 1, 2);
      const res = structuredClone({ ab, view }, { transfer: [ab] });
      out.push(ab.byteLength, ab.detached, res.ab.byteLength, Array.from(res.view), res.view.buffer === res.ab);
      try { structuredClone(ab); } catch (e) { out.push(['detached', e.name]); }
      try { structuredClone(1, { transfer: [ab] }); } catch (e) { out.push(['detached-transfer', e.name]); }
      const b2 = new ArrayBuffer(2);
      try { structuredClone(1, { transfer: [b2, b2] }); } catch (e) { out.push(['dup', e.name]); }
      try { structuredClone(1, { transfer: [{}] }); } catch (e) { out.push(['not-transferable', e.name]); }
      try { structuredClone(1, { transfer: [1] }); } catch (e) { out.push(['primitive', e.name]); }
      const b3 = new ArrayBuffer(2);
      try { structuredClone({ b3, f() {} }, { transfer: [b3] }); } catch (e) { out.push(['atomic', e.name, b3.byteLength]); }
      const rz = new ArrayBuffer(2, { maxByteLength: 16 });
      const rc = structuredClone(rz); out.push(rc.resizable, rc.maxByteLength, rc.byteLength);
      const rt = structuredClone(rz, { transfer: [rz] }); out.push(rt.resizable, rt.maxByteLength, rz.detached);
      return out;
    `);
    assert.deepEqual(r.glue, r.node);
  });

  test('Blob / File clone; SharedArrayBuffer and glue platform objects throw DataCloneError', async () => {
    const { run } = await createGlueContext();
    const out = await run<Promise<unknown[]>>(`
      (async () => {
        const out = [];
        const b = structuredClone(new Blob(['xyz'], { type: 'a/b' }));
        out.push(b instanceof Blob, b.type, await b.text());
        const f = structuredClone(new File(['q'], 'n.txt', { lastModified: 7 }));
        out.push(f instanceof File, f.name, f.lastModified, await f.text());
        for (const v of [new SharedArrayBuffer(4), new EventTarget(), new AbortController(), new Event('x'), navigator, location, crypto]) {
          try { structuredClone(v); out.push('cloned'); } catch (e) { out.push(e.name); }
        }
        return out;
      })()
    `);
    assert.deepEqual(Array.from(out), [
      true, 'a/b', 'xyz', true, 'n.txt', 7, 'q',
      'DataCloneError', 'DataCloneError', 'DataCloneError', 'DataCloneError', 'DataCloneError', 'DataCloneError', 'DataCloneError',
    ]);
  });

  test('uses the native clone hook when present', async () => {
    const { natives, calls } = fakeNatives({
      clone: {
        structuredClone: (v: unknown, transfer: unknown[]) => {
          calls.clone++;
          return { cloned: v, transfer: transfer.length };
        },
      },
    });
    const { run } = await createGlueContext({ natives });
    const r = run<{ cloned: number; transfer: number }>(`structuredClone(5, { transfer: [] })`);
    assert.equal(calls.clone, 1);
    assert.equal(r.cloned, 5);
  });
});
