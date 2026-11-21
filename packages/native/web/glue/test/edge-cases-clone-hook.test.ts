/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Regression tests: a native clone hook that loses its DataCloneError
// (the core's clone.cc returns undefined), same-document reload idioms, platform objects as named
// properties of arrays, JS clone path conformance (custom-tag errors, arguments, Intl Segments, revoked
// proxies, trailing holes), the shared blob URL store, navigator.permissions and DOM-1 window members,
// small WebIDL conversions, abort ordering of dependent signals, and listener exceptions on the
// device-like boot.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createDeviceContext,
  createGlueContext,
  fakeNatives,
} from './harness.ts';

const REG = `globalThis[Symbol.for('iwn.glue')]`;
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A hook like the device's clone.cc today: V8's serializer, but a refused value comes back undefined. */
function lossyCloneNatives(): {
  natives: Record<string, unknown>;
  calls: { n: number };
} {
  const calls = { n: 0 };
  const { natives } = fakeNatives({
    clone: {
      structuredClone(v: unknown, transfer: unknown[]) {
        calls.n++;
        try {
          return structuredClone(v, { transfer: transfer as never });
        } catch {
          return undefined;
        }
      },
    },
  });
  return { natives, calls };
}

const UNCLONEABLE = [
  ['fn top', `(function f() {})`],
  ['fn in object', `({ f() {} })`],
  ['symbol top', `Symbol('s')`],
  ['symbol in array', `[1, Symbol('s')]`],
  ['Promise', `Promise.resolve(1)`],
  ['WeakMap', `new WeakMap()`],
  ['Proxy', `new Proxy({ a: 1 }, {})`],
  ['Proxy in object', `({ p: new Proxy([], {}) })`],
  ['generator', `(function* () {})()`],
  ['arguments', `(function () { return arguments; })(1, 2)`],
];

describe('a native clone hook that returns undefined instead of throwing (TMR-3, WRK-5)', () => {
  test('every value V8 refuses still throws DataCloneError', async () => {
    const { natives, calls } = lossyCloneNatives();
    const { run } = await createGlueContext({ natives });
    for (const [name, expr] of UNCLONEABLE) {
      const r = run(
        `(() => { try { const v = structuredClone(${expr}); return 'returned ' + String(v); } catch (e) { return e.name + ':' + (e instanceof DOMException); } })()`,
      );
      assert.equal(r, 'DataCloneError:true', name);
    }
    assert.ok(calls.n > 0, 'plain-looking graphs went to the hook');
    // Legitimate undefined results stay as they are.
    assert.equal(
      run(
        `structuredClone(undefined) === undefined && structuredClone({ a: undefined }).hasOwnProperty('a')`,
      ),
      true,
    );
  });

  test('callers of structuredClone inherit the error: history.pushState and performance.mark', async () => {
    const { natives } = lossyCloneNatives();
    const { run } = await createGlueContext({ natives });
    assert.equal(
      run(
        `try { history.pushState({ f() {} }, ''); 'no throw' } catch (e) { e.name }`,
      ),
      'DataCloneError',
    );
    assert.equal(run(`history.state`), null);
    assert.equal(
      run(
        `try { performance.mark('m', { detail: Symbol() }); 'no throw' } catch (e) { e.name }`,
      ),
      'DataCloneError',
    );
  });

  test('a Proxy whose traps throw is a DataCloneError, not the trap error (V8 runs no traps)', async () => {
    const { natives } = lossyCloneNatives();
    const { run } = await createGlueContext({ natives });
    const code = `{ const p = new Proxy({}, { getPrototypeOf() { throw new RangeError('trap'); }, ownKeys() { throw new RangeError('trap'); } }); try { structuredClone({ p }); 'cloned' } catch (e) { e.name } }`;
    assert.equal(run(code), 'DataCloneError');
    const jsOnly = await createGlueContext();
    assert.equal(jsOnly.run(code), 'DataCloneError');
    // Only the ownKeys trap throws (the prototype read succeeds).
    const keysOnly = `{ const p = new Proxy({}, { ownKeys() { throw new RangeError('trap'); } }); try { structuredClone({ p }); 'cloned' } catch (e) { e.name } }`;
    assert.equal(run(keysOnly), 'DataCloneError');
    assert.equal(jsOnly.run(keysOnly), 'DataCloneError');
    // Only the getOwnPropertyDescriptor trap throws.
    const gopdOnly = `{ const p = new Proxy({ a: 1 }, { getOwnPropertyDescriptor() { throw new RangeError('trap'); } }); try { structuredClone({ p }); 'cloned' } catch (e) { e.name } }`;
    assert.equal(run(gopdOnly), 'DataCloneError');
    assert.equal(jsOnly.run(gopdOnly), 'DataCloneError');
  });

  test('an Error with a custom tag and a Blob cause is routed to the JS path', async () => {
    const { natives } = lossyCloneNatives();
    const { run } = await createGlueContext({ natives });
    assert.equal(
      run(
        `{ class E extends Error { get [Symbol.toStringTag]() { return 'Custom'; } } const c = structuredClone(new E('m', { cause: new Blob(['c']) })); c.cause instanceof Blob }`,
      ),
      true,
    );
  });

  test('a failed clone transfers nothing', async () => {
    const { natives } = lossyCloneNatives();
    const { run } = await createGlueContext({ natives });
    assert.equal(
      run(
        `const ab = new ArrayBuffer(8); let n; try { structuredClone({ ab, f() {} }, { transfer: [ab] }); } catch (e) { n = e.name; } n + ':' + ab.detached + ':' + ab.byteLength`,
      ),
      'DataCloneError:false:8',
    );
  });
});

describe('same-document reload idioms (DOM-5, PROC-8)', () => {
  for (const withNavigate of [false, true]) {
    test(`assign/replace/href/search to the current URL call app.reload()${withNavigate ? ' (host with navigate)' : ' (headset: reload only)'}`, async () => {
      const base = fakeNatives();
      const reloads: unknown[] = [];
      const navigates: unknown[] = [];
      const app: Record<string, unknown> = { reload: () => reloads.push(1) };
      if (withNavigate) app.navigate = (u: string) => navigates.push(u);
      const warnings: string[] = [];
      const { run } = await createGlueContext({
        natives: { ...base.natives, app },
        config: { url: 'https://app.local/index.html?a=1' },
        preset: {
          console: { warn: (m: string) => warnings.push(m), error() {} },
        },
      });
      run(`location.assign(location.href)`);
      run(`location.replace(location.href)`);
      run(`location.href = location.href`);
      run(`location.search = location.search`);
      assert.equal(reloads.length, 4);
      assert.deepEqual(navigates, []);
      assert.deepEqual(warnings, []);
      // Another document still needs app.navigate.
      run(`location.assign('/other.html')`);
      assert.equal(reloads.length, 4);
      if (withNavigate)
        assert.deepEqual(navigates, ['https://app.local/other.html']);
      else assert.equal(warnings.length, 1);
    });
  }
});

describe('structuredClone routing: arrays (TMR-3)', () => {
  function routedNatives(): {
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

  test('platform objects stored as named properties of short arrays take the JS path', async () => {
    const { natives, seen } = routedNatives();
    const { run } = await createGlueContext({ natives });
    assert.equal(
      run(
        `{ const a = [1, 2]; a.blob = new Blob(['q']); const c = structuredClone(a); c.blob instanceof Blob && c.length === 2 }`,
      ),
      true,
    );
    assert.equal(
      run(
        `{ const a = [1]; a.u = new URL('https://x/'); try { structuredClone(a); 'cloned' } catch (e) { e.name } }`,
      ),
      'DataCloneError',
    );
    // Non-enumerable indices do not shift the named-property scan.
    assert.equal(
      run(
        `{ const a = [1, 2, 3]; Object.defineProperty(a, 0, { value: 1, enumerable: false }); a.b = new Blob(['z']); structuredClone(a).b instanceof Blob }`,
      ),
      true,
    );
    assert.equal(run(`structuredClone([1, [2, { x: 3 }]])[1][1].x`), 3);
    assert.equal(seen.length, 1, 'plain arrays still go to the hook');
  });

  test('a run of holes switches to the existing keys and still finds what follows', async () => {
    const { natives, seen } = routedNatives();
    const { run } = await createGlueContext({ natives });
    assert.equal(
      run(
        `{ const a = [1]; a[200000] = new Blob(['q']); structuredClone(a)[200000] instanceof Blob }`,
      ),
      true,
    );
    assert.equal(
      run(
        `{ const a = [1]; a.length = 300000; a.blob = new Blob(['q']); structuredClone(a).blob instanceof Blob }`,
      ),
      true,
    );
    assert.equal(
      run(
        `{ const a = [1]; a[150000] = 2; Object.defineProperty(a, 250000, { get() { return 1; }, enumerable: true }); structuredClone(a)[250000] }`,
      ),
      1,
    );
    assert.equal(seen.length, 0);
    // Long dense arrays are walked by index (no Object.keys) and still reach nested platform objects.
    assert.equal(
      run(
        `{ const a = Array.from({ length: 100000 }, (_, i) => i); a[99999] = { b: new Blob(['x']) }; structuredClone(a)[99999].b instanceof Blob }`,
      ),
      true,
    );
  });
});

describe('the JS clone path against V8 (TMR-3)', () => {
  // A Blob in the graph forces the JS path even with a native hook.
  for (const native of [false, true]) {
    const label = native ? 'with the native hook' : 'JS only';
    const make = async () =>
      createGlueContext(
        native
          ? {
              natives: fakeNatives({
                clone: {
                  structuredClone: (v: unknown, t: unknown[]) =>
                    structuredClone(v, { transfer: t as never }),
                },
              }).natives,
            }
          : { natives: fakeNatives().natives },
      );

    test(`an Error with a custom Symbol.toStringTag stays an Error (${label})`, async () => {
      const { run } = await make();
      const out = run<string>(`
        class E extends Error { get [Symbol.toStringTag]() { return 'Custom'; } }
        const e = new E('m', { cause: new Blob(['c']) });
        const [c] = structuredClone([e, new Blob([])]);
        [c instanceof Error, c.message, c.cause instanceof Blob, Object.prototype.toString.call(c)].join();
      `);
      assert.equal(out, 'true,m,true,[object Error]');
    });

    test(`arguments, Intl Segments and revoked proxies throw DataCloneError (${label})`, async () => {
      const { run } = await make();
      for (const expr of [
        `(function () { return arguments; })(1, 2)`,
        `new Intl.Segmenter('en').segment('a b')`,
        `(() => { const r = Proxy.revocable({}, {}); r.revoke(); return r.proxy; })()`,
      ]) {
        assert.equal(
          run(
            `try { structuredClone([${expr}, new Blob([])]); 'cloned' } catch (e) { e.name }`,
          ),
          'DataCloneError',
          expr,
        );
        assert.equal(
          run(
            `try { structuredClone(${expr}); 'cloned' } catch (e) { e.name }`,
          ),
          'DataCloneError',
          `${expr} alone`,
        );
      }
      // A plain object that only claims to be one clones as data.
      assert.equal(
        run(
          `JSON.stringify(structuredClone([{ [Symbol.toStringTag]: 'Arguments', a: 1 }, new Blob([])])[0])`,
        ),
        '{"a":1}',
      );
    });

    test(`arrays keep their length, trailing holes included (${label})`, async () => {
      const { run } = await make();
      assert.equal(
        run(
          `{ const a = [1, , 3]; a.length = 6; const [c] = structuredClone([a, new Blob([])]); [c.length, 1 in c, 5 in c, c[2]].join() }`,
        ),
        '6,false,false,3',
      );
    });
  }
});

describe('blob URL store shared across globals (NET-15)', () => {
  test('a revoke in a worker removes the URL for the main thread too', async () => {
    const store = new Map<string, { bytes: Uint8Array; type: string }>();
    const blobUrls = {
      register: (url: string, bytes: Uint8Array, type: string) =>
        store.set(url, { bytes: bytes.slice(), type }),
      revoke: (url: string) => store.delete(url),
      resolve: (url: string) => store.get(url) ?? null,
    };
    const main = await createGlueContext({
      natives: { ...fakeNatives().natives, blobUrls },
    });
    const worker = await createGlueContext({
      natives: { ...fakeNatives().natives, blobUrls },
      config: { scope: 'worker', url: 'https://app.local/w.js' },
    });
    const url = main.run<string>(
      `globalThis.u = URL.createObjectURL(new Blob(['abc'])); u`,
    );
    worker.g.u = url;
    assert.equal(worker.run(`${REG}.blobUrls.resolve(u) !== null`), true);
    assert.equal(main.run(`${REG}.blobUrls.resolve(u) !== null`), true);
    worker.run(`URL.revokeObjectURL(u)`);
    assert.equal(store.has(url), false);
    assert.equal(main.run(`${REG}.blobUrls.resolve(u)`), null);
    assert.equal(worker.run(`${REG}.blobUrls.resolve(u)`), null);
  });
});

describe('navigator.permissions and DOM-1 window members', () => {
  test('query: granted for features the app has, prompt otherwise, TypeError for unknown names', async () => {
    const { natives } = fakeNatives();
    const device = natives.device as { info(): Record<string, unknown> };
    const info = device.info;
    let micGranted = false;
    natives.device = {
      info: () => ({
        ...info(),
        grantedPermissions: micGranted ? ['microphone'] : [],
      }),
    };
    const { run } = await createGlueContext({ natives });
    const q = (name: string) =>
      run<Promise<string>>(
        `navigator.permissions.query({ name: '${name}' }).then((s) => s.state, (e) => e.name)`,
      );
    assert.equal(await q('xr-spatial-tracking'), 'granted');
    assert.equal(await q('camera'), 'prompt');
    assert.equal(await q('microphone'), 'prompt');
    micGranted = true;
    assert.equal(await q('microphone'), 'granted');
    assert.equal(await q('bogus-name'), 'TypeError');
    const custom = await createGlueContext({
      config: { permissions: { granted: ['geolocation'] } },
    });
    assert.equal(
      await custom.run<Promise<string>>(
        `navigator.permissions.query({ name: 'geolocation' }).then((s) => s.state)`,
      ),
      'granted',
    );
    assert.equal(
      await custom.run<Promise<string>>(
        `navigator.permissions.query({ name: 'xr-spatial-tracking' }).then((s) => s.state)`,
      ),
      'prompt',
    );
  });

  test("query: a runtime prelude reports its own feature's grants (web/xr camera: camera once CAMERA + HEADSET_CAMERA)", async () => {
    const { run } = await createGlueContext();
    const q = (name: string) =>
      run<Promise<string>>(
        `navigator.permissions.query({ name: '${name}' }).then((s) => s.state)`,
      );
    run(`var held = false; ${REG}.addPermissionSource(() => held ? ['camera'] : []);
      ${REG}.addPermissionSource(() => { throw new Error('a broken source'); });`);
    assert.equal(await q('camera'), 'prompt');
    run(`held = true`);
    assert.equal(await q('camera'), 'granted', 'asked at each query');
    assert.equal(await q('microphone'), 'prompt');
    assert.equal(
      await q('xr-spatial-tracking'),
      'granted',
      'the packaged grants stay',
    );
  });

  test('top/parent/frames are the window, frameElement and opener null, name a settable string', async () => {
    const { run } = await createGlueContext();
    assert.equal(
      run(
        `[top === window, parent === window, frames === window, frameElement, opener, JSON.stringify(name)].join()`,
      ),
      'true,true,true,,,""',
    );
    assert.equal(run(`name = 42; typeof name + ':' + name`), 'string:42');
    assert.equal(run(`top = 1; top === window`), true);
    const worker = await createGlueContext({
      config: { scope: 'worker', url: 'https://app.local/w.js' },
    });
    assert.equal(
      worker.run(`typeof top + typeof parent + typeof frameElement`),
      'undefinedundefinedundefined',
    );
  });
});

describe('small WebIDL conversions', () => {
  test('structuredClone transfer must be an iterable of objects', async () => {
    for (const native of [false, true]) {
      const { run } = await createGlueContext(
        native ? { natives: lossyCloneNatives().natives } : {},
      );
      for (const t of ['null', '5', '{}', "'ab'"]) {
        // A string is iterable, but its elements are not objects.
        assert.equal(
          run(
            `try { structuredClone(1, { transfer: ${t} }); 'ok' } catch (e) { e.name }`,
          ),
          'TypeError',
          `transfer: ${t}`,
        );
      }
      assert.equal(run(`structuredClone(1, { transfer: undefined })`), 1);
      assert.equal(run(`structuredClone(1, { transfer: new Set() })`), 1);
    }
  });

  test('addEventListener converts the type before the null-callback return; pushState needs 2 arguments; randomUUID checks this', async () => {
    const { run } = await createGlueContext();
    assert.equal(
      run(
        `try { addEventListener(Symbol(), null); 'ok' } catch (e) { e.name }`,
      ),
      'TypeError',
    );
    assert.equal(
      run(
        `try { new EventTarget().addEventListener(Symbol(), null); 'ok' } catch (e) { e.name }`,
      ),
      'TypeError',
    );
    assert.equal(
      run(
        `try { new EventTarget().addEventListener('x', 5); 'ok' } catch (e) { e.name }`,
      ),
      'TypeError',
    );
    assert.equal(
      run(`try { history.pushState(); 'ok' } catch (e) { e.name }`),
      'TypeError',
    );
    assert.equal(
      run(`try { history.replaceState({}); 'ok' } catch (e) { e.name }`),
      'TypeError',
    );
    assert.equal(
      run(`try { history.pushState({}, Symbol()); 'ok' } catch (e) { e.name }`),
      'TypeError',
    );
    assert.equal(run(`history.pushState({ a: 1 }, ''); history.state.a`), 1);
    assert.equal(
      run(
        `try { const f = crypto.randomUUID; f(); 'ok' } catch (e) { e.name }`,
      ),
      'TypeError',
    );
    assert.match(
      run<string>(`crypto.randomUUID()`),
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test('measure duration is a number; readAsText with a replacement label gives U+FFFD', async () => {
    const { run } = await createGlueContext();
    assert.equal(
      run(`performance.measure('m', { start: 1, duration: '5' }).duration`),
      5,
    );
    assert.equal(
      run(
        `try { performance.measure('m', { start: 1, duration: 'x' }); 'ok' } catch (e) { e.name }`,
      ),
      'TypeError',
    );
    const read = (label: string, bytes: string) =>
      run<Promise<string>>(
        `new Promise((res) => { const r = new FileReader(); r.onload = () => res(JSON.stringify(r.result)); r.readAsText(new Blob([${bytes}]), '${label}'); })`,
      );
    assert.equal(await read('iso-2022-kr', `'AB'`), JSON.stringify('�'));
    assert.equal(await read('replacement', `''`), JSON.stringify(''));
    assert.equal(
      await read('iso-2022-kr', `new Uint8Array([0xef, 0xbb, 0xbf, 0x41])`),
      JSON.stringify('A'),
    );
  });
});

describe('abort ordering of dependent signals (DOM-10)', () => {
  // AbortSignal.any() flattens to the original sources, so dep and dep2 are both dependents of ac.signal and abort
  // in the order they were created (DOM "signal abort"). Not compared with the host Node: Node 24.16 changed its order.
  test("a source's abort steps run before its dependents', in creation order", async () => {
    const code = `
      const order = [];
      const ac = new AbortController();
      const dep = AbortSignal.any([ac.signal]);
      const dep2 = AbortSignal.any([dep]);
      dep2.addEventListener('abort', () => order.push('dep2:' + ac.signal.aborted + dep.aborted));
      dep.addEventListener('abort', () => order.push('dep:' + dep2.aborted));
      ac.signal.addEventListener('abort', () => order.push('source:' + dep.aborted + dep2.aborted));
      ac.abort('r');
      order.join(' ');
    `;
    const { run } = await createGlueContext();
    assert.equal(run(code), 'source:truetrue dep:true dep2:truetrue');
  });
});

describe('device-like boot: listener exceptions reach core.reportError', () => {
  test('a throwing listener is reported, and the next listener still runs', async () => {
    const { run, calls } = await createDeviceContext();
    run(`
      globalThis.ran = [];
      const t = new EventTarget();
      t.addEventListener('x', () => { throw new Error('boom'); });
      t.addEventListener('x', () => ran.push('second'));
      t.dispatchEvent(new Event('x'));
    `);
    await tick();
    assert.deepEqual(Array.from(run<string[]>(`ran`)), ['second']);
    const msgs = calls.reported.map(
      (e) => `${(e as Error).name}:${(e as Error).message}`,
    );
    assert.deepEqual(msgs, ['Error:boom']);
  });
});
